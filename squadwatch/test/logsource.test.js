'use strict';
// Log source tests (SPEC §5 + §19.3.24) — LOCAL mode only, plus the friendly
// lazy-require error paths for the optional ftp/sftp clients. No network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createLogSource } = require('../server/logsource');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(fn, what, ms = 4000, step = 10) {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await delay(step);
  }
}

function tmpdir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-logsrc-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* best effort */ } });
  return dir;
}

// Creates a local-mode source over <dir>/SquadGame.log with a fast poll and
// guaranteed stop() so node --test can exit.
function mkSource(t, dir, over) {
  const cfg = Object.assign({
    mode: 'local',
    path: path.join(dir, 'SquadGame.log'),
    pollMs: 15,
    backfill: false,
  }, over || {});
  const src = createLogSource(cfg, { dataDir: path.join(dir, 'data') });
  const lines = [];
  src.on('line', (l) => lines.push(l));
  t.after(() => src.stop());
  return { src, lines, cfg };
}

function moduleResolves(name) {
  try { require(name); return true; } catch (_e) { return false; }
}

// ----------------------------------------------------------------- local

test('local: appended lines are emitted in order (backfill reads from 0)', async (t) => {
  const dir = tmpdir(t);
  const { src, lines, cfg } = mkSource(t, dir, { backfill: true });
  fs.writeFileSync(cfg.path, 'L1\nL2\n');
  src.start();
  await waitFor(() => lines.length >= 2, 'initial backfill');
  fs.appendFileSync(cfg.path, 'L3\n');
  fs.appendFileSync(cfg.path, 'L4\r\n'); // CRLF stripped too
  await waitFor(() => lines.length >= 4, 'appended lines');
  assert.deepStrictEqual(lines, ['L1', 'L2', 'L3', 'L4']);

  const s = src.status();
  assert.strictEqual(s.mode, 'local');
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.error, null);
  assert.strictEqual(s.lagBytes, 0);
  assert.strictEqual(typeof s.lastReadAt, 'number');
});

test('local: default (no backfill, no persisted offset) starts at current END', async (t) => {
  const dir = tmpdir(t);
  const { src, lines, cfg } = mkSource(t, dir);
  fs.writeFileSync(cfg.path, 'old1\nold2\n');
  src.start();
  await waitFor(() => src.status().ok, 'first poll');
  assert.deepStrictEqual(lines, [], 'pre-existing lines are skipped');
  fs.appendFileSync(cfg.path, 'new1\n');
  await waitFor(() => lines.length >= 1, 'line appended after start');
  assert.deepStrictEqual(lines, ['new1']);
});

test('local: partial line is held in the carry until its newline arrives', async (t) => {
  const dir = tmpdir(t);
  const { src, lines, cfg } = mkSource(t, dir, { backfill: true });
  fs.writeFileSync(cfg.path, '');
  src.start();
  await waitFor(() => src.status().ok, 'first poll');

  fs.appendFileSync(cfg.path, 'abc'); // no newline yet
  await waitFor(() => src.status().lagBytes === 0 && src.status().ok, 'partial consumed');
  await delay(50); // a few more polls: still nothing to emit
  assert.deepStrictEqual(lines, [], 'no emit before the newline');

  fs.appendFileSync(cfg.path, 'def\n');
  await waitFor(() => lines.length >= 1, 'completed line');
  assert.deepStrictEqual(lines, ['abcdef'], 'carry + completion emitted as one line');
});

test('local: rotation to a smaller file resets the offset to 0', async (t) => {
  const dir = tmpdir(t);
  const { src, lines, cfg } = mkSource(t, dir, { backfill: true });
  fs.writeFileSync(cfg.path, 'first-line-one\nfirst-line-two\n');
  src.start();
  await waitFor(() => lines.length >= 2, 'original file');

  fs.writeFileSync(cfg.path, 'r1\nr2\n'); // strictly smaller -> rotation
  await waitFor(() => lines.length >= 4, 'rotated file re-read from 0');
  assert.deepStrictEqual(lines, ['first-line-one', 'first-line-two', 'r1', 'r2']);
});

test('local: offset persists to data/logsource.json and a second instance resumes', async (t) => {
  const dir = tmpdir(t);
  const first = mkSource(t, dir, { backfill: true });
  fs.writeFileSync(first.cfg.path, 'L1\nL2\n');
  first.src.start();
  await waitFor(() => first.lines.length >= 2, 'first instance lines');
  first.src.stop();

  const stateFile = path.join(dir, 'data', 'logsource.json');
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(persisted.path, first.cfg.path);
  assert.strictEqual(persisted.offset, Buffer.byteLength('L1\nL2\n'), 'offset covers exactly the emitted lines');

  fs.appendFileSync(first.cfg.path, 'L3\n');

  // backfill:false — the persisted offset (not END, not 0) must win.
  const second = mkSource(t, dir);
  second.src.start();
  await waitFor(() => second.lines.length >= 1, 'resumed line');
  await delay(50);
  assert.deepStrictEqual(second.lines, ['L3'], 'only the unseen line is emitted — never re-emits processed lines');
  second.src.stop();
  const persisted2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.strictEqual(persisted2.offset, Buffer.byteLength('L1\nL2\nL3\n'));
});

test('local: persisted partial line is not counted into the offset', async (t) => {
  const dir = tmpdir(t);
  const first = mkSource(t, dir, { backfill: true });
  fs.writeFileSync(first.cfg.path, 'done\npart');
  first.src.start();
  await waitFor(() => first.lines.length >= 1 && first.src.status().lagBytes === 0, 'first instance');
  first.src.stop();
  assert.deepStrictEqual(first.lines, ['done']);

  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'data', 'logsource.json'), 'utf8'));
  assert.strictEqual(persisted.offset, Buffer.byteLength('done\n'), 'offset stops at the last full line');

  fs.appendFileSync(first.cfg.path, 'ial\n');
  const second = mkSource(t, dir);
  second.src.start();
  await waitFor(() => second.lines.length >= 1, 'completed partial after resume');
  assert.deepStrictEqual(second.lines, ['partial'], 'resume re-reads the fragment so the full line is emitted once');
});

test('local: carry over 64KiB is discarded and tailing resyncs at the next newline (§19.3.24)', async (t) => {
  const dir = tmpdir(t);
  const { src, lines, cfg } = mkSource(t, dir, { backfill: true });
  fs.writeFileSync(cfg.path, '');
  src.start();
  await waitFor(() => src.status().ok, 'first poll');

  fs.appendFileSync(cfg.path, 'a'.repeat(70000)); // > 64KiB, no newline
  await waitFor(() => src.status().lagBytes === 0, 'oversized fragment consumed');
  assert.deepStrictEqual(lines, [], 'nothing emitted for the oversized fragment');

  // "tailpiece\n" terminates the discarded line (dropped by resync); AFTER is clean.
  fs.appendFileSync(cfg.path, 'tailpiece\nAFTER\n');
  await waitFor(() => lines.length >= 1, 'post-resync line');
  await delay(50);
  assert.deepStrictEqual(lines, ['AFTER'], 'fragment and its terminator dropped; next full line emitted');
});

test('local: missing file reports an error status, then recovers when it appears', async (t) => {
  const dir = tmpdir(t);
  const { src, lines, cfg } = mkSource(t, dir); // file does not exist yet
  src.start();
  await waitFor(() => src.status().ok === false && !!src.status().error, 'error status');

  fs.writeFileSync(cfg.path, 'pre\n'); // appears later: default start is its END
  await waitFor(() => src.status().ok, 'recovered');
  fs.appendFileSync(cfg.path, 'after\n');
  await waitFor(() => lines.length >= 1, 'line after recovery');
  assert.deepStrictEqual(lines, ['after']);
});

// --------------------------------------------------- ftp/sftp lazy requires

test('ftp: missing optional basic-ftp throws a friendly install hint', (t) => {
  if (moduleResolves('basic-ftp')) return t.skip('basic-ftp happens to be installed here');
  const dir = tmpdir(t);
  const src = createLogSource(
    { mode: 'ftp', pollMs: 50, ftp: { host: 'example.invalid', port: 21, user: 'u', password: 'p', path: '/x.log', secure: false } },
    { dataDir: path.join(dir, 'data') }
  );
  assert.throws(() => src.start(), /npm install basic-ftp/);
});

test('sftp: missing optional ssh2-sftp-client throws a friendly install hint', (t) => {
  if (moduleResolves('ssh2-sftp-client')) return t.skip('ssh2-sftp-client happens to be installed here');
  const dir = tmpdir(t);
  const src = createLogSource(
    { mode: 'sftp', pollMs: 50, sftp: { host: 'example.invalid', port: 22, user: 'u', password: 'p', privateKeyPath: '', path: '/x.log' } },
    { dataDir: path.join(dir, 'data') }
  );
  assert.throws(() => src.start(), /npm install ssh2-sftp-client/);
});

test('unknown log.mode is rejected up front', (t) => {
  const dir = tmpdir(t);
  assert.throws(
    () => createLogSource({ mode: 'carrier-pigeon' }, { dataDir: path.join(dir, 'data') }),
    /unknown log\.mode/
  );
});
