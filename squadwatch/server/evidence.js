'use strict';
// Evidence files on bans and warn/kick/ban actions, plus private ban notes
// (docs/BATCH3-CONTRACTS.md §1). Files arrive from the internet and are served
// back to admins' browsers, so:
// - The type is decided by magic bytes only, never by the Content-Type header
//   or the extension: PNG, JPEG, GIF, WEBP, MP4/MOV (ftyp, image brands
//   excluded), WEBM/MKV (EBML DocType), PDF, or plain text (valid UTF-8, no
//   NUL, at most 2 MB, no HTML/SVG/XML markup, no #! script). Anything else
//   is a 415.
// - A file is stored as <dataDir>/evidence/<sha256>.<ext>: its content names
//   it, never the client. The client's filename is display metadata only:
//   sanitized, at most 120 characters, its extension made to match the type.
// - An upload streams into a temp file in that directory while it is hashed,
//   counted and sniffed. On a refusal, a write error, an abort or a client
//   disconnect the temp file is removed (briefly held ones retried) before
//   anything is answered. One Windows keeps holding is left to a sweep every
//   10 minutes, which also clears temp files of uploads cut off by a crash
//   once they are an hour old.
// - An upload is refused (507) unless MIN_FREE_BYTES stay free on the disk
//   (the database lives there too) once it and every running upload have
//   written what they still may: their Content-Length, or the size cap.
// - Placing a file and inserting its row run in one synchronous step, as do a
//   delete's row update and unlink: concurrent uploads of the same bytes and
//   deletes interleave only between those steps, so no live row ever points
//   at a missing file.
// - Served files carry the sniffed type, nosniff and a sandbox CSP; anything
//   that is not an image or a video is an attachment.
// - A stored file is deleted only when this database's rows account for it
//   and none of them is live (index.js gives --demo a store of its own).
//
// createEvidence({db, config, log, auth, dataDir, minFreeBytes?, sweepMs?}) ->
//   {registerRoutes(api), start(), stop()}
// minFreeBytes (the disk an upload must leave free) and sweepMs (the temp-file
// sweep period) exist for tests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream');
const { log: utilLog } = require('./util');

const MAX_LIVE_PER_TARGET = 20;
const TEXT_MAX_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 64; // every signature below fits, EBML DocType included
const FILENAME_MAX = 120;
const CAPTION_MAX = 300;
const NOTE_MAX = 2000;
const DEFAULT_MAX_MB = 50;
// After a refusal mid-body, at most this much more is read and dropped
// before the connection closes, so a client still sending reads the answer
// instead of a connection reset.
const LINGER_BYTES = 8 * 1024 * 1024;
const LINGER_MS = 5000;
// The database lives on the same disk: an upload must leave this much free.
const MIN_FREE_BYTES = 256 * 1024 * 1024;
const TEMP_PREFIX = '.upload-';
const TEMP_SUFFIX = '.tmp';
// A temp file no running upload of this process owns is swept once untouched
// this long: it outlasts server.requestTimeout, so it is no live upload.
const TEMP_STALE_MS = 3600 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
// Windows antivirus and indexers briefly hold a file that was just written:
// a rename or delete refused with one of these is tried again after each wait.
const BUSY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const BUSY_RETRY_MS = [100, 300, 1000];

// Exact header from BATCH3 §1 on every stored-file response.
const FILE_CSP = "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";

// ext: stored extension; exts: client extensions kept as they are; inline:
// shown in the page rather than downloaded.
const TYPES = {
  png: { ext: 'png', mime: 'image/png', exts: ['png'], inline: true },
  jpg: { ext: 'jpg', mime: 'image/jpeg', exts: ['jpg', 'jpeg', 'jpe', 'jfif'], inline: true },
  gif: { ext: 'gif', mime: 'image/gif', exts: ['gif'], inline: true },
  webp: { ext: 'webp', mime: 'image/webp', exts: ['webp'], inline: true },
  mp4: { ext: 'mp4', mime: 'video/mp4', exts: ['mp4', 'm4v'], inline: true },
  mov: { ext: 'mov', mime: 'video/quicktime', exts: ['mov', 'qt'], inline: true },
  webm: { ext: 'webm', mime: 'video/webm', exts: ['webm'], inline: true },
  mkv: { ext: 'mkv', mime: 'video/x-matroska', exts: ['mkv'], inline: true },
  pdf: { ext: 'pdf', mime: 'application/pdf', exts: ['pdf'], inline: false },
  // .csv and friends open in spreadsheet apps (formula injection): kept as .txt.
  txt: { ext: 'txt', mime: 'text/plain', exts: ['txt', 'log'], inline: false },
};
const TYPE_BY_MIME = new Map(Object.values(TYPES).map((t) => [t.mime, t]));
const STORED_NAME_RE = new RegExp(`^[0-9a-f]{64}\\.(?:${Object.values(TYPES).map((t) => t.ext).join('|')})$`);

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// ISO-BMFF major brands of still images (HEIC, AVIF): an ftyp box, not MP4/MOV.
const IMAGE_BRANDS = new Set([
  'avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'mif2', 'msf1', 'miaf',
]);

// Text a browser could sniff, or a desktop program open, as HTML/SVG/XML.
const MARKUP_START_RE = new RegExp(
  '^\\s*<(?:!doctype|!--|\\?xml|(?:a|b|base|body|br|div|embed|font|form|frame|frameset|h1|head|html|iframe|img|' +
  'link|math|meta|object|p|script|style|svg|table|template|title)(?=[\\s/>]|$))', 'i');
const MARKUP_ANY_RE = /<(?:!doctype|\?xml|(?:embed|frame|frameset|html|iframe|object|script|svg)(?=[\s/>]))/i;

const NOT_ALLOWED = 'unsupported file type — attach a PNG, JPEG, GIF or WEBP image, an MP4, MOV, WEBM or MKV video, a PDF, or plain text';
// Invisible and direction-changing characters can disguise an extension.
const HIDDEN_CHARS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const WINDOWS_RESERVED_RE = /^(?:con|prn|aux|nul|com\d|lpt\d)$/i;
// Same rule as the private note on POST /api/bans: line breaks and tabs stay.
const NOTE_STRIP_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

// ------------------------------------------------------------- type sniffing

// The EBML header's DocType string, or null.
function ebmlDocType(b) {
  const lim = Math.min(b.length, SNIFF_BYTES);
  for (let i = 4; i + 2 < lim; i++) {
    if (b[i] !== 0x42 || b[i + 1] !== 0x82) continue;
    const first = b[i + 2];
    let len = 1;
    while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
    if (len > 8 || i + 2 + len > lim) return null;
    let size = first & (0xff >> len);
    for (let k = 1; k < len; k++) size = size * 256 + b[i + 2 + k];
    const start = i + 2 + len;
    if (size < 1 || size > 16 || start + size > lim) return null;
    return b.toString('latin1', start, start + size).replace(/\0+$/, '');
  }
  return null;
}

// The binary type the first bytes declare, or null (maybe plain text).
function sniff(b) {
  const at = (i, s) => b.length >= i + s.length && b.toString('latin1', i, i + s.length) === s;
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIG)) return TYPES.png;
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return TYPES.jpg;
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return TYPES.gif;
  if (at(0, 'RIFF') && at(8, 'WEBP')) return TYPES.webp;
  if (b.length >= 12 && at(4, 'ftyp')) {
    const brand = b.toString('latin1', 8, 12);
    if (!/^[\x20-\x7e]{4}$/.test(brand) || IMAGE_BRANDS.has(brand)) return null;
    return brand === 'qt  ' ? TYPES.mov : TYPES.mp4;
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const docType = ebmlDocType(b);
    if (docType === 'webm') return TYPES.webm;
    if (docType === 'matroska') return TYPES.mkv;
    return null;
  }
  if (at(0, '%PDF-')) return TYPES.pdf;
  return null;
}

// Decoded text that may be kept as plain text: no markup, no #! script.
function textAllowed(s) {
  if (/^\s*#!/.test(s)) return false;
  return !MARKUP_START_RE.test(s) && !MARKUP_ANY_RE.test(s);
}

// --------------------------------------------------------- names and headers

// Display name for an upload: no path, no hidden or reserved characters, at
// most FILENAME_MAX code points, and an extension that matches `type`.
function cleanFilename(raw, type) {
  let s = String(raw == null ? '' : raw).toWellFormed();
  s = s.split(/[\\/]/).pop();
  s = s.replace(HIDDEN_CHARS_RE, '').replace(/[<>:"|?*]/g, '_');
  s = s.replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  const dot = s.lastIndexOf('.');
  let base = s;
  let ext = type.ext;
  if (dot > 0 && type.exts.includes(s.slice(dot + 1).toLowerCase())) {
    base = s.slice(0, dot);
    ext = s.slice(dot + 1);
  }
  base = base.replace(/[\s.]+$/, '');
  if (!base) base = 'evidence';
  if (WINDOWS_RESERVED_RE.test(base.split('.')[0].trim())) base = `_${base}`;
  const room = FILENAME_MAX - 1 - ext.length;
  const cps = [...base];
  if (cps.length > room) base = cps.slice(0, room).join('').replace(/[\s.]+$/, '') || 'evidence';
  return `${base}.${ext}`;
}

// RFC 6266 / RFC 5987: an ASCII fallback plus the exact UTF-8 name.
function contentDisposition(kind, name) {
  const s = String(name).toWellFormed();
  const fallback = s.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const exact = encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${exact}`;
}

// One `bytes=` range -> {start, end}; 'unsatisfiable'; or null when the
// header is absent, malformed or asks for several ranges (served whole).
function parseRange(header, size) {
  if (header == null) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(String(header));
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? null : Number(m[2]);
  if (end != null && end < start) return null;
  if (start >= size) return 'unsatisfiable';
  return { start, end: end == null ? size - 1 : Math.min(end, size - 1) };
}

function etagMatches(header, etag) {
  if (header == null) return false;
  return String(header).split(',').some((v) => {
    const t = v.trim();
    return t === '*' || t.replace(/^W\//, '') === etag;
  });
}

function whenClosed(stream) {
  return new Promise((resolve) => {
    if (stream.closed) resolve();
    else stream.once('close', resolve);
  });
}

function noop() {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------ factory

function createEvidence(deps) {
  const d = deps || {};
  const db = d.db;
  const config = d.config || {};
  const auth = d.auth;
  const log = d.log && typeof d.log.warn === 'function' ? d.log : utilLog;
  if (!db || !auth) throw new Error('evidence needs db and auth');
  if (!d.dataDir) throw new Error('evidence needs dataDir');
  const dir = path.join(path.resolve(String(d.dataDir)), 'evidence');
  const minFree = Number.isFinite(d.minFreeBytes) ? d.minFreeBytes : MIN_FREE_BYTES;
  const sweepMs = Number.isFinite(d.sweepMs) && d.sweepMs > 0 ? d.sweepMs : SWEEP_EVERY_MS;
  const inflight = new Set(); // temp files of uploads still running
  const leftovers = new Set(); // temp files whose removal failed: the sweep's
  const reservations = new Set(); // {left}: bytes each running upload may still write
  let sweeper = null;

  let api = null;
  const err = (status, message) => new api.ApiErr(status, message);

  // Read live: the Settings API changes config.evidence in place.
  function maxMB() {
    const v = config.evidence && config.evidence.maxMB;
    return Number.isInteger(v) && v >= 1 && v <= 100 ? v : DEFAULT_MAX_MB;
  }
  function tooLarge() { return `file too large — the limit is ${maxMB()} MB`; }

  function storedPath(name) {
    return STORED_NAME_RE.test(String(name)) ? path.join(dir, String(name)) : null;
  }

  // ------------------------------------------------------------- db helpers

  const ROW_SELECT = `SELECT e.*, u.username AS uploader FROM evidence e
      LEFT JOIN users u ON u.id = e.uploaded_by`;

  function rowOut(r) {
    return {
      id: r.id, targetType: r.target_type, targetId: r.target_id,
      filename: r.filename, mime: r.mime, size: r.size,
      caption: r.caption == null ? null : r.caption,
      uploadedBy: r.uploaded_by == null ? null : r.uploaded_by,
      uploader: r.uploader == null ? null : r.uploader,
      uploadedAt: r.uploaded_at, url: `/api/evidence/${r.id}/file`,
    };
  }

  // {perm, playerId}; {ineligible} for an action that is not warn/kick/ban;
  // null when the row does not exist.
  function loadTarget(type, id) {
    if (type === 'ban') {
      const b = db.prepare('SELECT id, player_id FROM bans WHERE id = ?').get(id);
      return b ? { perm: 'ban', playerId: b.player_id == null ? null : b.player_id } : null;
    }
    const a = db.prepare('SELECT id, action, target_player_id FROM admin_actions WHERE id = ?').get(id);
    if (!a) return null;
    if (a.action !== 'warn' && a.action !== 'kick' && a.action !== 'ban') return { ineligible: true };
    return { perm: a.action, playerId: a.target_player_id == null ? null : a.target_player_id };
  }

  function usableTarget(type, id, user) {
    const target = loadTarget(type, id);
    if (!target) throw err(404, type === 'ban' ? 'ban not found' : 'admin action not found');
    if (target.ineligible) throw err(400, 'evidence attaches to warn, kick and ban actions only');
    if (!auth.can(user, target.perm)) throw err(403, `attaching evidence here needs the ${target.perm} permission`);
    return target;
  }

  function liveCount(type, id) {
    const r = db.prepare(
      'SELECT COUNT(*) AS c FROM evidence WHERE target_type = ? AND target_id = ? AND deleted_at IS NULL'
    ).get(type, id);
    return r ? Number(r.c) : 0;
  }

  // The role as stored now: an upload can outlast a permission change.
  function stillAllowed(userId, perm) {
    const r = db.prepare(
      `SELECT u.disabled, r.id AS role_id, r.perms FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
    ).get(userId);
    if (!r || Number(r.disabled) === 1) return false;
    return auth.parsePerms(r.role_id, r.perms)[perm] === true;
  }

  function later(ms, fn) {
    const timer = setTimeout(() => {
      try {
        fn();
      } catch (e) {
        log.warn('evidence', `cleanup retry failed: ${e.code || e.message}`);
      }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
  }

  // Removes the stored file(s) of `sha` once no live row references it.
  // Synchronous on purpose (see the header); a busy file is tried again
  // later, checked for references again first.
  function removeIfUnused(sha, extraNames, attempt = 0) {
    const live = db.prepare('SELECT COUNT(*) AS c FROM evidence WHERE sha256 = ? AND deleted_at IS NULL').get(sha);
    if (live && Number(live.c) > 0) return;
    const names = new Set(extraNames || []);
    for (const r of db.prepare('SELECT DISTINCT stored_name FROM evidence WHERE sha256 = ?').all(sha)) {
      names.add(r.stored_name);
    }
    for (const name of names) {
      const file = storedPath(name);
      if (!file || !name.startsWith(`${sha}.`)) continue;
      try {
        fs.rmSync(file, { force: true });
      } catch (e) {
        if (BUSY_CODES.has(e.code) && attempt < BUSY_RETRY_MS.length) {
          later(BUSY_RETRY_MS[attempt], () => removeIfUnused(sha, [name], attempt + 1));
        } else {
          log.warn('evidence', `could not remove ${name}: ${e.code || e.message}`);
        }
      }
    }
  }

  function targetParams(q) {
    const targetType = q.get('targetType');
    if (targetType !== 'ban' && targetType !== 'action') throw err(400, "targetType must be 'ban' or 'action'");
    return { targetType, targetId: api.intParam(q.get('targetId'), 'targetId') };
  }

  function cleanCaption(raw) {
    if (raw == null) return null;
    const s = String(raw).toWellFormed().replace(HIDDEN_CHARS_RE, ' ').replace(/\s+/g, ' ').trim();
    if ([...s].length > CAPTION_MAX) throw err(400, `caption must be at most ${CAPTION_MAX} characters`);
    return s || null;
  }

  // A reservation {left} for `need` more bytes, or null when the disk would
  // then keep less than minFree. The free space read from the disk already
  // holds what running uploads wrote; `left` is what each may still write.
  async function reserveSpace(need) {
    let free = Infinity; // unknown: the write itself still fails cleanly
    if (typeof fs.promises.statfs === 'function') {
      try {
        const s = await fs.promises.statfs(dir);
        free = Number(s.bavail) * Number(s.bsize);
      } catch (_e) { /* unknown */ }
    }
    // Compared and taken in one step: no other upload's check runs between.
    let pending = 0;
    for (const r of reservations) pending += r.left;
    if (free - pending < need + minFree) return null;
    const room = { left: need };
    reservations.add(room);
    return room;
  }

  // Removes an upload's temp file. Antivirus or an indexer briefly holding a
  // file just written is waited out (BUSY_RETRY_MS); one still held after
  // that is left to the sweep. Never rejects.
  async function dropTemp(tmp) {
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rm(tmp, { force: true });
        break;
      } catch (e) {
        if (BUSY_CODES.has(e.code) && attempt < BUSY_RETRY_MS.length) {
          await sleep(BUSY_RETRY_MS[attempt]);
          continue;
        }
        log.warn('evidence', `temp file not removed, left to the sweep: ${e.code || e.message}`);
        leftovers.add(tmp);
        break;
      }
    }
    inflight.delete(tmp);
  }

  // ------------------------------------------------------------- responses

  // Answers an upload that will not be stored. With the body still arriving,
  // the rest is read and dropped (LINGER_BYTES / LINGER_MS at most) before the
  // connection closes.
  function refuse(ctx, status, message) {
    const { req, res } = ctx;
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    if (req.complete || req.readableEnded) {
      api.json(res, status, { error: message });
      return;
    }
    const body = Buffer.from(JSON.stringify({ error: message }));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Content-Length': body.length,
      Connection: 'close',
    });
    res.write(body);
    let dropped = 0;
    let timer = null;
    const finish = () => {
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', finish);
      req.removeListener('close', finish);
      if (!res.writableEnded) res.end();
    };
    const onData = (chunk) => {
      dropped += chunk.length;
      if (dropped > LINGER_BYTES) finish();
    };
    timer = setTimeout(finish, LINGER_MS);
    if (typeof timer.unref === 'function') timer.unref();
    req.on('error', noop);
    req.on('data', onData);
    req.once('end', finish);
    req.once('close', finish);
    req.resume();
  }

  // --------------------------------------------------------------- receive

  // Streams the body into a temp file beside the store while hashing,
  // counting and sniffing it; `room` (reserveSpace) shrinks as bytes are
  // written. Resolves {tmp, size, sha256, type}. Rejects with {status,
  // message} (refusal or storage failure) or {aborted: true} (the client went
  // away) — always after the temp file is gone or left to the sweep.
  function receive(req, maxBytes, room) {
    return new Promise((resolve, reject) => {
      // Gone during the checks above: its 'close' has already fired.
      if (req.destroyed) {
        reject({ aborted: true });
        return;
      }
      const tmp = path.join(dir, `${TEMP_PREFIX}${crypto.randomBytes(12).toString('hex')}${TEMP_SUFFIX}`);
      inflight.add(tmp);
      const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600, flush: true });
      out.on('error', noop); // handled by onOutError while it matters; never fatal
      req.on('error', noop);
      const hash = crypto.createHash('sha256');
      let size = 0;
      let head = [];
      let headBytes = 0;
      let type = null;
      let text = null; // {decoder, parts} while the body may be plain text
      let settled = false;
      let paused = false;

      function detach() {
        req.removeListener('data', onData);
        req.removeListener('end', onEnd);
        req.removeListener('close', onClose);
        req.removeListener('error', onAbort);
        out.removeListener('error', onOutError);
        out.removeListener('drain', onDrain);
      }

      function settle(problem, value) {
        if (settled) return;
        settled = true;
        detach();
        if (!problem) {
          resolve(value);
          return;
        }
        out.destroy();
        whenClosed(out)
          .then(() => dropTemp(tmp))
          .catch(noop)
          .then(() => reject(problem));
      }
      const refusal = (status, message) => ({ status, message });

      // Fixes the type from the first bytes; returns why it is refused, or null.
      function startType(h) {
        type = sniff(h);
        if (type) return null;
        if (h.length === 0) return 'the file is empty';
        type = TYPES.txt;
        text = { decoder: new TextDecoder('utf-8', { fatal: true }), parts: [] };
        const why = moreText(h);
        if (why) return why;
        return textAllowed(text.parts.join('')) ? null : NOT_ALLOWED;
      }
      function moreText(chunk) {
        if (size > TEXT_MAX_BYTES) return `${NOT_ALLOWED} (plain text is limited to 2 MB)`;
        if (chunk.includes(0)) return NOT_ALLOWED;
        try {
          text.parts.push(text.decoder.decode(chunk, { stream: true }));
        } catch (_e) {
          return NOT_ALLOWED;
        }
        return null;
      }

      function write(chunk) {
        room.left = Math.max(0, room.left - chunk.length);
        if (!out.write(chunk) && !paused) {
          paused = true;
          req.pause();
          out.once('drain', onDrain);
        }
      }
      function onDrain() {
        paused = false;
        if (!settled) req.resume();
      }

      function onData(chunk) {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) return settle(refusal(413, tooLarge()));
        hash.update(chunk);
        if (head) {
          head.push(chunk);
          headBytes += chunk.length;
          if (headBytes >= SNIFF_BYTES) {
            const h = Buffer.concat(head);
            head = null;
            const why = startType(h);
            if (why) return settle(refusal(415, why));
          }
        } else if (text) {
          const why = moreText(chunk);
          if (why) return settle(refusal(415, why));
        }
        write(chunk);
      }

      function onEnd() {
        if (settled) return;
        if (head) {
          const h = Buffer.concat(head);
          head = null;
          const why = startType(h);
          if (why) return settle(refusal(415, why));
        }
        if (text) {
          let s;
          try {
            text.parts.push(text.decoder.decode());
            s = text.parts.join('');
          } catch (_e) {
            return settle(refusal(415, NOT_ALLOWED));
          }
          text = null;
          if (!textAllowed(s)) return settle(refusal(415, NOT_ALLOWED));
        }
        out.once('close', () => {
          if (!settled) settle(null, { tmp, size, sha256: hash.digest('hex'), type });
        });
        out.end();
      }

      function onClose() {
        if (!req.complete) settle({ aborted: true });
      }
      function onAbort() { settle({ aborted: true }); }
      function onOutError(e) {
        log.error('evidence', `storing an upload failed: ${e && (e.code || e.message)}`);
        settle(refusal(500, e && e.code === 'ENOSPC'
          ? 'could not store the file — the panel host is out of disk space'
          : 'could not store the file on the panel host'));
      }

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('close', onClose);
      req.on('error', onAbort);
      out.on('error', onOutError);
      req.resume();
    });
  }

  // Places the received file and inserts its row in one synchronous step.
  // -> {row, duplicate, target, placed}. Unless `placed` (renamed into the
  // store), the temp file is left for the caller to remove, as on a throw.
  function commit(plan, got, user) {
    const target = loadTarget(plan.targetType, plan.targetId);
    if (!target || target.ineligible) throw err(404, 'the item this file was for no longer exists');
    if (!stillAllowed(user.id, target.perm)) throw err(403, 'forbidden');
    const dup = db.prepare(
      `${ROW_SELECT} WHERE e.target_type = ? AND e.target_id = ? AND e.sha256 = ? AND e.deleted_at IS NULL
        ORDER BY e.id LIMIT 1`
    ).get(plan.targetType, plan.targetId, got.sha256);
    if (dup) return { row: dup, duplicate: true, target, placed: false };
    if (liveCount(plan.targetType, plan.targetId) >= MAX_LIVE_PER_TARGET) {
      throw err(409, `at most ${MAX_LIVE_PER_TARGET} files per item — delete one first`);
    }
    const storedName = `${got.sha256}.${got.type.ext}`;
    const finalPath = path.join(dir, storedName);
    let existing = null;
    try {
      existing = fs.statSync(finalPath);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    // Bytes already stored for another row are kept; the temp copy is spare.
    let placed = false;
    if (!(existing && existing.isFile() && existing.size === got.size)) {
      fs.renameSync(got.tmp, finalPath);
      placed = true;
      inflight.delete(got.tmp);
    }
    let id;
    try {
      id = db.prepare(
        `INSERT INTO evidence(target_type, target_id, sha256, stored_name, filename, mime, size, caption, uploaded_by, uploaded_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`
      ).run(plan.targetType, plan.targetId, got.sha256, storedName, cleanFilename(plan.rawName, got.type),
        got.type.mime, got.size, plan.caption, user.id, Date.now()).lastInsertRowid;
    } catch (e) {
      if (placed) removeIfUnused(got.sha256, [storedName]);
      throw e;
    }
    return { row: db.prepare(`${ROW_SELECT} WHERE e.id = ?`).get(id), duplicate: false, target, placed };
  }

  // -------------------------------------------------------------- handlers

  // POST /api/evidence — every check that needs no body runs before a byte
  // is read; the body itself is never buffered whole.
  async function hUpload(ctx) {
    let plan;
    let room;
    try {
      const { targetType, targetId } = targetParams(ctx.query);
      usableTarget(targetType, targetId, ctx.user);
      if (liveCount(targetType, targetId) >= MAX_LIVE_PER_TARGET) {
        throw err(409, `at most ${MAX_LIVE_PER_TARGET} files per item — delete one first`);
      }
      const caption = cleanCaption(ctx.query.get('caption'));
      const maxBytes = maxMB() * 1024 * 1024;
      const declared = ctx.req.headers['content-length'];
      const length = declared == null || declared === '' ? null : Number(declared);
      if (length != null && length > maxBytes) throw err(413, tooLarge());
      if (length === 0) throw err(415, 'the file is empty');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      plan = { targetType, targetId, caption, maxBytes, rawName: ctx.query.get('filename') };
      // Taken last, so no throw in this block leaves a reservation held.
      room = await reserveSpace(length != null ? length : maxBytes);
      if (!room) throw err(507, 'the panel host is low on disk space — free some up first');
    } catch (e) {
      if (e instanceof api.ApiErr) return refuse(ctx, e.status, e.message);
      log.error('evidence', `upload setup failed: ${e && (e.code || e.message)}`);
      return refuse(ctx, 500, 'could not store the file on the panel host');
    }
    try {
      return await keep(ctx, plan, room);
    } finally {
      reservations.delete(room);
    }
  }

  // Receives an upload whose checks passed, stores it and answers.
  async function keep(ctx, plan, room) {
    let got;
    try {
      got = await receive(ctx.req, plan.maxBytes, room);
    } catch (e) {
      if (e && e.aborted) return undefined; // nobody left to answer
      return refuse(ctx, e && e.status ? e.status : 500, e && e.message ? e.message : 'upload failed');
    }

    // commit() changes nothing before its rename, so a busy refusal there is
    // retried whole, every check included.
    let out;
    for (let attempt = 0; !out; attempt++) {
      try {
        out = commit(plan, got, ctx.user);
      } catch (e) {
        if (e && BUSY_CODES.has(e.code) && attempt < BUSY_RETRY_MS.length) {
          await sleep(BUSY_RETRY_MS[attempt]);
          continue;
        }
        await dropTemp(got.tmp);
        if (e instanceof api.ApiErr) return api.json(ctx.res, e.status, { error: e.message });
        log.error('evidence', `saving an upload failed: ${e && (e.code || e.message)}`);
        return api.json(ctx.res, 500, { error: 'could not store the file on the panel host' });
      }
    }
    if (!out.placed) await dropTemp(got.tmp);
    if (!out.duplicate) {
      try {
        auth.audit(ctx.user.id, 'evidence-upload', {
          targetPlayerId: out.target.playerId,
          details: {
            targetType: plan.targetType, targetId: plan.targetId, filename: out.row.filename,
            size: out.row.size, sha256: out.row.sha256,
          },
        });
      } catch (e) {
        log.error('evidence', `audit insert failed: ${e.message}`);
      }
    }
    const body = { ok: true, evidence: rowOut(out.row) };
    if (out.duplicate) body.duplicate = true;
    return api.json(ctx.res, 200, body);
  }

  function hList(ctx) {
    const { targetType, targetId } = targetParams(ctx.query);
    const rows = db.prepare(
      `${ROW_SELECT} WHERE e.target_type = ? AND e.target_id = ? AND e.deleted_at IS NULL ORDER BY e.id`
    ).all(targetType, targetId);
    // maxMB: the upload limit, so the browser's precheck matches it exactly.
    return api.json(ctx.res, 200, { rows: rows.map(rowOut), maxMB: maxMB() });
  }

  async function hFile(ctx) {
    const id = api.intParam(ctx.params[1], 'evidence id');
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id);
    if (!row || row.deleted_at != null) throw err(404, 'evidence not found');
    const file = storedPath(row.stored_name);
    if (!file || !row.stored_name.startsWith(`${row.sha256}.`)) {
      log.warn('evidence', `evidence ${id} has an unusable stored name — not served`);
      throw err(404, 'evidence file missing');
    }
    let fh;
    try {
      fh = await fs.promises.open(file, 'r');
    } catch (e) {
      if (e.code === 'ENOENT') throw err(404, 'evidence file missing');
      throw e;
    }
    let handed = false;
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw err(404, 'evidence file missing');
      const size = st.size;
      const { req, res } = ctx;
      const etag = `"${row.sha256}"`;
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', FILE_CSP);
      if (etagMatches(req.headers['if-none-match'], etag)) {
        res.statusCode = 304;
        res.end();
        return undefined;
      }
      let range = parseRange(req.headers.range, size);
      if (range && req.headers['if-range'] != null && req.headers['if-range'] !== etag) range = null;
      if (range === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${size}`);
        return api.json(res, 416, { error: 'range not satisfiable' });
      }
      const type = TYPE_BY_MIME.get(row.mime) || null;
      const name = row.filename || `evidence.${type ? type.ext : 'bin'}`;
      res.setHeader('Content-Type', !type ? 'application/octet-stream'
        : (type === TYPES.txt ? 'text/plain; charset=utf-8' : type.mime));
      res.setHeader('Content-Disposition', contentDisposition(type && type.inline ? 'inline' : 'attachment', name));
      res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Accept-Ranges', 'bytes');
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      res.statusCode = range ? 206 : 200;
      if (range) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', Math.max(0, end - start + 1));
      if (size === 0) {
        res.end();
        return undefined;
      }
      // The browser may have gone (a cancelled video seek) while we awaited.
      // A FileHandle left open is fatal in Node 26 once it is collected, so
      // every path below must close it: the finally does until the read
      // stream owns it, and pipeline() throws rather than taking ownership
      // when the response is already destroyed.
      if (res.destroyed) return undefined;
      const rs = fh.createReadStream({ start, end, autoClose: true });
      handed = true;
      try {
        pipeline(rs, res, (e) => {
          if (e && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') log.warn('evidence', `serving evidence ${id} failed: ${e.code || e.message}`);
        });
      } catch (_e) {
        rs.destroy();
      }
      return undefined;
    } finally {
      if (!handed) await fh.close().catch(noop);
    }
  }

  // Soft delete by the uploader, or by someone holding both ban and settings.
  function hDelete(ctx) {
    const id = api.intParam(ctx.params[1], 'evidence id');
    const row = db.prepare('SELECT * FROM evidence WHERE id = ?').get(id);
    if (!row || row.deleted_at != null) throw err(404, 'evidence not found');
    const own = row.uploaded_by != null && Number(row.uploaded_by) === Number(ctx.user.id);
    if (!own && !(auth.can(ctx.user, 'ban') && auth.can(ctx.user, 'settings'))) {
      throw err(403, 'only the uploader, or someone with both the ban and settings permissions, can delete evidence');
    }
    const r = db.prepare('UPDATE evidence SET deleted_by = ?, deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
      .run(ctx.user.id, Date.now(), id);
    if (r.changes === 0) throw err(404, 'evidence not found');
    removeIfUnused(row.sha256, [row.stored_name]);
    const target = loadTarget(row.target_type, row.target_id);
    auth.audit(ctx.user.id, 'evidence-delete', {
      targetPlayerId: target && !target.ineligible ? target.playerId : null,
      details: {
        evidenceId: id, targetType: row.target_type, targetId: row.target_id,
        filename: row.filename, sha256: row.sha256,
      },
    });
    return api.json(ctx.res, 200, { ok: true });
  }

  // POST /api/bans/:id/note — the private staff note. An imported ban
  // mirrors its source (the next sync would overwrite an edit made here).
  function hNote(ctx) {
    const id = api.intParam(ctx.params[1], 'ban id');
    const ban = db.prepare('SELECT id, player_id, source FROM bans WHERE id = ?').get(id);
    if (!ban) throw err(404, 'ban not found');
    if (!Object.prototype.hasOwnProperty.call(ctx.body, 'note')) throw err(400, 'note required ("" clears it)');
    const raw = ctx.body.note;
    if (raw != null && typeof raw !== 'string') throw err(400, 'note must be a string');
    if (ban.source != null) {
      throw err(409, 'this ban is imported from BattleMetrics — edit its note there; the next sync brings it here');
    }
    const note = String(raw == null ? '' : raw).replace(NOTE_STRIP_RE, '').trim();
    if (note.length > NOTE_MAX) throw err(400, `note must be at most ${NOTE_MAX} characters`);
    db.prepare('UPDATE bans SET note = ? WHERE id = ?').run(note || null, id);
    // The audit log has readers without `ban`: never the note's text.
    auth.audit(ctx.user.id, 'ban-note-update', {
      targetPlayerId: ban.player_id == null ? null : ban.player_id,
      details: { banId: id, length: note.length },
    });
    return api.json(ctx.res, 200, { ok: true, note: note || null });
  }

  // ------------------------------------------------------------- lifecycle

  function registerRoutes(a) {
    api = a;
    const readers = { anyPerm: ['ban', 'kick', 'warn', 'audit'] };
    api.route('GET', /^\/api\/evidence$/, readers, hList);
    api.route('POST', /^\/api\/evidence$/, { anyPerm: ['warn', 'kick', 'ban'], rawBody: true }, hUpload);
    api.route('GET', /^\/api\/evidence\/(\d+)\/file$/, readers, hFile);
    api.route('POST', /^\/api\/evidence\/(\d+)\/delete$/, { anyPerm: ['warn', 'kick', 'ban'] }, hDelete);
    api.route('POST', /^\/api\/bans\/(\d+)\/note$/, { perm: 'ban' }, hNote);
  }

  // Temp files no running upload owns: one whose removal failed at once, any
  // other (an upload cut off by a crash or a kill) once stale.
  function sweep() {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (_e) {
      return;
    }
    const seen = new Set();
    const cutoff = Date.now() - TEMP_STALE_MS;
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX) || !name.endsWith(TEMP_SUFFIX)) continue;
      const file = path.join(dir, name);
      seen.add(file);
      if (inflight.has(file)) continue;
      try {
        if (leftovers.has(file) || fs.statSync(file).mtimeMs < cutoff) {
          fs.rmSync(file, { force: true });
          leftovers.delete(file);
        }
      } catch (e) {
        log.warn('evidence', `leftover upload ${name} not removed: ${e.code || e.message}`);
      }
    }
    for (const file of leftovers) if (!seen.has(file)) leftovers.delete(file);
  }

  function start() {
    sweep();
    if (sweeper) clearInterval(sweeper);
    sweeper = setInterval(() => {
      try {
        sweep();
      } catch (e) {
        log.warn('evidence', `temp file sweep failed: ${e.message}`);
      }
    }, sweepMs);
    if (typeof sweeper.unref === 'function') sweeper.unref();
  }

  function stop() {
    if (sweeper) clearInterval(sweeper);
    sweeper = null;
    for (const tmp of [...inflight, ...leftovers]) {
      try { fs.rmSync(tmp, { force: true }); } catch (_e) { /* the sweep after the next start */ }
    }
    inflight.clear();
    leftovers.clear();
  }

  return { registerRoutes, start, stop };
}

module.exports = { createEvidence, sniff, cleanFilename, parseRange, contentDisposition };
