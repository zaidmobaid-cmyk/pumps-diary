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
// admin-channel intel). Unknown permissions are denied (secure default).
const ROLE_RANK = { viewer: 1, admin: 2, owner: 3 };
const PERM_MIN_ROLE = {
  view: 'viewer',    // read-only data + SSE stream
  stream: 'viewer',
  actions: 'admin',  // warn/kick/ban/unban/broadcast/layer/match/squads/flags review/notes/manual bans
  ips: 'admin',      // player IPs + alt detection
  audit: 'admin',    // §19.3.23: viewer gets 403 on /api/audit
  adminChat: 'admin',// admin-channel chat + ADMIN_CAM intel
  raw: 'owner',      // raw RCON console
  console: 'owner',
  users: 'owner',
  slomo: 'owner',
  settings: 'owner',
};

function can(user, perm) {
  if (!user || !user.role) return false;
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

  function verifySetupToken(token) {
    if (!setupTokenHex || typeof token !== 'string' || token.length === 0 || token.length > 256) return false;
    const a = crypto.createHash('sha256').update(token).digest();
    const b = crypto.createHash('sha256').update(setupTokenHex).digest();
    return crypto.timingSafeEqual(a, b);
  }

  function createUser(username, password, role) {
    const uname = String(username == null ? '' : username).trim();
    if (!uname || uname.length > 64) throw new Error('username must be 1-64 characters');
    if (typeof password !== 'string' || password.length < 1) throw new Error('password required');
    if (password.length > 1024) throw new Error('password too long');
    if (!ROLES.has(role)) throw new Error("role must be 'owner', 'admin' or 'viewer'");
    const t = now();
    try {
      const r = stmt('INSERT INTO users(username, pass_hash, role, created_at, disabled) VALUES(?,?,?,?,0)')
        .run(uname, hashPassword(password), role, t);
      return { id: r.lastInsertRowid, username: uname, role };
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
      ? stmt('SELECT id, username, role, pass_hash, disabled FROM users WHERE username = ?').get(uname)
      : undefined;
    if (!row) {
      verifyPassword(String(password == null ? '' : password), dummyHash()); // timing equalizer
      return null;
    }
    const ok = verifyPassword(String(password == null ? '' : password), row.pass_hash);
    if (!ok || row.disabled) return null;
    stmt('UPDATE users SET last_login=? WHERE id=?').run(now(), row.id);
    return { id: row.id, username: row.username, role: row.role };
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
  // role always read from that row. Sliding: refresh when < 15d left.
  function getSession(token) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
    const t = now();
    const row = stmt(
      `SELECT s.token_hash AS token_hash, s.expires_at AS expires_at,
              u.id AS id, u.username AS username, u.role AS role
         FROM auth_sessions s JOIN users u ON u.id = s.user_id
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
    return { user: { id: row.id, username: row.username, role: row.role }, expiresAt, refreshed };
  }

  function destroySession(token) {
    if (typeof token !== 'string' || !token) return false;
    return stmt('DELETE FROM auth_sessions WHERE token_hash=?').run(sha256hex(token)).changes > 0;
  }

  function destroyUserSessions(userId) {
    return stmt('DELETE FROM auth_sessions WHERE user_id=?').run(userId).changes;
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

module.exports = { createAuth, hashPassword, verifyPassword, can, createLoginLimiter, ROLES };
