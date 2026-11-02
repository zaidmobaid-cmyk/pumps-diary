'use strict';
// Tests for server/rcon.js (SPEC §4 / §17). A MINIMAL fake Squad RCON TCP server
// lives inline in this file on purpose — it does NOT use test/mock-squad.js.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { SquadRcon } = require('../server/rcon');

const SD_RESPONSE = 0;
const SD_CHAT = 1;
const SD_EXEC_OR_AUTHRESP = 2;
const SD_AUTH = 3;

const PASSWORD = 'hunter2';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Plain once-listener with a timeout. Deliberately NOT events.once(): that helper
// rejects pending waits whenever an 'error' event fires, which the bad-password
// test triggers on purpose.
function awaitEvent(emitter, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error(`timeout after ${ms}ms waiting for '${event}'`));
    }, ms);
    function onEvent(arg) {
      clearTimeout(timer);
      resolve(arg);
    }
    emitter.once(event, onEvent);
  });
}

function enc(id, type, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  const out = Buffer.alloc(4 + 10 + b.length);
  out.writeInt32LE(10 + b.length, 0);
  out.writeInt32LE(id, 4);
  out.writeInt32LE(type, 8);
  b.copy(out, 12);
  return out;
}

// Minimal fake Squad RCON server: auth (id -1 on bad password, after the standard empty
// RESPONSE_VALUE echo), echo/mapped exec responses split into 4096-byte packets, the
// empty-exec sentinel answered with an empty response, type-1 chat pushes, optional
// N-byte chunked writes, optional silence (never answer execs) for the timeout test.
class FakeSquadRcon {
  constructor({ password = PASSWORD, chunkBytes = 0 } = {}) {
    this.password = password;
    this.chunkBytes = chunkBytes;
    this.silent = false;
    this.handlers = new Map(); // command -> response string (default: `echo:<command>`)
    this.sockets = new Set();
    this.connections = 0;
    this.received = []; // every decoded request {id, type, body}
    this.server = net.createServer((sock) => this._accept(sock));
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => resolve(this.server.address().port));
    });
  }

  _accept(sock) {
    this.connections += 1;
    this.sockets.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => this.sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (buf.length < size + 4) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString('utf8', 12, size + 2);
        buf = buf.subarray(size + 4);
        this.received.push({ id, type, body });
        this._handle(sock, id, type, body);
      }
    });
  }

  _handle(sock, id, type, body) {
    if (type === SD_AUTH) {
      this._send(sock, enc(id, SD_RESPONSE, '')); // standard pre-auth echo
      this._send(sock, enc(body === this.password ? id : -1, SD_EXEC_OR_AUTHRESP, ''));
      return;
    }
    if (type !== SD_EXEC_OR_AUTHRESP || this.silent) return;
    if (body === '') {
      // The client's sentinel: answer with an empty response carrying the sentinel id.
      this._send(sock, enc(id, SD_RESPONSE, ''));
      return;
    }
    const resp = this.handlers.has(body) ? this.handlers.get(body) : `echo:${body}`;
    const rb = Buffer.from(String(resp), 'utf8');
    if (rb.length === 0) {
      this._send(sock, enc(id, SD_RESPONSE, ''));
      return;
    }
    for (let off = 0; off < rb.length; off += 4096) {
      this._send(sock, enc(id, SD_RESPONSE, rb.subarray(off, off + 4096)));
    }
  }

  _send(sock, packet) {
    if (sock.destroyed) return;
    if (this.chunkBytes > 0) {
      for (let i = 0; i < packet.length; i += this.chunkBytes) {
        sock.write(packet.subarray(i, i + this.chunkBytes));
      }
    } else {
      sock.write(packet);
    }
  }

  chat(body) {
    for (const sock of this.sockets) this._send(sock, enc(0, SD_CHAT, body));
  }

  destroySockets() {
    for (const sock of this.sockets) sock.destroy();
  }

  close() {
    this.destroySockets();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

// Boots a fake server + client; registers teardown so sockets/timers never outlive a test.
async function setup(t, { clientOpts = {}, serverOpts = {} } = {}) {
  const srv = new FakeSquadRcon(serverOpts);
  const port = await srv.listen();
  const rcon = new SquadRcon({
    host: '127.0.0.1',
    port,
    password: serverOpts.password || PASSWORD,
    ...clientOpts,
  });
  t.after(async () => {
    rcon.close();
    await srv.close();
  });
  return { srv, rcon };
}

async function connectAuthed(rcon) {
  const connected = awaitEvent(rcon, 'connected');
  rcon.connect();
  await connected;
}

test('auth ok: connects, auths, emits connected, status reflects it', async (t) => {
  const { rcon } = await setup(t);
  await connectAuthed(rcon);
  assert.strictEqual(rcon.status.connected, true);
  assert.strictEqual(rcon.status.authed, true);
  assert.strictEqual(rcon.status.lastError, null);
  assert.strictEqual(typeof rcon.status.since, 'number');
});

test('auth rejected (id -1): emits error with clear message, stops retrying', async (t) => {
  const { srv, rcon } = await setup(t, { clientOpts: { password: 'WRONG' } });
  const errP = awaitEvent(rcon, 'error');
  const discP = awaitEvent(rcon, 'disconnected');
  rcon.connect();
  const err = await errP;
  assert.match(err.message, /password/i);
  await discP;
  assert.strictEqual(rcon.status.authed, false);
  assert.match(String(rcon.status.lastError), /password/i);
  // Bad creds will not fix themselves: no reconnect even after the 1s backoff window.
  assert.strictEqual(srv.connections, 1);
  await sleep(1300);
  assert.strictEqual(srv.connections, 1);
});

test('exec rejects immediately when not connected', async (t) => {
  const { rcon } = await setup(t);
  await assert.rejects(() => rcon.exec('ListPlayers'), /not connected/i);
});

test('simple exec round-trip (and serialized queue)', async (t) => {
  const { srv, rcon } = await setup(t);
  srv.handlers.set('ShowCurrentMap', 'Current level is Yehorivka, layer is Yehorivka RAAS v1');
  await connectAuthed(rcon);
  const out = await rcon.exec('ShowCurrentMap');
  assert.strictEqual(out, 'Current level is Yehorivka, layer is Yehorivka RAAS v1');
  // Two queued commands stay serialized (one in flight) and both resolve correctly.
  const [a, b] = await Promise.all([rcon.exec('CmdA'), rcon.exec('CmdB')]);
  assert.strictEqual(a, 'echo:CmdA');
  assert.strictEqual(b, 'echo:CmdB');
  // The wire saw: auth, CmdA, sentinel, CmdB, sentinel — command before its sentinel.
  const execs = srv.received.filter((p) => p.type === SD_EXEC_OR_AUTHRESP);
  const idxA = execs.findIndex((p) => p.body === 'CmdA');
  assert.ok(idxA >= 0 && execs[idxA + 1].body === '', 'sentinel follows the command');
});

test('multi-packet response >4096 bytes reassembles via the sentinel', async (t) => {
  const { srv, rcon } = await setup(t);
  // ~9.1KB body; the euro sign sits exactly on the 4096-byte boundary so its UTF-8
  // bytes are split across two packets — must survive reassembly.
  const big = 'a'.repeat(4095) + '€' + 'b'.repeat(5000);
  assert.ok(Buffer.byteLength(big, 'utf8') > 4096 * 2);
  srv.handlers.set('ListLayers', big);
  await connectAuthed(rcon);
  const out = await rcon.exec('ListLayers');
  assert.strictEqual(out.length, big.length);
  assert.strictEqual(out, big);
});

test('response delivered in 7-byte socket chunks still parses', async (t) => {
  const { srv, rcon } = await setup(t, { serverOpts: { chunkBytes: 7 } });
  const info = '{"ServerName_s":"Fragment§Server — ok"}';
  srv.handlers.set('ShowServerInfo', info);
  await connectAuthed(rcon); // the auth response itself arrived in 7-byte chunks
  const out = await rcon.exec('ShowServerInfo');
  assert.strictEqual(out, info);
});

test('type-1 packets emit chat-packet with the raw utf8 body', async (t) => {
  const { srv, rcon } = await setup(t);
  await connectAuthed(rcon);
  const body =
    '[ChatAll] [Online IDs:EOS: 0002a10386d9114496bce8b6ded68587 steam: 76561198012345678] Жук™ : héllo <world>';
  const chatP = awaitEvent(rcon, 'chat-packet');
  srv.chat(body);
  assert.strictEqual(await chatP, body);
});

test('exec timeout rejects, drops the connection, then reconnects', async (t) => {
  const { srv, rcon } = await setup(t);
  await connectAuthed(rcon);
  srv.silent = true; // server swallows execs -> client must time out
  const disconnected = awaitEvent(rcon, 'disconnected');
  const reconnected = awaitEvent(rcon, 'connected', 8000);
  await assert.rejects(() => rcon.exec('ListPlayers', 300), /timeout/i);
  await disconnected;
  assert.strictEqual(rcon.status.authed, false);
  srv.silent = false;
  await reconnected; // ~1s backoff, fresh auth
  assert.strictEqual(srv.connections, 2);
  const out = await rcon.exec('AfterTimeout');
  assert.strictEqual(out, 'echo:AfterTimeout');
});

test('reconnects after a server-side socket destroy', async (t) => {
  const { srv, rcon } = await setup(t);
  await connectAuthed(rcon);
  const disconnected = awaitEvent(rcon, 'disconnected');
  const reconnected = awaitEvent(rcon, 'connected', 8000);
  srv.destroySockets();
  await disconnected;
  await reconnected;
  assert.strictEqual(srv.connections, 2);
  assert.strictEqual(rcon.status.authed, true);
  const out = await rcon.exec('AfterReconnect');
  assert.strictEqual(out, 'echo:AfterReconnect');
});
