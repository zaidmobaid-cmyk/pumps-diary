'use strict';
// Unit tests for server/auth.js (SPEC §12, §19.1.3, §19.3.15/18/19):
// scrypt hash/verify (async), sessions (create/get/expiry/sliding/disabled),
// setup token, destroyUserSessions, can() matrix, login limiter (10/60s per
// address with IPv6 by /64 and never reset by a success; 10 failures / 10 min
// per username, checks in flight counted, cleared only by that username's own
// success; capped maps).
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

test('hashPassword produces the exact §12 scrypt format and verifies', async () => {
  const h = hashPassword('hunter2!');
  assert.match(h, /^scrypt\$N=16384,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  const parts = h.split('$');
  assert.strictEqual(Buffer.from(parts[2], 'base64').length, 16); // randomBytes(16) salt
  assert.strictEqual(Buffer.from(parts[3], 'base64').length, 64); // 64-byte key
  const pending = verifyPassword('hunter2!', h);
  assert.ok(pending instanceof Promise, 'verification runs off the event loop');
  assert.strictEqual(await pending, true);
});

test('verifyPassword rejects wrong password, malformed and empty hashes', async () => {
  const h = hashPassword('correct horse');
  assert.strictEqual(await verifyPassword('wrong horse', h), false);
  assert.strictEqual(await verifyPassword('', h), false);
  assert.strictEqual(await verifyPassword('correct horse', 'not-a-hash'), false);
  assert.strictEqual(await verifyPassword('correct horse', ''), false);
  assert.strictEqual(await verifyPassword('correct horse', null), false);
  // tampered salt -> false
  const parts = h.split('$');
  const bad = [parts[0], parts[1], Buffer.from('0123456789abcdef').toString('base64'), parts[3]].join('$');
  assert.strictEqual(await verifyPassword('correct horse', bad), false);
  // absurd cost parameters are refused before any work (no huge allocation)
  const huge = h.replace('N=16384', 'N=1048576');
  assert.strictEqual(await verifyPassword('correct horse', huge), false);
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
  first.createFirstOwner({ username: 'boss', password: 'pw-pw-pw' });
  const again = createAuth({ db, config: {} });
  assert.strictEqual(again.needsSetup(), false);
  assert.strictEqual(again.setupToken, null);
});

test('createUser validates role/username and rejects duplicates (NOCASE)', () => {
  const { auth } = freshAuth();
  const u = auth.createUser('Alice', 'secret-1', 'admin');
  assert.ok(u.id > 0);
  assert.throws(() => auth.createUser('alice', 'other-pass', 'viewer'), /already taken/i);
  assert.throws(() => auth.createUser('bob', 'pw123456', 'superuser'), /role/i);
  assert.throws(() => auth.createUser('', 'pw123456', 'viewer'), /username/i);
  assert.throws(() => auth.createUser('bob', '', 'viewer'), /password/i);
  assert.throws(() => auth.createUser('bob', 'pw12345', 'viewer'), /at least 8 characters/);
});

test('verifyLogin: ok, case-insensitive username, wrong pw, unknown, disabled', async () => {
  const { db, auth } = freshAuth();
  auth.createUser('Wardex', 'top-secret', 'admin');
  const ok = await auth.verifyLogin('wardex', 'top-secret');
  assert.ok(ok && ok.role === 'admin' && ok.username === 'Wardex');
  assert.strictEqual(await auth.verifyLogin('Wardex', 'nope'), null);
  assert.strictEqual(await auth.verifyLogin('ghost', 'top-secret'), null);
  db.prepare('UPDATE users SET disabled=1 WHERE username=?').run('Wardex');
  assert.strictEqual(await auth.verifyLogin('Wardex', 'top-secret'), null);
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
  assert.deepStrictEqual(got.user, {
    id: u.id, username: 'sess', role: 'viewer', roleId: u.roleId,
    perms: { view: true, stream: true },
  });
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
  // viewer: read-only; no IPs, no moderation, no audit (§19.3.23), no users
  assert.strictEqual(can(viewer, 'view'), true);
  assert.strictEqual(can(viewer, 'stream'), true);
  for (const p of ['kick', 'ban', 'warn', 'flags', 'ips', 'audit', 'adminChat', 'raw', 'users']) {
    assert.strictEqual(can(viewer, p), false, `viewer must not have ${p}`);
  }
  // admin: moderation + server control + IPs + audit, but no owner-only surface
  assert.strictEqual(can(admin, 'view'), true);
  for (const p of ['notes', 'flags', 'warn', 'kick', 'ban', 'broadcast', 'team', 'squad', 'layer', 'match', 'ips', 'audit', 'adminChat']) {
    assert.strictEqual(can(admin, p), true, `admin should have ${p}`);
  }
  for (const p of ['raw', 'users', 'roles', 'slomo', 'settings']) {
    assert.strictEqual(can(admin, p), false, `admin must not have ${p}`);
  }
  // owner: everything in the catalog
  for (const p of ['view', 'kick', 'ban', 'ips', 'audit', 'raw', 'users', 'roles', 'slomo', 'settings']) {
    assert.strictEqual(can(owner, p), true, `owner should have ${p}`);
  }
  // custom perms object wins over the role fallback (unknown keys deny)
  const custom = { id: 4, role: 'Trial Mod', perms: { view: true, kick: true } };
  assert.strictEqual(can(custom, 'view'), true);
  assert.strictEqual(can(custom, 'kick'), true);
  assert.strictEqual(can(custom, 'ban'), false);
  assert.strictEqual(can(custom, 'raw'), false);
  assert.strictEqual(can({ id: 5, role: 'owner', perms: { view: true } }, 'raw'), false,
    'perms object wins even when the role name says owner');
  // unknown perms and bad users are denied
  assert.strictEqual(can(owner, 'nonsense-perm'), false);
  assert.strictEqual(can(null, 'view'), false);
  assert.strictEqual(can({ role: 'intruder' }, 'view'), false);
});

// ---------------------------------------------------------------- limiter

// One failed password check against `name`; false when no claim was granted.
function failOnce(lim, name) {
  const c = lim.claimUser(name);
  if (c.ok) c.fail();
  return c.ok;
}
// Would a check against `name` be claimable right now? (gives the claim back)
function userOpen(lim, name) {
  const c = lim.claimUser(name);
  if (c.ok) c.release();
  return c.ok;
}

test('login limiter: 10 attempts per address pass, the 11th within 60s is blocked (-> 429); no success reopens it', () => {
  const { auth } = freshAuth();
  const lim = auth.loginLimiter;
  const ip = '203.0.113.7';
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(lim.attempt(ip).ok, true, `attempt ${i + 1} should pass`);
  }
  const blocked = lim.attempt(ip);
  assert.strictEqual(blocked.ok, false);
  assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
  assert.strictEqual(lim.reset, undefined, 'there is no way to clear an address bucket');
  lim.claimUser('whoever-just-logged-in').succeed();
  assert.strictEqual(lim.attempt(ip).ok, false, 'a successful login from the address changes nothing');
  assert.strictEqual(lim.attempt('::ffff:203.0.113.7').ok, false, 'the IPv4-mapped form is the same client');
  assert.strictEqual(lim.attempt('198.51.100.9').ok, true, 'other addresses are unaffected');
});

test('login limiter: IPv6 clients share one bucket per /64 — rotating the low 64 bits buys nothing', () => {
  const lim = createLoginLimiter({ max: 3 });
  assert.strictEqual(lim.attempt('2001:db8:aa:bb::1').ok, true);
  assert.strictEqual(lim.attempt('2001:db8:aa:bb:ffff:ffff:ffff:fffe').ok, true);
  assert.strictEqual(lim.attempt('2001:0db8:00aa:00bb:1234::').ok, true);
  const blocked = lim.attempt('2001:db8:aa:bb:dead:beef:0:1');
  assert.strictEqual(blocked.ok, false, 'a fourth /128 inside the same /64 is still the same bucket');
  assert.ok(blocked.retryAfterSec >= 1);
  assert.strictEqual(lim.attempt('2001:db8:aa:bc::1').ok, true, 'the neighbouring /64 is another client');
  assert.strictEqual(lim.size, 2);
  lim.stop();
});

test('login limiter: a username locks after 10 failures (ASCII case-insensitive); only its own success clears it', () => {
  const lim = createLoginLimiter();
  for (let i = 0; i < 9; i++) assert.ok(failOnce(lim, i % 2 ? 'Victim' : ' victim '), `failure ${i + 1}`);
  assert.strictEqual(userOpen(lim, 'VICTIM'), true, '9 failures: still open');
  lim.claimUser('someone-else').succeed();
  assert.ok(failOnce(lim, 'victim'), "another account's success cleared nothing, so this is failure 10");
  const locked = lim.claimUser('Victim');
  assert.strictEqual(locked.ok, false, '10th failure locks the name');
  assert.ok(locked.retryAfterSec > 60 && locked.retryAfterSec <= 600, `10-minute window (got ${locked.retryAfterSec})`);
  lim.claimUser('someone-else').succeed();
  assert.strictEqual(userOpen(lim, 'victim'), false, "another account's success leaves the lock alone");
  assert.ok(lim.attempt('203.0.113.50').ok, 'username locks never touch address buckets');
  // names nobody owns are tracked exactly the same way
  for (let i = 0; i < 10; i++) failOnce(lim, 'no-such-user');
  assert.strictEqual(userOpen(lim, 'no-such-user'), false);
  // the name's own success, in any ASCII case, clears its failures
  for (let i = 0; i < 9; i++) failOnce(lim, 'alice');
  lim.claimUser(' ALICE').succeed();
  for (let i = 0; i < 9; i++) assert.ok(failOnce(lim, 'alice'), `failure ${i + 1} after her success`);
  assert.strictEqual(userOpen(lim, 'alice'), true, 'the 9 before her success were cleared');
  assert.strictEqual(userOpen(lim, 'no-such-user'), false);
  lim.stop();
});

test("login limiter: checks still in flight count toward a username's limit; each claim settles once", () => {
  const lim = createLoginLimiter({ userMax: 3 });
  const a = lim.claimUser('target');
  const b = lim.claimUser('TARGET');
  a.fail(); // 1 failure, b in flight
  const c = lim.claimUser('target');
  assert.strictEqual(c.ok, true, '1 failure + 1 in flight: room for one more');
  const full = lim.claimUser('target');
  assert.strictEqual(full.ok, false, '1 failure + 2 in flight reach the limit');
  assert.strictEqual(full.retryAfterSec, 1, 'held only by running checks');
  b.release(); // no check ran: its slot comes back
  b.release();
  b.fail(); // already settled: no-ops
  const d = lim.claimUser('target');
  assert.strictEqual(d.ok, true, 'the released slot is claimable again');
  assert.strictEqual(lim.claimUser('target').ok, false, 'and only that one: b settled exactly once');
  c.succeed(); // clears the recorded failure...
  d.fail(); // ...but a check that was in flight across it still counts
  assert.ok(failOnce(lim, 'target'));
  assert.ok(failOnce(lim, 'target'));
  const locked = lim.claimUser('target');
  assert.strictEqual(locked.ok, false, "d's failure plus two more lock the name");
  assert.ok(locked.retryAfterSec > 60, `held by recorded failures: the 10-minute window (got ${locked.retryAfterSec})`);
  lim.stop();
});

test('login limiter windows expire and both maps stay capped/swept (§19.3.19)', async () => {
  const lim = createLoginLimiter({
    max: 2, windowMs: 40, maxEntries: 10, userMax: 2, userWindowMs: 40, maxUserEntries: 10,
  });
  assert.strictEqual(lim.attempt('ip-x').ok, true);
  assert.strictEqual(lim.attempt('ip-x').ok, true);
  assert.strictEqual(lim.attempt('ip-x').ok, false);
  failOnce(lim, 'u');
  failOnce(lim, 'u');
  assert.strictEqual(userOpen(lim, 'u'), false);
  await sleep(60); // both windows passed
  assert.strictEqual(lim.attempt('ip-x').ok, true);
  assert.strictEqual(userOpen(lim, 'u'), true);
  for (let i = 0; i < 50; i++) lim.attempt(`flood-${i}`);
  assert.ok(lim.size <= 10, `address map must stay capped (size=${lim.size})`);
  for (let i = 0; i < 50; i++) failOnce(lim, `spray-${i}`);
  assert.ok(lim.userSize <= 10, `username map must stay capped (size=${lim.userSize})`);
  lim.sweep(Date.now() + 1000);
  assert.strictEqual(lim.size, 0, 'sweep drops expired address buckets');
  assert.strictEqual(lim.userSize, 0, 'sweep drops expired username failures');
  lim.stop();
});

test('login limiter cap evicts the least recently failed names first', () => {
  const lim = createLoginLimiter({ userMax: 2, maxUserEntries: 10 });
  failOnce(lim, 'target');
  for (let i = 0; i < 9; i++) failOnce(lim, `spray-a${i}`);
  failOnce(lim, 'target'); // still failing: moves to the back of the line
  for (let i = 0; i < 5; i++) failOnce(lim, `spray-b${i}`);
  assert.strictEqual(lim.userSize, 10);
  assert.strictEqual(userOpen(lim, 'target'), false, 'an actively failing name survives a spray of new ones');
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
