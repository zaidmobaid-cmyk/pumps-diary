'use strict';
// Admin action -> RCON command builder/executor.
// SPEC §4.3 (command catalog, ById preference, verbatim response + rconOk
// heuristic), §13 (execAdmin target resolution: params.playerId is the DB
// player id), §19.1.2 (createAdmin factory shape; system actions use user
// NULL), §19.3.17 (selector order + argument validation; validation failures
// happen BEFORE audit — nothing executed, nothing to audit).
const { log, sanitizeRconArg } = require('./util');

// §19.3.17 validation patterns.
const STEAM_ID_RE = /^7656\d{13}$/;
const SAFE_NAME_RE = /^[^"\r\n\0]{1,64}$/;
const GAME_ID_RE = /^\d{1,6}$/;
const INTERVAL_RE = /^(0|\d{1,3}[mhdwMy])$/;
const SQUAD_ID_RE = /^\d{1,4}$/;
const UNSAFE_NAME_ERROR = 'name contains unsafe characters — use the steamId';

// §4.3: responses containing these are recorded with rconOk=false.
const RCON_BAD_RE = /not found|invalid|error|unable/i;
function rconOkHeuristic(response) {
  return !RCON_BAD_RE.test(String(response == null ? '' : response));
}

// Action names (also exported so api.js can whitelist the audit filter).
const ACTION_NAMES = [
  'warn', 'kick', 'ban', 'broadcast',
  'changeLayer', 'setNextLayer', 'restartMatch', 'endMatch', 'slomo',
  'forceTeamChange', 'removeFromSquad', 'disbandSquad', 'demoteCommander',
  'raw',
];

/**
 * createAdmin({db, rcon, state, auth, config, layersCache}) ->
 *   { execAdmin(userOrNull, action, params), execRaw(userOrNull, command, auditMeta), actions }
 *
 * Both return `{ok, rconOk, command, response}` on an executed command,
 * `{ok:false, error}` on validation failure (no audit, api maps it to 400),
 * and `{ok:false, error, command, rconOk:false}` when the RCON exec itself
 * failed (audited with the error text as the response).
 */
function createAdmin({ db, rcon, state, auth, config, layersCache } = {}) {
  const cfg = config || {};
  void cfg; // config reserved (autoWarn interpolation lives in ingest)

  // ------------------------------------------------------------ target lookup

  function findLive(dbId) {
    try {
      if (!state || !state.players || typeof state.players.values !== 'function') return null;
      for (const rec of state.players.values()) {
        if (rec && Number(rec.dbId) === dbId) return rec;
      }
    } catch (_e) { /* live state unavailable */ }
    return null;
  }

  function loadRow(dbId) {
    try {
      return db.prepare('SELECT id, eos_id, steam_id, name FROM players WHERE id=?').get(dbId);
    } catch (e) {
      log.warn('admin', `player lookup failed: ${e.message}`);
      return undefined;
    }
  }

  // params.playerId = DB player id (§13); params.steamId = direct selector
  // (manual bans of never-seen players). Returns {error} on bad input.
  function resolveTarget(params) {
    const p = params || {};
    let dbId = null;
    let row;
    if (p.playerId != null && p.playerId !== '') {
      dbId = Number(p.playerId);
      if (!Number.isInteger(dbId) || dbId <= 0 || dbId > 999999999) return { error: 'invalid playerId' };
      row = loadRow(dbId);
      if (!row) return { error: 'player not found' };
    }
    const live = dbId != null ? findLive(dbId) : null;
    let steamId = null;
    if (p.steamId != null && p.steamId !== '') {
      if (!STEAM_ID_RE.test(String(p.steamId))) return { error: 'invalid steamId' };
      steamId = String(p.steamId);
    } else if (live && live.steamId && STEAM_ID_RE.test(String(live.steamId))) {
      steamId = String(live.steamId);
    } else if (row && row.steam_id && STEAM_ID_RE.test(String(row.steam_id))) {
      steamId = String(row.steam_id);
    }
    if (dbId == null && steamId == null) return { error: 'playerId or steamId required' };
    const name = live && live.name != null ? String(live.name) : (row && row.name != null ? String(row.name) : null);
    const gameId = live && live.playerId != null && GAME_ID_RE.test(String(live.playerId))
      ? String(live.playerId) : null;
    return { dbId, gameId, steamId, name, online: !!live };
  }

  // §19.3.17 selector order: (a) numeric in-game id -> ById variant (handled by
  // callers via t.gameId); (b) steamId as BARE selector, no quotes; (c) a name
  // only when it matches SAFE_NAME_RE, double-quoted.
  function selector(t, { allowSteam = true, allowName = true } = {}) {
    if (allowSteam && t.steamId) return { sel: t.steamId };
    if (allowName && t.name != null && t.name !== '') {
      if (!SAFE_NAME_RE.test(t.name)) return { error: UNSAFE_NAME_ERROR };
      return { sel: `"${t.name}"` };
    }
    return { error: allowSteam ? 'target has no usable selector (no steamId or safe name)' : 'target has no safe name selector — player must be online' };
  }

  function freeText(v, cap) {
    return sanitizeRconArg(v, cap == null ? 480 : cap);
  }

  function cachedLayers() {
    let list = null;
    try {
      if (typeof layersCache === 'function') list = layersCache();
      else if (Array.isArray(layersCache)) list = layersCache;
      else if (layersCache && Array.isArray(layersCache.layers)) list = layersCache.layers;
      if ((!list || list.length === 0) && state && Array.isArray(state.layers)) list = state.layers;
    } catch (_e) { list = null; }
    return Array.isArray(list) ? list : [];
  }

  // -------------------------------------------------------------- builders
  // Each returns {command, targetPlayerId, details} or {error}. All free-text
  // arguments go through sanitizeRconArg (strip \r\n\0, cap 480).

  const BUILDERS = {
    warn(p) {
      const message = freeText(p.message);
      if (!message) return { error: 'message required' };
      const t = resolveTarget(p);
      if (t.error) return t;
      if (t.gameId) return { command: `AdminWarnById ${t.gameId} ${message}`, targetPlayerId: t.dbId, details: { message } };
      const s = selector(t);
      if (s.error) return s;
      return { command: `AdminWarn ${s.sel} ${message}`, targetPlayerId: t.dbId, details: { message } };
    },

    kick(p) {
      const reason = freeText(p.reason) || 'Kicked by admin';
      const t = resolveTarget(p);
      if (t.error) return t;
      if (t.gameId) return { command: `AdminKickById ${t.gameId} ${reason}`, targetPlayerId: t.dbId, details: { reason } };
      const s = selector(t);
      if (s.error) return s;
      return { command: `AdminKick ${s.sel} ${reason}`, targetPlayerId: t.dbId, details: { reason } };
    },

    // §4.3 has no AdminBanById — selector only (steamId preferred).
    ban(p) {
      const interval = String(p.interval == null ? '' : p.interval).trim();
      if (!INTERVAL_RE.test(interval)) return { error: 'invalid ban interval (use 0, or e.g. 30m 2h 1d 1w 1M 1y)' };
      const reason = freeText(p.reason) || 'Banned by admin';
      const t = resolveTarget(p);
      if (t.error) return t;
      const s = selector(t);
      if (s.error) return s;
      return { command: `AdminBan ${s.sel} ${interval} ${reason}`, targetPlayerId: t.dbId, details: { interval, reason } };
    },

    broadcast(p) {
      const message = freeText(p.message);
      if (!message) return { error: 'message required' };
      return { command: `AdminBroadcast ${message}`, details: { message } };
    },

    // §19.3.17: layer argument must EXACTLY equal an entry of the cached
    // ListLayers list. `now:true` -> AdminChangeLayer, else AdminSetNextLayer.
    changeLayer(p) {
      const layer = typeof p.layer === 'string' ? p.layer : '';
      if (!layer) return { error: 'layer required' };
      const layers = cachedLayers();
      if (layers.length === 0) return { error: 'layer list not cached yet — try again shortly' };
      if (!layers.includes(layer)) return { error: 'unknown layer (must exactly match an entry from /api/layers)' };
      const nowFlag = p.now === true;
      return {
        command: `${nowFlag ? 'AdminChangeLayer' : 'AdminSetNextLayer'} ${layer}`,
        details: { layer, now: nowFlag },
        auditAction: nowFlag ? 'changeLayer' : 'setNextLayer',
      };
    },

    restartMatch() { return { command: 'AdminRestartMatch' }; },
    endMatch() { return { command: 'AdminEndMatch' }; },

    slomo(p) {
      const f = Number(p.factor);
      if (!Number.isFinite(f) || f < 0.05 || f > 10) return { error: 'slomo factor must be a number between 0.05 and 10' };
      return { command: `AdminSlomo ${f}`, details: { factor: f } };
    },

    forceTeamChange(p) {
      const t = resolveTarget(p);
      if (t.error) return t;
      if (t.gameId) return { command: `AdminForceTeamChangeById ${t.gameId}`, targetPlayerId: t.dbId };
      const s = selector(t);
      if (s.error) return s;
      return { command: `AdminForceTeamChange ${s.sel}`, targetPlayerId: t.dbId };
    },

    // §4.3: the non-ById variant takes "<name>" (not a steamId selector).
    removeFromSquad(p) {
      const t = resolveTarget(p);
      if (t.error) return t;
      if (t.gameId) return { command: `AdminRemovePlayerFromSquadById ${t.gameId}`, targetPlayerId: t.dbId };
      const s = selector(t, { allowSteam: false, allowName: true });
      if (s.error) return s;
      return { command: `AdminRemovePlayerFromSquad ${s.sel}`, targetPlayerId: t.dbId };
    },

    disbandSquad(p) {
      const teamId = Number(p.teamId);
      if (teamId !== 1 && teamId !== 2) return { error: 'teamId must be 1 or 2' };
      const squadId = String(p.squadId == null ? '' : p.squadId).trim();
      if (!SQUAD_ID_RE.test(squadId)) return { error: 'invalid squadId' };
      return { command: `AdminDisbandSquad ${teamId} ${squadId}`, details: { teamId, squadId: Number(squadId) } };
    },

    // §4.3: selector form only (no ById variant in the catalog).
    demoteCommander(p) {
      const t = resolveTarget(p);
      if (t.error) return t;
      const s = selector(t);
      if (s.error) return s;
      return { command: `AdminDemoteCommander ${s.sel}`, targetPlayerId: t.dbId };
    },
  };

  // ---------------------------------------------------------------- executor

  async function run(user, action, built) {
    const userId = user && user.id != null ? user.id : null; // NULL = system action (§19.1.2)
    const command = built.command;
    let response = null;
    let execError = null;
    try {
      response = await rcon.exec(command);
    } catch (e) {
      execError = e && e.message ? e.message : String(e);
    }
    const rconOk = execError == null ? rconOkHeuristic(response) : false;
    try {
      auth.audit(userId, action, {
        targetPlayerId: built.targetPlayerId == null ? null : built.targetPlayerId,
        details: built.details == null ? null : built.details,
        rconCommand: command,
        // Verbatim response is always recorded (§4.3); exec failures record the error.
        rconResponse: execError == null ? String(response == null ? '' : response) : `ERROR: ${execError}`,
        rconOk,
      });
    } catch (e) {
      log.error('admin', `audit insert failed: ${e.message}`);
    }
    if (execError != null) return { ok: false, error: execError, command, response: null, rconOk: false };
    return { ok: true, rconOk, command, response: String(response == null ? '' : response) };
  }

  async function execAdmin(user, action, params) {
    const build = BUILDERS[action];
    if (!build) return { ok: false, error: `unknown admin action: ${String(action)}` };
    let built;
    try {
      built = build(params || {});
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'invalid parameters' };
    }
    if (!built || built.error) return { ok: false, error: built ? built.error : 'invalid parameters' };
    return run(user, built.auditAction || action, built);
  }

  async function execRaw(user, command, auditMeta) {
    const meta = auditMeta || {};
    const cmd = freeText(command);
    if (!cmd) return { ok: false, error: 'command required' };
    return run(user, meta.action || 'raw', {
      command: cmd,
      targetPlayerId: meta.targetPlayerId == null ? null : meta.targetPlayerId,
      details: meta.details == null ? null : meta.details,
    });
  }

  return { execAdmin, execRaw, actions: ACTION_NAMES.slice() };
}

module.exports = {
  createAdmin,
  ACTION_NAMES,
  STEAM_ID_RE,
  SAFE_NAME_RE,
  INTERVAL_RE,
  SQUAD_ID_RE,
  GAME_ID_RE,
  rconOkHeuristic,
};
