'use strict';
// A ban-evasion flag names the banned account its player shares an IP with —
// an alt-account link, which only the `ips` permission may see (the same rule
// as the profile's shared-IP accounts). Everyone else gets the flag with its
// reason and `redacted: true`, in every flag list and in the live `flag` and
// `alert` SSE events. Other flag types pass through untouched. The audit row
// of a join-alert kick carries the same link and is redacted the same way.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const LiveState = require('../server/state');

async function harness(t) {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = {};
  const auth = createAuth({ db, config: cfg });
  const rcon = { status: { connected: true, authed: true }, async exec(cmd) { return `Executed: ${cmd}`; } };
  const state = new LiveState();
  const bus = new EventEmitter();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg, bus });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  let n = 0;
  function as(role) {
    n++;
    let roleRef = role;
    if (role && typeof role === 'object') roleRef = auth.createRole(`custom-${n}`, role).id;
    const u = auth.createUser(`user${n}`, 'password-123', roleRef);
    const cookie = `sw_session=${auth.createSession(u.id, {}).token}`;
    const get = async (p) => {
      const res = await fetch(base + p, { headers: { origin: base, accept: 'application/json', cookie } });
      return { status: res.status, json: await res.json() };
    };
    // Opens /api/stream and collects parsed `event: name` frames.
    const stream = async () => {
      const ac = new AbortController();
      t.after(() => ac.abort());
      const res = await fetch(base + '/api/stream', { headers: { origin: base, cookie }, signal: ac.signal });
      assert.strictEqual(res.status, 200);
      const events = [];
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      (async () => {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buf += dec.decode(value, { stream: true });
            let i;
            while ((i = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const ev = /^event: (.*)$/m.exec(frame);
              const data = /^data: (.*)$/m.exec(frame);
              if (ev && data) events.push({ event: ev[1], data: JSON.parse(data[1]) });
            }
          }
        } catch (_e) { /* aborted */ }
      })();
      const waitFor = async (pred) => {
        for (let k = 0; k < 100; k++) {
          const hit = events.find(pred);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('event not received');
      };
      await waitFor((e) => e.event === 'hello');
      return { events, waitFor };
    };
    return { user: u, get, stream };
  }

  const T = Date.now();
  const joiner = db.prepare('INSERT INTO players(name, eos_id, first_seen, last_seen) VALUES(?,?,?,?)')
    .run('NewAccount', 'eos-new', T, T).lastInsertRowid;
  const banned = db.prepare('INSERT INTO players(name, eos_id, first_seen, last_seen) VALUES(?,?,?,?)')
    .run('BannedMain', 'eos-banned', T, T).lastInsertRowid;
  const evasionDetails = {
    reason: 'Shares an IP address with a banned player',
    banId: 7, bannedPlayerId: Number(banned), bannedPlayerName: 'BannedMain', sharedIps: 1,
  };
  const insFlag = db.prepare('INSERT INTO flags(player_id, time, type, severity, match_id, details) VALUES(?,?,?,?,?,?)');
  const evasionFlagId = Number(insFlag.run(joiner, T, 'ban-evasion', 3, null, JSON.stringify(evasionDetails)).lastInsertRowid);
  const tkFlagId = Number(insFlag.run(joiner, T - 1000, 'tk-spree', 2, null, JSON.stringify({ count: 3 })).lastInsertRowid);

  return { db, bus, auth, admin, as, joiner: Number(joiner), banned: Number(banned), evasionDetails, evasionFlagId, tkFlagId };
}

const REDACTED = { reason: 'Shares an IP address with a banned player', redacted: true };

test('flag lists: ban-evasion links reach `ips` holders only; other flags untouched', async (t) => {
  const h = await harness(t);
  const withIps = h.as({ view: true, flags: true, ips: true });
  const noIps = h.as({ view: true, flags: true });
  const viewer = h.as('viewer');

  for (const [who, sees] of [[withIps, true], [noIps, false], [viewer, false]]) {
    const lists = [
      ['flags', (await who.get('/api/flags')).json.rows],
      ['overview', (await who.get('/api/overview')).json.recent.flags],
      ['profile', (await who.get(`/api/players/${h.joiner}`)).json.flags],
      ['trolls', (await who.get('/api/trolls')).json.openFlags],
    ];
    for (const [where, rows] of lists) {
      assert.ok(Array.isArray(rows), `${where}: carries a flag list`);
      const ev = rows.find((f) => f.id === h.evasionFlagId);
      assert.ok(ev, `${where}: evasion flag listed`);
      if (sees) {
        assert.deepStrictEqual(ev.details, h.evasionDetails, `${where}: full details for ips`);
      } else {
        assert.deepStrictEqual(ev.details, REDACTED, `${where}: redacted without ips`);
        assert.ok(!JSON.stringify(ev).includes('BannedMain'), `${where}: banned account name never leaks`);
      }
      const tk = rows.find((f) => f.id === h.tkFlagId);
      assert.ok(tk, `${where}: tk flag listed`);
      assert.deepStrictEqual(tk.details, { count: 3 }, `${where}: other flag types untouched`);
    }
  }
});

test('live events: flag and alert frames are redacted per client', async (t) => {
  const h = await harness(t);
  const withIps = await h.as({ view: true, stream: true, flags: true, ips: true }).stream();
  const noIps = await h.as({ view: true, stream: true, flags: true }).stream();

  const flagEvent = {
    time: Date.now(), flagId: 99, type: 'ban-evasion', severity: 3,
    player: { dbId: h.joiner, name: 'NewAccount' }, matchId: null, details: h.evasionDetails,
  };
  const alertEvent = {
    type: 'ban-evasion', time: Date.now(), player: { dbId: h.joiner, name: 'NewAccount' },
    details: h.evasionDetails, flagId: 99, severity: 3,
  };
  h.bus.emit('flag', flagEvent);
  h.bus.emit('join-alert', alertEvent);
  h.bus.emit('flag', { ...flagEvent, flagId: 100, type: 'watchlist-join', severity: 1, details: { reason: 'Watchlisted player joined' } });

  const fullFlag = await withIps.waitFor((e) => e.event === 'flag' && e.data.flagId === 99);
  assert.deepStrictEqual(fullFlag.data.details, h.evasionDetails);
  const fullAlert = await withIps.waitFor((e) => e.event === 'alert');
  assert.deepStrictEqual(fullAlert.data.details, h.evasionDetails);

  const redFlag = await noIps.waitFor((e) => e.event === 'flag' && e.data.flagId === 99);
  assert.deepStrictEqual(redFlag.data.details, REDACTED);
  assert.strictEqual(redFlag.data.player.name, 'NewAccount', 'the joining player stays visible');
  const redAlert = await noIps.waitFor((e) => e.event === 'alert');
  assert.deepStrictEqual(redAlert.data.details, REDACTED);
  const watch = await noIps.waitFor((e) => e.event === 'flag' && e.data.flagId === 100);
  assert.deepStrictEqual(watch.data.details, { reason: 'Watchlisted player joined' });
  for (const e of noIps.events) assert.ok(!JSON.stringify(e.data).includes('BannedMain'), `no leak in ${e.event}`);
});

// Join alerts' auto-kick of an evader is audited with the same link.
test('audit log: a join-alert kick names the banned account to `ips` holders only', async (t) => {
  const h = await harness(t);
  const KICK = 'Ban evasion - this account is linked to a banned player';
  // what joinalerts.js kickEvader audits, stored before any viewer asks
  const kick = await h.admin.execRaw(null, `AdminKick 76561198000000042 ${KICK}`, {
    action: 'join-alert-kick',
    targetPlayerId: h.joiner,
    details: { flagId: h.evasionFlagId, banId: 7, bannedPlayerId: h.banned, reason: KICK },
  });
  assert.strictEqual(kick.ok, true);
  h.auth.audit(null, 'kick', { targetPlayerId: h.joiner, details: { reason: 'Teamkilling' } });
  h.auth.audit(null, 'unban', { targetPlayerId: h.banned, details: { banId: 7 } });

  const full = { flagId: h.evasionFlagId, banId: 7, bannedPlayerId: h.banned, reason: KICK };
  const withIps = h.as({ view: true, audit: true, ips: true });
  const builtinAdmin = h.as('admin');
  const noIps = h.as({ view: true, audit: true });
  for (const [who, sees] of [[withIps, true], [builtinAdmin, true], [noIps, false]]) {
    for (const q of ['', '?action=join-alert-kick']) {
      const res = await who.get(`/api/audit${q}`);
      assert.strictEqual(res.status, 200);
      const row = res.json.rows.find((r) => r.action === 'join-alert-kick');
      assert.ok(row, `listed (${q || 'all'})`);
      assert.strictEqual(row.targetPlayerId, h.joiner, 'the evader stays visible');
      assert.strictEqual(row.targetName, 'NewAccount');
      if (sees) {
        assert.deepStrictEqual(row.details, full, `full details for ips (${q || 'all'})`);
      } else {
        assert.deepStrictEqual(row.details, { flagId: h.evasionFlagId, reason: KICK, redacted: true }, `redacted (${q || 'all'})`);
      }
      if (!q) {
        assert.deepStrictEqual(res.json.rows.find((r) => r.action === 'kick').details, { reason: 'Teamkilling' }, 'other actions untouched');
        assert.deepStrictEqual(res.json.rows.find((r) => r.action === 'unban').details, { banId: 7 });
      }
    }
  }
});
