# Batch 3 contracts — evidence, notes, templates, remote ban list, scheduler, admin calls, join alerts

Binding interface spec for this round's workstreams. ALREADY DONE by the lead
(do not redo): schema v6 (`bans.note`, `evidence`, `scheduled_tasks`,
`admin_calls`, settings key `reasonTemplates` seeded, BattleMetrics "[note]"
suffixes migrated into `bans.note`), config blocks (`evidence`,
`remoteBanList`, `adminCalls`, `joinAlerts` — defaults, validation,
SETTINGS_ALLOW, `remoteBanList.key` secret), api.js plumbing (route opt
`{rawBody:true}`, the extension registry, `banRow` note/evidenceCount, audit
rows' `evidenceCount`, ban create `note` + `actionId`, warn/kick `actionId`,
SSE `admincall`/`alert` relays + gating, AUDIT_ACTIONS), admin.js `auditId`,
placeholder modules + index.js wiring.

## §0 Module shape (all six feature modules)

`server/<module>.js` exports a factory called with
`deps = { db, config /* the LIVE cfg object */, log, bus, state, admin, auth, webhook, dataDir, settings: { apply(patch) } }`
and returns `{ registerRoutes(api), start(), stop() }`.

`api` = `{ route, json, ApiErr, strBody, intParam, clampInt, scrubText, sseBroadcast, cappedAll, doAdmin, auth, db, state, bus, admin, cfg }`.
- `route(method, regex, opts, handler)` — opts `{perm}`, `{anyPerm:[...]}`, `{public:true}`, and `{rawBody:true}` (POST body NOT parsed; CSRF still checked; handler streams `ctx.req`).
- handler `ctx = { req, res, params, query /* URLSearchParams */, ip, user, token, body }`; throw `new api.ApiErr(status, msg)` for errors.
- Audit: `auth.audit(userIdOrNull, action, { targetPlayerId, details })` (returns row id). Action names already allowed in the audit filter: evidence-upload, evidence-delete, ban-note-update, templates-update, remote-bans-rotate, remote-bans-update, schedule-create, schedule-update, schedule-delete, scheduled-run, admin-call-reply, admin-call-handled, join-alert-kick.
- `settings.apply(patch)` persists + applies a config patch exactly like POST /api/settings (only SETTINGS_ALLOW paths).
- RCON: `admin.execRaw(userOrNull, command, { action, targetPlayerId, details })` — audited, returns `{ ok, rconOk, response, auditId }`.
- Never send user text into RCON without `sanitizeRconArg` (server/util.js); never let a module crash the process (catch in timers/listeners).

## §1 Evidence (module `evidence.js`)

Files attached to a ban (`target_type 'ban'`, `target_id` = bans.id) or an admin
action (`'action'`, admin_actions.id whose action is warn|kick|ban).
- Storage: `<dataDir>/evidence/<sha256>.<ext>` (content-addressed, deduped).
- `POST /api/evidence?targetType=ban|action&targetId=N&filename=<urlenc>&caption=<urlenc, optional>` — `{rawBody:true}`, anyPerm warn/kick/ban, then per target: ban → `ban`; action → the perm named by the action (warn/kick/ban). Streams to a temp file while hashing; enforces `config.evidence.maxMB` (Content-Length precheck AND streamed count → 413, temp deleted); max 20 live files per target.
  Type is decided by MAGIC BYTES, never by headers or extension: PNG, JPEG, GIF, WEBP, MP4/MOV (ftyp), WEBM/MKV (EBML 1A45DFA3), PDF (%PDF-), plain text (valid UTF-8, no NUL, ≤ 2 MB) — everything else (SVG, HTML, scripts, archives, executables) → 415.
  Response `{ ok, evidence: { id, targetType, targetId, filename, mime, size, caption, uploadedBy, uploader, uploadedAt, url } }`. Audit `evidence-upload` {targetType, targetId, filename, size, sha256}.
- `GET /api/evidence?targetType=..&targetId=..` (anyPerm ban/kick/warn/audit) → `{ rows }`.
- `GET /api/evidence/:id/file` (anyPerm ban/kick/warn/audit) — streams with headers: sniffed `Content-Type`; `Content-Disposition` inline for images/video, attachment otherwise (RFC 5987 filename); `X-Content-Type-Options: nosniff`; `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'`; `Cache-Control: private, max-age=3600`; single-range `Range` support for video seeking.
- `POST /api/evidence/:id/delete` (the uploader, or a holder of BOTH `ban` and `settings`) — soft delete; the file is removed from disk when no live row references its sha256. Audit `evidence-delete`.
- `POST /api/bans/:id/note` (perm `ban`) `{ note }` (≤ 2000, control chars stripped) → updates `bans.note`. Audit `ban-note-update`. (Private: already only emitted to `ban` holders by banRow.)
- BattleMetrics import (`battlemetrics.js`): write the BM note into `bans.note`, NOT into `reason` (the v6 migration moved existing ones).

## §2 Reason templates (module `templates.js`)
Settings key `reasonTemplates` = `[{ id, kind: 'warn'|'kick'|'ban', label, reason, interval? }]` (`interval` only for ban; INTERVAL syntax of server/admin.js).
- `GET /api/reason-templates` (anyPerm warn/kick/ban/settings) → `{ rows }`.
- `POST /api/reason-templates` (perm `settings`) `{ rows }` — ≤ 60 rows; id `/^[a-z0-9-]{1,40}$/` unique; label 1–40; reason 1–480 with no CR/LF/NUL; ban interval must parse. Audit `templates-update`.

## §3 Remote ban list (module `remotebans.js`)
Squad reads ban files from URLs listed in the game server's `RemoteBanListHosts.cfg`.
- `GET /api/remote/bans.cfg?key=K` — `{public:true}`. If `remoteBanList.enabled` is false or K mismatches (timing-safe) → 404 (same body either way). Rate limit 30/min per client address. Body: one line per active, unexpired ban — `<SteamID64>:<expiry unix seconds | 0> //<reason>` (reason only, NEVER the note; CR/LF stripped) — plus EOS-id lines in the same format when `remoteBanList.includeEos` is true. `Content-Type: text/plain; charset=utf-8`, `Cache-Control: no-store`. Record last fetch time + client address (in memory) for the status view.
- `GET /api/remote-bans` (perm `settings`) → `{ enabled, includeEos, url /* full URL incl. key, or null */, lines, skippedNoSteam, lastFetchAt, lastFetchFrom }` (url built from `web.publicUrl`).
- `POST /api/remote-bans/rotate` (perm `settings`) → new key `crypto.randomBytes(24).toString('base64url')`, persisted via `settings.apply({ remoteBanList: { key } })` → `{ url }`. Audit `remote-bans-rotate` (never log the key).
- `POST /api/remote-bans` (perm `settings`) `{ enabled?, includeEos? }` → applied via `settings.apply`; enabling with no key generates one. Audit `remote-bans-update`.

## §4 Scheduler (module `scheduler.js`)
Table `scheduled_tasks` (v6). `payload` / `schedule` / `conditions` are JSON:
- kinds: `broadcast` `{ message }` · `command` `{ command }` (creating/editing requires `raw` as well as `settings`) · `countdown` `{ action: 'restartMatch'|'endMatch', steps: [minutes…], message }` (message may use `{m}`; broadcasts at each step, then runs the action via `admin.execAdmin(null, action, {})`).
- schedule: `{ type: 'interval', everyMinutes /* 5–1440 */ }` · `{ type: 'daily', times: ['HH:MM', …] /* server local time */ }` · `{ type: 'once', at /* epoch ms */ }`.
- conditions (optional): `{ minPlayers?, maxPlayers? }` against the live player count; unmet → skipped (recorded).
- Message placeholders: `{players} {maxPlayers} {layer} {nextLayer} {time}`.
- Engine: a 15 s tick (unref'd); due tasks run through `admin.execRaw(null, 'AdminBroadcast …' | command, { action: 'scheduled-run', details: { taskId, name } })`; RCON down → skipped and retried next due time; `last_run_at`, `next_run_at`, `last_result` updated; `once` tasks disable themselves after running. Never runs two instances of the same task concurrently.
- Routes (perm `settings`): `GET /api/schedules` → `{ rows }`; `POST /api/schedules` (create); `POST /api/schedules/:id` (update); `POST /api/schedules/:id/delete`; `POST /api/schedules/:id/run` (run now). Audits schedule-create/update/delete.

## §5 Admin calls (module `admincalls.js`)
- Listens to the bus `chat` event (see ingest.js for its exact payload). A message whose trimmed text starts with any `adminCalls.triggers` entry (case-insensitive, word boundary) from a player, when `adminCalls.enabled`, becomes a call — at most one per player per `adminCalls.cooldownSec`.
- Inserts `admin_calls`; emits bus `admin-call` with `{ id, time, status, playerName, playerDbId, eosId, steamId, message, handledBy, handledAt }` (api relays it as SSE `admincall` to people who can act).
- In-game reply: `AdminWarnById <in-game id> <reply>` (in-game id from live state; fall back to `AdminWarn "<eosId>" …`), audited `admin-call-reply`.
- Discord: `webhook.postAdminCall({ ...call, roleId: adminCalls.discordRoleId })` — content mentions `<@&roleId>` when set, with `allowed_mentions: { roles: [roleId] }`.
- Routes: `GET /api/admin-calls?status=open|all` (anyPerm flags/warn/kick/ban) → `{ rows, open }`; `POST /api/admin-calls/:id/handle` (same perms) → status handled + bus `admin-call` update. Audit `admin-call-handled`.

## §6 Join alerts (module `joinalerts.js`)
- Listens to bus `player-connected` (log AND roster paths emit it; see ingest.js for the payload).
- Checks (each behind its `joinAlerts.*` toggle): `watchlist` (players.watchlisted = 1), `flagged` (≥ 1 unreviewed flag), `banEvasion` (the joining player shares an IP in `player_ips` with a player under an active, unexpired ban — only possible when an IP is known).
- Each hit: a `flags` row (types `watchlist-join` sev 1, `flagged-join` sev 1, `ban-evasion` sev 3; details JSON with the reason and, for evasion, the banned player's id/name and ban id — never the raw IP) plus bus `flag` in the same shape ingest uses (so the Trolls inbox and the Discord flag webhook pick it up), and bus `join-alert` `{ type, time, player: { dbId, name }, details }` (SSE `alert`). One alert per player per type per 10 min.
- `joinAlerts.autoKickEvasion` true → kick the evader (`AdminKickById`, or `AdminKick <steamId>`), audited `join-alert-kick`.
- The evasion link (banned player id/name, ban id) is for the `ips` permission only: without it, ban-evasion flag details (every flag list, SSE `flag`/`alert`) are `{ reason, redacted: true }` and `join-alert-kick` audit details (GET /api/audit) `{ flagId, reason, redacted: true }`.
- Join-alert flags record a connection, not behaviour: the Trolls "repeat offenders" board does not count them.
- `webhook.postJoinAlert(alert)` for watchlist/flagged hits (evasion goes through the flag webhook).

## §7 UI (consumes §1–§6 exactly)
Builder F1 — app.js, views.js, css/shell.css, css/views.css:
- `SW.live` subscribes to `admincall` and `alert`. Global toasts + a short WebAudio chime (no audio files; mute toggle stored per browser) for new admin calls and join alerts. Topbar bell with the open admin-call count and a dropdown (message, player, time, Handle). Dashboard "Admin calls" card.
- Warn / Kick / Ban dialogs (SW.actions): reason-template picker (kind-filtered; a ban template also sets the duration), private note field on Ban, evidence attach (multi-file picker + drag-and-drop, client-side type/size precheck mirroring §1, upload after the action succeeds using `actionId` / `ban.id`, progress per file, retry on failure).
- Shared components: `SW.ui.evidenceUploader({ targetType, targetId })` and `SW.ui.evidenceList({ targetType, targetId })` (thumbnails for images, inline video player, file chips for PDF/text, lightbox, delete when allowed).
- Player profile: bans show the private note (when present) and their evidence; the actions/history list shows evidence counts with the viewer.
- Nav: add `{ route: 'automation', label: 'Automation', icon: 'clock', perm: 'settings' }` (System group). Flag labels for the new flag types.
Builder F2 — views-admin.js, css/admin.css:
- Bans page: private note (view + edit via `POST /api/bans/:id/note`, `ban` perm), evidence count badge + viewer + uploader per ban.
- Audit page: evidence count + viewer on warn/kick/ban rows; attach evidence afterwards.
- Settings: Reason templates editor; Remote ban list card (enable, include EOS, rotate key, copy URL, step-by-step: open the game server's `SquadGame/ServerConfig/RemoteBanListHosts.cfg` in the host's file manager, add the URL on its own line, restart); Admin calls card (enable, triggers, Discord role id with how-to, reply text, cooldown); Join alerts card (toggles, auto-kick evasion with a warning); Evidence card (max MB).
- `SW.routes.automation` (perm `settings`): scheduled tasks table (name, kind, schedule summary, conditions, enabled toggle, last run + result, next run, Run now, Edit, Delete) and a create/edit modal for all kinds/schedule types with live preview of the broadcast text.
