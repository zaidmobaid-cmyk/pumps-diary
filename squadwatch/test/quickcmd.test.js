'use strict';
// Quick commands (docs/NEXT-CONTRACTS.md §2) plus the other in-process API
// pieces of the same round: the §3 BattleMetrics wrappers and the ban
// rows' source/eosId.
//
// UNIT — admin.validateQuickCommands: list rules (≤30 rows, id/label/command
//   patterns, unique ids, toggles are one bare token).
//
// IN-PROCESS HTTP — createApi over a real db/auth/admin and a fake RCON that
//   records every command: the v5 defaults are seeded; run builds exactly
//   `<command> 0|1` for toggles (value required, only 0|1, never user text)
//   and the stored command for plain rows; each run is audited
//   'quick-command' with the RCON response; GET's `last` is the newest run
//   per id the game server accepted (a failed or refused run never shows as
//   the state); replace validates and audits 'quick-commands-update'; a
//   stored row that no longer validates is never listed or run; permission
//   gating per route, including a role with quickcmd but not raw.
//   BattleMetrics wrappers over a fake module: passthrough, banListId
//   validation, audit, error mapping, token scrubbing, gating, 503 without a
//   module, and only `settings` may import a list other than the saved one.
//   Bans: panel bans carry the player's eos id; GET /api/bans rows carry
//   source + eosId; the list is capped with total/truncated and panel bans
//   fill the cap before imported ones.
const test = require('node:test');
const assert = require('node:assert');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin, validateQuickCommands } = require('../server/admin');
const { createApi } = require('../server/api');
const LiveState = require('../server/state');

const DEFAULT_ROWS = [
  { id: 'no-respawn-timer', label: 'No respawn timer', command: 'AdminNoRespawnTimer', toggle: true },
  { id: 'all-roles', label: 'All roles available', command: 'AdminForceAllRoleAvailability', toggle: true },
];

// ------------------------------------------------------------------ harness

// A real db/auth/admin/api stack on an ephemeral port. RCON is a fake that
// records commands; `reply(cmd)` shapes its answers (throw = exec failure).
async function harness(t, { reply, battlemetrics, config } = {}) {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = config || {};
  const auth = createAuth({ db, config: cfg });
  const sent = [];
  const rcon = {
    status: { connected: true, authed: true },
    async exec(cmd) {
      sent.push(cmd);
      return reply ? reply(cmd) : `Executed: ${cmd}`;
    },
  };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg, battlemetrics });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  let n = 0;
  // A logged-in client for a builtin role name or a custom perms object.
  function as(role) {
    n++;
    let roleRef = role;
    if (role && typeof role === 'object') roleRef = auth.createRole(`custom-${n}`, role).id;
    const u = auth.createUser(`user${n}`, 'password-123', roleRef);
    const cookie = `sw_session=${auth.createSession(u.id, {}).token}`;
    const call = async (method, p, body) => {
      const headers = { origin: base, accept: 'application/json', cookie };
      const init = { method, headers };
      if (method !== 'GET') {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body == null ? {} : body);
      }
      const res = await fetch(base + p, init);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_e) { json = null; }
      return { status: res.status, json, text };
    };
    return { user: u, get: (p) => call('GET', p), post: (p, body) => call('POST', p, body) };
  }

  const audits = (action) => db.prepare('SELECT * FROM admin_actions WHERE action = ? ORDER BY id').all(action);
  return { db, auth, admin, sent, as, audits };
}

// ------------------------------------------------- UNIT: list validation

test('validateQuickCommands: list rules from NEXT-CONTRACTS §2', () => {
  const ok = validateQuickCommands([
    { id: 'fog', label: '  Fog of war  ', command: ' AdminSetFogOfWar ', toggle: true },
    { id: 'restart-2', label: 'Restart', command: 'AdminRestartMatch' },
    { id: 'say-hi', label: 'Say hi', command: 'AdminBroadcast Welcome to A3 — have fun!', toggle: false },
  ]);
  assert.deepStrictEqual(ok.rows, [
    { id: 'fog', label: 'Fog of war', command: 'AdminSetFogOfWar', toggle: true },
    { id: 'restart-2', label: 'Restart', command: 'AdminRestartMatch', toggle: false },
    { id: 'say-hi', label: 'Say hi', command: 'AdminBroadcast Welcome to A3 — have fun!', toggle: false },
  ], 'labels/commands trimmed, toggle defaults to false');
  assert.deepStrictEqual(validateQuickCommands([]).rows, [], 'an empty list is allowed');

  const row = (o) => Object.assign({ id: 'x-1', label: 'X', command: 'AdminFoo', toggle: false }, o);
  const bad = [
    ['nope', /array/],
    [{ id: 'x-1' }, /array/],
    [Array.from({ length: 31 }, (_v, i) => row({ id: `r${i}` })), /at most 30/],
    [[row({ id: 'Upper' })], /id/],
    [[row({ id: '' })], /id/],
    [[row({ id: 'a'.repeat(41) })], /id/],
    [[row({ id: 'with space' })], /id/],
    [[row({ id: 'dup' }), row({ id: 'dup' })], /row 2: duplicate id "dup"/],
    [[row({ label: '' })], /label/],
    [[row({ label: '   ' })], /label/],
    [[row({ label: 'L'.repeat(41) })], /label/],
    [[row({ label: 'two\nlines' })], /label/],
    [[row({ label: 42 })], /label/],
    [[row({ command: '1Admin' })], /command/],
    [[row({ command: 'ab' })], /command/],
    [[row({ command: 'A'.repeat(65) })], /command/],
    [[row({ command: 'AdminFoo\nAdminBar' })], /command/],
    [[row({ command: 'AdminFoo x\u0000' })], /command/],
    [[row({ command: `AdminFoo ${'a'.repeat(201)}` })], /command/],
    [[row({ command: 'Admin-Foo' })], /command/],
    [[row({ command: 'AdminNoRespawnTimer 1', toggle: true })], /toggle must be a single bare command/],
    [[row({ toggle: 'yes' })], /toggle must be true or false/],
    [[null], /object/],
    [[['AdminFoo']], /object/],
  ];
  for (const [input, re] of bad) {
    const out = validateQuickCommands(input);
    assert.ok(out.error, `rejected: ${JSON.stringify(input).slice(0, 80)}`);
    assert.match(out.error, re);
  }
  // exactly 30 rows is fine; ids are unique per list, not per label
  assert.ok(validateQuickCommands(Array.from({ length: 30 }, (_v, i) => row({ id: `r${i}` }))).rows);
});

// ----------------------------------------------------------- IN-PROCESS HTTP

test('v5 defaults are seeded and listed; nothing has run yet', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const r = await owner.get('/api/quick-commands');
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json.rows, DEFAULT_ROWS);
  assert.deepStrictEqual(r.json.last, {});
});

test('run: a toggle sends exactly "<command> 0|1" and is audited with the RCON response', async (t) => {
  const h = await harness(t, { reply: (cmd) => `No respawn timer set (${cmd.split(' ')[1]})` });
  const owner = h.as('owner');

  const on = await owner.post('/api/quick-commands/no-respawn-timer/run', { value: 1 });
  assert.strictEqual(on.status, 200, on.text);
  assert.deepStrictEqual(on.json, {
    ok: true, rconOk: true, rconResponse: 'No respawn timer set (1)', command: 'AdminNoRespawnTimer 1',
  });
  const off = await owner.post('/api/quick-commands/no-respawn-timer/run', { value: 0 });
  assert.strictEqual(off.status, 200, off.text);
  assert.strictEqual(off.json.command, 'AdminNoRespawnTimer 0');
  assert.deepStrictEqual(h.sent, ['AdminNoRespawnTimer 1', 'AdminNoRespawnTimer 0']);

  const rows = h.audits('quick-command');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].user_id, owner.user.id);
  assert.strictEqual(rows[0].rcon_command, 'AdminNoRespawnTimer 1');
  assert.strictEqual(rows[0].rcon_response, 'No respawn timer set (1)');
  assert.strictEqual(rows[0].rcon_ok, 1);
  assert.deepStrictEqual(JSON.parse(rows[0].details), {
    id: 'no-respawn-timer', label: 'No respawn timer', command: 'AdminNoRespawnTimer', value: 1,
  });
});

test('run: toggle value is required and must be exactly 0 or 1 — no exec, no audit otherwise', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const bodies = [
    {}, { value: null }, { value: 2 }, { value: -1 }, { value: '1' }, { value: true },
    { value: 1.5 }, { value: '1; AdminKick everyone' }, { value: [1] }, { value: { v: 1 } },
  ];
  for (const body of bodies) {
    const r = await owner.post('/api/quick-commands/all-roles/run', body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body)} -> ${r.text}`);
    assert.match(r.json.error, /0 or 1/);
  }
  assert.deepStrictEqual(h.sent, [], 'nothing reached RCON');
  assert.strictEqual(h.audits('quick-command').length, 0, 'validation failures are not audited');
});

test('run: a plain row sends its stored command verbatim and refuses a value', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const save = await owner.post('/api/quick-commands', {
    rows: DEFAULT_ROWS.concat([{ id: 'fog-off', label: 'Fog off', command: 'AdminSetFogOfWar 0', toggle: false }]),
  });
  assert.strictEqual(save.status, 200, save.text);

  const withValue = await owner.post('/api/quick-commands/fog-off/run', { value: 1 });
  assert.strictEqual(withValue.status, 400);
  assert.match(withValue.json.error, /only accepted by toggle/);

  const run = await owner.post('/api/quick-commands/fog-off/run', {});
  assert.strictEqual(run.status, 200, run.text);
  assert.strictEqual(run.json.command, 'AdminSetFogOfWar 0');
  const nullValue = await owner.post('/api/quick-commands/fog-off/run', { value: null });
  assert.strictEqual(nullValue.status, 200, 'null counts as no value');
  assert.deepStrictEqual(h.sent, ['AdminSetFogOfWar 0', 'AdminSetFogOfWar 0']);
  const d = JSON.parse(h.audits('quick-command')[0].details);
  assert.deepStrictEqual(d, { id: 'fog-off', label: 'Fog off', command: 'AdminSetFogOfWar 0', value: null });
});

test('run: unknown or malformed ids are 404; an RCON failure is a 502 that is still audited', async (t) => {
  let fail = false;
  const h = await harness(t, {
    reply: (cmd) => {
      if (fail) throw new Error('not connected');
      return `ok ${cmd}`;
    },
  });
  const owner = h.as('owner');
  assert.strictEqual((await owner.post('/api/quick-commands/nope/run', { value: 1 })).status, 404);
  assert.strictEqual((await owner.post('/api/quick-commands/NO-RESPAWN-TIMER/run', { value: 1 })).status, 404);
  assert.strictEqual((await owner.post('/api/quick-commands/a%20b/run', { value: 1 })).status, 404);
  assert.deepStrictEqual(h.sent, []);

  fail = true;
  const r = await owner.post('/api/quick-commands/all-roles/run', { value: 1 });
  assert.strictEqual(r.status, 502, r.text);
  assert.match(r.json.error, /not connected/);
  const rows = h.audits('quick-command');
  assert.strictEqual(rows.length, 1, 'the attempt is on record');
  assert.strictEqual(rows[0].rcon_command, 'AdminForceAllRoleAvailability 1');
  assert.strictEqual(rows[0].rcon_ok, 0);
  assert.match(rows[0].rcon_response, /^ERROR: not connected/);
});

test('GET last: newest run per id with value, user and time', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const mod = h.as({ view: true, quickcmd: true });
  const t0 = Date.now();
  await owner.post('/api/quick-commands/no-respawn-timer/run', { value: 1 });
  await mod.post('/api/quick-commands/no-respawn-timer/run', { value: 0 });
  await owner.post('/api/quick-commands/all-roles/run', { value: 1 });
  // noise: other audit actions and a failed validation never count
  await owner.post('/api/quick-commands/all-roles/run', { value: 7 });
  h.auth.audit(owner.user.id, 'raw', { details: { id: 'all-roles', value: 0 } });

  const r = await owner.get('/api/quick-commands');
  assert.strictEqual(r.status, 200, r.text);
  const last = r.json.last;
  assert.deepStrictEqual(Object.keys(last).sort(), ['all-roles', 'no-respawn-timer']);
  assert.strictEqual(last['no-respawn-timer'].value, 0, 'the newest run wins');
  assert.strictEqual(last['no-respawn-timer'].by, mod.user.username);
  assert.ok(last['no-respawn-timer'].at >= t0);
  assert.deepStrictEqual(Object.keys(last['no-respawn-timer']).sort(), ['at', 'by', 'value'], 'the §2 shape');
  assert.strictEqual(last['all-roles'].value, 1);
  assert.strictEqual(last['all-roles'].by, owner.user.username);

  // a removed row drops out of `last` even though its history remains
  await owner.post('/api/quick-commands', { rows: [DEFAULT_ROWS[1]] });
  const after = await owner.get('/api/quick-commands');
  assert.deepStrictEqual(Object.keys(after.json.last), ['all-roles']);
});

test('GET last: a failed or refused run never replaces the state the server accepted', async (t) => {
  let mode = 'ok';
  const h = await harness(t, {
    reply: (cmd) => {
      if (mode === 'down') throw new Error('not connected');
      if (mode === 'refuse') return `Error: unable to run ${cmd}`;
      return `ok ${cmd}`;
    },
  });
  const owner = h.as('owner');
  const mod = h.as({ view: true, quickcmd: true });
  assert.strictEqual((await owner.post('/api/quick-commands/no-respawn-timer/run', { value: 1 })).status, 200);
  const accepted = (await owner.get('/api/quick-commands')).json.last['no-respawn-timer'];
  assert.deepStrictEqual(accepted, { value: 1, by: owner.user.username, at: accepted.at });

  mode = 'down'; // the exec throws: the OFF never reached the server
  assert.strictEqual((await mod.post('/api/quick-commands/no-respawn-timer/run', { value: 0 })).status, 502);
  mode = 'refuse'; // the server answered with an error
  const refused = await mod.post('/api/quick-commands/no-respawn-timer/run', { value: 0 });
  assert.strictEqual(refused.status, 200, refused.text);
  assert.strictEqual(refused.json.rconOk, false);
  mode = 'down'; // an id whose only run failed has no state at all
  assert.strictEqual((await mod.post('/api/quick-commands/all-roles/run', { value: 1 })).status, 502);
  assert.deepStrictEqual(h.audits('quick-command').map((a) => a.rcon_ok), [1, 0, 0, 0], 'every attempt is on record');

  const last = (await owner.get('/api/quick-commands')).json.last;
  assert.deepStrictEqual(last, { 'no-respawn-timer': accepted }, 'still ON by the owner, not the failed OFF');

  mode = 'ok';
  assert.strictEqual((await mod.post('/api/quick-commands/no-respawn-timer/run', { value: 0 })).status, 200);
  const now = (await owner.get('/api/quick-commands')).json.last['no-respawn-timer'];
  assert.strictEqual(now.value, 0, 'an accepted OFF is the new state');
  assert.strictEqual(now.by, mod.user.username);
});

test('replace: validates, persists, and audits added/changed/removed', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const bad = [
    {}, { rows: 'x' }, { rows: [{ id: 'Bad', label: 'x', command: 'AdminFoo' }] },
    { rows: [{ id: 'a', label: 'x', command: 'AdminFoo 1', toggle: true }] },
    { rows: Array.from({ length: 31 }, (_v, i) => ({ id: `r${i}`, label: 'x', command: 'AdminFoo' })) },
  ];
  for (const body of bad) {
    const r = await owner.post('/api/quick-commands', body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body).slice(0, 60)} -> ${r.text}`);
  }
  assert.strictEqual(h.audits('quick-commands-update').length, 0, 'rejected saves are not audited');
  assert.deepStrictEqual((await owner.get('/api/quick-commands')).json.rows, DEFAULT_ROWS, 'list untouched');

  const next = [
    { id: 'no-respawn-timer', label: 'Instant respawn', command: 'AdminNoRespawnTimer', toggle: true },
    { id: 'vehicles', label: 'All vehicles', command: 'AdminForceAllVehicleAvailability', toggle: true },
  ];
  const ok = await owner.post('/api/quick-commands', { rows: next });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.deepStrictEqual(ok.json, { ok: true, rows: next });
  assert.deepStrictEqual((await owner.get('/api/quick-commands')).json.rows, next, 'persisted');
  const stored = h.db.prepare("SELECT value FROM settings WHERE key = 'quickCommands'").get();
  assert.deepStrictEqual(JSON.parse(stored.value), next);

  const audit = h.audits('quick-commands-update');
  assert.strictEqual(audit.length, 1);
  assert.deepStrictEqual(JSON.parse(audit[0].details), {
    added: [next[1]], changed: [next[0]], removed: ['all-roles'],
  });
  const run = await owner.post('/api/quick-commands/vehicles/run', { value: 1 });
  assert.strictEqual(run.json.command, 'AdminForceAllVehicleAvailability 1');
  assert.strictEqual((await owner.post('/api/quick-commands/all-roles/run', { value: 1 })).status, 404,
    'a removed row can no longer run');
});

test('a stored row that no longer validates is never listed or run', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  h.db.prepare("UPDATE settings SET value = ? WHERE key = 'quickCommands'").run(JSON.stringify([
    { id: 'evil', label: 'Evil', command: 'AdminNoRespawnTimer 1\nAdminKick x', toggle: true },
    DEFAULT_ROWS[0],
    { id: 'no-respawn-timer', label: 'Dup', command: 'AdminFoo', toggle: false },
  ]));
  const r = await owner.get('/api/quick-commands');
  assert.deepStrictEqual(r.json.rows, [DEFAULT_ROWS[0]], 'invalid and duplicate rows dropped');
  assert.strictEqual((await owner.post('/api/quick-commands/evil/run', { value: 1 })).status, 404);

  h.db.prepare("UPDATE settings SET value = 'not json' WHERE key = 'quickCommands'").run();
  const junk = await owner.get('/api/quick-commands');
  assert.strictEqual(junk.status, 200);
  assert.deepStrictEqual(junk.json.rows, []);
  assert.deepStrictEqual(h.sent, []);
});

test('permission gating: list needs quickcmd|raw|settings, run needs quickcmd, replace needs settings', async (t) => {
  const h = await harness(t);
  const viewer = h.as('viewer');
  const admin = h.as('admin'); // builtin admin got quickcmd from the v5 migration
  const quickOnly = h.as({ view: true, quickcmd: true });
  const rawOnly = h.as({ view: true, raw: true });
  const settingsOnly = h.as({ view: true, settings: true });
  const rows = { rows: DEFAULT_ROWS };

  const expect = async (who, label, list, run, replace) => {
    assert.strictEqual((await who.get('/api/quick-commands')).status, list, `${label} list`);
    assert.strictEqual((await who.post('/api/quick-commands/all-roles/run', { value: 1 })).status, run, `${label} run`);
    assert.strictEqual((await who.post('/api/quick-commands', rows)).status, replace, `${label} replace`);
  };
  await expect(viewer, 'viewer', 403, 403, 403);
  await expect(admin, 'builtin admin', 200, 200, 403);
  await expect(quickOnly, 'quickcmd without raw', 200, 200, 403);
  await expect(rawOnly, 'raw only', 200, 403, 403);
  await expect(settingsOnly, 'settings only', 200, 403, 200);
  assert.deepStrictEqual(h.sent, ['AdminForceAllRoleAvailability 1', 'AdminForceAllRoleAvailability 1'],
    'only the two quickcmd holders reached RCON');
  assert.strictEqual((await quickOnly.post('/api/admin/raw', { command: 'ListPlayers' })).status, 403,
    'the quickcmd-only role still has no raw console');
});

// ------------------------------------------ BattleMetrics wrappers (§3)

function fakeBattlemetrics(overrides) {
  const calls = [];
  const mod = Object.assign({
    calls,
    status() {
      return { configured: true, running: false, lastSyncAt: 1700000000000, lastResult: null, nextSyncAt: null };
    },
    async listBanLists() { return [{ id: 'aa11-bb22', name: 'A3 bans', banCount: 3 }, { id: 'cc33', name: 'Shared', banCount: null }]; },
    async importNow(opts) {
      calls.push(opts);
      return { fetched: 3, imported: 2, updated: 1, deactivated: 0, skippedNoIdentifier: 0, errors: [] };
    },
    start() {}, stop() {}, reconfigure() {},
  }, overrides || {});
  return mod;
}

test('BattleMetrics routes are thin wrappers: passthrough, banListId check, audit', async (t) => {
  const bm = fakeBattlemetrics();
  const h = await harness(t, { battlemetrics: bm });
  const owner = h.as('owner');

  const st = await owner.get('/api/battlemetrics/status');
  assert.strictEqual(st.status, 200, st.text);
  assert.deepStrictEqual(st.json, bm.status());

  const lists = await owner.get('/api/battlemetrics/ban-lists');
  assert.strictEqual(lists.status, 200, lists.text);
  assert.deepStrictEqual(lists.json, await bm.listBanLists(), 'the listBanLists() array itself');

  const imp = await owner.post('/api/battlemetrics/import', {});
  assert.strictEqual(imp.status, 200, imp.text);
  assert.deepStrictEqual(imp.json, { fetched: 3, imported: 2, updated: 1, deactivated: 0, skippedNoIdentifier: 0, errors: [] });
  const withId = await owner.post('/api/battlemetrics/import', { banListId: 'aa11-bb22' });
  assert.strictEqual(withId.status, 200, withId.text);
  assert.deepStrictEqual(bm.calls, [{}, { banListId: 'aa11-bb22' }]);

  for (const banListId of ['../x', 'a b', 'x'.repeat(65), 7, { id: 'x' }]) {
    const r = await owner.post('/api/battlemetrics/import', { banListId });
    assert.strictEqual(r.status, 400, `${JSON.stringify(banListId)} -> ${r.text}`);
  }
  assert.strictEqual(bm.calls.length, 2, 'rejected ids never reach the module');

  const audit = h.audits('bm-import');
  assert.strictEqual(audit.length, 2);
  assert.deepStrictEqual(JSON.parse(audit[1].details), {
    banListId: 'aa11-bb22', fetched: 3, imported: 2, updated: 1, deactivated: 0, skippedNoIdentifier: 0, errors: 0,
  });
});

test('BattleMetrics errors: 502 (or the module status), audited, token scrubbed; 503 without a module', async (t) => {
  const token = 'bm-secret-token-123';
  let err = new Error(`BattleMetrics rejected token ${token}`);
  const bm = fakeBattlemetrics({
    async importNow() { throw err; },
    async listBanLists() { throw new Error('upstream down'); },
  });
  const h = await harness(t, { battlemetrics: bm, config: { battlemetrics: { token, banListId: '', autoSync: false, syncHours: 6 } } });
  const owner = h.as('owner');

  const r = await owner.post('/api/battlemetrics/import', {});
  assert.strictEqual(r.status, 502, r.text);
  assert.ok(!r.text.includes(token), 'token never echoed');
  assert.match(r.json.error, /rejected token •••/);
  const audit = h.audits('bm-import');
  assert.strictEqual(audit.length, 1, 'failed imports are audited');
  assert.ok(!audit[0].details.includes(token));

  err = Object.assign(new Error('an import is already running'), { status: 409 });
  assert.strictEqual((await owner.post('/api/battlemetrics/import', {})).status, 409);
  assert.strictEqual((await owner.get('/api/battlemetrics/ban-lists')).status, 502);

  const settings = await owner.get('/api/settings');
  assert.strictEqual(settings.status, 200, settings.text);
  assert.ok(!settings.text.includes(token), 'settings never echo the BattleMetrics token');
  assert.strictEqual(settings.json.secretsSet.battlemetricsToken, true);

  const none = await harness(t);
  const owner2 = none.as('owner');
  assert.strictEqual((await owner2.get('/api/battlemetrics/status')).status, 503);
  assert.strictEqual((await owner2.post('/api/battlemetrics/import', {})).status, 503);
  assert.strictEqual((await owner2.get('/api/settings')).json.secretsSet.battlemetricsToken, false);
});

test('BattleMetrics gating: status/ban-lists need settings, import needs settings or ban', async (t) => {
  const bm = fakeBattlemetrics();
  const h = await harness(t, { battlemetrics: bm });
  const viewer = h.as('viewer');
  const admin = h.as('admin'); // ban, not settings
  const settingsOnly = h.as({ view: true, settings: true });
  for (const [who, label, st, lists, imp] of [
    [viewer, 'viewer', 403, 403, 403],
    [admin, 'admin', 403, 403, 200],
    [settingsOnly, 'settings', 200, 200, 200],
  ]) {
    assert.strictEqual((await who.get('/api/battlemetrics/status')).status, st, `${label} status`);
    assert.strictEqual((await who.get('/api/battlemetrics/ban-lists')).status, lists, `${label} ban-lists`);
    assert.strictEqual((await who.post('/api/battlemetrics/import', {})).status, imp, `${label} import`);
  }
});

test('BattleMetrics import: only settings may name a list other than the saved one', async (t) => {
  const bm = fakeBattlemetrics();
  const config = { battlemetrics: { token: 'bm-token-xyz', banListId: 'aa11-bb22', autoSync: false, syncHours: 6 } };
  const h = await harness(t, { battlemetrics: bm, config });
  const admin = h.as('admin'); // ban, not settings
  const banOnly = h.as({ view: true, ban: true });
  const settingsOnly = h.as({ view: true, settings: true });

  for (const who of [admin, banOnly]) {
    const r = await who.post('/api/battlemetrics/import', { banListId: 'cc33' });
    assert.strictEqual(r.status, 403, r.text);
    assert.match(r.json.error, /other than the saved one needs the settings permission/);
  }
  assert.deepStrictEqual(bm.calls, [], 'a refused list never reaches the module');
  assert.strictEqual(h.audits('bm-import').length, 0);

  assert.strictEqual((await admin.post('/api/battlemetrics/import', {})).status, 200, 'ban re-syncs the saved list');
  assert.strictEqual((await banOnly.post('/api/battlemetrics/import', { banListId: 'aa11-bb22' })).status, 200,
    'naming the saved list is the same re-sync');
  assert.strictEqual((await settingsOnly.post('/api/battlemetrics/import', { banListId: 'cc33' })).status, 200,
    'settings may import any list');

  // the saved list is read live: Settings changes config in place
  config.battlemetrics.banListId = 'cc33';
  assert.strictEqual((await admin.post('/api/battlemetrics/import', { banListId: 'cc33' })).status, 200);
  assert.strictEqual((await admin.post('/api/battlemetrics/import', { banListId: 'aa11-bb22' })).status, 403);
  config.battlemetrics.banListId = '';
  assert.strictEqual((await admin.post('/api/battlemetrics/import', { banListId: 'cc33' })).status, 403,
    'with no saved list, only settings picks one');
  assert.deepStrictEqual(bm.calls, [{}, { banListId: 'aa11-bb22' }, { banListId: 'cc33' }, { banListId: 'cc33' }]);
});

// ------------------------------------------------- bans: source + eosId

test('GET /api/bans rows carry source and eosId; panel bans store the eos id', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const eos = '0002aaaabbbbccccddddeeeeffff0001';
  const now = Date.now();
  const pid = h.db.prepare('INSERT INTO players(eos_id, steam_id, name, first_seen, last_seen) VALUES(?,?,?,?,?)')
    .run(eos, '76561198000000001', 'Griefer', now, now).lastInsertRowid;

  const made = await owner.post('/api/bans', { playerId: pid, interval: '1d', reason: 'tk spree' });
  assert.strictEqual(made.status, 200, made.text);
  assert.strictEqual(made.json.ban.eosId, eos);
  assert.strictEqual(made.json.ban.source, null);
  assert.strictEqual(h.db.prepare('SELECT eos_id FROM bans WHERE id = ?').get(made.json.ban.id).eos_id, eos);

  h.db.prepare(
    `INSERT INTO bans(player_id, steam_id, eos_id, source, external_id, issued_at, expires_at, reason, active)
     VALUES(?,?,?,?,?,?,?,?,1)`
  ).run(pid, '76561198000000001', eos, 'battlemetrics', 'bm-ban-77', now, null, 'cheating [BM note]');

  const list = await owner.get('/api/bans');
  assert.strictEqual(list.status, 200, list.text);
  const [bmRow, panelRow] = list.json.rows;
  assert.strictEqual(bmRow.source, 'battlemetrics');
  assert.strictEqual(bmRow.eosId, eos);
  assert.strictEqual(panelRow.source, null);
  assert.strictEqual(panelRow.eosId, eos);
  for (const r of list.json.rows) assert.ok('source' in r && 'eosId' in r);
  const profile = await owner.get(`/api/players/${pid}`);
  assert.ok(profile.json.bans.every((b) => 'source' in b && 'eosId' in b), 'profile ban rows share the shape');
});

test('GET /api/bans: capped with total/truncated; an import never pushes panel bans out', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const now = Date.now();
  const panel = h.db.prepare('INSERT INTO bans(steam_id, issued_at, expires_at, reason, active) VALUES(?,?,NULL,?,?)');
  const imported = h.db.prepare(
    `INSERT INTO bans(steam_id, source, external_id, issued_at, expires_at, reason, active)
     VALUES(?, 'battlemetrics', ?, ?, NULL, 'bm', 1)`
  );
  // three panel bans (one lifted) issued before a 2100-ban import, one after
  const panelIds = [];
  const bmIds = [];
  h.db.tx(() => {
    for (let i = 0; i < 3; i++) {
      panelIds.push(panel.run(`7656119800000000${i}`, now, `panel ${i}`, i === 2 ? 0 : 1).lastInsertRowid);
    }
    for (let i = 0; i < 2100; i++) {
      bmIds.push(imported.run(`765611990${String(i).padStart(8, '0')}`, `bm-${i}`, now).lastInsertRowid);
    }
    panelIds.push(panel.run('76561198000000009', now, 'panel after', 1).lastInsertRowid);
  });
  const isDesc = (ids) => ids.every((id, i) => i === 0 || ids[i - 1] > id);

  const active = await owner.get('/api/bans?active=1');
  assert.strictEqual(active.status, 200, active.text);
  assert.strictEqual(active.json.total, 2103);
  assert.strictEqual(active.json.truncated, true);
  assert.strictEqual(active.json.rows.length, 2000);
  const ids = active.json.rows.map((r) => r.id);
  assert.ok(isDesc(ids), 'newest first');
  for (const id of [panelIds[0], panelIds[1], panelIds[3]]) assert.ok(ids.includes(id), `active panel ban ${id} listed`);
  const bmSet = new Set(bmIds);
  assert.deepStrictEqual(ids.filter((id) => bmSet.has(id)), bmIds.slice(-1997).reverse(),
    'the newest imported bans fill the rest');

  const all = await owner.get('/api/bans');
  assert.strictEqual(all.json.total, 2104);
  assert.strictEqual(all.json.truncated, true);
  assert.deepStrictEqual(all.json.rows.filter((r) => r.source === null).map((r) => r.id), panelIds.slice().reverse());

  const lifted = await owner.get('/api/bans?active=0');
  assert.strictEqual(lifted.json.total, 1);
  assert.strictEqual(lifted.json.truncated, false);
  assert.deepStrictEqual(lifted.json.rows.map((r) => r.id), [panelIds[2]]);
});
