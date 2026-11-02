'use strict';
// In-game admin calls (docs/BATCH3-CONTRACTS.md §5). A chat line from a
// player whose trimmed text starts with an adminCalls.triggers entry becomes
// an admin_calls row, a bus 'admin-call' event (relayed as SSE `admincall`),
// a Discord post mentioning the configured role, and an in-game reply to the
// caller. Config is read live on every message (Settings edits it in place).
//
// Test seam (not part of the contract): deps.now() for the clock.
const { log: utilLog, sanitizeRconArg } = require('./util');

const MESSAGE_MAX = 480;
const REPLY_MAX = 400;
const LIST_MAX = 500;
const GAME_ID_RE = /^\d{1,6}$/;
const EOS_RE = /^[0-9a-f]{32}$/;
const STEAM_ID_RE = /^7656\d{13}$/;
const WORD_CHAR_RE = /^[\p{L}\p{N}_]$/u;

function isWordChar(ch) { return !!ch && WORD_CHAR_RE.test(ch); }

/**
 * The trigger `text` starts with (case-insensitive, after trimming), or
 * null. A trigger ending in a letter or digit must end a word there:
 * "!admins" is not "!admin" (list "!admins" to accept it), "!admin please"
 * and "!admin!" are.
 */
function matchTrigger(text, triggers) {
  const low = String(text == null ? '' : text).trim().toLowerCase();
  for (const raw of Array.isArray(triggers) ? triggers : []) {
    const trig = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!trig || !low.startsWith(trig)) continue;
    const cp = low.codePointAt(trig.length);
    const next = cp == null ? '' : String.fromCodePoint(cp);
    if (isWordChar(next) && isWordChar([...trig].pop())) continue;
    return String(raw).trim();
  }
  return null;
}

function createAdminCalls(deps) {
  const d = deps || {};
  const { db, bus, state, admin, auth, webhook } = d;
  const cfg = d.config || {};
  const log = d.log || utilLog;
  const now = typeof d.now === 'function' ? d.now : () => Date.now();
  let listening = false;

  function settings() {
    const a = cfg.adminCalls || {};
    return {
      enabled: a.enabled === true,
      triggers: Array.isArray(a.triggers) ? a.triggers : [],
      roleId: typeof a.discordRoleId === 'string' ? a.discordRoleId : '',
      reply: typeof a.reply === 'string' ? a.reply : '',
      cooldownMs: Number.isInteger(a.cooldownSec) && a.cooldownSec > 0 ? a.cooldownSec * 1000 : 0,
    };
  }

  const SELECT = `SELECT c.*, u.username AS handled_by_name FROM admin_calls c
    LEFT JOIN users u ON u.id = c.handled_by`;

  function getCall(id) {
    return db.prepare(`${SELECT} WHERE c.id = ?`).get(id) || null;
  }

  // The bus 'admin-call' payload and the API row are one shape, so a live
  // update can replace a listed row as is.
  function callOut(r) {
    return {
      id: r.id, time: r.time, status: r.status,
      playerName: r.player_name == null ? null : r.player_name,
      playerDbId: r.player_id == null ? null : r.player_id,
      eosId: r.eos_id == null ? null : r.eos_id,
      steamId: r.steam_id == null ? null : r.steam_id,
      message: r.message == null ? '' : r.message,
      handledBy: r.handled_by == null ? null : r.handled_by,
      handledByName: r.handled_by_name == null ? null : r.handled_by_name,
      handledAt: r.handled_at == null ? null : r.handled_at,
      matchId: r.match_id == null ? null : r.match_id,
    };
  }

  function emit(call) {
    if (!bus) return;
    try { bus.emit('admin-call', call); } catch (e) { log.warn('admincalls', `admin-call emit failed: ${e.message}`); }
  }

  // Time of this player's latest call (any status), or null.
  function lastCallAt(dbId, eosId) {
    const row = dbId != null
      ? db.prepare('SELECT MAX(time) AS t FROM admin_calls WHERE player_id = ? OR eos_id = ?').get(dbId, eosId)
      : db.prepare('SELECT MAX(time) AS t FROM admin_calls WHERE eos_id = ?').get(eosId);
    return row && row.t != null ? Number(row.t) : null;
  }

  // "Admins have been notified" to the caller only: by in-game id while the
  // live roster has one, else by EOS id (SteamID when there is none).
  function replyTo(call, text) {
    const msg = sanitizeRconArg(text, REPLY_MAX);
    if (!msg || !admin || typeof admin.execRaw !== 'function') return null;
    const live = call.eosId && state && typeof state.byEos === 'function' ? state.byEos(call.eosId) : null;
    const gameId = live && live.playerId != null && GAME_ID_RE.test(String(live.playerId)) ? String(live.playerId) : null;
    let command = null;
    if (gameId) command = `AdminWarnById ${gameId} ${msg}`;
    else if (call.eosId && EOS_RE.test(call.eosId)) command = `AdminWarn "${call.eosId}" ${msg}`;
    else if (call.steamId) command = `AdminWarn ${call.steamId} ${msg}`;
    if (!command) return null;
    return Promise.resolve()
      .then(() => admin.execRaw(null, command, {
        action: 'admin-call-reply',
        targetPlayerId: call.playerDbId,
        details: { callId: call.id, reply: msg },
      }))
      .catch((e) => {
        log.warn('admincalls', `in-game reply failed: ${e && e.message ? e.message : e}`);
        return null;
      });
  }

  /**
   * One bus 'chat' payload ({time, matchId, channel, player, message}).
   * Returns the new call, or null when the line is not one. In-game admins
   * talking in admin chat never call themselves.
   */
  function handleChat(ev) {
    const s = settings();
    if (!s.enabled || !ev || typeof ev.message !== 'string' || ev.channel === 'admin') return null;
    const p = ev.player && typeof ev.player === 'object' ? ev.player : {};
    const eosId = typeof p.eosId === 'string' && p.eosId ? p.eosId.toLowerCase() : null;
    const dbId = Number.isInteger(Number(p.dbId)) && Number(p.dbId) > 0 ? Number(p.dbId) : null;
    if (!eosId && dbId == null) return null; // not from a player
    if (!matchTrigger(ev.message, s.triggers)) return null;
    const time = Number(ev.time) || now();
    if (s.cooldownMs) {
      const last = lastCallAt(dbId, eosId);
      if (last != null && Math.abs(time - last) < s.cooldownMs) return null;
    }
    let name = typeof p.name === 'string' && p.name ? p.name : null;
    let steamId = p.steamId != null && STEAM_ID_RE.test(String(p.steamId)) ? String(p.steamId) : null;
    if (dbId != null && (!name || !steamId)) {
      const row = db.prepare('SELECT name, steam_id FROM players WHERE id = ?').get(dbId);
      if (row) {
        if (!name && row.name) name = String(row.name);
        if (!steamId && row.steam_id && STEAM_ID_RE.test(String(row.steam_id))) steamId = String(row.steam_id);
      }
    }
    const matchId = ev.matchId != null ? ev.matchId : (state && state.match && state.match.id != null ? state.match.id : null);
    const message = ev.message.trim().slice(0, MESSAGE_MAX);
    const r = db.prepare(
      `INSERT INTO admin_calls(time, match_id, player_id, player_name, eos_id, steam_id, message, status)
       VALUES(?,?,?,?,?,?,?,'open')`
    ).run(time, matchId, dbId, name, eosId, steamId, message);
    const call = callOut(getCall(r.lastInsertRowid));
    emit(call);
    if (webhook && typeof webhook.postAdminCall === 'function') {
      try {
        webhook.postAdminCall(Object.assign({}, call, { roleId: s.roleId }));
      } catch (e) {
        log.warn('admincalls', `discord post failed: ${e.message}`);
      }
    }
    replyTo(call, s.reply);
    return call;
  }

  const onChat = (ev) => {
    try {
      handleChat(ev);
    } catch (e) {
      log.error('admincalls', `chat handling failed: ${e && e.message ? e.message : e}`);
    }
  };

  function registerRoutes(api) {
    const { route, json, ApiErr, intParam, clampInt } = api;
    const authz = api.auth || auth;
    const PERMS = ['flags', 'warn', 'kick', 'ban'];

    // ?status=open (default) | all; newest first. `open` counts every open call.
    route('GET', /^\/api\/admin-calls$/, { anyPerm: PERMS }, (ctx) => {
      const status = ctx.query.get('status') || 'open';
      if (status !== 'open' && status !== 'all') throw new ApiErr(400, "status must be 'open' or 'all'");
      const limit = clampInt(ctx.query.get('limit'), 1, LIST_MAX, 100);
      const rows = db.prepare(
        `${SELECT}${status === 'open' ? " WHERE c.status = 'open'" : ''} ORDER BY c.id DESC LIMIT ?`
      ).all(limit).map(callOut);
      const open = db.prepare("SELECT COUNT(*) AS c FROM admin_calls WHERE status = 'open'").get();
      return json(ctx.res, 200, { rows, open: open ? Number(open.c) : 0 });
    });

    // Idempotent: a call someone already handled stays theirs.
    route('POST', /^\/api\/admin-calls\/(\d+)\/handle$/, { anyPerm: PERMS }, (ctx) => {
      const id = intParam(ctx.params[1], 'call id');
      const row = getCall(id);
      if (!row) throw new ApiErr(404, 'admin call not found');
      if (row.status !== 'open') return json(ctx.res, 200, { ok: true, call: callOut(row), alreadyHandled: true });
      const r = db.prepare("UPDATE admin_calls SET status = 'handled', handled_by = ?, handled_at = ? WHERE id = ? AND status = 'open'")
        .run(ctx.user.id, now(), id);
      const call = callOut(getCall(id));
      if (r.changes) {
        authz.audit(ctx.user.id, 'admin-call-handled', {
          targetPlayerId: row.player_id == null ? null : row.player_id,
          details: { callId: id },
        });
        emit(call);
      }
      return json(ctx.res, 200, { ok: true, call });
    });
  }

  function start() {
    if (listening || !bus || typeof bus.on !== 'function') return;
    bus.on('chat', onChat);
    listening = true;
  }

  function stop() {
    if (!listening) return;
    bus.removeListener('chat', onChat);
    listening = false;
  }

  return { registerRoutes, start, stop, handleChat };
}

module.exports = { createAdminCalls, matchTrigger };
