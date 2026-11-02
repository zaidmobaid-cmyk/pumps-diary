# Contracts for the layers / quick-commands / BattleMetrics / UI round

Binding interface spec shared by the four workstreams of this round. Each
workstream implements its side exactly; nobody changes a shape here without
the others. Ground truth gathered from the owner's live server (Squad +
"SUPERMOD", RCON `ListCommands 1`, 2026-11-02):

- `AdminChangeLayer <LayerName Faction1+Type Faction2+Type>` (travel now)
- `AdminSetNextLayer <LayerName Faction1+Type Faction2+Type>` (after match)
- `ListLayers` → 519 entries; vanilla `Sumari_AAS_v1`, modded entries carry the
  workshop id: `SU_Sumari_Seed_v1 (3293347373)`. The real layer name is the
  part before ` (`. `ShowCurrentMap` → `Current level is SPM | Sumari Bala,
  layer is SU_Sumari_Seed_v1, factions SU_IDF+Combined SU_PALINS`;
  `ShowNextMap` → `Next level is SPM | Kokan, layer is SU_Kokan_Invasion_v1,
  factions SU_USA SU_AFINS` (a faction may come without `+Type`).
- `DebugPrintFactionsList` prints to the server log, NOT to RCON (returns
  empty) — faction combos must be learned from ShowCurrentMap/ShowNextMap.
- Toggle commands exist and are spelled: `AdminNoRespawnTimer <0|1>`,
  `AdminForceAllRoleAvailability <0|1>`, plus AdminForceAllVehicleAvailability,
  AdminForceAllDeployableAvailability, AdminForceAllActionAvailability,
  AdminNoTeamChangeTimer, AdminDisableVehicleClaiming,
  AdminDisableVehicleTeamRequirement, AdminDisableVehicleKitRequirement,
  AdminAlwaysValidPlacement, AdminSetFogOfWar.

## 1. Layers & factions (backend: "layers" workstream)

- `GET /api/layers` (perm `view`) → `{ layers: string[], layerInfo: LayerInfo[], cachedAt }`.
  `layers` stays an array of plain names (backward compatible) — now with the
  ` (modid)` suffix STRIPPED and de-duplicated. `LayerInfo = { name, modId|null,
  level, mode }` (`level`/`mode` parsed best-effort from the name, e.g.
  `SU_Sumari_Seed_v1` → level `Sumari`, mode `Seed`, `mod: true`).
- `GET /api/factions` (perm `layer`) → `{ known: [{ code, mod }], types: string[],
  combos: { [layerName]: [{ team1, team2, count, lastSeen }] }, current:
  { layer, team1, team2 } | null, next: { layer, team1, team2 } | null }`.
  `known` = built-in vanilla Squad faction codes (ADF BAF CAF IMF INS MEA PLA
  PLAAGF PLANMC RGF TLF USA USMC VDV WPMC) ∪ every faction code ever seen on
  this server (strip `+Type`). `types` = built-in unit types (CombinedArms
  LightInfantry Mechanized Motorized Armored Support AirAssault
  AmphibiousAssault Combined) ∪ seen. `combos` learned from polling.
- `POST /api/admin/changeLayer` (perm `layer`) body `{ layer, now: bool,
  team1?: string, team2?: string }`. Layer matched case-insensitively against
  the stripped list and normalized to its exact name (404-style 400
  "unknown layer — pick one from the list" otherwise). Factions: both or
  neither; each must match `/^[A-Za-z0-9_]{1,48}(\+[A-Za-z0-9_]{1,48})?$/`.
  Sends `AdminChangeLayer|AdminSetNextLayer <layer>[ <team1> <team2>]`.
  Response `{ ok, rconOk, rconResponse, command }` (command echoed for the UI).
  Audit details include layer + factions.
- Learning: the ShowCurrentMap/ShowNextMap pollers capture the `factions`
  suffix; every distinct (layer, team1, team2) is upserted into the v5 table
  `layer_factions(layer, team1, team2, count, last_seen)`.

## 2. Quick commands (backend: "layers" workstream)

- Stored in the `settings` table under key `quickCommands` (JSON array).
  Item: `{ id, label, command, toggle }` — `toggle: true` means `command` is a
  single bare command that takes `1`/`0` (UI shows ON / OFF); `toggle: false`
  means `command` runs as written (UI shows one Run button).
- v5 migration seeds the defaults (owner's request):
  `[{ id: 'no-respawn-timer', label: 'No respawn timer', command: 'AdminNoRespawnTimer', toggle: true },
    { id: 'all-roles', label: 'All roles available', command: 'AdminForceAllRoleAvailability', toggle: true }]`
- New permission key `quickcmd` — label "Run quick commands", group
  "Server control". Builtin `owner` AND `admin` roles get it (the v5 migration
  must add it to both stored role rows — owner perms are seed data, there is
  no implicit all-keys bypass). `viewer` does not.
- `GET /api/quick-commands` (anyPerm `quickcmd`, `raw`, `settings`) →
  `{ rows: QuickCommand[], last: { [id]: { value: 0|1|null, by, at } } }` —
  `last` from the audit log (most recent run per id).
- `POST /api/quick-commands/:id/run` (perm `quickcmd`) body `{ value?: 0|1 }`
  (required for toggles) → `{ ok, rconOk, rconResponse, command }`. Audited as
  `quick-command` with `{ id, label, command }`.
- `POST /api/quick-commands` (perm `settings`) body `{ rows }` — replaces the
  list. Validation: ≤ 30 rows; id `/^[a-z0-9-]{1,40}$/` unique; label 1–40;
  command `/^[A-Za-z][A-Za-z0-9_]{2,63}( [^\r\n\0]{1,200})?$/`; toggle rows must
  be a single bare token (no args). Audited `quick-commands-update`.

## 3. BattleMetrics ban import (backend: "battlemetrics" workstream)

- Config (config.js SCHEMA + SETTINGS_ALLOW; token in SECRET_PATHS):
  `battlemetrics: { token: '', banListId: '', autoSync: false, syncHours: 6 }`.
- `server/battlemetrics.js` exports `createBattlemetrics({ db, config, log, bus, admin })`
  → `{ listBanLists(), importNow({ banListId? }), status(), start(), stop(), reconfigure() }`:
  - `listBanLists()` → `[{ id, name, banCount|null }]` for the saved token.
  - `importNow()` → `{ fetched, imported, updated, deactivated, skippedNoIdentifier, errors: string[] }`.
    Mirrors every BattleMetrics ban into the `bans` table with
    `source = 'battlemetrics'`, `external_id = <BM ban id>`, `steam_id`,
    `eos_id`, reason (the BM note goes to `bans.note` — BATCH3-CONTRACTS §1),
    `issued_at`, `expires_at` (null = permanent), `active`. Re-import updates
    in place (unique (source, external_id)); bans that are gone from the list
    or expired on BM are deactivated — only rows with `source='battlemetrics'`
    are ever touched. Creates stub `players` rows when unknown (name from BM).
  - `status()` → `{ configured, running, lastSyncAt, lastResult, nextSyncAt }`.
  - `start()/stop()` manage the auto-sync timer; `reconfigure()` re-reads config.
- Schema v5 (written by the LAYERS workstream in db.js so migrations stay
  ordered) adds to `bans`: `eos_id TEXT`, `source TEXT`, `external_id TEXT`,
  indexes on `eos_id` and unique `(source, external_id)`.
- Enforcement (battlemetrics workstream, ingest.js): on EVERY player connect —
  log path AND roster-poll path — any active, unexpired ban matching the
  player's steam id OR eos id (or player id) gets an immediate kick with the
  ban reason, audited as `ban-enforce`, at most once per player per 60 s.
- API (written by the LAYERS workstream as thin wrappers over `deps.battlemetrics`):
  `GET /api/battlemetrics/status` (perm `settings`), `GET /api/battlemetrics/ban-lists`
  (perm `settings`), `POST /api/battlemetrics/import` (anyPerm `settings`, `ban`)
  body `{ banListId? }` → importNow result; audited `bm-import`.
  `GET /api/bans` rows gain `source` and `eosId`.

## 4. UI (frontend workstream) — see the brief; consumes §1–§3 exactly.
