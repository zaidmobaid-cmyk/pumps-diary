'use strict';
// GET /api/players/:id lists the player's warn/kick/ban admin actions with
// their live evidence counts (the audit log's row shape) — only for people
// who can act on or audit them; system actions like ban-enforce stay out.
const test = require('node:test');
const assert = require('node:assert');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const LiveState = require('../server/state');

test('profile actions: warn/kick/ban rows with evidence counts, gated', async (t) => {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = {};
  const auth = createAuth({ db, config: cfg });
  const rcon = { status: { connected: true, authed: true }, async exec(cmd) { return `Executed: ${cmd}`; } };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;

  let n = 0;
  const as = (role) => {
    n++;
    const roleRef = typeof role === 'object' ? auth.createRole(`custom-${n}`, role).id : role;
    const u = auth.createUser(`user${n}`, 'password-123', roleRef);
    const cookie = `sw_session=${auth.createSession(u.id, {}).token}`;
    return { user: u, get: async (p) => (await fetch(base + p, { headers: { origin: base, cookie } })).json() };
  };
  const warner = as({ view: true, warn: true });
  const viewer = as('viewer');

  const T = Date.now();
  const pid = Number(db.prepare('INSERT INTO players(name, eos_id, first_seen, last_seen) VALUES(?,?,?,?)').run('Target', 'eos-t', T, T).lastInsertRowid);
  const other = Number(db.prepare('INSERT INTO players(name, eos_id, first_seen, last_seen) VALUES(?,?,?,?)').run('Other', 'eos-o', T, T).lastInsertRowid);
  const act = db.prepare('INSERT INTO admin_actions(time, user_id, action, target_player_id, details, rcon_ok) VALUES(?,?,?,?,?,?)');
  const warnId = Number(act.run(T - 3000, warner.user.id, 'warn', pid, JSON.stringify({ message: 'stop tk' }), 1).lastInsertRowid);
  const kickId = Number(act.run(T - 2000, warner.user.id, 'kick', pid, JSON.stringify({ reason: 'tk' }), 1).lastInsertRowid);
  const banId = Number(act.run(T - 1000, null, 'ban', pid, JSON.stringify({ interval: '1d', reason: 'tk' }), 0).lastInsertRowid);
  act.run(T, null, 'ban-enforce', pid, '{}', 1);
  act.run(T, warner.user.id, 'kick', other, '{}', 1);
  const ev = db.prepare(`INSERT INTO evidence(target_type, target_id, sha256, stored_name, filename, mime, size, uploaded_by, uploaded_at, deleted_at)
                         VALUES('action', ?, 'abc', 'abc.png', 'a.png', 'image/png', 1, ?, ?, ?)`);
  ev.run(kickId, warner.user.id, T, null);
  ev.run(kickId, warner.user.id, T, null);
  ev.run(kickId, warner.user.id, T, T); // deleted — not counted

  const seen = await warner.get(`/api/players/${pid}`);
  assert.ok(Array.isArray(seen.actions), 'actions listed for a warn holder');
  assert.deepStrictEqual(seen.actions.map((a) => a.id), [banId, kickId, warnId], 'own warn/kick/ban only, newest first');
  const kick = seen.actions.find((a) => a.id === kickId);
  assert.strictEqual(kick.evidenceCount, 2, 'live evidence only');
  assert.deepStrictEqual(kick.details, { reason: 'tk' });
  assert.strictEqual(kick.username, warner.user.username);
  assert.strictEqual(seen.actions.find((a) => a.id === banId).rconOk, false);
  assert.strictEqual(seen.actions.find((a) => a.id === warnId).evidenceCount, 0);

  const plain = await viewer.get(`/api/players/${pid}`);
  assert.ok(!('actions' in plain), 'viewers do not get the actions list');
});
