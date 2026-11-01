'use strict';
// Event pipeline (SPEC §11 + §19.1 + §19.3.24): consumes raw bus events
// (log-event, chat-packet-parsed, poll updates), writes the DB, maintains
// aggregates and flags, enforces bans, and emits the enriched §7 bus events.
const { log, prettyLayer } = require('./util');

// factions.js is lazy-required so a broken/missing module degrades a single
// deployable event (logged) instead of taking the whole pipeline down.
let _factions = null;
function getFactions() {
  if (!_factions) _factions = require('./factions');
  return _factions;
}

// §19.3.24 input caps applied at ingest.
const NAME_MAX = 64;
const CHAT_MAX = 480;

// Tolerant Online-IDs scanner (§6.1) for the raw ids blobs that ride inside
// wound/die/damage/revive events.
const IDS_RE = /\b(EOS|steam):\s*([0-9a-f]{32}|\d{17})/gi;
function scanIds(blob) {
  const out = { eosId: null, steamId: null };
  if (!blob) return out;
  const s = String(blob);
  IDS_RE.lastIndex = 0;
  let m;
  while ((m = IDS_RE.exec(s)) !== null) {
    const key = m[1].toLowerCase();
    if (key === 'eos' && !out.eosId) out.eosId = m[2].toLowerCase();
    else if (key === 'steam' && !out.steamId) out.steamId = m[2];
  }
  return out;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function toInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function lowerOrNull(v) {
  return v ? String(v).toLowerCase() : null;
}
function capName(v) {
  if (v == null) return null;
  const s = String(v).slice(0, NAME_MAX);
  return s === '' ? null : s;
}

// Watchlist entries are whole-word, case-insensitive matchers. An entry may be
// a regex fragment; if it does not compile it is used as an escaped literal.
function compileWatchlist(list) {
  const out = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const src = String(entry == null ? '' : entry).trim();
    if (!src) continue;
    let rx = null;
    try {
      rx = new RegExp(`\\b(?:${src})\\b`, 'i');
    } catch (_e) {
      rx = new RegExp(`\\b${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    }
    out.push(rx);
  }
  return out;
}

class Ingest {
  constructor({ db, state, bus, config, admin }) {
    this.db = db;
    this.state = state;
    this.bus = bus;
    this.config = config || {};
    this.admin = admin || null;

    this.match = null; // current open match {id, layer, level, layerClass, team1, team2, startedAt}
    this.tkTimes = new Map(); // attacker dbId -> [TK-wound timestamps] for tk_spree
    this.lastConnectedEos = null; // pairs PLAYER_CONNECTED with the following JOIN_SUCCEEDED
    this.watchlist = compileWatchlist(this.config.flags && this.config.flags.chatWatchlist);
    this.popTimer = null;
    this.retentionTimer = null;

    this._closeDanglingSessionsAtBoot();
    this._resumeOpenMatch();

    if (this.bus) {
      this._onLog = (ev) => this.onLogEvent(ev);
      this._onPkt = (pkt) => this.onChatPacket(pkt);
      this._onInfo = (info) => this.onServerInfo(info);
      this._onPlayers = () => this.onPlayersUpdated();
      this.bus.on('log-event', this._onLog);
      this.bus.on('chat-packet-parsed', this._onPkt);
      this.bus.on('serverinfo-updated', this._onInfo);
      this.bus.on('players-updated', this._onPlayers);
    }
  }

  stmt(sql) { return this.db.prepare(sql); }

  flagCfg() {
    const f = this.config.flags || {};
    return {
      tkSpreeCount: toInt(f.tkSpreeCount) || 3,
      tkSpreeWindowSec: toInt(f.tkSpreeWindowSec) || 180,
      massTkCount: toInt(f.massTkCount) || 5,
      newPlayerMinutes: toInt(f.newPlayerMinutes) || 15,
    };
  }

  // ---------------------------------------------------------------- lifecycle

  _closeDanglingSessionsAtBoot() {
    try {
      const rows = this.stmt(
        `SELECT s.id AS id, s.player_id AS player_id, s.connect_at AS connect_at,
                COALESCE(p.last_seen, s.connect_at) AS last_seen
           FROM sessions s LEFT JOIN players p ON p.id = s.player_id
          WHERE s.disconnect_at IS NULL`
      ).all();
      if (!rows.length) return;
      this.db.tx(() => {
        for (const r of rows) {
          this.closeSession(r.id, r.player_id, r.connect_at, Math.max(Number(r.connect_at) || 0, Number(r.last_seen) || 0));
        }
      });
      log.info('ingest', `closed ${rows.length} dangling session(s) at boot (crash recovery)`);
    } catch (e) {
      log.error('ingest', `boot session cleanup failed: ${e.message}`);
    }
  }

  _resumeOpenMatch() {
    try {
      const row = this.stmt(
        'SELECT id, layer, level, layer_class, team1, team2, started_at FROM matches WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1'
      ).get();
      if (!row) return;
      this.match = {
        id: Number(row.id), layer: row.layer, level: row.level, layerClass: row.layer_class,
        team1: row.team1, team2: row.team2, startedAt: row.started_at,
      };
      if (this.state) this.state.match = this.match;
    } catch (e) {
      log.error('ingest', `open-match resume failed: ${e.message}`);
    }
  }

  // Pop samples every 60s + hourly retention job. Tests drive samplePop()/
  // retentionSweep() directly and never need the timers.
  startTimers() {
    this.stopTimers();
    this.popTimer = setInterval(() => {
      try { this.samplePop(); } catch (e) { log.error('ingest', `pop sample failed: ${e.message}`); }
    }, 60 * 1000);
    this.retentionTimer = setInterval(() => {
      try { this.retentionSweep(); } catch (e) { log.error('ingest', `retention sweep failed: ${e.message}`); }
    }, 3600 * 1000);
    if (typeof this.popTimer.unref === 'function') this.popTimer.unref();
    if (typeof this.retentionTimer.unref === 'function') this.retentionTimer.unref();
  }

  stopTimers() {
    if (this.popTimer) { clearInterval(this.popTimer); this.popTimer = null; }
    if (this.retentionTimer) { clearInterval(this.retentionTimer); this.retentionTimer = null; }
  }

  // The watchlist is compiled once in the constructor; the Settings API calls
  // this after changing flags.chatWatchlist so new patterns apply live.
  refreshWatchlist() {
    this.watchlist = compileWatchlist(this.config.flags && this.config.flags.chatWatchlist);
  }

  stop() {
    this.stopTimers();
    if (this.bus) {
      if (this._onLog) this.bus.removeListener('log-event', this._onLog);
      if (this._onPkt) this.bus.removeListener('chat-packet-parsed', this._onPkt);
      if (this._onInfo) this.bus.removeListener('serverinfo-updated', this._onInfo);
      if (this._onPlayers) this.bus.removeListener('players-updated', this._onPlayers);
    }
  }

  samplePop(now) {
    const time = Number(now) || Date.now();
    const st = this.state || {};
    const si = st.serverInfo || null;
    const players = si && toNum(si.playerCount) != null
      ? toNum(si.playerCount)
      : (st.players && typeof st.players.size === 'number' ? st.players.size : 0);
    const queue = si ? (toNum(si.publicQueue) || 0) + (toNum(si.reservedQueue) || 0) : 0;
    const tick = st.tickRate != null ? toNum(st.tickRate) : null;
    const layer = st.currentLayer || (this.match ? this.match.layer : null) || null;
    this.stmt('INSERT OR REPLACE INTO pop_samples(time, players, queue, tick_rate, layer) VALUES(?,?,?,?,?)')
      .run(time, players, queue, tick, layer);
    if (this.bus) this.bus.emit('pop-sample', { time, players, queue, tickRate: tick, layer });
  }

  retentionSweep(now) {
    const time = Number(now) || Date.now();
    const ret = this.config.retention || {};
    const chatDays = toInt(ret.chatDays) || 0; // 0 = keep forever
    const popDays = toInt(ret.popDays) || 0;
    if (chatDays > 0) {
      const r = this.stmt('DELETE FROM chat WHERE time < ?').run(time - chatDays * 86400000);
      if (r.changes) log.info('ingest', `retention: pruned ${r.changes} chat row(s) older than ${chatDays}d`);
    }
    if (popDays > 0) {
      this.stmt('DELETE FROM pop_samples WHERE time < ?').run(time - popDays * 86400000);
    }
  }

  // ---------------------------------------------------------------- identity

  // Key on eosId; update steam/name/last_seen; maintain player_names.
  // Returns {id, created, firstSeen, prevLastSeen, prevName} or null without an eosId.
  getOrCreatePlayer(info) {
    const eosId = lowerOrNull(info.eosId);
    if (!eosId) return null;
    const time = Number(info.time) || Date.now();
    const steamId = info.steamId ? String(info.steamId) : null;
    const name = capName(info.name);
    let row = this.stmt('SELECT id, name, first_seen, last_seen FROM players WHERE eos_id=?').get(eosId);
    let created = false;
    if (!row) {
      const r = this.stmt('INSERT INTO players(eos_id, steam_id, name, first_seen, last_seen) VALUES(?,?,?,?,?)')
        .run(eosId, steamId, name, time, time);
      row = { id: r.lastInsertRowid, name: null, first_seen: time, last_seen: time };
      created = true;
    } else {
      this.stmt('UPDATE players SET steam_id=COALESCE(?, steam_id), name=COALESCE(?, name), last_seen=MAX(last_seen, ?) WHERE id=?')
        .run(steamId, name, time, row.id);
    }
    if (name) {
      this.stmt(
        `INSERT INTO player_names(player_id, name, first_used, last_used) VALUES(?,?,?,?)
         ON CONFLICT(player_id, name) DO UPDATE SET last_used=MAX(last_used, excluded.last_used)`
      ).run(row.id, name, time, time);
    }
    return {
      id: Number(row.id),
      created,
      firstSeen: row.first_seen != null ? Number(row.first_seen) : time,
      prevLastSeen: row.last_seen != null ? Number(row.last_seen) : time,
      prevName: row.name != null ? row.name : null,
    };
  }

  ensureLiveRecord(eosId, patch) {
    const st = this.state;
    if (!st || !st.players) return null;
    let rec = st.players.get(eosId);
    if (!rec) {
      rec = {
        playerId: null, dbId: null, eosId, steamId: null, name: null, teamId: null, squadId: null,
        isLeader: false, role: null, ip: null, controller: null, connectedAt: null,
        sessKills: 0, sessDeaths: 0, sessTks: 0,
      };
      st.players.set(eosId, rec);
    }
    if (patch) for (const k of Object.keys(patch)) { if (patch[k] !== undefined) rec[k] = patch[k]; }
    return rec;
  }

  // §19.1.1 playerRef; session counters are null for players we never saw live.
  ref(rec, extra) {
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

  safeBumpSession(eosId, delta) {
    try {
      if (eosId && this.state && typeof this.state.bumpSession === 'function') this.state.bumpSession(eosId, delta);
    } catch (e) {
      log.warn('ingest', `bumpSession failed: ${e.message}`);
    }
  }

  // Resolve an actor from an Online-IDs blob, falling back to the controller map.
  resolveActor(opts) {
    const ids = scanIds(opts.idsBlob);
    let rec = null;
    let dbId = null;
    let eosId = ids.eosId;
    if (eosId) {
      rec = this.state && typeof this.state.byEos === 'function' ? this.state.byEos(eosId) : null;
      const p = this.getOrCreatePlayer({ eosId, steamId: ids.steamId, name: opts.name, time: opts.time });
      dbId = p ? p.id : null;
      if (rec && !rec.dbId && dbId) rec.dbId = dbId;
    } else if (opts.controller && opts.controller !== 'nullptr') {
      rec = this.state && typeof this.state.byController === 'function' ? this.state.byController(opts.controller) : null;
      if (rec && rec.eosId) {
        eosId = rec.eosId;
        if (rec.dbId) {
          dbId = rec.dbId;
        } else {
          const p = this.getOrCreatePlayer({ eosId, steamId: rec.steamId, time: opts.time });
          dbId = p ? p.id : null;
          if (dbId) rec.dbId = dbId;
        }
      }
    }
    // Keep the controller map fresh for future lines that only carry a controller.
    if (eosId && opts.controller && opts.controller !== 'nullptr' && this.state && this.state.controllers) {
      this.state.controllers.set(opts.controller, eosId);
    }
    return { rec, dbId: dbId || null, eosId: eosId || null, steamId: ids.steamId || (rec && rec.steamId) || null };
  }

  // Resolve a victim/instigator by exact name through live state.
  resolveByName(name, time) {
    const rec = this.state && typeof this.state.byName === 'function' ? this.state.byName(name) : null;
    let dbId = rec && rec.dbId ? rec.dbId : null;
    if (rec && !dbId && rec.eosId) {
      const p = this.getOrCreatePlayer({ eosId: rec.eosId, steamId: rec.steamId, name: rec.name || name, time });
      dbId = p ? p.id : null;
      if (dbId) rec.dbId = dbId;
    }
    return { rec, dbId: dbId || null };
  }

  // ---------------------------------------------------------------- bus entry

  onLogEvent(ev) {
    if (!ev || !ev.event) return;
    try {
      switch (ev.event) {
        case 'PLAYER_CONNECTED': this.handleConnect(ev); break;
        case 'JOIN_SUCCEEDED': this.handleJoin(ev); break;
        case 'PLAYER_DISCONNECTED': this.handleDisconnect(ev); break;
        case 'PLAYER_DAMAGED': this.handleDamage(ev); break;
        case 'PLAYER_WOUNDED': this.handleKill(ev, 'wound'); break;
        case 'PLAYER_DIED': this.handleKill(ev, 'die'); break;
        case 'PLAYER_REVIVED': this.handleRevive(ev); break;
        case 'DEPLOYABLE_DAMAGED': this.handleDeployable(ev); break;
        case 'NEW_GAME': this.handleNewGame(ev); break;
        case 'MATCH_STATE': this.handleMatchState(ev); break;
        case 'ROUND_ENDED': this.handleRoundEnded(ev); break;
        case 'TICK_RATE': this.handleTickRate(ev); break;
        case 'ADMIN_BROADCAST_LOG':
          this.bus.emit('broadcast', { time: Number(ev.time) || Date.now(), message: ev.message, from: ev.from });
          break;
        default: break; // other parsed lines are state/poll concerns
      }
    } catch (e) {
      log.error('ingest', `failed to handle ${ev.event}: ${e.message}`);
    }
  }

  onChatPacket(pkt) {
    try {
      if (!pkt) return;
      if (pkt.kind && pkt.kind !== 'CHAT') return; // only chat messages are stored here
      if (!pkt.kind && (pkt.channel == null || pkt.message == null)) return;
      const time = Number(pkt.time) || Date.now();
      const message = String(pkt.message == null ? '' : pkt.message).slice(0, CHAT_MAX);
      const name = capName(pkt.name);
      const eosId = lowerOrNull(pkt.eosId);
      const matchId = this.match ? this.match.id : null;
      const p = this.getOrCreatePlayer({ eosId, steamId: pkt.steamId, name, time });
      const rec = eosId && this.state && typeof this.state.byEos === 'function' ? this.state.byEos(eosId) : null;
      if (rec && p && !rec.dbId) rec.dbId = p.id;
      if (rec && name && !rec.name) rec.name = name;
      this.stmt('INSERT INTO chat(time, match_id, player_id, channel, message) VALUES(?,?,?,?,?)')
        .run(time, matchId, p ? p.id : null, pkt.channel || null, message);
      if (p && pkt.channel !== 'admin') { // admin chat never feeds viewer-visible flags (§19.3.23)
        for (const rx of this.watchlist) {
          if (rx.test(message)) {
            this.insertFlag({
              type: 'chat_watchlist', severity: 1, playerDbId: p.id, rec, matchId, time,
              details: { message, pattern: rx.source },
            });
            break;
          }
        }
      }
      this.bus.emit('chat', {
        time, matchId, channel: pkt.channel || null,
        player: this.ref(rec, { dbId: p ? p.id : null, eosId, steamId: pkt.steamId || null, name }),
        message,
      });
    } catch (e) {
      log.error('ingest', `chat packet handling failed: ${e.message}`);
    }
  }

  onServerInfo(info) {
    try {
      const si = info || (this.state && this.state.serverInfo) || null;
      if (!si || !this.match) return;
      const t1 = si.teamOne || null;
      const t2 = si.teamTwo || null;
      const layerName = si.mapName || null;
      if ((t1 && !this.match.team1) || (t2 && !this.match.team2) || (layerName && !this.match.layer)) {
        this.stmt('UPDATE matches SET team1=COALESCE(team1, ?), team2=COALESCE(team2, ?), layer=COALESCE(layer, ?) WHERE id=?')
          .run(t1, t2, layerName, this.match.id);
        if (!this.match.team1) this.match.team1 = t1;
        if (!this.match.team2) this.match.team2 = t2;
        if (!this.match.layer) this.match.layer = layerName;
        if (this.state) this.state.match = this.match;
      }
    } catch (e) {
      log.error('ingest', `serverinfo handling failed: ${e.message}`);
    }
  }

  // After a ListPlayers poll, make sure every live player has a DB row + dbId
  // and that renames observed by the poll land in players/player_names.
  onPlayersUpdated() {
    try {
      if (!this.state || !this.state.players) return;
      const now = Date.now();
      for (const rec of this.state.players.values()) {
        if (!rec || !rec.eosId) continue;
        const p = this.getOrCreatePlayer({ eosId: rec.eosId, steamId: rec.steamId, name: rec.name, time: now });
        if (p && !rec.dbId) rec.dbId = p.id;
      }
    } catch (e) {
      log.error('ingest', `players-updated handling failed: ${e.message}`);
    }
  }

  // ---------------------------------------------------------------- sessions

  closeSession(sessionId, playerId, connectAt, disconnectAt) {
    const start = Number(connectAt) || 0;
    const end = Math.max(start, Number(disconnectAt) || 0);
    this.stmt('UPDATE sessions SET disconnect_at=? WHERE id=?').run(end, sessionId);
    const secs = Math.max(0, Math.round((end - start) / 1000));
    if (secs > 0 && playerId != null) {
      this.stmt('UPDATE players SET play_seconds=play_seconds+? WHERE id=?').run(secs, playerId);
    }
  }

  handleConnect(ev) {
    const time = Number(ev.time) || Date.now();
    const eosId = lowerOrNull(ev.eosId);
    if (!eosId) return;
    const p = this.getOrCreatePlayer({ eosId, steamId: ev.steamId, time });
    if (ev.ip) {
      this.stmt(
        `INSERT INTO player_ips(player_id, ip, first_seen, last_seen, times) VALUES(?,?,?,?,1)
         ON CONFLICT(player_id, ip) DO UPDATE SET last_seen=MAX(last_seen, excluded.last_seen), times=times+1`
      ).run(p.id, String(ev.ip), time, time);
    }
    // Close any dangling session for this player (missed disconnect), then open a new one.
    const dangling = this.stmt('SELECT id, connect_at FROM sessions WHERE player_id=? AND disconnect_at IS NULL').all(p.id);
    for (const s of dangling) this.closeSession(s.id, p.id, s.connect_at, Math.min(p.prevLastSeen, time));
    this.stmt('INSERT INTO sessions(player_id, connect_at) VALUES(?,?)').run(p.id, time);

    const rec = this.ensureLiveRecord(eosId, {
      dbId: p.id,
      steamId: ev.steamId ? String(ev.steamId) : undefined,
      ip: ev.ip || null,
      controller: ev.controller || null,
      connectedAt: time,
      sessKills: 0, sessDeaths: 0, sessTks: 0, // §19.1.1: init on connect
    });
    if (rec && !rec.name && p.prevName) rec.name = p.prevName;
    if (ev.controller && this.state && this.state.controllers) this.state.controllers.set(ev.controller, eosId);
    this.lastConnectedEos = eosId;

    this.enforceBan(p.id, rec || { eosId }, time);
    this.bus.emit('player-connected', { time, player: this.ref(rec, { dbId: p.id, eosId, steamId: ev.steamId || null }) });
  }

  // JOIN_SUCCEEDED carries only the name; it always directly follows the
  // PostLogin (PLAYER_CONNECTED) line for the same player in Squad logs.
  handleJoin(ev) {
    const eosId = this.lastConnectedEos;
    this.lastConnectedEos = null;
    if (!eosId) return;
    const name = capName(ev.suffixName);
    if (!name) return;
    const time = Number(ev.time) || Date.now();
    const p = this.getOrCreatePlayer({ eosId, name, time });
    this.ensureLiveRecord(eosId, { name, dbId: p ? p.id : undefined });
  }

  handleDisconnect(ev) {
    const time = Number(ev.time) || Date.now();
    const eosId = lowerOrNull(ev.eosId);
    if (!eosId) return;
    const p = this.getOrCreatePlayer({ eosId, time });
    const open = this.stmt('SELECT id, connect_at FROM sessions WHERE player_id=? AND disconnect_at IS NULL').all(p.id);
    for (const s of open) this.closeSession(s.id, p.id, s.connect_at, time);
    const rec = this.state && this.state.players ? this.state.players.get(eosId) || null : null;
    const refOut = this.ref(rec, { dbId: p.id, eosId });
    if (rec && rec.controller && this.state.controllers) this.state.controllers.delete(rec.controller);
    if (this.state && this.state.players) this.state.players.delete(eosId);
    this.bus.emit('player-disconnected', { time, player: refOut });
  }

  // ------------------------------------------------------------------- bans

  enforceBan(dbId, rec, time) {
    const ban = this.stmt(
      `SELECT id, reason, expires_at FROM bans
        WHERE player_id=? AND active=1 AND (expires_at IS NULL OR expires_at > ?)
        ORDER BY id DESC LIMIT 1`
    ).get(dbId, time);
    if (!ban) return;
    const until = ban.expires_at != null ? new Date(Number(ban.expires_at)).toISOString().slice(0, 10) : 'perm';
    const reason = `Banned: ${ban.reason || 'no reason recorded'} (until ${until})`;
    log.info('ingest', `ban enforcement: kicking player#${dbId} (${rec.name || rec.eosId || '?'})`, reason);
    if (this.admin && typeof this.admin.execAdmin === 'function') {
      // System action (§19.1.2): user NULL -> audited with user_id NULL by admin.js.
      Promise.resolve(this.admin.execAdmin(null, 'kick', { playerId: dbId, reason }))
        .catch((e) => log.warn('ingest', `ban enforcement kick failed: ${e.message}`));
    }
  }

  // ------------------------------------------------------------------ kills

  handleKill(ev, kind) {
    const time = Number(ev.time) || Date.now();
    const matchId = this.match ? this.match.id : null;
    const atk = this.resolveActor({ idsBlob: ev.attackerIds, controller: ev.attackerController, time });
    const vic = this.resolveByName(ev.victimName, time);
    const damage = toNum(ev.damage);
    const suicide = !!(atk.dbId && vic.dbId && atk.dbId === vic.dbId);
    const teamkill = !suicide && !!(
      atk.rec && vic.rec && atk.rec.teamId != null && vic.rec.teamId != null
      && Number(atk.rec.teamId) === Number(vic.rec.teamId)
    );

    this.stmt('INSERT INTO kills(match_id, time, kind, attacker_id, victim_id, weapon, damage, teamkill, suicide) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(matchId, time, kind, atk.dbId, vic.dbId, ev.weapon || null, damage, teamkill ? 1 : 0, suicide ? 1 : 0);

    // Squad convention: the wound IS the kill; die = gave up, recorded but never
    // double-counted in aggregates or session counters.
    if (kind === 'wound') {
      if (suicide) {
        this.bumpPlayers(vic.dbId, { deaths: 1, suicides: 1 }, time);
        this.bumpMatchPlayer(matchId, vic.dbId, vic.rec, { deaths: 1 });
        if (vic.rec && vic.rec.eosId) this.safeBumpSession(vic.rec.eosId, { deaths: 1 });
      } else {
        if (atk.dbId) {
          this.bumpPlayers(atk.dbId, { kills: 1, teamkills: teamkill ? 1 : 0 }, time);
          this.bumpMatchPlayer(matchId, atk.dbId, atk.rec, { kills: 1, teamkills: teamkill ? 1 : 0 });
          this.safeBumpSession(atk.eosId, teamkill ? { kills: 1, tks: 1 } : { kills: 1 });
        }
        if (vic.dbId) {
          this.bumpPlayers(vic.dbId, { deaths: 1, tk_deaths: teamkill ? 1 : 0 }, time);
          this.bumpMatchPlayer(matchId, vic.dbId, vic.rec, { deaths: 1, tk_deaths: teamkill ? 1 : 0 });
          if (vic.rec && vic.rec.eosId) this.safeBumpSession(vic.rec.eosId, { deaths: 1 });
        }
        if (teamkill && atk.dbId) this.onTeamkill(atk, vic, time, matchId);
      }
    }

    this.bus.emit('kill', {
      time, matchId, kind,
      attacker: (atk.rec || atk.dbId || atk.eosId) ? this.ref(atk.rec, { dbId: atk.dbId, eosId: atk.eosId, steamId: atk.steamId }) : null,
      victim: this.ref(vic.rec, { dbId: vic.dbId, name: ev.victimName }),
      weapon: ev.weapon || null, damage, teamkill, suicide,
    });
  }

  bumpPlayers(dbId, d, time) {
    if (!dbId) return;
    this.stmt(
      `UPDATE players SET
         kills=kills+?, deaths=deaths+?, teamkills=teamkills+?, tk_deaths=tk_deaths+?,
         suicides=suicides+?, revives_given=revives_given+?, revives_taken=revives_taken+?,
         last_seen=MAX(last_seen, ?)
       WHERE id=?`
    ).run(d.kills || 0, d.deaths || 0, d.teamkills || 0, d.tk_deaths || 0,
      d.suicides || 0, d.revives_given || 0, d.revives_taken || 0, time || 0, dbId);
  }

  bumpMatchPlayer(matchId, dbId, rec, d) {
    if (matchId == null || !dbId) return;
    this.stmt(
      `INSERT INTO match_players(match_id, player_id, team_id, kills, deaths, teamkills, tk_deaths, revives, damage_dealt)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(match_id, player_id) DO UPDATE SET
         team_id=COALESCE(excluded.team_id, team_id),
         kills=kills+excluded.kills, deaths=deaths+excluded.deaths,
         teamkills=teamkills+excluded.teamkills, tk_deaths=tk_deaths+excluded.tk_deaths,
         revives=revives+excluded.revives, damage_dealt=damage_dealt+excluded.damage_dealt`
    ).run(matchId, dbId, rec && rec.teamId != null ? Number(rec.teamId) : null,
      d.kills || 0, d.deaths || 0, d.teamkills || 0, d.tk_deaths || 0, d.revives || 0, d.damage || 0);
  }

  onTeamkill(atk, vic, time, matchId) {
    const fc = this.flagCfg();
    const victimName = vic.rec && vic.rec.name ? vic.rec.name : null;

    // tk_spree: >= N TK wounds inside the window; one flag per spree, then reset.
    const windowMs = fc.tkSpreeWindowSec * 1000;
    let arr = this.tkTimes.get(atk.dbId) || [];
    arr = arr.filter((t) => time - t < windowMs);
    arr.push(time);
    if (arr.length >= fc.tkSpreeCount) {
      this.insertFlag({
        type: 'tk_spree', severity: 3, playerDbId: atk.dbId, rec: atk.rec, matchId, time,
        details: { count: arr.length, windowSec: fc.tkSpreeWindowSec, victim: victimName },
      });
      arr = [];
    }
    this.tkTimes.set(atk.dbId, arr);

    // mass_tk: >= N TKs in one match; one flag per (player, match).
    if (matchId != null) {
      const row = this.stmt(
        `SELECT COUNT(*) AS n FROM kills WHERE attacker_id=? AND match_id=? AND teamkill=1 AND kind='wound'`
      ).get(atk.dbId, matchId);
      const n = row ? Number(row.n) : 0;
      if (n >= fc.massTkCount) {
        const existing = this.stmt(`SELECT id FROM flags WHERE type='mass_tk' AND player_id=? AND match_id=?`).get(atk.dbId, matchId);
        if (!existing) {
          this.insertFlag({
            type: 'mass_tk', severity: 3, playerDbId: atk.dbId, rec: atk.rec, matchId, time,
            details: { count: n },
          });
        }
      }
    }

    // new_player_tk: TK within newPlayerMinutes of first_seen.
    const prow = this.stmt('SELECT first_seen FROM players WHERE id=?').get(atk.dbId);
    if (prow && prow.first_seen != null && time - Number(prow.first_seen) <= fc.newPlayerMinutes * 60000) {
      this.insertFlag({
        type: 'new_player_tk', severity: 2, playerDbId: atk.dbId, rec: atk.rec, matchId, time,
        details: { minutesSinceFirstSeen: Math.round((time - Number(prow.first_seen)) / 60000), victim: victimName },
      });
    }

    if (this.config.autoWarnTeamkiller) this.autoWarn(atk, vic, time);
  }

  autoWarn(atk, vic, time) {
    // §19.3.17: values substituted into autoWarnMessage have `"` stripped.
    const stripQ = (s) => String(s == null ? '' : s).replace(/"/g, '');
    const tpl = String(this.config.autoWarnMessage || 'Teamkill detected: {victim}. TKs are logged.');
    const msg = tpl
      .replace(/\{victim\}/g, stripQ(vic.rec && vic.rec.name ? vic.rec.name : 'a teammate'))
      .replace(/\{attacker\}/g, stripQ(atk.rec && atk.rec.name ? atk.rec.name : ''));
    this.stmt('INSERT INTO warnings(player_id, by_user, time, message, auto) VALUES(?,?,?,?,1)')
      .run(atk.dbId, null, time, msg);
    if (this.admin && typeof this.admin.execAdmin === 'function') {
      Promise.resolve(this.admin.execAdmin(null, 'warn', { playerId: atk.dbId, message: msg }))
        .catch((e) => log.warn('ingest', `auto-warn failed: ${e.message}`));
    }
  }

  // ------------------------------------------------------------------ damage

  handleDamage(ev) {
    const time = Number(ev.time) || Date.now();
    const matchId = this.match ? this.match.id : null;
    const atk = this.resolveActor({ idsBlob: ev.attackerIds, controller: ev.attackerController, name: capName(ev.attackerName), time });
    const vic = this.resolveByName(ev.victimName, time);
    if (!atk.dbId || !vic.dbId) return;
    const damage = toNum(ev.damage) || 0;
    const self = atk.dbId === vic.dbId;
    const teamdamage = !self && atk.rec && vic.rec && atk.rec.teamId != null && vic.rec.teamId != null
      && Number(atk.rec.teamId) === Number(vic.rec.teamId) ? 1 : 0;
    // No per-hit rows; aggregate only. match_id is part of the PK, so hits that
    // land before any match is known are not aggregated.
    if (matchId == null) return;
    this.stmt(
      `INSERT INTO damage_agg(match_id, attacker_id, victim_id, weapon, hits, total, teamdamage)
       VALUES(?,?,?,?,1,?,?)
       ON CONFLICT(match_id, attacker_id, victim_id, weapon) DO UPDATE SET
         hits=hits+1, total=total+excluded.total, teamdamage=MAX(teamdamage, excluded.teamdamage)`
    ).run(matchId, atk.dbId, vic.dbId, ev.weapon || 'unknown', damage, teamdamage);
    this.bumpMatchPlayer(matchId, atk.dbId, atk.rec, { damage });
  }

  // ----------------------------------------------------------------- revives

  handleRevive(ev) {
    const time = Number(ev.time) || Date.now();
    const matchId = this.match ? this.match.id : null;
    const rIds = scanIds(ev.reviverIds);
    const vIds = scanIds(ev.revivedIds);
    const reviver = rIds.eosId ? this.getOrCreatePlayer({ eosId: rIds.eosId, steamId: rIds.steamId, name: capName(ev.reviverName), time }) : null;
    const revived = vIds.eosId ? this.getOrCreatePlayer({ eosId: vIds.eosId, steamId: vIds.steamId, name: capName(ev.revivedName), time }) : null;
    const rRec = rIds.eosId && this.state && typeof this.state.byEos === 'function' ? this.state.byEos(rIds.eosId) : null;
    const vRec = vIds.eosId && this.state && typeof this.state.byEos === 'function' ? this.state.byEos(vIds.eosId) : null;
    if (rRec && reviver && !rRec.dbId) rRec.dbId = reviver.id;
    if (vRec && revived && !vRec.dbId) vRec.dbId = revived.id;

    this.stmt('INSERT INTO revives(match_id, time, reviver_id, revived_id) VALUES(?,?,?,?)')
      .run(matchId, time, reviver ? reviver.id : null, revived ? revived.id : null);
    if (reviver) {
      this.bumpPlayers(reviver.id, { revives_given: 1 }, time);
      this.bumpMatchPlayer(matchId, reviver.id, rRec, { revives: 1 });
    }
    if (revived) this.bumpPlayers(revived.id, { revives_taken: 1 }, time);

    this.bus.emit('revive', {
      time, matchId,
      reviver: this.ref(rRec, { dbId: reviver ? reviver.id : null, eosId: rIds.eosId, steamId: rIds.steamId, name: capName(ev.reviverName) }),
      revived: this.ref(vRec, { dbId: revived ? revived.id : null, eosId: vIds.eosId, steamId: vIds.steamId, name: capName(ev.revivedName) }),
    });
  }

  // ------------------------------------------------------------- deployables

  handleDeployable(ev) {
    const time = Number(ev.time) || Date.now();
    const matchId = this.match ? this.match.id : null;
    const damage = toNum(ev.damage) || 0;

    let cls = { category: 'other', factionToken: null, label: ev.deployable || 'unknown' };
    try {
      const c = getFactions().classifyDeployable(ev.deployable);
      if (c) cls = { category: c.category || 'other', factionToken: c.factionToken != null ? c.factionToken : null, label: c.label || cls.label };
    } catch (e) {
      log.warn('ingest', `deployable classification unavailable (${e.message}) — storing as unknown`);
    }

    const inst = this.resolveByName(ev.playerName, time);
    const teamId = inst.rec && inst.rec.teamId != null ? Number(inst.rec.teamId) : null;
    let friendly = -1; // -1 = unknown; never guess (§0 honesty)
    try {
      const f = getFactions().resolveFriendly(cls.factionToken, teamId, this.match || {});
      friendly = f === 1 || f === 0 ? f : -1;
    } catch (_e) {
      friendly = -1;
    }

    this.stmt(
      `INSERT INTO deployable_damage(match_id, time, player_id, player_team, deployable, category, dep_faction,
         friendly, damage, weapon, damage_type, health_remaining)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(matchId, time, inst.dbId, teamId, ev.deployable || null, cls.category, cls.factionToken,
      friendly, damage, ev.weapon || null, ev.damageType || null, toNum(ev.healthRemaining));

    if (inst.dbId) {
      let col = 'deployable_damage_unknown';
      if (cls.category === 'radio' && friendly === 1) col = 'radio_damage_friendly';
      else if (cls.category === 'radio' && friendly === 0) col = 'radio_damage_enemy';
      else if (cls.category === 'hab' && friendly === 1) col = 'hab_damage_friendly';
      else if (cls.category === 'hab' && friendly === 0) col = 'hab_damage_enemy';
      // col comes from the fixed whitelist above — never from input.
      this.stmt(`UPDATE players SET ${col}=${col}+?, last_seen=MAX(last_seen, ?) WHERE id=?`).run(damage, time, inst.dbId);

      if (cls.category === 'radio' && friendly === 1) {
        this.accumulateFlag({
          type: 'friendly_radio', severity: 3, playerDbId: inst.dbId, rec: inst.rec, matchId, time,
          details: { damage, weapon: ev.weapon || null, hits: 1 },
        });
      } else if (cls.category === 'radio' && friendly === -1 && damage >= 100) {
        this.accumulateFlag({
          type: 'radio_unknown', severity: 1, playerDbId: inst.dbId, rec: inst.rec, matchId, time,
          details: { damage, weapon: ev.weapon || null, hits: 1 },
        });
      }
    }

    this.bus.emit('deployable', {
      time, matchId,
      player: ev.playerName || inst.dbId ? this.ref(inst.rec, { dbId: inst.dbId, name: capName(ev.playerName) }) : null,
      deployable: ev.deployable, category: cls.category, depFaction: cls.factionToken, friendly,
      damage, weapon: ev.weapon || null, damageType: ev.damageType || null,
      healthRemaining: toNum(ev.healthRemaining), label: cls.label,
    });
  }

  // ------------------------------------------------------------------- flags

  insertFlag(f) {
    const details = f.details == null ? {} : f.details;
    const r = this.stmt('INSERT INTO flags(player_id, time, type, severity, match_id, details) VALUES(?,?,?,?,?,?)')
      .run(f.playerDbId, f.time, f.type, f.severity, f.matchId, JSON.stringify(details));
    this.bus.emit('flag', {
      time: f.time, flagId: r.lastInsertRowid, type: f.type, severity: f.severity,
      player: this.ref(f.rec, { dbId: f.playerDbId }), matchId: f.matchId != null ? f.matchId : null, details,
    });
    return r.lastInsertRowid;
  }

  // Dedupe rule for friendly_radio / radio_unknown: one flag per (player, match);
  // repeats accumulate damage/hits into the existing row's details.
  accumulateFlag(f) {
    const existing = this.stmt('SELECT id, details FROM flags WHERE type=? AND player_id=? AND match_id IS ? ORDER BY id LIMIT 1')
      .get(f.type, f.playerDbId, f.matchId);
    if (!existing) {
      this.insertFlag(f);
      return;
    }
    let det = {};
    try { det = JSON.parse(existing.details || '{}') || {}; } catch (_e) { det = {}; }
    det.damage = (toNum(det.damage) || 0) + (toNum(f.details.damage) || 0);
    det.hits = (toNum(det.hits) || 0) + 1;
    if (f.details.weapon) det.weapon = f.details.weapon;
    this.stmt('UPDATE flags SET details=? WHERE id=?').run(JSON.stringify(det), existing.id);
  }

  // --------------------------------------------------------- match lifecycle

  handleNewGame(ev) {
    const time = Number(ev.time) || Date.now();
    // Close every still-open match (NEW_GAME is the authoritative end). Does NOT touch sessions.
    const open = this.stmt('SELECT id FROM matches WHERE ended_at IS NULL').all();
    for (const m of open) this.stmt('UPDATE matches SET ended_at=? WHERE id=?').run(time, m.id);

    const layerClass = ev.layerClass || null;
    const layer = layerClass ? prettyLayer(layerClass) : null;
    const level = ev.level || null; // §19.1.12: the Maps/<folder> segment
    const r = this.stmt('INSERT INTO matches(layer, level, layer_class, started_at) VALUES(?,?,?,?)')
      .run(layer, level, layerClass, time);
    this.match = { id: r.lastInsertRowid, layer, level, layerClass, team1: null, team2: null, startedAt: time };
    if (this.state) this.state.match = this.match;
    // team1/team2 (and a display layer, if ours is missing) arrive with the next serverinfo-updated.
    this.bus.emit('match-start', { matchId: this.match.id, layer, level, team1: null, team2: null, startedAt: time });
  }

  handleMatchState(ev) {
    const time = Number(ev.time) || Date.now();
    if (ev.to === 'InProgress' && this.match) {
      this.stmt('UPDATE matches SET in_progress_at=COALESCE(in_progress_at, ?) WHERE id=?').run(time, this.match.id);
    }
    this.bus.emit('match-state', { time, matchId: this.match ? this.match.id : null, from: ev.from, to: ev.to });
  }

  handleRoundEnded(ev) {
    if (ev.result !== 'won') return; // the paired "lost" line carries no extra info
    const time = Number(ev.time) || Date.now();
    if (!this.match) {
      log.warn('ingest', 'ROUND_ENDED with no open match — ignored');
      return;
    }
    const winnerTeam = toInt(ev.team);
    const tickets = toInt(ev.tickets);
    const level = ev.level || this.match.level; // §19.1.12: ROUND_ENDED level overwrites
    this.stmt('UPDATE matches SET winner_team=?, winner_faction=?, tickets=?, level=? WHERE id=?')
      .run(winnerTeam, ev.factionName || null, tickets, level, this.match.id);
    this.match.level = level;
    // Match row stays open until NEW_GAME; the enriched match-end fires now.
    this.bus.emit('match-end', {
      matchId: this.match.id, layer: this.match.layer, level,
      team1: this.match.team1, team2: this.match.team2, startedAt: this.match.startedAt,
      winnerTeam, winnerFaction: ev.factionName || null, tickets, endedAt: time,
    });
  }

  handleTickRate(ev) {
    const time = Number(ev.time) || Date.now();
    const rate = toNum(ev.tickRate);
    if (this.state) this.state.tickRate = rate;
    this.bus.emit('tick-rate', { time, tickRate: rate });
  }
}

module.exports = Ingest;
module.exports.Ingest = Ingest;
