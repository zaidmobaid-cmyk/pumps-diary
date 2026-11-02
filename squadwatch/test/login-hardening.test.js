'use strict';
// Login brute-force + HTTPS hardening (server/auth.js, server/api.js).
//
// UNIT — clientAddressKey (IPv4 exact, IPv4-mapped -> IPv4, IPv6 -> its /64
//   through every '::' form, zones/brackets/ports, loopback, garbage); the
//   username limit groups spellings exactly as the users table resolves them
//   (SQLite itself is the oracle: ASCII-only NOCASE, NUL, lone surrogates);
//   verifyLogin is async and every outcome costs exactly one scrypt; a reset
//   or disable landing mid-check wins; the in-flight cap refuses a 5th
//   concurrent check at once (scrypt calls are parked so slots stay held);
//   the 8-character minimum on every creation path, while passwords stored
//   before it keep working.
//
// IN-PROCESS HTTP — createApi over a real auth behind a trusted proxy: a
//   saturated check pool is a 503 + Retry-After, never a queue, and leaves no
//   claim on the username; concurrent guesses at a name one failure short of
//   its lock get one real check between them, the rest 429; a look-alike
//   account (KELVIN SIGN) logging in clears nothing for the name it mimics.
//
// SPAWNED SERVER (like settings.test.js), behind a trusted proxy: rotating
//   /128s inside one IPv6 /64 hits 429; a locked username stays locked
//   through another account's success from the same address and only its
//   own success clears it; known and unknown names answer identically; the
//   minimum on setup, user create, password reset and invite claim; HSTS on
//   HTTPS-arrived responses only; the plain-HTTP 308 without publicUrl via
//   the Host header, 400 on a malformed Host, publicUrl precedence, and
//   blanking publicUrl in Settings keeping the redirect. A second server
//   without trustProxy ignores the proxy headers entirely.
//
// Everything runs on random ports in fresh temp dirs.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');

const { openDb } = require('../server/db');
const {
  createAuth, hashPassword, passwordProblem, clientAddressKey, createLoginLimiter,
} = require('../server/auth');
const { createApi } = require('../server/api');

const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server', 'index.js');
const HSTS = 'max-age=31536000';
const OWNER = { username: 'boss', password: 'hunter2hunter2' };

function freshAuth() {
  const db = openDb(':memory:');
  db.migrate();
  return { db, auth: createAuth({ db, config: {} }) };
}

// Park every crypto.scrypt call until release(): the password checks that
// made them keep holding their in-flight slots for as long as a test needs.
function holdScrypt(t) {
  const real = crypto.scrypt;
  const parked = [];
  const mocked = t.mock.method(crypto, 'scrypt', (...args) => { parked.push(args); });
  return {
    get parked() { return parked.length; },
    release() {
      mocked.mock.restore();
      for (const args of parked.splice(0)) real(...args);
    },
  };
}

// Unique client addresses from the benchmarking range, one bucket each.
let addrSeq = 0;
function freshIp() {
  addrSeq++;
  return `198.18.${Math.floor(addrSeq / 250)}.${(addrSeq % 250) + 1}`;
}

// Polls `cond`; throws after `ms` so a regression fails instead of hanging
// on parked checks.
async function until(cond, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms}ms`);
    await sleep(5);
  }
}

// ===================================================================== UNIT

test('clientAddressKey: IPv4 exact, mapped IPv4 unwrapped, IPv6 collapsed to its /64', () => {
  const cases = [
    // IPv4 and IPv4-mapped IPv6 (dual-stack sockets report the latter)
    ['203.0.113.7', '203.0.113.7'],
    ['::ffff:203.0.113.7', '203.0.113.7'],
    ['::FFFF:203.0.113.7', '203.0.113.7'],
    ['0:0:0:0:0:ffff:cb00:7107', '203.0.113.7'],
    ['198.51.100.9:5555', '198.51.100.9'],
    // IPv6: every spelling of one /64 is one key
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:0db8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::9', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8::/64'],
    ['2001:db8::', '2001:db8::/64'],
    ['2001:db8:0:0:1::', '2001:db8::/64'],
    ['2001::1:0:0:0:1', '2001:0:0:1::/64'],
    ['  2001:DB8:A::1  ', '2001:db8:a::/64'],
    // zones, brackets, ports
    ['fe80::1%eth0', 'fe80::/64'],
    ['[2001:db8::1]', '2001:db8::/64'],
    ['[2001:db8::1]:443', '2001:db8::/64'],
    // loopback
    ['127.0.0.1', '127.0.0.1'],
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::1', '::/64'],
    // garbage: keyed by its own text, never thrown on
    ['', ''],
    [null, ''],
    [undefined, ''],
    ['unknown', 'unknown'],
    ['1.2.3.256', '1.2.3.256'],
    ['2001:db8::g', '2001:db8::g'],
    ['1::2::3', '1::2::3'],
    ['1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8:9'],
    ['1:2:3:4:5:6:7:8::', '1:2:3:4:5:6:7:8::'],
    [':1:2:3:4:5:6:7', ':1:2:3:4:5:6:7'],
    ['::ffff:1.2.3', '::ffff:1.2.3'],
  ];
  for (const [input, want] of cases) {
    assert.strictEqual(clientAddressKey(input), want, `clientAddressKey(${JSON.stringify(input)})`);
  }
  assert.strictEqual(clientAddressKey('x'.repeat(5000)).length, 64, 'garbage keys are bounded');
  assert.notStrictEqual(clientAddressKey('2001:db8:aa:bb::1'), clientAddressKey('2001:db8:aa:bc::1'),
    'neighbouring /64s stay apart');
});

test('the username limit groups spellings exactly as the users table resolves them', () => {
  const { db, auth } = freshAuth();
  // Separate accounts that a Unicode-aware lowercase would merge, plus the
  // NUL and U+FFFD corners of how SQLite stores and compares text.
  const accounts = [
    'kilo', '\u212Ailo', // KELVIN SIGN lowercases to 'k'
    '\u00E9lan', '\u00C9lan',
    '\u0430\u0434\u043C\u0438\u043D', '\u0410\u0434\u043C\u0438\u043D',
    '\u0130stanbul', 'i\u0307stanbul', // '\u0130'.toLowerCase() is 'i' + U+0307
    'x\uFFFDy', 'nul\u0000a',
  ];
  const insert = db.prepare('INSERT INTO users(username, pass_hash, role_id, created_at, disabled) VALUES(?,?,?,?,0)');
  const viewer = auth.roleRow('viewer').id;
  const ids = accounts.map((name) => Number(insert.run(name, 'x', viewer, Date.now()).lastInsertRowid));
  const probes = accounts.concat([
    'KILO', ' kIlO ', '\u212AILO', '\u00C9LAN', '\u00E9LAN', '\u0130STANBUL', 'I\u0307STANBUL',
    'x\uD800y', 'X\uDFFFY', // lone surrogates reach SQLite as U+FFFD
    'nul\u0000B', 'NUL\u0000z', // NOCASE stops at the NUL; byte lengths still match
    'nul\u0000bb', 'nul', 'ghost',
  ]);
  // the lookup verifyLogin runs
  const resolve = (name) => {
    const row = db.prepare('SELECT id FROM users WHERE username = ?').get(name.trim());
    return row ? Number(row.id) : null;
  };
  assert.strictEqual(new Set(ids).size, accounts.length, 'the users table keeps every account apart');
  assert.strictEqual(resolve('\u212AILO'), ids[1]);
  assert.strictEqual(resolve('X\uDFFFY'), ids[8]);
  assert.strictEqual(resolve('NUL\u0000z'), ids[9]);
  assert.strictEqual(resolve('nul\u0000bb'), null);

  accounts.forEach((account, i) => {
    const lim = createLoginLimiter({ userMax: 1 });
    lim.claimUser(account).fail(); // locks exactly this account's bucket
    for (const probe of probes) {
      const claim = lim.claimUser(probe);
      if (claim.ok) claim.release();
      const same = resolve(probe) === ids[i];
      assert.strictEqual(!claim.ok, same, `${JSON.stringify(probe)} vs account ${JSON.stringify(account)}: `
        + (same ? 'one account must be one bucket' : 'different accounts must not share a bucket'));
    }
    lim.stop();
  });
});

test('verifyLogin is async and every outcome costs exactly one scrypt: ok, wrong, unknown, disabled, blank, corrupt hash', async (t) => {
  const { db, auth } = freshAuth();
  auth.createUser('Uniform', 'uniform-pass', 'viewer');
  auth.createUser('Off', 'off-pass-123', 'viewer');
  db.prepare('UPDATE users SET disabled=1 WHERE username=?').run('Off');
  auth.createUser('Mangled', 'mangled-pass', 'viewer');
  db.prepare('UPDATE users SET pass_hash=? WHERE username=?').run('not-a-hash', 'Mangled');
  const spy = t.mock.method(crypto, 'scrypt');
  const cases = [
    ['uniform', 'uniform-pass', true],
    ['Uniform', 'wrong-pass', false],
    ['ghost', 'uniform-pass', false],
    ['Off', 'off-pass-123', false],
    ['', 'uniform-pass', false],
    ['Mangled', 'mangled-pass', false],
  ];
  for (const [username, password, good] of cases) {
    spy.mock.resetCalls();
    const pending = auth.verifyLogin(username, password);
    assert.ok(pending instanceof Promise, 'verifyLogin returns a promise');
    const out = await pending;
    const label = username || '(blank)';
    assert.strictEqual(spy.mock.callCount(), 1, `${label}: exactly one scrypt`);
    if (good) assert.ok(out && out.username === 'Uniform', `${label}: logs in`);
    else assert.strictEqual(out, null, `${label}: fails`);
  }
});

test('a password reset or a disable that lands while the check runs still wins', async (t) => {
  const { db, auth } = freshAuth();
  auth.createUser('racer', 'old-pass-123', 'admin');

  let hold = holdScrypt(t);
  const before = auth.verifyLogin('racer', 'old-pass-123');
  db.prepare('UPDATE users SET pass_hash=? WHERE username=?').run(hashPassword('new-pass-123'), 'racer');
  hold.release();
  assert.strictEqual(await before, null, 'the replaced password does not log in');

  hold = holdScrypt(t);
  const during = auth.verifyLogin('racer', 'new-pass-123');
  db.prepare('UPDATE users SET disabled=1 WHERE username=?').run('racer');
  hold.release();
  assert.strictEqual(await during, null, 'the disable wins');
});

test('in-flight cap: a 5th concurrent check is refused at once (ELOGINBUSY), and slots free on every path', async (t) => {
  const { auth } = freshAuth();
  auth.createUser('gate', 'gate-pass-1', 'admin');
  const hold = holdScrypt(t);
  const running = [
    auth.verifyLogin('gate', 'gate-pass-1'),
    auth.verifyLogin('gate', 'wrong-pass-1'),
    auth.verifyLogin('nobody', 'whatever-1'),
    auth.verifyLogin('', ''),
  ];
  assert.strictEqual(hold.parked, 4, 'four checks hold the four slots');
  await assert.rejects(auth.verifyLogin('gate', 'gate-pass-1'), (e) => {
    assert.strictEqual(e.code, 'ELOGINBUSY');
    assert.ok(e.retryAfterSec >= 1);
    return true;
  });
  assert.strictEqual(hold.parked, 4, 'the refused check never reached scrypt');
  hold.release();
  const [ok, wrong, unknown, blank] = await Promise.all(running);
  assert.ok(ok && ok.username === 'gate');
  assert.strictEqual(wrong, null);
  assert.strictEqual(unknown, null);
  assert.strictEqual(blank, null);
  // success and failure paths alike gave their slots back
  const again = await Promise.all([1, 2, 3, 4].map(() => auth.verifyLogin('gate', 'gate-pass-1')));
  assert.ok(again.every((u) => u && u.username === 'gate'));
});

test('new passwords need 8+ characters on every creation path; stored short ones keep working', async () => {
  assert.strictEqual(passwordProblem('1234567'), 'password must be at least 8 characters');
  assert.strictEqual(passwordProblem('12345678'), null);
  assert.strictEqual(passwordProblem('\u{1F511}'.repeat(7)), 'password must be at least 8 characters',
    'counted in characters, not UTF-16 units');
  assert.strictEqual(passwordProblem('\u{1F511}'.repeat(8)), null);
  assert.strictEqual(passwordProblem(''), 'password required');
  assert.strictEqual(passwordProblem(undefined), 'password required');

  const { db, auth } = freshAuth();
  assert.throws(() => auth.createFirstOwner({ username: 'boss', password: 'seven77' }), /at least 8 characters/);
  assert.strictEqual(auth.needsSetup(), true, 'a refused setup leaves setup open');
  assert.ok(auth.verifySetupToken(auth.setupToken), 'and the setup token valid');
  auth.createFirstOwner({ username: 'boss', password: 'eight888' });

  assert.throws(() => auth.createUser('mod', 'seven77', 'admin'), /at least 8 characters/);
  assert.ok(auth.createUser('mod', 'eight888', 'admin').id > 0);

  const inv = auth.createInvite({ roleId: auth.roleRow('viewer').id, ttlMs: 3600 * 1000 });
  assert.throws(() => auth.claimInvite(inv.token, { username: 'newbie', password: 'seven77' }), /at least 8 characters/);
  assert.ok(auth.findInvite(inv.token), 'the invite is still claimable');
  assert.ok(auth.claimInvite(inv.token, { username: 'newbie', password: 'eight888' }).user.id > 0);

  // accounts stored before the policy: unaffected
  db.prepare('INSERT INTO users(username, pass_hash, role_id, created_at, disabled) VALUES(?,?,?,?,0)')
    .run('oldtimer', hashPassword('abc'), auth.roleRow('viewer').id, Date.now());
  const legacy = await auth.verifyLogin('oldtimer', 'abc');
  assert.ok(legacy && legacy.username === 'oldtimer');
});

// ========================================================= IN-PROCESS HTTP

// createApi over `auth`, behind a trusted proxy so every login names its own
// client address: a fresh one by default, keeping address buckets out of the
// way of the username limit under test.
async function inProcessLogin(t, db, auth) {
  const server = createApi({ db, auth, config: { web: { trustProxy: true } } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (username, password, ip = freshIp()) => {
    const res = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { origin: base, 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ username, password }),
    });
    return { status: res.status, retryAfter: Number(res.headers.get('retry-after')), text: await res.text() };
  };
}

test('in-process API: a saturated password-check pool answers 503 + Retry-After at once, keeping no claim on the name', async (t) => {
  const { db, auth } = freshAuth();
  auth.createUser('busy', 'busy-pass-1', 'admin');
  const login = await inProcessLogin(t, db, auth);
  const hold = holdScrypt(t);
  let running;
  try {
    running = [1, 2, 3, 4].map(() => auth.verifyLogin('busy', 'busy-pass-1'));
    // more refusals than the username limit: any claim they kept would lock 'busy'
    for (let i = 1; i <= 12; i++) {
      const refused = await login('busy', 'busy-pass-1');
      assert.strictEqual(refused.status, 503, `refusal ${i}: ${refused.text}`);
      assert.ok(refused.retryAfter >= 1, 'Retry-After on the 503');
      assert.match(JSON.parse(refused.text).error, /busy/);
    }
    assert.strictEqual(hold.parked, 4, 'the refused logins queued no scrypt');
  } finally {
    hold.release();
  }
  assert.ok((await Promise.all(running)).every((u) => u && u.username === 'busy'));
  const ok = await login('busy', 'busy-pass-1');
  assert.strictEqual(ok.status, 200, `slots and claims came back: ${ok.text}`);
});

test('in-process API: concurrent guesses at a name one failure short of its lock get one real check between them', async (t) => {
  const { db, auth } = freshAuth();
  auth.createUser('victim', 'victim-pass-1', 'viewer');
  const login = await inProcessLogin(t, db, auth);
  for (let i = 1; i <= 9; i++) {
    assert.strictEqual((await login('victim', 'wrong-pass-1')).status, 401, `failure ${i}`);
  }
  const hold = holdScrypt(t);
  let tenth;
  let burst;
  try {
    tenth = login('victim', 'wrong-pass-1');
    await until(() => hold.parked === 1);
    const answered = [];
    burst = [1, 2, 3].map(() => login('VICTIM', 'wrong-pass-1').then((r) => { answered.push(r); return r; }));
    await until(() => answered.length === 3 || hold.parked > 1);
    assert.strictEqual(hold.parked, 1, 'the guesses that arrived while the 10th check ran never reached scrypt');
  } finally {
    hold.release();
  }
  for (const r of await Promise.all(burst)) {
    assert.strictEqual(r.status, 429, r.text);
    assert.ok(r.retryAfter >= 1, 'Retry-After on the 429');
  }
  assert.strictEqual((await tenth).status, 401, 'the one real check: failure 10');
  const locked = await login('victim', 'victim-pass-1');
  assert.strictEqual(locked.status, 429, 'ten checks in all, then locked, right password or not');
  assert.ok(locked.retryAfter > 60, `the username window (got ${locked.retryAfter})`);
});

test("in-process API: a look-alike account (KELVIN SIGN) logging in clears nothing for the name it mimics", async (t) => {
  const { db, auth } = freshAuth();
  const kilo = auth.createUser('kilo', 'kilo-pass-123', 'viewer');
  const mimic = auth.createUser('\u212Ailo', 'mimic-pass-1', 'viewer');
  assert.notStrictEqual(mimic.id, kilo.id, 'the users table keeps the two apart');
  const login = await inProcessLogin(t, db, auth);
  for (let i = 1; i <= 9; i++) {
    assert.strictEqual((await login('kilo', 'wrong-pass-1')).status, 401, `failure ${i}`);
  }
  assert.strictEqual((await login('\u212Ailo', 'mimic-pass-1')).status, 200, 'the look-alike logs in');
  assert.strictEqual((await login('kilo', 'wrong-pass-1')).status, 401, 'failure 10');
  const locked = await login('kilo', 'kilo-pass-123');
  assert.strictEqual(locked.status, 429, "the look-alike's success cleared none of kilo's failures");
});

// ====================================================== SPAWNED SERVER HTTP
// (startServer/waitExit copied/trimmed from settings.test.js)

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

// Real server, nothing linked (RCON idle); random high ports, retried on
// EADDRINUSE since web.port 0 is not supported.
async function startServer(web) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-login-'));
  let lastFail = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const cfgPath = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      web: Object.assign({ port, host: '127.0.0.1' }, web),
      squad: { rconHost: '', rconPort: 21114, rconPassword: '' },
      log: { mode: 'local', path: path.join(tmp, 'SquadGame.log'), pollMs: 100, backfill: true },
      dbPath: path.join(tmp, 'squadwatch.db'),
    }, null, 2));
    const child = spawn(process.execPath, [SERVER_JS, '--config', cfgPath], {
      cwd: ROOT,
      // 'ipc' so shutdown can be graceful on Windows, where kill() cannot
      // deliver a catchable signal.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 15000);
      child.stdout.on('data', (c) => {
        buf += c;
        if (/ v[^\n]* up: http/.test(buf)) { clearTimeout(timer); resolve('up'); }
      });
      child.stderr.on('data', (c) => { buf += c; });
      child.once('exit', () => { clearTimeout(timer); resolve('exited'); });
    });
    if (outcome === 'up') {
      const tokenLine = buf.split('\n').find((l) => l.includes('Setup token'));
      const m = tokenLine ? /([0-9a-f]{32})/.exec(tokenLine) : null;
      return { child, port, tmp, base: `http://127.0.0.1:${port}`, setupToken: m ? m[1] : null };
    }
    if (child.exitCode == null) child.kill('SIGKILL');
    lastFail = buf.slice(-2000);
    if (outcome === 'timeout' || !/EADDRINUSE|address already in use/i.test(buf)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw new Error(`server did not come up (${outcome}):\n${lastFail}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  throw new Error(`could not find a free web port in 5 attempts:\n${lastFail}`);
}

async function stopServer(app) {
  if (!app) return;
  const { child } = app;
  try {
    if (child.exitCode == null && child.signalCode == null) {
      if (process.platform === 'win32') child.send('shutdown');
      else child.kill('SIGTERM');
      await waitExit(child, 5000);
    }
  } catch (_e) {
    child.kill('SIGKILL');
    await waitExit(child, 3000).catch(() => {});
  }
  fs.rmSync(app.tmp, { recursive: true, force: true });
}

// fetch with the Origin the CSRF check requires, an optional cookie jar, and
// the headers a TLS-terminating tunnel adds: proto (https unless overridden,
// null = none) and the client address as the last X-Forwarded-For hop.
function makeApi(base) {
  return async function api(jar, method, p, body, { ip, proto = 'https' } = {}) {
    const headers = { origin: base, accept: 'application/json' };
    if (proto) headers['x-forwarded-proto'] = proto;
    if (ip) headers['x-forwarded-for'] = ip;
    if (jar && jar.cookie) headers.cookie = jar.cookie;
    const init = { method, headers, redirect: 'manual' };
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
    return { status: res.status, json, text, headers: res.headers };
  };
}

// Plain GET with a hand-set Host header (fetch will not forge one).
function rawGet(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A: behind a trusted proxy, no publicUrl. B: no trustProxy.
const ctx = { a: null, b: null, apiA: null, apiB: null, owner: { cookie: null }, users: {} };

test.before(async () => {
  [ctx.a, ctx.b] = await Promise.all([startServer({ trustProxy: true }), startServer({})]);
  ctx.apiA = makeApi(ctx.a.base);
  ctx.apiB = makeApi(ctx.b.base);
  const setup = await ctx.apiA(null, 'POST', '/api/setup',
    Object.assign({ setupToken: ctx.a.setupToken }, OWNER), { ip: freshIp() });
  assert.strictEqual(setup.status, 200, `setup: ${setup.text}`);
  const login = await ctx.apiA(ctx.owner, 'POST', '/api/login', OWNER, { ip: freshIp() });
  assert.strictEqual(login.status, 200, `owner login: ${login.text}`);
  for (const [username, password] of [['victim', 'victim-pass-1'], ['alice', 'alice-pass-1'], ['quiet', 'quiet-pass-1']]) {
    const r = await ctx.apiA(ctx.owner, 'POST', '/api/users', { username, password, role: 'viewer' });
    assert.strictEqual(r.status, 200, `create ${username}: ${r.text}`);
    ctx.users[username] = { id: r.json.user.id, password };
  }
});

test.after(async () => {
  await Promise.all([stopServer(ctx.a), stopServer(ctx.b)]);
});

function loginA(username, password, ip) {
  return ctx.apiA(null, 'POST', '/api/login', { username, password }, { ip });
}

test('HTTP: rotating addresses inside one IPv6 /64 hits 429; the next /64 and mapped IPv4 behave as one client each', async () => {
  for (let i = 1; i <= 10; i++) {
    const r = await loginA(`rot-${i}`, 'wrong-pass-1', `2001:db8:5:6::${i.toString(16)}`);
    assert.strictEqual(r.status, 401, `attempt ${i}: ${r.text}`);
  }
  const blocked = await loginA('rot-11', 'wrong-pass-1', '2001:db8:5:6:ffff:ffff:ffff:fffe');
  assert.strictEqual(blocked.status, 429, `11th /128 in the /64: ${blocked.text}`);
  const ra = Number(blocked.headers.get('retry-after'));
  assert.ok(ra >= 1 && ra <= 60, `Retry-After within the address window (got ${ra})`);
  assert.strictEqual((await loginA('rot-12', 'wrong-pass-1', '2001:db8:5:7::1')).status, 401,
    'the neighbouring /64 has its own bucket');

  const v4 = freshIp();
  for (let i = 1; i <= 10; i++) {
    assert.strictEqual((await loginA(`v4-${i}`, 'wrong-pass-1', v4)).status, 401);
  }
  assert.strictEqual((await loginA('v4-11', 'wrong-pass-1', `::ffff:${v4}`)).status, 429,
    'the IPv4-mapped spelling is the same client');
});

test('HTTP: a locked username stays locked through another account\'s success from the same address; only its own success clears', async () => {
  const victim = ctx.users.victim;
  const x = freshIp();
  for (let i = 1; i <= 9; i++) {
    assert.strictEqual((await loginA('victim', 'wrong-pass-1', x)).status, 401, `victim failure ${i}`);
  }
  assert.strictEqual((await loginA(OWNER.username, OWNER.password, x)).status, 200, 'owner logs in from x');
  const spent = await loginA('victim', 'wrong-pass-1', x);
  assert.strictEqual(spent.status, 429, "the owner's success did not reopen x's bucket");
  assert.ok(Number(spent.headers.get('retry-after')) <= 60);

  const y = freshIp();
  assert.strictEqual((await loginA('victim', 'wrong-pass-1', y)).status, 401, 'victim failure 10');
  const locked = await loginA('victim', victim.password, y);
  assert.strictEqual(locked.status, 429, 'locked: even the right password is refused');
  assert.ok(Number(locked.headers.get('retry-after')) > 60, 'the username window, not the address one');
  assert.strictEqual((await loginA(OWNER.username, OWNER.password, y)).status, 200, 'owner logs in from y');
  assert.strictEqual((await loginA('victim', victim.password, y)).status, 429,
    "another account's success from the same address leaves the lock in place");

  const alice = ctx.users.alice;
  const z1 = freshIp();
  for (let i = 1; i <= 9; i++) {
    assert.strictEqual((await loginA('alice', 'wrong-pass-1', z1)).status, 401, `alice failure ${i}`);
  }
  const z2 = freshIp();
  assert.strictEqual((await loginA('ALICE', alice.password, z2)).status, 200, 'alice logs in herself');
  for (let i = 1; i <= 9; i++) {
    assert.strictEqual((await loginA('alice', 'wrong-pass-1', z2)).status, 401,
      `failure ${i} after her success: the earlier 9 were cleared`);
  }
  assert.strictEqual((await loginA('alice', alice.password, freshIp())).status, 200);
});

test('HTTP: known and unknown usernames answer identically, before and after locking', async () => {
  const wrongKnown = await loginA('quiet', 'wrong-pass-1', freshIp());
  const wrongUnknown = await loginA('nobody-home', 'wrong-pass-1', freshIp());
  assert.strictEqual(wrongKnown.status, 401);
  assert.strictEqual(wrongUnknown.status, wrongKnown.status);
  assert.strictEqual(wrongUnknown.text, wrongKnown.text);
  for (const name of ['quiet', 'nobody-home']) {
    const ip = freshIp();
    for (let i = 2; i <= 10; i++) assert.strictEqual((await loginA(name, 'wrong-pass-1', ip)).status, 401);
  }
  const lockedKnown = await loginA('quiet', ctx.users.quiet.password, freshIp());
  const lockedUnknown = await loginA('nobody-home', 'wrong-pass-1', freshIp());
  assert.strictEqual(lockedKnown.status, 429);
  assert.strictEqual(lockedUnknown.status, 429);
  assert.strictEqual(lockedUnknown.text, lockedKnown.text);
  assert.ok(lockedKnown.headers.get('retry-after') && lockedUnknown.headers.get('retry-after'));
});

test('HTTP: setup, user create, password reset and invite claim all require 8+ characters', async () => {
  // setup — server B still needs its owner
  const shortSetup = await ctx.apiB(null, 'POST', '/api/setup',
    { username: 'root', password: 'seven77', setupToken: ctx.b.setupToken });
  assert.strictEqual(shortSetup.status, 400, shortSetup.text);
  assert.match(shortSetup.json.error, /at least 8 characters/);
  const okSetup = await ctx.apiB(null, 'POST', '/api/setup',
    { username: 'root', password: 'eight888', setupToken: ctx.b.setupToken });
  assert.strictEqual(okSetup.status, 200, okSetup.text);

  // user create
  const api = ctx.apiA;
  const shortUser = await api(ctx.owner, 'POST', '/api/users', { username: 'shorty', password: 'seven77', role: 'viewer' });
  assert.strictEqual(shortUser.status, 400, shortUser.text);
  assert.match(shortUser.json.error, /at least 8 characters/);
  const created = await api(ctx.owner, 'POST', '/api/users', { username: 'resetme', password: 'first-pass-1', role: 'viewer' });
  assert.strictEqual(created.status, 200, created.text);

  // password reset
  const id = created.json.user.id;
  const shortReset = await api(ctx.owner, 'POST', `/api/users/${id}`, { password: 'seven77' });
  assert.strictEqual(shortReset.status, 400, shortReset.text);
  assert.match(shortReset.json.error, /at least 8 characters/);
  assert.strictEqual((await loginA('resetme', 'first-pass-1', freshIp())).status, 200, 'refused reset changed nothing');
  assert.strictEqual((await api(ctx.owner, 'POST', `/api/users/${id}`, { password: 'second-pass-1' })).status, 200);
  assert.strictEqual((await loginA('resetme', 'second-pass-1', freshIp())).status, 200);

  // invite claim
  const roles = await api(ctx.owner, 'GET', '/api/roles');
  const viewer = roles.json.rows.find((r) => r.name === 'viewer');
  const inv = await api(ctx.owner, 'POST', '/api/invites', { roleId: viewer.id });
  assert.strictEqual(inv.status, 200, inv.text);
  const token = inv.json.token;
  const shortJoin = await api(null, 'POST', '/api/join', { token, username: 'joiner', password: 'seven77' }, { ip: freshIp() });
  assert.strictEqual(shortJoin.status, 400, shortJoin.text);
  assert.match(shortJoin.json.error, /at least 8 characters/);
  const peek = await api(null, 'GET', `/api/join?token=${token}`, null, { ip: freshIp() });
  assert.strictEqual(peek.json.valid, true, 'the refused claim did not spend the invite');
  const joined = await api(null, 'POST', '/api/join', { token, username: 'joiner', password: 'eight888' }, { ip: freshIp() });
  assert.strictEqual(joined.status, 200, joined.text);
});

test('HTTP: Strict-Transport-Security only on responses that arrived over HTTPS', async () => {
  const api = ctx.apiA;
  const ok = await api(null, 'GET', '/api/bootstrap');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.headers.get('strict-transport-security'), HSTS, 'no includeSubDomains, no preload');
  const missing = await api(null, 'GET', '/api/no-such-route');
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.headers.get('strict-transport-security'), HSTS, 'error responses carry it too');
  assert.strictEqual((await api(null, 'GET', '/api/bootstrap', null, { proto: 'https, http' }))
    .headers.get('strict-transport-security'), HSTS, 'the first X-Forwarded-Proto value decides');

  const direct = await api(null, 'GET', '/api/bootstrap', null, { proto: null });
  assert.strictEqual(direct.status, 200, 'direct local access (no proxy header) is served');
  assert.strictEqual(direct.headers.get('strict-transport-security'), null);
  const plain = await api(null, 'GET', '/api/bootstrap', null, { proto: 'http' });
  assert.strictEqual(plain.status, 308);
  assert.strictEqual(plain.headers.get('strict-transport-security'), null);

  // without trustProxy the header is just a claim: no HSTS, no redirect
  const untrusted = await ctx.apiB(null, 'GET', '/api/bootstrap');
  assert.strictEqual(untrusted.status, 200);
  assert.strictEqual(untrusted.headers.get('strict-transport-security'), null);
  const untrustedPlain = await ctx.apiB(null, 'GET', '/api/bootstrap', null, { proto: 'http' });
  assert.strictEqual(untrustedPlain.status, 200);
});

test('HTTP: plain-HTTP visits are redirected without any publicUrl, via a well-formed Host only', async () => {
  const port = ctx.a.port;
  const viaHost = await rawGet(port, '/api/bootstrap?x=1', { host: 'panel.example.test', 'x-forwarded-proto': 'http' });
  assert.strictEqual(viaHost.status, 308);
  assert.strictEqual(viaHost.headers.location, 'https://panel.example.test/api/bootstrap?x=1', 'path + query kept');
  assert.strictEqual(viaHost.headers['cache-control'], 'no-store');
  assert.strictEqual(viaHost.headers['strict-transport-security'], undefined);
  const withPort = await rawGet(port, '/', { host: 'panel.example.test:8443', 'x-forwarded-proto': 'http' });
  assert.strictEqual(withPort.headers.location, 'https://panel.example.test:8443/');

  for (const host of ['evil.test/phish', 'bad host', 'user@evil.test', '[::1]:8080', 'evil.test\\x']) {
    const r = await rawGet(port, '/api/bootstrap', { host, 'x-forwarded-proto': 'http' });
    assert.strictEqual(r.status, 400, `Host ${JSON.stringify(host)}`);
    assert.strictEqual(r.headers.location, undefined, `no Location for Host ${JSON.stringify(host)}`);
  }

  // a login posted over cleartext is bounced before any password check
  const post = await ctx.apiA(null, 'POST', '/api/login', OWNER, { proto: 'http', ip: freshIp() });
  assert.strictEqual(post.status, 308);
  assert.strictEqual(post.headers.get('location'), `https://127.0.0.1:${port}/api/login`);
});

test('HTTP: https publicUrl wins over Host; blanking it (or making it http) keeps the redirect', async () => {
  const api = ctx.apiA;
  const setPublicUrl = async (publicUrl) => {
    const r = await api(ctx.owner, 'POST', '/api/settings', { web: { publicUrl } });
    assert.strictEqual(r.status, 200, `set publicUrl ${JSON.stringify(publicUrl)}: ${r.text}`);
  };
  const plainVisit = (host) => rawGet(ctx.a.port, '/api/bootstrap', { host, 'x-forwarded-proto': 'http' });
  try {
    await setPublicUrl('https://panel.example.test/');
    let r = await plainVisit('elsewhere.example');
    assert.strictEqual(r.status, 308);
    assert.strictEqual(r.headers.location, 'https://panel.example.test/api/bootstrap', 'publicUrl wins over Host');

    await setPublicUrl('');
    r = await plainVisit('panel.example.test');
    assert.strictEqual(r.status, 308, 'blanking publicUrl must not reopen plain HTTP');
    assert.strictEqual(r.headers.location, 'https://panel.example.test/api/bootstrap');

    await setPublicUrl('http://insecure.example');
    r = await plainVisit('panel.example.test');
    assert.strictEqual(r.status, 308);
    assert.strictEqual(r.headers.location, 'https://panel.example.test/api/bootstrap', 'an http publicUrl is never a target');
  } finally {
    await setPublicUrl('');
  }
});
