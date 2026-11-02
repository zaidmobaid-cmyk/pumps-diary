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
    /** Map<"teamId:squadId", {time, name, creatorName, creatorEos, creatorDbId}>
     *  — exact creation records from SQUAD_CREATED events (vehicle-claim
     *  adjudication); merged into snapshot squads as createdAt. */
    this.squadCreations = new Map();
    /** Map<"squadId|name", rec> — creations whose team is not known yet (the
     *  creator was not rostered when the event arrived); resolved against the
     *  next ListSquads, which carries the authoritative team. */
    this._pendingCreations = new Map();
    /** mass squad turnover right after NEW_GAME is a map change, not disbands */
    this._suppressDisbandUntil = 0;
    /** armed on RCON disconnect: the first ListSquads after a reconnect is a
     *  catch-up, not evidence that the missing squads disbanded */
    this._skipNextSquadDiff = false;
    /** wall-clock stamp of the last world reset: one map change is observed up
     *  to three times (all-squads-vanish poll, lagged NEW_GAME log line,
     *  serverinfo echo) and must only reset the records once, or the later
     *  echoes wipe creations from the NEW round */
    this._lastWorldResetAt = 0;
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
    const next = Array.isArray(rows) ? rows.slice() : [];
    const prev = this.squads;
    this.squads = next;
    // Attach pending creations first — baseline-safe on every poll, gated or
    // not: ListSquads names the team the creation event could not resolve.
    for (const sq of next) {
      if (sq == null || sq.squadId == null || this.squadCreations.has(`${sq.teamId}:${sq.squadId}`)) continue;
      const pkey = `${sq.squadId}|${sq.name}`;
      const pending = this._pendingCreations.get(pkey);
      if (!pending) continue;
      if (pending.creatorName != null && sq.creatorName != null && pending.creatorName !== sq.creatorName) continue;
      this._pendingCreations.delete(pkey);
      this.squadCreations.set(`${sq.teamId}:${sq.squadId}`, pending);
    }
    // An RCON outage may have spanned anything (even a map change): the first
    // poll after reconnect only establishes the new baseline.
    if (this._skipNextSquadDiff) {
      this._skipNextSquadDiff = false;
      this.emit('squads-updated');
      return;
    }
    // Every squad vanishing at once is a world transition (map change / seed
    // reset), not simultaneous disbands — NEW_GAME often arrives late (lagged
    // log) or never (no log source configured), so detect it from the poll
    // itself: reset quietly and suppress the diff briefly.
    if (prev.length >= 2 && next.length === 0) {
      this.squadCreations.clear();
      this._pendingCreations.clear();
      this._suppressDisbandUntil = Date.now() + 30000;
      this._lastWorldResetAt = Date.now();
      this.emit('squads-updated');
      return;
    }
    // Disband detection: a squad present in the last poll and gone now. The
    // first 30s after NEW_GAME are suppressed — map change clears every squad.
    if (prev.length && Date.now() >= this._suppressDisbandUntil) {
      const alive = new Set(next.map((s) => `${s.teamId}:${s.squadId}`));
      for (const sq of prev) {
        if (!sq || sq.teamId == null || sq.squadId == null) continue;
        const key = `${sq.teamId}:${sq.squadId}`;
        if (alive.has(key)) continue;
        const created = this.squadCreations.get(key) || null;
        this.squadCreations.delete(key);
        this.emit('squad-disbanded', {
          time: Date.now(), teamId: sq.teamId, squadId: sq.squadId, name: sq.name,
          creatorName: sq.creatorName != null ? sq.creatorName : (created ? created.creatorName : null),
          createdAt: created ? created.time : null,
        });
      }
    }
    // Stale creation records: squad id reused for a differently-named squad
    // without a SQUAD_CREATED we saw (log gap) — drop rather than mislabel.
    for (const sq of next) {
      const rec = this.squadCreations.get(`${sq.teamId}:${sq.squadId}`);
      if (rec && rec.name != null && sq.name != null && rec.name !== sq.name) {
        this.squadCreations.delete(`${sq.teamId}:${sq.squadId}`);
      }
    }
    this.emit('squads-updated');
  }

  // Exact creation record from a SQUAD_CREATED event (log line or chat packet).
  // teamId null = creator not rostered yet: parked until the next ListSquads.
  noteSquadCreated({ teamId, squadId, name, time, creatorName, creatorEos, creatorDbId } = {}) {
    if (squadId == null) return;
    const rec = {
      time: Number(time) || Date.now(),
      name: name != null ? name : null,
      creatorName: creatorName != null ? creatorName : null,
      creatorEos: creatorEos != null ? creatorEos : null,
      creatorDbId: creatorDbId != null ? creatorDbId : null,
    };
    if (teamId == null) {
      this._pendingCreations.set(`${squadId}|${rec.name}`, rec);
      if (this._pendingCreations.size > 40) {
        const cutoff = Date.now() - 10 * 60 * 1000;
        for (const [k, r] of this._pendingCreations) {
          if (r.time < cutoff) this._pendingCreations.delete(k);
        }
      }
      return;
    }
    this.squadCreations.set(`${teamId}:${squadId}`, rec);
  }

  // NEW_GAME: every squad dissolves with the map — clear without emitting
  // a storm of 'squad-disbanded' events.
  clearSquadsForNewGame() {
    // The same transition arrives up to three ways (poll wipe, NEW_GAME line,
    // serverinfo echo); only the first one resets — later echoes would wipe
    // squads already created in the new round.
    if (Date.now() - this._lastWorldResetAt < 90000) return;
    this._lastWorldResetAt = Date.now();
    this.squads = [];
    this.squadCreations.clear();
    this._pendingCreations.clear();
    this._suppressDisbandUntil = Date.now() + 30000;
    this.emit('squads-updated');
  }

  applyServerInfo(info) {
    if (!info || typeof info !== 'object') return;
    const prevMap = this.serverInfo && this.serverInfo.mapName ? this.serverInfo.mapName : null;
    this.serverInfo = info;
    if (info.mapName) this.currentLayer = info.mapName;
    if (info.nextLayer) this.nextLayer = info.nextLayer;
    // Authoritative map-change signal that works without any log source:
    // every squad dissolved with the old world.
    if (prevMap != null && info.mapName && info.mapName !== prevMap) {
      this.clearSquadsForNewGame();
    }
    this.emit('serverinfo-updated', info);
  }

  // Called when the RCON link drops: squads may change arbitrarily while we
  // are blind, so the next poll must not be read as disbands.
  noteRconDown() {
    this._skipNextSquadDiff = true;
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
      const created = this.squadCreations.get(`${sq.teamId}:${sq.squadId}`) || null;
      t.squads.push({
        squadId: sq.squadId != null ? sq.squadId : null,
        teamId: t.teamId,
        name: sq.name != null ? sq.name : null,
        size: sq.size != null ? sq.size : null,
        locked: !!sq.locked,
        creatorName: sq.creatorName != null ? sq.creatorName : null,
        creatorEos: sq.creatorEos != null ? sq.creatorEos : null,
        creatorSteam: sq.creatorSteam != null ? sq.creatorSteam : null,
        createdAt: created ? created.time : null, // exact, from SQUAD_CREATED
        creatorDbId: created ? created.creatorDbId : null,
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
