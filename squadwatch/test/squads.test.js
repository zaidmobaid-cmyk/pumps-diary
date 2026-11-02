'use strict';
// Squad lifecycle tests (SPEC §6.1/§6.3 SQUAD_CREATED + §19.1.11, §10
// squadCreations, v3 squad_events): exact creation records — who created each
// squad and precisely when (vehicle-claim adjudication) — the log+packet
// dedupe window, poll-diff disband detection and its NEW_GAME suppression.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const parser = require('../server/parser');
const LiveState = require('../server/state');
const { openDb } = require('../server/db');
const Ingest = require('../server/ingest');

// ---------------------------------------------------------------- fixed data

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = Date.UTC(2026, 2, 1, 21, 0, 0); // 2026-03-01T21:00:00Z

const EOS_A = '000000000000000000000000000000aa';
const EOS_B = '000000000000000000000000000000bb';
const EOS_C = '000000000000000000000000000000cc';
const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';
const STEAM_C = '76561198000000003';

// Ids blob exactly as the §6.1 regexes capture it (leading space, cut at ")").
const idsEnd = (eos, steam) => ` EOS: ${eos} steam: ${steam}`;

// Hostile-ish names: " | " AND parentheses in both player and squad name.
const FANCY_PLAYER = '[1st] A | B (EU)';
const FANCY_SQUAD = 'ARMOR | MBT (RU) crew';
const FANCY_TEAM = 'Team Manticore Security Task Force';

// Mirrors the live-record shape ingest creates on PLAYER_CONNECTED (§10 + §19.1.1).
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

// A parsed ListSquads row (§6.4 shape).
function squadRow(over) {
  return Object.assign({
    teamId: 1, teamName: 'United States Army', squadId: 1, name: 'CMD',
    size: 1, locked: false, creatorName: 'Alpha', creatorEos: EOS_A, creatorSteam: STEAM_A,
  }, over);
}

// ------------------------------------------------------------------- parser

test('SQUAD_CREATED log line: " | " and parens survive in player AND squad names', () => {
  const line = `[2026.03.01-21.01.00:000][200]LogSquad: ${FANCY_PLAYER} (Online IDs: EOS: ${EOS_A} steam: ${STEAM_A}) has created Squad 7 (Squad Name: ${FANCY_SQUAD}) on ${FANCY_TEAM}`;
  const ev = parser.parseLogLine(line);
  assert.deepStrictEqual(ev, {
    event: 'SQUAD_CREATED', time: T0 + 1 * MIN, raw: line,
    playerName: FANCY_PLAYER, ids: idsEnd(EOS_A, STEAM_A), squadId: 7,
    squadName: FANCY_SQUAD, teamName: FANCY_TEAM,
  });
  // the captured blob resolves through the tolerant id scanner (§6.1)
  assert.deepStrictEqual(parser.parseOnlineIds(ev.ids), { eosId: EOS_A, steamId: STEAM_A });
});

test('SQUAD_CREATED chat packet (no "LogSquad: " prefix, §19.1.11) parses identically', () => {
  const body = `${FANCY_PLAYER} (Online IDs: EOS: ${EOS_A} steam: ${STEAM_A}) has created Squad 7 (Squad Name: ${FANCY_SQUAD}) on ${FANCY_TEAM}`;
  const pkt = parser.parseChatPacket(body);
  assert.deepStrictEqual(pkt, {
    kind: 'SQUAD_CREATED', playerName: FANCY_PLAYER, ids: idsEnd(EOS_A, STEAM_A),
    squadId: 7, squadName: FANCY_SQUAD, teamName: FANCY_TEAM,
  });
  // field-for-field identical to the log-line parse — ingest treats both alike
  const fromLog = parser.parseLogLine(`[2026.03.01-21.01.00:000][200]LogSquad: ${body}`);
  for (const k of ['playerName', 'ids', 'squadId', 'squadName', 'teamName']) {
    assert.deepStrictEqual(pkt[k], fromLog[k], k);
  }
});

// -------------------------------------------------------------------- state

test('noteSquadCreated + applyListSquads: snapshot squad carries createdAt + creatorDbId', () => {
  const st = new LiveState();
  st.noteSquadCreated({
    teamId: 1, squadId: 3, name: 'ARMOR', time: T0,
    creatorName: 'Alpha', creatorEos: EOS_A, creatorDbId: 42,
  });
  st.applyListSquads([squadRow({ squadId: 3, name: 'ARMOR', size: 2 })]);
  const t1 = st.snapshot().teams.find((t) => t.teamId === 1);
  const sq = t1.squads.find((s) => s.squadId === 3);
  assert.strictEqual(sq.createdAt, T0, 'exact creation time from SQUAD_CREATED');
  assert.strictEqual(sq.creatorDbId, 42);
  assert.strictEqual(sq.creatorName, 'Alpha');
});

test('a poll row renaming the same team:squadId drops the stale creation record', () => {
  const st = new LiveState();
  st.noteSquadCreated({
    teamId: 1, squadId: 3, name: 'ARMOR', time: T0,
    creatorName: 'Alpha', creatorEos: EOS_A, creatorDbId: 42,
  });
  st.applyListSquads([squadRow({ squadId: 3, name: 'ARMOR' })]);
  assert.ok(st.squadCreations.get('1:3'), 'creation record alive while the name matches');

  // Squad 3 vanished and its id was reused for a squad whose SQUAD_CREATED we
  // never saw (log gap): drop rather than mislabel the new squad.
  st.applyListSquads([squadRow({
    squadId: 3, name: 'INF RUSH', creatorName: 'Bravo', creatorEos: EOS_B, creatorSteam: STEAM_B,
  })]);
  assert.strictEqual(st.squadCreations.get('1:3'), undefined, 'stale creation record dropped');
  const sq = st.snapshot().teams.find((t) => t.teamId === 1).squads.find((s) => s.squadId === 3);
  assert.strictEqual(sq.createdAt, null);
  assert.strictEqual(sq.creatorDbId, null);
});

test("applyListSquads emits 'squad-disbanded' with creation info when a squad vanishes", () => {
  const st = new LiveState();
  const got = [];
  st.on('squad-disbanded', (e) => got.push(e));
  st.noteSquadCreated({
    teamId: 2, squadId: 5, name: 'HELI', time: T0,
    creatorName: 'Charlie', creatorEos: EOS_C, creatorDbId: 9,
  });
  st.applyListSquads([squadRow({
    teamId: 2, teamName: 'Russian Ground Forces', squadId: 5, name: 'HELI',
    creatorName: 'Charlie', creatorEos: EOS_C, creatorSteam: STEAM_C,
  })]);
  assert.strictEqual(got.length, 0, 'squad still listed: no disband');

  st.applyListSquads([]); // squad gone from the next poll
  assert.strictEqual(got.length, 1);
  const ev = got[0];
  assert.strictEqual(ev.teamId, 2);
  assert.strictEqual(ev.squadId, 5);
  assert.strictEqual(ev.name, 'HELI');
  assert.strictEqual(ev.creatorName, 'Charlie');
  assert.strictEqual(ev.createdAt, T0, 'creation info rides the disband event');
  assert.ok(Number.isFinite(ev.time));
  assert.strictEqual(st.squadCreations.get('2:5'), undefined, 'creation record consumed');
});

test('clearSquadsForNewGame empties squads + creations and suppresses disbands for 30s', () => {
  const st = new LiveState();
  const got = [];
  st.on('squad-disbanded', (e) => got.push(e));
  st.noteSquadCreated({
    teamId: 1, squadId: 1, name: 'CMD', time: T0,
    creatorName: 'Alpha', creatorEos: EOS_A, creatorDbId: 1,
  });
  st.applyListSquads([squadRow({ squadId: 1, name: 'CMD' }), squadRow({ squadId: 2, name: 'INF' })]);

  st.clearSquadsForNewGame();
  assert.deepStrictEqual(st.squads, [], 'squads emptied');
  assert.strictEqual(st.squadCreations.size, 0, 'creations emptied');

  // Map-change turnover: squads churn right after NEW_GAME — pure silence.
  st.applyListSquads([squadRow({ squadId: 1, name: 'CMD' })]);
  st.applyListSquads([]); // would be a disband outside the window
  assert.strictEqual(got.length, 0, 'no disband events within 30s of NEW_GAME');
});

// ------------------------------------------------------------------- ingest

function makeWorld(t) {
  const db = openDb(':memory:');
  t.after(() => db.close());
  db.migrate();
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const state = new LiveState();
  // index.js wiring: state's poll-diff disbands are forwarded onto the bus.
  state.on('squad-disbanded', (ev) => bus.emit('squad-disbanded', ev));
  const config = { flags: {}, retention: {} };
  const ingest = new Ingest({ db, state, bus, config, admin: null });
  t.after(() => ingest.stop());
  const events = { created: [], disbanded: [] };
  bus.on('squad-created', (p) => events.created.push(p));
  bus.on('squad-disbanded', (p) => events.disbanded.push(p));
  return { db, bus, state, config, ingest, events };
}

test('squad_events pipeline: creations, dedupe, disbands through a real in-memory db', async (t) => {
  const w = makeWorld(t);
  const L = (ev) => w.bus.emit('log-event', ev);
  const get = (sql, ...p) => w.db.prepare(sql).get(...p);
  const all = (sql, ...p) => w.db.prepare(sql).all(...p);

  let m1 = null;
  let aId = null;

  await t.test('SQUAD_CREATED log event writes the created row and announces it', () => {
    L({
      event: 'NEW_GAME', time: T0, raw: '', dlc: 'Game',
      pathParts: 'Maps/Narva/Gameplay_Layers/Narva_AAS_v2.Narva_AAS_v2',
      level: 'Narva', layerClass: 'Narva_AAS_v2',
    });
    m1 = w.ingest.match.id;
    assert.ok(Number.isInteger(m1) && m1 > 0, 'match opened');

    // the creator is online with a known team; the event's team text is a
    // display name and must NOT be the source while a live record exists
    liveRec(w.state, { eosId: EOS_A, steamId: STEAM_A, name: 'Alpha', teamId: 1 });

    const line = `[2026.03.01-21.01.00:000][300]LogSquad: Alpha (Online IDs: EOS: ${EOS_A} steam: ${STEAM_A}) has created Squad 1 (Squad Name: ${FANCY_SQUAD}) on ${FANCY_TEAM}`;
    const ev = parser.parseLogLine(line);
    assert.strictEqual(ev.event, 'SQUAD_CREATED');
    L(ev);

    const rows = all("SELECT * FROM squad_events WHERE type='created'");
    assert.equal(rows.length, 1);
    const r = rows[0];
    assert.equal(r.time, T0 + 1 * MIN, 'exact creation time from the log stamp');
    assert.equal(r.match_id, m1, 'linked to the open match');
    assert.equal(r.team_id, 1, "team from the creator's live record, not the team text");
    assert.equal(r.squad_id, 1);
    assert.equal(r.name, FANCY_SQUAD);
    aId = Number(get('SELECT id FROM players WHERE eos_id=?', EOS_A).id);
    assert.equal(r.player_id, aId, 'creator resolved via getOrCreatePlayer');
    assert.equal(r.player_name, 'Alpha');
    assert.equal(r.by_user, null);

    assert.equal(w.events.created.length, 1);
    assert.deepStrictEqual(w.events.created[0], {
      time: T0 + 1 * MIN, matchId: m1, teamId: 1, squadId: 1, name: FANCY_SQUAD,
      creatorName: 'Alpha', creatorDbId: aId,
    });

    // exact creation record stamped into live state (snapshot createdAt source)
    const created = w.state.squadCreations.get('1:1');
    assert.ok(created, 'noteSquadCreated called');
    assert.strictEqual(created.time, T0 + 1 * MIN);
    assert.strictEqual(created.creatorDbId, aId);
  });

  await t.test('the same creation arriving as a chat packet within the window is deduped', () => {
    const body = `Alpha (Online IDs: EOS: ${EOS_A} steam: ${STEAM_A}) has created Squad 1 (Squad Name: ${FANCY_SQUAD}) on ${FANCY_TEAM}`;
    const pkt = parser.parseChatPacket(body);
    assert.strictEqual(pkt.kind, 'SQUAD_CREATED');
    // RCON packets carry no timestamp; pin one inside the 15s dedupe window.
    w.bus.emit('chat-packet-parsed', Object.assign({ time: T0 + 1 * MIN + 5 * SEC }, pkt));

    assert.equal(all("SELECT * FROM squad_events WHERE type='created'").length, 1,
      'log + packet duplicate wrote no second row');
    assert.equal(w.events.created.length, 1, 'no duplicate bus announcement');
  });

  await t.test('a different squad created inside the same window still writes', () => {
    liveRec(w.state, { eosId: EOS_B, steamId: STEAM_B, name: 'Bravo', teamId: 1 });
    w.bus.emit('chat-packet-parsed', {
      kind: 'SQUAD_CREATED', playerName: 'Bravo', ids: idsEnd(EOS_B, STEAM_B),
      squadId: 2, squadName: 'LOGI', teamName: FANCY_TEAM,
      time: T0 + 1 * MIN + 10 * SEC,
    });
    const rows = all("SELECT * FROM squad_events WHERE type='created' ORDER BY id");
    assert.equal(rows.length, 2);
    assert.equal(rows[1].squad_id, 2);
    assert.equal(rows[1].name, 'LOGI');
    assert.equal(rows[1].team_id, 1);
    const bId = Number(get('SELECT id FROM players WHERE eos_id=?', EOS_B).id);
    assert.equal(rows[1].player_id, bId);
    assert.equal(w.events.created.length, 2);
    assert.equal(w.state.byEos(EOS_B).dbId, bId, 'live record backfilled with dbId');
  });

  await t.test('creator not in live state: no team guessing — record pends, next ListSquads resolves it', () => {
    L({
      event: 'SQUAD_CREATED', time: T0 + 2 * MIN, raw: '',
      playerName: 'Ghost', ids: idsEnd(EOS_C, STEAM_C), squadId: 4,
      // Faction display name with misleading digits: must never become team 78.
      squadName: 'INF', teamName: '78th Detached Logistics Brigade',
    });
    const r = get("SELECT * FROM squad_events WHERE type='created' AND squad_id=4");
    assert.ok(r, 'created row written');
    assert.equal(r.team_id, null, 'team unknown at event time stays NULL, never parsed from the faction text');
    const c = get('SELECT * FROM players WHERE eos_id=?', EOS_C);
    assert.equal(r.player_id, c.id, 'creator row created even while unseen live');
    assert.equal(c.name, 'Ghost');
    assert.equal(c.steam_id, STEAM_C);
    assert.ok(!w.state.squadCreations.has('78:4'), 'no record invented for a digit-guessed team');
    // The next squad poll names the authoritative team: the exact creation
    // time attaches to it and reaches the snapshot.
    w.state.applyListSquads([{ teamId: 2, squadId: 4, name: 'INF', size: 1, locked: false, creatorName: 'Ghost' }]);
    const rec = w.state.squadCreations.get('2:4');
    assert.ok(rec, 'pending creation resolved onto team 2');
    assert.equal(rec.time, T0 + 2 * MIN, 'exact event time preserved through resolution');
    const snapTeams = w.state.snapshot().teams;
    const t2 = snapTeams.find((x) => x.teamId === 2);
    const inf = t2 && t2.squads.find((s) => s.squadId === 4);
    assert.ok(inf && inf.createdAt === T0 + 2 * MIN, 'snapshot squad carries the exact createdAt');
  });

  await t.test("bus 'squad-disbanded' writes one disbanded row per squad per 30s", () => {
    const T1 = T0 + 5 * MIN;
    w.bus.emit('squad-disbanded', {
      time: T1, teamId: 1, squadId: 1, name: FANCY_SQUAD,
      creatorName: 'Alpha', createdAt: T0 + 1 * MIN,
    });
    let rows = all("SELECT * FROM squad_events WHERE type='disbanded'");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].time, T1);
    assert.equal(rows[0].match_id, m1);
    assert.equal(rows[0].team_id, 1);
    assert.equal(rows[0].squad_id, 1);
    assert.equal(rows[0].name, FANCY_SQUAD);
    assert.equal(rows[0].player_id, null, 'the poll diff does not know the actor');
    assert.equal(rows[0].player_name, 'Alpha', 'creator name kept for the record');
    assert.equal(rows[0].by_user, null);

    // the next poll echoes the same vanished squad inside 30s -> no duplicate
    w.bus.emit('squad-disbanded', {
      time: T1 + 10 * SEC, teamId: 1, squadId: 1, name: FANCY_SQUAD,
      creatorName: 'Alpha', createdAt: T0 + 1 * MIN,
    });
    rows = all("SELECT * FROM squad_events WHERE type='disbanded'");
    assert.equal(rows.length, 1, 'duplicate within 30s suppressed');

    // a different squad disbanding in the same window still writes
    w.bus.emit('squad-disbanded', {
      time: T1 + 12 * SEC, teamId: 1, squadId: 2, name: 'LOGI',
      creatorName: 'Bravo', createdAt: T0 + 1 * MIN + 10 * SEC,
    });
    rows = all("SELECT * FROM squad_events WHERE type='disbanded' ORDER BY id");
    assert.equal(rows.length, 2);
    assert.equal(rows[1].squad_id, 2);
  });
});

test('poll-diff disband flows state -> bus -> disbanded row (index.js wiring)', (t) => {
  const w = makeWorld(t); // fresh world: no NEW_GAME yet, so no suppression window
  w.state.applyListSquads([squadRow({ squadId: 9, name: 'RECON' })]);
  w.state.applyListSquads([]);
  assert.strictEqual(w.events.disbanded.length, 1, 'state emission forwarded to the bus');
  const r = w.db.prepare("SELECT * FROM squad_events WHERE type='disbanded'").get();
  assert.ok(r, 'disbanded row written by ingest');
  assert.equal(r.team_id, 1);
  assert.equal(r.squad_id, 9);
  assert.equal(r.name, 'RECON');
  assert.equal(r.match_id, null, 'no open match');
  assert.equal(r.player_name, 'Alpha');
  assert.equal(r.player_id, null);
});

// --------------------------------------------- review hardening (2026-11-02)

test('review hardening: transitions, outages, cross-source dedupe, disband identity', async (t) => {
  await t.test('all squads vanishing at once is a world transition, not a disband storm', () => {
    const st = new LiveState();
    const got = [];
    st.on('squad-disbanded', (e) => got.push(e));
    st.applyListSquads([
      squadRow({ squadId: 1 }), squadRow({ squadId: 2, name: 'INF' }),
      squadRow({ teamId: 2, squadId: 1, name: 'DAGGER' }),
    ]);
    st.noteSquadCreated({ teamId: 1, squadId: 1, name: 'CMD', time: Date.now(), creatorName: 'Alpha' });
    st.applyListSquads([]); // map change seen by the poll before (or without) NEW_GAME
    assert.strictEqual(got.length, 0, 'no disband events for a full wipe');
    assert.strictEqual(st.squadCreations.size, 0, 'creation records reset with the world');
    // the post-transition window stays quiet even for singles
    st.applyListSquads([squadRow({ squadId: 3, name: 'X' })]);
    st.applyListSquads([]);
    assert.strictEqual(got.length, 0, 'suppression window covers the churn');
  });

  await t.test('a single squad disappearing IS still a disband', () => {
    const st = new LiveState();
    const got = [];
    st.on('squad-disbanded', (e) => got.push(e));
    st.applyListSquads([squadRow({ squadId: 1 }), squadRow({ squadId: 2, name: 'INF' })]);
    st.applyListSquads([squadRow({ squadId: 2, name: 'INF' })]);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].squadId, 1);
  });

  await t.test('noteRconDown makes the first poll after reconnect a baseline', () => {
    const st = new LiveState();
    const got = [];
    st.on('squad-disbanded', (e) => got.push(e));
    st.applyListSquads([squadRow({ squadId: 1 }), squadRow({ squadId: 2, name: 'INF' })]);
    st.noteRconDown();
    st.applyListSquads([squadRow({ squadId: 2, name: 'INF' })]); // squad 1 left during the outage
    assert.strictEqual(got.length, 0, 'catch-up poll emits nothing');
    st.applyListSquads([]); // next diff is live again: squad 2 really disbanded
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].squadId, 2);
  });

  await t.test('serverinfo map change resets squads without any log source', () => {
    const st = new LiveState();
    const got = [];
    st.on('squad-disbanded', (e) => got.push(e));
    st.applyServerInfo({ mapName: 'SU_Kokan_Invasion_v1' });
    st.applyListSquads([squadRow({ squadId: 1 })]);
    st.noteSquadCreated({ teamId: 1, squadId: 1, name: 'CMD', time: Date.now(), creatorName: 'Alpha' });
    assert.strictEqual(st.squadCreations.size, 1);
    st.applyServerInfo({ mapName: 'SU_Tallil_Outskirts_Invasion_v1' });
    assert.strictEqual(st.squadCreations.size, 0, 'creations cleared on map change');
    st.applyListSquads([]); // squads emptying right after the change is quiet
    assert.strictEqual(got.length, 0);
  });

  await t.test('cross-source duplicate with a team-resolution flip: one row, backfilled', (ctx) => {
    const w = makeWorld(ctx);
    const all = (sql, ...p) => w.db.prepare(sql).all(...p);
    const now = Date.now();
    // RCON copy first: creator not rostered yet -> team unknown
    w.bus.emit('chat-packet-parsed', {
      kind: 'SQUAD_CREATED', playerName: 'Ghost', ids: idsEnd(EOS_C, STEAM_C),
      squadId: 9, squadName: 'HELI', teamName: FANCY_TEAM,
    });
    let rows = all("SELECT * FROM squad_events WHERE type='created' AND squad_id=9");
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].team_id, null, 'first copy could not resolve the team');
    // roster catches up, then the lagged log copy of the SAME creation arrives
    liveRec(w.state, { eosId: EOS_C, steamId: STEAM_C, name: 'Ghost', teamId: 2 });
    w.bus.emit('log-event', {
      event: 'SQUAD_CREATED', time: now, raw: '', playerName: 'Ghost',
      ids: idsEnd(EOS_C, STEAM_C), squadId: 9, squadName: 'HELI', teamName: FANCY_TEAM,
    });
    rows = all("SELECT * FROM squad_events WHERE type='created' AND squad_id=9");
    assert.strictEqual(rows.length, 1, 'no double insert when resolution flips between arrivals');
    assert.strictEqual(rows[0].team_id, 2, 'row backfilled with the resolved team');
    assert.strictEqual(w.events.created.length, 1, 'one bus event for one creation');
    const rec = w.state.squadCreations.get('2:9');
    assert.ok(rec, 'pending creation resolved onto the real team');
  });

  await t.test('same source twice is a genuine recreate: two rows', (ctx) => {
    const w = makeWorld(ctx);
    const all = (sql, ...p) => w.db.prepare(sql).all(...p);
    const now = Date.now();
    liveRec(w.state, { eosId: EOS_A, steamId: STEAM_A, name: 'Alpha', teamId: 1 });
    for (const dt of [0, 20000]) {
      w.bus.emit('log-event', {
        event: 'SQUAD_CREATED', time: now + dt, raw: '', playerName: 'Alpha',
        ids: idsEnd(EOS_A, STEAM_A), squadId: 5, squadName: 'ARMOR', teamName: FANCY_TEAM,
      });
    }
    const rows = all("SELECT * FROM squad_events WHERE type='created' AND squad_id=5");
    assert.strictEqual(rows.length, 2, 'disband-and-recreate is two creations');
  });

  await t.test('disband dedupe is per squad identity: a reused id with a new name records', (ctx) => {
    const w = makeWorld(ctx);
    const all = (sql, ...p) => w.db.prepare(sql).all(...p);
    const now = Date.now();
    w.bus.emit('squad-disbanded', { time: now, teamId: 1, squadId: 2, name: 'ALPHA', creatorName: 'A' });
    w.bus.emit('squad-disbanded', { time: now + 5000, teamId: 1, squadId: 2, name: 'ALPHA', creatorName: 'A' });
    w.bus.emit('squad-disbanded', { time: now + 10000, teamId: 1, squadId: 2, name: 'BRAVO', creatorName: 'B' });
    const rows = all("SELECT name FROM squad_events WHERE type='disbanded' AND squad_id=2 ORDER BY id");
    assert.deepStrictEqual(rows.map((r) => r.name), ['ALPHA', 'BRAVO'],
      'the poll echo deduped, the reused-id squad recorded');
  });
});
