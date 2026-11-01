'use strict';
// MockSquad — a fake Squad dedicated server for tests and demo mode (SPEC §15).
//
// STANDALONE: requires ONLY node: builtins (net, fs, events, path). It must not
// require any server/ module, so a couple of tiny helpers (pretty-layer, time
// stamp formatting) are implemented locally instead of via server/util.js.
//
// Provides:
//   - a real TCP RCON server implementing the §4.1 packet protocol (auth check,
//     multi-packet responses + the empty-exec sentinel echo, type-1 chat packets),
//   - EXACT real-format responses (§6.4) for the List*/Show* commands,
//   - Admin* commands that mutate mock state and reply with realistic strings,
//   - a log writer appending EXACT §6.2-shaped lines to `logPath`,
//   - a scripting API (addPlayer/chat/wound/die/... — all take an explicit
//     `time` (epoch ms) or default to Date.now()).

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const T_RESPONSE = 0; // SERVERDATA_RESPONSE_VALUE
const T_CHAT = 1; // SERVERDATA_CHAT_VALUE (Squad-specific)
const T_EXEC = 2; // SERVERDATA_EXECCOMMAND (client->server) / AUTH_RESPONSE (server->client)
const T_AUTH = 3; // SERVERDATA_AUTH

const MAX_BODY = 4096; // Squad splits bigger responses into multiple packets

// Deterministic name pool (clan tags + unicode) — demo + tests rely on this order.
const NAME_POOL = [
  'Wardex', 'BobTheBuilder', '[TLA] Ironhide', '=UBF= Кузнец', 'GoodGuy',
  '[7Pz] Günther', 'ÜberSniper', '龍の騎士', '[FR] Léon', 'xX_Shadow_Xx',
  '[RIP] Gravedigger', 'Sgt.Pepper', '[ANZ] Wombat', 'Mehmet Öz', '[KGB] Vodkaman',
  'Pixel|Pusher', '[USMC] Devil Dog', 'Čapek', '[GER] Blitz', 'NoScopeNina',
  '[BR] Capoeira', 'Señor Tango', '[PL] Wiedźmin', 'Habibi<3', '[CAF] Maple',
  '[NL] Vliegende Hollander', 'Stray (Bullet)', '[SWE] Norseman', 'Doc: Holiday', 'TicTac',
  '[MEA] Scimitar', 'Крокодил', '[AUS] Dropbear', 'Quiet|Storm', '[UK] Teabagger',
  '[TR] Yıldırım', 'Papa Smurf', '[VDV] Desantnik', 'Jäger Bomb', 'LowTTK',
  '[INS] Sandstorm', 'ElPresidente', '[IMF] Paperclip', 'Mörser Karl', 'FNG_Timmy',
  '[WPMC] Contractor', 'Boris the Blade', '[PLA] 东风', 'Kiwi Bird', 'OneManArmy',
  'Медведь', '[CDN] Tim Bits', 'Steely Dan', '[BAF] Crumpet', 'ADS Andy',
  '[RGF] Zapad', 'Lone Wolf McQuade', 'Touché', 'Sir Camps-a-lot', 'MedicMain',
];

const DEFAULT_LAYERS = [
  'Yehorivka_RAAS_v1',
  'Narva_AAS_v2',
  'Gorodok_RAAS_v1',
  'Mutaha_AAS_v1',
  'AlBasrah_Invasion_v1',
  'Fallujah_RAAS_v1',
  'Kohat_RAAS_v1',
  'Tallil_Invasion_v1',
];

// Faction setups keyed by token (used for TeamOne_s/TeamTwo_s + squad-created lines).
const FACTIONS = {
  USA: { setup: 'USA_S_CombinedArms', name: 'United States Army' },
  RGF: { setup: 'RGF_S_CombinedArms', name: 'Russian Ground Forces' },
  WPMC: { setup: 'WPMC_S_CombinedArms', name: 'Manticore Security Task Force' },
  BAF: { setup: 'BAF_S_CombinedArms', name: 'British Armed Forces' },
};

function pretty(s) {
  return String(s == null ? '' : s).replace(/_/g, ' ').trim();
}

// "[2026.03.01-21.50.52:123]" — stamp is written as UTC (parseLogTime assumes UTC).
function logStamp(t) {
  const d = new Date(t);
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return (
    d.getUTCFullYear() + '.' + p(d.getUTCMonth() + 1) + '.' + p(d.getUTCDate()) +
    '-' + p(d.getUTCHours()) + '.' + p(d.getUTCMinutes()) + '.' + p(d.getUTCSeconds()) +
    ':' + p(d.getUTCMilliseconds(), 3)
  );
}

function fmtDamage(n) {
  return Number(n).toFixed(6);
}

function stripC(name) {
  // "BP_SVDM_Optic_C" -> "BP_SVDM_Optic" (writers append the _C themselves)
  return String(name).replace(/_C$/, '');
}

class MockSquad extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.rconPort = o.rconPort != null ? o.rconPort : 0;
    this.logPath = o.logPath || null;
    this.password = o.password != null ? o.password : 'demo';
    // When set to a number N, every outgoing socket write is flushed in N-byte
    // chunks (lets rcon.test.js exercise fragmented delivery).
    this.fragmentBytes = o.fragmentBytes || null;

    this.port = null;
    this.server = null;
    this._sockets = new Set(); // every socket, authed or not
    this._clients = new Set(); // authed sockets (receive type-1 packets)

    // ---- mock game state ----
    this.players = new Map(); // eosId -> player
    this.disconnected = []; // newest first, max 15: {player, at}
    this.squads = new Map(); // `${teamId}:${squadId}` -> squad
    this.bans = []; // {eosId, steamId, name, interval, reason, at}
    this.layers = (o.layers || DEFAULT_LAYERS).slice();
    this.teams = {
      1: { token: 'USA', setup: FACTIONS.USA.setup, name: FACTIONS.USA.name },
      2: { token: 'RGF', setup: FACTIONS.RGF.setup, name: FACTIONS.RGF.name },
    };
    this.current = this._layerInfo(o.currentLayer || this.layers[0]);
    this.next = this._layerInfo(o.nextLayer || this.layers[1]);
    this.tickRate = 40.0;
    this.serverName = o.serverName || 'SquadWatch Mock Server';
    this.maxPlayers = o.maxPlayers || 100;
    this.matchStartedAt = Date.now();

    this.commands = []; // raw EXECCOMMAND strings received (for test assertions)

    this._n = 0; // deterministic id counter
    this._pid = 0; // next in-game numeric player id
    this._frame = 100; // log frame counter
    this._inst = 2146000000; // deployable/causer instance counter
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    return new Promise((resolve, reject) => {
      if (this.logPath) {
        fs.mkdirSync(path.dirname(path.resolve(this.logPath)), { recursive: true });
        if (!fs.existsSync(this.logPath)) fs.writeFileSync(this.logPath, '');
      }
      this.server = net.createServer((sock) => this._onConnection(sock));
      this.server.on('error', reject);
      this.server.listen(this.rconPort, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve({ port: this.port });
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      for (const s of this._sockets) s.destroy();
      this._sockets.clear();
      this._clients.clear();
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  // ------------------------------------------------------------ rcon protocol

  _onConnection(sock) {
    const st = { buf: Buffer.alloc(0), authed: false };
    this._sockets.add(sock);
    sock.on('data', (chunk) => {
      st.buf = Buffer.concat([st.buf, chunk]);
      try {
        this._drain(sock, st);
      } catch (e) {
        sock.destroy();
      }
    });
    const bye = () => {
      this._sockets.delete(sock);
      this._clients.delete(sock);
    };
    sock.on('close', bye);
    sock.on('error', bye);
  }

  _drain(sock, st) {
    while (st.buf.length >= 4) {
      const size = st.buf.readInt32LE(0);
      if (size < 10 || size > 1 << 20) {
        sock.destroy();
        return;
      }
      if (st.buf.length < size + 4) return; // wait for more
      const id = st.buf.readInt32LE(4);
      const type = st.buf.readInt32LE(8);
      const body = st.buf.slice(12, size + 2).toString('utf8');
      st.buf = st.buf.slice(size + 4);
      this._onPacket(sock, st, { id, type, body });
    }
  }

  _onPacket(sock, st, pkt) {
    if (pkt.type === T_AUTH) {
      // Real servers send an empty RESPONSE_VALUE before the auth response.
      this._sendPacket(sock, pkt.id, T_RESPONSE, '');
      if (pkt.body === this.password) {
        st.authed = true;
        this._clients.add(sock);
        this._sendPacket(sock, pkt.id, T_EXEC, '');
      } else {
        this._sendPacket(sock, -1, T_EXEC, '');
      }
      return;
    }
    if (pkt.type === T_EXEC) {
      if (!st.authed) return; // unauthenticated exec is ignored
      if (pkt.body === '') {
        // multi-packet sentinel: echo an empty response with the same id
        this._sendPacket(sock, pkt.id, T_RESPONSE, '');
        return;
      }
      const raw = pkt.body;
      this.commands.push(raw);
      let response;
      try {
        response = this._handleCommand(raw);
      } catch (e) {
        response = 'Error: ' + e.message;
      }
      this.emit('command', { raw, response });
      // split big bodies into MAX_BODY-byte packets, all with the command id
      const buf = Buffer.from(String(response == null ? '' : response), 'utf8');
      if (buf.length === 0) {
        this._sendPacket(sock, pkt.id, T_RESPONSE, '');
      } else {
        for (let off = 0; off < buf.length; off += MAX_BODY) {
          this._sendPacket(sock, pkt.id, T_RESPONSE, buf.slice(off, off + MAX_BODY));
        }
      }
    }
  }

  _sendPacket(sock, id, type, body) {
    const b = Buffer.isBuffer(body) ? body : Buffer.from(String(body == null ? '' : body), 'utf8');
    const buf = Buffer.alloc(14 + b.length);
    buf.writeInt32LE(10 + b.length, 0);
    buf.writeInt32LE(id | 0, 4);
    buf.writeInt32LE(type | 0, 8);
    b.copy(buf, 12);
    this._write(sock, buf);
  }

  _write(sock, buf) {
    if (sock.destroyed) return;
    const n = this.fragmentBytes;
    if (n && n > 0) {
      for (let off = 0; off < buf.length; off += n) sock.write(buf.slice(off, off + n));
    } else {
      sock.write(buf);
    }
  }

  // Send a type-1 (chat/event) packet to every authed client.
  sendChatPacket(body) {
    for (const sock of this._clients) this._sendPacket(sock, 0, T_CHAT, body);
    this.emit('chat-packet', body);
  }

  // -------------------------------------------------------------- log writer

  writeLog(rest, time) {
    const t = time != null ? time : Date.now();
    const line = '[' + logStamp(t) + '][' + (this._frame++ % 100000) + ']' + rest;
    if (this.logPath) fs.appendFileSync(this.logPath, line + '\n');
    this.emit('log-line', line);
    return line;
  }

  // ------------------------------------------------------------- state utils

  _layerInfo(layerClass) {
    const lc = String(layerClass).replace(/ /g, '_');
    const level = lc.split('_')[0];
    const mode = lc.split('_')[1] || 'RAAS';
    return { layerClass: lc, layer: pretty(lc), level, mode };
  }

  _nextIds() {
    const n = ++this._n;
    return {
      eosId: '0002' + n.toString(16).padStart(28, '0'),
      steamId: String(76561198000100000n + BigInt(n)),
      controller: 'BP_PlayerController_C_' + (2147250000 + n),
      ip: '100.64.' + Math.floor(n / 250) + '.' + ((n % 250) + 1),
    };
  }

  onlinePlayers() {
    return Array.from(this.players.values());
  }

  resolvePlayer(x) {
    if (x == null) return null;
    if (typeof x === 'object' && x.eosId) return this.players.get(x.eosId) || x;
    if (typeof x === 'number') {
      for (const p of this.players.values()) if (p.playerId === x) return p;
      return null;
    }
    const s = String(x);
    if (/^\d{1,6}$/.test(s)) {
      const n = parseInt(s, 10);
      for (const p of this.players.values()) if (p.playerId === n) return p;
    }
    if (/^[0-9a-f]{32}$/i.test(s)) return this.players.get(s.toLowerCase()) || null;
    if (/^7656\d{13}$/.test(s)) {
      for (const p of this.players.values()) if (p.steamId === s) return p;
      return null;
    }
    for (const p of this.players.values()) if (p.name === s) return p;
    const lo = s.toLowerCase();
    for (const p of this.players.values()) if (p.name.toLowerCase() === lo) return p;
    return null;
  }

  _idsBlob(p) {
    return 'EOS: ' + p.eosId + ' steam: ' + p.steamId;
  }

  // ------------------------------------------------------------ scripting API

  // addPlayer({name?, teamId?, squadId?, role?, eosId?, steamId?}, time?) -> player
  addPlayer(p, time) {
    const o = p || {};
    const ids = this._nextIds();
    const teamId = o.teamId != null ? o.teamId : (this._n % 2 === 1 ? 1 : 2);
    const player = {
      playerId: o.playerId != null ? o.playerId : this._pid++,
      eosId: (o.eosId || ids.eosId).toLowerCase(),
      steamId: o.steamId || ids.steamId,
      name: o.name || NAME_POOL[(this._n - 1) % NAME_POOL.length],
      teamId,
      squadId: o.squadId != null ? o.squadId : null,
      isLeader: !!o.isLeader,
      role: o.role || this.teams[teamId].token + '_Rifleman_01',
      controller: ids.controller,
      ip: o.ip || ids.ip,
      connectedAt: time != null ? time : Date.now(),
    };
    this.players.set(player.eosId, player);
    const t = time != null ? time : Date.now();
    const c = this.current;
    this.writeLog(
      'LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/Maps/' + c.level +
      '/Gameplay_Layers/' + c.layerClass + '.' + c.layerClass + ':PersistentLevel.' +
      player.controller + ' (IP: ' + player.ip + ' | Online IDs: ' + this._idsBlob(player) + ')',
      t
    );
    this.writeLog('LogNet: Join succeeded: ' + player.name, t);
    return player;
  }

  // removePlayer(playerOrSelector, time?) -> removed player or null
  removePlayer(x, time) {
    const p = this.resolvePlayer(x);
    if (!p || !this.players.has(p.eosId)) return null;
    const t = time != null ? time : Date.now();
    this.players.delete(p.eosId);
    this.disconnected.unshift({ player: p, at: t });
    if (this.disconnected.length > 15) this.disconnected.length = 15;
    this.writeLog(
      'LogNet: UNetConnection::Close: [UNetConnection] RemoteAddr: ' + p.ip + ':' +
      (50000 + p.playerId) + ', Name: EOSIpNetConnection_' + (2147254000 + p.playerId) +
      ', Driver: GameNetDriver EOSNetDriver_2147482519, IsServer: YES, PC: ' + p.controller +
      ', Owner: ' + p.controller + ', UniqueId: RedpointEOS:' + p.eosId,
      t
    );
    return p;
  }

  // createSquad(creator, squadName, time?) — helper beyond the §15 list (needed
  // so ListSquads/demo have real squads); writes the §6.2 squad-created line.
  createSquad(creator, squadName, time) {
    const p = this.resolvePlayer(creator);
    if (!p) return null;
    let maxId = 0;
    for (const sq of this.squads.values()) if (sq.teamId === p.teamId && sq.squadId > maxId) maxId = sq.squadId;
    const squad = {
      teamId: p.teamId,
      squadId: maxId + 1,
      name: squadName,
      locked: false,
      creatorName: p.name,
      creatorEos: p.eosId,
      creatorSteam: p.steamId,
    };
    this.squads.set(squad.teamId + ':' + squad.squadId, squad);
    p.squadId = squad.squadId;
    p.isLeader = true;
    this.writeLog(
      'LogSquad: ' + p.name + ' (Online IDs: ' + this._idsBlob(p) + ') has created Squad ' +
      squad.squadId + ' (Squad Name: ' + squad.name + ') on Team ' + this.teams[p.teamId].name,
      time
    );
    return squad;
  }

  // chat(player, channel, msg, time?) — sends a §6.3 CHAT type-1 packet.
  chat(player, channel, msg) {
    const p = this.resolvePlayer(player);
    if (!p) return;
    const chan = { all: 'ChatAll', team: 'ChatTeam', squad: 'ChatSquad', admin: 'ChatAdmin' }[channel] || channel;
    this.sendChatPacket('[' + chan + '] [Online IDs:' + this._idsBlob(p) + '] ' + p.name + ' : ' + msg);
  }

  // damage(attacker, victim, weapon, damage?, time?) — §6.2 PLAYER_DAMAGED line.
  damage(attacker, victim, weapon, dmg, time) {
    const a = this.resolvePlayer(attacker);
    const v = this.resolvePlayer(victim);
    if (!a || !v) return;
    this.writeLog(
      'LogSquad: Player:' + v.name + ' ActualDamage=' + fmtDamage(dmg != null ? dmg : 38.25) +
      ' from ' + a.name + ' (Online IDs: ' + this._idsBlob(a) + ' | Player Controller ID: ' +
      a.controller + ')caused by ' + stripC(weapon) + '_C',
      time
    );
  }

  _woundOrDie(kind, attacker, victim, weapon, dmg, time) {
    const a = this.resolvePlayer(attacker);
    const v = this.resolvePlayer(victim);
    if (!a || !v) return;
    this.writeLog(
      'LogSquadTrace: [DedicatedServer]ASQSoldier::' + kind + '(): Player:' + v.name +
      ' KillingDamage=' + fmtDamage(dmg != null ? dmg : 38.25) + ' from ' + a.controller +
      ' (Online IDs: ' + this._idsBlob(a) + ' | Controller ID: ' + a.controller +
      ') caused by ' + stripC(weapon) + '_C',
      time
    );
  }

  wound(attacker, victim, weapon, dmg, time) {
    this._woundOrDie('Wound', attacker, victim, weapon, dmg, time);
  }

  die(attacker, victim, weapon, dmg, time) {
    this._woundOrDie('Die', attacker, victim, weapon, dmg, time);
  }

  revive(reviver, revived, time) {
    const a = this.resolvePlayer(reviver);
    const b = this.resolvePlayer(revived);
    if (!a || !b) return;
    this.writeLog(
      'LogSquad: ' + a.name + ' (Online IDs: ' + this._idsBlob(a) + ') has revived ' +
      b.name + ' (Online IDs: ' + this._idsBlob(b) + ').',
      time
    );
  }

  // deployableDamage(player, className, damage, weapon, {damageType?, healthRemaining?, time?}?)
  deployableDamage(player, className, damage, weapon, opts) {
    const p = this.resolvePlayer(player);
    if (!p) return;
    const o = opts || {};
    const dep = stripC(className);
    const wep = stripC(weapon);
    const dtype = stripC(o.damageType || wep.replace(/_Explosive$/, '') + '_DamageType');
    const health = o.healthRemaining != null ? o.healthRemaining : Math.max(0, 2000 - damage);
    this.writeLog(
      'LogSquadTrace: [DedicatedServer]ASQDeployable::TakeDamage(): ' + dep + '_C_' + (++this._inst) +
      ': ' + fmtDamage(damage) + ' damage attempt by causer ' + wep + '_C_' + (++this._inst) +
      ' instigator ' + p.name + ' with damage type ' + dtype + '_C health remaining ' + fmtDamage(health),
      o.time
    );
  }

  // newGame(layer, level?, time?) — rotates the map; writes NEW_GAME + match-state lines.
  newGame(layer, level, time) {
    const t = time != null ? time : Date.now();
    const info = this._layerInfo(layer);
    if (level) info.level = level;
    this.current = info;
    const i = this.layers.indexOf(info.layerClass);
    const nextClass = this.layers[(i >= 0 ? i + 1 : 0) % this.layers.length];
    this.next = this._layerInfo(nextClass);
    this.squads.clear();
    for (const p of this.players.values()) {
      p.squadId = null;
      p.isLeader = false;
    }
    this.matchStartedAt = t;
    this.writeLog(
      'LogWorld: Bringing World /Game/Maps/' + info.level + '/Gameplay_Layers/' +
      info.layerClass + '.' + info.layerClass + ' up for play',
      t
    );
    this.writeLog('LogGameState: Match State Changed from EnteringMap to WaitingToStart', t);
    this.writeLog('LogGameState: Match State Changed from WaitingToStart to InProgress', t + 1500);
    return info;
  }

  // roundEnd(winnerTeam, tickets, time?) — §6.2 ROUND_ENDED (won + lost) lines.
  roundEnd(winnerTeam, tickets, time) {
    const t = time != null ? time : Date.now();
    const w = winnerTeam === 2 ? 2 : 1;
    const l = w === 1 ? 2 : 1;
    const c = this.current;
    const line = (teamId, verb, tix) =>
      'LogSquadGameEvents: Display: Team ' + teamId + ', ' + this.teams[teamId].name +
      ' ( ' + this.teams[teamId].token + ' ) has ' + verb + ' the match with ' + tix +
      ' Tickets on layer ' + c.layer + ' (level ' + c.level + ')!';
    this.writeLog(line(w, 'won', tickets), t);
    this.writeLog(line(l, 'lost', tickets), t);
    this.writeLog('LogGameState: Match State Changed from InProgress to WaitingPostMatch', t);
  }

  tick(rate, time) {
    this.tickRate = Number(rate);
    this.writeLog('LogSquad: USQGameState: Server Tick Rate: ' + this.tickRate.toFixed(2), time);
  }

  setTeams(team1Token, team2Token) {
    const f1 = FACTIONS[team1Token] || { setup: team1Token + '_S_CombinedArms', name: team1Token };
    const f2 = FACTIONS[team2Token] || { setup: team2Token + '_S_CombinedArms', name: team2Token };
    this.teams = {
      1: { token: team1Token, setup: f1.setup, name: f1.name },
      2: { token: team2Token, setup: f2.setup, name: f2.name },
    };
  }

  // ------------------------------------------------------------- RCON command

  _handleCommand(raw) {
    const sp = raw.indexOf(' ');
    const cmd = (sp < 0 ? raw : raw.slice(0, sp)).trim();
    const rest = sp < 0 ? '' : raw.slice(sp + 1).trim();
    switch (cmd.toLowerCase()) {
      case 'listplayers': return this._renderListPlayers();
      case 'listsquads': return this._renderListSquads();
      case 'showserverinfo': return this._renderServerInfo();
      case 'listlayers': return 'List of available layers :\n' + this.layers.join('\n');
      case 'showcurrentmap':
        return 'Current level is ' + this.current.level + ', layer is ' + this.current.layer;
      case 'shownextmap':
        return this.next
          ? 'Next level is ' + this.next.level + ', layer is ' + this.next.layer
          : 'Next level is , layer is To be voted';
      case 'listcommands': return this._renderListCommands();
      case 'adminbroadcast': return this._cmdBroadcast(rest);
      case 'adminchangelayer': return this._cmdChangeLayer(rest, true);
      case 'adminsetnextlayer': return this._cmdChangeLayer(rest, false);
      case 'adminrestartmatch':
        this.newGame(this.current.layerClass, this.current.level);
        return 'Game restarted';
      case 'adminendmatch':
        this.roundEnd(1, 150);
        return 'Match ended';
      case 'adminslomo': return 'Set clock speed to ' + (rest || '1.0');
      case 'adminkick': return this._cmdKick(rest, false);
      case 'adminkickbyid': return this._cmdKick(rest, true);
      case 'adminban': return this._cmdBan(rest);
      case 'adminwarn': return this._cmdWarn(rest, false);
      case 'adminwarnbyid': return this._cmdWarn(rest, true);
      case 'adminforceteamchange': return this._cmdForceTeam(rest, false);
      case 'adminforceteamchangebyid': return this._cmdForceTeam(rest, true);
      case 'adminremoveplayerfromsquad': return this._cmdRemoveFromSquad(rest, false);
      case 'adminremoveplayerfromsquadbyid': return this._cmdRemoveFromSquad(rest, true);
      case 'admindisbandsquad': return this._cmdDisbandSquad(rest);
      case 'admindemotecommander': return this._cmdDemoteCommander(rest);
      default:
        return 'Unknown command: ' + raw;
    }
  }

  _splitSelector(rest) {
    if (rest.startsWith('"')) {
      const end = rest.indexOf('"', 1);
      if (end > 0) return { selector: rest.slice(1, end), rest: rest.slice(end + 1).trim() };
    }
    const sp = rest.indexOf(' ');
    if (sp < 0) return { selector: rest, rest: '' };
    return { selector: rest.slice(0, sp), rest: rest.slice(sp + 1).trim() };
  }

  _renderListPlayers() {
    const out = ['----- Active Players -----'];
    for (const p of this.players.values()) {
      out.push(
        'ID: ' + p.playerId + ' | Online IDs: ' + this._idsBlob(p) + ' | Name: ' + p.name +
        ' | Team ID: ' + p.teamId + ' | Squad ID: ' + (p.squadId == null ? 'N/A' : p.squadId) +
        ' | Is Leader: ' + (p.isLeader ? 'True' : 'False') + ' | Role: ' + p.role
      );
    }
    out.push('----- Recently Disconnected Players [Max of 15] -----');
    const now = Date.now();
    for (const d of this.disconnected) {
      const sec = Math.max(0, Math.floor((now - d.at) / 1000));
      const mm = String(Math.floor(sec / 60)).padStart(2, '0');
      const ss = String(sec % 60).padStart(2, '0');
      out.push(
        'ID: ' + d.player.playerId + ' | Online IDs: ' + this._idsBlob(d.player) +
        ' | Since Disconnect: ' + mm + 'm.' + ss + 's | Name: ' + d.player.name
      );
    }
    return out.join('\n');
  }

  _renderListSquads() {
    const out = ['----- Active Squads -----'];
    for (const teamId of [1, 2]) {
      out.push('Team ID: ' + teamId + ' (' + this.teams[teamId].name + ')');
      for (const sq of this.squads.values()) {
        if (sq.teamId !== teamId) continue;
        let size = 0;
        for (const p of this.players.values()) if (p.teamId === teamId && p.squadId === sq.squadId) size++;
        out.push(
          'ID: ' + sq.squadId + ' | Name: ' + sq.name + ' | Size: ' + size +
          ' | Locked: ' + (sq.locked ? 'True' : 'False') + ' | Creator Name: ' + sq.creatorName +
          ' | Creator Online IDs: EOS: ' + sq.creatorEos + ' steam: ' + sq.creatorSteam
        );
      }
    }
    return out.join('\n');
  }

  _renderServerInfo() {
    return JSON.stringify({
      ServerName_s: this.serverName,
      MaxPlayers: this.maxPlayers,
      PlayerCount_I: String(this.players.size),
      PublicQueue_I: '0',
      ReservedQueue_I: '0',
      MapName_s: this.current.level,
      GameMode_s: this.current.mode,
      GameVersion_s: 'v8.2.1.369997.775',
      LICENSEDSERVER_b: true,
      TeamOne_s: this.teams[1].setup,
      TeamTwo_s: this.teams[2].setup,
      NextLayer_s: this.next ? this.next.layer : 'To be voted',
      'MATCHTIMEOUT_d': 120,
      'PLAYTIME_I': String(Math.max(0, Math.floor((Date.now() - this.matchStartedAt) / 1000))),
    });
  }

  _renderListCommands() {
    const cmds = [
      ['ListPlayers', 'List player ids with associated player name and SteamId'],
      ['ListSquads', 'List currently active squads by their team and squad id'],
      ['ShowServerInfo', 'Show server information in JSON format'],
      ['ShowCurrentMap', 'Ask the server what the current map is'],
      ['ShowNextMap', 'Ask the server what the next map is'],
      ['ListLayers', 'List the layers available on the server'],
      ['ListCommands', 'Prints out the information for all commands in the game'],
      ['AdminBroadcast', 'Send system message to all players on the server'],
      ['AdminChangeLayer', 'Change the layer and travel to it immediately'],
      ['AdminSetNextLayer', 'Set the next layer to travel to after this match'],
      ['AdminRestartMatch', 'Tell the server to restart the match'],
      ['AdminEndMatch', 'Tell the server to immediately end the match'],
      ['AdminSlomo', 'Set the clock speed on the server'],
      ['AdminKick', '<NameOrSteamId> <KickReason> Kicks a player from the server'],
      ['AdminKickById', '<PlayerId> <KickReason> Kicks a player with Id from the server'],
      ['AdminBan', '<NameOrSteamId> <BanLength> <BanReason> Bans a player from the server'],
      ['AdminWarn', '<NameOrSteamId> <WarnReason> Warns a player from the server'],
      ['AdminWarnById', '<PlayerId> <WarnReason> Warns a player with Id from the server'],
      ['AdminForceTeamChange', '<NameOrSteamId> Changes a player\'s team'],
      ['AdminForceTeamChangeById', '<PlayerId> Changes a player\'s team by Id'],
      ['AdminRemovePlayerFromSquad', '<PlayerName> Remove a player from their squad'],
      ['AdminRemovePlayerFromSquadById', '<PlayerId> Remove a player from their squad by Id'],
      ['AdminDisbandSquad', '<TeamId> <SquadId> Disbands the specified squad'],
      ['AdminDemoteCommander', '<NameOrSteamId> Demote a commander to a regular soldier'],
    ];
    return cmds.map((c) => c[0] + ' : ' + c[1]).join('\n');
  }

  _cmdBroadcast(msg) {
    this.sendChatPacket('[Broadcast] ' + msg);
    this.writeLog('LogSquad: ADMIN COMMAND: Message broadcasted <' + msg + '> from RCON');
    return 'Message broadcasted';
  }

  _cmdChangeLayer(arg, now) {
    const want = String(arg).trim().replace(/ /g, '_');
    const hit = this.layers.find((l) => l.toLowerCase() === want.toLowerCase());
    if (!hit) return 'Layer name invalid, check ListLayers for the list of valid layers';
    if (now) {
      this.newGame(hit);
      return 'Changed layer to ' + hit;
    }
    this.next = this._layerInfo(hit);
    return 'Set next layer to ' + hit;
  }

  _cmdKick(rest, byId) {
    const { selector, rest: reason } = this._splitSelector(rest);
    const p = this.resolvePlayer(byId ? parseInt(selector, 10) : selector);
    if (!p || !this.players.has(p.eosId)) return 'Player not found: ' + selector;
    this.removePlayer(p);
    const msg = 'Kicked player ' + p.playerId + '. [Online IDs= ' + this._idsBlob(p) + '] ' + p.name;
    this.sendChatPacket(msg);
    this.emit('kick', { player: p, reason });
    return msg;
  }

  _cmdBan(rest) {
    const s1 = this._splitSelector(rest);
    const s2 = this._splitSelector(s1.rest);
    const interval = s2.selector || '0';
    const reason = s2.rest;
    const p = this.resolvePlayer(s1.selector);
    if (!p || !this.players.has(p.eosId)) return 'Player not found: ' + s1.selector;
    this.bans.push({
      eosId: p.eosId, steamId: p.steamId, name: p.name, interval, reason, at: Date.now(),
    });
    this.removePlayer(p);
    const msg = 'Banned player ' + p.playerId + '. [Online IDs= ' + this._idsBlob(p) + '] ' +
      p.name + ' for interval ' + interval;
    this.sendChatPacket(msg);
    this.emit('ban', { player: p, interval, reason });
    return msg;
  }

  _cmdWarn(rest, byId) {
    const { selector, rest: message } = this._splitSelector(rest);
    const p = this.resolvePlayer(byId ? parseInt(selector, 10) : selector);
    if (!p || !this.players.has(p.eosId)) return 'Player not found: ' + selector;
    const msg = 'Remote admin has warned player ' + p.name + '. Message was "' + message + '"';
    this.sendChatPacket(msg);
    this.emit('warn', { player: p, message });
    return msg;
  }

  _cmdForceTeam(rest, byId) {
    const { selector } = this._splitSelector(rest);
    const p = this.resolvePlayer(byId ? parseInt(selector, 10) : selector);
    if (!p || !this.players.has(p.eosId)) return 'Player not found: ' + selector;
    p.teamId = p.teamId === 1 ? 2 : 1;
    p.squadId = null;
    p.isLeader = false;
    p.role = this.teams[p.teamId].token + '_Rifleman_01';
    return 'Forced team change for player ' + p.playerId + '. [Online IDs= ' +
      this._idsBlob(p) + '] ' + p.name;
  }

  _cmdRemoveFromSquad(rest, byId) {
    const { selector } = this._splitSelector(rest);
    const p = this.resolvePlayer(byId ? parseInt(selector, 10) : selector);
    if (!p || !this.players.has(p.eosId)) return 'Player not found: ' + selector;
    if (p.squadId == null) return 'Player ' + p.name + ' is not in a squad';
    p.squadId = null;
    p.isLeader = false;
    return 'Player ' + p.name + ' has been removed from their squad';
  }

  _cmdDisbandSquad(rest) {
    const m = /^(\d+)\s+(\d+)/.exec(rest);
    if (!m) return 'Invalid arguments: AdminDisbandSquad <TeamId> <SquadId>';
    const teamId = parseInt(m[1], 10);
    const squadId = parseInt(m[2], 10);
    const key = teamId + ':' + squadId;
    const sq = this.squads.get(key);
    if (!sq) return 'Squad not found: team ' + teamId + ' squad ' + squadId;
    this.squads.delete(key);
    for (const p of this.players.values()) {
      if (p.teamId === teamId && p.squadId === squadId) {
        p.squadId = null;
        p.isLeader = false;
      }
    }
    return 'Remote admin disbanded squad ' + squadId + ' on team ' + teamId + ', named "' + sq.name + '"';
  }

  _cmdDemoteCommander(rest) {
    const { selector } = this._splitSelector(rest);
    const p = this.resolvePlayer(selector);
    if (!p || !this.players.has(p.eosId)) return 'Player not found: ' + selector;
    return 'Demoted player ' + p.name + ' from the commander position';
  }
}

module.exports = { MockSquad, NAME_POOL, DEFAULT_LAYERS, FACTIONS };
