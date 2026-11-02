'use strict';
// Squad remote ban list (docs/BATCH3-CONTRACTS.md §3), over the real API
// in-process (createApi with the module as an extension, a full validated
// config, settings.apply = config.js applySettingsPatch).
//
// - Switched off, a wrong key and a missing key answer 404 exactly like an
//   unknown route; the key is compared with crypto.timingSafeEqual.
// - The list: one `<SteamID64>:<expiry s | 0> //<reason>` line per active,
//   unexpired ban (the player's SteamID when the ban has none); reason only
//   (control characters stripped), never the note; ids that do not validate
//   never appear; EOS lines only when includeEos; text/plain, no-store.
// - Status: url from web.publicUrl (null without one or without a key), line
//   and skipped counts, last fetch time and address (right key only).
// - Rotate: a fresh key, the old URL dead at once, audited without the key.
// - Update: enabling with no key makes one; includeEos; type checks; audited
//   without the key; settings permission for every management route.
// - A failed config.json save: its text goes to the caller only, scrubbed;
//   audit rows record a fixed marker.
// - Rate limit: 30 fetches a minute per client address, wrong keys included.
// - With the real auth bus and webhook: rotate and update post nothing to
//   Discord.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const { createWebhook } = require('../server/webhook');
const { loadConfig, applySettingsPatch } = require('../server/config');
const { createRemoteBans } = require('../server/remotebans');
const LiveState = require('../server/state');

const S = (n) => `7656119800000${String(n).padStart(4, '0')}`;
const E = (n) => n.toString(16).padStart(32, '0');
const DAY = 86400000;
const DISCORD_URL = 'https://discord.example.test/api/webhooks/1/x';

function defaultConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-rbl-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, '{}');
    return loadConfig(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// `webhook`: auth emits on a bus wired to the real Discord webhook, whose
// posts are recorded in `posts` instead of sent.
async function harness(t, { trustProxy = false, persistError = null, webhook = false } = {}) {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = defaultConfig();
  cfg.web.trustProxy = trustProxy;
  cfg.web.publicUrl = 'https://panel.example.test/';
  const posts = [];
  let bus = null;
  if (webhook) {
    bus = new EventEmitter();
    cfg.discordWebhook = DISCORD_URL;
    Object.assign(cfg.webhookEvents, { bans: true, kicks: true, warns: true });
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url, init) => {
      if (!String(url).startsWith(DISCORD_URL)) return realFetch(url, init);
      posts.push(JSON.parse(init.body));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    createWebhook({ config: cfg, bus });
  }
  const auth = createAuth({ db, config: cfg, bus });
  const rcon = { status: { connected: true, authed: true }, async exec(cmd) { return `Executed: ${cmd}`; } };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const applied = [];
  const settings = {
    apply(patch) {
      applied.push(JSON.parse(JSON.stringify(patch)));
      const res = applySettingsPatch(cfg, patch);
      return persistError ? Object.assign(res, { persistError }) : res;
    },
  };
  const remote = createRemoteBans({ db, config: cfg, log: null, bus: null, state, admin, auth, webhook: null, dataDir: null, settings });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg, extensions: [remote] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    remote.stop();
    await new Promise((resolve) => server.close(resolve));
    auth.loginLimiter.stop();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  let n = 0;
  function as(role) {
    n++;
    let roleRef = role;
    if (role && typeof role === 'object') roleRef = auth.createRole(`custom-${n}`, role).id;
    const user = auth.createUser(`user${n}`, 'password-123', roleRef);
    const cookie = `sw_session=${auth.createSession(user.id, {}).token}`;
    const call = async (method, p, body) => {
      const headers = { origin: base, accept: 'application/json', cookie };
      const init = { method, headers };
      if (method !== 'GET') {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body == null ? {} : body);
      }
      const res = await fetch(base + p, init);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_e) { json = null; }
      return { status: res.status, json, text };
    };
    return { user, get: (p) => call('GET', p), post: (p, body) => call('POST', p, body) };
  }

  // What the game server does: a bare GET, no cookie.
  async function fetchList(key, headers = {}) {
    const q = key === undefined ? '' : `?key=${encodeURIComponent(key)}`;
    const res = await fetch(`${base}/api/remote/bans.cfg${q}`, { headers });
    return { status: res.status, text: await res.text(), headers: res.headers };
  }

  function enable(includeEos = false) {
    const key = crypto.randomBytes(24).toString('base64url');
    applySettingsPatch(cfg, { remoteBanList: { enabled: true, key, includeEos } });
    return key;
  }

  const audits = (action) => db.prepare('SELECT * FROM admin_actions WHERE action = ? ORDER BY id').all(action);
  return { db, cfg, auth, base, applied, as, fetchList, enable, audits, posts };
}

// Panel bans, an imported one, and every reason a ban must stay out.
function seedBans(db) {
  const now = Date.now();
  const player = db.prepare('INSERT INTO players(eos_id, steam_id, name, first_seen, last_seen) VALUES(?,?,?,?,?)');
  const p1 = player.run(E(1), S(1), 'One', now, now).lastInsertRowid;
  const p2 = player.run(E(2), null, 'EOS only', now, now).lastInsertRowid;
  const p3 = player.run(null, S(3), 'Steam via player', now, now).lastInsertRowid;
  const ban = db.prepare(
    `INSERT INTO bans(player_id, steam_id, eos_id, issued_at, expires_at, reason, note, active, source, external_id)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  );
  const timedUntil = now + 2 * DAY;
  ban.run(p1, S(1), E(1), now, null, 'Cheating\r\nsecond line\u0000', 'SECRET-NOTE-1', 1, null, null);
  ban.run(p3, null, null, now, timedUntil, 'Teamkilling', null, 1, null, null);
  ban.run(p2, null, null, now, null, 'Alt account', null, 1, null, null);
  ban.run(p1, S(1), null, now - 3 * DAY, now - 1000, 'Expired ban', null, 1, null, null);
  ban.run(p3, S(3), null, now, null, 'Lifted ban', null, 0, null, null);
  ban.run(null, S(6), null, now, null, 'Wallhack', 'SECRET-BM-NOTE', 1, 'battlemetrics', '66');
  ban.run(null, 'not-a-steam-id', 'zz-not-an-eos-id', now, null, 'Junk ids', null, 1, null, null);
  ban.run(null, null, E(0xabc).toUpperCase(), now, null, 'Upper EOS', null, 1, null, null);
  return { timed: Math.floor(timedUntil / 1000) };
}

test('off, a wrong key and a missing key answer exactly like an unknown route; keys compare in constant time', async (t) => {
  const h = await harness(t);
  const unknown = await fetch(`${h.base}/api/no-such-route`);
  const want = { status: unknown.status, text: await unknown.text(), type: unknown.headers.get('content-type') };
  assert.strictEqual(want.status, 404);
  const same = (r, label) => {
    assert.strictEqual(r.status, want.status, label);
    assert.strictEqual(r.text, want.text, label);
    assert.strictEqual(r.headers.get('content-type'), want.type, label);
  };

  same(await h.fetchList('anything'), 'never enabled, no key yet');
  same(await h.fetchList(''), 'empty key while no key exists');
  const key = h.enable();
  h.cfg.remoteBanList.enabled = false;
  same(await h.fetchList(key), 'switched off, right key');
  h.cfg.remoteBanList.enabled = true;
  const spy = t.mock.method(crypto, 'timingSafeEqual');
  for (const [k, label] of [
    [undefined, 'missing'], ['', 'empty'], [key.slice(0, -1), 'prefix'], [`${key}x`, 'longer'],
    [`${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`, 'last character'], [key.toUpperCase(), 'case'],
  ]) {
    same(await h.fetchList(k), label);
  }
  assert.strictEqual(spy.mock.callCount(), 6, 'every key check is a timingSafeEqual');
  assert.strictEqual((await h.fetchList(key)).status, 200);
  assert.strictEqual(spy.mock.callCount(), 7);
});

test('the list: active unexpired bans by SteamID, expiry or 0, reason only (never the note), EOS lines only when on', async (t) => {
  const h = await harness(t);
  const { timed } = seedBans(h.db);
  const key = h.enable(false);

  const r = await h.fetchList(key);
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  assert.strictEqual(r.text, [
    `${S(1)}:0 //Cheating second line`,
    `${S(3)}:${timed} //Teamkilling`,
    `${S(6)}:0 //Wallhack`,
    '',
  ].join('\n'));
  assert.ok(!/SECRET/.test(r.text), 'notes never leave the panel');
  assert.ok(!/Expired|Lifted|Junk/.test(r.text), 'expired, lifted and unidentifiable bans stay out');

  h.cfg.remoteBanList.includeEos = true; // read live
  const withEos = await h.fetchList(key);
  assert.strictEqual(withEos.text, [
    `${S(1)}:0 //Cheating second line`,
    `${E(1)}:0 //Cheating second line`,
    `${S(3)}:${timed} //Teamkilling`,
    `${E(2)}:0 //Alt account`,
    `${S(6)}:0 //Wallhack`,
    `${E(0xabc)}:0 //Upper EOS`,
    '',
  ].join('\n'), 'EOS ids from the ban or its player, lower-cased');

  for (const line of withEos.text.trim().split('\n')) {
    assert.match(line, /^(7656\d{13}|[0-9a-f]{32}):\d+ \/\/[^\r\n]*$/, line);
  }
  h.db.prepare('UPDATE bans SET active = 0').run();
  const none = await h.fetchList(key);
  assert.strictEqual(none.status, 200);
  assert.strictEqual(none.text, '', 'no bans: an empty file');
});

test('status: url from web.publicUrl, line and skipped counts, last fetch by the right key only', async (t) => {
  const h = await harness(t, { trustProxy: true });
  seedBans(h.db);
  const owner = h.as('owner');
  let st = await owner.get('/api/remote-bans');
  assert.strictEqual(st.status, 200, st.text);
  assert.deepStrictEqual(st.json, {
    enabled: false, includeEos: false, url: null, lines: 3, skippedNoSteam: 3, lastFetchAt: null, lastFetchFrom: null,
  }, 'no key yet: no url');

  const key = h.enable(false);
  st = await owner.get('/api/remote-bans');
  assert.strictEqual(st.json.url, `https://panel.example.test/api/remote/bans.cfg?key=${key}`);
  assert.strictEqual(st.json.enabled, true);

  await h.fetchList('wrong', { 'x-forwarded-for': '198.51.100.9' });
  assert.strictEqual((await owner.get('/api/remote-bans')).json.lastFetchAt, null, 'a wrong key is no fetch');
  const t0 = Date.now();
  await h.fetchList(key, { 'x-forwarded-for': '203.0.113.7' });
  st = await owner.get('/api/remote-bans');
  assert.ok(st.json.lastFetchAt >= t0);
  assert.strictEqual(st.json.lastFetchFrom, '203.0.113.7');

  h.cfg.remoteBanList.includeEos = true;
  st = await owner.get('/api/remote-bans');
  assert.deepStrictEqual([st.json.includeEos, st.json.lines, st.json.skippedNoSteam], [true, 6, 1]);

  h.cfg.web.publicUrl = 'https://panel.example.test/sub/path/';
  assert.strictEqual((await owner.get('/api/remote-bans')).json.url,
    `https://panel.example.test/sub/path/api/remote/bans.cfg?key=${key}`);
  for (const pub of ['', 'not a url', 'ftp://panel.example.test']) {
    h.cfg.web.publicUrl = pub;
    assert.strictEqual((await owner.get('/api/remote-bans')).json.url, null, JSON.stringify(pub));
  }
});

test('rotate: a fresh key and URL, the old one dead at once, audited without the key', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const old = h.enable();
  assert.strictEqual((await h.fetchList(old)).status, 200);

  const r = await owner.post('/api/remote-bans/rotate', {});
  assert.strictEqual(r.status, 200, r.text);
  const fresh = h.cfg.remoteBanList.key;
  assert.notStrictEqual(fresh, old);
  assert.match(fresh, /^[A-Za-z0-9_-]{32}$/, '24 random bytes, base64url');
  assert.deepStrictEqual(r.json, {
    ok: true, url: `https://panel.example.test/api/remote/bans.cfg?key=${fresh}`, persistError: null,
  });
  assert.deepStrictEqual(h.applied, [{ remoteBanList: { key: fresh } }], 'persisted through settings.apply');
  assert.strictEqual((await h.fetchList(old)).status, 404, 'the old URL stops working');
  assert.strictEqual((await h.fetchList(fresh)).status, 200);
  assert.strictEqual((await owner.get('/api/remote-bans')).json.lastFetchFrom, '127.0.0.1');

  await owner.post('/api/remote-bans/rotate', {});
  assert.strictEqual((await owner.get('/api/remote-bans')).json.lastFetchAt, null, 'fetches of an old key are no news');
  const audits = h.audits('remote-bans-rotate');
  assert.strictEqual(audits.length, 2);
  assert.strictEqual(audits[0].user_id, owner.user.id);
  for (const a of audits) {
    for (const k of [old, fresh, h.cfg.remoteBanList.key]) assert.ok(!String(a.details).includes(k), 'never the key');
  }
});

test('a key that applied but could not be saved: the caller gets the reason, scrubbed; the audit only a marker', async (t) => {
  const why = "EPERM: operation not permitted, rename 'C:\\panel\\config.json.tmp-1' -> 'C:\\panel\\config.json' Hunter2Secret";
  const h = await harness(t, { persistError: why });
  h.cfg.squad.rconPassword = 'Hunter2Secret';
  const owner = h.as('owner');
  const rot = await owner.post('/api/remote-bans/rotate', {});
  assert.strictEqual(rot.status, 200, rot.text);
  const scrubbed = why.replace('Hunter2Secret', '•••');
  assert.strictEqual(rot.json.persistError, scrubbed);
  const upd = await owner.post('/api/remote-bans', { includeEos: true });
  assert.strictEqual(upd.status, 200, upd.text);
  assert.strictEqual(upd.json.persistError, scrubbed);

  // Audit readers need not hold settings: no OS message, path or secret.
  const audits = [...h.audits('remote-bans-rotate'), ...h.audits('remote-bans-update')];
  assert.strictEqual(audits.length, 2);
  for (const a of audits) {
    assert.strictEqual(JSON.parse(a.details).persistError, 'config.json not written — see the panel log');
    assert.ok(!/EPERM|panel\\|Hunter2/.test(a.details), a.details);
  }
});

test('update: enabling makes a key when there is none; includeEos; type checks; audited without the key', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  seedBans(h.db);
  for (const body of [{}, { enabled: 'yes' }, { includeEos: 1 }, { enabled: true, includeEos: null }]) {
    const r = await owner.post('/api/remote-bans', body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body)} -> ${r.text}`);
  }
  assert.strictEqual(h.cfg.remoteBanList.key, '', 'nothing applied');

  const on = await owner.post('/api/remote-bans', { enabled: true });
  assert.strictEqual(on.status, 200, on.text);
  const key = h.cfg.remoteBanList.key;
  assert.match(key, /^[A-Za-z0-9_-]{32}$/);
  assert.deepStrictEqual(on.json, {
    ok: true, persistError: null, enabled: true, includeEos: false,
    url: `https://panel.example.test/api/remote/bans.cfg?key=${key}`,
    lines: 3, skippedNoSteam: 3, lastFetchAt: null, lastFetchFrom: null,
  });
  assert.strictEqual((await h.fetchList(key)).status, 200);

  const eos = await owner.post('/api/remote-bans', { includeEos: true });
  assert.strictEqual(eos.json.includeEos, true);
  assert.strictEqual(h.cfg.remoteBanList.key, key, 'an existing key is kept');
  const off = await owner.post('/api/remote-bans', { enabled: false });
  assert.strictEqual(off.json.enabled, false);
  assert.strictEqual((await h.fetchList(key)).status, 404);
  const onAgain = await owner.post('/api/remote-bans', { enabled: true });
  assert.strictEqual(h.cfg.remoteBanList.key, key, 're-enabling keeps the key');
  assert.strictEqual(onAgain.json.url.endsWith(key), true);
  const noop = await owner.post('/api/remote-bans', { enabled: true });
  assert.strictEqual(noop.status, 200);

  const audits = h.audits('remote-bans-update');
  assert.strictEqual(audits.length, 4, 'a change that changes nothing is not audited');
  assert.deepStrictEqual(JSON.parse(audits[0].details), {
    enabled: true, includeEos: false, keyGenerated: true,
    changed: ['remoteBanList.enabled', 'remoteBanList.key'], persistError: null,
  });
  assert.strictEqual(JSON.parse(audits[1].details).keyGenerated, false);
  for (const a of audits) assert.ok(!String(a.details).includes(key), 'never the key');
});

test('settings permission for status, rotate and update; the list itself needs no session', async (t) => {
  const h = await harness(t);
  const key = h.enable();
  for (const [who, label, want] of [
    [h.as('admin'), 'admin', 403],
    [h.as({ view: true, ban: true, raw: true }), 'ban+raw', 403],
    [h.as('viewer'), 'viewer', 403],
    [h.as({ view: true, settings: true }), 'settings', 200],
  ]) {
    assert.strictEqual((await who.get('/api/remote-bans')).status, want, `${label} status`);
    assert.strictEqual((await who.post('/api/remote-bans', { includeEos: false })).status, want, `${label} update`);
    assert.strictEqual((await who.post('/api/remote-bans/rotate', {})).status, want, `${label} rotate`);
  }
  const anon = await fetch(`${h.base}/api/remote-bans`);
  assert.strictEqual(anon.status, 401);
  assert.strictEqual((await h.fetchList(key)).status, 404, 'the settings holder rotated it');
  assert.strictEqual((await h.fetchList(h.cfg.remoteBanList.key)).status, 200, 'no cookie needed');
});

test('rate limit: 30 fetches a minute per client address, wrong keys included', async (t) => {
  const h = await harness(t, { trustProxy: true });
  const key = h.enable();
  const from = (ip) => ({ 'x-forwarded-for': ip });
  for (let i = 0; i < 30; i++) {
    const r = await h.fetchList(i % 3 === 0 ? key : `guess-${i}`, from('198.51.100.20'));
    assert.strictEqual(r.status, i % 3 === 0 ? 200 : 404, `request ${i + 1}`);
  }
  const limited = await h.fetchList(key, from('198.51.100.20'));
  assert.strictEqual(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.strictEqual((await h.fetchList(key, from('198.51.100.21'))).status, 200, 'another address has its own budget');
  assert.strictEqual((await h.fetchList(key, from('2001:db8:1:2::5'))).status, 200);
  for (let i = 0; i < 29; i++) await h.fetchList('x', from(`2001:db8:1:2::${(i + 6).toString(16)}`));
  assert.strictEqual((await h.fetchList(key, from('2001:db8:1:2:ffff::1'))).status, 429, 'IPv6 counts per /64');
});

test('rotating the key or switching the list posts nothing to Discord', async (t) => {
  const h = await harness(t, { webhook: true });
  const owner = h.as('owner');
  h.auth.audit(owner.user.id, 'ban', { details: { reason: 'probe' } });
  assert.strictEqual(h.posts.length, 1, 'the webhook is live');
  assert.strictEqual((await owner.post('/api/remote-bans', { enabled: true })).status, 200);
  assert.strictEqual((await owner.post('/api/remote-bans/rotate', {})).status, 200);
  assert.strictEqual((await owner.post('/api/remote-bans', { includeEos: true })).status, 200);
  assert.deepStrictEqual(h.posts.slice(1).map((p) => p.embeds[0].title), []);
});
