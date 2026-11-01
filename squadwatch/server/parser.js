'use strict';
// server/parser.js — pure parsing functions (SPEC §6, amended by §19.1.9/19.1.11/19.1.12).
// Log lines, RCON type-1 chat packet bodies and RCON list-command responses.
// No I/O, no state: every function takes strings and returns plain objects / null.

// ---------------------------------------------------------------------------
// Online-id scanner (§6.1) — tolerant to key order, missing keys, `IDs=` vs
// `IDs:` framing and `Online Ids:` casing. Missing ids come back as null.
// ---------------------------------------------------------------------------
function parseOnlineIds(blob) {
  const out = { eosId: null, steamId: null };
  if (blob == null) return out;
  const re = /\b(EOS|steam):\s*([0-9a-f]{32}|\d{17})/gi;
  let m;
  const s = String(blob);
  while ((m = re.exec(s)) !== null) {
    const key = m[1].toLowerCase();
    if (key === 'eos' && out.eosId === null) out.eosId = m[2];
    else if (key === 'steam' && out.steamId === null) out.steamId = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Timestamp (§6.1): "YYYY.MM.DD-HH.mm.ss:ms" treated as UTC, then corrected by
// tzOffsetMin (minutes the server clock runs AHEAD of UTC — i.e. epoch =
// stampAsUtc - tzOffsetMin*60000). Returns epoch ms, or null when malformed.
// ---------------------------------------------------------------------------
const STAMP_RE = /^(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{1,4})$/;

function parseLogTime(stamp, tzOffsetMin = 0) {
  const m = STAMP_RE.exec(String(stamp == null ? '' : stamp).trim());
  if (!m) return null;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
  if (!Number.isFinite(utc)) return null;
  const off = Number(tzOffsetMin);
  const t = utc - (Number.isFinite(off) ? off : 0) * 60000;
  // An absurd offset (junk config) must not leak a non-finite epoch into events.
  return Number.isFinite(t) ? t : null;
}

function toIntOrNull(s) {
  const n = parseInt(String(s == null ? '' : s).trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Log line grammar (§6.1). Each regex runs against `rest` (text after the
// `[stamp][frame]` prefix). First match wins; unknown lines → null.
// Robustness: greedy `(.+)` before a literal ` (Online IDs:` anchor splits on
// the LAST occurrence, so names containing `(`,`)`,`|`,`:` survive.
// ---------------------------------------------------------------------------
function woundFields(m) {
  return {
    victimName: m[1],
    damage: parseFloat(m[2]),
    attackerController0: m[3],
    attackerIds: m[4],
    attackerController: m[5],
    weapon: m[6],
  };
}

const LOG_EVENTS = [
  ['PLAYER_CONNECTED',
    /^LogSquad: PostLogin: NewPlayer: BP_PlayerController_C .*PersistentLevel\.([^\s]+) \(IP: ([\d.]+) \| Online IDs:([^)]+)\)/,
    (m) => {
      const ids = parseOnlineIds(m[3]);
      return { controller: m[1], ip: m[2], eosId: ids.eosId, steamId: ids.steamId };
    }],
  ['JOIN_SUCCEEDED',
    /^LogNet: Join succeeded: (.+)$/,
    (m) => ({ suffixName: m[1] })],
  ['PLAYER_DISCONNECTED',
    /^LogNet: UNetConnection::Close:.*?UniqueId: RedpointEOS:([0-9a-f]+)/,
    (m) => ({ eosId: m[1] })],
  ['PLAYER_DAMAGED',
    /^LogSquad: Player:(.+) ActualDamage=(\d[\d.]*) from (.+) \(Online IDs:([^)|]+)\| Player Controller ID: ([^ )]+)\)caused by ([A-Za-z0-9_\-]+)_C/,
    (m) => ({
      victimName: m[1], damage: parseFloat(m[2]), attackerName: m[3],
      attackerIds: m[4], attackerController: m[5], weapon: m[6],
    })],
  ['PLAYER_WOUNDED',
    /^LogSquadTrace: \[DedicatedServer\](?:ASQSoldier::)?Wound\(\): Player:(.+) KillingDamage=-?(\d[\d.]*) from ([^(]+) \(Online IDs:([^)|]+)\| (?:Player )?Controller ID: ([\w\d]+)\) caused by ([A-Za-z0-9_\-]+)_C/,
    woundFields],
  ['PLAYER_DIED',
    /^LogSquadTrace: \[DedicatedServer\](?:ASQSoldier::)?Die\(\): Player:(.+) KillingDamage=-?(\d[\d.]*) from ([^(]+) \(Online IDs:([^)|]+)\| (?:Player )?Controller ID: ([\w\d]+)\) caused by ([A-Za-z0-9_\-]+)_C/,
    woundFields],
  ['PLAYER_REVIVED',
    /^LogSquad: (.+) \(Online IDs:([^)]+)\) has revived (.+) \(Online IDs:([^)]+)\)\./,
    (m) => ({ reviverName: m[1], reviverIds: m[2], revivedName: m[3], revivedIds: m[4] })],
  ['DEPLOYABLE_DAMAGED',
    /^LogSquadTrace: \[DedicatedServer\](?:ASQDeployable::)?TakeDamage\(\): ([A-Za-z0-9_]+)_C_[0-9]+: ([\d.]+) damage attempt by causer ([A-Za-z0-9_]+)_C_[0-9]+ instigator (.+) with damage type ([A-Za-z0-9_\-]+)_C health remaining ([\d.]+)/,
    (m) => ({
      deployable: m[1], damage: parseFloat(m[2]), weapon: m[3],
      playerName: m[4], damageType: m[5], healthRemaining: parseFloat(m[6]),
    })],
  ['NEW_GAME',
    /^LogWorld: Bringing World \/([A-Za-z0-9_]+)\/(.+?) up for play/,
    (m) => {
      const pathParts = m[2];
      const segs = pathParts.split('/');
      // §19.1.12: level = the path segment immediately after `Maps/`.
      const mi = segs.indexOf('Maps');
      let level = null;
      if (mi >= 0 && mi + 1 < segs.length) level = segs[mi + 1].split('.')[0] || null;
      const lastDot = pathParts.lastIndexOf('.');
      const layerClass = lastDot >= 0
        ? pathParts.slice(lastDot + 1)
        : (segs[segs.length - 1] || null);
      return { dlc: m[1], pathParts, level, layerClass };
    }],
  ['ROUND_ENDED',
    /^LogSquadGameEvents: Display: Team ([12]), (.+?) \( ?(.*?) ?\) has (won|lost) the match with (\d+) Tickets on layer (.+?) \(level (.+?)\)!/,
    (m) => ({
      team: parseInt(m[1], 10), factionName: m[2], factionTag: m[3],
      result: m[4], tickets: parseInt(m[5], 10), layer: m[6], level: m[7],
    })],
  ['MATCH_STATE',
    /^LogGameState: Match State Changed from ([A-Za-z]+) to ([A-Za-z]+)/,
    (m) => ({ from: m[1], to: m[2] })],
  ['TICK_RATE',
    /^LogSquad: USQGameState: Server Tick Rate: ([\d.]+)/,
    (m) => ({ tickRate: parseFloat(m[1]) })],
  ['ADMIN_BROADCAST_LOG',
    /^LogSquad: ADMIN COMMAND: Message broadcasted <(.+)> from (.+)/,
    (m) => ({ message: m[1], from: m[2] })],
  ['SQUAD_CREATED',
    /^LogSquad: (.+) \(Online IDs:([^)]+)\) has created Squad (\d+) \(Squad Name: (.+)\) on (.+)$/,
    (m) => ({
      playerName: m[1], ids: m[2], squadId: parseInt(m[3], 10),
      squadName: m[4], teamName: m[5],
    })],
];

const LINE_HEAD_RE = /^\[([0-9.:\-]+)\]\[\s*\d+\](.*)$/;

function parseLogLine(line, tzOffsetMin = 0) {
  if (typeof line !== 'string' || line.length === 0) return null;
  const head = LINE_HEAD_RE.exec(line);
  if (!head) return null;
  const time = parseLogTime(head[1], tzOffsetMin);
  if (time === null) return null;
  const rest = head[2];
  for (let i = 0; i < LOG_EVENTS.length; i++) {
    const m = LOG_EVENTS[i][1].exec(rest);
    if (m) return Object.assign({ event: LOG_EVENTS[i][0], time, raw: line }, LOG_EVENTS[i][2](m));
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chat packets (§6.3) — RCON type-1 bodies. Note the `Online IDs=` equals-sign
// quirk in KICKED/BANNED and the `Online Ids:` casing in ADMIN_CAM; ids always
// go through the tolerant scanner. §19.1.11: SQUAD_CREATED packet is the log
// variant WITHOUT the `LogSquad: ` prefix.
// ---------------------------------------------------------------------------
const CHAT_CHANNEL = { ChatAll: 'all', ChatTeam: 'team', ChatSquad: 'squad', ChatAdmin: 'admin' };

function parseChatPacket(body) {
  if (body == null) return null;
  // Strip trailing frame garbage only; leading/inner whitespace is meaningful.
  const s = String(body).replace(/[\r\n\u0000]+$/, '');
  if (!s) return null;

  let m = /^\[(ChatAll|ChatTeam|ChatSquad|ChatAdmin)\] \[Online IDs:([^\]]*)\] ([\s\S]+)$/.exec(s);
  if (m) {
    const ids = parseOnlineIds(m[2]);
    const rest = m[3];
    const i = rest.indexOf(' : '); // split name/message on the FIRST " : " after the id bracket
    if (i < 0) return null;
    return {
      kind: 'CHAT', channel: CHAT_CHANNEL[m[1]], eosId: ids.eosId, steamId: ids.steamId,
      name: rest.slice(0, i), message: rest.slice(i + 3),
    };
  }

  m = /^\[Online Ids:([^\]]*)\] ([\s\S]+) has (un)?possessed admin camera\.?$/i.exec(s);
  if (m) {
    const ids = parseOnlineIds(m[1]);
    return { kind: 'ADMIN_CAM', eosId: ids.eosId, steamId: ids.steamId, name: m[2], possessed: !m[3] };
  }

  m = /^Remote admin has warned player ([\s\S]+)\. Message was "([\s\S]*)"$/.exec(s);
  if (m) return { kind: 'WARNED', name: m[1], message: m[2] };

  m = /^Kicked player (\d+)\. \[Online IDs=([^\]]*)\] ([\s\S]+)$/.exec(s);
  if (m) {
    const ids = parseOnlineIds(m[2]);
    return { kind: 'KICKED', playerId: parseInt(m[1], 10), eosId: ids.eosId, steamId: ids.steamId, name: m[3] };
  }

  m = /^Banned player (\d+)\. \[Online IDs=([^\]]*)\] ([\s\S]+) for interval ([\s\S]+)$/.exec(s);
  if (m) {
    const ids = parseOnlineIds(m[2]);
    return {
      kind: 'BANNED', playerId: parseInt(m[1], 10), eosId: ids.eosId, steamId: ids.steamId,
      name: m[3], interval: m[4],
    };
  }

  m = /^([\s\S]+) \(Online IDs:([^)]+)\) has created Squad (\d+) \(Squad Name: ([\s\S]+)\) on ([\s\S]+)$/.exec(s);
  if (m) {
    return {
      kind: 'SQUAD_CREATED', playerName: m[1], ids: m[2], squadId: parseInt(m[3], 10),
      squadName: m[4], teamName: m[5],
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// ListPlayers (§6.4). Active rows are split on known field markers from the
// RIGHT so names containing " | " survive; Name is terminal (greedy to EOL)
// on disconnected rows. `Squad ID: N/A` → null.
// ---------------------------------------------------------------------------
function parseListPlayers(text) {
  const online = [];
  const disconnected = [];
  let section = 'active';
  for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^-+\s*Active Players\s*-+$/i.test(line)) { section = 'active'; continue; }
    if (/^-+\s*Recently Disconnected Players/i.test(line)) { section = 'disconnected'; continue; }
    const head = /^ID: (\d+) \| Online IDs: /.exec(line);
    if (!head) continue;
    const playerId = parseInt(head[1], 10);
    const rest = line.slice(head[0].length);

    if (section === 'disconnected') {
      const m = /^(.*?) \| Since Disconnect: (\S+) \| Name: (.*)$/.exec(rest);
      if (!m) continue;
      const ids = parseOnlineIds(m[1]);
      disconnected.push({
        playerId, eosId: ids.eosId, steamId: ids.steamId, name: m[3], sinceDisconnect: m[2],
      });
      continue;
    }

    const iName = rest.indexOf(' | Name: ');
    if (iName < 0) continue;
    const ids = parseOnlineIds(rest.slice(0, iName));
    let tail = rest.slice(iName + ' | Name: '.length);

    const iRole = tail.lastIndexOf(' | Role: ');
    if (iRole < 0) continue;
    const role = tail.slice(iRole + ' | Role: '.length);
    tail = tail.slice(0, iRole);

    const iLead = tail.lastIndexOf(' | Is Leader: ');
    if (iLead < 0) continue;
    const isLeader = /^true$/i.test(tail.slice(iLead + ' | Is Leader: '.length).trim());
    tail = tail.slice(0, iLead);

    const iSquad = tail.lastIndexOf(' | Squad ID: ');
    if (iSquad < 0) continue;
    const squadRaw = tail.slice(iSquad + ' | Squad ID: '.length).trim();
    const squadId = /^n\/a$/i.test(squadRaw) ? null : toIntOrNull(squadRaw);
    tail = tail.slice(0, iSquad);

    const iTeam = tail.lastIndexOf(' | Team ID: ');
    if (iTeam < 0) continue;
    const teamId = toIntOrNull(tail.slice(iTeam + ' | Team ID: '.length));
    const name = tail.slice(0, iTeam);

    online.push({ playerId, eosId: ids.eosId, steamId: ids.steamId, name, teamId, squadId, isLeader, role });
  }
  return { online, disconnected };
}

// ---------------------------------------------------------------------------
// ListSquads (§6.4). `Team ID: N (Team Name)` headers carry team context for
// the squad rows beneath; squad rows are split on markers from the RIGHT so
// squad and creator names containing " | " survive.
// ---------------------------------------------------------------------------
function parseListSquads(text) {
  const out = [];
  let teamId = null;
  let teamName = null;
  for (const rawLine of String(text == null ? '' : text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const th = /^Team ID: (\d+) \((.*)\)$/.exec(line);
    if (th) { teamId = parseInt(th[1], 10); teamName = th[2]; continue; }
    const sh = /^ID: (\d+) \| Name: /.exec(line);
    if (!sh) continue;
    let rest = line.slice(sh[0].length);

    const iIds = rest.lastIndexOf(' | Creator Online IDs: ');
    if (iIds < 0) continue;
    const ids = parseOnlineIds(rest.slice(iIds + ' | Creator Online IDs: '.length));
    rest = rest.slice(0, iIds);

    const iCreator = rest.lastIndexOf(' | Creator Name: ');
    if (iCreator < 0) continue;
    const creatorName = rest.slice(iCreator + ' | Creator Name: '.length);
    rest = rest.slice(0, iCreator);

    const iLocked = rest.lastIndexOf(' | Locked: ');
    if (iLocked < 0) continue;
    const locked = /^true$/i.test(rest.slice(iLocked + ' | Locked: '.length).trim());
    rest = rest.slice(0, iLocked);

    const iSize = rest.lastIndexOf(' | Size: ');
    if (iSize < 0) continue;
    const size = toIntOrNull(rest.slice(iSize + ' | Size: '.length));
    const name = rest.slice(0, iSize);

    out.push({
      teamId, teamName, squadId: parseInt(sh[1], 10), name, size, locked,
      creatorName, creatorEos: ids.eosId, creatorSteam: ids.steamId,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// ShowServerInfo (§6.4 + §19.1.9): JSON → camelCase object, tolerant of
// missing keys (null), numbers coerced.
// ---------------------------------------------------------------------------
function parseServerInfo(jsonText) {
  let o;
  try {
    o = JSON.parse(jsonText);
  } catch (_e) {
    return null;
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return null;
  const str = (k) => (o[k] === undefined || o[k] === null ? null : String(o[k]));
  const num = (k) => {
    if (o[k] === undefined || o[k] === null || o[k] === '') return null;
    const n = Number(o[k]);
    return Number.isFinite(n) ? n : null;
  };
  return {
    serverName: str('ServerName_s'),
    maxPlayers: num('MaxPlayers'),
    playerCount: num('PlayerCount_I'),
    publicQueue: num('PublicQueue_I'),
    reservedQueue: num('ReservedQueue_I'),
    mapName: str('MapName_s'),
    gameMode: str('GameMode_s'),
    gameVersion: str('GameVersion_s'),
    teamOne: str('TeamOne_s'),
    teamTwo: str('TeamTwo_s'),
    nextLayer: str('NextLayer_s'),
    matchTimeout: num('MATCHTIMEOUT_d'),
    playTimeSec: num('PLAYTIME_I'),
  };
}

// ---------------------------------------------------------------------------
// ListLayers (§6.4): skip the header line, one layer per line, trim, drop
// empties; `(…)` mod suffixes are kept as-is.
// ---------------------------------------------------------------------------
function parseLayers(text) {
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  return lines.slice(1).map((l) => l.trim()).filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// ShowCurrentMap / ShowNextMap (§6.4). "To be voted" / empty → nulls.
// Tolerates a trailing ", factions …" suffix some game versions append.
// ---------------------------------------------------------------------------
function mapFieldValue(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || /^to be voted$/i.test(s)) return null;
  return s;
}

function parseCurrentMap(text) {
  // The space before each value is optional: when the value is empty the
  // trailing space is often trimmed away with it.
  const m = /^Current level is ?(.*?), layer is ?(.*?)(?:, factions .*)?$/.exec(String(text == null ? '' : text).trim());
  if (!m) return null;
  return { level: mapFieldValue(m[1]), layer: mapFieldValue(m[2]) };
}

function parseNextMap(text) {
  const m = /^Next level is ?(.*?), layer is ?(.*?)(?:, factions .*)?$/.exec(String(text == null ? '' : text).trim());
  if (!m) return null;
  return { level: mapFieldValue(m[1]), layer: mapFieldValue(m[2]) };
}

module.exports = {
  parseLogLine,
  parseChatPacket,
  parseListPlayers,
  parseListSquads,
  parseServerInfo,
  parseLayers,
  parseCurrentMap,
  parseNextMap,
  parseOnlineIds,
  parseLogTime,
};
