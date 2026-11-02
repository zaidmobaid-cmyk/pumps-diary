'use strict';
// test/parser.test.js — §17: every fixture line parses to the exact expected
// object (deep equal); noise lines → null; name edge cases; id scanner
// tolerance; list-response parsing; every §6.3 chat-packet kind; factions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const parser = require('../server/parser');
const factions = require('../server/factions');

const FIXTURE_COUNT = 14; // §6.2 fixture lines, in order; everything after is noise

const lines = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.log'), 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.length > 0);

const T = (h, mi, s, ms) => Date.UTC(2026, 2, 1, h, mi, s, ms);

const EOS_A = '0002a10386d9114496bce8b6ded68587';
const STEAM_A = '76561198012345678';
const EOS_B = '0002b4c5d6e7f8091a2b3c4d5e6f7081';
const STEAM_B = '76561198087654321';
const EOS_C = '0002c0ffee00000000000000000000aa';
const STEAM_C = '76561198011112222';
const EOS_D = '0002deadbeef0000111122223333aaaa';
const STEAM_D = '76561198099998888';

// Raw ids blobs exactly as the §6.1 regexes capture them (spaces preserved).
const IDS_B_MID = ` EOS: ${EOS_B} steam: ${STEAM_B} `; // mid-line, cut at " | "
const IDS_B_END = ` EOS: ${EOS_B} steam: ${STEAM_B}`;  // cut at ")"
const IDS_A_END = ` EOS: ${EOS_A} steam: ${STEAM_A}`;
const IDS_C_END = ` EOS: ${EOS_C} steam: ${STEAM_C}`;

test('fixture file has the 14 spec lines plus at least 10 noise lines', () => {
  assert.ok(lines.length >= FIXTURE_COUNT + 10, `expected >= ${FIXTURE_COUNT + 10} lines, got ${lines.length}`);
});

test('every §6.2 fixture line parses to its exact expected object', () => {
  const expected = [
    {
      event: 'PLAYER_CONNECTED', time: T(21, 50, 52, 123), raw: lines[0],
      controller: 'BP_PlayerController_C_2147254377', ip: '86.142.11.23',
      eosId: EOS_A, steamId: STEAM_A,
    },
    {
      event: 'JOIN_SUCCEEDED', time: T(21, 51, 1, 4), raw: lines[1],
      suffixName: 'Wardex',
    },
    {
      event: 'PLAYER_DAMAGED', time: T(21, 55, 13, 901), raw: lines[2],
      victimName: 'Wardex', damage: 38.25, attackerName: 'BobTheBuilder',
      attackerIds: IDS_B_MID, attackerController: 'BP_PlayerController_C_2147254111',
      weapon: 'BP_SVDM_Optic',
    },
    {
      event: 'PLAYER_WOUNDED', time: T(21, 55, 14, 120), raw: lines[3],
      victimName: 'Wardex', damage: 38.25,
      attackerController0: 'BP_PlayerController_C_2147254111',
      attackerIds: IDS_B_MID, attackerController: 'BP_PlayerController_C_2147254111',
      weapon: 'BP_SVDM_Optic',
    },
    {
      event: 'PLAYER_DIED', time: T(21, 56, 20, 338), raw: lines[4],
      victimName: 'Wardex', damage: 38.25,
      attackerController0: 'BP_PlayerController_C_2147254111',
      attackerIds: IDS_B_MID, attackerController: 'BP_PlayerController_C_2147254111',
      weapon: 'BP_SVDM_Optic',
    },
    {
      event: 'PLAYER_REVIVED', time: T(21, 57, 5, 10), raw: lines[5],
      reviverName: 'BobTheBuilder', reviverIds: IDS_B_END,
      revivedName: 'Wardex', revivedIds: IDS_A_END,
    },
    {
      event: 'DEPLOYABLE_DAMAGED', time: T(21, 58, 0, 555), raw: lines[6],
      deployable: 'BP_FOBRadio_Woodland', damage: 350, weapon: 'BP_C4_Explosive',
      playerName: 'GrieferGuy', damageType: 'BP_C4_DamageType', healthRemaining: 1650,
    },
    {
      event: 'NEW_GAME', time: T(22, 1, 11, 0), raw: lines[7],
      dlc: 'Game',
      pathParts: 'Maps/Yehorivka/Gameplay_Layers/Yehorivka_RAAS_v1.Yehorivka_RAAS_v1',
      level: 'Yehorivka', layerClass: 'Yehorivka_RAAS_v1',
    },
    {
      event: 'MATCH_STATE', time: T(22, 1, 30, 0), raw: lines[8],
      from: 'WaitingToStart', to: 'InProgress',
    },
    {
      event: 'ROUND_ENDED', time: T(22, 44, 10, 222), raw: lines[9],
      team: 2, factionName: 'Manticore Security Task Force', factionTag: 'WPMC',
      result: 'won', tickets: 184, layer: 'Yehorivka RAAS v1', level: 'Yehorivka',
    },
    {
      event: 'TICK_RATE', time: T(22, 45, 0, 1), raw: lines[10],
      tickRate: 38.45,
    },
    {
      event: 'PLAYER_DISCONNECTED', time: T(22, 46, 0, 0), raw: lines[11],
      eosId: EOS_A,
    },
    {
      event: 'SQUAD_CREATED', time: T(22, 47, 0, 0), raw: lines[12],
      playerName: 'GoodGuy', ids: IDS_C_END, squadId: 3, squadName: 'ARMOR',
      teamName: 'Team Manticore Security Task Force',
    },
    {
      event: 'ADMIN_BROADCAST_LOG', time: T(22, 48, 0, 0), raw: lines[13],
      message: 'Welcome to the server', from: 'RCON',
    },
  ];
  assert.equal(expected.length, FIXTURE_COUNT);
  for (let i = 0; i < FIXTURE_COUNT; i++) {
    assert.deepEqual(parser.parseLogLine(lines[i]), expected[i], `fixture line ${i + 1}`);
  }
});

test('noise lines parse to null', () => {
  const noise = lines.slice(FIXTURE_COUNT);
  assert.ok(noise.length >= 10, `expected >= 10 noise lines, got ${noise.length}`);
  for (const l of noise) {
    assert.equal(parser.parseLogLine(l), null, `expected null for: ${l}`);
  }
});

test('parseLogLine rejects garbage and malformed stamps', () => {
  assert.equal(parser.parseLogLine(''), null);
  assert.equal(parser.parseLogLine('not a log line'), null);
  assert.equal(parser.parseLogLine('[bad stamp][1]LogNet: Join succeeded: X'), null);
  assert.equal(parser.parseLogLine(null), null);
  assert.equal(parser.parseLogLine(undefined), null);
});

test('parseLogTime treats stamp as UTC and applies tz offset (server clock ahead of UTC)', () => {
  const base = parser.parseLogTime('2026.03.01-21.50.52:123', 0);
  assert.equal(base, Date.UTC(2026, 2, 1, 21, 50, 52, 123));
  assert.equal(parser.parseLogTime('2026.03.01-21.50.52:123', 60), base - 3600000);
  assert.equal(parser.parseLogTime('2026.03.01-21.50.52:123', -30), base + 1800000);
  assert.equal(parser.parseLogTime('2026.03.01-21.50.52:004'), Date.UTC(2026, 2, 1, 21, 50, 52, 4));
  assert.equal(parser.parseLogTime('garbage'), null);
  assert.equal(parser.parseLogTime(''), null);
  // parseLogLine passes its optional tz offset through
  const shifted = parser.parseLogLine(lines[1], 60);
  assert.equal(shifted.time, T(21, 51, 1, 4) - 3600000);
});

test('parseOnlineIds tolerance: both / EOS-only / steam-only / either order / = framing', () => {
  assert.deepEqual(parser.parseOnlineIds(`EOS: ${EOS_A} steam: ${STEAM_A}`),
    { eosId: EOS_A, steamId: STEAM_A });
  assert.deepEqual(parser.parseOnlineIds(`steam: ${STEAM_A} EOS: ${EOS_A}`),
    { eosId: EOS_A, steamId: STEAM_A });
  assert.deepEqual(parser.parseOnlineIds(`EOS: ${EOS_A}`), { eosId: EOS_A, steamId: null });
  assert.deepEqual(parser.parseOnlineIds(`steam: ${STEAM_A}`), { eosId: null, steamId: STEAM_A });
  // lowercase key + no space after colon
  assert.deepEqual(parser.parseOnlineIds(`eos:${EOS_B} STEAM: ${STEAM_B}`),
    { eosId: EOS_B, steamId: STEAM_B });
  // the KICKED/BANNED "Online IDs=" framing still scans
  assert.deepEqual(parser.parseOnlineIds(`[Online IDs= EOS: ${EOS_C} steam: ${STEAM_C}]`),
    { eosId: EOS_C, steamId: STEAM_C });
  // garbage / wrong-length values are not ids
  assert.deepEqual(parser.parseOnlineIds('INVALID'), { eosId: null, steamId: null });
  assert.deepEqual(parser.parseOnlineIds('steam: 1234567890123456'), { eosId: null, steamId: null });
  assert.deepEqual(parser.parseOnlineIds(''), { eosId: null, steamId: null });
  assert.deepEqual(parser.parseOnlineIds(null), { eosId: null, steamId: null });
});

test('names containing parentheses, pipes and " : " survive log-line parsing', () => {
  // PLAYER_DAMAGED: victim and attacker are display names
  const dmg = parser.parseLogLine(
    `[2026.03.01-21.55.13:901][771]LogSquad: Player:We|rd (vic) : name ActualDamage=10.500000 from [TAG] Bob (the|guy) (Online IDs: EOS: ${EOS_B} steam: ${STEAM_B} | Player Controller ID: BP_PlayerController_C_1)caused by BP_AK74_C`
  );
  assert.deepEqual(dmg, {
    event: 'PLAYER_DAMAGED', time: T(21, 55, 13, 901),
    raw: `[2026.03.01-21.55.13:901][771]LogSquad: Player:We|rd (vic) : name ActualDamage=10.500000 from [TAG] Bob (the|guy) (Online IDs: EOS: ${EOS_B} steam: ${STEAM_B} | Player Controller ID: BP_PlayerController_C_1)caused by BP_AK74_C`,
    victimName: 'We|rd (vic) : name', damage: 10.5, attackerName: '[TAG] Bob (the|guy)',
    attackerIds: IDS_B_MID, attackerController: 'BP_PlayerController_C_1', weapon: 'BP_AK74',
  });

  // PLAYER_WOUNDED: victim name with pipes/parens; negative KillingDamage; nullptr attacker
  const wnd = parser.parseLogLine(
    `[2026.03.01-21.55.14:120][772]LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:A|B (c) : d KillingDamage=-300.000000 from nullptr (Online IDs: INVALID | Controller ID: None) caused by BP_Soldier_C`
  );
  assert.equal(wnd.event, 'PLAYER_WOUNDED');
  assert.equal(wnd.victimName, 'A|B (c) : d');
  assert.equal(wnd.damage, 300);
  assert.equal(wnd.attackerController0, 'nullptr');
  assert.equal(wnd.attackerIds, ' INVALID ');
  assert.equal(wnd.attackerController, 'None');
  assert.equal(wnd.weapon, 'BP_Soldier');

  // PLAYER_REVIVED: both names carry parens/pipes; split at the LAST " (Online IDs:"
  const rev = parser.parseLogLine(
    `[2026.03.01-21.57.05:010][850]LogSquad: [1st] Bob (BOSS) (Online IDs: EOS: ${EOS_B} steam: ${STEAM_B}) has revived A|ice (:D (Online IDs: EOS: ${EOS_A} steam: ${STEAM_A}).`
  );
  assert.equal(rev.event, 'PLAYER_REVIVED');
  assert.equal(rev.reviverName, '[1st] Bob (BOSS)');
  assert.equal(rev.reviverIds, IDS_B_END);
  assert.equal(rev.revivedName, 'A|ice (:D');
  assert.equal(rev.revivedIds, IDS_A_END);

  // SQUAD_CREATED log line: squad name with parens, player name with pipe
  const sq = parser.parseLogLine(
    `[2026.03.01-22.47.00:000][970]LogSquad: A|B (c) (Online IDs: EOS: ${EOS_C} steam: ${STEAM_C}) has created Squad 11 (Squad Name: HELI (RU) crew) on Team 1`
  );
  assert.equal(sq.event, 'SQUAD_CREATED');
  assert.equal(sq.playerName, 'A|B (c)');
  assert.equal(sq.squadId, 11);
  assert.equal(sq.squadName, 'HELI (RU) crew');
  assert.equal(sq.teamName, 'Team 1');
});

test('parseChatPacket CHAT: channels, FIRST " : " split, names with pipes/parens/brackets', () => {
  const p = parser.parseChatPacket(
    `[ChatAll] [Online IDs:EOS: ${EOS_A} steam: ${STEAM_A}] [DOG] Rex (a|b) : gg : wp : all`
  );
  assert.deepEqual(p, {
    kind: 'CHAT', channel: 'all', eosId: EOS_A, steamId: STEAM_A,
    name: '[DOG] Rex (a|b)', message: 'gg : wp : all',
  });
  assert.equal(parser.parseChatPacket(
    `[ChatTeam] [Online IDs:EOS: ${EOS_B} steam: ${STEAM_B}] Bob : push b`).channel, 'team');
  assert.equal(parser.parseChatPacket(
    `[ChatSquad] [Online IDs:EOS: ${EOS_B} steam: ${STEAM_B}] Bob : rally down`).channel, 'squad');
  assert.equal(parser.parseChatPacket(
    `[ChatAdmin] [Online IDs:EOS: ${EOS_B} steam: ${STEAM_B}] Bob : watch cam`).channel, 'admin');
  // EOS-only ids blob
  const solo = parser.parseChatPacket(`[ChatTeam] [Online IDs:EOS: ${EOS_A}] Solo : hi`);
  assert.deepEqual(solo, {
    kind: 'CHAT', channel: 'team', eosId: EOS_A, steamId: null, name: 'Solo', message: 'hi',
  });
  // no " : " separator → not a chat packet
  assert.equal(parser.parseChatPacket(`[ChatAll] [Online IDs:EOS: ${EOS_A}] Bob hello`), null);
});

test('parseChatPacket ADMIN_CAM (Online Ids casing), possessed and unpossessed', () => {
  const on = parser.parseChatPacket(
    `[Online Ids:EOS: ${EOS_A} steam: ${STEAM_A}] AdminGuy has possessed admin camera.`
  );
  assert.deepEqual(on, {
    kind: 'ADMIN_CAM', eosId: EOS_A, steamId: STEAM_A, name: 'AdminGuy', possessed: true,
  });
  const off = parser.parseChatPacket(
    `[Online Ids:EOS: ${EOS_A} steam: ${STEAM_A}] AdminGuy has unpossessed admin camera.`
  );
  assert.deepEqual(off, {
    kind: 'ADMIN_CAM', eosId: EOS_A, steamId: STEAM_A, name: 'AdminGuy', possessed: false,
  });
});

test('parseChatPacket WARNED', () => {
  const w = parser.parseChatPacket(
    'Remote admin has warned player [DOG] Rex. Message was "stop teamkilling"'
  );
  assert.deepEqual(w, { kind: 'WARNED', name: '[DOG] Rex', message: 'stop teamkilling' });
});

test('parseChatPacket KICKED/BANNED with the "Online IDs=" equals-sign quirk', () => {
  const k = parser.parseChatPacket(
    `Kicked player 7. [Online IDs= EOS: ${EOS_B} steam: ${STEAM_B}] [DOG] Rex | the (3rd)`
  );
  assert.deepEqual(k, {
    kind: 'KICKED', playerId: 7, eosId: EOS_B, steamId: STEAM_B, name: '[DOG] Rex | the (3rd)',
  });
  const b = parser.parseChatPacket(
    `Banned player 12. [Online IDs= EOS: ${EOS_C} steam: ${STEAM_C}] GrieferGuy for interval 1d`
  );
  assert.deepEqual(b, {
    kind: 'BANNED', playerId: 12, eosId: EOS_C, steamId: STEAM_C, name: 'GrieferGuy', interval: '1d',
  });
  const perm = parser.parseChatPacket(
    `Banned player 3. [Online IDs= EOS: ${EOS_C} steam: ${STEAM_C}] Bad Guy for interval 0`
  );
  assert.equal(perm.interval, '0');
});

test('parseChatPacket SQUAD_CREATED packet form has NO LogSquad: prefix (§19.1.11)', () => {
  const p = parser.parseChatPacket(
    `GoodGuy (Online IDs: EOS: ${EOS_C} steam: ${STEAM_C}) has created Squad 3 (Squad Name: ARMOR) on Team Manticore Security Task Force`
  );
  assert.deepEqual(p, {
    kind: 'SQUAD_CREATED', playerName: 'GoodGuy', ids: IDS_C_END, squadId: 3,
    squadName: 'ARMOR', teamName: 'Team Manticore Security Task Force',
  });
  // squad names keep pipes/parens; split happens at the LAST ") on "
  const fancy = parser.parseChatPacket(
    `A|B (c) (Online IDs: EOS: ${EOS_C} steam: ${STEAM_C}) has created Squad 11 (Squad Name: HELI (RU) crew) on Team 1`
  );
  assert.equal(fancy.playerName, 'A|B (c)');
  assert.equal(fancy.squadName, 'HELI (RU) crew');
  assert.equal(fancy.teamName, 'Team 1');
});

test('parseChatPacket rejects unrelated bodies', () => {
  assert.equal(parser.parseChatPacket(''), null);
  assert.equal(parser.parseChatPacket(null), null);
  assert.equal(parser.parseChatPacket('Some random RCON noise'), null);
});

test('parseListPlayers: active + disconnected sections, Squad ID: N/A, names with " | "', () => {
  const text = [
    '----- Active Players -----',
    `ID: 7 | Online IDs: EOS: ${EOS_A} steam: ${STEAM_A} | Name: Wardex | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01`,
    `ID: 12 | Online IDs: EOS: ${EOS_B} steam: ${STEAM_B} | Name: Krazy | Watcher (EU) | Team ID: 2 | Squad ID: N/A | Is Leader: False | Role: WPMC_Recruit_01`,
    '----- Recently Disconnected Players [Max of 15] -----',
    `ID: 3 | Online IDs: EOS: ${EOS_D} steam: ${STEAM_D} | Since Disconnect: 01m.30s | Name: Gone | Guy`,
  ].join('\n');
  assert.deepEqual(parser.parseListPlayers(text), {
    online: [
      {
        playerId: 7, eosId: EOS_A, steamId: STEAM_A, name: 'Wardex',
        teamId: 1, squadId: 2, isLeader: true, role: 'USA_Rifleman_01',
      },
      {
        playerId: 12, eosId: EOS_B, steamId: STEAM_B, name: 'Krazy | Watcher (EU)',
        teamId: 2, squadId: null, isLeader: false, role: 'WPMC_Recruit_01',
      },
    ],
    disconnected: [
      {
        playerId: 3, eosId: EOS_D, steamId: STEAM_D, name: 'Gone | Guy',
        sinceDisconnect: '01m.30s',
      },
    ],
  });
  assert.deepEqual(parser.parseListPlayers(''), { online: [], disconnected: [] });
  assert.deepEqual(parser.parseListPlayers('----- Active Players -----\n'), { online: [], disconnected: [] });
});

test('parseListSquads: team headers, locked/size types, names with " | "', () => {
  const text = [
    '----- Active Squads -----',
    'Team ID: 1 (United States Army)',
    `ID: 1 | Name: CMD Squad | Size: 9 | Locked: False | Creator Name: Wardex | Creator Online IDs: EOS: ${EOS_A} steam: ${STEAM_A}`,
    `ID: 2 | Name: ARMOR | HEAVY | Size: 4 | Locked: True | Creator Name: Krazy | Watcher | Creator Online IDs: EOS: ${EOS_B} steam: ${STEAM_B}`,
    'Team ID: 2 (Manticore Security Task Force)',
    `ID: 1 | Name: INF | Size: 6 | Locked: False | Creator Name: GoodGuy | Creator Online IDs: EOS: ${EOS_C} steam: ${STEAM_C}`,
  ].join('\n');
  assert.deepEqual(parser.parseListSquads(text), [
    {
      teamId: 1, teamName: 'United States Army', squadId: 1, name: 'CMD Squad', size: 9,
      locked: false, creatorName: 'Wardex', creatorEos: EOS_A, creatorSteam: STEAM_A,
    },
    {
      teamId: 1, teamName: 'United States Army', squadId: 2, name: 'ARMOR | HEAVY', size: 4,
      locked: true, creatorName: 'Krazy | Watcher', creatorEos: EOS_B, creatorSteam: STEAM_B,
    },
    {
      teamId: 2, teamName: 'Manticore Security Task Force', squadId: 1, name: 'INF', size: 6,
      locked: false, creatorName: 'GoodGuy', creatorEos: EOS_C, creatorSteam: STEAM_C,
    },
  ]);
  assert.deepEqual(parser.parseListSquads(''), []);
});

test('parseServerInfo: full object, coerced numbers, matchTimeout (§19.1.9)', () => {
  const info = parser.parseServerInfo(JSON.stringify({
    ServerName_s: 'My Squad Server', MaxPlayers: 100, PlayerCount_I: '77',
    PublicQueue_I: '3', ReservedQueue_I: '0', MapName_s: 'Yehorivka',
    GameMode_s: 'RAAS', GameVersion_s: 'v8.2.1', TeamOne_s: 'USA_S_CombinedArms',
    TeamTwo_s: 'RGF_S_CombinedArms', NextLayer_s: 'Gorodok RAAS v1',
    MATCHTIMEOUT_d: 120.5, PLAYTIME_I: '1234',
  }));
  assert.deepEqual(info, {
    serverName: 'My Squad Server', maxPlayers: 100, playerCount: 77,
    publicQueue: 3, reservedQueue: 0, mapName: 'Yehorivka', gameMode: 'RAAS',
    gameVersion: 'v8.2.1', teamOne: 'USA_S_CombinedArms', teamTwo: 'RGF_S_CombinedArms',
    nextLayer: 'Gorodok RAAS v1', matchTimeout: 120.5, playTimeSec: 1234,
  });
});

test('parseServerInfo tolerates missing keys (nulls) and rejects bad JSON', () => {
  assert.deepEqual(parser.parseServerInfo('{}'), {
    serverName: null, maxPlayers: null, playerCount: null, publicQueue: null,
    reservedQueue: null, mapName: null, gameMode: null, gameVersion: null,
    teamOne: null, teamTwo: null, nextLayer: null, matchTimeout: null, playTimeSec: null,
  });
  const partial = parser.parseServerInfo('{"ServerName_s":"X","PlayerCount_I":5}');
  assert.equal(partial.serverName, 'X');
  assert.equal(partial.playerCount, 5);
  assert.equal(partial.maxPlayers, null);
  assert.equal(parser.parseServerInfo('not json'), null);
  assert.equal(parser.parseServerInfo('[1,2]'), null);
  assert.equal(parser.parseServerInfo('null'), null);
});

test('parseLayers skips the header line, trims, drops empties, strips " (mod)" suffixes', () => {
  const out = parser.parseLayers(
    'List of available layers :\nAlbasrah_AAS_v1\n  Belaya_RAAS_v1 (CAF Mod)  \n\nYehorivka_RAAS_v1\n'
  );
  assert.deepEqual(out, ['Albasrah_AAS_v1', 'Belaya_RAAS_v1', 'Yehorivka_RAAS_v1']);
  assert.deepEqual(parser.parseLayers('List of available layers :'), []);
});

test('parseCurrentMap / parseNextMap incl. "To be voted" and empty values', () => {
  assert.deepEqual(parser.parseCurrentMap('Current level is Yehorivka, layer is Yehorivka RAAS v1'),
    { level: 'Yehorivka', layer: 'Yehorivka RAAS v1', team1: null, team2: null });
  assert.deepEqual(parser.parseNextMap('Next level is Gorodok, layer is Gorodok RAAS v1'),
    { level: 'Gorodok', layer: 'Gorodok RAAS v1', team1: null, team2: null });
  assert.deepEqual(parser.parseNextMap('Next level is To be voted, layer is To be voted'),
    { level: null, layer: null, team1: null, team2: null });
  assert.deepEqual(parser.parseNextMap('Next level is , layer is '),
    { level: null, layer: null, team1: null, team2: null });
  assert.equal(parser.parseCurrentMap('Next level is X, layer is Y'), null);
  assert.equal(parser.parseCurrentMap('garbage'), null);
});

// ---------------------------------------------------------------------------
// factions.js (§8)
// ---------------------------------------------------------------------------

test('classifyDeployable: radio / hab / other categories and labels', () => {
  assert.deepEqual(factions.classifyDeployable('BP_FOBRadio_Woodland'), {
    category: 'radio', factionToken: null, label: 'FOB Radio Woodland',
  });
  // full UE instance suffix is stripped before classification
  assert.deepEqual(factions.classifyDeployable('BP_FOBRadio_Woodland_C_2146067116'), {
    category: 'radio', factionToken: null, label: 'FOB Radio Woodland',
  });
  assert.deepEqual(factions.classifyDeployable('BP_Hab_RUS'), {
    category: 'hab', factionToken: 'RUS', label: 'Hab RUS',
  });
  assert.equal(factions.classifyDeployable('BP_FOBRadio_MEA').factionToken, 'MEA');
  assert.equal(factions.classifyDeployable('BP_FOBRadio_MEA').category, 'radio');
  assert.equal(factions.classifyDeployable('BP_HideoutHab_INS').category, 'hab');
  assert.equal(factions.classifyDeployable('BP_HideoutHab_INS').factionToken, 'INS');
  // ammo crate: other, no faction
  assert.deepEqual(factions.classifyDeployable('BP_AmmoCrate'), {
    category: 'other', factionToken: null, label: 'Ammo Crate',
  });
  assert.equal(factions.classifyDeployable('BP_AmmoCrate_USA').factionToken, 'USA');
  assert.equal(factions.classifyDeployable('BP_AmmoCrate_USA').category, 'other');
  // Desert skin is generic, not a faction
  assert.equal(factions.classifyDeployable('BP_FOBRadio_Desert').factionToken, null);
  assert.equal(factions.classifyDeployable('').category, 'other');
});

test('teamFactionTokens: leading token + alias map (RUS→RGF, US→USA, GB→BAF)', () => {
  assert.deepEqual(factions.teamFactionTokens('USA_S_CombinedArms'), ['USA', 'US']);
  assert.deepEqual(factions.teamFactionTokens('RGF_S_CombinedArms'), ['RGF', 'RUS']);
  assert.deepEqual(factions.teamFactionTokens('RUS_S_CombinedArms'), ['RGF', 'RUS']);
  assert.deepEqual(factions.teamFactionTokens('GB_S_Armored'), ['BAF', 'GB']);
  assert.deepEqual(factions.teamFactionTokens('WPMC_LO_LightInfantry'), ['WPMC']);
  assert.deepEqual(factions.teamFactionTokens(''), []);
  assert.deepEqual(factions.teamFactionTokens(null), []);
});

test('resolveFriendly: 1 friendly / 0 enemy / -1 unknown', () => {
  const match = { team1: 'WPMC_S_CombinedArms', team2: 'RGF_S_CombinedArms' };

  // BP_FOBRadio_Woodland → no faction token → unknown regardless of team
  const woodland = factions.classifyDeployable('BP_FOBRadio_Woodland');
  assert.equal(factions.resolveFriendly(woodland.factionToken, 1, match), -1);
  assert.equal(factions.resolveFriendly(woodland.factionToken, 2, match), -1);

  // BP_Hab_RUS: RUS normalizes to RGF → friendly for team 2, enemy for team 1
  const rusHab = factions.classifyDeployable('BP_Hab_RUS');
  assert.equal(factions.resolveFriendly(rusHab.factionToken, 2, match), 1);
  assert.equal(factions.resolveFriendly(rusHab.factionToken, 1, match), 0);

  // token matching neither team → unknown
  assert.equal(factions.resolveFriendly('MEA', 1, match), -1);
  // alias on the team side too: US_… team vs USA deployable
  const m2 = { team1: 'US_S_CombinedArms', team2: 'RGF_S_CombinedArms' };
  assert.equal(factions.resolveFriendly('USA', 1, m2), 1);
  assert.equal(factions.resolveFriendly('USA', 2, m2), 0);
  // missing/invalid inputs → unknown
  assert.equal(factions.resolveFriendly(null, 1, match), -1);
  assert.equal(factions.resolveFriendly('RGF', 3, match), -1);
  assert.equal(factions.resolveFriendly('RGF', null, match), -1);
  assert.equal(factions.resolveFriendly('RGF', 1, null), -1);
  assert.equal(factions.resolveFriendly('RGF', 1, {}), -1);
});
