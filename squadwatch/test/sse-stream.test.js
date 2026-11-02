'use strict';
// The live stream survives large frames. write() returning false only means
// one frame passed the socket's 16 KB mark — a full server's players snapshot
// alone does — so a client that keeps reading is never dropped for it; only a
// stalled client (over 1 MB unsent) is.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const LiveState = require('../server/state');

test('a reading client keeps its stream through frames far over 16 KB', async (t) => {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = {};
  const auth = createAuth({ db, config: cfg });
  const rcon = { status: { connected: true, authed: true }, async exec(cmd) { return `Executed: ${cmd}`; } };
  const state = new LiveState();
  const bus = new EventEmitter();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg, bus });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const u = auth.createUser('watcher', 'password-123', 'admin');
  const cookie = `sw_session=${auth.createSession(u.id, {}).token}`;

  const ac = new AbortController();
  t.after(() => ac.abort());
  const res = await fetch(base + '/api/stream', { headers: { origin: base, cookie }, signal: ac.signal });
  assert.strictEqual(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ended = false;
  const chats = [];
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { ended = true; return; }
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event: chat$/m.test(frame)) chats.push(JSON.parse(/^data: (.*)$/m.exec(frame)[1]));
        }
      }
    } catch (_e) { /* aborted */ }
  })();
  const waitFor = async (pred, what) => {
    for (let k = 0; k < 200; k++) { if (pred()) return; await new Promise((r) => setTimeout(r, 20)); }
    throw new Error(`timed out waiting for ${what}`);
  };

  const big = 'x'.repeat(60 * 1024);
  for (let n = 0; n < 5; n++) bus.emit('chat', { channel: 'all', message: big, n });
  bus.emit('chat', { channel: 'all', message: 'small after the big ones', n: 5 });
  await waitFor(() => chats.length === 6, 'all six chat frames');
  assert.deepStrictEqual(chats.map((c) => c.n), [0, 1, 2, 3, 4, 5], 'every frame arrives, in order');
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(ended, false, 'the stream is still open');
});
