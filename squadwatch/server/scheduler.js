'use strict';
// Scheduled broadcasts, raw commands and restart/end countdowns
// (docs/BATCH3-CONTRACTS.md §4). Tasks live in scheduled_tasks; a 15 s tick
// (unref'd) runs the due ones through the audited admin layer.
//
// Next-run times come from the schedule alone, never from when a run really
// happened, so lateness never accumulates: interval runs stay on the grid of
// their first run, daily runs on the server's local wall clock. Each
// occurrence is handled exactly once — run, or skipped and recorded (RCON
// down, conditions unmet, previous run still going, found too late) — and
// the task moves on to its next due time. A countdown starts at its
// scheduled time: it broadcasts at each step (minutes left, largest first)
// and runs the action when it reaches zero.
//
// Test seams (not part of the contract): deps.now() for the clock,
// deps.tzOffset(ms) -> minutes east of UTC, deps.timers for the tick and
// countdown timers; the returned tick() runs one engine pass.
const { log: utilLog, sanitizeRconArg, prettyLayer } = require('./util');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const TICK_MS = 15 * 1000;
// An occurrence found later than this (panel down, RCON blackout at boot)
// is missed, never run late: a 04:00 restart must not fire at noon.
const MISSED_GRACE_MS = 5 * MIN;
// A countdown's action found later than this (the panel stalled, the PC
// slept) is missed too: the last warning players got is stale by then.
const ACTION_GRACE_MS = 2 * MIN;

const KINDS = ['broadcast', 'command', 'countdown'];
// A task does only what its author could do by hand: besides settings, each
// kind needs the permissions of the admin actions it runs.
const KIND_PERMS = { broadcast: ['broadcast'], countdown: ['broadcast', 'match'], command: ['raw'] };
const PERM_NAMES = { broadcast: 'broadcast', match: 'match control', raw: 'raw RCON' };
const COUNTDOWN_ACTIONS = ['restartMatch', 'endMatch'];
const NAME_MAX = 60;
// Message templates; placeholders expand at run time.
const TEMPLATE_MAX = 400;
// 'AdminBroadcast ' + the expanded text stays inside execRaw's 480 cap.
const BROADCAST_MAX = 465;
const COMMAND_MAX = 480;
const COMMAND_RE = /^[A-Za-z][A-Za-z0-9_]{2,63}( [^\r\n\0]+)?$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CTRL_RE = /[\u0000-\u001f\u007f]/;
const STEP_MAX = 60;
const STEPS_MAX = 10;
const PLAYERS_MAX = 1000;
// rcon.js rejects with these while the link is down or was just lost.
const RCON_DOWN_RE = /RCON (not connected|disconnected|closed)|exec timeout/i;
const PLACEHOLDER_RE = /\{(players|maxPlayers|layer|nextLayer|time|m)\}/g;

// ------------------------------------------------------------- validation

function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function bad(error) { return { error }; }

// Whole numbers, also as digit strings (form inputs); anything else NaN.
function intOf(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : NaN;
  if (typeof v === 'string' && /^\s*\d{1,15}\s*$/.test(v)) return Number(v.trim());
  return NaN;
}

function boolOf(v) {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  return null;
}

function textField(v, label, max) {
  if (typeof v !== 'string') return bad(`${label} must be a string`);
  const s = v.trim();
  if (!s) return bad(`${label} required`);
  if (s.length > max) return bad(`${label} must be at most ${max} characters`);
  if (CTRL_RE.test(s)) return bad(`${label} must be one line without control characters`);
  return { value: s };
}

function normPayload(kind, p) {
  if (!isObj(p)) return bad('payload must be an object');
  if (kind === 'broadcast') {
    const m = textField(p.message, 'message', TEMPLATE_MAX);
    return m.error ? m : { value: { message: m.value } };
  }
  if (kind === 'command') {
    if (typeof p.command !== 'string') return bad('command must be a string');
    const c = p.command.trim();
    if (c.length > COMMAND_MAX || CTRL_RE.test(c) || !COMMAND_RE.test(c)) {
      return bad('command must be an RCON command name (letters, digits, _), optionally followed by its arguments, on one line');
    }
    return { value: { command: c } };
  }
  // countdown
  if (!COUNTDOWN_ACTIONS.includes(p.action)) return bad("countdown action must be 'restartMatch' or 'endMatch'");
  if (!Array.isArray(p.steps) || p.steps.length < 1 || p.steps.length > STEPS_MAX) {
    return bad(`a countdown needs 1-${STEPS_MAX} steps`);
  }
  const steps = new Set();
  for (const s of p.steps) {
    const n = intOf(s);
    if (!Number.isInteger(n) || n < 1 || n > STEP_MAX) return bad(`steps are minutes left: whole numbers from 1 to ${STEP_MAX}`);
    steps.add(n);
  }
  const m = textField(p.message, 'message', TEMPLATE_MAX);
  if (m.error) return m;
  return { value: { action: p.action, steps: [...steps].sort((a, b) => b - a), message: m.value } };
}

function normSchedule(s, now) {
  if (!isObj(s)) return bad('schedule must be an object');
  if (s.type === 'interval') {
    const n = intOf(s.everyMinutes);
    if (!Number.isInteger(n) || n < 5 || n > 1440) return bad('everyMinutes must be a whole number from 5 to 1440');
    return { value: { type: 'interval', everyMinutes: n } };
  }
  if (s.type === 'daily') {
    if (!Array.isArray(s.times) || s.times.length < 1 || s.times.length > 24) return bad('a daily schedule needs 1-24 times');
    const set = new Set();
    for (const x of s.times) {
      const m = typeof x === 'string' ? TIME_RE.exec(x.trim()) : null;
      if (!m) return bad('daily times must be HH:MM (24-hour, server local time)');
      set.add(`${m[1]}:${m[2]}`);
    }
    return { value: { type: 'daily', times: [...set].sort() } };
  }
  if (s.type === 'once') {
    const at = intOf(s.at);
    if (!Number.isSafeInteger(at) || at <= 0) return bad('a once schedule needs `at` in epoch milliseconds');
    if (at > now + 366 * DAY) return bad('pick a time within the next year');
    return { value: { type: 'once', at } };
  }
  return bad("schedule.type must be 'interval', 'daily' or 'once'");
}

function normConditions(c) {
  if (c == null) return { value: null };
  if (!isObj(c)) return bad('conditions must be an object');
  const out = {};
  for (const k of ['minPlayers', 'maxPlayers']) {
    if (c[k] == null || c[k] === '') continue;
    const n = intOf(c[k]);
    if (!Number.isInteger(n) || n < 0 || n > PLAYERS_MAX) return bad(`${k} must be a whole number from 0 to ${PLAYERS_MAX}`);
    out[k] = n;
  }
  if (out.minPlayers != null && out.maxPlayers != null && out.minPlayers > out.maxPlayers) {
    return bad('minPlayers cannot be above maxPlayers');
  }
  return { value: Object.keys(out).length ? out : null };
}

/**
 * validateTask({name, kind, payload, schedule, conditions?, enabled?}, {now})
 *   -> {task} normalized (trimmed text, sorted unique times, steps largest
 *      first, unknown keys dropped) | {error}. Whether a `once` time lies in
 *      the past is the caller's call: stored tasks are re-checked with this.
 */
function validateTask(input, { now = Date.now() } = {}) {
  if (!isObj(input)) return bad('task must be an object');
  const name = textField(input.name, 'name', NAME_MAX);
  if (name.error) return name;
  if (!KINDS.includes(input.kind)) return bad("kind must be 'broadcast', 'command' or 'countdown'");
  const payload = normPayload(input.kind, input.payload);
  if (payload.error) return payload;
  const schedule = normSchedule(input.schedule, now);
  if (schedule.error) return schedule;
  const conditions = normConditions(input.conditions);
  if (conditions.error) return conditions;
  const enabled = input.enabled == null ? true : boolOf(input.enabled);
  if (enabled == null) return bad('enabled must be true or false');
  if (input.kind === 'countdown' && schedule.value.type === 'interval'
    && payload.value.steps[0] >= schedule.value.everyMinutes) {
    return bad('the countdown must be shorter than the interval');
  }
  return {
    task: {
      name: name.value, kind: input.kind, payload: payload.value,
      schedule: schedule.value, conditions: conditions.value, enabled,
    },
  };
}

// ------------------------------------------------------------- next runs

// Minutes east of UTC in the process's (the server's) local zone.
function localOffsetMinutes(ms) {
  return 0 - new Date(ms).getTimezoneOffset();
}

// The instant a local wall-clock time occurs; `wall` is that wall time
// encoded as if it were UTC. A repeated wall time (clocks going back)
// resolves to its first occurrence; a skipped one (clocks going forward)
// to the first valid instant after the gap — the moment the clocks jump.
function wallToInstant(wall, tz) {
  const before = tz(wall - DAY);
  const after = tz(wall + DAY);
  let best = null;
  for (const off of before === after ? [before] : [before, after]) {
    const t = wall - off * MIN;
    if (tz(t) === off && (best == null || t < best)) best = t;
  }
  if (best != null) return best;
  // In the gap: the offset changes somewhere between these two instants.
  let lo = Math.min(wall - before * MIN, wall - after * MIN);
  let hi = Math.max(wall - before * MIN, wall - after * MIN);
  const offLo = tz(lo);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (tz(mid) === offLo) lo = mid; else hi = mid;
  }
  return hi;
}

// The earliest of `times` (HH:MM, local) strictly after `now`.
function nextDaily(times, now, tz) {
  const local = new Date(now + tz(now) * MIN);
  let best = null;
  // Today through the day after tomorrow: a gap or overlap moves a time by
  // at most a few hours, never past the following day's.
  for (let k = 0; k <= 2; k++) {
    for (const hm of times) {
      const [h, m] = hm.split(':').map(Number);
      const wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + k, h, m);
      const t = wallToInstant(wall, tz);
      if (t > now && (best == null || t < best)) best = t;
    }
  }
  return best;
}

/** When a task with this schedule, created or (re)enabled at `now`, first runs. */
function firstRunAt(schedule, now, tz = localOffsetMinutes) {
  if (schedule.type === 'interval') return now + schedule.everyMinutes * MIN;
  if (schedule.type === 'daily') return nextDaily(schedule.times, now, tz);
  return schedule.at;
}

/**
 * The next occurrence after the one scheduled at `scheduledAt` was handled
 * at `now` (>= scheduledAt). Interval runs stay on the scheduledAt grid
 * however late this one ran, skipping occurrences already past; `once` has
 * no next one (null).
 */
function nextRunAfter(schedule, scheduledAt, now, tz = localOffsetMinutes) {
  const at = Math.max(Number(scheduledAt) || 0, now);
  if (schedule.type === 'interval') {
    const p = schedule.everyMinutes * MIN;
    const anchor = Number(scheduledAt);
    if (!Number.isFinite(anchor)) return now + p;
    return anchor + p * (Math.floor((at - anchor) / p) + 1);
  }
  if (schedule.type === 'daily') return nextDaily(schedule.times, at, tz);
  return null;
}

// ----------------------------------------------------------------- engine

function parseJson(s) {
  if (s == null) return null;
  try { return JSON.parse(String(s)); } catch (_e) { return null; }
}

function result(status, message) {
  return { status, message: String(message == null ? '' : message).slice(0, 300) };
}

function short(s, n = 160) {
  const v = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

function createScheduler(deps) {
  const d = deps || {};
  const { db, bus, state, admin, auth } = d;
  const log = d.log || utilLog;
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  const tz = typeof d.tzOffset === 'function' ? d.tzOffset : localOffsetMinutes;
  const timers = d.timers || {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
  };

  const runs = new Map(); // task id -> the run in progress
  // Set when an exec found RCON down; cleared by any successful exec or a
  // completed poll. While set, due occurrences are skipped without an exec.
  let rconDown = false;
  let started = false;
  let stopped = false;
  let tickTimer = null;
  let wakeTimer = null;
  let ticking = null;
  let again = false;
  const onPoll = () => { rconDown = false; };

  const unref = (h) => { if (h && typeof h.unref === 'function') h.unref(); return h; };

  // ----------------------------------------------------------- live values

  function livePlayers() {
    const si = state && state.serverInfo;
    if (si && si.playerCount != null && Number.isFinite(Number(si.playerCount))) return Number(si.playerCount);
    return state && state.players && typeof state.players.size === 'number' ? state.players.size : 0;
  }

  function hhmm(t) {
    const l = new Date(t + tz(t) * MIN);
    return String(l.getUTCHours()).padStart(2, '0') + ':' + String(l.getUTCMinutes()).padStart(2, '0');
  }

  // {layer} and {nextLayer} are both layer names: ShowCurrentMap's, like
  // ShowNextMap's, before ShowServerInfo's MapName_s.
  function placeholders(t) {
    const si = (state && state.serverInfo) || {};
    const cur = state && state.currentMap && state.currentMap.layer;
    const layer = cur || (state && state.currentLayer) || si.mapName || null;
    const next = (state && state.nextLayer) || si.nextLayer || null;
    return {
      players: String(livePlayers()),
      maxPlayers: si.maxPlayers != null ? String(si.maxPlayers) : '?',
      layer: layer ? prettyLayer(layer) : 'unknown',
      nextLayer: next ? prettyLayer(next) : 'unknown',
      time: hhmm(t),
    };
  }

  // Live values only ever fill the template, and the whole line is
  // sanitized: nothing a layer name holds can start a second command.
  function fill(template, t, m) {
    const v = placeholders(t);
    const text = String(template).replace(PLACEHOLDER_RE, (all, k) => {
      if (k === 'm') return m == null ? all : String(m);
      return v[k];
    });
    return sanitizeRconArg(text, BROADCAST_MAX);
  }

  function unmet(c) {
    if (!c) return null;
    const n = livePlayers();
    if (c.minPlayers != null && n < c.minPlayers) return `${n} player(s) online, needs at least ${c.minPlayers}`;
    if (c.maxPlayers != null && n > c.maxPlayers) return `${n} player(s) online, needs at most ${c.maxPlayers}`;
    return null;
  }

  // ---------------------------------------------------------------- rows

  function getRow(id) {
    return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) || null;
  }

  function taskOf(row) {
    const payload = parseJson(row.payload);
    const schedule = parseJson(row.schedule);
    const conditions = row.conditions == null ? null : parseJson(row.conditions);
    return validateTask({
      name: row.name, kind: row.kind, payload, schedule, conditions, enabled: !!row.enabled,
    }, { now: now() });
  }

  function rowOut(r) {
    const res = parseJson(r.last_result);
    const run = runs.get(r.id);
    return {
      id: r.id, name: r.name, kind: r.kind,
      payload: parseJson(r.payload), schedule: parseJson(r.schedule),
      conditions: r.conditions == null ? null : parseJson(r.conditions),
      enabled: !!r.enabled,
      lastRunAt: r.last_run_at == null ? null : Number(r.last_run_at),
      nextRunAt: r.next_run_at == null ? null : Number(r.next_run_at),
      lastResult: res && typeof res === 'object' ? res.message : (r.last_result == null ? null : String(r.last_result)),
      lastStatus: res && typeof res === 'object' ? res.status : null,
      running: !!run,
      runEndsAt: run && run.kind === 'countdown' ? run.actionAt : null,
      createdBy: r.created_by == null ? null : r.created_by,
      createdAt: r.created_at == null ? null : Number(r.created_at),
      updatedAt: r.updated_at == null ? null : Number(r.updated_at),
    };
  }

  function setResult(id, res, at) {
    db.prepare('UPDATE scheduled_tasks SET last_run_at = ?, last_result = ? WHERE id = ?')
      .run(at, JSON.stringify(res), id);
  }
  // A once task's single occurrence is used up — unless it was re-armed
  // (an edit set a new time) while this run was going.
  function consumeOnce(id) {
    db.prepare('UPDATE scheduled_tasks SET enabled = 0 WHERE id = ? AND next_run_at IS NULL').run(id);
  }

  // ---------------------------------------------------------------- execs

  async function execRaw(user, command, details) {
    try {
      return await admin.execRaw(user || null, command, { action: 'scheduled-run', details });
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e), command };
    }
  }

  async function execAction(user, action) {
    try {
      return await admin.execAdmin(user || null, action, {});
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e), command: action };
    }
  }

  // An exec result -> the run's outcome; tracks whether RCON is down.
  function outcome(r, okText) {
    if (r && r.ok) {
      rconDown = false;
      if (r.rconOk === false) return result('failed', `server replied: ${short(r.response)}`);
      return result('ok', typeof okText === 'function' ? okText(r) : okText);
    }
    const err = r && r.error ? String(r.error) : 'unknown error';
    if (r && r.command != null && RCON_DOWN_RE.test(err)) {
      rconDown = true;
      return result('skipped', 'RCON not connected');
    }
    return result('failed', short(err));
  }

  // -------------------------------------------------------------- runs

  // Starts one occurrence. Resolves to {res, r, gone}: the outcome and the
  // exec result behind it — for a countdown, of its opening broadcast (the
  // rest runs on the tick) — and whether the task was deleted meanwhile.
  // `consume`: a scheduled once task, used up when done. A run whose task is
  // deleted writes nothing more: SQLite may give that id to the next task.
  async function begin(task, row, { user, manual, at, consume }) {
    const details = { taskId: row.id, name: task.name };
    if (manual) details.manual = true;
    if (task.kind === 'countdown') return beginCountdown(task, row, { user, at, consume, details });
    const run = { kind: task.kind, startedAt: at, deleted: false };
    runs.set(row.id, run);
    try {
      const r = task.kind === 'broadcast'
        ? await execRaw(user, `AdminBroadcast ${fill(task.payload.message, at)}`, details)
        : await execRaw(user, task.payload.command, details);
      const res = outcome(r, task.kind === 'broadcast' ? 'broadcast sent' : (x) => short(x.response) || 'command sent');
      if (!run.deleted) {
        setResult(row.id, res, at);
        if (consume) consumeOnce(row.id);
      }
      return { res, r, gone: run.deleted };
    } finally {
      if (runs.get(row.id) === run) runs.delete(row.id);
    }
  }

  async function beginCountdown(task, row, { user, at, consume, details }) {
    const total = task.payload.steps[0];
    const run = {
      kind: 'countdown', id: row.id, task, user, consume, details, startedAt: at,
      // steps as absolute times, earliest first: step m goes out with m minutes left
      steps: task.payload.steps.map((m) => ({ m, at: at + (total - m) * MIN, done: false })),
      actionAt: at + total * MIN, opened: false, warned: 0, missed: 0, busy: false, cancelled: false, deleted: false,
    };
    runs.set(row.id, run);
    setResult(row.id, result('running', `countdown started — ${task.payload.action} at ${hhmm(run.actionAt)}`), at);
    const first = await stepCountdown(run, at);
    armWake();
    return Object.assign(first || { res: result('running', 'countdown started'), r: null }, { gone: run.deleted });
  }

  function endCountdown(run, res) {
    run.cancelled = true;
    if (runs.get(run.id) === run) runs.delete(run.id);
    if (run.deleted) return;
    setResult(run.id, res, run.startedAt);
    if (run.consume) consumeOnce(run.id);
  }

  // Sends what is due of a countdown at `t`: the latest due step (earlier
  // unsent ones are stale by now) announcing the minutes really left, then
  // the action once its time has come — unless that time is long past.
  // The opening broadcast must reach the server: without that warning the
  // countdown is called off rather than ending a match unannounced.
  async function stepCountdown(run, t) {
    if (run.busy || run.cancelled) return null;
    run.busy = true;
    let opening = null;
    try {
      const due = run.steps.filter((s) => !s.done && s.at <= t);
      for (const s of due) s.done = true;
      if (due.length && t < run.actionAt) {
        const s = due[due.length - 1];
        const text = fill(run.task.payload.message, t, Math.min(s.m, Math.ceil((run.actionAt - t) / MIN)));
        let r = null;
        let res;
        if (rconDown && run.opened) {
          res = result('skipped', 'RCON not connected');
        } else {
          r = await execRaw(run.user, `AdminBroadcast ${text}`, Object.assign({ step: s.m }, run.details));
          res = outcome(r, 'warning sent');
        }
        if (!run.opened) {
          opening = { res, r };
          if (res.status !== 'ok') {
            opening.res = result(res.status, `countdown not started — ${res.message}`);
            endCountdown(run, opening.res);
            return opening;
          }
          run.opened = true;
        }
        if (res.status === 'ok') run.warned++; else run.missed++;
      }
      if (!run.cancelled && t >= run.actionAt) {
        for (const s of run.steps) s.done = true;
        const action = run.task.payload.action;
        let res;
        if (t - run.actionAt > ACTION_GRACE_MS) {
          res = result('skipped', `missed — the panel stalled; ${action} was due at ${hhmm(run.actionAt)} and was not sent`);
        } else if (rconDown) {
          res = result('skipped', `RCON not connected — ${action} was not sent`);
        } else {
          const r = await execAction(run.user, action);
          const lost = run.missed ? `, ${run.missed} warning(s) not delivered` : '';
          res = outcome(r, `${action} sent after ${run.warned} warning(s)${lost}`);
          if (run.cancelled) res.message = short(`${res.message} (the cancel came after it was sent)`, 300);
        }
        endCountdown(run, res);
      }
      return opening;
    } catch (e) {
      // Never leave a dead run behind: it would block the task for good.
      log.error('scheduler', `countdown #${run.id} failed: ${e && e.message ? e.message : e}`);
      try { endCountdown(run, result('failed', `countdown stopped: ${short(e && e.message ? e.message : e)}`)); } catch (_e) { /* db gone */ }
      return opening;
    } finally {
      run.busy = false;
    }
  }

  // Stops a countdown in progress: no further warnings, no action.
  function cancelRun(id, why) {
    const run = runs.get(id);
    if (!run || run.kind !== 'countdown') return false;
    run.cancelled = true;
    runs.delete(id);
    try { setResult(id, result('cancelled', why), run.startedAt); } catch (_e) { /* row gone */ }
    armWake();
    return true;
  }

  // One due occurrence found by the tick at `t`. The row is read afresh: an
  // earlier task's exec in this tick can take seconds, and the task may have
  // been deleted, disabled or edited meanwhile.
  async function handleDue(id, t) {
    const row = getRow(id);
    if (!row || !row.enabled || row.next_run_at == null || Number(row.next_run_at) > t) return;
    const scheduledAt = Number(row.next_run_at);
    const v = taskOf(row);
    if (v.error) {
      // A stored task that no longer validates never runs.
      db.prepare('UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL, last_run_at = ?, last_result = ? WHERE id = ?')
        .run(t, JSON.stringify(result('failed', `invalid task: ${v.error}`)), row.id);
      log.warn('scheduler', `task #${row.id} disabled: ${v.error}`);
      return;
    }
    const task = v.task;
    const once = task.schedule.type === 'once';
    // Claim this occurrence, as the row stands now, before anything async.
    const claim = db.prepare('UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?')
      .run(nextRunAfter(task.schedule, scheduledAt, t, tz), row.id, row.next_run_at);
    if (claim.changes !== 1) return;
    const skip = (why) => {
      setResult(row.id, result('skipped', why), t);
      if (once) consumeOnce(row.id);
    };
    if (t - scheduledAt > MISSED_GRACE_MS) return skip(`missed — the panel was not running at ${hhmm(scheduledAt)}`);
    if (runs.has(row.id)) {
      // The row keeps showing the run in progress; its result says how it went.
      log.info('scheduler', `task #${row.id}: the ${hhmm(scheduledAt)} occurrence was skipped — the previous run was still going`);
      if (once) consumeOnce(row.id);
      return;
    }
    if (rconDown) return skip('RCON not connected');
    const why = unmet(task.conditions);
    if (why) return skip(why);
    await begin(task, row, { user: null, manual: false, at: t, consume: once });
  }

  async function tickOnce() {
    if (stopped) return;
    const t = now();
    for (const run of [...runs.values()]) {
      if (run.kind === 'countdown') await stepCountdown(run, t);
    }
    const due = db.prepare(
      `SELECT id FROM scheduled_tasks
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at, id`
    ).all(t);
    for (const { id } of due) {
      if (stopped) break;
      try {
        await handleDue(Number(id), t);
      } catch (e) {
        log.error('scheduler', `task #${id} failed: ${e && e.message ? e.message : e}`);
      }
    }
  }

  // One engine pass; overlapping calls fold into one more pass.
  function tick() {
    if (ticking) {
      again = true;
      return ticking;
    }
    ticking = (async () => {
      try {
        do {
          again = false;
          await tickOnce();
        } while (again);
      } catch (e) {
        log.error('scheduler', `tick failed: ${e && e.message ? e.message : e}`);
      } finally {
        ticking = null;
        armWake();
      }
    })();
    return ticking;
  }

  // Countdown steps keep their minute marks to the second instead of
  // waiting for the next 15 s tick.
  function armWake() {
    if (!started) return;
    if (wakeTimer) {
      timers.clearTimeout(wakeTimer);
      wakeTimer = null;
    }
    let soonest = null;
    for (const run of runs.values()) {
      // A run mid-exec re-arms this when its step completes.
      if (run.kind !== 'countdown' || run.cancelled || run.busy) continue;
      for (const s of run.steps) if (!s.done && (soonest == null || s.at < soonest)) soonest = s.at;
      if (soonest == null || run.actionAt < soonest) soonest = run.actionAt;
    }
    if (soonest == null) return;
    wakeTimer = unref(timers.setTimeout(() => {
      wakeTimer = null;
      tick();
    }, Math.max(0, soonest - now()) + 10));
  }

  // ---------------------------------------------------------------- routes

  const FIELDS = ['name', 'kind', 'payload', 'schedule', 'conditions', 'enabled'];

  function changedFields(row, task) {
    const stored = {
      name: row.name, kind: row.kind, payload: row.payload, schedule: row.schedule,
      conditions: row.conditions == null ? null : row.conditions, enabled: !!row.enabled,
    };
    const fresh = {
      name: task.name, kind: task.kind, payload: JSON.stringify(task.payload),
      schedule: JSON.stringify(task.schedule),
      conditions: task.conditions ? JSON.stringify(task.conditions) : null, enabled: task.enabled,
    };
    return FIELDS.filter((k) => stored[k] !== fresh[k]);
  }

  function registerRoutes(api) {
    const { route, json, ApiErr, intParam } = api;
    const authz = api.auth || auth;
    const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
    const pastOnce = (task, t) => task.enabled && task.schedule.type === 'once' && task.schedule.at < t - MIN;

    // Why `user` may not handle tasks of these kinds (a 403 message), or null.
    function lacking(user, ...kinds) {
      for (const kind of kinds) {
        for (const perm of KIND_PERMS[kind] || []) {
          if (!authz.can(user, perm)) return `${kind} tasks also need the ${PERM_NAMES[perm]} permission`;
        }
      }
      return null;
    }

    function load(ctx) {
      const id = intParam(ctx.params[1], 'task id');
      const row = getRow(id);
      if (!row) throw new ApiErr(404, 'scheduled task not found');
      return row;
    }

    route('GET', /^\/api\/schedules$/, { perm: 'settings' }, (ctx) => {
      const t = now();
      const rows = db.prepare('SELECT * FROM scheduled_tasks ORDER BY id').all().map(rowOut);
      // placeholders: what a broadcast would say right now (live preview).
      return json(ctx.res, 200, { rows, placeholders: placeholders(t), utcOffsetMinutes: tz(t) });
    });

    route('POST', /^\/api\/schedules$/, { perm: 'settings' }, (ctx) => {
      const t = now();
      const v = validateTask(ctx.body, { now: t });
      if (v.error) throw new ApiErr(400, v.error);
      const task = v.task;
      const denied = lacking(ctx.user, task.kind);
      if (denied) throw new ApiErr(403, denied);
      if (pastOnce(task, t)) throw new ApiErr(400, 'that time has already passed');
      const next = task.enabled ? firstRunAt(task.schedule, t, tz) : null;
      const r = db.prepare(
        `INSERT INTO scheduled_tasks(name, kind, payload, schedule, conditions, enabled, next_run_at,
           created_by, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(task.name, task.kind, JSON.stringify(task.payload), JSON.stringify(task.schedule),
        task.conditions ? JSON.stringify(task.conditions) : null, task.enabled ? 1 : 0, next,
        ctx.user.id, t, t);
      const id = r.lastInsertRowid;
      authz.audit(ctx.user.id, 'schedule-create', { details: Object.assign({ taskId: id }, task) });
      return json(ctx.res, 200, { ok: true, row: rowOut(getRow(id)) });
    });

    // Partial update: absent fields keep their stored values. An explicit
    // enabled:false also calls off a countdown in progress.
    route('POST', /^\/api\/schedules\/(\d+)$/, { perm: 'settings' }, (ctx) => {
      const row = load(ctx);
      const t = now();
      const merged = {};
      for (const k of FIELDS) {
        if (has(ctx.body, k)) merged[k] = ctx.body[k];
        else if (k === 'enabled') merged[k] = !!row.enabled;
        else if (k === 'name' || k === 'kind') merged[k] = row[k];
        else merged[k] = row[k] == null ? null : parseJson(row[k]);
      }
      const v = validateTask(merged, { now: t });
      if (v.error) throw new ApiErr(400, v.error);
      const task = v.task;
      const denied = lacking(ctx.user, row.kind, task.kind);
      if (denied) throw new ApiErr(403, denied);
      const changed = changedFields(row, task);
      const wasEnabled = !!row.enabled;
      const rearm = !wasEnabled || changed.includes('schedule');
      if (rearm && pastOnce(task, t)) throw new ApiErr(400, 'that time has already passed');
      let next = row.next_run_at == null ? null : Number(row.next_run_at);
      if (!task.enabled) next = null;
      else if (rearm || (next == null && task.schedule.type !== 'once')) next = firstRunAt(task.schedule, t, tz);
      db.prepare(
        `UPDATE scheduled_tasks SET name = ?, kind = ?, payload = ?, schedule = ?, conditions = ?, enabled = ?,
           next_run_at = ?, updated_at = ? WHERE id = ?`
      ).run(task.name, task.kind, JSON.stringify(task.payload), JSON.stringify(task.schedule),
        task.conditions ? JSON.stringify(task.conditions) : null, task.enabled ? 1 : 0, next, t, row.id);
      const cancelled = boolOf(ctx.body.enabled) === false && cancelRun(row.id, 'cancelled — the task was disabled');
      if (changed.length || cancelled) {
        const details = Object.assign({ taskId: row.id, changed }, task);
        if (cancelled) details.cancelledRun = true;
        authz.audit(ctx.user.id, 'schedule-update', { details });
      }
      return json(ctx.res, 200, { ok: true, row: rowOut(getRow(row.id)), cancelledRun: !!cancelled });
    });

    // Settings alone may remove any task: deleting runs nothing.
    route('POST', /^\/api\/schedules\/(\d+)\/delete$/, { perm: 'settings' }, (ctx) => {
      const row = load(ctx);
      const run = runs.get(row.id);
      const cancelled = cancelRun(row.id, 'cancelled — the task was deleted');
      if (run) {
        run.deleted = true;
        runs.delete(row.id);
      }
      db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(row.id);
      const details = { taskId: row.id, name: row.name, kind: row.kind };
      if (cancelled) details.cancelledRun = true;
      authz.audit(ctx.user.id, 'schedule-delete', { details });
      return json(ctx.res, 200, { ok: true, cancelledRun: cancelled });
    });

    // Run now: whatever the task's schedule, enabled flag or conditions; the
    // schedule itself is left as it was. Audited under the user who asked.
    route('POST', /^\/api\/schedules\/(\d+)\/run$/, { perm: 'settings' }, async (ctx) => {
      const row = load(ctx);
      const denied = lacking(ctx.user, row.kind);
      if (denied) throw new ApiErr(403, denied);
      if (runs.has(row.id)) throw new ApiErr(409, 'this task is already running');
      const v = taskOf(row);
      if (v.error) throw new ApiErr(400, `stored task is invalid: ${v.error}`);
      const { res, r, gone } = await begin(v.task, row, { user: ctx.user, manual: true, at: now(), consume: false });
      if (r && !r.ok) {
        if (r.command == null) throw new ApiErr(400, r.error || 'invalid command');
        throw new ApiErr(502, `RCON command failed: ${r.error || 'unknown error'}`);
      }
      const out = { ok: true, result: res, rconOk: r ? r.rconOk : null, rconResponse: r ? r.response : null };
      const run = gone ? null : runs.get(row.id);
      if (run && run.kind === 'countdown') {
        out.running = true;
        out.endsAt = run.actionAt;
      }
      // row null: the task was deleted while its command went out.
      const fresh = gone ? null : getRow(row.id);
      out.row = fresh ? rowOut(fresh) : null;
      return json(ctx.res, 200, out);
    });
  }

  // ------------------------------------------------------------- lifecycle

  function start() {
    if (started) return;
    started = true;
    stopped = false;
    // A countdown the panel was running when it stopped is lost, never
    // resumed late: say so on its row.
    try {
      for (const row of db.prepare('SELECT id, schedule, last_run_at, last_result FROM scheduled_tasks').all()) {
        const res = parseJson(row.last_result);
        if (!res || res.status !== 'running' || runs.has(row.id)) continue;
        setResult(row.id, result('failed', 'interrupted — the panel restarted during the countdown'), row.last_run_at);
        const s = parseJson(row.schedule);
        if (s && s.type === 'once') consumeOnce(row.id);
      }
    } catch (e) {
      log.warn('scheduler', `could not check interrupted runs: ${e.message}`);
    }
    if (bus && typeof bus.on === 'function') {
      bus.on('players-updated', onPoll);
      bus.on('serverinfo-updated', onPoll);
    }
    tickTimer = unref(timers.setInterval(() => { tick(); }, TICK_MS));
  }

  function stop() {
    started = false;
    stopped = true;
    if (tickTimer) { timers.clearInterval(tickTimer); tickTimer = null; }
    if (wakeTimer) { timers.clearTimeout(wakeTimer); wakeTimer = null; }
    if (bus && typeof bus.removeListener === 'function') {
      bus.removeListener('players-updated', onPoll);
      bus.removeListener('serverinfo-updated', onPoll);
    }
    for (const [id, run] of [...runs]) {
      if (run.kind !== 'countdown') continue;
      run.cancelled = true;
      runs.delete(id);
      try {
        setResult(id, result('failed', 'interrupted — the panel stopped during the countdown'), run.startedAt);
        if (run.consume) consumeOnce(id);
      } catch (_e) { /* db already closed */ }
    }
  }

  return { registerRoutes, start, stop, tick };
}

module.exports = {
  createScheduler, validateTask, firstRunAt, nextRunAfter, nextDaily, wallToInstant, localOffsetMinutes,
  MISSED_GRACE_MS,
};
