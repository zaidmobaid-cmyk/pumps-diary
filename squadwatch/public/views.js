'use strict';
/* A3 Admin — views.js (data views)
 *
 * Registers SW.routes.players (+ profile), SW.routes.matches (+ detail),
 * SW.routes.chat, SW.routes.trolls and the BattleMetrics-style
 * SW.routes.live (roster + unified live feed), which overrides the stage-1
 * live route from app.js (views.js loads after app.js and before boot()).
 *
 * Design: docs/DESIGN.md is binding. Every page opens with the .page-head
 * pattern; tables sit in .table-wrap; single-line values that can be long
 * use .truncate + title; free text wraps anywhere. View-specific styles live
 * in css/views.css (tokens only); generic components come from style.css.
 *
 * Conventions (established by app.js):
 *   - SW.routes[name] = { render(el, ctx), cleanup() }; render runs with
 *     this = route def and reassigns this.cleanup; SW.live.on() unsubscribers
 *     and timers are cleared there.
 *   - CSP: script-src 'self' — NO inline handlers and no style attributes;
 *     everything is wired with addEventListener. Every game- or
 *     user-controlled string goes through textContent / setAttribute (or
 *     SW.esc when composed into innerHTML). innerHTML only ever receives
 *     static icon markup.
 */
(function () {
  const SW = window.SW;
  const el = SW.ui.el;

  /* ======================================================= shared helpers */

  /* g(obj, 'camelCase', 'snake_case', …) -> first defined value. The API is
   * authored in parallel, so the views tolerate both key spellings. */
  function g(obj) {
    if (!obj) return undefined;
    for (let i = 1; i < arguments.length; i++) {
      const v = obj[arguments[i]];
      if (v !== undefined) return v;
    }
    return undefined;
  }

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  /* §19.3.21: "[all]" lists may be plain arrays or {rows, total, truncated}. */
  function listOf(x) {
    if (Array.isArray(x)) return x;
    if (x && Array.isArray(x.rows)) return x.rows;
    return [];
  }
  function totalOf(x) {
    if (x && typeof x === 'object' && !Array.isArray(x) && x.total != null) return num(x.total);
    return listOf(x).length;
  }
  function isTruncated(x) { return !!(x && typeof x === 'object' && !Array.isArray(x) && x.truncated); }
  function truncNote(x, noun) {
    if (!isTruncated(x)) return null;
    return el('div', {
      class: 'vw-note',
      text: 'Showing the first ' + SW.ui.fmtNum(listOf(x).length) + ' of ' +
        SW.ui.fmtNum(totalOf(x)) + ' ' + noun + ' (list truncated).',
    });
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const a = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(null, a); }, ms);
    };
  }

  function fmtDmg(v) { return SW.ui.fmtNum(Math.round(num(v))); }

  function kdText(k, d) {
    k = num(k); d = num(d);
    return d > 0 ? (k / d).toFixed(2) : k.toFixed(2);
  }

  function uniq(arr) { return Array.from(new Set(arr)); }

  function initials(name) {
    const parts = String(name == null ? '?' : name).trim().split(/\s+/).filter(Boolean);
    let out = '';
    for (const p of parts.slice(0, 2)) out += Array.from(p)[0] || '';
    return Array.from((out || '?').toUpperCase()).slice(0, 2).join('');
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function validDate(ts) {
    ts = Number(ts);
    if (!ts) return null;
    const d = new Date(ts);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function hms(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }

  /* feed gutter time: "21:04:13" today, "Nov 2" for older events */
  function clock(ts) {
    const d = validDate(ts);
    if (!d) return '—';
    if (d.toDateString() === new Date().toDateString()) return hms(d);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  /* list timestamps: today "21:04:13", this year "Nov 2 21:04", else "2025-11-02" */
  function stamp(ts) {
    const d = validDate(ts);
    if (!d) return '—';
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return hms(d);
    if (d.getFullYear() === now.getFullYear()) {
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
        pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* ---- icons: SW.icon when app.js ships the glyph, else these static
   * fallbacks (same stroke style). Markup here is constant — never data. */
  const EXTRA_ICONS = {
    'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
    'user-minus': '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="22" y1="11" x2="16" y2="11"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
    more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    crosshair: '<circle cx="12" cy="12" r="9"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>',
  };
  function ico(name, cls) {
    const own = SW.icon(name, cls);
    if (!EXTRA_ICONS[name] || own !== SW.icon('__a3_missing__', cls)) return own;
    return '<svg class="icon' + (cls ? ' ' + SW.esc(cls) : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + EXTRA_ICONS[name] + '</svg>';
  }

  /* ---- small render atoms ---- */

  /* player link that truncates; full name in the title */
  function nameLink(ref, cls) {
    ref = ref || {};
    const a = SW.ui.playerLink(ref, { class: 'truncate' + (cls ? ' ' + cls : '') });
    a.title = ref.name == null || ref.name === '' ? 'unknown' : String(ref.name);
    return a;
  }

  /* single-line text that truncates; full text in the title */
  function tspan(text, cls) {
    const s = el('span', { class: 'truncate' + (cls ? ' ' + cls : '') });
    s.textContent = text == null ? '' : String(text);
    s.title = s.textContent;
    return s;
  }

  function matchLink(matchId, label) {
    if (matchId == null) return null;
    const a = el('a', { class: 'vw-mlink mono', href: '#/matches/' + encodeURIComponent(matchId), title: 'Open match #' + matchId });
    a.textContent = label || '#' + matchId;
    return a;
  }

  function zero(text) { return el('span', { class: 'vw-zero', text: text == null ? '0' : text }); }

  /* weapon / damage-type ids: prettified text, raw id in the title */
  function prettyWeapon(w) {
    if (typeof SW.ui.prettyWeapon === 'function') return SW.ui.prettyWeapon(w);
    const raw = String(w == null ? '' : w);
    return raw.replace(/^BP_/i, '').replace(/_C(_\d+)?$/i, '').replace(/_\d{5,}$/, '').replace(/_/g, ' ').trim() || raw;
  }
  function weaponSpan(w, cls) {
    const s = el('span', { class: 'truncate mono' + (cls ? ' ' + cls : '') });
    s.textContent = prettyWeapon(w);
    s.title = String(w == null ? '' : w);
    return s;
  }

  /* live arrivals: the shared flash (amber decay) — never for backfill */
  function flash(node) {
    if (typeof SW.ui.flashIn === 'function') return SW.ui.flashIn(node);
    node.classList.add('flash-in');
    return node;
  }

  function chanKey(channel) {
    return String(channel || 'all').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'all';
  }

  function tkCellNode(v) {
    v = num(v);
    return v > 0 ? el('span', { class: 'vw-tk', text: SW.ui.fmtNum(v) }) : zero('0');
  }

  function teamBadge(teamId, label) {
    const t = num(teamId);
    const kind = t === 2 ? 'team2' : (t === 1 ? 'team1' : 'dim');
    return SW.ui.badge(label != null ? label : 'T' + (t || '?'), kind);
  }

  function catBadge(cat) {
    if (cat === 'radio') return SW.ui.badge('radio', 'purple');
    if (cat === 'hab') return SW.ui.badge('HAB', 'accent');
    return SW.ui.badge(cat || 'other', 'dim');
  }

  function sideBadge(friendly) {
    const f = num(friendly);
    if (f === 1) return SW.ui.badge('friendly', 'red');
    if (f === 0) return SW.ui.badge('enemy', 'green');
    return SW.ui.badge('unknown', 'dim');
  }

  function liveTag(text) {
    return el('span', { class: 'vw-live-tag' }, el('span', { class: 'vw-pulse on' }), el('span', { text: text || 'Live' }));
  }

  /* restart the route fade when async content replaces a skeleton */
  function refade(node) {
    node.classList.remove('fade-in');
    void node.offsetWidth; // eslint-disable-line no-void
    node.classList.add('fade-in');
  }

  /* ---- page head (DESIGN §5): title + sub on the left, actions right ---- */
  function pageHead(o) {
    const head = el('header', { class: 'page-head vw-head' });
    const text = el('div', { class: 'page-head-main vw-head-text' });
    if (o.crumb) {
      const c = el('a', { class: 'vw-crumb', href: o.crumb.href });
      c.innerHTML = SW.icon('chevron-left');
      c.append(el('span', { text: o.crumb.label }));
      text.append(c);
    }
    const title = el('h1', { class: 'page-title' + (o.truncate ? ' truncate' : '') });
    title.textContent = o.title;
    if (o.truncate) title.title = o.title;
    text.append(title);
    const sub = el('div', { class: 'page-sub' });
    text.append(sub);
    const actions = el('div', { class: 'page-actions' });
    head.append(text, actions);
    function setSub(v) {
      sub.textContent = '';
      const empty = v == null || v === '';
      sub.classList.toggle('hidden', empty);
      if (empty) return;
      if (typeof v === 'string') sub.textContent = v; else sub.append(v);
    }
    setSub(o.sub);
    return { el: head, text, title, sub, actions, setSub };
  }

  const CRUMB_PLAYERS = { href: '#/players', label: 'Players' };
  const CRUMB_MATCHES = { href: '#/matches', label: 'Matches' };

  /* ---- panel: a card with a header row (signal-ticked .card-title or a
   * lead control on the left, tools on the right) and a body. flush bodies
   * hold full-bleed tables / feeds. ---- */
  function panel(o) {
    o = o || {};
    const card = el('section', { class: 'card vw-panel' + (o.cls ? ' ' + o.cls : '') });
    const head = el('div', { class: 'vw-panel-head' });
    let title = null;
    let countEl = null;
    if (o.title != null) {
      title = el('h2', { class: 'card-title vw-panel-title' });
      title.append(el('span', { class: 'truncate', text: o.title }));
      countEl = el('span', { class: 'vw-count hidden' });
      title.append(countEl);
      head.append(title);
    }
    if (o.lead) head.append(o.lead);
    const tools = el('div', { class: 'vw-panel-tools' });
    head.append(tools);
    const body = el('div', { class: 'vw-panel-body' + (o.flush ? ' flush' : '') });
    card.append(head, body);
    let foot = null;
    return {
      el: card, head, title, tools, body,
      setCount(n, kind) {
        if (!countEl) return;
        const show = n != null && n !== '' && n !== 0;
        countEl.classList.toggle('hidden', !show);
        countEl.classList.toggle('warn', kind === 'warn');
        countEl.textContent = show ? (typeof n === 'number' ? SW.ui.fmtNum(n) : String(n)) : '';
      },
      foot() {
        if (!foot) { foot = el('div', { class: 'vw-panel-foot' }); card.append(foot); }
        return foot;
      },
    };
  }

  /* ---- empty state (.empty, same anatomy as SW.ui.empty): icon + one-line
   * title + one-line hint + optional primary action ---- */
  function emptyState(title, hint, icon, action) {
    const d = el('div', { class: 'empty empty-state vw-empty' });
    d.append(el('span', { class: 'empty-icon', html: ico(icon || 'search'), 'aria-hidden': 'true' }));
    d.append(el('p', { class: 'empty-title', text: title }));
    if (hint) d.append(el('p', { class: 'empty-hint', text: hint }));
    if (action) { action.classList.add('empty-action'); d.append(action); }
    return d;
  }
  function emptyCard(title, hint, icon, action) {
    return el('div', { class: 'card vw-empty-card' }, emptyState(title, hint, icon, action));
  }

  /* ---- lists only the game log fills (kills, teamkills, deployable
   * damage, flags, matches): while that feed is off or failing
   * (SW.logFeed, app.js) their empty state says so — with a Settings
   * shortcut for holders of the settings perm — instead of claiming
   * nothing happened. Views re-render these on SW.live '_logfeed'. ---- */
  function logMissing() { return !!(SW.logFeed && SW.logFeed.missing()); }
  function logGap() { return SW.logFeed.state() === 'down' ? 'which is failing right now' : 'which is not connected'; }
  function logEmpty(what, small) {
    const c = SW.logFeed.copy(what);
    let btn = null;
    if (c.action) {
      btn = el('a', { class: 'btn small ' + (small ? 'ghost' : 'primary'), href: c.action.href });
      btn.innerHTML = SW.icon(c.action.icon) + '<span></span>';
      btn.querySelector('span').textContent = c.action.label;
    }
    const d = emptyState(c.title, c.hint, 'scroll', btn);
    d.classList.add('vw-logempty');
    return d;
  }

  /* ---- skeletons while a view's first fetch is in flight ---- */
  function skeleton(lines, cls) {
    const box = el('div', { class: 'vw-skel' + (cls ? ' ' + cls : ''), 'aria-busy': 'true', 'aria-label': 'Loading' });
    for (let i = 0; i < (lines || 6); i++) box.append(el('div', { class: 'skeleton line vw-skel-line' }));
    return box;
  }
  function pageSkeleton() {
    const box = el('div', { class: 'vw-skel-page', 'aria-busy': 'true', 'aria-label': 'Loading' });
    box.append(
      el('div', { class: 'vw-skel-head' },
        el('div', { class: 'skeleton block vw-skel-av' }),
        el('div', { class: 'vw-skel-headlines' },
          el('div', { class: 'skeleton line vw-skel-h1' }),
          el('div', { class: 'skeleton line vw-skel-h2' }))),
      el('div', { class: 'vw-skel-cards' },
        el('div', { class: 'skeleton block' }),
        el('div', { class: 'skeleton block' }),
        el('div', { class: 'skeleton block' })),
      skeleton(6, 'vw-skel-table'));
    return box;
  }

  /* ---- tables: SW.ui.table + per-column responsive hiding (low-value
   * columns drop out instead of overflowing the card)
   * col.hide: 'lg' (<1440px) | 'md' (<1024px) | 'sm' (<768px) | 'xs' (<480px) ---- */
  const HIDE_CLS = { lg: 'vw-hide-lg', md: 'vw-hide-md', sm: 'vw-hide-sm', xs: 'vw-hide-xs' };
  function mkTable(cols, rows, opts) {
    opts = Object.assign({}, opts);
    const mapped = cols.map((c) => {
      const extra = [c.class, c.hide ? HIDE_CLS[c.hide] : null].filter(Boolean).join(' ');
      return Object.assign({}, c, { class: extra || undefined });
    });
    opts.class = 'vw-table' + (opts.class ? ' ' + opts.class : '');
    const t = SW.ui.table(mapped, rows, opts);
    const ths = t.querySelectorAll('thead th');
    mapped.forEach((c, i) => {
      if (ths[i] && c.hide) ths[i].classList.add(HIDE_CLS[c.hide]);
      if (ths[i] && c.class) c.class.split(' ').forEach((k) => { if (k && k.indexOf('vw-col-') === 0) ths[i].classList.add(k); });
    });
    return t;
  }

  /* single-select segmented chips: chipBar([{value,label}], active, onPick) */
  function chipBar(items, value, onPick, opts) {
    const row = el('div', { class: 'vw-seg', role: 'group' });
    if (opts && opts.label) row.setAttribute('aria-label', opts.label);
    const btns = [];
    const api = { el: row, value };
    api.set = (v) => {
      api.value = v;
      for (const [b, val] of btns) {
        b.classList.toggle('on', val === v);
        b.setAttribute('aria-pressed', val === v ? 'true' : 'false');
      }
    };
    for (const it of items) {
      const b = el('button', { type: 'button', class: 'chip' });
      b.textContent = it.label;
      b.addEventListener('click', () => {
        if (api.value === it.value) return;
        api.set(it.value);
        onPick(it.value);
      });
      btns.push([b, it.value]);
      row.append(b);
    }
    api.set(value);
    return api;
  }

  /* tab bar + content: tabsView([{id,label,badge?,badgeKind?,hidden?,render(c)}], {active})
   * -> {el, set(id, quiet) (re-renders even the active tab), get(), setBadge(id, n, kind)} */
  function tabsView(defs, opts) {
    opts = opts || {};
    const visible = defs.filter((d) => !d.hidden);
    const wrap = el('div', { class: 'vw-tabset' });
    const bar = el('div', { class: 'tabs vw-tabs', role: 'tablist' });
    const content = el('div', { class: 'vw-tab-body', role: 'tabpanel' });
    const btns = new Map();
    let current = null;
    /* quiet: an in-place refresh — no entrance fade */
    function set(id, quiet) {
      if (!btns.has(id)) return;
      current = id;
      for (const [k, b] of btns) {
        const on = k === id;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      }
      content.textContent = '';
      if (!quiet) refade(content);
      const d = visible.find((x) => x.id === id);
      try { if (d) d.render(content); } catch (e) {
        console.error('tab ' + id, e);
        content.textContent = '';
        content.append(emptyCard('This tab failed to render', 'See the browser console for details.', 'warn'));
      }
    }
    function setBadge(id, n, kind) {
      const b = btns.get(id);
      if (!b) return;
      let badge = b.querySelector('.vw-tab-n');
      if (n == null || n === 0 || n === '0') { if (badge) badge.remove(); return; }
      if (!badge) { badge = el('span'); b.append(badge); }
      badge.className = 'vw-tab-n' + (kind === 'warn' ? ' warn' : '');
      badge.textContent = typeof n === 'number' ? SW.ui.fmtNum(n) : String(n);
    }
    for (const d of visible) {
      const b = el('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': 'false' });
      b.append(el('span', { text: d.label }));
      b.addEventListener('click', () => set(d.id));
      btns.set(d.id, b);
      setBadge(d.id, d.badge, d.badgeKind);
      bar.append(b);
    }
    bar.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const ids = Array.from(btns.keys());
      const i = ids.indexOf(current);
      if (i === -1) return;
      const next = ids[(i + (e.key === 'ArrowRight' ? 1 : ids.length - 1)) % ids.length];
      set(next);
      btns.get(next).focus();
      e.preventDefault();
    });
    wrap.append(bar, content);
    if (visible.length) set(opts.active && btns.has(opts.active) ? opts.active : visible[0].id);
    return { el: wrap, set, get: () => current, setBadge };
  }

  /* ---- normalizers ---- */

  /* player ref (app.js playerLink shape) from any row spelling */
  function refOf(r) {
    if (!r) return {};
    return {
      dbId: g(r, 'dbId', 'id', 'playerId', 'player_id'),
      eosId: g(r, 'eosId', 'eos_id'),
      steamId: g(r, 'steamId', 'steam_id'),
      name: g(r, 'name', 'playerName', 'player_name'),
      teamId: g(r, 'teamId', 'team_id'),
      watchlisted: !!g(r, 'watchlisted'),
    };
  }

  /* kill rows: pass through §7 enriched payloads, synthesize refs from flat rows */
  function normKill(k) {
    if (!k) return k;
    if (k.attacker !== undefined || k.victim !== undefined) return k;
    const atkId = g(k, 'attackerId', 'attacker_id');
    const atkName = g(k, 'attackerName', 'attacker_name');
    return {
      time: g(k, 'time'),
      matchId: g(k, 'matchId', 'match_id'),
      kind: g(k, 'kind') || 'wound',
      weapon: g(k, 'weapon'),
      damage: g(k, 'damage'),
      teamkill: !!num(g(k, 'teamkill')),
      suicide: !!num(g(k, 'suicide')),
      attacker: (atkId != null || atkName != null) ? { dbId: atkId, name: atkName } : null,
      victim: { dbId: g(k, 'victimId', 'victim_id'), name: g(k, 'victimName', 'victim_name') },
    };
  }
  function killKey(k) {
    if (k.id != null) return 'i' + k.id;
    return [k.time, k.kind, k.weapon,
      k.attacker && (k.attacker.dbId != null ? k.attacker.dbId : k.attacker.name),
      k.victim && (k.victim.dbId != null ? k.victim.dbId : k.victim.name)].join('|');
  }

  function normChat(c) {
    if (!c) return c;
    const out = Object.assign({}, c);
    if (!out.player || typeof out.player !== 'object') {
      out.player = {
        dbId: g(c, 'playerId', 'player_id'),
        name: g(c, 'playerName', 'player_name') || '?',
      };
    }
    if (out.matchId === undefined) out.matchId = g(c, 'match_id');
    return out;
  }

  function prettyDeployable(cn) {
    if (!cn) return '';
    return String(cn).replace(/^BP_/, '').replace(/_C(_\d+)?$/, '').replace(/_/g, ' ');
  }
  function normDep(r) {
    if (!r) return r;
    const fr = g(r, 'friendly');
    return {
      time: g(r, 'time'),
      matchId: g(r, 'matchId', 'match_id'),
      player: (r.player && typeof r.player === 'object') ? r.player
        : ((g(r, 'playerId', 'player_id') != null || g(r, 'playerName', 'player_name') != null)
          ? { dbId: g(r, 'playerId', 'player_id'), name: g(r, 'playerName', 'player_name') } : null),
      deployable: g(r, 'deployable'),
      label: g(r, 'label') || prettyDeployable(g(r, 'deployable')),
      category: g(r, 'category') || 'other',
      friendly: fr == null ? -1 : num(fr),
      damage: g(r, 'damage'),
      weapon: g(r, 'weapon'),
      damageType: g(r, 'damageType', 'damage_type'),
    };
  }

  function matchDur(m) {
    const a = num(g(m, 'startedAt', 'started_at'));
    if (!a) return '—';
    const b = g(m, 'endedAt', 'ended_at');
    return SW.ui.fmtDur(((b ? num(b) : Date.now()) - a) / 1000);
  }

  /* ---- squad role ids -> short human labels (DESIGN: never truncate a
   * role mid-word). "USA_AutomaticRifleman_01" -> Auto Rifleman / AR. */
  const ROLE_MAP = {
    SL: ['Squad Lead', 'SL'], SquadLeader: ['Squad Lead', 'SL'],
    FTL: ['Fireteam Lead', 'FTL'], FireteamLeader: ['Fireteam Lead', 'FTL'], TL: ['Team Lead', 'TL'],
    Commander: ['Commander', 'CMD'], CMD: ['Commander', 'CMD'],
    Rifleman: ['Rifleman', 'RIF'], Medic: ['Medic', 'MED'], Corpsman: ['Medic', 'MED'],
    AR: ['Auto Rifleman', 'AR'], AutomaticRifleman: ['Auto Rifleman', 'AR'], AutoRifleman: ['Auto Rifleman', 'AR'],
    MG: ['Machine Gunner', 'MG'], MachineGunner: ['Machine Gunner', 'MG'], HMG: ['Heavy MG', 'HMG'],
    LAT: ['Light AT', 'LAT'], HAT: ['Heavy AT', 'HAT'], AT: ['Anti-Tank', 'AT'],
    Grenadier: ['Grenadier', 'GL'], Marksman: ['Marksman', 'DMR'], Sniper: ['Sniper', 'SNP'], Spotter: ['Spotter', 'SPT'],
    Engineer: ['Engineer', 'ENG'], CombatEngineer: ['Combat Eng', 'CE'], Sapper: ['Sapper', 'SAP'],
    Crewman: ['Crewman', 'CRW'], Crew: ['Crewman', 'CRW'], Pilot: ['Pilot', 'PLT'],
    Recruit: ['Recruit', 'RCT'], Scout: ['Scout', 'SCT'], Raider: ['Raider', 'RDR'],
    Ambusher: ['Ambusher', 'AMB'], Saboteur: ['Saboteur', 'SAB'], Infiltrator: ['Infiltrator', 'INF'],
    Breacher: ['Breacher', 'BRC'], Unarmed: ['Unarmed', 'UNA'],
  };
  function humanizeRole(s) {
    const words = String(s).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/\s+/).filter(Boolean);
    let out = '';
    for (const w of words) {
      const next = out ? out + ' ' + w : w;
      if (out && next.length > 14) break; // drop whole trailing words, never cut one
      out = next;
    }
    return out || String(s);
  }
  function roleLabel(role) {
    if (!role) return null;
    let parts = String(role).split('_').filter(Boolean);
    while (parts.length > 1 && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
    if (parts.length > 1 && /^[A-Z][A-Z0-9]{1,6}$/.test(parts[0]) && !ROLE_MAP[parts[0]]) parts = parts.slice(1);
    if (!parts.length) return null;
    const lead = parts.length > 1 && (parts[0] === 'SL' || parts[0] === 'FTL');
    const core = lead ? parts.slice(1) : parts;
    const hit = core.find((p) => ROLE_MAP[p]);
    let long;
    let short;
    if (hit) { long = ROLE_MAP[hit][0]; short = ROLE_MAP[hit][1]; } else {
      long = humanizeRole(core[0]);
      short = core[0].replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || '?';
    }
    if (lead) { long = humanizeRole(long + ' ' + parts[0]); short = parts[0]; }
    return { long, short };
  }

  /* ---- feed rows (DESIGN §5): time gutter · icon · content · meta. Same
   * anatomy + classes as SW.ui.feedRow (feed-time / feed-icon / feed-main /
   * feed-meta) so every feed in the app reads alike; vw-ev* carry the view
   * layout so it holds whatever the global feed styles are. ---- */
  function evRow(kindCls, ts, iconName, iconCls, mainNode, metaNode) {
    const row = el('div', { class: 'feed-row ui-row vw-ev ' + kindCls });
    const t = el('span', { class: 'feed-time vw-ev-t mono' });
    t.textContent = clock(ts);
    if (validDate(ts)) t.title = SW.ui.fmtTime(ts);
    row.append(t, el('span', { class: 'feed-icon vw-ev-ic' + (iconCls ? ' ' + iconCls : ''), html: ico(iconName), 'aria-hidden': 'true' }), mainNode);
    if (metaNode) row.append(metaNode);
    return row;
  }

  /* opts: {matchLink: append the match id, selfId: profile owner (tints own kills)} */
  function killFeedRow(k, opts) {
    opts = opts || {};
    const tk = !!k.teamkill;
    const died = k.kind === 'die';
    const main = el('span', { class: 'feed-main vw-ev-main vw-kill' });
    if (k.suicide) {
      main.append(nameLink(k.victim || {}, 'vw-ev-name'), el('span', { class: 'feed-verb vw-verb', text: 'died (suicide)' }));
    } else {
      main.append(k.attacker ? nameLink(k.attacker, 'vw-ev-name') : el('span', { class: 'feed-verb vw-verb', text: 'environment' }));
      main.append(el('span', { class: 'kill-arrow vw-ev-arrow', html: SW.icon('chevron-right'), 'aria-hidden': 'true' }));
      main.append(nameLink(k.victim || {}, 'vw-ev-name'));
      if (died) main.append(el('span', { class: 'feed-verb vw-verb', text: 'gave up' }));
    }
    const meta = el('span', { class: 'feed-meta vw-ev-meta' });
    if (tk) meta.append(SW.ui.badge('TK', 'red'));
    if (k.weapon) meta.append(weaponSpan(k.weapon, 'feed-weapon vw-weapon'));
    if (opts.matchLink && k.matchId != null) meta.append(matchLink(k.matchId));
    let own = '';
    if (opts.selfId != null && k.victim) {
      const vid = k.victim.dbId != null ? k.victim.dbId : k.victim.id;
      own = vid != null && String(vid) === String(opts.selfId) ? ' own-death' : ' own-kill';
    }
    return evRow('kill' + (tk ? ' tk' : '') + (died ? ' died' : '') + (k.suicide ? ' suicide' : '') + own,
      k.time, tk ? 'warn' : (k.suicide || died ? 'skull' : 'crosshair'), tk ? 'is-tk' : '',
      main, meta.childNodes.length ? meta : null);
  }

  function chatFeedRow(c) {
    const ch = chanKey(c.channel);
    const main = el('span', { class: 'feed-main chat-main vw-ev-main vw-chat' });
    main.append(SW.ui.channelChip(c.channel));
    main.append(nameLink(c.player || { name: '?' }, 'vw-chat-name'));
    const msg = el('span', { class: 'feed-msg vw-chat-msg wrap-anywhere' });
    msg.textContent = c.message == null ? '' : String(c.message);
    main.append(msg);
    return evRow('chat-line chan-' + ch + (ch === 'admin' ? ' admin-chat' : ''), c.time, 'chat', 'chan-icon ch-' + ch, main, null);
  }

  function connFeedRow(kind, data) {
    data = data || {};
    const ref = (data.player && typeof data.player === 'object')
      ? data.player
      : { dbId: g(data, 'playerDbId', 'playerId'), name: data.name };
    const joined = kind === 'connect';
    const main = el('span', { class: 'feed-main vw-ev-main vw-conn' });
    main.append(nameLink(ref, 'vw-ev-name'), el('span', { class: 'feed-verb vw-verb', text: joined ? 'joined' : 'left' }));
    return evRow('conn ' + (joined ? 'join' : 'leave'), data.time, joined ? 'user-plus' : 'user-minus', '', main, null);
  }

  function squadFeedRow(d) {
    d = d || {};
    const created = d.type === 'created';
    const admin = !created && !!d.byUser;
    const main = el('span', { class: 'feed-main vw-ev-main vw-sq' });
    main.append(el('span', { class: 'vw-sq-num mono', text: d.squadId != null ? String(d.squadId) : '?', title: 'Squad number' }));
    if (d.name) main.append(tspan(String(d.name), 'vw-sq-name'));
    main.append(el('span', { class: 'feed-verb vw-verb ' + (created ? 'is-created' : 'is-disbanded'), text: created ? 'created' : 'disbanded' }));
    if (created && d.creatorName) {
      main.append(el('span', { class: 'feed-verb vw-verb', text: 'by' }));
      main.append(d.creatorDbId != null
        ? nameLink({ dbId: d.creatorDbId, name: d.creatorName }, 'vw-ev-name')
        : tspan(String(d.creatorName), 'vw-ev-name'));
    }
    if (admin) {
      main.append(el('span', { class: 'feed-verb vw-verb', text: 'by admin' }));
      main.append(tspan(String(d.byUser), 'vw-ev-admin'));
    }
    const meta = d.teamId != null ? el('span', { class: 'feed-meta vw-ev-meta' }, teamBadge(d.teamId)) : null;
    return evRow('squad-ev' + (created ? ' is-created' : ' is-disbanded') + (admin ? ' admin' : ''),
      d.time, 'users', '', main, meta);
  }

  /* ---- chat message list (chat page + profile/match chat tabs)
   * chatList({hidePlayer, withMatch, emptyText, emptyHint}) ->
   *   {el, update(rows), prepend(row, cap)} ---- */
  function chatList(opts) {
    opts = opts || {};
    const wrap = el('div', {
      class: 'cv-list' + (opts.hidePlayer ? ' no-player' : '') + (opts.withMatch ? ' with-match' : ''),
    });
    let rows = [];
    function msgRow(r, fresh) {
      const row = el('div', { class: 'cv-row chan-' + chanKey(r.channel) + (chanKey(r.channel) === 'admin' ? ' admin-chat' : '') });
      if (fresh) flash(row);
      const t = el('span', { class: 'cv-time mono', text: stamp(r.time) });
      if (validDate(r.time)) t.title = SW.ui.fmtTime(r.time);
      row.append(t, el('span', { class: 'cv-chan' }, SW.ui.channelChip(r.channel)));
      if (!opts.hidePlayer) row.append(el('span', { class: 'cv-player' }, nameLink(r.player || { name: '?' })));
      const m = el('div', { class: 'cv-msg wrap-anywhere' });
      m.textContent = r.message == null ? '' : String(r.message);
      row.append(m);
      if (opts.withMatch) row.append(el('span', { class: 'cv-match' }, matchLink(r.matchId)));
      return row;
    }
    function draw() {
      wrap.textContent = '';
      if (!rows.length) {
        wrap.append(emptyState(opts.emptyText || 'No chat messages', opts.emptyHint || null, 'chat'));
        return;
      }
      for (const r of rows) wrap.append(msgRow(r, false));
    }
    draw();
    return {
      el: wrap,
      update(newRows) { rows = newRows || []; draw(); },
      prepend(r, cap) {
        if (!rows.length) wrap.textContent = '';
        rows.unshift(r);
        wrap.prepend(msgRow(r, true));
        while (cap && rows.length > cap) {
          rows.pop();
          if (wrap.lastChild) wrap.lastChild.remove();
        }
      },
    };
  }

  /* ------------------------------------------------------------ flag rows */

  /* one label table for every flag surface (app.js SW.ui.flagLabel) */
  function flagTypeLabel(t) { return SW.ui.flagLabel(t); }

  /* details may be an object (SSE) or a JSON string (DB rows) */
  function detailsObj(d) {
    if (d && typeof d === 'object') return d;
    if (typeof d !== 'string' || !/^\s*\{/.test(d)) return null;
    try { return JSON.parse(d); } catch (_e) { return null; }
  }
  function prettyDetails(d) {
    if (d == null || d === '') return '';
    let obj = null;
    if (typeof d === 'object') obj = d;
    else {
      const s = String(d).trim();
      if (/^[[{]/.test(s)) { try { obj = JSON.parse(s); } catch (_e) { obj = null; } }
      if (obj == null || typeof obj !== 'object') return String(d);
    }
    try {
      return Object.keys(obj).map((k) => {
        const v = obj[k];
        return k + ': ' + (v != null && typeof v === 'object' ? JSON.stringify(v) : String(v));
      }).join('\n');
    } catch (_e) { return String(d); }
  }

  function playerOfFlag(f) {
    if (f && f.player && typeof f.player === 'object') return f.player;
    return {
      dbId: g(f, 'playerId', 'player_id'),
      name: g(f, 'playerName', 'player_name', 'name') || 'unknown',
    };
  }

  function sortFlags(rows) {
    return rows.slice().sort((a, b) => {
      const ra = g(a, 'reviewed') ? 1 : 0;
      const rb = g(b, 'reviewed') ? 1 : 0;
      if (ra !== rb) return ra - rb;
      return num(b.time) - num(a.time);
    });
  }

  /* flagRow(f, {hidePlayer, onReviewed}) */
  function flagRow(f, opts) {
    opts = opts || {};
    const reviewed = !!g(f, 'reviewed');
    const sev = Math.min(3, Math.max(1, num(g(f, 'severity')) || 1));
    const row = el('div', { class: 'tro-flag sev' + sev + (reviewed ? ' reviewed' : '') });
    const sevBox = el('div', { class: 'tro-flag-sev' }, SW.ui.sevBadge(g(f, 'severity')));
    const main = el('div', { class: 'tro-flag-main' });
    const head = el('div', { class: 'tro-flag-head' });
    if (!opts.hidePlayer) head.append(nameLink(refOf(playerOfFlag(f)), 'tro-flag-player'));
    head.append(tspan(flagTypeLabel(g(f, 'type')), 'tro-flag-type'));
    const mid = g(f, 'matchId', 'match_id');
    if (mid != null) head.append(matchLink(mid));
    main.append(head);
    /* ban evasion names the banned account it shares an IP with; the server
     * hides that link from roles without 'ips' ({reason, redacted: true}) */
    let details = g(f, 'details');
    const evasion = g(f, 'type') === 'ban-evasion';
    const ev = evasion ? SW.ui.evasionOf(details) : null;
    const hidden = evasion && !ev ? detailsObj(details) : null;
    if (ev && (ev.name || ev.playerId != null)) {
      const line = el('div', { class: 'tro-flag-evasion' });
      line.append(el('span', { class: 'tro-flag-evasion-k', text: 'Shares an IP with' }));
      line.append(ev.playerId != null
        ? nameLink({ dbId: ev.playerId, name: ev.name || 'player #' + ev.playerId }, 'tro-flag-evasion-name')
        : tspan(ev.name, 'tro-flag-evasion-name'));
      if (ev.banId != null) line.append(el('span', { class: 'tro-flag-evasion-ban mono', text: 'ban #' + ev.banId }));
      main.append(line);
    } else if (hidden && hidden.redacted === true) {
      main.append(el('div', { class: 'tro-flag-evasion is-hidden' },
        el('span', { class: 'tro-flag-evasion-ic', html: SW.icon('lock'), 'aria-hidden': 'true' }),
        el('span', { class: 'tro-flag-evasion-k', text: 'Linked banned account hidden — seeing it needs the “See IPs & alt accounts” permission.' })));
      details = hidden.reason ? { reason: hidden.reason } : null;
    }
    const det = prettyDetails(details);
    if (det) {
      const dEl = el('div', { class: 'tro-flag-details mono wrap-anywhere' });
      dEl.textContent = det;
      main.append(dEl);
    }
    const noteEl = el('div', { class: 'tro-flag-note wrap-anywhere hidden' });
    function showNote(n) {
      noteEl.textContent = 'Review note: ' + n;
      noteEl.classList.remove('hidden');
    }
    const note0 = g(f, 'reviewNote', 'review_note');
    if (note0) showNote(note0);
    main.append(noteEl);
    const side = el('div', { class: 'tro-flag-side' });
    side.append(SW.ui.timeAgo(g(f, 'time')));
    if (reviewed) {
      side.append(SW.ui.badge('reviewed', 'ok'));
    } else if (SW.can('flags')) {
      const btn = el('button', { type: 'button', class: 'btn ghost small tro-review' });
      btn.innerHTML = SW.icon('check') + '<span>Review</span>';
      btn.addEventListener('click', async () => {
        const v = await SW.ui.confirmModal({
          title: 'Review flag',
          body: 'Mark "' + flagTypeLabel(g(f, 'type')) + '" on ' + (playerOfFlag(f).name || 'player') + ' as reviewed?',
          confirmText: 'Mark reviewed',
          fields: [{
            name: 'note', label: 'Review note (optional)', type: 'textarea', rows: 3,
            placeholder: 'e.g. warned the player / false positive',
          }],
        });
        if (!v) return;
        const flagId = g(f, 'id', 'flagId');
        btn.disabled = true;
        try {
          await SW.api('/api/flags/' + encodeURIComponent(flagId) + '/review', {
            method: 'POST', body: v.note ? { note: v.note } : {},
          });
          SW.ui.toast('Flag reviewed', 'ok');
          row.classList.add('reviewed');
          btn.replaceWith(SW.ui.badge('reviewed', 'ok'));
          if (v.note) showNote(v.note);
          if (opts.onReviewed) opts.onReviewed(f);
        } catch (_e) { btn.disabled = false; /* toasted by SW.api */ }
      });
      side.append(btn);
    }
    row.append(sevBox, main, side);
    return row;
  }

  function flagList(rows, opts) {
    const box = el('div', { class: 'tro-flags' });
    for (const f of sortFlags(rows)) box.append(flagRow(f, opts));
    return box;
  }

  /* shared deployable-damage table */
  function deployablesTable(rowsIn, opts) {
    opts = opts || {};
    const rows = rowsIn.map(normDep);
    const cols = [{
      key: 'time', label: 'Time', sortable: true,
      sortVal: (r) => num(r.time), render: (r) => SW.ui.timeAgo(r.time),
    }];
    if (opts.withPlayer) {
      cols.push({ key: 'player', label: 'Player', class: 'vw-col-name', render: (r) => nameLink(r.player || { name: 'unknown' }) });
    }
    cols.push(
      { key: 'label', label: 'Deployable', class: 'vw-col-text', render: (r) => tspan(r.label || r.deployable || '—') },
      { key: 'category', label: 'Type', hide: 'xs', render: (r) => catBadge(r.category) },
      { key: 'friendly', label: 'Side', sortable: true, sortVal: (r) => num(r.friendly), render: (r) => sideBadge(r.friendly) },
      { key: 'damage', label: 'Damage', align: 'right', sortable: true, sortVal: (r) => num(r.damage), render: (r) => fmtDmg(r.damage) },
      { key: 'weapon', label: 'Weapon', hide: 'sm', class: 'vw-col-text', render: (r) => ((r.weapon || r.damageType) ? weaponSpan(r.weapon || r.damageType) : '—') }
    );
    if (opts.withMatch) cols.push({ key: 'match', label: 'Match', align: 'right', render: (r) => matchLink(r.matchId) });
    return mkTable(cols, rows, {
      sort: { key: 'time', dir: 'desc' },
      rowClass: (r) => (num(r.friendly) === 1 && r.category === 'radio' ? 'radio-row' : ''),
      emptyText: opts.emptyText || (logMissing()
        ? 'No deployable damage recorded — it comes from the game log, ' + logGap()
        : 'No deployable damage recorded'),
    });
  }

  /* ========================================================= PLAYERS list */

  const PLAYER_SORT_KEYS = ['last_seen', 'kills', 'teamkills', 'radio', 'playtime'];
  const PLAYER_FILTERS = ['online', 'flagged', 'watchlisted', 'banned'];
  const PLAYER_FILTER_NOUN = {
    '': 'players on record', online: 'online now', flagged: 'with open flags',
    watchlisted: 'on the watchlist', banned: 'currently banned',
  };

  function playerNameCell(r) {
    const w = el('span', { class: 'vw-namecell' });
    w.append(el('span', { class: 'vw-dot' + (r.online ? ' on' : ''), title: r.online ? 'Online now' : 'Offline' }));
    w.append(nameLink(refOf(r)));
    if (r.watchlisted) w.append(el('span', { class: 'vw-star', html: SW.icon('star'), title: 'Watchlisted' }));
    if (g(r, 'bannedActive', 'banned_active')) w.append(SW.ui.badge('banned', 'red'));
    return w;
  }

  function renderPlayersList(main, ctx) {
    const unsubs = [];
    this.cleanup = () => { unsubs.forEach((u) => u()); };

    let q = (ctx.query && ctx.query.q) || '';
    let filter = (ctx.query && ctx.query.filter) || '';
    if (PLAYER_FILTERS.indexOf(filter) === -1) filter = '';
    let sort = SW.prefs.get('sort:players', null);
    if (!sort || PLAYER_SORT_KEYS.indexOf(sort.key) === -1 || (sort.dir !== 'asc' && sort.dir !== 'desc')) {
      sort = { key: 'last_seen', dir: 'desc' };
    }
    let page = 0;
    let perGuess = 50;
    let seq = 0;
    let shown = false;

    const view = el('div', { class: 'view vw vw-players fade-in' });
    main.append(view);

    const head = pageHead({ title: 'Players', sub: 'Everyone the server has seen — search by name, Steam ID or EOS ID.' });
    const search = el('input', {
      class: 'input', type: 'search', value: q,
      placeholder: 'Search name / Steam ID / EOS ID…', 'aria-label': 'Search players',
    });
    const sbox = el('div', { class: 'search-box vw-search' });
    sbox.innerHTML = SW.icon('search');
    sbox.append(search);
    head.actions.append(sbox);
    view.append(head.el);

    const chips = chipBar([
      { value: '', label: 'All' },
      { value: 'online', label: 'Online' },
      { value: 'flagged', label: 'Flagged' },
      { value: 'watchlisted', label: 'Watchlisted' },
      { value: 'banned', label: 'Banned' },
    ], filter, (v) => { filter = v; page = 0; load(); }, { label: 'Filter players' });
    const pnl = panel({ lead: chips.el, flush: true, cls: 'vw-grid-panel' });
    const countEl = el('span', { class: 'vw-resultcount' });
    pnl.tools.append(countEl);
    pnl.body.append(skeleton(10, 'vw-skel-table'));
    view.append(pnl.el);

    const cols = [
      { key: 'name', label: 'Player', class: 'vw-col-name', render: playerNameCell },
      { key: 'kills', label: 'Kills', sortable: true, align: 'right', hide: 'xs', render: (r) => SW.ui.fmtNum(r.kills) },
      { key: 'deaths', label: 'Deaths', align: 'right', hide: 'lg', render: (r) => SW.ui.fmtNum(r.deaths) },
      { key: 'kd', label: 'K/D', align: 'right', hide: 'md', render: (r) => kdText(r.kills, r.deaths) },
      { key: 'teamkills', label: 'TKs', sortable: true, align: 'right', render: (r) => tkCellNode(r.teamkills) },
      { key: 'tkDeaths', label: 'TK deaths', align: 'right', hide: 'lg', render: (r) => SW.ui.fmtNum(g(r, 'tkDeaths', 'tk_deaths')) },
      {
        key: 'radio', label: 'Radio dmg', sortable: true, align: 'right', hide: 'sm',
        render: (r) => {
          const v = num(g(r, 'radioFriendly', 'radio_damage_friendly'));
          return v > 0 ? el('span', { class: 'vw-purple', text: fmtDmg(v) }) : zero('0');
        },
      },
      {
        key: 'playtime', label: 'Playtime', sortable: true, align: 'right', hide: 'lg',
        render: (r) => SW.ui.fmtDur(g(r, 'playSeconds', 'play_seconds')),
      },
      {
        key: 'flags', label: 'Flags', align: 'right', hide: 'xs',
        render: (r) => {
          const n = num(g(r, 'flagsOpen', 'flags_open'));
          return n > 0 ? SW.ui.badge(String(n), 'warn') : zero('—');
        },
      },
      {
        key: 'last_seen', label: 'Last seen', sortable: true, align: 'right',
        render: (r) => SW.ui.timeAgo(g(r, 'lastSeen', 'last_seen')),
      },
    ];

    const tbl = mkTable(cols, [], {
      class: 'vw-scroll',
      sort, storeKey: 'players',
      onSort: (key, dir) => { sort = { key, dir }; page = 0; load(); },
      onRowClick: (r) => { const pid = g(r, 'id', 'dbId'); if (pid != null) SW.navigate('#/players/' + pid); },
      rowClass: (r) => (r.watchlisted ? 'watch-row' : ''),
      emptyText: 'No players match these filters',
    });

    const doSearch = debounce(() => { q = search.value.trim(); page = 0; load(); }, 300);
    search.addEventListener('input', doSearch);
    search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { q = search.value.trim(); page = 0; load(); } });

    async function load() {
      const my = ++seq;
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (filter) params.set('filter', filter);
      params.set('sort', sort.key);
      params.set('dir', sort.dir);
      params.set('page', String(page));
      params.set('per', '50');
      pnl.el.classList.add('is-busy');
      let r;
      try { r = await SW.api('/api/players?' + params.toString()); } catch (_e) {
        if (my !== seq) return;
        pnl.el.classList.remove('is-busy');
        if (!shown) {
          pnl.body.textContent = '';
          pnl.body.append(emptyState('Could not load players', 'The server did not answer — try again in a moment.', 'users'));
        }
        return;
      }
      if (my !== seq) return;
      pnl.el.classList.remove('is-busy');
      const rows = (r && r.rows) || [];
      const total = num(r && r.total);
      perGuess = Math.max(perGuess, rows.length);
      if (!shown) { shown = true; pnl.body.textContent = ''; pnl.body.append(tbl); }
      tbl.update(rows);
      countEl.textContent = SW.ui.fmtNum(total) + ' ' + (q ? 'matching' : PLAYER_FILTER_NOUN[filter]);
      const foot = pnl.foot();
      foot.textContent = '';
      const multi = total > perGuess || page > 0;
      foot.classList.toggle('hidden', !multi);
      if (multi) {
        foot.append(SW.ui.pager({
          page, per: perGuess, total,
          onPage: (p) => { page = p; load(); },
        }));
      }
    }
    load();
  }

  /* ======================================================= PLAYER profile */

  const ACTION_KIND_SET = { warn: 1, kick: 1, ban: 1 };

  function renderProfile(main, ctx) {
    const unsubs = [];
    let refreshTimer = null;
    this.cleanup = () => {
      unsubs.forEach((u) => u());
      if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    };
    const id = ctx.args[0];
    const view = el('div', { class: 'view vw vw-profile fade-in' });
    main.append(view);
    view.append(pageSkeleton());
    let prof = null;
    let lastActionAt = 0;
    (async () => {
      let d;
      try { d = await SW.api('/api/players/' + encodeURIComponent(id)); }
      catch (e) {
        view.textContent = '';
        const missing = e && e.status === 404;
        view.append(pageHead({ title: 'Player', crumb: CRUMB_PLAYERS }).el);
        const back = el('a', { class: 'btn primary', href: '#/players', text: 'Back to players' });
        view.append(emptyCard(
          missing ? 'No such player' : 'Could not load this player',
          missing ? 'This profile id is not in the database.' : 'The server did not answer — try again in a moment.',
          'user', back));
        refade(view);
        return;
      }
      view.textContent = '';
      prof = buildProfile(view, d || {}, id);
      refade(view);
    })();

    /* a warn / kick / ban on this player, or evidence on one of its bans or
     * actions, refreshes the Discipline data in place (other tabs keep any
     * draft the admin is typing) */
    function refreshSoon() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(async () => {
        refreshTimer = null;
        let d;
        try { d = await SW.api('/api/players/' + encodeURIComponent(id), { toast: false }); } catch (_e) { return; }
        if (prof && view.isConnected) prof.update(d || {});
      }, 400);
    }
    unsubs.push(SW.live.on('_action', (a) => {
      if (!a || a.playerId == null || String(a.playerId) !== String(id)) return;
      lastActionAt = Date.now();
      refreshSoon();
    }));
    unsubs.push(SW.live.on('_evidence', (e) => {
      if (!e || !prof) return;
      /* a fresh action's own target is not known here until the refresh lands */
      if (prof.knows(e.targetType, e.targetId) || Date.now() - lastActionAt < 120000) refreshSoon();
    }));
  }

  function buildProfile(view, d, id) {
    const p = d.player || {};
    const ref = {
      dbId: num(id) || g(p, 'id'),
      name: g(p, 'name') || 'unknown',
      eosId: g(p, 'eosId', 'eos_id') || null,
      steamId: g(p, 'steamId', 'steam_id') || null,
      watchlisted: !!g(p, 'watchlisted'),
    };

    /* ---- identity head (.page-head): avatar · name · ids · actions ---- */
    const head = el('header', { class: 'page-head vw-head pf-head' });
    const ident = el('div', { class: 'vw-head-text pf-ident' });

    const av = el('div', { class: 'pf-avatar' + (d.online ? ' is-online' : '') });
    const avatarUrl = g(p, 'avatar');
    const avInner = el('div', { class: 'pf-avatar-in display' });
    if (avatarUrl) {
      const img = el('img', { src: avatarUrl, alt: '' });
      img.addEventListener('error', () => { img.remove(); avInner.textContent = initials(ref.name); });
      avInner.append(img);
    } else {
      avInner.textContent = initials(ref.name);
    }
    av.append(avInner);
    if (d.online) av.append(el('span', { class: 'pf-avatar-dot', title: 'Online now' }));

    const idText = el('div', { class: 'pf-ident-text' });
    const crumb = el('a', { class: 'vw-crumb', href: CRUMB_PLAYERS.href });
    crumb.innerHTML = SW.icon('chevron-left');
    crumb.append(el('span', { text: CRUMB_PLAYERS.label }));
    idText.append(crumb);

    const nameRow = el('div', { class: 'pf-name-row' });
    const h1 = el('h1', { class: 'page-title truncate pf-name' });
    h1.textContent = ref.name;
    h1.title = ref.name;
    nameRow.append(h1);
    const star = el('span', { class: 'vw-star pf-star' + (ref.watchlisted ? '' : ' hidden'), html: SW.icon('star'), title: 'Watchlisted' });
    nameRow.append(star);
    nameRow.append(d.online
      ? el('span', { class: 'pf-status is-online' }, el('span', { class: 'vw-pulse on' }), el('span', { text: 'Online' }))
      : el('span', { class: 'pf-status', text: 'Offline' }));
    idText.append(nameRow);

    const pastNames = uniq(listOf(d.names).map((n) => g(n, 'name')).filter((n) => n && n !== ref.name));
    if (pastNames.length) {
      const aka = el('div', { class: 'pf-aka truncate', title: 'Also seen as: ' + pastNames.join(', ') });
      aka.append(el('span', { class: 'pf-aka-k', text: 'aka' }), document.createTextNode(' ' + pastNames.join(' · ')));
      idText.append(aka);
    }

    function idChip(label, value, link) {
      const c = el('span', { class: 'pf-id' });
      c.append(el('span', { class: 'pf-id-k', text: label }));
      c.append(tspan(value, 'pf-id-v mono'));
      c.append(SW.ui.copyBtn(value));
      if (link) {
        const a = el('a', {
          class: 'icon-btn pf-id-link', href: link, target: '_blank', rel: 'noopener noreferrer',
          title: 'Open Steam profile', 'aria-label': 'Open Steam profile',
        });
        a.innerHTML = ico('external');
        c.append(a);
      }
      return c;
    }
    if (ref.eosId || ref.steamId) {
      const ids = el('div', { class: 'pf-ids' });
      if (ref.eosId) ids.append(idChip('EOS', ref.eosId));
      if (ref.steamId) ids.append(idChip('Steam', ref.steamId, 'https://steamcommunity.com/profiles/' + encodeURIComponent(ref.steamId)));
      idText.append(ids);
    }

    const meta = el('div', { class: 'pf-meta' });
    function metaItem(k, v) {
      const i = el('span', { class: 'pf-meta-i' }, el('span', { class: 'pf-meta-k', text: k }));
      if (typeof v === 'string') i.append(el('span', { text: v })); else i.append(v);
      meta.append(i);
    }
    metaItem('First seen', SW.ui.fmtTime(g(p, 'firstSeen', 'first_seen')));
    metaItem('Last seen', SW.ui.timeAgo(g(p, 'lastSeen', 'last_seen')));
    if (d.online && d.session) {
      const since = num(g(d.session, 'connectAt', 'connect_at'));
      if (since) metaItem('Online for', SW.ui.fmtDur((Date.now() - since) / 1000));
    }
    idText.append(meta);
    ident.append(av, idText);

    /* actions — each behind its own granular perm (§1); the rarely used ones
     * live in the overflow menu so the head stays calm */
    const actions = el('div', { class: 'page-actions pf-actions' });
    if (SW.can('flags')) {
      const watchBtn = el('button', { type: 'button', class: 'btn ghost pf-watch' });
      const syncWatch = () => {
        watchBtn.innerHTML = SW.icon('star') + '<span>' + (ref.watchlisted ? 'Watching' : 'Watch') + '</span>';
        watchBtn.classList.toggle('is-on', !!ref.watchlisted);
        watchBtn.setAttribute('aria-pressed', ref.watchlisted ? 'true' : 'false');
        star.classList.toggle('hidden', !ref.watchlisted);
      };
      syncWatch();
      watchBtn.addEventListener('click', async () => {
        await SW.actions.watch(ref, !ref.watchlisted);
        syncWatch();
      });
      actions.append(watchBtn);
    }
    function actBtn(label, icon, fn, danger) {
      const b = el('button', { type: 'button', class: 'btn ' + (danger ? 'danger ghost' : 'ghost') });
      b.innerHTML = SW.icon(icon) + '<span>' + SW.esc(label) + '</span>';
      b.addEventListener('click', fn);
      return b;
    }
    if (SW.can('warn')) actions.append(actBtn('Warn', 'warn', () => SW.actions.warn(ref)));
    if (SW.can('kick')) actions.append(actBtn('Kick', 'kick', () => SW.actions.kick(ref)));
    if (SW.can('ban')) actions.append(actBtn('Ban', 'ban', () => SW.actions.ban(ref), true));
    async function manualFlag() {
      try {
        const v = await SW.ui.confirmModal({
          title: 'Flag ' + ref.name,
          body: 'Creates a manual severity-2 flag on this player (shows up in the troll inbox).',
          confirmText: 'Add flag',
          fields: [{ name: 'details', label: 'Details', type: 'textarea', required: true, rows: 3 }],
        });
        if (!v) return;
        await SW.api('/api/players/' + encodeURIComponent(id) + '/flag', { method: 'POST', body: { details: v.details } });
        SW.ui.toast('Player flagged', 'ok');
      } catch (_e) { /* toasted by SW.api */ }
    }
    const more = [];
    if (SW.can('team')) more.push({ label: 'Force team change', icon: 'swap', onClick: () => SW.actions.forceTeam(ref) });
    if (SW.can('squad')) more.push({ label: 'Remove from squad', icon: 'x', onClick: () => SW.actions.removeFromSquad(ref) });
    if (SW.can('notes')) more.push({ label: 'Add note', icon: 'note', onClick: () => SW.actions.note(ref) });
    if (SW.can('flags')) more.push({ label: 'Flag player', icon: 'flag', onClick: manualFlag });
    if (more.length) {
      const mb = el('button', {
        type: 'button', class: 'btn ghost icon-only pf-more',
        title: 'More actions', 'aria-label': 'More actions', 'aria-haspopup': 'menu',
      });
      mb.innerHTML = ico('more');
      mb.addEventListener('click', (e) => { e.stopPropagation(); SW.ui.popover(mb, more); });
      actions.append(mb);
    }
    head.append(ident, actions);

    /* ---- stat groups (hero tiles) ---- */
    const kills = num(g(p, 'kills'));
    const deaths = num(g(p, 'deaths'));
    const tks = num(g(p, 'teamkills'));
    const tkd = num(g(p, 'tkDeaths', 'tk_deaths'));
    const sui = num(g(p, 'suicides'));
    const rg = num(g(p, 'revivesGiven', 'revives_given'));
    const rt = num(g(p, 'revivesTaken', 'revives_taken'));
    const rdf = num(g(p, 'radioDamageFriendly', 'radio_damage_friendly', 'radioFriendly'));
    const rde = num(g(p, 'radioDamageEnemy', 'radio_damage_enemy'));
    const hdf = num(g(p, 'habDamageFriendly', 'hab_damage_friendly', 'habFriendly'));
    const hde = num(g(p, 'habDamageEnemy', 'hab_damage_enemy'));
    const flagCount = totalOf(d.flags);

    function statGroup(title, items, cls) {
      const card = el('section', { class: 'card hud pf-stats ' + cls });
      card.append(el('h2', { class: 'card-title', text: title }));
      const grid = el('div', { class: 'pf-stat-grid' });
      for (const it of items) {
        const s = el('div', { class: 'pf-stat' + (it[2] ? ' ' + it[2] : '') });
        s.append(el('div', { class: 'pf-stat-l', text: it[0] }));
        const v = el('div', { class: 'pf-stat-v display tabular truncate' });
        v.textContent = it[1];
        v.title = it[0] + ': ' + it[1];
        s.append(v);
        grid.append(s);
      }
      card.append(grid);
      return card;
    }
    const stats = el('div', { class: 'pf-statgroups vw-grid' },
      statGroup('Combat', [
        ['Kills', SW.ui.fmtNum(kills)],
        ['Deaths', SW.ui.fmtNum(deaths)],
        ['K/D', kdText(kills, deaths)],
        ['Revives given', SW.ui.fmtNum(rg), rg > 0 ? 'good' : ''],
        ['Revives taken', SW.ui.fmtNum(rt)],
        ['Playtime', SW.ui.fmtDur(g(p, 'playSeconds', 'play_seconds'))],
      ], 'pf-combat'),
      statGroup('Conduct', [
        ['Teamkills', SW.ui.fmtNum(tks), tks > 0 ? 'bad' : ''],
        ['TK deaths', SW.ui.fmtNum(tkd)],
        ['Suicides', SW.ui.fmtNum(sui)],
        ['Flags', SW.ui.fmtNum(flagCount), flagCount > 0 ? 'warn' : ''],
      ], 'pf-conduct'),
      statGroup('Deployable damage', [
        ['Radio · friendly', fmtDmg(rdf), rdf > 0 ? 'purple' : ''],
        ['Radio · enemy', fmtDmg(rde)],
        ['HAB · friendly', fmtDmg(hdf), hdf > 0 ? 'purple' : ''],
        ['HAB · enemy', fmtDmg(hde)],
      ], 'pf-deploy'));

    /* ---- tab data ---- */
    const recentKills = listOf(d.recentKills).map(normKill);
    const recentDeaths = listOf(d.recentDeaths).map(normKill);
    const tkList = listOf(d.tkIncidents).map(normKill);
    const depList = listOf(d.deployableDamage);
    const matchesList = listOf(d.matches);
    const notesList = listOf(d.notes);
    const chatCount = num(g(d, 'chatCount', 'chat_count'));
    /* Discipline data is replaced in place by update() */
    const disc = {};
    function setDisc(src) {
      disc.warnings = listOf(src.warnings);
      disc.bans = listOf(src.bans);
      disc.flags = listOf(src.flags);
      /* the player's warn / kick / ban admin actions, when the API lists them */
      const acts = src.actions != null ? src.actions : src.adminActions;
      disc.actions = acts == null ? null : listOf(acts).filter((a) => ACTION_KIND_SET[String(g(a, 'action'))]);
    }
    setDisc(d);
    function disciplineCount() { return disc.warnings.length + disc.bans.length + disc.flags.length; }

    /* Overview: merged recent kills/deaths timeline */
    function renderOverview(c) {
      const seen = new Set();
      const merged = [];
      for (const k of recentKills.concat(recentDeaths)) {
        const key = killKey(k);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(k);
      }
      merged.sort((a, b) => num(b.time) - num(a.time));
      const pn = panel({ title: 'Recent kills & deaths', flush: true });
      if (merged.length) pn.setCount(merged.length > 100 ? 100 : merged.length);
      if (!merged.length) {
        pn.body.append(logMissing()
          ? logEmpty('Kills and deaths')
          : emptyState('No recent kills or deaths', 'Combat shows up here once this player fights.', 'swords'));
      } else {
        const feed = el('div', { class: 'feed vw-feed' });
        for (const k of merged.slice(0, 100)) feed.append(killFeedRow(k, { matchLink: true, selfId: ref.dbId }));
        pn.body.append(feed);
      }
      c.append(pn.el);
    }

    function renderMatchesTab(c) {
      const cols = [
        { key: 'layer', label: 'Layer', class: 'vw-col-name', render: (r) => tspan(g(r, 'layer') || '—', 'vw-strong') },
        {
          key: 'startedAt', label: 'Started', sortable: true,
          sortVal: (r) => num(g(r, 'startedAt', 'started_at')),
          render: (r) => SW.ui.timeAgo(g(r, 'startedAt', 'started_at')),
        },
        { key: 'teamId', label: 'Team', hide: 'sm', render: (r) => teamBadge(g(r, 'teamId', 'team_id')) },
        { key: 'kills', label: 'K', sortable: true, align: 'right', sortVal: (r) => num(r.kills), render: (r) => SW.ui.fmtNum(r.kills) },
        { key: 'deaths', label: 'D', sortable: true, align: 'right', hide: 'xs', sortVal: (r) => num(r.deaths), render: (r) => SW.ui.fmtNum(r.deaths) },
        { key: 'teamkills', label: 'TK', sortable: true, align: 'right', sortVal: (r) => num(r.teamkills), render: (r) => tkCellNode(r.teamkills) },
        { key: 'revives', label: 'Revives', align: 'right', hide: 'sm', render: (r) => SW.ui.fmtNum(r.revives) },
        { key: 'damage', label: 'Damage', align: 'right', hide: 'sm', sortable: true, sortVal: (r) => num(g(r, 'damage', 'damageDealt', 'damage_dealt')), render: (r) => fmtDmg(g(r, 'damage', 'damageDealt', 'damage_dealt')) },
      ];
      const pn = panel({ title: 'Match history', flush: true });
      pn.setCount(matchesList.length);
      pn.body.append(mkTable(cols, matchesList, {
        sort: { key: 'startedAt', dir: 'desc' },
        onRowClick: (r) => { const mid = g(r, 'matchId', 'match_id', 'id'); if (mid != null) SW.navigate('#/matches/' + mid); },
        emptyText: 'No matches recorded for this player',
      }));
      c.append(pn.el);
    }

    function renderIncidents(c) {
      const grid = el('div', { class: 'pf-stack' });
      /* teamkills */
      const tkPanel = panel({ title: 'Teamkills', flush: true });
      tkPanel.setCount(totalOf(d.tkIncidents), 'warn');
      if (tkList.length) {
        const feed = el('div', { class: 'feed vw-feed vw-feed-tall' });
        for (const k of tkList.slice().sort((a, b) => num(b.time) - num(a.time))) feed.append(killFeedRow(k, { matchLink: true }));
        tkPanel.body.append(feed);
        const tn = truncNote(d.tkIncidents, 'teamkills');
        if (tn) tkPanel.foot().append(tn);
      } else {
        tkPanel.body.append(logMissing()
          ? logEmpty('Teamkills')
          : emptyState('No teamkills recorded', 'Clean record so far.', 'shield'));
      }
      /* deployable damage */
      const depPanel = panel({ title: 'Deployable damage', flush: true });
      depPanel.setCount(totalOf(d.deployableDamage));
      depPanel.body.append(deployablesTable(depList, { withMatch: true }));
      const dn = truncNote(d.deployableDamage, 'deployable-damage events');
      if (dn) depPanel.foot().append(dn);
      grid.append(tkPanel.el, depPanel.el);
      c.append(grid);
    }

    function renderChatTab(c) {
      let page = 0;
      let perGuess = 50;
      let seqc = 0;
      const pn = panel({ title: 'Chat history', flush: true });
      pn.setCount(chatCount);
      const link = el('a', {
        class: 'btn ghost small',
        href: '#/chat?playerId=' + encodeURIComponent(id) + '&player=' + encodeURIComponent(ref.name),
      });
      link.innerHTML = SW.icon('search') + '<span>Open in chat search</span>';
      pn.tools.append(link);
      const list = chatList({ hidePlayer: true, withMatch: true, emptyText: 'No chat messages from this player' });
      pn.body.append(skeleton(6));
      c.append(pn.el);
      let shown = false;
      async function loadChat() {
        const my = ++seqc;
        let r;
        try { r = await SW.api('/api/players/' + encodeURIComponent(id) + '/chat?page=' + page + '&per=50'); }
        catch (_e) {
          if (my !== seqc) return;
          shown = false;
          pn.body.textContent = '';
          pn.body.append(emptyState('Could not load chat history', 'The server did not answer — try again in a moment.', 'chat'));
          return;
        }
        if (my !== seqc) return;
        if (!shown) { shown = true; pn.body.textContent = ''; pn.body.append(list.el); }
        const rows = ((r && r.rows) || []).map(normChat);
        perGuess = Math.max(perGuess, rows.length);
        list.update(rows);
        const total = num(r && r.total);
        const foot = pn.foot();
        foot.textContent = '';
        const multi = total > rows.length || page > 0;
        foot.classList.toggle('hidden', !multi);
        if (multi) foot.append(SW.ui.pager({ page, per: perGuess, total, onPage: (pg) => { page = pg; loadChat(); } }));
      }
      loadChat();
    }

    function renderSessions(c) {
      const sTbl = mkTable([
        { key: 'connect', label: 'Connected', render: (r) => el('span', { class: 'mono vw-dimtext', text: stamp(g(r, 'connectAt', 'connect_at')), title: SW.ui.fmtTime(g(r, 'connectAt', 'connect_at')) }) },
        {
          key: 'disconnect', label: 'Disconnected',
          render: (r) => {
            const dc = g(r, 'disconnectAt', 'disconnect_at');
            return dc ? el('span', { class: 'mono vw-dimtext', text: stamp(dc), title: SW.ui.fmtTime(dc) }) : SW.ui.badge('online', 'green');
          },
        },
        {
          key: 'dur', label: 'Duration', align: 'right',
          render: (r) => {
            const a = num(g(r, 'connectAt', 'connect_at'));
            if (!a) return '—';
            const b = g(r, 'disconnectAt', 'disconnect_at');
            return SW.ui.fmtDur(((b ? num(b) : Date.now()) - a) / 1000);
          },
        },
      ], listOf(d.sessions), { emptyText: 'No sessions recorded' });

      const ipTbl = mkTable([
        {
          key: 'ip', label: 'IP', class: 'vw-col-name',
          render: (r) => el('span', { class: 'vw-ipcell' }, tspan(r.ip || '', 'mono'), SW.ui.copyBtn(r.ip || '')),
        },
        { key: 'times', label: 'Conns', align: 'right', render: (r) => SW.ui.fmtNum(r.times) },
        { key: 'firstSeen', label: 'First seen', hide: 'sm', render: (r) => el('span', { class: 'mono vw-dimtext', text: stamp(g(r, 'firstSeen', 'first_seen')), title: SW.ui.fmtTime(g(r, 'firstSeen', 'first_seen')) }) },
        { key: 'lastSeen', label: 'Last seen', align: 'right', render: (r) => SW.ui.timeAgo(g(r, 'lastSeen', 'last_seen')) },
      ], listOf(d.ips), { emptyText: 'No IP addresses recorded' });

      const altTbl = mkTable([
        { key: 'name', label: 'Player', class: 'vw-col-name', render: (r) => nameLink(refOf(r)) },
        { key: 'sharedIps', label: 'Shared IPs', align: 'right', render: (r) => SW.ui.fmtNum(g(r, 'sharedIps', 'shared_ips')) },
      ], listOf(d.alts), {
        onRowClick: (r) => { const pid = g(r, 'playerId', 'player_id', 'id'); if (pid != null) SW.navigate('#/players/' + pid); },
        emptyText: 'No other accounts share an IP with this player',
      });

      const sP = panel({ title: 'Sessions', flush: true });
      sP.setCount(listOf(d.sessions).length);
      sP.body.append(sTbl);
      const iP = panel({ title: 'IP addresses', flush: true });
      iP.setCount(listOf(d.ips).length);
      iP.body.append(ipTbl);
      const aP = panel({ title: 'Possible alts', flush: true });
      aP.setCount(listOf(d.alts).length, listOf(d.alts).length ? 'warn' : null);
      aP.tools.append(el('span', { class: 'vw-hint', text: 'accounts sharing an IP' }));
      aP.body.append(altTbl);
      c.append(el('div', { class: 'pf-split vw-grid' }, sP.el, el('div', { class: 'pf-stack' }, iP.el, aP.el)));
    }

    function isPermBan(r) {
      const raw = g(r, 'intervalRaw', 'interval_raw');
      if (raw != null) return String(raw) === '0';
      return !g(r, 'expiresAt', 'expires_at');
    }
    function banIsLive(r) {
      if (g(r, 'unbannedAt', 'unbanned_at')) return false;
      return num(g(r, 'active')) === 1 && (isPermBan(r) || num(g(r, 'expiresAt', 'expires_at')) > Date.now());
    }
    function banStatus(r) {
      if (g(r, 'unbannedAt', 'unbanned_at')) return SW.ui.badge('unbanned', 'dim');
      return banIsLive(r) ? SW.ui.badge('active', 'red') : SW.ui.badge('expired', 'dim');
    }
    function banDuration(r) {
      if (isPermBan(r)) return 'Permanent';
      const raw = g(r, 'intervalRaw', 'interval_raw');
      if (raw) return String(raw);
      const ds = num(g(r, 'durationSec', 'duration_sec'));
      return ds ? SW.ui.fmtDur(ds) : '—';
    }

    /* one ban: status · duration · when / who / expiry, the reason, the
     * private note (sent only to ban holders), and its evidence */
    function banCard(r) {
      const live = banIsLive(r);
      const card = el('article', { class: 'pf-ban' + (live ? ' is-active' : '') });
      const head = el('div', { class: 'pf-ban-head' });
      head.append(banStatus(r), el('span', { class: 'pf-ban-dur display' + (isPermBan(r) ? ' is-perm' : ''), text: banDuration(r) }));
      if (g(r, 'source') === 'battlemetrics') head.append(SW.ui.badge('BattleMetrics', 'accent', 'Imported from BattleMetrics'));
      const meta = el('span', { class: 'pf-ban-meta' });
      const issued = g(r, 'issuedAt', 'issued_at');
      meta.append(el('span', { class: 'mono', text: stamp(issued), title: SW.ui.fmtTime(issued) }));
      const issuer = g(r, 'issuer');
      if (issuer) meta.append(el('span', { class: 'pf-ban-by' }, el('span', { text: 'by' }), tspan(issuer, 'pf-ban-issuer')));
      const ex = num(g(r, 'expiresAt', 'expires_at'));
      if (live && !isPermBan(r) && ex) {
        meta.append(el('span', { class: 'pf-countdown mono', text: 'ends in ' + SW.ui.fmtDur((ex - Date.now()) / 1000), title: SW.ui.fmtTime(ex) }));
      } else if (!live && ex && !g(r, 'unbannedAt', 'unbanned_at')) {
        meta.append(el('span', { class: 'mono vw-dimtext', text: 'ended ' + stamp(ex), title: SW.ui.fmtTime(ex) }));
      }
      head.append(meta);
      const evCount = num(g(r, 'evidenceCount', 'evidence_count'));
      const canView = SW.evidence.canView();
      if (canView && r.id != null) {
        const btn = SW.ui.evidenceButton({
          targetType: 'ban', targetId: r.id, count: evCount, canUpload: SW.can('ban'),
          title: 'Evidence · ban #' + r.id, subtitle: (ref.name || 'Player') + ' — ' + banDuration(r).toLowerCase() + ' ban, ' + stamp(issued),
        });
        btn.classList.add('pf-ban-ev');
        head.append(btn);
      } else if (evCount) {
        head.append(el('span', { class: 'pf-ban-evn', title: evCount + ' evidence file' + (evCount === 1 ? '' : 's'), html: SW.icon('paperclip') },
          el('span', { class: 'tabular', text: String(evCount) })));
      }
      card.append(head);
      const reason = el('div', { class: 'pf-ban-reason wrap-anywhere' });
      reason.textContent = r.reason == null || r.reason === '' ? 'No reason given' : String(r.reason);
      if (r.reason == null || r.reason === '') reason.classList.add('is-empty');
      card.append(reason);
      if (r.note) {
        const note = el('div', { class: 'pf-ban-note' });
        note.append(el('span', { class: 'pf-ban-note-ic', html: SW.icon('lock'), title: 'Private — staff who can ban only' }),
          el('div', { class: 'pf-ban-note-body' },
            el('span', { class: 'pf-ban-note-k', text: 'Private note' }),
            el('div', { class: 'pf-ban-note-text wrap-anywhere', text: String(r.note) })));
        card.append(note);
      }
      if (canView && evCount > 0 && r.id != null) {
        card.append(SW.ui.evidenceList({ targetType: 'ban', targetId: r.id, compact: true, count: evCount }));
      }
      return card;
    }

    /* the player's warn / kick / ban actions with their evidence (rows like
     * GET /api/audit's), shown when the profile API includes them */
    function actionsPanel() {
      const rows = disc.actions.slice().sort((a, b) => num(b.time) - num(a.time));
      const pn = panel({ title: 'Admin actions', flush: true });
      pn.setCount(rows.length);
      const KIND_BADGE = { warn: 'dim', kick: 'warn', ban: 'red' };
      pn.body.append(mkTable([
        { key: 'time', label: 'Time', render: (r) => SW.ui.timeAgo(r.time) },
        { key: 'action', label: 'Action', render: (r) => SW.ui.badge(String(r.action), KIND_BADGE[r.action] || 'dim') },
        {
          key: 'details', label: 'Reason / message', class: 'vw-col-wrap',
          render: (r) => {
            let det = g(r, 'details');
            if (typeof det === 'string') { try { det = JSON.parse(det); } catch (_e) { det = { reason: det }; } }
            det = det && typeof det === 'object' ? det : {};
            const s = el('span', { class: 'vw-wrapcell' });
            s.append(el('span', { class: 'wrap-anywhere', text: String(det.message || det.reason || '—') }));
            if (r.action === 'ban' && det.interval != null) s.append(SW.ui.badge(String(det.interval) === '0' ? 'perm' : String(det.interval), 'dim'));
            return s;
          },
        },
        { key: 'by', label: 'By', hide: 'sm', render: (r) => { const by = g(r, 'username', 'byUsername'); return by ? tspan(by, 'vw-dimtext') : zero('—'); } },
        {
          key: 'evidence', label: 'Evidence', align: 'right',
          render: (r) => (SW.evidence.canView() && r.id != null
            ? SW.ui.evidenceButton({
              targetType: 'action', targetId: r.id, count: num(g(r, 'evidenceCount', 'evidence_count')),
              canUpload: SW.can(String(r.action)), title: 'Evidence · ' + r.action + ' #' + r.id,
              /* the ban dialog attaches its files to the ban, not to this row */
              subtitle: (ref.name || 'Player') + ' — ' + r.action + ', ' + stamp(r.time) + (r.action === 'ban'
                ? '. These files belong to this action entry; files on the ban itself are on its ban card above.'
                : ''),
            })
            : SW.ui.fmtNum(num(g(r, 'evidenceCount', 'evidence_count')))),
        },
      ], rows, { emptyText: 'No warn, kick or ban actions recorded' }));
      return pn.el;
    }

    function renderDiscipline(c) {
      const warningsList = disc.warnings;
      const bansList = disc.bans;
      const flagsList = disc.flags;
      const warnTbl = mkTable([
        { key: 'time', label: 'Time', render: (r) => SW.ui.timeAgo(r.time) },
        {
          key: 'message', label: 'Message', class: 'vw-col-wrap',
          render: (r) => {
            const s = el('span', { class: 'vw-wrapcell' });
            const t = el('span', { class: 'wrap-anywhere' });
            t.textContent = r.message == null ? '' : String(r.message);
            s.append(t);
            if (g(r, 'auto')) s.append(SW.ui.badge('auto', 'dim'));
            return s;
          },
        },
        { key: 'by', label: 'By', hide: 'sm', render: (r) => { const by = g(r, 'byUsername', 'by_username'); return by ? tspan(by, 'vw-dimtext') : zero('—'); } },
      ], warningsList, { emptyText: 'No warnings' });

      const wP = panel({ title: 'Warnings', flush: true });
      wP.setCount(warningsList.length);
      wP.body.append(warnTbl);
      const bP = panel({ title: 'Bans', flush: true });
      bP.setCount(bansList.length, bansList.some(banIsLive) ? 'warn' : null);
      if (bansList.length) {
        const cards = el('div', { class: 'pf-bans' });
        for (const r of bansList.slice().sort((a, b) => num(g(b, 'issuedAt', 'issued_at')) - num(g(a, 'issuedAt', 'issued_at')))) {
          cards.append(banCard(r));
        }
        bP.body.append(cards);
      } else {
        bP.body.append(emptyState('No bans', 'Bans issued from the panel or imported from BattleMetrics land here.', 'ban'));
      }
      const fP = panel({ title: 'Flags', flush: true });
      fP.setCount(flagsList.length, flagsList.some((f) => !g(f, 'reviewed')) ? 'warn' : null);
      fP.body.append(flagsList.length
        ? flagList(flagsList, { hidePlayer: true })
        : emptyState('No flags on this player', 'Automatic detections and manual flags land here.', 'flag'));
      const stack = el('div', { class: 'pf-stack' }, bP.el);
      if (disc.actions) stack.append(actionsPanel());
      stack.append(wP.el, fP.el);
      c.append(stack);
    }

    function renderNotes(c) {
      const pn = panel({ title: 'Admin notes' });
      pn.setCount(notesList.length);
      const list = el('div', { class: 'pf-notes' });
      let emptyEl = null;
      function noteRow(n) {
        const r = el('article', { class: 'pf-note' });
        const t = el('div', { class: 'pf-note-text wrap-anywhere' });
        t.textContent = n.text == null ? '' : String(n.text);
        const by = g(n, 'byUsername', 'username', 'byUser', 'by_user');
        const byTxt = by == null ? '' : (typeof by === 'number' ? 'user #' + by : String(by));
        const m = el('div', { class: 'pf-note-meta' });
        if (byTxt) m.append(tspan(byTxt, 'pf-note-by'));
        m.append(el('span', { class: 'mono', text: stamp(n.time), title: SW.ui.fmtTime(n.time) }));
        r.append(t, m);
        return r;
      }
      if (SW.can('notes')) {
        const ta = el('textarea', { class: 'input', rows: '3', placeholder: 'Add a note visible to admins…', 'aria-label': 'New note' });
        const save = el('button', { type: 'button', class: 'btn primary', text: 'Save note' });
        save.addEventListener('click', async () => {
          const text = ta.value.trim();
          if (!text) return;
          save.disabled = true;
          try {
            const r = await SW.api('/api/players/' + encodeURIComponent(id) + '/notes', { method: 'POST', body: { text } });
            ta.value = '';
            if (emptyEl) { emptyEl.remove(); emptyEl = null; }
            list.prepend(flash(noteRow((r && r.note) || { text, time: Date.now() })));
            SW.ui.toast('Note saved', 'ok');
          } catch (_e) { /* toasted by SW.api */ }
          save.disabled = false;
        });
        pn.body.append(el('div', { class: 'pf-composer' }, ta, el('div', { class: 'pf-composer-row' }, save)));
      }
      if (!notesList.length) {
        emptyEl = emptyState('No notes yet', 'Context for other admins: warnings given, appeals, history.', 'note');
        list.append(emptyEl);
      } else {
        for (const n of notesList.slice().sort((a, b) => num(b.time) - num(a.time))) list.append(noteRow(n));
      }
      pn.body.append(list);
      c.append(pn.el);
    }

    const tabs = tabsView([
      { id: 'overview', label: 'Overview', render: renderOverview },
      { id: 'matches', label: 'Matches', badge: matchesList.length || null, render: renderMatchesTab },
      {
        id: 'incidents', label: 'Incidents',
        badge: (totalOf(d.tkIncidents) + totalOf(d.deployableDamage)) || null,
        badgeKind: 'warn', render: renderIncidents,
      },
      { id: 'chat', label: 'Chat', badge: chatCount || null, render: renderChatTab },
      { id: 'sessions', label: 'Sessions & IPs', hidden: !SW.can('ips'), render: renderSessions },
      { id: 'discipline', label: 'Discipline', badge: disciplineCount() || null, render: renderDiscipline },
      { id: 'notes', label: 'Notes', badge: notesList.length || null, render: renderNotes },
    ]);

    view.append(head, stats, tabs.el);

    return {
      /* fresh profile data: only the Discipline tab is redrawn */
      update(d2) {
        setDisc(d2);
        tabs.setBadge('discipline', disciplineCount() || null);
        if (tabs.get() === 'discipline') tabs.set('discipline', true);
      },
      /* is this evidence target one of the player's bans or actions? */
      knows(type, targetId) {
        const list = type === 'ban' ? disc.bans : (type === 'action' ? (disc.actions || []) : []);
        return list.some((r) => r && r.id != null && String(r.id) === String(targetId));
      },
    };
  }

  /* ========================================================= MATCHES list */

  function matchResultCell(r) {
    const ended = g(r, 'endedAt', 'ended_at');
    const wt = num(g(r, 'winnerTeam', 'winner_team'));
    if (!wt && !ended) return liveTag('Live');
    if (!wt) return zero('No result');
    const wrap = el('span', { class: 'ml-result' });
    const fac = g(r, 'winnerFaction', 'winner_faction') || 'Team ' + wt;
    wrap.append(el('span', { class: 'ml-swatch t' + wt, 'aria-hidden': 'true' }), tspan(fac + ' won', 'ml-winner'));
    const tk = g(r, 'tickets');
    if (tk != null) wrap.append(el('span', { class: 'ml-tickets mono', text: SW.ui.fmtNum(tk) + ' tickets', title: 'Winner finished with ' + num(tk) + ' tickets' }));
    return wrap;
  }

  function renderMatchesList(main) {
    const unsubs = [];
    let reloadTimer = null;
    this.cleanup = () => {
      unsubs.forEach((u) => u());
      if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    };
    let page = 0;
    let perGuess = 50;
    let seq = 0;
    let shown = false;
    let noMatches = false;
    const view = el('div', { class: 'view vw vw-matches fade-in' });
    main.append(view);

    const head = pageHead({ title: 'Matches', sub: 'Every round the server has played, newest first — open one for the scoreboard and kill feed.' });
    view.append(head.el);

    const pnl = panel({ title: 'Match history', flush: true, cls: 'vw-grid-panel' });
    pnl.body.append(skeleton(10, 'vw-skel-table'));
    view.append(pnl.el);

    const cols = [
      {
        key: 'layer', label: 'Layer', class: 'vw-col-name',
        render: (r) => {
          const w = el('span', { class: 'ml-layer' });
          w.append(tspan(g(r, 'layer') || '—', 'ml-layer-name'));
          if (g(r, 'level')) w.append(tspan(g(r, 'level'), 'ml-level'));
          return w;
        },
      },
      { key: 'startedAt', label: 'Started', hide: 'xs', render: (r) => SW.ui.timeAgo(g(r, 'startedAt', 'started_at')) },
      { key: 'duration', label: 'Duration', align: 'right', hide: 'md', render: matchDur },
      { key: 'result', label: 'Result', class: 'vw-col-result', render: matchResultCell },
      { key: 'players', label: 'Players', align: 'right', hide: 'lg', render: (r) => SW.ui.fmtNum(r.players) },
      { key: 'kills', label: 'Kills', align: 'right', hide: 'md', render: (r) => SW.ui.fmtNum(r.kills) },
      { key: 'teamkills', label: 'TKs', align: 'right', render: (r) => tkCellNode(r.teamkills) },
    ];
    const tbl = mkTable(cols, [], {
      class: 'vw-scroll',
      onRowClick: (r) => { const mid = g(r, 'id', 'matchId'); if (mid != null) SW.navigate('#/matches/' + mid); },
      rowClass: (r) => (!num(g(r, 'winnerTeam', 'winner_team')) && !g(r, 'endedAt', 'ended_at') ? 'ml-live-row' : ''),
      emptyText: 'No matches recorded yet',
    });

    async function load() {
      const my = ++seq;
      pnl.el.classList.add('is-busy');
      let r;
      try { r = await SW.api('/api/matches?page=' + page + '&per=50'); } catch (_e) {
        if (my !== seq) return;
        pnl.el.classList.remove('is-busy');
        if (!shown) {
          pnl.body.textContent = '';
          pnl.body.append(emptyState('Could not load matches', 'The server did not answer — try again in a moment.', 'swords'));
        }
        return;
      }
      if (my !== seq) return;
      pnl.el.classList.remove('is-busy');
      const rows = (r && r.rows) || [];
      const total = num(r && r.total);
      perGuess = Math.max(perGuess, rows.length);
      noMatches = !rows.length && page === 0;
      /* a match opens on the game log's map change: an empty history with
       * no log feed says why instead of "no matches recorded yet" */
      if (noMatches && logMissing()) {
        shown = false;
        pnl.body.textContent = '';
        pnl.body.append(logEmpty('Matches'));
      } else if (!shown) { shown = true; pnl.body.textContent = ''; pnl.body.append(tbl); }
      tbl.update(rows);
      pnl.setCount(total);
      const foot = pnl.foot();
      foot.textContent = '';
      const multi = total > perGuess || page > 0;
      foot.classList.toggle('hidden', !multi);
      if (multi) {
        foot.append(SW.ui.pager({
          page, per: perGuess, total,
          onPage: (p) => { page = p; load(); },
        }));
      }
    }

    /* a NEW_GAME / ROUND_ENDED while watching page 1 refreshes the list */
    unsubs.push(SW.live.on('match', () => {
      if (page !== 0 || reloadTimer) return;
      reloadTimer = setTimeout(() => { reloadTimer = null; load(); }, 1500);
    }));
    unsubs.push(SW.live.on('_logfeed', () => { if (noMatches) load(); }));

    load();
  }

  /* ======================================================== MATCH detail */

  function renderMatchDetail(main, ctx) {
    this.cleanup = () => {};
    const id = ctx.args[0];
    const view = el('div', { class: 'view vw vw-match fade-in' });
    main.append(view);
    view.append(pageSkeleton());
    (async () => {
      let d;
      try { d = await SW.api('/api/matches/' + encodeURIComponent(id)); }
      catch (e) {
        view.textContent = '';
        const missing = e && e.status === 404;
        view.append(pageHead({ title: 'Match', crumb: CRUMB_MATCHES }).el);
        const back = el('a', { class: 'btn primary', href: '#/matches', text: 'Back to matches' });
        view.append(emptyCard(
          missing ? 'No such match' : 'Could not load this match',
          missing ? 'This match id is not in the database.' : 'The server did not answer — try again in a moment.',
          'swords', back));
        refade(view);
        return;
      }
      view.textContent = '';
      buildMatch(view, d || {});
      refade(view);
    })();
  }

  function normScore(r) {
    return {
      playerId: g(r, 'playerId', 'player_id', 'id'),
      name: g(r, 'name', 'playerName', 'player_name') || 'unknown',
      eosId: g(r, 'eosId', 'eos_id'),
      steamId: g(r, 'steamId', 'steam_id'),
      teamId: num(g(r, 'teamId', 'team_id')),
      kills: num(g(r, 'kills')),
      deaths: num(g(r, 'deaths')),
      teamkills: num(g(r, 'teamkills')),
      tkDeaths: num(g(r, 'tkDeaths', 'tk_deaths')),
      revives: num(g(r, 'revives')),
      damage: num(g(r, 'damage', 'damageDealt', 'damage_dealt')),
    };
  }

  function buildMatch(view, d) {
    const m = d.match || {};
    const team1 = g(m, 'team1') || 'Team 1';
    const team2 = g(m, 'team2') || 'Team 2';
    const started = g(m, 'startedAt', 'started_at');
    const ended = g(m, 'endedAt', 'ended_at');
    const winnerTeam = num(g(m, 'winnerTeam', 'winner_team'));
    const tickets = g(m, 'tickets');
    const sbRows = listOf(d.scoreboard).map(normScore);

    /* ---- head ---- */
    const head = pageHead({ title: g(m, 'layer') || 'Match', truncate: true, crumb: CRUMB_MATCHES });
    const sub = el('span', { class: 'vw-subparts' });
    if (g(m, 'level')) sub.append(tspan(g(m, 'level')));
    sub.append(el('span', { text: SW.ui.fmtTime(started) }));
    sub.append(el('span', { text: (ended ? 'lasted ' : 'running ') + matchDur(m) }));
    head.setSub(sub);

    /* ---- versus hero ---- */
    function teamTotals(t) {
      const rows = sbRows.filter((r) => r.teamId === t);
      return {
        players: rows.length,
        kills: rows.reduce((n, r) => n + r.kills, 0),
        tks: rows.reduce((n, r) => n + r.teamkills, 0),
      };
    }
    function vsSide(t, name) {
      const tt = teamTotals(t);
      const won = winnerTeam === t;
      const lost = (winnerTeam === 1 || winnerTeam === 2) && !won;
      const s = el('div', { class: 'md-vs-side t' + t + (won ? ' is-win' : '') + (lost ? ' is-loss' : '') });
      const lab = el('div', { class: 'md-vs-label' }, el('span', { text: 'Team ' + t }));
      if (won) lab.append(el('span', { class: 'md-vs-tag', text: 'Victory' }));
      s.append(lab, tspan(name, 'md-vs-name display'));
      s.append(el('div', {
        class: 'md-vs-stats',
        text: tt.players + (tt.players === 1 ? ' player' : ' players') + ' · ' + SW.ui.fmtNum(tt.kills) + ' kills' + (tt.tks ? ' · ' + tt.tks + ' TK' : ''),
      }));
      return s;
    }
    const mid = el('div', { class: 'md-vs-mid' });
    if (winnerTeam === 1 || winnerTeam === 2) {
      const fac = g(m, 'winnerFaction', 'winner_faction') || (winnerTeam === 1 ? team1 : team2);
      mid.append(tspan(fac + ' won', 'md-vs-k'));
      mid.append(el('div', { class: 'md-vs-v display tabular', text: tickets != null ? SW.ui.fmtNum(tickets) : '—' }));
      mid.append(el('div', { class: 'md-vs-u', text: 'tickets left' }));
    } else if (!ended) {
      mid.append(el('div', { class: 'md-vs-k' }, liveTag('Live')));
      mid.append(el('div', { class: 'md-vs-v display tabular', text: matchDur(m) }));
      mid.append(el('div', { class: 'md-vs-u', text: 'elapsed' }));
    } else {
      mid.append(el('div', { class: 'md-vs-k', text: 'Match ended' }));
      mid.append(el('div', { class: 'md-vs-v md-vs-none display', text: 'No result' }));
      mid.append(el('div', { class: 'md-vs-u', text: 'lasted ' + matchDur(m) }));
    }
    const vs = el('section', { class: 'card hud md-vs' + (winnerTeam === 1 || winnerTeam === 2 ? ' won-' + winnerTeam : '') });
    vs.append(vsSide(1, team1), mid, vsSide(2, team2));

    /* ---- scoreboards: two team columns ≥1280px, stacked below ---- */
    function scoreCol(teamId, teamName) {
      const rows = sbRows.filter((r) => r.teamId === teamId);
      const pn = panel({ flush: true, cls: 'md-team t' + teamId });
      const idBox = el('div', { class: 'md-team-id' },
        el('span', { class: 'md-team-label', text: 'Team ' + teamId }),
        tspan(teamName, 'md-team-name'));
      pn.head.prepend(idBox);
      pn.tools.append(el('span', { class: 'vw-resultcount', text: rows.length + (rows.length === 1 ? ' player' : ' players') }));
      const cols = [
        { key: 'name', label: 'Player', class: 'vw-col-name', render: (r) => nameLink({ dbId: r.playerId, name: r.name, eosId: r.eosId, steamId: r.steamId }) },
        { key: 'kills', label: 'K', sortable: true, align: 'right' },
        { key: 'deaths', label: 'D', sortable: true, align: 'right' },
        { key: 'teamkills', label: 'TK', sortable: true, align: 'right', render: (r) => tkCellNode(r.teamkills) },
        { key: 'revives', label: 'Rev', sortable: true, align: 'right', hide: 'xs' },
        { key: 'damage', label: 'Dmg', sortable: true, align: 'right', hide: 'xs', sortVal: (r) => r.damage, render: (r) => fmtDmg(r.damage) },
      ];
      pn.body.append(mkTable(cols, rows, {
        sort: { key: 'kills', dir: 'desc' },
        emptyText: 'No players recorded',
      }));
      return pn.el;
    }
    const sb = el('div', { class: 'md-scoreboard vw-grid' }, scoreCol(1, team1), scoreCol(2, team2));

    /* ---- tabs ---- */
    const kills = listOf(d.kills).map(normKill);
    const deps = listOf(d.deployables);
    const chat = listOf(d.chat).map(normChat);
    const flags = listOf(d.flags);

    function renderKillsTab(c) {
      let tkOnly = false;
      const pn = panel({ title: 'Kill feed', flush: true });
      pn.setCount(totalOf(d.kills));
      const chips = chipBar([
        { value: false, label: 'All kills' },
        { value: true, label: 'Teamkills only' },
      ], false, (v) => { tkOnly = v; drawFeed(); }, { label: 'Kill filter' });
      pn.tools.append(chips.el);
      const feed = el('div', { class: 'feed vw-feed vw-feed-tall' });
      pn.body.append(feed);
      function drawFeed() {
        feed.textContent = '';
        const rows = tkOnly ? kills.filter((k) => k && k.teamkill) : kills;
        if (!rows.length) {
          feed.append(!ended && logMissing()
            ? logEmpty(tkOnly ? 'Teamkills' : 'Kills and teamkills')
            : emptyState(tkOnly ? 'No teamkills this match' : 'No kills recorded', null, 'swords'));
          return;
        }
        for (const k of rows) feed.append(killFeedRow(k));
      }
      drawFeed();
      const tn = truncNote(d.kills, 'kills');
      if (tn) pn.foot().append(tn);
      c.append(pn.el);
    }

    function renderDepsTab(c) {
      const depRows = deps.map(normDep);
      let cat = '';
      let friendlyOnly = false;
      const pn = panel({ title: 'Deployable damage', flush: true });
      pn.setCount(totalOf(d.deployables));
      const catChips = chipBar([
        { value: '', label: 'All' },
        { value: 'radio', label: 'Radio' },
        { value: 'hab', label: 'HAB' },
        { value: 'other', label: 'Other' },
      ], '', (v) => { cat = v; draw(); }, { label: 'Deployable type' });
      const fChip = el('button', { type: 'button', class: 'chip', text: 'Friendly only', 'aria-pressed': 'false' });
      fChip.addEventListener('click', () => {
        friendlyOnly = !friendlyOnly;
        fChip.classList.toggle('on', friendlyOnly);
        fChip.setAttribute('aria-pressed', friendlyOnly ? 'true' : 'false');
        draw();
      });
      pn.tools.append(catChips.el, fChip);
      const holder = el('div');
      pn.body.append(holder);
      function draw() {
        holder.textContent = '';
        let rows = depRows;
        if (cat) rows = rows.filter((r) => r.category === cat);
        if (friendlyOnly) rows = rows.filter((r) => r.friendly === 1);
        holder.append(deployablesTable(rows, { withPlayer: true, emptyText: 'No deployable damage matches this filter' }));
      }
      draw();
      const tn = truncNote(d.deployables, 'deployable-damage events');
      if (tn) pn.foot().append(tn);
      c.append(pn.el);
    }

    function renderChatTab(c) {
      const pn = panel({ title: 'Match chat', flush: true });
      pn.setCount(totalOf(d.chat));
      const list = chatList({ emptyText: 'No chat during this match' });
      list.update(chat);
      pn.body.append(list.el);
      const tn = truncNote(d.chat, 'chat messages');
      if (tn) pn.foot().append(tn);
      c.append(pn.el);
    }

    function renderFlagsTab(c) {
      const pn = panel({ title: 'Flags raised', flush: true });
      pn.setCount(flags.length, flags.length ? 'warn' : null);
      if (flags.length) pn.body.append(flagList(flags));
      else if (!ended && logMissing()) pn.body.append(logEmpty('Teamkill sprees and friendly radio damage'));
      else pn.body.append(emptyState('No flags raised this match', 'Teamkill sprees and friendly radio damage would show up here.', 'flag'));
      c.append(pn.el);
    }

    const tabs = tabsView([
      { id: 'kills', label: 'Kill feed', badge: totalOf(d.kills) || null, render: renderKillsTab },
      { id: 'deployables', label: 'Deployables', badge: totalOf(d.deployables) || null, render: renderDepsTab },
      { id: 'chat', label: 'Chat', badge: totalOf(d.chat) || null, render: renderChatTab },
      { id: 'flags', label: 'Flags', badge: totalOf(d.flags) || null, badgeKind: flags.length ? 'warn' : null, render: renderFlagsTab },
    ]);

    view.append(head.el, vs, sb, tabs.el);
  }

  /* ============================================================== CHAT */

  const CHAT_CHANNELS = ['all', 'team', 'squad', 'admin'];

  function renderChatView(main, ctx) {
    const unsubs = [];
    this.cleanup = () => { unsubs.forEach((u) => u()); };

    const per = 100;
    let perGuess = per;
    let q = (ctx.query && ctx.query.q) || '';
    let channel = (ctx.query && ctx.query.channel) || '';
    if (CHAT_CHANNELS.indexOf(channel) === -1) channel = '';
    let playerId = (ctx.query && ctx.query.playerId) || '';
    let page = 0;
    let seq = 0;
    let rows = [];
    let total = 0;
    let shown = false;

    const view = el('div', { class: 'view vw vw-chat fade-in' });
    main.append(view);

    const head = pageHead({ title: 'Chat' });
    const liveSub = el('span', { class: 'cv-sub' });
    const liveDot = el('span', { class: 'vw-pulse' });
    const liveText = el('span');
    liveSub.append(liveDot, liveText);
    head.setSub(liveSub);
    const sInput = el('input', {
      class: 'input', type: 'search', value: q,
      placeholder: 'Search messages…', 'aria-label': 'Search chat messages',
    });
    const sbox = el('div', { class: 'search-box vw-search' });
    sbox.innerHTML = SW.icon('search');
    sbox.append(sInput);
    head.actions.append(sbox);
    view.append(head.el);

    /* filters row: channel + player */
    const chanItems = [
      { value: '', label: 'All channels' },
      { value: 'all', label: 'All chat' },
      { value: 'team', label: 'Team' },
      { value: 'squad', label: 'Squad' },
    ];
    if (SW.can('adminChat')) chanItems.push({ value: 'admin', label: 'Admin' });
    const chanChips = chipBar(chanItems, channel, (v) => { channel = v; page = 0; load(); }, { label: 'Channel' });

    const dl = el('datalist', { id: 'chat-player-dl' });
    const pInput = el('input', {
      class: 'input', list: 'chat-player-dl', autocomplete: 'off',
      placeholder: 'Filter by player…', 'aria-label': 'Filter by player',
    });
    if (ctx.query && ctx.query.player) pInput.value = ctx.query.player;
    else if (playerId) pInput.value = '#' + playerId;
    const clearP = el('button', { type: 'button', class: 'icon-btn cv-clear', html: SW.icon('x'), title: 'Clear player filter', 'aria-label': 'Clear player filter' });
    clearP.addEventListener('click', () => {
      pInput.value = '';
      if (playerId) { playerId = ''; page = 0; load(); }
      syncClear();
    });
    function syncClear() { clearP.classList.toggle('hidden', !pInput.value); }
    syncClear();

    const fetchNames = debounce(async () => {
      const term = pInput.value.trim();
      if (!term || /#\d+\s*$/.test(term)) return;
      try {
        const r = await SW.api('/api/players?q=' + encodeURIComponent(term) + '&sort=last_seen&dir=desc&page=0&per=10', { toast: false });
        dl.textContent = '';
        for (const row of (r && r.rows) || []) {
          dl.append(el('option', { value: (row.name || '?') + ' #' + g(row, 'id', 'dbId') }));
        }
      } catch (_e) { /* ignore — autocomplete is best-effort */ }
    }, 250);
    pInput.addEventListener('input', () => {
      syncClear();
      const sel = pInput.value.match(/#(\d+)\s*$/);
      if (sel) {
        if (playerId !== sel[1]) { playerId = sel[1]; page = 0; load(); }
        return;
      }
      if (!pInput.value.trim() && playerId) { playerId = ''; page = 0; load(); }
      fetchNames();
    });

    const doSearch = debounce(() => { q = sInput.value.trim(); page = 0; load(); }, 350);
    sInput.addEventListener('input', doSearch);
    sInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { q = sInput.value.trim(); page = 0; load(); } });

    const pfield = el('div', { class: 'search-box vw-search cv-player-filter' });
    pfield.innerHTML = SW.icon('user');
    pfield.append(pInput, dl, clearP);

    const pnl = panel({ lead: chanChips.el, flush: true, cls: 'cv-panel vw-grid-panel' });
    const countEl = el('span', { class: 'vw-resultcount cv-count' });
    pnl.tools.append(countEl, pfield);
    const list = chatList({ withMatch: true, emptyText: 'No chat messages match', emptyHint: 'Try another channel, player or search term.' });
    pnl.body.append(skeleton(12, 'cv-skel'));
    view.append(pnl.el);

    function unfiltered() { return page === 0 && !q && !channel && !playerId; }
    function syncLive() {
      const on = unfiltered();
      liveDot.classList.toggle('on', on && !!SW.live.up);
      liveText.textContent = on
        ? 'Live — new messages land at the top as they are sent.'
        : 'Filtered view — clear the filters to follow chat live.';
    }
    function renderFoot() {
      const foot = pnl.foot();
      foot.textContent = '';
      const multi = total > perGuess || page > 0;
      foot.classList.toggle('hidden', !multi);
      if (multi) {
        foot.append(SW.ui.pager({
          page, per: perGuess, total,
          onPage: (p) => { page = p; load(); },
        }));
      }
      countEl.textContent = SW.ui.fmtNum(total) + (total === 1 ? ' message' : ' messages');
    }

    async function load() {
      const my = ++seq;
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (channel) params.set('channel', channel);
      if (playerId) params.set('playerId', playerId);
      params.set('page', String(page));
      params.set('per', String(per));
      pnl.el.classList.add('is-busy');
      syncLive();
      let r;
      try { r = await SW.api('/api/chat?' + params.toString()); } catch (_e) {
        if (my !== seq) return;
        pnl.el.classList.remove('is-busy');
        if (!shown) {
          pnl.body.textContent = '';
          pnl.body.append(emptyState('Could not load chat', 'The server did not answer — try again in a moment.', 'chat'));
        }
        return;
      }
      if (my !== seq) return;
      pnl.el.classList.remove('is-busy');
      rows = ((r && r.rows) || []).map(normChat);
      total = num(r && r.total);
      perGuess = Math.max(perGuess, rows.length);
      if (!shown) { shown = true; pnl.body.textContent = ''; pnl.body.append(list.el); }
      list.update(rows.slice());
      renderFoot();
      syncLive();
    }

    /* live append on page 1 when unfiltered (admin rows never reach viewers —
     * the API/SSE already excludes them per §19.3.23) */
    unsubs.push(SW.live.on('chat', (c) => {
      if (!c || !unfiltered() || !shown) return;
      const row = normChat(c);
      rows.unshift(row);
      if (rows.length > per) rows.pop();
      total++;
      list.prepend(row, per);
      renderFoot();
    }));
    unsubs.push(SW.live.on('_conn', syncLive));

    load();
  }

  /* ============================================================= TROLLS */

  function normFlagEvent(f) {
    return {
      id: g(f, 'id', 'flagId'),
      time: f.time,
      type: f.type,
      severity: f.severity,
      player: f.player,
      matchId: g(f, 'matchId', 'match_id'),
      details: f.details,
      reviewed: g(f, 'reviewed') || 0,
    };
  }

  function lbValue(r, keys) {
    for (const k of keys) { if (r && r[k] !== undefined) return r[k]; }
    return 0;
  }

  /* opts.logWhat: the board's subject for the no-game-log empty state */
  function lbCard(title, icon, rows, valKeys, opts) {
    opts = opts || {};
    const pn = panel({ title, cls: 'tro-board', flush: true });
    pn.tools.append(el('span', { class: 'tro-board-unit', text: opts.valueLabel || 'Count' }));
    if (!rows.length) {
      pn.body.append(logMissing()
        ? logEmpty(opts.logWhat || title, true)
        : emptyState('Nobody here yet', 'Good news for the server.', icon));
      return pn.el;
    }
    const ol = el('ol', { class: 'tro-lb' });
    rows.slice(0, 10).forEach((r, i) => {
      const li = el('li', { class: 'tro-lb-row' + (i < 3 ? ' top' + (i + 1) : '') });
      li.append(el('span', { class: 'tro-lb-rank display tabular', text: String(i + 1) }));
      li.append(nameLink(refOf(r), 'tro-lb-name'));
      const v = lbValue(r, valKeys);
      li.append(el('span', { class: 'tro-lb-val mono tabular', text: opts.damage ? fmtDmg(v) : SW.ui.fmtNum(num(v)) }));
      ol.append(li);
    });
    pn.body.append(ol);
    return pn.el;
  }

  function renderTrolls(main) {
    const unsubs = [];
    let watchUnsubs = [];
    this.cleanup = () => {
      unsubs.forEach((u) => u());
      watchUnsubs.forEach((u) => u());
      watchUnsubs = [];
    };

    let reviewedFilter = '0'; /* '0' unreviewed | '1' reviewed | 'all' */
    let page = 0;
    let seq = 0;
    let openCount = 0;

    const view = el('div', { class: 'view vw vw-trolls fade-in' });
    main.append(view);

    const head = pageHead({ title: 'Trolls', sub: 'Teamkill sprees, friendly radio damage and watchlist hits — detected automatically, reviewed here.' });
    view.append(head.el);

    /* live-watch toggle */
    let watching = !!SW.prefs.get('trolls-livewatch', false);
    const watchChip = el('button', {
      type: 'button', class: 'btn ghost tro-watch',
      title: 'Toast every live teamkill and radio-damage event while this page is open',
    });
    watchChip.innerHTML = SW.icon('eye');
    const watchLab = el('span');
    watchChip.append(watchLab);
    function applyWatch() {
      watchChip.classList.toggle('is-on', watching);
      watchChip.setAttribute('aria-pressed', watching ? 'true' : 'false');
      watchLab.textContent = watching ? 'Live watch on' : 'Live watch off';
      watchUnsubs.forEach((u) => u());
      watchUnsubs = [];
      if (!watching) return;
      watchUnsubs.push(SW.live.on('kill', (k) => {
        if (!k || !k.teamkill || k.kind === 'die') return;
        const a = (k.attacker && k.attacker.name) || 'unknown';
        const v = (k.victim && k.victim.name) || 'unknown';
        SW.ui.toast('TK: ' + a + ' teamkilled ' + v + (k.weapon ? ' — ' + k.weapon : ''), 'error');
      }));
      watchUnsubs.push(SW.live.on('deployable', (dp) => {
        if (!dp || dp.category !== 'radio') return;
        const f = num(dp.friendly);
        if (f === 0) return; /* enemy radio damage is normal play */
        const who = (dp.player && dp.player.name) || 'unknown';
        const what = f === 1 ? 'Friendly radio damage: ' : 'Radio damage (unknown side): ';
        SW.ui.toast(what + who + ' — ' + fmtDmg(dp.damage) + ' dmg' + (dp.weapon ? ' (' + dp.weapon + ')' : ''), f === 1 ? 'error' : 'warn');
      }));
    }
    watchChip.addEventListener('click', () => {
      watching = !watching;
      SW.prefs.set('trolls-livewatch', watching);
      applyWatch();
    });
    applyWatch();
    head.actions.append(watchChip);

    /* flag inbox */
    const chips = chipBar([
      { value: '0', label: 'Unreviewed' },
      { value: '1', label: 'Reviewed' },
      { value: 'all', label: 'All' },
    ], reviewedFilter, (v) => { reviewedFilter = v; page = 0; loadFlags(); }, { label: 'Review state' });
    const inbox = panel({ title: 'Flag inbox', flush: true, cls: 'tro-inbox' });
    inbox.tools.append(chips.el);
    const listBox = el('div', { class: 'tro-flags' });
    inbox.body.append(listBox);
    view.append(inbox.el);
    function setOpen(n) { openCount = Math.max(0, n); inbox.setCount(openCount ? openCount + ' open' : null, 'warn'); }
    /* detections ride the game log: with no log feed, "all quiet" would lie */
    function inboxEmpty() {
      if (reviewedFilter !== '1' && logMissing()) return logEmpty('Teamkill sprees, friendly radio damage and the flags they raise');
      return reviewedFilter === '0'
        ? emptyState('All quiet', 'No unreviewed flags — new detections appear here live.', 'shield')
        : emptyState('No flags', 'Nothing matches this filter yet.', 'flag');
    }

    let inboxIsEmpty = false; /* the inbox shows its empty state (not an error) */
    async function loadFlags() {
      const my = ++seq;
      inboxIsEmpty = false;
      listBox.textContent = '';
      listBox.append(skeleton(5, 'tro-skel'));
      let r;
      try { r = await SW.api('/api/flags?reviewed=' + encodeURIComponent(reviewedFilter) + '&page=' + page + '&per=50'); }
      catch (_e) {
        if (my === seq) { listBox.textContent = ''; listBox.append(emptyState('Could not load flags', 'The server did not answer — try again in a moment.', 'flag')); }
        return;
      }
      if (my !== seq) return;
      listBox.textContent = '';
      const rows = sortFlags((r && r.rows) || []);
      const total = num(r && r.total);
      if (reviewedFilter === '0') setOpen(total);
      inboxIsEmpty = !rows.length;
      if (!rows.length) {
        listBox.append(inboxEmpty());
      } else {
        for (const f of rows) {
          listBox.append(flagRow(f, {
            onReviewed: () => { if (reviewedFilter === '0') setOpen(openCount - 1); },
          }));
        }
      }
      const foot = inbox.foot();
      foot.textContent = '';
      const multi = total > rows.length || page > 0;
      foot.classList.toggle('hidden', !multi);
      if (multi) foot.append(SW.ui.pager({ page, per: 50, total, onPage: (p) => { page = p; loadFlags(); } }));
    }

    /* live flags land at the top of the inbox (app.js already toasts them) */
    unsubs.push(SW.live.on('flag', (f) => {
      if (!f || page !== 0 || reviewedFilter === '1') return;
      const empty = listBox.querySelector('.vw-empty, .vw-skel');
      if (empty) empty.remove();
      inboxIsEmpty = false;
      listBox.prepend(flash(flagRow(normFlagEvent(f), {
        onReviewed: () => { if (reviewedFilter === '0') setOpen(openCount - 1); },
      })));
      if (reviewedFilter === '0') setOpen(openCount + 1);
    }));

    /* the game log came up or went away: re-word the empty lists it fills */
    let redrawBoards = null;
    unsubs.push(SW.live.on('_logfeed', () => {
      if (inboxIsEmpty) { listBox.textContent = ''; listBox.append(inboxEmpty()); }
      if (redrawBoards) redrawBoards();
    }));

    loadFlags();

    /* leaderboards — §19.1.8: every board is {all, week} */
    const lbSection = el('section', { class: 'tro-lbs' });
    const lbHead = el('div', { class: 'vw-section-head' }, el('h2', { class: 'card-title', text: 'Leaderboards' }));
    const lbTools = el('div', { class: 'vw-section-tools' });
    lbHead.append(lbTools);
    const grid = el('div', { class: 'tro-lb-grid vw-grid' });
    grid.append(skeletonCard(), skeletonCard(), skeletonCard(), skeletonCard());
    lbSection.append(lbHead, grid);
    view.append(lbSection);
    function skeletonCard() { return el('div', { class: 'card tro-board-skel' }, skeleton(6)); }

    (async () => {
      let t;
      try { t = await SW.api('/api/trolls', { toast: false }); }
      catch (_e) {
        grid.textContent = '';
        grid.append(emptyCard('Could not load leaderboards', 'The server did not answer — try again in a moment.', 'shield-alert'));
        return;
      }
      const lbs = (t && t.leaderboards) || {};
      let period = 'all';
      function pick(board) {
        if (Array.isArray(board)) return board; /* tolerate pre-amendment shape */
        return listOf(board && board[period]);
      }
      function drawBoards() {
        grid.textContent = '';
        grid.append(
          lbCard('Teamkills', 'skull', pick(lbs.teamkills),
            ['teamkills', 'value', 'count', 'tks'], { valueLabel: 'TKs', logWhat: 'Teamkills' }),
          lbCard('Friendly radio damage', 'radio', pick(lbs.radioFriendly),
            ['radioFriendly', 'radio_damage_friendly', 'radioDamageFriendly', 'value', 'damage'],
            { damage: true, valueLabel: 'Damage', logWhat: 'Radio damage events' }),
          lbCard('TK victims', 'shield-alert', pick(lbs.tkDeaths),
            ['tkDeaths', 'tk_deaths', 'value', 'count'], { valueLabel: 'TK deaths', logWhat: 'Teamkill deaths' }),
          lbCard('Repeat offenders', 'flame', pick(lbs.repeatOffenders),
            ['flags', 'flagCount', 'flag_count', 'count', 'value'], { valueLabel: 'Flags', logWhat: 'Teamkill and radio flags' })
        );
      }
      const periodChips = chipBar([
        { value: 'all', label: 'All time' },
        { value: 'week', label: 'Last 7 days' },
      ], 'all', (v) => { period = v; drawBoards(); }, { label: 'Leaderboard period' });
      lbTools.append(periodChips.el);
      drawBoards();
      redrawBoards = drawBoards;
    })();
  }

  /* ============================================== LIVE (BattleMetrics-style)
   * Two panes: left = roster (teams > squads with creation time / claim
   * order / creator + per-squad Disband), right = one unified live feed
   * (kills, chat, joins/leaves, squad created/disbanded) backfilled from
   * GET /api/live/feed and kept live over SSE. '_resync' (emitted by app.js
   * after the stream reconnects) re-fetches both.
   *
   * Roster-refresh approach for squad creation lines: a local overlay map
   * keyed "teamId:squadId" is filled from 'squad' SSE events so the created/
   * claim line appears instantly; the authoritative snapshot (squads carry
   * createdAt/creatorDbId) wins as soon as the next 'players' event lands,
   * and the overlay is pruned against it.
   */

  const FEED_FILTERS = [
    { value: 'kill', label: 'Kills' },
    { value: 'chat', label: 'Chat' },
    { value: 'join', label: 'Join / leave' },
    { value: 'squad', label: 'Squads' },
  ];
  const FEED_KIND_VALUES = FEED_FILTERS.map((f) => f.value);
  function feedGroupOf(kind) {
    return kind === 'connect' || kind === 'disconnect' ? 'join' : kind;
  }

  function renderLive(main) {
    const unsubs = [];
    let renderTimer = null;
    let lastRender = 0;
    this.cleanup = () => {
      unsubs.forEach((u) => u());
      if (renderTimer) clearTimeout(renderTimer);
    };

    const page = el('div', { class: 'view vw lv fade-in' });
    main.append(page);

    /* ---- page head: live status line + admin command bar (broadcast +
     * the layer picker, each behind its own perm, §1) ---- */
    const head = pageHead({ title: 'Live' });
    const liveDot = el('span', { class: 'vw-pulse' });
    const subText = el('span', { class: 'truncate lv-sub-text' });
    head.setSub(el('span', { class: 'lv-sub' }, liveDot, subText));
    function syncConn() {
      const up = !!SW.live.up;
      liveDot.classList.toggle('on', up);
      liveDot.title = up ? 'Live updates connected' : 'Live updates reconnecting';
    }
    syncConn();
    unsubs.push(SW.live.on('_conn', syncConn));

    if (SW.can('broadcast')) {
      const grp = el('div', { class: 'lv-cmd lv-cmd-bc' });
      const field = el('div', { class: 'search-box vw-search' });
      field.innerHTML = SW.icon('broadcast');
      const bInput = el('input', { class: 'input', placeholder: 'Broadcast to all players…', maxlength: '480', 'aria-label': 'Broadcast message' });
      field.append(bInput);
      const bBtn = el('button', { type: 'button', class: 'btn primary', text: 'Send' });
      const sendB = async () => {
        const msg = bInput.value.trim();
        if (!msg) return;
        bBtn.disabled = true;
        try { await SW.actions.broadcastSend(msg); bInput.value = ''; } catch (_e) { /* toasted */ }
        bBtn.disabled = false;
      };
      bBtn.addEventListener('click', sendB);
      bInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendB(); });
      grp.append(field, bBtn);
      head.actions.append(grp);
    }
    if (SW.can('layer')) {
      const lBtn = el('button', {
        type: 'button', class: 'btn ghost lv-layer-btn',
        title: 'Set the next layer or change it now — with factions',
      });
      lBtn.innerHTML = SW.icon('map') + '<span>Change layer</span>';
      lBtn.addEventListener('click', () => SW.ui.openLayerPicker());
      head.actions.append(lBtn);
    }
    page.append(head.el);

    /* ---- two panes: roster left, unified feed right ---- */
    const layout = el('div', { class: 'lv-layout' });
    const left = el('div', { class: 'lv-roster' });
    const right = el('div', { class: 'lv-side' });
    layout.append(left, right);
    page.append(layout);

    const teamsWrap = el('div', { class: 'lv-teams' });
    const disc = panel({ title: 'Recently disconnected', cls: 'lv-disc', flush: true });
    left.append(teamsWrap, disc.el);

    /* =================================================== roster (left pane) */

    /* squad-creation overlay: 'squad' SSE events land here instantly; the
     * snapshot's own createdAt/creatorDbId take precedence once present. */
    const overlay = new Map(); // "teamId:squadId" -> {createdAt, creatorName, creatorDbId, name}

    function overlayFor(sq) {
      const direct = overlay.get(sq.teamId + ':' + sq.squadId);
      if (direct && (direct.name == null || sq.name == null || direct.name === sq.name)) return direct;
      /* creator not rostered when the event fired -> event had teamId null;
       * only trust it when the squad name matches exactly AND the record is
       * fresh — squad numbers and names (ARMOR, HELI, CMD) recur, and a stale
       * anon record must not hand a later squad someone else's claim. */
      const anon = overlay.get('null:' + sq.squadId);
      if (anon && anon.name != null && sq.name != null && anon.name === sq.name
        && anon.createdAt != null && Date.now() - anon.createdAt < 10 * 60 * 1000) return anon;
      return null;
    }

    /* best known creation record for a snapshot squad */
    function creationOf(sq) {
      if (sq.createdAt != null) {
        return { createdAt: num(sq.createdAt), creatorName: sq.creatorName, creatorDbId: g(sq, 'creatorDbId') };
      }
      const ov = overlayFor(sq);
      if (ov && ov.createdAt != null) {
        return {
          createdAt: ov.createdAt,
          creatorName: sq.creatorName != null ? sq.creatorName : ov.creatorName,
          creatorDbId: ov.creatorDbId,
        };
      }
      return { createdAt: null, creatorName: sq.creatorName != null ? sq.creatorName : null, creatorDbId: g(sq, 'creatorDbId') };
    }

    function pruneOverlay() {
      if (!overlay.size) return;
      const now = Date.now();
      const snap = SW.state.snapshot;
      for (const [key, rec] of overlay) {
        // Anon (team-unknown) records age out fast; teamed ones get longer.
        const ttl = key.startsWith('null:') ? 10 * 60 * 1000 : 45 * 60 * 1000;
        if (rec.createdAt != null && now - rec.createdAt > ttl) { overlay.delete(key); continue; }
        if (!snap || !snap.teams) continue;
        for (const t of snap.teams) {
          const sq = (t.squads || []).find((s) => s && (t.teamId + ':' + s.squadId) === key);
          if (sq && sq.createdAt != null) { overlay.delete(key); break; }
          // An anon record is also done the moment the snapshot itself knows
          // this squad's creation (matched by number + name on any team).
          if (key.startsWith('null:')) {
            const m = (t.squads || []).find((s) => s && ('null:' + s.squadId) === key
              && s.name === rec.name && s.createdAt != null);
            if (m) { overlay.delete(key); break; }
          }
        }
      }
    }

    /* claim order: 1-based rank of createdAt among the SAME team's current
     * squads; squads with unknown createdAt rank last and get no number. */
    function claimRanks(team) {
      const ranked = (team.squads || [])
        .map((sq) => ({ sq, c: creationOf(sq) }))
        .filter((e) => e.c.createdAt != null)
        .sort((a, b) => a.c.createdAt - b.c.createdAt);
      const map = new Map();
      ranked.forEach((e, i) => map.set(e.sq, i + 1));
      return map;
    }

    /* ONE tidy line: [#rank] 21:02:13 · 4m ago · by Creator — truncates as a
     * whole (creator first), the full story in the title */
    function claimLine(sq, ranks) {
      const line = el('div', { class: 'lv-claim' });
      const cr = creationOf(sq);
      const rank = ranks.get(sq);
      const story = [];
      if (rank != null) {
        line.append(el('span', { class: 'lv-claim-rank mono', text: '#' + rank }));
        story.push('Claim #' + rank + ' on this team — #1 was created first (vehicle-claim priority)');
      }
      if (cr.createdAt != null) {
        const when = new Date(cr.createdAt);
        const t = el('span', { class: 'lv-claim-time' });
        t.append(el('span', { class: 'mono', text: hms(when) }), el('span', { class: 'lv-claim-sep', text: '·' }), SW.ui.timeAgo(cr.createdAt));
        line.append(t);
        story.push('created ' + when.toLocaleString());
      } else {
        line.append(el('span', { class: 'lv-claim-unknown truncate', text: 'Created before A3 Admin connected' }));
        story.push('Creation time unknown — this squad existed before A3 Admin started watching the logs');
      }
      if (cr.creatorName) {
        line.append(el('span', { class: 'lv-claim-by', text: 'by' }));
        line.append(cr.creatorDbId != null
          ? nameLink({ dbId: cr.creatorDbId, name: cr.creatorName }, 'lv-claim-creator')
          : tspan(cr.creatorName, 'lv-claim-creator'));
        story.push('by ' + cr.creatorName);
      }
      line.title = story.join(' · ');
      return line;
    }

    function kdt(p) {
      const k = num(p.sessKills);
      const dd = num(p.sessDeaths);
      const tk = num(p.sessTks);
      const w = el('span', {
        class: 'lv-kdt mono' + (tk > 0 ? ' has-tk' : ''),
        title: 'This session — kills ' + k + ' · deaths ' + dd + ' · teamkills ' + tk,
      });
      w.append(
        el('b', { text: String(k) }), el('i', { text: '/' }),
        el('b', { text: String(dd) }), el('i', { text: '/' }),
        el('b', { class: 'tk', text: String(tk) }));
      return w;
    }

    function memberRow(p) {
      const row = el('div', { class: 'lv-member' + (p.isLeader ? ' is-leader' : '') });
      row.append(p.isLeader
        ? el('span', { class: 'lv-lead', html: SW.icon('star'), title: 'Squad leader' })
        : el('span', { class: 'lv-lead' }));
      row.append(nameLink(p, 'lv-name'));
      const rl = roleLabel(p.role);
      const role = el('span', { class: 'lv-role' });
      if (rl) {
        role.title = String(p.role);
        role.append(el('span', { class: 'lv-role-l', text: rl.long }), el('span', { class: 'lv-role-s', text: rl.short }));
      }
      row.append(role, kdt(p));
      return row;
    }

    function disbandBtn(team, sq) {
      const btn = el('button', {
        type: 'button', class: 'btn ghost small icon-only reveal-on-hover lv-disband',
        title: 'Disband squad', 'aria-label': 'Disband squad ' + sq.squadId + (sq.name ? ' (' + sq.name + ')' : ''),
      });
      btn.innerHTML = ico('trash');
      btn.addEventListener('click', async () => {
        const teamId = num(team.teamId);
        const squadId = num(sq.squadId);
        const label = squadId + ' — ' + (sq.name || 'Squad') + ' (' + ((sq.players && sq.players.length) || sq.size || 0) + ')';
        const v = await SW.ui.confirmModal({
          title: 'Disband squad',
          body: 'Disband squad ' + label + ' on team ' + teamId + '? Its members become unassigned.',
          danger: true,
          confirmText: 'Disband',
        });
        if (!v) return;
        btn.disabled = true;
        try {
          const res = await SW.api('/api/admin/disbandSquad', { method: 'POST', body: { teamId, squadId } });
          SW.ui.rconToast('Disband squad ' + squadId + ' (team ' + teamId + ')', res);
          /* roster re-renders on the next players/squad SSE event */
        } catch (_e) { btn.disabled = false; /* toasted by SW.api */ }
      });
      return btn;
    }

    function squadBlock(team, sq, ranks) {
      const n = sq.players ? sq.players.length : num(sq.size);
      const b = el('div', { class: 'lv-squad' + (sq.locked ? ' is-locked' : '') + (n >= 9 ? ' is-full' : '') });
      const h = el('div', { class: 'lv-squad-head' });
      h.append(el('span', { class: 'lv-sq-num mono', text: sq.squadId != null ? String(sq.squadId) : '–', title: 'Squad number' }));
      h.append(tspan(sq.name || 'Squad', 'lv-sq-name'));
      if (sq.locked) h.append(el('span', { class: 'lv-sq-lock', html: SW.icon('lock'), title: 'Locked squad' }));
      h.append(el('span', { class: 'lv-sq-size mono', text: n + '/9', title: n + ' of 9 slots filled' }));
      if (SW.can('squad') && team.teamId != null && sq.squadId != null) h.append(disbandBtn(team, sq));
      b.append(h, claimLine(sq, ranks));
      const mem = el('div', { class: 'lv-members' });
      for (const p of sq.players || []) mem.append(memberRow(p));
      b.append(mem);
      return b;
    }

    function unassignedBlock(list) {
      const b = el('div', { class: 'lv-squad is-unassigned' });
      const h = el('div', { class: 'lv-squad-head' });
      h.append(el('span', { class: 'lv-sq-num lv-sq-none', html: SW.icon('user'), 'aria-hidden': 'true' }));
      h.append(el('span', { class: 'lv-sq-name', text: 'Unassigned' }));
      h.append(el('span', { class: 'lv-sq-size mono', text: String(list.length) }));
      b.append(h);
      const mem = el('div', { class: 'lv-members' });
      for (const p of list) mem.append(memberRow(p));
      b.append(mem);
      return b;
    }

    function teamCount(team) {
      return (team.squads || []).reduce((n, s) => n + ((s.players && s.players.length) || 0), 0) +
        ((team.unassigned && team.unassigned.length) || 0);
    }

    function teamPanel(team) {
      const tid = team.teamId;
      const col = el('section', { class: 'lv-team ' + (tid === 1 ? 't1' : (tid === 2 ? 't2' : 't0')) });
      const count = teamCount(team);
      const th = el('header', { class: 'lv-team-head' });
      const lab = el('div', { class: 'lv-team-label' }, el('span', { text: tid != null ? 'Team ' + tid : 'No team' }));
      const tickets = g(team, 'tickets');
      if (tickets != null) lab.append(el('span', { class: 'lv-team-tickets mono', text: SW.ui.fmtNum(tickets) + ' tickets' }));
      const squadsN = (team.squads || []).length;
      lab.append(el('span', { class: 'lv-team-squads', text: squadsN + (squadsN === 1 ? ' squad' : ' squads') }));
      th.append(lab);
      th.append(tspan(team.name || (tid != null ? 'Team ' + tid : 'No team'), 'lv-team-name display'));
      th.append(el('div', { class: 'lv-team-count' },
        el('span', { class: 'lv-team-n display tabular', text: String(count) }),
        el('span', { class: 'lv-team-n-l', text: count === 1 ? 'player' : 'players' })));
      col.append(th);
      const ranks = claimRanks(team);
      const list = el('div', { class: 'lv-squads' });
      for (const sq of team.squads || []) list.append(squadBlock(team, sq, ranks));
      if (team.unassigned && team.unassigned.length) list.append(unassignedBlock(team.unassigned));
      if (!list.children.length) list.append(el('div', { class: 'lv-team-empty', text: 'No players on this team' }));
      col.append(list);
      return col;
    }

    function updateSub() {
      const snap = SW.state.snapshot || {};
      const si = SW.state.serverInfo || snap.serverInfo || {};
      let count = si.playerCount;
      if (count == null && snap.teams) count = snap.teams.reduce((n, t) => n + teamCount(t), 0);
      const parts = [(count != null ? count : '—') + (si.maxPlayers != null ? ' / ' + si.maxPlayers : '') + ' players'];
      const layer = snap.currentLayer || si.mapName;
      if (layer) parts.push(String(layer));
      subText.textContent = parts.join(' · ');
      subText.title = subText.textContent;
    }

    function renderRoster() {
      teamsWrap.textContent = '';
      updateSub();
      const snap = SW.state.snapshot;
      if (!snap || !snap.teams || !snap.teams.length) {
        teamsWrap.append(emptyCard('No live roster yet', 'Waiting for the first RCON ListPlayers poll.', 'live'));
        renderDisc();
        return;
      }
      for (const team of snap.teams) teamsWrap.append(teamPanel(team));
      renderDisc();
    }

    function renderDisc() {
      disc.body.textContent = '';
      const snap = SW.state.snapshot;
      const list = (snap && snap.recentlyDisconnected) || [];
      disc.setCount(list.length);
      if (!list.length) {
        disc.body.append(el('div', { class: 'lv-disc-none', text: 'Nobody left recently.' }));
        return;
      }
      const rows = el('div', { class: 'lv-disc-list' });
      for (const dd of list) {
        const row = el('div', { class: 'lv-disc-row' });
        row.append(nameLink(dd, 'lv-disc-name'));
        const since = dd.sinceDisconnect || (dd.disconnectedAt ? SW.ui.timeAgoText(dd.disconnectedAt) : '');
        row.append(el('span', { class: 'lv-disc-since mono', text: since ? String(since) : '' }));
        if (SW.can('ban')) {
          const b = el('button', { type: 'button', class: 'btn danger ghost small', title: 'Ban this player even though they already left' });
          b.innerHTML = SW.icon('ban') + '<span>Ban</span>';
          b.addEventListener('click', () => SW.actions.ban(dd));
          row.append(b);
        }
        rows.append(row);
      }
      disc.body.append(rows);
    }

    /* re-render throttled to 2s (spec 14.4) */
    function scheduleRender() {
      if (renderTimer) return;
      const wait = Math.max(0, 2000 - (Date.now() - lastRender));
      renderTimer = setTimeout(() => {
        renderTimer = null;
        lastRender = Date.now();
        renderRoster();
      }, wait);
    }

    /* kill events bump session K/D/TK between snapshots */
    function bump(ref, field) {
      const snap = SW.state.snapshot;
      if (!ref || !ref.eosId || !snap || !snap.teams) return;
      for (const t of snap.teams) {
        const buckets = (t.squads || []).map((s) => s.players || []);
        buckets.push(t.unassigned || []);
        for (const bucket of buckets) {
          for (const p of bucket) {
            if (p.eosId === ref.eosId) { p[field] = (Number(p[field]) || 0) + 1; return; }
          }
        }
      }
    }

    /* ================================================= live feed (right pane) */

    const EV_CAP = 400;   // in-memory event buffer
    const DOM_CAP = 300;  // rendered rows

    let filters = SW.prefs.get('live:feed-filters', null);
    if (!Array.isArray(filters) || !filters.length ||
      filters.some((f) => FEED_KIND_VALUES.indexOf(f) === -1)) {
      filters = FEED_KIND_VALUES.slice();
    }
    let paused = false;
    let pending = 0;
    let backfilled = false;
    const events = []; // {t, kind, data} newest first

    const feed = panel({ title: 'Live feed', cls: 'lv-feed-card', flush: true });
    right.append(feed.el);

    const pendBadge = el('span', { class: 'badge warn lv-pending hidden', title: 'Events buffered while paused' });
    const pauseBtn = el('button', { type: 'button', class: 'btn ghost small icon-only lv-pause' });
    function syncPause() {
      pauseBtn.innerHTML = SW.icon(paused ? 'play' : 'pause');
      pauseBtn.title = paused ? 'Resume feed' : 'Pause feed';
      pauseBtn.setAttribute('aria-label', pauseBtn.title);
      pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      pauseBtn.classList.toggle('is-on', paused);
      feed.el.classList.toggle('is-paused', paused);
      pendBadge.textContent = pending ? '+' + pending + ' new' : 'Paused';
      pendBadge.classList.toggle('hidden', !paused);
    }
    pauseBtn.addEventListener('click', () => {
      paused = !paused;
      if (!paused) { pending = 0; redraw(); }
      syncPause();
    });
    feed.tools.append(pendBadge, pauseBtn);
    syncPause();

    /* filter chips: All + multi-toggle kinds, persisted */
    const chipRow = el('div', { class: 'lv-filters', role: 'group', 'aria-label': 'Feed filters' });
    const allChip = el('button', { type: 'button', class: 'chip', text: 'All' });
    const kindChips = [];
    function syncChips() {
      const all = filters.length === FEED_KIND_VALUES.length;
      allChip.classList.toggle('on', all);
      allChip.setAttribute('aria-pressed', all ? 'true' : 'false');
      for (const [b, val] of kindChips) {
        const on = filters.indexOf(val) !== -1;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
    function setFilters(next) {
      filters = next;
      SW.prefs.set('live:feed-filters', filters);
      syncChips();
      redraw();
    }
    allChip.addEventListener('click', () => setFilters(FEED_KIND_VALUES.slice()));
    chipRow.append(allChip);
    for (const f of FEED_FILTERS) {
      const b = el('button', { type: 'button', class: 'chip', text: f.label });
      b.addEventListener('click', () => {
        const i = filters.indexOf(f.value);
        const next = filters.slice();
        if (i === -1) next.push(f.value); else next.splice(i, 1);
        setFilters(next);
      });
      kindChips.push([b, f.value]);
      chipRow.append(b);
    }
    syncChips();
    feed.el.insertBefore(chipRow, feed.body);

    /* kills reach this feed only through the game log: while it is off or
     * failing a note says so (chat, joins and squads still ride RCON) */
    const logNote = el('div', { class: 'lv-lognote hidden', role: 'status' });
    function syncLogNote() {
      const miss = logMissing();
      logNote.classList.toggle('hidden', !miss);
      logNote.textContent = '';
      if (!miss) return;
      logNote.innerHTML = SW.icon('scroll');
      logNote.append(el('span', {
        class: 'lv-lognote-text',
        text: 'No kills in this feed — they come from the game log (SquadGame.log), ' + logGap() + '.',
      }));
      if (SW.can('settings')) {
        logNote.append(el('a', {
          class: 'lv-lognote-link', href: '#/settings',
          text: SW.logFeed.state() === 'down' ? 'Check log feed' : 'Connect log feed',
        }));
      }
    }
    syncLogNote();
    feed.el.insertBefore(logNote, feed.body);

    const feedList = el('div', { class: 'feed vw-feed lv-feed', role: 'log', 'aria-label': 'Live feed' });
    feedList.append(skeleton(10, 'lv-feed-skel'));
    feed.body.append(feedList);

    function passes(ev) { return filters.indexOf(feedGroupOf(ev.kind)) !== -1; }

    function rowFor(ev) {
      try {
        if (ev.kind === 'kill') return killFeedRow(normKill(ev.data));
        if (ev.kind === 'chat') return chatFeedRow(normChat(ev.data));
        if (ev.kind === 'squad') return squadFeedRow(ev.data);
        if (ev.kind === 'connect' || ev.kind === 'disconnect') return connFeedRow(ev.kind, ev.data);
      } catch (e) { console.error('live feed row (' + ev.kind + ')', e); }
      return null;
    }

    function redraw() {
      feedList.textContent = '';
      let shown = 0;
      for (const ev of events) {
        if (!passes(ev)) continue;
        const row = rowFor(ev);
        if (!row) continue;
        feedList.append(row);
        if (++shown >= DOM_CAP) break;
      }
      if (!shown) {
        const noLog = logMissing();
        if (noLog && filters.length === 1 && filters[0] === 'kill') feedList.append(logEmpty('Kills and teamkills'));
        else if (filters.length === FEED_KIND_VALUES.length) {
          feedList.append(emptyState('No live events yet', noLog
            ? 'Chat, joins and squad changes appear here as they happen — kills need the game log.'
            : 'Kills, chat, joins and squad changes appear here as they happen.', 'live'));
        } else feedList.append(emptyState('Nothing matches these filters', 'Turn a filter back on to see more events.', 'live'));
      }
    }

    /* cheap signature so the REST backfill does not duplicate events that
     * already arrived over SSE between page open and fetch resolve */
    function sigOf(ev) {
      const dd = ev.data || {};
      let extra = '';
      if (ev.kind === 'kill') {
        extra = ((dd.attacker && dd.attacker.name) || '') + '>' + ((dd.victim && dd.victim.name) || '') + '|' + (dd.weapon || '');
      } else if (ev.kind === 'chat') {
        extra = ((dd.player && dd.player.name) || dd.playerName || '') + '|' + (dd.message || '');
      } else if (ev.kind === 'squad') {
        extra = (dd.type || '') + '|' + (dd.teamId != null ? dd.teamId : '') + ':' + (dd.squadId != null ? dd.squadId : '');
      } else {
        extra = dd.name || (dd.player && dd.player.name) || '';
      }
      return ev.kind + '|' + ev.t + '|' + extra;
    }

    function addLive(kind, data) {
      const ev = { t: num(data && data.time) || Date.now(), kind, data };
      events.unshift(ev);
      if (events.length > EV_CAP) events.pop();
      if (!backfilled) return; /* the backfill's redraw renders it */
      if (paused) {
        if (passes(ev)) { pending++; syncPause(); }
        return;
      }
      if (!passes(ev)) return;
      const row = rowFor(ev);
      if (!row) return;
      const empty = feedList.querySelector('.vw-empty');
      if (empty) empty.remove();
      feedList.prepend(flash(row));
      while (feedList.children.length > DOM_CAP) feedList.lastChild.remove();
    }

    /* backfill, merged with anything SSE already delivered; re-run on resync */
    let backfillSeq = 0;
    async function loadBackfill() {
      const my = ++backfillSeq;
      let r = null;
      try { r = await SW.api('/api/live/feed?limit=120', { toast: false }); }
      catch (_e) {
        if (my !== backfillSeq) return;
        if (!backfilled) { backfilled = true; if (!paused) redraw(); }
        return;
      }
      if (my !== backfillSeq) return;
      const seen = new Set(events.map(sigOf));
      let added = 0;
      for (const row of (r && r.rows) || []) {
        if (!row || !row.kind) continue;
        const ev = { t: num(row.t) || num(row.data && row.data.time), kind: row.kind, data: row.data || {} };
        const s = sigOf(ev);
        if (seen.has(s)) continue;
        seen.add(s);
        events.push(ev);
        if (passes(ev)) added++;
      }
      events.sort((a, b) => b.t - a.t);
      if (events.length > EV_CAP) events.length = EV_CAP;
      const first = !backfilled;
      backfilled = true;
      if (paused && !first) {
        if (added) { pending += added; syncPause(); }
        return;
      }
      redraw();
    }
    loadBackfill();

    /* ------------------------------------------------------- subscriptions */
    unsubs.push(SW.live.on('players', () => { pruneOverlay(); scheduleRender(); }));
    unsubs.push(SW.live.on('serverinfo', () => scheduleRender()));
    unsubs.push(SW.live.on('match', () => scheduleRender()));
    unsubs.push(SW.live.on('kill', (k) => {
      if (!k) return;
      addLive('kill', k);
      if (k.kind !== 'wound') return;
      if (k.attacker && !k.suicide) bump(k.attacker, 'sessKills');
      if (k.victim) bump(k.victim, 'sessDeaths');
      if (k.teamkill && k.attacker) bump(k.attacker, 'sessTks');
      scheduleRender();
    }));
    unsubs.push(SW.live.on('chat', (c) => { if (c) addLive('chat', c); }));
    unsubs.push(SW.live.on('_logfeed', () => {
      syncLogNote();
      const only = feedList.children.length === 1 ? feedList.firstElementChild : null;
      if (backfilled && !paused && only && only.classList.contains('vw-empty')) redraw();
    }));
    unsubs.push(SW.live.on('connect', (dd) => { if (dd) { addLive('connect', dd); scheduleRender(); } }));
    unsubs.push(SW.live.on('disconnect', (dd) => { if (dd) { addLive('disconnect', dd); scheduleRender(); } }));
    unsubs.push(SW.live.on('squad', (s) => {
      if (!s) return;
      addLive('squad', s);
      const key = (s.teamId != null ? s.teamId : 'null') + ':' + s.squadId;
      if (s.type === 'created') {
        overlay.set(key, {
          createdAt: num(s.time) || Date.now(),
          creatorName: s.creatorName != null ? s.creatorName : null,
          creatorDbId: g(s, 'creatorDbId'),
          name: s.name != null ? s.name : null,
        });
        // A teamed record supersedes an earlier team-unknown one for the
        // same squad — never let the anon copy stamp anything later.
        if (s.teamId != null) overlay.delete('null:' + s.squadId);
      } else {
        overlay.delete(key);
        if (s.teamId != null) overlay.delete('null:' + s.squadId);
      }
      scheduleRender();
    }));
    // Map change dissolves every squad: stale creation overlays must never
    // decorate the next match's same-numbered, same-named squads.
    unsubs.push(SW.live.on('match', (m) => {
      if (m && m.type === 'start') { overlay.clear(); scheduleRender(); }
    }));
    // The stream came back after a gap. app.js emits '_resync' only after it
    // has refetched the overview, so the snapshot is already fresh: re-fetch
    // the feed backfill (deduped by signature) and redraw the roster now.
    unsubs.push(SW.live.on('_resync', () => {
      loadBackfill();
      pruneOverlay();
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      lastRender = Date.now();
      renderRoster();
    }));

    if (!SW.state.snapshot && typeof SW.refreshOverview === 'function') {
      SW.refreshOverview().then(() => { lastRender = Date.now(); renderRoster(); });
    }
    lastRender = Date.now();
    renderRoster();
  }

  /* ======================================================== route table */

  SW.routes.players = {
    render(main, ctx) {
      if (ctx.args && ctx.args.length) renderProfile.call(this, main, ctx);
      else renderPlayersList.call(this, main, ctx);
    },
    cleanup() {},
  };

  SW.routes.matches = {
    render(main, ctx) {
      if (ctx.args && ctx.args.length) renderMatchDetail.call(this, main, ctx);
      else renderMatchesList.call(this, main, ctx);
    },
    cleanup() {},
  };

  SW.routes.chat = {
    render(main, ctx) { renderChatView.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.trolls = {
    render(main, ctx) { renderTrolls.call(this, main, ctx); },
    cleanup() {},
  };

  /* overrides the stage-1 live route registered by app.js (loaded earlier) */
  SW.routes.live = {
    render(main, ctx) { renderLive.call(this, main, ctx); },
    cleanup() {},
  };
})();
