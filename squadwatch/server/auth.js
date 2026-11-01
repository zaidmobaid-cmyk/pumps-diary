'use strict';
// Users, sessions, roles, login rate limiting, audit log.
// SPEC §12 with binding amendments §19.1.3 (createAuth factory shape),
// §19.3.15 (first-run setup token), §19.3.18 (session JOIN + disabled check,
// destroyUserSessions on user mutation), §19.3.19 (limiter keyed on clientIp,
// capped + swept map), §19.3.23 (viewer may NOT read audit).
const crypto = require('node:crypto');
const { log, sha256hex, randomTokenHex } = require('./util');

// ---------------------------------------------------------------- passwords

// §12: scrypt$N=16384,r=8,p=1$<salt b64>$<hash b64>; randomBytes(16) salt, 64-byte key.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const HASH_RE = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

function verifyPassword(pw, stored) {
  try {
    const m = HASH_RE.exec(String(stored == null ? '' : stored));
    if (!m) return false;
    const N = parseInt(m[1], 10);
    const r = parseInt(m[2], 10);
    const p = parseInt(m[3], 10);
    // Sanity bounds: our own format only ever writes 16384/8/1, but stay
    // self-describing without letting a corrupt row allocate gigabytes.
    if (!(N >= 2 && N <= 131072) || !(r >= 1 && r <= 32) || !(p >= 1 && p <= 16)) return false;
    if ((N & (N - 1)) !== 0) return false; // N must be a power of two
    const salt = Buffer.from(m[4], 'base64');
    const want = Buffer.from(m[5], 'base64');
    if (want.length < 16 || want.length > 128) return false;
    const got = crypto.scryptSync(String(pw), salt, want.length, {
      N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r),
    });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (_e) {
    return false;
  }
}

// Used to equalize timing when the username does not exist.
let _dummyHash = null;
function dummyHash() {
  if (!_dummyHash) _dummyHash = hashPassword(randomTokenHex(12));
  return _dummyHash;
}

// ------------------------------------------------------------- login limiter

// §12 + §19.3.19: in-memory per-clientIp limiter, 5 attempts / 60s -> 429 at the
// API layer. Map capped at 10k entries, swept per minute (interval is unref'd
// so it never keeps the process alive; sweeps also run lazily on attempt()).
function createLoginLimiter({ max = 5, windowMs = 60000, maxEntries = 10000 } = {}) {
  const hits = new Map(); // key -> [attempt timestamps within window]
  let lastSweep = Date.now();

  function sweep(now) {
    const t = now == null ? Date.now() : now;
    lastSweep = t;
    for (const [key, arr] of hits) {
      const live = arr.filter((ts) => t - ts < windowMs);
      if (live.length === 0) hits.delete(key);
      else hits.set(key, live);
    }
    trim();
  }

  function trim() {
    // Hard cap: drop oldest-inserted entries beyond maxEntries.
    while (hits.size > maxEntries) {
      const oldest = hits.keys().next();
      if (oldest.done) break;
      hits.delete(oldest.value);
    }
  }

  const timer = setInterval(() => sweep(), 60000);
  if (typeof timer.unref === 'function') timer.unref();

  function attempt(ip) {
    const now = Date.now();
    if (now - lastSweep >= 60000) sweep(now);
    const key = String(ip == null ? '' : ip);
    const arr = (hits.get(key) || []).filter((ts) => now - ts < windowMs);
    if (arr.length >= max) {
      hits.set(key, arr);
      const retryAfterSec = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
      return { ok: false, retryAfterSec };
    }
    arr.push(now);
    hits.set(key, arr);
    trim();
    return { ok: true, remaining: max - arr.length };
  }

  function reset(ip) { hits.delete(String(ip == null ? '' : ip)); }

  return {
    attempt,
    reset,
    sweep,
    stop() { clearInterval(timer); },
    get size() { return hits.size; },
  };
}

// --------------------------------------------------------- permission matrix

// §12 roles amended by §19.3.23 (audit is admin+; viewer never sees IPs or
// admin-channel intel) and docs/ROLES-INVITES-SETTINGS.md (granular keys +
// custom roles). Unknown permissions are denied (secure default).
//
// PERM_MIN_ROLE serves two jobs: the legacy fallback for bare {role} users,
// and the seed matrix for the builtin role rows (builtinRolePerms).
const ROLE_RANK = { viewer: 1, admin: 2, owner: 3 };
const PERM_MIN_ROLE = {
  view: 'viewer',      // read-only data
  stream: 'viewer',    // SSE live updates
  notes: 'admin',      // player notes
  flags: 'admin',      // flag review, manual flags, watchlist
  warn: 'admin',
  kick: 'admin',
  ban: 'admin',        // ban/unban + bans.cfg export
  broadcast: 'admin',
  team: 'admin',       // force team change
  squad: 'admin',      // disband/remove/demote commander
  layer: 'admin',      // change/queue layers
  match: 'admin',      // restart/end match
  ips: 'admin',        // player IPs + alt detection
  adminChat: 'admin',  // admin-channel chat + ADMIN_CAM intel
  audit: 'admin',      // §19.3.23: viewer gets 403 on /api/audit
  slomo: 'owner',
  raw: 'owner',        // raw RCON console
  users: 'owner',      // manage panel users + invites
  roles: 'owner',      // manage roles
  settings: 'owner',
};
const PERM_KEYS = Object.keys(PERM_MIN_ROLE);

// Catalog metadata the Roles UI renders (GET /api/perms).
const PERM_INFO = [
  { key: 'view', group: 'Panel', label: 'View panel data' },
  { key: 'stream', group: 'Panel', label: 'Live updates' },
  { key: 'ips', group: 'Panel', label: 'See IPs & alt accounts' },
  { key: 'adminChat', group: 'Panel', label: 'See admin chat & admin cam' },
  { key: 'audit', group: 'Panel', label: 'Read the audit log' },
  { key: 'notes', group: 'Moderation', label: 'Player notes' },
  { key: 'flags', group: 'Moderation', label: 'Review flags & watchlist' },
  { key: 'warn', group: 'Moderation', label: 'Warn players' },
  { key: 'kick', group: 'Moderation', label: 'Kick players' },
  { key: 'ban', group: 'Moderation', label: 'Ban / unban players' },
  { key: 'broadcast', group: 'Server control', label: 'Broadcast messages' },
  { key: 'team', group: 'Server control', label: 'Force team changes' },
  { key: 'squad', group: 'Server control', label: 'Manage squads' },
  { key: 'layer', group: 'Server control', label: 'Change layers' },
  { key: 'match', group: 'Server control', label: 'Restart / end matches' },
  { key: 'slomo', group: 'Server control', label: 'Slow motion' },
  { key: 'raw', group: 'Administration', label: 'Raw RCON console' },
  { key: 'users', group: 'Administration', label: 'Manage users & invites' },
  { key: 'roles', group: 'Administration', label: 'Manage roles' },
  { key: 'settings', group: 'Administration', label: 'Server settings' },
];

// Only granted keys, no `false` entries: stored perms are always in
// sanitizePerms' canonical shape, so "same perms" compares equal as JSON and a
// no-op save on a builtin role never reads as a change (which would log every
// member out).
function builtinRolePerms(role) {
  const out = {};
  const rank = ROLE_RANK[role] || 0;
  for (const k of PERM_KEYS) { if (rank >= ROLE_RANK[PERM_MIN_ROLE[k]]) out[k] = true; }
  return out;
}

// Drop unknown keys and anything not exactly `true`.
function sanitizePerms(perms) {
  const src = perms && typeof perms === 'object' && !Array.isArray(perms) ? perms : {};
  const out = {};
  for (const k of PERM_KEYS) { if (src[k] === true) out[k] = true; }
  return out;
}

function can(user, perm) {
  if (!user) return false;
  if (user.perms && typeof user.perms === 'object') return user.perms[perm] === true;
  if (!user.role) return false;
  const min = PERM_MIN_ROLE[perm];
  if (!min) return false;
  return (ROLE_RANK[user.role] || 0) >= ROLE_RANK[min];
}

const ROLES = new Set(['owner', 'admin', 'viewer']);

// ------------------------------------------------------------------ factory

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;       // 30 days
const SESSION_REFRESH_BELOW_MS = 15 * 24 * 3600 * 1000; // refresh when < 15d left

/**
 * createAuth({db, config, bus?}) — §19.1.3.
 * `bus` is optional; when provided, audit() also emits the canonical
 * 'admin-action' bus event (consumed by webhook.js). setBus() allows late wiring.
 */
function createAuth({ db, config, bus } = {}) {
  if (!db || typeof db.prepare !== 'function') throw new Error('createAuth requires {db}');
  const cfg = config || {};
  let busRef = bus || null;

  const stmt = (sql) => db.prepare(sql);
  const now = () => Date.now();

  function userCount() {
    const row = stmt('SELECT COUNT(*) AS c FROM users').get();
    return row ? Number(row.c) : 0;
  }

  // §19.3.15 first-run setup token: generated when the users table is empty at
  // boot and printed to the console ONLY (never served by the API outside
  // --demo mode). index.js repeats it in the boot banner via auth.setupToken.
  let setupTokenHex = null;
  if (userCount() === 0) {
    setupTokenHex = randomTokenHex(16); // randomBytes(16).hex
    log.info('auth', `FIRST-RUN: no users exist yet. Setup token (required by POST /api/setup): ${setupTokenHex}`);
  }

  function needsSetup() { return userCount() === 0; }

  // ------------------------------------------------------------------- roles

  // Parsed-perms cache: role_id -> { text, obj }. Invalidated by comparing the
  // stored JSON text, so external writes (tests poking SQL) stay correct.
  const permsCache = new Map();
  function parsePerms(roleId, text) {
    const hit = permsCache.get(roleId);
    if (hit && hit.text === text) return hit.obj;
    let obj = {};
    try { obj = sanitizePerms(JSON.parse(String(text == null ? '{}' : text))); } catch (_e) { obj = {}; }
    permsCache.set(roleId, { text, obj });
    return obj;
  }

  function roleRow(idOrName) {
    if (idOrName == null) return null;
    const row = typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))
      ? stmt('SELECT id, name, builtin, perms, created_at FROM roles WHERE id = ?').get(Number(idOrName))
      : stmt('SELECT id, name, builtin, perms, created_at FROM roles WHERE name = ?').get(String(idOrName));
    return row || null;
  }

  function roleOut(row) {
    return {
      id: row.id, name: row.name, builtin: !!row.builtin,
      perms: parsePerms(row.id, row.perms), createdAt: row.created_at,
    };
  }

  function listRoles() {
    const rows = stmt(
      `SELECT r.id, r.name, r.builtin, r.perms, r.created_at,
              (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) AS members,
              (SELECT COUNT(*) FROM invites i WHERE i.role_id = r.id AND i.used_at IS NULL
                      AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > ?)) AS open_invites
         FROM roles r ORDER BY r.builtin DESC, r.id`
    ).all(now());
    return rows.map((r) => Object.assign(roleOut(r), {
      members: Number(r.members), openInvites: Number(r.open_invites),
    }));
  }

  function validRoleName(name) {
    const n = String(name == null ? '' : name).trim();
    if (!n || n.length > 32) throw new Error('role name must be 1-32 characters');
    if (/^\d+$/.test(n)) throw new Error('role name cannot be all digits'); // ids resolve numerically
    return n;
  }

  function createRole(name, perms) {
    const n = validRoleName(name);
    const p = sanitizePerms(perms);
    try {
      const r = stmt('INSERT INTO roles(name, builtin, perms, created_at) VALUES(?,0,?,?)')
        .run(n, JSON.stringify(p), now());
      return roleOut(roleRow(Number(r.lastInsertRowid)));
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new Error('role name already taken');
      throw e;
    }
  }

  // Returns { role, memberIds } — the API layer revokes members' sessions and
  // streams (§19.3.18 pattern) when perms changed.
  function updateRole(id, { name, perms } = {}) {
    const row = roleRow(Number(id));
    if (!row) throw new Error('role not found');
    let newName = row.name;
    if (name !== undefined && String(name) !== row.name) {
      if (row.builtin) throw new Error('builtin role names cannot change');
      newName = validRoleName(name);
    }
    let newPerms = row.perms;
    let permsChanged = false;
    if (perms !== undefined) {
      if (row.builtin && row.name === 'owner') throw new Error("the owner role's permissions cannot change");
      const p = JSON.stringify(sanitizePerms(perms));
      permsChanged = p !== row.perms;
      newPerms = p;
    }
    try {
      stmt('UPDATE roles SET name=?, perms=? WHERE id=?').run(newName, newPerms, row.id);
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new Error('role name already taken');
      throw e;
    }
    const memberIds = permsChanged
      ? stmt('SELECT id FROM users WHERE role_id = ?').all(row.id).map((u) => Number(u.id))
      : [];
    return { role: roleOut(roleRow(row.id)), permsChanged, memberIds };
  }

  function deleteRole(id) {
    const row = roleRow(Number(id));
    if (!row) throw new Error('role not found');
    if (row.builtin) throw new Error('builtin roles cannot be deleted');
    const members = stmt('SELECT COUNT(*) AS c FROM users WHERE role_id=?').get(row.id);
    if (Number(members.c) > 0) throw new Error('role still has members — reassign them first');
    const open = stmt(
      `SELECT COUNT(*) AS c FROM invites WHERE role_id=? AND used_at IS NULL AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`
    ).get(row.id, now());
    if (Number(open.c) > 0) throw new Error('role has open invites — revoke them first');
    stmt('DELETE FROM invites WHERE role_id=? ').run(row.id); // spent/revoked ones
    stmt('DELETE FROM roles WHERE id=?').run(row.id);
    permsCache.delete(row.id);
    return true;
  }

  // A user "holds the keys" when their role grants users+roles+settings. The
  // panel must always keep at least one enabled key-holder (generalized
  // last-owner rule; hUserUpdate enforces it via this helper).
  function keyholderCount({ exceptUserId } = {}) {
    const rows = stmt(
      `SELECT u.id, r.perms, r.id AS role_id FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.disabled = 0`
    ).all();
    let n = 0;
    for (const r of rows) {
      if (exceptUserId != null && Number(r.id) === Number(exceptUserId)) continue;
      const p = parsePerms(r.role_id, r.perms);
      if (p.users === true && p.roles === true && p.settings === true) n++;
    }
    return n;
  }

  function verifySetupToken(token) {
    if (!setupTokenHex || typeof token !== 'string' || token.length === 0 || token.length > 256) return false;
    const a = crypto.createHash('sha256').update(token).digest();
    const b = crypto.createHash('sha256').update(setupTokenHex).digest();
    return crypto.timingSafeEqual(a, b);
  }

  // role: a roles.id, or a role name ('owner'/'admin'/'viewer'/custom).
  function createUser(username, password, role) {
    const uname = String(username == null ? '' : username).trim();
    if (!uname || uname.length > 64) throw new Error('username must be 1-64 characters');
    if (typeof password !== 'string' || password.length < 1) throw new Error('password required');
    if (password.length > 1024) throw new Error('password too long');
    const r = roleRow(role);
    if (!r) throw new Error('unknown role');
    const t = now();
    try {
      const ins = stmt('INSERT INTO users(username, pass_hash, role_id, created_at, disabled) VALUES(?,?,?,?,0)')
        .run(uname, hashPassword(password), r.id, t);
      return { id: ins.lastInsertRowid, username: uname, role: r.name, roleId: r.id };
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) throw new Error('username already taken');
      throw e;
    }
  }

  // §12 first-run: create the owner ONLY when the users table is empty,
  // re-checked inside the transaction (setup race).
  function createFirstOwner({ username, password } = {}) {
    const user = db.tx(() => {
      if (userCount() !== 0) throw new Error('setup already completed');
      return createUser(username, password, 'owner');
    });
    setupTokenHex = null; // single use
    return user;
  }

  function verifyLogin(username, password) {
    const uname = String(username == null ? '' : username).trim();
    const row = uname
      ? stmt(
        `SELECT u.id, u.username, u.pass_hash, u.disabled, r.id AS role_id, r.name AS role, r.perms AS perms
           FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = ?`
      ).get(uname)
      : undefined;
    if (!row) {
      verifyPassword(String(password == null ? '' : password), dummyHash()); // timing equalizer
      return null;
    }
    const ok = verifyPassword(String(password == null ? '' : password), row.pass_hash);
    if (!ok || row.disabled) return null;
    stmt('UPDATE users SET last_login=? WHERE id=?').run(now(), row.id);
    return { id: row.id, username: row.username, role: row.role, roleId: row.role_id, perms: parsePerms(row.role_id, row.perms) };
  }

  // ---------------------------------------------------------------- sessions

  function createSession(userId, meta) {
    const m = meta || {};
    const token = randomTokenHex(32); // 64 hex chars; only sha256(token) is stored
    const t = now();
    const expiresAt = t + SESSION_TTL_MS;
    stmt('INSERT INTO auth_sessions(token_hash, user_id, created_at, expires_at, ip, ua) VALUES(?,?,?,?,?,?)')
      .run(sha256hex(token), userId, t, expiresAt,
        String(m.ip == null ? '' : m.ip).slice(0, 64) || null,
        String(m.ua == null ? '' : m.ua).slice(0, 256) || null);
    return { token, expiresAt };
  }

  // §19.3.18: single JOIN resolution; expiry + users.disabled checked in SQL;
  // role + perms always read from that row, so a role edit applies to the very
  // next request. Sliding: refresh when < 15d left.
  function getSession(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
    const t = now();
    const row = stmt(
      `SELECT s.token_hash AS token_hash, s.expires_at AS expires_at,
              u.id AS id, u.username AS username,
              r.id AS role_id, r.name AS role, r.perms AS perms
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id
         JOIN roles r ON r.id = u.role_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`
    ).get(sha256hex(token), t);
    if (!row) return null;
    let expiresAt = Number(row.expires_at);
    let refreshed = false;
    if (expiresAt - t < SESSION_REFRESH_BELOW_MS) {
      expiresAt = t + SESSION_TTL_MS;
      stmt('UPDATE auth_sessions SET expires_at=? WHERE token_hash=?').run(expiresAt, row.token_hash);
      refreshed = true;
    }
    return {
      user: {
        id: row.id, username: row.username, role: row.role,
        roleId: row.role_id, perms: parsePerms(row.role_id, row.perms),
      },
      expiresAt, refreshed,
    };
  }

  function destroySession(token) {
    if (typeof token !== 'string' || !token) return false;
    return stmt('DELETE FROM auth_sessions WHERE token_hash=?').run(sha256hex(token)).changes > 0;
  }

  function destroyUserSessions(userId) {
    return stmt('DELETE FROM auth_sessions WHERE user_id=?').run(userId).changes;
  }

  // ----------------------------------------------------------------- invites

  // Single-use, role-bound invite links (docs/ROLES-INVITES-SETTINGS.md §2).
  // Only sha256(token) is stored; the full token is returned exactly once.
  function createInvite({ roleId, ttlMs, createdBy } = {}) {
    const r = roleRow(Number(roleId));
    if (!r) throw new Error('unknown role');
    const ttl = Number(ttlMs);
    if (!Number.isFinite(ttl) || ttl < 60000 || ttl > 720 * 3600 * 1000) {
      throw new Error('invite expiry must be between 1 minute and 30 days');
    }
    const token = randomTokenHex(32);
    const t = now();
    const ins = stmt(
      'INSERT INTO invites(token_hash, role_id, created_by, created_at, expires_at) VALUES(?,?,?,?,?)'
    ).run(sha256hex(token), r.id, createdBy == null ? null : createdBy, t, t + ttl);
    return { id: Number(ins.lastInsertRowid), token, roleId: r.id, roleName: r.name, expiresAt: t + ttl };
  }

  function inviteState(row, t) {
    if (row.revoked_at != null) return 'revoked';
    if (row.used_at != null) return 'used';
    if (row.expires_at != null && Number(row.expires_at) <= t) return 'expired';
    return 'unused';
  }

  function listInvites() {
    const t = now();
    return stmt(
      `SELECT i.*, r.name AS role_name, c.username AS created_by_name, u.username AS used_by_name
         FROM invites i
         JOIN roles r ON r.id = i.role_id
         LEFT JOIN users c ON c.id = i.created_by
         LEFT JOIN users u ON u.id = i.used_by
        ORDER BY i.id DESC`
    ).all().map((row) => ({
      id: row.id, roleId: row.role_id, roleName: row.role_name,
      createdBy: row.created_by, createdByName: row.created_by_name,
      createdAt: row.created_at, expiresAt: row.expires_at,
      usedBy: row.used_by, usedByName: row.used_by_name, usedAt: row.used_at,
      revokedAt: row.revoked_at, state: inviteState(row, t),
    }));
  }

  function revokeInvite(id) {
    const row = stmt('SELECT * FROM invites WHERE id=?').get(Number(id));
    if (!row) throw new Error('invite not found');
    if (row.used_at != null) throw new Error('invite was already used');
    if (row.revoked_at == null) stmt('UPDATE invites SET revoked_at=? WHERE id=?').run(now(), row.id);
    return true;
  }

  // Validity probe for the public join page. Returns null for anything not
  // currently claimable (one generic answer — no state oracle for strangers).
  function findInvite(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
    const row = stmt(
      `SELECT i.*, r.name AS role_name FROM invites i JOIN roles r ON r.id = i.role_id
        WHERE i.token_hash = ?`
    ).get(sha256hex(token));
    if (!row || inviteState(row, now()) !== 'unused') return null;
    return { id: row.id, roleId: row.role_id, roleName: row.role_name, expiresAt: row.expires_at };
  }

  // Claim = create the account and consume the invite in one transaction.
  function claimInvite(token, { username, password } = {}) {
    return db.tx(() => {
      const inv = findInvite(token);
      if (!inv) throw new Error('this invite link is no longer valid');
      const user = createUser(username, password, inv.roleId);
      stmt('UPDATE invites SET used_by=?, used_at=? WHERE id=?').run(user.id, now(), inv.id);
      return { user, inviteId: inv.id };
    });
  }

  // ------------------------------------------------------------------- audit

  // §12: admin_actions insert + bus 'admin-action'. userId NULL = system action.
  function audit(userId, action, meta) {
    const m = meta || {};
    const t = m.time != null ? Number(m.time) : now();
    const details = m.details == null ? null
      : (typeof m.details === 'string' ? m.details : JSON.stringify(m.details));
    const rconOk = m.rconOk == null ? null : (m.rconOk ? 1 : 0);
    const r = stmt(
      `INSERT INTO admin_actions(time, user_id, action, target_player_id, details, rcon_command, rcon_response, rcon_ok)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(t, userId == null ? null : userId, String(action),
      m.targetPlayerId == null ? null : m.targetPlayerId,
      details,
      m.rconCommand == null ? null : String(m.rconCommand),
      m.rconResponse == null ? null : String(m.rconResponse),
      rconOk);
    const row = {
      id: r.lastInsertRowid, time: t, userId: userId == null ? null : userId, action: String(action),
      targetPlayerId: m.targetPlayerId == null ? null : m.targetPlayerId,
      details, rconCommand: m.rconCommand == null ? null : String(m.rconCommand),
      rconResponse: m.rconResponse == null ? null : String(m.rconResponse), rconOk,
    };
    if (busRef) {
      try { busRef.emit('admin-action', row); } catch (e) { log.warn('auth', `admin-action emit failed: ${e.message}`); }
    }
    return row.id;
  }

  const loginLimiter = createLoginLimiter();

  return {
    // passwords
    hashPassword,
    verifyPassword,
    // users
    createUser,
    verifyLogin,
    // sessions
    createSession,
    getSession,
    destroySession,
    destroyUserSessions,
    // roles
    roleRow,
    parsePerms,
    listRoles,
    createRole,
    updateRole,
    deleteRole,
    keyholderCount,
    // invites
    createInvite,
    listInvites,
    revokeInvite,
    findInvite,
    claimInvite,
    // authorization + audit
    can,
    audit,
    loginLimiter,
    // first-run setup (§19.3.15)
    needsSetup,
    get setupToken() { return setupTokenHex; },
    verifySetupToken,
    createFirstOwner,
    // late bus wiring (index.js may construct auth before the bus consumers)
    setBus(b) { busRef = b || null; },
    _config: cfg,
  };
}

module.exports = {
  createAuth, hashPassword, verifyPassword, can, createLoginLimiter, ROLES,
  PERM_KEYS, PERM_INFO, builtinRolePerms, sanitizePerms,
};
