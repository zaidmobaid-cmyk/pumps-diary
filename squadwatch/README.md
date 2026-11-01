# SquadWatch

Self-hosted admin & stats panel for your **Squad** dedicated server — a BattleMetrics
alternative you run yourself, with deeper Squad-specific intel:

- **Player intelligence** — every player profile tracks kills, deaths, K/D, teamkills
  (given *and* received), revives, suicides, playtime, sessions, name history, IP history
  and alt-account detection (shared IPs), full per-player chat history, and every admin
  action ever taken against them.
- **Troll catcher** — damage to radios and HABs is logged with a friendly/enemy
  classification. Friendly radio damage, TK sprees, mass TKs, and brand-new accounts that
  start teamkilling all raise **flags** that appear instantly on the dashboard (and
  optionally in Discord). No more "who blew up our radio?" mysteries.
- **Match history** — every round with layer, factions, winner, tickets, duration, full
  scoreboard (kills/deaths/TKs/revives/damage per player), kill feed, deployable damage
  log, and the chat that happened during it.
- **Chat archive** — all channels (all/team/squad/admin), searchable, filterable, live.
- **Full admin suite** — warn, kick, ban (with expiry + automatic re-kick enforcement if
  the ban didn't stick), broadcast, force team change, remove from squad, disband squad,
  demote commander, set next layer / change layer now, restart/end match, and a raw RCON
  console with history and autocomplete. Every action is **audit-logged** with the
  verbatim RCON response.
- **Live view** — current teams, squads and players refreshed continuously, population &
  tick-rate graphs, kill/chat feeds, recently-disconnected list (ban the rage-quitters).
- **Multi-admin** — owner/admin/viewer roles, per-action permissions, login rate limiting.

Zero npm dependencies. One Node process. One SQLite file. No build step.

## Requirements

- **Node.js ≥ 22.13** (uses the built-in `node:sqlite`).
- Network access to your Squad server's **RCON** port (default `21114`).
- Access to the server's **`SquadGame.log`** — one of:
  - `local`: SquadWatch runs on the same box as the Squad server (best),
  - `ftp` / `sftp`: your game-server provider's file access (install the one optional
    dependency it tells you about: `npm install basic-ftp` or `npm install ssh2-sftp-client`).

> Why the log file? Squad's RCON alone doesn't expose kills, teamkills, or deployable
> damage — those only exist in the server log. SquadWatch combines both, like SquadJS does.

## Quick start (demo mode — no Squad server needed)

```bash
node server/index.js --demo
```

Open http://localhost:8787, create your owner account, and explore with ~40 simulated
players, live matches, teamkills, a radio griefer, and working admin actions (kicks
actually remove the fake players). Great for trying the UI before wiring up your server.

## Real setup

1. Copy the example config and edit it:

```bash
cp config.example.json config.json
```

2. Set `squad.rconHost`, `squad.rconPort`, `squad.rconPassword` (from your server's
   `Rcon.cfg`), and the `log` section (`mode` + path/credentials).

3. Run it:

```bash
node server/index.js
```

4. Open the panel (default `http://<host>:8787`), create the **owner** account on first
   run, then add your admins under **Users**.

Recovery / headless user creation:

```bash
node server/index.js --create-admin <username> <password> [owner|admin|viewer]
```

### Config reference

See `config.example.json`. Notable options:

| Key | Meaning |
|---|---|
| `log.backfill` | `true` = ingest the existing log from the beginning on first run |
| `log.timezoneOffsetMinutes` | offset if your Squad box's clock isn't UTC |
| `flags.*` | thresholds for TK-spree / mass-TK / new-player-TK flagging |
| `flags.chatWatchlist` | words that flag a player when said in chat |
| `autoWarnTeamkiller` | send an automatic in-game warn on every TK |
| `steamApiKey` | optional — fetches Steam avatars/personas for profiles |
| `discordWebhook` + `webhookEvents` | push flags/bans/kicks to a Discord channel |
| `retention.chatDays` | prune chat after N days (0 = keep forever) |

## Security notes (read this)

- The panel grants real power over your server — **put it behind HTTPS** (Caddy/nginx
  reverse proxy) or keep it on a private network (VPN/Tailscale).
- `config.json` contains your RCON password; it's git-ignored — keep it that way.
- Sessions are httpOnly cookies; mutating requests are origin-checked; logins are
  rate-limited; passwords are scrypt-hashed. Still: don't expose it unprotected.

## Parser health

Squad's log format shifts slightly between game updates. SquadWatch never crashes on an
unknown line — it counts them, and **Settings → Parser health** shows samples so patterns
can be tuned in `server/parser.js`. You can also check any log offline:

```bash
node tools/parse-check.js /path/to/SquadGame.log
```

It reports how many lines matched which event and prints samples of unmatched ones.

## Running as a service (systemd)

```ini
[Unit]
Description=SquadWatch
After=network.target

[Service]
WorkingDirectory=/opt/squadwatch
ExecStart=/usr/bin/node server/index.js
Restart=always
User=squadwatch

[Install]
WantedBy=multi-user.target
```

## Notes & limits

- **Unbanning**: Squad has no RCON unban. Unbanning in SquadWatch deactivates the ban in
  its database (and stops re-kick enforcement); if the ban also landed in the server's
  `Bans.cfg`, remove it there (the Bans page shows the exact line). **Export Bans.cfg**
  generates the file content for all active panel bans.
- Stats begin when SquadWatch starts watching (enable `log.backfill` to ingest the
  current log file's history).
- One Squad server per SquadWatch instance (run two instances for two servers).

## Architecture

```
SquadGame.log ──(local/ftp/sftp tail)──▶ parser ──▶ ingest ──▶ SQLite (data/squadwatch.db)
Squad RCON  ◀──(commands/admin actions)── bus ◀──▶ live state        │
     └──(chat packets, player polls)──────▶ ingest                   ▼
                                       HTTP API + SSE ──▶ browser panel (public/)
```

MIT licensed. Built for server owners; respect your players' privacy and your local laws
when storing IPs and chat.
