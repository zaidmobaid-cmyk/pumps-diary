# SquadWatch — Technical Specification (v1)

> **§19 (Binding amendments) overrides anything earlier in this document that
> conflicts with it. Read §19 before building any module.**

Self-hosted admin & stats panel for a single Squad dedicated server. A BattleMetrics
alternative the owner runs themselves: deeper Squad-specific stats (teamkills, damage,
radio/HAB damage with friendly-fire classification to catch griefers), full chat history,
match history with scoreboards, and a complete admin toolkit (warn/kick/ban, layer
control, broadcasts, squad management, raw RCON console) with audit logging.

## 0. Non-negotiable principles

- **Runtime**: Node.js >= 22.13 (uses built-in `node:sqlite`). CommonJS (`"type":"commonjs"`),
  `'use strict';` at top of every file. NO TypeScript, NO build step, NO bundler.
- **Dependencies**: ZERO npm dependencies for core operation (local log mode + RCON + web).
  `basic-ftp` and `ssh2-sftp-client` are OPTIONAL — lazy-`require`d only when `log.mode`
  is `"ftp"`/`"sftp"`; if missing, throw a friendly error naming the exact
  `npm install basic-ftp` / `npm install ssh2-sftp-client` command. `better-sqlite3` is an
  optional fallback if `node:sqlite` is unavailable (see §9 db.js).
- **Frontend**: vanilla HTML/CSS/JS served statically by the Node server. No frameworks.
  Single-page app with hash routing. Every user-originated string (player names, chat,
  reasons, notes) MUST go through `esc()` before touching `innerHTML` — player names
  regularly contain `<`, `>`, `"`, emoji, RTL text. Prefer `textContent` where possible.
- **Security**: every SQL statement uses bound parameters (`?`). Every RCON argument is
  sanitized (strip `\r\n\0`, length-cap 480 chars). Mutating API routes verify the
  `Origin`/`Referer` host matches the request Host (CSRF). Session cookies are
  `HttpOnly; SameSite=Lax`, `Secure` when behind HTTPS (see config `web.secureCookies`).
- **Honesty**: never fabricate stats. If a value is unknown (e.g. deployable team can't be
  classified), store/display "unknown", never guess silently.
- **Errors**: API errors are JSON `{"error": "message"}` with proper status codes.
  Server never crashes on a bad log line / RCON hiccup — log and continue. Use the
  shared logger `log.info/warn/error(tag, msg, extra?)` from `server/util.js`.

## 1. Repository layout (all paths relative to `squadwatch/`)

```
package.json                  # name squadwatch, type commonjs, scripts, optionalDeps noted in README only
config.example.json           # full example config (committed); config.json is gitignored
README.md                     # setup, GSP guide, security notes, feature tour  (written by integrator)
server/
  index.js                    # boot + wiring + CLI flags (written by integrator — do NOT write)
  util.js                     # logger, time helpers, esc helpers, misc (written by integrator — do NOT write)
  config.js                   # config load + validation + defaults
  rcon.js                     # Squad RCON client
  parser.js                   # log line + chat packet + RCON list-response parsers
  factions.js                 # deployable classification + faction/team matching
  db.js                       # sqlite open/migrate + prepared statement bag
  state.js                    # LiveState (players/squads/layer/match)
  ingest.js                   # event pipeline: DB writes, aggregates, flags, enforcement
  logsource.js                # local/ftp/sftp log tailing with offset persistence
  auth.js                     # users, sessions, roles, rate limit, audit
  api.js                      # HTTP server: REST + SSE + static
  admin.js                    # admin action -> RCON command builder/executor
  demo.js                     # demo-mode orchestrator (uses test/mock-squad.js)
  steam.js                    # optional Steam avatar/persona fetcher
  webhook.js                  # optional Discord webhook notifier
public/
  index.html
  style.css
  app.js                      # core: router, api client, SSE, components, dashboard/live views
  views.js                    # players/matches/chat/trolls views
  views-admin.js              # admin/console/bans/audit/users/settings views + login/setup
test/
  mock-squad.js               # fake Squad server: RCON listener + log writer (also used by demo)
  fixtures/sample.log         # real-shaped log lines (below, §6.2)
  parser.test.js  rcon.test.js  db.test.js  ingest.test.js  integration.test.js
tools/
  parse-check.js              # node tools/parse-check.js <SquadGame.log> -> coverage report
data/                         # runtime (gitignored): squadwatch.db, logsource.json
```

`node --test test/` must pass with no network access. Tests use `node:test` + `node:assert`.

## 2. Config (`config.json`, loaded by `server/config.js`)

```json
{
  "web": { "port": 8787, "host": "0.0.0.0", "publicUrl": "", "secureCookies": "auto" },
  "squad": { "rconHost": "127.0.0.1", "rconPort": 21114, "rconPassword": "CHANGEME" },
  "log": {
    "mode": "local",
    "path": "/home/squad/SquadGame/Saved/Logs/SquadGame.log",
    "pollMs": 1500,
    "backfill": false,
    "timezoneOffsetMinutes": 0,
    "ftp":  { "host": "", "port": 21, "user": "", "password": "", "path": "", "secure": false },
    "sftp": { "host": "", "port": 22, "user": "", "password": "", "privateKeyPath": "", "path": "" }
  },
  "dbPath": "data/squadwatch.db",
  "steamApiKey": "",
  "discordWebhook": "",
  "webhookEvents": { "flags": true, "bans": true, "kicks": true, "warns": false, "matchEnd": false },
  "flags": {
    "tkSpreeCount": 3, "tkSpreeWindowSec": 180,
    "massTkCount": 5,
    "newPlayerMinutes": 15,
    "chatWatchlist": []
  },
  "autoWarnTeamkiller": false,
  "autoWarnMessage": "Teamkill detected: {victim}. TKs are logged. Apologize in all-chat.",
  "retention": { "chatDays": 0, "popDays": 30 },
  "demo": false,
  "logUnparsed": false
}
```

Rules: `config.js` exports `loadConfig(path)` → deep-merged over defaults, with type
validation (throw listing every invalid field). `web.secureCookies`: `"auto"` = Secure flag
iff request came via `x-forwarded-proto: https` or TLS socket; `true`/`false` force.
`retention.chatDays` 0 = keep forever. CLI overrides (parsed in index.js): `--demo`,
`--port N`, `--config path`, `--create-admin <user> <pass> [role]`.

## 3. Shared event bus

`index.js` creates `bus = new EventEmitter()` (`setMaxListeners(100)`). All runtime events
flow: producers (rcon chat packets, logsource lines→parser, state pollers, ingest) emit on
bus; consumers (ingest, api SSE, webhook) listen. **Canonical bus events** (payloads §7):

`log-event` (parsed log line), `chat` , `player-connected`, `player-disconnected`,
`kill` (wound/die enriched), `revive`, `deployable` (enriched w/ classification),
`match-start`, `match-end`, `match-state`, `flag`, `admin-action`, `broadcast`,
`players-updated` (after ListPlayers poll), `serverinfo-updated`, `rcon-status`,
`log-status`, `tick-rate`, `pop-sample`.

## 4. RCON client — `server/rcon.js`

Source RCON over TCP with Squad quirks. Export `class SquadRcon extends EventEmitter`.

### 4.1 Packet format
`[int32LE size][int32LE id][int32LE type][body utf8][0x00][0x00]`, `size = 10 + bodyByteLen`.
Types: `SERVERDATA_AUTH = 3`, `SERVERDATA_EXECCOMMAND = 2`, `SERVERDATA_AUTH_RESPONSE = 2`
(server→client), `SERVERDATA_RESPONSE_VALUE = 0`, **`SERVERDATA_CHAT_VALUE = 1`**
(Squad-specific: unsolicited chat/event stream packets).

### 4.2 Behavior
- `constructor({host, port, password})`; `connect()` starts a persistent loop:
  connect → auth → ready; on socket error/close emit `'disconnected'`, retry with backoff
  1s,2s,4s,…max 30s, forever. Emit `'connected'` when authed. `status` getter:
  `{connected, authed, lastError, since}`.
- Auth: send type 3 id=1 with password. Success = any packet type 2 with id 1;
  **id === -1 means bad password** → emit `'error'` with clear message, stop retrying
  until `connect()` called again (bad creds won't fix themselves); set status.
- `async exec(command, timeoutMs=12000)` → resolves full response body string.
  Serialize: ONE command in flight (internal FIFO queue). Multi-packet responses:
  after sending the command (id = next odd int), immediately send an empty
  EXECCOMMAND with sentinel id = cmdId+1. Concatenate every type-0 body with cmdId;
  when a packet with sentinel id arrives, resolve. Timeout → reject + DROP the
  connection (resync) and reconnect.
- Buffering: accumulate `Buffer`; while `buf.len >= 4`: read size; if size < 10 or
  size > 65536 → protocol desync → destroy socket (reconnect). If `buf.len >= size+4`,
  slice packet, parse id/type, body = bytes 12..size+2 (strip 2 trailing nulls), utf8.
  Handle fragmentation & coalescing. (Empty follow-response packets of size 10 are normal.)
- Type-1 packets: emit `'chat-packet'` with raw body string (parser handles meaning).
- Keepalive: if no packet received for 45s, exec `PING` (harmless unknown cmd) —
  actually use `ShowCurrentMap`; on timeout the exec logic reconnects.
- All writes guarded: if not authed, `exec` rejects `new Error('RCON not connected')`.

### 4.3 Admin command catalog (used by admin.js; exact syntax)
```
ListPlayers | ListSquads | ShowServerInfo | ShowCurrentMap | ShowNextMap | ListLayers | ListCommands 1
AdminBroadcast <msg>
AdminChangeLayer <layer> | AdminSetNextLayer <layer>
AdminRestartMatch | AdminEndMatch | AdminSlomo <float>
AdminKick "<selector>" <reason>        | AdminKickById <playerId> <reason>
AdminBan "<selector>" <interval> <reason>     # interval: 0=perm, 1d, 3d, 1w, 1M …
AdminWarn "<selector>" <message>       | AdminWarnById <playerId> <message>
AdminForceTeamChange "<selector>"      | AdminForceTeamChangeById <playerId>
AdminRemovePlayerFromSquad "<name>"    | AdminRemovePlayerFromSquadById <playerId>
AdminDisbandSquad <teamId> <squadId>
AdminDemoteCommander "<selector>"
```
`selector` = steamId64 when known, else exact name. When the target is ONLINE and we have
the numeric in-game `playerId` from ListPlayers, prefer the `…ById` variant. Always record
the verbatim RCON response in the audit row; treat responses containing
`not found|invalid|error|unable` (case-insensitive) as `rconOk=false` but still record.

## 5. Log source — `server/logsource.js`

`createLogSource(cfg.log, {dataDir})` → EventEmitter with `start()`, `stop()`,
`status()` → `{mode, ok, lagBytes, lastReadAt, error}`. Emits `'line'` (string, no newline,
in file order) and `'status'`.

- **local**: poll `fs.stat` every `pollMs`. If `size > offset` → read `[offset,size)`
  (stream, utf8), split `\n`, keep trailing partial in a carry buffer. If `size < offset`
  → rotation/truncate → `offset = 0`, carry=''. Persist `{offset, size, path}` to
  `data/logsource.json` at most every 5s. On boot: if persisted path matches & file size
  >= persisted offset → resume; else if `backfill` → 0; else start at current END.
- **ftp**: lazy `require('basic-ftp')`. Keep a client connected; every `max(pollMs,4000)`:
  `size(path)`; if grown, `downloadTo(PassThrough, path, offset)` appending to carry;
  same rotation rule. Reconnect on error w/ backoff; `secure:true` → FTPS.
- **sftp**: lazy `require('ssh2-sftp-client')`; `stat` + `createReadStream({start:offset})`.
  Password or `privateKeyPath` auth.
- NEVER re-emit lines already processed (offset only advances after a full line is emitted).

## 6. Parser — `server/parser.js`

Pure functions, no I/O. Exports: `parseLogLine(line)`, `parseChatPacket(body)`,
`parseListPlayers(text)`, `parseListSquads(text)`, `parseServerInfo(jsonText)`,
`parseLayers(text)`, `parseCurrentMap(text)`, `parseNextMap(text)`, `parseOnlineIds(blob)`,
`parseLogTime(stamp, tzOffsetMin)`.

### 6.1 Log line grammar
Every line: `[YYYY.MM.DD-HH.mm.ss:ms][frame]Category: rest`. `parseLogTime` treats the
stamp as UTC then applies `timezoneOffsetMinutes` (server clocks vary); returns epoch ms.
`parseOnlineIds("EOS: 0002a10386d9114496bce8b6ded68587 steam: 76561198012345678")` →
`{eosId, steamId}` (either may be missing; keys appear as `EOS:`/`steam:`, order varies —
scan with `/\b(EOS|steam):\s*([0-9a-f]{32}|\d{17})/gi`).

`parseLogLine` returns `null` or `{event, time, raw, ...fields}`:

| event | regex on `rest` (after timestamp prefix) | fields |
|---|---|---|
| `PLAYER_CONNECTED` | `^LogSquad: PostLogin: NewPlayer: BP_PlayerController_C .*PersistentLevel\.([^\s]+) \(IP: ([\d.]+) \| Online IDs:([^)]+)\)` | `controller, ip, eosId, steamId` |
| `JOIN_SUCCEEDED` | `^LogNet: Join succeeded: (.+)$` | `suffixName` |
| `PLAYER_DISCONNECTED` | `^LogNet: UNetConnection::Close:.*?UniqueId: RedpointEOS:([0-9a-f]+)` | `eosId` |
| `PLAYER_DAMAGED` | `^LogSquad: Player:(.+) ActualDamage=([\d.]+) from (.+) \(Online IDs:([^)|]+)\| Player Controller ID: ([^ )]+)\)caused by ([A-Za-z0-9_\-]+)_C` | `victimName, damage, attackerName, attackerIds, attackerController, weapon` |
| `PLAYER_WOUNDED` | `^LogSquadTrace: \[DedicatedServer\](?:ASQSoldier::)?Wound\(\): Player:(.+) KillingDamage=-?([\d.]+) from ([^(]+) \(Online IDs:([^)|]+)\| (?:Player )?Controller ID: ([\w\d]+)\) caused by ([A-Za-z0-9_\-]+)_C` | `victimName, damage, attackerController0, attackerIds, attackerController, weapon` |
| `PLAYER_DIED` | same but `Die\(\):` | same |
| `PLAYER_REVIVED` | `^LogSquad: (.+) \(Online IDs:([^)]+)\) has revived (.+) \(Online IDs:([^)]+)\)\.` | `reviverName, reviverIds, revivedName, revivedIds` |
| `DEPLOYABLE_DAMAGED` | `^LogSquadTrace: \[DedicatedServer\](?:ASQDeployable::)?TakeDamage\(\): ([A-Za-z0-9_]+)_C_[0-9]+: ([\d.]+) damage attempt by causer ([A-Za-z0-9_]+)_C_[0-9]+ instigator (.+) with damage type ([A-Za-z0-9_\-]+)_C health remaining ([\d.]+)` | `deployable, damage, weapon, playerName, damageType, healthRemaining` |
| `NEW_GAME` | `^LogWorld: Bringing World /([A-Za-z0-9_]+)/(.+?) up for play` | `dlc, pathParts` (derive `level` = last path segment before `.`, `layerClass` = after `.`) |
| `ROUND_ENDED` | `^LogSquadGameEvents: Display: Team ([12]), (.+?) \( ?(.*?) ?\) has (won|lost) the match with (\d+) Tickets on layer (.+?) \(level (.+?)\)!` | `team, factionName, factionTag, result, tickets, layer, level` |
| `MATCH_STATE` | `^LogGameState: Match State Changed from ([A-Za-z]+) to ([A-Za-z]+)` | `from, to` |
| `TICK_RATE` | `^LogSquad: USQGameState: Server Tick Rate: ([\d.]+)` | `tickRate` |
| `ADMIN_BROADCAST_LOG` | `^LogSquad: ADMIN COMMAND: Message broadcasted <(.+)> from (.+)` | `message, from` |
| `SQUAD_CREATED` | `^LogSquad: (.+) \(Online IDs:([^)]+)\) has created Squad (\d+) \(Squad Name: (.+)\) on (.+)$` | `playerName, ids, squadId, squadName, teamName` |

Robustness rules: names may contain `(`,`)`,`|`,`:` — where a name precedes
` (Online IDs:`, split on the **last** occurrence of ` (Online IDs:`. Keep each regex
anchored (`^`) and prefer lazy quantifiers before literal anchors. Unknown lines → `null`.
Attacker "nullptr"/empty controller → environment/suicide (see ingest).

### 6.2 Fixture lines (commit EXACTLY these to `test/fixtures/sample.log`, one per line, plus 10+ realistic noise lines that must parse to null)

```
[2026.03.01-21.50.52:123][448]LogSquad: PostLogin: NewPlayer: BP_PlayerController_C /Game/Maps/Narva/Gameplay_Layers/Narva_AAS_v2.Narva_AAS_v2:PersistentLevel.BP_PlayerController_C_2147254377 (IP: 86.142.11.23 | Online IDs: EOS: 0002a10386d9114496bce8b6ded68587 steam: 76561198012345678)
[2026.03.01-21.51.01:004][512]LogNet: Join succeeded: Wardex
[2026.03.01-21.55.13:901][771]LogSquad: Player:Wardex ActualDamage=38.250000 from BobTheBuilder (Online IDs: EOS: 0002b4c5d6e7f8091a2b3c4d5e6f7081 steam: 76561198087654321 | Player Controller ID: BP_PlayerController_C_2147254111)caused by BP_SVDM_Optic_C
[2026.03.01-21.55.14:120][772]LogSquadTrace: [DedicatedServer]ASQSoldier::Wound(): Player:Wardex KillingDamage=38.250000 from BP_PlayerController_C_2147254111 (Online IDs: EOS: 0002b4c5d6e7f8091a2b3c4d5e6f7081 steam: 76561198087654321 | Controller ID: BP_PlayerController_C_2147254111) caused by BP_SVDM_Optic_C
[2026.03.01-21.56.20:338][801]LogSquadTrace: [DedicatedServer]ASQSoldier::Die(): Player:Wardex KillingDamage=38.250000 from BP_PlayerController_C_2147254111 (Online IDs: EOS: 0002b4c5d6e7f8091a2b3c4d5e6f7081 steam: 76561198087654321 | Controller ID: BP_PlayerController_C_2147254111) caused by BP_SVDM_Optic_C
[2026.03.01-21.57.05:010][850]LogSquad: BobTheBuilder (Online IDs: EOS: 0002b4c5d6e7f8091a2b3c4d5e6f7081 steam: 76561198087654321) has revived Wardex (Online IDs: EOS: 0002a10386d9114496bce8b6ded68587 steam: 76561198012345678).
[2026.03.01-21.58.00:555][900]LogSquadTrace: [DedicatedServer]ASQDeployable::TakeDamage(): BP_FOBRadio_Woodland_C_2146067116: 350.000000 damage attempt by causer BP_C4_Explosive_C_2146001122 instigator GrieferGuy with damage type BP_C4_DamageType_C health remaining 1650.000000
[2026.03.01-22.01.11:000][100]LogWorld: Bringing World /Game/Maps/Yehorivka/Gameplay_Layers/Yehorivka_RAAS_v1.Yehorivka_RAAS_v1 up for play
[2026.03.01-22.01.30:000][120]LogGameState: Match State Changed from WaitingToStart to InProgress
[2026.03.01-22.44.10:222][333]LogSquadGameEvents: Display: Team 2, Manticore Security Task Force ( WPMC ) has won the match with 184 Tickets on layer Yehorivka RAAS v1 (level Yehorivka)!
[2026.03.01-22.45.00:001][950]LogSquad: USQGameState: Server Tick Rate: 38.45
[2026.03.01-22.46.00:000][960]LogNet: UNetConnection::Close: [UNetConnection] RemoteAddr: 86.142.11.23:50143, Name: EOSIpNetConnection_2147254300, Driver: GameNetDriver EOSNetDriver_2147482519, IsServer: YES, PC: BP_PlayerController_C_2147254377, Owner: BP_PlayerController_C_2147254377, UniqueId: RedpointEOS:0002a10386d9114496bce8b6ded68587
[2026.03.01-22.47.00:000][970]LogSquad: GoodGuy (Online IDs: EOS: 0002c0ffee00000000000000000000aa steam: 76561198011112222) has created Squad 3 (Squad Name: ARMOR) on Team Manticore Security Task Force
[2026.03.01-22.48.00:000][980]LogSquad: ADMIN COMMAND: Message broadcasted <Welcome to the server> from RCON
```

### 6.3 Chat packets (RCON type 1 bodies) — `parseChatPacket(body)` → `null` or:
| kind | format | fields |
|---|---|---|
| `CHAT` | `[ChatAll\|ChatTeam\|ChatSquad\|ChatAdmin] [Online IDs:EOS: <eos> steam: <steam>] <name> : <msg>` | `channel ('all'\|'team'\|'squad'\|'admin'), eosId, steamId, name, message` (split name/msg on FIRST ` : ` after the `]` bracket) |
| `ADMIN_CAM` | `[Online Ids:EOS: <eos> steam: <steam>] <name> has (un)?possessed admin camera.` | `eosId, steamId, name, possessed:bool` |
| `WARned` | `Remote admin has warned player <name>. Message was "<msg>"` | `name, message` |
| `KICKED` | `Kicked player <id>. [Online IDs= EOS: <eos> steam: <steam>] <name>` | `playerId, eosId, steamId, name` |
| `BANNED` | `Banned player <id>. [Online IDs= EOS: <eos> steam: <steam>] <name> for interval <interval>` | `playerId, eosId, steamId, name, interval` |
| `SQUAD_CREATED` | same as log line variant | — |

Note `Online IDs=` (equals sign) in kick/ban lines and `Online Ids:` casing in admin-cam —
match ids with the tolerant scanner from `parseOnlineIds`.

### 6.4 RCON list responses
`parseListPlayers`: sections `----- Active Players -----` then lines
`ID: 7 | Online IDs: EOS: <eos> steam: <steam> | Name: <name> | Team ID: 1 | Squad ID: 2 | Is Leader: True | Role: USA_Rifleman_01`
(`Squad ID: N/A` → null). Then `----- Recently Disconnected Players [Max of 15] -----` lines
`ID: 3 | Online IDs: EOS: … steam: … | Since Disconnect: 01m.30s | Name: <name>` →
`{online:[{playerId,eosId,steamId,name,teamId,squadId,isLeader,role}], disconnected:[{playerId,eosId,steamId,name,sinceDisconnect}]}`.
Name is LAST field → greedy to EOL (names with `|` survive on player lines because Name is
terminal on disconnected lines and mid-line on active — for active lines split on known
field markers ` | Team ID: ` etc. from the RIGHT).

`parseListSquads`: `Team ID: 1 (United States Army)` headers then
`ID: 1 | Name: CMD | Size: 9 | Locked: False | Creator Name: X | Creator Online IDs: EOS: … steam: …`
→ `[{teamId, teamName, squadId, name, size, locked, creatorName, creatorEos, creatorSteam}]`.

`parseServerInfo`: JSON.parse; pick (tolerate absence): `ServerName_s, MaxPlayers,
PlayerCount_I, PublicQueue_I, ReservedQueue_I, MapName_s, GameMode_s, GameVersion_s,
TeamOne_s, TeamTwo_s, NextLayer_s, MATCHTIMEOUT_d, PLAYTIME_I` → camelCase object
`{serverName, maxPlayers, playerCount, publicQueue, reservedQueue, mapName, gameMode,
gameVersion, teamOne, teamTwo, nextLayer, playTimeSec}` (numbers coerced).

`parseLayers` (ListLayers): skip header line, one layer name per line, trim, drop empties
and `(…)` mod suffixes kept as-is. `parseCurrentMap`/`parseNextMap`:
`Current level is <level>, layer is <layer>` / `Next level is …, layer is …` (value may be
`To be voted`/empty → nulls).

## 7. Canonical enriched event payloads (bus)

All carry `time` (epoch ms). `player` refs are `{dbId, eosId, steamId, name, teamId, squadId}`
(nullable fields ok).
- `kill`: `{time, matchId, kind:'wound'|'die', attacker:playerRef|null, victim:playerRef, weapon, damage, teamkill:bool, suicide:bool}`
- `chat`: `{time, matchId, channel, player:playerRef, message}`
- `deployable`: `{time, matchId, player:playerRef|null, deployable, category:'radio'|'hab'|'other', depFaction, friendly: 1|0|-1, damage, weapon, damageType, healthRemaining, label}` (`friendly:-1` = unknown)
- `flag`: `{time, flagId, type, severity:1|2|3, player:playerRef, matchId, details}`
- `match-start`/`match-end`: `{matchId, layer, level, team1, team2, startedAt}` / `+{winnerTeam, winnerFaction, tickets, endedAt}`

## 8. Factions / deployable classification — `server/factions.js`

- `classifyDeployable(className)` → `{category, factionToken|null, label}`.
  category: `/fobradio|fob_radio|radiohab/i`… precisely: `radio` if `/FOBRadio|FOB_Radio/i`;
  `hab` if `/\bHAB\b|_Hab_|Hab$|HideoutHab|Bunker_Hab/i`; else `other`.
  Label: strip `BP_` prefix and trailing `_C…`, split CamelCase/underscores → human string.
- Faction tokens scanned from className suffix/parts (longest match first):
  `USMC, PLANMC, PLAAGF, PLA, VDV, RGF, RUS, USA, US, GB, BAF, CAF, AUS, ADF, MEA, INS,
  IMF, MIL, TLF, WPMC` (also `Woodland`→null generic, `Desert`→null generic).
- `teamFactionTokens(teamStr)`: team setup strings look like `"USA_S_CombinedArms"`,
  `"RGF_S_CombinedArms"`, `"WPMC_LO_LightInfantry"` → leading token before `_`. Also map
  aliases: `RUS→RGF`, `US→USA`, `GB→BAF`.
- `resolveFriendly(depFactionToken, instigatorTeamId, match)` → `1|0|-1`: match holds
  `team1`/`team2` setup strings; if token null → `-1`; if token (normalized) equals
  instigator's team token → `1` (friendly damage!), equals other team → `0`, else `-1`.

## 9. Database — `server/db.js` (SQLite, WAL)

`openDb(path)` → `{raw, prepare, exec, tx(fn), migrate()}`. Backend: try
`require('node:sqlite').DatabaseSync`; on failure try `require('better-sqlite3')`; else
throw with friendly "upgrade Node to >=22.13 or npm install better-sqlite3".
Wrapper normalizes: `prepare(sql)` → `{run(...p), get(...p), all(...p)}`;
`tx(fn)` wraps BEGIN/COMMIT/ROLLBACK. `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;`. Migrations: `schema_version` pragma-style table; v1 DDL below.

```sql
CREATE TABLE players(
  id INTEGER PRIMARY KEY, eos_id TEXT UNIQUE, steam_id TEXT, name TEXT,
  first_seen INTEGER, last_seen INTEGER, play_seconds INTEGER DEFAULT 0,
  kills INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0, teamkills INTEGER DEFAULT 0,
  tk_deaths INTEGER DEFAULT 0, suicides INTEGER DEFAULT 0,
  revives_given INTEGER DEFAULT 0, revives_taken INTEGER DEFAULT 0,
  radio_damage_friendly REAL DEFAULT 0, radio_damage_enemy REAL DEFAULT 0,
  hab_damage_friendly REAL DEFAULT 0, hab_damage_enemy REAL DEFAULT 0,
  deployable_damage_unknown REAL DEFAULT 0,
  avatar TEXT, persona_fetched_at INTEGER, watchlisted INTEGER DEFAULT 0);
CREATE INDEX idx_players_steam ON players(steam_id);
CREATE INDEX idx_players_name ON players(name);
CREATE TABLE player_names(player_id INTEGER, name TEXT, first_used INTEGER, last_used INTEGER,
  PRIMARY KEY(player_id, name));
CREATE TABLE player_ips(player_id INTEGER, ip TEXT, first_seen INTEGER, last_seen INTEGER,
  times INTEGER DEFAULT 1, PRIMARY KEY(player_id, ip));
CREATE INDEX idx_ips_ip ON player_ips(ip);
CREATE TABLE sessions(id INTEGER PRIMARY KEY, player_id INTEGER, connect_at INTEGER,
  disconnect_at INTEGER);
CREATE INDEX idx_sessions_player ON sessions(player_id);
CREATE TABLE matches(id INTEGER PRIMARY KEY, layer TEXT, level TEXT, layer_class TEXT,
  team1 TEXT, team2 TEXT, started_at INTEGER, in_progress_at INTEGER, ended_at INTEGER,
  winner_team INTEGER, winner_faction TEXT, tickets INTEGER);
CREATE TABLE match_players(match_id INTEGER, player_id INTEGER, team_id INTEGER,
  kills INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0, teamkills INTEGER DEFAULT 0,
  tk_deaths INTEGER DEFAULT 0, revives INTEGER DEFAULT 0, damage_dealt REAL DEFAULT 0,
  PRIMARY KEY(match_id, player_id));
CREATE TABLE kills(id INTEGER PRIMARY KEY, match_id INTEGER, time INTEGER, kind TEXT,
  attacker_id INTEGER, victim_id INTEGER, weapon TEXT, damage REAL,
  teamkill INTEGER DEFAULT 0, suicide INTEGER DEFAULT 0);
CREATE INDEX idx_kills_match ON kills(match_id); CREATE INDEX idx_kills_attacker ON kills(attacker_id);
CREATE INDEX idx_kills_victim ON kills(victim_id); CREATE INDEX idx_kills_time ON kills(time);
CREATE TABLE revives(id INTEGER PRIMARY KEY, match_id INTEGER, time INTEGER,
  reviver_id INTEGER, revived_id INTEGER);
CREATE TABLE damage_agg(match_id INTEGER, attacker_id INTEGER, victim_id INTEGER,
  weapon TEXT, hits INTEGER DEFAULT 0, total REAL DEFAULT 0, teamdamage INTEGER DEFAULT 0,
  PRIMARY KEY(match_id, attacker_id, victim_id, weapon));
CREATE TABLE deployable_damage(id INTEGER PRIMARY KEY, match_id INTEGER, time INTEGER,
  player_id INTEGER, player_team INTEGER, deployable TEXT, category TEXT, dep_faction TEXT,
  friendly INTEGER, damage REAL, weapon TEXT, damage_type TEXT, health_remaining REAL);
CREATE INDEX idx_dep_player ON deployable_damage(player_id); CREATE INDEX idx_dep_match ON deployable_damage(match_id);
CREATE TABLE chat(id INTEGER PRIMARY KEY, time INTEGER, match_id INTEGER, player_id INTEGER,
  channel TEXT, message TEXT);
CREATE INDEX idx_chat_time ON chat(time); CREATE INDEX idx_chat_player ON chat(player_id);
CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE,
  pass_hash TEXT, role TEXT CHECK(role IN ('owner','admin','viewer')),
  created_at INTEGER, last_login INTEGER, disabled INTEGER DEFAULT 0);
CREATE TABLE auth_sessions(token_hash TEXT PRIMARY KEY, user_id INTEGER,
  created_at INTEGER, expires_at INTEGER, ip TEXT, ua TEXT);
CREATE TABLE admin_actions(id INTEGER PRIMARY KEY, time INTEGER, user_id INTEGER,
  action TEXT, target_player_id INTEGER, details TEXT, rcon_command TEXT,
  rcon_response TEXT, rcon_ok INTEGER);
CREATE INDEX idx_actions_time ON admin_actions(time);
CREATE TABLE bans(id INTEGER PRIMARY KEY, player_id INTEGER, issued_by INTEGER,
  issued_at INTEGER, duration_sec INTEGER, expires_at INTEGER, reason TEXT,
  interval_raw TEXT, active INTEGER DEFAULT 1, rcon_ok INTEGER,
  unbanned_by INTEGER, unbanned_at INTEGER);
CREATE TABLE warnings(id INTEGER PRIMARY KEY, player_id INTEGER, by_user INTEGER,
  time INTEGER, message TEXT, auto INTEGER DEFAULT 0);
CREATE TABLE flags(id INTEGER PRIMARY KEY, player_id INTEGER, time INTEGER, type TEXT,
  severity INTEGER, match_id INTEGER, details TEXT, reviewed INTEGER DEFAULT 0,
  reviewed_by INTEGER, reviewed_at INTEGER);
CREATE INDEX idx_flags_player ON flags(player_id);
CREATE TABLE player_notes(id INTEGER PRIMARY KEY, player_id INTEGER, by_user INTEGER,
  time INTEGER, text TEXT);
CREATE TABLE pop_samples(time INTEGER PRIMARY KEY, players INTEGER, queue INTEGER,
  tick_rate REAL, layer TEXT);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT);
```

## 10. Live state — `server/state.js`

`class LiveState extends EventEmitter` holding:
`players: Map<eosId, {playerId, dbId, eosId, steamId, name, teamId, squadId, isLeader, role, ip, controller, connectedAt}>`,
`controllers: Map<controller, eosId>`, `squads`, `serverInfo` (parsed §6.4), `layers:[]`,
`currentLayer, nextLayer, tickRate`, `match` (current row `{id, layer, level, team1, team2, startedAt}`),
`recentlyDisconnected:[]`.
Methods: `applyListPlayers(parsed)` (reconcile: team/squad/name updates, detect joins only
as fallback — log events are primary), `applyListSquads`, `applyServerInfo`,
`byName(name)` (exact, then case-insensitive, then trailing-match for JOIN_SUCCEEDED
suffixes), `byEos`, `bySteam`, `byController`, `playerRef(p)`, `snapshot()` → JSON-safe
`{serverInfo, teams:[{teamId, name, squads:[{…, players:[…]}], unassigned:[…]}], recentlyDisconnected, currentLayer, nextLayer, tickRate, match}`.

## 11. Ingest — `server/ingest.js`

`class Ingest { constructor({db, state, bus, config, admin}) }` — subscribes to bus raw
events (`log-event`, `chat-packet-parsed`, poll updates) and produces DB writes +
enriched bus events (§7). Core rules:

- **Identity**: `getOrCreatePlayer({eosId, steamId, name, time})` — key on eosId; update
  steam/name/last_seen; maintain `player_names` (upsert window), `player_ips` on connect.
- **Sessions**: PLAYER_CONNECTED → open session (close any dangling), store controller map;
  PLAYER_DISCONNECTED → close session, add `play_seconds` delta. On NEW_GAME do NOT close
  sessions. On boot, close all dangling sessions (crash recovery) with `disconnect_at = last_seen`.
- **Match lifecycle**: NEW_GAME → close current match if open (`ended_at=time`), insert new
  match (layer from layerClass pretty-printed; level), reset per-match caches; next
  `serverinfo-updated` fills `team1/team2/layer` names when they arrive. MATCH_STATE
  `*→InProgress` sets `in_progress_at`. ROUND_ENDED (the `won` line) sets winner/tickets
  (match stays open until NEW_GAME; `match-end` bus event fires at ROUND_ENDED).
- **Kills**: on PLAYER_WOUNDED/PLAYER_DIED resolve attacker via ids blob → eos, else
  controller map; victim via exact name (state.byName). `suicide` = attacker===victim.
  `teamkill` = both resolved, not suicide, same teamId at event time. Insert `kills` row;
  update `players` + `match_players` aggregates: wound → attacker.kills++/victim.deaths++
  (die rows recorded with kind='die' but do NOT double-count kills/deaths — Squad
  convention: the wound is the kill; die = gave up). TK on wound → teamkills++/tk_deaths++,
  run TK flag logic, optional autoWarnTeamkiller via admin.execRaw (AdminWarn), insert
  `warnings(auto=1)`.
- **Damage**: PLAYER_DAMAGED → upsert `damage_agg` (+hits, +damage, teamdamage flag by
  team compare) and `match_players.damage_dealt`. No per-hit rows.
- **Revives**: insert, aggregates both players.
- **Deployables**: classify via factions.js; resolve player by name; friendly via
  instigator team + match factions. Insert row; bump player aggregate columns
  (radio/hab × friendly/enemy, unknown bucket). Flag logic below. Emit enriched event.
- **Chat**: insert chat rows (any channel), link player by eos. Watchlist regex (whole-word,
  case-insensitive) hits → flag `chat_watchlist` severity 1 with the message.
- **Flags** (insert + bus `flag` + webhook):
  - `friendly_radio` sev3: deployable category radio, friendly===1. Details: damage, weapon.
    Dedupe: one flag per (player, match), accumulate damage into details (update row).
  - `radio_unknown` sev1: category radio, friendly===-1, damage >= 100 (dedupe same way).
  - `tk_spree` sev3: >= cfg.tkSpreeCount TK wounds within tkSpreeWindowSec.
    One flag per spree (reset window after flag).
  - `mass_tk` sev3: >= cfg.massTkCount TKs in one match (one flag per match).
  - `new_player_tk` sev2: TK within newPlayerMinutes of first_seen.
  - `chat_watchlist` sev1.
- **Ban enforcement**: on PLAYER_CONNECTED, if active ban (active=1, not expired) →
  `AdminKickById` (or AdminKick selector) with reason `Banned: <reason> (until <date|perm>)`,
  audit as system action (user_id NULL), webhook note.
- **Pop samples**: every 60s insert `{players, queue, tickRate, layer}`; prune per retention.
- **Retention job** hourly: chatDays>0 → delete old chat; popDays prune.

## 12. Auth — `server/auth.js`

> **Amended**: granular per-role permissions, admin invites, and the runtime settings
> API are specified in `docs/ROLES-INVITES-SETTINGS.md` (where it and this spec conflict,
> it wins). Roles are table-backed as of schema v2; the matrix below seeds the builtins.

- `hashPassword(pw)` → `scrypt$N=16384,r=8,p=1$<salt b64>$<hash b64>` via node:crypto
  (`randomBytes(16)` salt, 64-byte key); `verifyPassword` with `timingSafeEqual`.
- Sessions: token = `randomBytes(32).hex`; store sha256(token); cookie `sw_session`,
  `HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` (+`Secure` per config). 30-day expiry,
  sliding (refresh expires_at when < 15d left). `destroySession`, `destroyUserSessions`.
- Login rate limit: in-memory per-IP 5 attempts / 60s → 429.
- Roles & permissions matrix (enforced server-side in api.js; helper `can(user, perm)`):
  - `viewer`: read-only everything EXCEPT: no IPs, no raw console, no users, no audit? —
    audit visible, IPs hidden, actions forbidden.
  - `admin`: all viewer + all player/admin actions (warn/kick/ban/unban/broadcast/layer/
    match/squad actions/flags review/notes/manual bans) + see IPs.
  - `owner`: all + raw console + user management + slomo + settings view.
- First-run: `GET /api/bootstrap` → `{needsSetup: users==0}`; `POST /api/setup`
  `{username,password}` creates owner — ONLY when users table empty (also re-check inside tx).
- CLI `--create-admin user pass [role=admin]` in index.js for recovery.
- `audit(userId, action, {targetPlayerId, details, rconCommand, rconResponse, rconOk})`
  → admin_actions insert + bus `admin-action`.

## 13. HTTP API — `server/api.js`

`createApi({db, state, ingest, rcon, bus, auth, admin, config, version})` → `http.Server`.
Tiny router (method+regex table). Static: serve `public/` (correct MIME, no directory
traversal — resolve+prefix check), `/` → index.html, cache-control no-cache for dev-sanity.
Body parse: JSON only, 64KB cap. All `/api/*` except `login|setup|bootstrap` require
session; role checks per route. Mutating routes: Origin-host check. Every response JSON.

Routes (→ shapes):
```
POST /api/login {username,password} → {ok, user:{id,username,role}}   | sets cookie
POST /api/logout → {ok}
GET  /api/bootstrap → {needsSetup, serverName, version}
POST /api/setup {username,password} → {ok}            # only when no users
GET  /api/me → {user}
GET  /api/overview → {status:{rcon:…, log:…, tickRate, serverInfo…}, snapshot: state.snapshot(),
      counters:{playersTotal, matchesTotal, flagsOpen, bansActive, onlineAdmins? no},
      recent:{kills:[last 25 enriched], chat:[last 25], flags:[last 10 unreviewed]}}
GET  /api/stream  (SSE; text/event-stream)  events: hello {snapshot,me}, then
      kill, chat, deployable, flag, connect, disconnect, players (snapshot every 5s max,
      on players-updated), match, serverinfo, tick, status ({rcon,log}), broadcast, pop
GET  /api/pop?hours=24 → {samples:[[time,players,queue,tick]…]}
GET  /api/players?q=&sort=last_seen|kills|teamkills|radio|playtime&dir=&filter=online|flagged|watchlisted|banned&page=&per=50
      → {total, rows:[{id,name,eosId,steamId,lastSeen,firstSeen,playSeconds,kills,deaths,
         teamkills,tkDeaths,radioFriendly,habFriendly,flagsOpen,online,watchlisted,bannedActive}]}
GET  /api/players/:id → full profile: {player(all agg cols), names[], online, session,
      ips:[{ip,firstSeen,lastSeen,times}] (admin+), alts:[{playerId,name,sharedIps}] (admin+),
      sessions:[last 50], matches:[{matchId,layer,startedAt,teamId,kills,deaths,teamkills,revives,damage}],
      recentKills[50], recentDeaths[50], tkIncidents[all], deployableDamage[all],
      chatCount, flags[], warnings[], bans[], notes[]}
GET  /api/players/:id/chat?page= → {total, rows}
POST /api/players/:id/notes {text} → {ok,note}        (admin)
POST /api/players/:id/watch {on:bool} → {ok}          (admin)
POST /api/players/:id/flag {details} → {ok}           (admin; manual flag sev2)
GET  /api/matches?page= → {total, rows:[{id,layer,level,startedAt,endedAt,winnerTeam,
      winnerFaction,tickets,team1,team2,players,kills,teamkills}]}
GET  /api/matches/:id → {match, scoreboard:[match_players joined w/ names, both teams],
      kills:[all enriched], deployables:[…], chat:[…], flags:[…]}
GET  /api/chat?q=&channel=&playerId=&page=&per=100 → {total, rows:[{time,channel,player:{id,name},message,matchId}]}
GET  /api/flags?reviewed=0|1|all&page= → {total, rows:[flag + player name]}
POST /api/flags/:id/review {note?} → {ok}             (admin)
GET  /api/trolls → {openFlags, leaderboards:{teamkills:{all:[…],week:[…]},
      radioFriendly:[…], tkDeaths:[…], repeatOffenders:[players w/ >=2 flags]}}
GET  /api/layers → {layers:[…], cachedAt}
GET  /api/bans?active=1|0|all → {rows:[ban + player name + issuer]}
POST /api/bans {playerId|steamId, interval, reason} → {ok, ban, rconOk, rconResponse} (admin)
POST /api/bans/:id/unban → {ok, note:"…Bans.cfg…"}    (admin; sets active=0; NOTE: Squad
      has no RCON unban — response includes guidance string; if player online nothing to do)
GET  /api/export/bans.cfg → text/plain lines "SteamId:ExpiryEpoch //reason" for active bans (admin)
POST /api/admin/warn {playerId, message} → {ok, rconOk, rconResponse}      (admin)
POST /api/admin/kick {playerId, reason} → …                                 (admin)
POST /api/admin/broadcast {message} → …                                     (admin)
POST /api/admin/forceTeamChange {playerId} → …                              (admin)
POST /api/admin/removeFromSquad {playerId} → …                              (admin)
POST /api/admin/disbandSquad {teamId, squadId} → …                          (admin)
POST /api/admin/demoteCommander {playerId} → …                              (admin)
POST /api/admin/changeLayer {layer, now:bool} → …                           (admin)
POST /api/admin/match {op:'restart'|'end'} → …                              (admin)
POST /api/admin/slomo {factor} → …                                          (owner)
POST /api/admin/raw {command} → {ok, response}                              (owner)
GET  /api/audit?page=&userId=&action= → {total, rows:[action + username + player name]}
GET  /api/users → {rows} (owner)   POST /api/users {username,password,role} (owner)
POST /api/users/:id {role?|disabled?|password?} (owner; cannot demote last owner)
GET  /api/settings → {config: redacted(config), status:{rcon,log,db:{path,sizeBytes},
      parser:{unmatched24h, samples:[last 10 unmatched lines]}, version} } (owner)
```
`admin.js` exports `execAdmin(user, action, params)` implementing the §4.3 catalog with
selector preference (online numeric id → ById; else steamId/eos selector; sanitize args;
audit everything; returns `{ok, rconOk, command, response}`). Target resolution:
`playerId` = DB player id; look up live player via state (eos) for ById/selector.

## 14. Frontend (public/) — design + views

### 14.1 Design language
Dark tactical. Tokens on `:root`:
`--bg:#0b0e14; --panel:#11161f; --panel2:#171e2a; --raise:#1f2838; --line:#232c3d;
--text:#dbe3f0; --dim:#8b97ad; --faint:#5c6a80; --accent:#f0a020; --accent2:#4ba3f5;
--red:#e5484d; --green:#30a46c; --purple:#9d7bd8; --team1:#4ba3f5; --team2:#e5744b;
--gold:#f0c040;` Radius 10px cards / 8px controls. Font: Inter
(Google Fonts link + `system-ui` fallback); mono `ui-monospace,'JetBrains Mono',monospace`.
`color-scheme: dark`. Focus-visible outlines. 14px base. NO emoji as UI chrome — inline
SVG icon set via `icon(name)` helper (stroke 1.8, 24-box): dashboard, live, users, swords,
chat, shield-alert, gavel, terminal, ban, scroll, user-cog, settings, search, warn, kick,
swap, radio, hab, skull, clock, copy, check, x, chevrons, logout, eye, flame, broadcast,
map, play, pause, flag, note, star.
Logo: inline SVG — radar/shield mark + wordmark "SQUADWATCH" (Saira-like weight via
letter-spacing; just Inter 800 italic-ish is fine). Kill feed rows, TK rows get
`--red` left border; friendly radio damage rows `--purple`.

Layout: fixed left sidebar 220px (collapsible to 56px icons on <900px; overlay drawer on
mobile) + topbar (server name, layer → next layer, players `74/100 (+3)`, tick chip,
match clock, RCON/log status dots, user menu) + main scroll area. Toasts top-right.
Modal + confirm dialogs (danger style for kick/ban). Player popover menu on any player
name click: Profile, Warn, Kick, Ban, Force team, Remove from squad, Watch, Note.

### 14.2 Core (app.js)
- `esc(s)` HTML-escape; EVERY dynamic string through it (or textContent).
- `api(path, {method,body})` fetch wrapper → JSON, 401 → show login view, error → toast.
- Hash router: `#/dashboard #/live #/players #/players/:id #/matches #/matches/:id #/chat
  #/trolls #/admin #/console #/bans #/audit #/users #/settings #/login #/setup`.
  Route table → view render fns; views render into `#main`; nav active state;
  role-gates hide nav items (and views check `me.role`).
- SSE client: `EventSource('/api/stream')`, auto-reconnect (browser native + manual retry
  on error with backoff), dispatch to a pub/sub `live.on('kill',…)`; views subscribe and
  MUST unsubscribe on route change (`view.cleanup()` convention).
- Components: `table(cols, rows, opts)` sortable, `pager`, `statCard`, `sparkline(canvas,
  series)`, `badge`, `timeAgo` (auto-refresh 30s), `fmtDur`, `playerLink(ref)` (popover),
  `confirmModal({title, body, danger, fields:[{name,label,type,options,placeholder}]})` →
  Promise, `copyBtn(text)`.
- Login view (centered card, logo, error shake), Setup view (first-run owner creation),
  both hide chrome.
- Prefs in localStorage: sidebar collapsed, console history, per-table sort, feed paused.

### 14.3 Views
- **Dashboard**: stat cards (Players+queue, Current layer + next w/ change buttons(admin),
  Match clock + tick sparkline, Open flags(→trolls), Active bans, TKs today);
  24h population chart (canvas line, queue as faint second line); two live columns:
  Kill feed (TK highlighted, weapon, timeAgo) + Chat feed (channel chip colors:
  all=accent2, team=green, squad=dim, admin=gold); Alerts strip (latest unreviewed flags).
- **Live**: team columns with faction names; squad cards (name, size, locked lock icon,
  SL star on leader) listing players (role kit abbreviation, session K/D/TK via live
  aggregation from today's kills — serve in snapshot? players rows carry per-session
  kills/deaths/tks maintained in state by ingest enrichment → YES include in playerRef);
  Unassigned bucket; Recently disconnected panel (with Ban-anyway action);
  topline: broadcast quick-box (admin), next layer quick-set.
- **Players**: search box (name/steamid/eosid), filter chips, sortable table, flags column
  (badge), online dot, link rows → profile.
- **Profile**: header card (avatar/initials, current+past names, EOS/Steam ids + copy,
  steamcommunity link, first/last seen, playtime, watch star toggle, action buttons);
  stat grid (K/D, kills, deaths, TKs given/received, revives, suicides, radio dmg
  friendly/enemy, hab dmg); tabs: Overview (recent kills/deaths merged timeline),
  Matches (table), Incidents (TKs + deployable damage, friendly radio highlighted),
  Chat (paged), Sessions & IPs (admin: ip table + alts sharing IPs), Discipline
  (warnings incl auto, bans, flags w/ review state), Notes (add/list).
- **Matches**: table; Match detail: header (layer, duration, result banner winner faction
  + tickets), scoreboard (two team tables, sortable, TK column red when >0), tabs:
  Kill feed (filter: all/TK only), Deployables (radio/hab filters, friendly filter),
  Chat, Flags.
- **Chat**: filters (channel chips, player autocomplete via players search, text query),
  paged table, each row: time, channel chip, player link, message. Live append when on
  page 1 no filters.
- **Trolls**: Flag inbox (unreviewed first; severity badges sev3 red/sev2 amber/sev1 dim;
  row: time, player, type label, details, match link, Review button) + "live watch"
  toggle (toast every kill TK/radio event); Leaderboards: tabs All-time/7 days — TKs,
  Friendly radio damage, TK victims, Repeat offenders.
- **Admin**: Broadcast composer (+ saved presets in localStorage, send);
  Layer control: current/next cards, searchable layer list (from /api/layers),
  buttons Set Next / Change Now (confirm);
  Match: Restart/End (double-confirm);
  Squads: team/squad picker → disband, demote commander by player picker;
  Players quick actions: player picker (online list) → warn/kick/ban/forceteam/remove.
  Every action → toast with rcon response (truncated, expandable).
- **Console** (owner): terminal panel (mono, output history with timestamps, command
  echo), input w/ up/down history (localStorage, 100), autocomplete dropdown from §4.3
  catalog + `ListCommands` output, Ctrl+L clear. Quick buttons sidebar: ListPlayers,
  ShowServerInfo, ListSquads, ShowNextMap.
- **Bans**: active/expired tabs; row: player, reason, issued by, issued at, expires
  (countdown), rconOk badge, Unban btn (confirm; shows Bans.cfg guidance from API);
  Manual ban card: steamid input + interval preset (1d/3d/7d/1M/perm/custom) + reason;
  Export Bans.cfg button (downloads /api/export/bans.cfg).
- **Audit**: table (time, user, action, target player, details, rcon ok, expand response).
  Filter by user/action.
- **Users** (owner): list (role select, disable toggle, reset password modal), add user.
- **Settings** (owner): status cards (RCON connected since/err, Log source mode/lag,
  DB size, server version/game version, parser health: unmatched line count + sample
  lines w/ copy — "send these to tune parser"), redacted config dump (mono block).

### 14.4 SSE-driven behavior
Kill/chat/deployable/flag events update: dashboard feeds (cap 50 rows in DOM), live view
session stats, toasts (flags always toast for admins; kills only in troll-watch mode).
`players` snapshot event re-renders Live view roster (throttle 2s). `status` event updates
topbar dots. Connection lost → topbar banner "live updates reconnecting…".

## 15. Mock Squad server & demo — `test/mock-squad.js`, `server/demo.js`

`class MockSquad { constructor({rconPort=0, logPath, password='demo'}) }`:
- TCP server speaking RCON (§4.1): auth check, EXECCOMMAND responses for ListPlayers/
  ListSquads/ShowServerInfo/ListLayers/ShowCurrentMap/ShowNextMap (rendered from internal
  mock state in EXACT real formats §6.4), Admin* commands mutate mock state (kick removes
  player, ban removes + records, broadcast → chat packet to all rcon clients +
  ADMIN_BROADCAST_LOG log line, changeLayer swaps layer + NEW_GAME lines) and reply with
  realistic confirmations. Multi-packet: honor the empty-exec sentinel echo. Unknown
  command → `Unknown command: <cmd>`.
- Log writer: appends real-format lines (§6.2 shapes) to `logPath`.
- `api`: `addPlayer(p)`, `removePlayer`, `chat(player, channel, msg)` (sends type-1 packet),
  `wound/die(attacker, victim, weapon)`, `revive`, `deployableDamage(player, className,
  damage, weapon)`, `newGame(layer, level)`, `roundEnd(winnerTeam, tickets)`, `tick(rate)`.
  All take explicit `time` or use Date.now.
- Deterministic name/id pool for tests.

`server/demo.js` `startDemo({dataDir})`: boots MockSquad on an ephemeral port with
`logPath=data/demo-SquadGame.log`, returns `{rconHost:'127.0.0.1', rconPort, rconPassword,
logPath, stop}` AND runs a continuous scenario: 36–60 fake players (name pool with clans
tags, unicode), joins/leaves, squads, kills every 3–10s (8% TK), chat chatter (some toxic
lines triggering watchlist if configured), occasional friendly radio damage by designated
"GrieferGuy" + TK spree every ~10 min, matches rotate every 8 min through 4 layers,
seeds 3 finished historical matches on first boot by replaying a compressed scenario with
backdated timestamps through the log file BEFORE the app tails it… simpler: demo writes
backdated lines into the log file first, app ingests with `backfill:true` in demo mode.
index.js `--demo`: force `log.mode=local`, backfill true, db `data/demo.db`, wire to mock.

## 16. index.js boot order (for reference — integrator writes it)
config → db.migrate → auth.init → state → rcon (connect) → parser wiring:
rcon 'chat-packet' → parseChatPacket → bus; logsource 'line' → parseLogLine → bus
(+unparsed counter ring buffer for settings) → ingest (subscribes) → pollers
(ListPlayers 15s, ListSquads 15s, ShowServerInfo 30s, ListLayers 6h, ShowNextMap 60s)
→ steam.js (hourly if key) → webhook → api.listen → banner log with URL.
Graceful SIGINT/SIGTERM: stop pollers, close sources, close sessions? (leave), db close.

## 17. Testing requirements
- `parser.test.js`: every fixture line parses to the exact expected object (deep equal);
  noise lines → null; names with `(`,`)`,`|`,` : ` edge cases; ids scanner tolerance.
- `rcon.test.js`: against in-process MockSquad: auth ok/bad, exec echo, multi-packet
  (>4096 body), fragmented delivery (mock flushes in 7-byte chunks), reconnect after
  destroy, chat packet emission, exec timeout → reconnect.
- `db.test.js`: migrate idempotent; player upsert; aggregates math.
- `ingest.test.js`: feed scripted parsed events → assert kills/TK detection (same team),
  match lifecycle, friendly radio flag created, ban enforcement kick issued (admin stub),
  session playtime.
- `integration.test.js`: full boot (random ports, tmp dirs): MockSquad + app; scenario:
  6 players join (2 teams), chat, wound (enemy), wound (TK), C4 friendly radio, round end,
  new game; then: setup owner via API, login (cookie jar), GET overview/players/
  players/:id (assert TK + radio stats), matches/:id scoreboard, chat search, flags
  list (friendly_radio + maybe tk flags), POST admin/kick → assert mock received
  AdminKickById AND player gone next poll, POST admin/raw as owner ok, 403 as viewer
  (create viewer via users API), SSE: open stream, trigger kill, assert event arrives
  <5s. Keep total runtime < 60s.

## 18. Explicit non-goals (v1)
Multi-server fleets; RCON unban (impossible — guidance text instead); editing remote
Bans.cfg; auto-punish beyond optional auto-warn; Steam OAuth login; historical seeding
from old logs (parse-check tool only reports); mobile-native apps; HTTPS termination
(document reverse proxy / tailscale instead).

## 19. BINDING AMENDMENTS (design-review fixes — these override earlier sections)

### 19.1 Interfaces & shapes
1. **playerRef (§7)** is `{dbId, eosId, steamId, name, teamId, squadId, sessKills, sessDeaths, sessTks}`
   (session counters nullable). **state.js (§10)** player records additionally carry
   `sessKills, sessDeaths, sessTks` (init 0 on connect); state exposes
   `bumpSession(eosId, {kills?, deaths?, tks?})` and ingest calls it on every enriched
   kill event (attacker kills++, victim deaths++, tks++ on teamkill). `snapshot()`
   includes these per player. **snapshot()/SSE payloads NEVER include `ip` or
   `controller`** — IPs exist only in `GET /api/players/:id` for admin+.
2. **admin.js (§13)**: `createAdmin({db, rcon, state, auth, config, layersCache}) →
   {execAdmin(userOrNull, action, params), execRaw(userOrNull, command, auditMeta)}`.
   System actions (auto-warn, ban enforcement) call `execAdmin(null, …)` → audit row
   with `user_id` NULL. `createApi` receives this object as `admin`.
3. **auth.js (§12)**: `createAuth({db, config}) → {hashPassword, verifyPassword,
   createUser, verifyLogin, createSession, getSession, destroySession,
   destroyUserSessions, can(user, perm), audit(userId, action, meta), loginLimiter}`.
   §16 boot uses `auth = createAuth(…)` (no separate `init`).
4. **createApi deps (§13)** gain `parserHealth: {count24h(), samples()}` (ring buffer of
   last 10 unmatched lines + 24h counter, built in index.js and fed by the parser wiring).
5. **Bus (§3)**: add `chat-packet-parsed` (payload = §6.3 parsed packet) to the canonical
   list. index.js wiring: `rcon.on('chat-packet', b => { const p = parseChatPacket(b);
   if (p) bus.emit('chat-packet-parsed', p); })`. Ingest consumes `chat-packet-parsed`
   and emits enriched `chat`.
6. **revive payload (§7)**: `{time, matchId, reviver: playerRef, revived: playerRef}`;
   `revive` is also an SSE event (§13 list).
7. **GET /api/overview counters** gain `tksToday` (COUNT kills WHERE teamkill=1 AND
   kind='wound' AND time >= start of current UTC day).
8. **GET /api/trolls**: EVERY leaderboard is `{all:[…], week:[…]}` (teamkills,
   radioFriendly, tkDeaths, repeatOffenders).
9. **parseServerInfo** output includes `matchTimeout` (from `MATCHTIMEOUT_d`).
10. **GET /api/settings** status includes `gameVersion` (from state.serverInfo).
11. **SQUAD_CREATED chat packet (§6.3)**: same pattern as the log variant WITHOUT the
    `^LogSquad: ` prefix (body starts `<name> (Online IDs:…) has created Squad …`),
    same fields.
12. **NEW_GAME (§6.1)**: `level` = the path segment immediately after `Maps/` (the map
    folder, e.g. `Yehorivka`); `layerClass` = segment after the final `.`. A later
    ROUND_ENDED `level` value overwrites `matches.level`.

### 19.2 Schema changes (include in v1 DDL, not a migration)
13. `bans` gains `steam_id TEXT` (set from the players row or the manual input);
    `/api/export/bans.cfg` uses `COALESCE(bans.steam_id, players.steam_id)`. Manual ban
    of a never-seen steamId: create a stub players row `{steam_id, name:'(manual ban)'}`
    AND store bans.steam_id.
14. `flags` gains `review_note TEXT` (filled by POST /api/flags/:id/review {note}).

### 19.3 Security (all MUST)
15. **First-run setup race**: when users==0 at boot, generate
    `setupToken = randomBytes(16).hex`, print it in the console banner ONLY.
    `POST /api/setup` requires `{username, password, setupToken}`; compare via sha256 +
    `timingSafeEqual`; rate-limited like login. `GET /api/bootstrap` may still return
    `needsSetup`. The frontend Setup view has a token field ("printed in the server
    console"). In `--demo` mode ONLY, bootstrap returns `setupToken` so the demo is
    frictionless (demo binds to localhost by default).
16. **SQL identifier safety**: `sort/dir/filter/channel/reviewed/active/action` query
    params are resolved through whitelist lookup maps (e.g.
    `SORT = {last_seen:'last_seen', kills:'kills', teamkills:'teamkills',
    radio:'radio_damage_friendly', playtime:'play_seconds'}`); unknown key → 400.
    User strings are NEVER concatenated into SQL — bound params only.
17. **RCON selector safety** (admin.js): order of preference (a) numeric in-game id →
    `…ById`; (b) steamId matching `/^7656\d{13}$/` as bare selector (no quotes);
    (c) a NAME selector is allowed only if it matches `/^[^"\r\n\0]{1,64}$/` — otherwise
    return `{ok:false, error:'name contains unsafe characters — use the steamId'}`.
    Values substituted into `autoWarnMessage` have `"` stripped. Validate before exec:
    ban interval `/^(0|\d{1,3}[mhdwMy])$/`; slomo finite 0.05–10; teamId ∈ {1,2};
    squadId `/^\d{1,4}$/`; playerId `/^\d{1,6}$/`; changeLayer/setNextLayer argument must
    EXACTLY equal an entry of the cached ListLayers list (else 400). 400s happen before
    audit (nothing executed → nothing to audit).
18. **Sessions**: resolution is a single JOIN (`auth_sessions` × `users`) checking
    `expires_at > now AND users.disabled = 0`; role always read from that row. Any
    change to a user's password/role/disabled calls `destroyUserSessions(targetId)`.
19. **Proxy model**: config gains `web.trustProxy` (default `false`).
    `clientIp(req)` = trustProxy ? last X-Forwarded-For hop : `socket.remoteAddress`.
    `x-forwarded-proto` honored only when trustProxy. Login limiter + stored IPs +
    audit IPs key on `clientIp()`. Limiter map capped at 10k entries, swept per minute.
20. **CSRF exact algorithm** (mutating routes): take `Origin`, else `Referer`;
    absent → 403; literal `null` → 403; `new URL(v).host` must strictly equal
    `req.headers.host` OR the host of `web.publicUrl`. Mutating requests must have
    `Content-Type: application/json`.
21. **Pagination clamps** (one helper): `per = clamp(1..200)`, `page >= 0`,
    `hours <= 720`. Every "[all]" list in §13 becomes `LIMIT 2000` + `total` count and
    a `truncated` boolean.
22. **SSE limits**: api.js attaches ONE bus listener per event type, fanning out to a
    `Set` of client responses. Max 4 concurrent streams per user, 64 global (503 beyond).
    Heartbeat comment `: ping` every 25s; drop clients on write error/backpressure.
    Viewer-role streams do NOT receive admin-channel chat or ADMIN_CAM events.
23. **Viewer intel**: admin-channel chat (`channel='admin'`) and ADMIN_CAM data are
    excluded from every viewer-facing read (SQL WHERE + SSE). `/api/audit` is admin+
    only (viewer gets 403). §12 matrix updated accordingly.
24. **Input caps at ingest**: chat message stored max 480 chars; player name max 64;
    logsource carry buffer max 64 KiB (overflow → discard fragment, count as unparsed,
    resync at next newline).
25. **XSS sinks**: console output, audit `rcon_command`/`rcon_response`, unmatched-line
    samples, flag details, toast bodies are rendered via `textContent` / `<pre>` nodes
    ONLY. api.js sets on every response: `X-Content-Type-Options: nosniff`,
    `Referrer-Policy: no-referrer`, and on HTML:
    `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
    'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com;
    img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'`.
    **Consequence for the frontend: NO inline `<script>`, NO `onclick=`/`on*=`
    attributes anywhere — external .js files and `addEventListener`/delegation only.**
26. **Static serving**: decodeURIComponent once (400 on throw); reject `\0` and any
    `..` segment BEFORE resolve; final check `resolved === pub || resolved.startsWith(pub + path.sep)`;
    whitelist extensions `.html .css .js .svg .png .ico .webmanifest .map .woff2` with an
    explicit MIME table.
27. **Secret redaction**: `REDACT_PATHS = ['squad.rconPassword','log.ftp.password',
    'log.sftp.password','steamApiKey','discordWebhook']` → `'•••'` in /api/settings;
    the same scrub applies to logged error strings/status objects; never log the merged
    config. config.js logs a prominent warning when `log.mode==='ftp' && !log.ftp.secure`.
28. **ListPlayers `ID:`** values are the numeric in-game player ids used by `…ById`
    commands — state keeps them current; they change per connection.
