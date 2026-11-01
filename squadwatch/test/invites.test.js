'use strict';
// Unit tests for invite links (docs/ROLES-INVITES-SETTINGS.md §2):
// hash-only token storage, findInvite validity probe, single-use claim in one
// tx (rollback on username conflict), revoke, derived states, ttl/role guards.
const test = require('node:test');
const assert = require('node:assert');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { sha256hex } = require('../server/util');

function freshAuth(extra) {
  const db = openDb(':memory:');
  db.migrate();
  const auth = createAuth(Object.assign({ db, config: {} }, extra));
  return { db, auth };
}

const HOUR = 3600 * 1000;
const MAX_TTL = 720 * 3600 * 1000; // 30 days

// ------------------------------------------------------------- create + hash

test('createInvite returns the full 64-hex token once, stores only sha256(token)', () => {
  const { db, auth } = freshAuth();
  const role = auth.roleRow('admin');
  const before = Date.now();
  const inv = auth.createInvite({ roleId: role.id, ttlMs: HOUR, createdBy: null });
  assert.ok(inv.id > 0);
  assert.match(inv.token, /^[0-9a-f]{64}$/); // randomTokenHex(32), like sessions
  assert.strictEqual(inv.roleId, role.id);
  assert.strictEqual(inv.roleName, 'admin');
  assert.ok(inv.expiresAt >= before + HOUR && inv.expiresAt <= Date.now() + HOUR);
  const row = db.prepare('SELECT token_hash FROM invites WHERE id=?').get(inv.id);
  assert.strictEqual(row.token_hash, sha256hex(inv.token));
  assert.notStrictEqual(row.token_hash, inv.token);
  // the token never shows up again — not in the list output either
  const listed = auth.listInvites();
  assert.strictEqual(listed.length, 1);
  assert.ok(!JSON.stringify(listed).includes(inv.token));
});

// ----------------------------------------------------------------- findInvite

test('findInvite answers with role info only for currently-claimable tokens', () => {
  const { auth } = freshAuth();
  const role = auth.roleRow('viewer');
  const inv = auth.createInvite({ roleId: role.id, ttlMs: HOUR });
  assert.deepStrictEqual(auth.findInvite(inv.token), {
    id: inv.id, roleId: role.id, roleName: 'viewer', expiresAt: inv.expiresAt,
  });
  assert.strictEqual(auth.findInvite('deadbeef'.repeat(8)), null); // unknown token
  assert.strictEqual(auth.findInvite('short'), null); // length guard
  assert.strictEqual(auth.findInvite(''), null);
  assert.strictEqual(auth.findInvite(null), null);
});

// ---------------------------------------------------------------------- claim

test('claimInvite creates the user with the invite role, consumes it exactly once', () => {
  const { db, auth } = freshAuth();
  const role = auth.createRole('Recruiter', { view: true, kick: true });
  const inv = auth.createInvite({ roleId: role.id, ttlMs: HOUR });
  const { user, inviteId } = auth.claimInvite(inv.token, { username: 'newbie', password: 'pw123456' });
  assert.strictEqual(inviteId, inv.id);
  assert.strictEqual(user.role, 'Recruiter');
  assert.strictEqual(user.roleId, role.id);
  const row = db.prepare('SELECT used_by, used_at FROM invites WHERE id=?').get(inv.id);
  assert.strictEqual(Number(row.used_by), user.id);
  assert.ok(Number(row.used_at) > 0);
  // the account works and carries the invite's role perms
  const login = auth.verifyLogin('newbie', 'pw123456');
  assert.ok(login && login.roleId === role.id);
  assert.deepStrictEqual(login.perms, { view: true, kick: true });
  // single use: a SECOND claim of the same token fails
  assert.strictEqual(auth.findInvite(inv.token), null);
  assert.throws(() => auth.claimInvite(inv.token, { username: 'other', password: 'pw123456' }),
    /no longer valid/);
  assert.strictEqual(auth.listInvites()[0].state, 'used');
});

// ------------------------------------------------------------ expiry + revoke

test('expired invites are not claimable (expires_at pushed into the past in SQL)', () => {
  const { db, auth } = freshAuth();
  const inv = auth.createInvite({ roleId: auth.roleRow('viewer').id, ttlMs: 60000 }); // minimum ttl
  db.prepare('UPDATE invites SET expires_at=? WHERE id=?').run(Date.now() - 1000, inv.id);
  assert.strictEqual(auth.findInvite(inv.token), null);
  assert.throws(() => auth.claimInvite(inv.token, { username: 'late', password: 'pw123456' }),
    /no longer valid/);
  assert.strictEqual(auth.listInvites()[0].state, 'expired');
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n), 0,
    'no account was created');
});

test('revokeInvite blocks claims, is idempotent, and refuses used invites', () => {
  const { auth } = freshAuth();
  const viewer = auth.roleRow('viewer');
  const inv = auth.createInvite({ roleId: viewer.id, ttlMs: HOUR });
  assert.strictEqual(auth.revokeInvite(inv.id), true);
  assert.strictEqual(auth.findInvite(inv.token), null);
  assert.throws(() => auth.claimInvite(inv.token, { username: 'x', password: 'pw123456' }),
    /no longer valid/);
  assert.strictEqual(auth.revokeInvite(inv.id), true); // idempotent
  assert.strictEqual(auth.listInvites()[0].state, 'revoked');
  const used = auth.createInvite({ roleId: viewer.id, ttlMs: HOUR });
  auth.claimInvite(used.token, { username: 'joined', password: 'pw123456' });
  assert.throws(() => auth.revokeInvite(used.id), /already used/);
  assert.throws(() => auth.revokeInvite(99999), /not found/);
});

// --------------------------------------------------------------------- states

test('listInvites derives unused/used/revoked/expired and joins names', () => {
  const { db, auth } = freshAuth();
  const owner = auth.createUser('boss', 'pw123456', 'owner');
  const viewer = auth.roleRow('viewer');
  const unused = auth.createInvite({ roleId: viewer.id, ttlMs: HOUR, createdBy: owner.id });
  const used = auth.createInvite({ roleId: viewer.id, ttlMs: HOUR, createdBy: owner.id });
  const revoked = auth.createInvite({ roleId: viewer.id, ttlMs: HOUR, createdBy: owner.id });
  const expired = auth.createInvite({ roleId: viewer.id, ttlMs: HOUR, createdBy: owner.id });
  auth.claimInvite(used.token, { username: 'claimer', password: 'pw123456' });
  auth.revokeInvite(revoked.id);
  db.prepare('UPDATE invites SET expires_at=? WHERE id=?').run(Date.now() - 1, expired.id);

  const rows = auth.listInvites();
  assert.deepStrictEqual(rows.map((r) => r.id),
    [expired.id, revoked.id, used.id, unused.id], 'newest first');
  const byId = new Map(rows.map((r) => [r.id, r]));
  assert.strictEqual(byId.get(unused.id).state, 'unused');
  assert.strictEqual(byId.get(used.id).state, 'used');
  assert.strictEqual(byId.get(revoked.id).state, 'revoked');
  assert.strictEqual(byId.get(expired.id).state, 'expired');
  assert.strictEqual(byId.get(used.id).usedByName, 'claimer');
  assert.ok(Number(byId.get(used.id).usedAt) > 0);
  assert.ok(Number(byId.get(revoked.id).revokedAt) > 0);
  assert.ok(rows.every((r) => r.roleName === 'viewer' && r.createdByName === 'boss'));
});

// --------------------------------------------------------------------- guards

test('createInvite guards: ttl below 1min / above 30d and unknown roles rejected', () => {
  const { auth } = freshAuth();
  const viewer = auth.roleRow('viewer');
  assert.throws(() => auth.createInvite({ roleId: viewer.id, ttlMs: 59999 }), /between 1 minute and 30 days/);
  assert.throws(() => auth.createInvite({ roleId: viewer.id, ttlMs: MAX_TTL + 1 }), /between 1 minute and 30 days/);
  assert.throws(() => auth.createInvite({ roleId: viewer.id, ttlMs: NaN }), /between 1 minute and 30 days/);
  assert.throws(() => auth.createInvite({ roleId: viewer.id }), /between 1 minute and 30 days/);
  assert.throws(() => auth.createInvite({ roleId: 9999, ttlMs: HOUR }), /unknown role/);
  // the exact bounds themselves are fine
  assert.ok(auth.createInvite({ roleId: viewer.id, ttlMs: 60000 }).token);
  assert.ok(auth.createInvite({ roleId: viewer.id, ttlMs: MAX_TTL }).token);
});

test('claiming with a taken username throws and does NOT consume the invite', () => {
  const { db, auth } = freshAuth();
  auth.createUser('Taken', 'pw123456', 'admin');
  const inv = auth.createInvite({ roleId: auth.roleRow('viewer').id, ttlMs: HOUR });
  assert.throws(() => auth.claimInvite(inv.token, { username: 'taken', password: 'pw123456' }),
    /already taken/i); // NOCASE collision, the one non-generic claim error
  const row = db.prepare('SELECT used_by, used_at FROM invites WHERE id=?').get(inv.id);
  assert.strictEqual(row.used_by, null);
  assert.strictEqual(row.used_at, null, 'tx rolled back — invite not consumed');
  assert.strictEqual(auth.listInvites()[0].state, 'unused');
  // still claimable afterwards with a free username
  assert.ok(auth.findInvite(inv.token));
  const { user } = auth.claimInvite(inv.token, { username: 'free', password: 'pw123456' });
  assert.strictEqual(user.role, 'viewer');
});
