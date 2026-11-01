'use strict';
// Shared helpers: logger, sanitizers, small formatters. Zero dependencies.
const crypto = require('node:crypto');

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

const log = {
  info(tag, msg, extra) { console.log(`${ts()} [${tag}] ${msg}`, extra !== undefined ? extra : ''); },
  warn(tag, msg, extra) { console.warn(`${ts()} [${tag}] WARN ${msg}`, extra !== undefined ? extra : ''); },
  error(tag, msg, extra) { console.error(`${ts()} [${tag}] ERROR ${msg}`, extra !== undefined ? extra : ''); },
};

// Strip characters that could break out of an RCON command; cap length.
function sanitizeRconArg(s, max = 480) {
  return String(s == null ? '' : s).replace(/[\r\n\0]/g, ' ').trim().slice(0, max);
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function randomTokenHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// Squad ban interval ("0"=perm, "30m","2h","1d","1w","1M","1y") -> seconds (0 = permanent).
// Returns null for anything it does not understand.
function parseInterval(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (s === '0') return 0;
  const m = /^(\d{1,4})([smhdwMy])$/.exec(s);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, M: 2592000, y: 31536000 }[m[2]];
  return n * unit;
}

// "Yehorivka_RAAS_v1" -> "Yehorivka RAAS v1"
function prettyLayer(s) {
  return String(s == null ? '' : s).replace(/_/g, ' ').trim();
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

module.exports = { log, sanitizeRconArg, sha256hex, randomTokenHex, parseInterval, prettyLayer, clampInt };
