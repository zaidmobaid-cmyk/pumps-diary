'use strict';
// Reason templates (docs/BATCH3-CONTRACTS.md §2).
//
// UNIT — validateTemplates: ≤ 60 rows; id /^[a-z0-9-]{1,40}$/ unique; kind
//   warn|kick|ban; label 1-40; reason 1-480 on one line (no CR/LF/NUL or
//   other control characters); a ban row needs an interval in admin.js's
//   INTERVAL syntax, other rows take none.
//
// IN-PROCESS HTTP — createApi with the templates module as an extension:
//   the v6 seeds are listed; any of warn/kick/ban/settings may read; only
//   settings may replace; a replace is normalized, persisted and audited
//   'templates-update' with added/changed/removed ids; a refused replace
//   saves and audits nothing; a stored row that no longer validates (or an
//   unreadable row) is never listed.
const test = require('node:test');
const assert = require('node:assert');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const { createTemplates, validateTemplates } = require('../server/templates');
const LiveState = require('../server/state');

// db.js v6 seeds.
const DEFAULTS = [
  { id: 'tk-warn', kind: 'warn', label: 'Teamkilling', reason: 'Teamkilling - check your targets. More TKs lead to a kick.' },
  { id: 'rules-warn', kind: 'warn', label: 'Server rules', reason: 'Please follow the server rules - see our Discord.' },
  { id: 'no-squad-kick', kind: 'kick', label: 'Not in a squad', reason: 'Join a squad - playing outside a squad is not allowed here.' },
  { id: 'toxic-kick', kind: 'kick', label: 'Toxic behaviour', reason: 'Toxic behaviour - kicked by an admin.' },
  { id: 'tk-ban', kind: 'ban', label: 'Intentional teamkilling', reason: 'Intentional teamkilling', interval: '3d' },
  { id: 'grief-ban', kind: 'ban', label: 'Griefing friendly assets', reason: 'Griefing friendly radios/HABs', interval: '1w' },
  { id: 'cheat-ban', kind: 'ban', label: 'Cheating', reason: 'Cheating', interval: '0' },
];

async function harness(t) {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = {};
  const auth = createAuth({ db, config: cfg });
  const rcon = { status: { connected: true, authed: true }, async exec(cmd) { return `Executed: ${cmd}`; } };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const logs = [];
  const log = { info() {}, warn: (tag, msg) => logs.push(msg), error: (tag, msg) => logs.push(msg) };
  const templates = createTemplates({ db, config: cfg, log, auth, dataDir: null });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg, extensions: [templates] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    auth.loginLimiter.stop();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  function as(role) {
    n++;
    let roleRef = role;
    if (role && typeof role === 'object') roleRef = auth.createRole(`custom-${n}`, role).id;
    const user = auth.createUser(`user${n}`, 'password-123', roleRef);
    const cookie = `sw_session=${auth.createSession(user.id, {}).token}`;
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
    return { user, get: (p) => call('GET', p), post: (p, body) => call('POST', p, body) };
  }
  const audits = (action) => db.prepare('SELECT * FROM admin_actions WHERE action = ? ORDER BY id').all(action);
  const stored = () => JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'reasonTemplates'").get().value);
  return { db, auth, cfg, logs, as, audits, stored };
}

const row = (o) => Object.assign({ id: 'x-1', kind: 'warn', label: 'X', reason: 'Do not do that' }, o);

// ------------------------------------------------------------------- UNIT

test('validateTemplates: list and row rules', () => {
  const ok = validateTemplates([
    { id: 'a', kind: 'warn', label: '  Spaced  ', reason: '  Trimmed reason\t(tab ok)  ', extra: 'dropped' },
    { id: 'b', kind: 'kick', label: 'Kick', reason: 'Bye', interval: '' },
    { id: 'c', kind: 'ban', label: 'Ban', reason: 'Gone', interval: ' 30m ' },
    { id: 'd', kind: 'ban', label: 'Perm', reason: 'Forever', interval: '0' },
    { id: 'e', kind: 'kick', label: 'Kick 2', reason: 'Bye', interval: null },
  ]);
  assert.deepStrictEqual(ok.rows, [
    { id: 'a', kind: 'warn', label: 'Spaced', reason: 'Trimmed reason\t(tab ok)' },
    { id: 'b', kind: 'kick', label: 'Kick', reason: 'Bye' },
    { id: 'c', kind: 'ban', label: 'Ban', reason: 'Gone', interval: '30m' },
    { id: 'd', kind: 'ban', label: 'Perm', reason: 'Forever', interval: '0' },
    { id: 'e', kind: 'kick', label: 'Kick 2', reason: 'Bye' },
  ], 'trimmed, unknown keys dropped, interval only on ban rows');
  assert.deepStrictEqual(validateTemplates([]).rows, []);
  assert.strictEqual(validateTemplates(Array.from({ length: 60 }, (_v, i) => row({ id: `r${i}` }))).rows.length, 60);

  const bad = [
    ['nope', /rows must be an array/],
    [{ 0: row() }, /rows must be an array/],
    [Array.from({ length: 61 }, (_v, i) => row({ id: `r${i}` })), /at most 60/],
    [[null], /object/],
    [[[row()]], /object/],
    [[row({ id: 'Upper' })], /id/],
    [[row({ id: '' })], /id/],
    [[row({ id: 'a'.repeat(41) })], /id/],
    [[row({ id: 'a b' })], /id/],
    [[row({ id: 7 })], /id/],
    [[row({ id: 'dup' }), row({ id: 'dup' })], /row 2: duplicate id "dup"/],
    [[row({ kind: 'mute' })], /kind/],
    [[row({ kind: undefined })], /kind/],
    [[row({ label: '' })], /label/],
    [[row({ label: '   ' })], /label/],
    [[row({ label: 'L'.repeat(41) })], /label/],
    [[row({ label: 'two\nlines' })], /label/],
    [[row({ label: 5 })], /label/],
    [[row({ reason: '' })], /reason/],
    [[row({ reason: '  ' })], /reason/],
    [[row({ reason: 'r'.repeat(481) })], /reason/],
    [[row({ reason: 'line\nbreak' })], /reason/],
    [[row({ reason: 'carriage\rreturn' })], /reason/],
    [[row({ reason: 'nul\u0000byte' })], /reason/],
    [[row({ reason: 'escape\u001b[31m' })], /reason/],
    [[row({ reason: ['x'] })], /reason/],
    [[row({ kind: 'ban' })], /ban template needs a duration/],
    [[row({ kind: 'ban', interval: '' })], /duration/],
    [[row({ kind: 'ban', interval: '2x' })], /duration/],
    [[row({ kind: 'ban', interval: '1000d' })], /duration/],
    [[row({ kind: 'ban', interval: '30s' })], /duration/],
    [[row({ kind: 'ban', interval: '0d' })], /duration/],
    [[row({ kind: 'ban', interval: '05d' })], /duration/],
    [[row({ kind: 'ban', interval: 3 })], /duration/],
    [[row({ kind: 'ban', interval: '1d; AdminKick x' })], /duration/],
    [[row({ kind: 'warn', interval: '1d' })], /only ban templates take a duration/],
    [[row({ kind: 'kick', interval: 0 })], /only ban templates take a duration/],
  ];
  for (const [input, re] of bad) {
    const out = validateTemplates(input);
    assert.ok(out.error, `rejected: ${JSON.stringify(input).slice(0, 80)}`);
    assert.match(out.error, re, JSON.stringify(input).slice(0, 80));
  }
  assert.strictEqual(validateTemplates([row({ reason: 'r'.repeat(480) })]).rows[0].reason.length, 480, '480 fits');
  assert.strictEqual(validateTemplates([row({ label: 'é'.repeat(40) })]).rows[0].label, 'é'.repeat(40), 'labels count characters');
});

// ---------------------------------------------------------- IN-PROCESS HTTP

test('GET: the v6 seeds; warn, kick, ban or settings may read; a viewer may not', async (t) => {
  const h = await harness(t);
  for (const [who, label, want] of [
    [h.as('owner'), 'owner', 200],
    [h.as('admin'), 'admin', 200],
    [h.as({ view: true, warn: true }), 'warn', 200],
    [h.as({ view: true, kick: true }), 'kick', 200],
    [h.as({ view: true, ban: true }), 'ban', 200],
    [h.as({ view: true, settings: true }), 'settings', 200],
    [h.as({ view: true, audit: true, flags: true }), 'audit+flags', 403],
    [h.as('viewer'), 'viewer', 403],
  ]) {
    const r = await who.get('/api/reason-templates');
    assert.strictEqual(r.status, want, `${label}: ${r.text}`);
    if (want === 200) assert.deepStrictEqual(r.json, { rows: DEFAULTS, maxMB: null }, label);
  }
  // The dialogs' evidence precheck learns the live upload limit from here.
  h.cfg.evidence = { maxMB: 75 };
  assert.strictEqual((await h.as({ view: true, warn: true }).get('/api/reason-templates')).json.maxMB, 75);
});

test('POST: settings only; normalized, persisted, audited with added/changed/removed ids', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const next = [
    Object.assign({}, DEFAULTS[0], { reason: 'Teamkilling - last warning.' }), // changed
    DEFAULTS[4], // unchanged
    { id: 'afk-kick', kind: 'kick', label: ' AFK ', reason: ' Away from keyboard ', interval: '' }, // added
    { id: 'alt-ban', kind: 'ban', label: 'Ban evasion', reason: 'Ban evasion (alt account)', interval: '1M', note: 'x' },
  ];
  for (const who of [h.as('admin'), h.as({ view: true, ban: true, warn: true, kick: true })]) {
    assert.strictEqual((await who.post('/api/reason-templates', { rows: next })).status, 403);
  }
  const r = await owner.post('/api/reason-templates', { rows: next });
  assert.strictEqual(r.status, 200, r.text);
  const want = [
    { id: 'tk-warn', kind: 'warn', label: 'Teamkilling', reason: 'Teamkilling - last warning.' },
    DEFAULTS[4],
    { id: 'afk-kick', kind: 'kick', label: 'AFK', reason: 'Away from keyboard' },
    { id: 'alt-ban', kind: 'ban', label: 'Ban evasion', reason: 'Ban evasion (alt account)', interval: '1M' },
  ];
  assert.deepStrictEqual(r.json, { ok: true, rows: want });
  assert.deepStrictEqual(h.stored(), want, 'persisted normalized');
  assert.deepStrictEqual((await h.as({ view: true, warn: true }).get('/api/reason-templates')).json.rows, want);

  const audit = h.audits('templates-update');
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].user_id, owner.user.id);
  assert.deepStrictEqual(JSON.parse(audit[0].details), {
    count: 4,
    added: ['afk-kick', 'alt-ban'],
    changed: ['tk-warn'],
    removed: ['rules-warn', 'no-squad-kick', 'toxic-kick', 'grief-ban', 'cheat-ban'],
  });

  const empty = await owner.post('/api/reason-templates', { rows: [] });
  assert.strictEqual(empty.status, 200, 'an empty list is allowed');
  assert.deepStrictEqual(h.stored(), []);
});

test('POST: a refused list saves nothing and audits nothing', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const bodies = [
    {},
    { rows: 'x' },
    { rows: [row({ kind: 'ban', interval: 'forever' })] },
    { rows: [row(), row()] },
    { rows: [row({ reason: 'two\nlines' })] },
    { rows: Array.from({ length: 61 }, (_v, i) => row({ id: `r${i}` })) },
  ];
  for (const body of bodies) {
    const r = await owner.post('/api/reason-templates', body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body).slice(0, 60)} -> ${r.text}`);
    assert.ok(r.json.error);
  }
  assert.deepStrictEqual(h.stored(), DEFAULTS, 'untouched');
  assert.strictEqual(h.audits('templates-update').length, 0);
});

test('a stored row that no longer validates is never listed; an unreadable value lists nothing', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  h.db.prepare("UPDATE settings SET value = ? WHERE key = 'reasonTemplates'").run(JSON.stringify([
    { id: 'evil', kind: 'warn', label: 'Evil', reason: 'line one\nAdminKick everyone' },
    DEFAULTS[0],
    { id: 'tk-warn', kind: 'kick', label: 'Dup', reason: 'dup id' },
    { id: 'no-interval', kind: 'ban', label: 'Ban', reason: 'x' },
    'not an object',
  ]));
  const r = await owner.get('/api/reason-templates');
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json.rows, [DEFAULTS[0]]);
  assert.strictEqual(h.logs.filter((l) => /stored reason template skipped/.test(l)).length, 4);

  h.db.prepare("UPDATE settings SET value = '{not json' WHERE key = 'reasonTemplates'").run();
  const junk = await owner.get('/api/reason-templates');
  assert.strictEqual(junk.status, 200);
  assert.deepStrictEqual(junk.json.rows, []);
  h.db.prepare("DELETE FROM settings WHERE key = 'reasonTemplates'").run();
  assert.deepStrictEqual((await owner.get('/api/reason-templates')).json.rows, [], 'no row at all');
});
