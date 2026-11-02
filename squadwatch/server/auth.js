'use strict';
// Users, sessions, roles, login rate limiting, audit log.
// SPEC §12 with binding amendments §19.1.3 (createAuth factory shape),
// §19.3.15 (first-run setup token), §19.3.18 (session JOIN + disabled check,
// destroyUserSessions on user mutation), §19.3.19 (limiter keyed on clientIp,
// capped + swept map), §19.3.23 (viewer may NOT read audit).
// Login hardening: limiter keyed per address (IPv6 by /64) AND per username,
// password checks on the threadpool behind an in-flight cap, and an
// 8-character minimum for new passwords.
const crypto = require('node:crypto');
const { log, sha256hex, randomTokenHex } = require('./util');

// ---------------------------------------------------------------- passwords

// §12: scrypt$N=16384,r=8,p=1$<salt b64>$<hash b64>; randomBytes(16) salt, 64-byte key.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

// Applies to NEW passwords only: accounts stored before it keep logging in.
const MIN_PASSWORD_CHARS = 8;
const MAX_PASSWORD_CHARS = 1024;

// scrypt runs on libuv's threadpool (4 threads by default); checks beyond
// this many would only queue there, so verifyLogin refuses them outright.
const MAX_PASSWORD_CHECKS = 4;

// Sync on purpose: account creation is rare and runs inside db.tx.
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(pw), salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// null when `pw` is acceptable as a new password, else why not (the API's
// 400 message).
function passwordProblem(pw) {
  if (typeof pw !== 'string' || pw.length === 0) return 'password required';
  if (pw.length > MAX_PASSWORD_CHARS) return 'password too long';
  // Code points, so an emoji counts once rather than as two UTF-16 halves.
  if ([...pw].length < MIN_PASSWORD_CHARS) return `password must be at least ${MIN_PASSWORD_CHARS} characters`;
  return null;
}

const HASH_RE = /^scrypt\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

// Parsed stored hash, or null when it is not one we can check.
function parseHash(stored) {
  const m = HASH_RE.exec(String(stored == null ? '' : stored));
  if (!m) return null;
  const N = parseInt(m[1], 10);
  const r = parseInt(m[2], 10);
  const p = parseInt(m[3], 10);
  // Sanity bounds: our own format only ever writes 16384/8/1, but stay
  // self-describing without letting a corrupt row allocate gigabytes.
  if (!(N >= 2 && N <= 131072) || !(r >= 1 && r <= 32) || !(p >= 1 && p <= 16)) return null;
  if ((N & (N - 1)) !== 0) return null; // N must be a power of two
  const salt = Buffer.from(m[4], 'base64');
  const want = Buffer.from(m[5], 'base64');
  if (want.length < 16 || want.length > 128) return null;
  return { N, r, p, salt, want };
}

// crypto.scrypt (not scryptSync): a check must never stall the event loop
// that carries SSE, RCON polling and every other request.
function scryptAsync(pw, salt, keylen, opts) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pw, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function checkHash(pw, h) {
  try {
    const got = await scryptAsync(String(pw), h.salt, h.want.length, {
      N: h.N, r: h.r, p: h.p, maxmem: Math.max(64 * 1024 * 1024, 256 * h.N * h.r),
    });
    return got.length === h.want.length && crypto.timingSafeEqual(got, h.want);
  } catch (_e) {
    return false;
  }
}

// Resolves true/false; an unusable stored hash is simply false.
async function verifyPassword(pw, stored) {
  const h = parseHash(stored);
  return h ? checkHash(pw, h) : false;
}

// Unknown users and unreadable stored hashes are checked against this, so
// every failed login pays exactly one scrypt (no timing oracle for names).
let _dummyHash = null;
function dummyHash() {
  if (!_dummyHash) _dummyHash = parseHash(hashPassword(randomTokenHex(12)));
  return _dummyHash;
}

// ------------------------------------------------------------- login limiter

function ipv4Octets(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

// Eight 16-bit groups, or null. Expands '::' and a trailing dotted quad
// ('::ffff:192.0.2.1').
function ipv6Hextets(s) {
  if (s.length > 45 || !/^[0-9a-f:.]+$/i.test(s)) return null;
  let str = s;
  if (str.includes('.')) {
    const cut = str.lastIndexOf(':');
    const o = cut >= 0 ? ipv4Octets(str.slice(cut + 1)) : null;
    if (!o) return null;
    str = `${str.slice(0, cut + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const groups = (x) => (x === '' ? [] : x.split(':'));
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  if (!head.concat(tail).every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const zeros = 8 - head.length - tail.length;
  if (halves.length === 2 ? zeros < 1 : zeros !== 0) return null;
  return head.concat(new Array(zeros).fill('0'), tail).map((g) => parseInt(g, 16));
}

// Limiter key for a client address. IPv4 — also IPv4-mapped IPv6, as a
// dual-stack socket reports it — stays exact. IPv6 collapses to its /64, one
// subscriber's allocation: whoever holds a /64 can rotate the low 64 bits
// freely, and each rotation must not buy a fresh bucket. Brackets, a trailing
// :port and a %zone are tolerated; anything unparseable is keyed by its own
// (bounded) text.
function clientAddressKey(ip) {
  let s = String(ip == null ? '' : ip).trim();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(s);
  if (bracketed) s = bracketed[1];
  else {
    const v4port = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s);
    if (v4port) s = v4port[1];
  }
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const v4 = ipv4Octets(s);
  if (v4) return v4.join('.');
  const h = ipv6Hextets(s);
  if (!h) return s.toLowerCase().slice(0, 64);
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) {
    return [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join('.');
  }
  const net = h.slice(0, 4);
  while (net.length && net[net.length - 1] === 0) net.pop();
  return `${net.map((x) => x.toString(16)).join(':')}::/64`;
}

// Username limiter key: groups exactly the spellings the users table resolves
// to one account (username TEXT UNIQUE COLLATE NOCASE, looked up trimmed).
// NOCASE folds ASCII A-Z only — toLowerCase() would also merge 'kilo' with
// '\u212Ailo' (KELVIN SIGN), a separate account whose logins would then clear
// kilo's failures. NOCASE also stops comparing at the first NUL (byte lengths
// must still match), and SQLite receives a lone surrogate as U+FFFD: keying
// those spellings apart would hand one account many fresh buckets.
function usernameKey(username) {
  const s = String(username == null ? '' : username).trim().toWellFormed();
  const nul = s.indexOf('\0');
  const head = (nul < 0 ? s : s.slice(0, nul)).replace(/[A-Z]/g, (c) => c.toLowerCase());
  return nul < 0 ? head : `${head}\0${Buffer.byteLength(s)}`;
}

// §12 + §19.3.19, two independent limits (-> 429 at the API layer):
//  - per client address (clientAddressKey): EVERY attempt counts and no
//    success resets it, so an account holder cannot clear their own
//    address's bucket between guesses at someone else's account.
//  - per username (usernameKey): failed password checks only; only that
//    account's own successful login clears them. Unknown names are tracked
//    exactly like real ones, so the limiter is no username oracle. Checks
//    still running count toward the limit (claimUser reserves one before the
//    async check), so a concurrent burst cannot overshoot it.
// Both maps are capped, dropping the least recently touched key first, and
// swept per minute (interval unref'd so it never keeps the process alive;
// sweeps also run lazily on use). Username failures are only recorded after
// a real scrypt check, which the in-flight cap throttles, so evicting a live
// entry by spraying unique names takes minutes of saturated logins at this
// maxUserEntries.
function createLoginLimiter({
  max = 10, windowMs = 60000, maxEntries = 10000,
  userMax = 10, userWindowMs = 600000, maxUserEntries = 50000,
} = {}) {
  const hits = new Map(); // address key -> attempt timestamps within windowMs
  const fails = new Map(); // username key -> newest failure timestamps within userWindowMs
  // username key -> claimed checks not yet settled. Each claim settles within
  // one password check, so this map needs no sweep or cap.
  const claims = new Map();
  let lastSweep = Date.now();

  function prune(map, win, t) {
    for (const [key, arr] of map) {
      const live = arr.filter((ts) => t - ts < win);
      if (live.length === 0) map.delete(key);
      else map.set(key, live);
    }
  }
  // Map order is insertion order and touch() re-inserts, so the first key is
  // the least recently touched.
  function cap(map, limit) {
    while (map.size > limit) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
  }
  function touch(map, key, arr) {
    map.delete(key);
    map.set(key, arr);
  }

  function sweep(now) {
    const t = now == null ? Date.now() : now;
    lastSweep = t;
    prune(hits, windowMs, t);
    prune(fails, userWindowMs, t);
    cap(hits, maxEntries);
    cap(fails, maxUserEntries);
  }
  function lazySweep(now) {
    if (now - lastSweep >= 60000) sweep(now);
  }

  const timer = setInterval(() => sweep(), 60000);
  if (typeof timer.unref === 'function') timer.unref();

  // Seconds until fewer than `limit` timestamps remain inside the window.
  function retryAfterSec(arr, limit, win, now) {
    return Math.max(1, Math.ceil((arr[arr.length - limit] + win - now) / 1000));
  }

  function attempt(ip) {
    const now = Date.now();
    lazySweep(now);
    const key = clientAddressKey(ip);
    const arr = (hits.get(key) || []).filter((ts) => now - ts < windowMs);
    if (arr.length >= max) {
      touch(hits, key, arr);
      return { ok: false, retryAfterSec: retryAfterSec(arr, max, windowMs, now) };
    }
    arr.push(now);
    touch(hits, key, arr);
    cap(hits, maxEntries);
    return { ok: true, remaining: max - arr.length };
  }

  function recordFailure(key) {
    const now = Date.now();
    // Only the newest userMax failures can ever decide the lock.
    const arr = (fails.get(key) || []).filter((ts) => now - ts < userWindowMs).concat(now).slice(-userMax);
    touch(fails, key, arr);
    cap(fails, maxUserEntries);
  }

  // Reserves one password check against `username`'s limit, or refuses once
  // its failures plus the checks still in flight reach userMax. The caller
  // settles the claim exactly once: fail() records a failure; succeed()
  // clears that account's failures (never an address bucket, and claims
  // still in flight keep counting); release() when no check ran. Later calls
  // are no-ops.
  function claimUser(username) {
    const now = Date.now();
    lazySweep(now);
    const key = usernameKey(username);
    const arr = (fails.get(key) || []).filter((ts) => now - ts < userWindowMs);
    const pending = claims.get(key) || 0;
    if (arr.length + pending >= userMax) {
      // Held only by running checks, the lock lifts or hardens within a second.
      const wait = arr.length >= userMax ? retryAfterSec(arr, userMax, userWindowMs, now) : 1;
      return { ok: false, retryAfterSec: wait };
    }
    claims.set(key, pending + 1);
    let open = true;
    const settle = (then) => () => {
      if (!open) return;
      open = false;
      const left = (claims.get(key) || 1) - 1;
      if (left > 0) claims.set(key, left);
      else claims.delete(key);
      if (then) then(key);
    };
    return {
      ok: true,
      fail: settle(recordFailure),
      succeed: settle((k) => fails.delete(k)),
      release: settle(null),
    };
  }

  return {
    attempt,
    claimUser,
    sweep,
    stop() { clearInterval(timer); },
    get size() { return hits.size; },
    get userSize() { return fails.size; },
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
  quickcmd: 'admin',   // run the owner-approved quick commands (presets)
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
  { key: 'quickcmd', group: 'Server control', label: 'Run quick commands' },
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
    const weak = passwordProblem(password);
    if (weak) throw new Error(weak);
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

  dummyHash(); // built now, at boot, instead of on the first unknown-user login

  let checksInFlight = 0;

  // Resolves the user, or null for ANY failure (wrong password, unknown,
  // disabled, unreadable hash) — each path awaits exactly one scrypt. When
  // MAX_PASSWORD_CHECKS are already running it rejects at once with
  // code 'ELOGINBUSY' (+ retryAfterSec) rather than queueing.
  async function verifyLogin(username, password) {
    if (checksInFlight >= MAX_PASSWORD_CHECKS) {
      const busy = new Error('too many password checks in progress');
      busy.code = 'ELOGINBUSY';
      busy.retryAfterSec = 1;
      throw busy;
    }
    checksInFlight++;
    try {
      const uname = String(username == null ? '' : username).trim();
      const row = uname ? stmt('SELECT id, pass_hash FROM users WHERE username = ?').get(uname) : undefined;
      const stored = row ? parseHash(row.pass_hash) : null;
      const ok = await checkHash(String(password == null ? '' : password), stored || dummyHash());
      if (!stored || !ok) return null;
      // The check yielded to the event loop: re-read, so a password reset or
      // a disable that landed meanwhile still wins.
      const cur = stmt(
        `SELECT u.id, u.username, u.pass_hash, u.disabled, r.id AS role_id, r.name AS role, r.perms AS perms
           FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
      ).get(row.id);
      if (!cur || cur.disabled || cur.pass_hash !== row.pass_hash) return null;
      stmt('UPDATE users SET last_login=? WHERE id=?').run(now(), cur.id);
      return { id: cur.id, username: cur.username, role: cur.role, roleId: cur.role_id, perms: parsePerms(cur.role_id, cur.perms) };
    } finally {
      checksInFlight--;
    }
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
    passwordProblem,
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
  createAuth, hashPassword, verifyPassword, passwordProblem, can, createLoginLimiter, clientAddressKey, ROLES,
  PERM_KEYS, PERM_INFO, builtinRolePerms, sanitizePerms,
};
