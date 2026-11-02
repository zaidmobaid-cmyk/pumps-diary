'use strict';
// SQLite open/migrate + normalized prepared-statement bag (SPEC §9 + §19.2).
// Primary backend: built-in node:sqlite (Node >= 22.13).
// Optional fallback: better-sqlite3 (only if node:sqlite is unavailable).
const fs = require('node:fs');
const path = require('node:path');
const { log } = require('./util');

const FRIENDLY_BACKEND_ERROR =
  'No SQLite backend available. A3 Admin uses the built-in node:sqlite module — ' +
  'upgrade Node to >=22.13, or install the optional fallback with: npm install better-sqlite3';

function pickBackend() {
  try {
    const { DatabaseSync } = require('node:sqlite');
    if (typeof DatabaseSync === 'function') return { kind: 'node:sqlite', open: (p) => new DatabaseSync(p) };
  } catch (_e) { /* fall through to better-sqlite3 */ }
  try {
    const Database = require('better-sqlite3');
    return { kind: 'better-sqlite3', open: (p) => new Database(p) };
  } catch (_e) { /* neither backend present */ }
  throw new Error(FRIENDLY_BACKEND_ERROR);
}

// v1 DDL — verbatim from SPEC §9, including the §19.2 amendments
// (bans.steam_id, flags.review_note) folded into the v1 schema.
const DDL_V1 = `
CREATE TABLE players(
  id INTEGER PRIMARY KEY, eos_id TEXT UNIQUE, steam_id TEXT, name TEXT,
  first_seen INTEGER, last_seen INTEGER, play_seconds INTEGER DEFAULT 0,
  kills INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0, teamkills INTEGER DEFAULT 0,
  tk_deaths INTEGER DEFAULT 0, suicides INTEGER DEFAULT 0,
  revives_given INTEGER DEFAULT 0, revives_taken INTEGER DEFAULT 0,
  radio_damage_friendly REAL DEFAULT 0, radio_damage_enemy REAL DEFAULT 0,
  hab_damage_friendly REAL DEFAULT 0, hab_damage_enemy REAL DEFAULT 0,
  deployable_damage_unknown REAL DEFAULT 0,
  avatar TEXT, persona_fetched_at INTEGER, watchlisted INTEGER DEFAULT 0);
CREATE INDEX idx_players_steam ON players(steam_id);
CREATE INDEX idx_players_name ON players(name);
CREATE TABLE player_names(player_id INTEGER, name TEXT, first_used INTEGER, last_used INTEGER,
  PRIMARY KEY(player_id, name));
CREATE TABLE player_ips(player_id INTEGER, ip TEXT, first_seen INTEGER, last_seen INTEGER,
  times INTEGER DEFAULT 1, PRIMARY KEY(player_id, ip));
CREATE INDEX idx_ips_ip ON player_ips(ip);
CREATE TABLE sessions(id INTEGER PRIMARY KEY, player_id INTEGER, connect_at INTEGER,
  disconnect_at INTEGER);
CREATE INDEX idx_sessions_player ON sessions(player_id);
CREATE TABLE matches(id INTEGER PRIMARY KEY, layer TEXT, level TEXT, layer_class TEXT,
  team1 TEXT, team2 TEXT, started_at INTEGER, in_progress_at INTEGER, ended_at INTEGER,
  winner_team INTEGER, winner_faction TEXT, tickets INTEGER);
CREATE TABLE match_players(match_id INTEGER, player_id INTEGER, team_id INTEGER,
  kills INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0, teamkills INTEGER DEFAULT 0,
  tk_deaths INTEGER DEFAULT 0, revives INTEGER DEFAULT 0, damage_dealt REAL DEFAULT 0,
  PRIMARY KEY(match_id, player_id));
CREATE TABLE kills(id INTEGER PRIMARY KEY, match_id INTEGER, time INTEGER, kind TEXT,
  attacker_id INTEGER, victim_id INTEGER, weapon TEXT, damage REAL,
  teamkill INTEGER DEFAULT 0, suicide INTEGER DEFAULT 0);
CREATE INDEX idx_kills_match ON kills(match_id);
CREATE INDEX idx_kills_attacker ON kills(attacker_id);
CREATE INDEX idx_kills_victim ON kills(victim_id);
CREATE INDEX idx_kills_time ON kills(time);
CREATE TABLE revives(id INTEGER PRIMARY KEY, match_id INTEGER, time INTEGER,
  reviver_id INTEGER, revived_id INTEGER);
CREATE TABLE damage_agg(match_id INTEGER, attacker_id INTEGER, victim_id INTEGER,
  weapon TEXT, hits INTEGER DEFAULT 0, total REAL DEFAULT 0, teamdamage INTEGER DEFAULT 0,
  PRIMARY KEY(match_id, attacker_id, victim_id, weapon));
CREATE TABLE deployable_damage(id INTEGER PRIMARY KEY, match_id INTEGER, time INTEGER,
  player_id INTEGER, player_team INTEGER, deployable TEXT, category TEXT, dep_faction TEXT,
  friendly INTEGER, damage REAL, weapon TEXT, damage_type TEXT, health_remaining REAL);
CREATE INDEX idx_dep_player ON deployable_damage(player_id);
CREATE INDEX idx_dep_match ON deployable_damage(match_id);
CREATE TABLE chat(id INTEGER PRIMARY KEY, time INTEGER, match_id INTEGER, player_id INTEGER,
  channel TEXT, message TEXT);
CREATE INDEX idx_chat_time ON chat(time);
CREATE INDEX idx_chat_player ON chat(player_id);
CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE,
  pass_hash TEXT, role TEXT CHECK(role IN ('owner','admin','viewer')),
  created_at INTEGER, last_login INTEGER, disabled INTEGER DEFAULT 0);
CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER,
  created_at INTEGER, expires_at INTEGER, ip TEXT, ua TEXT);
CREATE TABLE admin_actions(id INTEGER PRIMARY KEY, time INTEGER, user_id INTEGER,
  action TEXT, target_player_id INTEGER, details TEXT, rcon_command TEXT,
  rcon_response TEXT, rcon_ok INTEGER);
CREATE INDEX idx_actions_time ON admin_actions(time);
CREATE TABLE bans(id INTEGER PRIMARY KEY, player_id INTEGER, steam_id TEXT, issued_by INTEGER,
  issued_at INTEGER, duration_sec INTEGER, expires_at INTEGER, reason TEXT,
  interval_raw TEXT, active INTEGER DEFAULT 1, rcon_ok INTEGER,
  unbanned_by INTEGER, unbanned_at INTEGER);
CREATE TABLE warnings(id INTEGER PRIMARY KEY, player_id INTEGER, by_user INTEGER,
  time INTEGER, message TEXT, auto INTEGER DEFAULT 0);
CREATE TABLE flags(id INTEGER PRIMARY KEY, player_id INTEGER, time INTEGER, type TEXT,
  severity INTEGER, match_id INTEGER, details TEXT, reviewed INTEGER DEFAULT 0,
  reviewed_by INTEGER, reviewed_at INTEGER, review_note TEXT);
CREATE INDEX idx_flags_player ON flags(player_id);
CREATE TABLE player_notes(id INTEGER PRIMARY KEY, player_id INTEGER, by_user INTEGER,
  time INTEGER, text TEXT);
CREATE TABLE pop_samples(time INTEGER PRIMARY KEY, players INTEGER, queue INTEGER,
  tick_rate REAL, layer TEXT);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
`;

// v2 — custom roles + invite links (docs/ROLES-INVITES-SETTINGS.md).
// users is rebuilt from role TEXT to role_id FK; builtin role rows are seeded
// from auth.js's matrix so legacy 'owner'/'admin'/'viewer' behavior is identical.
const DDL_V2 = `
CREATE TABLE roles(
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE COLLATE NOCASE,
  builtin INTEGER DEFAULT 0,
  perms TEXT,
  created_at INTEGER);
CREATE TABLE invites(
  id INTEGER PRIMARY KEY,
  token_hash TEXT UNIQUE,
  role_id INTEGER REFERENCES roles(id),
  created_by INTEGER,
  created_at INTEGER,
  expires_at INTEGER,
  used_by INTEGER,
  used_at INTEGER,
  revoked_at INTEGER);
`;

// v3 — squad lifecycle history: who created each squad and exactly when
// (vehicle-claim adjudication), and who disbanded what. Fed by the
// SQUAD_CREATED log/chat-packet events and by poll-diff disband detection.
const DDL_V3 = `
CREATE TABLE squad_events(
  id INTEGER PRIMARY KEY,
  time INTEGER,
  match_id INTEGER,
  type TEXT,
  team_id INTEGER,
  squad_id INTEGER,
  name TEXT,
  player_id INTEGER,
  player_name TEXT,
  by_user INTEGER);
CREATE INDEX idx_squad_events_match ON squad_events(match_id);
CREATE INDEX idx_squad_events_time ON squad_events(time);
`;

// v5 — imported ban lists (BattleMetrics) match on EOS as well as Steam and
// remember where each ban came from; faction pairings are learned per layer
// from ShowCurrentMap/ShowNextMap (docs/NEXT-CONTRACTS.md).
const DDL_V5 = `
ALTER TABLE bans ADD COLUMN eos_id TEXT;
ALTER TABLE bans ADD COLUMN source TEXT;
ALTER TABLE bans ADD COLUMN external_id TEXT;
CREATE INDEX idx_bans_eos ON bans(eos_id);
CREATE INDEX idx_bans_steam ON bans(steam_id);
CREATE UNIQUE INDEX idx_bans_source_ext ON bans(source, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE layer_factions(
  layer TEXT NOT NULL,
  team1 TEXT NOT NULL,
  team2 TEXT NOT NULL,
  count INTEGER DEFAULT 0,
  last_seen INTEGER,
  PRIMARY KEY(layer, team1, team2));
`;

// v6 — evidence files on bans and admin actions, private ban notes, the
// scheduler, in-game admin calls (docs/BATCH3-CONTRACTS.md).
const DDL_V6 = `
ALTER TABLE bans ADD COLUMN note TEXT;
CREATE TABLE evidence(
  id INTEGER PRIMARY KEY,
  target_type TEXT NOT NULL CHECK(target_type IN ('ban','action')),
  target_id INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  filename TEXT,
  mime TEXT,
  size INTEGER,
  caption TEXT,
  uploaded_by INTEGER,
  uploaded_at INTEGER,
  deleted_by INTEGER,
  deleted_at INTEGER);
CREATE INDEX idx_evidence_target ON evidence(target_type, target_id);
CREATE TABLE scheduled_tasks(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('broadcast','command','countdown')),
  payload TEXT NOT NULL,
  schedule TEXT NOT NULL,
  conditions TEXT,
  enabled INTEGER DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER,
  last_result TEXT,
  created_by INTEGER,
  created_at INTEGER,
  updated_at INTEGER);
CREATE TABLE admin_calls(
  id INTEGER PRIMARY KEY,
  time INTEGER NOT NULL,
  match_id INTEGER,
  player_id INTEGER,
  player_name TEXT,
  eos_id TEXT,
  steam_id TEXT,
  message TEXT,
  status TEXT DEFAULT 'open' CHECK(status IN ('open','handled')),
  handled_by INTEGER,
  handled_at INTEGER);
CREATE INDEX idx_admin_calls_time ON admin_calls(time);
CREATE INDEX idx_admin_calls_status ON admin_calls(status);
CREATE INDEX IF NOT EXISTS idx_actions_target ON admin_actions(target_player_id);
`;

// Shared warn/kick/ban wording every admin picks from (editable in Settings).
const DEFAULT_REASON_TEMPLATES = [
  { id: 'tk-warn', kind: 'warn', label: 'Teamkilling', reason: 'Teamkilling - check your targets. More TKs lead to a kick.' },
  { id: 'rules-warn', kind: 'warn', label: 'Server rules', reason: 'Please follow the server rules - see our Discord.' },
  { id: 'no-squad-kick', kind: 'kick', label: 'Not in a squad', reason: 'Join a squad - playing outside a squad is not allowed here.' },
  { id: 'toxic-kick', kind: 'kick', label: 'Toxic behaviour', reason: 'Toxic behaviour - kicked by an admin.' },
  { id: 'tk-ban', kind: 'ban', label: 'Intentional teamkilling', reason: 'Intentional teamkilling', interval: '3d' },
  { id: 'grief-ban', kind: 'ban', label: 'Griefing friendly assets', reason: 'Griefing friendly radios/HABs', interval: '1w' },
  { id: 'cheat-ban', kind: 'ban', label: 'Cheating', reason: 'Cheating', interval: '0' },
];

// The owner's requested one-press commands (toggles take 1/0).
const DEFAULT_QUICK_COMMANDS = [
  { id: 'no-respawn-timer', label: 'No respawn timer', command: 'AdminNoRespawnTimer', toggle: true },
  { id: 'all-roles', label: 'All roles available', command: 'AdminForceAllRoleAvailability', toggle: true },
];

const USERS_V2_REBUILD = `
CREATE TABLE users_v2(
  id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE,
  pass_hash TEXT, role_id INTEGER NOT NULL REFERENCES roles(id),
  created_at INTEGER, last_login INTEGER, disabled INTEGER DEFAULT 0);
INSERT INTO users_v2(id, username, pass_hash, role_id, created_at, last_login, disabled)
  SELECT u.id, u.username, u.pass_hash, r.id, u.created_at, u.last_login, u.disabled
    FROM users u JOIN roles r ON r.name = u.role;
DROP TABLE users;
ALTER TABLE users_v2 RENAME TO users;
`;

// Normalize bound parameters so both backends behave identically:
// undefined -> NULL, booleans -> 1/0. (better-sqlite3 rejects both outright;
// keeping this in one place means callers never have to care.)
function normArgs(args) {
  const out = new Array(args.length);
  for (let i = 0; i < args.length; i++) {
    const v = args[i];
    if (v === undefined) out[i] = null;
    else if (typeof v === 'boolean') out[i] = v ? 1 : 0;
    else out[i] = v;
  }
  return out;
}

/**
 * openDb(dbPath) -> { raw, backend, path, prepare, exec, tx, migrate, close }
 *  - prepare(sql) -> { run(...p) -> {changes,lastInsertRowid}, get(...p), all(...p) }
 *    (statements are memoized by SQL text — the "prepared statement bag")
 *  - tx(fn) wraps fn() in BEGIN/COMMIT with ROLLBACK on throw, returns fn's result
 *  - migrate() applies the v1 DDL exactly once, tracked in schema_version
 */
function openDb(dbPath) {
  const backend = pickBackend();
  if (dbPath !== ':memory:' && !String(dbPath).startsWith('file:')) {
    try { fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true }); } catch (_e) { /* opening will report */ }
  }
  const raw = backend.open(dbPath);

  function exec(sql) { raw.exec(sql); }

  const stmtCache = new Map();
  function prepare(sql) {
    let wrapped = stmtCache.get(sql);
    if (wrapped) return wrapped;
    const st = raw.prepare(sql);
    wrapped = {
      run(...args) {
        const r = st.run(...normArgs(args));
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      get(...args) { return st.get(...normArgs(args)); },
      all(...args) { return st.all(...normArgs(args)); },
    };
    stmtCache.set(sql, wrapped);
    return wrapped;
  }

  function tx(fn) {
    exec('BEGIN');
    try {
      const out = fn();
      exec('COMMIT');
      return out;
    } catch (err) {
      try { exec('ROLLBACK'); } catch (_e) { /* already rolled back */ }
      throw err;
    }
  }

  // WAL + pragmas (§9). journal_mode returns a row; exec discards it, which is fine.
  exec('PRAGMA journal_mode=WAL;');
  exec('PRAGMA synchronous=NORMAL;');
  exec('PRAGMA foreign_keys=ON;');

  function migrate() {
    exec('CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)');
    let row = prepare('SELECT version AS v FROM schema_version LIMIT 1').get();
    if (!row) {
      prepare('INSERT INTO schema_version(version) VALUES(0)').run();
      row = { v: 0 };
    }
    let version = Number(row.v) || 0;
    if (version < 1) {
      tx(() => {
        exec(DDL_V1);
        prepare('UPDATE schema_version SET version=?').run(1);
      });
      version = 1;
      log.info('db', `migrated schema to v1 (${backend.kind})`);
    }
    if (version < 2) {
      // Late require: auth.js owns the permission matrix; no import cycle
      // (auth.js never requires db.js).
      const { builtinRolePerms } = require('./auth');
      const t = Date.now();
      tx(() => {
        exec(DDL_V2);
        const ins = prepare('INSERT INTO roles(name, builtin, perms, created_at) VALUES(?,1,?,?)');
        for (const name of ['owner', 'admin', 'viewer']) {
          ins.run(name, JSON.stringify(builtinRolePerms(name)), t);
        }
        const before = prepare('SELECT COUNT(*) AS c FROM users').get();
        exec(USERS_V2_REBUILD);
        const after = prepare('SELECT COUNT(*) AS c FROM users').get();
        // The rebuild joins users.role to the seeded role names; a row with an
        // unexpected role value would silently vanish. Refuse to migrate a db
        // we would lose accounts from (tx rolls back, old schema intact).
        if (Number(before.c) !== Number(after.c)) {
          throw new Error(`v2 migration would drop ${Number(before.c) - Number(after.c)} user(s) with unrecognized roles — aborting`);
        }
        prepare('UPDATE schema_version SET version=?').run(2);
      });
      version = 2;
      log.info('db', 'migrated schema to v2 (roles, invites)');
    }
    if (version < 3) {
      tx(() => {
        exec(DDL_V3);
        prepare('UPDATE schema_version SET version=?').run(3);
      });
      version = 3;
      log.info('db', 'migrated schema to v3 (squad_events)');
    }
    if (version < 4) {
      tx(() => {
        // The live-feed backfill reads recent DISCONNECTS, but sessions rows
        // are ordered by connect: disconnect_at needs its own index.
        exec('CREATE INDEX idx_sessions_disconnect ON sessions(disconnect_at);');
        prepare('UPDATE schema_version SET version=?').run(4);
      });
      version = 4;
      log.info('db', 'migrated schema to v4 (sessions disconnect index)');
    }
    if (version < 5) {
      tx(() => {
        exec(DDL_V5);
        prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)')
          .run('quickCommands', JSON.stringify(DEFAULT_QUICK_COMMANDS));
        // Builtin role perms are stored seed data with no implicit "all keys"
        // bypass, so a new permission key must be granted explicitly.
        exec("UPDATE roles SET perms = json_set(COALESCE(perms, '{}'), '$.quickcmd', json('true')) WHERE builtin = 1 AND name IN ('owner', 'admin');");
        prepare('UPDATE schema_version SET version=?').run(5);
      });
      version = 5;
      log.info('db', 'migrated schema to v5 (ban sources, faction combos, quick commands)');
    }
    if (version < 6) {
      tx(() => {
        exec(DDL_V6);
        prepare('INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)')
          .run('reasonTemplates', JSON.stringify(DEFAULT_REASON_TEMPLATES));
        // BattleMetrics staff notes were stored as a trailing "[note]" on the
        // player-visible reason; they move to the private note column.
        const rows = prepare("SELECT id, reason FROM bans WHERE source = 'battlemetrics' AND reason LIKE '%]'").all();
        const upd = prepare('UPDATE bans SET reason = ?, note = ? WHERE id = ?');
        for (const r of rows) {
          const m = /^(.*?)\s*\[([^[\]]*)\]$/s.exec(String(r.reason));
          if (m) upd.run(m[1] || null, m[2] || null, r.id);
        }
        prepare('UPDATE schema_version SET version=?').run(6);
      });
      version = 6;
      log.info('db', 'migrated schema to v6 (evidence, ban notes, scheduler, admin calls)');
    }
    return version;
  }

  function close() { try { raw.close(); } catch (_e) { /* already closed */ } }

  return { raw, backend: backend.kind, path: dbPath, prepare, exec, tx, migrate, close };
}

module.exports = { openDb };
