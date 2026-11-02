'use strict';
// Static files. With `staticSnapshot` (the live panel) the server serves the
// public/ it booted with — later edits in the tree never reach browsers
// before a restart — and stamps asset URLs in the HTML with content hashes.
// Without it (demo, development) every request reads the disk and stamps
// mtimes. Both refuse traversal and unknown extensions.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createApi } = require('../server/api');
const LiveState = require('../server/state');

async function boot(t, publicDir, staticSnapshot) {
  const db = openDb(':memory:');
  db.migrate();
  const auth = createAuth({ db, config: {} });
  const server = createApi({ db, state: new LiveState(), auth, config: {}, publicDir, staticSnapshot });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, type: res.headers.get('content-type'), csp: res.headers.get('content-security-policy'), text: await res.text() };
  };
  // The path exactly as written: fetch would normalize dot segments away.
  get.raw = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  return get;
}

function makePublic(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a3-public-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'secret.js'), 'outside public/');
  const dir = path.join(root, 'public');
  fs.mkdirSync(path.join(dir, 'css'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<link href="css/a.css"><script src="app.js"></script><script src="missing.js"></script>');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("v1")');
  fs.writeFileSync(path.join(dir, 'css', 'a.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not servable');
  return dir;
}
const hash10 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

test('snapshot: boot-time files and content-hash stamps; later edits stay out', async (t) => {
  const dir = makePublic(t);
  const get = await boot(t, dir, true);

  const index = await get('/');
  assert.strictEqual(index.status, 200);
  assert.ok(index.csp, 'HTML carries the CSP');
  assert.ok(index.text.includes(`src="app.js?v=${hash10('console.log("v1")')}"`), index.text);
  assert.ok(index.text.includes(`href="css/a.css?v=${hash10('body{}')}"`), index.text);
  assert.ok(index.text.includes('src="missing.js"'), 'unknown assets stay unstamped');

  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("v2 half-written');
  fs.writeFileSync(path.join(dir, 'late.js'), 'added after boot');
  assert.strictEqual((await get('/app.js')).text, 'console.log("v1")', 'edits after boot are not served');
  assert.strictEqual((await get('/late.js')).status, 404, 'files added after boot are not served');
  assert.ok((await get('/')).text.includes(`app.js?v=${hash10('console.log("v1")')}`), 'stamps stay the boot-time ones');

  assert.strictEqual((await get('/css/a.css')).type, 'text/css; charset=utf-8');
  assert.strictEqual((await get('/notes.txt')).status, 404, 'unlisted extensions are never served');
  assert.strictEqual((await get('/css/../app.js')).status, 200, 'the URL parser normalizes inner dot segments');
  for (const raw of ['/../secret.js', '/css/../../secret.js', '/%2e%2e/secret.js', '/..%2fsecret.js', '/css%2f..%2f..%2fsecret.js']) {
    const st = await get.raw(raw);
    assert.ok(st === 400 || st === 404, `traversal refused: ${raw} -> ${st}`);
  }
});

test('no snapshot: reads the disk on every request, mtime stamps', async (t) => {
  const dir = makePublic(t);
  const get = await boot(t, dir, false);
  assert.strictEqual((await get('/app.js')).text, 'console.log("v1")');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("v2")');
  assert.strictEqual((await get('/app.js')).text, 'console.log("v2")');
  const mt = Math.floor(fs.statSync(path.join(dir, 'app.js')).mtimeMs).toString(36);
  assert.ok((await get('/')).text.includes(`src="app.js?v=${mt}"`));
});
