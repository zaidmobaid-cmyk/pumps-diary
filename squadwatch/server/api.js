'use strict';
// HTTP server: REST + SSE + static file serving.
// SPEC §13 with binding amendments: §19.1.4 (parserHealth dep), §19.1.6
// (revive SSE event), §19.1.7 (overview tksToday), §19.1.8 (trolls all/week),
// §19.1.10 (settings gameVersion), §19.2.13/14 (bans.steam_id + stub players,
// flags.review_note), §19.3.15 (setup token), §19.3.16 (SQL whitelist maps),
// §19.3.18 (session JOIN + destroyUserSessions on user mutation), §19.3.19
// (trustProxy/clientIp), §19.3.20 (exact CSRF algorithm + Content-Type),
// §19.3.21 (pagination clamps + LIMIT 2000 truncation), §19.3.22 (SSE
// single-listener fanout, per-user/global caps, ping, viewer filtering),
// §19.3.23 (viewer intel exclusions; audit admin+), §19.3.25 (security
// headers + exact CSP), §19.3.26 (static serving rules), §19.3.27 (secret
// redaction). docs/NEXT-CONTRACTS.md: §1 (layers, factions, changeLayer),
// §2 (quick commands), §3 (BattleMetrics wrappers, ban source/eosId).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { log, sanitizeRconArg, parseInterval, clampInt } = require('./util');
const { ACTION_NAMES, STEAM_ID_RE, INTERVAL_RE } = require('./admin');
const { PERM_INFO } = require('./auth');
const { splitFaction } = require('./parser');
const { JOIN_FLAG_TYPES } = require('./joinalerts');
const { NOT_SAVED } = require('./config');

const BODY_LIMIT = 64 * 1024; // §13: JSON only, 64KB cap

// Live evidence files attached to a ban row (BATCH3 §1); used inside ban SELECTs.
const EVIDENCE_COUNT_SQL = `(SELECT COUNT(*) FROM evidence e
        WHERE e.target_type = 'ban' AND e.target_id = b.id AND e.deleted_at IS NULL) AS evidence_count`;
const COOKIE_NAME = 'sw_session';
const COOKIE_MAX_AGE = 2592000; // 30 days, matches session TTL
const CAP = 2000; // §19.3.21 "[all]" list cap

// §19.3.25 — exact CSP, applied to HTML responses.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' " +
  'https://fonts.googleapis.com; font-src https://fonts.gstatic.com; ' +
  "img-src 'self' https: data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'";

// §19.3.26 — whitelisted extensions with an explicit MIME table.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

// Every servable file under `dir` (MIME-listed extensions), keyed by its
// resolved path, with a short content hash for cache-busting asset URLs.
function snapshotStatic(dir) {
  const files = new Map();
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && MIME[path.extname(ent.name).toLowerCase()]) {
        const buf = fs.readFileSync(full);
        files.set(full, { buf, tag: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10) });
      }
    }
  };
  walk(dir);
  return files;
}

// §19.3.27 — config paths whose values are redacted/scrubbed.
const REDACT_PATHS = [
  'squad.rconPassword', 'log.ftp.password', 'log.sftp.password', 'steamApiKey', 'discordWebhook',
  'battlemetrics.token', 'remoteBanList.key',
];
const REDACTED = '•••'; // •••

// §19.3.16 — whitelist lookup maps; unknown key -> 400.
// Null-prototype maps so inherited Object.prototype keys can never satisfy a lookup.
const PLAYER_SORT = Object.assign(Object.create(null), {
  last_seen: 'last_seen', kills: 'kills', teamkills: 'teamkills',
  radio: 'radio_damage_friendly', playtime: 'play_seconds',
});
const SORT_DIR = Object.assign(Object.create(null), { asc: 'ASC', desc: 'DESC' });
const PLAYER_FILTERS = new Set(['online', 'flagged', 'watchlisted', 'banned']);
const CHAT_CHANNELS = new Set(['all', 'team', 'squad', 'admin']);
const FLAGS_REVIEWED = Object.assign(Object.create(null), { 0: 'f.reviewed = 0', 1: 'f.reviewed = 1', all: null });
const BANS_ACTIVE = new Set(['1', '0', 'all']);
const MATCH_OPS = Object.assign(Object.create(null), { restart: 'restartMatch', end: 'endMatch' });

// NEXT-CONTRACTS §1 — the built-in catalog GET /api/factions starts from;
// every faction and unit type this server has shown is added to it.
const VANILLA_FACTIONS = [
  'ADF', 'BAF', 'CAF', 'IMF', 'INS', 'MEA', 'PLA', 'PLAAGF', 'PLANMC', 'RGF', 'TLF',
  'USA', 'USMC', 'VDV', 'WPMC',
];
const UNIT_TYPES = [
  'CombinedArms', 'LightInfantry', 'Mechanized', 'Motorized', 'Armored', 'Support',
  'AirAssault', 'AmphibiousAssault', 'Combined',
];
// BattleMetrics ban-list ids are UUIDs; anything else never reaches its URL.
const BM_LIST_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const UNBAN_NOTE = 'Ban deactivated in A3 Admin (join enforcement stops immediately). ' +
  'Squad has no RCON unban command — if this ban was exported, remove the SteamID line from ' +
  'Bans.cfg on the game server (then AdminReloadServerConfig or wait for map change). ' +
  'If the player is currently online, nothing more to do.';

class ApiErr extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function parseDetails(s) {
  if (s == null) return null;
  try { return JSON.parse(s); } catch (_e) { return s; }
}
function likeEscape(s) { return String(s).replace(/[\\%_]/g, (c) => '\\' + c); }
function getPath(obj, dotted) {
  let cur = obj;
  for (const k of dotted.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}
function setPath(obj, dotted, val) {
  const ks = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[ks[i]];
  }
  if (cur && typeof cur === 'object') cur[ks[ks.length - 1]] = val;
}
function utcDayStart(t) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * createApi({db, state, ingest, rcon, bus, auth, admin, config, parserHealth, version,
 *            demoCli, runtime, battlemetrics})
 *   -> http.Server (caller listens; server.close() tears down SSE + bus wiring).
 */
function createApi(deps) {
  const {
    db, state, ingest, rcon, bus, auth, admin, config, parserHealth, version, demoCli, runtime, battlemetrics,
  } = deps || {};
  const cfg = config || {};
  const web = cfg.web || {};
  const trustProxy = web.trustProxy === true; // §19.3.19, default false
  const pubDir = path.resolve((deps && deps.publicDir) || path.join(__dirname, '..', 'public'));
  // A live panel serves the public/ it booted with: files edited in this tree
  // reach browsers only on restart, together with the server code they are
  // written against. Without the option every request reads the disk.
  const staticFiles = deps && deps.staticSnapshot === true ? snapshotStatic(pubDir) : null;
  const ph = parserHealth && typeof parserHealth.count24h === 'function'
    ? parserHealth : { count24h: () => 0, samples: () => [] };
  const AUDIT_ACTIONS = new Set([
    ...((admin && Array.isArray(admin.actions)) ? admin.actions : ACTION_NAMES),
    'setNextLayer', 'unban', 'note', 'watch', 'manual-flag', 'flag-review',
    'user-create', 'user-update', 'setup',
    'role-create', 'role-update', 'role-delete',
    'invite-create', 'invite-revoke', 'invite-use',
    'settings-update', 'settings-test',
    'quick-command', 'quick-commands-update', 'bm-import', 'ban-enforce',
    // docs/BATCH3-CONTRACTS.md
    'evidence-upload', 'evidence-delete', 'ban-note-update', 'templates-update',
    'remote-bans-rotate', 'remote-bans-update',
    'schedule-create', 'schedule-update', 'schedule-delete', 'scheduled-run',
    'admin-call-reply', 'admin-call-handled', 'join-alert-kick',
  ]);

  // ------------------------------------------------------- secret redaction
  // Read live on every scrub: the settings API can change secrets at runtime,
  // and a snapshot would leave the new values unscrubbed.
  function secretVals() {
    return REDACT_PATHS
      .map((p) => getPath(cfg, p))
      .filter((v) => typeof v === 'string' && v.length >= 3);
  }

  function scrubText(s) {
    let out = String(s == null ? '' : s);
    for (const v of secretVals()) if (out.includes(v)) out = out.split(v).join(REDACTED);
    return out;
  }
  function scrubDeep(x) {
    if (x == null) return x;
    if (typeof x === 'string') return scrubText(x);
    if (Array.isArray(x)) return x.map(scrubDeep);
    if (typeof x === 'object') {
      const o = {};
      for (const k of Object.keys(x)) o[k] = scrubDeep(x[k]);
      return o;
    }
    return x;
  }
  function redactedConfig() {
    let clone;
    try { clone = JSON.parse(JSON.stringify(cfg)); } catch (_e) { clone = {}; }
    for (const p of REDACT_PATHS) {
      const v = getPath(clone, p);
      if (typeof v === 'string' && v.length > 0) setPath(clone, p, REDACTED);
    }
    return clone;
  }

  // ------------------------------------------------------------ live status
  let lastLogStatus = null; // cached from 'log-status' bus events

  function rconStatus() {
    try {
      const s = rcon ? rcon.status : null;
      if (!s) return null;
      return {
        connected: !!s.connected, authed: !!s.authed,
        lastError: s.lastError == null ? null : scrubText(String(s.lastError)),
        since: s.since == null ? null : s.since,
      };
    } catch (_e) { return null; }
  }
  function logStatusOut() {
    if (lastLogStatus) return scrubDeep(lastLogStatus);
    return { mode: (cfg.log && cfg.log.mode) || 'local', ok: null };
  }
  function statusPayload() { return { rcon: rconStatus(), log: logStatusOut() }; }
  function snapshot() {
    try { return state && typeof state.snapshot === 'function' ? state.snapshot() : null; }
    catch (_e) { return null; }
  }
  function liveDbIdSet() {
    const set = new Set();
    try {
      if (state && state.players && typeof state.players.values === 'function') {
        for (const rec of state.players.values()) {
          if (rec && Number.isInteger(Number(rec.dbId)) && rec.dbId) set.add(Number(rec.dbId));
        }
      }
    } catch (_e) { /* state unavailable */ }
    return set;
  }

  // -------------------------------------------------------- request helpers
  function clientIp(req) {
    if (trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (xff) {
        const parts = String(xff).split(',');
        const last = parts[parts.length - 1].trim();
        if (last) return last; // last X-Forwarded-For hop (§19.3.19)
      }
    }
    return (req.socket && req.socket.remoteAddress) || '';
  }
  function cookieSecure(req) {
    if (web.secureCookies === true) return true;
    if (web.secureCookies === false) return false;
    // "auto": Secure iff TLS socket or trusted x-forwarded-proto: https (§2, §19.3.19)
    if (req.socket && req.socket.encrypted) return true;
    if (trustProxy) {
      const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
      if (proto === 'https') return true;
    }
    return false;
  }
  function setSessionCookie(res, req, token, maxAge) {
    const ma = maxAge == null ? COOKIE_MAX_AGE : maxAge;
    let c = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ma}`;
    if (cookieSecure(req)) c += '; Secure';
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : c);
  }
  function getCookie(req, name) {
    const h = req.headers.cookie;
    if (!h) return null;
    for (const part of String(h).split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
  }
  function json(res, status, obj) {
    if (res.headersSent) { try { res.end(); } catch (_e) { /* gone */ } return; }
    const body = JSON.stringify(obj == null ? {} : obj);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    if (status === 413) res.setHeader('Connection', 'close');
    res.statusCode = status;
    res.end(body);
  }

  // §19.3.20 — exact CSRF algorithm. Returns null when OK, else a reason.
  function csrfCheck(req) {
    let v = req.headers.origin;
    if (v == null || v === '') v = req.headers.referer;
    if (v == null || v === '') return 'missing Origin/Referer header';
    if (v === 'null') return "Origin 'null' rejected";
    let host;
    try { host = new URL(String(v)).host; } catch (_e) { return 'malformed Origin/Referer'; }
    if (host && host === req.headers.host) return null;
    if (web.publicUrl) {
      try { if (host && host === new URL(String(web.publicUrl)).host) return null; } catch (_e) { /* bad publicUrl */ }
    }
    return 'cross-origin request rejected';
  }
  function isJsonContentType(req) {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    return ct === 'application/json';
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const cl = Number(req.headers['content-length']);
      if (Number.isFinite(cl) && cl > BODY_LIMIT) { reject(new ApiErr(413, 'body too large (64KB max)')); return; }
      let size = 0;
      let done = false;
      const chunks = [];
      req.on('data', (c) => {
        if (done) return;
        size += c.length;
        if (size > BODY_LIMIT) { done = true; reject(new ApiErr(413, 'body too large (64KB max)')); return; }
        chunks.push(c);
      });
      req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
      req.on('error', (e) => { if (!done) { done = true; reject(e); } });
    });
  }

  // §19.3.21 — pagination clamps.
  function pageOf(q, defPer) {
    const per = clampInt(q.get('per'), 1, 200, defPer == null ? 50 : defPer);
    const page = clampInt(q.get('page'), 0, 1000000, 0);
    return { per, page, offset: page * per };
  }
  // §19.3.21 — "[all]" lists: LIMIT 2000 + total + truncated.
  function cappedAll(rowsSql, countSql, params, mapRow) {
    const rows = db.prepare(`${rowsSql} LIMIT ${CAP}`).all(...params);
    const crow = db.prepare(countSql).get(...params);
    const total = crow ? Number(crow.c) : rows.length;
    return { total, truncated: total > rows.length, rows: mapRow ? rows.map(mapRow) : rows };
  }

  function intParam(v, name) {
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > 999999999) throw new ApiErr(400, `invalid ${name}`);
    return n;
  }
  function strBody(v, name, { max = 480, required = true } = {}) {
    if (v == null || v === '') {
      if (required) throw new ApiErr(400, `${name} required`);
      return null;
    }
    if (typeof v !== 'string') throw new ApiErr(400, `${name} must be a string`);
    return v.slice(0, max);
  }

  // viewer intel exclusion (§19.3.23): admin-channel chat is excluded from
  // every viewer-facing read. `alias` is the chat table alias in the query.
  function viewerChatCond(user, alias) {
    if (auth.can(user, 'adminChat')) return '';
    return ` AND (${alias}.channel IS NULL OR ${alias}.channel <> 'admin')`;
  }

  // ------------------------------------------------------------ row mappers
  function killRow(r) {
    return {
      id: r.id, time: r.time, matchId: r.match_id, kind: r.kind,
      attacker: (r.attacker_id != null || r.attacker_name != null)
        ? { id: r.attacker_id, name: r.attacker_name } : null,
      victim: (r.victim_id != null || r.victim_name != null)
        ? { id: r.victim_id, name: r.victim_name } : null,
      weapon: r.weapon, damage: r.damage, teamkill: !!r.teamkill, suicide: !!r.suicide,
    };
  }
  const KILL_SELECT = `SELECT k.id, k.time, k.match_id, k.kind, k.weapon, k.damage, k.teamkill, k.suicide,
      k.attacker_id, a.name AS attacker_name, k.victim_id, v.name AS victim_name
    FROM kills k LEFT JOIN players a ON a.id = k.attacker_id LEFT JOIN players v ON v.id = k.victim_id`;

  function chatRow(r) {
    return {
      id: r.id, time: r.time, matchId: r.match_id, channel: r.channel,
      player: { id: r.player_id, name: r.player_name }, message: r.message,
    };
  }
  function flagRow(r) {
    return {
      id: r.id, playerId: r.player_id, playerName: r.player_name == null ? null : r.player_name,
      time: r.time, type: r.type, severity: r.severity, matchId: r.match_id,
      details: parseDetails(r.details), reviewed: !!r.reviewed,
      reviewedBy: r.reviewed_by == null ? null : r.reviewed_by,
      reviewedAt: r.reviewed_at == null ? null : r.reviewed_at,
      reviewNote: r.review_note == null ? null : r.review_note,
    };
  }
  // A ban-evasion flag names the banned account its player shares an IP
  // with — an alt-account link, which only the `ips` permission may see.
  function redactFlag(flag, user) {
    if (!flag || flag.type !== 'ban-evasion' || auth.can(user, 'ips')) return flag;
    const d = flag.details && typeof flag.details === 'object' ? flag.details : {};
    return { ...flag, details: { reason: typeof d.reason === 'string' ? d.reason : 'Shares an IP address with a banned player', redacted: true } };
  }
  function flagRowsFor(user) {
    return (r) => redactFlag(flagRow(r), user);
  }
  // Join alerts' auto-kick of an evader is audited with that same link (the
  // banned account and its ban): in audit rows too, stored ones included,
  // only `ips` sees it.
  function auditDetailsFor(r, user) {
    const details = parseDetails(r.details);
    if (r.action !== 'join-alert-kick' || auth.can(user, 'ips')) return details;
    const d = details && typeof details === 'object' ? details : {};
    return {
      flagId: d.flagId == null ? null : d.flagId,
      reason: typeof d.reason === 'string' ? d.reason : null,
      redacted: true,
    };
  }
  // canSeeNotes: the private staff note (BATCH3 §2) only reaches roles that
  // can ban — it may hold evidence links and alt intel.
  function banRow(nowT, canSeeNotes) {
    return (r) => ({
      ...(canSeeNotes ? { note: r.note == null ? null : r.note } : {}),
      evidenceCount: r.evidence_count == null ? 0 : Number(r.evidence_count),
      id: r.id, playerId: r.player_id,
      playerName: r.player_name == null ? null : r.player_name,
      steamId: r.steam_id || r.p_steam || null,
      issuedBy: r.issued_by, issuer: r.issuer == null ? null : r.issuer,
      issuedAt: r.issued_at, durationSec: r.duration_sec, expiresAt: r.expires_at,
      reason: r.reason, intervalRaw: r.interval_raw, active: !!r.active,
      expired: r.expires_at != null && r.expires_at <= nowT,
      rconOk: r.rcon_ok == null ? null : !!r.rcon_ok,
      unbannedBy: r.unbanned_by == null ? null : r.unbanned_by,
      unbannedAt: r.unbanned_at == null ? null : r.unbanned_at,
      // NEXT-CONTRACTS §3: null source = issued in this panel.
      source: r.source == null ? null : r.source,
      eosId: r.eos_id == null ? null : r.eos_id,
    });
  }
  function matchRowMap(r) {
    return {
      id: r.id, layer: r.layer, level: r.level, layerClass: r.layer_class,
      team1: r.team1, team2: r.team2, startedAt: r.started_at,
      inProgressAt: r.in_progress_at, endedAt: r.ended_at,
      winnerTeam: r.winner_team, winnerFaction: r.winner_faction, tickets: r.tickets,
    };
  }
  function deployableRowMap(r) {
    return {
      id: r.id, matchId: r.match_id, time: r.time,
      playerId: r.player_id, playerName: r.player_name == null ? null : r.player_name,
      playerTeam: r.player_team, deployable: r.deployable, category: r.category,
      depFaction: r.dep_faction, friendly: r.friendly, damage: r.damage,
      weapon: r.weapon, damageType: r.damage_type, healthRemaining: r.health_remaining,
    };
  }
  function playerFullMap(r) {
    return {
      id: r.id, eosId: r.eos_id, steamId: r.steam_id, name: r.name,
      firstSeen: r.first_seen, lastSeen: r.last_seen, playSeconds: r.play_seconds,
      kills: r.kills, deaths: r.deaths, teamkills: r.teamkills, tkDeaths: r.tk_deaths,
      suicides: r.suicides, revivesGiven: r.revives_given, revivesTaken: r.revives_taken,
      radioDamageFriendly: r.radio_damage_friendly, radioDamageEnemy: r.radio_damage_enemy,
      habDamageFriendly: r.hab_damage_friendly, habDamageEnemy: r.hab_damage_enemy,
      deployableDamageUnknown: r.deployable_damage_unknown,
      avatar: r.avatar, watchlisted: !!r.watchlisted,
    };
  }

  // ------------------------------------------------------------------- SSE
  // §19.3.22: ONE bus listener per event type fanning out to a Set of client
  // responses; max 4 streams/user, 64 global; ': ping' heartbeat every 25s;
  // drop on write error or a stalled client; viewers never get admin-channel
  // chat or ADMIN_CAM data.
  const sse = {
    clients: new Set(), // { res, user }
    perUser: new Map(), // userId -> live stream count
    lastPlayersSent: 0,
    playersTimer: null,
    pingTimer: null,
  };
  function dropClient(client) {
    if (!sse.clients.has(client)) return;
    sse.clients.delete(client);
    const uid = client.user.id;
    const n = (sse.perUser.get(uid) || 1) - 1;
    if (n <= 0) sse.perUser.delete(uid); else sse.perUser.set(uid, n);
    try { client.res.end(); } catch (_e) { /* already gone */ }
  }
  // A stalled client must not grow server memory without bound, but write()
  // returning false only means one frame passed the socket's 16 KB mark — the
  // players snapshot of a full server alone does — so a healthy stream is
  // dropped only once this much sits unsent.
  const SSE_MAX_BUFFERED = 1024 * 1024;
  function sseWrite(client, text) {
    try {
      client.res.write(text);
      if (client.res.writableLength > SSE_MAX_BUFFERED) dropClient(client);
    } catch (_e) {
      dropClient(client);
    }
  }
  function allowedFor(client, event, data) {
    // Admin-channel chat and ADMIN_CAM intel need the adminChat permission
    // (custom roles make "not a viewer" meaningless as a privilege test).
    if (event === 'chat' && data && data.channel === 'admin') return auth.can(client.user, 'adminChat');
    if (data && data.kind === 'ADMIN_CAM') return auth.can(client.user, 'adminChat');
    // Admin calls and join alerts go to people who can act on them; join
    // alerts may describe ban-evasion links.
    if (event === 'admincall') return ['flags', 'warn', 'kick', 'ban'].some((p) => auth.can(client.user, p));
    if (event === 'alert') return ['flags', 'ban'].some((p) => auth.can(client.user, p));
    return true;
  }
  function sseBroadcast(event, data) {
    if (sse.clients.size === 0) return;
    const frame = (d) => `event: ${event}\ndata: ${JSON.stringify(d == null ? null : d)}\n\n`;
    const full = frame(data);
    const redactable = (event === 'flag' || event === 'alert') && data && data.type === 'ban-evasion';
    let redacted = null;
    for (const client of [...sse.clients]) {
      if (!allowedFor(client, event, data)) continue;
      if (redactable && !auth.can(client.user, 'ips')) {
        if (redacted == null) redacted = frame(redactFlag(data, client.user));
        sseWrite(client, redacted);
      } else {
        sseWrite(client, full);
      }
    }
  }
  function sendPlayersSnapshot() {
    sse.lastPlayersSent = Date.now();
    sseBroadcast('players', snapshot());
  }
  function schedulePlayersSnapshot() {
    if (sse.clients.size === 0) return;
    const since = Date.now() - sse.lastPlayersSent;
    if (since >= 5000) { sendPlayersSnapshot(); return; }
    if (sse.playersTimer) return;
    sse.playersTimer = setTimeout(() => {
      sse.playersTimer = null;
      sendPlayersSnapshot();
    }, 5000 - since);
  }

  const busWiring = [
    ['kill', (p) => sseBroadcast('kill', p)],
    ['chat', (p) => sseBroadcast('chat', p)],
    ['deployable', (p) => sseBroadcast('deployable', p)],
    ['flag', (p) => sseBroadcast('flag', p)],
    ['revive', (p) => sseBroadcast('revive', p)], // §19.1.6
    ['player-connected', (p) => sseBroadcast('connect', p)],
    ['player-disconnected', (p) => sseBroadcast('disconnect', p)],
    ['players-updated', () => schedulePlayersSnapshot()],
    ['match-start', (p) => sseBroadcast('match', Object.assign({ type: 'start' }, p))],
    ['match-end', (p) => sseBroadcast('match', Object.assign({ type: 'end' }, p))],
    ['match-state', (p) => sseBroadcast('match', Object.assign({ type: 'state' }, p))],
    ['serverinfo-updated', (p) => sseBroadcast('serverinfo', p || (state && state.serverInfo) || null)],
    ['tick-rate', (p) => sseBroadcast('tick', p)],
    ['rcon-status', () => sseBroadcast('status', statusPayload())],
    ['log-status', (s) => { lastLogStatus = s; sseBroadcast('status', statusPayload()); }],
    ['broadcast', (p) => sseBroadcast('broadcast', p)],
    ['pop-sample', (p) => sseBroadcast('pop', p)],
    // docs/BATCH3-CONTRACTS.md §6/§7: new and updated admin calls, join alerts.
    ['admin-call', (p) => sseBroadcast('admincall', p)],
    ['join-alert', (p) => sseBroadcast('alert', p)],
    ['squad-created', (p) => sseBroadcast('squad', Object.assign({ type: 'created' }, p))],
    ['squad-disbanded', (p) => sseBroadcast('squad', Object.assign({ type: 'disbanded' }, p))],
    ['squad-disbanded-admin', (p) => sseBroadcast('squad', Object.assign({ type: 'disbanded' }, p))],
  ];
  if (bus) for (const [ev, fn] of busWiring) bus.on(ev, fn);

  function dropUserStreams(userId) {
    for (const client of [...sse.clients]) {
      if (client.user && client.user.id === userId) dropClient(client);
    }
  }
  sse.pingTimer = setInterval(() => {
    for (const client of [...sse.clients]) {
      // Re-check the account on every ping so role changes and disables take
      // effect on long-lived streams, not just on new requests (§19.3.18).
      try {
        const row = db.prepare(
          `SELECT u.disabled, r.id AS role_id, r.name AS role, r.perms AS perms
             FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
        ).get(client.user.id);
        if (!row || Number(row.disabled) === 1) { dropClient(client); continue; }
        client.user.role = row.role;
        client.user.roleId = row.role_id;
        client.user.perms = auth.parsePerms(row.role_id, row.perms);
      } catch (_e) { /* keep the stream on transient db errors */ }
      sseWrite(client, ': ping\n\n');
    }
  }, 25000);
  if (typeof sse.pingTimer.unref === 'function') sse.pingTimer.unref();

  function hStream(ctx) {
    const uid = ctx.user.id;
    const cur = sse.perUser.get(uid) || 0;
    if (cur >= 4 || sse.clients.size >= 64) {
      return json(ctx.res, 503, { error: 'too many concurrent streams' });
    }
    const res = ctx.res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ snapshot: snapshot(), me: ctx.user })}\n\n`);
    const client = { res, user: ctx.user };
    sse.clients.add(client);
    sse.perUser.set(uid, cur + 1);
    ctx.req.on('close', () => dropClient(client));
  }

  // ---------------------------------------------------------- auth handlers
  function tooManyAttempts(ctx, lim, message) {
    ctx.res.setHeader('Retry-After', String(lim.retryAfterSec || 60));
    return json(ctx.res, 429, { error: message });
  }

  async function hLogin(ctx) {
    const lim = auth.loginLimiter.attempt(ctx.ip);
    if (!lim.ok) return tooManyAttempts(ctx, lim, 'too many login attempts — try again shortly');
    const username = strBody(ctx.body.username, 'username', { max: 64 });
    const password = strBody(ctx.body.password, 'password', { max: 1024 });
    // A locked username gets this same 429 before any check, right password
    // or not; unknown names lock exactly like real ones. Claimed before the
    // await, so concurrent guesses cannot all pass a name one failure short
    // of its lock.
    const claim = auth.loginLimiter.claimUser(username);
    if (!claim.ok) return tooManyAttempts(ctx, claim, 'too many login attempts — try again shortly');
    let user;
    try {
      user = await auth.verifyLogin(username, password);
    } catch (e) {
      claim.release(); // verifyLogin resolves null for every failed check, so a throw is never one
      if (!e || e.code !== 'ELOGINBUSY') throw e;
      ctx.res.setHeader('Retry-After', String(e.retryAfterSec || 1));
      return json(ctx.res, 503, { error: 'busy checking other sign-ins — try again in a moment' });
    }
    if (!user) {
      claim.fail();
      return json(ctx.res, 401, { error: 'invalid username or password' });
    }
    claim.succeed();
    const sess = auth.createSession(user.id, {
      ip: ctx.ip, ua: String(ctx.req.headers['user-agent'] || '').slice(0, 256),
    });
    setSessionCookie(ctx.res, ctx.req, sess.token);
    return json(ctx.res, 200, { ok: true, user });
  }
  function hLogout(ctx) {
    if (ctx.token) auth.destroySession(ctx.token);
    if (ctx.user) dropUserStreams(ctx.user.id);
    setSessionCookie(ctx.res, ctx.req, '', 0);
    return json(ctx.res, 200, { ok: true });
  }
  function hBootstrap(ctx) {
    const out = {
      needsSetup: auth.needsSetup(),
      serverName: (state && state.serverInfo && state.serverInfo.serverName) || null,
      version: version == null ? null : version,
    };
    // §19.3.15: only the --demo CLI flag (never config.json) exposes the
    // setup token here; demoCli is passed by index.js and cannot be set from config.
    if (demoCli === true && out.needsSetup && auth.setupToken) out.setupToken = auth.setupToken;
    return json(ctx.res, 200, out);
  }
  function hSetup(ctx) {
    const lim = auth.loginLimiter.attempt(ctx.ip); // rate-limited like login (§19.3.15)
    if (!lim.ok) return tooManyAttempts(ctx, lim, 'too many attempts — try again shortly');
    const username = strBody(ctx.body.username, 'username', { max: 64 });
    const password = strBody(ctx.body.password, 'password', { max: 1024 });
    const token = strBody(ctx.body.setupToken, 'setupToken', { max: 256 });
    if (!auth.needsSetup()) return json(ctx.res, 403, { error: 'setup already completed' });
    if (!auth.verifySetupToken(token)) {
      return json(ctx.res, 403, { error: 'invalid setup token (printed in the server console at boot)' });
    }
    let user;
    try {
      user = auth.createFirstOwner({ username, password });
    } catch (e) {
      return json(ctx.res, 400, { error: e.message });
    }
    auth.audit(user.id, 'setup', { details: { username: user.username, role: 'owner' } });
    return json(ctx.res, 200, { ok: true });
  }
  function hMe(ctx) { return json(ctx.res, 200, { user: ctx.user }); }

  // ---------------------------------------------------------- data handlers
  function hOverview(ctx) {
    const nowT = Date.now();
    const dayStart = utcDayStart(nowT);
    const count = (sql, ...p) => { const r = db.prepare(sql).get(...p); return r ? Number(r.c) : 0; };
    const counters = {
      playersTotal: count('SELECT COUNT(*) AS c FROM players'),
      matchesTotal: count('SELECT COUNT(*) AS c FROM matches'),
      flagsOpen: count('SELECT COUNT(*) AS c FROM flags WHERE reviewed = 0'),
      bansActive: count('SELECT COUNT(*) AS c FROM bans WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)', nowT),
      // §19.1.7
      tksToday: count("SELECT COUNT(*) AS c FROM kills WHERE teamkill = 1 AND kind = 'wound' AND time >= ?", dayStart),
    };
    const kills = db.prepare(`${KILL_SELECT} WHERE k.kind = 'wound' ORDER BY k.id DESC LIMIT 25`).all().map(killRow);
    const chat = db.prepare(
      `SELECT c.id, c.time, c.match_id, c.channel, c.message, c.player_id, p.name AS player_name
         FROM chat c LEFT JOIN players p ON p.id = c.player_id
        WHERE 1=1${viewerChatCond(ctx.user, 'c')} ORDER BY c.id DESC LIMIT 25`
    ).all().map(chatRow);
    const flags = db.prepare(
      `SELECT f.*, p.name AS player_name FROM flags f LEFT JOIN players p ON p.id = f.player_id
        WHERE f.reviewed = 0 ORDER BY f.id DESC LIMIT 10`
    ).all().map(flagRowsFor(ctx.user));
    return json(ctx.res, 200, {
      status: {
        rcon: rconStatus(), log: logStatusOut(),
        tickRate: state && state.tickRate != null ? state.tickRate : null,
        serverInfo: (state && state.serverInfo) || null,
      },
      snapshot: snapshot(),
      counters,
      recent: { kills, chat, flags },
    });
  }

  // GET /api/live/feed — backfill for the Live page's unified feed: recent
  // kills, chat (viewer-filtered), squad created/disbanded, joins/leaves,
  // merged newest-first. Live updates then ride the SSE stream.
  function hLiveFeed(ctx) {
    const limit = clampInt(ctx.query.get('limit'), 10, 300, 120);
    const out = [];
    const kills = db.prepare(`${KILL_SELECT} WHERE k.kind = 'wound' ORDER BY k.id DESC LIMIT ?`).all(limit).map(killRow);
    for (const k of kills) out.push({ t: k.time, kind: 'kill', data: k });
    const chat = db.prepare(
      `SELECT c.id, c.time, c.match_id, c.channel, c.message, c.player_id, p.name AS player_name
         FROM chat c LEFT JOIN players p ON p.id = c.player_id
        WHERE 1=1${viewerChatCond(ctx.user, 'c')} ORDER BY c.id DESC LIMIT ?`
    ).all(limit).map(chatRow);
    for (const c of chat) out.push({ t: c.time, kind: 'chat', data: c });
    const squads = db.prepare(
      `SELECT se.*, u.username AS by_username FROM squad_events se
         LEFT JOIN users u ON u.id = se.by_user ORDER BY se.id DESC LIMIT ?`
    ).all(limit);
    for (const s of squads) {
      out.push({
        t: s.time, kind: 'squad',
        data: {
          type: s.type, time: s.time, teamId: s.team_id, squadId: s.squad_id, name: s.name,
          creatorName: s.player_name, creatorDbId: s.player_id, byUser: s.by_username || null,
        },
      });
    }
    // Connects: session rows are created at connect, so id order IS connect
    // order. Disconnects: disconnect_at is updated in place on old rows, so
    // they need their own query (and index) or long sessions' leavers vanish
    // from the backfill.
    const conns = db.prepare(
      `SELECT s.connect_at, s.player_id, p.name AS name FROM sessions s
         LEFT JOIN players p ON p.id = s.player_id ORDER BY s.id DESC LIMIT ?`
    ).all(limit);
    for (const s of conns) {
      if (s.connect_at != null) out.push({ t: s.connect_at, kind: 'connect', data: { time: s.connect_at, playerDbId: s.player_id, name: s.name } });
    }
    const disc = db.prepare(
      `SELECT s.disconnect_at, s.player_id, p.name AS name FROM sessions s
         LEFT JOIN players p ON p.id = s.player_id
        WHERE s.disconnect_at IS NOT NULL ORDER BY s.disconnect_at DESC LIMIT ?`
    ).all(limit);
    for (const s of disc) {
      out.push({ t: s.disconnect_at, kind: 'disconnect', data: { time: s.disconnect_at, playerDbId: s.player_id, name: s.name } });
    }
    out.sort((a, b) => b.t - a.t);
    return json(ctx.res, 200, { rows: out.slice(0, limit) });
  }

  function hPop(ctx) {
    const hours = clampInt(ctx.query.get('hours'), 1, 720, 24); // §19.3.21
    const since = Date.now() - hours * 3600 * 1000;
    const rows = db.prepare(
      'SELECT time, players, queue, tick_rate FROM pop_samples WHERE time >= ? ORDER BY time'
    ).all(since);
    return json(ctx.res, 200, { samples: rows.map((r) => [r.time, r.players, r.queue, r.tick_rate]) });
  }

  function hPlayers(ctx) {
    const q = ctx.query;
    const sortKey = q.get('sort') || 'last_seen';
    const sortCol = PLAYER_SORT[sortKey];
    if (!sortCol) throw new ApiErr(400, 'unknown sort key');
    const dirKey = (q.get('dir') || 'desc').toLowerCase();
    const dir = SORT_DIR[dirKey];
    if (!dir) throw new ApiErr(400, 'unknown sort direction');
    const filter = q.get('filter') || '';
    if (filter && !PLAYER_FILTERS.has(filter)) throw new ApiErr(400, 'unknown filter');
    const { per, offset } = pageOf(q, 50);
    const nowT = Date.now();
    const where = [];
    const whereParams = [];
    const qstr = (q.get('q') || '').trim().slice(0, 128);
    if (qstr) {
      where.push("(p.name LIKE ? ESCAPE '\\' OR p.steam_id = ? OR p.eos_id = ?)");
      whereParams.push(`%${likeEscape(qstr)}%`, qstr, qstr.toLowerCase());
    }
    const liveIds = filter === 'online' ? [...liveDbIdSet()] : null;
    if (filter === 'online') {
      if (!liveIds.length) return json(ctx.res, 200, { total: 0, rows: [] });
      where.push(`p.id IN (${liveIds.map(() => '?').join(',')})`);
      whereParams.push(...liveIds);
    } else if (filter === 'flagged') {
      where.push('EXISTS(SELECT 1 FROM flags f WHERE f.player_id = p.id AND f.reviewed = 0)');
    } else if (filter === 'watchlisted') {
      where.push('p.watchlisted = 1');
    } else if (filter === 'banned') {
      where.push('EXISTS(SELECT 1 FROM bans b WHERE b.player_id = p.id AND b.active = 1 AND (b.expires_at IS NULL OR b.expires_at > ?))');
      whereParams.push(nowT);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(
      `SELECT p.id, p.name, p.eos_id, p.steam_id, p.last_seen, p.first_seen, p.play_seconds,
              p.kills, p.deaths, p.teamkills, p.tk_deaths,
              p.radio_damage_friendly, p.hab_damage_friendly, p.watchlisted,
              (SELECT COUNT(*) FROM flags f WHERE f.player_id = p.id AND f.reviewed = 0) AS flags_open,
              EXISTS(SELECT 1 FROM bans b WHERE b.player_id = p.id AND b.active = 1
                     AND (b.expires_at IS NULL OR b.expires_at > ?)) AS banned_active
         FROM players p${whereSql}
        ORDER BY p.${sortCol} ${dir}, p.id DESC LIMIT ? OFFSET ?`
    ).all(nowT, ...whereParams, per, offset);
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM players p${whereSql}`).get(...whereParams);
    const liveSet = liveDbIdSet();
    return json(ctx.res, 200, {
      total: totalRow ? Number(totalRow.c) : 0,
      rows: rows.map((r) => ({
        id: r.id, name: r.name, eosId: r.eos_id, steamId: r.steam_id,
        lastSeen: r.last_seen, firstSeen: r.first_seen, playSeconds: r.play_seconds,
        kills: r.kills, deaths: r.deaths, teamkills: r.teamkills, tkDeaths: r.tk_deaths,
        radioFriendly: r.radio_damage_friendly, habFriendly: r.hab_damage_friendly,
        flagsOpen: r.flags_open, online: liveSet.has(r.id),
        watchlisted: !!r.watchlisted, bannedActive: !!r.banned_active,
      })),
    });
  }

  function hPlayer(ctx) {
    const id = intParam(ctx.params[1], 'player id');
    const row = db.prepare('SELECT * FROM players WHERE id = ?').get(id);
    if (!row) throw new ApiErr(404, 'player not found');
    const isAdmin = auth.can(ctx.user, 'ips');
    const liveSet = liveDbIdSet();
    const online = liveSet.has(id);
    const openSession = db.prepare(
      'SELECT id, connect_at FROM sessions WHERE player_id = ? AND disconnect_at IS NULL ORDER BY id DESC LIMIT 1'
    ).get(id);
    const out = {
      player: playerFullMap(row),
      names: db.prepare(
        'SELECT name, first_used, last_used FROM player_names WHERE player_id = ? ORDER BY last_used DESC LIMIT 2000'
      ).all(id).map((r) => ({ name: r.name, firstUsed: r.first_used, lastUsed: r.last_used })),
      online,
      session: openSession ? { id: openSession.id, connectAt: openSession.connect_at } : null,
      sessions: db.prepare(
        'SELECT id, connect_at, disconnect_at FROM sessions WHERE player_id = ? ORDER BY id DESC LIMIT 50'
      ).all(id).map((r) => ({ id: r.id, connectAt: r.connect_at, disconnectAt: r.disconnect_at })),
      matches: db.prepare(
        `SELECT mp.match_id, m.layer, m.started_at, mp.team_id, mp.kills, mp.deaths,
                mp.teamkills, mp.revives, mp.damage_dealt
           FROM match_players mp JOIN matches m ON m.id = mp.match_id
          WHERE mp.player_id = ? ORDER BY m.started_at DESC LIMIT 2000`
      ).all(id).map((r) => ({
        matchId: r.match_id, layer: r.layer, startedAt: r.started_at, teamId: r.team_id,
        kills: r.kills, deaths: r.deaths, teamkills: r.teamkills, revives: r.revives, damage: r.damage_dealt,
      })),
      recentKills: db.prepare(
        `${KILL_SELECT} WHERE k.attacker_id = ? AND k.kind = 'wound' ORDER BY k.id DESC LIMIT 50`
      ).all(id).map(killRow),
      recentDeaths: db.prepare(
        `${KILL_SELECT} WHERE k.victim_id = ? AND k.kind = 'wound' ORDER BY k.id DESC LIMIT 50`
      ).all(id).map(killRow),
      // §19.3.21 — "[all]" lists are capped + wrapped.
      tkIncidents: cappedAll(
        `${KILL_SELECT} WHERE k.teamkill = 1 AND k.kind = 'wound' AND (k.attacker_id = ? OR k.victim_id = ?) ORDER BY k.time DESC`,
        "SELECT COUNT(*) AS c FROM kills k WHERE k.teamkill = 1 AND k.kind = 'wound' AND (k.attacker_id = ? OR k.victim_id = ?)",
        [id, id], killRow
      ),
      deployableDamage: cappedAll(
        `SELECT d.*, NULL AS player_name FROM deployable_damage d WHERE d.player_id = ? ORDER BY d.time DESC`,
        'SELECT COUNT(*) AS c FROM deployable_damage d WHERE d.player_id = ?',
        [id], deployableRowMap
      ),
      chatCount: (() => {
        const r = db.prepare(`SELECT COUNT(*) AS c FROM chat c WHERE c.player_id = ?${viewerChatCond(ctx.user, 'c')}`).get(id);
        return r ? Number(r.c) : 0;
      })(),
      flags: db.prepare(
        'SELECT f.*, NULL AS player_name FROM flags f WHERE f.player_id = ? ORDER BY f.id DESC LIMIT 2000'
      ).all(id).map(flagRowsFor(ctx.user)),
      warnings: db.prepare(
        `SELECT w.id, w.player_id, w.by_user, w.time, w.message, w.auto, u.username AS by_username
           FROM warnings w LEFT JOIN users u ON u.id = w.by_user
          WHERE w.player_id = ? ORDER BY w.id DESC LIMIT 2000`
      ).all(id).map((r) => ({
        id: r.id, playerId: r.player_id, byUser: r.by_user, byUsername: r.by_username == null ? null : r.by_username,
        time: r.time, message: r.message, auto: !!r.auto,
      })),
      bans: db.prepare(
        `SELECT b.*, NULL AS player_name, NULL AS p_steam, u.username AS issuer,
                ${EVIDENCE_COUNT_SQL}
           FROM bans b LEFT JOIN users u ON u.id = b.issued_by
          WHERE b.player_id = ? ORDER BY b.id DESC LIMIT 2000`
      ).all(id).map(banRow(Date.now(), auth.can(ctx.user, 'ban'))),
      // Warn/kick/ban actions with their evidence counts, for people who act
      // on or audit them (the audit log's row shape).
      ...(['audit', 'warn', 'kick', 'ban'].some((p) => auth.can(ctx.user, p)) ? {
        actions: db.prepare(
          `SELECT a.id, a.time, a.action, a.details, a.rcon_ok, u.username,
                  (SELECT COUNT(*) FROM evidence e WHERE e.target_type = 'action'
                      AND e.target_id = a.id AND e.deleted_at IS NULL) AS evidence_count
             FROM admin_actions a LEFT JOIN users u ON u.id = a.user_id
            WHERE a.target_player_id = ? AND a.action IN ('warn', 'kick', 'ban')
            ORDER BY a.id DESC LIMIT 500`
        ).all(id).map((r) => ({
          id: r.id, time: r.time, action: r.action, details: parseDetails(r.details),
          username: r.username == null ? null : r.username,
          rconOk: r.rcon_ok == null ? null : !!r.rcon_ok,
          evidenceCount: r.evidence_count == null ? 0 : Number(r.evidence_count),
        })),
      } : {}),
      notes: db.prepare(
        `SELECT n.id, n.player_id, n.by_user, n.time, n.text, u.username AS by_username
           FROM player_notes n LEFT JOIN users u ON u.id = n.by_user
          WHERE n.player_id = ? ORDER BY n.id DESC LIMIT 2000`
      ).all(id).map((r) => ({
        id: r.id, playerId: r.player_id, byUser: r.by_user, byUsername: r.by_username == null ? null : r.by_username,
        time: r.time, text: r.text,
      })),
    };
    if (isAdmin) {
      // IPs exist ONLY here, for admin+ (§19.1.1, §19.3.23).
      out.ips = db.prepare(
        'SELECT ip, first_seen, last_seen, times FROM player_ips WHERE player_id = ? ORDER BY last_seen DESC LIMIT 2000'
      ).all(id).map((r) => ({ ip: r.ip, firstSeen: r.first_seen, lastSeen: r.last_seen, times: r.times }));
      out.alts = db.prepare(
        `SELECT p2.id AS player_id, p2.name, COUNT(DISTINCT i2.ip) AS shared
           FROM player_ips i1
           JOIN player_ips i2 ON i2.ip = i1.ip AND i2.player_id <> i1.player_id
           JOIN players p2 ON p2.id = i2.player_id
          WHERE i1.player_id = ?
          GROUP BY p2.id, p2.name ORDER BY shared DESC, p2.id LIMIT 50`
      ).all(id).map((r) => ({ playerId: r.player_id, name: r.name, sharedIps: Number(r.shared) }));
    }
    return json(ctx.res, 200, out);
  }

  function hPlayerChat(ctx) {
    const id = intParam(ctx.params[1], 'player id');
    const { per, offset } = pageOf(ctx.query, 100);
    const cond = viewerChatCond(ctx.user, 'c');
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM chat c WHERE c.player_id = ?${cond}`).get(id);
    const rows = db.prepare(
      `SELECT c.id, c.time, c.match_id, c.channel, c.message, c.player_id, p.name AS player_name
         FROM chat c LEFT JOIN players p ON p.id = c.player_id
        WHERE c.player_id = ?${cond} ORDER BY c.id DESC LIMIT ? OFFSET ?`
    ).all(id, per, offset);
    return json(ctx.res, 200, { total: totalRow ? Number(totalRow.c) : 0, rows: rows.map(chatRow) });
  }

  function hNoteAdd(ctx) {
    const id = intParam(ctx.params[1], 'player id');
    if (!db.prepare('SELECT id FROM players WHERE id = ?').get(id)) throw new ApiErr(404, 'player not found');
    const text = strBody(ctx.body.text, 'text', { max: 2000 });
    const t = Date.now();
    const r = db.prepare('INSERT INTO player_notes(player_id, by_user, time, text) VALUES(?,?,?,?)')
      .run(id, ctx.user.id, t, text);
    auth.audit(ctx.user.id, 'note', { targetPlayerId: id, details: { noteId: r.lastInsertRowid } });
    return json(ctx.res, 200, {
      ok: true,
      note: { id: r.lastInsertRowid, playerId: id, byUser: ctx.user.id, byUsername: ctx.user.username, time: t, text },
    });
  }

  function hWatch(ctx) {
    const id = intParam(ctx.params[1], 'player id');
    const on = ctx.body.on === true || ctx.body.on === 1;
    const r = db.prepare('UPDATE players SET watchlisted = ? WHERE id = ?').run(on ? 1 : 0, id);
    if (r.changes === 0) throw new ApiErr(404, 'player not found');
    auth.audit(ctx.user.id, 'watch', { targetPlayerId: id, details: { on } });
    return json(ctx.res, 200, { ok: true });
  }

  function hManualFlag(ctx) {
    const id = intParam(ctx.params[1], 'player id');
    if (!db.prepare('SELECT id FROM players WHERE id = ?').get(id)) throw new ApiErr(404, 'player not found');
    const raw = ctx.body.details;
    const text = typeof raw === 'string' ? raw.slice(0, 2000)
      : (raw == null ? '' : JSON.stringify(raw).slice(0, 2000));
    if (!text) throw new ApiErr(400, 'details required');
    const t = Date.now();
    const matchId = state && state.match && state.match.id != null ? state.match.id : null;
    const details = { text, by: ctx.user.username };
    let flagId = null;
    if (ingest && typeof ingest.insertFlag === 'function') {
      flagId = ingest.insertFlag({ type: 'manual', severity: 2, playerDbId: id, rec: null, matchId, time: t, details });
    } else {
      const r = db.prepare('INSERT INTO flags(player_id, time, type, severity, match_id, details) VALUES(?,?,?,?,?,?)')
        .run(id, t, 'manual', 2, matchId, JSON.stringify(details));
      flagId = r.lastInsertRowid;
      if (bus) bus.emit('flag', { time: t, flagId, type: 'manual', severity: 2, player: { dbId: id }, matchId, details });
    }
    auth.audit(ctx.user.id, 'manual-flag', { targetPlayerId: id, details: { flagId, text } });
    return json(ctx.res, 200, { ok: true, flagId });
  }

  function hMatches(ctx) {
    const { per, offset } = pageOf(ctx.query, 50);
    const totalRow = db.prepare('SELECT COUNT(*) AS c FROM matches').get();
    const rows = db.prepare(
      `SELECT m.*,
              (SELECT COUNT(*) FROM match_players mp WHERE mp.match_id = m.id) AS player_count,
              (SELECT COUNT(*) FROM kills k WHERE k.match_id = m.id AND k.kind = 'wound') AS kill_count,
              (SELECT COUNT(*) FROM kills k WHERE k.match_id = m.id AND k.kind = 'wound' AND k.teamkill = 1) AS tk_count
         FROM matches m ORDER BY m.id DESC LIMIT ? OFFSET ?`
    ).all(per, offset);
    return json(ctx.res, 200, {
      total: totalRow ? Number(totalRow.c) : 0,
      rows: rows.map((r) => Object.assign(matchRowMap(r), {
        players: Number(r.player_count), kills: Number(r.kill_count), teamkills: Number(r.tk_count),
      })),
    });
  }

  function hMatch(ctx) {
    const id = intParam(ctx.params[1], 'match id');
    const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(id);
    if (!m) throw new ApiErr(404, 'match not found');
    const scoreboard = db.prepare(
      `SELECT mp.player_id, p.name, p.steam_id, mp.team_id, mp.kills, mp.deaths, mp.teamkills,
              mp.tk_deaths, mp.revives, mp.damage_dealt
         FROM match_players mp LEFT JOIN players p ON p.id = mp.player_id
        WHERE mp.match_id = ? ORDER BY mp.team_id, mp.kills DESC, mp.player_id LIMIT 2000`
    ).all(id).map((r) => ({
      playerId: r.player_id, name: r.name, steamId: r.steam_id, teamId: r.team_id,
      kills: r.kills, deaths: r.deaths, teamkills: r.teamkills, tkDeaths: r.tk_deaths,
      revives: r.revives, damageDealt: r.damage_dealt,
    }));
    const kills = cappedAll(
      `${KILL_SELECT} WHERE k.match_id = ? ORDER BY k.id`,
      'SELECT COUNT(*) AS c FROM kills k WHERE k.match_id = ?',
      [id], killRow
    );
    const deployables = db.prepare(
      `SELECT d.*, p.name AS player_name FROM deployable_damage d
         LEFT JOIN players p ON p.id = d.player_id
        WHERE d.match_id = ? ORDER BY d.id LIMIT 2000`
    ).all(id).map(deployableRowMap);
    const chat = db.prepare(
      `SELECT c.id, c.time, c.match_id, c.channel, c.message, c.player_id, p.name AS player_name
         FROM chat c LEFT JOIN players p ON p.id = c.player_id
        WHERE c.match_id = ?${viewerChatCond(ctx.user, 'c')} ORDER BY c.id LIMIT 2000`
    ).all(id).map(chatRow);
    const flags = db.prepare(
      `SELECT f.*, p.name AS player_name FROM flags f LEFT JOIN players p ON p.id = f.player_id
        WHERE f.match_id = ? ORDER BY f.id LIMIT 2000`
    ).all(id).map(flagRowsFor(ctx.user));
    return json(ctx.res, 200, { match: matchRowMap(m), scoreboard, kills, deployables, chat, flags });
  }

  function hChat(ctx) {
    const q = ctx.query;
    const { per, offset } = pageOf(q, 100);
    const where = [];
    const params = [];
    const qstr = (q.get('q') || '').trim().slice(0, 128);
    if (qstr) { where.push("c.message LIKE ? ESCAPE '\\'"); params.push(`%${likeEscape(qstr)}%`); }
    const channel = q.get('channel') || '';
    if (channel) {
      if (!CHAT_CHANNELS.has(channel)) throw new ApiErr(400, 'unknown channel');
      if (channel === 'admin' && !auth.can(ctx.user, 'adminChat')) throw new ApiErr(403, 'forbidden');
      where.push('c.channel = ?');
      params.push(channel);
    }
    const pid = q.get('playerId');
    if (pid != null && pid !== '') { where.push('c.player_id = ?'); params.push(intParam(pid, 'playerId')); }
    let whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : ' WHERE 1=1';
    whereSql += viewerChatCond(ctx.user, 'c');
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM chat c${whereSql}`).get(...params);
    const rows = db.prepare(
      `SELECT c.id, c.time, c.match_id, c.channel, c.message, c.player_id, p.name AS player_name
         FROM chat c LEFT JOIN players p ON p.id = c.player_id${whereSql}
        ORDER BY c.id DESC LIMIT ? OFFSET ?`
    ).all(...params, per, offset);
    return json(ctx.res, 200, { total: totalRow ? Number(totalRow.c) : 0, rows: rows.map(chatRow) });
  }

  function hFlags(ctx) {
    const key = ctx.query.get('reviewed') || 'all';
    if (!(key in FLAGS_REVIEWED)) throw new ApiErr(400, 'reviewed must be 0, 1 or all');
    const cond = FLAGS_REVIEWED[key];
    const whereSql = cond ? ` WHERE ${cond}` : '';
    const { per, offset } = pageOf(ctx.query, 50);
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM flags f${whereSql}`).get();
    const rows = db.prepare(
      `SELECT f.*, p.name AS player_name FROM flags f LEFT JOIN players p ON p.id = f.player_id
        ${whereSql} ORDER BY f.id DESC LIMIT ? OFFSET ?`
    ).all(per, offset);
    return json(ctx.res, 200, { total: totalRow ? Number(totalRow.c) : 0, rows: rows.map(flagRowsFor(ctx.user)) });
  }

  function hFlagReview(ctx) {
    const id = intParam(ctx.params[1], 'flag id');
    const flag = db.prepare('SELECT id, player_id FROM flags WHERE id = ?').get(id);
    if (!flag) throw new ApiErr(404, 'flag not found');
    const note = strBody(ctx.body.note, 'note', { max: 2000, required: false });
    db.prepare('UPDATE flags SET reviewed = 1, reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ?')
      .run(ctx.user.id, Date.now(), note, id);
    auth.audit(ctx.user.id, 'flag-review', { targetPlayerId: flag.player_id, details: { flagId: id, note } });
    return json(ctx.res, 200, { ok: true });
  }

  function hTrolls(ctx) {
    const weekAgo = Date.now() - 7 * 86400 * 1000;
    const lb = (allSql, weekSql, params = []) => ({
      all: db.prepare(allSql).all(...params).map((r) => ({ id: r.id, name: r.name, value: Number(r.value) })),
      week: db.prepare(weekSql).all(weekAgo, ...params).map((r) => ({ id: r.id, name: r.name, value: Number(r.value) })),
    });
    // §19.1.8 — every leaderboard is {all, week}.
    const leaderboards = {
      teamkills: lb(
        'SELECT id, name, teamkills AS value FROM players WHERE teamkills > 0 ORDER BY value DESC, id LIMIT 20',
        `SELECT p.id, p.name, COUNT(*) AS value FROM kills k JOIN players p ON p.id = k.attacker_id
          WHERE k.teamkill = 1 AND k.kind = 'wound' AND k.time >= ?
          GROUP BY p.id, p.name ORDER BY value DESC, p.id LIMIT 20`
      ),
      radioFriendly: lb(
        'SELECT id, name, radio_damage_friendly AS value FROM players WHERE radio_damage_friendly > 0 ORDER BY value DESC, id LIMIT 20',
        `SELECT p.id, p.name, SUM(d.damage) AS value FROM deployable_damage d JOIN players p ON p.id = d.player_id
          WHERE d.category = 'radio' AND d.friendly = 1 AND d.time >= ?
          GROUP BY p.id, p.name ORDER BY value DESC, p.id LIMIT 20`
      ),
      tkDeaths: lb(
        'SELECT id, name, tk_deaths AS value FROM players WHERE tk_deaths > 0 ORDER BY value DESC, id LIMIT 20',
        `SELECT p.id, p.name, COUNT(*) AS value FROM kills k JOIN players p ON p.id = k.victim_id
          WHERE k.teamkill = 1 AND k.kind = 'wound' AND k.time >= ?
          GROUP BY p.id, p.name ORDER BY value DESC, p.id LIMIT 20`
      ),
      // Join alerts flag a connection, not behaviour (BATCH3 §6): rejoining
      // never makes a repeat offender.
      repeatOffenders: lb(
        `SELECT p.id, p.name, COUNT(*) AS value FROM flags f JOIN players p ON p.id = f.player_id
          WHERE f.type NOT IN (SELECT value FROM json_each(?))
          GROUP BY p.id, p.name HAVING COUNT(*) >= 2 ORDER BY value DESC, p.id LIMIT 20`,
        `SELECT p.id, p.name, COUNT(*) AS value FROM flags f JOIN players p ON p.id = f.player_id
          WHERE f.time >= ? AND f.type NOT IN (SELECT value FROM json_each(?))
          GROUP BY p.id, p.name HAVING COUNT(*) >= 2 ORDER BY value DESC, p.id LIMIT 20`,
        [JSON.stringify(JOIN_FLAG_TYPES)]
      ),
    };
    const openFlags = db.prepare(
      `SELECT f.*, p.name AS player_name FROM flags f LEFT JOIN players p ON p.id = f.player_id
        WHERE f.reviewed = 0 ORDER BY f.severity DESC, f.id DESC LIMIT 50`
    ).all().map(flagRowsFor(ctx.user));
    return json(ctx.res, 200, { openFlags, leaderboards });
  }

  // NEXT-CONTRACTS §1: `layers` stays plain names (now suffix-stripped and
  // de-duplicated); `layerInfo` is the parallel {name, modId, level, mode, mod}.
  function hLayers(ctx) {
    return json(ctx.res, 200, {
      layers: state && Array.isArray(state.layers) ? state.layers : [],
      layerInfo: state && Array.isArray(state.layerInfo) ? state.layerInfo : [],
      cachedAt: state && state.layersCachedAt != null ? state.layersCachedAt : null,
    });
  }

  // NEXT-CONTRACTS §1: faction catalog (built-in ∪ seen), per-layer combos
  // learned from the map pollers, and what the server shows right now.
  function hFactions(ctx) {
    const rows = db.prepare(
      'SELECT layer, team1, team2, count, last_seen FROM layer_factions ORDER BY layer, count DESC, last_seen DESC'
    ).all();
    const combos = Object.create(null); // layer names are data: never prototype keys
    const vanilla = new Set(VANILLA_FACTIONS);
    const seenCodes = new Set();
    const builtinTypes = new Set(UNIT_TYPES);
    const seenTypes = new Set();
    const note = (token) => {
      if (!token) return;
      const f = splitFaction(token);
      if (f.code && !vanilla.has(f.code)) seenCodes.add(f.code);
      if (f.type && !builtinTypes.has(f.type)) seenTypes.add(f.type);
    };
    for (const r of rows) {
      (combos[r.layer] || (combos[r.layer] = [])).push({
        team1: r.team1, team2: r.team2, count: Number(r.count) || 0,
        lastSeen: r.last_seen == null ? null : Number(r.last_seen),
      });
      note(r.team1);
      note(r.team2);
    }
    const slot = (m) => {
      if (!m || !m.layer) return null;
      note(m.team1);
      note(m.team2);
      return { layer: m.layer, team1: m.team1 == null ? null : m.team1, team2: m.team2 == null ? null : m.team2 };
    };
    const current = slot(state && state.currentMap);
    const next = slot(state && state.nextMap);
    return json(ctx.res, 200, {
      known: VANILLA_FACTIONS.map((code) => ({ code, mod: false }))
        .concat([...seenCodes].sort().map((code) => ({ code, mod: true }))),
      types: UNIT_TYPES.concat([...seenTypes].sort()),
      combos,
      current,
      next,
    });
  }

  // -------------------------------------------------------------- bans
  const BAN_SELECT = `SELECT b.*, p.name AS player_name, p.steam_id AS p_steam, u.username AS issuer,
      ${EVIDENCE_COUNT_SQL}
      FROM bans b LEFT JOIN players p ON p.id = b.player_id LEFT JOIN users u ON u.id = b.issued_by`;
  // Bans between their duplicate check and their INSERT (the RCON await sits
  // in between), by every id that check matches on: 'p:<player id>',
  // 's:<SteamID>', 'e:<eos id>'.
  const bansInFlight = new Set();

  // §19.3.21 cap with total + truncated; rows newest first. Panel-issued bans
  // (source NULL) fill the cap before imported ones, so a large BattleMetrics
  // list can never push a panel ban, and its Unban button, off the page.
  function hBansList(ctx) {
    const key = ctx.query.get('active') || 'all';
    if (!BANS_ACTIVE.has(key)) throw new ApiErr(400, 'active must be 1, 0 or all');
    const nowT = Date.now();
    let whereSql = '';
    const params = [];
    if (key === '1') {
      whereSql = ' WHERE b.active = 1 AND (b.expires_at IS NULL OR b.expires_at > ?)';
      params.push(nowT);
    } else if (key === '0') {
      whereSql = ' WHERE (b.active = 0 OR (b.expires_at IS NOT NULL AND b.expires_at <= ?))';
      params.push(nowT);
    }
    const out = cappedAll(
      `${BAN_SELECT}${whereSql} ORDER BY (b.source IS NOT NULL), b.id DESC`,
      `SELECT COUNT(*) AS c FROM bans b${whereSql}`,
      params, banRow(nowT, auth.can(ctx.user, 'ban')));
    out.rows.sort((a, b) => b.id - a.id);
    return json(ctx.res, 200, out);
  }

  async function hBanCreate(ctx) {
    const body = ctx.body;
    const intervalStr = String(body.interval == null ? '' : body.interval).trim();
    if (!INTERVAL_RE.test(intervalStr)) throw new ApiErr(400, 'invalid interval (use 0, or e.g. 1d 3d 1w 1M)');
    const durationSec = parseInterval(intervalStr);
    if (durationSec == null) throw new ApiErr(400, 'invalid interval');
    const reason = sanitizeRconArg(body.reason == null ? '' : body.reason, 480);
    // Private staff note: stored only, never sent over RCON, never in kick
    // texts, Bans.cfg or the remote ban list.
    const note = body.note == null ? '' : String(body.note).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2000);
    let playerRow = null;
    let steamIdParam = null;
    if (body.playerId != null && body.playerId !== '') {
      playerRow = db.prepare('SELECT * FROM players WHERE id = ?').get(intParam(body.playerId, 'playerId'));
      if (!playerRow) throw new ApiErr(404, 'player not found');
    } else if (body.steamId != null && body.steamId !== '') {
      steamIdParam = String(body.steamId).trim();
      if (!STEAM_ID_RE.test(steamIdParam)) throw new ApiErr(400, 'invalid steamId');
      playerRow = db.prepare('SELECT * FROM players WHERE steam_id = ? ORDER BY last_seen DESC LIMIT 1').get(steamIdParam);
      if (!playerRow) {
        // §19.2.13: manual ban of a never-seen steamId -> stub players row.
        const t = Date.now();
        const ins = db.prepare('INSERT INTO players(steam_id, name, first_seen, last_seen) VALUES(?,?,?,?)')
          .run(steamIdParam, '(manual ban)', t, t);
        playerRow = db.prepare('SELECT * FROM players WHERE id = ?').get(ins.lastInsertRowid);
      }
    } else {
      throw new ApiErr(400, 'playerId or steamId required');
    }
    const banSteamId = steamIdParam || playerRow.steam_id || null;
    // One ban of a player at a time: a second one sent while the first still
    // awaits RCON would pass the check below too and stack a duplicate.
    const claim = [`p:${playerRow.id}`];
    if (banSteamId) claim.push(`s:${banSteamId}`);
    if (playerRow.eos_id) claim.push(`e:${String(playerRow.eos_id).toLowerCase()}`);
    if (claim.some((k) => bansInFlight.has(k))) {
      throw new ApiErr(409, `A ban for ${playerRow.name ? String(playerRow.name).trim() : 'this player'} is being sent right now — check the Bans page in a moment.`);
    }
    // A ban that adds nothing — an active one already lasts as long, give or
    // take a retry's worth of minutes — is refused before RCON, so pressing
    // Ban again after "player not found" never stacks duplicates. A longer
    // ban (1d -> perm) goes through and outranks the old one.
    const checkT = Date.now();
    const existing = db.prepare(
      `SELECT b.expires_at, b.source, u.username AS issuer FROM bans b LEFT JOIN users u ON u.id = b.issued_by
        WHERE b.active = 1 AND (b.expires_at IS NULL OR b.expires_at > ?)
          AND (b.player_id = ? OR (b.steam_id IS NOT NULL AND b.steam_id = ?)
               OR (b.eos_id IS NOT NULL AND lower(b.eos_id) = lower(?)))
        ORDER BY (b.expires_at IS NULL) DESC, b.expires_at DESC LIMIT 1`
    ).get(checkT, playerRow.id, banSteamId, playerRow.eos_id || null);
    if (existing) {
      const slack = Math.min(3600 * 1000, durationSec * 100); // 10%, at most an hour
      const covered = existing.expires_at == null
        || (durationSec !== 0 && Number(existing.expires_at) >= checkT + durationSec * 1000 - slack);
      if (covered) {
        const until = existing.expires_at == null ? 'permanently'
          : `until ${new Date(Number(existing.expires_at)).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        const by = existing.source === 'battlemetrics' ? ' (imported from BattleMetrics)'
          : (existing.issuer ? ` by ${existing.issuer}` : '');
        throw new ApiErr(409, `${playerRow.name ? String(playerRow.name).trim() : 'This player'} is already banned ${until}${by}. A3 Admin kicks them whenever they join.`);
      }
    }
    for (const k of claim) bansInFlight.add(k);
    try {
      // RCON attempt (audited inside admin.js). Offline targets simply yield a
      // "not found" style response -> rconOk=false, still recorded.
      const rconRes = await admin.execAdmin(ctx.user, 'ban', {
        playerId: playerRow.id,
        steamId: steamIdParam || undefined,
        interval: intervalStr,
        reason: reason || 'Banned by admin',
      });
      const rconOk = rconRes.ok === true && rconRes.rconOk === true;
      if (rconRes.ok !== true && rconRes.command == null) {
        // Validation stopped the command before admin.js could audit it, but the
        // DB ban below still takes effect (join enforcement) — audit it here.
        auth.audit(ctx.user.id, 'ban', {
          targetPlayerId: playerRow.id,
          details: { interval: intervalStr, reason: reason || null, rconSkipped: rconRes.error || 'no usable selector' },
        });
      }
      const nowT = Date.now();
      const expiresAt = durationSec === 0 ? null : nowT + durationSec * 1000;
      // eos_id too, so join enforcement matches the ban on either id.
      const banEosId = playerRow.eos_id || null;
      const ins = db.prepare(
        `INSERT INTO bans(player_id, steam_id, eos_id, issued_by, issued_at, duration_sec, expires_at, reason, interval_raw, active, rcon_ok, note)
         VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`
      ).run(playerRow.id, banSteamId, banEosId, ctx.user.id, nowT, durationSec, expiresAt,
        reason || null, intervalStr, rconOk ? 1 : 0, note || null);
      const ban = {
        id: ins.lastInsertRowid, playerId: playerRow.id, playerName: playerRow.name,
        steamId: banSteamId, issuedBy: ctx.user.id, issuer: ctx.user.username,
        issuedAt: nowT, durationSec, expiresAt, reason: reason || null,
        intervalRaw: intervalStr, active: true, rconOk, source: null, eosId: banEosId,
        note: note || null, evidenceCount: 0,
      };
      return json(ctx.res, 200, {
        ok: true, ban, rconOk,
        rconResponse: rconRes.ok ? rconRes.response : (rconRes.error || null),
        actionId: rconRes.auditId == null ? null : rconRes.auditId,
      });
    } finally {
      for (const k of claim) bansInFlight.delete(k);
    }
  }

  function hUnban(ctx) {
    const id = intParam(ctx.params[1], 'ban id');
    const row = db.prepare('SELECT * FROM bans WHERE id = ?').get(id);
    if (!row) throw new ApiErr(404, 'ban not found');
    if (row.active) {
      db.prepare('UPDATE bans SET active = 0, unbanned_by = ?, unbanned_at = ? WHERE id = ?')
        .run(ctx.user.id, Date.now(), id);
    }
    auth.audit(ctx.user.id, 'unban', { targetPlayerId: row.player_id, details: { banId: id } });
    return json(ctx.res, 200, { ok: true, note: UNBAN_NOTE });
  }

  function hExportBans(ctx) {
    const nowT = Date.now();
    const rows = db.prepare(
      `SELECT COALESCE(b.steam_id, p.steam_id) AS sid, b.expires_at, b.reason
         FROM bans b LEFT JOIN players p ON p.id = b.player_id
        WHERE b.active = 1 AND (b.expires_at IS NULL OR b.expires_at > ?) ORDER BY b.id`
    ).all(nowT);
    const lines = [];
    for (const r of rows) {
      if (!r.sid) continue; // no SteamID -> cannot appear in Bans.cfg
      const expiry = r.expires_at != null ? Math.floor(r.expires_at / 1000) : 0;
      const reason = String(r.reason == null ? '' : r.reason).replace(/[\r\n\0]/g, ' ');
      lines.push(`${r.sid}:${expiry} //${reason}`);
    }
    const res = ctx.res;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Disposition', 'attachment; filename="Bans.cfg"');
    res.statusCode = 200;
    res.end(lines.length ? lines.join('\n') + '\n' : '');
  }

  // ------------------------------------------------------- admin RCON routes
  async function doAdmin(ctx, action, params) {
    const r = await admin.execAdmin(ctx.user, action, params);
    if (!r.ok && r.command == null) throw new ApiErr(400, r.error || 'invalid request'); // §19.3.17: pre-audit 400
    if (!r.ok) throw new ApiErr(502, `RCON command failed: ${r.error || 'unknown error'}`);
    return r;
  }
  async function hWarn(ctx) {
    const playerId = intParam(ctx.body.playerId, 'playerId');
    const message = strBody(ctx.body.message, 'message', { max: 480 });
    const r = await doAdmin(ctx, 'warn', { playerId, message });
    db.prepare('INSERT INTO warnings(player_id, by_user, time, message, auto) VALUES(?,?,?,?,0)')
      .run(playerId, ctx.user.id, Date.now(), sanitizeRconArg(message, 480));
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response, actionId: r.auditId == null ? null : r.auditId });
  }
  async function hKick(ctx) {
    const playerId = intParam(ctx.body.playerId, 'playerId');
    const reason = strBody(ctx.body.reason, 'reason', { max: 480, required: false });
    const r = await doAdmin(ctx, 'kick', { playerId, reason });
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response, actionId: r.auditId == null ? null : r.auditId });
  }
  async function hBroadcast(ctx) {
    const message = strBody(ctx.body.message, 'message', { max: 480 });
    const r = await doAdmin(ctx, 'broadcast', { message });
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response });
  }
  async function hForceTeamChange(ctx) {
    const r = await doAdmin(ctx, 'forceTeamChange', { playerId: intParam(ctx.body.playerId, 'playerId') });
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response });
  }
  async function hRemoveFromSquad(ctx) {
    const r = await doAdmin(ctx, 'removeFromSquad', { playerId: intParam(ctx.body.playerId, 'playerId') });
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response });
  }
  async function hDisbandSquad(ctx) {
    const teamId = intParam(ctx.body.teamId, 'teamId');
    const squadId = intParam(ctx.body.squadId, 'squadId');
    const r = await doAdmin(ctx, 'disbandSquad', { teamId: ctx.body.teamId, squadId: ctx.body.squadId });
    if (r.rconOk) {
      // Record who pulled the trigger NOW (ingest's poll-diff echo skips the
      // insert when it sees this row) and update the live view immediately.
      try {
        const sq = (state && state.squads || []).find((s) => s && s.teamId === teamId && s.squadId === squadId) || null;
        const created = state && state.squadCreations ? state.squadCreations.get(`${teamId}:${squadId}`) : null;
        const now = Date.now();
        db.prepare(
          `INSERT INTO squad_events(time, match_id, type, team_id, squad_id, name, player_id, player_name, by_user)
           VALUES(?,?,?,?,?,?,NULL,?,?)`
        ).run(now, state && state.match ? state.match.id : null, 'disbanded', teamId, squadId,
          sq ? sq.name : null, sq ? sq.creatorName : (created ? created.creatorName : null), ctx.user.id);
        if (state) {
          state.squads = (state.squads || []).filter((s) => !(s && s.teamId === teamId && s.squadId === squadId));
          if (state.squadCreations) state.squadCreations.delete(`${teamId}:${squadId}`);
        }
        if (bus) {
          bus.emit('squad-disbanded-admin', {
            time: now, teamId, squadId, name: sq ? sq.name : null,
            creatorName: sq ? sq.creatorName : null, byUser: ctx.user.username,
          });
        }
      } catch (_e) { /* the RCON action itself succeeded; history is best-effort */ }
    }
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response });
  }
  async function hDemoteCommander(ctx) {
    const r = await doAdmin(ctx, 'demoteCommander', { playerId: intParam(ctx.body.playerId, 'playerId') });
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response });
  }
  // NEXT-CONTRACTS §1: body {layer, now, team1?, team2?}; the command is
  // echoed so the UI can show exactly what the server was sent.
  async function hChangeLayer(ctx) {
    const layer = strBody(ctx.body.layer, 'layer', { max: 128 });
    const r = await doAdmin(ctx, 'changeLayer', {
      layer, now: ctx.body.now === true, team1: ctx.body.team1, team2: ctx.body.team2,
    });
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response, command: r.command });
  }
  async function hMatchOp(ctx) {
    const op = String(ctx.body.op == null ? '' : ctx.body.op);
    const action = MATCH_OPS[op];
    if (!action) throw new ApiErr(400, "op must be 'restart' or 'end'");
    const r = await doAdmin(ctx, action, {});
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response });
  }
  async function hSlomo(ctx) {
    const r = await doAdmin(ctx, 'slomo', { factor: ctx.body.factor });
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response });
  }
  async function hRaw(ctx) {
    const command = strBody(ctx.body.command, 'command', { max: 480 });
    const r = await admin.execRaw(ctx.user, command);
    if (!r.ok && r.command == null) throw new ApiErr(400, r.error || 'invalid command');
    if (!r.ok) throw new ApiErr(502, `RCON command failed: ${r.error || 'unknown error'}`);
    return json(ctx.res, 200, { ok: true, response: r.response });
  }

  // ------------------------------------------- quick commands (NEXT-CONTRACTS §2)

  // Newest run per id that the game server accepted (rcon_ok = 1), from the
  // audit log: {value, by, at}. A run whose exec failed or whose reply was
  // refused never changed the server, so it never becomes the shown state.
  function quickLast(rows) {
    const last = {};
    if (!rows.length) return last;
    let found = [];
    try {
      found = db.prepare(
        `SELECT a.time, a.details, u.username FROM admin_actions a
           LEFT JOIN users u ON u.id = a.user_id
          WHERE a.id IN (SELECT MAX(id) FROM admin_actions
                          WHERE action = 'quick-command' AND rcon_ok = 1 AND json_valid(details)
                          GROUP BY json_extract(details, '$.id'))`
      ).all();
    } catch (e) {
      log.warn('api', `quick-command history unreadable: ${e.message}`);
    }
    const ids = new Set(rows.map((q) => q.id));
    for (const r of found) {
      const d = parseDetails(r.details);
      if (!d || typeof d !== 'object' || !ids.has(d.id)) continue;
      last[d.id] = {
        value: d.value === 0 || d.value === 1 ? d.value : null,
        by: r.username == null ? null : r.username,
        at: r.time,
      };
    }
    return last;
  }

  function hQuickList(ctx) {
    const rows = admin.quickCommands();
    return json(ctx.res, 200, { rows, last: quickLast(rows) });
  }

  // Runs through the admin layer: audited 'quick-command' with the response.
  async function hQuickRun(ctx) {
    const id = ctx.params[1];
    if (!admin.quickCommands().some((q) => q.id === id)) throw new ApiErr(404, 'quick command not found');
    const r = await doAdmin(ctx, 'quickCommand', { id, value: ctx.body.value });
    return json(ctx.res, 200, { ok: true, rconOk: r.rconOk, rconResponse: r.response, command: r.command });
  }

  function hQuickReplace(ctx) {
    const before = admin.quickCommands();
    let rows;
    try {
      rows = admin.saveQuickCommands(ctx.body.rows);
    } catch (e) {
      throw new ApiErr(400, e.message);
    }
    const prev = new Map(before.map((q) => [q.id, q]));
    const kept = new Set(rows.map((q) => q.id));
    const same = (a, b) => a.label === b.label && a.command === b.command && a.toggle === b.toggle;
    auth.audit(ctx.user.id, 'quick-commands-update', {
      details: {
        added: rows.filter((q) => !prev.has(q.id)),
        changed: rows.filter((q) => prev.has(q.id) && !same(prev.get(q.id), q)),
        removed: before.filter((q) => !kept.has(q.id)).map((q) => q.id),
      },
    });
    return json(ctx.res, 200, { ok: true, rows });
  }

  // ------------------------------------- BattleMetrics (NEXT-CONTRACTS §3)
  // Thin wrappers over deps.battlemetrics. Upstream failures surface as 502
  // unless the module names a status; messages pass through the scrubber
  // (the API token is a redacted secret).

  function bm() {
    if (!battlemetrics) throw new ApiErr(503, 'BattleMetrics import is unavailable');
    return battlemetrics;
  }
  function bmError(e) {
    const status = e && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 ? e.status : 502;
    return new ApiErr(status, scrubText(e && e.message ? e.message : String(e)));
  }

  function hBmStatus(ctx) {
    const mod = bm();
    let out;
    try { out = mod.status(); } catch (e) { throw bmError(e); }
    return json(ctx.res, 200, scrubDeep(out || {}));
  }

  async function hBmBanLists(ctx) {
    const mod = bm();
    let lists;
    try { lists = await mod.listBanLists(); } catch (e) { throw bmError(e); }
    return json(ctx.res, 200, scrubDeep(Array.isArray(lists) ? lists : []));
  }

  // The saved list, read live (the Settings API edits config in place).
  function savedBmList() {
    const b = cfg.battlemetrics && typeof cfg.battlemetrics === 'object' ? cfg.battlemetrics : {};
    return typeof b.banListId === 'string' ? b.banListId.trim() : '';
  }

  // Which list is enforced is a settings decision: a `ban` holder may re-sync
  // the saved list, but only `settings` may name another one (its bans would
  // be enforced at once).
  async function hBmImport(ctx) {
    const mod = bm();
    const raw = ctx.body.banListId;
    let banListId;
    if (raw !== undefined && raw !== null && raw !== '') {
      if (typeof raw !== 'string' || !BM_LIST_ID_RE.test(raw)) throw new ApiErr(400, 'invalid banListId');
      banListId = raw;
    }
    if (banListId !== undefined && banListId !== savedBmList() && !auth.can(ctx.user, 'settings')) {
      throw new ApiErr(403, 'importing a ban list other than the saved one needs the settings permission');
    }
    let out;
    try {
      out = await mod.importNow(banListId === undefined ? {} : { banListId });
    } catch (e) {
      const err = bmError(e);
      auth.audit(ctx.user.id, 'bm-import', { details: { banListId: banListId || null, error: err.message } });
      throw err;
    }
    const res = scrubDeep(out || {});
    auth.audit(ctx.user.id, 'bm-import', {
      details: {
        banListId: banListId || null,
        fetched: res.fetched, imported: res.imported, updated: res.updated,
        deactivated: res.deactivated, skippedNoIdentifier: res.skippedNoIdentifier,
        errors: Array.isArray(res.errors) ? res.errors.length : 0,
      },
    });
    return json(ctx.res, 200, res);
  }

  // ----------------------------------------------------------- audit, users
  function hAudit(ctx) {
    const q = ctx.query;
    const { per, offset } = pageOf(q, 50);
    const where = [];
    const params = [];
    const uid = q.get('userId');
    if (uid != null && uid !== '') { where.push('a.user_id = ?'); params.push(intParam(uid, 'userId')); }
    const action = q.get('action') || '';
    if (action) {
      if (!AUDIT_ACTIONS.has(action)) throw new ApiErr(400, 'unknown action'); // §19.3.16
      where.push('a.action = ?');
      params.push(action);
    }
    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM admin_actions a${whereSql}`).get(...params);
    const rows = db.prepare(
      `SELECT a.*, u.username, p.name AS target_name,
              (SELECT COUNT(*) FROM evidence e WHERE e.target_type = 'action'
                  AND e.target_id = a.id AND e.deleted_at IS NULL) AS evidence_count
         FROM admin_actions a LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN players p ON p.id = a.target_player_id
        ${whereSql} ORDER BY a.id DESC LIMIT ? OFFSET ?`
    ).all(...params, per, offset);
    return json(ctx.res, 200, {
      total: totalRow ? Number(totalRow.c) : 0,
      rows: rows.map((r) => ({
        id: r.id, time: r.time, userId: r.user_id,
        username: r.username == null ? null : r.username,
        action: r.action, targetPlayerId: r.target_player_id,
        targetName: r.target_name == null ? null : r.target_name,
        details: auditDetailsFor(r, ctx.user),
        rconCommand: r.rcon_command, rconResponse: r.rcon_response,
        rconOk: r.rcon_ok == null ? null : !!r.rcon_ok,
        evidenceCount: r.evidence_count == null ? 0 : Number(r.evidence_count),
      })),
    });
  }

  function hUsersList(ctx) {
    const rows = db.prepare(
      `SELECT u.id, u.username, u.created_at, u.last_login, u.disabled,
              r.id AS role_id, r.name AS role
         FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.id`
    ).all();
    return json(ctx.res, 200, {
      rows: rows.map((r) => ({
        id: r.id, username: r.username, role: r.role, roleId: r.role_id,
        createdAt: r.created_at, lastLogin: r.last_login, disabled: !!r.disabled,
      })),
    });
  }

  function hUserCreate(ctx) {
    const username = strBody(ctx.body.username, 'username', { max: 64 });
    const password = strBody(ctx.body.password, 'password', { max: 1024 });
    const roleRef = ctx.body.roleId != null ? Number(ctx.body.roleId) : String(ctx.body.role == null ? '' : ctx.body.role);
    const role = auth.roleRow(roleRef);
    if (!role) throw new ApiErr(400, 'unknown role');
    assertCanGrantRole(ctx.user, role);
    let user;
    try {
      user = auth.createUser(username, password, role.id);
    } catch (e) {
      throw new ApiErr(400, e.message);
    }
    auth.audit(ctx.user.id, 'user-create', { details: { username: user.username, role: role.name } });
    return json(ctx.res, 200, { ok: true, user });
  }

  // The panel must always keep one enabled account whose role can still run it
  // (users+roles+settings) — the generalized "last owner" rule.
  function assertNotLastKeyholder(targetId, msg) {
    if (auth.keyholderCount({ exceptUserId: targetId }) === 0) throw new ApiErr(400, msg);
  }

  // No privilege amplification: whoever hands out a role (user create/update,
  // invite) must themselves hold every permission that role grants. Owners
  // hold everything, so this never constrains them.
  function assertCanGrantRole(actor, row) {
    const perms = auth.parsePerms(row.id, row.perms);
    const missing = Object.keys(perms).filter((k) => perms[k] === true && !auth.can(actor, k));
    if (missing.length) {
      throw new ApiErr(403, `you cannot assign a role with permissions you do not hold (${missing.join(', ')})`);
    }
  }

  function hUserUpdate(ctx) {
    const id = intParam(ctx.params[1], 'user id');
    const target = db.prepare(
      `SELECT u.id, u.username, u.disabled, u.role_id, r.name AS role, r.perms AS perms
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`
    ).get(id);
    if (!target) throw new ApiErr(404, 'user not found');
    const body = ctx.body;
    const sets = [];
    const params = [];
    const changed = [];
    let newRole = null;
    let newDisabled = null;
    if (body.role !== undefined || body.roleId !== undefined) {
      newRole = auth.roleRow(body.roleId != null ? Number(body.roleId) : String(body.role));
      if (!newRole) throw new ApiErr(400, 'invalid role');
      assertCanGrantRole(ctx.user, newRole);
      sets.push('role_id = ?'); params.push(newRole.id); changed.push(`role:${newRole.name}`);
    }
    if (body.disabled !== undefined) {
      newDisabled = body.disabled === true || body.disabled === 1 ? 1 : 0;
      sets.push('disabled = ?'); params.push(newDisabled); changed.push('disabled');
    }
    if (body.password !== undefined) {
      const pw = strBody(body.password, 'password', { max: 1024 });
      const weak = auth.passwordProblem(pw);
      if (weak) throw new ApiErr(400, weak);
      sets.push('pass_hash = ?'); params.push(auth.hashPassword(pw)); changed.push('password');
    }
    if (!sets.length) throw new ApiErr(400, 'nothing to update');
    // Would this change cost the target their keyholder status (or the panel
    // its last keyholder)? Check only when it can (§13 generalized).
    const targetPerms = auth.parsePerms(target.role_id, target.perms);
    const wasKeyholder = !target.disabled &&
      targetPerms.users === true && targetPerms.roles === true && targetPerms.settings === true;
    if (wasKeyholder) {
      const nextPerms = newRole ? auth.roleRow(newRole.id) && auth.parsePerms(newRole.id, auth.roleRow(newRole.id).perms) : targetPerms;
      const staysKeyholder = newDisabled !== 1 &&
        nextPerms.users === true && nextPerms.roles === true && nextPerms.settings === true;
      if (!staysKeyholder) {
        assertNotLastKeyholder(id, 'cannot demote or disable the last account that can manage users, roles and settings');
      }
    }
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    auth.destroyUserSessions(id); // §19.3.18
    dropUserStreams(id); // live streams end immediately, not at next request
    auth.audit(ctx.user.id, 'user-update', { details: { userId: id, username: target.username, changed } });
    return json(ctx.res, 200, { ok: true });
  }

  // ------------------------------------------- roles (docs/ROLES-INVITES-SETTINGS.md §1)

  function hPerms(ctx) {
    return json(ctx.res, 200, { perms: PERM_INFO });
  }

  function hRolesList(ctx) {
    return json(ctx.res, 200, { rows: auth.listRoles() });
  }

  function hRoleCreate(ctx) {
    let role;
    try {
      role = auth.createRole(ctx.body.name, ctx.body.perms);
    } catch (e) {
      throw new ApiErr(400, e.message);
    }
    auth.audit(ctx.user.id, 'role-create', { details: { roleId: role.id, name: role.name, perms: Object.keys(role.perms) } });
    return json(ctx.res, 200, { ok: true, role });
  }

  function hRoleUpdate(ctx) {
    const id = intParam(ctx.params[1], 'role id');
    const current = auth.roleRow(id);
    if (!current) throw new ApiErr(404, 'role not found');
    // Pre-check the keyholder invariant: if this edit strips users/roles/
    // settings from the role, the panel must still have an enabled keyholder
    // whose role is a DIFFERENT one (owner perms are immutable, so the owner
    // role itself can never trip this).
    if (ctx.body.perms !== undefined) {
      const cur = auth.parsePerms(current.id, current.perms);
      const wasKeys = cur.users === true && cur.roles === true && cur.settings === true;
      const p = ctx.body.perms || {};
      const staysKeys = p.users === true && p.roles === true && p.settings === true;
      if (wasKeys && !staysKeys) {
        const rows = db.prepare(
          `SELECT r.perms, r.id AS role_id FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.disabled = 0 AND u.role_id <> ?`
        ).all(current.id);
        const otherKeyholder = rows.some((r) => {
          const q = auth.parsePerms(r.role_id, r.perms);
          return q.users === true && q.roles === true && q.settings === true;
        });
        if (!otherKeyholder) {
          throw new ApiErr(400, 'this change would leave no account able to manage users, roles and settings');
        }
      }
    }
    let out;
    try {
      out = auth.updateRole(id, { name: ctx.body.name, perms: ctx.body.perms });
    } catch (e) {
      throw new ApiErr(/not found/.test(e.message) ? 404 : 400, e.message);
    }
    if (out.permsChanged) {
      // §19.3.18 pattern: a permission change hits members NOW, not at the
      // next request — sessions die and live streams drop.
      for (const uid of out.memberIds) {
        auth.destroyUserSessions(uid);
        dropUserStreams(uid);
      }
    }
    // Audit exactly which keys moved — the whole point of auditing the most
    // security-sensitive mutation in the panel (docs/R-I-S §1).
    const beforePerms = auth.parsePerms(current.id, current.perms);
    const afterPerms = out.role.perms || {};
    const permsAdded = Object.keys(afterPerms).filter((k) => !beforePerms[k]);
    const permsRemoved = Object.keys(beforePerms).filter((k) => !afterPerms[k]);
    auth.audit(ctx.user.id, 'role-update', {
      details: {
        roleId: id, name: out.role.name, permsChanged: out.permsChanged,
        permsAdded, permsRemoved, members: out.memberIds.length,
      },
    });
    return json(ctx.res, 200, { ok: true, role: out.role });
  }

  function hRoleDelete(ctx) {
    const id = intParam(ctx.params[1], 'role id');
    const row = auth.roleRow(id);
    if (!row) throw new ApiErr(404, 'role not found');
    try {
      auth.deleteRole(id);
    } catch (e) {
      throw new ApiErr(/members|invites/.test(e.message) ? 409 : 400, e.message);
    }
    auth.audit(ctx.user.id, 'role-delete', { details: { roleId: id, name: row.name } });
    return json(ctx.res, 200, { ok: true });
  }

  // ----------------------------------------- invites (docs/ROLES-INVITES-SETTINGS.md §2)

  function inviteUrlFor(ctx, token) {
    let origin = '';
    const pub = String((cfg.web && cfg.web.publicUrl) || '').replace(/\/+$/, '');
    if (pub) origin = pub;
    else {
      const host = String(ctx.req.headers.host || '').slice(0, 256);
      if (host) origin = `${cookieSecure(ctx.req) ? 'https' : 'http'}://${host}`;
    }
    return origin ? `${origin}/#/join/${token}` : `/#/join/${token}`;
  }

  function hInvitesList(ctx) {
    return json(ctx.res, 200, { rows: auth.listInvites() });
  }

  function hInviteCreate(ctx) {
    const roleId = intParam(String(ctx.body.roleId == null ? '' : ctx.body.roleId), 'roleId');
    const ttlHours = clampInt(ctx.body.ttlHours, 1, 720, 168);
    const role = auth.roleRow(roleId);
    if (!role) throw new ApiErr(400, 'unknown role');
    assertCanGrantRole(ctx.user, role);
    let inv;
    try {
      inv = auth.createInvite({ roleId, ttlMs: ttlHours * 3600 * 1000, createdBy: ctx.user.id });
    } catch (e) {
      throw new ApiErr(400, e.message);
    }
    auth.audit(ctx.user.id, 'invite-create', { details: { inviteId: inv.id, roleId: inv.roleId, roleName: inv.roleName, ttlHours } });
    // The token appears in this response exactly once and is never stored.
    return json(ctx.res, 200, {
      ok: true,
      invite: { id: inv.id, roleId: inv.roleId, roleName: inv.roleName, expiresAt: inv.expiresAt },
      token: inv.token,
      url: inviteUrlFor(ctx, inv.token),
    });
  }

  function hInviteRevoke(ctx) {
    const id = intParam(ctx.params[1], 'invite id');
    try {
      auth.revokeInvite(id);
    } catch (e) {
      throw new ApiErr(/not found/.test(e.message) ? 404 : 400, e.message);
    }
    auth.audit(ctx.user.id, 'invite-revoke', { details: { inviteId: id } });
    return json(ctx.res, 200, { ok: true });
  }

  // Public probe for the join page. Rate-limited; one generic answer for every
  // non-claimable state (no oracle).
  function hJoinPeek(ctx) {
    const lim = auth.loginLimiter.attempt(ctx.ip);
    if (!lim.ok) return tooManyAttempts(ctx, lim, 'too many attempts — try again shortly');
    const inv = auth.findInvite(String(ctx.query.get('token') || ''));
    if (!inv) return json(ctx.res, 200, { valid: false });
    return json(ctx.res, 200, {
      valid: true,
      roleName: inv.roleName,
      serverName: (state && state.serverInfo && state.serverInfo.serverName) || null,
    });
  }

  function hJoin(ctx) {
    const lim = auth.loginLimiter.attempt(ctx.ip);
    if (!lim.ok) return tooManyAttempts(ctx, lim, 'too many attempts — try again shortly');
    const token = strBody(ctx.body.token, 'token', { max: 256 });
    const username = strBody(ctx.body.username, 'username', { max: 64 });
    const password = strBody(ctx.body.password, 'password', { max: 1024 });
    let claimed;
    try {
      claimed = auth.claimInvite(token, { username, password });
    } catch (e) {
      return json(ctx.res, 400, { error: e.message });
    }
    auth.audit(null, 'invite-use', {
      details: { inviteId: claimed.inviteId, userId: claimed.user.id, username: claimed.user.username, role: claimed.user.role },
    });
    // Straight into the panel: same session flow as /api/login.
    const sess = auth.createSession(claimed.user.id, {
      ip: ctx.ip, ua: String(ctx.req.headers['user-agent'] || '').slice(0, 256),
    });
    setSessionCookie(ctx.res, ctx.req, sess.token);
    const full = auth.getSession(sess.token);
    return json(ctx.res, 200, { ok: true, user: full ? full.user : claimed.user });
  }

  function hSettings(ctx) {
    let sizeBytes = null;
    const dbPath = (db && db.path) || cfg.dbPath || null;
    try {
      if (dbPath && dbPath !== ':memory:') sizeBytes = fs.statSync(path.resolve(String(dbPath))).size;
    } catch (_e) { /* db file may not exist yet */ }
    let samples = [];
    try { samples = (ph.samples() || []).map((s) => scrubText(s)); } catch (_e) { samples = []; }
    let unmatched24h = 0;
    try { unmatched24h = Number(ph.count24h()) || 0; } catch (_e) { unmatched24h = 0; }
    return json(ctx.res, 200, {
      config: redactedConfig(), // §19.3.27
      // Which secrets EXIST (never their values) — the Settings form shows
      // "saved" placeholders from this.
      secretsSet: {
        rconPassword: !!(cfg.squad && cfg.squad.rconPassword),
        ftpPassword: !!(cfg.log && cfg.log.ftp && cfg.log.ftp.password),
        sftpPassword: !!(cfg.log && cfg.log.sftp && cfg.log.sftp.password),
        steamApiKey: !!cfg.steamApiKey,
        discordWebhook: !!cfg.discordWebhook,
        battlemetricsToken: !!(cfg.battlemetrics && cfg.battlemetrics.token),
      },
      demo: demoCli === true,
      linked: !!(cfg.squad && cfg.squad.rconHost),
      status: {
        rcon: rconStatus(),
        log: logStatusOut(),
        db: { path: dbPath, sizeBytes },
        parser: { unmatched24h, samples },
        version: version == null ? null : version,
        gameVersion: (state && state.serverInfo && state.serverInfo.gameVersion) || null, // §19.1.10
      },
    });
  }

  // POST /api/settings — validate, persist to config.json, apply live
  // (docs/ROLES-INVITES-SETTINGS.md §3). Demo settings are fixed.
  function hSettingsUpdate(ctx) {
    if (demoCli === true) throw new ApiErr(403, 'demo settings are fixed — run without --demo to configure a real server');
    if (!runtime || typeof runtime.applySettings !== 'function') throw new ApiErr(500, 'settings runtime unavailable');
    let out;
    try {
      out = runtime.applySettings(ctx.body || {});
    } catch (e) {
      // Validation messages already redact secret values (config.js §19.3.27).
      throw new ApiErr(400, scrubText(e.message));
    }
    // Roles without `settings` read the audit log: a failed config.json
    // write is recorded as a marker; its text (OS message, paths) goes to
    // the caller only, scrubbed.
    auth.audit(ctx.user.id, 'settings-update', {
      details: { changed: out.changedPaths, persistError: out.persistError ? NOT_SAVED : null },
    });
    const persistError = out.persistError ? scrubText(String(out.persistError)) : null;
    return json(ctx.res, 200, { ok: true, changed: out.changedPaths, persistError });
  }

  // POST /api/settings/test — one-shot probes with candidate values, never
  // touching the live clients. RCON: {rconHost, rconPort, rconPassword?} (null
  // password = saved). Log source: {log:{mode?, path?, ftp?, sftp?}} — local
  // stats the file; ftp/sftp checks the optional package, then connects.
  async function hSettingsTest(ctx) {
    if (demoCli === true) throw new ApiErr(403, 'demo settings are fixed');
    if (!runtime) throw new ApiErr(500, 'settings runtime unavailable');
    if (ctx.body.log !== undefined) {
      if (typeof runtime.testLog !== 'function') throw new ApiErr(500, 'settings runtime unavailable');
      const out = await runtime.testLog(ctx.body.log || {});
      auth.audit(ctx.user.id, 'settings-test', {
        details: { target: 'log', mode: (ctx.body.log && ctx.body.log.mode) || null, ok: !!out.ok },
      });
      if (out.error) out.error = scrubText(String(out.error));
      return json(ctx.res, 200, out);
    }
    if (typeof runtime.testRcon !== 'function') throw new ApiErr(500, 'settings runtime unavailable');
    const host = strBody(ctx.body.rconHost, 'rconHost', { max: 256 });
    const port = clampInt(ctx.body.rconPort, 1, 65535, 0);
    if (!port) throw new ApiErr(400, 'rconPort must be 1-65535');
    const password = ctx.body.rconPassword == null ? null : String(ctx.body.rconPassword).slice(0, 1024);
    const out = await runtime.testRcon({ host, port, password });
    auth.audit(ctx.user.id, 'settings-test', { details: { target: 'rcon', host, port, ok: !!out.ok } });
    if (out.error) out.error = scrubText(String(out.error));
    return json(ctx.res, 200, out);
  }

  // -------------------------------------------------------------- the router
  const routes = [];
  function route(method, re, opts, handler) { routes.push({ method, re, opts: opts || {}, handler }); }

  route('POST', /^\/api\/login$/, { public: true }, hLogin);
  route('POST', /^\/api\/logout$/, { perm: 'view' }, hLogout);
  route('GET', /^\/api\/bootstrap$/, { public: true }, hBootstrap);
  route('POST', /^\/api\/setup$/, { public: true }, hSetup);
  route('GET', /^\/api\/me$/, { perm: 'view' }, hMe);
  route('GET', /^\/api\/overview$/, { perm: 'view' }, hOverview);
  route('GET', /^\/api\/stream$/, { perm: 'stream' }, hStream);
  route('GET', /^\/api\/pop$/, { perm: 'view' }, hPop);
  route('GET', /^\/api\/live\/feed$/, { perm: 'view' }, hLiveFeed);
  route('GET', /^\/api\/players$/, { perm: 'view' }, hPlayers);
  route('GET', /^\/api\/players\/(\d+)$/, { perm: 'view' }, hPlayer);
  route('GET', /^\/api\/players\/(\d+)\/chat$/, { perm: 'view' }, hPlayerChat);
  route('POST', /^\/api\/players\/(\d+)\/notes$/, { perm: 'notes' }, hNoteAdd);
  route('POST', /^\/api\/players\/(\d+)\/watch$/, { perm: 'flags' }, hWatch);
  route('POST', /^\/api\/players\/(\d+)\/flag$/, { perm: 'flags' }, hManualFlag);
  route('GET', /^\/api\/matches$/, { perm: 'view' }, hMatches);
  route('GET', /^\/api\/matches\/(\d+)$/, { perm: 'view' }, hMatch);
  route('GET', /^\/api\/chat$/, { perm: 'view' }, hChat);
  route('GET', /^\/api\/flags$/, { perm: 'view' }, hFlags);
  route('POST', /^\/api\/flags\/(\d+)\/review$/, { perm: 'flags' }, hFlagReview);
  route('GET', /^\/api\/trolls$/, { perm: 'view' }, hTrolls);
  route('GET', /^\/api\/layers$/, { perm: 'view' }, hLayers);
  route('GET', /^\/api\/factions$/, { perm: 'layer' }, hFactions);
  route('GET', /^\/api\/bans$/, { perm: 'view' }, hBansList);
  route('POST', /^\/api\/bans$/, { perm: 'ban' }, hBanCreate);
  route('POST', /^\/api\/bans\/(\d+)\/unban$/, { perm: 'ban' }, hUnban);
  route('GET', /^\/api\/export\/bans\.cfg$/, { perm: 'ban' }, hExportBans);
  route('POST', /^\/api\/admin\/warn$/, { perm: 'warn' }, hWarn);
  route('POST', /^\/api\/admin\/kick$/, { perm: 'kick' }, hKick);
  route('POST', /^\/api\/admin\/broadcast$/, { perm: 'broadcast' }, hBroadcast);
  route('POST', /^\/api\/admin\/forceTeamChange$/, { perm: 'team' }, hForceTeamChange);
  route('POST', /^\/api\/admin\/removeFromSquad$/, { perm: 'squad' }, hRemoveFromSquad);
  route('POST', /^\/api\/admin\/disbandSquad$/, { perm: 'squad' }, hDisbandSquad);
  route('POST', /^\/api\/admin\/demoteCommander$/, { perm: 'squad' }, hDemoteCommander);
  route('POST', /^\/api\/admin\/changeLayer$/, { perm: 'layer' }, hChangeLayer);
  route('POST', /^\/api\/admin\/match$/, { perm: 'match' }, hMatchOp);
  route('POST', /^\/api\/admin\/slomo$/, { perm: 'slomo' }, hSlomo);
  route('POST', /^\/api\/admin\/raw$/, { perm: 'raw' }, hRaw);
  route('GET', /^\/api\/quick-commands$/, { anyPerm: ['quickcmd', 'raw', 'settings'] }, hQuickList);
  route('POST', /^\/api\/quick-commands$/, { perm: 'settings' }, hQuickReplace);
  route('POST', /^\/api\/quick-commands\/([a-z0-9-]{1,40})\/run$/, { perm: 'quickcmd' }, hQuickRun);
  route('GET', /^\/api\/battlemetrics\/status$/, { perm: 'settings' }, hBmStatus);
  route('GET', /^\/api\/battlemetrics\/ban-lists$/, { perm: 'settings' }, hBmBanLists);
  route('POST', /^\/api\/battlemetrics\/import$/, { anyPerm: ['settings', 'ban'] }, hBmImport);
  route('GET', /^\/api\/audit$/, { perm: 'audit' }, hAudit); // §19.3.23: admin+
  route('GET', /^\/api\/users$/, { perm: 'users' }, hUsersList);
  route('POST', /^\/api\/users$/, { perm: 'users' }, hUserCreate);
  route('POST', /^\/api\/users\/(\d+)$/, { perm: 'users' }, hUserUpdate);
  route('GET', /^\/api\/perms$/, { anyPerm: ['users', 'roles'] }, hPerms);
  route('GET', /^\/api\/roles$/, { anyPerm: ['users', 'roles'] }, hRolesList);
  route('POST', /^\/api\/roles$/, { perm: 'roles' }, hRoleCreate);
  route('POST', /^\/api\/roles\/(\d+)$/, { perm: 'roles' }, hRoleUpdate);
  route('POST', /^\/api\/roles\/(\d+)\/delete$/, { perm: 'roles' }, hRoleDelete);
  route('GET', /^\/api\/invites$/, { perm: 'users' }, hInvitesList);
  route('POST', /^\/api\/invites$/, { perm: 'users' }, hInviteCreate);
  route('POST', /^\/api\/invites\/(\d+)\/revoke$/, { perm: 'users' }, hInviteRevoke);
  route('GET', /^\/api\/join$/, { public: true }, hJoinPeek);
  route('POST', /^\/api\/join$/, { public: true }, hJoin);
  route('GET', /^\/api\/settings$/, { perm: 'settings' }, hSettings);
  route('POST', /^\/api\/settings$/, { perm: 'settings' }, hSettingsUpdate);
  route('POST', /^\/api\/settings\/test$/, { perm: 'settings' }, hSettingsTest);

  // Feature modules (docs/BATCH3-CONTRACTS.md: evidence, reason templates,
  // remote ban list, scheduler, admin calls, join alerts) register their own
  // routes against these shared helpers. Route opts as above, plus
  // { rawBody: true } for streaming uploads.
  const extApi = {
    route, json, ApiErr, strBody, intParam, clampInt, scrubText, sseBroadcast,
    cappedAll, doAdmin, auth, db, state, bus, admin, cfg,
  };
  for (const ext of (deps && deps.extensions) || []) {
    if (ext && typeof ext.registerRoutes === 'function') ext.registerRoutes(extApi);
  }

  // ------------------------------------------------------------ static files
  async function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' });
    }
    // §19.3.26 — decode once (the dispatcher already decoded; `pathname` is
    // the decoded path), reject \0 and any ".." segment BEFORE resolve.
    let p = pathname;
    if (p.includes('\0')) return json(res, 400, { error: 'bad path' });
    if (p.split('/').includes('..')) return json(res, 400, { error: 'bad path' });
    if (p === '/') p = '/index.html';
    const resolved = path.resolve(pubDir, '.' + (p.startsWith('/') ? p : '/' + p));
    if (!(resolved === pubDir || resolved.startsWith(pubDir + path.sep))) {
      return json(res, 404, { error: 'not found' });
    }
    const ext = path.extname(resolved).toLowerCase();
    const mime = MIME[ext];
    if (!mime) return json(res, 404, { error: 'not found' });
    let buf;
    if (staticFiles) {
      const f = staticFiles.get(resolved);
      if (!f) return json(res, 404, { error: 'not found' });
      buf = f.buf;
    } else {
      try {
        buf = await fs.promises.readFile(resolved);
      } catch (_e) {
        return json(res, 404, { error: 'not found' });
      }
    }
    // Proxies (Cloudflare's default browser TTL is 4h) can pin old JS/CSS in
    // browsers regardless of our no-cache. Stamp each local asset URL in the
    // HTML with its content hash (or mtime) so every change is a new URL the
    // cache never saw.
    if (ext === '.html') {
      const html = buf.toString('utf8').replace(
        /\b(src|href)="((?:css\/|brand\/)?[\w.-]+\.(?:js|css|png|svg|ico|webmanifest))"/g,
        (m, attr, rel) => {
          if (staticFiles) {
            const f = staticFiles.get(path.join(pubDir, rel));
            return f ? `${attr}="${rel}?v=${f.tag}"` : m;
          }
          try {
            const st = fs.statSync(path.join(pubDir, rel));
            return `${attr}="${rel}?v=${Math.floor(st.mtimeMs).toString(36)}"`;
          } catch (_e) { return m; }
        }
      );
      buf = Buffer.from(html, 'utf8');
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-cache');
    if (ext === '.html') res.setHeader('Content-Security-Policy', CSP); // §19.3.25
    res.statusCode = 200;
    if (req.method === 'HEAD') { res.setHeader('Content-Length', buf.length); res.end(); return; }
    res.end(buf);
  }

  // --------------------------------------------------------------- dispatch
  // First X-Forwarded-Proto value; '' unless the proxy is trusted.
  function forwardedProto(req) {
    if (!trustProxy) return '';
    return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  }
  // Base URL a plain-HTTP visit is sent to: web.publicUrl when it is an https
  // URL (read per request — the Settings API can change it), else the
  // visitor's own Host over https. null when that Host is not a bare
  // hostname[:port], so a forged Host can never shape the Location.
  function httpsBase(req) {
    try {
      const u = new URL(String(web.publicUrl || ''));
      if (u.protocol === 'https:') return u.origin + u.pathname.replace(/\/+$/, '');
    } catch (_e) { /* blank or malformed publicUrl: use the Host header */ }
    const host = String(req.headers.host || '');
    return /^[A-Za-z0-9.-]+(:\d+)?$/.test(host) ? `https://${host}` : null;
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff'); // §19.3.25 on every response
    res.setHeader('Referrer-Policy', 'no-referrer');
    const proto = forwardedProto(req);
    // A visitor who reached the trusted proxy over plain HTTP never gets the
    // panel there (passwords would cross the internet unencrypted) — whatever
    // web.publicUrl says, so blanking it cannot reopen cleartext logins.
    if (proto === 'http') {
      const base = httpsBase(req);
      if (!base) return json(res, 400, { error: 'bad Host header' });
      res.writeHead(308, { Location: base + (req.url && req.url.startsWith('/') ? req.url : '/'), 'Cache-Control': 'no-store' });
      return res.end();
    }
    // HSTS only on responses that really travelled over HTTPS. No
    // includeSubDomains or preload: both would commit hosts other than this
    // panel to HTTPS, which is not this server's call.
    if (proto === 'https' || (req.socket && req.socket.encrypted)) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    let url;
    try {
      url = new URL(req.url, 'http://internal');
    } catch (_e) {
      return json(res, 400, { error: 'bad request' });
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname); // once; 400 on throw (§19.3.26)
    } catch (_e) {
      return json(res, 400, { error: 'bad path encoding' });
    }

    if (pathname === '/api' || pathname.startsWith('/api/')) {
      let matched = null;
      let m = null;
      let pathExists = false;
      for (const r of routes) {
        const mm = r.re.exec(pathname);
        if (!mm) continue;
        pathExists = true;
        if (r.method === req.method) { matched = r; m = mm; break; }
      }
      if (!matched) {
        return json(res, pathExists ? 405 : 404, { error: pathExists ? 'method not allowed' : 'not found' });
      }
      const ctx = {
        req, res, params: m, query: url.searchParams,
        ip: clientIp(req), user: null, token: null, body: null,
      };
      try {
        if (!matched.opts.public) {
          // §13: everything except login|setup|bootstrap requires a session.
          const token = getCookie(req, COOKIE_NAME);
          const sess = token ? auth.getSession(token) : null;
          if (!sess) return json(res, 401, { error: 'unauthorized' });
          ctx.user = sess.user;
          ctx.token = token;
          if (sess.refreshed) setSessionCookie(res, req, token); // sliding window (§12)
          const allowed = matched.opts.anyPerm
            ? matched.opts.anyPerm.some((p) => auth.can(ctx.user, p))
            : auth.can(ctx.user, matched.opts.perm || 'view');
          if (!allowed) return json(res, 403, { error: 'forbidden' });
        }
        if (req.method === 'POST' && matched.opts.rawBody) {
          // Streaming upload route (evidence): the handler reads ctx.req and
          // enforces its own size and type limits. CSRF still applies; the
          // JSON-only Content-Type rule does not.
          const csrfErr = csrfCheck(req);
          if (csrfErr) return json(res, 403, { error: `request blocked: ${csrfErr}` });
          ctx.body = null;
        } else if (req.method === 'POST') {
          // §19.3.20 — CSRF + Content-Type on every mutating route.
          const csrfErr = csrfCheck(req);
          if (csrfErr) return json(res, 403, { error: `request blocked: ${csrfErr}` });
          if (!isJsonContentType(req)) return json(res, 403, { error: 'Content-Type must be application/json' });
          const buf = await readBody(req);
          if (buf.length === 0) {
            ctx.body = {};
          } else {
            let parsed;
            try {
              parsed = JSON.parse(buf.toString('utf8'));
            } catch (_e) {
              return json(res, 400, { error: 'invalid JSON body' });
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              return json(res, 400, { error: 'JSON object body expected' });
            }
            ctx.body = parsed;
          }
        }
        return await matched.handler(ctx);
      } catch (e) {
        if (e instanceof ApiErr) return json(res, e.status, { error: e.message });
        log.error('api', `handler ${req.method} ${pathname} failed: ${scrubText(e && e.message ? e.message : String(e))}`);
        return json(res, 500, { error: 'internal error' });
      }
    }
    return serveStatic(req, res, pathname);
  }

  const server = http.createServer((req, res) => {
    Promise.resolve(handle(req, res)).catch((e) => {
      log.error('api', `request failed: ${scrubText(e && e.message ? e.message : String(e))}`);
      if (!res.headersSent) {
        try { json(res, 500, { error: 'internal error' }); } catch (_e) { /* socket gone */ }
      } else {
        try { res.end(); } catch (_e) { /* socket gone */ }
      }
    });
  });

  // Evidence uploads (up to evidence.maxMB) over a slow uplink outlast Node's
  // 5-minute whole-request default.
  server.requestTimeout = 20 * 60 * 1000;

  // Teardown: detach bus listeners, stop timers, drop SSE clients, and make
  // sure long-lived SSE sockets do not keep server.close() hanging forever.
  let tornDown = false;
  function teardown() {
    if (tornDown) return;
    tornDown = true;
    if (bus) for (const [ev, fn] of busWiring) bus.removeListener(ev, fn);
    clearInterval(sse.pingTimer);
    if (sse.playersTimer) { clearTimeout(sse.playersTimer); sse.playersTimer = null; }
    for (const client of [...sse.clients]) dropClient(client);
  }
  const origClose = server.close.bind(server);
  server.close = function close(cb) {
    teardown();
    const out = origClose(cb);
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    return out;
  };
  server.on('close', teardown);

  return server;
}

module.exports = { createApi };
