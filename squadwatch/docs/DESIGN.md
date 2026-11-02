# A3 Admin — design system

Binding spec for the A3 Admin UI (public/). The product was "SquadWatch"; every
user-visible string now says **A3 Admin** (wordmark: "A3" + "ADMIN"). Internal
identifiers stay (package name, file names, `sw_session` cookie, `sw:` storage
keys, `window.SW`) so sessions and preferences survive.

The goal is a panel that looks designed, not generated: a tactical **night-ops
command console** — calm, precise, dense where it matters, with one signature
accent. Avoid every stock-dashboard tell: no Inter, no generic blue primary,
no bubbly 12px radii, no soft drop shadows on every card, no rainbow badges.

## 1. Identity

- **Mark**: the A3 Community logo — faceted gold "A" + faceted silver "3" —
  as transparent PNGs in `public/brand/` (`a3-mark.png` 401×287 for large
  uses like the auth screens, `a3-mark-sm.png` 134×96 for the sidebar/topbar,
  favicons and an apple-touch icon). Never recolor, outline or crop the mark.
  On the light theme the silver "3" disappears against white, so the mark gets
  a hairline drop-shadow there (`filter: drop-shadow(...)`) to keep its edge.
- **Wordmark**: the mark itself reads "A3"; next to it sits `ADMIN` in Chakra
  Petch 600, `--text`, letter-spacing .2em — the lockup reads "A3 ADMIN".
  Auth screens may add a small `COMMUNITY` caption in `--gold`.
- **Brand gold**: sampled from the logo — `#E3BD22`. It replaces the amber
  in §3 wherever amber appears (`--accent`, `--logo`, `--gold*`, glows,
  banners, chart queue, console accent, selection).
- **Signature details** (use sparingly; they ARE the brand):
  1. *Command grid*: the app background carries a faint 32px grid plus a soft
     amber glow top-left (§3).
  2. *HUD brackets*: L-shaped corner brackets on hero surfaces only — stat
     tiles, the auth card, the empty "no server linked" state. Class `.hud`.
  3. *Signal tick*: card/section titles get a 3×12px amber bar before the label.
  4. *Data in Chakra Petch*: big numbers (stat values, scores) use the display
     face with tabular figures.

## 2. Type

| Role | Family | Size / weight | Notes |
|---|---|---|---|
| Display (brand, page titles, stat values) | `--display`: 'Chakra Petch' | page title 22/600; stat value 26/600; brand 16/700 | `font-variant-numeric: tabular-nums` on values |
| UI / body | `--font`: 'IBM Plex Sans' | 14/400 body, 13 secondary, 500 for names, 600 for emphasis | line-height 1.5 body, 1.3 dense rows |
| Labels (card titles, table heads, stat labels) | `--font` | 11/600, uppercase, letter-spacing .12em, `--dim` | |
| Mono (ids, weapons, timestamps, paths, RCON) | `--mono`: 'IBM Plex Mono' | 12/400–500 | |

Google Fonts URL (CSP already allows it):
`https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap`

## 3. Color tokens

Dark is the DEFAULT (no attribute). Light ("Daylight") lives under
`:root[data-theme="light"]`. Token NAMES are unchanged from the old stylesheet
so every rule keeps working; only values change, plus the new tokens marked NEW.

### Dark (default)
```
--bg #0A0D11            --bg-grid rgba(120,160,200,.035) NEW   --bg-glow rgba(227,189,34,.06) NEW
--panel #10151B         --panel2 #151B23          --raise #1B232D       --overlay-bg #121820
--line rgba(148,170,196,.10)   --line-strong rgba(148,170,196,.20)
--row-line rgba(148,170,196,.07)   --row-hover rgba(148,170,196,.05)   --feed-stripe transparent
--text #E6EDF5          --dim #8D9AAB             --faint #5C6878
--accent #E3BD22  --accent-hover #EDCB45  --accent-contrast #171303        (primary actions, active nav)
--accent2 #5AB0FF --accent2-soft rgba(90,176,255,.12) --accent2-border rgba(90,176,255,.40)  (links, info, focus ring)
--logo #E3BD22  --gold #E3BD22  --gold-soft rgba(227,189,34,.12)  --gold-border rgba(227,189,34,.40)
--red #FF5D5D --red-hover #FF7373 --red-contrast #FFFFFF --red-text #FF8A8A --red-soft rgba(255,93,93,.12) --red-border rgba(255,93,93,.40) --red-glow rgba(255,93,93,.55)
--green #34D399 --green-text #5EE6B0 --green-soft rgba(52,211,153,.12) --green-border rgba(52,211,153,.40) --green-glow rgba(52,211,153,.60)
--purple #B794F6 --purple-soft rgba(183,148,246,.12) --purple-border rgba(183,148,246,.40)
--team1 #4FA3FF --team1-soft rgba(79,163,255,.10) --team1-border rgba(79,163,255,.40)
--team2 #FF7A59 --team2-soft rgba(255,122,89,.10) --team2-border rgba(255,122,89,.40)
--btn-bg #18202A --btn-hover-bg #1F2834 --input-bg #0C1015 --chip-bg #18202A --code-bg #0C1015
--nav-hover-bg rgba(148,170,196,.06) --nav-active-bg rgba(227,189,34,.10) --nav-active-text #F5F8FB
--chart-line #5AB0FF --chart-fill rgba(90,176,255,.14) --chart-queue rgba(227,189,34,.75) --chart-grid rgba(148,170,196,.08) --chart-label #5C6878
--tk-bg rgba(255,93,93,.07) --radio-bg rgba(183,148,246,.07) --alert-bg rgba(227,189,34,.06) --alert-border rgba(227,189,34,.28)
--banner-bg rgba(227,189,34,.09) --banner-border rgba(227,189,34,.30) --banner-text #F0D36A
--console-bg #070A0D --console-line #1A222C --console-text #D7E1EC --console-dim #5C6878 --console-accent #E3BD22 --console-err #FF7373
--backdrop rgba(4,6,9,.72) --selection rgba(227,189,34,.28) --scrollbar #222B36 --scrollbar-hover #2F3A47 --dot-ring rgba(255,255,255,.05)
--shadow 0 24px 48px -12px rgba(0,0,0,.65), 0 0 0 1px rgba(148,170,196,.10)
--shadow-card inset 0 1px 0 rgba(255,255,255,.025)
--auth-glow1 rgba(227,189,34,.10) --auth-glow2 rgba(90,176,255,.06)
```

### Light — "Daylight" (`:root[data-theme="light"]`)
Warm stone neutrals, not cold slate. Same roles; amber is deepened for contrast.
```
--bg #F2F2EE --bg-grid rgba(40,48,40,.045) --bg-glow rgba(201,162,15,.07)
--panel #FFFFFF --panel2 #F7F7F3 --raise #ECECE6 --overlay-bg #FFFFFF
--line rgba(28,32,24,.10) --line-strong rgba(28,32,24,.20) --row-line rgba(28,32,24,.07) --row-hover rgba(28,32,24,.035) --feed-stripe transparent
--text #12151A --dim #5B636D --faint #8E959D
--accent #D9B01A --accent-hover #C9A20F --accent-contrast #1A1503
--accent2 #1F6FEB --accent2-soft rgba(31,111,235,.09) --accent2-border rgba(31,111,235,.35)
--logo #C9A20F --gold #8C6D00 --gold-soft rgba(201,162,15,.12) --gold-border rgba(201,162,15,.40)
--red #D93636 --red-hover #BF2727 --red-contrast #FFFFFF --red-text #B42323 --red-soft rgba(217,54,54,.09) --red-border rgba(217,54,54,.35) --red-glow rgba(217,54,54,.35)
--green #13A36A --green-text #0D7F52 --green-soft rgba(19,163,106,.10) --green-border rgba(19,163,106,.38) --green-glow rgba(19,163,106,.45)
--purple #7C4DDB --purple-soft rgba(124,77,219,.08) --purple-border rgba(124,77,219,.35)
--team1 #1F6FEB --team1-soft rgba(31,111,235,.08) --team1-border rgba(31,111,235,.38)
--team2 #D9480F --team2-soft rgba(217,72,15,.09) --team2-border rgba(217,72,15,.40)
--btn-bg #FFFFFF --btn-hover-bg #F2F2EE --input-bg #FFFFFF --chip-bg #F2F2EE --code-bg #F7F7F3
--nav-hover-bg rgba(28,32,24,.05) --nav-active-bg rgba(201,162,15,.12) --nav-active-text #12151A
--chart-line #1F6FEB --chart-fill rgba(31,111,235,.10) --chart-queue rgba(201,162,15,.70) --chart-grid rgba(28,32,24,.07) --chart-label #8E959D
--tk-bg rgba(217,54,54,.06) --radio-bg rgba(124,77,219,.06) --alert-bg rgba(201,162,15,.07) --alert-border rgba(201,162,15,.30)
--banner-bg rgba(201,162,15,.10) --banner-border rgba(201,162,15,.35) --banner-text #6E5600
(console tokens: identical to dark — the console is a dark terminal in both themes)
--backdrop rgba(18,21,26,.40) --selection rgba(201,162,15,.22) --scrollbar #D3D3CC --scrollbar-hover #B5B5AD --dot-ring rgba(18,21,26,.06)
--shadow 0 24px 48px -16px rgba(18,21,26,.22), 0 0 0 1px rgba(28,32,24,.08)
--shadow-card 0 1px 0 rgba(28,32,24,.04)
--auth-glow1 rgba(201,162,15,.12) --auth-glow2 rgba(31,111,235,.06)
```

### Shape, space, motion (both themes)
```
--radius 8px (cards, modals)   --radius-s 5px (controls, chips)   --radius-xs 3px (badges)  NEW
--display 'Chakra Petch', 'IBM Plex Sans', system-ui, sans-serif   NEW
--font 'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', sans-serif
--mono 'IBM Plex Mono', ui-monospace, 'SF Mono', Consolas, monospace
--ease cubic-bezier(.2,.7,.2,1)   --dur-1 120ms   --dur-2 180ms   --dur-3 260ms   NEW
--sidebar-w 236px   --sidebar-w-min 64px   --topbar-h 56px
spacing scale: 4 · 8 · 12 · 16 · 20 · 24 · 32 (px) — nothing off-scale
```

## 4. Surfaces & elevation

- **App background**: `--bg` + grid (`background-image: linear-gradient(var(--bg-grid) 1px, transparent 1px), linear-gradient(90deg, var(--bg-grid) 1px, transparent 1px); background-size: 32px 32px;`) + `radial-gradient(1200px 600px at 0% 0%, var(--bg-glow), transparent 60%)`. Applied to the scrolling main area, fixed (does not scroll with content).
- **Cards**: `--panel`, 1px `--line` border, `--radius`, `--shadow-card` (an inner top highlight — "machined", not floating). Hover state only on interactive cards: border → `--line-strong`.
- **Overlays** (modals, popovers, toasts): `--overlay-bg`, `--shadow`, 1px border.
- **Sidebar**: `--panel` with a right hairline; **topbar**: translucent panel (`color-mix(in srgb, var(--panel) 82%, transparent)` + `backdrop-filter: blur(14px) saturate(140%)`), bottom hairline, sticky.

## 5. Components

- **Page head** (`.page-head`): left = `.page-title` (display 22/600) + optional `.page-sub` (13, `--dim`); right = `.page-actions` (buttons/filters). 24px below. Every page uses it.
- **Card title** (`.card-title`): label style (§2) with the amber signal tick; actions float right in the same row; 12px below.
- **Stat tile** (`.stat`/`.stat-card`, existing classes): label on top, value below in display 26/600 tabular, optional sub-line 12 `--dim`; icon chip top-right 28px rounded-5 tinted. Value is **single-line, ellipsis, with `title`**. `.hud` brackets.
- **Buttons**: height 32 (small 28); `--radius-s`; 13/600.
  - primary: `--accent` bg, `--accent-contrast` text, hover `--accent-hover`, active translateY(1px).
  - default/ghost: transparent, 1px `--line-strong`, hover `--btn-hover-bg`.
  - danger: **ghost** red (red text + red-border) everywhere except inside confirm modals where it is solid `--red`. Destructive actions in dense lists (e.g. Disband per squad) are icon-only ghost buttons revealed on row hover / always visible on touch.
- **Inputs**: height 34, `--input-bg`, 1px `--line-strong`, focus = 1px `--accent2-border` + 3px `--accent2-soft` ring, transition `--dur-1`.
- **Chips / filters**: 26px pills, `--chip-bg`; selected = `--gold-soft` bg + `--gold-border` + `--text`.
- **Badges**: 18px, `--radius-xs`, 11/600 uppercase; tinted soft bg + border of the status color; text in the `*-text` token. Severity: S1 neutral, S2 amber, S3 red.
- **Tables**: always inside `.table-wrap` (horizontal scroll inside the card, never the page). Sticky header row (`--panel2`), 12px label-style heads, rows 40px, `--row-line` separators, hover `--row-hover`; numeric cells right-aligned, tabular, mono where they are ids/durations. Name cells truncate with `title`. First column may be `.sticky-col` on mobile.
- **Feeds** (kill/chat/live): row = `time` (mono 11 `--faint`, fixed 64px left gutter) · icon (16) · content (flex, min-width 0, names truncate) · trailing meta. New rows enter with `.flash-in` (240ms fade/slide + a 1.2s amber-soft background flash that decays). TK rows: red tick on the left edge, not a full red wash.
  - **Join** rows: user-plus icon in `--green`, "**Name** joined" — name 500 `--text`, verb `--dim`.
  - **Leave** rows: user-minus icon in `--faint`, "**Name** left" in `--dim`. Both clearly readable — never invisible-grey.
- **Modals**: 520 default width, `--radius`, header with title + close, footer actions right-aligned; enter = backdrop fade 180ms + panel scale .98→1 + fade.
- **Toasts**: bottom-right stack, slide-up + fade; status-colored 3px left edge.
- **Empty states**: centered icon (28, `--faint`) + one-line title + one-line hint + optional primary action; inside the card, generous padding.
- **Skeletons** (`.skeleton`): `--raise` blocks with a shimmer sweep; used while a view's first fetch is in flight so nothing jumps.

## 6. Motion

- Hover/focus/color changes: `--dur-1`, `--ease`.
- Route change: main content `.fade-in` (opacity 0→1, translateY 4px→0, `--dur-3`).
- Live dots: 2s pulse ring on connected states only.
- Numbers that update live (player count, tickets) do not animate size; they cross-fade (`--dur-2`).
- `@media (prefers-reduced-motion: reduce)`: disable transforms/animations; keep instant state changes.
- Never animate layout properties (width/height/top/left) — opacity and transform only.

## 7. Layout & responsiveness

- Main content max-width 1600px, centered; padding 24 (≥1024), 16 (<1024), 12 (<480).
- Breakpoints:
  - **≥1280**: sidebar expanded (236).
  - **1024–1279**: sidebar collapses to the 64px icon rail (labels become tooltips); content grids keep 2 columns where they fit.
  - **768–1023**: icon rail; multi-column grids collapse to 1–2 columns; dashboard feeds stack.
  - **<768**: sidebar becomes an off-canvas drawer (hamburger in the topbar, backdrop, closes on navigate/Escape); topbar shows hamburger + wordmark mark + server name (truncated) + live dot; secondary chips (layer, players, tps, clock) move into a horizontally-scrollable chip row under the topbar or are hidden; stat tiles 2 per row; tables scroll inside their card.
- **The page itself must never scroll horizontally at any width ≥ 320px.** Wide content scrolls inside its own `.table-wrap`/feed container.

### Overflow rules (non-negotiable)
1. Every flex/grid child that holds text gets `min-width: 0` (foundation sets this globally for `.grid > *`, `.row > *`, `.flex > *`, `.col > *`, card bodies).
2. Single-line values that can be long (server names, layer names, player names, squad names, roles, paths, ids) use `.truncate` AND carry a `title` with the full text.
3. Multi-line free text (chat messages, notes, reasons, RCON output) uses `overflow-wrap: anywhere`.
4. Paths and tokens shown in Settings/diagnostics: `.truncate` + copy button, never a raw unbreakable string.
5. Fixed-width UI (chips, badges, buttons) never shrinks below its content: `flex: 0 0 auto`.

## 8. Class contract

The foundation stylesheet (style.css) restyles every existing selector and
provides these NEW utilities; page code may rely on them:
`.page-head .page-title .page-sub .page-actions` · `.truncate` · `.wrap-anywhere`
· `.hud` · `.skeleton` (+ `.skeleton.line`, `.skeleton.block`) · `.fade-in` ·
`.flash-in` · `.feed-row.join` `.feed-row.leave` · `.sticky-col` ·
`.tabular` (tabular-nums) · `.display` (display face) · `body.drawer-open` (mobile
sidebar open) · `.empty` (empty state) · `.btn.icon-only` · `.reveal-on-hover`
(child shown on parent :hover/:focus-within; always visible on `(hover: none)`).

Per-area stylesheets (loaded after style.css; each owned by one area):
`css/shell.css` (sidebar, topbar, auth screens, dashboard — app.js),
`css/views.css` (players, profile, matches, chat, trolls, live — views.js),
`css/admin.css` (admin tools, bans, audit, console, users, roles, settings — views-admin.js).
Area sheets use tokens only — no literal colors.

## 9. Assets

All in `public/brand/`, cut from the owner-supplied A3 Community logo (the
mark only — the source image's "COMMUNITY" text is cut off at the bottom, so
text is always set live in Chakra Petch instead):

| File | Size | Use |
|---|---|---|
| `a3-mark.png` | 401×287 | auth screens, large brand moments (display ≤ 140px tall) |
| `a3-mark-sm.png` | 134×96 | sidebar, topbar, mobile drawer (display 28–40px tall) |
| `favicon-32.png`, `favicon-64.png` | square, transparent | browser tab icons |
| `apple-touch-icon.png` | 180², on `#0A0D11` | phone home-screen icon |

Markup: `<img class="brand-mark" src="brand/a3-mark-sm.png" alt="A3">` with
explicit `width`/`height` attributes (no layout shift).
