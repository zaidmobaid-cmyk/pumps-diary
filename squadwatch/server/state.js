'use strict';
// Live server state (SPEC §10 + §19.1.1). Holds what is true RIGHT NOW on the
// game server: online players, squads, layer info, the open match. Ingest and
// the pollers write into it; api.js reads snapshot() for SSE/overview.
//
// §19.1.1 / §19.3: snapshot() and every SSE payload built from it NEVER carry
// `ip` or `controller` — those stay inside the live records (profile IPs are
// served separately to admin+ from the DB).
const { EventEmitter } = require('node:events');

// A player that joined via log events but was not yet seen by a ListPlayers
// poll (playerId still null) survives one reconcile window, so a poll response
// generated just before the join cannot evict a genuinely connected player.
const JOIN_GRACE_MS = 60 * 1000;

function lower(s) {
  return s == null ? null : String(s).toLowerCase();
}

function blankRecord(eosId, now) {
  return {
    playerId: null, dbId: null, eosId, steamId: null, name: null,
    teamId: null, squadId: null, isLeader: false, role: null,
    ip: null, controller: null, connectedAt: now,
    sessKills: 0, sessDeaths: 0, sessTks: 0, // §19.1.1: init 0 on connect
  };
}

// JSON-safe player view for snapshot(): everything EXCEPT ip and controller.
function publicPlayer(rec) {
  const n = (v) => (v === undefined || v === null ? null : v);
  return {
    playerId: n(rec.playerId),
    dbId: n(rec.dbId),
    eosId: n(rec.eosId),
    steamId: n(rec.steamId),
    name: n(rec.name),
    teamId: n(rec.teamId),
    squadId: n(rec.squadId),
    isLeader: !!rec.isLeader,
    role: n(rec.role),
    connectedAt: n(rec.connectedAt),
    sessKills: rec.sessKills != null ? rec.sessKills : null,
    sessDeaths: rec.sessDeaths != null ? rec.sessDeaths : null,
    sessTks: rec.sessTks != null ? rec.sessTks : null,
  };
}

class LiveState extends EventEmitter {
  constructor() {
    super();
    /** Map<eosId(lowercase), record> — record shape in blankRecord() */
    this.players = new Map();
    /** Map<controllerName, eosId> */
    this.controllers = new Map();
    /** parsed ListSquads rows (§6.4) */
    this.squads = [];
    /** parsed ShowServerInfo (§6.4) or null */
    this.serverInfo = null;
    /** cached ListLayers names */
    this.layers = [];
    this.currentLayer = null;
    this.nextLayer = null;
    this.tickRate = null;
    /** current match row ref {id, layer, level, team1, team2, startedAt} (ingest owns it) */
    this.match = null;
    /** parsed "Recently Disconnected" rows from the last ListPlayers poll */
    this.recentlyDisconnected = [];
  }

  // ------------------------------------------------------------- lookups

  byEos(eosId) {
    if (eosId == null) return null;
    return this.players.get(lower(eosId)) || null;
  }

  bySteam(steamId) {
    if (steamId == null) return null;
    const want = String(steamId);
    for (const rec of this.players.values()) {
      if (rec.steamId != null && String(rec.steamId) === want) return rec;
    }
    return null;
  }

  byController(controller) {
    if (controller == null) return null;
    const eos = this.controllers.get(controller);
    return eos ? this.players.get(eos) || null : null;
  }

  // Exact name, then case-insensitive, then trailing-suffix match — Squad's
  // "Join succeeded: <name>" lines can drop clan-tag prefixes (§10).
  byName(name) {
    if (name == null || name === '') return null;
    const want = String(name);
    for (const rec of this.players.values()) {
      if (rec.name === want) return rec;
    }
    const low = want.toLowerCase();
    for (const rec of this.players.values()) {
      if (rec.name != null && String(rec.name).toLowerCase() === low) return rec;
    }
    for (const rec of this.players.values()) {
      if (rec.name != null && String(rec.name).endsWith(want)) return rec;
    }
    return null;
  }

  // ------------------------------------------------------------- refs

  // §19.1.1 shape. Accepts a live record or an eosId; null in -> null out.
  playerRef(p) {
    const rec = typeof p === 'string' ? this.byEos(p) : p;
    if (!rec) return null;
    const n = (v) => (v === undefined || v === null ? null : v);
    return {
      dbId: n(rec.dbId),
      eosId: n(rec.eosId),
      steamId: n(rec.steamId),
      name: n(rec.name),
      teamId: n(rec.teamId),
      squadId: n(rec.squadId),
      sessKills: rec.sessKills != null ? rec.sessKills : null,
      sessDeaths: rec.sessDeaths != null ? rec.sessDeaths : null,
      sessTks: rec.sessTks != null ? rec.sessTks : null,
    };
  }

  // §19.1.1: ingest bumps per-session counters on every enriched kill event.
  bumpSession(eosId, delta) {
    const rec = this.byEos(eosId);
    if (!rec || !delta) return;
    if (delta.kills) rec.sessKills = (rec.sessKills || 0) + delta.kills;
    if (delta.deaths) rec.sessDeaths = (rec.sessDeaths || 0) + delta.deaths;
    if (delta.tks) rec.sessTks = (rec.sessTks || 0) + delta.tks;
  }

  // ------------------------------------------------------------- apply polls

  // Reconcile the live map against a parsed ListPlayers response (§6.4).
  // Log events are the primary join/leave source; the poll updates
  // team/squad/name/playerId, creates missed joins as a fallback, and prunes
  // players the server no longer lists (with a short grace window for
  // log-joined players the poll may predate).
  applyListPlayers(parsed) {
    if (!parsed || !Array.isArray(parsed.online)) return;
    const now = Date.now();
    const seen = new Set();

    for (const row of parsed.online) {
      const eos = lower(row.eosId);
      if (!eos) continue; // cannot key a record without an EOS id
      seen.add(eos);
      let rec = this.players.get(eos);
      if (!rec) {
        rec = blankRecord(eos, now); // fallback join detection
        this.players.set(eos, rec);
      }
      if (row.playerId != null) rec.playerId = row.playerId; // §19.3.28: per-connection ids
      if (row.steamId) rec.steamId = String(row.steamId);
      if (row.name) rec.name = row.name;
      rec.teamId = row.teamId != null ? row.teamId : null;
      rec.squadId = row.squadId != null ? row.squadId : null; // N/A -> null (left squad)
      rec.isLeader = !!row.isLeader;
      if (row.role != null) rec.role = row.role;
    }

    for (const [eos, rec] of this.players) {
      if (seen.has(eos)) continue;
      const freshLogJoin = rec.playerId == null && rec.connectedAt != null
        && now - rec.connectedAt < JOIN_GRACE_MS;
      if (freshLogJoin) continue;
      if (rec.controller) this.controllers.delete(rec.controller);
      this.players.delete(eos);
    }

    this.recentlyDisconnected = Array.isArray(parsed.disconnected)
      ? parsed.disconnected.map((d) => ({
        playerId: d.playerId != null ? d.playerId : null,
        eosId: d.eosId != null ? lower(d.eosId) : null,
        steamId: d.steamId != null ? String(d.steamId) : null,
        name: d.name != null ? d.name : null,
        sinceDisconnect: d.sinceDisconnect != null ? d.sinceDisconnect : null,
      }))
      : [];

    this.emit('players-updated');
  }

  applyListSquads(rows) {
    this.squads = Array.isArray(rows) ? rows.slice() : [];
    this.emit('squads-updated');
  }

  applyServerInfo(info) {
    if (!info || typeof info !== 'object') return;
    this.serverInfo = info;
    if (info.mapName) this.currentLayer = info.mapName;
    if (info.nextLayer) this.nextLayer = info.nextLayer;
    this.emit('serverinfo-updated', info);
  }

  // ------------------------------------------------------------- snapshot

  teamNameFor(teamId) {
    for (const sq of this.squads) {
      if (sq && sq.teamId === teamId && sq.teamName) return sq.teamName;
    }
    const si = this.serverInfo;
    if (si) {
      if (teamId === 1 && si.teamOne) return si.teamOne;
      if (teamId === 2 && si.teamTwo) return si.teamTwo;
    }
    return teamId == null ? 'No team' : null;
  }

  // JSON-safe view for /api/overview and SSE (§10 shape, §19.1.1 exclusions):
  // {serverInfo, teams:[{teamId, name, squads:[{…, players:[…]}], unassigned:[…]}],
  //  recentlyDisconnected, currentLayer, nextLayer, tickRate, match}
  snapshot() {
    const teams = new Map(); // teamId -> team entry

    const ensureTeam = (teamId) => {
      const key = teamId == null ? 'none' : teamId;
      let t = teams.get(key);
      if (!t) {
        t = { teamId: teamId == null ? null : teamId, name: this.teamNameFor(teamId), squads: [], unassigned: [] };
        teams.set(key, t);
      }
      return t;
    };

    // Squad always runs two teams; seed them whenever there is roster data so
    // both columns render even while one side is empty.
    if (this.players.size > 0 || this.squads.length > 0) {
      ensureTeam(1);
      ensureTeam(2);
    }

    for (const sq of this.squads) {
      if (!sq) continue;
      const t = ensureTeam(sq.teamId != null ? sq.teamId : null);
      t.squads.push({
        squadId: sq.squadId != null ? sq.squadId : null,
        teamId: t.teamId,
        name: sq.name != null ? sq.name : null,
        size: sq.size != null ? sq.size : null,
        locked: !!sq.locked,
        creatorName: sq.creatorName != null ? sq.creatorName : null,
        creatorEos: sq.creatorEos != null ? sq.creatorEos : null,
        creatorSteam: sq.creatorSteam != null ? sq.creatorSteam : null,
        players: [],
      });
    }

    for (const rec of this.players.values()) {
      const pub = publicPlayer(rec);
      const t = ensureTeam(rec.teamId != null ? rec.teamId : null);
      if (rec.squadId != null) {
        let sq = t.squads.find((s) => s.squadId === rec.squadId);
        if (!sq) {
          // ListSquads poll lagging behind ListPlayers — show a stub squad.
          sq = {
            squadId: rec.squadId, teamId: t.teamId, name: null, size: null, locked: false,
            creatorName: null, creatorEos: null, creatorSteam: null, players: [],
          };
          t.squads.push(sq);
        }
        sq.players.push(pub);
      } else {
        t.unassigned.push(pub);
      }
    }

    const byNameAsc = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
    const byPlayer = (a, b) => (b.isLeader === a.isLeader ? byNameAsc(a, b) : (b.isLeader ? 1 : -1));
    const teamList = Array.from(teams.values());
    teamList.sort((a, b) => (a.teamId == null ? Infinity : a.teamId) - (b.teamId == null ? Infinity : b.teamId));
    for (const t of teamList) {
      t.squads.sort((a, b) => (a.squadId == null ? Infinity : a.squadId) - (b.squadId == null ? Infinity : b.squadId));
      for (const sq of t.squads) sq.players.sort(byPlayer);
      t.unassigned.sort(byNameAsc);
    }

    return {
      serverInfo: this.serverInfo,
      teams: teamList,
      recentlyDisconnected: this.recentlyDisconnected.map((d) => ({
        playerId: d.playerId, eosId: d.eosId, steamId: d.steamId, name: d.name,
        sinceDisconnect: d.sinceDisconnect,
      })),
      currentLayer: this.currentLayer,
      nextLayer: this.nextLayer,
      tickRate: this.tickRate,
      match: this.match ? Object.assign({}, this.match) : null,
    };
  }
}

module.exports = LiveState;
module.exports.LiveState = LiveState;
