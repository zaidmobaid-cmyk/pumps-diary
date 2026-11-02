'use strict';
// BattleMetrics ban-list import (docs/NEXT-CONTRACTS.md §3). Mirrors a BM
// ban list into the bans table (source 'battlemetrics', external_id = the BM
// ban id) so ingest's ban enforcement covers everyone banned there. Zero
// dependencies: global fetch against BM's JSON:API.
//
// createBattlemetrics({db, config, log, bus, admin, apiBase?, timing?}) ->
//   { listBanLists(), importNow({banListId?}), status(), start(), stop(), reconfigure() }
// admin is unused here: kicking banned players is ingest's job. apiBase /
// timing exist for tests (a local mock API, short waits); config
// battlemetrics.apiBase is the same hook for tests that boot the whole server.
// Each finished run emits bus 'battlemetrics-sync' {at, banListId, result}.
//
// Rules the import keeps:
// - The API token goes only to the API origin, in the Authorization header,
//   and never into logs, errors, results or the database.
// - Only rows with source='battlemetrics' are ever written. A panel unban of
//   an imported row (unbanned_by set) stands; rows the import itself
//   deactivated come back when their BM ban is active again.
// - Bans a read did not see must never look removed: absence deactivates only
//   after a read that followed the list's links to the end with no error and
//   no count far short of BM's own. A ban whose expiry or identifiers cannot
//   be read is skipped and reported; its stored copy stays as it was.
// - Each imported ban belongs to the list it was last read on (settings row
//   OWNERS_KEY). Absence deactivates only that list's bans, so importing one
//   list never weakens another's; a ban moved between lists follows the move.
// - Bans this organization exempted on BM are not read (filter[exempt]). A
//   server-only ban (orgWide false) is enforced here unless the file-only
//   battlemetrics.serverId names this server's BM id and the ban another's.
// - The admin note is staff-only: it goes to the private bans.note column,
//   never into the reason that kick messages, Bans.cfg and the remote ban
//   list show. Imported reasons hold no square brackets (they become
//   parentheses): ingest drops a trailing "[...]" from them in kick messages.
const { log: utilLog } = require('./util');

const API_BASE = 'https://api.battlemetrics.com';
const SOURCE = 'battlemetrics';
const PAGE_SIZE = 100;
const MAX_PAGES = 1000; // links that never end
// settings row: the latest run {at, banListId, complete, result} plus
// lists: {[banListId]: {at, complete}}, each list's own latest run.
const STATE_KEY = 'battlemetrics.lastSync';
const OWNERS_KEY = 'battlemetrics.listBans'; // settings row: {[banListId]: [BM ban ids last read on it]}
const SYNC_LISTS_MAX = 20; // per-list run records kept, newest first

// BM allows 300 requests a minute per token, with a burst limit near five a
// second. Tests shrink these through deps.timing.
const TIMING = {
  gapMs: 250, // requests start at least this far apart
  timeoutMs: 30 * 1000, // per attempt
  attempts: 4, // 408 / 429 / 5xx / unreachable are tried again
  retryDelaysMs: [1000, 3000, 8000],
  rateLimitWaitMs: 60 * 1000, // a 429 or a spent budget without Retry-After
  maxWaitMs: 2 * 60 * 1000, // a longer Retry-After fails the request instead
  bootDelayMs: 60 * 1000, // the soonest an auto-sync runs after start/reconfigure
  retryFailedMs: 30 * 60 * 1000, // next auto-sync after a run that could not finish its read
};
const LOW_REMAINING = 5; // X-Rate-Limit-Remaining below this pauses requests

// A complete read is still distrusted when it found no bans while BM counts
// some (the token may see the list but not its bans), or this many fewer than
// BM's active count on the first page beyond what the count drifted by while
// reading (pages went missing). BM's counts run a few off, so small gaps pass.
const COUNT_SHORT_MIN = 10;
const COUNT_SHORT_SHARE = 0.01;

const LIST_COUNTS_MAX = 10; // ban lists that get a count request in listBanLists
const ERRORS_MAX = 20;
const NAME_MAX = 64;
const REASON_MAX = 480; // same cap as reasons issued in the panel
const NOTE_MAX = 2000; // same cap as notes written in the panel

const LIST_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const BAN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SERVER_ID_RE = /^\d{1,12}$/;
const STEAM_ID_RE = /^7656\d{13}$/;
const STEAM_RUN_RE = /(?<!\d)\d{17}(?!\d)/;
const EOS_RUN_RE = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/i;

// status = the HTTP status the API layer answers with; unset = upstream (502).
class BmError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'BmError';
    if (status) this.status = status;
  }
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function noBrackets(s) {
  return s.replace(/\[/g, '(').replace(/\]/g, ')');
}

function countOf(v) {
  return Number.isInteger(v) && v >= 0 ? v : null;
}

// Identifier values are only ever taken from strings: a 17-digit SteamID that
// went through a JSON number has lost precision and names another account.
function steamIn(v) {
  if (typeof v !== 'string') return null;
  const m = STEAM_RUN_RE.exec(v);
  return m && STEAM_ID_RE.test(m[0]) ? m[0] : null;
}
function eosIn(v) {
  if (typeof v !== 'string') return null;
  const m = EOS_RUN_RE.exec(v);
  return m ? m[0].toLowerCase() : null;
}

// The ban's SteamID / EOS id: an admin-added (manual) one first, else the
// first. Entries are {type, identifier|value, manual?, metadata?}.
// `unreadable`: the attribute is not a list, or an entry could name a
// SteamID/EOS id without saying which (a bare number references an
// identifier the ban does not inline; no type; a Steam/EOS entry without a
// string value) — not the same answer as "names none".
function readIdentifiers(list) {
  const steam = [];
  const eos = [];
  let unreadable = !Array.isArray(list);
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || typeof it !== 'object' || Array.isArray(it) || typeof it.type !== 'string') {
      unreadable = true;
      continue;
    }
    const manual = it.manual === true;
    // A family-share owner id names the account that lent the game, not the player.
    if (/steam/i.test(it.type) && /owner|share|family/i.test(it.type)) continue;
    if (/steam/i.test(it.type)) {
      const profile = it.metadata && typeof it.metadata === 'object' ? it.metadata.profile : null;
      const values = [it.identifier, it.value, profile && typeof profile === 'object' ? profile.steamid : null];
      if (!values.some((v) => typeof v === 'string')) unreadable = true;
      const id = steamIn(values[0]) || steamIn(values[1]) || steamIn(values[2]);
      if (id) steam.push({ id, manual });
    } else if (/eos/i.test(it.type)) {
      if (typeof it.identifier !== 'string' && typeof it.value !== 'string') unreadable = true;
      const id = eosIn(it.identifier) || eosIn(it.value);
      if (id) eos.push({ id, manual });
    }
  }
  const pick = (xs) => (xs.find((x) => x.manual) || xs[0] || { id: null }).id;
  return { steamId: pick(steam), eosId: pick(eos), unreadable };
}

// The panel's note rule: line breaks and tabs stay, other control characters
// go. Well-formed after the cut, so the stored copy compares equal next sync.
function cleanNote(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, NOTE_MAX).toWellFormed();
  return s || null;
}

function relId(res, name) {
  const rel = res.relationships && typeof res.relationships === 'object' ? res.relationships[name] : null;
  const data = rel && typeof rel === 'object' ? rel.data : null;
  return data && typeof data === 'object' && data.id != null ? String(data.id) : null;
}

// One ban resource -> {id, issuedAt, expiresAt, steamId, eosId, reason, note,
// playerName, serverOnly} or {id?, bad} for a shape the import cannot trust.
// serverOnly: the BM server id a server-only (orgWide false) ban is limited to.
function parseBan(res, names) {
  if (!res || typeof res !== 'object' || Array.isArray(res)) return { bad: 'not an object' };
  const id = typeof res.id === 'string' || typeof res.id === 'number' ? String(res.id).trim() : '';
  if (!BAN_ID_RE.test(id)) return { bad: 'no usable id' };
  const a = res.attributes;
  if (!a || typeof a !== 'object') return { id, bad: 'no attributes' };
  // A ban whose expiry is unreadable is neither imported nor deactivated.
  if (!Object.prototype.hasOwnProperty.call(a, 'expires')) return { id, bad: 'no expiry' };
  let expiresAt = null;
  if (a.expires !== null) {
    expiresAt = typeof a.expires === 'string' ? Date.parse(a.expires) : NaN;
    if (!Number.isFinite(expiresAt)) return { id, bad: 'unreadable expiry' };
  }
  const ts = typeof a.timestamp === 'string' ? Date.parse(a.timestamp) : NaN;
  const ids = readIdentifiers(a.identifiers);
  // Nor is a ban in force whose identity is unreadable (an expired one needs none).
  const expired = expiresAt != null && expiresAt <= Date.now();
  if (!expired && !ids.steamId && !ids.eosId && ids.unreadable) return { id, bad: 'unreadable identifiers' };
  const playerId = relId(res, 'player');
  const server = relId(res, 'server');
  return {
    id,
    issuedAt: Number.isFinite(ts) ? ts : null,
    expiresAt,
    steamId: ids.steamId,
    eosId: ids.eosId,
    reason: noBrackets(cleanText(a.reason, REASON_MAX)) || null,
    note: cleanNote(a.note),
    playerName: playerId != null ? names.get(playerId) || null : null,
    serverOnly: a.orgWide === false && server != null && SERVER_ID_RE.test(server) ? server : null,
  };
}

function readPage(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.data)) {
    throw new BmError('BattleMetrics returned an unexpected page (no data list)');
  }
  const names = new Map();
  for (const inc of Array.isArray(json.included) ? json.included : []) {
    if (!inc || inc.type !== 'player' || inc.id == null || !inc.attributes) continue;
    const name = cleanText(inc.attributes.name, NAME_MAX);
    if (name) names.set(String(inc.id), name);
  }
  const meta = json.meta && typeof json.meta === 'object' ? json.meta : {};
  const links = json.links && typeof json.links === 'object' ? json.links : {};
  const next = links.next;
  return {
    data: json.data,
    names,
    active: countOf(meta.active),
    total: countOf(meta.total),
    next: typeof next === 'string' && next ? next
      : (next && typeof next === 'object' && typeof next.href === 'string' && next.href ? next.href : null),
  };
}

function retryAfterMs(res) {
  const v = res.headers.get('retry-after');
  if (v == null || String(v).trim() === '') return null;
  const n = Number(v);
  const ms = Number.isFinite(n) ? n * 1000 : Date.parse(v) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

function netReason(e) {
  const c = e && e.cause;
  if (c && typeof c.code === 'string') return c.code;
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'timed out';
  return 'network error';
}

function httpMessage(path, status, detail) {
  if (status === 401) return 'BattleMetrics rejected the API token (HTTP 401) — check that it is complete and not revoked';
  if (status === 403) return 'BattleMetrics refused access (HTTP 403) — the token needs the ban list and bans permissions for this list';
  if (status === 404 && path === '/bans') return 'BattleMetrics does not know this ban list (HTTP 404) — check the ban list id and that the token can see it';
  return `BattleMetrics answered HTTP ${status} to GET ${path}${detail ? `: ${detail}` : ''}`;
}

function createBattlemetrics(deps) {
  const d = deps || {};
  const db = d.db;
  const config = d.config || {};
  const log = d.log && typeof d.log.info === 'function' ? d.log : utilLog;
  const bus = d.bus || null;
  const timing = Object.assign({}, TIMING, d.timing || {});

  let started = false;
  let timer = null;
  let nextSyncAt = null;
  let inFlight = null; // {listId, promise}
  let life = new AbortController(); // stop() aborts every request in flight
  let nextSlot = 0; // pacing: the earliest the next request may start
  let pausedUntil = 0; // rate limit: nothing is sent before this
  let lastCache; // undefined = not loaded yet

  // Read live: the Settings API changes config.battlemetrics in place.
  function settings() {
    const b = config.battlemetrics && typeof config.battlemetrics === 'object' ? config.battlemetrics : {};
    const hours = Number(b.syncHours);
    const serverId = b.serverId == null ? '' : String(b.serverId).trim();
    return {
      token: typeof b.token === 'string' ? b.token.trim() : '',
      banListId: typeof b.banListId === 'string' ? b.banListId.trim() : '',
      autoSync: b.autoSync === true,
      syncHours: Number.isFinite(hours) && hours >= 1 ? Math.min(hours, 168) : 6,
      serverId: SERVER_ID_RE.test(serverId) ? serverId : '', // this game server's BM id; '' = unknown
    };
  }

  function apiBase() {
    const b = config.battlemetrics && typeof config.battlemetrics === 'object' ? config.battlemetrics : {};
    const raw = d.apiBase || (typeof b.apiBase === 'string' && b.apiBase) || API_BASE;
    return String(raw).replace(/\/+$/, '');
  }

  function scrub(text) {
    let s = String(text == null ? '' : text);
    const t = settings().token;
    if (t.length >= 3) s = s.split(t).join('•••');
    return s;
  }

  function addError(out, msg) {
    if (out.errors.length < ERRORS_MAX) out.errors.push(scrub(msg));
  }

  // ------------------------------------------------------------ http client

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new BmError('BattleMetrics request stopped'));
      const t = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      function onAbort() {
        clearTimeout(t);
        reject(new BmError('BattleMetrics request stopped'));
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Requests start at least gapMs apart and never inside a rate-limit pause;
  // a pause longer than maxWaitMs fails the call rather than hang it. Slots
  // are taken synchronously, so concurrent callers queue up in order.
  async function turn(signal) {
    for (;;) {
      const now = Date.now();
      if (pausedUntil - now > timing.maxWaitMs) {
        throw new BmError(`BattleMetrics rate limit — try again in ${Math.ceil((pausedUntil - now) / 1000)}s`);
      }
      const at = Math.max(nextSlot, pausedUntil);
      if (at <= now) {
        nextSlot = now + timing.gapMs;
        return;
      }
      await sleep(at - now, signal);
    }
  }

  function pause(ms) {
    pausedUntil = Math.max(pausedUntil, Date.now() + ms);
  }

  async function errorDetail(res) {
    let text = '';
    try { text = await res.text(); } catch (_e) { return ''; }
    try {
      const j = JSON.parse(text);
      if (j && Array.isArray(j.errors)) {
        return j.errors.slice(0, 2)
          .map((e) => cleanText(e && (typeof e.detail === 'string' ? e.detail : e.title), 120))
          .filter(Boolean).join('; ');
      }
    } catch (_e) { /* not JSON:API */ }
    return '';
  }

  async function getJson(url, token, signal) {
    const path = url.pathname;
    for (let attempt = 1; ; attempt++) {
      await turn(signal);
      let res;
      try {
        res = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': 'A3-Admin-panel' },
          // A redirect could carry the Authorization header elsewhere.
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(timing.timeoutMs)]),
        });
      } catch (e) {
        if (signal.aborted) throw new BmError('BattleMetrics request stopped');
        if (attempt >= timing.attempts) {
          throw new BmError(`could not reach BattleMetrics for GET ${path} (${netReason(e)})`);
        }
        await sleep(timing.retryDelaysMs[Math.min(attempt, timing.retryDelaysMs.length) - 1] || 0, signal);
        continue;
      }
      // The token's budget is shared with anything else using it: nearly
      // spent, the next requests wait for the window to turn over.
      const remaining = res.headers.get('x-rate-limit-remaining');
      if (remaining != null && remaining.trim() !== '' && Number(remaining) < LOW_REMAINING) {
        const wait = retryAfterMs(res);
        pause(wait != null ? Math.min(wait, timing.maxWaitMs) : timing.rateLimitWaitMs);
      }
      if (res.ok) {
        try {
          return await res.json();
        } catch (_e) {
          throw new BmError(`BattleMetrics answered GET ${path} with invalid JSON`);
        }
      }
      const detail = await errorDetail(res);
      if (res.status === 429) {
        const wait = retryAfterMs(res);
        if (wait != null && wait > timing.maxWaitMs) {
          pause(wait);
          throw new BmError(`BattleMetrics rate limit: it asks to wait ${Math.ceil(wait / 1000)}s — try again later`);
        }
        pause(wait != null ? wait : timing.rateLimitWaitMs);
        if (attempt >= timing.attempts) throw new BmError('BattleMetrics rate limit (HTTP 429) — try again in a minute');
        continue;
      }
      if ((res.status >= 500 || res.status === 408) && attempt < timing.attempts) {
        await sleep(timing.retryDelaysMs[Math.min(attempt, timing.retryDelaysMs.length) - 1] || 0, signal);
        continue;
      }
      throw new BmError(httpMessage(path, res.status, detail));
    }
  }

  function withParams(url, params) {
    for (const k of Object.keys(params)) url.searchParams.set(k, params[k]);
    return url;
  }

  function pageKey(url) {
    const p = new URLSearchParams(url.searchParams);
    p.sort();
    return `${url.pathname}?${p.toString()}`;
  }

  // Every page of a collection. A next link is followed only on the same
  // origin and path (the token goes nowhere else), each page once, and asks
  // for our params again: BM's links need not repeat a request's filters.
  async function readPages(path, params, token, signal, onPage) {
    const base = new URL(apiBase() + path);
    const visited = new Set();
    let url = withParams(new URL(base.href), params);
    for (let n = 0; url; n++) {
      if (n >= MAX_PAGES) throw new BmError(`BattleMetrics gave more than ${MAX_PAGES} pages for ${path}`);
      const key = pageKey(url);
      if (visited.has(key)) throw new BmError('BattleMetrics pagination led back to a page already read');
      visited.add(key);
      const page = readPage(await getJson(url, token, signal));
      onPage(page, n);
      if (!page.next) return;
      let next;
      try {
        next = new URL(page.next, base);
      } catch (_e) {
        throw new BmError('BattleMetrics returned an unreadable pagination link');
      }
      if (next.origin !== base.origin || next.pathname !== base.pathname) {
        throw new BmError('BattleMetrics returned a pagination link to another address — not followed');
      }
      url = withParams(next, params);
    }
  }

  // ----------------------------------------------------------- persistence

  function lastSync() {
    if (lastCache !== undefined) return lastCache;
    lastCache = null;
    try {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(STATE_KEY);
      const v = r && r.value != null ? JSON.parse(String(r.value)) : null;
      if (v && typeof v === 'object' && Number.isFinite(Number(v.at))) lastCache = v;
    } catch (e) {
      log.warn('battlemetrics', `last sync record unreadable: ${e.message}`);
    }
    return lastCache;
  }

  function saveLastSync(v) {
    lastCache = v;
    try {
      db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(STATE_KEY, JSON.stringify(v));
    } catch (e) {
      log.warn('battlemetrics', `could not save the sync record: ${e.message}`);
    }
  }

  // {at, complete} of this list's latest run, or null.
  function syncOf(listId) {
    const last = lastSync();
    if (!last) return null;
    const lists = last.lists && typeof last.lists === 'object' ? last.lists : {};
    const rec = Object.prototype.hasOwnProperty.call(lists, listId) ? lists[listId]
      : (last.banListId === listId ? last : null);
    return rec && typeof rec === 'object' && Number.isFinite(Number(rec.at)) ? rec : null;
  }

  // The latest run record, keeping every other list's own latest run.
  function recordRun(listId, at, complete, result) {
    const last = lastSync();
    const prev = last && last.lists && typeof last.lists === 'object' ? last.lists : {};
    const kept = Object.keys(prev)
      .filter((id) => id !== listId && LIST_ID_RE.test(id) && prev[id] && Number.isFinite(Number(prev[id].at)))
      .sort((x, y) => Number(prev[y].at) - Number(prev[x].at))
      .slice(0, SYNC_LISTS_MAX - 1);
    const lists = { [listId]: { at, complete } };
    for (const id of kept) lists[id] = { at: Number(prev[id].at), complete: prev[id].complete !== false };
    saveLastSync({ at, banListId: listId, complete, result, lists });
  }

  // BM ban id -> the list it was last read on. An unreadable record reads as
  // empty: until each list is read again, absence then deactivates nothing.
  function loadOwners() {
    const owners = new Map();
    let v = null;
    try {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(OWNERS_KEY);
      v = r && r.value != null ? JSON.parse(String(r.value)) : null;
    } catch (e) {
      log.warn('battlemetrics', `ban list membership record unreadable: ${e.message}`);
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return owners;
    for (const listId of Object.keys(v)) {
      if (!LIST_ID_RE.test(listId) || !Array.isArray(v[listId])) continue;
      for (const id of v[listId]) if (typeof id === 'string' && BAN_ID_RE.test(id)) owners.set(id, listId);
    }
    return owners;
  }

  // Grouped by list; only ids with a stored row (nothing else is deactivated).
  function saveOwners(owners, stored) {
    const byList = new Map();
    for (const [id, listId] of owners) {
      if (!stored.has(id)) continue;
      if (!byList.has(listId)) byList.set(listId, []);
      byList.get(listId).push(id);
    }
    db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(OWNERS_KEY, JSON.stringify(Object.fromEntries(byList)));
  }

  // ------------------------------------------------------------- db mirror

  // Known player by EOS id, then SteamID; else a stub row named from BM, like
  // the stub a panel ban of an unseen SteamID makes. Its first/last seen is
  // the ban's time, so thousands of imported stubs do not crowd the players
  // list's "recently seen" end; a later connect by that EOS id adopts it.
  function playerFor(ban, now) {
    if (ban.eosId) {
      const r = db.prepare('SELECT id FROM players WHERE eos_id = ?').get(ban.eosId);
      if (r) return Number(r.id);
    }
    if (ban.steamId) {
      const r = db.prepare('SELECT id FROM players WHERE steam_id = ? ORDER BY last_seen DESC LIMIT 1').get(ban.steamId);
      if (r) return Number(r.id);
    }
    const t = ban.issuedAt != null ? ban.issuedAt : now;
    const ins = db.prepare('INSERT INTO players(eos_id, steam_id, name, first_seen, last_seen) VALUES(?,?,?,?,?)')
      .run(ban.eosId, ban.steamId, ban.playerName || '(BattleMetrics ban)', t, t);
    return Number(ins.lastInsertRowid);
  }

  function deactivate(rowId, now, expiresAt) {
    if (expiresAt === undefined) {
      db.prepare('UPDATE bans SET active = 0, unbanned_at = ? WHERE id = ?').run(now, rowId);
    } else {
      db.prepare('UPDATE bans SET active = 0, unbanned_at = ?, expires_at = ? WHERE id = ?').run(now, expiresAt, rowId);
    }
  }

  // here = this game server's BM id ('' = unknown). True when a row was inserted.
  function applyBan(ban, row, now, here, out) {
    if (ban.expiresAt != null && ban.expiresAt <= now) {
      if (row && row.active) {
        deactivate(row.id, now, ban.expiresAt);
        out.deactivated++;
      }
      return false;
    }
    if (here && ban.serverOnly && ban.serverOnly !== here) {
      // Limited to another BM server: not in force here.
      if (row && row.active) {
        deactivate(row.id, now);
        out.deactivated++;
      }
      return false;
    }
    if (!ban.steamId && !ban.eosId) {
      out.skippedNoIdentifier++;
      // Its old identifiers are no longer banned upstream.
      if (row && row.active) {
        deactivate(row.id, now);
        out.deactivated++;
      }
      return false;
    }
    const durationSec = ban.expiresAt == null ? 0
      : (ban.issuedAt != null ? Math.max(0, Math.round((ban.expiresAt - ban.issuedAt) / 1000)) : null);
    if (!row) {
      const playerId = playerFor(ban, now);
      db.prepare(
        `INSERT INTO bans(player_id, steam_id, eos_id, issued_by, issued_at, duration_sec, expires_at, reason, note,
           interval_raw, active, rcon_ok, source, external_id)
         VALUES(?,?,?,NULL,?,?,?,?,?,NULL,1,NULL,?,?)`
      ).run(playerId, ban.steamId, ban.eosId, ban.issuedAt, durationSec, ban.expiresAt, ban.reason, ban.note, SOURCE, ban.id);
      out.imported++;
      return true;
    }
    const idsChanged = row.steam_id !== ban.steamId || row.eos_id !== ban.eosId;
    const playerId = idsChanged || row.player_id == null ? playerFor(ban, now) : Number(row.player_id);
    const active = row.unbanned_by != null ? 0 : 1; // a panel unban stands
    const same = Number(row.player_id) === playerId && !idsChanged
      && row.reason === ban.reason && row.note === ban.note
      && row.issued_at === ban.issuedAt && row.expires_at === ban.expiresAt
      && row.duration_sec === durationSec && Number(row.active) === active;
    if (same) return false;
    db.prepare(
      `UPDATE bans SET player_id = ?, steam_id = ?, eos_id = ?, issued_at = ?, duration_sec = ?, expires_at = ?,
         reason = ?, note = ?, active = ?, unbanned_at = CASE WHEN ? = 1 THEN NULL ELSE unbanned_at END
       WHERE id = ?`
    ).run(playerId, ban.steamId, ban.eosId, ban.issuedAt, durationSec, ban.expiresAt, ban.reason, ban.note,
      active, active, row.id);
    out.updated++;
    return false;
  }

  // One read of list `listId` into the db, with the list membership record in
  // the same transaction.
  function applyRead(read, listId, here, out) {
    const now = Date.now();
    const rows = new Map();
    for (const r of db.prepare(
      `SELECT id, external_id, player_id, steam_id, eos_id, reason, note, issued_at, expires_at, duration_sec, active,
              unbanned_by
         FROM bans WHERE source = ?`
    ).all(SOURCE)) {
      if (r.external_id != null) rows.set(String(r.external_id), r);
    }
    const owners = loadOwners();
    const stored = new Set(rows.keys());
    try {
      db.tx(() => {
        for (const ban of read.bans.values()) {
          try {
            if (applyBan(ban, rows.get(ban.id), now, here, out)) stored.add(ban.id);
          } catch (e) {
            addError(out, `ban ${ban.id} not saved: ${e.message}`);
          }
        }
        for (const id of read.seen) owners.set(id, listId);
        if (read.complete) {
          // Gone from this list. A row no list claims is never deactivated
          // by absence; the next list that lists it claims it.
          for (const [ext, row] of rows) {
            if (read.seen.has(ext) || owners.get(ext) !== listId) continue;
            owners.delete(ext);
            if (row.active) {
              deactivate(row.id, now);
              out.deactivated++;
            }
          }
        }
        saveOwners(owners, stored);
      });
    } catch (e) {
      // Rolled back: nothing of this run was written.
      out.imported = 0;
      out.updated = 0;
      out.deactivated = 0;
      throw e;
    }
  }

  // ---------------------------------------------------------------- import

  async function runImport(listId, token, here) {
    const signal = life.signal;
    const out = { fetched: 0, imported: 0, updated: 0, deactivated: 0, skippedNoIdentifier: 0, errors: [] };
    const read = {
      bans: new Map(), seen: new Set(), noId: 0, bad: 0, serverOnly: 0, elsewhere: 0,
      complete: false, firstCount: null, lastCount: null,
    };
    try {
      const params = {
        'filter[banList]': listId,
        'filter[expired]': 'false', // expired ones are also dropped client-side
        'filter[exempt]': 'false', // exempted for this organization: not in force on its servers
        include: 'player',
        'page[size]': String(PAGE_SIZE),
      };
      await readPages('/bans', params, token, signal, (page, n) => {
        if (n === 0) read.firstCount = page.active;
        if (page.active != null) read.lastCount = page.active;
        for (const res of page.data) {
          const b = parseBan(res, page.names);
          if (b.id) read.seen.add(b.id);
          else read.noId++;
          if (b.bad) {
            read.bad++;
            continue;
          }
          if (b.serverOnly && !read.bans.has(b.id)) {
            read.serverOnly++;
            if (here && b.serverOnly !== here) read.elsewhere++;
          }
          read.bans.set(b.id, b);
        }
      });
      read.complete = true;
    } catch (e) {
      addError(out, e && e.message ? e.message : String(e));
    }
    out.fetched = read.seen.size + read.noId;
    if (signal.aborted) return out; // stop(): shutting down, the db may be closing
    if (read.complete && read.firstCount != null && read.firstCount > 0) {
      const drift = Math.abs((read.lastCount != null ? read.lastCount : read.firstCount) - read.firstCount);
      const short = read.firstCount - out.fetched;
      if (out.fetched === 0
        || short > Math.max(COUNT_SHORT_MIN, Math.ceil(read.firstCount * COUNT_SHORT_SHARE)) + drift) {
        read.complete = false;
        addError(out, `BattleMetrics counts ${read.firstCount} active bans on the list but only ${out.fetched} were read — nothing was deactivated this run`);
      }
    }
    if (read.bad) addError(out, `${read.bad} ban(s) had an unexpected shape and were skipped (their stored copies were left as they were)`);
    if (!read.complete && read.bans.size) addError(out, 'the list was not read to the end: bans read were saved, none were deactivated');
    try {
      applyRead(read, listId, here, out);
    } catch (e) {
      addError(out, `saving the bans failed: ${e.message}`);
    }
    const at = Date.now();
    recordRun(listId, at, read.complete, out);
    let summary = `ban list ${listId}: ${out.fetched} read, ${out.imported} new, ${out.updated} updated, `
      + `${out.deactivated} deactivated, ${out.skippedNoIdentifier} without a Steam/EOS id`;
    if (read.serverOnly) {
      summary += here
        ? `, ${read.elsewhere} of ${read.serverOnly} server-only ban(s) for other BattleMetrics servers left out`
        : `, ${read.serverOnly} server-only ban(s) enforced as if for this server (battlemetrics.serverId unset)`;
    }
    if (out.errors.length) {
      log.warn('battlemetrics', `${summary} — ${out.errors.length} problem(s)`);
      for (const e of out.errors) log.warn('battlemetrics', e);
    } else {
      log.info('battlemetrics', summary);
    }
    if (bus) {
      try { bus.emit('battlemetrics-sync', { at, banListId: listId, result: out }); } catch (_e) { /* listener trouble is theirs */ }
    }
    return out;
  }

  // Upstream trouble lands in the result's errors; only a call that cannot
  // start throws (status 400 / 409 for the API layer).
  function importNow(opts) {
    const o = opts || {};
    const c = settings();
    if (!c.token) return Promise.reject(new BmError('save a BattleMetrics API token first', 400));
    const listId = o.banListId != null && String(o.banListId).trim() !== '' ? String(o.banListId).trim() : c.banListId;
    if (!listId) return Promise.reject(new BmError('choose a BattleMetrics ban list first', 400));
    if (!LIST_ID_RE.test(listId)) return Promise.reject(new BmError('invalid ban list id', 400));
    if (inFlight) {
      if (inFlight.listId === listId) return inFlight.promise;
      return Promise.reject(new BmError('another ban list is being imported — try again when it finishes', 409));
    }
    const promise = runImport(listId, c.token, c.serverId).finally(() => {
      inFlight = null;
      if (started) schedule();
    });
    inFlight = { listId, promise };
    return promise;
  }

  async function countBans(listId, token, signal) {
    let n = null;
    const params = { 'filter[banList]': listId, 'filter[expired]': 'false', 'filter[exempt]': 'false', 'page[size]': '1' };
    await readPages('/bans', params, token, signal, (page) => {
      n = page.active != null ? page.active : page.total;
      page.next = null; // one page is the count
    });
    return n;
  }

  async function listBanLists() {
    const c = settings();
    if (!c.token) throw new BmError('save a BattleMetrics API token first', 400);
    const signal = life.signal;
    const lists = [];
    const seen = new Set();
    await readPages('/ban-lists', { 'page[size]': String(PAGE_SIZE) }, c.token, signal, (page) => {
      for (const r of page.data) {
        if (!r || typeof r !== 'object' || r.id == null) continue;
        const id = String(r.id);
        if (!LIST_ID_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        const a = r.attributes && typeof r.attributes === 'object' ? r.attributes : {};
        const m = r.meta && typeof r.meta === 'object' ? r.meta : {};
        const banCount = countOf(a.banCount) != null ? countOf(a.banCount) : countOf(m.banCount);
        lists.push({ id, name: cleanText(a.name, 100) || id, banCount });
      }
    });
    for (const l of lists.slice(0, LIST_COUNTS_MAX)) {
      if (l.banCount != null) continue;
      try {
        l.banCount = await countBans(l.id, c.token, signal);
      } catch (_e) {
        l.banCount = null; // a subscribed list may show its name but not its bans
      }
    }
    return lists;
  }

  // ------------------------------------------------------------- auto-sync

  function schedule() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    nextSyncAt = null;
    if (!started) return;
    const c = settings();
    if (!c.autoSync || !c.token || !c.banListId) return;
    const now = Date.now();
    const period = c.syncHours * 3600 * 1000;
    // The configured list's own last run: imports of other lists do not count.
    const last = syncOf(c.banListId);
    let at = now;
    if (last) at = Number(last.at) + (last.complete === false ? Math.min(period, timing.retryFailedMs) : period);
    at = Math.max(at, now + timing.bootDelayMs);
    nextSyncAt = at;
    timer = setTimeout(() => {
      timer = null;
      nextSyncAt = null;
      importNow({}).catch((e) => {
        log.warn('battlemetrics', `auto-sync did not run: ${scrub(e && e.message ? e.message : e)}`);
      }).finally(() => {
        if (started && !timer) schedule();
      });
    }, at - now);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    started = true;
    schedule();
  }

  function stop() {
    started = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    nextSyncAt = null;
    life.abort();
    life = new AbortController();
  }

  function reconfigure() {
    schedule();
  }

  function status() {
    const c = settings();
    const last = lastSync();
    return {
      configured: !!(c.token && c.banListId),
      running: !!inFlight,
      lastSyncAt: last ? Number(last.at) : null,
      lastResult: last && last.result ? last.result : null,
      nextSyncAt,
    };
  }

  return { listBanLists, importNow, status, start, stop, reconfigure };
}

module.exports = { createBattlemetrics, BmError };
