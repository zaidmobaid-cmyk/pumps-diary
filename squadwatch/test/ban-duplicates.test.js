'use strict';
// POST /api/bans refuses a ban that adds nothing: the player (matched by
// player id, SteamID or EOS id) already has an active ban lasting at least
// as long, give or take 10% of the new duration (at most an hour), so a retry
// after "player not found" never stacks duplicates. Nothing reaches RCON for
// a refused ban. A longer ban goes through. A ban sent while another ban of
// the same player still awaits RCON is refused as well.
const test = require('node:test');
const assert = require('node:assert');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const LiveState = require('../server/state');

test('duplicate bans are refused before RCON; longer ones go through', async (t) => {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = {};
  const auth = createAuth({ db, config: cfg });
  const sent = [];
  const rcon = {
    status: { connected: true, authed: true },
    async exec(cmd) { sent.push(cmd); return 'ERROR: Unable to find player with name or id (x)'; },
  };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const u = auth.createUser('nailed', 'password-123', 'owner');
  const cookie = `sw_session=${auth.createSession(u.id, {}).token}`;
  const ban = async (body) => {
    const res = await fetch(base + '/api/bans', {
      method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const T = Date.now();
  const mk = (name, steam, eos) => Number(db.prepare('INSERT INTO players(name, steam_id, eos_id, first_seen, last_seen) VALUES(?,?,?,?,?)')
    .run(name, steam, eos, T, T).lastInsertRowid);
  const twist = mk('  TW!ST', '76561199731425684', '00028fd457e9462496a0edff6f8c5a5a');
  const other = mk('Other', '76561199000000002', '0002bbbb');

  let r = await ban({ playerId: twist, interval: '0', reason: 'Toxic behaviour' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.rconOk, false, 'offline: the game server missed it, the ban still stands');
  const rconAfterFirst = sent.length;

  r = await ban({ playerId: twist, interval: '0', reason: 'Toxic behaviour' });
  assert.strictEqual(r.status, 409, 'the same permanent ban again');
  assert.match(r.json.error, /^TW!ST is already banned permanently by nailed\./);
  r = await ban({ playerId: twist, interval: '1d', reason: 'x' });
  assert.strictEqual(r.status, 409, 'a shorter ban under a permanent one');
  r = await ban({ steamId: '76561199731425684', interval: '0', reason: 'x' });
  assert.strictEqual(r.status, 409, 'matched by SteamID too');
  assert.strictEqual(sent.length, rconAfterFirst, 'refused bans never reach RCON');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS c FROM bans WHERE player_id = ?').get(twist).c, 1);

  r = await ban({ playerId: other, interval: '1d', reason: 'tk' });
  assert.strictEqual(r.status, 200);
  r = await ban({ playerId: other, interval: '1d', reason: 'tk' });
  assert.strictEqual(r.status, 409, 'an immediate retry of the same duration');
  assert.match(r.json.error, /already banned until \d{4}-\d\d-\d\d \d\d:\d\d UTC by nailed/);
  r = await ban({ playerId: other, interval: '1w', reason: 'tk again' });
  assert.strictEqual(r.status, 200, 'a longer ban goes through');
  r = await ban({ playerId: other, interval: '0', reason: 'cheating' });
  assert.strictEqual(r.status, 200, 'and a permanent one over a timed one');

  db.prepare("UPDATE bans SET active = 0 WHERE player_id = ?").run(twist);
  r = await ban({ playerId: twist, interval: '0', reason: 'back again' });
  assert.strictEqual(r.status, 200, 'after an unban, banning works again');

  // A zero count would parse as permanent: only "0" itself means that.
  for (const interval of ['0d', '0m', '00d', '05d']) {
    const sentBefore = sent.length;
    r = await ban({ playerId: mk(`Z ${interval}`, null, null), interval, reason: 'x' });
    assert.strictEqual(r.status, 400, `"${interval}" is refused`);
    assert.strictEqual(sent.length, sentBefore, `"${interval}" never reaches RCON`);
  }
});

// The duplicate check and the INSERT sit on either side of the RCON await:
// a ban in flight claims its player (by player id, SteamID and EOS id) until
// it is stored, so a second ban sent meanwhile is refused instead of stacking.
test('two bans of one player at once: the second is refused while the first awaits RCON', async (t) => {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = {};
  const auth = createAuth({ db, config: cfg });
  const sent = [];
  const pending = [];
  // The game server answers when told to — or after 2 s, so a ban that
  // should have been refused fails the test instead of hanging it.
  const rcon = {
    status: { connected: true, authed: true },
    exec(cmd) {
      sent.push(cmd);
      return new Promise((resolve) => {
        const answer = () => { clearTimeout(timer); resolve(`Banned: ${cmd}`); };
        const timer = setTimeout(answer, 2000);
        pending.push(answer);
      });
    },
  };
  const answerRcon = () => { for (const f of pending.splice(0)) f(); };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ban = async (who, body) => {
    const res = await fetch(base + '/api/bans', {
      method: 'POST', headers: { origin: base, cookie: who, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const login = (name) => `sw_session=${auth.createSession(auth.createUser(name, 'password-123', 'owner').id, {}).token}`;
  const alice = login('alice');
  const bob = login('bob');
  const until = async (fn, label) => {
    for (let i = 0; i < 400 && !fn(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(fn(), label);
  };
  const T = Date.now();
  const mk = (name, steam, eos) => Number(db.prepare('INSERT INTO players(name, steam_id, eos_id, first_seen, last_seen) VALUES(?,?,?,?,?)')
    .run(name, steam, eos, T, T).lastInsertRowid);
  const TWIST_STEAM = '76561199731425684';
  const twist = mk('TW!ST', TWIST_STEAM, '00028fd457e9462496a0edff6f8c5a5a');
  const twistOldRow = mk('TW!ST (old name)', TWIST_STEAM, '0002cccc');
  const other = mk('Other', '76561199000000002', '0002bbbb');
  const activeBans = (pid) => db.prepare('SELECT COUNT(*) AS c FROM bans WHERE player_id = ? AND active = 1').get(pid).c;

  const first = ban(alice, { playerId: twist, interval: '1d', reason: 'TK spree' });
  await until(() => sent.length === 1, 'the first ban is waiting on the game server');
  let r = await ban(bob, { playerId: twist, interval: '1d', reason: 'TK spree' });
  assert.strictEqual(r.status, 409, 'the same ban from another admin');
  assert.match(r.json.error, /^A ban for TW!ST is being sent right now/);
  r = await ban(alice, { playerId: twist, interval: '0', reason: 'TK spree' });
  assert.strictEqual(r.status, 409, 'a longer one waits for it too');
  r = await ban(bob, { steamId: TWIST_STEAM, interval: '1d', reason: 'x' });
  assert.strictEqual(r.status, 409, 'matched by SteamID');
  r = await ban(bob, { playerId: twistOldRow, interval: '1d', reason: 'x' });
  assert.strictEqual(r.status, 409, 'another row with the same SteamID');
  const otherBan = ban(bob, { playerId: other, interval: '1d', reason: 'tk' });
  await until(() => sent.length === 2, 'another player is not held up');
  answerRcon();
  assert.strictEqual((await first).status, 200);
  assert.strictEqual((await otherBan).status, 200);
  assert.strictEqual(sent.filter((c) => c.includes(TWIST_STEAM)).length, 1, 'one AdminBan for TW!ST');
  assert.strictEqual(activeBans(twist) + activeBans(twistOldRow), 1, 'one ban row');

  // Stored, the claim is gone: the ban itself now answers a retry, and a
  // longer ban goes through.
  r = await ban(bob, { playerId: twist, interval: '1d', reason: 'TK spree' });
  assert.strictEqual(r.status, 409);
  assert.match(r.json.error, /^TW!ST is already banned until .* by alice\./);
  const longer = ban(bob, { playerId: twist, interval: '0', reason: 'Back again' });
  await until(() => sent.length === 3, 'the longer ban reaches RCON');
  answerRcon();
  assert.strictEqual((await longer).status, 200);

  // A ban that fails half-way releases its claim as well.
  const third = mk('Third', '76561199000000003', '0002dddd');
  const realExec = admin.execAdmin;
  admin.execAdmin = async () => { throw new Error('socket closed mid-command'); };
  r = await ban(alice, { playerId: third, interval: '1d', reason: 'x' });
  assert.strictEqual(r.status, 500);
  admin.execAdmin = realExec;
  const retry = ban(alice, { playerId: third, interval: '1d', reason: 'x' });
  await until(() => sent.length === 4, 'the retry reaches RCON');
  answerRcon();
  assert.strictEqual((await retry).status, 200);
});
