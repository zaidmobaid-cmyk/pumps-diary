'use strict';
// Tests for server/db.js: backend wrapper normalization, WAL, idempotent
// migrate() (including on a reopened existing db), player upsert math and a
// representative additive aggregate upsert (match_players).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDb } = require('../server/db');

function tmpDbPath(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-db-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ } });
  return path.join(dir, name || 'test.db');
}

const EXPECTED_TABLES = [
  'players', 'player_names', 'player_ips', 'sessions', 'matches', 'match_players',
  'kills', 'revives', 'damage_agg', 'deployable_damage', 'chat', 'users',
  'auth_sessions', 'admin_actions', 'bans', 'warnings', 'flags', 'player_notes',
  'pop_samples', 'settings', 'schema_version',
];

test('openDb returns the normalized wrapper and applies WAL pragmas', (t) => {
  const db = openDb(tmpDbPath(t));
  t.after(() => db.close());
  assert.equal(typeof db.prepare, 'function');
  assert.equal(typeof db.exec, 'function');
  assert.equal(typeof db.tx, 'function');
  assert.equal(typeof db.migrate, 'function');
  assert.ok(db.raw, 'raw backend handle exposed');

  const mode = db.prepare('PRAGMA journal_mode').get();
  assert.equal(String(Object.values(mode)[0]).toLowerCase(), 'wal');
  const fk = db.prepare('PRAGMA foreign_keys').get();
  assert.equal(Number(Object.values(fk)[0]), 1);

  // Parameter normalization: undefined -> NULL, booleans -> 1/0 — identical on
  // both backends so callers never have to care which one loaded.
  db.exec('CREATE TABLE tnorm(a, b, c)');
  const info = db.prepare('INSERT INTO tnorm(a, b, c) VALUES(?,?,?)').run(undefined, true, false);
  assert.equal(typeof info.changes, 'number');
  assert.equal(typeof info.lastInsertRowid, 'number');
  assert.equal(info.changes, 1);
  const row = db.prepare('SELECT a, b, c FROM tnorm').get();
  assert.equal(row.a, null);
  assert.equal(row.b, 1);
  assert.equal(row.c, 0);
  assert.equal(db.prepare('SELECT * FROM tnorm WHERE a=1').get(), undefined);
  assert.deepEqual(db.prepare('SELECT b FROM tnorm').all(), [{ b: 1 }]);
});

test('migrate() applies the full v1 DDL and is idempotent, including on a reopened existing db', (t) => {
  const file = tmpDbPath(t);
  const db1 = openDb(file);
  assert.equal(db1.migrate(), 4);
  assert.equal(db1.migrate(), 4, 'second migrate on the same handle is a no-op');

  const names = db1.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const tbl of EXPECTED_TABLES) assert.ok(names.includes(tbl), `missing table ${tbl}`);

  // §19.2 amendments are part of the v1 DDL, not a later migration.
  const banCols = db1.prepare('PRAGMA table_info(bans)').all().map((r) => r.name);
  assert.ok(banCols.includes('steam_id'), 'bans.steam_id (§19.2.13)');
  const flagCols = db1.prepare('PRAGMA table_info(flags)').all().map((r) => r.name);
  assert.ok(flagCols.includes('review_note'), 'flags.review_note (§19.2.14)');

  // v2: builtin roles seeded, users carries role_id (not role TEXT)
  const roles = db1.prepare('SELECT name, builtin FROM roles ORDER BY id').all();
  assert.deepEqual(roles.map((r) => r.name), ['owner', 'admin', 'viewer']);
  assert.ok(roles.every((r) => r.builtin === 1), 'seed roles are builtin');
  const userCols = db1.prepare('PRAGMA table_info(users)').all().map((r) => r.name);
  assert.ok(userCols.includes('role_id') && !userCols.includes('role'), 'users rebuilt onto role_id');
  assert.ok(names.includes('invites'), 'invites table exists');

  // Survive a write so the reopen below sees a genuinely existing, used db.
  db1.prepare('INSERT INTO settings(key, value) VALUES(?,?)').run('hello', 'world');
  assert.equal(db1.prepare('SELECT version FROM schema_version').get().version, 4);
  db1.close();

  const db2 = openDb(file);
  t.after(() => db2.close());
  assert.equal(db2.migrate(), 4, 'migrate on an existing db does not re-apply DDL');
  assert.equal(db2.migrate(), 4);
  assert.equal(db2.prepare('SELECT value FROM settings WHERE key=?').get('hello').value, 'world');
  assert.equal(db2.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n, 1);
});

test('player upsert math: eos-keyed, COALESCE fields, MAX(last_seen), additive aggregates', (t) => {
  const db = openDb(tmpDbPath(t));
  t.after(() => db.close());
  db.migrate();

  const T = Date.UTC(2026, 2, 1, 12, 0, 0);
  const up = db.prepare(
    `INSERT INTO players(eos_id, steam_id, name, first_seen, last_seen)
     VALUES(?,?,?,?,?)
     ON CONFLICT(eos_id) DO UPDATE SET
       steam_id=COALESCE(excluded.steam_id, steam_id),
       name=COALESCE(excluded.name, name),
       last_seen=MAX(last_seen, excluded.last_seen)`
  );
  up.run('000000000000000000000000000000e1', null, 'Alpha', T, T);
  up.run('000000000000000000000000000000e1', '76561198000000001', null, T - 5000, T + 60000);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM players').get().n, 1, 'eos key deduped');
  const row = db.prepare('SELECT * FROM players WHERE eos_id=?').get('000000000000000000000000000000e1');
  assert.equal(row.name, 'Alpha', 'NULL name did not clobber the known name');
  assert.equal(row.steam_id, '76561198000000001', 'steam id filled in later');
  assert.equal(row.first_seen, T, 'first insert keeps first_seen');
  assert.equal(row.last_seen, T + 60000, 'last_seen is MAX of both');
  assert.equal(row.kills, 0);
  assert.equal(row.play_seconds, 0);

  const bump = db.prepare(
    'UPDATE players SET kills=kills+?, teamkills=teamkills+?, radio_damage_friendly=radio_damage_friendly+?, play_seconds=play_seconds+? WHERE eos_id=?'
  );
  bump.run(2, 1, 350.5, 120, '000000000000000000000000000000e1');
  bump.run(1, 0, 149.5, 60, '000000000000000000000000000000e1');
  const agg = db.prepare('SELECT kills, teamkills, radio_damage_friendly, play_seconds FROM players WHERE eos_id=?')
    .get('000000000000000000000000000000e1');
  assert.equal(agg.kills, 3);
  assert.equal(agg.teamkills, 1);
  assert.ok(Math.abs(agg.radio_damage_friendly - 500) < 1e-9);
  assert.equal(agg.play_seconds, 180);
});

test('representative aggregate update: match_players additive upsert + tx semantics', (t) => {
  const db = openDb(tmpDbPath(t));
  t.after(() => db.close());
  db.migrate();

  const up = db.prepare(
    `INSERT INTO match_players(match_id, player_id, team_id, kills, deaths, teamkills, tk_deaths, revives, damage_dealt)
     VALUES(?,?,?,?,?,?,?,?,?)
     ON CONFLICT(match_id, player_id) DO UPDATE SET
       team_id=COALESCE(excluded.team_id, team_id),
       kills=kills+excluded.kills, deaths=deaths+excluded.deaths,
       teamkills=teamkills+excluded.teamkills, tk_deaths=tk_deaths+excluded.tk_deaths,
       revives=revives+excluded.revives, damage_dealt=damage_dealt+excluded.damage_dealt`
  );
  up.run(1, 10, 1, 1, 0, 0, 0, 0, 38.25);
  up.run(1, 10, null, 1, 1, 1, 0, 1, 61.75);
  up.run(2, 10, 2, 1, 0, 0, 0, 0, 0); // same player, other match: separate row

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM match_players').get().n, 2);
  const row = db.prepare('SELECT * FROM match_players WHERE match_id=? AND player_id=?').get(1, 10);
  assert.equal(row.team_id, 1, 'COALESCE kept the first known team');
  assert.equal(row.kills, 2);
  assert.equal(row.deaths, 1);
  assert.equal(row.teamkills, 1);
  assert.equal(row.revives, 1);
  assert.ok(Math.abs(row.damage_dealt - 100) < 1e-9);

  // tx(): rollback on throw, commit otherwise, passes the return value through.
  assert.throws(
    () => db.tx(() => { up.run(1, 10, 1, 5, 0, 0, 0, 0, 0); throw new Error('boom'); }),
    /boom/
  );
  assert.equal(db.prepare('SELECT kills FROM match_players WHERE match_id=1 AND player_id=10').get().kills, 2,
    'rolled back increment is gone');
  const out = db.tx(() => { up.run(1, 10, 1, 1, 0, 0, 0, 0, 0); return 'done'; });
  assert.equal(out, 'done');
  assert.equal(db.prepare('SELECT kills FROM match_players WHERE match_id=1 AND player_id=10').get().kills, 3);
});
