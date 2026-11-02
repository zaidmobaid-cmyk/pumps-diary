'use strict';
// BattleMetrics ban import + ban enforcement (docs/NEXT-CONTRACTS.md §3).
// The import runs against a local mock of BM's JSON:API (node:http): paging
// with links that drop the request's filters, expired / unidentifiable /
// malformed bans, re-sync deactivation scoped per list, exemptions,
// server-only bans, 401, 429 + Retry-After, reads that cannot finish.
// Enforcement drives a real Ingest + LiveState on an
// in-memory db (log path, roster path, poll sweep, the 60 s gap), and once
// end to end through the real admin layer, RCON client and MockSquad.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { openDb } = require('../server/db');
const { createBattlemetrics } = require('../server/battlemetrics');
const { loadConfig, applySettingsPatch } = require('../server/config');
const Ingest = require('../server/ingest');
const LiveState = require('../server/state');

const TOKEN = 'bm-token-0123456789abcdefghijklmnop';
const LIST = '6b1f2c3d-0000-4000-8000-00000000aaaa';
const OTHER = '6b1f2c3d-0000-4000-8000-00000000bbbb';
const DAY = 86400000;
const TS = '2026-10-01T12:00:00.000Z';

const S = (n) => `7656119800000${String(n).padStart(4, '0')}`; // SteamID64
const E = (n) => n.toString(16).padStart(32, '0'); // EOS id

// Every wait short; Retry-After is still honoured in full (maxWaitMs).
const FAST = {
  gapMs: 0, timeoutMs: 5000, attempts: 3, retryDelaysMs: [10, 10],
  rateLimitWaitMs: 50, maxWaitMs: 5000, bootDelayMs: 20, retryFailedMs: 60000,
};

// A BM ban resource. `ids` are extra raw identifier entries; `server` names
// the BM server it was issued on (with orgWide false: the only one it covers).
function bmBan(id, o = {}) {
  const identifiers = [];
  if (o.steam) identifiers.push({ type: 'steamID', identifier: o.steam, manual: true });
  if (o.eos) identifiers.push({ type: 'eosID', identifier: o.eos, manual: false });
  if (o.ids) identifiers.push(...o.ids);
  const relationships = { banList: { data: { type: 'banList', id: o.list || LIST } } };
  if (o.player) relationships.player = { data: { type: 'player', id: String(o.player) } };
  if (o.server) relationships.server = { data: { type: 'server', id: String(o.server) } };
  return {
    type: 'ban',
    id: String(id),
    attributes: {
      uid: `u${id}`, timestamp: o.ts || TS, reason: o.reason == null ? 'Cheating' : o.reason,
      note: o.note == null ? null : o.note, expires: o.expires === undefined ? null : o.expires,
      identifiers, orgWide: o.orgWide === undefined ? true : o.orgWide, autoAddEnabled: true, nativeEnabled: null,
    },
    relationships,
  };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}
function close(server) {
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}
async function waitFor(fn, label, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------- mock BM API

async function startBm(t) {
  const st = {
    lists: [{ id: LIST, name: 'A3 Server bans' }, { id: OTHER, name: 'Partner bans' }],
    bans: { [LIST]: [], [OTHER]: [] },
    players: new Map(), // BM player id -> name (include=player)
    exempt: new Set(), // ban ids the token's organization exempted (hidden by filter[exempt]=false)
    pageSize: 2, // per page, whatever page[size] asks
    leakExpired: false, // answer filter[expired]=false with expired bans too
    links: 'bare', // next link: 'bare' (page[key] only), 'full', 'relative', 'object', 'foreign'
    hide: false, // no bans on the page, while meta still counts them
    failWhen: null, // (url) -> {status, headers?, body?} | null, checked after auth
    requests: [],
  };
  const foreign = { requests: 0 };
  const foreignSrv = http.createServer((req, res) => {
    foreign.requests++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"data":[],"links":{}}');
  });
  await listen(foreignSrv);
  const foreignBase = `http://127.0.0.1:${foreignSrv.address().port}`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    st.requests.push({
      path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization || null, at: Date.now(),
    });
    const send = (status, body, headers) => {
      res.writeHead(status, Object.assign({ 'content-type': 'application/json' }, headers || {}));
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return send(401, { errors: [{ status: '401', title: 'Unauthorized', detail: 'Invalid access token.' }] });
    }
    const injected = st.failWhen && st.failWhen(url);
    if (injected) return send(injected.status, injected.body || { errors: [{ title: 'Injected failure' }] }, injected.headers);
    if (url.pathname === '/ban-lists') {
      return send(200, {
        data: st.lists.map((l) => ({ type: 'banList', id: l.id, attributes: { name: l.name, action: 'kick' } })),
        links: { next: null },
      });
    }
    if (url.pathname !== '/bans') return send(404, { errors: [{ title: 'Not found' }] });
    const listId = url.searchParams.get('filter[banList]');
    if (!st.bans[listId]) return send(404, { errors: [{ status: '404', title: 'Unknown ban list' }] });
    const all = url.searchParams.get('filter[exempt]') === 'false'
      ? st.bans[listId].filter((b) => !(b && b.id != null && st.exempt.has(String(b.id))))
      : st.bans[listId];
    const now = Date.now();
    const expired = (b) => !!(b && b.attributes && typeof b.attributes.expires === 'string'
      && Date.parse(b.attributes.expires) <= now);
    const active = all.filter((b) => !expired(b));
    const shown = url.searchParams.get('filter[expired]') === 'false' && !st.leakExpired ? active : all;
    const per = st.pageSize || Number(url.searchParams.get('page[size]')) || 100;
    const off = Number(url.searchParams.get('page[key]') || 0);
    const slice = st.hide ? [] : shown.slice(off, off + per);
    const included = [];
    if (url.searchParams.get('include') === 'player') {
      for (const b of slice) {
        const pid = b && b.relationships && b.relationships.player && b.relationships.player.data.id;
        if (pid && st.players.has(pid) && !included.some((x) => x.id === pid)) {
          included.push({ type: 'player', id: pid, attributes: { name: st.players.get(pid) } });
        }
      }
    }
    let next = null;
    if (!st.hide && off + per < shown.length) {
      const q = new URLSearchParams();
      if (st.links === 'full') for (const [k, v] of url.searchParams) if (k !== 'page[key]') q.set(k, v);
      q.set('page[key]', String(off + per));
      if (st.links === 'relative') next = `/bans?${q}`;
      else if (st.links === 'object') next = { href: `${base}/bans?${q}` };
      else if (st.links === 'foreign') next = `${foreignBase}/bans?${q}`;
      else next = `${base}/bans?${q}`;
    }
    return send(200, {
      data: slice, included,
      meta: { active: active.length, expired: all.length - active.length, total: all.length },
      links: { next },
    });
  });
  await listen(server);
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => Promise.all([close(server), close(foreignSrv)]));
  return { st, base, foreign, bansRequests: () => st.requests.filter((r) => r.path === '/bans') };
}

// Import module + its own db; logs captured to prove the token never shows.
async function importWorld(t, opts = {}) {
  const bm = await startBm(t);
  const db = opts.db || openDb(':memory:');
  if (!opts.db) {
    db.migrate();
    t.after(() => db.close());
  }
  const config = {
    battlemetrics: Object.assign({ token: TOKEN, banListId: LIST, autoSync: false, syncHours: 6 }, opts.bm || {}),
  };
  const logs = [];
  const log = {
    info: (tag, msg, x) => logs.push(`info ${tag} ${msg} ${x == null ? '' : x}`),
    warn: (tag, msg, x) => logs.push(`warn ${tag} ${msg} ${x == null ? '' : x}`),
    error: (tag, msg, x) => logs.push(`error ${tag} ${msg} ${x == null ? '' : x}`),
  };
  const bus = new EventEmitter();
  const mod = createBattlemetrics({
    db, config, log, bus, admin: null, apiBase: bm.base, timing: Object.assign({}, FAST, opts.timing || {}),
  });
  t.after(() => mod.stop());
  const rows = () => db.prepare(
    "SELECT * FROM bans WHERE source = 'battlemetrics' ORDER BY CAST(external_id AS INTEGER)"
  ).all();
  const row = (ext) => db.prepare("SELECT * FROM bans WHERE source = 'battlemetrics' AND external_id = ?").get(String(ext));
  const active = () => rows().filter((r) => r.active).map((r) => r.external_id);
  // The list membership record, each list's ban ids sorted.
  const owners = () => {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'battlemetrics.listBans'").get();
    const v = r ? JSON.parse(r.value) : {};
    for (const k of Object.keys(v)) v[k].sort((a, b) => Number(a) - Number(b));
    return v;
  };
  return { bm, db, config, logs, bus, mod, rows, row, active, owners };
}

// ================================================================= import

test('listBanLists: names and active counts for the saved token; no token is a 400', async (t) => {
  const w = await importWorld(t);
  w.bm.st.bans[LIST] = [
    bmBan(1, { steam: S(1) }), bmBan(2, { steam: S(2) }), bmBan(3, { steam: S(3) }),
    bmBan(4, { steam: S(4), expires: new Date(Date.now() - DAY).toISOString() }),
  ];
  const lists = await w.mod.listBanLists();
  assert.deepStrictEqual(lists, [
    { id: LIST, name: 'A3 Server bans', banCount: 3 },
    { id: OTHER, name: 'Partner bans', banCount: 0 },
  ]);
  assert.ok(w.bm.st.requests.length >= 3, 'the lists, then one count request per list');
  for (const r of w.bm.st.requests) assert.strictEqual(r.auth, `Bearer ${TOKEN}`, 'Bearer token on every request');

  w.config.battlemetrics.token = '';
  await assert.rejects(w.mod.listBanLists(), (e) => e.status === 400 && /token/.test(e.message));
});

test('import: every page, filters re-applied to bare links, identifiers, notes, names, stubs', async (t) => {
  const w = await importWorld(t);
  const now = Date.now();
  // A player the server has seen: the ban attaches to their row.
  const known = w.db.prepare('INSERT INTO players(eos_id, steam_id, name, first_seen, last_seen) VALUES(?,?,?,?,?)')
    .run(E(1), S(1), 'Known In-Game', now - DAY, now - 1000).lastInsertRowid;
  w.bm.st.players.set('9001', 'Known On BM');
  w.bm.st.players.set('9002', 'Griefer\u0007 ');
  const expiresSoon = new Date(now + 3 * DAY).toISOString();
  const b101 = bmBan(101, { steam: S(1), eos: E(1), player: 9001 });
  w.bm.st.leakExpired = true; // client-side filtering must still drop expired bans
  w.bm.st.bans[LIST] = [
    b101,
    bmBan(102, { steam: S(2), reason: 'Griefing', player: 9002 }),
    bmBan(103, { eos: E(3).toUpperCase(), reason: '[AC] wallhack', note: 'clip [medal] here' }),
    bmBan(104, { steam: S(4), reason: 'Toxic {{timeLeft}}', expires: expiresSoon }),
    bmBan(105, {
      ids: [
        { type: 'steamFamilyShareOwner', identifier: S(95), manual: true }, // the lender, not the player
        { type: 'steamID', identifier: `https://steamcommunity.com/profiles/${S(5)}/` },
        { type: 'steamID', metadata: { profile: { steamid: S(55) } } },
      ],
    }),
    bmBan(106, { steam: S(6), expires: new Date(now - DAY).toISOString() }),
    // Read in full, and names no SteamID/EOS id.
    bmBan(107, {
      ids: [
        { type: 'ip', identifier: '10.0.0.7' }, { type: 'steamID', identifier: '123' }, { type: 'BEGUID', identifier: 'abc' },
        { type: 'steamFamilyShareOwner', identifier: S(97) },
      ],
    }),
    Object.assign(bmBan(108, { steam: S(8) }), { attributes: Object.assign(bmBan(108).attributes, { expires: 'next tuesday' }) }),
    null,
    { type: 'ban' },
    { type: 'ban', id: '110' },
    b101, // listed twice: one ban
  ];

  const out = await w.mod.importNow();
  assert.deepStrictEqual(out, {
    fetched: 11, imported: 5, updated: 0, deactivated: 0, skippedNoIdentifier: 1,
    errors: ['4 ban(s) had an unexpected shape and were skipped (their stored copies were left as they were)'],
  });

  // 12 resources at 2 a page; every page asks for the same filters again.
  const reqs = w.bm.bansRequests();
  assert.strictEqual(reqs.length, 6);
  for (const r of reqs) {
    assert.strictEqual(r.query['filter[banList]'], LIST);
    assert.strictEqual(r.query['filter[expired]'], 'false');
    assert.strictEqual(r.query['filter[exempt]'], 'false');
    assert.strictEqual(r.query.include, 'player');
    assert.strictEqual(r.query['page[size]'], '100');
  }
  assert.deepStrictEqual(reqs.map((r) => r.query['page[key]'] || '0'), ['0', '2', '4', '6', '8', '10']);

  const rows = w.rows();
  assert.deepStrictEqual(rows.map((r) => r.external_id), ['101', '102', '103', '104', '105']);
  for (const r of rows) {
    assert.strictEqual(r.active, 1);
    assert.strictEqual(r.issued_by, null);
    assert.strictEqual(r.issued_at, Date.parse(TS));
    assert.strictEqual(r.rcon_ok, null);
  }
  const [r101, r102, r103, r104, r105] = rows;
  assert.strictEqual(r101.player_id, known, 'known player by EOS id: no stub');
  assert.strictEqual(r101.steam_id, S(1));
  assert.strictEqual(r101.eos_id, E(1));
  assert.strictEqual(r101.reason, 'Cheating');
  assert.strictEqual(r101.expires_at, null);
  assert.strictEqual(r101.duration_sec, 0, 'permanent');
  assert.strictEqual(w.db.prepare('SELECT name FROM players WHERE id = ?').get(known).name, 'Known In-Game',
    'a real player row is never renamed from BM');

  const stub = w.db.prepare('SELECT * FROM players WHERE id = ?').get(r102.player_id);
  assert.strictEqual(stub.name, 'Griefer', 'stub named from BM (control chars stripped)');
  assert.strictEqual(stub.steam_id, S(2));
  assert.strictEqual(stub.eos_id, null);
  assert.strictEqual(stub.first_seen, Date.parse(TS), 'stub dated at the ban, not now');
  assert.strictEqual(stub.last_seen, Date.parse(TS));

  assert.strictEqual(r103.eos_id, E(3), 'EOS id lower-cased');
  assert.strictEqual(r103.steam_id, null);
  assert.strictEqual(r103.reason, '(AC) wallhack', 'brackets in a reason become parentheses; the note stays out');
  assert.strictEqual(r103.note, 'clip [medal] here', 'the BM admin note lands in the private note column');
  assert.strictEqual(r101.note, null, 'no BM note: none stored');
  assert.strictEqual(w.db.prepare('SELECT name FROM players WHERE id = ?').get(r103.player_id).name, '(BattleMetrics ban)');

  assert.strictEqual(r104.expires_at, Date.parse(expiresSoon));
  assert.strictEqual(r104.duration_sec, Math.round((Date.parse(expiresSoon) - Date.parse(TS)) / 1000));
  assert.strictEqual(r104.reason, 'Toxic {{timeLeft}}', 'templates are stored as BM has them');
  assert.strictEqual(r105.steam_id, S(5), 'SteamID found inside a profile address');

  assert.strictEqual(w.row(106), undefined, 'expired on BM: never imported');
  assert.strictEqual(w.row(107), undefined, 'no usable Steam/EOS id: skipped');
  assert.strictEqual(w.row(108), undefined, 'unreadable expiry: skipped');
  const players = w.db.prepare('SELECT COUNT(*) AS n FROM players').get().n;
  assert.strictEqual(players, 5, 'one known + four stubs');

  const st = w.mod.status();
  assert.strictEqual(st.configured, true);
  assert.strictEqual(st.running, false);
  assert.ok(st.lastSyncAt >= now);
  assert.deepStrictEqual(st.lastResult, out);
  assert.strictEqual(st.nextSyncAt, null, 'not started');
});

test('re-sync: idempotent, updates in place, deactivates gone/expired/unidentified, never touches local bans or panel unbans', async (t) => {
  const w = await importWorld(t);
  w.bm.st.links = 'relative';
  w.bm.st.bans[LIST] = [
    bmBan(1, { steam: S(1) }), bmBan(2, { steam: S(2) }), bmBan(3, { steam: S(3), reason: 'Racism', note: 'clip:\n https://x' }),
    bmBan(4, { steam: S(4), expires: new Date(Date.now() + 5 * DAY).toISOString() }), bmBan(5, { eos: E(5) }),
  ];
  // A ban issued in the panel for one of the same players.
  const local = w.db.prepare(
    'INSERT INTO bans(player_id, steam_id, issued_by, issued_at, duration_sec, expires_at, reason, interval_raw, active, rcon_ok) VALUES(?,?,?,?,?,?,?,?,?,?)'
  ).run(null, S(1), 1, Date.now(), 0, null, 'local reason', '0', 1, 1).lastInsertRowid;
  const localBefore = w.db.prepare('SELECT * FROM bans WHERE id = ?').get(local);

  let out = await w.mod.importNow();
  assert.strictEqual(out.imported, 5);
  assert.strictEqual(w.row(3).note, 'clip:\n https://x', 'line breaks in a note are kept');
  out = await w.mod.importNow();
  assert.deepStrictEqual(out, { fetched: 5, imported: 0, updated: 0, deactivated: 0, skippedNoIdentifier: 0, errors: [] },
    'a second identical import changes nothing');

  // Upstream: 1 deleted, 3 reworded, 4 revoked (expiry moved to the past),
  // 2 lost its SteamID; here: 5 unbanned by a panel admin.
  const revokedAt = new Date(Date.now() - 60000).toISOString();
  w.bm.st.bans[LIST] = [
    bmBan(2, { ids: [{ type: 'ip', identifier: '1.2.3.4' }] }),
    bmBan(3, { steam: S(3), reason: 'Racism in all chat', note: 'second clip' }),
    bmBan(4, { steam: S(4), expires: revokedAt }),
    bmBan(5, { eos: E(5) }),
  ];
  w.bm.st.leakExpired = true; // BM still lists the revoked one
  w.db.prepare("UPDATE bans SET active = 0, unbanned_by = 7, unbanned_at = 1 WHERE source = 'battlemetrics' AND external_id = '5'").run();

  out = await w.mod.importNow();
  assert.deepStrictEqual(out, { fetched: 4, imported: 0, updated: 1, deactivated: 3, skippedNoIdentifier: 1, errors: [] });
  assert.strictEqual(w.row(1).active, 0, 'gone from the list');
  assert.strictEqual(w.row(2).active, 0, 'its SteamID is no longer banned');
  assert.strictEqual(w.row(4).active, 0, 'expired on BM');
  assert.strictEqual(w.row(4).expires_at, Date.parse(revokedAt));
  assert.strictEqual(w.row(3).active, 1);
  assert.strictEqual(w.row(3).reason, 'Racism in all chat', 'updated in place');
  assert.strictEqual(w.row(3).note, 'second clip', 'the note follows BM like the reason');
  assert.strictEqual(w.rows().filter((r) => r.external_id === '3').length, 1);
  assert.strictEqual(w.row(5).active, 0, 'a panel unban stands');
  assert.strictEqual(w.row(5).unbanned_by, 7);
  for (const id of [1, 2, 4]) {
    assert.strictEqual(w.row(id).unbanned_by, null, 'import deactivations are system ones');
    assert.ok(w.row(id).unbanned_at > 0);
  }
  assert.deepStrictEqual(w.db.prepare('SELECT * FROM bans WHERE id = ?').get(local), localBefore, 'local ban untouched');

  // Ban 1 comes back upstream: the import's own deactivation is undone.
  w.bm.st.bans[LIST].push(bmBan(1, { steam: S(1) }));
  out = await w.mod.importNow();
  assert.strictEqual(out.updated, 1);
  assert.strictEqual(w.row(1).active, 1);
  assert.strictEqual(w.row(1).unbanned_at, null);
  assert.strictEqual(w.row(5).active, 0, 'still unbanned in the panel');
});

test('identifiers that cannot be read are reported and keep the stored copy; read ones naming no Steam/EOS id deactivate it', async (t) => {
  const w = await importWorld(t);
  w.bm.st.pageSize = 100;
  w.bm.st.bans[LIST] = [1, 2, 3, 4, 5].map((n) => bmBan(n, { steam: S(n) }));
  assert.strictEqual((await w.mod.importNow()).imported, 5);
  const shaped = (n, identifiers) => {
    const b = bmBan(n);
    if (identifiers === undefined) delete b.attributes.identifiers;
    else b.attributes.identifiers = identifiers;
    return b;
  };
  w.bm.st.bans[LIST] = [
    shaped(1, undefined), // the attribute is gone (a token without the scope?)
    shaped(2, { 0: { type: 'steamID', identifier: S(2) } }), // not a list
    shaped(3, [12345678, { identifier: S(3) }]), // a reference; an entry without a type
    shaped(4, [{ type: 'steamID', identifier: 76561198000000004 }, { type: 'eosID', id: 77 }]), // number; no value
    shaped(5, [{ type: 'ip', identifier: '10.0.0.5' }, { type: 'steamID', identifier: '123' }]), // read: no usable id
    shaped(6, [99, { type: 'steamID', identifier: S(6) }]), // one readable id is enough
  ];
  let out = await w.mod.importNow();
  assert.deepStrictEqual(out, {
    fetched: 6, imported: 1, updated: 0, deactivated: 1, skippedNoIdentifier: 1,
    errors: ['4 ban(s) had an unexpected shape and were skipped (their stored copies were left as they were)'],
  });
  assert.deepStrictEqual(w.active(), ['1', '2', '3', '4', '6']);
  assert.strictEqual(w.row(6).steam_id, S(6));

  // Expired upstream needs no identity: that stored copy goes.
  w.bm.st.leakExpired = true;
  w.bm.st.bans[LIST][0].attributes.expires = new Date(Date.now() - 60000).toISOString();
  out = await w.mod.importNow();
  assert.strictEqual(out.deactivated, 1);
  assert.match(out.errors[0], /^3 ban\(s\) had an unexpected shape/);
  assert.deepStrictEqual(w.active(), ['2', '3', '4', '6']);
});

test('bans exempted on BM are not read; with battlemetrics.serverId set, server-only bans for other BM servers are left out', async (t) => {
  const w = await importWorld(t);
  w.bm.st.pageSize = 100;
  w.bm.st.bans[LIST] = [
    bmBan(1, { steam: S(1) }),
    bmBan(2, { steam: S(2) }), // exempted by this organization
    bmBan(3, { steam: S(3), orgWide: false, server: 111 }), // server-only: this server
    bmBan(4, { steam: S(4), orgWide: false, server: 222 }), // server-only: another one
    bmBan(5, { steam: S(5), orgWide: false }), // server-only, no server named
    bmBan(6, { steam: S(6), server: 222 }), // org-wide, issued on another server
  ];
  w.bm.st.exempt.add('2');
  let out = await w.mod.importNow();
  assert.deepStrictEqual([out.fetched, out.imported], [5, 5], 'serverId unset: every server-only ban is enforced');
  assert.strictEqual(w.row(2), undefined, 'exempted: never read');
  for (const r of w.bm.bansRequests()) assert.strictEqual(r.query['filter[exempt]'], 'false');
  assert.ok(w.logs.some((l) => /2 server-only ban\(s\) enforced as if for this server/.test(l)));

  w.config.battlemetrics.serverId = '111';
  out = await w.mod.importNow();
  assert.deepStrictEqual([out.imported, out.updated, out.deactivated, out.errors.length], [0, 0, 1, 0]);
  assert.deepStrictEqual(w.active(), ['1', '3', '5', '6']);
  assert.ok(w.logs.some((l) => /1 of 2 server-only ban\(s\) for other BattleMetrics servers left out/.test(l)));

  // The exemption lifted and ban 4 made org-wide on BM: both in force.
  w.bm.st.exempt.clear();
  w.bm.st.bans[LIST][3] = bmBan(4, { steam: S(4) });
  out = await w.mod.importNow();
  assert.deepStrictEqual([out.imported, out.updated, out.deactivated], [1, 1, 0]);
  assert.deepStrictEqual(w.active(), ['1', '2', '3', '4', '5', '6']);
});

test('a read that cannot finish deactivates nothing; one-off imports of another list never weaken the configured one', async (t) => {
  const w = await importWorld(t);
  w.bm.st.links = 'object';
  w.bm.st.bans[LIST] = [1, 2, 3, 4, 5].map((n) => bmBan(n, { steam: S(n) }));
  assert.strictEqual((await w.mod.importNow()).imported, 5);
  w.bm.st.bans[LIST] = [6, 7, 8, 9].map((n) => bmBan(n, { steam: S(n) })); // 1-5 removed upstream

  // Page 2 keeps failing with 5xx: page 1's bans are saved, nothing deactivated.
  w.bm.st.failWhen = (url) => (url.searchParams.get('page[key]') === '2' ? { status: 503 } : null);
  const page2Before = w.bm.bansRequests().filter((r) => r.query['page[key]'] === '2').length;
  let out = await w.mod.importNow();
  assert.strictEqual(out.imported, 2, 'bans 6 and 7 from the page that was read');
  assert.strictEqual(out.deactivated, 0);
  assert.match(out.errors[0], /HTTP 503/);
  assert.match(out.errors[1], /not read to the end/);
  assert.strictEqual(w.bm.bansRequests().filter((r) => r.query['page[key]'] === '2').length - page2Before, 3,
    'tried 3 times');
  assert.strictEqual(w.rows().filter((r) => r.active).length, 7);
  assert.strictEqual(w.mod.status().lastResult.deactivated, 0);
  w.bm.st.failWhen = null;

  // A next link to another host is never followed: the token stays home.
  w.bm.st.links = 'foreign';
  out = await w.mod.importNow();
  assert.match(out.errors[0], /another address/);
  assert.strictEqual(out.deactivated, 0);
  assert.strictEqual(w.bm.foreign.requests, 0, 'nothing sent to the other host');
  w.bm.st.links = 'bare';

  // BM counts bans it does not show (token may not see them): nothing goes.
  w.bm.st.hide = true;
  out = await w.mod.importNow();
  assert.strictEqual(out.fetched, 0);
  assert.match(out.errors[0], /counts 4 active bans on the list but only 0 were read/);
  assert.strictEqual(out.deactivated, 0);
  assert.strictEqual(w.rows().filter((r) => r.active).length, 7);
  w.bm.st.hide = false;

  // A one-off import of another list adds, and deactivates nothing of LIST.
  w.bm.st.bans[OTHER] = [bmBan(50, { steam: S(50), list: OTHER })];
  out = await w.mod.importNow({ banListId: OTHER });
  assert.deepStrictEqual([out.imported, out.deactivated], [1, 0]);
  assert.strictEqual(w.rows().filter((r) => r.active).length, 8);

  // The configured list read in full mirrors it: 1-5 go; 50 is OTHER's.
  out = await w.mod.importNow();
  assert.deepStrictEqual([out.imported, out.deactivated, out.errors.length], [2, 5, 0]);
  assert.deepStrictEqual(w.active(), ['6', '7', '8', '9', '50']);
});

test('lists mirror separately: a full read deactivates only its own missing bans; a moved ban follows its list', async (t) => {
  // No list saved yet: Settings imports whichever list is picked.
  const w = await importWorld(t, { bm: { banListId: '' } });
  w.bm.st.pageSize = 100;
  w.bm.st.bans[LIST] = [bmBan(1, { steam: S(1) }), bmBan(2, { steam: S(2) })];
  w.bm.st.bans[OTHER] = [bmBan(10, { steam: S(10), list: OTHER }), bmBan(11, { steam: S(11), list: OTHER })];
  assert.strictEqual((await w.mod.importNow({ banListId: LIST })).imported, 2);
  let out = await w.mod.importNow({ banListId: OTHER });
  assert.deepStrictEqual([out.imported, out.deactivated], [2, 0], 'reading OTHER leaves LIST alone');
  assert.deepStrictEqual(w.active(), ['1', '2', '10', '11']);
  assert.deepStrictEqual(w.owners(), { [LIST]: ['1', '2'], [OTHER]: ['10', '11'] });

  // Upstream: 10 deleted from OTHER; 2 moved from LIST to OTHER.
  w.bm.st.bans[LIST] = [bmBan(1, { steam: S(1) })];
  w.bm.st.bans[OTHER] = [bmBan(11, { steam: S(11), list: OTHER }), bmBan(2, { steam: S(2), list: OTHER })];
  out = await w.mod.importNow({ banListId: OTHER });
  assert.deepStrictEqual([out.imported, out.updated, out.deactivated], [0, 0, 1], '10 is gone from OTHER');
  out = await w.mod.importNow({ banListId: LIST });
  assert.deepStrictEqual([out.imported, out.updated, out.deactivated], [0, 0, 0], '2 is OTHER\'s now');
  assert.deepStrictEqual(w.active(), ['1', '2', '11']);
  assert.deepStrictEqual(w.owners(), { [LIST]: ['1'], [OTHER]: ['2', '11'] }, 'a deactivated absentee is no list\'s');

  // Membership is persisted: a fresh instance (a restart) keeps it.
  const again = await importWorld(t, { db: w.db, bm: { banListId: '' } });
  again.bm.st.bans[LIST] = []; // emptied upstream, and BM counts none
  again.bm.st.bans[OTHER] = [bmBan(11, { steam: S(11), list: OTHER }), bmBan(2, { steam: S(2), list: OTHER })];
  out = await again.mod.importNow({ banListId: LIST });
  assert.deepStrictEqual([out.fetched, out.deactivated, out.errors.length], [0, 1, 0]);
  assert.deepStrictEqual(again.active(), ['2', '11']);

  // A lost or unreadable record deactivates nothing by absence until a list claims its bans again.
  w.db.prepare("UPDATE settings SET value = '{not json' WHERE key = 'battlemetrics.listBans'").run();
  again.bm.st.bans[OTHER] = [bmBan(11, { steam: S(11), list: OTHER })];
  out = await again.mod.importNow({ banListId: OTHER });
  assert.deepStrictEqual([out.deactivated, out.errors.length], [0, 0], '2 is claimed by no list');
  assert.deepStrictEqual(again.active(), ['2', '11']);
  assert.deepStrictEqual(again.owners(), { [OTHER]: ['11'] }, 'rewritten from the read');
  assert.ok(again.logs.some((l) => /membership record unreadable/.test(l)));
});

test('auto-sync follows the saved list\'s own last run: a one-off import of another list neither triggers it nor hides its result', async (t) => {
  const w = await importWorld(t, { bm: { autoSync: true }, timing: { bootDelayMs: 50 } });
  w.bm.st.pageSize = 100;
  w.bm.st.bans[LIST] = [bmBan(1, { steam: S(1) })];
  w.bm.st.bans[OTHER] = [bmBan(10, { steam: S(10), list: OTHER }), bmBan(11, { steam: S(11), list: OTHER })];
  await w.mod.importNow();
  w.mod.start();
  const next = w.mod.status().nextSyncAt;
  assert.ok(next > Date.now() + 5 * 3600000, 'syncHours after LIST\'s run');
  const out = await w.mod.importNow({ banListId: OTHER });
  assert.deepStrictEqual([out.imported, out.deactivated], [2, 0]);
  assert.strictEqual(w.mod.status().nextSyncAt, next, 'still from LIST\'s own run');
  await new Promise((r) => setTimeout(r, 200)); // well past bootDelayMs
  assert.strictEqual(w.bm.bansRequests().filter((r) => r.query['filter[banList]'] === LIST).length, 1, 'no early LIST sync');
  assert.deepStrictEqual(w.mod.status().lastResult, out, 'status shows the latest run');
  assert.deepStrictEqual(w.active(), ['1', '10', '11']);

  // A restart reads LIST's own run back from the record.
  w.mod.stop();
  const again = await importWorld(t, { db: w.db, bm: { autoSync: true }, timing: { bootDelayMs: 50 } });
  again.mod.start();
  assert.strictEqual(again.mod.status().nextSyncAt, next);
  again.mod.stop();
});

test('401 lands in the result, writes nothing; the token never reaches logs, results, status or the db', async (t) => {
  const w = await importWorld(t, { bm: { token: 'wrong-token-zzzzzzzzzzzz' } });
  w.bm.st.bans[LIST] = [bmBan(1, { steam: S(1) })];
  let out = await w.mod.importNow();
  assert.deepStrictEqual(out.fetched, 0);
  assert.strictEqual(out.errors.length, 1);
  assert.match(out.errors[0], /rejected the API token \(HTTP 401\)/);
  assert.strictEqual(w.rows().length, 0);
  assert.strictEqual(w.bm.bansRequests().length, 1, 'an auth failure is not retried');

  w.config.battlemetrics.token = TOKEN;
  out = await w.mod.importNow();
  assert.strictEqual(out.imported, 1);
  const stored = w.db.prepare("SELECT value FROM settings WHERE key = 'battlemetrics.lastSync'").get().value;
  for (const text of [JSON.stringify(out), JSON.stringify(w.mod.status()), stored, w.logs.join('\n')]) {
    assert.ok(!text.includes(TOKEN), 'good token never echoed');
    assert.ok(!text.includes('wrong-token-zzzzzzzzzzzz'), 'bad token never echoed');
  }
});

test('429: Retry-After is waited out in full, a bare 429 waits the default, a huge one fails fast', async (t) => {
  const w = await importWorld(t);
  w.bm.st.pageSize = 100;
  w.bm.st.bans[LIST] = [bmBan(1, { steam: S(1) })];
  let n429 = 0;
  w.bm.st.failWhen = () => (n429++ === 0 ? { status: 429, headers: { 'retry-after': '1' } } : null);
  const t0 = Date.now();
  let out = await w.mod.importNow();
  assert.ok(Date.now() - t0 >= 950, `waited ${Date.now() - t0}ms for Retry-After: 1`);
  assert.deepStrictEqual([out.imported, out.errors.length], [1, 0]);
  assert.strictEqual(w.bm.bansRequests().length, 2);

  n429 = 0;
  w.bm.st.failWhen = () => (n429++ === 0 ? { status: 429 } : null);
  out = await w.mod.importNow();
  assert.deepStrictEqual(out.errors, [], 'no Retry-After: retried after the default pause');

  // A nearly spent budget (X-Rate-Limit-Remaining) pauses the next request.
  w.bm.st.pageSize = 1;
  w.bm.st.bans[LIST].push(bmBan(2, { steam: S(2) }));
  let first = true;
  w.bm.st.failWhen = () => {
    if (!first) return null;
    first = false;
    return { status: 200, headers: { 'x-rate-limit-remaining': '0' }, body: {
      data: [bmBan(1, { steam: S(1) })], meta: { active: 2 }, links: { next: `${w.bm.base}/bans?page[key]=1` },
    } };
  };
  const from = w.bm.bansRequests().length;
  out = await w.mod.importNow();
  assert.deepStrictEqual([out.imported, out.errors.length], [1, 0]);
  const [p1, p2] = w.bm.bansRequests().slice(from);
  assert.ok(p2.at - p1.at >= 45, `paused ${p2.at - p1.at}ms after a spent budget`);

  w.bm.st.failWhen = () => ({ status: 429, headers: { 'retry-after': '3600' } });
  const before = w.bm.bansRequests().length;
  out = await w.mod.importNow();
  assert.match(out.errors[0], /asks to wait 3600s/);
  assert.strictEqual(w.bm.bansRequests().length, before + 1, 'not retried inside the long wait');
  assert.strictEqual(w.row(1).active, 1, 'nothing deactivated');
  await assert.rejects(w.mod.listBanLists(), /try again in \d+s/, 'later calls fail fast instead of hanging');
});

test('stop() ends an import in flight: nothing written, nothing recorded', async (t) => {
  const w = await importWorld(t, { timing: { retryDelaysMs: [300, 300] } });
  w.bm.st.bans[LIST] = [bmBan(1, { steam: S(1) })];
  w.bm.st.failWhen = () => ({ status: 503 });
  const p = w.mod.importNow();
  await waitFor(() => w.bm.bansRequests().length === 1, 'the first attempt');
  w.mod.stop();
  const out = await p;
  assert.match(out.errors[0], /stopped/);
  assert.strictEqual(w.rows().length, 0);
  assert.strictEqual(w.mod.status().lastSyncAt, null, 'a stopped run is not a sync');
  assert.strictEqual(w.mod.status().running, false);
});

test('importNow preconditions and overlap; status persists; auto-sync schedules, runs and stops', async (t) => {
  const w = await importWorld(t, { bm: { banListId: '' } });
  w.bm.st.bans[LIST] = [bmBan(1, { steam: S(1) })];
  await assert.rejects(w.mod.importNow(), (e) => e.status === 400 && /ban list/.test(e.message));
  await assert.rejects(w.mod.importNow({ banListId: 'not a list/id' }), (e) => e.status === 400);
  assert.strictEqual(w.mod.status().configured, false);

  w.config.battlemetrics.banListId = LIST;
  const p1 = w.mod.importNow();
  assert.strictEqual(w.mod.importNow(), p1, 'the same list joins the running import');
  await assert.rejects(w.mod.importNow({ banListId: OTHER }), (e) => e.status === 409);
  assert.strictEqual(w.mod.status().running, true);
  await p1;
  assert.strictEqual(w.mod.status().running, false);
  const at = w.mod.status().lastSyncAt;

  // Another instance on the same db reads the persisted record.
  const again = await importWorld(t, { db: w.db });
  assert.strictEqual(again.mod.status().lastSyncAt, at);
  assert.deepStrictEqual(again.mod.status().lastResult, w.mod.status().lastResult);

  // Auto-sync: due now -> runs after bootDelayMs; then every syncHours.
  w.config.battlemetrics.autoSync = true;
  w.db.prepare("DELETE FROM settings WHERE key = 'battlemetrics.lastSync'").run();
  const fresh = await importWorld(t, { db: w.db, bm: { autoSync: true } });
  fresh.bm.st.bans[LIST] = [bmBan(1, { steam: S(1) })];
  fresh.mod.start();
  assert.ok(fresh.mod.status().nextSyncAt > Date.now() - 5, 'scheduled');
  await waitFor(() => fresh.mod.status().lastSyncAt != null && !fresh.mod.status().running, 'the auto-sync run');
  const s = fresh.mod.status();
  assert.deepStrictEqual(s.lastResult.errors, []);
  assert.strictEqual(fresh.bm.bansRequests().length, 1);
  assert.ok(Math.abs(s.nextSyncAt - (s.lastSyncAt + 6 * 3600000)) < 1000, 'next run syncHours after the last');

  fresh.config.battlemetrics.autoSync = false;
  fresh.mod.reconfigure();
  assert.strictEqual(fresh.mod.status().nextSyncAt, null, 'autoSync off: nothing scheduled');
  fresh.config.battlemetrics.autoSync = true;
  fresh.mod.reconfigure();
  assert.ok(fresh.mod.status().nextSyncAt > Date.now() + 5 * 3600000, 'back on: from the last run');
  fresh.mod.stop();
  assert.strictEqual(fresh.mod.status().nextSyncAt, null);

  // A run that could not finish its read is retried sooner.
  fresh.config.battlemetrics.token = 'wrong-token-zzzzzzzzzzzz';
  await fresh.mod.importNow();
  fresh.mod.start();
  const f = fresh.mod.status();
  assert.ok(Math.abs(f.nextSyncAt - (f.lastSyncAt + FAST.retryFailedMs)) < 1000, 'retryFailedMs after a failed run');
  fresh.mod.stop();
});

test('config: battlemetrics block in defaults, schema and SETTINGS_ALLOW; the token is a secret', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-bm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig(path.join(dir, 'missing.json'));
  assert.deepStrictEqual(cfg.battlemetrics, { token: '', banListId: '', autoSync: false, syncHours: 6 });

  let res = applySettingsPatch(cfg, {
    battlemetrics: {
      token: TOKEN, banListId: LIST, autoSync: true, syncHours: 12, apiBase: 'http://evil.example', serverId: '42',
    },
  });
  assert.deepStrictEqual(res.changedPaths.sort(), [
    'battlemetrics.autoSync', 'battlemetrics.banListId', 'battlemetrics.syncHours', 'battlemetrics.token',
  ]);
  assert.strictEqual(cfg.battlemetrics.apiBase, undefined, 'apiBase is file-only');
  assert.strictEqual(cfg.battlemetrics.serverId, undefined, 'serverId is file-only');
  res = applySettingsPatch(cfg, { battlemetrics: { token: null } });
  assert.deepStrictEqual(res.changedPaths, [], 'null keeps the saved token');
  assert.strictEqual(cfg.battlemetrics.token, TOKEN);

  assert.throws(
    () => applySettingsPatch(cfg, { battlemetrics: { token: 12345, banListId: 'https://x/y', syncHours: 0 } }),
    (e) => /battlemetrics\.token \(expected string\)/.test(e.message)
      && /battlemetrics\.banListId/.test(e.message) && /battlemetrics\.syncHours/.test(e.message)
      && !e.message.includes('12345')
  );
  assert.strictEqual(cfg.battlemetrics.syncHours, 12, 'invalid patch left cfg untouched');
  res = applySettingsPatch(cfg, { battlemetrics: { token: '' } });
  assert.deepStrictEqual(res.changedPaths, ['battlemetrics.token'], '"" clears');

  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ battlemetrics: { apiBase: 'ftp://nope' } }));
  assert.throws(() => loadConfig(file), /battlemetrics\.apiBase/);
  fs.writeFileSync(file, JSON.stringify({ battlemetrics: { apiBase: 'http://127.0.0.1:9' } }));
  assert.strictEqual(loadConfig(file).battlemetrics.apiBase, 'http://127.0.0.1:9');
  fs.writeFileSync(file, JSON.stringify({ battlemetrics: { serverId: 1234567 } }));
  assert.throws(() => loadConfig(file), /battlemetrics\.serverId/);
  fs.writeFileSync(file, JSON.stringify({ battlemetrics: { serverId: '1234567' } }));
  assert.strictEqual(loadConfig(file).battlemetrics.serverId, '1234567');
});

// ============================================================ enforcement

function adminStub() {
  return {
    calls: [],
    execAdmin(user, action, params) {
      this.calls.push({ user, action, params });
      return Promise.resolve({ ok: true, rconOk: true, command: `stub:${action}`, response: 'OK' });
    },
    execRaw(user, command, meta) {
      this.calls.push({ user, action: 'raw', command, meta });
      return Promise.resolve({ ok: true, rconOk: true, command, response: 'OK' });
    },
  };
}

function enforceWorld(t, db) {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const state = new LiveState();
  const admin = adminStub();
  const ingest = new Ingest({ db, state, bus, config: { flags: {}, retention: {} }, admin });
  t.after(() => ingest.stop());
  const row = (i) => ({
    playerId: 10 + i, eosId: E(i), steamId: S(i), name: `Player${i}`, teamId: 1, squadId: null, isLeader: false, role: 'USA_Rifleman_01',
  });
  return {
    bus, state, admin, ingest, row,
    kicks: () => admin.calls.filter((c) => c.action === 'raw' && c.meta && c.meta.action === 'ban-enforce'),
    log: (ev) => bus.emit('log-event', Object.assign({ raw: '' }, ev)),
    poll: (time, rows) => state.applyListPlayers({ online: rows, disconnected: [] }, time),
  };
}

test('log path: imported bans kick by SteamID or EOS id, audited ban-enforce; notes never reach the player', async (t) => {
  const w = await importWorld(t);
  const exp = Date.now() + 2 * DAY + 3 * 3600000 + 60000;
  w.bm.st.bans[LIST] = [
    bmBan(1, { steam: S(1), reason: 'Aimbot | {{timeLeft}} left {{appealUrl}}', note: 'staff only: clip', expires: new Date(exp).toISOString() }),
    bmBan(2, { eos: E(2), reason: 'Ban evasion' }),
  ];
  assert.strictEqual((await w.mod.importNow()).imported, 2);
  const e = enforceWorld(t, w.db);
  e.poll(Date.now(), []); // boot baseline: an empty server

  e.log({ event: 'PLAYER_CONNECTED', time: Date.now(), eosId: E(91), steamId: S(1), controller: 'PC_1', ip: '10.0.0.1' });
  let k = e.kicks();
  assert.strictEqual(k.length, 1);
  assert.strictEqual(k[0].user, null, 'system action');
  const until = new Date(exp).toISOString().slice(0, 10);
  assert.strictEqual(k[0].command, `AdminKick ${S(1)} Banned: Aimbot | 2d 3h left (until ${until})`);
  assert.ok(!k[0].command.includes('staff only'), 'the BM admin note is never shown');
  const pid = w.db.prepare('SELECT id FROM players WHERE eos_id = ?').get(E(91)).id;
  assert.strictEqual(k[0].meta.targetPlayerId, pid, 'the connecting player, not the stub');
  assert.deepStrictEqual(k[0].meta.details, {
    banId: w.row(1).id, source: 'battlemetrics', externalId: '1', matchedBy: 'steam', via: 'log',
    reason: `Banned: Aimbot | 2d 3h left (until ${until})`,
  });
  assert.strictEqual(e.admin.calls.filter((c) => c.action === 'kick').length, 0, 'no second, unaudited kick path');

  // EOS-only ban: the import's stub carries the EOS id, so the connecting
  // player adopts that row. At log time there is no in-game id or SteamID
  // yet: nothing is sent, and the roster's join (it knows the id) kicks.
  e.log({ event: 'PLAYER_CONNECTED', time: Date.now(), eosId: E(2), steamId: null, controller: 'PC_2', ip: '10.0.0.2' });
  assert.strictEqual(w.db.prepare('SELECT id FROM players WHERE eos_id = ?').get(E(2)).id, w.row(2).player_id,
    'the stub row is adopted, not duplicated');
  assert.strictEqual(e.kicks().length, 1);
  e.poll(Date.now(), [Object.assign(e.row(2), { steamId: null })]);
  k = e.kicks();
  assert.strictEqual(k.length, 2);
  assert.strictEqual(k[1].command, 'AdminKickById 12 Banned: Ban evasion (until perm)');
  assert.strictEqual(k[1].meta.details.matchedBy, 'player');
  assert.strictEqual(k[1].meta.details.via, 'roster');

  // A ban that only names an EOS id matches a player row that does not.
  w.db.prepare("INSERT INTO bans(eos_id, reason, active, source, external_id) VALUES(?, 'Alt account', 1, 'battlemetrics', '99')").run(E(3));
  e.log({ event: 'PLAYER_CONNECTED', time: Date.now(), eosId: E(3), steamId: S(3), controller: 'PC_3', ip: '10.0.0.3' });
  k = e.kicks();
  assert.strictEqual(k.length, 3);
  assert.strictEqual(k[2].command, `AdminKick ${S(3)} Banned: Alt account (until perm)`);
  assert.strictEqual(k[2].meta.details.matchedBy, 'eos');
});

test('one kick per player per 60 s across log, roster and poll; a reconnect inside the gap is kicked after it', async (t) => {
  const db = openDb(':memory:');
  db.migrate();
  t.after(() => db.close());
  db.prepare("INSERT INTO bans(steam_id, reason, active, source, external_id) VALUES(?, 'Wallhack', 1, 'battlemetrics', '77')").run(S(1));
  const T = Date.UTC(2026, 10, 2, 20, 0, 0);
  t.mock.timers.enable({ apis: ['Date'], now: T });
  const e = enforceWorld(t, db);
  e.poll(T, []);

  e.log({ event: 'PLAYER_CONNECTED', time: T, eosId: E(1), steamId: S(1), controller: 'PC_1', ip: '10.0.0.1' });
  assert.strictEqual(e.kicks().length, 1, 'log path kicks');
  t.mock.timers.setTime(T + 15000);
  e.poll(T + 15000, [e.row(1)]); // the roster reports the same connection
  assert.strictEqual(e.kicks().length, 1, 'roster join inside the gap: no second kick');
  t.mock.timers.setTime(T + 30000);
  e.poll(T + 30000, [e.row(1)]); // the kick did not land / they came straight back
  assert.strictEqual(e.kicks().length, 1, 'poll inside the gap: no kick');
  t.mock.timers.setTime(T + 61000);
  e.poll(T + 61000, [e.row(1)]);
  const k = e.kicks();
  assert.strictEqual(k.length, 2, 'still online after the gap: kicked again');
  assert.strictEqual(k[1].command, 'AdminKickById 11 Banned: Wallhack (until perm)');
  assert.strictEqual(k[1].meta.details.via, 'poll');
  t.mock.timers.setTime(T + 70000);
  e.log({ event: 'PLAYER_CONNECTED', time: T + 70000, eosId: E(1), steamId: S(1), controller: 'PC_9', ip: '10.0.0.1' });
  assert.strictEqual(e.kicks().length, 2, 'reconnect inside the new gap waits for the sweep');
});

test('log connect of a reconnect whose disconnect line never came: never kicked by the old connection\'s in-game id', (t) => {
  const db = openDb(':memory:');
  db.migrate();
  t.after(() => db.close());
  const e = enforceWorld(t, db);
  const T = Date.now();
  e.poll(T, [e.row(1), Object.assign(e.row(2), { steamId: null })]); // online: in-game ids 11 and 12
  db.prepare("INSERT INTO bans(steam_id, reason, active, source, external_id) VALUES(?, 'Wallhack', 1, 'battlemetrics', '1')").run(S(1));
  db.prepare("INSERT INTO bans(eos_id, reason, active, source, external_id) VALUES(?, 'Alt account', 1, 'battlemetrics', '2')").run(E(2));

  // Both reconnect before the next poll; neither disconnect line arrived.
  e.log({ event: 'PLAYER_CONNECTED', time: T + 3000, eosId: E(1), steamId: S(1), controller: 'PC_n1', ip: '10.0.0.1' });
  e.log({ event: 'PLAYER_CONNECTED', time: T + 3000, eosId: E(2), steamId: null, controller: 'PC_n2', ip: '10.0.0.2' });
  assert.deepStrictEqual(e.kicks().map((k) => k.command), [`AdminKick ${S(1)} Banned: Wallhack (until perm)`],
    'by SteamID; no SteamID for player 2: nothing sent, no gap started');

  // The next poll lists player 2's new in-game id: the sweep kicks by it.
  e.poll(T + 15000, [Object.assign(e.row(2), { playerId: 40, steamId: null })]);
  const k = e.kicks();
  assert.strictEqual(k.length, 2);
  assert.strictEqual(k[1].command, 'AdminKickById 40 Banned: Alt account (until perm)');
  assert.deepStrictEqual([k[1].meta.details.via, k[1].meta.details.matchedBy], ['poll', 'eos']);
});

test('local bans keep working: player-id match, same kick text; expired and lifted bans never kick', (t) => {
  const db = openDb(':memory:');
  db.migrate();
  t.after(() => db.close());
  const e = enforceWorld(t, db);
  const insBan = db.prepare(
    'INSERT INTO bans(player_id, steam_id, issued_by, issued_at, duration_sec, expires_at, reason, interval_raw, active, rcon_ok) VALUES(?,?,?,?,?,?,?,?,?,?)'
  );
  const connect = (i, steam) => e.log({ event: 'PLAYER_CONNECTED', time: Date.now(), eosId: E(i), steamId: steam, controller: `PC_${i}`, ip: '10.0.0.9' });
  const disconnect = (i) => e.log({ event: 'PLAYER_DISCONNECTED', time: Date.now(), eosId: E(i) });
  const idOf = (i) => db.prepare('SELECT id FROM players WHERE eos_id = ?').get(E(i)).id;

  // Known player, banned in the panel while offline (no SteamID on the ban).
  connect(4, S(4));
  disconnect(4);
  insBan.run(idOf(4), null, 1, Date.now(), 0, null, 'intentional teamkilling', '0', 1, 1);
  connect(4, S(4));
  let k = e.kicks();
  assert.strictEqual(k.length, 1);
  assert.strictEqual(k[0].command, `AdminKick ${S(4)} Banned: intentional teamkilling (until perm)`);
  assert.deepStrictEqual([k[0].meta.details.source, k[0].meta.details.matchedBy], ['local', 'player']);

  // Expired, and unbanned, bans never kick.
  connect(5, S(5));
  disconnect(5);
  insBan.run(idOf(5), S(5), 1, Date.now() - 2 * DAY, 3600, Date.now() - DAY, 'expired ban', '1h', 1, 1);
  connect(6, S(6));
  disconnect(6);
  insBan.run(idOf(6), S(6), 1, Date.now(), 0, null, 'lifted', '0', 0, 1);
  connect(5, S(5));
  connect(6, S(6));
  assert.strictEqual(e.kicks().length, 1);

  // A panel ban of a never-seen SteamID (stub row, no EOS id): the player's
  // real row is a different one, so it matches by SteamID.
  const stub = db.prepare('INSERT INTO players(steam_id, name, first_seen, last_seen) VALUES(?,?,?,?)')
    .run(S(7), '(manual ban)', 1, 1).lastInsertRowid;
  insBan.run(stub, S(7), 1, Date.now(), 86400, Date.now() + DAY, 'cheating', '1d', 1, 0);
  connect(7, S(7));
  k = e.kicks();
  assert.strictEqual(k.length, 2);
  assert.match(k[1].command, new RegExp(`^AdminKick ${S(7)} Banned: cheating \\(until \\d{4}-\\d{2}-\\d{2}\\)$`));
  assert.strictEqual(k[1].meta.details.matchedBy, 'steam');
  assert.strictEqual(k[1].meta.targetPlayerId, idOf(7));
});

test('poll sweep: players online when a ban is imported are kicked at the next poll', async (t) => {
  const w = await importWorld(t);
  const e = enforceWorld(t, w.db);
  const T = Date.now();
  e.poll(T, [e.row(1), e.row(2)]); // online at boot: a baseline, nobody joins
  assert.strictEqual(e.kicks().length, 0);
  w.bm.st.bans[LIST] = [bmBan(1, { steam: S(1), reason: 'Exploiting' })];
  await w.mod.importNow();
  e.poll(T + 15000, [e.row(1), e.row(2)]);
  const k = e.kicks();
  assert.strictEqual(k.length, 1);
  assert.strictEqual(k[0].command, 'AdminKickById 11 Banned: Exploiting (until perm)');
  assert.strictEqual(k[0].meta.details.via, 'poll');
});

test('end to end: MockSquad roster join of a BM-banned player -> real admin layer kicks by id, audited ban-enforce', async (t) => {
  const { MockSquad } = require('./mock-squad');
  const SquadRcon = require('../server/rcon');
  const parser = require('../server/parser');
  const { createAdmin } = require('../server/admin');

  const w = await importWorld(t);
  w.bm.st.bans[LIST] = [bmBan(1, { steam: S(42), reason: 'Wallhack', note: 'see clip' })];
  assert.strictEqual((await w.mod.importNow()).imported, 1);

  const mock = new MockSquad({ password: 'pw' });
  await mock.start();
  t.after(() => mock.stop());
  const rcon = new SquadRcon({ host: '127.0.0.1', port: mock.port, password: 'pw' });
  const up = new Promise((resolve) => rcon.once('connected', resolve));
  rcon.connect();
  await up;
  t.after(() => rcon.close());

  const audits = [];
  const auth = { audit(userId, action, meta) { audits.push(Object.assign({ userId, action }, meta)); return audits.length; } };
  const state = new LiveState();
  const bus = new EventEmitter();
  const admin = createAdmin({ db: w.db, rcon, state, auth, config: {} });
  const ingest = new Ingest({ db: w.db, state, bus, config: { flags: {}, retention: {} }, admin });
  t.after(() => ingest.stop());
  const poll = async () => state.applyListPlayers(parser.parseListPlayers(await rcon.exec('ListPlayers')));

  mock.addPlayer({ name: 'Innocent' });
  await poll(); // boot baseline
  const cheater = mock.addPlayer({ name: 'Cheater', steamId: S(42) });
  await poll(); // roster join -> enforcement
  await waitFor(() => !mock.players.has(cheater.eosId), 'the banned player kicked off the mock');
  await waitFor(() => audits.length === 1, 'the audit row');
  assert.strictEqual(audits[0].action, 'ban-enforce');
  assert.strictEqual(audits[0].userId, null);
  assert.strictEqual(audits[0].rconCommand, `AdminKickById ${cheater.playerId} Banned: Wallhack (until perm)`);
  assert.strictEqual(audits[0].rconOk, true);
  assert.strictEqual(audits[0].targetPlayerId, w.db.prepare('SELECT id FROM players WHERE eos_id = ?').get(cheater.eosId).id);
  assert.deepStrictEqual(mock.commands.filter((c) => /^AdminKick/.test(c)),
    [`AdminKickById ${cheater.playerId} Banned: Wallhack (until perm)`], 'one kick, nobody else');
  assert.strictEqual(mock.players.size, 1, 'the innocent player stays');
});
