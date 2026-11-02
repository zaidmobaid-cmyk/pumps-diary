'use strict';
// Shared warn/kick/ban reason templates (docs/BATCH3-CONTRACTS.md §2), kept in
// the settings row 'reasonTemplates' (seeded by the v6 migration). Rows are
// {id, kind: 'warn'|'kick'|'ban', label, reason, interval?}; interval belongs
// to ban rows only and uses the INTERVAL syntax of server/admin.js. A stored
// row that no longer validates is dropped on read, so a hand-edited row never
// reaches a dialog.
//
// createTemplates({db, auth}) -> {registerRoutes(api), start(), stop()}
const { INTERVAL_RE } = require('./admin');
const { parseInterval, log: utilLog } = require('./util');

const SETTINGS_KEY = 'reasonTemplates';
const MAX_ROWS = 60;
const ID_RE = /^[a-z0-9-]{1,40}$/;
const KINDS = new Set(['warn', 'kick', 'ban']);
const LABEL_MAX = 40;
// Reasons go out over RCON as one line: no line breaks, NUL or other control
// characters (a tab is harmless).
const REASON_MAX = 480;
const REASON_BAD_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

const blank = (v) => v === undefined || v === null || v === '';

// One template -> {row} normalized to {id, kind, label, reason[, interval]},
// or {error}.
function checkRow(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { error: 'must be an object' };
  const id = typeof t.id === 'string' ? t.id : '';
  if (!ID_RE.test(id)) return { error: 'id must be 1-40 characters of a-z, 0-9 and -' };
  if (!KINDS.has(t.kind)) return { error: "kind must be 'warn', 'kick' or 'ban'" };
  const label = typeof t.label === 'string' ? t.label.trim() : '';
  const labelLen = [...label].length;
  if (labelLen < 1 || labelLen > LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label)) {
    return { error: `label must be 1-${LABEL_MAX} characters` };
  }
  const reason = typeof t.reason === 'string' ? t.reason.trim() : '';
  if (reason.length < 1 || reason.length > REASON_MAX || REASON_BAD_RE.test(reason)) {
    return { error: `reason must be 1-${REASON_MAX} characters on one line` };
  }
  const row = { id, kind: t.kind, label, reason };
  if (t.kind === 'ban') {
    const interval = typeof t.interval === 'string' ? t.interval.trim() : '';
    if (!INTERVAL_RE.test(interval) || parseInterval(interval) == null) {
      return { error: 'a ban template needs a duration (0 = permanent, or e.g. 30m 2h 1d 1w 1M 1y)' };
    }
    row.interval = interval;
  } else if (!blank(t.interval)) {
    return { error: 'only ban templates take a duration' };
  }
  return { row };
}

// The whole list (POST replaces it) -> {rows} or {error}.
function validateTemplates(rows) {
  if (!Array.isArray(rows)) return { error: 'rows must be an array' };
  if (rows.length > MAX_ROWS) return { error: `at most ${MAX_ROWS} templates` };
  const out = [];
  const ids = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = checkRow(rows[i]);
    if (r.error) return { error: `row ${i + 1}: ${r.error}` };
    if (ids.has(r.row.id)) return { error: `row ${i + 1}: duplicate id "${r.row.id}"` };
    ids.add(r.row.id);
    out.push(r.row);
  }
  return { rows: out };
}

function createTemplates(deps) {
  const d = deps || {};
  const db = d.db;
  const auth = d.auth;
  const log = d.log && typeof d.log.warn === 'function' ? d.log : utilLog;
  if (!db || !auth) throw new Error('reason templates need db and auth');

  function load() {
    let parsed = [];
    try {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
      parsed = r && r.value != null ? JSON.parse(String(r.value)) : [];
    } catch (e) {
      log.warn('templates', `reason templates unreadable: ${e.message}`);
      return [];
    }
    const out = [];
    const ids = new Set();
    for (const t of Array.isArray(parsed) ? parsed : []) {
      const r = checkRow(t);
      if (r.error || ids.has(r.row.id)) {
        log.warn('templates', `stored reason template skipped (${r.error || 'duplicate id'})`);
        continue;
      }
      ids.add(r.row.id);
      out.push(r.row);
    }
    return out;
  }

  function registerRoutes(api) {
    api.route('GET', /^\/api\/reason-templates$/, { anyPerm: ['warn', 'kick', 'ban', 'settings'] }, (ctx) => {
      // The warn/kick/ban dialogs load this on open: the evidence upload limit
      // rides along so their file precheck is exact before the first upload.
      const ev = api.cfg && api.cfg.evidence;
      const maxMB = ev && Number.isInteger(ev.maxMB) ? ev.maxMB : null;
      return api.json(ctx.res, 200, { rows: load(), maxMB });
    });

    api.route('POST', /^\/api\/reason-templates$/, { perm: 'settings' }, (ctx) => {
      const v = validateTemplates(ctx.body.rows);
      if (v.error) throw new api.ApiErr(400, v.error);
      const before = load();
      db.prepare(
        'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run(SETTINGS_KEY, JSON.stringify(v.rows));
      const prev = new Map(before.map((t) => [t.id, t]));
      const kept = new Set(v.rows.map((t) => t.id));
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      auth.audit(ctx.user.id, 'templates-update', {
        details: {
          count: v.rows.length,
          added: v.rows.filter((t) => !prev.has(t.id)).map((t) => t.id),
          changed: v.rows.filter((t) => prev.has(t.id) && !same(prev.get(t.id), t)).map((t) => t.id),
          removed: before.filter((t) => !kept.has(t.id)).map((t) => t.id),
        },
      });
      return api.json(ctx.res, 200, { ok: true, rows: v.rows });
    });
  }

  return { registerRoutes, start() {}, stop() {} };
}

module.exports = { createTemplates, validateTemplates, MAX_ROWS };
