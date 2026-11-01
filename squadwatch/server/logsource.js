'use strict';
// Log source (SPEC §5 + §19.3.24): tails SquadGame.log via local fs polling,
// FTP or SFTP, emitting 'line' (string, no newline, in file order) and
// 'status'. Offsets persist to <dataDir>/logsource.json so restarts never
// re-emit lines already processed — the persisted offset only ever covers
// fully emitted lines (the partial-line carry is excluded and re-read).
//
// ftp/sftp modes lazy-require their optional clients; when the package is not
// installed, start() throws a friendly error naming the exact install command.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { log } = require('./util');

const CARRY_MAX = 64 * 1024; // §19.3.24: cap on the partial-line carry buffer
const PERSIST_EVERY_MS = 5000; // persist offsets at most every 5s
const READ_CHUNK = 64 * 1024;
const NL = 0x0a;
const CR = 0x0d;

function lazyRequire(name) {
  try {
    return require(name);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`'${name}'`)) {
      throw new Error(
        `log.mode needs the optional package "${name}", which is not installed. Install it with: npm install ${name}`
      );
    }
    throw e;
  }
}

class LogSource extends EventEmitter {
  constructor(cfg, opts) {
    super();
    this.cfg = Object.assign({ mode: 'local', pollMs: 1500, backfill: false }, cfg || {});
    this.mode = this.cfg.mode || 'local';
    if (this.mode !== 'local' && this.mode !== 'ftp' && this.mode !== 'sftp') {
      throw new Error(`logsource: unknown log.mode "${this.mode}" (expected "local", "ftp" or "sftp")`);
    }
    this.dataDir = (opts && opts.dataDir) || 'data';
    this.stateFile = path.join(this.dataDir, 'logsource.json');

    this.pos = 0; // next byte to fetch from the source
    this.carry = Buffer.alloc(0); // partial line already fetched, not yet emitted
    this.resync = false; // dropping bytes until the next newline (carry overflow)
    this.size = 0; // last observed source size
    this.lastReadAt = null;
    this.error = null;
    this.ok = false;
    this.lastStatusKey = null;

    this.started = false;
    this.stopped = false;
    this.timer = null;
    this.polling = false;
    this.lastPersist = 0;
    this.backoffErrors = 0;

    this.client = null; // ftp/sftp client, created lazily per connection
    this.ftpLib = null;
    this.SftpClient = null;
    // undefined = start decision already made; otherwise the persisted record
    // (or null) still waiting for the first size observation.
    this.pendingResume = undefined;
  }

  // ------------------------------------------------------------- lifecycle

  start() {
    if (this.started) return this;
    // Lazy optional dependencies (§0): only when the mode actually needs them.
    if (this.mode === 'ftp') this.ftpLib = lazyRequire('basic-ftp');
    if (this.mode === 'sftp') this.SftpClient = lazyRequire('ssh2-sftp-client');

    let persisted = null;
    try {
      persisted = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch (_e) {
      persisted = null; // first run, unreadable or corrupt -> fresh decision
    }
    this.pendingResume = persisted;

    this.started = true;
    this.stopped = false;
    this.schedule(0);
    return this;
  }

  stop() {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.persist(true);
    this.teardownClient();
  }

  status() {
    return {
      mode: this.mode,
      ok: this.ok,
      lagBytes: Math.max(0, this.size - this.pos),
      lastReadAt: this.lastReadAt,
      error: this.error,
    };
  }

  // ------------------------------------------------------------- scheduling

  schedule(delay) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tick();
    }, delay);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  nextDelay() {
    const pollMs = Math.max(10, Number(this.cfg.pollMs) || 1500);
    const base = this.mode === 'local' ? pollMs : Math.max(pollMs, 4000);
    if (this.mode !== 'local' && this.backoffErrors > 0) {
      return Math.min(base * Math.pow(2, Math.min(this.backoffErrors, 4)), 30000);
    }
    return base;
  }

  async tick() {
    if (this.stopped || this.polling) return;
    this.polling = true;
    try {
      if (this.mode === 'local') await this.pollLocal();
      else if (this.mode === 'ftp') await this.pollFtp();
      else await this.pollSftp();
      this.setOk();
    } catch (e) {
      this.fail(e);
      if (this.mode !== 'local') await this.teardownClient();
    } finally {
      this.polling = false;
      if (!this.stopped) this.schedule(this.nextDelay());
    }
  }

  // ------------------------------------------------------------- shared tail

  sourcePath() {
    if (this.mode === 'ftp') return (this.cfg.ftp && this.cfg.ftp.path) || '';
    if (this.mode === 'sftp') return (this.cfg.sftp && this.cfg.sftp.path) || '';
    return this.cfg.path || '';
  }

  // First size observation decides where tailing starts (§5 boot rule):
  // persisted path matches and file still at least that long -> resume;
  // else backfill -> 0; else current END.
  resolveStart(size) {
    const persisted = this.pendingResume;
    this.pendingResume = undefined;
    const srcPath = this.sourcePath();
    if (
      persisted && persisted.path === srcPath
      && Number.isFinite(persisted.offset) && persisted.offset >= 0 && size >= persisted.offset
    ) {
      this.pos = persisted.offset;
      log.info('logsource', `resuming ${this.mode} tail of ${srcPath} at offset ${this.pos}/${size}`);
    } else if (this.cfg.backfill) {
      this.pos = 0;
    } else {
      this.pos = size;
    }
  }

  // size < consumed bytes -> the file was rotated or truncated: start over.
  checkRotation(size) {
    if (size < this.pos) {
      log.info('logsource', `rotation/truncation detected (size ${size} < offset ${this.pos}) — restarting at 0`);
      this.pos = 0;
      this.carry = Buffer.alloc(0);
      this.resync = false;
    }
  }

  emitLine(line) {
    try {
      this.emit('line', line);
    } catch (e) {
      log.error('logsource', `line listener threw: ${e.message}`);
    }
  }

  // Split a fetched chunk into lines, honoring the carry buffer, CRLF, the
  // §19.3.24 64KiB carry cap (overflow -> discard fragment, resync at the
  // next newline) and resync mode.
  ingestChunk(buf) {
    let data = this.carry.length ? Buffer.concat([this.carry, buf]) : buf;
    this.carry = Buffer.alloc(0);

    if (this.resync) {
      const nl = data.indexOf(NL);
      if (nl === -1) return; // still inside the oversized fragment: keep dropping
      data = data.subarray(nl + 1);
      this.resync = false;
    }

    let start = 0;
    for (;;) {
      const nl = data.indexOf(NL, start);
      if (nl === -1) break;
      let end = nl;
      if (end > start && data[end - 1] === CR) end--;
      if (end - start > CARRY_MAX) {
        // A line this long would have overflowed the carry under any other
        // chunking — drop it uniformly (counts as unparsed).
        log.warn('logsource', `dropping ${end - start}-byte line (over the ${CARRY_MAX}-byte carry cap)`);
      } else {
        this.emitLine(data.toString('utf8', start, end));
      }
      start = nl + 1;
    }

    const rest = data.subarray(start);
    if (rest.length > CARRY_MAX) {
      log.warn('logsource', `carry buffer exceeded ${CARRY_MAX} bytes with no newline — discarding fragment (counts as unparsed) and resyncing at the next newline`);
      this.resync = true;
    } else if (rest.length) {
      this.carry = Buffer.from(rest); // copy: do not pin the big concat buffer
    }
  }

  // Persist {offset, size, path}; offset excludes the carry so only fully
  // emitted lines count (§5: offset only advances after a full line).
  persist(force) {
    if (this.pendingResume !== undefined) return; // never clobber before the start decision
    const now = Date.now();
    if (!force && now - this.lastPersist < PERSIST_EVERY_MS) return;
    this.lastPersist = now;
    const record = { offset: this.pos - this.carry.length, size: this.size, path: this.sourcePath() };
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(record));
    } catch (e) {
      log.warn('logsource', `could not persist offsets to ${this.stateFile}: ${e.message}`);
    }
  }

  setOk() {
    this.error = null;
    this.ok = true;
    this.backoffErrors = 0;
    this.emitStatusIfChanged();
  }

  fail(err) {
    this.error = (err && err.message) || String(err);
    this.ok = false;
    this.backoffErrors++;
    log.warn('logsource', `${this.mode} poll failed: ${this.error}`);
    this.emitStatusIfChanged();
  }

  emitStatusIfChanged() {
    const key = `${this.ok}|${this.error || ''}`;
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    try {
      this.emit('status', this.status());
    } catch (e) {
      log.error('logsource', `status listener threw: ${e.message}`);
    }
  }

  // ------------------------------------------------------------- local mode

  async pollLocal() {
    const st = await fsp.stat(this.cfg.path); // throws -> fail() handles it
    const size = st.size;
    this.size = size;
    if (this.pendingResume !== undefined) this.resolveStart(size);
    this.checkRotation(size);

    if (size > this.pos) {
      let fh;
      try {
        fh = await fsp.open(this.cfg.path, 'r');
        while (this.pos < size && !this.stopped) {
          const want = Math.min(READ_CHUNK, size - this.pos);
          const buf = Buffer.alloc(want);
          const { bytesRead } = await fh.read(buf, 0, want, this.pos);
          if (bytesRead <= 0) break;
          this.pos += bytesRead;
          this.ingestChunk(bytesRead === want ? buf : buf.subarray(0, bytesRead));
        }
      } finally {
        if (fh) await fh.close().catch(() => {});
      }
    }
    this.lastReadAt = Date.now();
    this.persist(false);
  }

  // ------------------------------------------------------------- ftp mode

  async pollFtp() {
    const f = this.cfg.ftp || {};
    if (!this.client || this.client.closed) {
      await this.teardownClient();
      const client = new this.ftpLib.Client();
      await client.access({
        host: f.host,
        port: f.port || 21,
        user: f.user,
        password: f.password,
        secure: !!f.secure, // §5: secure:true -> FTPS
      });
      this.client = client;
    }
    const size = await this.client.size(f.path);
    this.size = size;
    if (this.pendingResume !== undefined) this.resolveStart(size);
    this.checkRotation(size);

    if (size > this.pos) {
      const sink = new PassThrough();
      const chunks = [];
      sink.on('data', (c) => chunks.push(c));
      await this.client.downloadTo(sink, f.path, this.pos);
      for (const c of chunks) {
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
        this.pos += buf.length;
        this.ingestChunk(buf);
      }
    }
    this.lastReadAt = Date.now();
    this.persist(false);
  }

  // ------------------------------------------------------------- sftp mode

  async pollSftp() {
    const s = this.cfg.sftp || {};
    if (!this.client) {
      const client = new this.SftpClient();
      const auth = { host: s.host, port: s.port || 22, username: s.user };
      if (s.privateKeyPath) auth.privateKey = fs.readFileSync(s.privateKeyPath);
      else auth.password = s.password;
      await client.connect(auth);
      this.client = client;
    }
    const st = await this.client.stat(s.path);
    const size = st.size;
    this.size = size;
    if (this.pendingResume !== undefined) this.resolveStart(size);
    this.checkRotation(size);

    if (size > this.pos) {
      const stream = this.client.createReadStream(s.path, { start: this.pos, autoClose: true });
      await new Promise((resolve, reject) => {
        stream.on('data', (c) => {
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          this.pos += buf.length;
          this.ingestChunk(buf);
        });
        stream.on('end', resolve);
        stream.on('close', resolve);
        stream.on('error', reject);
      });
    }
    this.lastReadAt = Date.now();
    this.persist(false);
  }

  async teardownClient() {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      if (this.mode === 'ftp' && typeof client.close === 'function') client.close();
      else if (this.mode === 'sftp' && typeof client.end === 'function') await client.end();
    } catch (_e) {
      // connection already gone — nothing to clean
    }
  }
}

function createLogSource(cfg, opts) {
  return new LogSource(cfg, opts);
}

// Can this mode's optional dependency be loaded right now? Lets the settings
// API refuse an ftp/sftp save BEFORE anything is applied or persisted, instead
// of throwing from start() after the config already changed.
function modeAvailable(mode) {
  try {
    if (mode === 'ftp') lazyRequire('basic-ftp');
    else if (mode === 'sftp') lazyRequire('ssh2-sftp-client');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { createLogSource, modeAvailable };
