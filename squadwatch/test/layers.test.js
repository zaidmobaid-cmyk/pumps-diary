'use strict';
// Layers & factions (docs/NEXT-CONTRACTS.md §1).
//
// UNIT — parser: ListLayers " (modid)" suffix stripping + case-insensitive
//   de-duplication, LayerInfo (level/mode/mod) best-effort parsing, the
//   ShowCurrentMap/ShowNextMap ", factions A B" suffix (a faction may lack
//   +Type), whitespace-heavy 64KiB lines staying linear. state: the layer
//   cache, current/next tracking and the combo-learning `fresh` signal
//   (counted once per appearance; a queued next turning current is the
//   same round). admin.changeLayer: the validation matrix, case-insensitive
//   match normalized to the list's spelling, both-or-neither factions, the
//   exact command text, and the audit row.
//
// SPAWNED SERVER (like integration.test.js) against a MockSquad subclass that
//   speaks the owner's modded server dialect: GET /api/layers is stripped +
//   de-duplicated with layerInfo; the boot pollers learn the current/next
//   combos into layer_factions and GET /api/factions serves them with the
//   catalog; POST /api/admin/changeLayer sends the exact command, echoes it,
//   and the re-poll after it learns the new pairing (a queued combo that
//   then goes live is not counted twice); 400s send nothing; viewers may
//   read layers but not factions or change them.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const parser = require('../server/parser');
const LiveState = require('../server/state');
const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { MockSquad } = require('./mock-squad');

const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server', 'index.js');
const RCON_PASSWORD = 'layers-secret';

// Ground truth captured from the owner's server (NEXT-CONTRACTS header).
const CURRENT_LINE = 'Current level is SPM | Sumari Bala, layer is SU_Sumari_Seed_v1, factions SU_IDF+Combined SU_PALINS';
const NEXT_LINE = 'Next level is SPM | Kokan, layer is SU_Kokan_Invasion_v1, factions SU_USA SU_AFINS';

// ----------------------------------------------------------- UNIT: parser

test('parseLayerList strips " (modid)" suffixes and de-duplicates case-insensitively', () => {
  const text = [
    'List of available layers :',
    'Sumari_AAS_v1',
    'SU_Sumari_Seed_v1 (3293347373)',
    '  SU_Kokan_Invasion_v1 (3293347373)  ',
    'su_sumari_seed_v1 (999)', // same layer again: first spelling + id win
    'Sumari_AAS_v1',
    'Belaya_RAAS_v1 (CAF Mod)',
    'Odd_Name(12)', // no space before "(": part of the name, not a suffix
    'Empty_Suffix_v1 ()',
    '',
    '   ',
  ].join('\r\n');
  assert.deepStrictEqual(parser.parseLayerList(text), [
    { name: 'Sumari_AAS_v1', modId: null },
    { name: 'SU_Sumari_Seed_v1', modId: '3293347373' },
    { name: 'SU_Kokan_Invasion_v1', modId: '3293347373' },
    { name: 'Belaya_RAAS_v1', modId: 'CAF Mod' },
    { name: 'Odd_Name(12)', modId: null },
    { name: 'Empty_Suffix_v1', modId: null },
  ]);
  assert.deepStrictEqual(parser.parseLayers(text), [
    'Sumari_AAS_v1', 'SU_Sumari_Seed_v1', 'SU_Kokan_Invasion_v1', 'Belaya_RAAS_v1', 'Odd_Name(12)', 'Empty_Suffix_v1',
  ]);
  assert.deepStrictEqual(parser.splitLayerName('SU_Sumari_Seed_v1 (3293347373)'), { name: 'SU_Sumari_Seed_v1', modId: '3293347373' });
  assert.deepStrictEqual(parser.splitLayerName('(123)'), { name: '(123)', modId: null }, 'a bare parenthetical is not a suffix');
  assert.deepStrictEqual(parser.splitLayerName('A (b) c)'), { name: 'A (b) c)', modId: null });
});

test('layerInfo parses level/mode best-effort and marks modded layers', () => {
  const info = (n, id) => parser.layerInfo(n, id === undefined ? null : id);
  assert.deepStrictEqual(info('SU_Sumari_Seed_v1', '3293347373'),
    { name: 'SU_Sumari_Seed_v1', modId: '3293347373', level: 'Sumari', mode: 'Seed', mod: true });
  assert.deepStrictEqual(info('Sumari_AAS_v1'),
    { name: 'Sumari_AAS_v1', modId: null, level: 'Sumari', mode: 'AAS', mod: false });
  assert.strictEqual(info('SU_Kokan_Invasion_v1', '1').level, 'Kokan');
  assert.strictEqual(info('SU_Kokan_Invasion_v1', '1').mode, 'Invasion');
  // an unknown (modded) mode is still found before the version token
  assert.deepStrictEqual([info('SU_Kokan_Conquest_v2').level, info('SU_Kokan_Conquest_v2').mode], ['Kokan', 'Conquest']);
  assert.deepStrictEqual([info('Fools_Road_AAS_v1').level, info('Fools_Road_AAS_v1').mode], ['Fools Road', 'AAS']);
  assert.deepStrictEqual([info('CAF_Gorodok_RAAS_v1').level, info('CAF_Gorodok_RAAS_v1').mode], ['Gorodok', 'RAAS']);
  // names that do not follow Level_Mode_vN: no mode, first word as level
  assert.deepStrictEqual([info('JensensRange_ADF-PLA').level, info('JensensRange_ADF-PLA').mode], ['JensensRange', null]);
  assert.deepStrictEqual([info('').level, info('').mode, info('').mod], [null, null, false]);
});

test('ShowCurrentMap / ShowNextMap: factions suffix -> team1/team2 (a faction may lack +Type)', () => {
  assert.deepStrictEqual(parser.parseCurrentMap(CURRENT_LINE), {
    level: 'SPM | Sumari Bala', layer: 'SU_Sumari_Seed_v1', team1: 'SU_IDF+Combined', team2: 'SU_PALINS',
  });
  assert.deepStrictEqual(parser.parseNextMap(NEXT_LINE), {
    level: 'SPM | Kokan', layer: 'SU_Kokan_Invasion_v1', team1: 'SU_USA', team2: 'SU_AFINS',
  });
  // vanilla shape without factions, and an empty factions suffix
  assert.deepStrictEqual(parser.parseNextMap('Next level is Kokan, layer is Kokan_RAAS_v1'),
    { level: 'Kokan', layer: 'Kokan_RAAS_v1', team1: null, team2: null });
  assert.deepStrictEqual(parser.parseNextMap('Next level is Kokan, layer is Kokan_RAAS_v1, factions '),
    { level: 'Kokan', layer: 'Kokan_RAAS_v1', team1: null, team2: null });
  // never half a pairing: one token, three tokens or a bad token -> both null
  for (const f of ['SU_USA', 'A B C', 'SU-USA SU_AFINS', 'A+B+C D', 'X+ Y', '+X Y']) {
    const r = parser.parseCurrentMap(`Current level is L, layer is Some_AAS_v1, factions ${f}`);
    assert.deepStrictEqual([r.layer, r.team1, r.team2], ['Some_AAS_v1', null, null], f);
  }
  // a " (modid)" suffix on the layer is stripped like ListLayers'
  assert.strictEqual(parser.parseCurrentMap('Current level is X, layer is SU_A_Seed_v1 (3293347373), factions A B').layer,
    'SU_A_Seed_v1');
  assert.deepStrictEqual(parser.parseNextMap('Next level is To be voted, layer is To be voted, factions A B'),
    { level: null, layer: null, team1: 'A', team2: 'B' });
  assert.deepStrictEqual(parser.parseFactionPair('  SU_IDF+Combined   SU_PALINS '), { team1: 'SU_IDF+Combined', team2: 'SU_PALINS' });
  assert.deepStrictEqual(parser.splitFaction('SU_IDF+Combined'), { code: 'SU_IDF', type: 'Combined' });
  assert.deepStrictEqual(parser.splitFaction('SU_PALINS'), { code: 'SU_PALINS', type: null });
});

test('layer/map parsing stays linear on whitespace-heavy 64KiB lines', () => {
  const SIZE = 64 * 1024;
  const t0 = Date.now();
  const spaced = `A${' '.repeat(SIZE)}B`;
  assert.deepStrictEqual(parser.parseLayerList(`h\n${spaced}`), [{ name: spaced, modId: null }]);
  parser.parseLayerList(`h\n${'( '.repeat(SIZE / 2)})`);
  parser.splitLayerName(`x ${'('.repeat(SIZE)} )`);
  const r = parser.parseCurrentMap(`Current level is a, layer is b, factions ${'X '.repeat(SIZE / 2)}`);
  assert.deepStrictEqual([r.team1, r.team2], [null, null]);
  parser.layerInfo('_'.repeat(SIZE) + 'v1', null);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0}ms`);
});

// ------------------------------------------------------------ UNIT: state

test('state.applyLayers caches names + layerInfo; an empty reply keeps the cache', () => {
  const st = new LiveState();
  const entries = parser.parseLayerList('h\nSumari_AAS_v1\nSU_Sumari_Seed_v1 (3293347373)');
  assert.strictEqual(st.applyLayers(entries, 1234), true);
  assert.deepStrictEqual(st.layers, ['Sumari_AAS_v1', 'SU_Sumari_Seed_v1']);
  assert.deepStrictEqual(st.layerInfo.map((i) => [i.name, i.modId, i.mod]), [
    ['Sumari_AAS_v1', null, false], ['SU_Sumari_Seed_v1', '3293347373', true],
  ]);
  assert.strictEqual(st.layersCachedAt, 1234);
  assert.strictEqual(st.applyLayers([], 5678), false);
  assert.strictEqual(st.applyLayers(parser.parseLayerList('List of available layers :'), 5678), false);
  assert.deepStrictEqual(st.layers, ['Sumari_AAS_v1', 'SU_Sumari_Seed_v1'], 'kept');
  assert.strictEqual(st.layersCachedAt, 1234);
});

test('state.applyMapInfo tracks current/next and counts each combo once per appearance', () => {
  const st = new LiveState();
  const cur = (layer, team1, team2) => st.applyMapInfo('current', { level: 'L', layer, team1, team2 });
  const nxt = (layer, team1, team2) => st.applyMapInfo('next', { level: 'L', layer, team1, team2 });

  assert.deepStrictEqual(cur('SU_Sumari_Seed_v1', 'SU_IDF+Combined', 'SU_PALINS'),
    { layer: 'SU_Sumari_Seed_v1', team1: 'SU_IDF+Combined', team2: 'SU_PALINS', fresh: true });
  assert.deepStrictEqual(st.currentMap, { layer: 'SU_Sumari_Seed_v1', level: 'L', team1: 'SU_IDF+Combined', team2: 'SU_PALINS' });
  assert.strictEqual(cur('SU_Sumari_Seed_v1', 'SU_IDF+Combined', 'SU_PALINS').fresh, false, 'repeat poll: last-seen only');

  assert.strictEqual(nxt('SU_Kokan_Invasion_v1', 'SU_USA', 'SU_AFINS').fresh, true);
  assert.strictEqual(nxt('SU_Kokan_Invasion_v1', 'SU_USA', 'SU_AFINS').fresh, false);
  assert.strictEqual(nxt('SU_Kokan_Invasion_v1', 'SU_USA+Raid', 'SU_AFINS').fresh, true, 'new pairing for the same layer');
  // map travel: the queued round goes live — counted already when queued
  assert.strictEqual(cur('SU_Kokan_Invasion_v1', 'SU_USA+Raid', 'SU_AFINS').fresh, false);
  // an earlier queued pairing replaced before it went live still counts as known
  assert.strictEqual(cur('SU_Kokan_Invasion_v1', 'SU_USA', 'SU_AFINS').fresh, false);
  // a layer changed straight to (never queued) is a new appearance
  assert.strictEqual(cur('Sumari_AAS_v1', 'USA', 'RGF').fresh, true);
  // going live consumed the queued mark: the same combo live again later is a new round
  assert.strictEqual(cur('SU_Kokan_Invasion_v1', 'SU_USA+Raid', 'SU_AFINS').fresh, true);
  assert.strictEqual(cur('Sumari_AAS_v1', 'USA', 'RGF').fresh, true);

  // no factions: tracked, nothing to learn
  assert.strictEqual(cur('Kokan_RAAS_v1', null, null), null);
  assert.deepStrictEqual(st.currentMap, { layer: 'Kokan_RAAS_v1', level: 'L', team1: null, team2: null });
  assert.strictEqual(cur('Sumari_AAS_v1', 'USA', 'RGF').fresh, true, 'back after a factionless round: new appearance');
  // "To be voted" clears next; a garbled (unparsed) reply changes nothing
  assert.strictEqual(nxt(null, null, null), null);
  assert.strictEqual(st.nextMap, null);
  assert.strictEqual(st.applyMapInfo('current', null), null);
  assert.strictEqual(st.currentMap.layer, 'Sumari_AAS_v1');
  assert.strictEqual(st.applyMapInfo('sideways', { layer: 'X', team1: 'A', team2: 'B' }), null);
});

// ----------------------------------------------- UNIT: admin.changeLayer

function changeLayerRig({ layers, fail } = {}) {
  const db = openDb(':memory:');
  db.migrate();
  const auth = createAuth({ db, config: {} });
  auth.loginLimiter.stop();
  const sent = [];
  const rcon = {
    async exec(cmd) {
      sent.push(cmd);
      if (fail) throw new Error('rcon down');
      return `OK ${cmd}`;
    },
  };
  const state = new LiveState();
  if (layers !== null) {
    state.applyLayers(parser.parseLayerList(['List of available layers :'].concat(layers || [
      'Sumari_AAS_v1', 'SU_Sumari_Seed_v1 (3293347373)', 'SU_Kokan_Invasion_v1 (3293347373)',
    ]).join('\n')));
  }
  const admin = createAdmin({ db, rcon, state, auth, config: {}, layersCache: () => state.layers });
  const user = auth.createUser('boss', 'password-123', 'owner');
  return { db, admin, sent, user, run: (p) => admin.execAdmin(user, 'changeLayer', p) };
}

test('changeLayer: case-insensitive layer match, normalized spelling, exact command text', async () => {
  const rig = changeLayerRig();
  const cases = [
    [{ layer: 'SU_Sumari_Seed_v1' }, 'AdminSetNextLayer SU_Sumari_Seed_v1'],
    [{ layer: 'su_sumari_seed_V1', now: true }, 'AdminChangeLayer SU_Sumari_Seed_v1'],
    [{ layer: '  sumari_aas_v1  ', now: false }, 'AdminSetNextLayer Sumari_AAS_v1'],
    [{ layer: 'SU_Sumari_Seed_v1 (3293347373)' }, 'AdminSetNextLayer SU_Sumari_Seed_v1'], // a raw list entry
    [{ layer: 'SU_Sumari_Seed_v1', now: 'yes' }, 'AdminSetNextLayer SU_Sumari_Seed_v1'], // only `true` travels now
    [{ layer: 'SU_Sumari_Seed_v1', team1: 'SU_IDF+Combined', team2: 'SU_PALINS' },
      'AdminSetNextLayer SU_Sumari_Seed_v1 SU_IDF+Combined SU_PALINS'],
    [{ layer: 'su_kokan_invasion_v1', now: true, team1: ' SU_USA ', team2: 'SU_AFINS+Combined' },
      'AdminChangeLayer SU_Kokan_Invasion_v1 SU_USA SU_AFINS+Combined'],
    [{ layer: 'Sumari_AAS_v1', team1: '', team2: '   ' }, 'AdminSetNextLayer Sumari_AAS_v1'], // blank = neither
    [{ layer: 'Sumari_AAS_v1', team1: null, team2: undefined }, 'AdminSetNextLayer Sumari_AAS_v1'],
  ];
  for (const [params, command] of cases) {
    const r = await rig.run(params);
    assert.strictEqual(r.ok, true, `${JSON.stringify(params)}: ${r.error}`);
    assert.strictEqual(r.command, command);
    assert.strictEqual(r.rconOk, true);
    assert.strictEqual(r.response, `OK ${command}`);
  }
  assert.deepStrictEqual(rig.sent, cases.map((c) => c[1]));

  const rows = rig.db.prepare("SELECT * FROM admin_actions WHERE action IN ('changeLayer', 'setNextLayer') ORDER BY id").all();
  assert.strictEqual(rows.length, cases.length, 'every executed change is audited');
  assert.strictEqual(rows[1].action, 'changeLayer');
  assert.strictEqual(rows[0].action, 'setNextLayer');
  assert.strictEqual(rows[6].rcon_command, 'AdminChangeLayer SU_Kokan_Invasion_v1 SU_USA SU_AFINS+Combined');
  assert.strictEqual(rows[6].user_id, rig.user.id);
  assert.deepStrictEqual(JSON.parse(rows[6].details),
    { layer: 'SU_Kokan_Invasion_v1', now: true, team1: 'SU_USA', team2: 'SU_AFINS+Combined' });
  assert.deepStrictEqual(JSON.parse(rows[0].details),
    { layer: 'SU_Sumari_Seed_v1', now: false, team1: null, team2: null });
});

test('changeLayer validation matrix: nothing is sent or audited on a 400', async () => {
  const rig = changeLayerRig();
  const L = 'SU_Sumari_Seed_v1';
  const cases = [
    [{}, /layer required/],
    [{ layer: '' }, /layer required/],
    [{ layer: '   ' }, /layer required/],
    [{ layer: 42 }, /layer required/],
    [{ layer: 'Nope_AAS_v1' }, /^unknown layer — pick one from the list$/],
    [{ layer: 'SU_Sumari_Seed' }, /unknown layer/], // no prefix matching
    [{ layer: `${L} SU_IDF SU_PALINS` }, /unknown layer/], // factions belong in team1/team2
    [{ layer: L, team1: 'SU_IDF' }, /both factions or neither/],
    [{ layer: L, team2: 'SU_PALINS' }, /both factions or neither/],
    [{ layer: L, team1: 'SU_IDF', team2: '' }, /both factions or neither/],
    [{ layer: L, team1: 'SU IDF', team2: 'SU_PALINS' }, /invalid faction/],
    [{ layer: L, team1: 'SU-IDF', team2: 'SU_PALINS' }, /invalid faction/],
    [{ layer: L, team1: 'SU_IDF+Combined+X', team2: 'SU_PALINS' }, /invalid faction/],
    [{ layer: L, team1: 'SU_IDF+', team2: 'SU_PALINS' }, /invalid faction/],
    [{ layer: L, team1: '+Combined', team2: 'SU_PALINS' }, /invalid faction/],
    [{ layer: L, team1: 'A'.repeat(49), team2: 'SU_PALINS' }, /invalid faction/],
    [{ layer: L, team1: 'SU_IDF', team2: `SU_PALINS+${'T'.repeat(49)}` }, /invalid faction/],
    [{ layer: L, team1: 'SU_IDF\nAdminBroadcast hi', team2: 'SU_PALINS' }, /invalid faction/],
    [{ layer: L, team1: 5, team2: 'SU_PALINS' }, /invalid faction/],
    [{ layer: L, team1: ['SU_IDF'], team2: 'SU_PALINS' }, /invalid faction/],
  ];
  for (const [params, re] of cases) {
    const r = await rig.run(params);
    assert.strictEqual(r.ok, false, JSON.stringify(params));
    assert.strictEqual(r.command, undefined, 'a validation failure carries no command (api: 400)');
    assert.match(r.error, re, JSON.stringify(params));
  }
  // the longest legal tokens are accepted
  const long = await rig.run({ layer: L, team1: `${'A'.repeat(48)}+${'B'.repeat(48)}`, team2: 'C' });
  assert.strictEqual(long.ok, true, long.error);
  assert.deepStrictEqual(rig.sent, [`AdminSetNextLayer ${L} ${'A'.repeat(48)}+${'B'.repeat(48)} C`]);
  assert.strictEqual(rig.db.prepare('SELECT COUNT(*) AS c FROM admin_actions').get().c, 1);

  const empty = changeLayerRig({ layers: null });
  assert.match((await empty.run({ layer: L })).error, /not cached yet/);
  assert.deepStrictEqual(empty.sent, []);
});

test('changeLayer: an RCON failure is audited with the error and reported with the command', async () => {
  const rig = changeLayerRig({ fail: true });
  const r = await rig.run({ layer: 'sumari_aas_v1', now: true, team1: 'USA', team2: 'RGF+Armored' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.command, 'AdminChangeLayer Sumari_AAS_v1 USA RGF+Armored');
  const row = rig.db.prepare("SELECT * FROM admin_actions WHERE action = 'changeLayer'").get();
  assert.strictEqual(row.rcon_ok, 0);
  assert.match(row.rcon_response, /^ERROR: rcon down/);
});

// --------------------------------------------------- SPAWNED SERVER (e2e)

// MockSquad speaking the owner's modded dialect: mod-suffixed ListLayers
// entries and ShowCurrentMap/ShowNextMap with a factions suffix; the layer
// commands take "<layer> [<team1> <team2>]".
class ModdedSquad extends MockSquad {
  constructor(opts) {
    super(Object.assign({
      layers: [
        'Sumari_AAS_v1',
        'SU_Sumari_Seed_v1 (3293347373)',
        'SU_Kokan_Invasion_v1 (3293347373)',
        'SU_Sumari_Seed_v1 (3293347373)',
        'Kokan_RAAS_v1',
      ],
    }, opts));
    this.cur = { level: 'SPM | Sumari Bala', layer: 'SU_Sumari_Seed_v1', factions: 'SU_IDF+Combined SU_PALINS' };
    this.nxt = { level: 'SPM | Kokan', layer: 'SU_Kokan_Invasion_v1', factions: 'SU_USA+Raid SU_AFINS' };
  }

  _handleCommand(raw) {
    const sp = raw.indexOf(' ');
    const cmd = (sp < 0 ? raw : raw.slice(0, sp)).toLowerCase();
    const args = sp < 0 ? [] : raw.slice(sp + 1).split(' ');
    const line = (m) => `level is ${m.level}, layer is ${m.layer}${m.factions ? `, factions ${m.factions}` : ''}`;
    if (cmd === 'showcurrentmap') return `Current ${line(this.cur)}`;
    if (cmd === 'shownextmap') return `Next ${line(this.nxt)}`;
    if (cmd === 'adminchangelayer' || cmd === 'adminsetnextlayer') {
      const known = this.layers.map((l) => l.split(' (')[0]);
      if (!known.includes(args[0]) || (args.length !== 1 && args.length !== 3)) {
        return 'Layer name invalid, check ListLayers for the list of valid layers';
      }
      const slot = { level: 'SPM', layer: args[0], factions: args.length === 3 ? `${args[1]} ${args[2]}` : '' };
      if (cmd === 'adminchangelayer') this.cur = slot;
      else this.nxt = slot;
      return `${cmd === 'adminchangelayer' ? 'Changed' : 'Set next'} layer to ${raw.slice(sp + 1)}`;
    }
    return super._handleCommand(raw);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(fn, { timeoutMs = 15000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      lastErr = null;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
    }
    await sleep(intervalMs);
  }
}

function makeApi(base) {
  return async function api(jar, method, p, body) {
    const headers = { origin: base, accept: 'application/json' };
    if (jar && jar.cookie) headers.cookie = jar.cookie;
    const init = { method, headers };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body == null ? {} : body);
    }
    const res = await fetch(base + p, init);
    if (jar && typeof res.headers.getSetCookie === 'function') {
      for (const sc of res.headers.getSetCookie()) {
        const m = /^sw_session=([^;]*)/.exec(sc);
        if (m) jar.cookie = m[1] ? `sw_session=${m[1]}` : null;
      }
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_e) { json = null; }
    return { status: res.status, json, text };
  };
}

function waitExit(child, ms) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error(`child did not exit within ${ms}ms`)), ms);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

// Random high web ports with EADDRINUSE retry (web.port 0 is not supported).
async function startServer({ tmp, logPath, mock, transcript }) {
  let lastFail = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const cfgPath = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      web: { port, host: '127.0.0.1' },
      squad: { rconHost: '127.0.0.1', rconPort: mock.port, rconPassword: RCON_PASSWORD },
      log: { mode: 'local', path: logPath, pollMs: 100, backfill: true },
      dbPath: path.join(tmp, 'squadwatch.db'),
    }, null, 2));
    const child = spawn(process.execPath, [SERVER_JS, '--config', cfgPath], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let buf = '';
    const feed = (c) => {
      buf += c;
      transcript.text = (transcript.text + c).slice(-120000);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 15000);
      child.stdout.on('data', (c) => {
        feed(c);
        if (/A3 Admin v[^\n]* up: http/.test(buf)) { clearTimeout(timer); resolve('up'); }
      });
      child.stderr.on('data', feed);
      child.once('exit', () => { clearTimeout(timer); resolve('exited'); });
    });
    if (outcome === 'up') {
      const tokenLine = buf.split('\n').find((l) => l.includes('Setup token'));
      const m = tokenLine ? /([0-9a-f]{32})/.exec(tokenLine) : null;
      return { child, port, setupToken: m ? m[1] : null };
    }
    if (child.exitCode == null) child.kill('SIGKILL');
    lastFail = buf.slice(-2000);
    if (outcome === 'timeout') throw new Error(`server did not print the up banner within 15s:\n${lastFail}`);
    if (!/EADDRINUSE|address already in use/i.test(buf)) throw new Error(`server exited before the banner:\n${lastFail}`);
  }
  throw new Error(`could not find a free web port in 5 attempts:\n${lastFail}`);
}

test('e2e: modded layer list, learned faction combos, and changeLayer through the real server', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-layers-'));
  const logPath = path.join(tmp, 'SquadGame.log');
  const mock = new ModdedSquad({ rconPort: 0, logPath, password: RCON_PASSWORD });
  await mock.start();
  const transcript = { text: '' };
  let child = null;
  let stepName = 'boot';
  const step = (s) => { stepName = s; };

  try {
    try {
      const app = await startServer({ tmp, logPath, mock, transcript });
      child = app.child;
      const api = makeApi(`http://127.0.0.1:${app.port}`);
      const owner = { cookie: null };
      const viewer = { cookie: null };

      step('owner setup + login');
      assert.strictEqual((await api(owner, 'POST', '/api/setup', {
        username: 'boss', password: 'hunter2hunter2', setupToken: app.setupToken,
      })).status, 200);
      assert.strictEqual((await api(owner, 'POST', '/api/login', { username: 'boss', password: 'hunter2hunter2' })).status, 200);

      step('GET /api/layers: suffixes stripped, de-duplicated, layerInfo alongside');
      const layers = await until(async () => {
        const r = await api(owner, 'GET', '/api/layers');
        return r.json && r.json.cachedAt != null ? r.json : null;
      }, { label: 'layer cache filled by the boot ListLayers poll' });
      assert.deepStrictEqual(layers.layers, ['Sumari_AAS_v1', 'SU_Sumari_Seed_v1', 'SU_Kokan_Invasion_v1', 'Kokan_RAAS_v1']);
      assert.deepStrictEqual(layers.layerInfo[1],
        { name: 'SU_Sumari_Seed_v1', modId: '3293347373', level: 'Sumari', mode: 'Seed', mod: true });
      assert.deepStrictEqual(layers.layerInfo[0],
        { name: 'Sumari_AAS_v1', modId: null, level: 'Sumari', mode: 'AAS', mod: false });

      step('GET /api/factions: boot pollers learned the current + next combos');
      const fac = await until(async () => {
        const r = await api(owner, 'GET', '/api/factions');
        return r.json && r.json.current && r.json.next ? r.json : null;
      }, { label: 'current/next factions from ShowCurrentMap/ShowNextMap' });
      assert.deepStrictEqual(fac.current, { layer: 'SU_Sumari_Seed_v1', team1: 'SU_IDF+Combined', team2: 'SU_PALINS' });
      assert.deepStrictEqual(fac.next, { layer: 'SU_Kokan_Invasion_v1', team1: 'SU_USA+Raid', team2: 'SU_AFINS' });
      const combo = (c) => [c.team1, c.team2, c.count];
      assert.deepStrictEqual(fac.combos.SU_Sumari_Seed_v1.map(combo), [['SU_IDF+Combined', 'SU_PALINS', 1]]);
      assert.deepStrictEqual(fac.combos.SU_Kokan_Invasion_v1.map(combo), [['SU_USA+Raid', 'SU_AFINS', 1]]);
      assert.ok(Number.isFinite(fac.combos.SU_Sumari_Seed_v1[0].lastSeen));
      const known = new Map(fac.known.map((k) => [k.code, k.mod]));
      assert.strictEqual(known.get('USA'), false, 'vanilla catalog');
      assert.strictEqual(known.get('WPMC'), false);
      for (const code of ['SU_IDF', 'SU_PALINS', 'SU_USA', 'SU_AFINS']) assert.strictEqual(known.get(code), true, code);
      assert.ok(!known.has('SU_IDF+Combined'), 'codes are stored without +Type');
      assert.ok(fac.types.includes('CombinedArms') && fac.types.includes('Combined'), 'built-in unit types');
      assert.strictEqual(fac.types[fac.types.length - 1], 'Raid', 'seen types follow the built-ins');

      step('POST changeLayer (queue next with factions): exact command, echoed, re-poll learns it');
      const queued = await api(owner, 'POST', '/api/admin/changeLayer', {
        layer: 'su_kokan_invasion_v1', now: false, team1: 'SU_USA', team2: 'SU_AFINS+Combined',
      });
      assert.strictEqual(queued.status, 200, queued.text);
      assert.strictEqual(queued.json.command, 'AdminSetNextLayer SU_Kokan_Invasion_v1 SU_USA SU_AFINS+Combined');
      assert.strictEqual(queued.json.rconOk, true, queued.json.rconResponse);
      assert.match(queued.json.rconResponse, /^Set next layer to /);
      assert.ok(mock.commands.includes('AdminSetNextLayer SU_Kokan_Invasion_v1 SU_USA SU_AFINS+Combined'));
      const learned = await until(async () => {
        const r = (await api(owner, 'GET', '/api/factions')).json;
        return r.next && r.next.team2 === 'SU_AFINS+Combined' ? r : null;
      }, { timeoutMs: 10000, label: 'the queued pairing re-polled from ShowNextMap' });
      assert.deepStrictEqual(learned.combos.SU_Kokan_Invasion_v1.map(combo).sort(),
        [['SU_USA', 'SU_AFINS+Combined', 1], ['SU_USA+Raid', 'SU_AFINS', 1]].sort());

      step('POST changeLayer now to the queued combo: same round, not counted twice');
      const live = await api(owner, 'POST', '/api/admin/changeLayer', {
        layer: 'SU_Kokan_Invasion_v1', now: true, team1: 'SU_USA', team2: 'SU_AFINS+Combined',
      });
      assert.strictEqual(live.status, 200, live.text);
      assert.strictEqual(live.json.command, 'AdminChangeLayer SU_Kokan_Invasion_v1 SU_USA SU_AFINS+Combined');
      const wentLive = await until(async () => {
        const r = (await api(owner, 'GET', '/api/factions')).json;
        return r.current && r.current.layer === 'SU_Kokan_Invasion_v1' ? r : null;
      }, { timeoutMs: 10000, label: 'ShowCurrentMap re-polled after travel' });
      const row = wentLive.combos.SU_Kokan_Invasion_v1.find((c) => c.team2 === 'SU_AFINS+Combined');
      assert.strictEqual(row.count, 1);

      step('POST changeLayer without factions: tracked, nothing learned');
      const plain = await api(owner, 'POST', '/api/admin/changeLayer', { layer: 'SUMARI_AAS_V1', now: true });
      assert.strictEqual(plain.status, 200, plain.text);
      assert.strictEqual(plain.json.command, 'AdminChangeLayer Sumari_AAS_v1');
      const after = await until(async () => {
        const r = (await api(owner, 'GET', '/api/factions')).json;
        return r.current && r.current.layer === 'Sumari_AAS_v1' ? r : null;
      }, { timeoutMs: 10000, label: 'factionless current layer re-polled' });
      assert.deepStrictEqual(after.current, { layer: 'Sumari_AAS_v1', team1: null, team2: null });
      assert.strictEqual(after.combos.Sumari_AAS_v1, undefined);

      step('400s send nothing to the server');
      const before = mock.commands.filter((c) => /^Admin(Change|SetNext)Layer/.test(c)).length;
      for (const [body, re] of [
        [{ layer: 'SU_Sumari_Seed_v1', team1: 'SU_IDF' }, /both factions or neither/],
        [{ layer: 'SU_Sumari_Seed_v1', team1: 'SU IDF', team2: 'SU_PALINS' }, /invalid faction/],
        [{ layer: 'Nowhere_AAS_v1' }, /^unknown layer — pick one from the list$/],
        [{ layer: 7 }, /layer must be a string/],
      ]) {
        const r = await api(owner, 'POST', '/api/admin/changeLayer', body);
        assert.strictEqual(r.status, 400, `${JSON.stringify(body)} -> ${r.text}`);
        assert.match(r.json.error, re);
      }
      assert.strictEqual(mock.commands.filter((c) => /^Admin(Change|SetNext)Layer/.test(c)).length, before);

      step('audit carries layer + factions');
      const audit = await api(owner, 'GET', '/api/audit?action=setNextLayer');
      assert.strictEqual(audit.status, 200, audit.text);
      assert.deepStrictEqual(audit.json.rows[0].details,
        { layer: 'SU_Kokan_Invasion_v1', now: false, team1: 'SU_USA', team2: 'SU_AFINS+Combined' });
      assert.strictEqual(audit.json.rows[0].rconCommand, 'AdminSetNextLayer SU_Kokan_Invasion_v1 SU_USA SU_AFINS+Combined');

      step('viewer: layers yes, factions and changes no');
      assert.strictEqual((await api(owner, 'POST', '/api/users', { username: 'scout', password: 'viewerpass1', role: 'viewer' })).status, 200);
      assert.strictEqual((await api(viewer, 'POST', '/api/login', { username: 'scout', password: 'viewerpass1' })).status, 200);
      assert.strictEqual((await api(viewer, 'GET', '/api/layers')).status, 200);
      assert.strictEqual((await api(viewer, 'GET', '/api/factions')).status, 403);
      assert.strictEqual((await api(viewer, 'POST', '/api/admin/changeLayer', { layer: 'Sumari_AAS_v1' })).status, 403);

      step('graceful shutdown');
      if (process.platform === 'win32') child.send('shutdown');
      else child.kill('SIGTERM');
      const exit = await waitExit(child, 5000);
      assert.strictEqual(exit.code, 0, `clean exit (got code=${exit.code} signal=${exit.signal})`);
      child = null;
    } catch (e) {
      e.message = `[step: ${stepName}] ${e.message}\n--- server output (tail) ---\n${transcript.text.slice(-3000)}`;
      throw e;
    }
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
      await waitExit(child, 3000).catch(() => {});
    }
    await mock.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
