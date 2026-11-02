'use strict';
// SquadWatch — Source RCON client with Squad quirks (docs/SPEC.md §4).
// Zero npm dependencies: node:net + node:events only.
//
// Wire format (§4.1): [int32LE size][int32LE id][int32LE type][body utf8][0x00][0x00]
// where size = 10 + bodyByteLen (id + type + body + two null terminators).

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { log, sanitizeRconArg } = require('./util');

// Packet types.
const SERVERDATA_RESPONSE_VALUE = 0; // server -> client: command output
const SERVERDATA_CHAT_VALUE = 1;     // server -> client: Squad-specific unsolicited chat/event stream
const SERVERDATA_EXECCOMMAND = 2;    // client -> server
const SERVERDATA_AUTH_RESPONSE = 2;  // server -> client (same numeric value as EXECCOMMAND)
const SERVERDATA_AUTH = 3;           // client -> server

const AUTH_ID = 1;              // fixed id for the auth request (commands use odd ids >= 3)
const MIN_SIZE = 10;            // empty-body packet: id(4) + type(4) + 2 nulls
const MAX_SIZE = 65536;         // anything outside [MIN_SIZE, MAX_SIZE] is a protocol desync

// Real Squad servers answer an empty EXECCOMMAND (our multi-packet sentinel)
// with TWO empty responses and then these seven raw bytes WITHOUT a packet
// header (captured live 2026-11-02; same quirk SquadJS works around). Read
// naively they become a garbage size field and desync the whole stream.
const SQUAD_BROKEN_TRAILER = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00]);
const BACKOFF_MIN_MS = 1000;    // reconnect backoff 1s, 2s, 4s, ... capped at 30s
const BACKOFF_MAX_MS = 30000;
const DIAL_TIMEOUT_MS = 15000;  // connect + auth must complete within this, else retry
const MAX_CMD_CHARS = 2000;     // whole-command cap (individual args are capped at 480 by admin.js)
const EMPTY = Buffer.alloc(0);

function encodePacket(id, type, body) {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
  const size = MIN_SIZE + b.length;
  const out = Buffer.alloc(4 + size); // zero-filled, so the two trailing nulls come free
  out.writeInt32LE(size, 0);
  out.writeInt32LE(id | 0, 4);
  out.writeInt32LE(type | 0, 8);
  b.copy(out, 12);
  return out;
}

class SquadRcon extends EventEmitter {
  // keepaliveMs is overridable for tests only; the spec value is 45s.
  constructor({ host, port, password, keepaliveMs = 45000 } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.password = String(password == null ? '' : password);
    this.keepaliveMs = keepaliveMs;

    this._socket = null;
    this._buf = EMPTY;        // receive accumulator (fragmentation/coalescing tolerant)
    this._connected = false;  // TCP level
    this._authed = false;
    this._lastError = null;
    this._since = null;       // epoch ms of the last connected/disconnected transition
    this._stopped = true;     // no reconnect loop while true (pre-connect(), after close(), after bad password)

    this._queue = [];         // FIFO of pending {command, timeoutMs, resolve, reject}
    this._inflight = null;    // the ONE command in flight: {id, sentinelId, chunks, timer, resolve, reject}
    this._nextId = 3;         // odd ids for commands; sentinel is cmdId+1 (even); 1 is reserved for auth

    this._backoffMs = BACKOFF_MIN_MS;
    this._reconnectTimer = null;
    this._keepaliveTimer = null;
    this._dialTimer = null;
  }

  get status() {
    return {
      connected: this._connected,
      authed: this._authed,
      lastError: this._lastError,
      since: this._since,
    };
  }

  // Start (or restart after close()/bad password) the persistent connect loop.
  connect() {
    this._stopped = false;
    if (this._socket) return; // already connecting/connected
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._backoffMs = BACKOFF_MIN_MS;
    this._dial();
  }

  // Deliberate shutdown (graceful exit / tests): stops the loop, clears every timer,
  // destroys the socket and rejects pending execs. No 'disconnected' event is emitted.
  close() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._stopKeepalive();
    this._clearDialTimer();
    const sock = this._socket;
    this._socket = null; // detach first so this socket's close handler is a no-op
    if (sock) sock.destroy();
    if (this._connected || this._authed) this._since = Date.now();
    this._connected = false;
    this._authed = false;
    this._buf = EMPTY;
    this._failAll(new Error('RCON closed'));
  }

  // Execute a command; resolves with the full (multi-packet reassembled) response body.
  exec(command, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      if (!this._authed) {
        reject(new Error('RCON not connected'));
        return;
      }
      // Strip \r\n\0 so nothing can smuggle extra protocol lines; generous whole-command cap.
      const cmd = sanitizeRconArg(command, MAX_CMD_CHARS);
      this._queue.push({ command: cmd, timeoutMs, resolve, reject });
      this._pump();
    });
  }

  // ---- internals ----------------------------------------------------------

  _dial() {
    if (this._stopped || this._socket) return;
    this._buf = EMPTY;
    const sock = net.connect({ host: this.host, port: this.port });
    this._socket = sock;
    sock.setNoDelay(true);
    this._armDialTimer();
    sock.on('connect', () => {
      if (sock !== this._socket) return;
      this._connected = true;
      this._write(encodePacket(AUTH_ID, SERVERDATA_AUTH, this.password));
    });
    sock.on('data', (chunk) => {
      if (sock === this._socket) this._onData(chunk);
    });
    sock.on('error', (err) => {
      if (sock !== this._socket) return;
      this._lastError = err && err.message ? err.message : String(err);
      // 'close' always follows an error; reconnect is handled there.
    });
    sock.on('close', () => {
      if (sock === this._socket) this._onClose();
    });
  }

  _onClose() {
    this._socket = null;
    this._connected = false;
    this._authed = false;
    this._buf = EMPTY;
    this._since = Date.now();
    this._stopKeepalive();
    this._clearDialTimer();
    this._failAll(new Error('RCON disconnected'));
    this.emit('disconnected', { lastError: this._lastError });
    if (!this._stopped) this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || this._stopped || this._socket) return;
    const delay = this._backoffMs;
    this._backoffMs = Math.min(this._backoffMs * 2, BACKOFF_MAX_MS);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._dial();
    }, delay);
  }

  _onData(chunk) {
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk]);
    // Drain every complete packet currently buffered; tolerate fragmentation & coalescing.
    while (this._socket && !this._socket.destroyed && this._buf.length >= 1) {
      // Squad's headerless 7-byte trailer can sit at any packet boundary —
      // swallow it before trying to read a header there. A legitimate header
      // can never match all seven bytes: that would need size 256 with an id
      // divisible by 2^24, and our ids are capped far below that.
      if (this._buf[0] === 0x00) {
        const n = Math.min(this._buf.length, SQUAD_BROKEN_TRAILER.length);
        if (this._buf.subarray(0, n).equals(SQUAD_BROKEN_TRAILER.subarray(0, n))) {
          if (this._buf.length < SQUAD_BROKEN_TRAILER.length) return; // trailer still arriving
          this._buf = this._buf.length === SQUAD_BROKEN_TRAILER.length
            ? EMPTY : this._buf.subarray(SQUAD_BROKEN_TRAILER.length);
          continue;
        }
      }
      if (this._buf.length < 4) return;
      const size = this._buf.readInt32LE(0);
      if (size < MIN_SIZE || size > MAX_SIZE) {
        this._desync(`bad packet size ${size}`);
        return;
      }
      if (this._buf.length < size + 4) return; // wait for the rest of this packet
      const id = this._buf.readInt32LE(4);
      const type = this._buf.readInt32LE(8);
      // body = bytes 12..size+2 (the 2 trailing nulls stripped); copy so multi-packet
      // accumulation does not pin large receive buffers.
      const body = Buffer.from(this._buf.subarray(12, size + 2));
      this._buf = this._buf.length === size + 4 ? EMPTY : this._buf.subarray(size + 4);
      this._onPacket(id, type, body);
    }
  }

  _onPacket(id, type, body) {
    this._touchKeepalive();

    if (!this._authed) {
      if (id === -1) {
        // Bad password. Credentials won't fix themselves: stop retrying until connect()
        // is called again.
        this._stopped = true;
        this._lastError = 'auth failed: bad RCON password';
        const err = new Error(`RCON auth failed: bad password for ${this.host}:${this.port}`);
        if (this.listenerCount('error') > 0) this.emit('error', err);
        else log.error('rcon', err.message);
        this._destroySocket();
        return;
      }
      if (type === SERVERDATA_AUTH_RESPONSE && id === AUTH_ID) {
        this._authed = true;
        this._since = Date.now();
        this._lastError = null;
        this._backoffMs = BACKOFF_MIN_MS;
        this._clearDialTimer();
        this._touchKeepalive();
        this.emit('connected');
        this._pump();
      }
      // Anything else pre-auth (e.g. the standard empty RESPONSE_VALUE echo) is ignored.
      return;
    }

    if (type === SERVERDATA_CHAT_VALUE) {
      // Unsolicited Squad chat/event stream packet; parser.js owns the meaning.
      this.emit('chat-packet', body.toString('utf8'));
      return;
    }

    if (type === SERVERDATA_RESPONSE_VALUE) {
      const inf = this._inflight;
      if (inf && id === inf.id) {
        inf.chunks.push(body);
        return;
      }
      if (inf && id === inf.sentinelId) {
        // The server answers in order, so the (empty) sentinel response means the real
        // response is complete. Decode once after reassembly so a UTF-8 character split
        // across packet boundaries survives.
        clearTimeout(inf.timer);
        this._inflight = null;
        inf.resolve(Buffer.concat(inf.chunks).toString('utf8'));
        this._pump();
        return;
      }
      // Stray response (e.g. a late packet from before a resync) — ignore.
      return;
    }
    // Any other packet type post-auth is ignored (empty size-10 follow packets are normal).
  }

  _pump() {
    if (this._inflight || !this._authed || this._queue.length === 0) return;
    const job = this._queue.shift();
    const id = this._nextId;
    this._nextId += 2;
    // Cap below 2^24 so no id is ever divisible by 2^24 — that keeps a real
    // header from ever matching the Squad broken-trailer byte pattern.
    if (this._nextId > 0xfffff0) this._nextId = 3; // keep ids odd
    const inf = {
      id,
      sentinelId: id + 1,
      chunks: [],
      resolve: job.resolve,
      reject: job.reject,
      timer: setTimeout(() => this._onExecTimeout(inf, job), job.timeoutMs),
    };
    this._inflight = inf;
    this._write(encodePacket(id, SERVERDATA_EXECCOMMAND, job.command));
    // Empty-exec sentinel trick for multi-packet responses (§4.2).
    this._write(encodePacket(inf.sentinelId, SERVERDATA_EXECCOMMAND, EMPTY));
  }

  _onExecTimeout(inf, job) {
    if (this._inflight !== inf) return;
    this._inflight = null;
    this._lastError = `exec timeout (${job.timeoutMs}ms): ${job.command.slice(0, 80)}`;
    log.warn('rcon', this._lastError);
    inf.reject(new Error(`RCON exec timeout after ${job.timeoutMs}ms: ${job.command.slice(0, 80)}`));
    // Packet/id alignment can no longer be trusted: drop the connection to resync;
    // the close handler reconnects with backoff.
    this._destroySocket();
  }

  _failAll(err) {
    const inf = this._inflight;
    this._inflight = null;
    if (inf) {
      clearTimeout(inf.timer);
      inf.reject(err);
    }
    if (this._queue.length) {
      const q = this._queue;
      this._queue = [];
      for (const job of q) job.reject(err);
    }
  }

  // Keepalive: if no packet has been received for keepaliveMs (45s), issue a harmless
  // ShowCurrentMap. If the server is gone, the exec timeout path drops and reconnects.
  _touchKeepalive() {
    if (!this._authed) return;
    if (this._keepaliveTimer) clearTimeout(this._keepaliveTimer);
    this._keepaliveTimer = setTimeout(() => {
      this._keepaliveTimer = null;
      if (!this._authed) return;
      this.exec('ShowCurrentMap').catch(() => {});
    }, this.keepaliveMs);
  }

  _stopKeepalive() {
    if (this._keepaliveTimer) {
      clearTimeout(this._keepaliveTimer);
      this._keepaliveTimer = null;
    }
  }

  _armDialTimer() {
    this._clearDialTimer();
    this._dialTimer = setTimeout(() => {
      this._dialTimer = null;
      if (!this._authed && this._socket) {
        this._lastError = 'connect/auth timeout';
        this._destroySocket();
      }
    }, DIAL_TIMEOUT_MS);
  }

  _clearDialTimer() {
    if (this._dialTimer) {
      clearTimeout(this._dialTimer);
      this._dialTimer = null;
    }
  }

  _desync(reason) {
    this._lastError = `protocol desync: ${reason}`;
    log.warn('rcon', this._lastError);
    this._destroySocket();
  }

  _destroySocket() {
    const sock = this._socket;
    if (sock && !sock.destroyed) sock.destroy();
  }

  _write(buf) {
    const sock = this._socket;
    if (!sock || sock.destroyed) return false;
    try {
      return sock.write(buf);
    } catch (err) {
      this._lastError = err && err.message ? err.message : String(err);
      this._destroySocket();
      return false;
    }
  }
}

// Support both `require('./rcon')` -> class and `require('./rcon').SquadRcon`.
module.exports = SquadRcon;
module.exports.SquadRcon = SquadRcon;
