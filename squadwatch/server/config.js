'use strict';
// Config loading & validation (SPEC §2, §19.3.19 web.trustProxy default false,
// §19.3.27 plaintext-FTP warning). Zero dependencies.
//
// loadConfig(path) -> user config deep-merged over defaults, with type
// validation that throws ONE error listing EVERY invalid field.
const fs = require('node:fs');
const { log } = require('./util');

// ---------------------------------------------------------------- defaults

function defaults() {
  return {
    web: { port: 8787, host: '0.0.0.0', publicUrl: '', secureCookies: 'auto', trustProxy: false },
    squad: { rconHost: '127.0.0.1', rconPort: 21114, rconPassword: 'CHANGEME' },
    log: {
      mode: 'local',
      path: '/home/squad/SquadGame/Saved/Logs/SquadGame.log',
      pollMs: 1500,
      backfill: false,
      timezoneOffsetMinutes: 0,
      ftp: { host: '', port: 21, user: '', password: '', path: '', secure: false },
      sftp: { host: '', port: 22, user: '', password: '', privateKeyPath: '', path: '' },
    },
    dbPath: 'data/squadwatch.db',
    steamApiKey: '',
    discordWebhook: '',
    webhookEvents: { flags: true, bans: true, kicks: true, warns: false, matchEnd: false },
    flags: {
      tkSpreeCount: 3,
      tkSpreeWindowSec: 180,
      massTkCount: 5,
      newPlayerMinutes: 15,
      chatWatchlist: [],
    },
    autoWarnTeamkiller: false,
    autoWarnMessage: 'Teamkill detected: {victim}. TKs are logged. Apologize in all-chat.',
    retention: { chatDays: 0, popDays: 30 },
    demo: false,
    logUnparsed: false,
  };
}

// ---------------------------------------------------------------- validation

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const isString = (v) => (typeof v === 'string' ? null : 'expected string');
const isNonEmptyString = (v) => (typeof v === 'string' && v.length > 0 ? null : 'expected non-empty string');
const isBool = (v) => (typeof v === 'boolean' ? null : 'expected boolean');
const isNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? null : 'expected number');
const isPosNumber = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? null : 'expected positive number');
const isNonNegInt = (v) => (Number.isInteger(v) && v >= 0 ? null : 'expected integer >= 0');
const isPort = (v) => (Number.isInteger(v) && v >= 1 && v <= 65535 ? null : 'expected integer 1-65535');
const isSecureCookies = (v) => (v === 'auto' || typeof v === 'boolean' ? null : 'expected true, false or "auto"');
const isMode = (v) => (v === 'local' || v === 'ftp' || v === 'sftp' ? null : 'expected "local", "ftp" or "sftp"');
const isStringArray = (v) =>
  (Array.isArray(v) && v.every((x) => typeof x === 'string') ? null : 'expected array of strings');

// Mirrors the defaults tree; leaves are checker functions.
const SCHEMA = {
  web: { port: isPort, host: isString, publicUrl: isString, secureCookies: isSecureCookies, trustProxy: isBool },
  // rconHost '' = "no server linked yet": the panel boots with RCON idle and
  // the Settings page links a server later (docs/ROLES-INVITES-SETTINGS.md §3).
  squad: { rconHost: isString, rconPort: isPort, rconPassword: isString },
  log: {
    mode: isMode,
    path: isString,
    pollMs: isPosNumber,
    backfill: isBool,
    timezoneOffsetMinutes: isNumber,
    ftp: { host: isString, port: isPort, user: isString, password: isString, path: isString, secure: isBool },
    sftp: { host: isString, port: isPort, user: isString, password: isString, privateKeyPath: isString, path: isString },
  },
  dbPath: isNonEmptyString,
  steamApiKey: isString,
  discordWebhook: isString,
  webhookEvents: { flags: isBool, bans: isBool, kicks: isBool, warns: isBool, matchEnd: isBool },
  flags: {
    tkSpreeCount: isNonNegInt,
    tkSpreeWindowSec: isNonNegInt,
    massTkCount: isNonNegInt,
    newPlayerMinutes: isNonNegInt,
    chatWatchlist: isStringArray,
  },
  autoWarnTeamkiller: isBool,
  autoWarnMessage: isString,
  retention: { chatDays: isNonNegInt, popDays: isNonNegInt },
  demo: isBool,
  logUnparsed: isBool,
};

// §19.3.27 — never echo these values, even in validation errors.
const SECRET_PATHS = new Set([
  'squad.rconPassword', 'log.ftp.password', 'log.sftp.password', 'steamApiKey', 'discordWebhook',
]);

function show(v) {
  if (v === undefined) return 'undefined';
  let s;
  try { s = JSON.stringify(v); } catch (_e) { s = String(v); }
  if (s === undefined) s = String(v);
  return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

// Walk the merged config against SCHEMA. Collects problems (invalid fields)
// and unknown keys (ignored with a warning, never fatal).
function validateNode(value, schema, prefix, problems, unknown) {
  for (const key of Object.keys(schema)) {
    const p = prefix ? `${prefix}.${key}` : key;
    const spec = schema[key];
    const v = value[key];
    if (typeof spec === 'function') {
      const err = spec(v);
      if (err) problems.push(SECRET_PATHS.has(p) ? `${p} (${err})` : `${p} (${err}, got ${show(v)})`);
    } else if (!isPlainObject(v)) {
      problems.push(`${p} (expected object, got ${show(v)})`);
    } else {
      validateNode(v, spec, p, problems, unknown);
    }
  }
  for (const key of Object.keys(value)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      unknown.push(prefix ? `${prefix}.${key}` : key);
    }
  }
}

// ---------------------------------------------------------------- merging

// User values win; plain objects merge recursively; arrays/scalars replace.
function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = {};
  for (const k of Object.keys(base)) out[k] = base[k];
  for (const k of Object.keys(over)) {
    out[k] = isPlainObject(base[k]) && isPlainObject(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

// ---------------------------------------------------------------- loadConfig

function loadConfig(configPath) {
  const file = configPath || 'config.json';
  let user = {};
  if (fs.existsSync(file)) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      throw new Error(`config: cannot read ${file}: ${e.message}`);
    }
    try {
      user = JSON.parse(text);
    } catch (e) {
      throw new Error(`config: ${file} is not valid JSON: ${e.message}`);
    }
    if (!isPlainObject(user)) {
      throw new Error(`config: ${file} must contain a JSON object`);
    }
  } else {
    // Keep first runs (and --demo) frictionless: defaults work out of the box.
    log.warn('config', `${file} not found — using built-in defaults (copy config.example.json to ${file} to customize)`);
  }

  const merged = deepMerge(defaults(), user);

  const problems = [];
  const unknown = [];
  validateNode(merged, SCHEMA, '', problems, unknown);
  if (unknown.length) {
    log.warn('config', `unknown config keys (ignored): ${unknown.join(', ')}`);
  }
  if (problems.length) {
    throw new Error(`config: invalid values — ${problems.join('; ')}`);
  }

  // §19.3.27: prominent warning for plaintext FTP (never log the config itself).
  if (merged.log.mode === 'ftp' && !merged.log.ftp.secure) {
    log.warn('config', '*** log.mode is "ftp" with log.ftp.secure=false — FTP credentials and log data travel in PLAINTEXT. Set log.ftp.secure=true (FTPS) or switch to sftp. ***');
  }

  return merged;
}

// ------------------------------------------- runtime settings patching (§3)
// The Settings API may change exactly these config paths. Listen address, db
// location and demo stay file-only — changing them from the web is a footgun.
const SETTINGS_ALLOW = [
  'squad.rconHost', 'squad.rconPort', 'squad.rconPassword',
  'log.mode', 'log.path', 'log.pollMs', 'log.backfill', 'log.timezoneOffsetMinutes',
  'log.ftp.host', 'log.ftp.port', 'log.ftp.user', 'log.ftp.password', 'log.ftp.path', 'log.ftp.secure',
  'log.sftp.host', 'log.sftp.port', 'log.sftp.user', 'log.sftp.password', 'log.sftp.privateKeyPath', 'log.sftp.path',
  'web.publicUrl',
  'steamApiKey', 'discordWebhook',
  'webhookEvents.flags', 'webhookEvents.bans', 'webhookEvents.kicks', 'webhookEvents.warns', 'webhookEvents.matchEnd',
  'flags.tkSpreeCount', 'flags.tkSpreeWindowSec', 'flags.massTkCount', 'flags.newPlayerMinutes', 'flags.chatWatchlist',
  'autoWarnTeamkiller', 'autoWarnMessage',
  'retention.chatDays', 'retention.popDays',
];

function getLeaf(obj, dotted) {
  let cur = obj;
  for (const k of dotted.split('.')) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}
function setLeaf(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * applySettingsPatch(cfg, patch) — docs/ROLES-INVITES-SETTINGS.md §3.
 * Walks SETTINGS_ALLOW only (everything else in `patch` is ignored), validates
 * the WHOLE patched config against SCHEMA on a clone, then mutates `cfg` IN
 * PLACE — never replacing nested objects, because ingest/webhook/api hold the
 * same object and read it live. Secret paths: null/absent = keep the stored
 * value, '' = clear, any other string = set.
 * Returns { changedPaths }. Throws one Error listing every invalid field
 * (secret values never echoed).
 */
function applySettingsPatch(cfg, patch) {
  if (!isPlainObject(patch)) throw new Error('settings patch must be a JSON object');
  const candidates = []; // [path, newValue]
  for (const p of SETTINGS_ALLOW) {
    const v = getLeaf(patch, p);
    if (v === undefined) continue;
    if (SECRET_PATHS.has(p) && v === null) continue; // null secret = keep
    candidates.push([p, v]);
  }
  // Validate on a clone first — cfg stays untouched when anything is invalid.
  const clone = JSON.parse(JSON.stringify(cfg));
  for (const [p, v] of candidates) setLeaf(clone, p, v);
  const problems = [];
  const unknown = [];
  validateNode(clone, SCHEMA, '', problems, unknown);
  if (problems.length) throw new Error(`invalid values — ${problems.join('; ')}`);

  const changedPaths = [];
  for (const [p, v] of candidates) {
    const before = getLeaf(cfg, p);
    const same = Array.isArray(v) || Array.isArray(before)
      ? JSON.stringify(before) === JSON.stringify(v)
      : before === v;
    if (!same) {
      setLeaf(cfg, p, v);
      changedPaths.push(p);
    }
  }
  return { changedPaths };
}

/**
 * persistUserConfig(configPath, changedPaths, cfg) — carry the new values into
 * the sparse user config.json (created if missing), written atomically
 * (tmp + rename) with pretty JSON so hand-editing stays pleasant.
 */
function persistUserConfig(configPath, changedPaths, cfg) {
  const file = configPath || 'config.json';
  let user = {};
  let prevMode = null;
  if (fs.existsSync(file)) {
    // Never rewrite a file we could not read: hand-edited config.json may hold
    // file-only keys (dbPath, web.host, trustProxy) that a sparse rewrite would
    // silently destroy. Failing here surfaces as persistError — the change
    // still applied live, the file is untouched.
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      throw new Error(`config.json is unreadable or not valid JSON (${e.message}) — fix it by hand; the change was applied live but NOT saved`);
    }
    if (!isPlainObject(parsed)) {
      throw new Error('config.json does not contain a JSON object — fix it by hand; the change was applied live but NOT saved');
    }
    user = parsed;
    try { prevMode = fs.statSync(file).mode & 0o777; } catch (_e) { prevMode = null; }
  }
  for (const p of changedPaths) setLeaf(user, p, getLeaf(cfg, p));
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    // The file holds secrets (RCON/FTP passwords, API keys): keep the owner's
    // own permissions when the file exists, 0600 for a fresh one — never the
    // default world-readable mode.
    fs.writeFileSync(tmp, JSON.stringify(user, null, 2) + '\n', { encoding: 'utf8', mode: prevMode == null ? 0o600 : prevMode });
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_e) { /* */ }
    throw e;
  }
}

module.exports = { loadConfig, applySettingsPatch, persistUserConfig, SETTINGS_ALLOW };
