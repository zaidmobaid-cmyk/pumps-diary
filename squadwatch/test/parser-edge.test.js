'use strict';
// test/parser-edge.test.js — parser robustness fuzz (hostile-but-realistic input).
//
// Hard property, checked on every call in this file:
//   parseLogLine / parseChatPacket NEVER throw, and either return null or a
//   well-formed object: `time` is a finite number when present, every
//   name-carrying field (name, *Name, from, suffixName, …) is a string.
//
// Covered input classes: names with double quotes / pipes / " : " /
// "(Online IDs:" / RTL / CJK / emoji / 64+ chars; every §6.3 chat-packet kind
// with those names; ListPlayers rows whose names embed " | Team ID: "-like
// marker text (including DISCONNECTED rows); wound/die attacker-id blobs with
// EOS only / steam only / swapped order; unusual deployable class names;
// truncated lines at every code-unit and byte offset; 70KB single lines under
// a 5s watchdog; year-boundary timestamps with tzOffset minutes; and
// parseInterval / parseLayers junk. A seeded mutation fuzzer sweeps the rest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const parser = require('../server/parser');
const { parseInterval } = require('../server/util');

const PARSER_PATH = require.resolve('../server/parser');

// ---------------------------------------------------------------------------
// Property harness
// ---------------------------------------------------------------------------
const NAMEY_KEY_RE = /(^|[a-z0-9])name$/i; // name, victimName, squadName, suffixName, …

function short(s) {
  s = String(s);
  return s.length > 180 ? `${s.slice(0, 180)}…(${s.length} chars)` : s;
}

function assertWellFormed(r, input, fnName) {
  if (r === null) return r;
  assert.equal(typeof r, 'object', `${fnName}: non-object non-null result for: ${short(input)}`);
  assert.ok(!Array.isArray(r), `${fnName}: array result for: ${short(input)}`);
  if ('time' in r) {
    assert.ok(Number.isFinite(r.time), `${fnName}: time=${r.time} not finite for: ${short(input)}`);
  }
  if ('event' in r) assert.equal(typeof r.event, 'string', `${fnName}: event not a string`);
  if ('kind' in r) assert.equal(typeof r.kind, 'string', `${fnName}: kind not a string`);
  for (const k of Object.keys(r)) {
    if (NAMEY_KEY_RE.test(k) || k === 'from' || k === 'suffixName') {
      assert.equal(typeof r[k], 'string',
        `${fnName}: ${k}=${String(r[k])} not a string for: ${short(input)}`);
    }
  }
  return r;
}

function logLine(line, tz) {
  let r;
  try {
    r = parser.parseLogLine(line, tz);
  } catch (e) {
    assert.fail(`parseLogLine THREW (${e.message}) for: ${short(line)}`);
  }
  return assertWellFormed(r, line, 'parseLogLine');
}

function chatPacket(body) {
  let r;
  try {
    r = parser.parseChatPacket(body);
  } catch (e) {
    assert.fail(`parseChatPacket THREW (${e.message}) for: ${short(body)}`);
  }
  return assertWellFormed(r, body, 'parseChatPacket');
}

function noThrow(fnName, fn, input) {
  try {
    return fn(input);
  } catch (e) {
    return assert.fail(`${fnName} THREW (${e.message}) for: ${short(input)}`);
  }
}

// ---------------------------------------------------------------------------
// Shared hostile material
// ---------------------------------------------------------------------------
const STAMP = '[2026.03.01-21.55.14:120][772]';
const T0 = Date.UTC(2026, 2, 1, 21, 55, 14, 120);

const EOS = '0002b4c5d6e7f8091a2b3c4d5e6f7081';
const STEAM = '76561198087654321';
const EOS2 = '0002a10386d9114496bce8b6ded68587';
const STEAM2 = '76561198012345678';
const IDS_MID = ` EOS: ${EOS} steam: ${STEAM} `; // as the §6.1 regexes capture it, cut at " | "
const IDS_END = ` EOS: ${EOS} steam: ${STEAM}`;  // cut at ")"
const IDS2_END = ` EOS: ${EOS2} steam: ${STEAM2}`;

const LONG_NAME = 'LongNameGuy_' + 'x'.repeat(70); // 82 chars, > 64
const COLONY = 'Colon : Name : x'; // contains the chat " : " separator
const HOSTILE_NAMES = [
  'Quote "The" Guy"',                                   // double quotes
  'Pipe|Man |x| y',                                     // pipes
  'Troll (Online IDs: EOS: deadbeef)',                  // fake id anchor inside the name
  'شاهد‏ المراقب', // Arabic + RLM (RTL)
  '黑暗王者玩家',               // CJK
  'Emoji \u{1F40D}\u{1F3AE}\u{1F5E1} Guy',              // astral plane / surrogate pairs
  LONG_NAME,                                            // 64+ chars
  '[TAG] M. "The | Knife" \u{1F5E1} (Online IDs: fake) ' + 'ё'.repeat(40), // kitchen sink
];
const LOG_NAMES = HOSTILE_NAMES.concat([COLONY]); // " : " is only ambiguous in CHAT bodies

const FIXTURE_LINES = fs.readFileSync(path.join(__dirname, 'fixtures', 'sample.log'), 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.length > 0);

// ---------------------------------------------------------------------------
// 1. Hostile names through every name-bearing log event
// ---------------------------------------------------------------------------
test('log lines: hostile names (quotes/pipes/" : "/fake-id/RTL/CJK/emoji/64+) survive every name-bearing event', () => {
  for (const name of LOG_NAMES) {
    // JOIN_SUCCEEDED — name is terminal
    const join = logLine(`${STAMP}LogNet: Join succeeded: ${name}`);
    assert.equal(join.event, 'JOIN_SUCCEEDED', name);
    assert.equal(join.suffixName, name);

    // PLAYER_DAMAGED — hostile victim AND attacker; split on the LAST " (Online IDs:"
    const dmg = logLine(`${STAMP}LogSquad: Player:${name} ActualDamage=12.500000 from ${name} (Online IDs:${IDS_MID}| Player Controller ID: BP_PlayerController_C_1)caused by BP_AK74_C`);
    assert.equal(dmg.event, 'PLAYER_DAMAGED', name);
    assert.equal(dmg.victimName, name);
    assert.equal(dmg.attackerName, name);
    assert.equal(dmg.attackerIds, IDS_MID);
    assert.equal(dmg.weapon, 'BP_AK74');

    // PLAYER_WOUNDED / PLAYER_DIED — hostile victim
    for (const verb of ['Wound', 'Die']) {
      const w = logLine(`${STAMP}LogSquadTrace: [DedicatedServer]ASQSoldier::${verb}(): Player:${name} KillingDamage=-38.250000 from BP_PlayerController_C_9 (Online IDs:${IDS_MID}| Controller ID: BP_PlayerController_C_9) caused by BP_SVDM_Optic_C`);
      assert.equal(w.event, verb === 'Wound' ? 'PLAYER_WOUNDED' : 'PLAYER_DIED', name);
      assert.equal(w.victimName, name);
      assert.equal(w.damage, 38.25);
      assert.equal(w.weapon, 'BP_SVDM_Optic');
    }

    // PLAYER_REVIVED — hostile on both sides
    const rev = logLine(`${STAMP}LogSquad: ${name} (Online IDs:${IDS_END}) has revived ${name} (Online IDs:${IDS2_END}).`);
    assert.equal(rev.event, 'PLAYER_REVIVED', name);
    assert.equal(rev.reviverName, name);
    assert.equal(rev.revivedName, name);
    assert.equal(rev.reviverIds, IDS_END);
    assert.equal(rev.revivedIds, IDS2_END);

    // SQUAD_CREATED — hostile player name AND squad name
    const sq = logLine(`${STAMP}LogSquad: ${name} (Online IDs:${IDS_END}) has created Squad 42 (Squad Name: ${name}) on Team 2`);
    assert.equal(sq.event, 'SQUAD_CREATED', name);
    assert.equal(sq.playerName, name);
    assert.equal(sq.squadName, name);
    assert.equal(sq.squadId, 42);
    assert.equal(sq.teamName, 'Team 2');

    // DEPLOYABLE_DAMAGED — hostile instigator
    const dep = logLine(`${STAMP}LogSquadTrace: [DedicatedServer]ASQDeployable::TakeDamage(): BP_FOBRadio_Woodland_C_2146067116: 350.000000 damage attempt by causer BP_C4_Explosive_C_2146001122 instigator ${name} with damage type BP_C4_DamageType_C health remaining 1650.000000`);
    assert.equal(dep.event, 'DEPLOYABLE_DAMAGED', name);
    assert.equal(dep.playerName, name);

    // ADMIN_BROADCAST_LOG — hostile sender
    const bc = logLine(`${STAMP}LogSquad: ADMIN COMMAND: Message broadcasted <hi <nested> msg> from ${name}`);
    assert.equal(bc.event, 'ADMIN_BROADCAST_LOG', name);
    assert.equal(bc.from, name);
    assert.equal(bc.message, 'hi <nested> msg');
  }
});

// ---------------------------------------------------------------------------
// 2. Every §6.3 chat-packet kind with every hostile name
// ---------------------------------------------------------------------------
test('chat packets: every §6.3 kind with hostile names', () => {
  const CHANNELS = [['ChatAll', 'all'], ['ChatTeam', 'team'], ['ChatSquad', 'squad'], ['ChatAdmin', 'admin']];
  const MSG = 'gg : wp "quoted" | end \u{1F40D}';
  HOSTILE_NAMES.forEach((name, i) => {
    // CHAT — all four channels round-robin; split on the FIRST " : " after the id bracket
    const [raw, channel] = CHANNELS[i % CHANNELS.length];
    const chat = chatPacket(`[${raw}] [Online IDs:EOS: ${EOS} steam: ${STEAM}] ${name} : ${MSG}`);
    assert.deepEqual(chat, {
      kind: 'CHAT', channel, eosId: EOS, steamId: STEAM, name, message: MSG,
    }, `CHAT name: ${name}`);

    // ADMIN_CAM — "Online Ids:" casing, possessed + unpossessed, optional trailing dot
    const camOn = chatPacket(`[Online Ids:EOS: ${EOS} steam: ${STEAM}] ${name} has possessed admin camera.`);
    assert.deepEqual(camOn, { kind: 'ADMIN_CAM', eosId: EOS, steamId: STEAM, name, possessed: true }, name);
    const camOff = chatPacket(`[Online Ids:EOS: ${EOS} steam: ${STEAM}] ${name} has unpossessed admin camera`);
    assert.deepEqual(camOff, { kind: 'ADMIN_CAM', eosId: EOS, steamId: STEAM, name, possessed: false }, name);

    // WARNED — message itself full of quotes
    const warned = chatPacket(`Remote admin has warned player ${name}. Message was "be "nice" | ok"`);
    assert.deepEqual(warned, { kind: 'WARNED', name, message: 'be "nice" | ok' }, name);

    // KICKED — name is terminal, "Online IDs=" equals-sign framing
    const kicked = chatPacket(`Kicked player 7. [Online IDs= EOS: ${EOS} steam: ${STEAM}] ${name}`);
    assert.deepEqual(kicked, { kind: 'KICKED', playerId: 7, eosId: EOS, steamId: STEAM, name }, name);

    // BANNED — hostile name + assorted interval spellings (validation is admin.js's job)
    const interval = ['1d', '0', '999y', 'until further notice', '∞'][i % 5];
    const banned = chatPacket(`Banned player 12. [Online IDs= EOS: ${EOS} steam: ${STEAM}] ${name} for interval ${interval}`);
    assert.deepEqual(banned, {
      kind: 'BANNED', playerId: 12, eosId: EOS, steamId: STEAM, name, interval,
    }, name);

    // SQUAD_CREATED (§19.1.11 — no "LogSquad: " prefix), hostile player AND squad name
    const sq = chatPacket(`${name} (Online IDs:${IDS_END}) has created Squad 9 (Squad Name: ${name}) on Team 2`);
    assert.deepEqual(sq, {
      kind: 'SQUAD_CREATED', playerName: name, ids: IDS_END, squadId: 9, squadName: name, teamName: 'Team 2',
    }, name);
  });

  // Documented wire ambiguity (§6.3 mandates FIRST " : " split): a name that
  // itself contains " : " is truncated at its first separator. Not fixable
  // without changing the spec'd split rule — the message keeps the remainder.
  const quirk = chatPacket(`[ChatTeam] [Online IDs:EOS: ${EOS}] ${COLONY} : real message`);
  assert.deepEqual(quirk, {
    kind: 'CHAT', channel: 'team', eosId: EOS, steamId: null,
    name: 'Colon', message: 'Name : x : real message',
  });

  // BANNED where the *interval* contains " for interval ": the greedy name
  // capture absorbs everything up to the LAST separator (shifted split, still
  // well-formed — Squad's wire format is ambiguous here).
  const shifted = chatPacket(`Banned player 2. [Online IDs= EOS: ${EOS}] Name for interval 1 for interval 2`);
  assert.deepEqual(shifted, {
    kind: 'BANNED', playerId: 2, eosId: EOS, steamId: null, name: 'Name for interval 1', interval: '2',
  });
});

// ---------------------------------------------------------------------------
// 3. Wound/die attacker-id blobs: EOS only / steam only / swapped order
// ---------------------------------------------------------------------------
test('wound/die attacker ids blob: EOS only, steam only, swapped order', () => {
  const mk = (verb, blob) => `${STAMP}LogSquadTrace: [DedicatedServer]ASQSoldier::${verb}(): Player:Vic KillingDamage=-10.000000 from BP_PlayerController_C_1 (Online IDs:${blob}| Controller ID: BP_PlayerController_C_1) caused by BP_AK74_C`;

  const eosOnly = logLine(mk('Wound', ` EOS: ${EOS} `));
  assert.equal(eosOnly.event, 'PLAYER_WOUNDED');
  assert.equal(eosOnly.attackerIds, ` EOS: ${EOS} `);
  assert.deepEqual(parser.parseOnlineIds(eosOnly.attackerIds), { eosId: EOS, steamId: null });

  const steamOnly = logLine(mk('Die', ` steam: ${STEAM} `));
  assert.equal(steamOnly.event, 'PLAYER_DIED');
  assert.deepEqual(parser.parseOnlineIds(steamOnly.attackerIds), { eosId: null, steamId: STEAM });

  const swapped = logLine(mk('Wound', ` steam: ${STEAM} EOS: ${EOS} `));
  assert.equal(swapped.event, 'PLAYER_WOUNDED');
  assert.deepEqual(parser.parseOnlineIds(swapped.attackerIds), { eosId: EOS, steamId: STEAM });

  // Same three variants on PLAYER_DAMAGED
  for (const blob of [` EOS: ${EOS} `, ` steam: ${STEAM} `, ` steam: ${STEAM} EOS: ${EOS} `]) {
    const d = logLine(`${STAMP}LogSquad: Player:Vic ActualDamage=5.000000 from Bob (Online IDs:${blob}| Player Controller ID: BP_PlayerController_C_1)caused by BP_AK74_C`);
    assert.equal(d.event, 'PLAYER_DAMAGED', blob);
    assert.equal(d.attackerIds, blob);
  }

  // Empty-ish and junk blobs on wound lines still parse (ids resolve to null downstream)
  const junk = logLine(`${STAMP}LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:Vic KillingDamage=-1.000000 from nullptr (Online IDs: INVALID | Controller ID: None) caused by BP_Soldier_C`);
  assert.equal(junk.event, 'PLAYER_WOUNDED');
  assert.deepEqual(parser.parseOnlineIds(junk.attackerIds), { eosId: null, steamId: null });
});

// ---------------------------------------------------------------------------
// 4. Deployable lines with unusual class names
// ---------------------------------------------------------------------------
test('deployable lines: vanilla, short-instance, faction and mod class names', () => {
  const mk = (dep, causer, instigator, dtype) => `${STAMP}LogSquadTrace: [DedicatedServer]ASQDeployable::TakeDamage(): ${dep}: 50.000000 damage attempt by causer ${causer} instigator ${instigator} with damage type ${dtype} health remaining 450.000000`;

  // BP_Hab_RUS_C_1 — single-digit instance suffix; class keeps the faction token
  const hab = logLine(mk('BP_Hab_RUS_C_1', 'BP_Grenade_C_2', 'Bob', 'BP_Frag_DamageType_C'));
  assert.equal(hab.event, 'DEPLOYABLE_DAMAGED');
  assert.equal(hab.deployable, 'BP_Hab_RUS');
  assert.equal(hab.weapon, 'BP_Grenade');

  // BP_FOBRadio_MEA — faction-suffixed radio
  const mea = logLine(mk('BP_FOBRadio_MEA_C_2146001', 'BP_C4_Explosive_C_1', 'Bob', 'BP_C4_DamageType_C'));
  assert.equal(mea.deployable, 'BP_FOBRadio_MEA');
  assert.equal(mea.damageType, 'BP_C4_DamageType');

  // Mod classes + unicode instigator + hyphenated damage type + 0 health
  const mod = logLine(`${STAMP}LogSquadTrace: [DedicatedServer]ASQDeployable::TakeDamage(): BP_ZZZCustomRadio_C_99: 1.500000 damage attempt by causer BP_ZZZCustomBoom_C_7 instigator [MOD] П\u{1F40D} with damage type BP_ZZZCustom-DamageType_C health remaining 0.000000`);
  assert.equal(mod.deployable, 'BP_ZZZCustomRadio');
  assert.equal(mod.weapon, 'BP_ZZZCustomBoom');
  assert.equal(mod.playerName, '[MOD] П\u{1F40D}');
  assert.equal(mod.damageType, 'BP_ZZZCustom-DamageType');
  assert.equal(mod.healthRemaining, 0);

  // FINDING (documented limitation, acceptable): a hyphen in the deployable
  // CLASS name is rejected (`[A-Za-z0-9_]+`), while damage types allow it.
  // Hyphens are not valid UE C++ identifiers, so real classes never carry one;
  // such a line returns null (never throws).
  assert.equal(logLine(`${STAMP}LogSquadTrace: [DedicatedServer]ASQDeployable::TakeDamage(): BP_Weird-Class_C_99: 1.0 damage attempt by causer BP_X_C_1 instigator Bob with damage type BP_Y_C health remaining 0.000000`), null);
});

// ---------------------------------------------------------------------------
// 5. ListPlayers: marker-like text inside names, both sections
// ---------------------------------------------------------------------------
test('parseListPlayers: names containing " | Team ID: "-like marker text survive, incl. DISCONNECTED rows', () => {
  const evil1 = 'Evil | Team ID: 9 | Role: fake';
  const evil2 = 'Gone | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: X';
  const evil3 = 'T | Since Disconnect: 0s | Name: X';
  const uni = `${HOSTILE_NAMES[3]} ${HOSTILE_NAMES[5]} ${LONG_NAME}`;
  const text = [
    '----- Active Players -----',
    `ID: 5 | Online IDs: EOS: ${EOS} steam: ${STEAM} | Name: ${evil1} | Team ID: 2 | Squad ID: N/A | Is Leader: False | Role: MEA_Rifleman_01`,
    `ID: 6 | Online IDs: EOS: ${EOS2} steam: ${STEAM2} | Name: ${uni} | Team ID: 1 | Squad ID: 3 | Is Leader: True | Role: USA_SL_01`,
    'ID: 8 | Online IDs:  | Name: NoIdsGuy | Team ID: 1 | Squad ID: N/A | Is Leader: False | Role: USA_Rifleman_01',
    `ID: 9 | Online IDs: EOS: ${EOS} | Name: Truncated row with no role | Team ID: 1 | Squad ID: 4`,
    'garbage line that is not a row at all',
    '----- Recently Disconnected Players [Max of 15] -----',
    `ID: 3 | Online IDs: EOS: ${EOS} steam: ${STEAM} | Since Disconnect: 01m.30s | Name: ${evil2}`,
    `ID: 4 | Online IDs: EOS: ${EOS2} steam: ${STEAM2} | Since Disconnect: 03m.09s | Name: ${evil3}`,
  ].join('\n');

  const out = noThrow('parseListPlayers', parser.parseListPlayers, text);
  assert.deepEqual(out, {
    online: [
      {
        playerId: 5, eosId: EOS, steamId: STEAM, name: evil1,
        teamId: 2, squadId: null, isLeader: false, role: 'MEA_Rifleman_01',
      },
      {
        playerId: 6, eosId: EOS2, steamId: STEAM2, name: uni,
        teamId: 1, squadId: 3, isLeader: true, role: 'USA_SL_01',
      },
      {
        playerId: 8, eosId: null, steamId: null, name: 'NoIdsGuy',
        teamId: 1, squadId: null, isLeader: false, role: 'USA_Rifleman_01',
      },
      // ID: 9 (no " | Role: ") is dropped, not thrown
    ],
    disconnected: [
      { playerId: 3, eosId: EOS, steamId: STEAM, name: evil2, sinceDisconnect: '01m.30s' },
      { playerId: 4, eosId: EOS2, steamId: STEAM2, name: evil3, sinceDisconnect: '03m.09s' },
    ],
  });

  // junk inputs never throw
  for (const junk of [null, undefined, '', 42, '\u0000\u0000', 'ID: 1 | Online IDs: ']) {
    const r = noThrow('parseListPlayers', parser.parseListPlayers, junk);
    assert.deepEqual(r, { online: [], disconnected: [] }, short(junk));
  }
});

// ---------------------------------------------------------------------------
// 6. Timestamps: year boundaries, tz offsets, junk
// ---------------------------------------------------------------------------
test('parseLogTime: year boundaries with tzOffset minutes, junk stamps and junk offsets', () => {
  const NYE = Date.UTC(2025, 11, 31, 23, 59, 59, 999);
  assert.equal(parser.parseLogTime('2025.12.31-23.59.59:999', 0), NYE);
  assert.equal(parser.parseLogTime('2025.12.31-23.59.59:999', -60), NYE + 3600000);  // into 2026
  assert.equal(parser.parseLogTime('2026.01.01-00.00.30:000', 90), Date.UTC(2026, 0, 1, 0, 0, 30) - 90 * 60000); // back into 2025
  assert.equal(parser.parseLogTime('2026.01.01-00.00.00:000', 0), Date.UTC(2026, 0, 1));
  assert.equal(parser.parseLogTime('2024.02.29-12.00.00:7', 0), Date.UTC(2024, 1, 29, 12, 0, 0, 7)); // leap day
  assert.equal(parser.parseLogTime('2026.06.15-10.00.00:1234', 0), Date.UTC(2026, 5, 15, 10, 0, 1, 234)); // 4-digit ms rolls

  // parseLogLine passes tz through; a year-boundary line keeps a finite time
  const line = logLine('[2025.12.31-23.59.59:999][448]LogNet: Join succeeded: NYE Guy', -60);
  assert.equal(line.time, NYE + 3600000);

  // junk stamps → null (single-digit fields, missing ms, swapped separators, empty, non-strings)
  for (const bad of ['2026.3.1-10.00.00:000', '2026.03.01-10.00.00', '2026-03-01 10:00:00:000',
    '2026.03.01-10.00.00:', '', 'garbage', null, undefined, 123, '21.50.52-2026.03.01:000']) {
    assert.equal(parser.parseLogTime(bad, 0), null, short(bad));
  }

  // junk tz offsets fall back to 0 (NaN / non-numeric / Infinity)
  const base = Date.UTC(2026, 0, 1);
  for (const tz of ['abc', NaN, Infinity, -Infinity, null, {}, []]) {
    assert.equal(parser.parseLogTime('2026.01.01-00.00.00:000', tz), base, String(tz));
  }
  // numeric-string and large-but-sane offsets apply
  assert.equal(parser.parseLogTime('2026.01.01-00.00.00:000', '60'), base - 3600000);
  assert.equal(parser.parseLogTime('2026.01.01-00.00.00:000', -1440), base + 86400000);

  // calendar-rollover quirks (month 13, day 00, year 0000): accepted today via
  // Date.UTC rollover — the contract here is only "finite or null, never throw"
  for (const quirky of ['2026.13.01-00.00.00:000', '2026.00.00-00.00.00:000', '0000.01.01-00.00.00:0', '9999.99.99-99.99.99:9999']) {
    const v = parser.parseLogTime(quirky, 0);
    assert.ok(v === null || Number.isFinite(v), `${quirky} -> ${v}`);
  }

  // an extreme (junk-config) offset must not leak a non-finite time
  for (const tz of [1e308, -1e308, Number.MAX_VALUE]) {
    const v = parser.parseLogTime('2026.01.01-00.00.00:000', tz);
    assert.ok(v === null || Number.isFinite(v), `tz=${tz} -> ${v}`);
    const l = logLine('[2026.01.01-00.00.00:000][1]LogNet: Join succeeded: X', tz);
    assert.ok(l === null || Number.isFinite(l.time), `tz=${tz} line time`);
  }
});

// ---------------------------------------------------------------------------
// 7. parseInterval / parseLayers junk
// ---------------------------------------------------------------------------
test('parseInterval (util.js): junk in, null out; valid spellings parse', () => {
  assert.equal(parseInterval('0'), 0);
  assert.equal(parseInterval(' 0 '), 0);
  assert.equal(parseInterval('30m'), 1800);
  assert.equal(parseInterval('2h'), 7200);
  assert.equal(parseInterval('1d'), 86400);
  assert.equal(parseInterval('1w'), 604800);
  assert.equal(parseInterval('1M'), 2592000);
  assert.equal(parseInterval('1y'), 31536000);
  assert.equal(parseInterval('9999y'), 9999 * 31536000);
  assert.equal(parseInterval(' 1d '), 86400);  // surrounding whitespace is trimmed by design
  assert.equal(parseInterval('1d\n'), 86400);
  for (const junk of ['', ' ', '-1d', '99999d', '1 d', 'd1', '1.5h', '0x10m', 'Infinity',
    '١d' /* Arabic-Indic digit */, '10S', 'm', '1dd', '1d2h', null, undefined, 12, {}, [],
    '1\u0000d', '∞']) {
    assert.equal(noThrow('parseInterval', parseInterval, junk), null, short(junk));
  }
});

test('parseLayers / parseCurrentMap / parseNextMap / parseServerInfo: junk never throws', () => {
  assert.deepEqual(noThrow('parseLayers', parser.parseLayers, null), []);
  assert.deepEqual(parser.parseLayers(''), []);
  assert.deepEqual(parser.parseLayers('List of available layers :'), []);
  assert.deepEqual(parser.parseLayers('header\n\n  \n\t\n'), []);
  assert.deepEqual(parser.parseLayers('header\r\nA\r\n B (Mod) \r\n'), ['A', 'B (Mod)']);
  assert.deepEqual(parser.parseLayers(42), []); // one line, and the header line is skipped
  assert.deepEqual(parser.parseLayers('x'.repeat(70 * 1024)), []); // 70KB single line, no newline

  for (const junk of [null, '', 'garbage', 'Current level is', 'level is X, layer is Y', 42]) {
    assert.equal(noThrow('parseCurrentMap', parser.parseCurrentMap, junk), null, short(junk));
    assert.equal(noThrow('parseNextMap', parser.parseNextMap, junk), null, short(junk));
  }
  assert.deepEqual(parser.parseCurrentMap('Current level is , layer is '), { level: null, layer: null });
  assert.deepEqual(parser.parseNextMap('Next level is To be voted, layer is To be voted'), { level: null, layer: null });

  for (const junk of ['', 'not json', '[1,2]', 'null', '"str"', '42', '{', '{"a":', null, undefined]) {
    assert.equal(noThrow('parseServerInfo', parser.parseServerInfo, junk), null, short(junk));
  }
  // weird value types inside valid JSON coerce, never throw
  const weird = noThrow('parseServerInfo', parser.parseServerInfo,
    '{"ServerName_s": {"a": 1}, "PlayerCount_I": {}, "MaxPlayers": [], "PublicQueue_I": "  ", "__proto__": {"x": 1}}');
  assert.equal(typeof weird, 'object');
  assert.equal(typeof weird.serverName, 'string');
  for (const k of ['playerCount', 'maxPlayers', 'publicQueue']) {
    assert.ok(weird[k] === null || Number.isFinite(weird[k]), `${k}=${weird[k]}`);
  }
});

// ---------------------------------------------------------------------------
// 8. Truncation: every prefix/suffix at code-unit AND byte offsets → null or
//    well-formed, never a throw
// ---------------------------------------------------------------------------
test('truncated lines at every offset: parseLogLine/parseChatPacket return null or well-formed, never throw', () => {
  const hostileLogLines = LOG_NAMES.map((n) =>
    `${STAMP}LogSquad: Player:${n} ActualDamage=12.500000 from ${n} (Online IDs:${IDS_MID}| Player Controller ID: BP_PlayerController_C_1)caused by BP_AK74_C`);
  const logCorpus = FIXTURE_LINES.concat(hostileLogLines);

  for (const line of logCorpus) {
    for (let i = 0; i <= line.length; i++) {
      logLine(line.slice(0, i)); // prefix (may split a surrogate pair)
      logLine(line.slice(i));    // suffix
    }
  }

  const chatCorpus = HOSTILE_NAMES.map((n) => `[ChatAll] [Online IDs:EOS: ${EOS} steam: ${STEAM}] ${n} : msg \u{1F40D}`)
    .concat(HOSTILE_NAMES.map((n) => `Banned player 12. [Online IDs= EOS: ${EOS}] ${n} for interval 1d`))
    .concat([`[Online Ids:EOS: ${EOS}] شاهد has possessed admin camera.`]);
  for (const body of chatCorpus) {
    for (let i = 0; i <= body.length; i++) {
      chatPacket(body.slice(0, i));
      chatPacket(body.slice(i));
    }
  }

  // byte-offset cuts through multi-byte UTF-8 (yields U+FFFD and lone-surrogate-free
  // strings) — every offset of the unicode-heavy lines
  const uniLines = hostileLogLines.slice(3, 8).concat(chatCorpus.slice(3, 6));
  for (const line of uniLines) {
    const buf = Buffer.from(line, 'utf8');
    for (let i = 0; i <= buf.length; i++) {
      const cut = buf.subarray(0, i).toString('utf8');
      logLine(cut);
      chatPacket(cut);
    }
  }
});

// ---------------------------------------------------------------------------
// 9. Seeded mutation fuzz across all parser entry points
// ---------------------------------------------------------------------------
test('seeded mutation fuzz: no parser entry point ever throws; results stay well-formed', () => {
  let seed = 0xC0FFEE;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

  const POOL = ['"', '|', ':', ' : ', '(', ')', '[', ']', '=', '.', '\u0000', '\r', '\n', '\t',
    '‏', '‮', '\uD83D', '\uDC0D', '\u{1F40D}', 'ش', '黑', 'ё',
    '(Online IDs:', ' | Team ID: ', ' : ', 'EOS: ', 'steam: ', '9999999999999999999', '-', 'caused by '];

  const bases = FIXTURE_LINES.concat([
    `[ChatAll] [Online IDs:EOS: ${EOS} steam: ${STEAM}] Bob : hello there`,
    `[Online Ids:EOS: ${EOS}] AdminGuy has possessed admin camera.`,
    'Remote admin has warned player Bob. Message was "stop"',
    `Kicked player 7. [Online IDs= EOS: ${EOS}] Bob`,
    `Banned player 12. [Online IDs= EOS: ${EOS}] Bob for interval 1d`,
    `Bob (Online IDs:${IDS_END}) has created Squad 3 (Squad Name: ARMOR) on Team 2`,
    `ID: 7 | Online IDs: EOS: ${EOS} steam: ${STEAM} | Name: Bob | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01`,
    `ID: 1 | Name: CMD | Size: 9 | Locked: False | Creator Name: Bob | Creator Online IDs: EOS: ${EOS}`,
    'Current level is Yehorivka, layer is Yehorivka RAAS v1',
    '2026.03.01-21.50.52:123',
    '{"ServerName_s":"X","PlayerCount_I":5}',
  ]);

  const mutate = (s) => {
    const n = 1 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const op = Math.floor(rnd() * 4);
      const i = Math.floor(rnd() * (s.length + 1));
      const j = Math.min(s.length, i + 1 + Math.floor(rnd() * 20));
      if (op === 0) s = s.slice(0, i) + pick(POOL) + s.slice(i);        // insert
      else if (op === 1) s = s.slice(0, i) + s.slice(j);                // delete span
      else if (op === 2) s = s.slice(0, i) + pick(POOL) + s.slice(j);   // replace span
      else s = s.slice(0, j) + s.slice(i, j) + s.slice(j);              // duplicate span
    }
    return s.length > 4000 ? s.slice(0, 4000) : s;
  };

  const TZ_JUNK = [0, 60, -600, 'abc', NaN, Infinity, 1e15, -1e15, 1e308, null, undefined];
  for (let iter = 0; iter < 3000; iter++) {
    const mutant = mutate(pick(bases));
    logLine(mutant, pick(TZ_JUNK));
    chatPacket(mutant);
    if (iter % 5 === 0) {
      const lp = noThrow('parseListPlayers', parser.parseListPlayers, mutant);
      assert.ok(Array.isArray(lp.online) && Array.isArray(lp.disconnected));
      for (const row of lp.online.concat(lp.disconnected)) assert.equal(typeof row.name, 'string');
      const ls = noThrow('parseListSquads', parser.parseListSquads, mutant);
      assert.ok(Array.isArray(ls));
      assert.ok(Array.isArray(noThrow('parseLayers', parser.parseLayers, mutant)));
      noThrow('parseCurrentMap', parser.parseCurrentMap, mutant);
      noThrow('parseNextMap', parser.parseNextMap, mutant);
      noThrow('parseOnlineIds', parser.parseOnlineIds, mutant);
      noThrow('parseServerInfo', parser.parseServerInfo, mutant);
      const t = noThrow('parseLogTime', (x) => parser.parseLogTime(x, pick(TZ_JUNK)), mutant);
      assert.ok(t === null || Number.isFinite(t), `parseLogTime -> ${t} for: ${short(mutant)}`);
    }
  }
});

test('non-string inputs never throw anywhere', () => {
  const weird = [null, undefined, 0, 42, -1.5, NaN, Infinity, true, false, {}, [],
    ['LogNet: Join succeeded: X'], { toString: () => '[ChatAll] x' }, Symbol('s'), 9007199254740993n];
  for (const w of weird) {
    logLine(w);
    // BigInt/Symbol pass String() fine; objects coerce via toString
    chatPacket(w);
    noThrow('parseListPlayers', parser.parseListPlayers, w);
    noThrow('parseListSquads', parser.parseListSquads, w);
    noThrow('parseLayers', parser.parseLayers, w);
    noThrow('parseCurrentMap', parser.parseCurrentMap, w);
    noThrow('parseNextMap', parser.parseNextMap, w);
    noThrow('parseOnlineIds', parser.parseOnlineIds, w);
    noThrow('parseServerInfo', parser.parseServerInfo, w);
    noThrow('parseLogTime', (x) => parser.parseLogTime(x, 0), w);
    noThrow('parseInterval', parseInterval, w);
  }
});

// ---------------------------------------------------------------------------
// 10. 70KB single lines: must complete under a 5s watchdog (adversarial
//     backtracking shapes). Runs in a child process so a true regex hang is
//     killed by the timeout instead of wedging the suite. (logsource caps
//     lines at 64KiB — §19.3.24 — so 70KB over-covers production input.)
// ---------------------------------------------------------------------------
test('70KB single lines parse to completion (no hang) under a 5s timeout', () => {
  const childSrc = [
    'const parser = require(process.argv[1]);',
    'const SIZE = 70 * 1024;',
    'const STAMP = "[2026.03.01-21.50.52:123][448]";',
    'function pad(prefix, unit) { let s = prefix; while (s.length < SIZE) s += unit; return s.slice(0, SIZE); }',
    'const cases = [',
    '  ["damaged-triple-greedy", () => parser.parseLogLine(pad(STAMP + "LogSquad: Player:", "x ActualDamage=1.0 from y (Online IDs: z| Player Controller ID: w)"))],',
    '  ["damaged-long-victim", () => parser.parseLogLine(STAMP + "LogSquad: Player:" + "A".repeat(SIZE - 200) + " ActualDamage=1.0 from B (Online IDs: z| Player Controller ID: w)caused by NOPE")],',
    '  ["wounded-repeat", () => parser.parseLogLine(pad(STAMP + "LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:", "v KillingDamage=-1.0 from a (Online IDs: i| Controller ID: c) caused by "))],',
    '  ["revived-repeat-no-dot", () => parser.parseLogLine(pad(STAMP + "LogSquad: ", "A (Online IDs: B) has revived "))],',
    '  ["squadcreated-log-repeat", () => parser.parseLogLine(pad(STAMP + "LogSquad: ", " (Online IDs: x) has created Squad 1 (Squad Name: n) on "))],',
    '  ["connected-repeat", () => parser.parseLogLine(pad(STAMP + "LogSquad: PostLogin: NewPlayer: BP_PlayerController_C ", "PersistentLevel.X (IP: 1.2.3.4 | Online IDs"))],',
    '  ["head-digits", () => parser.parseLogLine("[" + "1".repeat(SIZE) + "]")],',
    '  ["warned-repeat", () => parser.parseChatPacket(pad("Remote admin has warned player ", ". Message was \\"") + "x")],',
    '  ["warned-many-quotes", () => parser.parseChatPacket("Remote admin has warned player " + "\\". Message was \\"".repeat(Math.floor(SIZE / 16)) + "x")],',
    '  ["banned-repeat", () => parser.parseChatPacket(pad("Banned player 1. [Online IDs= EOS: x] ", " for interval ") + "x")],',
    '  ["chat-unterminated-bracket", () => parser.parseChatPacket("[ChatAll] [Online IDs:" + "E".repeat(SIZE))],',
    '  ["chat-huge-msg", () => parser.parseChatPacket("[ChatAll] [Online IDs:EOS: 0002a10386d9114496bce8b6ded68587] Bob : " + "m".repeat(SIZE))],',
    '  ["squadcreated-chat-repeat", () => parser.parseChatPacket(pad("N", " (Online IDs: x) has created Squad 1 (Squad Name: s) on"))],',
    '  ["admincam-repeat", () => parser.parseChatPacket(pad("[Online Ids:x] ", " has possessed admin camera"))],',
    '  ["nul-tail", () => parser.parseChatPacket("x" + "\\u0000".repeat(SIZE))],',
    '  ["currentmap-repeat", () => parser.parseCurrentMap(pad("Current level is ", ", layer is x, factions "))],',
    '  ["listplayers-one-line", () => parser.parseListPlayers(pad("ID: 1 | Online IDs: EOS: x | Name: ", " | Team ID: 1"))],',
    '  ["layers-70k", () => parser.parseLayers("h\\n" + "L".repeat(SIZE))],',
    '];',
    'let total = 0;',
    'for (const [name, fn] of cases) {',
    '  const t0 = Date.now(); let r;',
    '  try { r = fn(); } catch (e) { console.error("THREW " + name + ": " + e.message); process.exit(2); }',
    '  const dt = Date.now() - t0; total += dt;',
    '  if (dt > 4000) { console.error("SLOW " + name + ": " + dt + "ms"); process.exit(3); }',
    '  const ok = r === null || (typeof r === "object" && r !== null);',
    '  if (!ok) { console.error("MALFORMED " + name); process.exit(4); }',
    '}',
    'console.log("EDGE-OK " + total + "ms");',
  ].join('\n');

  const res = spawnSync(process.execPath, ['-e', childSrc, PARSER_PATH], {
    timeout: 5000, encoding: 'utf8', windowsHide: true,
  });
  if (res.error && (res.error.code === 'ETIMEDOUT' || res.signal === 'SIGTERM')) {
    assert.fail('parser HUNG: 70KB adversarial corpus exceeded the 5s timeout');
  }
  assert.equal(res.signal, null, `child killed (${res.signal}) — likely a hang past the 5s timeout`);
  assert.equal(res.status, 0, `child failed:\n${res.stderr || ''}${res.stdout || ''}`);
  assert.match(res.stdout, /EDGE-OK \d+ms/);
});

// ---------------------------------------------------------------------------
// 11. parseLogLine time from hostile lines is always finite (sanity pin on the
//     full fixture corpus with assorted tz offsets)
// ---------------------------------------------------------------------------
test('fixture corpus re-parses with assorted tz offsets: time always finite', () => {
  for (const tz of [0, 1, -1, 765, -765, 60 * 24]) {
    for (const line of FIXTURE_LINES) {
      const r = logLine(line, tz);
      if (r) assert.ok(Number.isFinite(r.time));
    }
  }
  assert.ok(Number.isFinite(T0)); // keep the shared constant honest
});
