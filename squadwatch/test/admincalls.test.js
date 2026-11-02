'use strict';
// In-game admin calls (docs/BATCH3-CONTRACTS.md §5).
//
// UNIT — matchTrigger: case-insensitive prefix of the trimmed line that must
//   end a word ("!admins" is not "!admin" unless listed). webhook
//   postAdminCall: the role mention lives in `content` with allowed_mentions
//   naming only that role, player text stays escaped in the embed.
//
// ENGINE — a real db, a real bus, an admin recorder, a webhook recorder and a
//   fake clock: a trigger line becomes an open call (row, bus 'admin-call',
//   Discord with the role id, in-game reply by in-game id or the EOS
//   fallback, audited admin-call-reply); per-player cooldown; lines that are
//   not calls; config read live; real ingest chat packets feed it.
//
// IN-PROCESS HTTP — createApi with the module as an extension: list
//   (open/all, open count), handle (status, audit, bus update, idempotent),
//   the flags/warn/kick/ban permission set, and the SSE `admincall` relay
//   reaching admins but not viewers.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const { createWebhook } = require('../server/webhook');
const LiveState = require('../server/state');
const Ingest = require('../server/ingest');
const { createAdminCalls, matchTrigger } = require('../server/admincalls');

const T0 = Date.UTC(2026, 2, 1, 21, 0, 0);
const SEC = 1000;
const EOS_A = '0002aaaabbbbccccddddeeeeffff0001';
const EOS_B = '0002aaaabbbbccccddddeeeeffff0002';
const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';
const ROLE = '123456789012345678';
const REPLY = 'Admins have been notified - hang tight.';

function quietLog() {
  const lines = [];
  const push = (lvl) => (...a) => lines.push([lvl, ...a]);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// ------------------------------------------------------------------ unit

test('matchTrigger: case-insensitive, trimmed, and the trigger must end a word', () => {
  const t = ['!admin'];
  const yes = ['!admin', '!ADMIN', '  !Admin  ', '!admin please', '!admin!', '!admin, tk at main', '!admin\thelp', '!admin?'];
  for (const s of yes) assert.strictEqual(matchTrigger(s, t), '!admin', JSON.stringify(s));
  const no = ['!admins', '!administrator', '!admin_', '!admin2', '!adminé', 'hey !admin', 'admin', '', '!adm', '! admin'];
  for (const s of no) assert.strictEqual(matchTrigger(s, t), null, JSON.stringify(s));
  assert.strictEqual(matchTrigger('!admins come', ['!admin', '!admins']), '!admins', 'listed explicitly');
  assert.strictEqual(matchTrigger('@admin!!', ['@admin']), '@admin');
  // a trigger ending in punctuation needs no boundary after it
  assert.strictEqual(matchTrigger('!help?now', ['!help?']), '!help?');
  assert.strictEqual(matchTrigger('!admin', ['', '   ', null]), null, 'blank triggers never match');
  assert.strictEqual(matchTrigger('!admin', 'not a list'), null);
});

function withFetch(t) {
  const posted = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    posted.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 204 };
  };
  t.after(() => { globalThis.fetch = prev; });
  return posted;
}

test('webhook postAdminCall: only the configured role can ping; player text is escaped in the embed', async (t) => {
  const posted = withFetch(t);
  const config = { discordWebhook: 'https://discord.example/api/webhooks/1/x', webhookEvents: {} };
  const wh = createWebhook({ config });
  const call = {
    id: 9, time: T0, status: 'open', playerName: '[Admin](https://evil.example) @everyone', playerDbId: 3,
    eosId: EOS_A, steamId: STEAM_A, message: '!admin <@&999999999> **help** [here](https://evil.example)',
  };
  wh.postAdminCall(Object.assign({}, call, { roleId: ROLE }));
  wh.postAdminCall(Object.assign({}, call, { roleId: '' }));
  wh.postAdminCall(Object.assign({}, call, { roleId: 'not-a-role' }));
  await flush();
  assert.strictEqual(posted.length, 3);
  const [withRole, noRole, badRole] = posted.map((p) => p.body);
  assert.strictEqual(withRole.content, `<@&${ROLE}> admin call from in game`);
  assert.deepStrictEqual(withRole.allowed_mentions, { roles: [ROLE] });
  for (const b of [noRole, badRole]) {
    assert.strictEqual(b.content, undefined, 'no content without a valid role');
    assert.deepStrictEqual(b.allowed_mentions, { parse: [] });
  }
  const embed = withRole.embeds[0];
  assert.strictEqual(embed.title, 'In-game admin call');
  assert.ok(!embed.description.includes('[here](') && !embed.description.includes('<@&'), embed.description);
  assert.ok(embed.description.includes('\\*\\*help\\*\\*'));
  assert.ok(!embed.fields[0].value.includes('[Admin]('), 'names are escaped too');
  assert.deepStrictEqual(embed.fields.map((f) => f.name), ['Player', 'SteamID', 'Call']);
  assert.strictEqual(embed.fields[2].value, '#9');

  config.discordWebhook = '';
  wh.postAdminCall(Object.assign({}, call, { roleId: ROLE }));
  await flush();
  assert.strictEqual(posted.length, 3, 'no webhook URL: nothing is sent');
});

// ---------------------------------------------------------------- engine

function world(t, adminCalls) {
  const db = openDb(':memory:');
  db.migrate();
  const bus = new EventEmitter();
  const clock = { t: T0 };
  const sent = [];
  const admin = {
    async execRaw(user, command, meta) {
      sent.push({ user, command, meta });
      return { ok: true, rconOk: true, command, response: 'ok', auditId: sent.length };
    },
  };
  const posts = [];
  const webhook = { postAdminCall: (c) => posts.push(c) };
  const state = {
    players: new Map(),
    match: { id: 7 },
    byEos(e) { return this.players.get(e) || null; },
  };
  const config = {
    adminCalls: Object.assign({
      enabled: true, triggers: ['!admin'], discordRoleId: ROLE, reply: REPLY, cooldownSec: 60,
    }, adminCalls || {}),
  };
  const log = quietLog();
  const mod = createAdminCalls({ db, bus, state, admin, auth: null, webhook, config, log, now: () => clock.t });
  mod.start();
  t.after(() => { mod.stop(); db.close(); });
  const events = [];
  bus.on('admin-call', (c) => events.push(c));
  const addPlayer = (eos, steam, name) => db.prepare(
    'INSERT INTO players(eos_id, steam_id, name, first_seen, last_seen) VALUES(?,?,?,?,?)'
  ).run(eos, steam, name, T0, T0).lastInsertRowid;
  // ingest's 'chat' payload
  const chat = (dbId, eos, steam, name, message, extra) => bus.emit('chat', Object.assign({
    time: clock.t, matchId: 7, channel: 'all',
    player: { dbId, eosId: eos, steamId: steam, name, teamId: 1, squadId: null, sessKills: 0, sessDeaths: 0, sessTks: 0 },
    message,
  }, extra || {}));
  const rows = () => db.prepare('SELECT * FROM admin_calls ORDER BY id').all();
  return { db, bus, clock, sent, posts, state, config, log, events, addPlayer, chat, rows, mod };
}

test('engine: a trigger line becomes an open call — row, live event, Discord with the role, in-game reply', async (t) => {
  const w = world(t);
  const a = w.addPlayer(EOS_A, STEAM_A, 'Alice');
  w.state.players.set(EOS_A, { eosId: EOS_A, playerId: 12, dbId: a, name: 'Alice' });
  w.chat(a, EOS_A, STEAM_A, 'Alice', '  !admin someone is ramming at main  ');
  await flush();

  const rows = w.rows();
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(Object.assign({}, rows[0]), {
    id: rows[0].id, time: T0, match_id: 7, player_id: a, player_name: 'Alice', eos_id: EOS_A, steam_id: STEAM_A,
    message: '!admin someone is ramming at main', status: 'open', handled_by: null, handled_at: null,
  });
  const call = {
    id: rows[0].id, time: T0, status: 'open', playerName: 'Alice', playerDbId: a, eosId: EOS_A, steamId: STEAM_A,
    message: '!admin someone is ramming at main', handledBy: null, handledByName: null, handledAt: null, matchId: 7,
  };
  assert.deepStrictEqual(w.events, [call]);
  assert.deepStrictEqual(w.posts, [Object.assign({}, call, { roleId: ROLE })]);
  assert.deepStrictEqual(w.sent, [{
    user: null,
    command: `AdminWarnById 12 ${REPLY}`,
    meta: { action: 'admin-call-reply', targetPlayerId: a, details: { callId: call.id, reply: REPLY } },
  }]);
  assert.deepStrictEqual(w.log.lines.filter((l) => l[0] !== 'info'), []);
});

test('engine: the reply falls back to the EOS id without an in-game id; a blank reply sends nothing', async (t) => {
  const w = world(t);
  const a = w.addPlayer(EOS_A, STEAM_A, 'Alice');
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admin');
  await flush();
  assert.deepStrictEqual(w.sent.map((s) => s.command), [`AdminWarn "${EOS_A}" ${REPLY}`]);

  w.config.adminCalls.reply = '   ';
  const b = w.addPlayer(EOS_B, STEAM_B, 'Bob');
  w.chat(b, EOS_B, STEAM_B, 'Bob', '!admin');
  await flush();
  assert.strictEqual(w.rows().length, 2, 'the call itself still happens');
  assert.strictEqual(w.sent.length, 1, 'no reply to send');
});

test('engine: one call per player per cooldown; other players are not held back', async (t) => {
  const w = world(t, { cooldownSec: 60 });
  const a = w.addPlayer(EOS_A, STEAM_A, 'Alice');
  const b = w.addPlayer(EOS_B, STEAM_B, 'Bob');
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admin');
  w.clock.t = T0 + 30 * SEC;
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admin hello??');
  w.chat(b, EOS_B, STEAM_B, 'Bob', '!admin');
  w.clock.t = T0 + 59 * SEC;
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admin');
  w.clock.t = T0 + 60 * SEC;
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admin still waiting');
  await flush();
  assert.deepStrictEqual(w.rows().map((r) => [r.player_name, r.time]), [
    ['Alice', T0], ['Bob', T0 + 30 * SEC], ['Alice', T0 + 60 * SEC],
  ]);
  assert.strictEqual(w.events.length, 3);

  // a player known only by EOS id is held back the same way
  w.config.adminCalls.cooldownSec = 0;
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admin');
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admin');
  assert.strictEqual(w.rows().length, 5, 'cooldownSec 0: no cooldown');
  w.config.adminCalls.cooldownSec = 60;
  w.clock.t = T0 + 10 * 60 * SEC;
  w.chat(null, '0002aaaabbbbccccddddeeeeffff0003', null, 'Ghost', '!admin');
  w.clock.t += 10 * SEC;
  w.chat(null, '0002aaaabbbbccccddddeeeeffff0003', null, 'Ghost', '!admin');
  assert.strictEqual(w.rows().length, 6);
});

test('engine: lines that are not calls change nothing; config is read live', async (t) => {
  const w = world(t);
  const a = w.addPlayer(EOS_A, STEAM_A, 'Alice');
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admins where are you');
  w.chat(a, EOS_A, STEAM_A, 'Alice', 'can an admin come? !admin');
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admin', { channel: 'admin' });
  w.chat(null, null, null, null, '!admin');
  w.bus.emit('chat', null);
  w.bus.emit('chat', { time: T0, channel: 'all', player: null, message: '!admin' });
  w.bus.emit('chat', { time: T0, channel: 'all', player: { dbId: a }, message: 42 });
  w.config.adminCalls.enabled = false;
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admin');
  await flush();
  assert.deepStrictEqual(w.rows(), []);
  assert.deepStrictEqual(w.events, []);
  assert.deepStrictEqual(w.sent, []);
  assert.deepStrictEqual(w.posts, []);

  w.config.adminCalls.enabled = true;
  w.config.adminCalls.triggers = ['!admin', '!admins', '!help'];
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admins where are you');
  w.clock.t += 120 * SEC;
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!HELP me');
  assert.deepStrictEqual(w.rows().map((r) => r.message), ['!admins where are you', '!HELP me']);
  w.mod.stop();
  w.clock.t += 120 * SEC;
  w.chat(a, EOS_A, STEAM_A, 'Alice', '!admin');
  assert.strictEqual(w.rows().length, 2, 'stop() detaches from the bus');
});

test('engine: real ingest chat packets feed it, and the caller is resolved from the db', async (t) => {
  const w = world(t);
  const ingest = new Ingest({ db: w.db, state: null, bus: w.bus, config: { flags: {} }, admin: null });
  t.after(() => ingest.stop());
  w.bus.emit('chat-packet-parsed', { kind: 'CHAT', channel: 'team', eosId: EOS_A, steamId: STEAM_A, name: 'Alice', message: '!admin heli stolen' });
  await flush();
  const [row] = w.rows();
  assert.ok(row, 'a call was recorded');
  const pid = w.db.prepare('SELECT id FROM players WHERE eos_id = ?').get(EOS_A).id;
  assert.strictEqual(row.player_id, pid);
  assert.strictEqual(row.player_name, 'Alice');
  assert.strictEqual(row.steam_id, STEAM_A);
  assert.strictEqual(row.message, '!admin heli stolen');
  assert.strictEqual(w.sent[0].command, `AdminWarn "${EOS_A}" ${REPLY}`);
});

// --------------------------------------------------------- in-process HTTP

async function harness(t) {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = {
    adminCalls: { enabled: true, triggers: ['!admin'], discordRoleId: '', reply: REPLY, cooldownSec: 60 },
  };
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const auth = createAuth({ db, config: cfg, bus });
  const sentCmds = [];
  const rcon = {
    status: { connected: true, authed: true },
    async exec(cmd) { sentCmds.push(cmd); return `Executed: ${cmd}`; },
  };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const mod = createAdminCalls({ db, bus, state, admin, auth, webhook: null, config: cfg, log: quietLog() });
  const server = createApi({ db, state, rcon, bus, auth, admin, config: cfg, extensions: [mod] });
  mod.start();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => mod.stop());
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  function as(role) {
    n++;
    const roleRef = role && typeof role === 'object' ? auth.createRole(`custom-${n}`, role).id : role;
    const u = auth.createUser(`user${n}`, 'password-123', roleRef);
    const cookie = `sw_session=${auth.createSession(u.id, {}).token}`;
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
    return { user: u, cookie, get: (p) => call('GET', p), post: (p, body) => call('POST', p, body) };
  }
  // A live SSE stream: events in arrival order; until(pred) waits for one.
  async function stream(who) {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { headers: { cookie: who.cookie }, signal: ctrl.signal });
    assert.strictEqual(res.status, 200);
    const events = [];
    let wake = () => {};
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block);
            const data = /^data: (.*)$/m.exec(block);
            if (ev) events.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null });
          }
          wake();
        }
      } catch (_e) { /* aborted at teardown */ }
    })();
    t.after(() => ctrl.abort());
    async function until(pred, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`no matching SSE event; got ${events.map((e) => e.event).join(',')}`);
        await new Promise((resolve) => { wake = resolve; setTimeout(resolve, 50); });
      }
    }
    await until((e) => e.event === 'hello');
    return { events, until };
  }
  const audits = (action) => db.prepare('SELECT * FROM admin_actions WHERE action = ? ORDER BY id').all(action);
  const addPlayer = (eos, steam, name) => db.prepare(
    'INSERT INTO players(eos_id, steam_id, name, first_seen, last_seen) VALUES(?,?,?,?,?)'
  ).run(eos, steam, name, T0, T0).lastInsertRowid;
  const chat = (dbId, eos, steam, name, message, time) => bus.emit('chat', {
    time: time || Date.now(), matchId: null, channel: 'all',
    player: { dbId, eosId: eos, steamId: steam, name, teamId: 1, squadId: null, sessKills: 0, sessDeaths: 0, sessTks: 0 },
    message,
  });
  return { db, bus, auth, sentCmds, as, stream, audits, addPlayer, chat };
}

test('HTTP: list open/all with the open count; handle once, audited and announced; who may', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const viewer = h.as('viewer');
  const flagsOnly = h.as({ view: true, flags: true });
  const kickOnly = h.as({ view: true, kick: true });
  const a = h.addPlayer(EOS_A, STEAM_A, 'Alice');
  const b = h.addPlayer(EOS_B, STEAM_B, 'Bob');
  h.chat(a, EOS_A, STEAM_A, 'Alice', '!admin one', T0);
  h.chat(b, EOS_B, STEAM_B, 'Bob', '!admin two', T0 + SEC);

  for (const who of [owner, flagsOnly, kickOnly]) {
    const r = await who.get('/api/admin-calls');
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(r.json.open, 2);
    assert.deepStrictEqual(r.json.rows.map((c) => c.message), ['!admin two', '!admin one'], 'newest first');
  }
  assert.strictEqual((await viewer.get('/api/admin-calls')).status, 403);
  assert.strictEqual((await viewer.post('/api/admin-calls/1/handle', {})).status, 403);
  assert.strictEqual((await owner.get('/api/admin-calls?status=closed')).status, 400);

  const updates = [];
  h.bus.on('admin-call', (c) => updates.push(c));
  const first = (await owner.get('/api/admin-calls')).json.rows[1];
  const handled = await flagsOnly.post(`/api/admin-calls/${first.id}/handle`, {});
  assert.strictEqual(handled.status, 200, handled.text);
  assert.strictEqual(handled.json.call.status, 'handled');
  assert.strictEqual(handled.json.call.handledBy, flagsOnly.user.id);
  assert.strictEqual(handled.json.call.handledByName, flagsOnly.user.username);
  assert.ok(handled.json.call.handledAt >= T0);
  assert.deepStrictEqual(updates, [handled.json.call], 'the update goes out on the bus as is');
  const audit = h.audits('admin-call-handled');
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].user_id, flagsOnly.user.id);
  assert.strictEqual(audit[0].target_player_id, a);
  assert.deepStrictEqual(JSON.parse(audit[0].details), { callId: first.id });

  const again = await kickOnly.post(`/api/admin-calls/${first.id}/handle`, {});
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.alreadyHandled, true);
  assert.strictEqual(again.json.call.handledBy, flagsOnly.user.id, 'stays with whoever handled it');
  assert.strictEqual(h.audits('admin-call-handled').length, 1);
  assert.strictEqual(updates.length, 1);

  const open = await owner.get('/api/admin-calls?status=open');
  assert.strictEqual(open.json.open, 1);
  assert.deepStrictEqual(open.json.rows.map((c) => c.message), ['!admin two']);
  const all = await owner.get('/api/admin-calls?status=all&limit=1');
  assert.deepStrictEqual(all.json.rows.map((c) => c.message), ['!admin two'], 'limit applies');
  assert.strictEqual(all.json.open, 1);
  assert.strictEqual((await owner.post('/api/admin-calls/999/handle', {})).status, 404);

  // the in-game replies went through the real admin layer, audited
  assert.deepStrictEqual(h.sentCmds, [`AdminWarn "${EOS_A}" ${REPLY}`, `AdminWarn "${EOS_B}" ${REPLY}`]);
  assert.deepStrictEqual(h.audits('admin-call-reply').map((r) => r.target_player_id), [a, b]);
});

test('HTTP: SSE admincall reaches the people who can act on it, not viewers', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const viewer = h.as('viewer');
  const ownerStream = await h.stream(owner);
  const viewerStream = await h.stream(viewer);
  const a = h.addPlayer(EOS_A, STEAM_A, 'Alice');
  h.chat(a, EOS_A, STEAM_A, 'Alice', '!admin help');
  const got = await ownerStream.until((e) => e.event === 'admincall');
  assert.strictEqual(got.data.message, '!admin help');
  assert.strictEqual(got.data.status, 'open');

  const handled = await owner.post(`/api/admin-calls/${got.data.id}/handle`, {});
  assert.strictEqual(handled.status, 200);
  const upd = await ownerStream.until((e) => e.event === 'admincall' && e.data.status === 'handled');
  assert.strictEqual(upd.data.id, got.data.id);

  h.bus.emit('broadcast', { time: Date.now(), message: 'sentinel', from: 'test' });
  await viewerStream.until((e) => e.event === 'broadcast');
  assert.deepStrictEqual(viewerStream.events.filter((e) => e.event === 'admincall'), [], 'viewers never see admin calls');
});
