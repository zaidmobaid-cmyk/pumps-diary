'use strict';
// Roster-diff joins/leaves (state roster-* events -> ingest sessions +
// 'player-connected'/'player-disconnected'): the live feed's only join/leave
// source while RCON is linked but no game log is. Baselines, the two-poll
// leave debounce, mass-vanish holds, map travel, restart resume, and dedupe
// with a lagging log path in both orders — through a real in-memory db,
// LiveState and Ingest.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const LiveState = require('../server/state');
const { openDb } = require('../server/db');
const Ingest = require('../server/ingest');

const SEC = 1000;
const MIN = 60 * SEC;
const POLL = 15 * SEC; // index.js ListPlayers cadence

// Player i: fixed ids and a parsed ListPlayers row (§6.4 shape).
const eosOf = (i) => `${'0'.repeat(30)}${(0xa0 + i).toString(16)}`;
const steamOf = (i) => `765611980000000${10 + i}`;
function row(i) {
  return {
    playerId: 100 + i, eosId: eosOf(i), steamId: steamOf(i), name: `Player${i}`,
    teamId: (i % 2) + 1, squadId: null, isLeader: false, role: 'USA_Rifleman_01',
  };
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_x, k) => a + k);

// The live-feed backfill's session queries, verbatim from api.js hLiveFeed.
const FEED_CONNECTS = `SELECT s.connect_at, s.player_id, p.name AS name FROM sessions s
         LEFT JOIN players p ON p.id = s.player_id ORDER BY s.id DESC LIMIT ?`;
const FEED_DISCONNECTS = `SELECT s.disconnect_at, s.player_id, p.name AS name FROM sessions s
         LEFT JOIN players p ON p.id = s.player_id
        WHERE s.disconnect_at IS NOT NULL ORDER BY s.disconnect_at DESC LIMIT ?`;

// Real LiveState + Ingest on an in-memory db (or a given one: a "restart").
// t0 is whole-second wall time: map-change grace is armed off the real clock.
function makeWorld(t, db) {
  if (!db) {
    db = openDb(':memory:');
    t.after(() => db.close());
    db.migrate();
  }
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const state = new LiveState();
  const ingest = new Ingest({ db, state, bus, config: { flags: {}, retention: {} }, admin: null });
  t.after(() => ingest.stop());
  const events = { connect: [], disconnect: [], roster: [] };
  bus.on('player-connected', (p) => events.connect.push(p));
  bus.on('player-disconnected', (p) => events.disconnect.push(p));
  for (const name of ['roster-joined', 'roster-left', 'roster-baseline']) {
    state.on(name, (p) => events.roster.push(Object.assign({ event: name }, p)));
  }
  const dbId = (i) => {
    const r = db.prepare('SELECT id FROM players WHERE eos_id=?').get(eosOf(i));
    return r ? Number(r.id) : null;
  };
  const sessions = (i) => db.prepare('SELECT connect_at, disconnect_at FROM sessions WHERE player_id=? ORDER BY id')
    .all(dbId(i)).map((s) => [s.connect_at, s.disconnect_at]);
  return {
    db, bus, state, ingest, events, dbId, sessions,
    t0: Math.floor(Date.now() / 1000) * 1000,
    // One ListPlayers poll at `time` listing players `idx`.
    poll: (time, idx) => state.applyListPlayers({ online: idx.map(row), disconnected: [] }, time),
    log: (ev) => bus.emit('log-event', Object.assign({ raw: '' }, ev)),
    playSeconds: (i) => Number(db.prepare('SELECT play_seconds FROM players WHERE id=?').get(dbId(i)).play_seconds),
    // What play_seconds must equal: each closed session credited once.
    credited: (i) => sessions(i).reduce((n, [c, d]) => n + (d == null ? 0 : (d - c) / SEC), 0),
    openCount: () => Number(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE disconnect_at IS NULL').get().n),
    rosterOf: (name) => events.roster.filter((e) => e.event === name),
  };
}

// ------------------------------------------------------------ baselines

test('first roster after boot is a baseline: nobody already online joined', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, [0, 1, 2]);
  assert.deepStrictEqual(w.events.roster.map((e) => e.event), ['roster-baseline']);
  const base = w.events.roster[0];
  assert.strictEqual(base.reason, 'boot');
  assert.strictEqual(base.time, w.t0);
  assert.deepStrictEqual(base.players.map((p) => p.eosId), [eosOf(0), eosOf(1), eosOf(2)]);
  assert.strictEqual(w.events.connect.length, 0, 'no player-connected for the baseline');
  assert.strictEqual(w.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'no session invented');

  w.poll(w.t0 + POLL, [0, 1, 2]);
  assert.strictEqual(w.events.roster.length, 1, 'an unchanged roster emits nothing');
  assert.strictEqual(w.events.connect.length, 0);
});

test('a garbled empty first roster is no baseline while ShowServerInfo counts players', (t) => {
  const w = makeWorld(t);
  w.state.applyServerInfo({ mapName: 'Narva_AAS_v2', playerCount: 3 });
  w.poll(w.t0, []); // e.g. a reply mixed up with the boot-time ListLayers
  assert.strictEqual(w.events.roster.length, 0, 'no baseline taken from it');
  w.poll(w.t0 + POLL, [0, 1, 2]);
  assert.deepStrictEqual(w.events.roster.map((e) => e.event), ['roster-baseline']);
  assert.strictEqual(w.events.connect.length, 0, 'everyone already online: no join storm');

  // A genuinely empty server at boot is a baseline like any other.
  const e = makeWorld(t);
  e.state.applyServerInfo({ mapName: 'Narva_AAS_v2', playerCount: 0 });
  e.poll(e.t0, []);
  e.poll(e.t0 + POLL, [0]);
  assert.strictEqual(e.events.connect.length, 1, 'the first joiner after an empty boot is announced');
});

test('a new name in the next poll joins once, opens a session, log-path payload shape', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, [0]);
  w.poll(w.t0 + POLL, [0, 1]);
  w.poll(w.t0 + 2 * POLL, [0, 1]);

  assert.deepStrictEqual(w.rosterOf('roster-joined').map(({ event, ...p }) => p), [{
    time: w.t0 + POLL, eosId: eosOf(1), steamId: steamOf(1), name: 'Player1', teamId: 2, playerId: 101,
  }]);
  assert.strictEqual(w.events.connect.length, 1, 'announced exactly once');
  assert.deepStrictEqual(w.events.connect[0], {
    time: w.t0 + POLL,
    player: {
      dbId: w.dbId(1), eosId: eosOf(1), steamId: steamOf(1), name: 'Player1', teamId: 2, squadId: null,
      sessKills: 0, sessDeaths: 0, sessTks: 0,
    },
  });
  assert.deepStrictEqual(w.sessions(1), [[w.t0 + POLL, null]], 'one open session from the poll time');
  const p = w.db.prepare('SELECT * FROM players WHERE eos_id=?').get(eosOf(1));
  assert.strictEqual(p.name, 'Player1');
  assert.strictEqual(p.steam_id, steamOf(1));
  assert.strictEqual(w.state.byEos(eosOf(1)).dbId, Number(p.id), 'live record backfilled with dbId');

  // Same keys as the log path's PLAYER_CONNECTED announcement (api.js/SSE/frontend unchanged).
  w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 40 * SEC, controller: 'BP_PlayerController_C_9', ip: '10.0.0.9', eosId: eosOf(9), steamId: steamOf(9) });
  assert.strictEqual(w.events.connect.length, 2);
  assert.deepStrictEqual(Object.keys(w.events.connect[0].player).sort(), Object.keys(w.events.connect[1].player).sort());
});

// ---------------------------------------------------------------- leaves

test('a leave needs two consecutive missed polls and is credited like the log path', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, []);
  for (let k = 1; k <= 8; k++) w.poll(w.t0 + k * POLL, [0]); // joined at +15s, last seen +120s

  w.poll(w.t0 + 9 * POLL, []); // first miss
  assert.strictEqual(w.rosterOf('roster-left').length, 0);
  assert.strictEqual(w.events.disconnect.length, 0, 'one missed poll is not a leave');
  assert.deepStrictEqual(w.sessions(0), [[w.t0 + POLL, null]]);

  w.poll(w.t0 + 10 * POLL, []); // second miss: confirmed
  assert.deepStrictEqual(w.rosterOf('roster-left').map(({ event, ...p }) => p), [{
    time: w.t0 + 9 * POLL, eosId: eosOf(0), steamId: steamOf(0), name: 'Player0', teamId: 1, playerId: 100,
    lastSeenAt: w.t0 + 8 * POLL, missedAt: w.t0 + 9 * POLL,
  }]);
  assert.deepStrictEqual(w.events.disconnect, [{
    time: w.t0 + 9 * POLL, // stamped at the poll that first missed them
    player: {
      dbId: w.dbId(0), eosId: eosOf(0), steamId: steamOf(0), name: 'Player0', teamId: 1, squadId: null,
      sessKills: null, sessDeaths: null, sessTks: null,
    },
  }]);
  assert.deepStrictEqual(w.sessions(0), [[w.t0 + POLL, w.t0 + 9 * POLL]]);
  assert.strictEqual(w.playSeconds(0), 120);

  w.poll(w.t0 + 11 * POLL, []);
  assert.strictEqual(w.events.disconnect.length, 1, 'gone stays gone: no repeat');
});

test('a reappearance between misses cancels the pending leave', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, []);
  w.poll(w.t0 + POLL, [0]);
  w.poll(w.t0 + 2 * POLL, []); // glitchy poll
  w.poll(w.t0 + 3 * POLL, [0]);
  w.poll(w.t0 + 4 * POLL, []); // and again
  w.poll(w.t0 + 5 * POLL, [0]);
  assert.strictEqual(w.rosterOf('roster-left').length, 0);
  assert.strictEqual(w.rosterOf('roster-joined').length, 1, 'no re-join after a flap');
  assert.strictEqual(w.events.connect.length, 1);
  assert.strictEqual(w.events.disconnect.length, 0);
  assert.deepStrictEqual(w.sessions(0), [[w.t0 + POLL, null]], 'the session never broke');
});

// --------------------------------------------------- RCON outage baseline

test('noteRconDown: the reconnect poll is a baseline; outage leavers date from the drop', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, []);
  w.poll(w.t0 + POLL, [0, 1]); // A, B join
  w.poll(w.t0 + 2 * POLL, [0, 1]);
  w.state.noteRconDown(w.t0 + 40 * SEC);
  w.state.noteRconDown(w.t0 + 50 * SEC); // failed redials keep the first stamp
  const before = w.events.roster.length;

  w.poll(w.t0 + 3 * MIN, [0, 2]); // back: B gone, C appeared while we were blind
  assert.deepStrictEqual(w.events.roster.slice(before).map((e) => e.event), ['roster-baseline']);
  assert.strictEqual(w.events.roster[before].reason, 'reconnect');
  assert.strictEqual(w.events.connect.length, 2, 'C already online when sight returned: not a join');
  assert.strictEqual(w.events.disconnect.length, 0, 'B missing from the reconnect poll: not a leave yet');
  assert.deepStrictEqual(w.sessions(2), [], 'no session invented for C');

  w.poll(w.t0 + 3 * MIN + POLL, [0, 2]); // B still gone: now it counts
  assert.strictEqual(w.events.disconnect.length, 1);
  assert.strictEqual(w.events.disconnect[0].player.eosId, eosOf(1));
  assert.strictEqual(w.events.disconnect[0].time, w.t0 + 40 * SEC, 'dated from the drop, not the reconnect');
  assert.deepStrictEqual(w.sessions(1), [[w.t0 + POLL, w.t0 + 40 * SEC]]);
  assert.strictEqual(w.playSeconds(1), 25);
  assert.deepStrictEqual(w.sessions(0), [[w.t0 + POLL, null]], 'A was continuous');

  w.poll(w.t0 + 4 * MIN, [0]); // C leaves: no session was ever opened, nothing to announce
  w.poll(w.t0 + 4 * MIN + POLL, [0]);
  assert.strictEqual(w.rosterOf('roster-left').length, 2);
  assert.strictEqual(w.events.disconnect.length, 1);
});

// ------------------------------------------------------------ mass vanish

test('mass vanish: no leaves that poll, no join storm on return, newcomers a poll late', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, []);
  w.poll(w.t0 + POLL, range(0, 7)); // 8 joins
  assert.strictEqual(w.events.connect.length, 8);

  w.poll(w.t0 + 2 * POLL, [0, 1, 8]); // 6 of 8 gone at once (broken poll) + newcomer 8
  assert.strictEqual(w.rosterOf('roster-joined').length, 8, 'the vanish poll announces nobody');
  assert.strictEqual(w.events.disconnect.length, 0);

  w.poll(w.t0 + 3 * POLL, range(0, 8)); // everyone back
  assert.strictEqual(w.events.disconnect.length, 0);
  assert.strictEqual(w.events.connect.length, 9, 'only the genuine newcomer joins — no storm');
  assert.strictEqual(w.events.connect[8].player.eosId, eosOf(8));
  assert.strictEqual(w.events.connect[8].time, w.t0 + 3 * POLL);
  for (const i of range(0, 7)) assert.deepStrictEqual(w.sessions(i), [[w.t0 + POLL, null]], `session ${i} untouched`);

  // A real mass exit looks the same at first: held, then confirmed once the
  // hold runs out, every leave dated from the vanish poll.
  const vanishAt = w.t0 + 4 * POLL;
  w.poll(vanishAt, [0, 1]);
  let k = 5;
  for (; w.t0 + k * POLL < vanishAt + 3 * MIN; k++) w.poll(w.t0 + k * POLL, [0, 1]);
  assert.strictEqual(w.events.disconnect.length, 0, 'held for the whole window');
  w.poll(w.t0 + k * POLL, [0, 1]);
  assert.strictEqual(w.events.disconnect.length, 7);
  assert.ok(w.events.disconnect.every((e) => e.time === vanishAt));
  assert.deepStrictEqual(w.sessions(5), [[w.t0 + POLL, vanishAt]]);
  assert.strictEqual(w.openCount(), 2);

  // Below MASS_VANISH_MIN listed players the plain two-poll rule applies.
  const s = makeWorld(t);
  s.poll(s.t0, []);
  s.poll(s.t0 + POLL, [0, 1, 2]);
  s.poll(s.t0 + 2 * POLL, [0]);
  s.poll(s.t0 + 3 * POLL, [0]);
  assert.strictEqual(s.events.disconnect.length, 2);
});

// --------------------------------------------------------------- map change

test('map change: NEW_GAME closes no session and emits no leave; travel absences wait', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, []);
  w.poll(w.t0 + POLL, range(0, 5));
  w.log({ event: 'NEW_GAME', time: w.t0 + 20 * SEC, layerClass: 'Narva_AAS_v2', level: 'Narva' });
  assert.strictEqual(w.openCount(), 6, 'NEW_GAME does not touch sessions');
  assert.strictEqual(w.events.disconnect.length, 0);

  w.poll(w.t0 + 2 * POLL, range(0, 3)); // 4 and 5 still loading the new map
  w.poll(w.t0 + 3 * POLL, range(0, 3)); // a leave outside the travel grace
  assert.strictEqual(w.events.disconnect.length, 0, 'held through map travel');
  w.poll(w.t0 + 4 * POLL, range(0, 5));
  assert.strictEqual(w.events.disconnect.length, 0);
  assert.strictEqual(w.events.connect.length, 6, 'back on the new map: no re-joins');
  assert.strictEqual(w.openCount(), 6);

  // A genuine end-of-match leaver is still recorded once the grace is over.
  w.poll(w.t0 + 5 * POLL, range(0, 4));
  w.poll(w.t0 + 6 * POLL, range(0, 4));
  assert.strictEqual(w.events.disconnect.length, 0);
  w.poll(w.t0 + 4 * MIN, range(0, 4));
  assert.strictEqual(w.events.disconnect.length, 1);
  assert.strictEqual(w.events.disconnect[0].time, w.t0 + 5 * POLL, 'dated from the first missed poll');
});

// ------------------------------------------------- dedupe with the log path

test('log first, then the roster: one session, one announcement each way', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, []);
  w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 5 * SEC, controller: 'BP_PlayerController_C_1', ip: '10.0.0.1', eosId: eosOf(0), steamId: steamOf(0) });
  w.log({ event: 'JOIN_SUCCEEDED', time: w.t0 + 5 * SEC + 100, suffixName: 'Player0' });
  assert.strictEqual(w.events.connect.length, 1);

  w.poll(w.t0 + POLL, [0]); // the roster sees the same connection
  assert.strictEqual(w.rosterOf('roster-joined').length, 1, 'state reports it');
  assert.strictEqual(w.events.connect.length, 1, 'ingest does not announce it twice');
  assert.deepStrictEqual(w.sessions(0), [[w.t0 + 5 * SEC, null]], 'no second session');

  w.poll(w.t0 + 2 * POLL, [0]);
  w.log({ event: 'PLAYER_DISCONNECTED', time: w.t0 + 40 * SEC, eosId: eosOf(0) });
  assert.strictEqual(w.events.disconnect.length, 1);
  w.poll(w.t0 + 3 * POLL, []);
  w.poll(w.t0 + 4 * POLL, []);
  assert.strictEqual(w.rosterOf('roster-left').length, 1, 'state reports it');
  assert.strictEqual(w.events.disconnect.length, 1, 'ingest does not announce it twice');
  assert.deepStrictEqual(w.sessions(0), [[w.t0 + 5 * SEC, w.t0 + 40 * SEC]], 'precise log times kept');
  assert.strictEqual(w.playSeconds(0), 35);
});

test('roster first, then a lagging log: one session with the precise times, no duplicates', async (t) => {
  await t.test('log lines land after the roster already closed the session', (ctx) => {
    const w = makeWorld(ctx);
    w.poll(w.t0, []);
    for (let k = 1; k <= 20; k++) w.poll(w.t0 + k * POLL, [0]); // joined +15s, last seen +300s
    w.poll(w.t0 + 21 * POLL, []);
    w.poll(w.t0 + 22 * POLL, []); // roster leave at +315s
    assert.deepStrictEqual(w.sessions(0), [[w.t0 + POLL, w.t0 + 21 * POLL]]);
    assert.strictEqual(w.playSeconds(0), 300);

    // FTP finally delivers the same connection's lines.
    w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 8 * SEC, controller: 'BP_PlayerController_C_1', ip: '10.0.0.1', eosId: eosOf(0), steamId: steamOf(0) });
    w.log({ event: 'JOIN_SUCCEEDED', time: w.t0 + 8 * SEC + 100, suffixName: 'Player0' });
    w.log({ event: 'PLAYER_DISCONNECTED', time: w.t0 + 309 * SEC, eosId: eosOf(0) });

    assert.strictEqual(w.events.connect.length, 1, 'no second join');
    assert.strictEqual(w.events.disconnect.length, 1, 'no second leave');
    assert.deepStrictEqual(w.sessions(0), [[w.t0 + 8 * SEC, w.t0 + 309 * SEC]], 'one session, precise ends');
    assert.strictEqual(w.playSeconds(0), 301, 're-credited by the deltas, never double counted');
    assert.strictEqual(w.db.prepare('SELECT ip FROM player_ips WHERE player_id=?').get(w.dbId(0)).ip, '10.0.0.1');
    assert.strictEqual(w.state.byEos(eosOf(0)), null, 'a departed player is not resurrected live');
  });

  await t.test('the connect line lands while the player is still on', (ctx) => {
    const w = makeWorld(ctx);
    const CTRL = 'BP_PlayerController_C_2';
    w.poll(w.t0, []);
    w.poll(w.t0 + POLL, [1]); // roster join at +15s
    w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 8 * SEC, controller: CTRL, ip: '10.0.0.2', eosId: eosOf(1), steamId: steamOf(1) });
    w.log({ event: 'JOIN_SUCCEEDED', time: w.t0 + 8 * SEC + 100, suffixName: 'Player1' });
    assert.strictEqual(w.events.connect.length, 1, 'no second join');
    assert.deepStrictEqual(w.sessions(1), [[w.t0 + 8 * SEC, null]], 'start moved to the precise log time');
    const rec = w.state.byEos(eosOf(1));
    assert.strictEqual(rec.ip, '10.0.0.2', 'log-only facts reach the live record');
    assert.strictEqual(rec.controller, CTRL);
    assert.strictEqual(rec.connectedAt, w.t0 + 8 * SEC);
    assert.strictEqual(rec.playerId, 101, 'poll facts kept');
    assert.strictEqual(w.state.controllers.get(CTRL), eosOf(1), 'kills by controller resolve');

    for (let k = 2; k <= 8; k++) w.poll(w.t0 + k * POLL, [1]);
    w.poll(w.t0 + 9 * POLL, []);
    w.poll(w.t0 + 10 * POLL, []); // roster leave at +135s
    w.log({ event: 'PLAYER_DISCONNECTED', time: w.t0 + 130 * SEC, eosId: eosOf(1) });
    assert.strictEqual(w.events.disconnect.length, 1);
    assert.deepStrictEqual(w.sessions(1), [[w.t0 + 8 * SEC, w.t0 + 130 * SEC]]);
    assert.strictEqual(w.playSeconds(1), 122);
  });
});

test('roster a whole connection ahead of the log: each log line finds its own session', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, []);
  for (let k = 1; k <= 6; k++) w.poll(w.t0 + k * POLL, [0]); // join +15s, last seen +90s
  w.poll(w.t0 + 7 * POLL, []);
  w.poll(w.t0 + 8 * POLL, []); // leave at +105s
  w.poll(w.t0 + 9 * POLL, []);
  w.poll(w.t0 + 10 * POLL, [0]); // rejoin at +150s
  assert.strictEqual(w.events.connect.length, 2);
  assert.strictEqual(w.events.disconnect.length, 1);

  // The trailing log: first connection, its end, the rejoin.
  w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 10 * SEC, controller: 'BP_PlayerController_C_1', ip: '10.0.0.1', eosId: eosOf(0), steamId: steamOf(0) });
  w.log({ event: 'JOIN_SUCCEEDED', time: w.t0 + 10 * SEC + 100, suffixName: 'Player0' });
  w.log({ event: 'PLAYER_DISCONNECTED', time: w.t0 + 100 * SEC, eosId: eosOf(0) });
  assert.ok(w.state.byEos(eosOf(0)), 'the old disconnect leaves the current connection live');
  w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 140 * SEC, controller: 'BP_PlayerController_C_3', ip: '10.0.0.1', eosId: eosOf(0), steamId: steamOf(0) });
  w.log({ event: 'JOIN_SUCCEEDED', time: w.t0 + 140 * SEC + 100, suffixName: 'Player0' });

  assert.strictEqual(w.events.connect.length, 2, 'nothing announced twice');
  assert.strictEqual(w.events.disconnect.length, 1);
  assert.deepStrictEqual(w.sessions(0), [
    [w.t0 + 10 * SEC, w.t0 + 100 * SEC],
    [w.t0 + 140 * SEC, null],
  ]);
  assert.strictEqual(w.playSeconds(0), 90);
  assert.strictEqual(w.state.byEos(eosOf(0)).connectedAt, w.t0 + 140 * SEC);
});

test('a short connection the roster never saw is filled in by the log around the rejoin', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, []);
  w.poll(w.t0 + 7 * MIN, [0]); // the roster only sees the later rejoin
  // The trailing log: a 5-second connection minutes earlier, then the rejoin.
  w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 60 * SEC, controller: 'BP_PlayerController_C_1', ip: '10.0.0.1', eosId: eosOf(0), steamId: steamOf(0) });
  w.log({ event: 'PLAYER_DISCONNECTED', time: w.t0 + 65 * SEC, eosId: eosOf(0) });
  assert.ok(w.state.byEos(eosOf(0)), 'the rejoined player stays live');
  w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 7 * MIN - 5 * SEC, controller: 'BP_PlayerController_C_2', ip: '10.0.0.1', eosId: eosOf(0), steamId: steamOf(0) });

  assert.deepStrictEqual(w.sessions(0), [
    [w.t0 + 7 * MIN - 5 * SEC, null], // the roster's session, adopted
    [w.t0 + 60 * SEC, w.t0 + 65 * SEC], // the log's own short one
  ]);
  assert.strictEqual(w.playSeconds(0), 5);
  assert.deepStrictEqual(w.events.connect.map((e) => e.time), [w.t0 + 7 * MIN, w.t0 + 60 * SEC]);
  assert.deepStrictEqual(w.events.disconnect.map((e) => e.time), [w.t0 + 65 * SEC]);
});

test('a session a log gap left open is closed at its last sighting when the roster sees a rejoin', (t) => {
  const w = makeWorld(t);
  // Logged in while RCON was still unlinked; the disconnect line was lost.
  w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 10 * SEC, controller: 'BP_PlayerController_C_1', ip: '10.0.0.1', eosId: eosOf(0), steamId: steamOf(0) });
  w.poll(w.t0 + 20 * MIN, []); // RCON linked: baseline without them
  w.poll(w.t0 + 20 * MIN + POLL, [0]); // they rejoin
  assert.deepStrictEqual(w.sessions(0), [
    [w.t0 + 10 * SEC, w.t0 + 10 * SEC], // ended by the last sighting, not stretched to now
    [w.t0 + 20 * MIN + POLL, null],
  ]);
  assert.strictEqual(w.playSeconds(0), 0);
  assert.strictEqual(w.events.connect.length, 2, 'the rejoin is announced');
});

// ------------------------------------------------------------ panel restart

test('a quick panel restart resumes sessions of players still online (no join storm)', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  db.migrate();
  const w1 = makeWorld(t, db);
  const t0 = w1.t0;
  w1.poll(t0, []);
  w1.poll(t0 + POLL, [0, 1, 2]);
  assert.strictEqual(w1.events.connect.length, 3);
  // The pollers kept last_seen fresh until the panel went down.
  db.prepare('UPDATE players SET last_seen=?').run(t0 + 10 * MIN);
  w1.ingest.stop();

  const w2 = makeWorld(t, db); // boot: crash recovery closes all three at last_seen
  for (const i of [0, 1, 2]) {
    assert.deepStrictEqual(w2.sessions(i), [[t0 + POLL, t0 + 10 * MIN]]);
    assert.strictEqual(w2.playSeconds(i), 585);
  }
  w2.poll(t0 + 10 * MIN + 20 * SEC, [0]); // 1's row missed this poll; 2 left during the restart
  assert.deepStrictEqual(w2.sessions(0), [[t0 + POLL, null]], 'resumed, not reopened');
  assert.strictEqual(w2.playSeconds(0), 0, 'the boot-close credit is taken back');
  w2.poll(t0 + 10 * MIN + 35 * SEC, [0, 1]);
  assert.deepStrictEqual(w2.sessions(1), [[t0 + POLL, null]], 'missed by the baseline alone (one poll): resumed');
  assert.strictEqual(w2.events.connect.length, 0, 'nobody "joined" because the panel restarted');
  assert.deepStrictEqual(w2.sessions(2), [[t0 + POLL, t0 + 10 * MIN]]);
  assert.strictEqual(w2.playSeconds(2), 585);

  // 2 left during the restart. Nobody announced it, so the trailing log's
  // line does, and its precise time replaces boot recovery's guess. Back a
  // little later: a real join, not a resume of the pre-restart session.
  w2.log({ event: 'PLAYER_DISCONNECTED', time: t0 + 10 * MIN + 5 * SEC, eosId: eosOf(2) });
  assert.deepStrictEqual(w2.events.disconnect.map((e) => [e.player.eosId, e.time]), [[eosOf(2), t0 + 10 * MIN + 5 * SEC]]);
  w2.poll(t0 + 10 * MIN + 50 * SEC, [0, 1, 2]);
  assert.deepStrictEqual(w2.events.connect.map((e) => e.player.eosId), [eosOf(2)]);
  assert.deepStrictEqual(w2.sessions(2), [[t0 + POLL, t0 + 10 * MIN + 5 * SEC], [t0 + 10 * MIN + 50 * SEC, null]]);
  assert.strictEqual(w2.playSeconds(2), 590);
  w2.log({ event: 'PLAYER_DISCONNECTED', time: t0 + 10 * MIN + 5 * SEC, eosId: eosOf(2) }); // the same line again
  assert.strictEqual(w2.events.disconnect.length, 1, 'announced once');
  assert.ok(w2.state.byEos(eosOf(2)), 'and it does not end the new connection');

  w2.poll(t0 + 20 * MIN, [1, 2]);
  w2.poll(t0 + 20 * MIN + POLL, [1, 2]);
  const left0 = w2.events.disconnect.filter((e) => e.player.eosId === eosOf(0));
  assert.deepStrictEqual(left0.map((e) => e.time), [t0 + 20 * MIN]);
  assert.deepStrictEqual(w2.sessions(0), [[t0 + POLL, t0 + 20 * MIN]], 'one session across the restart');
  assert.strictEqual(w2.playSeconds(0), 1185, 'credited once');
});

test('after a long outage the first roster is a plain baseline: nothing resumed or announced', (t) => {
  const db = openDb(':memory:');
  t.after(() => db.close());
  db.migrate();
  const w1 = makeWorld(t, db);
  const t0 = w1.t0;
  w1.poll(t0, []);
  w1.poll(t0 + POLL, [0, 1]);
  db.prepare('UPDATE players SET last_seen=?').run(t0 + 10 * MIN);
  w1.ingest.stop();

  const w2 = makeWorld(t, db);
  w2.poll(t0 + 40 * MIN, [0, 1]);
  w2.poll(t0 + 40 * MIN + POLL, [0, 1, 3]);
  assert.deepStrictEqual(w2.sessions(0), [[t0 + POLL, t0 + 10 * MIN]]);
  assert.strictEqual(w2.playSeconds(0), 585);
  assert.deepStrictEqual(w2.events.connect.map((e) => e.player.eosId), [eosOf(3)], 'only the real newcomer');
});

test('boot resume ends one poll after the boot baseline', async (t) => {
  // Two players on a server with only RCON linked; the panel restarts.
  function restarted(ctx, lastSeen) {
    const db = openDb(':memory:');
    ctx.after(() => db.close());
    db.migrate();
    const w1 = makeWorld(ctx, db);
    const t0 = w1.t0;
    w1.poll(t0, []);
    for (let k = 1; k <= 4; k++) w1.poll(t0 + k * POLL, [0, 1]); // both join at +15s, seen to +60s
    w1.poll(t0 + 5 * POLL, [0]); // 1 quit at about +65s: a first miss, no leave yet
    // What the pollers' last_seen updates leave behind.
    for (const i of [0, 1]) db.prepare('UPDATE players SET last_seen=? WHERE eos_id=?').run(t0 + lastSeen[i], eosOf(i));
    w1.ingest.stop();
    return { t0, w: makeWorld(ctx, db) }; // boot recovery closes both at last_seen
  }

  await t.test('missing from the baseline and the poll after it: gone, and a later return is a join', (ctx) => {
    const { t0, w } = restarted(ctx, [75 * SEC, 60 * SEC]);
    assert.deepStrictEqual(w.sessions(1), [[t0 + POLL, t0 + 60 * SEC]]);
    w.poll(t0 + 100 * SEC, [0]); // boot baseline: 1 is not online
    w.poll(t0 + 115 * SEC, [0]); // nor in the poll after it
    w.poll(t0 + 6 * MIN, [0, 1]); // back about five minutes after quitting
    assert.deepStrictEqual(w.events.connect.map((e) => [e.player.eosId, e.time]), [[eosOf(1), t0 + 6 * MIN]]);
    assert.deepStrictEqual(w.sessions(1), [[t0 + POLL, t0 + 60 * SEC], [t0 + 6 * MIN, null]],
      'a new session; the one before the restart stays closed');
    w.poll(t0 + 7 * MIN, [0]);
    w.poll(t0 + 7 * MIN + POLL, [0]);
    assert.deepStrictEqual(w.events.disconnect.map((e) => [e.player.eosId, e.time]), [[eosOf(1), t0 + 7 * MIN]]);
    assert.strictEqual(w.playSeconds(1), 45 + 60);
    assert.strictEqual(w.playSeconds(1), w.credited(1));
    assert.deepStrictEqual(w.sessions(0), [[t0 + POLL, null]], '0 played through the restart');

    const feed = (sql, col) => w.db.prepare(sql).all(120).filter((r) => r.player_id === w.dbId(1)).map((r) => r[col]);
    assert.deepStrictEqual(feed(FEED_CONNECTS, 'connect_at').sort((a, b) => a - b), [t0 + POLL, t0 + 6 * MIN],
      'the backfill has the rejoin');
    assert.deepStrictEqual(feed(FEED_DISCONNECTS, 'disconnect_at'), [t0 + 7 * MIN, t0 + 60 * SEC]);
  });

  await t.test('a reconnect baseline resumes nothing, even as the poll after the boot baseline', (ctx) => {
    const { t0, w } = restarted(ctx, [75 * SEC, 60 * SEC]);
    w.poll(t0 + 100 * SEC, [0]); // boot baseline: 1 is not online
    w.state.noteRconDown(t0 + 105 * SEC);
    w.poll(t0 + 4 * MIN, [0, 1]); // 1 came back while RCON was down
    assert.strictEqual(w.events.connect.length, 0, 'already online when sight returned: not a join');
    assert.deepStrictEqual(w.sessions(1), [[t0 + POLL, t0 + 60 * SEC]], 'the old session is not reopened');
    assert.strictEqual(w.playSeconds(1), 45);
  });
});

// ------------------------------------------- restart while the log trails

test('after a panel restart the trailing log pairs with roster sessions through the db', async (t) => {
  function fresh(ctx) {
    const db = openDb(':memory:');
    ctx.after(() => db.close());
    db.migrate();
    return db;
  }
  const CTRL = 'BP_PlayerController_C_1';
  const connected = (w, time) => {
    w.log({ event: 'PLAYER_CONNECTED', time, controller: CTRL, ip: '10.0.0.1', eosId: eosOf(0), steamId: steamOf(0) });
    w.log({ event: 'JOIN_SUCCEEDED', time: time + 100, suffixName: 'Player0' });
  };

  await t.test('a resumed session takes the lagging connect and disconnect lines', (ctx) => {
    const db = fresh(ctx);
    const w1 = makeWorld(ctx, db);
    const t0 = w1.t0;
    w1.poll(t0, []);
    w1.poll(t0 + POLL, [0]); // roster join at +15s; the +8s PostLogin line is still in the FTP lag
    db.prepare('UPDATE players SET last_seen=?').run(t0 + 25 * SEC);
    w1.ingest.stop();

    const w = makeWorld(ctx, db);
    w.poll(t0 + 40 * SEC, [0]); // boot baseline: still on, the session resumes
    connected(w, t0 + 8 * SEC);
    assert.deepStrictEqual(w.sessions(0), [[t0 + 8 * SEC, null]], 'one open session, from the precise time');
    assert.strictEqual(w.events.connect.length, 0, 'announced once, before the restart');
    assert.strictEqual(w.state.byEos(eosOf(0)).controller, CTRL);

    for (let k = 1; k <= 40; k++) w.poll(t0 + 40 * SEC + k * POLL, [0]); // seen to +640s
    w.poll(t0 + 655 * SEC, []);
    w.poll(t0 + 670 * SEC, []); // roster leave at +655s
    assert.deepStrictEqual(w.sessions(0), [[t0 + 8 * SEC, t0 + 655 * SEC]]);
    w.log({ event: 'PLAYER_DISCONNECTED', time: t0 + 650 * SEC, eosId: eosOf(0) });
    assert.deepStrictEqual(w.sessions(0), [[t0 + 8 * SEC, t0 + 650 * SEC]]);
    assert.strictEqual(w.playSeconds(0), 642);
    assert.strictEqual(w.playSeconds(0), w.credited(0));
    assert.strictEqual(w.events.disconnect.length, 1, 'the roster leave, not repeated');
  });

  await t.test('a connect line that lands before the first roster poll', (ctx) => {
    const db = fresh(ctx);
    const w1 = makeWorld(ctx, db);
    const t0 = w1.t0;
    w1.poll(t0, []);
    w1.poll(t0 + POLL, [0]);
    db.prepare('UPDATE players SET last_seen=?').run(t0 + 25 * SEC);
    w1.ingest.stop();

    const w = makeWorld(ctx, db); // boot recovery: [+15s, +25s]
    connected(w, t0 + 8 * SEC); // the backlog wins the race with ListPlayers
    assert.deepStrictEqual(w.sessions(0), [[t0 + 8 * SEC, t0 + 25 * SEC]], 'the closed session takes the start');
    w.poll(t0 + 40 * SEC, [0]);
    assert.deepStrictEqual(w.sessions(0), [[t0 + 8 * SEC, null]], 'and still resumes');
    assert.strictEqual(w.playSeconds(0), 0, 'with every boot-close second taken back');
    w.poll(t0 + 55 * SEC, []);
    w.poll(t0 + 70 * SEC, []);
    assert.strictEqual(w.playSeconds(0), 47);
    assert.strictEqual(w.playSeconds(0), w.credited(0));
    assert.strictEqual(w.events.connect.length, 0);
  });

  await t.test('a connection the roster closed before the restart takes both lines quietly', (ctx) => {
    const db = fresh(ctx);
    const w1 = makeWorld(ctx, db);
    const t0 = w1.t0;
    w1.poll(t0, []);
    for (let k = 1; k <= 10; k++) w1.poll(t0 + k * POLL, [0]); // joined +15s, last seen +150s
    w1.poll(t0 + 165 * SEC, []);
    w1.poll(t0 + 180 * SEC, []); // roster leave at +165s, announced
    assert.strictEqual(w1.events.disconnect.length, 1);
    w1.ingest.stop();

    const w = makeWorld(ctx, db); // nothing open, nothing for boot recovery
    w.poll(t0 + 200 * SEC, []);
    connected(w, t0 + 8 * SEC);
    w.log({ event: 'PLAYER_DISCONNECTED', time: t0 + 158 * SEC, eosId: eosOf(0) });
    assert.strictEqual(w.events.connect.length, 0, 'both announced before the restart');
    assert.strictEqual(w.events.disconnect.length, 0);
    assert.deepStrictEqual(w.sessions(0), [[t0 + 8 * SEC, t0 + 158 * SEC]], 'one session, precise ends');
    assert.strictEqual(w.playSeconds(0), 150);
    assert.strictEqual(w.playSeconds(0), w.credited(0));
    assert.strictEqual(w.state.byEos(eosOf(0)), null, 'not resurrected live');
  });
});

test('a roster leave closes only the session it watched; an older log session waits for its own line', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, []);
  w.poll(w.t0 + 7 * MIN, [0]); // the roster sees a connection from +7min
  // The trailing log: a 5-second connection minutes earlier, whose disconnect
  // line is still in the FTP lag when the player leaves for good.
  w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 60 * SEC, controller: 'BP_PlayerController_C_1', ip: '10.0.0.1', eosId: eosOf(0), steamId: steamOf(0) });
  for (let k = 1; k <= 4; k++) w.poll(w.t0 + 7 * MIN + k * POLL, [0]); // last seen +8min
  w.poll(w.t0 + 8 * MIN + POLL, []);
  w.poll(w.t0 + 8 * MIN + 2 * POLL, []); // roster leave at +8m15s
  assert.deepStrictEqual(w.sessions(0), [
    [w.t0 + 7 * MIN, w.t0 + 8 * MIN + POLL], // the roster's
    [w.t0 + 60 * SEC, null], // the log's, untouched
  ]);

  w.log({ event: 'PLAYER_DISCONNECTED', time: w.t0 + 65 * SEC, eosId: eosOf(0) });
  w.log({ event: 'PLAYER_CONNECTED', time: w.t0 + 7 * MIN - 5 * SEC, controller: 'BP_PlayerController_C_2', ip: '10.0.0.1', eosId: eosOf(0), steamId: steamOf(0) });
  w.log({ event: 'PLAYER_DISCONNECTED', time: w.t0 + 8 * MIN + 5 * SEC, eosId: eosOf(0) });
  assert.deepStrictEqual(w.sessions(0), [
    [w.t0 + 7 * MIN - 5 * SEC, w.t0 + 8 * MIN + 5 * SEC],
    [w.t0 + 60 * SEC, w.t0 + 65 * SEC],
  ]);
  assert.strictEqual(w.playSeconds(0), 70 + 5);
  assert.strictEqual(w.playSeconds(0), w.credited(0));
  assert.deepStrictEqual(w.events.connect.map((e) => e.time), [w.t0 + 7 * MIN, w.t0 + 60 * SEC]);
  assert.deepStrictEqual(w.events.disconnect.map((e) => e.time), [w.t0 + 8 * MIN + POLL, w.t0 + 65 * SEC]);
});

// ------------------------------------------------------- live-feed backfill

test('the live-feed backfill (api.js session queries) carries roster joins and leaves', (t) => {
  const w = makeWorld(t);
  w.poll(w.t0, []);
  w.poll(w.t0 + POLL, [0, 1]);
  w.poll(w.t0 + 2 * POLL, [0]);
  w.poll(w.t0 + 3 * POLL, [0]); // 1 left, stamped +30s

  const conns = w.db.prepare(FEED_CONNECTS).all(120);
  assert.deepStrictEqual(
    conns.map((r) => [r.connect_at, r.player_id, r.name]).sort((a, b) => a[1] - b[1]),
    [[w.t0 + POLL, w.dbId(0), 'Player0'], [w.t0 + POLL, w.dbId(1), 'Player1']]
  );
  const discs = w.db.prepare(FEED_DISCONNECTS).all(120);
  assert.deepStrictEqual(discs.map((r) => [r.disconnect_at, r.player_id, r.name]),
    [[w.t0 + 2 * POLL, w.dbId(1), 'Player1']]);
});
