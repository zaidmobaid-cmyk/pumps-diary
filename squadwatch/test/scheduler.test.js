'use strict';
// Scheduler (docs/BATCH3-CONTRACTS.md §4).
//
// UNIT — validateTask normalization and rejections; next-run math: interval
//   grid (no drift, missed occurrences skipped), daily wall-clock times in a
//   fixed zone, DST gaps (the first valid instant after the gap) and
//   overlaps (the first occurrence only), and the real Europe/Berlin zone.
//
// ENGINE — a real db, a fake clock and zone, no-op timers (tick() is driven
//   by hand) and an admin recorder: broadcasts with live placeholders,
//   commands, RCON-down skips that wait for the next due time, conditions,
//   once tasks, missed occurrences, countdown sequencing (steps at their
//   offsets, stale steps dropped, late ones telling the time left, then
//   the action — missed after a stall), no overlapping runs, the opening
//   warning as a precondition, interruption on stop/restart, invalid
//   stored tasks, rows changed mid-tick read afresh.
//
// IN-PROCESS HTTP — createApi over a real db/auth/admin with a recording
//   fake RCON: CRUD, partial updates, audits, each kind's permissions
//   (raw, broadcast, match control) on top of settings, run-now as the
//   requesting user, 409 while running, disabling as the way to call off a
//   countdown, and a deleted task's run never writing onto its id's heir.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const LiveState = require('../server/state');
const {
  createScheduler, validateTask, firstRunAt, nextRunAfter, nextDaily, localOffsetMinutes,
} = require('../server/scheduler');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 2, 1, 9, 0, 0); // 2026-03-01 09:00Z = 10:00 at UTC+1
const UTC1 = () => 60;

// A CET/CEST-like zone with the 2026 EU transitions (01:00Z both days).
const SPRING = Date.UTC(2026, 2, 29, 1, 0, 0);
const AUTUMN = Date.UTC(2026, 9, 25, 1, 0, 0);
const EU = (ms) => (ms >= SPRING && ms < AUTUMN ? 120 : 60);

const NO_TIMERS = {
  setInterval: () => null, clearInterval: () => {}, setTimeout: () => null, clearTimeout: () => {},
};

function quietLog() {
  const lines = [];
  const push = (lvl) => (...a) => lines.push([lvl, ...a]);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

// ------------------------------------------------------------- validation

test('validateTask: normalizes every kind and schedule type', () => {
  const now = T0;
  const b = validateTask({
    name: '  Discord plug ', kind: 'broadcast', payload: { message: ' Join us {players}/{maxPlayers} ', junk: 1 },
    schedule: { type: 'interval', everyMinutes: '30' }, conditions: { minPlayers: '10', maxPlayers: null },
  }, { now });
  assert.deepStrictEqual(b.task, {
    name: 'Discord plug', kind: 'broadcast', payload: { message: 'Join us {players}/{maxPlayers}' },
    schedule: { type: 'interval', everyMinutes: 30 }, conditions: { minPlayers: 10 }, enabled: true,
  });

  const c = validateTask({
    name: 'Fog off', kind: 'command', payload: { command: ' AdminSetFogOfWar 0 ' },
    schedule: { type: 'daily', times: ['23:00', '06:30', '06:30', ' 12:00 '] }, conditions: {}, enabled: false,
  }, { now });
  assert.deepStrictEqual(c.task, {
    name: 'Fog off', kind: 'command', payload: { command: 'AdminSetFogOfWar 0' },
    schedule: { type: 'daily', times: ['06:30', '12:00', '23:00'] }, conditions: null, enabled: false,
  });

  const cd = validateTask({
    name: 'Nightly restart', kind: 'countdown',
    payload: { action: 'restartMatch', steps: [1, 10, '5', 5], message: 'Restart in {m} min' },
    schedule: { type: 'once', at: now + HOUR }, enabled: 1,
  }, { now });
  assert.deepStrictEqual(cd.task, {
    name: 'Nightly restart', kind: 'countdown',
    payload: { action: 'restartMatch', steps: [10, 5, 1], message: 'Restart in {m} min' },
    schedule: { type: 'once', at: now + HOUR }, conditions: null, enabled: true,
  });
});

test('validateTask: rejects malformed input with a reason', () => {
  const now = T0;
  const base = {
    name: 'x', kind: 'broadcast', payload: { message: 'hi' }, schedule: { type: 'interval', everyMinutes: 30 },
  };
  const cd = { kind: 'countdown', payload: { action: 'endMatch', steps: [5], message: 'End in {m}' } };
  const cases = [
    [null, /object/],
    [{ name: '' }, /name required/],
    [{ name: 'n'.repeat(61) }, /name must be at most 60/],
    [{ name: 'two\nlines' }, /name must be one line/],
    [{ kind: 'shell' }, /kind must be/],
    [{ payload: null }, /payload must be an object/],
    [{ payload: { message: '' } }, /message required/],
    [{ payload: { message: 'm'.repeat(401) } }, /at most 400/],
    [{ payload: { message: 'a\rb' } }, /one line/],
    [{ kind: 'command', payload: { command: '1Admin' } }, /RCON command name/],
    [{ kind: 'command', payload: { command: 'AdminFoo x\nAdminBar' } }, /RCON command name/],
    [{ kind: 'command', payload: { command: 'Ad' } }, /RCON command name/],
    [{ kind: 'command', payload: { command: `AdminFoo ${'a'.repeat(480)}` } }, /RCON command name/],
    [{ kind: 'command', payload: { command: 42 } }, /must be a string/],
    [{ ...cd, payload: { ...cd.payload, action: 'kickAll' } }, /restartMatch' or 'endMatch/],
    [{ ...cd, payload: { ...cd.payload, steps: [] } }, /1-10 steps/],
    [{ ...cd, payload: { ...cd.payload, steps: Array.from({ length: 11 }, (_v, i) => i + 1) } }, /1-10 steps/],
    [{ ...cd, payload: { ...cd.payload, steps: [0] } }, /from 1 to 60/],
    [{ ...cd, payload: { ...cd.payload, steps: [61] } }, /from 1 to 60/],
    [{ ...cd, payload: { ...cd.payload, steps: [1.5] } }, /from 1 to 60/],
    [{ ...cd, payload: { ...cd.payload, message: undefined } }, /message must be a string/],
    [{ schedule: null }, /schedule must be an object/],
    [{ schedule: { type: 'cron' } }, /schedule.type/],
    [{ schedule: { type: 'interval', everyMinutes: 4 } }, /5 to 1440/],
    [{ schedule: { type: 'interval', everyMinutes: 1441 } }, /5 to 1440/],
    [{ schedule: { type: 'interval', everyMinutes: 7.5 } }, /5 to 1440/],
    [{ schedule: { type: 'daily', times: [] } }, /1-24 times/],
    [{ schedule: { type: 'daily', times: Array.from({ length: 25 }, () => '01:00') } }, /1-24 times/],
    [{ schedule: { type: 'daily', times: ['24:00'] } }, /HH:MM/],
    [{ schedule: { type: 'daily', times: ['7:05'] } }, /HH:MM/],
    [{ schedule: { type: 'daily', times: [700] } }, /HH:MM/],
    [{ schedule: { type: 'once', at: 0 } }, /epoch milliseconds/],
    [{ schedule: { type: 'once', at: 'tomorrow' } }, /epoch milliseconds/],
    [{ schedule: { type: 'once', at: now + 400 * 24 * HOUR } }, /within the next year/],
    [{ conditions: [] }, /conditions must be an object/],
    [{ conditions: { minPlayers: -1 } }, /0 to 1000/],
    [{ conditions: { maxPlayers: 1001 } }, /0 to 1000/],
    [{ conditions: { minPlayers: 'lots' } }, /0 to 1000/],
    [{ conditions: { minPlayers: 50, maxPlayers: 10 } }, /cannot be above/],
    [{ enabled: 'yes' }, /enabled must be true or false/],
    [{ ...cd, schedule: { type: 'interval', everyMinutes: 5 } }, /shorter than the interval/],
  ];
  for (const [patch, re] of cases) {
    const input = patch === null ? null : Object.assign({}, base, patch);
    const out = validateTask(input, { now });
    assert.ok(out.error, `rejected: ${JSON.stringify(patch)}`);
    assert.match(out.error, re, JSON.stringify(patch));
  }
});

// ------------------------------------------------------------- next runs

test('interval: runs stay on the grid of the first run, however late each one is handled', () => {
  const s = { type: 'interval', everyMinutes: 30 };
  const first = firstRunAt(s, T0);
  assert.strictEqual(first, T0 + 30 * MIN);
  // handled 40 s late: the next is still on the grid
  assert.strictEqual(nextRunAfter(s, first, first + 40 * SEC), first + 30 * MIN);
  // handled exactly on time
  assert.strictEqual(nextRunAfter(s, first, first), first + 30 * MIN);
  // a long outage: occurrences already past are skipped, never replayed
  assert.strictEqual(nextRunAfter(s, first, first + 95 * MIN), first + 120 * MIN);
  assert.strictEqual(nextRunAfter(s, first, first + 90 * MIN), first + 120 * MIN, 'strictly after now');
  // a thousand late runs accumulate no drift
  let at = first;
  for (let i = 0; i < 1000; i++) at = nextRunAfter(s, at, at + 14 * SEC);
  assert.strictEqual(at, first + 1000 * 30 * MIN);
});

test('daily: the earliest listed local time after now, today or tomorrow', () => {
  const s = { type: 'daily', times: ['06:00', '12:30', '23:59'] };
  // T0 is 10:00 local (UTC+1)
  assert.strictEqual(firstRunAt(s, T0, UTC1), Date.UTC(2026, 2, 1, 11, 30));
  assert.strictEqual(nextRunAfter(s, Date.UTC(2026, 2, 1, 11, 30), Date.UTC(2026, 2, 1, 11, 30, 20), UTC1),
    Date.UTC(2026, 2, 1, 22, 59), 'a late tick stays on the wall clock');
  assert.strictEqual(nextDaily(s.times, Date.UTC(2026, 2, 1, 22, 59), UTC1), Date.UTC(2026, 2, 2, 5, 0),
    'after the last time: tomorrow\'s first');
  // west of UTC: local date differs from the UTC date
  const west = () => -300;
  assert.strictEqual(nextDaily(['20:00'], Date.UTC(2026, 2, 2, 0, 30), west), Date.UTC(2026, 2, 2, 1, 0),
    '19:30 local on Mar 1 -> 20:00 local the same local day');
});

test('daily across DST: a skipped time fires when the clocks jump, a repeated one fires once', () => {
  const s = { type: 'daily', times: ['01:30', '02:30', '03:30'] };
  // spring forward 2026-03-29: 02:00 CET -> 03:00 CEST; 02:30 does not exist
  let t = Date.UTC(2026, 2, 28, 23, 0); // 00:00 CET
  const spring = [];
  for (let i = 0; i < 4; i++) { t = nextDaily(s.times, t, EU); spring.push(new Date(t).toISOString()); }
  assert.deepStrictEqual(spring, [
    '2026-03-29T00:30:00.000Z', // 01:30 CET
    '2026-03-29T01:00:00.000Z', // 02:30 skipped -> 03:00 CEST, the moment of the jump
    '2026-03-29T01:30:00.000Z', // 03:30 CEST
    '2026-03-29T23:30:00.000Z', // 01:30 CEST the next day
  ]);
  // fall back 2026-10-25: 03:00 CEST -> 02:00 CET; 02:30 happens twice
  t = Date.UTC(2026, 9, 24, 22, 0); // 00:00 CEST
  const autumn = [];
  for (let i = 0; i < 4; i++) { t = nextDaily(s.times, t, EU); autumn.push(new Date(t).toISOString()); }
  assert.deepStrictEqual(autumn, [
    '2026-10-24T23:30:00.000Z', // 01:30 CEST
    '2026-10-25T00:30:00.000Z', // 02:30 CEST, the first of the two
    '2026-10-25T02:30:00.000Z', // 03:30 CET — the repeated 02:30 CET is not run again
    '2026-10-26T00:30:00.000Z', // 01:30 CET the next day
  ]);
});

test('daily in the real Europe/Berlin zone (process TZ) matches the model', (t) => {
  const prev = process.env.TZ;
  process.env.TZ = 'Europe/Berlin';
  t.after(() => { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; });
  if (localOffsetMinutes(Date.UTC(2026, 0, 15)) !== 60 || localOffsetMinutes(Date.UTC(2026, 6, 15)) !== 120) {
    t.skip('this runtime ignores a TZ change');
    return;
  }
  assert.strictEqual(nextDaily(['02:30'], Date.UTC(2026, 2, 28, 23, 0), localOffsetMinutes), SPRING);
  assert.strictEqual(nextDaily(['02:30'], Date.UTC(2026, 9, 24, 22, 0), localOffsetMinutes), Date.UTC(2026, 9, 25, 0, 30));
  assert.strictEqual(nextDaily(['02:30'], Date.UTC(2026, 9, 25, 0, 30), localOffsetMinutes), Date.UTC(2026, 9, 26, 1, 30));
});

// ----------------------------------------------------------------- engine

function fakeAdmin() {
  const calls = [];
  const admin = {
    calls,
    mode: 'ok', // 'ok' | 'down' | 'refuse'
    respond(command) {
      if (admin.mode === 'down') return { ok: false, error: 'RCON not connected', command, response: null, rconOk: false, auditId: calls.length };
      if (admin.mode === 'refuse') return { ok: true, rconOk: false, command, response: 'Error: unknown command', auditId: calls.length };
      return { ok: true, rconOk: true, command, response: `done: ${command}`, auditId: calls.length };
    },
    async execRaw(user, command, meta) {
      calls.push({ fn: 'execRaw', user, command, meta });
      return admin.respond(command);
    },
    async execAdmin(user, action, params) {
      calls.push({ fn: 'execAdmin', user, action, params });
      return admin.respond(action === 'restartMatch' ? 'AdminRestartMatch' : 'AdminEndMatch');
    },
  };
  return admin;
}

function engine(t, { tz = UTC1, t0 = T0 } = {}) {
  const db = openDb(':memory:');
  db.migrate();
  const bus = new EventEmitter();
  const clock = { t: t0 };
  const admin = fakeAdmin();
  const log = quietLog();
  const state = {
    serverInfo: { playerCount: 42, maxPlayers: 100, mapName: 'Sumari_AAS_v1', nextLayer: 'Kokan_RAAS_v1' },
    currentLayer: 'Sumari_AAS_v1', nextLayer: 'Kokan_RAAS_v1', players: new Map(), match: null,
  };
  const sched = createScheduler({
    db, bus, state, admin, auth: null, config: {}, log, now: () => clock.t, tzOffset: tz, timers: NO_TIMERS,
  });
  t.after(() => { sched.stop(); db.close(); });
  function add(input) {
    const v = validateTask(Object.assign({ name: 'task' }, input), { now: clock.t });
    assert.ok(v.task, v.error);
    const next = v.task.enabled ? firstRunAt(v.task.schedule, clock.t, tz) : null;
    return db.prepare(
      `INSERT INTO scheduled_tasks(name, kind, payload, schedule, conditions, enabled, next_run_at, created_at, updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)`
    ).run(v.task.name, v.task.kind, JSON.stringify(v.task.payload), JSON.stringify(v.task.schedule),
      v.task.conditions ? JSON.stringify(v.task.conditions) : null, v.task.enabled ? 1 : 0, next, clock.t, clock.t)
      .lastInsertRowid;
  }
  function row(id) {
    const r = db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id);
    return r ? Object.assign({}, r, { result: r.last_result ? JSON.parse(r.last_result) : null }) : null;
  }
  async function at(ms) { clock.t = ms; await sched.tick(); }
  const sent = () => admin.calls.map((c) => (c.fn === 'execRaw' ? c.command : `#${c.action}`));
  return { db, bus, clock, admin, log, state, sched, add, row, at, sent };
}

test('engine: an interval broadcast runs on its grid with live placeholders and records each run', async (t) => {
  const e = engine(t);
  const id = e.add({
    kind: 'broadcast', name: 'Status',
    payload: { message: 'Players {players}/{maxPlayers} on {layer}, next {nextLayer} at {time} {m}' },
    schedule: { type: 'interval', everyMinutes: 30 },
  });
  assert.strictEqual(e.row(id).next_run_at, T0 + 30 * MIN);

  await e.at(T0 + 29 * MIN);
  assert.deepStrictEqual(e.sent(), [], 'not due yet');

  await e.at(T0 + 30 * MIN + 40 * SEC);
  assert.deepStrictEqual(e.admin.calls, [{
    fn: 'execRaw', user: null,
    command: 'AdminBroadcast Players 42/100 on Sumari AAS v1, next Kokan RAAS v1 at 10:30 {m}',
    meta: { action: 'scheduled-run', details: { taskId: id, name: 'Status' } },
  }]);
  let r = e.row(id);
  assert.strictEqual(r.last_run_at, T0 + 30 * MIN + 40 * SEC);
  assert.strictEqual(r.next_run_at, T0 + 60 * MIN, 'next on the grid, not 30 min after the late run');
  assert.deepStrictEqual(r.result, { status: 'ok', message: 'broadcast sent' });

  await e.at(T0 + 30 * MIN + 55 * SEC);
  assert.strictEqual(e.admin.calls.length, 1, 'one run per occurrence');

  e.state.serverInfo.playerCount = 7;
  e.state.currentMap = { layer: 'SU_Sumari_Seed_v1', level: 'Sumari Bala', team1: null, team2: null };
  await e.at(T0 + 60 * MIN + 5 * SEC);
  assert.strictEqual(e.admin.calls.length, 2);
  assert.strictEqual(e.admin.calls[1].command,
    'AdminBroadcast Players 7/100 on SU Sumari Seed v1, next Kokan RAAS v1 at 11:00 {m}', 'ShowCurrentMap\'s layer first');
  assert.strictEqual(e.row(id).next_run_at, T0 + 90 * MIN);

  // the panel was down for over an hour: the overdue occurrence is missed
  await e.at(T0 + 175 * MIN);
  assert.strictEqual(e.admin.calls.length, 2, 'nothing sent late');
  r = e.row(id);
  assert.strictEqual(r.result.status, 'skipped');
  assert.match(r.result.message, /missed — the panel was not running at 11:30/);
  assert.strictEqual(r.next_run_at, T0 + 180 * MIN, 'back on the grid');
  assert.deepStrictEqual(e.log.lines.filter((l) => l[0] === 'error'), []);
});

test('engine: RCON down skips the occurrence, waits for the next due time, and a completed poll lifts it', async (t) => {
  const e = engine(t);
  e.sched.start(); // listens for polls (timers are no-ops)
  const id = e.add({ kind: 'broadcast', payload: { message: 'hello' }, schedule: { type: 'interval', everyMinutes: 10 } });

  e.admin.mode = 'down';
  await e.at(T0 + 10 * MIN);
  assert.strictEqual(e.admin.calls.length, 1, 'the attempt found RCON down');
  let r = e.row(id);
  assert.deepStrictEqual(r.result, { status: 'skipped', message: 'RCON not connected' });
  assert.strictEqual(r.next_run_at, T0 + 20 * MIN, 'retried at the next due time, not on every tick');

  await e.at(T0 + 10 * MIN + 15 * SEC);
  await e.at(T0 + 10 * MIN + 30 * SEC);
  assert.strictEqual(e.admin.calls.length, 1, 'no retry before the next due time');

  await e.at(T0 + 20 * MIN);
  assert.strictEqual(e.admin.calls.length, 1, 'known down: skipped without another exec');
  r = e.row(id);
  assert.strictEqual(r.result.status, 'skipped');
  assert.strictEqual(r.next_run_at, T0 + 30 * MIN);

  e.admin.mode = 'ok';
  e.bus.emit('players-updated'); // a poll completed: RCON is back
  await e.at(T0 + 30 * MIN);
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast hello', 'AdminBroadcast hello']);
  assert.strictEqual(e.row(id).result.status, 'ok');
});

test('engine: conditions skip (and record) occurrences outside the player range', async (t) => {
  const e = engine(t);
  const id = e.add({
    kind: 'broadcast', payload: { message: 'seeding!' }, schedule: { type: 'interval', everyMinutes: 10 },
    conditions: { minPlayers: 50, maxPlayers: 80 },
  });
  await e.at(T0 + 10 * MIN);
  assert.deepStrictEqual(e.sent(), []);
  assert.deepStrictEqual(e.row(id).result, { status: 'skipped', message: '42 player(s) online, needs at least 50' });
  assert.strictEqual(e.row(id).last_run_at, T0 + 10 * MIN, 'the skip is when it was handled');

  e.state.serverInfo.playerCount = 90;
  await e.at(T0 + 20 * MIN);
  assert.deepStrictEqual(e.row(id).result, { status: 'skipped', message: '90 player(s) online, needs at most 80' });

  // no count from ShowServerInfo: the live roster is the count
  e.state.serverInfo.playerCount = null;
  for (let i = 0; i < 60; i++) e.state.players.set(`eos${i}`, {});
  await e.at(T0 + 30 * MIN);
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast seeding!']);
});

test('engine: once runs at its time and disables itself; found too late it is missed, never run late', async (t) => {
  const e = engine(t);
  const a = e.add({ kind: 'broadcast', payload: { message: 'event starts' }, schedule: { type: 'once', at: T0 + 10 * MIN } });
  const b = e.add({ kind: 'broadcast', payload: { message: 'too late' }, schedule: { type: 'once', at: T0 + 12 * MIN } });

  await e.at(T0 + 10 * MIN + 5 * SEC);
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast event starts']);
  assert.strictEqual(e.row(a).enabled, 0);
  assert.strictEqual(e.row(a).next_run_at, null);
  assert.strictEqual(e.row(a).result.status, 'ok');

  await e.at(T0 + 18 * MIN); // b is 6 minutes overdue
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast event starts'], 'nothing sent late');
  assert.strictEqual(e.row(b).enabled, 0);
  assert.strictEqual(e.row(b).result.status, 'skipped');
  assert.match(e.row(b).result.message, /^missed/);

  await e.at(T0 + 2 * HOUR);
  assert.strictEqual(e.admin.calls.length, 1, 'neither runs again');
});

test('engine: daily runs keep the wall clock; downtime past the grace is a missed occurrence', async (t) => {
  const e = engine(t);
  const id = e.add({ kind: 'broadcast', payload: { message: 'daily' }, schedule: { type: 'daily', times: ['04:00', '16:00'] } });
  assert.strictEqual(e.row(id).next_run_at, Date.UTC(2026, 2, 1, 15, 0));
  await e.at(Date.UTC(2026, 2, 1, 15, 0, 20));
  assert.strictEqual(e.admin.calls.length, 1);
  assert.strictEqual(e.row(id).next_run_at, Date.UTC(2026, 2, 2, 3, 0));
  await e.at(Date.UTC(2026, 2, 2, 4, 30)); // 05:30 local: the 04:00 run was 90 minutes ago
  assert.strictEqual(e.admin.calls.length, 1, 'not run 90 minutes late');
  assert.match(e.row(id).result.message, /missed — the panel was not running at 04:00/);
  assert.strictEqual(e.row(id).next_run_at, Date.UTC(2026, 2, 2, 15, 0));
});

test('engine: a command runs verbatim; a refused reply is a failed run', async (t) => {
  const e = engine(t);
  const id = e.add({ kind: 'command', payload: { command: 'AdminSetFogOfWar 0' }, schedule: { type: 'interval', everyMinutes: 5 } });
  await e.at(T0 + 5 * MIN);
  assert.deepStrictEqual(e.sent(), ['AdminSetFogOfWar 0']);
  assert.deepStrictEqual(e.row(id).result, { status: 'ok', message: 'done: AdminSetFogOfWar 0' });
  e.admin.mode = 'refuse';
  await e.at(T0 + 10 * MIN);
  assert.deepStrictEqual(e.row(id).result, { status: 'failed', message: 'server replied: Error: unknown command' });
});

test('engine: a countdown warns at each step\'s offset, then runs the action', async (t) => {
  const e = engine(t);
  const S = T0 + 5 * MIN;
  const id = e.add({
    kind: 'countdown', name: 'Restart',
    payload: { action: 'restartMatch', steps: [1, 10, 5], message: 'Restart in {m} min ({players} online)' },
    schedule: { type: 'once', at: S },
  });
  await e.at(S);
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast Restart in 10 min (42 online)']);
  assert.deepStrictEqual(e.admin.calls[0].meta, { action: 'scheduled-run', details: { step: 10, taskId: id, name: 'Restart' } });
  assert.strictEqual(e.row(id).result.status, 'running');
  assert.match(e.row(id).result.message, /restartMatch at 10:15/);
  assert.strictEqual(e.row(id).enabled, 1, 'stays enabled while running, so disabling can call it off');

  await e.at(S + 4 * MIN + 59 * SEC);
  assert.strictEqual(e.admin.calls.length, 1, 'nothing before the 5-minute mark');
  await e.at(S + 5 * MIN);
  await e.at(S + 5 * MIN + 15 * SEC);
  await e.at(S + 9 * MIN);
  assert.deepStrictEqual(e.sent().slice(1), ['AdminBroadcast Restart in 5 min (42 online)', 'AdminBroadcast Restart in 1 min (42 online)']);
  await e.at(S + 9 * MIN + 59 * SEC);
  assert.strictEqual(e.admin.calls.length, 3, 'the action waits for zero');

  await e.at(S + 10 * MIN);
  assert.deepStrictEqual(e.admin.calls[3], { fn: 'execAdmin', user: null, action: 'restartMatch', params: {} });
  const r = e.row(id);
  assert.deepStrictEqual(r.result, { status: 'ok', message: 'restartMatch sent after 3 warning(s)' });
  assert.strictEqual(r.last_run_at, S, 'the run is dated by its start');
  assert.strictEqual(r.enabled, 0, 'once: used up');
  await e.at(S + 30 * MIN);
  assert.strictEqual(e.admin.calls.length, 4, 'nothing after the action');
});

test('engine: a late countdown tick sends only the latest due warning; past zero, only the action', async (t) => {
  const e = engine(t);
  const S = T0 + 60 * MIN; // the first run, one interval after creation
  e.add({
    kind: 'countdown', payload: { action: 'endMatch', steps: [10, 5, 2], message: 'End in {m}' },
    schedule: { type: 'interval', everyMinutes: 60 },
  });
  await e.at(S);
  await e.at(S + 8 * MIN + 30 * SEC); // the 5 and 2 marks are both due: only "2" is still true
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast End in 10', 'AdminBroadcast End in 2']);
  await e.at(S + 10 * MIN);
  assert.deepStrictEqual(e.sent().slice(2), ['#endMatch']);

  // the next occurrence, with the panel stalled past zero: no stale warnings
  await e.at(S + 60 * MIN);
  await e.at(S + 71 * MIN);
  assert.deepStrictEqual(e.sent().slice(3), ['AdminBroadcast End in 10', '#endMatch']);
  assert.match(e.db.prepare('SELECT last_result FROM scheduled_tasks').get().last_result, /endMatch sent after 1 warning/);
});

test('engine: a countdown action that comes due during a stall is missed, never sent late; a late warning tells the time left', async (t) => {
  const e = engine(t);
  const S = T0 + 5 * MIN;
  const id = e.add({
    kind: 'countdown', payload: { action: 'restartMatch', steps: [10, 1], message: 'Restart in {m} min' },
    schedule: { type: 'once', at: S },
  });
  await e.at(S);
  // the panel's PC slept two minutes in and woke five and a half hours later
  await e.at(S + 5 * HOUR + 30 * MIN);
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast Restart in 10 min'], 'no stale warning, no restart into a live match');
  const r = e.row(id);
  assert.deepStrictEqual(r.result, {
    status: 'skipped', message: 'missed — the panel stalled; restartMatch was due at 10:15 and was not sent',
  });
  assert.strictEqual(r.last_run_at, S);
  assert.strictEqual(r.enabled, 0, 'once: used up');
  await e.at(S + 6 * HOUR);
  assert.strictEqual(e.admin.calls.length, 1, 'nothing afterwards either');

  // a stall that ends before zero: the warning says what is really left,
  // and an action a little late (inside the grace) still goes out
  const S2 = S + 7 * HOUR;
  const id2 = e.add({
    kind: 'countdown', payload: { action: 'endMatch', steps: [10, 5], message: 'End in {m} min' },
    schedule: { type: 'once', at: S2 },
  });
  await e.at(S2);
  await e.at(S2 + 9 * MIN + 30 * SEC); // the 5-minute mark passed 4.5 minutes ago
  assert.deepStrictEqual(e.sent().slice(1), ['AdminBroadcast End in 10 min', 'AdminBroadcast End in 1 min']);
  await e.at(S2 + 11 * MIN + 30 * SEC);
  assert.deepStrictEqual(e.sent().slice(3), ['#endMatch']);
  assert.deepStrictEqual(e.row(id2).result, { status: 'ok', message: 'endMatch sent after 2 warning(s)' });
});

test('engine: a task deleted, disabled or edited while an earlier one\'s exec is in flight is read afresh', async (t) => {
  const e = engine(t);
  const daily = (hm) => ({ type: 'daily', times: [hm] });
  const due = Date.UTC(2026, 2, 1, 9, 30); // 10:30 local
  const a = e.add({ name: 'A', kind: 'broadcast', payload: { message: 'slow one' }, schedule: daily('10:30') });
  const b = e.add({ name: 'B', kind: 'command', payload: { command: 'AdminKickAll everyone' }, schedule: daily('10:30') });
  const c = e.add({ name: 'C', kind: 'broadcast', payload: { message: 'old text' }, schedule: daily('10:30') });
  const d = e.add({ name: 'D', kind: 'broadcast', payload: { message: 'once' }, schedule: { type: 'once', at: due } });
  const f = e.add({ name: 'F', kind: 'broadcast', payload: { message: 'turned off' }, schedule: daily('10:30') });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  e.admin.execRaw = async (user, command, meta) => {
    e.admin.calls.push({ fn: 'execRaw', user, command, meta });
    if (command === 'AdminBroadcast slow one') await gate;
    return e.admin.respond(command);
  };
  e.clock.t = due + 5 * SEC;
  const tick = e.sched.tick();
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast slow one'], 'A\'s exec is in flight');
  // meanwhile, what the API routes write: B deleted, C and D moved, F disabled
  e.db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(b);
  e.db.prepare('UPDATE scheduled_tasks SET payload = ?, schedule = ?, next_run_at = ? WHERE id = ?')
    .run(JSON.stringify({ message: 'new text' }), JSON.stringify(daily('11:00')), Date.UTC(2026, 2, 1, 10, 0), c);
  e.db.prepare('UPDATE scheduled_tasks SET schedule = ?, next_run_at = ? WHERE id = ?')
    .run(JSON.stringify({ type: 'once', at: Date.UTC(2026, 2, 1, 11, 0) }), Date.UTC(2026, 2, 1, 11, 0), d);
  e.db.prepare('UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL WHERE id = ?').run(f);
  release();
  await tick;
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast slow one'], 'nothing ran from the rows as the tick first saw them');
  assert.strictEqual(e.row(a).result.status, 'ok');
  assert.strictEqual(e.row(c).next_run_at, Date.UTC(2026, 2, 1, 10, 0), 'C keeps today\'s new time');
  assert.strictEqual(e.row(c).last_result, null);
  assert.strictEqual(e.row(d).enabled, 1, 'the re-armed once task stays armed');
  assert.strictEqual(e.row(d).next_run_at, Date.UTC(2026, 2, 1, 11, 0));
  assert.strictEqual(e.row(f).enabled, 0);
  assert.strictEqual(e.row(f).last_result, null);

  await e.at(Date.UTC(2026, 2, 1, 10, 0, 5));
  await e.at(Date.UTC(2026, 2, 1, 11, 0, 5));
  assert.deepStrictEqual(e.sent().slice(1), ['AdminBroadcast new text', 'AdminBroadcast once'], 'each at its new time');
});

test('engine: a task never runs twice at once — an occurrence due mid-countdown is skipped', async (t) => {
  const e = engine(t);
  const id = e.add({
    kind: 'countdown', payload: { action: 'restartMatch', steps: [10], message: 'Restart in {m}' },
    schedule: { type: 'daily', times: ['10:30', '10:35'] },
  });
  await e.at(Date.UTC(2026, 2, 1, 9, 30));
  await e.at(Date.UTC(2026, 2, 1, 9, 35));
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast Restart in 10'], 'the 10:35 occurrence did not start a second countdown');
  assert.strictEqual(e.row(id).result.status, 'running', 'the row still shows the countdown in progress');
  assert.strictEqual(e.row(id).next_run_at, Date.UTC(2026, 2, 2, 9, 30), 'the skipped occurrence is used up');
  assert.ok(e.log.lines.some((l) => /10:35 occurrence was skipped — the previous run was still going/.test(l[2])));
  await e.at(Date.UTC(2026, 2, 1, 9, 40));
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast Restart in 10', '#restartMatch']);
  assert.strictEqual(e.row(id).result.status, 'ok');
  assert.strictEqual(e.row(id).next_run_at, Date.UTC(2026, 2, 2, 9, 30));
});

test('engine: without its opening warning a countdown is called off — no unannounced restart', async (t) => {
  const e = engine(t);
  const id = e.add({
    kind: 'countdown', payload: { action: 'restartMatch', steps: [5, 1], message: 'Restart in {m}' },
    schedule: { type: 'once', at: T0 + MIN },
  });
  e.admin.mode = 'down';
  await e.at(T0 + MIN);
  e.admin.mode = 'ok';
  await e.at(T0 + 6 * MIN);
  await e.at(T0 + 20 * MIN);
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast Restart in 5'], 'no action, no further warnings');
  assert.deepStrictEqual(e.row(id).result, { status: 'skipped', message: 'countdown not started — RCON not connected' });
  assert.strictEqual(e.row(id).enabled, 0);
});

test('engine: a countdown cut off by stop() or a restart is reported, never resumed', async (t) => {
  const e = engine(t);
  const id = e.add({
    kind: 'countdown', payload: { action: 'restartMatch', steps: [10], message: 'Restart in {m}' },
    schedule: { type: 'once', at: T0 + MIN },
  });
  await e.at(T0 + MIN);
  e.sched.stop();
  assert.deepStrictEqual(e.row(id).result, { status: 'failed', message: 'interrupted — the panel stopped during the countdown' });
  assert.strictEqual(e.row(id).enabled, 0);
  await e.at(T0 + 20 * MIN);
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast Restart in 10'], 'no action after stop');

  // a crash leaves the row "running": the next boot says what happened
  const other = e.add({ kind: 'broadcast', payload: { message: 'x' }, schedule: { type: 'interval', everyMinutes: 30 } });
  e.db.prepare('UPDATE scheduled_tasks SET last_result = ?, last_run_at = ? WHERE id = ?')
    .run(JSON.stringify({ status: 'running', message: 'countdown started' }), T0, other);
  const again = createScheduler({ db: e.db, bus: e.bus, state: e.state, admin: e.admin, log: quietLog(), now: () => e.clock.t, timers: NO_TIMERS });
  again.start();
  t.after(() => again.stop());
  assert.deepStrictEqual(e.row(other).result, { status: 'failed', message: 'interrupted — the panel restarted during the countdown' });
  assert.strictEqual(e.row(other).last_run_at, T0);
  assert.strictEqual(e.row(other).enabled, 1, 'an interval task keeps its schedule');
});

test('engine: an error mid-countdown ends that run as failed instead of blocking the task', async (t) => {
  const e = engine(t);
  const id = e.add({
    kind: 'countdown', payload: { action: 'restartMatch', steps: [10, 5], message: 'Restart in {m} ({players})' },
    schedule: { type: 'interval', everyMinutes: 60 },
  });
  const S = T0 + 60 * MIN;
  await e.at(S);
  let boom = true;
  const si = e.state.serverInfo;
  Object.defineProperty(e.state, 'serverInfo', {
    configurable: true,
    get() { if (boom) throw new Error('state exploded'); return si; },
  });
  await e.at(S + 5 * MIN);
  assert.deepStrictEqual(e.row(id).result, { status: 'failed', message: 'countdown stopped: state exploded' });
  boom = false;
  await e.at(S + 10 * MIN);
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast Restart in 10 (42)'], 'the broken run never reaches its action');
  await e.at(S + 60 * MIN);
  assert.deepStrictEqual(e.sent().slice(1), ['AdminBroadcast Restart in 10 (42)'], 'the next occurrence starts normally');
});

test('engine: start() ticks every 15 s and wakes exactly at the next countdown mark', async (t) => {
  const armed = [];
  const timers = {
    setInterval: (fn, ms) => { armed.push({ kind: 'interval', fn, ms }); return { unref() {} }; },
    clearInterval: () => {},
    setTimeout: (fn, ms) => { const h = { kind: 'timeout', fn, ms, unref() {} }; armed.push(h); return h; },
    clearTimeout: (h) => { if (h) h.cleared = true; },
  };
  const db = openDb(':memory:');
  db.migrate();
  const clock = { t: T0 };
  const admin = fakeAdmin();
  const sched = createScheduler({ db, bus: new EventEmitter(), state: {}, admin, log: quietLog(), now: () => clock.t, tzOffset: UTC1, timers });
  t.after(() => { sched.stop(); db.close(); });
  sched.start();
  assert.deepStrictEqual(armed.map((a) => [a.kind, a.ms]), [['interval', 15000]]);

  const v = validateTask({
    name: 'cd', kind: 'countdown', payload: { action: 'endMatch', steps: [3, 1], message: 'End in {m}' },
    schedule: { type: 'once', at: T0 + MIN },
  }, { now: T0 });
  db.prepare(`INSERT INTO scheduled_tasks(name, kind, payload, schedule, enabled, next_run_at) VALUES(?,?,?,?,1,?)`)
    .run('cd', 'countdown', JSON.stringify(v.task.payload), JSON.stringify(v.task.schedule), T0 + MIN);
  // the 15 s tick finds it due 3 s late; the countdown runs from its real start
  const S = T0 + MIN + 3 * SEC;
  clock.t = S;
  armed[0].fn();
  await sched.tick();
  const wake = armed.filter((a) => a.kind === 'timeout' && !a.cleared).pop();
  assert.strictEqual(wake.ms, 2 * MIN + 10, 'armed for the 1-minute mark, not the next 15 s tick');
  clock.t = S + 2 * MIN;
  wake.fn();
  await sched.tick();
  assert.deepStrictEqual(admin.calls.map((c) => c.command || c.action), ['AdminBroadcast End in 3', 'AdminBroadcast End in 1']);
  const next = armed.filter((a) => a.kind === 'timeout' && !a.cleared).pop();
  assert.strictEqual(next.ms, MIN + 10, 'then for zero');
});

test('engine: live values cannot smuggle a second command into a broadcast', async (t) => {
  const e = engine(t);
  e.state.currentLayer = 'Evil\nAdminKick 76561198000000001 bye';
  e.state.serverInfo.maxPlayers = '100\r\nAdminEndMatch';
  e.add({ kind: 'broadcast', payload: { message: '{layer} {maxPlayers}' }, schedule: { type: 'interval', everyMinutes: 5 } });
  await e.at(T0 + 5 * MIN);
  assert.deepStrictEqual(e.sent(), ['AdminBroadcast Evil AdminKick 76561198000000001 bye 100  AdminEndMatch']);
  assert.ok(!/[\r\n]/.test(e.sent()[0]));
});

test('engine: a stored task that no longer validates is disabled, never run', async (t) => {
  const e = engine(t);
  const id = e.add({ kind: 'command', payload: { command: 'AdminSetFogOfWar 0' }, schedule: { type: 'interval', everyMinutes: 5 } });
  e.db.prepare('UPDATE scheduled_tasks SET payload = ? WHERE id = ?').run(JSON.stringify({ command: 'AdminFoo\nAdminKick x' }), id);
  await e.at(T0 + 5 * MIN);
  assert.deepStrictEqual(e.sent(), []);
  const r = e.row(id);
  assert.strictEqual(r.enabled, 0);
  assert.strictEqual(r.next_run_at, null);
  assert.match(r.result.message, /^invalid task: command must be/);
});

// --------------------------------------------------------- in-process HTTP

async function harness(t, { reply } = {}) {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = {};
  const bus = new EventEmitter();
  const auth = createAuth({ db, config: cfg });
  const sentCmds = [];
  const rcon = {
    status: { connected: true, authed: true },
    async exec(cmd) {
      sentCmds.push(cmd);
      return reply ? reply(cmd) : `Executed: ${cmd}`;
    },
  };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const sched = createScheduler({ db, bus, state, admin, auth, config: cfg, log: quietLog(), timers: NO_TIMERS });
  const server = createApi({ db, state, rcon, bus, auth, admin, config: cfg, extensions: [sched] });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => sched.stop());
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  function as(role) {
    n++;
    const roleRef = role && typeof role === 'object' ? auth.createRole(`custom-${n}`, role).id : role;
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
  return { db, auth, sched, sentCmds, as, audits };
}

const BROADCAST = {
  name: 'Discord', kind: 'broadcast', payload: { message: 'Join our Discord! {players} online' },
  schedule: { type: 'interval', everyMinutes: 30 },
};

test('HTTP: create, list, partial update and delete — validated, audited, settings-only', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const viewer = h.as('viewer');
  const admin = h.as('admin'); // moderation perms, no settings

  for (const who of [viewer, admin]) {
    assert.strictEqual((await who.get('/api/schedules')).status, 403);
    assert.strictEqual((await who.post('/api/schedules', BROADCAST)).status, 403);
  }

  const before = Date.now();
  const made = await owner.post('/api/schedules', BROADCAST);
  assert.strictEqual(made.status, 200, made.text);
  const row = made.json.row;
  assert.deepStrictEqual(Object.keys(row).sort(), [
    'conditions', 'createdAt', 'createdBy', 'enabled', 'id', 'kind', 'lastResult', 'lastRunAt', 'lastStatus',
    'name', 'nextRunAt', 'payload', 'runEndsAt', 'running', 'schedule', 'updatedAt',
  ]);
  assert.strictEqual(row.enabled, true);
  assert.strictEqual(row.createdBy, owner.user.id);
  assert.ok(row.nextRunAt >= before + 30 * MIN && row.nextRunAt <= Date.now() + 30 * MIN, 'first run one interval out');
  assert.deepStrictEqual(row.payload, BROADCAST.payload);
  assert.strictEqual(row.lastResult, null);
  const created = h.audits('schedule-create');
  assert.strictEqual(created.length, 1);
  assert.deepStrictEqual(JSON.parse(created[0].details), {
    taskId: row.id, name: 'Discord', kind: 'broadcast', payload: BROADCAST.payload,
    schedule: BROADCAST.schedule, conditions: null, enabled: true,
  });

  const list = await owner.get('/api/schedules');
  assert.strictEqual(list.status, 200, list.text);
  assert.deepStrictEqual(list.json.rows.map((r) => r.id), [row.id]);
  assert.deepStrictEqual(Object.keys(list.json.placeholders).sort(), ['layer', 'maxPlayers', 'nextLayer', 'players', 'time']);
  assert.strictEqual(typeof list.json.utcOffsetMinutes, 'number');

  for (const body of [
    {}, { ...BROADCAST, kind: 'nope' }, { ...BROADCAST, schedule: { type: 'interval', everyMinutes: 1 } },
    { ...BROADCAST, schedule: { type: 'once', at: Date.now() - 10 * MIN } },
  ]) {
    const r = await owner.post('/api/schedules', body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body)} -> ${r.text}`);
  }

  // partial updates: name only keeps the next run; disabling clears it; enabling re-arms
  const renamed = await owner.post(`/api/schedules/${row.id}`, { name: 'Discord plug' });
  assert.strictEqual(renamed.status, 200, renamed.text);
  assert.strictEqual(renamed.json.row.name, 'Discord plug');
  assert.strictEqual(renamed.json.row.nextRunAt, row.nextRunAt);
  const off = await owner.post(`/api/schedules/${row.id}`, { enabled: false });
  assert.strictEqual(off.json.row.enabled, false);
  assert.strictEqual(off.json.row.nextRunAt, null);
  const on = await owner.post(`/api/schedules/${row.id}`, { enabled: true, schedule: { type: 'daily', times: ['23:59'] } });
  assert.strictEqual(on.status, 200, on.text);
  assert.ok(on.json.row.nextRunAt > Date.now() && on.json.row.nextRunAt <= Date.now() + 24 * HOUR);
  const same = await owner.post(`/api/schedules/${row.id}`, { name: 'Discord plug' });
  assert.strictEqual(same.status, 200);
  const updates = h.audits('schedule-update').map((a) => JSON.parse(a.details).changed);
  assert.deepStrictEqual(updates, [['name'], ['enabled'], ['schedule', 'enabled']], 'a no-op save is not audited');
  assert.strictEqual((await owner.post(`/api/schedules/${row.id}`, { schedule: { type: 'daily', times: ['25:00'] } })).status, 400);
  assert.strictEqual((await owner.post('/api/schedules/999', { name: 'x' })).status, 404);

  // a once task cannot be (re)armed in the past
  const once = await owner.post('/api/schedules', {
    ...BROADCAST, name: 'Once', schedule: { type: 'once', at: Date.now() + HOUR }, enabled: false,
  });
  assert.strictEqual(once.status, 200, once.text);
  assert.strictEqual(once.json.row.nextRunAt, null, 'disabled: no next run');
  const past = await owner.post(`/api/schedules/${once.json.row.id}`, { schedule: { type: 'once', at: Date.now() - HOUR }, enabled: true });
  assert.strictEqual(past.status, 400);
  assert.match(past.json.error, /already passed/);

  const del = await owner.post(`/api/schedules/${row.id}/delete`, {});
  assert.strictEqual(del.status, 200, del.text);
  assert.deepStrictEqual(JSON.parse(h.audits('schedule-delete')[0].details), { taskId: row.id, name: 'Discord plug', kind: 'broadcast' });
  assert.strictEqual((await owner.post(`/api/schedules/${row.id}/delete`, {})).status, 404);
  assert.deepStrictEqual((await owner.get('/api/schedules')).json.rows.map((r) => r.name), ['Once']);
});

test('HTTP: command tasks need raw as well as settings — to create, edit or run them', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner'); // has raw
  const noRaw = h.as({ view: true, settings: true, broadcast: true });
  const cmd = { name: 'Fog', kind: 'command', payload: { command: 'AdminSetFogOfWar 0' }, schedule: { type: 'interval', everyMinutes: 60 } };

  const denied = await noRaw.post('/api/schedules', cmd);
  assert.strictEqual(denied.status, 403);
  assert.match(denied.json.error, /raw RCON permission/);
  const made = await owner.post('/api/schedules', cmd);
  assert.strictEqual(made.status, 200, made.text);
  const id = made.json.row.id;

  assert.strictEqual((await noRaw.post(`/api/schedules/${id}`, { enabled: false })).status, 403, 'editing a command task');
  assert.strictEqual((await noRaw.post(`/api/schedules/${id}/run`, {})).status, 403, 'running a command task');
  const b = await noRaw.post('/api/schedules', BROADCAST);
  assert.strictEqual(b.status, 200, 'a broadcast needs no raw');
  assert.strictEqual((await noRaw.post(`/api/schedules/${b.json.row.id}`, { kind: 'command', payload: cmd.payload })).status, 403,
    'nor can a broadcast be turned into a command');
  assert.strictEqual((await noRaw.get('/api/schedules')).status, 200);

  const run = await owner.post(`/api/schedules/${id}/run`, {});
  assert.strictEqual(run.status, 200, run.text);
  assert.deepStrictEqual(h.sentCmds, ['AdminSetFogOfWar 0']);
  assert.strictEqual((await noRaw.post(`/api/schedules/${id}/delete`, {})).status, 200, 'removing one is fine');
});

test('HTTP: broadcast and countdown tasks need what they run — broadcast, and match control too — to create, edit or run them', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const settingsOnly = h.as({ view: true, settings: true });
  const broadcaster = h.as({ view: true, settings: true, broadcast: true });
  const matchOnly = h.as({ view: true, settings: true, match: true });
  const both = h.as({ view: true, settings: true, broadcast: true, match: true });
  const END = {
    name: 'End', kind: 'countdown', payload: { action: 'endMatch', steps: [1], message: 'End in {m}' },
    schedule: { type: 'daily', times: ['04:00'] },
  };
  const deny = async (res, re, what) => {
    const r = await res;
    assert.strictEqual(r.status, 403, `${what}: ${r.text}`);
    assert.match(r.json.error, re, what);
  };

  await deny(settingsOnly.post('/api/schedules', BROADCAST), /^broadcast tasks also need the broadcast permission$/, 'broadcast without broadcast');
  await deny(broadcaster.post('/api/schedules', END), /^countdown tasks also need the match control permission$/, 'countdown without match');
  await deny(matchOnly.post('/api/schedules', END), /^countdown tasks also need the broadcast permission$/, 'countdown without broadcast');

  const b = await broadcaster.post('/api/schedules', BROADCAST);
  assert.strictEqual(b.status, 200, b.text);
  const cd = await owner.post('/api/schedules', END);
  assert.strictEqual(cd.status, 200, cd.text);
  const bId = b.json.row.id;
  const cdId = cd.json.row.id;
  await deny(settingsOnly.post(`/api/schedules/${bId}/run`, {}), /broadcast permission/, 'running a broadcast');
  await deny(settingsOnly.post(`/api/schedules/${bId}`, { name: 'x' }), /broadcast permission/, 'editing a broadcast');
  await deny(broadcaster.post(`/api/schedules/${cdId}/run`, {}), /match control permission/, 'running a countdown');
  await deny(broadcaster.post(`/api/schedules/${cdId}`, { enabled: false }), /match control permission/, 'editing a countdown');
  await deny(broadcaster.post(`/api/schedules/${bId}`, { kind: 'countdown', payload: END.payload }), /match control permission/,
    'turning a broadcast into a countdown');
  assert.deepStrictEqual(h.sentCmds, [], 'nothing reached the server');

  const run = await both.post(`/api/schedules/${cdId}/run`, {});
  assert.strictEqual(run.status, 200, run.text);
  assert.strictEqual(run.json.running, true);
  assert.deepStrictEqual(h.sentCmds, ['AdminBroadcast End in 1']);
  const del = await settingsOnly.post(`/api/schedules/${cdId}/delete`, {});
  assert.strictEqual(del.status, 200, 'removing one is fine');
  assert.strictEqual(del.json.cancelledRun, true);
});

test('HTTP: a task deleted while its command is in flight — nothing of that run lands on the task that gets its id next', async (t) => {
  let release = null;
  const h = await harness(t, {
    reply: async (cmd) => {
      if (cmd.includes('hold on')) await new Promise((resolve) => { release = resolve; });
      return `Message broadcasted: ${cmd}`;
    },
  });
  const owner = h.as('owner');
  const made = await owner.post('/api/schedules', { ...BROADCAST, name: 'Held', payload: { message: 'hold on' } });
  assert.strictEqual(made.status, 200, made.text);
  const id = made.json.row.id;
  const running = owner.post(`/api/schedules/${id}/run`, {});
  for (let i = 0; i < 200 && !release; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(release, 'the broadcast is in flight');

  const del = await owner.post(`/api/schedules/${id}/delete`, {});
  assert.strictEqual(del.status, 200, del.text);
  const again = await owner.post('/api/schedules', { ...BROADCAST, name: 'Newcomer' });
  assert.strictEqual(again.json.row.id, id, 'SQLite hands the freed id to the next task');
  assert.strictEqual(again.json.row.running, false);
  release();
  const run = await running;
  assert.strictEqual(run.status, 200, run.text);
  assert.strictEqual(run.json.rconOk, true, 'the broadcast itself went out');
  assert.strictEqual(run.json.row, null, 'the task it ran is gone');
  const row = (await owner.get('/api/schedules')).json.rows.find((r) => r.id === id);
  assert.strictEqual(row.name, 'Newcomer');
  assert.strictEqual(row.lastResult, null);
  assert.strictEqual(row.lastRunAt, null);
  assert.strictEqual(row.enabled, true);
});

test('HTTP: run now sends as the requesting user and leaves the schedule alone', async (t) => {
  let down = false;
  const h = await harness(t, {
    reply: (cmd) => {
      if (down) throw new Error('RCON not connected');
      return `Message broadcasted: ${cmd}`;
    },
  });
  const owner = h.as('owner');
  const made = await owner.post('/api/schedules', BROADCAST);
  const { id, nextRunAt } = made.json.row;

  const run = await owner.post(`/api/schedules/${id}/run`, {});
  assert.strictEqual(run.status, 200, run.text);
  assert.strictEqual(run.json.ok, true);
  assert.strictEqual(run.json.rconOk, true);
  assert.deepStrictEqual(run.json.result, { status: 'ok', message: 'broadcast sent' });
  assert.deepStrictEqual(h.sentCmds, ['AdminBroadcast Join our Discord! 0 online']);
  assert.strictEqual(run.json.row.nextRunAt, nextRunAt, 'the schedule is untouched');
  assert.strictEqual(run.json.row.lastStatus, 'ok');
  const audit = h.audits('scheduled-run');
  assert.strictEqual(audit.length, 1);
  assert.strictEqual(audit[0].user_id, owner.user.id);
  assert.strictEqual(audit[0].rcon_command, 'AdminBroadcast Join our Discord! 0 online');
  assert.deepStrictEqual(JSON.parse(audit[0].details), { taskId: id, name: 'Discord', manual: true });

  down = true;
  const fail = await owner.post(`/api/schedules/${id}/run`, {});
  assert.strictEqual(fail.status, 502, fail.text);
  assert.match(fail.json.error, /RCON not connected/);
  const row = (await owner.get('/api/schedules')).json.rows[0];
  assert.strictEqual(row.lastStatus, 'skipped');
  assert.strictEqual((await owner.post('/api/schedules/12345/run', {})).status, 404);
});

test('HTTP: a countdown started now can be called off by disabling it', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const made = await owner.post('/api/schedules', {
    name: 'Restart', kind: 'countdown',
    payload: { action: 'restartMatch', steps: [10, 5, 1], message: 'Server restart in {m} min' },
    schedule: { type: 'daily', times: ['04:00'] },
  });
  assert.strictEqual(made.status, 200, made.text);
  const id = made.json.row.id;

  const t0 = Date.now();
  const run = await owner.post(`/api/schedules/${id}/run`, {});
  assert.strictEqual(run.status, 200, run.text);
  assert.strictEqual(run.json.running, true);
  assert.ok(run.json.endsAt >= t0 + 10 * MIN && run.json.endsAt <= Date.now() + 10 * MIN);
  assert.deepStrictEqual(h.sentCmds, ['AdminBroadcast Server restart in 10 min']);
  assert.strictEqual(run.json.row.running, true);
  assert.strictEqual(run.json.row.runEndsAt, run.json.endsAt);

  const twice = await owner.post(`/api/schedules/${id}/run`, {});
  assert.strictEqual(twice.status, 409);

  const off = await owner.post(`/api/schedules/${id}`, { enabled: false });
  assert.strictEqual(off.status, 200, off.text);
  assert.strictEqual(off.json.cancelledRun, true);
  assert.strictEqual(off.json.row.running, false);
  assert.strictEqual(off.json.row.lastStatus, 'cancelled');
  assert.strictEqual(JSON.parse(h.audits('schedule-update')[0].details).cancelledRun, true);
  await h.sched.tick();
  assert.deepStrictEqual(h.sentCmds, ['AdminBroadcast Server restart in 10 min'], 'no more warnings, no restart');
});
