'use strict';
// Unit tests for server/auth.js (SPEC §12, §19.1.3, §19.3.15/18/19):
// scrypt hash/verify, sessions (create/get/expiry/sliding/disabled), setup
// token, destroyUserSessions, can() matrix, login limiter (5/60s -> blocked).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { setTimeout: sleep } = require('node:timers/promises');

const { openDb } = require('../server/db');
const { createAuth, hashPassword, verifyPassword, can, createLoginLimiter } = require('../server/auth');

function freshDb() {
  const db = openDb(':memory:');
  db.migrate();
  return db;
}
function freshAuth(extra) {
  const db = freshDb();
  const auth = createAuth(Object.assign({ db, config: {} }, extra));
  return { db, auth };
}

// ------------------------------------------------------------ password hash

test('hashPassword produces the exact §12 scrypt format and verifies', () => {
  const h = hashPassword('hunter2!');
  assert.match(h, /^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  const parts = h.split('$');
  assert.strictEqual(Buffer.from(parts[2], 'base64').length, 16); // randomBytes(16) salt
  assert.strictEqual(Buffer.from(parts[3], 'base64').length, 64); // 64-byte key
  assert.strictEqual(verifyPassword('hunter2!', h), true);
});

test('verifyPassword rejects wrong password, malformed and empty hashes', () => {
  const h = hashPassword('correct horse');
  assert.strictEqual(verifyPassword('wrong horse', h), false);
  assert.strictEqual(verifyPassword('', h), false);
  assert.strictEqual(verifyPassword('correct horse', 'not-a-hash'), false);
  assert.strictEqual(verifyPassword('correct horse', ''), false);
  assert.strictEqual(verifyPassword('correct horse', null), false);
  // tampered salt -> false
  const parts = h.split('$');
  const bad = [parts[0], parts[1], Buffer.from('0123456789abcdef').toString('base64'), parts[3]].join('$');
  assert.strictEqual(verifyPassword('correct horse', bad), false);
});

test('two hashes of the same password differ (random salt)', () => {
  assert.notStrictEqual(hashPassword('same'), hashPassword('same'));
});

// ----------------------------------------------------------- setup + users

test('first-run setup token + createFirstOwner (single use, tx re-check)', () => {
  const { auth } = freshAuth();
  assert.strictEqual(auth.needsSetup(), true);
  assert.match(auth.setupToken, /^[0-9a-f]{32}$/); // randomBytes(16).hex
  assert.strictEqual(auth.verifySetupToken('wrong'), false);
  assert.strictEqual(auth.verifySetupToken(''), false);
  assert.strictEqual(auth.verifySetupToken(auth.setupToken), true);

  const owner = auth.createFirstOwner({ username: 'boss', password: 'pw-pw-pw' });
  assert.strictEqual(owner.role, 'owner');
  assert.strictEqual(auth.needsSetup(), false);
  assert.strictEqual(auth.setupToken, null); // consumed
  assert.throws(() => auth.createFirstOwner({ username: 'x', password: 'y' }), /already completed/);
});

test('no setup token is generated when users already exist', () => {
  const db = freshDb();
  const first = createAuth({ db, config: {} });
  first.createFirstOwner({ username: 'boss', password: 'pw' });
  const again = createAuth({ db, config: {} });
  assert.strictEqual(again.needsSetup(), false);
  assert.strictEqual(again.setupToken, null);
});

test('createUser validates role/username and rejects duplicates (NOCASE)', () => {
  const { auth } = freshAuth();
  const u = auth.createUser('Alice', 'secret-1', 'admin');
  assert.ok(u.id > 0);
  assert.throws(() => auth.createUser('alice', 'other', 'viewer'), /already taken/i);
  assert.throws(() => auth.createUser('bob', 'pw', 'superuser'), /role/i);
  assert.throws(() => auth.createUser('', 'pw', 'viewer'), /username/i);
  assert.throws(() => auth.createUser('bob', '', 'viewer'), /password/i);
});

test('verifyLogin: ok, case-insensitive username, wrong pw, unknown, disabled', () => {
  const { db, auth } = freshAuth();
  auth.createUser('Wardex', 'top-secret', 'admin');
  const ok = auth.verifyLogin('wardex', 'top-secret');
  assert.ok(ok && ok.role === 'admin' && ok.username === 'Wardex');
  assert.strictEqual(auth.verifyLogin('Wardex', 'nope'), null);
  assert.strictEqual(auth.verifyLogin('ghost', 'top-secret'), null);
  db.prepare('UPDATE users SET disabled=1 WHERE username=?').run('Wardex');
  assert.strictEqual(auth.verifyLogin('Wardex', 'top-secret'), null);
});

// ---------------------------------------------------------------- sessions

test('session create/get roundtrip (JOIN returns role from users row)', () => {
  const { auth } = freshAuth();
  const u = auth.createUser('sess', 'pw123456', 'viewer');
  const s = auth.createSession(u.id, { ip: '1.2.3.4', ua: 'test-agent' });
  assert.match(s.token, /^[0-9a-f]{64}$/); // randomBytes(32).hex
  assert.ok(s.expiresAt > Date.now() + 29 * 86400 * 1000);
  const got = auth.getSession(s.token);
  assert.ok(got);
  assert.deepStrictEqual(got.user, { id: u.id, username: 'sess', role: 'viewer' });
  assert.strictEqual(auth.getSession('deadbeef'.repeat(8)), null);
  assert.strictEqual(auth.getSession(''), null);
  assert.strictEqual(auth.getSession(null), null);
});

test('only sha256(token) is stored, never the token itself', () => {
  const { db, auth } = freshAuth();
  const u = auth.createUser('h', 'pw123456', 'admin');
  const s = auth.createSession(u.id, {});
  const row = db.prepare('SELECT token_hash FROM auth_sessions').get();
  assert.notStrictEqual(row.token_hash, s.token);
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
});

test('expired sessions are rejected', () => {
  const { db, auth } = freshAuth();
  const u = auth.createUser('exp', 'pw123456', 'admin');
  const s = auth.createSession(u.id, {});
  db.prepare('UPDATE auth_sessions SET expires_at=? WHERE user_id=?').run(Date.now() - 1000, u.id);
  assert.strictEqual(auth.getSession(s.token), null);
});

test('sliding refresh: expiry < 15d left is pushed back out to ~30d', () => {
  const { db, auth } = freshAuth();
  const u = auth.createUser('slide', 'pw123456', 'admin');
  const s = auth.createSession(u.id, {});
  const soon = Date.now() + 5 * 86400 * 1000; // 5 days left
  db.prepare('UPDATE auth_sessions SET expires_at=? WHERE user_id=?').run(soon, u.id);
  const got = auth.getSession(s.token);
  assert.ok(got && got.refreshed === true);
  assert.ok(got.expiresAt > Date.now() + 29 * 86400 * 1000);
  const row = db.prepare('SELECT expires_at FROM auth_sessions WHERE user_id=?').get(u.id);
  assert.strictEqual(Number(row.expires_at), got.expiresAt);
  // a fresh session (30d left) is NOT refreshed
  const s2 = auth.createSession(u.id, {});
  const got2 = auth.getSession(s2.token);
  assert.strictEqual(got2.refreshed, false);
});

test('disabled user is rejected at session resolution (§19.3.18 JOIN check)', () => {
  const { db, auth } = freshAuth();
  const u = auth.createUser('dis', 'pw123456', 'admin');
  const s = auth.createSession(u.id, {});
  assert.ok(auth.getSession(s.token));
  db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(u.id);
  assert.strictEqual(auth.getSession(s.token), null);
});

test('destroySession and destroyUserSessions', () => {
  const { auth } = freshAuth();
  const a = auth.createUser('a', 'pw123456', 'admin');
  const b = auth.createUser('b', 'pw123456', 'viewer');
  const s1 = auth.createSession(a.id, {});
  const s2 = auth.createSession(a.id, {});
  const s3 = auth.createSession(b.id, {});
  assert.strictEqual(auth.destroySession(s1.token), true);
  assert.strictEqual(auth.getSession(s1.token), null);
  assert.ok(auth.getSession(s2.token));
  assert.strictEqual(auth.destroyUserSessions(a.id), 1); // s2 remained
  assert.strictEqual(auth.getSession(s2.token), null);
  assert.ok(auth.getSession(s3.token), 'other user sessions must survive');
  assert.strictEqual(auth.destroySession(s1.token), false); // already gone
});

// ---------------------------------------------------------------- can()

test('can() permission matrix spot checks (§12 + §19.3.23)', () => {
  const viewer = { id: 1, role: 'viewer' };
  const admin = { id: 2, role: 'admin' };
  const owner = { id: 3, role: 'owner' };
  // viewer: read-only; no IPs, no actions, no audit (§19.3.23), no console/users
  assert.strictEqual(can(viewer, 'view'), true);
  assert.strictEqual(can(viewer, 'actions'), false);
  assert.strictEqual(can(viewer, 'ips'), false);
  assert.strictEqual(can(viewer, 'audit'), false);
  assert.strictEqual(can(viewer, 'adminChat'), false);
  assert.strictEqual(can(viewer, 'raw'), false);
  assert.strictEqual(can(viewer, 'users'), false);
  // admin: actions + IPs + audit, but no owner-only surface
  assert.strictEqual(can(admin, 'view'), true);
  assert.strictEqual(can(admin, 'actions'), true);
  assert.strictEqual(can(admin, 'ips'), true);
  assert.strictEqual(can(admin, 'audit'), true);
  assert.strictEqual(can(admin, 'raw'), false);
  assert.strictEqual(can(admin, 'users'), false);
  assert.strictEqual(can(admin, 'slomo'), false);
  assert.strictEqual(can(admin, 'settings'), false);
  // owner: everything
  for (const p of ['view', 'actions', 'ips', 'audit', 'raw', 'console', 'users', 'slomo', 'settings']) {
    assert.strictEqual(can(owner, p), true, `owner should have ${p}`);
  }
  // unknown perms and bad users are denied
  assert.strictEqual(can(owner, 'nonsense-perm'), false);
  assert.strictEqual(can(null, 'view'), false);
  assert.strictEqual(can({ role: 'intruder' }, 'view'), false);
});

// ---------------------------------------------------------------- limiter

test('login limiter: 5 attempts pass, the 6th within 60s is blocked (-> 429)', () => {
  const { auth } = freshAuth();
  const ip = '203.0.113.7';
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(auth.loginLimiter.attempt(ip).ok, true, `attempt ${i + 1} should pass`);
  }
  const blocked = auth.loginLimiter.attempt(ip);
  assert.strictEqual(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
  // other IPs are unaffected; reset() clears the key
  assert.strictEqual(auth.loginLimiter.attempt('198.51.100.9').ok, true);
  auth.loginLimiter.reset(ip);
  assert.strictEqual(auth.loginLimiter.attempt(ip).ok, true);
});

test('login limiter window expires and map stays capped/swept (§19.3.19)', async () => {
  const lim = createLoginLimiter({ max: 2, windowMs: 40, maxEntries: 10 });
  assert.strictEqual(lim.attempt('ip-x').ok, true);
  assert.strictEqual(lim.attempt('ip-x').ok, true);
  assert.strictEqual(lim.attempt('ip-x').ok, false);
  await sleep(60); // window passed
  assert.strictEqual(lim.attempt('ip-x').ok, true);
  for (let i = 0; i < 50; i++) lim.attempt(`flood-${i}`);
  assert.ok(lim.size <= 10, `map must stay capped (size=${lim.size})`);
  lim.stop();
});

// ---------------------------------------------------------------- audit

test('audit() inserts an admin_actions row and emits bus admin-action', () => {
  const bus = new EventEmitter();
  const { db, auth } = freshAuth({ bus });
  const u = auth.createUser('aud', 'pw123456', 'owner');
  let emitted = null;
  bus.on('admin-action', (a) => { emitted = a; });
  const id = auth.audit(u.id, 'kick', {
    targetPlayerId: 42,
    details: { reason: 'tk' },
    rconCommand: 'AdminKickById 7 tk',
    rconResponse: 'Kicked player 7.',
    rconOk: true,
  });
  assert.ok(id > 0);
  const row = db.prepare('SELECT * FROM admin_actions WHERE id=?').get(id);
  assert.strictEqual(row.user_id, u.id);
  assert.strictEqual(row.action, 'kick');
  assert.strictEqual(row.target_player_id, 42);
  assert.strictEqual(row.rcon_command, 'AdminKickById 7 tk');
  assert.strictEqual(row.rcon_response, 'Kicked player 7.');
  assert.strictEqual(Number(row.rcon_ok), 1);
  assert.deepStrictEqual(JSON.parse(row.details), { reason: 'tk' });
  assert.ok(emitted && emitted.id === id && emitted.action === 'kick');
  // system action: user NULL (§19.1.2)
  const sysId = auth.audit(null, 'warn', { rconCommand: 'AdminWarn x y', rconResponse: 'ok', rconOk: false });
  const sysRow = db.prepare('SELECT * FROM admin_actions WHERE id=?').get(sysId);
  assert.strictEqual(sysRow.user_id, null);
  assert.strictEqual(Number(sysRow.rcon_ok), 0);
});
