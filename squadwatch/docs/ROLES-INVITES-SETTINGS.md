# Custom roles, invites, and in-panel server linking

Feature spec, 2026-11-01. Extends SPEC.md §12 (auth) and §19.3.x amendments; where
this file and SPEC.md conflict, this file wins for the features it covers.

## 1. Custom roles with granular permissions

### Permission catalog (final — the only keys that exist)

| key | grants | builtin min-role |
|---|---|---|
| `view` | read panel data (players, matches, chat, flags, bans, live) | viewer |
| `stream` | SSE live updates | viewer |
| `notes` | add player notes | admin |
| `flags` | review flags, manual flags, watchlist toggle | admin |
| `warn` | warn players | admin |
| `kick` | kick players | admin |
| `ban` | ban/unban, export bans.cfg | admin |
| `broadcast` | server broadcasts | admin |
| `team` | force team change | admin |
| `squad` | disband squad, remove from squad, demote commander | admin |
| `layer` | change/queue layers | admin |
| `match` | restart/end match | admin |
| `ips` | see player IPs + alt detection | admin |
| `adminChat` | admin-channel chat + admin-cam intel | admin |
| `audit` | read audit log | admin |
| `slomo` | slow-motion control | owner |
| `raw` | raw RCON console | owner |
| `users` | manage panel users + invites | owner |
| `roles` | manage roles | owner |
| `settings` | read/write server connection settings | owner |

The legacy coarse key `actions` is **removed**; every route that used it moves to
the fine key listed above. `can(user, perm)`: when `user.perms` is present it is
`user.perms[perm] === true` (unknown keys deny); the legacy min-role matrix stays
as fallback for bare `{role}` users (old tests) and defines builtin role seeds.

### Storage (schema v2)

```sql
CREATE TABLE roles(
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE COLLATE NOCASE,   -- display name, 1-32 chars
  builtin INTEGER DEFAULT 0,         -- 1 for owner/admin/viewer
  perms TEXT,                        -- JSON object {permKey: true}
  created_at INTEGER);
CREATE TABLE invites(
  id INTEGER PRIMARY KEY,
  token_hash TEXT UNIQUE,            -- sha256 hex of the invite token
  role_id INTEGER REFERENCES roles(id),
  created_by INTEGER,
  created_at INTEGER,
  expires_at INTEGER,                -- NULL = no expiry
  used_by INTEGER, used_at INTEGER,  -- single-use
  revoked_at INTEGER);
```

Seed rows `owner`/`admin`/`viewer` (builtin=1) with perms derived from the legacy
matrix. `users` is rebuilt (no declared FKs reference it): `role TEXT CHECK(...)`
column becomes `role_id INTEGER NOT NULL REFERENCES roles(id)`, backfilled by
name. Everywhere the code exposed `user.role` it now exposes the role row's
`name` (builtin names stay lowercase `owner`/`admin`/`viewer`, so existing UI
strings and tests keep meaning). Sessions resolve via triple JOIN
(`auth_sessions → users → roles`), so a role's perms apply to REST requests
immediately after edit.

### Rules

- Builtin roles: name immutable; `owner` perms immutable (always ALL keys true,
  including future ones); `admin`/`viewer` perms editable; none deletable.
- Custom roles: name 1-32 chars unique (NOCASE); perms validated — unknown keys
  rejected; may NOT be granted... nothing: any key is grantable (BM-style full
  flexibility), the owner decides.
- Delete: only when no users and no unused invites reference it (409 otherwise).
- Role perms edit → for every member: `auth.destroyUserSessions(id)` +
  `dropUserStreams(id)` (§19.3.18 pattern — members re-login, SSE cut now).
  The audit row records `permsAdded` / `permsRemoved` key lists.
- **No privilege amplification**: whoever assigns a role (user create/update,
  invite create) must themselves hold every permission that role grants —
  otherwise 403. Owners hold everything, so owners are never constrained;
  a `users`-only holder cannot mint an owner invite.
- `stream` is enforced at `/api/stream` (a role with `view` but not `stream`
  gets REST reads only; the client does not open SSE without it).
- User role change → same revocation (already in hUserUpdate).
- Last-owner protection generalizes: a user may not be demoted/disabled/role-
  changed if they are the last enabled user whose role grants `users` AND
  `roles` AND `settings` (otherwise the panel can lock itself out). The existing
  check in hUserUpdate ("last owner") switches to this predicate.
- Audit actions: `role-create`, `role-update` (changed keys in details),
  `role-delete`.

### API

| route | perm | behavior |
|---|---|---|
| `GET /api/roles` | `users` OR `roles` (read needed by Users UI) | rows: id, name, builtin, perms, members (count), invites (unused count) |
| `POST /api/roles` | `roles` | {name, perms} → create |
| `POST /api/roles/:id` | `roles` | {name?, perms?} → update per rules above |
| `POST /api/roles/:id/delete` | `roles` | delete per rules above |
| `GET /api/perms` | `users` OR `roles` | the catalog with labels/groups for UI |

(POST-for-delete matches the existing API style — the router has no DELETE
routes; CSRF checks cover non-GET.)

## 2. Admin invites

- `POST /api/invites` perm `users`: {roleId, ttlHours (1-720, default 168)} →
  creates single-use invite, returns the **full token once** (never stored
  plaintext): `{id, token, url}`, url = `<publicUrl or request origin>/#/join/<token>`.
  Audit `invite-create` {inviteId, roleId}.
- `GET /api/invites` perm `users`: rows with role name, creator, created/expires,
  state: `unused` / `used` (by whom, when) / `revoked` / `expired`. Never the token.
- `POST /api/invites/:id/revoke` perm `users`: mark revoked (idempotent). Audit
  `invite-revoke`.
- `GET /api/join?token=` **public**, login-limiter on ip: timing-safe lookup by
  sha256; → `{valid, roleName, serverName}` (nothing else leaks).
- `POST /api/join` **public**, login-limiter on ip: {token, username, password} —
  in one tx re-verify unused/unexpired/unrevoked, `createUser` with the invite's
  role, mark used. Then create a session (auto-login, same cookie as /api/login).
  Audit `invite-use` (system, details {inviteId, userId, username}). Errors are
  generic ("invite is no longer valid") except username conflicts.
- Token: `randomTokenHex(32)` like sessions. Length guards as sessions (≤256).

Frontend: `#/join/<token>` route renders a claim form (like setup) — role +
server name shown, username/password/repeat, then straight into the panel.
Users page gets an **Invite** button (modal: role select, expiry select, create →
one-time link with copy button + warning it is shown once) and an Invites table
(state, role, revoke button).

## 3. In-panel server linking (Settings write path)

- `squad.rconHost` validation relaxes to `isString` ('' = **not linked**): boot
  proceeds, RCON client stays idle (no connect loop, status
  `{state:'unconfigured'}`), ingest/logsource likewise idle when their inputs
  are blank. The UI shows "No Squad server linked — open Settings" on the
  dashboard status strip for users with `settings`.
- `PUT` is not in the router's verb set; use `POST /api/settings` perm
  `settings`: body is a partial config patch limited to an allowlist:
  `squad.{rconHost,rconPort,rconPassword}`, `log.{mode,path,pollMs,backfill,
  timezoneOffsetMinutes,ftp.*,sftp.*}`, `web.publicUrl`, `discordWebhook`,
  `steamApiKey`, `webhookEvents.*`, `flags.*`, `autoWarnTeamkiller`,
  `autoWarnMessage`, `retention.*`. Never: `web.host/port/secureCookies/
  trustProxy`, `dbPath`, `demo` (those stay file-only; changing listen addr from
  the web is a footgun).
  - Secrets (`rconPassword`, ftp/sftp passwords, `steamApiKey`,
    `discordWebhook`): omitted/`null` = keep stored value; `""` = clear; the
    sentinel never echoes back.
  - Validate the patched config with the SCHEMA before anything else (reuse
    config.js validators; respond 400 with the problems list — already
    secret-redacting).
  - Persist: read current `config.json` (the sparse user file; `{}` if absent),
    deep-apply the patch, write pretty JSON atomically (tmp + rename). In
    `--demo` mode `POST /api/settings` is 403 ("demo settings are fixed") — the
    demo must stay reproducible.
  - Apply live: `reconfigure(cfg)` in index.js — stop rcon + logsource (+their
    pollers), rebuild them with the new cfg, rewire ingest/state listeners
    exactly as boot does (the wiring moves into a `startSources(cfg)` function
    boot and reconfigure share). The web server, db, auth, SSE clients are
    untouched. Audit `settings-update` with the list of changed key paths only
    (never values).
- `POST /api/settings/test` perm `settings`: {rconHost, rconPort, rconPassword?
  (null = stored; '' = genuinely empty, matching save semantics)} → one-shot
  RCON connect + `ShowServerInfo`, never touching the live client: → `{ok,
  serverName?, players?, error?}`. Audit `settings-test` (host:port only).
  Also `{log:{mode,...}}` variant: local = fs.stat the path; ftp/sftp =
  connect+stat if the optional dep is installed, else `{ok:false,
  error:'install basic-ftp / ssh2-sftp-client'}`.
- Hardening (post-review): saving `log.mode` ftp/sftp is refused up front when
  the optional package is missing (nothing applied or persisted); a log source
  that fails to start never crashes boot (error goes to the status strip);
  `persistUserConfig` refuses to rewrite an unreadable/invalid `config.json`
  (surfaced as `persistError`; the live change still applies), writes 0600 for
  new files and preserves the existing file's mode; the old logsource instance
  is fully detached on swap so it can neither double-ingest nor overwrite the
  new source's status. A failed write's text (scrubbed of secrets) goes to
  the caller only: the `settings-update` audit row, which roles without
  `settings` read, records `persistError: 'config.json not written — see the
  panel log'`.
- GET /api/settings already returns `redactedConfig()` + status — it gains
  `editable: <the allowlist tree>` metadata? No — the frontend hardcodes the
  form; GET just keeps serving current (redacted) values, now including which
  secrets are set (`rconPassword: true/false` style flags inside `config.secrets`).

Settings UI (owner): "Server connection" card — RCON host/port/password
(password field placeholder "•••• saved" when set), **Test connection** button
with inline result, log source mode selector with per-mode fields, Save.
"Integrations" card — Discord webhook, Steam API key, webhook event toggles.
"Panel" card — publicUrl, retention, flag thresholds, auto-warn. Save applies
live; toast on success; status strip reflects the new connection within seconds.

## 4. Mode switch (demo → real)

- `.claude/launch.json` gains a `squadwatch` (real mode) config on port 8790;
  demo stays available via `--demo`.
- Real first boot with no `config.json`: index.js currently exits — instead,
  when `--setup` ... no: keep it simple, ship a starter `config.json` (copy of
  example with `rconHost: ""`, `log.path: ""`, sensible comments impossible in
  JSON — README section instead). First run prints the setup token (console
  only, §19.3.15 unchanged) — the local session surfaces it to the user.

## 5. Tests (new)

- `roles.test.js`: migration v2 on a v1 db (seeded users keep working, role
  names/ids backfilled); can() with custom perms; role CRUD incl. builtin
  protections, delete-with-members 409, last-admin-capable protection; perms
  edit revokes member sessions/streams.
- `invites.test.js`: full lifecycle (create → peek → join → session works with
  role perms; reuse → 4xx; expired; revoked; bad token timing-safe; limiter).
- `settings.test.js`: POST validate/allowlist/secret-keep-clear semantics;
  config.json written sparse+pretty; reconfigure swaps RCON to a second
  MockSquad live (ingest keeps flowing); test endpoint ok + failure paths;
  demo-mode 403.
- integration.test.js gains: owner creates custom role + invite, second HTTP
  client joins via invite, exercises a granted perm (kick) and is 403'd on a
  denied one (raw), owner edits role → member's SSE drops + session invalid.
