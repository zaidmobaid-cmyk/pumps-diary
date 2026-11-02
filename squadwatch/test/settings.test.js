'use strict';
// Tests for the runtime Settings write path (docs/ROLES-INVITES-SETTINGS.md §3).
//
// UNIT — server/config.js pure functions:
//   applySettingsPatch: allowlist walking + changedPaths, non-allowlisted paths
//   ignored, validate-on-clone (one throw lists every bad field, secret values
//   never echoed, cfg untouched), secret null/''/string semantics, nested
//   objects mutated IN PLACE (live references survive), array change detection.
//   persistUserConfig: sparse + pretty JSON, atomic tmp+rename, loadConfig
//   round-trip.
//
// IN-PROCESS — POST /api/settings when config.json could not be written: the
// caller gets the reason, scrubbed of secrets; the audit row, which roles
// without `settings` read, only a fixed marker (no OS message, no path).
//
// INTEGRATION — boot the REAL server (spawned like integration.test.js) with
// squad.rconHost '' (no server linked), then link an in-process MockSquad live
// through POST /api/settings: RCON retargets within seconds, config.json gains
// the squad block, /api/settings/test probes ok + wrong-password, an
// out-of-range port is a 400, and a viewer (no `settings` perm) gets 403.
//
// Everything runs on ephemeral/random ports and in fresh temp dirs; nothing
// touches the repo's data/ dir or any running demo instance.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { MockSquad } = require('./mock-squad');
const { loadConfig, applySettingsPatch, persistUserConfig } = require('../server/config');
const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const LiveState = require('../server/state');

const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server', 'index.js');
const RCON_PASSWORD = 'settings-secret';

// ---------------------------------------------------------------- tiny utils

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll `fn` until it returns a truthy value; throws (with the label) on timeout.
async function until(fn, { timeoutMs = 15000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      lastErr = null;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for: ${label}` +
        (lastErr ? ` (last error: ${lastErr.message})` : '')
      );
    }
    await sleep(intervalMs);
  }
}

// A full, valid config built the way index.js builds one: a sparse user file in
// a throwaway dir, deep-merged over defaults by loadConfig.
function freshCfg(sparse) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-cfg-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(sparse || {}, null, 2));
  return { dir, file, cfg: loadConfig(file) };
}

// ------------------------------------------------- UNIT: applySettingsPatch

test('applySettingsPatch applies allowlisted paths and reports changedPaths', () => {
  const { dir, cfg } = freshCfg();
  try {
    const res = applySettingsPatch(cfg, {
      squad: { rconHost: '10.1.2.3', rconPort: 2211 },
      web: { publicUrl: 'https://panel.example' },
      autoWarnTeamkiller: true,
    });
    assert.deepStrictEqual(res.changedPaths.sort(), [
      'autoWarnTeamkiller', 'squad.rconHost', 'squad.rconPort', 'web.publicUrl',
    ]);
    assert.strictEqual(cfg.squad.rconHost, '10.1.2.3');
    assert.strictEqual(cfg.squad.rconPort, 2211);
    assert.strictEqual(cfg.web.publicUrl, 'https://panel.example');
    assert.strictEqual(cfg.autoWarnTeamkiller, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applySettingsPatch ignores paths outside SETTINGS_ALLOW', () => {
  const { dir, cfg } = freshCfg();
  try {
    // web.host, web.port, dbPath and demo stay file-only (§3) — a patch naming
    // them is silently a no-op, not an error.
    const res = applySettingsPatch(cfg, {
      web: { host: '9.9.9.9', port: 1 },
      dbPath: 'elsewhere/evil.db',
      demo: true,
      nonsense: { nested: 1 },
    });
    assert.deepStrictEqual(res.changedPaths, []);
    assert.strictEqual(cfg.web.host, '0.0.0.0');
    assert.strictEqual(cfg.web.port, 8787);
    assert.strictEqual(cfg.dbPath, 'data/squadwatch.db');
    assert.strictEqual(cfg.demo, false);
    assert.ok(!('nonsense' in cfg), 'unknown keys are not grafted onto cfg');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('applySettingsPatch validates on a clone: throw lists fields, never secret values, cfg untouched', () => {
  const { dir, cfg } = freshCfg({ squad: { rconPassword: 'super-secret-pw' } });
  try {
    const before = JSON.parse(JSON.stringify(cfg));
    assert.throws(
      () => applySettingsPatch(cfg, {
        // one valid change + one bad port + one bad (non-string) secret
        squad: { rconHost: 'rcon.example', rconPort: 99999, rconPassword: 12345678 },
      }),
      (e) => {
        assert.match(e.message, /squad\.rconPort/);
        assert.match(e.message, /1-65535/);
        assert.match(e.message, /99999/); // non-secret values may be echoed
        assert.match(e.message, /squad\.rconPassword/);
        assert.ok(!e.message.includes('12345678'), 'secret value not echoed (§19.3.27)');
        assert.ok(!e.message.includes('super-secret-pw'), 'stored secret not echoed');
        return true;
      }
    );
    // validate-on-clone: the valid rconHost half was not applied either
    assert.deepStrictEqual(cfg, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('secret semantics: null keeps, "" clears, string sets (squad.rconPassword)', () => {
  const { dir, cfg } = freshCfg({ squad: { rconPassword: 'keep-me' } });
  try {
    let res = applySettingsPatch(cfg, { squad: { rconPassword: null }, autoWarnTeamkiller: true });
    assert.strictEqual(cfg.squad.rconPassword, 'keep-me');
    assert.deepStrictEqual(res.changedPaths, ['autoWarnTeamkiller'], 'null secret is not a change');

    res = applySettingsPatch(cfg, { squad: { rconPassword: 'brand-new' } });
    assert.strictEqual(cfg.squad.rconPassword, 'brand-new');
    assert.deepStrictEqual(res.changedPaths, ['squad.rconPassword']);

    res = applySettingsPatch(cfg, { squad: { rconPassword: '' } });
    assert.strictEqual(cfg.squad.rconPassword, '');
    assert.deepStrictEqual(res.changedPaths, ['squad.rconPassword']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('nested config objects are mutated IN PLACE (live references stay valid)', () => {
  const { dir, cfg } = freshCfg();
  try {
    // ingest/webhook/api hold these very objects and read them live (§3)
    const squadRef = cfg.squad;
    const webhookRef = cfg.webhookEvents;
    const ftpRef = cfg.log.ftp;
    applySettingsPatch(cfg, {
      squad: { rconHost: 'live.example' },
      webhookEvents: { warns: true },
      log: { ftp: { host: 'ftp.example' } },
    });
    assert.strictEqual(cfg.squad, squadRef, 'cfg.squad is the same object');
    assert.strictEqual(cfg.webhookEvents, webhookRef, 'cfg.webhookEvents is the same object');
    assert.strictEqual(cfg.log.ftp, ftpRef, 'cfg.log.ftp is the same object');
    assert.strictEqual(squadRef.rconHost, 'live.example');
    assert.strictEqual(webhookRef.warns, true);
    assert.strictEqual(ftpRef.host, 'ftp.example');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('array change detection: same-content chatWatchlist is no change, different content is', () => {
  const { dir, cfg } = freshCfg({ flags: { chatWatchlist: ['wallhack', 'cheat'] } });
  try {
    let res = applySettingsPatch(cfg, { flags: { chatWatchlist: ['wallhack', 'cheat'] } });
    assert.deepStrictEqual(res.changedPaths, [], 'equal-content array is not a change');

    res = applySettingsPatch(cfg, { flags: { chatWatchlist: ['wallhack', 'cheat', 'aimbot'] } });
    assert.deepStrictEqual(res.changedPaths, ['flags.chatWatchlist']);
    assert.deepStrictEqual(cfg.flags.chatWatchlist, ['wallhack', 'cheat', 'aimbot']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------- UNIT: persistUserConfig

test('persistUserConfig writes sparse pretty JSON atomically and round-trips loadConfig', () => {
  const { dir, file, cfg } = freshCfg({ web: { port: 9321 }, squad: { rconHost: 'old.example' } });
  try {
    const res = applySettingsPatch(cfg, {
      squad: { rconHost: 'new.example', rconPort: 2215, rconPassword: 'pw-123' },
      flags: { chatWatchlist: ['cheat'] },
    });
    persistUserConfig(file, res.changedPaths, cfg);

    const text = fs.readFileSync(file, 'utf8');
    const user = JSON.parse(text);
    // sparse: only the hand-written keys + the changed paths, nothing merged in
    assert.deepStrictEqual(user, {
      web: { port: 9321 },
      squad: { rconHost: 'new.example', rconPort: 2215, rconPassword: 'pw-123' },
      flags: { chatWatchlist: ['cheat'] },
    });
    assert.strictEqual(text, JSON.stringify(user, null, 2) + '\n', 'pretty 2-space JSON + trailing newline');
    // atomic: the tmp file was renamed away, nothing else left behind
    assert.ok(!fs.existsSync(`${file}.tmp-${process.pid}`), 'tmp file gone after rename');
    assert.deepStrictEqual(fs.readdirSync(dir), ['config.json']);
    // round-trip: loadConfig re-merges the sparse file over defaults
    const re = loadConfig(file);
    assert.strictEqual(re.web.port, 9321);
    assert.strictEqual(re.squad.rconHost, 'new.example');
    assert.strictEqual(re.squad.rconPort, 2215);
    assert.strictEqual(re.squad.rconPassword, 'pw-123');
    assert.deepStrictEqual(re.flags.chatWatchlist, ['cheat']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken config.json is reported by position, never by quoting its text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-cfg-broken-'));
  const file = path.join(dir, 'config.json');
  try {
    // V8 quotes the text around an unexpected token: here, the password.
    for (const [text, where] of [
      ['{"squad": {"rconPassword": Hunter2Secret}}', /\(syntax error\)/],
      ['{"squad":{"rconPassword":"Hunter2Secret"', /line 1, column \d+/],
    ]) {
      fs.writeFileSync(file, text);
      const cfg = loadConfig(path.join(dir, 'absent.json'));
      const res = applySettingsPatch(cfg, { squad: { rconHost: 'x.example' } });
      assert.throws(() => persistUserConfig(file, res.changedPaths, cfg), (e) => {
        assert.match(e.message, where);
        assert.ok(!/Hunter2/.test(e.message), `no file text in: ${e.message}`);
        return true;
      });
      assert.throws(() => loadConfig(file), (e) => {
        assert.match(e.message, /is not valid JSON/);
        assert.ok(!/Hunter2/.test(e.message), `no file text in: ${e.message}`);
        return true;
      });
      assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'the broken file is left untouched');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------ IN-PROCESS: config.json not written

test('a save that applied but could not be written: the caller gets the reason, scrubbed; the audit row only a marker', async (t) => {
  const { dir, cfg } = freshCfg({});
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  cfg.squad.rconPassword = 'Hunter2Secret';
  const why = "EPERM: operation not permitted, rename 'C:\\Users\\Zaid\\panel\\config.json.tmp-1' -> " +
    "'C:\\Users\\Zaid\\panel\\config.json' Hunter2Secret";
  let failWrite = true;
  const runtime = {
    applySettings(patch) {
      const res = applySettingsPatch(cfg, patch);
      if (failWrite && res.changedPaths.length) res.persistError = why;
      return res;
    },
  };
  const db = openDb(':memory:');
  db.migrate();
  t.after(() => db.close());
  const auth = createAuth({ db, config: cfg });
  t.after(() => auth.loginLimiter.stop());
  const rcon = { status: { connected: false, authed: false }, async exec() { throw new Error('not linked'); } };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg, runtime });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const api = makeApi(`http://127.0.0.1:${server.address().port}`);
  const login = (name, role) => {
    const u = auth.createUser(name, 'password-123', role);
    return { cookie: `sw_session=${auth.createSession(u.id, {}).token}` };
  };
  const owner = login('owner1', 'owner');
  const auditor = login('admin1', 'admin'); // reads the audit log, holds no `settings`

  const saved = await api(owner, 'POST', '/api/settings', { autoWarnTeamkiller: true });
  assert.strictEqual(saved.status, 200, saved.text);
  assert.deepStrictEqual(saved.json.changed, ['autoWarnTeamkiller']);
  assert.strictEqual(saved.json.persistError, why.replace('Hunter2Secret', '•••'), 'the caller: the reason, scrubbed');
  failWrite = false;
  const fine = await api(owner, 'POST', '/api/settings', { autoWarnTeamkiller: false });
  assert.strictEqual(fine.json.persistError, null);

  const audit = await api(auditor, 'GET', '/api/audit?action=settings-update');
  assert.strictEqual(audit.status, 200, audit.text);
  assert.deepStrictEqual(audit.json.rows.map((r) => r.details), [
    { changed: ['autoWarnTeamkiller'], persistError: null },
    { changed: ['autoWarnTeamkiller'], persistError: 'config.json not written — see the panel log' },
  ]);
  assert.ok(!/EPERM|Zaid|Hunter2/.test(audit.text), audit.text);
});

// ------------------------------------------------------ integration helpers
// (copied/trimmed from integration.test.js — same spawn/ipc/port patterns)

// fetch wrapper with a cookie jar + the Origin header the CSRF check requires.
function makeApi(base) {
  return async function api(jar, method, p, body) {
    const headers = { origin: base, accept: 'application/json' };
    if (jar && jar.cookie) headers.cookie = jar.cookie;
    const init = { method, headers };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body == null ? {} : body);
    }
    const res = await fetch(base + p, init);
    if (jar && typeof res.headers.getSetCookie === 'function') {
      for (const sc of res.headers.getSetCookie()) {
        const m = /^sw_session=([^;]*)/.exec(sc);
        if (m) jar.cookie = m[1] ? `sw_session=${m[1]}` : null;
      }
    }
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch (_e) { json = null; }
    }
    return { status: res.status, json, text };
  };
}

function waitExit(child, ms) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error(`child did not exit within ${ms}ms`)), ms);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

// Spawn the real server with squad.rconHost '' — no server linked yet (§3):
// RCON stays idle and the Settings API links the mock later. web.port 0 is not
// supported, so pick random high ports and retry on EADDRINUSE.
async function startServer({ tmp, logPath, transcript, web }) {
  let lastFail = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const cfgPath = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      web: Object.assign({ port, host: '127.0.0.1' }, web || {}),
      // rconHost '' = not linked; 21114 is just the placeholder default port.
      squad: { rconHost: '', rconPort: 21114, rconPassword: '' },
      log: { mode: 'local', path: logPath, pollMs: 100, backfill: true },
      dbPath: path.join(tmp, 'squadwatch.db'),
      // demo intentionally NOT set: the setup token must only be printed on stdout.
    }, null, 2));

    const child = spawn(process.execPath, [SERVER_JS, '--config', cfgPath], {
      cwd: ROOT,
      // 'ipc' so the shutdown step can request a graceful stop on Windows,
      // where kill() cannot deliver a catchable signal.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let buf = '';
    const feed = (c) => {
      buf += c;
      transcript.text = (transcript.text + c).slice(-120000);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 15000);
      const check = (c) => {
        feed(c);
        if (/A3 Admin v[^\n]* up: http/.test(buf)) { clearTimeout(timer); resolve('up'); }
      };
      child.stdout.on('data', check);
      child.stderr.on('data', feed);
      child.once('exit', () => { clearTimeout(timer); resolve('exited'); });
    });
    // keep collecting output for diagnostics after boot
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    if (outcome === 'up') {
      // parse the one-time setup token from the FIRST-RUN console line.
      const tokenLine = buf.split('\n').find((l) => l.includes('Setup token'));
      const m = tokenLine ? /([0-9a-f]{32})/.exec(tokenLine) : null;
      return { child, port, cfgPath, setupToken: m ? m[1] : null };
    }
    if (child.exitCode == null) child.kill('SIGKILL');
    lastFail = buf.slice(-2000);
    if (outcome === 'timeout') throw new Error(`server did not print the up banner within 15s:\n${lastFail}`);
    if (!/EADDRINUSE|address already in use/i.test(buf)) {
      throw new Error(`server exited before the banner:\n${lastFail}`);
    }
    // port collision: loop and try another one
  }
  throw new Error(`could not find a free web port in 5 attempts:\n${lastFail}`);
}

// -----------------------------------------------------------------------------

test('integration: boot unlinked, link a MockSquad live via POST /api/settings (§3)', async () => {
  // temp dir — never the repo data/ dir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-set-'));
  const logPath = path.join(tmp, 'SquadGame.log');

  // MockSquad on an ephemeral RCON port — the server does NOT know about it yet.
  const mock = new MockSquad({ rconPort: 0, logPath, password: RCON_PASSWORD });
  await mock.start();

  const transcript = { text: '' };
  let child = null;
  let stepName = 'boot';
  const step = (s) => { stepName = s; };

  try {
    try {
      // ------------------------------------------------ boot with no server linked
      const app = await startServer({ tmp, logPath, transcript });
      child = app.child;
      assert.ok(app.setupToken, 'FIRST-RUN setup token printed in the console banner');
      const base = `http://127.0.0.1:${app.port}`;
      const api = makeApi(base);
      const owner = { cookie: null };
      const viewer = { cookie: null };

      step('first-run setup + owner login');
      const okSetup = await api(owner, 'POST', '/api/setup', {
        username: 'boss', password: 'hunter2hunter2', setupToken: app.setupToken,
      });
      assert.strictEqual(okSetup.status, 200, `setup accepted: ${okSetup.text}`);
      const login = await api(owner, 'POST', '/api/login', { username: 'boss', password: 'hunter2hunter2' });
      assert.strictEqual(login.status, 200, `owner login: ${login.text}`);
      assert.ok(owner.cookie, 'session cookie captured');

      // ----------------------------------------------------- unlinked state reads
      step('GET /api/settings shows linked:false and an idle RCON');
      const before = await api(owner, 'GET', '/api/settings');
      assert.strictEqual(before.status, 200, `settings read: ${before.text}`);
      assert.strictEqual(before.json.linked, false, 'no server linked yet');
      assert.ok(before.json.status && before.json.status.rcon, 'rcon status present');
      assert.strictEqual(before.json.status.rcon.connected, false, 'RCON not connected while unlinked');
      assert.strictEqual(before.json.secretsSet.rconPassword, false, 'no RCON password saved yet');

      // --------------------------------------------------- link the mock server
      step('POST /api/settings links the mock server');
      const saved = await api(owner, 'POST', '/api/settings', {
        squad: { rconHost: '127.0.0.1', rconPort: mock.port, rconPassword: RCON_PASSWORD },
      });
      assert.strictEqual(saved.status, 200, `settings update: ${saved.text}`);
      assert.strictEqual(saved.json.ok, true);
      assert.deepStrictEqual(saved.json.changed.sort(),
        ['squad.rconHost', 'squad.rconPassword', 'squad.rconPort']);
      assert.strictEqual(saved.json.persistError, null);

      step('RCON connects to the mock within ~10s');
      await until(async () => {
        const o = await api(owner, 'GET', '/api/overview');
        const r = o.json && o.json.status && o.json.status.rcon;
        return r && r.connected && r.authed ? true : null;
      }, { timeoutMs: 10000, label: 'status.rcon.connected in /api/overview' });

      step('config.json on disk now carries the saved squad block');
      const onDisk = JSON.parse(fs.readFileSync(app.cfgPath, 'utf8'));
      assert.deepStrictEqual(onDisk.squad, {
        rconHost: '127.0.0.1', rconPort: mock.port, rconPassword: RCON_PASSWORD,
      });

      step('GET /api/settings reflects the link and never echoes the password');
      const after = await api(owner, 'GET', '/api/settings');
      assert.strictEqual(after.json.linked, true);
      assert.strictEqual(after.json.secretsSet.rconPassword, true, 'saved-secret flag set');
      assert.ok(!after.text.includes(RCON_PASSWORD), 'redactedConfig scrubbed the password (§19.3.27)');

      // ----------------------------------------------------- connection probes
      step('POST /api/settings/test probes the mock with the saved password');
      const probe = await api(owner, 'POST', '/api/settings/test', {
        rconHost: '127.0.0.1', rconPort: mock.port, rconPassword: null, // null = stored
      });
      assert.strictEqual(probe.status, 200, `test: ${probe.text}`);
      assert.strictEqual(probe.json.ok, true, `probe failed: ${probe.text}`);
      assert.strictEqual(probe.json.serverName, 'A3 Demo Server');

      step('POST /api/settings/test with a wrong password fails naming the password');
      const bad = await api(owner, 'POST', '/api/settings/test', {
        rconHost: '127.0.0.1', rconPort: mock.port, rconPassword: 'not-the-password',
      });
      assert.strictEqual(bad.status, 200);
      assert.strictEqual(bad.json.ok, false);
      assert.match(bad.json.error, /password/i);

      // ------------------------------------------------------- rejection paths
      step('out-of-range rconPort -> 400, nothing applied');
      const invalid = await api(owner, 'POST', '/api/settings', { squad: { rconPort: 99999 } });
      assert.strictEqual(invalid.status, 400, `expected 400: ${invalid.text}`);
      assert.match(invalid.json.error, /squad\.rconPort/);
      assert.strictEqual(JSON.parse(fs.readFileSync(app.cfgPath, 'utf8')).squad.rconPort, mock.port,
        'config.json keeps the good port');

      step('a user without the settings perm gets 403');
      const created = await api(owner, 'POST', '/api/users', {
        username: 'scout', password: 'viewerpass1', role: 'viewer',
      });
      assert.strictEqual(created.status, 200, `user create: ${created.text}`);
      const vLogin = await api(viewer, 'POST', '/api/login', { username: 'scout', password: 'viewerpass1' });
      assert.strictEqual(vLogin.status, 200);
      const vRead = await api(viewer, 'GET', '/api/settings');
      assert.strictEqual(vRead.status, 403, 'viewer may not read settings');
      const vWrite = await api(viewer, 'POST', '/api/settings', { squad: { rconHost: 'evil.example' } });
      assert.strictEqual(vWrite.status, 403, 'viewer may not write settings');

      // --------------------------------------------------------------- shutdown
      step('graceful shutdown');
      if (process.platform === 'win32') child.send('shutdown');
      else child.kill('SIGTERM');
      const exit = await waitExit(child, 5000);
      assert.strictEqual(exit.code, 0, `clean exit (got code=${exit.code} signal=${exit.signal})`);
      child = null;
    } catch (e) {
      e.message = `[step: ${stepName}] ${e.message}\n--- server output (tail) ---\n${transcript.text.slice(-3000)}`;
      throw e;
    }
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
      await waitExit(child, 3000).catch(() => {});
    }
    await mock.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('behind a trusted HTTPS proxy, plain-HTTP visits are redirected to the public HTTPS origin', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-https-'));
  const logPath = path.join(tmp, 'SquadGame.log');
  const transcript = { text: '' };
  let child = null;
  try {
    const app = await startServer({
      tmp, logPath, transcript,
      web: { trustProxy: true, publicUrl: 'https://panel.example.test/' },
    });
    child = app.child;
    const base = `http://127.0.0.1:${app.port}`;
    const get = (p, headers) => fetch(base + p, { headers, redirect: 'manual' });

    const viaHttp = await get('/api/bootstrap?x=1', { 'x-forwarded-proto': 'http' });
    assert.strictEqual(viaHttp.status, 308, 'plain-HTTP visit through the proxy is redirected');
    assert.strictEqual(viaHttp.headers.get('location'), 'https://panel.example.test/api/bootstrap?x=1',
      'redirect keeps path + query on the configured HTTPS origin');

    const viaHttps = await get('/api/bootstrap', { 'x-forwarded-proto': 'https' });
    assert.strictEqual(viaHttps.status, 200, 'HTTPS visits are served');

    const direct = await get('/api/bootstrap', {});
    assert.strictEqual(direct.status, 200, 'direct local access (no proxy header) is served');
  } finally {
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
      await waitExit(child, 3000).catch(() => {});
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
