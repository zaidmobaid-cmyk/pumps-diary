'use strict';
// Unit tests for custom roles (docs/ROLES-INVITES-SETTINGS.md §1):
// v2 migration seeds the builtin role rows, legacy role NAMES keep working,
// sanitizePerms, role CRUD + builtin protections + delete rules, live perms
// through getSession's triple JOIN, and the keyholderCount last-keys predicate.
const test = require('node:test');
const assert = require('node:assert');

const { openDb } = require('../server/db');
const { createAuth, builtinRolePerms, sanitizePerms } = require('../server/auth');

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

const HOUR = 3600 * 1000;

// ---------------------------------------------------------------- migration

test('v2 migration on a fresh db seeds builtin roles and rebuilds users onto role_id', () => {
  const db = freshDb();
  const rows = db.prepare('SELECT id, name, builtin, perms FROM roles ORDER BY id').all();
  assert.deepStrictEqual(rows.map((r) => r.name), ['owner', 'admin', 'viewer']);
  for (const r of rows) {
    assert.strictEqual(Number(r.builtin), 1, `${r.name} must be builtin`);
    assert.deepStrictEqual(JSON.parse(r.perms), builtinRolePerms(r.name),
      `${r.name} seed perms must match auth's matrix`);
  }
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  assert.ok(cols.includes('role_id'), 'users.role_id exists');
  assert.ok(!cols.includes('role'), 'legacy users.role TEXT column is gone');
});

// -------------------------------------------------------------- legacy names

test('builtin role names still resolve: createUser/verifyLogin expose the NAME', () => {
  const { auth } = freshAuth();
  for (const name of ['owner', 'admin', 'viewer']) {
    const u = auth.createUser(`u-${name}`, 'pw123456', name);
    assert.strictEqual(u.role, name, 'user.role carries the role name, not the id');
    assert.strictEqual(u.roleId, auth.roleRow(name).id);
  }
  const ok = auth.verifyLogin('u-admin', 'pw123456');
  assert.ok(ok);
  assert.strictEqual(ok.role, 'admin');
  assert.deepStrictEqual(ok.perms, sanitizePerms(builtinRolePerms('admin')),
    'perms come from the seeded role row (true keys only)');
});

// ------------------------------------------------------------- sanitizePerms

test('sanitizePerms drops unknown keys and anything not exactly true', () => {
  assert.deepStrictEqual(
    sanitizePerms({ view: true, kick: 'yes', ban: 1, warn: false, nonsense: true, raw: true }),
    { view: true, raw: true }
  );
  assert.deepStrictEqual(sanitizePerms(null), {});
  assert.deepStrictEqual(sanitizePerms('view'), {});
  assert.deepStrictEqual(sanitizePerms(['view']), {});
  assert.deepStrictEqual(sanitizePerms({ toString: true, hasOwnProperty: true }), {});
});

// ------------------------------------------------------------------ role CRUD

test('createRole: sanitized perms, NOCASE-unique names, name validation', () => {
  const { auth } = freshAuth();
  const r = auth.createRole('Trial Mod', { view: true, kick: true, nonsense: true, warn: 'yes' });
  assert.ok(r.id > 0);
  assert.strictEqual(r.name, 'Trial Mod');
  assert.strictEqual(r.builtin, false);
  assert.deepStrictEqual(r.perms, { view: true, kick: true }, 'junk keys/values stripped on create');
  assert.ok(r.createdAt > 0);
  assert.throws(() => auth.createRole('trial mod', {}), /already taken/i); // NOCASE
  assert.throws(() => auth.createRole('', {}), /1-32/);
  assert.throws(() => auth.createRole('x'.repeat(33), {}), /1-32/);
  assert.throws(() => auth.createRole('123', {}), /digits/); // ids resolve numerically
  const all = auth.listRoles();
  assert.deepStrictEqual(all.map((x) => x.name), ['owner', 'admin', 'viewer', 'Trial Mod'],
    'builtins first, then customs');
  const mine = all.find((x) => x.name === 'Trial Mod');
  assert.strictEqual(mine.members, 0);
  assert.strictEqual(mine.openInvites, 0);
});

test('updateRole: rename, permsChanged flag and memberIds for revocation', () => {
  const { auth } = freshAuth();
  const r = auth.createRole('Recruit', { view: true });
  const a = auth.createUser('m1', 'pw123456', r.id);
  const b = auth.createUser('m2', 'pw123456', r.id);
  // rename only: perms untouched, nobody to revoke
  const renamed = auth.updateRole(r.id, { name: 'Recruits' });
  assert.strictEqual(renamed.role.name, 'Recruits');
  assert.strictEqual(renamed.permsChanged, false);
  assert.deepStrictEqual(renamed.memberIds, []);
  // identical perms: not a change
  const same = auth.updateRole(r.id, { perms: { view: true } });
  assert.strictEqual(same.permsChanged, false);
  assert.deepStrictEqual(same.memberIds, []);
  // real perms change: every member is reported (API revokes sessions/streams)
  const upd = auth.updateRole(r.id, { perms: { view: true, stream: true } });
  assert.strictEqual(upd.permsChanged, true);
  assert.deepStrictEqual(upd.memberIds.slice().sort((x, y) => x - y),
    [a.id, b.id].sort((x, y) => x - y));
  assert.deepStrictEqual(upd.role.perms, { view: true, stream: true });
  assert.throws(() => auth.updateRole(9999, { name: 'x' }), /not found/);
  const other = auth.createRole('Other', {});
  assert.throws(() => auth.updateRole(other.id, { name: 'recruits' }), /already taken/i);
});

// -------------------------------------------------------- builtin protections

test('builtin protections: owner perms immutable, names immutable, undeletable', () => {
  const { auth } = freshAuth();
  const owner = auth.roleRow('owner');
  const admin = auth.roleRow('admin');
  assert.throws(() => auth.updateRole(owner.id, { perms: { view: true } }), /owner role's permissions/);
  assert.throws(() => auth.updateRole(admin.id, { name: 'boss' }), /builtin role names/);
  for (const name of ['owner', 'admin', 'viewer']) {
    assert.throws(() => auth.deleteRole(auth.roleRow(name).id), /cannot be deleted/);
  }
  // sending the unchanged name back is a no-op, not an error
  assert.strictEqual(auth.updateRole(admin.id, { name: 'admin' }).role.name, 'admin');
  // admin/viewer perms ARE editable (only owner's are frozen)
  const upd = auth.updateRole(admin.id, { perms: { view: true, stream: true, kick: true } });
  assert.strictEqual(upd.permsChanged, true);
  assert.deepStrictEqual(upd.role.perms, { view: true, stream: true, kick: true });
});

test('deleteRole: blocked by members, blocked by open invites, then cleans up', () => {
  const { db, auth } = freshAuth();
  const r = auth.createRole('Temp', { view: true });
  const u = auth.createUser('tmp', 'pw123456', r.id);
  assert.throws(() => auth.deleteRole(r.id), /members/);
  db.prepare('UPDATE users SET role_id=? WHERE id=?').run(auth.roleRow('owner').id, u.id);
  const inv = auth.createInvite({ roleId: r.id, ttlMs: HOUR });
  assert.throws(() => auth.deleteRole(r.id), /invites/);
  auth.revokeInvite(inv.id);
  assert.strictEqual(auth.deleteRole(r.id), true);
  assert.strictEqual(auth.roleRow(r.id), null);
  assert.strictEqual(Number(db.prepare('SELECT COUNT(*) AS n FROM invites WHERE role_id=?').get(r.id).n), 0,
    'spent/revoked invites are swept with the role');
});

// -------------------------------------------------------------- live sessions

test('getSession reads perms from the role row — an edit applies to the NEXT call', () => {
  const { auth } = freshAuth();
  const r = auth.createRole('Scout', { view: true, stream: true });
  const u = auth.createUser('scout1', 'pw123456', r.id);
  const s = auth.createSession(u.id, {});
  let got = auth.getSession(s.token);
  assert.ok(got);
  assert.strictEqual(got.user.role, 'Scout');
  assert.strictEqual(got.user.roleId, r.id);
  assert.deepStrictEqual(got.user.perms, { view: true, stream: true });
  const upd = auth.updateRole(r.id, { perms: { view: true, kick: true } });
  assert.strictEqual(upd.permsChanged, true);
  assert.deepStrictEqual(upd.memberIds, [u.id]);
  got = auth.getSession(s.token); // same token — no re-login needed for REST
  assert.deepStrictEqual(got.user.perms, { view: true, kick: true },
    'role edit is visible on the very next session resolution');
});

// ----------------------------------------------------------------- keyholders

test('keyholderCount: enabled users whose role grants users+roles+settings', () => {
  const { db, auth } = freshAuth();
  const root = auth.createUser('root', 'pw123456', 'owner');
  assert.strictEqual(auth.keyholderCount(), 1);
  auth.createUser('mod', 'pw123456', 'admin'); // admin lacks the three keys
  assert.strictEqual(auth.keyholderCount(), 1);
  const partial = auth.createRole('Partial', { users: true, roles: true });
  auth.createUser('half', 'pw123456', partial.id);
  assert.strictEqual(auth.keyholderCount(), 1, 'users+roles without settings does not hold the keys');
  const keys = auth.createRole('Keymaster', { users: true, roles: true, settings: true });
  const km = auth.createUser('km', 'pw123456', keys.id);
  assert.strictEqual(auth.keyholderCount(), 2);
  assert.strictEqual(auth.keyholderCount({ exceptUserId: root.id }), 1);
  assert.strictEqual(auth.keyholderCount({ exceptUserId: km.id }), 1);
  db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(km.id);
  assert.strictEqual(auth.keyholderCount(), 1, 'disabled users are not keyholders');
  assert.strictEqual(auth.keyholderCount({ exceptUserId: root.id }), 0);
});
