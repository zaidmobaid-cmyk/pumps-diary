'use strict';
// Ingest pipeline tests (SPEC §11/§17 + §19.1/§19.3.24): scripted parsed events
// are driven through a REAL EventEmitter bus into a real temp sqlite db, with a
// minimal state stub (§10 + §19.1.1 surface) and an admin stub capturing
// execAdmin calls. All timestamps are fixed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { openDb } = require('../server/db');
const Ingest = require('../server/ingest');

// ---------------------------------------------------------------- fixed data

const SEC = 1000;
const MIN = 60 * SEC;
const T0 = Date.UTC(2026, 2, 1, 21, 0, 0); // 2026-03-01T21:00:00Z

const EOS_A = '000000000000000000000000000000aa';
const EOS_B = '000000000000000000000000000000bb';
const EOS_C = '000000000000000000000000000000cc';
const EOS_D = '000000000000000000000000000000dd';
const EOS_E = '000000000000000000000000000000ee';
const EOS_F = '000000000000000000000000000000ff';
const EOS_G = '00000000000000000000000000000011';
const EOS_H = '00000000000000000000000000000022';
const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';
const STEAM_C = '76561198000000003';
const STEAM_D = '76561198000000004';
const STEAM_E = '76561198000000005';
const STEAM_F = '76561198000000006';
const CTRL_A = 'BP_PlayerController_C_1001';
const CTRL_B = 'BP_PlayerController_C_1002';
const CTRL_C = 'BP_PlayerController_C_1003';

const idsBlob = (eos, steam) => ` EOS: ${eos} steam: ${steam} `;

// ------------------------------------------------------------------- stubs

// Minimal LiveState surface ingest needs (§10 + §19.1.1).
function makeStateStub() {
  return {
    players: new Map(),
    controllers: new Map(),
    squads: [],
    serverInfo: null,
    layers: [],
    currentLayer: null,
    nextLayer: null,
    tickRate: null,
    match: null,
    recentlyDisconnected: [],
    bumps: [],
    byEos(eos) { return this.players.get(eos) || null; },
    bySteam(steam) {
      for (const p of this.players.values()) if (p.steamId === steam) return p;
      return null;
    },
    byController(c) {
      const eos = this.controllers.get(c);
      return eos ? this.players.get(eos) || null : null;
    },
    byName(name) {
      if (name == null) return null;
      for (const p of this.players.values()) if (p.name === name) return p;
      const low = String(name).toLowerCase();
      for (const p of this.players.values()) if (p.name && p.name.toLowerCase() === low) return p;
      for (const p of this.players.values()) if (p.name && p.name.endsWith(String(name))) return p;
      return null;
    },
    bumpSession(eosId, delta) {
      this.bumps.push({ eosId, delta });
      const p = this.players.get(eosId);
      if (!p) return;
      if (delta.kills) p.sessKills = (p.sessKills || 0) + delta.kills;
      if (delta.deaths) p.sessDeaths = (p.sessDeaths || 0) + delta.deaths;
      if (delta.tks) p.sessTks = (p.sessTks || 0) + delta.tks;
    },
  };
}

function makeAdminStub() {
  return {
    calls: [],
    execAdmin(user, action, params) {
      this.calls.push({ user, action, params });
      return Promise.resolve({ ok: true, rconOk: true, command: `stub:${action}`, response: 'OK' });
    },
    execRaw(user, command, meta) {
      this.calls.push({ user, action: 'raw', params: { command, meta } });
      return Promise.resolve({ ok: true, rconOk: true, command, response: 'OK' });
    },
  };
}

const BUS_EVENTS = ['kill', 'chat', 'deployable', 'flag', 'revive', 'match-start', 'match-end',
  'match-state', 'player-connected', 'player-disconnected', 'broadcast', 'tick-rate', 'pop-sample'];

function makeWorld(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-ingest-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ } });
  const db = openDb(path.join(dir, 'ingest.db'));
  t.after(() => db.close());
  db.migrate();
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const state = makeStateStub();
  const admin = makeAdminStub();
  const config = {
    flags: { tkSpreeCount: 3, tkSpreeWindowSec: 180, massTkCount: 5, newPlayerMinutes: 15, chatWatchlist: ['cheat'] },
    autoWarnTeamkiller: true,
    autoWarnMessage: 'TK: {victim}',
    retention: { chatDays: 0, popDays: 30 },
  };
  const ingest = new Ingest({ db, state, bus, config, admin });
  t.after(() => ingest.stop());
  const events = {};
  for (const name of BUS_EVENTS) { events[name] = []; bus.on(name, (p) => events[name].push(p)); }
  return { dir, db, bus, state, admin, config, ingest, events };
}

test('ingest pipeline: scripted parsed events through a real temp db', async (t) => {
  const w = makeWorld(t);
  const L = (ev) => w.bus.emit('log-event', ev);
  const get = (sql, ...p) => w.db.prepare(sql).get(...p);
  const all = (sql, ...p) => w.db.prepare(sql).all(...p);
  const dbId = (eos) => get('SELECT id FROM players WHERE eos_id=?', eos).id;
  const connect = (time, eos, steam, ctrl, ip, name) => {
    L({ event: 'PLAYER_CONNECTED', time, raw: '', controller: ctrl, ip, eosId: eos, steamId: steam });
    L({ event: 'JOIN_SUCCEEDED', time: time + 100, raw: '', suffixName: name });
  };

  let m1 = null;
  let m2 = null;

  await t.test('match start, serverinfo fill-in, connects open sessions', () => {
    L({ event: 'NEW_GAME', time: T0, raw: '', dlc: 'Game', pathParts: 'Maps/Narva/Gameplay_Layers/Narva_AAS_v2.Narva_AAS_v2', level: 'Narva', layerClass: 'Narva_AAS_v2' });
    assert.equal(w.events['match-start'].length, 1);
    m1 = w.events['match-start'][0].matchId;
    assert.ok(Number.isInteger(m1) && m1 > 0);
    assert.equal(w.state.match.id, m1, 'state.match bookkeeping updated');

    const row0 = get('SELECT * FROM matches WHERE id=?', m1);
    assert.equal(row0.layer, 'Narva AAS v2', 'layer pretty-printed from layerClass');
    assert.equal(row0.level, 'Narva');
    assert.equal(row0.layer_class, 'Narva_AAS_v2');
    assert.equal(row0.started_at, T0);
    assert.equal(row0.team1, null);

    w.bus.emit('serverinfo-updated', {
      teamOne: 'USA_S_CombinedArms', teamTwo: 'RGF_S_CombinedArms', mapName: 'Narva AAS v2',
      playerCount: 3, publicQueue: 0, reservedQueue: 0,
    });
    const row1 = get('SELECT team1, team2 FROM matches WHERE id=?', m1);
    assert.equal(row1.team1, 'USA_S_CombinedArms', 'serverinfo-updated filled team1');
    assert.equal(row1.team2, 'RGF_S_CombinedArms');
    assert.equal(w.ingest.match.team1, 'USA_S_CombinedArms');

    L({ event: 'MATCH_STATE', time: T0 + 90 * SEC, raw: '', from: 'WaitingToStart', to: 'InProgress' });
    assert.equal(get('SELECT in_progress_at FROM matches WHERE id=?', m1).in_progress_at, T0 + 90 * SEC);

    connect(T0 + 2 * SEC, EOS_A, STEAM_A, CTRL_A, '10.0.0.1', 'Alpha');
    connect(T0 + 3 * SEC, EOS_B, STEAM_B, CTRL_B, '10.0.0.2', 'Bra"vo');
    connect(T0 + 4 * SEC, EOS_C, STEAM_C, CTRL_C, '10.0.0.3', 'Charlie');

    assert.equal(get('SELECT COUNT(*) AS n FROM players').n, 3);
    const a = get('SELECT * FROM players WHERE eos_id=?', EOS_A);
    assert.equal(a.name, 'Alpha');
    assert.equal(a.steam_id, STEAM_A);
    assert.equal(a.first_seen, T0 + 2 * SEC);
    assert.equal(get('SELECT times, ip FROM player_ips WHERE player_id=?', a.id).ip, '10.0.0.1');
    assert.equal(all('SELECT * FROM sessions WHERE disconnect_at IS NULL').length, 3, 'three open sessions');
    assert.equal(get('SELECT name FROM player_names WHERE player_id=? AND name=?', a.id, 'Alpha').name, 'Alpha');

    // live records + controller map; session counters init 0 (§19.1.1)
    const recA = w.state.players.get(EOS_A);
    assert.equal(recA.dbId, a.id);
    assert.equal(recA.sessKills, 0);
    assert.equal(w.state.controllers.get(CTRL_A), EOS_A);

    // enriched player-connected refs never leak ip/controller (§19.1.1)
    assert.equal(w.events['player-connected'].length, 3);
    const ref = w.events['player-connected'][0].player;
    assert.ok(!('ip' in ref) && !('controller' in ref), 'playerRef must not carry ip/controller');
    assert.equal(ref.eosId, EOS_A);

    // teams arrive via ListPlayers reconcile in production; the stub sets them directly
    w.state.players.get(EOS_A).teamId = 1;
    w.state.players.get(EOS_B).teamId = 1;
    w.state.players.get(EOS_C).teamId = 2;
  });

  const T1 = T0 + 5 * MIN;

  await t.test('TK detection (same team) + auto-warn with quote-stripped substitution + new_player_tk', () => {
    L({
      event: 'PLAYER_WOUNDED', time: T1, raw: '', victimName: 'Bra"vo', damage: '38.250000',
      attackerController0: CTRL_A, attackerIds: idsBlob(EOS_A, STEAM_A), attackerController: CTRL_A, weapon: 'BP_SVDM_Optic',
    });
    const k = get('SELECT * FROM kills ORDER BY id DESC LIMIT 1');
    assert.equal(k.kind, 'wound');
    assert.equal(k.teamkill, 1, 'same-team wound is a TK');
    assert.equal(k.suicide, 0);
    assert.equal(k.match_id, m1);
    assert.equal(k.attacker_id, dbId(EOS_A));
    assert.equal(k.victim_id, dbId(EOS_B));
    assert.ok(Math.abs(k.damage - 38.25) < 1e-9);

    const a = get('SELECT kills, teamkills FROM players WHERE eos_id=?', EOS_A);
    assert.equal(a.kills, 1);
    assert.equal(a.teamkills, 1);
    const b = get('SELECT deaths, tk_deaths FROM players WHERE eos_id=?', EOS_B);
    assert.equal(b.deaths, 1);
    assert.equal(b.tk_deaths, 1);

    // §19.1.1 session counter bumps via state.bumpSession
    assert.equal(w.state.players.get(EOS_A).sessKills, 1);
    assert.equal(w.state.players.get(EOS_A).sessTks, 1);
    assert.equal(w.state.players.get(EOS_B).sessDeaths, 1);

    const ev = w.events.kill[w.events.kill.length - 1];
    assert.equal(ev.teamkill, true);
    assert.equal(ev.suicide, false);
    assert.equal(ev.attacker.name, 'Alpha');
    assert.equal(ev.victim.name, 'Bra"vo');

    // autoWarnTeamkiller -> admin.execAdmin(null, 'warn', …), `"` stripped from substitutions (§19.3.17)
    const warns = w.admin.calls.filter((c) => c.action === 'warn');
    assert.equal(warns.length, 1);
    assert.equal(warns[0].user, null, 'system action: user NULL');
    assert.equal(warns[0].params.playerId, dbId(EOS_A));
    assert.equal(warns[0].params.message, 'TK: Bravo', 'victim name substituted with quotes stripped');
    const wrow = get('SELECT * FROM warnings WHERE player_id=?', dbId(EOS_A));
    assert.equal(wrow.auto, 1);
    assert.equal(wrow.by_user, null);
    assert.equal(wrow.message, 'TK: Bravo');

    // TK 5 minutes after first_seen (< 15m) -> new_player_tk sev2
    const npf = all("SELECT * FROM flags WHERE type='new_player_tk'");
    assert.equal(npf.length, 1);
    assert.equal(npf[0].severity, 2);
    assert.equal(npf[0].player_id, dbId(EOS_A));
  });

  await t.test('suicide is not a TK and counts suicides, not kills', () => {
    L({
      event: 'PLAYER_WOUNDED', time: T1 + 10 * SEC, raw: '', victimName: 'Charlie', damage: '100.000000',
      attackerController0: CTRL_C, attackerIds: idsBlob(EOS_C, STEAM_C), attackerController: CTRL_C, weapon: 'BP_Grenade_Frag',
    });
    const k = get('SELECT * FROM kills ORDER BY id DESC LIMIT 1');
    assert.equal(k.suicide, 1);
    assert.equal(k.teamkill, 0, 'suicide never counts as TK');
    const c = get('SELECT kills, deaths, suicides, teamkills FROM players WHERE eos_id=?', EOS_C);
    assert.equal(c.suicides, 1);
    assert.equal(c.deaths, 1);
    assert.equal(c.kills, 0, 'self-kill grants no kill');
    assert.equal(c.teamkills, 0);
    assert.equal(w.admin.calls.filter((x) => x.action === 'warn').length, 1, 'no auto-warn for suicide');
    const ev = w.events.kill[w.events.kill.length - 1];
    assert.equal(ev.suicide, true);
    assert.equal(ev.teamkill, false);
  });

  await t.test('wound counts the kill; die row is stored but never double-counted', () => {
    // enemy wound resolved via the CONTROLLER fallback (no ids in the blob)
    L({
      event: 'PLAYER_WOUNDED', time: T1 + 20 * SEC, raw: '', victimName: 'Charlie', damage: '55.000000',
      attackerController0: CTRL_A, attackerIds: ' ', attackerController: CTRL_A, weapon: 'BP_M4_Carbine',
    });
    let k = get('SELECT * FROM kills ORDER BY id DESC LIMIT 1');
    assert.equal(k.attacker_id, dbId(EOS_A), 'attacker resolved through controller map');
    assert.equal(k.teamkill, 0, 'cross-team wound is not a TK');

    // the matching Die() line: recorded with kind=die, aggregates untouched
    L({
      event: 'PLAYER_DIED', time: T1 + 21 * SEC, raw: '', victimName: 'Charlie', damage: '55.000000',
      attackerController0: CTRL_A, attackerIds: idsBlob(EOS_A, STEAM_A), attackerController: CTRL_A, weapon: 'BP_M4_Carbine',
    });
    k = get('SELECT * FROM kills ORDER BY id DESC LIMIT 1');
    assert.equal(k.kind, 'die');
    assert.equal(k.attacker_id, dbId(EOS_A));

    const a = get('SELECT kills FROM players WHERE eos_id=?', EOS_A);
    assert.equal(a.kills, 2, 'die did not double-count the kill');
    const c = get('SELECT deaths FROM players WHERE eos_id=?', EOS_C);
    assert.equal(c.deaths, 2, 'die did not double-count the death');
    assert.equal(w.state.players.get(EOS_A).sessKills, 2, 'session counters bumped on wound only');
    assert.equal(w.state.players.get(EOS_C).sessDeaths, 2);

    // environment kill: nullptr controller + no ids -> attacker NULL, not suicide
    L({
      event: 'PLAYER_WOUNDED', time: T1 + 25 * SEC, raw: '', victimName: 'Charlie', damage: '999.000000',
      attackerController0: 'nullptr', attackerIds: ' ', attackerController: 'nullptr', weapon: 'BP_FallDamage',
    });
    k = get('SELECT * FROM kills ORDER BY id DESC LIMIT 1');
    assert.equal(k.attacker_id, null);
    assert.equal(k.suicide, 0);
    assert.equal(get('SELECT deaths FROM players WHERE eos_id=?', EOS_C).deaths, 3);
    assert.equal(w.events.kill[w.events.kill.length - 1].attacker, null);

    assert.equal(all('SELECT * FROM kills').length, 5, '4 wounds + 1 die stored so far');
  });

  await t.test('PLAYER_DAMAGED upserts damage_agg and match_players.damage_dealt', () => {
    for (const dt of [30 * SEC, 31 * SEC]) {
      L({
        event: 'PLAYER_DAMAGED', time: T1 + dt, raw: '', victimName: 'Bra"vo', damage: '25.500000',
        attackerName: 'Alpha', attackerIds: idsBlob(EOS_A, STEAM_A), attackerController: CTRL_A, weapon: 'BP_SVDM_Optic',
      });
    }
    const agg = get('SELECT * FROM damage_agg WHERE match_id=? AND attacker_id=? AND victim_id=? AND weapon=?',
      m1, dbId(EOS_A), dbId(EOS_B), 'BP_SVDM_Optic');
    assert.equal(agg.hits, 2);
    assert.ok(Math.abs(agg.total - 51) < 1e-9);
    assert.equal(agg.teamdamage, 1, 'same-team damage flagged');
    const mp = get('SELECT damage_dealt FROM match_players WHERE match_id=? AND player_id=?', m1, dbId(EOS_A));
    assert.ok(Math.abs(mp.damage_dealt - 51) < 1e-9);
    assert.equal(all('SELECT * FROM damage_agg').length, 1, 'aggregated, no per-hit rows');
  });

  await t.test('revives insert + aggregates for both players', () => {
    L({
      event: 'PLAYER_REVIVED', time: T1 + 40 * SEC, raw: '',
      reviverName: 'Bra"vo', reviverIds: idsBlob(EOS_B, STEAM_B),
      revivedName: 'Charlie', revivedIds: idsBlob(EOS_C, STEAM_C),
    });
    const r = get('SELECT * FROM revives ORDER BY id DESC LIMIT 1');
    assert.equal(r.match_id, m1);
    assert.equal(r.reviver_id, dbId(EOS_B));
    assert.equal(r.revived_id, dbId(EOS_C));
    assert.equal(get('SELECT revives_given FROM players WHERE eos_id=?', EOS_B).revives_given, 1);
    assert.equal(get('SELECT revives_taken FROM players WHERE eos_id=?', EOS_C).revives_taken, 1);
    assert.equal(get('SELECT revives FROM match_players WHERE match_id=? AND player_id=?', m1, dbId(EOS_B)).revives, 1);
    const ev = w.events.revive[0];
    assert.equal(ev.reviver.name, 'Bra"vo');
    assert.equal(ev.revived.name, 'Charlie');
  });

  const T2 = T0 + 8 * MIN;

  await t.test('friendly radio damage -> friendly_radio sev3 with per-(player,match) dedupe accumulating damage', () => {
    // Alpha is team 1 = USA_S_CombinedArms; a USA radio is FRIENDLY to him.
    L({
      event: 'DEPLOYABLE_DAMAGED', time: T2, raw: '', deployable: 'BP_FOBRadio_USA', damage: '350.000000',
      weapon: 'BP_C4_Explosive', playerName: 'Alpha', damageType: 'BP_C4_DamageType', healthRemaining: '1650.000000',
    });
    L({
      event: 'DEPLOYABLE_DAMAGED', time: T2 + 5 * SEC, raw: '', deployable: 'BP_FOBRadio_USA', damage: '150.000000',
      weapon: 'BP_C4_Explosive', playerName: 'Alpha', damageType: 'BP_C4_DamageType', healthRemaining: '1500.000000',
    });
    const rows = all('SELECT * FROM deployable_damage ORDER BY id');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].category, 'radio');
    assert.equal(rows[0].friendly, 1, 'USA radio hit by team-1 (USA) player is friendly');
    assert.equal(rows[0].player_team, 1);
    assert.equal(rows[0].player_id, dbId(EOS_A));

    const flags = all("SELECT * FROM flags WHERE type='friendly_radio'");
    assert.equal(flags.length, 1, 'one flag per (player, match)');
    assert.equal(flags[0].severity, 3);
    assert.equal(flags[0].player_id, dbId(EOS_A));
    assert.equal(flags[0].match_id, m1);
    const det = JSON.parse(flags[0].details);
    assert.equal(det.damage, 500, 'damage accumulated into the existing flag');
    assert.equal(det.hits, 2);

    assert.ok(Math.abs(get('SELECT radio_damage_friendly FROM players WHERE eos_id=?', EOS_A).radio_damage_friendly - 500) < 1e-9);
    const ev = w.events.deployable[0];
    assert.equal(ev.category, 'radio');
    assert.equal(ev.friendly, 1);
    assert.ok(ev.label);
    assert.equal(w.events.flag.filter((f) => f.type === 'friendly_radio').length, 1, 'flag event emitted once, accumulation is silent');

    // Enemy radio damage (Charlie is team 2 = RGF hitting a USA radio): no flag.
    L({
      event: 'DEPLOYABLE_DAMAGED', time: T2 + 10 * SEC, raw: '', deployable: 'BP_FOBRadio_USA', damage: '100.000000',
      weapon: 'BP_IED_Small', playerName: 'Charlie', damageType: 'BP_IED_DamageType', healthRemaining: '1400.000000',
    });
    assert.equal(get('SELECT friendly FROM deployable_damage ORDER BY id DESC LIMIT 1').friendly, 0);
    assert.ok(Math.abs(get('SELECT radio_damage_enemy FROM players WHERE eos_id=?', EOS_C).radio_damage_enemy - 100) < 1e-9);
    assert.equal(all("SELECT * FROM flags WHERE type='friendly_radio'").length, 1);

    // Unknown faction radio (Woodland -> generic): friendly=-1, radio_unknown sev1 >=100 dmg, same dedupe.
    L({
      event: 'DEPLOYABLE_DAMAGED', time: T2 + 20 * SEC, raw: '', deployable: 'BP_FOBRadio_Woodland', damage: '120.000000',
      weapon: 'BP_C4_Explosive', playerName: 'Alpha', damageType: 'BP_C4_DamageType', healthRemaining: '880.000000',
    });
    L({
      event: 'DEPLOYABLE_DAMAGED', time: T2 + 25 * SEC, raw: '', deployable: 'BP_FOBRadio_Woodland', damage: '130.000000',
      weapon: 'BP_C4_Explosive', playerName: 'Alpha', damageType: 'BP_C4_DamageType', healthRemaining: '750.000000',
    });
    assert.equal(get('SELECT friendly FROM deployable_damage ORDER BY id DESC LIMIT 1').friendly, -1, 'unclassifiable stays unknown, never guessed');
    const unk = all("SELECT * FROM flags WHERE type='radio_unknown'");
    assert.equal(unk.length, 1);
    assert.equal(unk[0].severity, 1);
    assert.equal(JSON.parse(unk[0].details).damage, 250);
    assert.ok(Math.abs(get('SELECT deployable_damage_unknown FROM players WHERE eos_id=?', EOS_A).deployable_damage_unknown - 250) < 1e-9);
  });

  const T3 = T0 + 30 * MIN;

  await t.test('tk_spree window flag (one per spree) and mass_tk per match', () => {
    const tkWound = (time) => L({
      event: 'PLAYER_WOUNDED', time, raw: '', victimName: 'Bra"vo', damage: '40.000000',
      attackerController0: CTRL_A, attackerIds: idsBlob(EOS_A, STEAM_A), attackerController: CTRL_A, weapon: 'BP_SVDM_Optic',
    });
    tkWound(T3);            // window restarts: the T1 TK is 25min old
    tkWound(T3 + 10 * SEC);
    tkWound(T3 + 20 * SEC); // 3rd within 180s -> tk_spree fires, window resets
    tkWound(T3 + 30 * SEC); // 5th TK of the match -> mass_tk fires (massTkCount=5)

    const sprees = all("SELECT * FROM flags WHERE type='tk_spree'");
    assert.equal(sprees.length, 1, 'exactly one spree flag, window reset after it');
    assert.equal(sprees[0].severity, 3);
    assert.equal(JSON.parse(sprees[0].details).count, 3);

    const mass = all("SELECT * FROM flags WHERE type='mass_tk'");
    assert.equal(mass.length, 1, 'mass_tk deduped per (player, match)');
    assert.equal(mass[0].match_id, m1);
    assert.equal(JSON.parse(mass[0].details).count, 5);

    assert.equal(all("SELECT * FROM flags WHERE type='new_player_tk'").length, 1, 'spree TKs are past the new-player window');

    const a = get('SELECT kills, teamkills FROM players WHERE eos_id=?', EOS_A);
    assert.equal(a.kills, 6);
    assert.equal(a.teamkills, 5);
    const b = get('SELECT deaths, tk_deaths FROM players WHERE eos_id=?', EOS_B);
    assert.equal(b.deaths, 5);
    assert.equal(b.tk_deaths, 5);
    assert.equal(w.state.players.get(EOS_A).sessTks, 5);
    assert.equal(w.admin.calls.filter((c) => c.action === 'warn').length, 5, 'one auto-warn per TK');
    assert.equal(all('SELECT * FROM warnings WHERE auto=1').length, 5);

    const mp = get('SELECT * FROM match_players WHERE match_id=? AND player_id=?', m1, dbId(EOS_A));
    assert.equal(mp.kills, 6);
    assert.equal(mp.teamkills, 5);
    assert.equal(mp.team_id, 1);
  });

  const T4 = T0 + 45 * MIN;
  const T5 = T0 + 46 * MIN;

  await t.test('match lifecycle: ROUND_ENDED winner/tickets + level overwrite, NEW_GAME closes previous match', () => {
    // the losing team line carries no winner info and is ignored
    L({
      event: 'ROUND_ENDED', time: T4, raw: '', team: '1', factionName: 'United States Army', factionTag: 'USA',
      result: 'lost', tickets: '0', layer: 'Narva AAS v2', level: 'Narva',
    });
    assert.equal(get('SELECT winner_team FROM matches WHERE id=?', m1).winner_team, null);

    L({
      event: 'ROUND_ENDED', time: T4, raw: '', team: '2', factionName: 'Russian Ground Forces', factionTag: 'RGF',
      result: 'won', tickets: '184', layer: 'Narva AAS v2', level: 'Narva Flooded',
    });
    let row = get('SELECT * FROM matches WHERE id=?', m1);
    assert.equal(row.winner_team, 2);
    assert.equal(row.winner_faction, 'Russian Ground Forces');
    assert.equal(row.tickets, 184);
    assert.equal(row.level, 'Narva Flooded', '§19.1.12: ROUND_ENDED level overwrites matches.level');
    assert.equal(row.ended_at, null, 'match stays open until NEW_GAME');

    const endEv = w.events['match-end'][0];
    assert.equal(endEv.matchId, m1);
    assert.equal(endEv.winnerTeam, 2);
    assert.equal(endEv.tickets, 184);
    assert.equal(endEv.endedAt, T4);

    L({ event: 'NEW_GAME', time: T5, raw: '', dlc: 'Game', pathParts: 'Maps/Yehorivka/Gameplay_Layers/Yehorivka_RAAS_v1.Yehorivka_RAAS_v1', level: 'Yehorivka', layerClass: 'Yehorivka_RAAS_v1' });
    row = get('SELECT ended_at FROM matches WHERE id=?', m1);
    assert.equal(row.ended_at, T5, 'NEW_GAME closed the previous match');

    assert.equal(w.events['match-start'].length, 2);
    m2 = w.events['match-start'][1].matchId;
    assert.notEqual(m2, m1);
    const row2 = get('SELECT * FROM matches WHERE id=?', m2);
    assert.equal(row2.layer, 'Yehorivka RAAS v1');
    assert.equal(row2.level, 'Yehorivka');
    assert.equal(row2.ended_at, null);
    assert.equal(w.state.match.id, m2);
    // sessions are NOT closed by NEW_GAME
    assert.equal(all('SELECT * FROM sessions WHERE disconnect_at IS NULL').length, 3);
  });

  await t.test('ban enforcement kicks an actively banned player on PLAYER_CONNECTED', () => {
    // Delta gets known, leaves, gets banned while offline.
    connect(T5 + 1 * SEC, EOS_D, STEAM_D, 'BP_PlayerController_C_1004', '10.0.0.4', 'Delta');
    L({ event: 'PLAYER_DISCONNECTED', time: T5 + 2 * SEC, raw: '', eosId: EOS_D });
    w.db.prepare(
      'INSERT INTO bans(player_id, steam_id, issued_by, issued_at, duration_sec, expires_at, reason, interval_raw, active, rcon_ok) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(dbId(EOS_D), STEAM_D, null, T5, 0, null, 'intentional teamkilling', '0', 1, 1);

    assert.equal(w.admin.calls.filter((c) => c.action === 'kick').length, 0);
    L({ event: 'PLAYER_CONNECTED', time: T5 + 10 * SEC, raw: '', controller: 'BP_PlayerController_C_1005', ip: '10.0.0.4', eosId: EOS_D, steamId: STEAM_D });
    const kicks = w.admin.calls.filter((c) => c.action === 'kick');
    assert.equal(kicks.length, 1);
    assert.equal(kicks[0].user, null, 'system action: user NULL');
    assert.equal(kicks[0].params.playerId, dbId(EOS_D));
    assert.match(kicks[0].params.reason, /^Banned: intentional teamkilling \(until perm\)$/);

    // An EXPIRED ban must not kick.
    connect(T5 + 20 * SEC, EOS_E, STEAM_E, 'BP_PlayerController_C_1006', '10.0.0.5', 'Echo');
    L({ event: 'PLAYER_DISCONNECTED', time: T5 + 21 * SEC, raw: '', eosId: EOS_E });
    w.db.prepare(
      'INSERT INTO bans(player_id, steam_id, issued_by, issued_at, duration_sec, expires_at, reason, interval_raw, active, rcon_ok) VALUES(?,?,?,?,?,?,?,?,?,?)'
    ).run(dbId(EOS_E), STEAM_E, null, T5 - 86400000, 3600, T5, 'expired ban', '1h', 1, 1);
    L({ event: 'PLAYER_CONNECTED', time: T5 + 30 * SEC, raw: '', controller: 'BP_PlayerController_C_1007', ip: '10.0.0.5', eosId: EOS_E, steamId: STEAM_E });
    assert.equal(w.admin.calls.filter((c) => c.action === 'kick').length, 1, 'expired ban did not kick');
  });

  const T6 = T5 + 2 * MIN;

  await t.test('session open/close credits play_seconds', () => {
    connect(T6, EOS_F, STEAM_F, 'BP_PlayerController_C_1008', '10.0.0.6', 'Foxtrot');
    const fid = dbId(EOS_F);
    let sess = all('SELECT * FROM sessions WHERE player_id=?', fid);
    assert.equal(sess.length, 1);
    assert.equal(sess[0].connect_at, T6);
    assert.equal(sess[0].disconnect_at, null);

    L({ event: 'PLAYER_DISCONNECTED', time: T6 + 3600 * SEC, raw: '', eosId: EOS_F });
    sess = all('SELECT * FROM sessions WHERE player_id=?', fid);
    assert.equal(sess.length, 1);
    assert.equal(sess[0].disconnect_at, T6 + 3600 * SEC);
    assert.equal(get('SELECT play_seconds FROM players WHERE id=?', fid).play_seconds, 3600);
    assert.equal(w.state.players.has(EOS_F), false, 'live record removed on disconnect');
    assert.equal(w.events['player-disconnected'].length >= 1, true);
  });

  const Tc = T5 + 3 * MIN;

  await t.test('chat row insert + enriched chat event + watchlist flag + §19.3.24 caps', () => {
    w.bus.emit('chat-packet-parsed', { kind: 'CHAT', channel: 'all', eosId: EOS_A, steamId: STEAM_A, name: 'Alpha', message: 'gg wp', time: Tc });
    let row = get('SELECT * FROM chat ORDER BY id DESC LIMIT 1');
    assert.equal(row.message, 'gg wp');
    assert.equal(row.channel, 'all');
    assert.equal(row.player_id, dbId(EOS_A));
    assert.equal(row.match_id, m2, 'chat linked to the current match');
    const ev = w.events.chat[w.events.chat.length - 1];
    assert.equal(ev.player.name, 'Alpha');
    assert.equal(ev.message, 'gg wp');

    // watchlist: whole-word, case-insensitive
    w.bus.emit('chat-packet-parsed', { kind: 'CHAT', channel: 'team', eosId: EOS_A, steamId: STEAM_A, name: 'Alpha', message: 'you CHEAT bro', time: Tc + SEC });
    let wl = all("SELECT * FROM flags WHERE type='chat_watchlist'");
    assert.equal(wl.length, 1);
    assert.equal(wl[0].severity, 1);
    assert.equal(JSON.parse(wl[0].details).message, 'you CHEAT bro');

    w.bus.emit('chat-packet-parsed', { kind: 'CHAT', channel: 'all', eosId: EOS_A, steamId: STEAM_A, name: 'Alpha', message: 'cheating all day', time: Tc + 2 * SEC });
    wl = all("SELECT * FROM flags WHERE type='chat_watchlist'");
    assert.equal(wl.length, 1, 'substring inside a longer word does not match whole-word watchlist');

    // §19.3.24: chat stored max 480 chars; player name max 64
    w.bus.emit('chat-packet-parsed', { kind: 'CHAT', channel: 'all', eosId: EOS_H, steamId: '76561198000000008', name: 'H'.repeat(100), message: 'x'.repeat(600), time: Tc + 3 * SEC });
    row = get('SELECT LENGTH(message) AS len FROM chat ORDER BY id DESC LIMIT 1');
    assert.equal(row.len, 480);
    assert.equal(get('SELECT LENGTH(name) AS len FROM players WHERE eos_id=?', EOS_H).len, 64);

    // non-CHAT packets (admin cam etc.) are not chat rows
    const before = all('SELECT * FROM chat').length;
    w.bus.emit('chat-packet-parsed', { kind: 'ADMIN_CAM', eosId: EOS_A, steamId: STEAM_A, name: 'Alpha', possessed: true });
    assert.equal(all('SELECT * FROM chat').length, before);
  });

  await t.test('pop samples (test-controlled timers) + retention job', () => {
    assert.equal(typeof w.ingest.startTimers, 'function');
    assert.equal(typeof w.ingest.stopTimers, 'function');
    w.ingest.startTimers();
    assert.ok(w.ingest.popTimer, '60s pop timer armed');
    assert.ok(w.ingest.retentionTimer, 'hourly retention timer armed');
    w.ingest.stopTimers();
    assert.equal(w.ingest.popTimer, null);

    w.state.serverInfo = { playerCount: 42, publicQueue: 3, reservedQueue: 2 };
    w.state.tickRate = 40.5;
    w.state.currentLayer = 'Yehorivka RAAS v1';
    const Tp = T5 + 10 * MIN;
    w.ingest.samplePop(Tp);
    const row = get('SELECT * FROM pop_samples WHERE time=?', Tp);
    assert.equal(row.players, 42);
    assert.equal(row.queue, 5);
    assert.ok(Math.abs(row.tick_rate - 40.5) < 1e-9);
    assert.equal(row.layer, 'Yehorivka RAAS v1');
    assert.equal(w.events['pop-sample'].length, 1);

    // Retention: chatDays=0 keeps forever; >0 prunes strictly older rows.
    const Told = T0 - 10 * 86400000;
    w.bus.emit('chat-packet-parsed', { kind: 'CHAT', channel: 'all', eosId: EOS_A, steamId: STEAM_A, name: 'Alpha', message: 'ancient history', time: Told });
    w.ingest.samplePop(Told);
    w.ingest.retentionSweep(Tp); // chatDays=0, popDays=30: 10-day-old rows survive
    assert.equal(all('SELECT * FROM chat WHERE time=?', Told).length, 1);
    assert.equal(all('SELECT * FROM pop_samples WHERE time=?', Told).length, 1);

    w.config.retention.chatDays = 5;
    w.config.retention.popDays = 5;
    w.ingest.retentionSweep(Tp);
    assert.equal(all('SELECT * FROM chat WHERE time=?', Told).length, 0, 'old chat pruned');
    assert.equal(all('SELECT * FROM pop_samples WHERE time=?', Told).length, 0, 'old pop samples pruned');
    assert.equal(all('SELECT * FROM chat WHERE message=?', 'gg wp').length, 1, 'recent chat kept');
    assert.equal(all('SELECT * FROM pop_samples WHERE time=?', Tp).length, 1, 'recent sample kept');
  });

  await t.test('boot closes dangling sessions (crash recovery) and resumes the open match', () => {
    const T7 = T5 + 20 * MIN;
    L({ event: 'PLAYER_CONNECTED', time: T7, raw: '', controller: 'BP_PlayerController_C_1009', ip: '10.0.0.7', eosId: EOS_G, steamId: null });
    const gid = dbId(EOS_G);
    assert.equal(get('SELECT disconnect_at FROM sessions WHERE player_id=?', gid).disconnect_at, null);
    // simulate later activity before the crash
    w.db.prepare('UPDATE players SET last_seen=? WHERE id=?').run(T7 + 10 * MIN, gid);

    // "reboot": a fresh Ingest on the same db (new bus/state/admin stubs)
    const bus2 = new EventEmitter();
    const state2 = makeStateStub();
    const admin2 = makeAdminStub();
    const ingest2 = new Ingest({ db: w.db, state: state2, bus: bus2, config: w.config, admin: admin2 });
    try {
      const sess = get('SELECT * FROM sessions WHERE player_id=?', gid);
      assert.equal(sess.disconnect_at, T7 + 10 * MIN, 'dangling session closed with disconnect_at = last_seen');
      assert.equal(get('SELECT play_seconds FROM players WHERE id=?', gid).play_seconds, 600);
      assert.equal(all('SELECT * FROM sessions WHERE disconnect_at IS NULL').length, 0, 'every dangling session closed');
      assert.ok(ingest2.match, 'open match resumed at boot');
      assert.equal(ingest2.match.id, m2);
      assert.equal(state2.match.id, m2);
    } finally {
      ingest2.stop();
    }
  });
});
