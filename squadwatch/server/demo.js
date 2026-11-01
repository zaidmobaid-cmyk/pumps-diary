'use strict';
// Demo-mode orchestrator (SPEC §15). Boots a MockSquad on an ephemeral port,
// seeds ~3 backdated historical matches into the log file (so the app ingests
// them with backfill:true), then runs a continuous randomized live scenario.
//
// startDemo({dataDir}) -> Promise<{rconHost, rconPort, rconPassword, logPath, stop}>

const path = require('node:path');
const fs = require('node:fs');
const { log } = require('./util');
const { MockSquad } = require('../test/mock-squad');

const RCON_PASSWORD = 'demo';
const GRIEFER = 'GrieferGuy';

// 4-layer live rotation (all present in MockSquad's ListLayers).
const ROTATION = ['Yehorivka_RAAS_v1', 'Narva_AAS_v2', 'Gorodok_RAAS_v1', 'Mutaha_AAS_v1'];

const WEAPONS = [
  'BP_M4_Carbine', 'BP_AK74_Base', 'BP_SVDM_Optic', 'BP_M240B', 'BP_PKM',
  'BP_M110_Optic', 'BP_AKS74U', 'BP_M9_Beretta', 'BP_Frag_Grenade', 'BP_M136',
];
const ROLES = ['Rifleman_01', 'Medic_01', 'AutomaticRifleman_01', 'Grenadier_01', 'Marksman_01', 'SL_01'];
const SQUAD_NAMES = ['CMD', 'INF', 'ARMOR', 'HELI', 'LOGI', 'MORTARS', 'RECON', 'MBT', 'BRADLEY', 'FOB BUILDERS'];
const CHAT_LINES = [
  'need a medic at bravo', 'logi inbound to main', 'enemies on the radio tower',
  'gg', 'wp', 'anyone got binos?', 'marking armor on the map', 'HAB down, rally up',
  'squad lead, requesting pickup', 'nice shot', 'who is driving the logi??',
  'push alpha with us', 'heli crashed lol', 'mines on the main road', 'ty',
  'that TK was not on purpose, sorry', 'watch the hill east of cafe',
  'заходим с фланга', 'où est le FOB ?', 'vamos amigos', '敌人在北边',
  'free kit in main', 'need crewman for MBT', 'spawning rally', 'cap is bleeding, back cap!',
];

function rnd(n) { return Math.floor(Math.random() * n); }
function pick(arr) { return arr[rnd(arr.length)]; }
function between(a, b) { return a + Math.random() * (b - a); }

async function startDemo(opts) {
  const dataDir = (opts && opts.dataDir) || 'data';
  fs.mkdirSync(dataDir, { recursive: true });
  const logPath = path.join(dataDir, 'demo-SquadGame.log');

  const firstBoot = !fs.existsSync(logPath) || fs.statSync(logPath).size === 0;

  const mock = new MockSquad({ rconPort: 0, logPath, password: RCON_PASSWORD });
  await mock.start();

  if (firstBoot) {
    try {
      seedHistory(mock);
    } catch (e) {
      log.warn('demo', 'failed to seed historical matches: ' + e.message);
    }
  }

  const live = runLiveScenario(mock);

  log.info('demo', `MockSquad up on 127.0.0.1:${mock.port} (rcon password "${RCON_PASSWORD}"), log at ${logPath}`);

  return {
    rconHost: '127.0.0.1',
    rconPort: mock.port,
    rconPassword: RCON_PASSWORD,
    logPath,
    stop: async () => {
      live.stop();
      await mock.stop();
    },
  };
}

// --------------------------------------------------------------------- history

// Write ~3 finished, compressed, backdated matches straight into the log file.
// The app ingests them on boot via backfill:true.
function seedHistory(mock) {
  const MATCH_MS = 45 * 60 * 1000; // each historical match "lasted" 45 min
  const GAP_MS = 20 * 60 * 1000;
  let t = Date.now() - 3 * (MATCH_MS + GAP_MS) - 10 * 60 * 1000;

  for (let m = 0; m < 3; m++) {
    const layer = ROTATION[m % ROTATION.length];
    mock.newGame(layer, null, t);
    t += 5000;

    // 18-26 players join over the first minutes
    const roster = [];
    const count = 18 + rnd(9);
    for (let i = 0; i < count; i++) {
      const teamId = (i % 2) + 1;
      const name = i === 0 ? GRIEFER : undefined;
      roster.push(mock.addPlayer({ name, teamId, role: roleFor(mock, teamId) }, t));
      t += Math.floor(between(500, 4000));
    }
    // a few squads per team
    for (const teamId of [1, 2]) {
      const members = roster.filter((p) => p.teamId === teamId);
      for (let s = 0; s < 3 && s * 4 < members.length; s++) {
        const creator = members[s * 4];
        mock.createSquad(creator, SQUAD_NAMES[(m + s) % SQUAD_NAMES.length], t);
        for (let k = 1; k < 4 && s * 4 + k < members.length; k++) {
          members[s * 4 + k].squadId = creator.squadId;
        }
        t += 1000;
      }
    }

    // compressed combat: ~70 wounds, ~25% die, ~40% of those revived, some TKs
    const kills = 60 + rnd(21);
    const step = (MATCH_MS - 8 * 60 * 1000) / kills;
    for (let k = 0; k < kills; k++) {
      t += Math.floor(step * between(0.5, 1.5));
      const attacker = pick(roster);
      const tk = Math.random() < 0.08;
      const pool = roster.filter((p) => p !== attacker && (tk ? p.teamId === attacker.teamId : p.teamId !== attacker.teamId));
      if (!pool.length) continue;
      const victim = pick(pool);
      const weapon = pick(WEAPONS);
      const dmg = between(25, 95);
      mock.damage(attacker, victim, weapon, dmg, t - 150);
      mock.wound(attacker, victim, weapon, dmg, t);
      if (Math.random() < 0.25) {
        mock.die(attacker, victim, weapon, dmg, t + 20000 + rnd(15000));
      } else if (Math.random() < 0.4) {
        const medics = roster.filter((p) => p.teamId === victim.teamId && p !== victim);
        if (medics.length) mock.revive(pick(medics), victim, t + 10000 + rnd(30000));
      }
      if (k % 15 === 7) mock.tick(between(32, 48), t);
    }

    // the designated griefer hits a friendly radio once per historical match
    const griefer = roster.find((p) => p.name === GRIEFER) || roster[0];
    for (let h = 0; h < 2; h++) {
      t += 15000;
      mock.deployableDamage(griefer, 'BP_FOBRadio_Woodland', 350, 'BP_C4_Explosive', { time: t });
    }

    t += 60 * 1000;
    mock.roundEnd(1 + rnd(2), 40 + rnd(260), t);

    // everyone leaves between matches
    for (const p of roster.slice()) {
      t += Math.floor(between(200, 1500));
      mock.removePlayer(p, t);
    }
    mock.disconnected.length = 0; // history players are long gone
    t += GAP_MS;
  }
  log.info('demo', 'seeded 3 backdated historical matches into the demo log');
}

function roleFor(mock, teamId) {
  return mock.teams[teamId].token + '_' + pick(ROLES);
}

// ------------------------------------------------------------------- scenario

function runLiveScenario(mock) {
  const timers = new Set();
  let stopped = false;

  function after(ms, fn) {
    const t = setTimeout(() => {
      timers.delete(t);
      if (stopped) return;
      try {
        fn();
      } catch (e) {
        log.warn('demo', 'scenario step failed: ' + e.message);
      }
    }, ms);
    timers.add(t);
    return t;
  }
  function every(minMs, maxMs, fn) {
    const loop = () => {
      fn();
      if (!stopped) after(between(minMs, maxMs), loop);
    };
    after(between(minMs, maxMs), loop);
  }

  // fresh match for the live scenario
  mock.newGame(ROTATION[0]);
  let rotationIdx = 0;

  // target population 36-60, pooled names (clan tags + unicode via NAME_POOL)
  const targetPop = 36 + rnd(25);
  let griefer = null;
  const join = (name) => {
    const teamId = teamNeedingPlayers(mock);
    return mock.addPlayer({ name, teamId, role: roleFor(mock, teamId) });
  };
  griefer = join(GRIEFER);
  for (let i = 1; i < targetPop; i++) join();
  makeSquads(mock);

  // kills every 3-10s with ~8% TK
  every(3000, 10000, () => {
    const players = mock.onlinePlayers();
    if (players.length < 4) return;
    const attacker = pick(players);
    const tk = Math.random() < 0.08;
    const pool = players.filter((p) => p !== attacker && (tk ? p.teamId === attacker.teamId : p.teamId !== attacker.teamId));
    if (!pool.length) return;
    const victim = pick(pool);
    const weapon = pick(WEAPONS);
    const dmg = between(25, 95);
    mock.damage(attacker, victim, weapon, dmg);
    mock.wound(attacker, victim, weapon, dmg);
    if (tk && Math.random() < 0.6) {
      after(between(1500, 5000), () => mock.chat(victim, 'all', pick(['dude??', 'TK!!', 'watch your fire', 'report ' + attacker.name])));
    }
    if (Math.random() < 0.25) {
      after(between(5000, 20000), () => mock.die(attacker, victim, weapon, dmg));
    } else if (Math.random() < 0.4) {
      after(between(5000, 25000), () => {
        const medics = mock.onlinePlayers().filter((p) => p.teamId === victim.teamId && p.eosId !== victim.eosId);
        if (medics.length && mock.players.has(victim.eosId)) mock.revive(pick(medics), victim);
      });
    }
  });

  // chat chatter every 4-12s
  every(4000, 12000, () => {
    const players = mock.onlinePlayers();
    if (!players.length) return;
    const who = pick(players);
    const channel = pick(['all', 'all', 'team', 'team', 'team', 'squad']);
    mock.chat(who, channel, pick(CHAT_LINES));
  });

  // joins/leaves every 25-70s, pop kept within 36-60
  every(25000, 70000, () => {
    const pop = mock.players.size;
    const wantLeave = pop > 58 || (pop > 36 && Math.random() < 0.5);
    if (wantLeave) {
      const leavers = mock.onlinePlayers().filter((p) => p.name !== GRIEFER);
      if (leavers.length) mock.removePlayer(pick(leavers));
    } else if (pop < 60) {
      join();
    }
  });

  // tick rate report every 30-60s
  every(30000, 60000, () => mock.tick(between(30, 50)));

  // GrieferGuy: friendly radio damage + a TK spree roughly every 10 min
  every(8 * 60 * 1000, 12 * 60 * 1000, () => {
    if (!mock.players.has(griefer.eosId)) griefer = join(GRIEFER);
    const g = mock.players.get(griefer.eosId);
    // C4 on his own team's radio, a few charges
    for (let i = 0; i < 2 + rnd(2); i++) {
      after(i * 4000, () => mock.deployableDamage(g, 'BP_FOBRadio_Woodland', 350, 'BP_C4_Explosive'));
    }
    // then a TK spree: 3-4 teammates within ~90s
    const mates = mock.onlinePlayers().filter((p) => p.teamId === g.teamId && p.eosId !== g.eosId);
    const n = Math.min(3 + rnd(2), mates.length);
    for (let i = 0; i < n; i++) {
      after(15000 + i * between(8000, 20000), () => {
        const alive = mock.onlinePlayers().filter((p) => p.teamId === g.teamId && p.eosId !== g.eosId);
        if (alive.length && mock.players.has(g.eosId)) {
          mock.wound(g, pick(alive), 'BP_M4_Carbine', between(60, 100));
        }
      });
    }
    after(60000, () => mock.chat(g, 'all', pick(['oops', 'lol', 'my bad :)', 'free ammo at the radio'])));
  });

  // match rotation every ~8 min across the 4-layer rotation
  every(7 * 60 * 1000, 9 * 60 * 1000, () => {
    mock.roundEnd(1 + rnd(2), 30 + rnd(270));
    after(8000, () => {
      rotationIdx = (rotationIdx + 1) % ROTATION.length;
      mock.newGame(ROTATION[rotationIdx]);
      makeSquads(mock);
    });
  });

  return {
    stop() {
      stopped = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}

function teamNeedingPlayers(mock) {
  let t1 = 0;
  let t2 = 0;
  for (const p of mock.players.values()) (p.teamId === 1 ? t1++ : t2++);
  if (t1 === t2) return 1 + rnd(2);
  return t1 < t2 ? 1 : 2;
}

function makeSquads(mock) {
  for (const teamId of [1, 2]) {
    const members = mock.onlinePlayers().filter((p) => p.teamId === teamId && p.squadId == null);
    const squadCount = Math.min(4 + rnd(5), Math.floor(members.length / 3));
    let i = 0;
    for (let s = 0; s < squadCount; s++) {
      const creator = members[i++];
      if (!creator) break;
      const sq = mock.createSquad(creator, SQUAD_NAMES[s % SQUAD_NAMES.length]);
      const size = 2 + rnd(7); // + creator -> up to 9
      for (let k = 0; k < size && i < members.length; k++) {
        members[i++].squadId = sq.squadId;
      }
    }
    // the rest stay unassigned
  }
}

module.exports = { startDemo };
