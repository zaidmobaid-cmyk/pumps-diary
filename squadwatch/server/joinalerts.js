'use strict';
// Join alerts (docs/BATCH3-CONTRACTS.md §6). When a watchlisted player, a
// player with unreviewed flags, or a likely ban evader (shares an IP with a
// player under an active, unexpired ban) joins: a flags row plus bus 'flag'
// in ingest's shape (Trolls inbox, Discord flag webhook), bus 'join-alert'
// (SSE `alert`), Discord for watchlist/flagged hits, and — when
// joinAlerts.autoKickEvasion is on — a kick of the evader. Toggles are read
// live on every join.
//
// Only the log's PostLogin line carries a connection's IP. When the roster
// poll announced the connection first, ingest adopts that session silently
// once the line lands: ban evasion is checked again then.
//
// Test seams (not part of the contract): deps.now() for the clock and
// deps.defer(fn) for when a bus event is processed.
const { log: utilLog } = require('./util');

const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
// One alert per player per type in this window.
const DEDUPE_MS = 10 * MIN;
// A join reported this late (log backfill, a long-stalled log source) is
// history: nothing to alert on, nobody to kick.
const STALE_MS = 10 * MIN;
// Two accounts share an address only when their use of it came within this
// long of each other: an address the ISP handed to someone else later links
// no one.
const SHARE_WINDOW_MS = 30 * DAY;
// An address more than this many other accounts used inside that window is
// a shared exit (carrier-grade NAT, café, VPN): it links no one.
const SHARED_EXIT_ACCOUNTS = 5;
// The joiner's most recently used addresses that are looked at.
const OWN_IPS_MAX = 50;
// Game-server log clock vs panel clock, as ingest allows.
const CLOCK_SLACK_MS = 60 * 1000;
// Players whose latest join announcement is remembered.
const JOINS_MAX = 5000;
const SEVERITY = { 'watchlist-join': 1, 'flagged-join': 1, 'ban-evasion': 3 };
// Flags these alerts write never count as "flagged" themselves, or one flag
// would re-alert on every join forever; nor as offences (api.js Trolls board).
const JOIN_FLAG_TYPES = Object.keys(SEVERITY);
const GAME_ID_RE = /^\d{1,6}$/;
const STEAM_ID_RE = /^7656\d{13}$/;
const KICK_REASON = 'Ban evasion - this account is linked to a banned player';

function posInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function createJoinAlerts(deps) {
  const d = deps || {};
  const { db, bus, state, admin, webhook } = d;
  const cfg = d.config || {};
  const log = d.log || utilLog;
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  // The log path announces a join at its PostLogin line; the name comes on
  // the very next line, so a bus join is looked at once that has landed.
  const defer = typeof d.defer === 'function' ? d.defer : (fn) => setImmediate(fn);
  let listening = false;
  // eos id -> {time, linked}: its latest join announcement, and whether that
  // join's check already linked the player to a ban (and acted on it).
  const joins = new Map();

  function noteJoin(eosId, time) {
    joins.delete(eosId);
    joins.set(eosId, { time, linked: false });
    if (joins.size > JOINS_MAX) joins.delete(joins.keys().next().value);
  }

  function toggles() {
    const j = cfg.joinAlerts || {};
    return {
      watchlist: j.watchlist === true,
      flagged: j.flagged === true,
      banEvasion: j.banEvasion === true,
      autoKickEvasion: j.autoKickEvasion === true,
    };
  }

  // ingest.ref's §19.1.1 playerRef shape.
  function ref(rec, extra) {
    const r = rec || {};
    const x = extra || {};
    const pick = (a, b) => (a != null ? a : (b != null ? b : null));
    return {
      dbId: pick(r.dbId, x.dbId),
      eosId: pick(r.eosId, x.eosId),
      steamId: pick(r.steamId, x.steamId),
      name: pick(r.name, x.name),
      teamId: pick(r.teamId, x.teamId),
      squadId: pick(r.squadId, x.squadId),
      sessKills: rec ? (r.sessKills != null ? r.sessKills : null) : null,
      sessDeaths: rec ? (r.sessDeaths != null ? r.sessDeaths : null) : null,
      sessTks: rec ? (r.sessTks != null ? r.sessTks : null) : null,
    };
  }

  function unreviewedFlags(dbId) {
    const rows = db.prepare(
      `SELECT type, COUNT(*) AS n FROM flags
        WHERE player_id = ? AND reviewed = 0 AND type NOT IN (SELECT value FROM json_each(?))
        GROUP BY type ORDER BY n DESC, type`
    ).all(dbId, JSON.stringify(JOIN_FLAG_TYPES));
    let count = 0;
    for (const r of rows) count += Number(r.n);
    return { count, types: rows.map((r) => r.type) };
  }

  // Does ban row `b` name players row `p` (by db id, SteamID or EOS id)?
  function banNames(b, p) {
    if (b.player_id != null && Number(b.player_id) === Number(p.id)) return true;
    if (b.steam_id != null && p.steam_id != null && String(b.steam_id) === String(p.steam_id)) return true;
    return b.eos_id != null && p.eos_id != null && String(b.eos_id).toLowerCase() === String(p.eos_id).toLowerCase();
  }

  // Does link `a` outrank `b`: permanent bans first, then the latest expiry,
  // then more shared addresses, then the newest ban.
  function outranks(a, b) {
    const ap = a.ban.expires_at == null;
    const bp = b.ban.expires_at == null;
    if (ap !== bp) return ap;
    if (!ap && Number(a.ban.expires_at) !== Number(b.ban.expires_at)) return Number(a.ban.expires_at) > Number(b.ban.expires_at);
    if (a.shared !== b.shared) return a.shared > b.shared;
    return Number(a.ban.id) > Number(b.ban.id);
  }

  // The banned player this one shares an address with, or null; never the
  // IP itself. Bounded work on every join: indexed lookups for the joiner's
  // latest addresses, then — only when someone shares one — a single pass
  // over bans for everyone involved. A ban naming the joiner directly is
  // ingest's ban enforcement, not evasion.
  function evasionLink(player, at) {
    const mine = db.prepare(
      'SELECT ip, first_seen, last_seen FROM player_ips WHERE player_id = ? ORDER BY last_seen DESC LIMIT ?'
    ).all(player.id, OWN_IPS_MAX);
    const near = db.prepare(
      `SELECT player_id FROM player_ips
        WHERE ip = ? AND player_id <> ? AND first_seen <= ? AND last_seen >= ? LIMIT ?`
    );
    const shared = new Map(); // other player id -> addresses shared with them
    for (const m of mine) {
      const others = near.all(m.ip, player.id, Number(m.last_seen) + SHARE_WINDOW_MS,
        Number(m.first_seen) - SHARE_WINDOW_MS, SHARED_EXIT_ACCOUNTS + 1);
      if (others.length > SHARED_EXIT_ACCOUNTS) continue;
      for (const o of others) shared.set(Number(o.player_id), (shared.get(Number(o.player_id)) || 0) + 1);
    }
    if (!shared.size) return null;
    const people = db.prepare('SELECT id, name, steam_id, eos_id FROM players WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([player.id, ...shared.keys()]));
    const list = (f) => JSON.stringify(people.map(f).filter((v) => v != null).map(String));
    const active = db.prepare(
      `SELECT id, player_id, steam_id, eos_id, expires_at FROM bans
        WHERE active = 1 AND (expires_at IS NULL OR expires_at > ?)
          AND (player_id IN (SELECT value FROM json_each(?))
               OR steam_id IN (SELECT value FROM json_each(?))
               OR lower(eos_id) IN (SELECT value FROM json_each(?)))`
    ).all(at, JSON.stringify(people.map((p) => Number(p.id))), list((p) => p.steam_id),
      list((p) => (p.eos_id == null ? null : String(p.eos_id).toLowerCase())));
    if (!active.length || active.some((b) => banNames(b, player))) return null;
    let best = null;
    for (const p of people) {
      if (Number(p.id) === Number(player.id)) continue;
      for (const b of active) {
        if (!banNames(b, p)) continue;
        const link = { ban: b, other: p, shared: shared.get(Number(p.id)) || 0 };
        if (!best || outranks(link, best)) best = link;
      }
    }
    if (!best) return null;
    return {
      banId: Number(best.ban.id), bannedPlayerId: Number(best.other.id),
      bannedPlayerName: best.other.name == null ? null : best.other.name, sharedIps: best.shared,
    };
  }

  // The flag row + bus events + Discord for one hit, unless this player had
  // this alert inside the dedupe window. -> {flagId, alert|null}.
  function raise(type, ctx, details) {
    const last = db.prepare('SELECT id, time FROM flags WHERE player_id = ? AND type = ? ORDER BY id DESC LIMIT 1')
      .get(ctx.dbId, type);
    if (last && Math.abs(ctx.time - Number(last.time)) < DEDUPE_MS) return { flagId: Number(last.id), alert: null };
    const severity = SEVERITY[type];
    const r = db.prepare('INSERT INTO flags(player_id, time, type, severity, match_id, details) VALUES(?,?,?,?,?,?)')
      .run(ctx.dbId, ctx.time, type, severity, ctx.matchId, JSON.stringify(details));
    const flagId = r.lastInsertRowid;
    const alert = { type, time: ctx.time, player: { dbId: ctx.dbId, name: ctx.name }, details, flagId, severity };
    if (bus) {
      try {
        bus.emit('flag', {
          time: ctx.time, flagId, type, severity,
          player: ref(ctx.rec, { dbId: ctx.dbId, eosId: ctx.eosId, steamId: ctx.steamId, name: ctx.name }),
          matchId: ctx.matchId, details,
        });
        bus.emit('join-alert', alert);
      } catch (e) {
        log.warn('joinalerts', `alert emit failed: ${e.message}`);
      }
    }
    if (type !== 'ban-evasion' && webhook && typeof webhook.postJoinAlert === 'function') {
      try { webhook.postJoinAlert(alert); } catch (e) { log.warn('joinalerts', `discord post failed: ${e.message}`); }
    }
    return { flagId, alert };
  }

  // SteamID first: it names exactly this account, while an in-game id read
  // at join time may still be the previous connection's.
  function kickCommand(ctx) {
    if (ctx.steamId) return `AdminKick ${ctx.steamId} ${KICK_REASON}`;
    const gameId = ctx.rec && ctx.rec.playerId != null && GAME_ID_RE.test(String(ctx.rec.playerId))
      ? String(ctx.rec.playerId) : null;
    return gameId ? `AdminKickById ${gameId} ${KICK_REASON}` : null;
  }

  function kickEvader(ctx, link, flagId) {
    const command = kickCommand(ctx);
    if (!command || !admin || typeof admin.execRaw !== 'function') return null;
    return Promise.resolve()
      .then(() => admin.execRaw(null, command, {
        action: 'join-alert-kick',
        targetPlayerId: ctx.dbId,
        details: { flagId, banId: link.banId, bannedPlayerId: link.bannedPlayerId, reason: KICK_REASON },
      }))
      .catch((e) => {
        log.warn('joinalerts', `evasion kick failed: ${e && e.message ? e.message : e}`);
        return null;
      });
  }

  // One join ({time, player}) -> the alerts raised. `evasionOnly`: the join
  // was looked at in full already, before its IP was known.
  function run(ev, evasionOnly) {
    const t = toggles();
    if (evasionOnly ? !t.banEvasion : (!t.watchlist && !t.flagged && !t.banEvasion)) return [];
    const p = ev && ev.player && typeof ev.player === 'object' ? ev.player : {};
    const time = Number(ev && ev.time) || now();
    if (now() - time > STALE_MS) return [];
    let dbId = posInt(p.dbId);
    const evEos = typeof p.eosId === 'string' && p.eosId ? p.eosId.toLowerCase() : null;
    if (dbId == null && evEos) {
      const row = db.prepare('SELECT id FROM players WHERE eos_id = ?').get(evEos);
      dbId = row ? Number(row.id) : null;
    }
    if (dbId == null) return [];
    const player = db.prepare('SELECT id, eos_id, steam_id, name, watchlisted FROM players WHERE id = ?').get(dbId);
    if (!player) return [];
    const eosId = player.eos_id ? String(player.eos_id).toLowerCase() : evEos;
    const rec = eosId && state && typeof state.byEos === 'function' ? state.byEos(eosId) : null;
    const steam = [p.steamId, rec && rec.steamId, player.steam_id].find((s) => s != null && STEAM_ID_RE.test(String(s)));
    const ctx = {
      dbId, eosId, rec, time,
      steamId: steam ? String(steam) : null,
      name: (rec && rec.name) || player.name || (typeof p.name === 'string' && p.name) || null,
      matchId: state && state.match && state.match.id != null ? state.match.id : null,
    };
    const out = [];
    const keep = (r) => { if (r.alert) out.push(r.alert); return r; };
    if (!evasionOnly && t.watchlist && Number(player.watchlisted) === 1) {
      keep(raise('watchlist-join', ctx, { reason: 'Watchlisted player joined' }));
    }
    if (!evasionOnly && t.flagged) {
      const f = unreviewedFlags(dbId);
      if (f.count) {
        keep(raise('flagged-join', ctx, {
          reason: `Joined with ${f.count} unreviewed flag${f.count === 1 ? '' : 's'}`,
          unreviewed: f.count, types: f.types.slice(0, 5),
        }));
      }
    }
    if (t.banEvasion) {
      const link = evasionLink(player, Math.max(time, now()));
      if (link) {
        const j = eosId ? joins.get(eosId) : null;
        if (j) j.linked = true;
        const details = Object.assign({ reason: 'Shares an IP address with a banned player' }, link);
        if (t.autoKickEvasion && kickCommand(ctx)) details.autoKick = true;
        const r = keep(raise('ban-evasion', ctx, details));
        if (t.autoKickEvasion) kickEvader(ctx, link, r.flagId);
      }
    }
    return out;
  }

  /**
   * One bus 'player-connected' payload ({time, player}). Returns the alerts
   * raised (deduped hits are left out); an evader is kicked on every join
   * while auto-kick is on, deduped or not.
   */
  function check(ev) {
    return run(ev, false);
  }

  /**
   * One bus 'log-event' PLAYER_CONNECTED line, once ingest has stored its IP.
   * A line ingest announced as the join was looked at in full by check(). One
   * it adopted silently — the roster announced that connection first — gets
   * the ban-evasion check now, unless that join's check already linked the
   * player (the roster join comes at most CLOCK_SLACK_MS before its line).
   */
  function recheck(ev) {
    const eosId = ev && typeof ev.eosId === 'string' && ev.eosId ? ev.eosId.toLowerCase() : null;
    const time = Number(ev && ev.time);
    if (!eosId || !Number.isFinite(time) || !ev.ip) return [];
    const j = joins.get(eosId);
    if (j && j.time === time) return [];
    if (j && j.linked && j.time >= time - CLOCK_SLACK_MS) return [];
    return run({ time, player: { eosId, steamId: ev.steamId || null } }, true);
  }

  const later = (what, fn) => defer(() => {
    try {
      fn();
    } catch (e) {
      log.error('joinalerts', `${what} failed: ${e && e.message ? e.message : e}`);
    }
  });

  const onConnect = (ev) => {
    const p = ev && ev.player;
    if (p && typeof p.eosId === 'string' && p.eosId) noteJoin(p.eosId.toLowerCase(), Number(ev.time));
    later('join check', () => check(ev));
  };

  const onLog = (ev) => {
    if (!ev || ev.event !== 'PLAYER_CONNECTED') return;
    later('connect line check', () => recheck(ev));
  };

  function start() {
    if (listening || !bus || typeof bus.on !== 'function') return;
    bus.on('player-connected', onConnect);
    bus.on('log-event', onLog);
    listening = true;
  }

  function stop() {
    if (!listening) return;
    bus.removeListener('player-connected', onConnect);
    bus.removeListener('log-event', onLog);
    listening = false;
  }

  // No routes of its own: alerts surface through the flags API and SSE.
  return { registerRoutes() {}, start, stop, check, recheck };
}

module.exports = { createJoinAlerts, DEDUPE_MS, JOIN_FLAG_TYPES };
