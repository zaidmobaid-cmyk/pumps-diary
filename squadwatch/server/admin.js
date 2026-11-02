'use strict';
// Admin action -> RCON command builder/executor.
// SPEC §4.3 (command catalog, ById preference, verbatim response + rconOk
// heuristic), §13 (execAdmin target resolution: params.playerId is the DB
// player id), §19.1.2 (createAdmin factory shape; system actions use user
// NULL), §19.3.17 (selector order + argument validation; validation failures
// happen BEFORE audit — nothing executed, nothing to audit).
// docs/NEXT-CONTRACTS.md §1 (changeLayer: case-insensitive layer match,
// optional faction pair) and §2 (quick commands).
const { log, sanitizeRconArg } = require('./util');
const { FACTION_TOKEN_RE, splitLayerName } = require('./parser');

// §19.3.17 validation patterns.
const STEAM_ID_RE = /^7656\d{13}$/;
const SAFE_NAME_RE = /^[^"\r\n\0]{1,64}$/;
const GAME_ID_RE = /^\d{1,6}$/;
// "0" alone is permanent; a zero count ("0d") would be read as permanent too.
const INTERVAL_RE = /^(0|[1-9]\d{0,2}[mhdwMy])$/;
const SQUAD_ID_RE = /^\d{1,4}$/;
const UNSAFE_NAME_ERROR = 'name contains unsafe characters — use the steamId';

// docs/NEXT-CONTRACTS.md §2 quick-command rules. A toggle row is one bare
// command the panel completes with 1 or 0; any other row runs as written.
const QUICK_COMMANDS_KEY = 'quickCommands';
const QUICK_MAX_ROWS = 30;
const QUICK_ID_RE = /^[a-z0-9-]{1,40}$/;
const QUICK_COMMAND_RE = /^[A-Za-z][A-Za-z0-9_]{2,63}( [^\r\n\0]{1,200})?$/;
const QUICK_TOGGLE_RE = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;

// One quick-command row -> {row} normalized to {id, label, command, toggle},
// or {error}.
function checkQuickRow(q) {
  if (!q || typeof q !== 'object' || Array.isArray(q)) return { error: 'must be an object' };
  const id = typeof q.id === 'string' ? q.id : '';
  if (!QUICK_ID_RE.test(id)) return { error: 'id must be 1-40 characters of a-z, 0-9 and -' };
  const label = typeof q.label === 'string' ? q.label.trim() : '';
  const labelLen = [...label].length;
  if (labelLen < 1 || labelLen > 40 || /[\u0000-\u001f\u007f]/.test(label)) {
    return { error: 'label must be 1-40 characters' };
  }
  if (q.toggle !== undefined && typeof q.toggle !== 'boolean') return { error: 'toggle must be true or false' };
  const toggle = q.toggle === true;
  const command = typeof q.command === 'string' ? q.command.trim() : '';
  if (!QUICK_COMMAND_RE.test(command)) {
    return { error: 'command must be an RCON command name (letters, digits, _), optionally followed by a space and its arguments' };
  }
  if (toggle && !QUICK_TOGGLE_RE.test(command)) {
    return { error: 'a toggle must be a single bare command — the panel appends 1 or 0' };
  }
  return { row: { id, label, command, toggle } };
}

// The whole list (POST /api/quick-commands replaces it) -> {rows} or {error}.
function validateQuickCommands(rows) {
  if (!Array.isArray(rows)) return { error: 'rows must be an array' };
  if (rows.length > QUICK_MAX_ROWS) return { error: `at most ${QUICK_MAX_ROWS} quick commands` };
  const out = [];
  const ids = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = checkQuickRow(rows[i]);
    if (r.error) return { error: `row ${i + 1}: ${r.error}` };
    if (ids.has(r.row.id)) return { error: `row ${i + 1}: duplicate id "${r.row.id}"` };
    ids.add(r.row.id);
    out.push(r.row);
  }
  return { rows: out };
}

// changeLayer faction argument: absent (undefined/null/blank), a valid
// Faction[+Type] token, or invalid.
function factionArg(v) {
  if (v === undefined || v === null) return { absent: true };
  if (typeof v !== 'string') return { invalid: true };
  const s = v.trim();
  if (!s) return { absent: true };
  return FACTION_TOKEN_RE.test(s) ? { value: s } : { invalid: true };
}

// §4.3: responses containing these are recorded with rconOk=false.
const RCON_BAD_RE = /not found|invalid|error|unable|unknown command|not permitted|permission denied/i;
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
 *   { execAdmin(userOrNull, action, params), execRaw(userOrNull, command, auditMeta),
 *     quickCommands(), saveQuickCommands(rows), actions }
 *
 * Both exec functions return `{ok, rconOk, command, response}` on an executed
 * command, `{ok:false, error}` on validation failure (no audit, api maps it to
 * 400), and `{ok:false, error, command, rconOk:false}` when the RCON exec
 * itself failed (audited with the error text as the response).
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

  // ------------------------------------------------------- quick commands
  // Stored in settings['quickCommands'] (seeded by the v5 migration). A row
  // that no longer validates is dropped on read, so a hand-edited row can
  // never reach RCON.
  function quickCommands() {
    let parsed = [];
    try {
      const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(QUICK_COMMANDS_KEY);
      parsed = r && r.value != null ? JSON.parse(String(r.value)) : [];
    } catch (e) {
      log.warn('admin', `quick commands unreadable: ${e.message}`);
      return [];
    }
    const out = [];
    const ids = new Set();
    for (const q of Array.isArray(parsed) ? parsed : []) {
      const r = checkQuickRow(q);
      if (r.error || ids.has(r.row.id)) {
        log.warn('admin', `stored quick command skipped (${r.error || 'duplicate id'})`);
        continue;
      }
      ids.add(r.row.id);
      out.push(r.row);
    }
    return out;
  }

  // Replaces the whole list. Throws with a user-facing message when invalid.
  function saveQuickCommands(rows) {
    const v = validateQuickCommands(rows);
    if (v.error) throw new Error(v.error);
    db.prepare(
      'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(QUICK_COMMANDS_KEY, JSON.stringify(v.rows));
    return v.rows;
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

    // NEXT-CONTRACTS §1: the layer is matched case-insensitively against the
    // cached (suffix-stripped) ListLayers names and sent in the list's exact
    // spelling; a raw " (modid)" entry is accepted for its stripped name.
    // Factions: both or neither, each a Faction[+Type] token. `now:true` ->
    // AdminChangeLayer (travel now), else AdminSetNextLayer (after the match).
    changeLayer(p) {
      const raw = typeof p.layer === 'string' ? p.layer.trim() : '';
      if (!raw) return { error: 'layer required' };
      const layers = cachedLayers();
      if (layers.length === 0) return { error: 'layer list not cached yet — try again shortly' };
      const want = splitLayerName(raw).name.toLowerCase();
      const layer = layers.find((l) => String(l).toLowerCase() === want);
      if (!layer) return { error: 'unknown layer — pick one from the list' };
      const f1 = factionArg(p.team1);
      const f2 = factionArg(p.team2);
      if (!!f1.absent !== !!f2.absent) return { error: 'pick both factions or neither' };
      if (f1.invalid || f2.invalid) {
        return { error: 'invalid faction — use Faction or Faction+Type (letters, digits, _), e.g. USA+CombinedArms' };
      }
      const team1 = f1.absent ? null : f1.value;
      const team2 = f2.absent ? null : f2.value;
      const nowFlag = p.now === true;
      const verb = nowFlag ? 'AdminChangeLayer' : 'AdminSetNextLayer';
      return {
        command: team1 ? `${verb} ${layer} ${team1} ${team2}` : `${verb} ${layer}`,
        details: { layer, now: nowFlag, team1, team2 },
        auditAction: nowFlag ? 'changeLayer' : 'setNextLayer',
      };
    },

    // NEXT-CONTRACTS §2: a stored row by id. A toggle sends `<command> 1|0` —
    // the 0/1 value is the only input that reaches the command; any other row
    // sends its stored command exactly.
    quickCommand(p) {
      const row = quickCommands().find((q) => q.id === p.id);
      if (!row) return { error: 'unknown quick command' };
      let value = null;
      if (row.toggle) {
        if (p.value !== 0 && p.value !== 1) return { error: 'value must be 0 or 1 for this toggle' };
        value = p.value;
      } else if (p.value !== undefined && p.value !== null) {
        return { error: 'value is only accepted by toggle commands' };
      }
      return {
        command: row.toggle ? `${row.command} ${value}` : row.command,
        details: { id: row.id, label: row.label, command: row.command, value },
        auditAction: 'quick-command',
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
    let auditId = null;
    try {
      auditId = auth.audit(userId, action, {
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
    // auditId: the admin_actions row, so evidence can be attached to it.
    if (execError != null) return { ok: false, error: execError, command, response: null, rconOk: false, auditId };
    return { ok: true, rconOk, command, response: String(response == null ? '' : response), auditId };
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

  return { execAdmin, execRaw, quickCommands, saveQuickCommands, actions: ACTION_NAMES.slice() };
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
  validateQuickCommands,
  QUICK_MAX_ROWS,
};
