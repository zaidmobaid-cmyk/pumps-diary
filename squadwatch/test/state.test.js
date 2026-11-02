'use strict';
// LiveState tests (SPEC §10 + §19.1.1): lookups, session counters, playerRef
// shape, ListPlayers reconciliation and the snapshot() grouping/exclusions.
const test = require('node:test');
const assert = require('node:assert');

const LiveState = require('../server/state');

const EOS_A = '000000000000000000000000000000aa';
const EOS_B = '000000000000000000000000000000bb';
const EOS_C = '000000000000000000000000000000cc';
const EOS_D = '000000000000000000000000000000dd';
const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';

// Mirrors the record shape ingest creates on PLAYER_CONNECTED (§10 + §19.1.1).
function liveRec(st, over) {
  const rec = Object.assign({
    playerId: null, dbId: null, eosId: null, steamId: null, name: null,
    teamId: null, squadId: null, isLeader: false, role: null,
    ip: null, controller: null, connectedAt: Date.now(),
    sessKills: 0, sessDeaths: 0, sessTks: 0,
  }, over);
  st.players.set(rec.eosId, rec);
  if (rec.controller) st.controllers.set(rec.controller, rec.eosId);
  return rec;
}

function onlineRow(over) {
  return Object.assign({
    playerId: 1, eosId: EOS_A, steamId: STEAM_A, name: 'Someone',
    teamId: 1, squadId: null, isLeader: false, role: 'USA_Rifleman_01',
  }, over);
}

function collectKeys(v, out) {
  if (Array.isArray(v)) {
    for (const x of v) collectKeys(x, out);
  } else if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      out.add(k);
      collectKeys(v[k], out);
    }
  }
  return out;
}

// ---------------------------------------------------------------- lookups

test('byName: exact beats case-insensitive beats trailing-suffix', () => {
  const st = new LiveState();
  const tagged = liveRec(st, { eosId: EOS_A, name: '[TAG] Wardex' }); // would match endsWith first
  const exact = liveRec(st, { eosId: EOS_B, name: 'Wardex' });
  const cased = liveRec(st, { eosId: EOS_C, name: 'BOBTHEBUILDER' });

  assert.strictEqual(st.byName('Wardex'), exact, 'exact match wins over a trailing match inserted earlier');
  assert.strictEqual(st.byName('wardex'), exact, 'case-insensitive full match');
  assert.strictEqual(st.byName('bobthebuilder'), cased);

  st.players.delete(EOS_B);
  assert.strictEqual(st.byName('Wardex'), tagged, 'JOIN_SUCCEEDED suffix resolves via trailing match');
  assert.strictEqual(st.byName('NoSuchPlayer'), null);
  assert.strictEqual(st.byName(''), null);
  assert.strictEqual(st.byName(null), null);
});

test('byEos / bySteam / byController', () => {
  const st = new LiveState();
  const a = liveRec(st, { eosId: EOS_A, steamId: STEAM_A, name: 'A', controller: 'BP_PlayerController_C_1' });
  assert.strictEqual(st.byEos(EOS_A), a);
  assert.strictEqual(st.byEos(EOS_A.toUpperCase()), a, 'eos lookup is case-insensitive');
  assert.strictEqual(st.byEos('ffffffffffffffffffffffffffffffff'), null);
  assert.strictEqual(st.bySteam(STEAM_A), a);
  assert.strictEqual(st.bySteam('76561198099999999'), null);
  assert.strictEqual(st.byController('BP_PlayerController_C_1'), a);
  assert.strictEqual(st.byController('BP_PlayerController_C_404'), null);
});

// ------------------------------------------------- session counters & refs

test('bumpSession increments and playerRef carries the §19.1.1 shape', () => {
  const st = new LiveState();
  const a = liveRec(st, {
    eosId: EOS_A, steamId: STEAM_A, name: 'Alpha', dbId: 7, teamId: 1, squadId: 2,
    ip: '10.0.0.1', controller: 'BP_PlayerController_C_9',
  });

  st.bumpSession(EOS_A, { kills: 1 });
  st.bumpSession(EOS_A, { kills: 1, tks: 1 });
  st.bumpSession(EOS_A, { deaths: 1 });
  st.bumpSession('unknown-eos', { kills: 5 }); // silently ignored
  assert.strictEqual(a.sessKills, 2);
  assert.strictEqual(a.sessDeaths, 1);
  assert.strictEqual(a.sessTks, 1);

  assert.deepStrictEqual(st.playerRef(a), {
    dbId: 7, eosId: EOS_A, steamId: STEAM_A, name: 'Alpha', teamId: 1, squadId: 2,
    sessKills: 2, sessDeaths: 1, sessTks: 1,
  });
  assert.deepStrictEqual(st.playerRef(EOS_A), st.playerRef(a), 'accepts an eosId too');
  assert.strictEqual(st.playerRef(null), null);
  assert.strictEqual(st.playerRef('unknown-eos'), null);

  // A bare record that never connected live -> nullable counters.
  const ref = st.playerRef({ eosId: EOS_B, name: 'Ghost' });
  assert.deepStrictEqual(ref, {
    dbId: null, eosId: EOS_B, steamId: null, name: 'Ghost', teamId: null, squadId: null,
    sessKills: null, sessDeaths: null, sessTks: null,
  });
});

// ------------------------------------------------------------- reconciling

test('applyListPlayers reconciles team/squad/name, keeps live-only fields, prunes leavers', () => {
  const st = new LiveState();
  // A joined via log events: has ip/controller, no playerId yet.
  const a = liveRec(st, {
    eosId: EOS_A, steamId: STEAM_A, name: 'OldName', controller: 'BP_PlayerController_C_1',
    ip: '86.1.2.3', connectedAt: Date.now() - 5 * 60000, sessKills: 3,
  });

  st.applyListPlayers({
    online: [
      onlineRow({ playerId: 4, eosId: EOS_A.toUpperCase(), steamId: STEAM_A, name: 'NewName', teamId: 1, squadId: 2, isLeader: true, role: 'USA_SL_01' }),
      onlineRow({ playerId: 9, eosId: EOS_B, steamId: STEAM_B, name: 'PollJoin', teamId: 2, squadId: null }),
    ],
    disconnected: [
      { playerId: 3, eosId: EOS_C, steamId: null, name: 'Leaver', sinceDisconnect: '01m.30s' },
    ],
  });

  assert.strictEqual(st.players.size, 2);
  assert.strictEqual(st.byEos(EOS_A), a, 'existing record updated in place');
  assert.strictEqual(a.playerId, 4);
  assert.strictEqual(a.name, 'NewName');
  assert.strictEqual(a.teamId, 1);
  assert.strictEqual(a.squadId, 2);
  assert.strictEqual(a.isLeader, true);
  assert.strictEqual(a.role, 'USA_SL_01');
  assert.strictEqual(a.ip, '86.1.2.3', 'poll must not clear log-known ip');
  assert.strictEqual(a.controller, 'BP_PlayerController_C_1');
  assert.strictEqual(a.sessKills, 3, 'session counters survive reconciliation');

  const b = st.byEos(EOS_B);
  assert.ok(b, 'missed join created as fallback');
  assert.strictEqual(b.sessKills, 0);
  assert.strictEqual(b.teamId, 2);

  assert.deepStrictEqual(st.recentlyDisconnected, [
    { playerId: 3, eosId: EOS_C, steamId: null, name: 'Leaver', sinceDisconnect: '01m.30s' },
  ]);

  // Next poll: A left squad (Squad ID: N/A -> null), B gone entirely.
  st.applyListPlayers({ online: [onlineRow({ playerId: 4, eosId: EOS_A, name: 'NewName', teamId: 1, squadId: null })], disconnected: [] });
  assert.strictEqual(a.squadId, null, 'N/A squad clears squadId');
  assert.strictEqual(st.byEos(EOS_B), null, 'player absent from poll is pruned');
  assert.strictEqual(st.players.size, 1);
});

test('applyListPlayers grace window: a fresh log join survives one stale poll', () => {
  const st = new LiveState();
  const fresh = liveRec(st, { eosId: EOS_A, name: 'JustJoined', connectedAt: Date.now() });
  st.applyListPlayers({ online: [], disconnected: [] });
  assert.strictEqual(st.byEos(EOS_A), fresh, 'poll generated before the join must not evict a fresh player');

  fresh.connectedAt = Date.now() - 2 * 60000; // past the grace window
  st.applyListPlayers({ online: [], disconnected: [] });
  assert.strictEqual(st.byEos(EOS_A), null, 'stale unlisted player is pruned');

  // A record the poll itself created (has playerId) is pruned immediately.
  st.applyListPlayers({ online: [onlineRow({ playerId: 5, eosId: EOS_B, name: 'Blip' })], disconnected: [] });
  assert.ok(st.byEos(EOS_B));
  st.applyListPlayers({ online: [], disconnected: [] });
  assert.strictEqual(st.byEos(EOS_B), null);
});

test('applyServerInfo stores info, updates layers, emits serverinfo-updated', () => {
  const st = new LiveState();
  let emitted = null;
  st.on('serverinfo-updated', (si) => { emitted = si; });
  const info = {
    serverName: 'Test Server', maxPlayers: 100, playerCount: 74, publicQueue: 3, reservedQueue: 0,
    mapName: 'Yehorivka_RAAS_v1', gameMode: 'RAAS', gameVersion: 'v8.0', teamOne: 'USA_S_CombinedArms',
    teamTwo: 'RGF_S_CombinedArms', nextLayer: 'Narva_AAS_v2', matchTimeout: 120, playTimeSec: 600,
  };
  st.applyServerInfo(info);
  assert.strictEqual(st.serverInfo, info);
  assert.strictEqual(st.currentLayer, 'Yehorivka_RAAS_v1');
  assert.strictEqual(st.nextLayer, 'Narva_AAS_v2');
  assert.strictEqual(emitted, info);
  st.applyServerInfo(null); // ignored, no throw
  assert.strictEqual(st.serverInfo, info);
});

// --------------------------------------------------------------- snapshot

test('snapshot groups teams -> squads -> players + unassigned, excludes ip/controller', () => {
  const st = new LiveState();
  st.tickRate = 38.45;
  st.currentLayer = 'Yehorivka_RAAS_v1';
  st.nextLayer = 'Narva_AAS_v2';
  st.match = { id: 12, layer: 'Yehorivka RAAS v1', level: 'Yehorivka', team1: 'USA_S_CombinedArms', team2: 'RGF_S_CombinedArms', startedAt: 1000 };
  st.applyServerInfo({ teamOne: 'USA_S_CombinedArms', teamTwo: 'RGF_S_CombinedArms', mapName: 'Yehorivka_RAAS_v1', nextLayer: 'Narva_AAS_v2' });
  st.applyListSquads([
    { teamId: 1, teamName: 'United States Army', squadId: 1, name: 'CMD', size: 2, locked: false, creatorName: 'Alpha', creatorEos: EOS_A, creatorSteam: STEAM_A },
  ]);

  liveRec(st, { eosId: EOS_A, name: 'Alpha', teamId: 1, squadId: 1, isLeader: true, role: 'USA_SL_01', ip: '1.2.3.4', controller: 'BP_PlayerController_C_1', sessKills: 2 });
  liveRec(st, { eosId: EOS_B, name: 'Bravo', teamId: 1, squadId: 1, ip: '5.6.7.8', controller: 'BP_PlayerController_C_2' });
  liveRec(st, { eosId: EOS_C, name: 'Charlie', teamId: 1, squadId: null });
  liveRec(st, { eosId: EOS_D, name: 'Delta', teamId: 2, squadId: 7 }); // squad poll lagging -> stub squad
  st.recentlyDisconnected = [{ playerId: 3, eosId: 'e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0', steamId: null, name: 'Leaver', sinceDisconnect: '01m.30s' }];

  const snap = st.snapshot();

  // JSON-safe (SSE-ready) and round-trippable.
  assert.deepStrictEqual(JSON.parse(JSON.stringify(snap)), snap);

  // §19.1.1: never leak ip / controller through snapshot.
  const keys = collectKeys(snap, new Set());
  assert.ok(!keys.has('ip'), 'snapshot must not contain any "ip" key');
  assert.ok(!keys.has('controller'), 'snapshot must not contain any "controller" key');

  assert.strictEqual(snap.currentLayer, 'Yehorivka_RAAS_v1');
  assert.strictEqual(snap.nextLayer, 'Narva_AAS_v2');
  assert.strictEqual(snap.tickRate, 38.45);
  assert.strictEqual(snap.match.id, 12);
  assert.notStrictEqual(snap.match, st.match, 'match is copied, not shared');
  assert.deepStrictEqual(snap.recentlyDisconnected, st.recentlyDisconnected);
  assert.notStrictEqual(snap.recentlyDisconnected[0], st.recentlyDisconnected[0]);

  assert.strictEqual(snap.teams.length, 2);
  const [t1, t2] = snap.teams;
  assert.strictEqual(t1.teamId, 1);
  assert.strictEqual(t1.name, 'United States Army', 'team name from ListSquads header');
  assert.strictEqual(t2.teamId, 2);
  assert.strictEqual(t2.name, 'RGF_S_CombinedArms', 'team 2 name falls back to serverInfo');

  assert.strictEqual(t1.squads.length, 1);
  const cmd = t1.squads[0];
  assert.strictEqual(cmd.name, 'CMD');
  assert.strictEqual(cmd.players.length, 2);
  assert.strictEqual(cmd.players[0].name, 'Alpha', 'leader sorts first');
  assert.strictEqual(cmd.players[0].isLeader, true);
  assert.strictEqual(cmd.players[0].sessKills, 2);
  assert.strictEqual(cmd.players[1].name, 'Bravo');
  assert.deepStrictEqual(t1.unassigned.map((p) => p.name), ['Charlie']);

  assert.strictEqual(t2.squads.length, 1, 'unknown squad gets a stub entry');
  assert.strictEqual(t2.squads[0].squadId, 7);
  assert.strictEqual(t2.squads[0].name, null);
  assert.deepStrictEqual(t2.squads[0].players.map((p) => p.name), ['Delta']);

  // Empty state -> empty teams array (frontend shows its empty-state).
  const empty = new LiveState();
  assert.deepStrictEqual(empty.snapshot().teams, []);
  assert.strictEqual(empty.snapshot().match, null);
});

test('snapshot puts players with no team yet under a null-team bucket', () => {
  const st = new LiveState();
  liveRec(st, { eosId: EOS_A, name: 'Fresh' }); // connected via log line only
  const snap = st.snapshot();
  const none = snap.teams.find((t) => t.teamId === null);
  assert.ok(none, 'null-team bucket exists');
  assert.deepStrictEqual(none.unassigned.map((p) => p.name), ['Fresh']);
  assert.strictEqual(snap.teams[snap.teams.length - 1], none, 'null team sorts last');
});
