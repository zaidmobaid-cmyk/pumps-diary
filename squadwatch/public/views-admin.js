'use strict';
/* A3 Admin — views-admin.js (admin surfaces)
 *
 * Registers SW.routes.admin / console (the "Raw command" page) / bans /
 * audit / users / roles / settings / automation per spec §14.3 + §19
 * amendments, docs/ROLES-INVITES-SETTINGS.md (login + setup + join live in
 * app.js), docs/NEXT-CONTRACTS.md (§2 quick commands, §3 BattleMetrics ban
 * import) and docs/BATCH3-CONTRACTS.md §7 "Builder F2" (ban notes, evidence
 * on bans and warn/kick/ban audit rows, reason templates, remote ban list,
 * admin calls, join alerts, evidence limits, scheduled tasks).
 * Visual language: docs/DESIGN.md — every page opens with the .page-head
 * pattern; cards, forms, tables and the raw-command terminal are laid out by
 * css/admin.css (adm-* classes, tokens only, container queries so the
 * sidebar state never matters).
 *
 * Conventions (established by app.js / views.js):
 *   - SW.routes[name] = { perm?, render(el, ctx), cleanup() }; render runs
 *     with this = route def and reassigns this.cleanup; SW.live.on()
 *     unsubscribers, timers and document-level listeners are cleared there.
 *   - Perm gates mirror the app.js NAV table: granular keys per §1 — a perm
 *     array means "any one grants" (SW.canAny). In-view buttons are gated by
 *     their own key (kick needs kick, ban needs ban, …).
 *   - CSP: script-src 'self' — NO inline handlers; everything is wired with
 *     addEventListener. No style attribute ever carries untrusted data (the
 *     only inline styles are numbers: the role coverage meter width, the
 *     Raw command page's --adm-qc-h and the fallback uploader's progress
 *     scale).
 *   - §19.3.25 XSS sinks: every game- or user-controlled string (player,
 *     layer, squad, role and user names, reasons, raw command output, audit rcon
 *     command/response, parser samples, config dumps, API notes, quick-
 *     command labels/commands, BattleMetrics list names and import errors,
 *     ban notes, evidence file names and captions, template texts, scheduled
 *     task names/messages/results) is rendered via textContent / <pre> ONLY.
 *     innerHTML only ever receives static icon markup (SW.icon / icon()).
 *   - Overflow (DESIGN §7): single-line values get .truncate + title, free
 *     text .wrap-anywhere, tables scroll inside their own .table-wrap.
 *   - Admin POSTs go through SW.api; results surface via rconResultToast
 *     (truncated response + "full response" expander) or SW.ui.rconToast.
 */
(function () {
  const SW = window.SW;
  const el = SW.ui.el;

  /* ======================================================= shared helpers */

  /* g(obj, 'camelCase', 'snake_case', …) -> first defined value (api.js is
   * authored in parallel; tolerate both key spellings — same as views.js). */
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

  /* epoch seconds or ms -> ms (0 when absent) */
  function toMs(v) {
    const n = num(v);
    return n > 0 && n < 1e12 ? n * 1000 : n;
  }

  function listOf(x) {
    if (Array.isArray(x)) return x;
    if (x && Array.isArray(x.rows)) return x.rows;
    return [];
  }

  function debounce(fn, ms) {
    let t = null;
    return function () {
      const a = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(null, a); }, ms);
    };
  }

  function fmtBytes(n) {
    n = num(n);
    if (n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : String(Math.round(n))) + ' ' + units[i];
  }

  function pad2(x) { return (x < 10 ? '0' : '') + x; }

  function fmtHMS(ts) {
    const d = new Date(Number(ts) || Date.now());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtYMD(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function fmtDate(ts) {
    const n = Number(ts);
    if (!n) return '—';
    return new Date(n).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function clip(s, max) {
    s = String(s == null ? '' : s);
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  let uidSeq = 0;
  function uid(prefix) {
    uidSeq += 1;
    return prefix + '-' + uidSeq;
  }

  /* icons the shared set (app.js) may not carry, drawn in the same 24-unit
   * stroke style. SW.icon wins as soon as it knows a name: an unknown name
   * comes back as its dot fallback. Static markup only. */
  const EXTRA_ICONS = {
    paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    repeat: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  };
  const DOT_ICON = SW.icon('dot');
  function icon(name) {
    const s = SW.icon(name);
    if (s !== DOT_ICON || !Object.prototype.hasOwnProperty.call(EXTRA_ICONS, name)) return s;
    return '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
      + EXTRA_ICONS[name] + '</svg>';
  }

  /* a shared component's return value -> a DOM node (node, {el} or null) */
  function asNode(x) {
    if (!x) return null;
    if (x.nodeType) return x;
    if (x.el && x.el.nodeType) return x.el;
    return null;
  }

  /* JSON column that may arrive parsed or as text -> plain object | null */
  function objOf(v) {
    if (typeof v === 'string') {
      try { v = JSON.parse(v); } catch (_e) { return null; }
    }
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  }

  function hasOwn(o, k) { return !!o && Object.prototype.hasOwnProperty.call(o, k); }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function hhmm(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  /* "3 Nov 21:00" (the year only when it is not this year) */
  function fmtDayTime(ts) {
    const d = new Date(Number(ts));
    if (!Number.isFinite(d.getTime())) return '—';
    const y = d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + y + ' ' + hhmm(d);
  }
  /* code points, the way the server counts label lengths */
  function cpLen(s) { return Array.from(String(s == null ? '' : s)).length; }

  /* a live text counter for a textarea/input with a hard cap */
  function counterFor(input, max) {
    const c = el('span', { class: 'adm-counter', 'aria-live': 'polite' });
    const sync = () => {
      const n = cpLen(input.value);
      c.textContent = n + ' / ' + max;
      c.classList.toggle('is-near', n > max - Math.max(20, Math.round(max / 10)));
    };
    input.addEventListener('input', sync);
    sync();
    return c;
  }

  /* camelCase / kebab keys -> readable words ("forceTeamChange" -> "force
   * team change"). Only ever rendered through textContent. */
  function humanize(k) {
    return String(k == null ? '' : k)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /* button with icon + label (label via textContent). `compact` mirrors the
   * label into aria-label + title because narrow-container CSS may hide the
   * visible label and leave the icon. */
  function iconBtn(label, iconName, cls, compact) {
    const b = el('button', { type: 'button', class: 'btn ' + (cls || '') });
    b.innerHTML = icon(iconName) + '<span class="adm-btn-label"></span>';
    b.querySelector('.adm-btn-label').textContent = label;
    if (compact) {
      b.setAttribute('aria-label', label);
      b.title = label;
    }
    return b;
  }

  /* ------------------------------------------------ layout building blocks */

  /* DESIGN §5 page head: title + sub on the left, actions right — the same
   * frame the views pages use (page-head-main / page-actions). */
  function pageHead(title, sub, actions) {
    const text = el('div', { class: 'page-head-main adm-head-text' }, el('h1', { class: 'page-title', text: title }));
    if (sub) text.append(el('div', { class: 'page-sub', text: sub }));
    const acts = el('div', { class: 'page-actions' });
    (actions || []).forEach((a) => { if (a) acts.append(a); });
    return { el: el('header', { class: 'page-head adm-head' }, text, acts), actions: acts };
  }

  /* Card: a head strip (signal-ticked .card-title + optional count chip on
   * the left, tools on the right), a flexible body and an optional footer.
   * Bodies stretch, so footers line up across a grid row. A null title
   * turns the head into a lead toolbar (filters start at the left). */
  function card(title, o) {
    o = o || {};
    const c = el(o.tag || 'section', { class: 'card adm-card' + (o.class ? ' ' + o.class : '') });
    const head = el('div', { class: 'adm-card-head' });
    let countEl = null;
    if (title != null) {
      const t = el('h2', { class: 'card-title' }, el('span', { class: 'truncate', text: title }));
      if (o.count) {
        countEl = el('span', { class: 'adm-chip-count hidden' });
        t.append(countEl);
      }
      head.append(t);
    }
    const actions = el('div', { class: 'adm-card-tools' + (title == null ? ' is-lead' : '') });
    head.append(actions);
    const body = el('div', { class: 'adm-card-body' + (o.flush ? ' is-flush' : '') });
    c.append(head, body);
    let foot = null;
    return {
      el: c, head, actions, body,
      setCount(v) {
        if (!countEl) return;
        const show = v != null && v !== '' && v !== 0;
        countEl.classList.toggle('hidden', !show);
        countEl.textContent = show ? String(v) : '';
      },
      foot() {
        if (!foot) { foot = el('div', { class: 'adm-card-foot' }); c.append(foot); }
        return foot;
      },
    };
  }

  /* Table card: titled (with a count chip) or a bare filter toolbar, over a
   * flush body that holds the .table-wrap; optional footer (pager). */
  function tableCard(o) {
    o = o || {};
    const c = card(o.title != null ? o.title : null, {
      class: 'adm-table-card' + (o.class ? ' ' + o.class : ''),
      flush: true,
      count: o.title != null,
    });
    (o.tools || []).forEach((t) => { if (t) c.actions.append(t); });
    c.body.classList.add('adm-table-body');
    return {
      el: c.el, head: c.head, tools: c.actions, body: c.body,
      setCount: c.setCount,
      foot: c.foot,
    };
  }

  function section(title) {
    const body = el('div', { class: 'adm-section-body' });
    for (let i = 1; i < arguments.length; i++) { if (arguments[i]) body.append(arguments[i]); }
    return el('section', { class: 'adm-section' }, el('h2', { class: 'section-title', text: title }), body);
  }

  /* DESIGN §5 empty state: icon + one-line title + one-line hint + optional
   * primary action ({label, icon, onClick}). The icon sits directly in
   * .empty — the foundation draws its radar disc on `.empty > .icon`. */
  function emptyState(iconName, title, hint, action, compact) {
    const d = el('div', { class: 'empty' + (compact ? ' compact' : '') });
    d.innerHTML = icon(iconName || 'search'); /* static icon markup only */
    d.append(el('p', { class: 'empty-title', text: title }));
    if (hint) d.append(el('p', { class: 'empty-hint', text: hint }));
    if (action && action.label) {
      const b = iconBtn(action.label, action.icon || 'plus', 'primary small empty-action');
      if (action.onClick) b.addEventListener('click', action.onClick);
      d.append(b);
    }
    return d;
  }

  function emptyCard(icon, title, hint) {
    return el('div', { class: 'card adm-card adm-card--empty' }, emptyState(icon, title, hint));
  }

  /* first-fetch placeholder rows (DESIGN §5 skeletons) — nothing jumps */
  function skeletonRows(n) {
    const d = el('div', { class: 'adm-skel', 'aria-busy': 'true', 'aria-label': 'Loading' });
    for (let i = 0; i < (n || 5); i++) d.append(el('div', { class: 'skeleton line' }));
    return d;
  }

  /* label + control (+ muted hint). A bare input/select/textarea — or a
   * wrapper holding exactly one — is linked with for/id; anything else
   * becomes a labelled group. */
  function field(label, control, hint, cls) {
    const f = el('div', { class: 'field adm-field' + (cls ? ' ' + cls : '') });
    if (label) {
      const lab = el('label', { class: 'adm-field-label', text: label });
      const isCtl = /^(INPUT|SELECT|TEXTAREA)$/.test(control.tagName);
      const inner = isCtl ? [control] : control.querySelectorAll('input, select, textarea');
      if (inner.length === 1) {
        if (!inner[0].id) inner[0].id = uid('adm-f');
        lab.htmlFor = inner[0].id;
      } else {
        lab.id = uid('adm-l');
        if (!control.getAttribute('role')) control.setAttribute('role', 'group');
        control.setAttribute('aria-labelledby', lab.id);
      }
      f.append(lab);
    }
    f.append(control);
    if (hint) f.append(el('div', { class: 'hint', text: hint }));
    return f;
  }

  /* 6-column form grid; children carry adm-w-2/3/4 (default full width) */
  function formGrid() {
    const f = el('div', { class: 'adm-form' });
    for (let i = 0; i < arguments.length; i++) { if (arguments[i]) f.append(arguments[i]); }
    return f;
  }

  /* input with a unit suffix drawn inside the box ("s", "min", "days") */
  function unitInput(input, unit) {
    return el('div', { class: 'adm-unit' }, input, el('span', { class: 'adm-unit-suffix', 'aria-hidden': 'true', text: unit }));
  }

  /* search field with a leading icon (foundation .search-box) */
  function searchBox(placeholder, ariaLabel) {
    const input = el('input', { class: 'input', type: 'search', placeholder, 'aria-label': ariaLabel, autocomplete: 'off', spellcheck: 'false' });
    const wrap = el('div', { class: 'search-box adm-search' });
    wrap.innerHTML = SW.icon('search');
    wrap.append(input);
    return { wrap, input };
  }

  /* segmented single-select chips (DESIGN §5 chips/filters; also used as
   * tabs). onChange fires on every click — re-clicking the active tab
   * doubles as a reload, as before. */
  function segmented(options, value, onChange, o) {
    o = o || {};
    const wrap = el('div', { class: 'adm-seg', role: o.tabs ? 'tablist' : 'group', 'aria-label': o.label || null });
    const btns = [];
    options.forEach((opt) => {
      const b = el('button', { type: 'button', class: 'chip', text: opt.label });
      if (o.tabs) b.setAttribute('role', 'tab');
      b.addEventListener('click', () => { set(opt.value); onChange(opt.value); });
      btns.push([b, opt.value]);
      wrap.append(b);
    });
    function set(v) {
      for (const [b, val] of btns) {
        const on = val === v;
        b.classList.toggle('on', on);
        b.setAttribute(o.tabs ? 'aria-selected' : 'aria-pressed', String(on));
      }
    }
    set(value);
    return {
      el: wrap,
      set,
      disable() { btns.forEach(([b]) => { b.disabled = true; }); },
    };
  }

  function keyHint(keys, what) {
    return el('span', { class: 'adm-key' }, el('kbd', { text: keys }), el('span', { text: what }));
  }

  function dot(state) {
    return el('span', { class: 'adm-dot' + (state ? ' is-' + state : ''), 'aria-hidden': 'true' });
  }

  /* status pill (card-title right side): dot + short state word */
  function setPill(p, state, text) {
    p.className = 'adm-pill' + (state ? ' is-' + state : '');
    p.textContent = '';
    p.append(dot(state), el('span', { text }));
  }

  function readoutCell(label, valueEl, cls) {
    return el('div', { class: 'adm-readout-cell' + (cls ? ' ' + cls : '') },
      el('div', { class: 'adm-readout-label', text: label }), valueEl);
  }

  /* on/off switch: a real checkbox (role=switch) over a drawn track, so
   * keyboard, forms and screen readers treat it as the checkbox it is */
  function switchEl(checked, ariaLabel) {
    const input = el('input', { type: 'checkbox', role: 'switch', 'aria-label': ariaLabel || null });
    input.checked = !!checked;
    return { el: el('label', { class: 'adm-switch' }, input, el('span', { class: 'adm-switch-ui', 'aria-hidden': 'true' })), input };
  }

  /* a whole-row label: switch + title + a one-line description */
  function toggleRow(checked, title, desc) {
    const input = el('input', { type: 'checkbox', role: 'switch' });
    input.checked = !!checked;
    const text = el('span', { class: 'adm-toggle-text' }, el('span', { class: 'adm-toggle-title', text: title }));
    if (desc) text.append(el('span', { class: 'adm-toggle-desc', text: desc }));
    const row = el('label', { class: 'adm-toggle-row' },
      el('span', { class: 'adm-switch' }, input, el('span', { class: 'adm-switch-ui', 'aria-hidden': 'true' })), text);
    return { el: row, input };
  }

  /* tinted callout with a leading icon: tone 'info' (foundation .callout),
   * 'warn' or 'danger' */
  function callout(iconName, tone, content) {
    const c = el('div', { class: 'callout adm-callout' + (tone && tone !== 'info' ? ' is-' + tone : '') });
    c.innerHTML = icon(iconName);
    const body = el('span');
    if (typeof content === 'string') body.textContent = content;
    else if (Array.isArray(content)) content.forEach((x) => body.append(x));
    else if (content) body.append(content);
    c.append(body);
    return c;
  }

  /* ------------------------------------------------------- table cells */

  function truncSpan(text, cls) {
    const s = text == null ? '' : String(text);
    return el('span', { class: 'truncate adm-trunc' + (cls ? ' ' + cls : ''), title: s || null, text: s || '—' });
  }

  /* player name: clickable action link, single line, full name on hover */
  function nameLink(ref) {
    const r = ref || {};
    const a = SW.ui.playerLink(r, { class: 'truncate adm-name' });
    a.title = r.name || 'unknown';
    return a;
  }

  /* audit/ban timestamp: time over ISO date, full locale string on hover */
  function stampCell(ts) {
    const n = Number(ts);
    if (!n) return el('span', { class: 'adm-muted', text: '—' });
    const d = new Date(n);
    return el('div', { class: 'adm-stamp', title: d.toLocaleString() },
      el('span', { class: 'adm-stamp-time', text: fmtHMS(n) }),
      el('span', { class: 'adm-stamp-date', text: fmtYMD(d) }));
  }

  function rconBadge(v) {
    if (v === 1 || v === true || v === '1') return SW.ui.badge('ok', 'ok');
    if (v === 0 || v === false || v === '0') return SW.ui.badge('fail', 'red');
    return SW.ui.badge('n/a', 'dim');
  }
  /* Squad's own AdminBan when the ban was issued (a bans row). A miss (the
   * player had already left) is not a failed ban: A3 Admin enforces a live
   * ban on every join — an expired or lifted one on none. */
  function banGameBadge(r) {
    const v = g(r, 'rconOk', 'rcon_ok');
    if (v === 1 || v === true || v === '1') {
      return SW.ui.badge('applied', 'ok', 'Squad applied this ban directly when it was issued.');
    }
    if (v === 0 || v === false || v === '0') {
      if (!banLive(r)) {
        return SW.ui.badge('not applied', 'dim',
          'The game server could not apply it directly when it was issued (usually: the player had already left). ' +
          'The ban is no longer active, so nothing enforces it now.');
      }
      return SW.ui.badge('kick on join', 'warn',
        'The game server could not apply it directly (usually: the player had already left). ' +
        'The ban is active: A3 Admin kicks the player within seconds whenever they join.');
    }
    return SW.ui.badge('n/a', 'dim');
  }

  /* same selector preference as app.js targetBody (private there) */
  function targetBody(ref, extra) {
    const body = Object.assign({}, extra);
    const dbId = ref && (ref.dbId != null ? ref.dbId : ref.id);
    if (dbId != null) body.playerId = dbId;
    else if (ref && ref.steamId) body.steamId = ref.steamId;
    return body;
  }

  /* §14.3: every admin action toasts the rcon response — truncated with an
   * expander. The full text only ever lands in textContent (§19.3.25). */
  const RCON_CUT = 280;
  function rconResultToast(title, res) {
    const bad = res && (res.ok === false || res.rconOk === false);
    const kind = bad ? 'warn' : 'ok';
    let full = '';
    if (res) {
      const v = res.rconResponse != null ? res.rconResponse : res.response;
      if (v != null) full = String(v);
    }
    if (!full) { SW.ui.toast(title, kind); return; }
    if (full.length <= RCON_CUT) { SW.ui.toast(title, kind, { pre: full }); return; }
    const t = SW.ui.toast(title, kind, { pre: full.slice(0, RCON_CUT) + '…', sticky: true });
    if (!t || !t.el) return;
    let timer = setTimeout(() => t.dismiss(), 12000);
    const btn = el('button', { type: 'button', class: 'btn ghost small expand-btn', text: 'Show full response' });
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (timer) { clearTimeout(timer); timer = null; }
      const pre = t.el.querySelector('.toast-pre');
      if (pre) pre.textContent = full; /* textContent — never markup */
      btn.remove();
    });
    t.el.append(btn);
  }

  /* two sequential confirms (match restart/end per §14.3) */
  async function doubleConfirm(first, second) {
    const a = await SW.ui.confirmModal(first);
    if (!a) return false;
    const b = await SW.ui.confirmModal(second);
    return !!b;
  }

  /* flatten the live snapshot into online playerRefs (grouped data kept) */
  function onlinePlayers() {
    const out = [];
    const snap = SW.state.snapshot;
    if (!snap || !snap.teams) return out;
    for (const t of snap.teams) {
      const teamName = t.name || ('Team ' + t.teamId);
      const buckets = (t.squads || []).map((s) => s.players || []);
      buckets.push(t.unassigned || []);
      for (const bucket of buckets) {
        for (const p of bucket) {
          out.push(Object.assign({ teamId: t.teamId, teamName }, p));
        }
      }
    }
    return out;
  }

  /* <select> of online players, grouped per team; keeps selection across
   * snapshot refreshes (keyed by eosId, falling back to steamId/name) and
   * leaves the DOM alone when the roster did not change, so an open
   * dropdown is never yanked shut by a live update. */
  function playerPicker(ariaLabel) {
    const sel = el('select', { class: 'input', 'aria-label': ariaLabel || 'Online player' });
    let refs = [];
    let sig = null;
    function keyOf(p) { return p.eosId || p.steamId || ('n:' + (p.name || '')); }
    function rebuild() {
      const next = onlinePlayers().sort((a, b) => {
        if (num(a.teamId) !== num(b.teamId)) return num(a.teamId) - num(b.teamId);
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
      const nextSig = next.map((p) => keyOf(p) + '\u0001' + (p.name || '') + '\u0001' + p.teamId + '\u0001' + (p.squadId != null ? p.squadId : '') + '\u0001' + (p.teamName || '')).join('\u0002');
      if (nextSig === sig) { refs = next; return; }
      sig = nextSig;
      const prev = sel.value !== '' && refs[Number(sel.value)] ? keyOf(refs[Number(sel.value)]) : null;
      refs = next;
      sel.textContent = '';
      sel.append(el('option', { value: '', text: refs.length ? 'Pick an online player…' : 'No players online' }));
      let grp = null;
      let grpTeam = null;
      refs.forEach((p, i) => {
        if (grpTeam !== p.teamId) {
          grpTeam = p.teamId;
          grp = el('optgroup', { label: 'Team ' + p.teamId + ' — ' + (p.teamName || '') });
          sel.append(grp);
        }
        const o = el('option', { value: String(i) });
        o.textContent = (p.name || 'unknown') + (p.squadId != null ? ' · sq ' + p.squadId : '');
        (grp || sel).append(o);
        if (prev && keyOf(p) === prev) sel.value = String(i);
      });
    }
    rebuild();
    return {
      el: sel,
      rebuild,
      current() { return sel.value === '' ? null : refs[Number(sel.value)] || null; },
    };
  }

  function prefersReducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_e) { return false; }
  }

  /* scroll a card into view and ring it briefly (Settings ?focus=…).
   * `settled` (a promise): cards above may still grow while their data
   * loads, so the scroll lands once more when it resolves. */
  function spotlight(node, settled) {
    if (!node) return;
    const go = (smooth) => {
      try { node.scrollIntoView({ block: 'start', behavior: smooth && !prefersReducedMotion() ? 'smooth' : 'auto' }); }
      catch (_e) { node.scrollIntoView(); }
    };
    requestAnimationFrame(() => {
      go(true);
      node.classList.add('is-target');
      setTimeout(() => node.classList.remove('is-target'), 1800);
      if (settled && typeof settled.then === 'function') {
        settled.then(() => requestAnimationFrame(() => { if (node.isConnected) go(false); }), () => {});
      }
    });
  }

  /* own enumerable keys of a JSON object into a null-prototype map, so a
   * key like "constructor" or "__proto__" is plain data */
  function ownMap(obj) {
    const out = Object.create(null);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const k of Object.keys(obj)) out[k] = obj[k];
    }
    return out;
  }

  /* ========================================= QUICK COMMANDS (shared parts) */

  /* docs/NEXT-CONTRACTS.md §2. A toggle row holds one bare command that the
   * server sends with 1 (ON) or 0 (OFF); any other row runs as written. The
   * regexes mirror the server's validation so the Settings editor flags a
   * bad row before Save. */
  const QC_MAX = 30;
  const QC_LABEL_MAX = 40;
  const QC_ID_RE = /^[a-z0-9-]{1,40}$/;
  const QC_CMD_RE = /^[A-Za-z][A-Za-z0-9_]{2,63}( [^\r\n\0]{1,200})?$/;
  const QC_TOGGLE_RE = /^[A-Za-z][A-Za-z0-9_]{2,63}$/;

  /* "No respawn timer" / "AdminNoRespawnTimer" -> "no-respawn-timer" (≤ 40) */
  function slugOf(s) {
    return String(s || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '');
  }

  /* ids for editor rows: ids matching `re` stay; the rest come from
   * baseOf(row, taken), made unique with -2, -3 … (40 characters max) */
  function uniqueIds(rows, re, baseOf) {
    const taken = new Set(rows.filter((x) => x.id && re.test(x.id)).map((x) => x.id));
    return rows.map((x) => {
      if (x.id && re.test(x.id)) return x.id;
      const base = baseOf(x, taken);
      let id = base;
      for (let k = 2; taken.has(id); k++) {
        const suf = '-' + k;
        id = base.slice(0, 40 - suf.length).replace(/-+$/, '') + suf;
      }
      taken.add(id);
      return id;
    });
  }

  /* the toggles RCON ListCommands reports on the owner's server, labelled so
   * that ON always means the command's 1 */
  const QC_COMMON = [
    { id: 'no-respawn-timer', label: 'No respawn timer', command: 'AdminNoRespawnTimer' },
    { id: 'all-roles', label: 'All roles available', command: 'AdminForceAllRoleAvailability' },
    { id: 'all-vehicles', label: 'All vehicles available', command: 'AdminForceAllVehicleAvailability' },
    { id: 'all-deployables', label: 'All deployables available', command: 'AdminForceAllDeployableAvailability' },
    { id: 'all-actions', label: 'All actions available', command: 'AdminForceAllActionAvailability' },
    { id: 'no-team-change-timer', label: 'No team change timer', command: 'AdminNoTeamChangeTimer' },
    { id: 'no-vehicle-claiming', label: 'Disable vehicle claiming', command: 'AdminDisableVehicleClaiming' },
    { id: 'no-vehicle-team-req', label: 'Disable vehicle team requirement', command: 'AdminDisableVehicleTeamRequirement' },
    { id: 'no-vehicle-kit-req', label: 'Disable vehicle kit requirement', command: 'AdminDisableVehicleKitRequirement' },
    { id: 'always-valid-placement', label: 'Always valid placement', command: 'AdminAlwaysValidPlacement' },
    { id: 'fog-of-war', label: 'Fog of war', command: 'AdminSetFogOfWar' },
  ];

  /* GET /api/quick-commands rows -> [{id, label, command, toggle}] */
  function qcRows(r) {
    return listOf(r).filter((x) => x && x.id != null && x.id !== '').map((x) => ({
      id: String(x.id),
      label: String(x.label == null || x.label === '' ? x.id : x.label),
      command: String(x.command == null ? '' : x.command),
      toggle: x.toggle === true || x.toggle === 1 || x.toggle === '1',
    }));
  }

  /* last[id] = {value: 0|1|null, by, at, rconOk} — the newest run per id,
   * read from the audit log. `at` may arrive in seconds or ms, `by` as a
   * name or a user object; rconOk false = the game server refused it.
   * -> {value, by, at, failed} | null */
  function qcLast(last, id) {
    if (!last || !Object.prototype.hasOwnProperty.call(last, id)) return null;
    const v = last[id];
    if (!v || typeof v !== 'object') return null;
    const at = toMs(g(v, 'at', 'time', 'ts'));
    let by = g(v, 'by', 'username', 'user');
    if (by && typeof by === 'object') by = g(by, 'username', 'name');
    const raw = g(v, 'value');
    let value = null;
    if (raw === 1 || raw === '1' || raw === true) value = 1;
    else if (raw === 0 || raw === '0' || raw === false) value = 0;
    const ok = g(v, 'rconOk', 'rcon_ok');
    return {
      value,
      by: by == null || by === '' ? null : String(by),
      at: at || null,
      failed: ok === false || ok === 0,
    };
  }

  /* run toast: the title says what was set, the body is the RCON response —
   * or the command itself when the game answered with nothing */
  function qcToast(row, value, res) {
    const title = row.toggle ? row.label + ' → ' + (value === 1 ? 'ON' : 'OFF') : 'Ran: ' + row.label;
    const resp = res && (res.rconResponse != null ? res.rconResponse : res.response);
    if (resp != null && String(resp).trim() !== '') { rconResultToast(title, res); return; }
    const sent = res && res.command ? String(res.command) : row.command + (row.toggle ? ' ' + value : '');
    rconResultToast(title, Object.assign({}, res, { rconResponse: '$ ' + sent + '\n(no response text)' }));
  }

  /* Quick-commands panel (Admin tools card, top of the Raw command page):
   * one tile per preset — label, the command in mono, ON / OFF for toggles
   * or Run, and the last value sent from A3 Admin. A press runs at once with
   * no confirm: an owner approved every preset in Settings.
   * o.onResult(row, value, res) also receives each successful run.
   * -> {el, load(quiet), dispose()} */
  function quickPanel(o) {
    o = o || {};
    const c = card('Quick commands', { class: 'adm-qc' + (o.class ? ' ' + o.class : ''), count: true });
    if (SW.can('settings')) {
      const edit = el('a', { class: 'btn ghost small', href: '#/settings?focus=quick-commands', title: 'Edit the presets in Settings' });
      edit.innerHTML = SW.icon('edit') + '<span class="adm-btn-label"></span>';
      edit.querySelector('.adm-btn-label').textContent = 'Edit';
      c.actions.append(edit);
    }
    const refreshBtn = el('button', { type: 'button', class: 'btn ghost small icon-only', title: 'Refresh', 'aria-label': 'Refresh quick commands' });
    refreshBtn.innerHTML = SW.icon('refresh');
    c.actions.append(refreshBtn);
    const list = el('div', { class: 'adm-qc-list', role: 'list', 'aria-label': 'Quick commands' });
    c.body.append(list);
    c.foot().append(el('p', { class: 'adm-note', text: 'State is the last value sent from A3 Admin — the game server is not read back.' }));

    let rows = [];
    let last = ownMap(null);
    let loaded = false;
    let seq = 0;
    let disposed = false;
    const busy = new Set(); /* ids with a run in flight */

    function lastLine(row) {
      const box = el('div', { class: 'adm-qc-last' });
      if (busy.has(row.id)) {
        box.append(dot('busy'), el('span', { text: 'Sending…' }));
        return box;
      }
      const L = qcLast(last, row.id);
      if (!L) {
        box.append(el('span', { class: 'adm-qc-never', text: 'Not run from A3 Admin yet' }));
        return box;
      }
      let word = 'Ran';
      let tone = 'ran';
      if (row.toggle && L.value === 1) { word = 'ON'; tone = 'on'; }
      else if (row.toggle && L.value === 0) { word = 'OFF'; tone = 'off'; }
      box.append(el('span', { class: 'adm-qc-state is-' + tone, text: word }));
      if (L.failed) {
        box.append(el('span', { class: 'adm-qc-sep', 'aria-hidden': 'true', text: '·' }),
          el('span', { class: 'adm-qc-fail', title: 'The game server did not accept it', text: 'failed' }));
      }
      if (L.by) {
        box.append(el('span', { class: 'adm-qc-sep', 'aria-hidden': 'true', text: '·' }),
          el('span', { class: 'adm-qc-by truncate', title: 'by ' + L.by, text: 'by ' + L.by }));
      }
      if (L.at) box.append(el('span', { class: 'adm-qc-sep', 'aria-hidden': 'true', text: '·' }), SW.ui.timeAgo(L.at));
      return box;
    }

    function tile(row) {
      const t = el('div', { class: 'adm-qc-tile' + (busy.has(row.id) ? ' is-busy' : ''), role: 'listitem', dataset: { id: row.id } });
      const cmdText = row.toggle ? row.command + ' 1|0' : row.command;
      t.append(
        el('span', { class: 'adm-qc-label truncate', title: row.label, text: row.label }),
        el('code', { class: 'adm-qc-cmd truncate', title: cmdText, text: cmdText }),
        lastLine(row));
      const acts = el('div', { class: 'adm-qc-acts' });
      if (row.toggle) {
        const sw = el('div', { class: 'adm-qc-switch', role: 'group', 'aria-label': row.label });
        [[1, 'ON'], [0, 'OFF']].forEach(([v, word]) => {
          sw.append(el('button', {
            type: 'button',
            class: 'btn small ' + (v ? 'adm-qc-on' : 'adm-qc-off'),
            title: 'Send ' + row.command + ' ' + v,
            dataset: { v: String(v) },
            text: word,
          }));
        });
        acts.append(sw);
      } else {
        const b = iconBtn('Run', 'play', 'small adm-qc-run');
        b.title = 'Run ' + row.command;
        acts.append(b);
      }
      t.append(acts);
      paintActs(t, row);
      return t;
    }

    /* busy / lit state of a tile's buttons. Busy buttons stay focusable
     * (aria-disabled, not disabled) so keyboard focus survives a run. */
    function paintActs(t, row) {
      const on = busy.has(row.id);
      const L = qcLast(last, row.id);
      t.classList.toggle('is-busy', on);
      t.querySelectorAll('.adm-qc-acts button').forEach((b) => {
        if (on) b.setAttribute('aria-disabled', 'true');
        else b.removeAttribute('aria-disabled');
        if (b.dataset.v === '1' || b.dataset.v === '0') {
          const lit = !!L && !L.failed && L.value === Number(b.dataset.v);
          b.classList.toggle('is-lit', lit);
          b.setAttribute('aria-pressed', String(lit));
        }
      });
    }

    function tileOf(id) {
      for (const n of Array.from(list.children)) {
        if (n.dataset && n.dataset.id === id) return n;
      }
      return null;
    }

    /* refresh one tile in place: state line + buttons */
    function syncTile(id) {
      const row = rows.find((r) => r.id === id);
      const t = row ? tileOf(id) : null;
      if (!t) return;
      const old = t.querySelector('.adm-qc-last');
      if (old) old.replaceWith(lastLine(row));
      paintActs(t, row);
    }

    function draw() {
      c.setCount(rows.length);
      list.textContent = '';
      if (!rows.length) {
        const canEdit = SW.can('settings');
        list.append(emptyState('zap', 'No quick commands yet',
          canEdit ? 'Add one-press presets — like No respawn timer — in Settings.' : 'An owner can add one-press presets in Settings.',
          canEdit ? { label: 'Set up quick commands', icon: 'settings', onClick: () => SW.navigate('#/settings?focus=quick-commands') } : null,
          true));
        return;
      }
      const frag = document.createDocumentFragment();
      rows.forEach((row) => frag.append(tile(row)));
      list.append(frag);
    }

    async function run(row, value) {
      if (busy.has(row.id)) return;
      busy.add(row.id);
      syncTile(row.id);
      let res = null;
      try {
        res = await SW.api('/api/quick-commands/' + encodeURIComponent(row.id) + '/run', {
          method: 'POST', body: row.toggle ? { value } : {},
        });
      } catch (_e) { /* toasted by SW.api */ }
      busy.delete(row.id);
      if (res) qcToast(row, value, res);
      if (disposed) return;
      if (res) {
        if (o.onResult) o.onResult(row, value, res);
        const me = SW.state.me;
        last[row.id] = {
          value: row.toggle ? value : null,
          by: me && me.username ? me.username : null,
          at: Date.now(),
          rconOk: res.rconOk !== false,
        };
      }
      syncTile(row.id);
      if (res) load(true); /* the audit log is the authority for 'last' */
    }

    list.addEventListener('click', (e) => {
      const b = e.target.closest('.adm-qc-acts button');
      if (!b || !list.contains(b) || b.getAttribute('aria-disabled') === 'true') return;
      const t = b.closest('.adm-qc-tile');
      const row = t ? rows.find((r) => r.id === t.dataset.id) : null;
      if (!row) return;
      run(row, row.toggle ? (b.dataset.v === '1' ? 1 : 0) : null);
    });

    /* quiet: a background refresh — failures keep the tiles already shown */
    async function load(quiet) {
      const my = ++seq;
      if (!loaded) {
        list.textContent = '';
        list.append(skeletonRows(2));
      }
      refreshBtn.disabled = true;
      let r;
      try { r = await SW.api('/api/quick-commands', { toast: false }); }
      catch (e) {
        if (my !== seq || disposed) return;
        refreshBtn.disabled = false;
        if (loaded) {
          if (!quiet) SW.ui.toast('Could not refresh quick commands', 'error');
          return;
        }
        list.textContent = '';
        list.append(emptyState('zap', 'Could not load quick commands',
          e && e.status === 403 ? 'Your role cannot read the preset list.' : 'The server did not answer — try Refresh in a moment.',
          null, true));
        return;
      }
      if (my !== seq || disposed) return;
      refreshBtn.disabled = false;
      const next = qcRows(r);
      /* same presets as on screen: refresh in place so focus stays put */
      const same = loaded && rows.length > 0 && next.length === rows.length && next.every((x, i) =>
        x.id === rows[i].id && x.label === rows[i].label && x.command === rows[i].command && x.toggle === rows[i].toggle);
      loaded = true;
      rows = next;
      last = ownMap(r && r.last);
      if (same) rows.forEach((x) => syncTile(x.id));
      else draw();
    }

    const onVisible = () => { if (document.visibilityState === 'visible' && loaded) load(true); };
    document.addEventListener('visibilitychange', onVisible);
    refreshBtn.addEventListener('click', () => load(false));

    return {
      el: c.el,
      load,
      dispose() {
        disposed = true;
        document.removeEventListener('visibilitychange', onVisible);
      },
    };
  }

  /* =================================== BATTLEMETRICS IMPORT (shared parts) */

  function bmErrors(res) {
    const e = res && res.errors;
    if (Array.isArray(e)) return e.map((x) => String(x));
    return e ? [String(e)] : [];
  }

  /* importNow() result (§3) -> one-line summary */
  function bmSummary(res) {
    const n = (k) => SW.ui.fmtNum(num(res && res[k]));
    const errs = bmErrors(res).length;
    return n('fetched') + ' fetched · ' + n('imported') + ' new · ' + n('updated') + ' updated · '
      + n('deactivated') + ' deactivated' + (errs ? ' · ' + errs + (errs === 1 ? ' error' : ' errors') : '');
  }

  /* importNow() result -> labelled count strip + the error list (<pre>,
   * textContent — BattleMetrics API messages are untrusted) */
  function bmResultView(res) {
    const errs = bmErrors(res);
    const cells = [
      ['Fetched', res && res.fetched, 'Bans read from the BattleMetrics list'],
      ['Imported', res && res.imported, 'New in A3 Admin'],
      ['Updated', res && res.updated, 'Already mirrored — refreshed in place'],
      ['Deactivated', res && res.deactivated, 'Lifted or expired on BattleMetrics — no longer enforced here'],
      ['Skipped', g(res || {}, 'skippedNoIdentifier', 'skipped'), 'No SteamID or EOS ID on the ban — nothing to match a player against'],
      ['Errors', errs.length, null],
    ];
    const strip = el('div', { class: 'adm-bm-counts' });
    for (const [k, v, tip] of cells) {
      const n = num(v);
      strip.append(el('div', {
        class: 'adm-bm-count' + (k === 'Imported' && n ? ' is-new' : '') + (k === 'Errors' && n ? ' is-bad' : ''),
        title: tip,
      }, el('span', { class: 'adm-bm-count-v', text: SW.ui.fmtNum(n) }), el('span', { class: 'adm-bm-count-k', text: k })));
    }
    const wrap = el('div', { class: 'adm-bm-result' }, strip);
    if (errs.length) {
      const shown = errs.slice(0, 20);
      const pre = el('pre', { class: 'adm-pre adm-bm-errors' });
      pre.textContent = shown.join('\n') + (errs.length > shown.length ? '\n… and ' + (errs.length - shown.length) + ' more' : '');
      wrap.append(pre);
    }
    return wrap;
  }

  /* POST /api/battlemetrics/import. A long list can outlast the reverse
   * proxy's read timeout (Cloudflare gives up after ~100 s) while the server
   * keeps importing, so a gateway timeout reads "still running", not
   * "failed". -> result | null (every failure already toasted) */
  async function bmImportCall(banListId) {
    try {
      return await SW.api('/api/battlemetrics/import', {
        method: 'POST', body: banListId ? { banListId } : {}, toast: false,
      });
    } catch (e) {
      const st = e && e.status;
      if (st === 401) return null; /* SW.api is already on its way to the login page */
      if (st === 504 || st === 524) {
        SW.ui.toast('The import is still running on the server — check back in a minute for the result', 'info', { timeout: 9000 });
      } else if (st == null) {
        SW.ui.toast('Network error — the import may still be running on the server', 'warn');
      } else {
        SW.ui.toast((e && e.message) || 'BattleMetrics import failed', 'error');
      }
      return null;
    }
  }

  /* ================================================ EVIDENCE (shared parts)
   * docs/BATCH3-CONTRACTS.md §1. Files hang off a ban (targetType 'ban',
   * bans.id) or a warn / kick / ban audit row ('action', admin_actions.id).
   * app.js owns the evidence components (SW.ui.evidenceButton /
   * openEvidence / evidenceList / evidenceUploader); each is feature-
   * detected, and without them a minimal list (GET /api/evidence + the /file
   * URLs) and a plain uploader stand in. The server decides every file's
   * type from its bytes — the extension / MIME precheck here only spares a
   * doomed upload. */

  const EV_TEXT_MAX = 2 * 1024 * 1024;
  const EV_PER_TARGET = 20;
  const EV_EXT = Object.assign(Object.create(null), {
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image',
    mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', mkv: 'video',
    pdf: 'pdf', txt: 'text', log: 'text',
  });
  const EV_MIME = Object.assign(Object.create(null), {
    'image/png': 'image', 'image/jpeg': 'image', 'image/gif': 'image', 'image/webp': 'image',
    'video/mp4': 'video', 'video/quicktime': 'video', 'video/webm': 'video', 'video/x-matroska': 'video',
    'application/pdf': 'pdf', 'text/plain': 'text',
  });
  const EV_ACCEPT = Object.keys(EV_EXT).map((x) => '.' + x).concat(Object.keys(EV_MIME)).join(',');
  const EV_TYPES_TEXT = 'images (PNG, JPEG, GIF, WebP), video (MP4, MOV, WebM, MKV), PDF or plain text';
  /* config.evidence.maxMB once the Settings page has read it this session */
  let evMaxMB = null;

  /* File -> 'image' | 'video' | 'pdf' | 'text' | null */
  function evKindOfFile(file) {
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(file && file.name || ''));
    const byExt = m ? EV_EXT[m[1].toLowerCase()] : undefined;
    return byExt || EV_MIME[String(file && file.type || '').toLowerCase()] || null;
  }

  /* why the server would refuse this file, or null */
  function evPrecheck(file) {
    const kind = evKindOfFile(file);
    if (!kind) return 'Not an allowed type — use ' + EV_TYPES_TEXT + '.';
    if (!file.size) return 'The file is empty.';
    if (kind === 'text' && file.size > EV_TEXT_MAX) return 'Text files can be at most 2 MB.';
    if (evMaxMB && file.size > evMaxMB * 1024 * 1024) return 'Larger than the ' + evMaxMB + ' MB upload limit.';
    return null;
  }

  /* only the server's own file route is ever linked */
  function evFileUrl(r) {
    const u = r && typeof r.url === 'string' ? r.url : '';
    if (/^\/api\/evidence\/\d+\/file$/.test(u)) return u;
    return '/api/evidence/' + encodeURIComponent(String(r && r.id)) + '/file';
  }

  async function evList(targetType, targetId) {
    const q = new URLSearchParams({ targetType: String(targetType), targetId: String(targetId) });
    return listOf(await SW.api('/api/evidence?' + q.toString(), { toast: false }));
  }

  function evUploadError(status, body) {
    const msg = body && typeof body === 'object' && body.error ? String(body.error) : '';
    if (status === 413) return msg || 'Too large for the upload limit.';
    if (status === 415) return 'Not an allowed file type — use ' + EV_TYPES_TEXT + '.';
    if (status === 401) return 'Signed out — sign in again, then retry.';
    if (status === 403 && (!msg || msg === 'forbidden')) return 'Your role cannot attach evidence here.';
    return msg || 'Upload failed (HTTP ' + status + ').';
  }

  /* streams one file to POST /api/evidence (raw body; the same-origin XHR
   * carries the Origin header the CSRF check wants). onProgress(0..1).
   * -> Promise<response>; rejects with an Error carrying .status */
  function evUpload(targetType, targetId, file, caption, onProgress) {
    return new Promise((resolve, reject) => {
      const q = new URLSearchParams();
      q.set('targetType', String(targetType));
      q.set('targetId', String(targetId));
      q.set('filename', String(file.name || 'evidence').slice(0, 200));
      if (caption) q.set('caption', caption);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/evidence?' + q.toString());
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / Math.max(1, e.total));
      };
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch (_e) { body = null; }
        if (xhr.status >= 200 && xhr.status < 300) { resolve(body); return; }
        const err = new Error(evUploadError(xhr.status, body));
        err.status = xhr.status;
        reject(err);
      };
      xhr.onerror = () => {
        const err = new Error('Network error — the upload did not reach A3 Admin.');
        err.status = 0;
        reject(err);
      };
      xhr.send(file);
    });
  }

  /* the server's rule: the route takes warn, kick or ban; then the
   * uploader, or someone holding ban AND settings */
  function evCanDelete(r) {
    const me = SW.state.me;
    if (!me || !SW.canAny(['warn', 'kick', 'ban'])) return false;
    const by = g(r, 'uploadedBy', 'uploaded_by');
    return (by != null && Number(by) === Number(me.id)) || (SW.can('ban') && SW.can('settings'));
  }

  /* fallback list: one row per file — type icon, name (opens the file),
   * size · uploader · age, caption, delete when allowed.
   * o: {targetType, targetId, canUpload, onChange} -> {el, reload} */
  function evFallbackList(o) {
    const box = el('div', { class: 'adm-ev-list', role: 'list', 'aria-label': 'Evidence files' });
    let seq = 0;

    function item(r) {
      const mime = String(g(r, 'mime') || '');
      const kindIcon = /^image\//.test(mime) ? 'image' : (/^video\//.test(mime) ? 'film' : 'note');
      const name = String(g(r, 'filename') || ('evidence #' + r.id));
      const row = el('div', { class: 'adm-ev-item', role: 'listitem' });
      const ic = el('span', { class: 'adm-ev-icon', 'aria-hidden': 'true' });
      ic.innerHTML = icon(kindIcon);
      const main = el('div', { class: 'adm-ev-main' },
        el('a', {
          class: 'adm-ev-name truncate', href: evFileUrl(r), target: '_blank', rel: 'noopener noreferrer',
          title: 'Open ' + name, text: name,
        }));
      const meta = el('div', { class: 'adm-ev-meta' });
      meta.append(el('span', { text: fmtBytes(g(r, 'size')) }));
      const who = g(r, 'uploader', 'uploaderName', 'uploader_name');
      if (who) meta.append(el('span', { class: 'truncate', title: 'by ' + who, text: 'by ' + who }));
      const at = g(r, 'uploadedAt', 'uploaded_at');
      if (at) meta.append(SW.ui.timeAgo(at));
      main.append(meta);
      const cap = g(r, 'caption');
      if (cap) main.append(el('div', { class: 'adm-ev-caption wrap-anywhere', text: String(cap) }));
      row.append(ic, main);
      if (evCanDelete(r)) {
        const del = el('button', { type: 'button', class: 'btn danger ghost small icon-only', title: 'Delete', 'aria-label': 'Delete ' + name });
        del.innerHTML = icon('trash');
        del.addEventListener('click', async () => {
          const v = await SW.ui.confirmModal({
            title: 'Delete this evidence?',
            body: '"' + name + '" disappears for everyone. The deletion is audit-logged.',
            danger: true,
            confirmText: 'Delete file',
          });
          if (!v) return;
          del.disabled = true;
          try {
            await SW.api('/api/evidence/' + encodeURIComponent(r.id) + '/delete', { method: 'POST', body: {} });
            SW.ui.toast('Evidence deleted', 'ok');
            load();
            if (o.onChange) o.onChange();
          } catch (_e) { del.disabled = false; /* toasted */ }
        });
        row.append(del);
      }
      return row;
    }

    async function load() {
      const my = ++seq;
      if (!box.childNodes.length) box.append(skeletonRows(2));
      let rows;
      try { rows = await evList(o.targetType, o.targetId); }
      catch (e) {
        if (my !== seq) return;
        box.textContent = '';
        box.append(emptyState('paperclip', 'Could not load the evidence',
          e && e.status === 403 ? 'Your role cannot view evidence.' : 'The server did not answer — close this and try again in a moment.',
          null, true));
        return;
      }
      if (my !== seq) return;
      box.textContent = '';
      if (!rows.length) {
        box.append(emptyState('paperclip', 'No evidence yet',
          o.canUpload ? 'Attach screenshots, clips, PDFs or log excerpts below.' : null, null, true));
        return;
      }
      rows.forEach((r) => box.append(item(r)));
    }
    load();
    return { el: box, reload: load };
  }

  /* fallback uploader: picker + drop zone, an optional caption for the
   * next files, one progress row per file, Retry on failure.
   * o: {targetType, targetId, onUploaded} -> {el} */
  function evFallbackUploader(o) {
    const input = el('input', { type: 'file', multiple: true, accept: EV_ACCEPT, class: 'adm-ev-file', tabindex: '-1', 'aria-hidden': 'true' });
    const pick = iconBtn('Choose files', 'upload', 'ghost small');
    const caption = el('input', {
      class: 'input', type: 'text', maxlength: '200', autocomplete: 'off',
      placeholder: 'Caption for the next files (optional) — what does it show?', 'aria-label': 'Evidence caption',
    });
    const dropText = el('div', { class: 'adm-ev-drop-text' },
      el('span', { class: 'adm-ev-drop-title', text: 'Drop files here' }),
      el('span', { class: 'adm-ev-drop-hint', text: 'Images, video, PDF or text · up to ' + EV_PER_TARGET + ' files each' + (evMaxMB ? ' · ' + evMaxMB + ' MB per file' : '') }));
    const dropIcon = el('span', { class: 'adm-ev-drop-icon', 'aria-hidden': 'true' });
    dropIcon.innerHTML = icon('upload');
    const drop = el('div', { class: 'adm-ev-drop' }, dropIcon, dropText, pick, input);
    const queue = el('div', { class: 'adm-ev-queue', role: 'list', 'aria-label': 'Uploads' });
    const wrap = el('div', { class: 'adm-ev-up' }, drop, caption, queue);

    const jobs = [];
    let busy = false;

    function paint(j) {
      j.row.className = 'adm-ev-job is-' + j.state;
      j.status.textContent = j.state === 'queued' ? 'Waiting…'
        : j.state === 'sending' ? Math.round(j.p * 100) + '%'
          : j.state === 'done' ? 'Attached'
            : j.error;
      j.bar.style.transform = 'scaleX(' + (j.state === 'done' ? 1 : Math.max(0, Math.min(1, j.p))) + ')'; /* number only */
      j.retry.classList.toggle('hidden', !(j.state === 'failed' && j.retryable));
    }

    function add(files) {
      for (const f of files) {
        const status = el('span', { class: 'adm-ev-job-status' });
        const bar = el('span', { class: 'adm-ev-bar-fill' });
        const retry = el('button', { type: 'button', class: 'btn ghost small', text: 'Retry' });
        const j = {
          file: f, caption: caption.value.trim(), state: 'queued', p: 0, error: '', retryable: true, status, bar, retry,
          row: el('div', { class: 'adm-ev-job', role: 'listitem' },
            el('span', { class: 'adm-ev-job-name truncate', title: f.name, text: f.name }),
            el('span', { class: 'adm-ev-job-size', text: fmtBytes(f.size) }),
            el('span', { class: 'adm-ev-bar', 'aria-hidden': 'true' }, bar),
            status, retry),
        };
        const bad = evPrecheck(f);
        if (bad) { j.state = 'failed'; j.error = bad; j.retryable = false; }
        retry.addEventListener('click', () => { j.state = 'queued'; j.p = 0; paint(j); pump(); });
        paint(j);
        jobs.push(j);
        queue.append(j.row);
      }
      pump();
    }

    async function pump() {
      if (busy) return;
      busy = true;
      for (;;) {
        const j = jobs.find((x) => x.state === 'queued');
        if (!j) break;
        j.state = 'sending';
        paint(j);
        try {
          await evUpload(o.targetType, o.targetId, j.file, j.caption, (p) => { j.p = p; paint(j); });
          j.state = 'done';
          paint(j);
          if (o.onUploaded) o.onUploaded();
        } catch (e) {
          j.state = 'failed';
          j.error = (e && e.message) || 'Upload failed.';
          j.retryable = !(e && (e.status === 413 || e.status === 415 || e.status === 403));
          paint(j);
        }
      }
      busy = false;
    }

    pick.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      const files = Array.from(input.files || []);
      input.value = '';
      if (files.length) add(files);
    });
    let depth = 0;
    drop.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('is-over'); });
    drop.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
    drop.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove('is-over'); });
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      drop.classList.remove('is-over');
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) add(files);
    });
    return { el: wrap };
  }

  /* list (+ uploader when the viewer may attach) for one target — app.js's
   * list / uploader when present (wired the way its own dialog wires them),
   * else the fallbacks. o: {targetType, targetId, canUpload}
   * -> {el, bindDrop(node), dispose()} */
  function evidencePanel(o) {
    const wrap = el('div', { class: 'adm-ev' });
    const listSlot = el('div', { class: 'adm-ev-slot' });
    wrap.append(listSlot);
    let list = null;
    let up = null;

    function mountList() {
      let node = null;
      if (typeof SW.ui.evidenceList === 'function') {
        try {
          list = SW.ui.evidenceList({ targetType: o.targetType, targetId: o.targetId });
          node = asNode(list);
        } catch (e) { console.error('evidenceList', e); node = null; }
      }
      if (!node) {
        list = evFallbackList({ targetType: o.targetType, targetId: o.targetId, canUpload: o.canUpload });
        node = list.el;
      }
      listSlot.textContent = '';
      listSlot.append(node);
    }
    /* an upload landed: add it in place when the list can, else re-read */
    function uploaded(ev) {
      if (ev && list && typeof list.add === 'function') {
        try { list.add(ev); return; } catch (_e) { /* re-read below */ }
      }
      const fn = list && (list.reload || list.refresh || list.load);
      if (typeof fn === 'function') {
        try { fn.call(list); return; } catch (_e) { /* rebuilt below */ }
      }
      mountList();
    }
    mountList();

    if (o.canUpload) {
      let node = null;
      if (typeof SW.ui.evidenceUploader === 'function') {
        try {
          up = SW.ui.evidenceUploader({
            targetType: o.targetType, targetId: o.targetId,
            existing: () => (list && typeof list.count === 'function' ? list.count() : 0),
            onUploaded: uploaded,
          });
          node = asNode(up);
        } catch (e) { console.error('evidenceUploader', e); node = null; }
      }
      if (!node) {
        up = evFallbackUploader({ targetType: o.targetType, targetId: o.targetId, onUploaded: () => uploaded(null) });
        node = up.el;
      }
      wrap.append(el('div', { class: 'adm-ev-upslot' }, el('div', { class: 'adm-subhead', text: 'Attach more' }), node));
    }

    return {
      el: wrap,
      /* the whole dialog takes dropped files */
      bindDrop(node) {
        if (up && typeof up.setDropTarget === 'function') { try { up.setDropTarget(node); } catch (_e) { /* optional */ } }
      },
      /* in-flight uploads keep going in app.js's background tray */
      dispose(label) {
        if (up && typeof up.detach === 'function') {
          try { up.detach(); } catch (_e) { /* already detached */ }
          try {
            if (typeof up.busy === 'function' && up.busy() && SW.evidence && typeof SW.evidence.tray === 'function') SW.evidence.tray(up, label);
          } catch (_e) { /* no tray */ }
        }
        for (const x of [list, up]) {
          const fn = x && (x.dispose || x.destroy);
          if (typeof fn === 'function') { try { fn.call(x); } catch (_e) { /* already gone */ } }
        }
      },
    };
  }

  /* the evidence dialog for one ban / audit row — app.js's openEvidence
   * when present. o: {targetType, targetId, title, lead, hint, canUpload,
   * onClose(count | null)}; the count is the live one at close (null when
   * it could not be read) */
  function openEvidenceModal(o) {
    const sub = [o.lead, o.hint].filter(Boolean).join(' ');
    if (typeof SW.ui.openEvidence === 'function') {
      let count = null;
      try {
        const h = SW.ui.openEvidence({
          targetType: o.targetType, targetId: o.targetId, title: o.title, subtitle: sub || null,
          canUpload: !!o.canUpload,
          onChange(rows) { if (Array.isArray(rows)) count = rows.length; },
          onClose() { if (o.onClose) o.onClose(count); },
        });
        if (h) return h;
      } catch (e) { console.error('openEvidence', e); }
    }
    const body = el('div', { class: 'adm-modal-stack adm-ev-modal' });
    if (o.lead) body.append(el('p', { class: 'modal-text wrap-anywhere', text: o.lead }));
    const panel = evidencePanel({ targetType: o.targetType, targetId: o.targetId, canUpload: o.canUpload });
    body.append(panel.el);
    if (o.hint) body.append(el('p', { class: 'adm-note', text: o.hint }));
    const doneBtn = el('button', { type: 'button', class: 'btn primary', text: 'Done' });
    body.append(el('div', { class: 'modal-actions' }, doneBtn));
    const m = SW.ui.modal({
      title: o.title, body, wide: true, class: 'adm-ev-dialog',
      onClose: () => {
        panel.dispose(o.title);
        if (!o.onClose) return;
        evList(o.targetType, o.targetId).then((rows) => o.onClose(rows.length), () => o.onClose(null));
      },
    });
    panel.bindDrop(m.el);
    doneBtn.addEventListener('click', () => m.close());
    return m;
  }

  /* the per-row control — app.js's evidenceButton when present, else a
   * paperclip + count chip ("Add" while empty and the viewer may attach).
   * Nothing at all when there is nothing to open or attach.
   * o: {targetType, targetId, count, canView, canUpload, what, title, lead,
   * hint, onCount(n)} */
  function evidenceControl(o) {
    const n = num(o.count);
    if (!n && !(o.canView && o.canUpload)) {
      return null;
    }
    if (o.canView && typeof SW.ui.evidenceButton === 'function') {
      try {
        const b = SW.ui.evidenceButton({
          targetType: o.targetType, targetId: o.targetId, count: n,
          title: o.title, subtitle: [o.lead, o.hint].filter(Boolean).join(' ') || null,
          canUpload: !!o.canUpload,
          onChange(rows) { if (Array.isArray(rows) && o.onCount) o.onCount(rows.length, true); },
        });
        if (b && b.nodeType) return b;
      } catch (e) { console.error('evidenceButton', e); }
    }
    const files = n + (n === 1 ? ' evidence file' : ' evidence files');
    if (!o.canView) {
      const s = el('span', { class: 'adm-ev-chip is-static', title: files });
      s.innerHTML = icon('paperclip');
      s.append(el('span', { class: 'adm-ev-chip-n', text: String(n) }));
      return s;
    }
    const label = n ? files + ' on ' + o.what + ' — open' : 'Attach evidence to ' + o.what;
    const b = el('button', { type: 'button', class: 'adm-ev-chip' + (n ? '' : ' is-empty'), title: label, 'aria-label': label });
    b.innerHTML = icon('paperclip');
    b.append(el('span', { class: 'adm-ev-chip-n', text: n ? String(n) : 'Add' }));
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      openEvidenceModal({
        targetType: o.targetType, targetId: o.targetId, title: o.title, lead: o.lead, hint: o.hint,
        canUpload: o.canUpload,
        onClose(c) { if (c != null && o.onCount) o.onCount(c, false); },
      });
    });
    return b;
  }

  /* keeps row counts true after uploads / deletions made anywhere — app.js
   * emits '_evidence' on SW.live, also for a closed dialog's uploads that
   * finish in the background. The count is re-read, never added to.
   * findRow(targetId) -> row | null; apply(row, n). -> unsubscribe */
  function trackEvidence(targetType, findRow, apply) {
    const timers = new Map();
    const off = SW.live.on('_evidence', (e) => {
      if (!e || e.targetType !== targetType || e.targetId == null) return;
      const key = String(e.targetId);
      if (timers.has(key) || !findRow(e.targetId)) return;
      timers.set(key, setTimeout(() => {
        timers.delete(key);
        evList(targetType, e.targetId).then((rows) => {
          const r = findRow(e.targetId);
          if (r) apply(r, rows.length);
        }, () => { /* the next page load shows it */ });
      }, 300));
    });
    return () => {
      off();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }

  /* ============================================================ ADMIN view */

  const BC_PRESET_KEY = 'bc-presets';
  const BC_PRESET_CAP = 12;
  const BC_MAX = 480;

  function renderAdmin(main) {
    const unsubs = [];
    this.cleanup = () => { unsubs.forEach((u) => u()); };

    const view = el('div', { class: 'view view-admin adm fade-in' });
    main.append(view);
    view.append(pageHead('Admin tools',
      'Broadcast, rotate layers, run the match and act on players. Every action is audit-logged.').el);

    /* per-card perm gates (§1): a card only renders (and only syncs) when the
     * viewer holds its key; quick-action buttons are filtered one by one. */
    const canBroadcast = SW.can('broadcast');
    const canLayer = SW.can('layer');
    const canMatch = SW.can('match');
    const canSquad = SW.can('squad');

    /* one-press presets (§2) — loaded once the layout is in place */
    const qk = SW.can('quickcmd') ? quickPanel({ class: 'adm-qc--tools' }) : null;
    if (qk) unsubs.push(() => qk.dispose());

    /* ---------------------------------------------- broadcast composer */
    const bc = card('Broadcast', { class: 'adm-bc' });
    const bcCount = el('span', { class: 'adm-counter' });
    bc.actions.append(bcCount);
    const bcTa = el('textarea', {
      class: 'input adm-bc-input', rows: '3', maxlength: String(BC_MAX),
      placeholder: 'Message shown to every player on the server…',
      'aria-label': 'Broadcast message',
    });
    const presetBox = el('div', { class: 'adm-presets' });
    bc.body.append(bcTa, el('div', { class: 'adm-presets-wrap' },
      el('div', { class: 'adm-subrow' },
        el('span', { class: 'adm-subhead', text: 'Presets' }),
        el('span', { class: 'adm-note', text: 'Saved in this browser only' })),
      presetBox));
    const bcSave = iconBtn('Save as preset', 'star', 'ghost small');
    const bcSend = iconBtn('Send broadcast', 'broadcast', 'primary');
    bc.foot().append(bcSave, el('span', { class: 'adm-grow' }),
      el('span', { class: 'adm-kbd-hint', title: 'Send with Ctrl+Enter' }, el('kbd', { text: 'Ctrl' }), el('kbd', { text: 'Enter' })),
      bcSend);

    function syncCount() {
      const n = bcTa.value.length;
      bcCount.textContent = n + ' / ' + BC_MAX;
      bcCount.classList.toggle('is-near', n > BC_MAX - 60);
    }
    syncCount();
    bcTa.addEventListener('input', syncCount);

    function getPresets() {
      const p = SW.prefs.get(BC_PRESET_KEY, []);
      return Array.isArray(p) ? p.filter((x) => typeof x === 'string' && x.trim()) : [];
    }
    function drawPresets() {
      presetBox.textContent = '';
      const presets = getPresets();
      if (!presets.length) {
        presetBox.append(el('span', { class: 'adm-note', text: 'No presets yet — type a message and save it for one-click reuse.' }));
        return;
      }
      presets.forEach((msg, i) => {
        const use = el('button', { type: 'button', class: 'adm-preset-use', title: msg, text: msg });
        const del = el('button', { type: 'button', class: 'adm-preset-del', 'aria-label': 'Delete preset', title: 'Delete preset' });
        del.innerHTML = SW.icon('x');
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          const next = getPresets();
          next.splice(i, 1);
          SW.prefs.set(BC_PRESET_KEY, next);
          drawPresets();
        });
        use.addEventListener('click', () => { bcTa.value = msg; syncCount(); bcTa.focus(); });
        presetBox.append(el('span', { class: 'adm-preset' }, use, del));
      });
    }
    drawPresets();

    bcSave.addEventListener('click', () => {
      const msg = bcTa.value.trim();
      if (!msg) { SW.ui.toast('Type a message first, then save it as a preset', 'warn'); return; }
      const presets = getPresets();
      if (presets.indexOf(msg) !== -1) { SW.ui.toast('That preset already exists', 'warn'); return; }
      presets.unshift(msg);
      SW.prefs.set(BC_PRESET_KEY, presets.slice(0, BC_PRESET_CAP));
      drawPresets();
      SW.ui.toast('Preset saved', 'ok');
    });

    bcSend.addEventListener('click', async () => {
      const msg = bcTa.value.trim();
      if (!msg) return;
      bcSend.disabled = true;
      try {
        const res = await SW.api('/api/admin/broadcast', { method: 'POST', body: { message: msg } });
        rconResultToast('Broadcast sent', res);
        bcTa.value = '';
        syncCount();
      } catch (_e) { /* toasted by SW.api */ }
      bcSend.disabled = false;
    });
    bcTa.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); bcSend.click(); }
    });

    /* ------------------------------------------------- layer control
     * The app-wide layer picker (SW.ui.openLayerPicker, app.js) owns the
     * layer + faction choice and the next / now send; without it the card
     * keeps its own searchable list (mountLayerList). */
    const hasPicker = typeof SW.ui.openLayerPicker === 'function';
    const lc = card('Layers', { class: 'adm-layers' + (hasPicker ? ' is-compact' : '') });
    const curVal = el('div', { class: 'adm-readout-value truncate' });
    const nextVal = el('div', { class: 'adm-readout-value truncate' });
    const curFac = el('div', { class: 'adm-readout-sub truncate hidden' });
    const nextFac = el('div', { class: 'adm-readout-sub truncate hidden' });
    const curCell = readoutCell('Now playing', curVal, 'is-now');
    const nextCell = readoutCell('Up next', nextVal, 'is-next');
    curCell.append(curFac);
    nextCell.append(nextFac);
    lc.body.append(el('div', { class: 'adm-readout' }, curCell, nextCell));

    function currentLayerName() {
      const snap = SW.state.snapshot || {};
      const si = SW.state.serverInfo || snap.serverInfo || {};
      return snap.currentLayer || si.mapName || '';
    }
    function nextLayerName() {
      const snap = SW.state.snapshot || {};
      const si = SW.state.serverInfo || snap.serverInfo || {};
      return snap.nextLayer || si.nextLayer || '';
    }
    function syncLayerKv() {
      const c = currentLayerName();
      const n = nextLayerName();
      curVal.textContent = c || '—';
      curVal.title = c || '';
      nextVal.textContent = n || '—';
      nextVal.title = n || '';
    }

    function openLayerPicker() {
      const open = SW.ui.openLayerPicker;
      if (typeof open !== 'function') {
        /* no picker after all: the card grows its own list in place */
        if (!layerList) {
          if (pickRow) pickRow.remove();
          lc.el.classList.remove('is-compact');
          layerList = mountLayerList();
          layerList.load(false);
        }
        return;
      }
      try {
        const p = open.call(SW.ui);
        if (p && typeof p.catch === 'function') p.catch((e) => console.error('layer picker', e));
      } catch (e) {
        console.error('layer picker', e);
        SW.ui.toast('The layer picker failed to open — see the browser console', 'error');
      }
    }

    /* factions under NOW / NEXT from GET /api/factions (learned server-side
     * via ShowCurrentMap / ShowNextMap). Shown only when the answer names the
     * layer on screen; refetched when a layer changes, or after 30 s while
     * the server's poll still trails the live layer event. Layer names compare
     * without ListLayers' " (modid)" suffix. */
    const layerKey = (s) => String(s == null ? '' : s).replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase();
    const sameLayer = (a, b) => layerKey(a) !== '' && layerKey(a) === layerKey(b);
    let facKey = null;
    let facAt = 0;
    let facStale = false;
    /* -> true when the server answered for a different layer (stale) */
    function setFac(node, f, shown) {
      const named = f && f.layer ? String(f.layer) : '';
      const ok = !!(f && f.team1 && f.team2 && named && sameLayer(named, shown));
      const txt = ok ? String(f.team1) + ' vs ' + String(f.team2) : '';
      node.textContent = txt;
      node.title = txt;
      node.classList.toggle('hidden', !txt);
      return !!(named && shown && !sameLayer(named, shown));
    }
    async function syncFactions() {
      const cur = currentLayerName();
      const nxt = nextLayerName();
      const key = cur + '\u0001' + nxt;
      if (key === facKey && !(facStale && Date.now() - facAt > 30000)) return;
      facKey = key;
      facAt = Date.now();
      if (!cur && !nxt) {
        setFac(curFac, null, '');
        setFac(nextFac, null, '');
        facStale = false;
        return;
      }
      let r = null;
      try { r = await SW.api('/api/factions', { toast: false }); } catch (_e) { r = null; }
      if (facKey !== key) return;
      const a = setFac(curFac, r && r.current, cur);
      const b = setFac(nextFac, r && r.next, nxt);
      facStale = a || b;
    }

    let layerList = null; /* fallback list: {sync(), load(force)} */
    let pickRow = null;
    if (hasPicker) {
      const pickBtn = iconBtn('Choose layer…', 'layers', 'primary');
      pickBtn.addEventListener('click', openLayerPicker);
      pickRow = el('div', { class: 'adm-layer-pick' }, pickBtn,
        el('p', { class: 'adm-note', text: 'Pick a layer and its factions, then queue it next or switch now.' }));
      lc.body.append(pickRow);
    } else {
      layerList = mountLayerList();
    }

    /* the card's own searchable list — Set next / Change now per row */
    function mountLayerList() {
      const lRefresh = el('button', {
        type: 'button', class: 'btn ghost small icon-only',
        title: 'Refresh layer list', 'aria-label': 'Refresh layer list',
      });
      lRefresh.innerHTML = SW.icon('refresh');
      lc.actions.append(lRefresh);
      const lSearch = searchBox('Search layers…', 'Search layers');
      const lList = el('div', { class: 'adm-layer-list', role: 'list', 'aria-label': 'Layers' });
      lc.body.append(lSearch.wrap, lList);
      const lCount = el('span', { class: 'adm-note tabular' });
      lc.foot().append(lCount, el('span', { class: 'adm-grow' }),
        el('span', { class: 'adm-note adm-hide-narrow', text: 'Set next queues it · Change now switches immediately' }));

      let layers = [];
      let layersLoading = false;
      let drawnCur = null;
      let drawnNext = null;
      let drawnQuery = '';

      async function confirmSetNext(layer) {
        const v = await SW.ui.confirmModal({
          title: 'Set next layer',
          body: 'Set "' + layer + '" as the next layer? It loads when the current match ends.',
          confirmText: 'Set next',
        });
        if (!v) return;
        try { await SW.actions.setNextLayer(layer); } catch (_e) { /* toasted */ }
      }

      /* one delegated listener; rows carry an index into shownLayers */
      let shownLayers = [];
      lList.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]');
        if (!b || !lList.contains(b)) return;
        const L = shownLayers[Number(b.dataset.i)];
        if (L == null) return;
        if (b.dataset.act === 'next') confirmSetNext(L);
        else SW.actions.changeLayerNow(L); /* danger confirm inside */
      });

      function drawLayers() {
        const q = lSearch.input.value.trim().toLowerCase();
        const keepScroll = q === drawnQuery ? lList.scrollTop : 0;
        const cur = currentLayerName();
        const next = nextLayerName();
        drawnCur = cur;
        drawnNext = next;
        drawnQuery = q;
        lList.textContent = '';
        shownLayers = [];
        if (layersLoading) {
          lCount.textContent = '';
          lList.append(el('div', { class: 'adm-list-msg' }, el('span', { class: 'spinner', role: 'status', 'aria-label': 'Loading layers' })));
          return;
        }
        const rows = q ? layers.filter((L) => L.toLowerCase().indexOf(q) !== -1) : layers;
        lCount.textContent = !layers.length ? '' : (q ? rows.length + ' of ' + layers.length + ' layers' : layers.length + ' layers');
        if (!layers.length) {
          lList.append(emptyState('map', 'No layer list yet', 'Is RCON connected? Refresh once it is.', null, true));
          return;
        }
        if (!rows.length) {
          lList.append(emptyState('search', 'No layers match', 'Try part of a map or game-mode name.', null, true));
          return;
        }
        shownLayers = rows;
        const frag = document.createDocumentFragment();
        rows.forEach((L, i) => {
          const item = el('div', {
            class: 'adm-layer-row' + (L === cur ? ' is-current' : '') + (L === next ? ' is-next' : ''),
            role: 'listitem',
          });
          item.append(el('span', { class: 'adm-layer-name truncate', title: L, text: L }));
          if (L === cur) item.append(SW.ui.badge('now', 'warn'));
          if (L === next) item.append(SW.ui.badge('next', 'accent'));
          const bNext = iconBtn('Set next', 'chevron-right', 'ghost small', true);
          bNext.dataset.act = 'next';
          bNext.dataset.i = String(i);
          const bNow = iconBtn('Change now', 'play', 'danger ghost small', true);
          bNow.dataset.act = 'now';
          bNow.dataset.i = String(i);
          item.append(el('span', { class: 'adm-layer-acts' }, bNext, bNow));
          frag.append(item);
        });
        lList.append(frag);
        lList.scrollTop = keepScroll;
      }

      async function loadLayers(force) {
        if (force) SW.state.layers = null;
        layersLoading = true;
        drawLayers();
        try { layers = await SW.actions.fetchLayers(); }
        catch (_e) { layers = []; }
        if (!Array.isArray(layers)) layers = [];
        layersLoading = false;
        drawLayers();
      }
      lSearch.input.addEventListener('input', debounce(drawLayers, 150));
      lRefresh.addEventListener('click', () => loadLayers(true));

      return {
        sync() { if (currentLayerName() !== drawnCur || nextLayerName() !== drawnNext) drawLayers(); },
        load: loadLayers,
      };
    }

    /* ------------------------------------------------- match control */
    const mc = card('Match', { class: 'adm-match' });
    const mLayer = el('div', { class: 'adm-readout-value truncate' });
    const mStarted = el('div', { class: 'adm-readout-value' });
    const mPlayers = el('div', { class: 'adm-readout-value tabular' });
    mc.body.append(
      el('div', { class: 'adm-readout' },
        readoutCell('Layer', mLayer, 'is-wide is-now'),
        readoutCell('Started', mStarted),
        readoutCell('Players', mPlayers)),
      el('p', { class: 'adm-note', text: 'Both actions ask twice — they hit every player on the server.' }));
    const bRestart = iconBtn('Restart match', 'refresh', 'danger ghost');
    const bEnd = iconBtn('End match', 'flag', 'danger ghost');
    mc.foot().append(el('div', { class: 'adm-btn-pair' }, bRestart, bEnd));

    function syncMatchInfo() {
      const snap = SW.state.snapshot || {};
      const m = snap.match;
      const started = m && g(m, 'startedAt', 'started_at');
      const layer = (m && m.layer) || currentLayerName();
      mLayer.textContent = layer || '—';
      mLayer.title = layer || '';
      mStarted.textContent = '';
      if (started) mStarted.append(SW.ui.timeAgo(started));
      else mStarted.append(el('span', { class: 'adm-muted', text: 'No live data' }));
      const si = SW.state.serverInfo || snap.serverInfo || {};
      mPlayers.textContent = si.playerCount != null
        ? si.playerCount + (si.maxPlayers != null ? ' / ' + si.maxPlayers : '')
        : '—';
    }

    async function matchOp(op) {
      const verb = op === 'restart' ? 'Restart' : 'End';
      const ok = await doubleConfirm({
        title: verb + ' the current match?',
        body: op === 'restart'
          ? 'AdminRestartMatch reloads the current layer from the start for everyone.'
          : 'AdminEndMatch ends the round immediately and moves on to the next layer.',
        danger: true,
        confirmText: verb + ' match',
      }, {
        title: 'Really ' + op + ' the match?',
        body: 'Second confirmation — this cannot be undone.',
        danger: true,
        confirmText: 'Yes, ' + op + ' it',
      });
      if (!ok) return;
      try {
        const res = await SW.api('/api/admin/match', { method: 'POST', body: { op } });
        rconResultToast(verb + ' match sent', res);
      } catch (_e) { /* toasted */ }
    }
    bRestart.addEventListener('click', () => matchOp('restart'));
    bEnd.addEventListener('click', () => matchOp('end'));

    /* --------------------------------------------------- squad tools */
    const sq = card('Squads', { class: 'adm-squads' });
    const teamSel = el('select', { class: 'input', 'aria-label': 'Team' });
    const squadSel = el('select', { class: 'input', 'aria-label': 'Squad' });
    const bDisband = iconBtn('Disband squad', 'x', 'danger ghost small');
    const cmdPicker = playerPicker('Commander to demote');
    const bDemote = iconBtn('Demote', 'chevron-down', 'ghost small');
    sq.body.append(
      formGrid(field('Team', teamSel, null, 'adm-w-3 adm-pair'), field('Squad', squadSel, null, 'adm-w-3 adm-pair')),
      el('div', { class: 'adm-right' }, bDisband),
      el('div', { class: 'adm-divider', role: 'separator' }),
      field('Demote commander', el('div', { class: 'adm-inline' }, cmdPicker.el, bDemote)));

    function teamsOf() { return (SW.state.snapshot && SW.state.snapshot.teams) || []; }
    let teamSig = null;
    let squadSig = null;
    function rebuildTeamSel() {
      const teams = teamsOf();
      const sig = teams.map((t) => t.teamId + '\u0001' + (t.name || '')).join('\u0002');
      if (sig !== teamSig) {
        teamSig = sig;
        const prev = teamSel.value;
        teamSel.textContent = '';
        if (!teams.length) {
          teamSel.append(el('option', { value: '', text: 'No live roster yet' }));
        } else {
          for (const t of teams) {
            const o = el('option', { value: String(t.teamId) });
            o.textContent = 'Team ' + t.teamId + ' — ' + (t.name || '');
            teamSel.append(o);
          }
          if (prev && Array.prototype.some.call(teamSel.options, (o) => o.value === prev)) teamSel.value = prev;
        }
      }
      rebuildSquadSel();
    }
    function rebuildSquadSel() {
      const team = teamsOf().find((t) => String(t.teamId) === teamSel.value);
      const squads = (team && team.squads) || [];
      const sig = teamSel.value + '\u0003' + squads.map((s) => s.squadId + '\u0001' + (s.name || '') + '\u0001' + (s.players ? s.players.length : (s.size || 0))).join('\u0002');
      if (sig === squadSig) return;
      squadSig = sig;
      const prev = squadSel.value;
      squadSel.textContent = '';
      if (!squads.length) {
        squadSel.append(el('option', { value: '', text: 'No squads on this team' }));
        return;
      }
      for (const s of squads) {
        const o = el('option', { value: String(s.squadId) });
        const size = s.players ? s.players.length : (s.size || 0);
        o.textContent = s.squadId + ' — ' + (s.name || 'Squad') + ' (' + size + ')';
        squadSel.append(o);
      }
      if (prev && Array.prototype.some.call(squadSel.options, (o) => o.value === prev)) squadSel.value = prev;
    }
    teamSel.addEventListener('change', rebuildSquadSel);

    bDisband.addEventListener('click', async () => {
      const teamId = Number(teamSel.value);
      const squadId = Number(squadSel.value);
      if (!teamId || !squadSel.value) { SW.ui.toast('Pick a team and a squad first', 'warn'); return; }
      const squadLabel = squadSel.options[squadSel.selectedIndex] ? squadSel.options[squadSel.selectedIndex].textContent : squadId;
      const v = await SW.ui.confirmModal({
        title: 'Disband squad',
        body: 'Disband squad ' + squadLabel + ' on team ' + teamId + '? Its members become unassigned.',
        danger: true,
        confirmText: 'Disband',
      });
      if (!v) return;
      try {
        const res = await SW.api('/api/admin/disbandSquad', { method: 'POST', body: { teamId, squadId } });
        rconResultToast('Disband squad ' + squadId + ' (team ' + teamId + ')', res);
      } catch (_e) { /* toasted */ }
    });

    bDemote.addEventListener('click', async () => {
      const ref = cmdPicker.current();
      if (!ref) { SW.ui.toast('Pick a player first', 'warn'); return; }
      const v = await SW.ui.confirmModal({
        title: 'Demote commander',
        body: 'Demote ' + (ref.name || 'this player') + ' from commander?',
        confirmText: 'Demote',
      });
      if (!v) return;
      try {
        const res = await SW.api('/api/admin/demoteCommander', { method: 'POST', body: targetBody(ref) });
        rconResultToast('Demoted ' + (ref.name || 'player'), res);
      } catch (_e) { /* toasted */ }
    });

    /* -------------------------------------------- player quick actions */
    const qc = card('Player actions', { class: 'adm-quick' });
    const qaPicker = playerPicker('Player for quick actions');
    const qaGrid = el('div', { class: 'adm-action-grid' });
    function qa(label, icon, fn, danger) {
      const b = iconBtn(label, icon, (danger ? 'danger ghost' : 'ghost') + ' small');
      b.addEventListener('click', () => {
        const ref = qaPicker.current();
        if (!ref) { SW.ui.toast('Pick a player first', 'warn'); return; }
        fn(ref); /* SW.actions.* confirm + POST + rcon toast */
      });
      return b;
    }
    const qaButtons = [];
    if (SW.can('warn')) qaButtons.push(qa('Warn', 'warn', (r) => SW.actions.warn(r)));
    if (SW.can('kick')) qaButtons.push(qa('Kick', 'kick', (r) => SW.actions.kick(r)));
    if (SW.can('ban')) qaButtons.push(qa('Ban', 'ban', (r) => SW.actions.ban(r), true));
    if (SW.can('team')) qaButtons.push(qa('Force team', 'swap', (r) => SW.actions.forceTeam(r)));
    if (canSquad) qaButtons.push(qa('Unsquad', 'x', (r) => SW.actions.removeFromSquad(r)));
    qaGrid.append(...qaButtons);
    qc.body.append(
      el('div', { class: 'adm-quick-main' }, field('Online player', qaPicker.el), qaGrid),
      el('p', { class: 'adm-note', text: 'Offline players: open their profile from the Players page for the same actions.' }));

    /* ----------------------------------------------- balanced layout
     * Row A: broadcast | match (7:5). Row B: layers + quick commands |
     * squads + player actions (7:5), each side a stack whose cards flex so
     * both sides end together. Missing cards (perms) shrink a stack; a stack
     * alone in its row lays its two cards side by side. */
    const rowA = [canBroadcast ? bc.el : null, canMatch ? mc.el : null].filter(Boolean);
    const leftCards = [canLayer ? lc.el : null, qk ? qk.el : null].filter(Boolean);
    const rightCards = [canSquad ? sq.el : null, qaButtons.length ? qc.el : null].filter(Boolean);
    const rowB = [];
    if (leftCards.length) {
      rowB.push(el('div', { class: 'adm-stack' + (!rightCards.length && leftCards.length === 2 ? ' is-wide' : '') }, leftCards));
    }
    if (rightCards.length) {
      rowB.push(el('div', { class: 'adm-stack' + (!leftCards.length && rightCards.length === 2 ? ' is-wide' : '') }, rightCards));
    }
    if (!rowA.length && !rowB.length) {
      view.append(el('div', { class: 'adm-col' }, emptyCard('lock', 'No admin tools for your role',
        'Broadcast, layer, match, squad, player-action or quick-command permissions unlock them.')));
      return;
    }
    const tools = el('div', { class: 'adm-tools' });
    if (rowA.length) tools.append(el('div', { class: 'adm-tools-row' + (rowA.length === 1 ? ' is-single' : '') }, rowA));
    if (rowB.length) tools.append(el('div', { class: 'adm-tools-row is-b' + (rowB.length === 1 ? ' is-single' : '') }, rowB));
    view.append(tools);

    /* ------------------------------------------------ live wiring */
    const syncAll = () => {
      if (canLayer) {
        syncLayerKv();
        if (layerList) layerList.sync();
        syncFactions();
      }
      if (canMatch) syncMatchInfo();
      if (canSquad) { rebuildTeamSel(); cmdPicker.rebuild(); }
      if (qaButtons.length) qaPicker.rebuild();
    };
    const syncLive = debounce(syncAll, 400);
    unsubs.push(SW.live.on('players', syncLive));
    unsubs.push(SW.live.on('serverinfo', syncLive));
    unsubs.push(SW.live.on('match', syncLive));
    unsubs.push(SW.live.on('connect', syncLive));
    unsubs.push(SW.live.on('disconnect', syncLive));

    if (canLayer) {
      syncLayerKv();
      syncFactions();
      if (layerList) layerList.load(false);
    }
    if (canMatch) syncMatchInfo();
    if (canSquad) rebuildTeamSel();
    if (qk) qk.load();
    if (!SW.state.snapshot) SW.refreshOverview().then(syncAll);
  }

  /* ===================================== RAW COMMAND view (route #/console) */

  /* §4.3 admin command catalog + the §2 toggles (placeholders stripped on
   * insert). Layer commands take optional factions: <Faction+Type> each. */
  const CMD_CATALOG = [
    'ListPlayers',
    'ListSquads',
    'ShowServerInfo',
    'ShowCurrentMap',
    'ShowNextMap',
    'ListLayers',
    'ListCommands 1',
    'AdminBroadcast <msg>',
    'AdminChangeLayer <layer> <faction1> <faction2>',
    'AdminSetNextLayer <layer> <faction1> <faction2>',
    'AdminRestartMatch',
    'AdminEndMatch',
    'AdminSlomo <float>',
    'AdminKick "<selector>" <reason>',
    'AdminKickById <playerId> <reason>',
    'AdminBan "<selector>" <interval> <reason>',
    'AdminWarn "<selector>" <message>',
    'AdminWarnById <playerId> <message>',
    'AdminForceTeamChange "<selector>"',
    'AdminForceTeamChangeById <playerId>',
    'AdminRemovePlayerFromSquad "<name>"',
    'AdminRemovePlayerFromSquadById <playerId>',
    'AdminDisbandSquad <teamId> <squadId>',
    'AdminDemoteCommander "<selector>"',
  ].concat(QC_COMMON.map((t) => t.command + ' <0|1>'));
  const HIST_KEY = 'console-history';
  const HIST_CAP = 100;
  const OUT_CAP = 400;
  const RECENT_SHOWN = 8;

  function renderConsole(main) {
    const docKey = (e) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        clearOut();
      }
    };
    document.addEventListener('keydown', docKey);
    let unsubStatus = null;
    let qk = null;
    let qkResize = null;
    this.cleanup = () => {
      document.removeEventListener('keydown', docKey);
      if (unsubStatus) unsubStatus();
      if (qk) qk.dispose();
      if (qkResize) qkResize.disconnect();
    };

    const view = el('div', { class: 'view view-console adm fade-in' });
    main.append(view);
    const clearBtn = iconBtn('Clear output', 'x', 'ghost small');
    clearBtn.title = 'Clear output (Ctrl+L)';
    view.append(pageHead('Raw command',
      'Send any RCON command straight to the game server — every command lands in the audit log.',
      [clearBtn]).el);

    /* one-press presets (§2) above the terminal; each run is echoed into the
     * output too. The terminal gives up the panel's height (--adm-qc-h, a
     * number) so its input line stays on screen. */
    if (SW.can('quickcmd')) {
      qk = quickPanel({
        class: 'adm-qc--raw',
        onResult(row, value, res) {
          const sent = res && res.command ? String(res.command) : row.command + (row.toggle ? ' ' + value : '');
          const resp = res && (res.rconResponse != null ? res.rconResponse : res.response);
          push('c-cmd', sent, true);
          push('c-resp', resp == null || resp === '' ? '(empty response)' : String(resp));
        },
      });
      view.append(qk.el);
      if (typeof ResizeObserver === 'function') {
        qkResize = new ResizeObserver(() => {
          view.style.setProperty('--adm-qc-h', Math.round(qk.el.getBoundingClientRect().height + 24) + 'px');
        });
        qkResize.observe(qk.el);
      }
      qk.load();
    }

    const wrap = el('div', { class: 'adm-console' });
    view.append(wrap);

    /* terminal panel — a dark surface in both themes (console-* tokens) */
    const term = el('section', { class: 'adm-term', 'aria-label': 'RCON terminal' });
    const stateBox = el('span', { class: 'adm-term-state', role: 'status' });
    term.append(el('div', { class: 'adm-term-head' },
      el('span', { class: 'adm-term-title', text: 'RCON session' }),
      stateBox,
      el('span', { class: 'adm-term-keys' },
        keyHint('↑ ↓', 'history'), keyHint('Tab', 'complete'), keyHint('Ctrl L', 'clear'))));
    const out = el('div', { class: 'adm-term-out', role: 'log', 'aria-label': 'Command output', tabindex: '0' });
    const inRow = el('div', { class: 'adm-term-in' });
    const ac = el('div', { class: 'adm-term-ac hidden', role: 'listbox', 'aria-label': 'Command suggestions' });
    const prompt = el('span', { class: 'adm-term-prompt', 'aria-hidden': 'true', text: 'rcon›' });
    const input = el('input', {
      class: 'adm-term-input', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'RCON command — Tab completes, ↑/↓ history',
      'aria-label': 'RCON command',
    });
    inRow.append(ac, prompt, input);
    term.append(out, inRow);
    wrap.append(term);

    /* read-only info commands + recent history rail */
    const rail = card('Info commands', { class: 'adm-rail', tag: 'aside' });
    const infoList = el('div', { class: 'adm-rail-list adm-rail-info' });
    function infoBtn(cmd, icon) {
      const b = iconBtn(cmd, icon, 'ghost small adm-rail-btn');
      b.title = 'Run ' + cmd;
      b.addEventListener('click', () => run(cmd));
      infoList.append(b);
      return b;
    }
    const infoBtns = [
      infoBtn('ListPlayers', 'users'),
      infoBtn('ShowServerInfo', 'dashboard'),
      infoBtn('ListSquads', 'shield'),
      infoBtn('ShowCurrentMap', 'map'),
      infoBtn('ShowNextMap', 'layers'),
    ];
    const recentList = el('div', { class: 'adm-rail-list adm-recent' });
    rail.body.append(infoList, el('div', { class: 'adm-recent-wrap' },
      el('div', { class: 'adm-subhead', text: 'Recent' }), recentList));
    wrap.append(rail.el);

    /* ---- connection / busy state in the terminal head ---- */
    let busy = false;
    const st0 = SW.state.status && SW.state.status.rcon;
    let rconUp = st0 ? !!st0.connected : null; /* null = not known yet */
    function paintState() {
      stateBox.textContent = '';
      if (busy) stateBox.append(dot('busy'), el('span', { text: 'Running…' }));
      else if (rconUp === true) stateBox.append(dot('ok'), el('span', { text: 'Connected' }));
      else if (rconUp === false) stateBox.append(dot('bad'), el('span', { text: 'RCON down' }));
      else stateBox.append(dot('idle'), el('span', { text: 'Ready' }));
    }
    unsubStatus = SW.live.on('status', (s) => {
      if (s && s.rcon) { rconUp = !!s.rcon.connected; paintState(); }
    });

    /* ---- output (textContent-only per §19.3.25) ---- */
    function line(kind, text, ts) {
      const d = el('div', { class: 'adm-term-line' + (kind ? ' ' + kind : '') });
      d.append(el('span', { class: 'adm-term-time', text: fmtHMS(ts) }));
      const body = el('span', { class: 'adm-term-text' });
      body.textContent = text == null ? '' : String(text);
      d.append(body);
      return d;
    }
    function nearBottom() {
      return out.scrollHeight - out.scrollTop - out.clientHeight < 60;
    }
    function push(kind, text, force) {
      const stick = force || nearBottom();
      out.append(line(kind, text, Date.now()));
      while (out.children.length > OUT_CAP) out.firstChild.remove();
      if (stick) out.scrollTop = out.scrollHeight;
    }
    function clearOut() {
      out.textContent = '';
      push('c-sys', 'Output cleared.', true);
    }
    clearBtn.addEventListener('click', clearOut);
    push('c-sys', 'A3 Admin raw command line — commands go straight to the game server and are audit-logged.', true);

    /* ---- history (localStorage, cap 100) ---- */
    let hist = SW.prefs.get(HIST_KEY, []);
    if (!Array.isArray(hist)) hist = [];
    hist = hist.filter((h) => typeof h === 'string').slice(-HIST_CAP);
    let histPos = hist.length; /* hist.length == not navigating */
    let draft = '';
    function drawRecent() {
      recentList.textContent = '';
      const seen = new Set();
      const items = [];
      for (let i = hist.length - 1; i >= 0 && items.length < RECENT_SHOWN; i--) {
        if (!seen.has(hist[i])) { seen.add(hist[i]); items.push(hist[i]); }
      }
      if (!items.length) {
        recentList.append(el('p', { class: 'adm-note', text: 'Commands you run show up here.' }));
        return;
      }
      for (const cmd of items) {
        const b = el('button', { type: 'button', class: 'adm-recent-item truncate', title: cmd, text: cmd });
        /* inserts, never runs — recent commands may be destructive */
        b.addEventListener('click', () => {
          input.value = cmd;
          histPos = hist.length;
          closeAc();
          input.focus();
        });
        recentList.append(b);
      }
    }
    function pushHistory(cmd) {
      if (hist[hist.length - 1] !== cmd) hist.push(cmd);
      if (hist.length > HIST_CAP) hist = hist.slice(-HIST_CAP);
      SW.prefs.set(HIST_KEY, hist);
      histPos = hist.length;
      draft = '';
      drawRecent();
    }
    function histUp() {
      if (!hist.length || histPos <= 0) return;
      if (histPos === hist.length) draft = input.value;
      histPos--;
      input.value = hist[histPos];
      setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
    }
    function histDown() {
      if (histPos >= hist.length) return;
      histPos++;
      input.value = histPos === hist.length ? draft : hist[histPos];
    }

    /* ---- autocomplete over the §4.3 catalog ---- */
    let acItems = [];
    let acSel = -1;
    function insertText(entry) {
      let cut = entry.length;
      const lt = entry.indexOf('<');
      const qt = entry.indexOf('"');
      if (lt !== -1) cut = Math.min(cut, lt);
      if (qt !== -1) cut = Math.min(cut, qt);
      let t = entry.slice(0, cut);
      if (cut < entry.length && !/\s$/.test(t)) t += ' ';
      return t;
    }
    function closeAc() {
      ac.classList.add('hidden');
      ac.textContent = '';
      acItems = [];
      acSel = -1;
    }
    function markAcSel() {
      Array.prototype.forEach.call(ac.children, (n, i) => {
        n.classList.toggle('sel', i === acSel);
        n.setAttribute('aria-selected', String(i === acSel));
      });
    }
    function openAc() {
      const typed = input.value;
      if (!typed.trim() || /\s/.test(typed.trim())) { closeAc(); return; }
      const q = typed.trim().toLowerCase();
      const matches = CMD_CATALOG.filter((c) => c.toLowerCase().indexOf(q) === 0);
      if (!matches.length || (matches.length === 1 && matches[0].toLowerCase() === q)) { closeAc(); return; }
      ac.textContent = '';
      acItems = matches.slice(0, 10);
      acSel = -1;
      for (let i = 0; i < acItems.length; i++) {
        const item = el('div', { class: 'adm-term-ac-item', role: 'option', 'aria-selected': 'false' });
        item.textContent = acItems[i];
        /* mousedown fires before the input loses focus */
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = insertText(acItems[i]);
          closeAc();
          input.focus();
        });
        ac.append(item);
      }
      ac.classList.remove('hidden');
    }
    input.addEventListener('input', () => { histPos = hist.length; openAc(); });
    input.addEventListener('blur', () => setTimeout(closeAc, 120));

    /* ---- exec ---- */
    function setBusy(b) {
      busy = b;
      infoBtns.forEach((btn) => { btn.disabled = b; });
      prompt.textContent = b ? '…' : 'rcon›';
      term.classList.toggle('is-busy', b);
      paintState();
    }
    async function run(cmd) {
      cmd = String(cmd == null ? '' : cmd).trim();
      if (!cmd || busy) return;
      pushHistory(cmd);
      push('c-cmd', cmd, true);
      setBusy(true);
      try {
        const r = await SW.api('/api/admin/raw', { method: 'POST', body: { command: cmd }, toast: false });
        const resp = r && (r.response != null ? r.response : r.rconResponse);
        push('c-resp', resp == null || resp === '' ? '(empty response)' : String(resp));
      } catch (e) {
        push('c-err', 'error: ' + ((e && e.message) || 'command failed'));
      }
      setBusy(false);
    }

    input.addEventListener('keydown', (e) => {
      const acOpen = !ac.classList.contains('hidden') && acItems.length > 0;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (acOpen) { acSel = (acSel + 1) % acItems.length; markAcSel(); }
        else histDown();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (acOpen) { acSel = acSel <= 0 ? acItems.length - 1 : acSel - 1; markAcSel(); }
        else histUp();
      } else if (e.key === 'Tab') {
        if (acOpen) {
          e.preventDefault();
          input.value = insertText(acItems[acSel >= 0 ? acSel : 0]);
          closeAc();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (acOpen && acSel >= 0) {
          input.value = insertText(acItems[acSel]);
          closeAc();
          return;
        }
        closeAc();
        if (busy) return; /* keep the text until the in-flight command returns */
        const cmd = input.value;
        input.value = '';
        run(cmd);
      } else if (e.key === 'Escape') {
        if (acOpen) { e.preventDefault(); closeAc(); }
      }
    });

    paintState();
    drawRecent();
    setTimeout(() => input.focus(), 30);
  }

  /* ============================================================= BANS view */

  const BAN_INTERVAL_RE = /^(0|[1-9]\d{0,2}[mhdwMy])$/;
  const STEAMID_RE = /^7656\d{13}$/;

  function banIsPerm(r) {
    const raw = g(r, 'intervalRaw', 'interval_raw');
    if (raw != null && raw !== '') return String(raw) === '0';
    return !g(r, 'expiresAt', 'expires_at');
  }

  /* active, not lifted and not run out (also while the page stays open) */
  function banLive(r) {
    if (num(g(r, 'active')) !== 1 || g(r, 'unbannedAt', 'unbanned_at') || g(r, 'expired') === true) return false;
    const ex = num(g(r, 'expiresAt', 'expires_at'));
    return banIsPerm(r) || ex > Date.now();
  }

  /* 'battlemetrics' rows are mirrored by the §3 import; every other row was
   * issued in A3 Admin */
  function banSource(r) {
    return String(g(r, 'source') || '').toLowerCase() === 'battlemetrics' ? 'battlemetrics' : 'local';
  }

  function issuerOf(r) {
    const v = g(r, 'issuerName', 'issuer', 'issuedByName', 'issued_by_name', 'byUsername', 'by_username', 'issuedByUsername', 'username');
    if (v != null && v !== '') return String(v);
    const id = g(r, 'issuedBy', 'issued_by');
    if (id == null) return banSource(r) === 'battlemetrics' ? 'BattleMetrics' : 'system';
    return 'user #' + id;
  }

  function sourceBadge(r) {
    if (banSource(r) !== 'battlemetrics') return SW.ui.badge('Local', 'dim', 'Issued in A3 Admin');
    const ext = g(r, 'externalId', 'external_id');
    return SW.ui.badge('BattleMetrics', 'accent', 'Mirrored from BattleMetrics' + (ext ? ' — ban ' + ext : ''));
  }

  /* import result (Bans page shortcut) */
  function bmResultModal(res) {
    const body = el('div', { class: 'adm-modal-stack' });
    body.append(el('p', {
      class: 'modal-text',
      text: 'The BattleMetrics ban list is mirrored in A3 Admin, and a banned player is kicked as soon as they join.',
    }), bmResultView(res));
    const actions = el('div', { class: 'modal-actions' });
    let toSettings = null;
    if (SW.can('settings')) {
      toSettings = el('a', { class: 'btn ghost', href: '#/settings?focus=battlemetrics', text: 'Import settings' });
      actions.append(toSettings);
    }
    const okBtn = el('button', { type: 'button', class: 'btn primary', text: 'Done' });
    actions.append(okBtn);
    body.append(actions);
    const m = SW.ui.modal({ title: 'BattleMetrics import finished', body });
    okBtn.addEventListener('click', () => m.close());
    if (toSettings) toSettings.addEventListener('click', () => m.close());
  }

  function renderBans(main) {
    /* uploads / deletions anywhere (also a closed dialog's) keep the
     * evidence counts on screen true */
    this.cleanup = trackEvidence('ban',
      (id) => rows.find((x) => String(g(x, 'id', 'banId')) === String(id)) || null,
      (r, n) => setEvidenceCount(r, n, false));
    /* the list is readable with plain view; every write (ban, unban, the
     * Bans.cfg export, notes, attaching evidence) needs the ban perm —
     * exactly what the API enforces. The BattleMetrics import takes settings
     * OR ban (§3); opening evidence takes ban, kick, warn or audit (BATCH3
     * §1). Rows carry the private `note` only for ban holders. */
    const canBan = SW.can('ban');
    const canImport = SW.canAny(['settings', 'ban']);
    const canEvidence = SW.canAny(['ban', 'kick', 'warn', 'audit']);
    const view = el('div', { class: 'view view-bans adm fade-in' });
    main.append(view);

    let importBtn = null;
    if (canImport) {
      importBtn = iconBtn('Import from BattleMetrics', 'refresh', 'ghost small');
      importBtn.title = 'Pull the saved BattleMetrics ban list into A3 Admin';
      importBtn.addEventListener('click', () => importFromBm());
    }
    let exportA = null;
    if (canBan) {
      exportA = el('a', { class: 'btn ghost small', href: '/api/export/bans.cfg', download: 'Bans.cfg' });
      exportA.innerHTML = SW.icon('download') + '<span>Export Bans.cfg</span>';
    }
    view.append(pageHead('Bans',
      canBan
        ? 'Bans issued in A3 Admin or imported from BattleMetrics. Squad has no RCON unban — export a fresh Bans.cfg after lifting one.'
        : 'Bans issued in A3 Admin or imported from BattleMetrics, and when they run out.',
      [importBtn, exportA]).el);

    const layout = el('div', { class: 'adm-bans' + (canBan ? '' : ' is-single') });
    view.append(layout);

    /* ------------------------------------------------ list card */
    let tab = 'active'; /* 'active' | 'expired' */
    let bmOnly = false;
    const seg = segmented(
      [{ value: 'active', label: 'Active' }, { value: 'expired', label: 'Expired' }],
      tab, (v) => { tab = v; load(); }, { label: 'Ban state', tabs: true });
    const bmChip = el('button', {
      type: 'button', class: 'chip adm-bm-chip', 'aria-pressed': 'false',
      title: 'Show only bans mirrored from BattleMetrics', text: 'Imported from BattleMetrics',
    });
    bmChip.addEventListener('click', () => {
      bmOnly = !bmOnly;
      bmChip.classList.toggle('on', bmOnly);
      bmChip.setAttribute('aria-pressed', String(bmOnly));
      draw();
    });
    const filter = searchBox('Filter by player, SteamID, EOS ID, reason' + (canBan ? ' or note' : ''), 'Filter bans');
    const count = el('span', { class: 'adm-count' });
    const list = tableCard({ tools: [seg.el, bmChip, filter.wrap, count] });
    layout.append(list.el);

    let importing = false;
    async function importFromBm() {
      if (importing) return;
      importing = true;
      const v = await SW.ui.confirmModal({
        title: 'Import bans from BattleMetrics',
        body: 'Pulls every ban on the saved BattleMetrics ban list into A3 Admin. Re-imports update in place, and bans lifted or expired on BattleMetrics stop being enforced here. Bans issued in A3 Admin are never touched.',
        confirmText: 'Import now',
      });
      if (!v) { importing = false; return; }
      if (importBtn) importBtn.disabled = true;
      const res = await bmImportCall(null);
      importing = false;
      if (importBtn) importBtn.disabled = false;
      if (!res) return;
      bmResultModal(res);
      load();
    }

    function playerCell(r) {
      const sid = g(r, 'steamId', 'steam_id');
      const eos = g(r, 'eosId', 'eos_id');
      const wrap = el('div', { class: 'adm-who' });
      wrap.append(nameLink({
        dbId: g(r, 'playerId', 'player_id'),
        name: g(r, 'playerName', 'player_name', 'name') || 'unknown',
        steamId: sid,
        eosId: eos,
      }));
      if (sid) wrap.append(el('span', { class: 'adm-sub mono', text: String(sid) }));
      if (eos) wrap.append(el('span', { class: 'adm-sub mono adm-eos truncate', title: 'EOS ' + eos, text: 'EOS ' + eos }));
      return wrap;
    }

    function expiryCell(r) {
      const unbanned = g(r, 'unbannedAt', 'unbanned_at');
      if (unbanned) {
        return el('div', { class: 'adm-who' },
          el('span', {}, SW.ui.badge('unbanned', 'dim')),
          el('span', { class: 'adm-sub', title: SW.ui.fmtTime(unbanned), text: fmtDate(unbanned) }));
      }
      /* a permanent ban can still be inactive: deactivated by an import */
      if (banIsPerm(r)) return num(g(r, 'active')) === 1 ? SW.ui.badge('permanent', 'red') : SW.ui.badge('lifted', 'dim');
      const ex = num(g(r, 'expiresAt', 'expires_at'));
      if (!ex) return null;
      if (ex > Date.now() && num(g(r, 'active')) === 1) {
        return el('span', { class: 'adm-countdown', title: SW.ui.fmtTime(ex), text: 'in ' + SW.ui.fmtDur((ex - Date.now()) / 1000) });
      }
      return el('span', { class: 'adm-muted', title: SW.ui.fmtTime(ex), text: fmtDate(ex) });
    }

    function unbanCell(r) {
      if (num(g(r, 'active')) !== 1) return SW.ui.badge('inactive', 'dim');
      const b = el('button', { type: 'button', class: 'btn ghost small', text: 'Unban' });
      b.addEventListener('click', async () => {
        const name = g(r, 'playerName', 'player_name', 'name') || 'this player';
        /* an import re-activates a mirrored ban while it is still active on
         * BattleMetrics — say so before lifting one here */
        const v = await SW.ui.confirmModal({
          title: 'Unban ' + name,
          body: banSource(r) === 'battlemetrics'
            ? 'This ban is mirrored from BattleMetrics. Lifting it here stops A3 Admin enforcing it, but the next import turns it back on while it is still active on BattleMetrics — lift it there to make it stick.'
            : 'Mark this ban inactive in A3 Admin? Squad has no RCON unban command — if the ban also lives in the server\'s Bans.cfg you must update that file too (guidance shown after).',
          confirmText: 'Unban',
        });
        if (!v) return;
        b.disabled = true;
        try {
          const res = await SW.api('/api/bans/' + encodeURIComponent(g(r, 'id', 'banId')) + '/unban', { method: 'POST', body: {} });
          const noteText = (res && res.note) ? String(res.note) : 'Ban marked inactive.';
          const body = el('div', { class: 'adm-modal-stack' });
          body.append(el('p', { class: 'modal-text', text: noteText })); /* API guidance — textContent only */
          const again = el('a', { class: 'btn ghost', href: '/api/export/bans.cfg', download: 'Bans.cfg' });
          again.innerHTML = SW.icon('download') + '<span>Export fresh Bans.cfg</span>';
          const okBtn = el('button', { type: 'button', class: 'btn primary', text: 'Got it' });
          body.append(el('div', { class: 'modal-actions' }, again, okBtn));
          const m = SW.ui.modal({ title: 'Ban lifted — one more step', body });
          okBtn.addEventListener('click', () => m.close());
          load();
        } catch (_e) { b.disabled = false; /* toasted by SW.api */ }
      });
      return b;
    }

    function banName(r) { return String(g(r, 'playerName', 'player_name', 'name') || 'unknown player'); }

    /* private staff note editor (POST /api/bans/:id/note, ban perm) */
    function editNote(r) {
      const form = el('form', { class: 'adm-modal-stack adm-note-form' });
      form.append(el('p', {
        class: 'modal-text',
        text: 'Only staff with the ban permission can read this note. It never reaches the player, the game server, Bans.cfg or the remote ban list.',
      }));
      const ta = el('textarea', {
        class: 'input adm-note-input', rows: '6', maxlength: '2000',
        placeholder: 'Context for other admins — alt accounts, links to clips, what happened before…',
        'aria-label': 'Private note',
      });
      ta.value = r.note == null ? '' : String(r.note);
      form.append(ta, el('div', { class: 'adm-subrow adm-note-meta' },
        el('span', { class: 'adm-note adm-grow', text: 'Save it empty to remove the note.' }),
        counterFor(ta, 2000)));
      const cancel = el('button', { type: 'button', class: 'btn ghost', text: 'Cancel' });
      const save = el('button', { type: 'submit', class: 'btn primary', text: 'Save note' });
      form.append(el('div', { class: 'modal-actions' }, cancel, save));
      const m = SW.ui.modal({ title: 'Private note — ' + banName(r), body: form });
      cancel.addEventListener('click', () => m.close());
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        /* the server strips the same control characters (tab and newlines stay) */
        const text = ta.value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
        save.disabled = true;
        try {
          const res = await SW.api('/api/bans/' + encodeURIComponent(g(r, 'id', 'banId')) + '/note', { method: 'POST', body: { note: text } });
          let saved = text;
          if (res && hasOwn(res, 'note')) saved = res.note;
          else if (res && res.ban && hasOwn(res.ban, 'note')) saved = res.ban.note;
          r.note = saved == null || saved === '' ? null : String(saved);
          m.close();
          SW.ui.toast(r.note ? 'Private note saved' : 'Private note removed', 'ok');
          draw();
        } catch (_e) { save.disabled = false; /* toasted by SW.api */ }
      });
      setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 40);
    }

    /* reason (what the player saw) + the private note under it. A
     * BattleMetrics ban mirrors its note from there (the server refuses an
     * edit here — the next import would overwrite it). */
    function reasonCell(r) {
      const box = el('div', { class: 'adm-reason-cell' },
        el('div', { class: 'adm-reason wrap-anywhere', text: r.reason == null || r.reason === '' ? '—' : String(r.reason) }));
      if (!hasOwn(r, 'note')) return box;
      const note = r.note == null ? '' : String(r.note);
      const mirrored = banSource(r) === 'battlemetrics';
      if (note) {
        const head = el('div', { class: 'adm-ban-note-head', title: mirrored ? 'From BattleMetrics — edit it there' : null });
        head.innerHTML = icon('lock');
        head.append(el('span', { class: 'adm-ban-note-k', text: mirrored ? 'BattleMetrics note' : 'Private note' }));
        if (canBan && !mirrored) {
          const ed = el('button', { type: 'button', class: 'adm-ban-note-edit', title: 'Edit the private note', 'aria-label': 'Edit the private note on ' + banName(r) });
          ed.innerHTML = icon('edit');
          ed.addEventListener('click', () => editNote(r));
          head.append(ed);
        }
        box.append(el('div', { class: 'adm-ban-note' }, head,
          el('div', { class: 'adm-ban-note-text wrap-anywhere', title: note.length > 160 ? note : null, text: note })));
      } else if (canBan && !mirrored) {
        const add = el('button', {
          type: 'button', class: 'adm-note-add reveal-on-hover',
          title: 'Only staff with the ban permission see notes', 'aria-label': 'Add a private note on ' + banName(r),
        });
        add.innerHTML = icon('plus');
        add.append(el('span', { text: 'Private note' }));
        add.addEventListener('click', () => editNote(r));
        box.append(add);
      }
      return box;
    }

    /* a new count for a row: controls that update themselves (live) only
     * need the row to remember it */
    function setEvidenceCount(r, n, live) {
      if (n === num(g(r, 'evidenceCount', 'evidence_count'))) return;
      r.evidenceCount = n;
      if (!live) draw();
    }

    function evidenceCell(r) {
      const reason = r.reason ? String(r.reason) : '';
      const at = g(r, 'issuedAt', 'issued_at');
      return evidenceControl({
        targetType: 'ban',
        targetId: g(r, 'id', 'banId'),
        count: g(r, 'evidenceCount', 'evidence_count'),
        canView: canEvidence,
        canUpload: canBan,
        what: 'this ban',
        title: 'Evidence — ' + banName(r),
        lead: 'Ban' + (reason ? ' for "' + clip(reason, 140) + '"' : '')
          + (at ? ' · issued ' + fmtDayTime(at) : '') + ' by ' + issuerOf(r) + '.',
        onCount: (n, live) => setEvidenceCount(r, n, live),
      });
    }

    const cols = [
      { key: 'player', label: 'Player', render: playerCell },
      { key: 'reason', label: 'Reason', render: reasonCell },
      {
        key: 'evidence', label: 'Evidence', class: 'adm-td-ev', sortable: true,
        sortVal: (row) => num(g(row, 'evidenceCount', 'evidence_count')),
        render: evidenceCell,
      },
      { key: 'source', label: 'Source', render: sourceBadge },
      { key: 'issuer', label: 'Issued by', render: (row) => truncSpan(issuerOf(row), 'adm-w-issuer') },
      {
        key: 'issued', label: 'Issued', sortable: true,
        sortVal: (row) => num(g(row, 'issuedAt', 'issued_at')),
        render: (row) => stampCell(g(row, 'issuedAt', 'issued_at')),
      },
      {
        key: 'expires', label: 'Expires', sortable: true,
        sortVal: (row) => (banIsPerm(row) ? Infinity : num(g(row, 'expiresAt', 'expires_at'))),
        render: expiryCell,
      },
      { key: 'rcon', label: 'In game', render: banGameBadge },
    ];
    if (canBan) cols.push({ key: 'unban', label: '', class: 'adm-td-actions', render: unbanCell });

    let rows = [];
    let tbl = null;
    let seq = 0;
    const emptyBox = el('div', { class: 'adm-table-empty' });

    function matchesFilter(r, q) {
      const hay = [
        g(r, 'playerName', 'player_name', 'name'), g(r, 'steamId', 'steam_id'), g(r, 'eosId', 'eos_id'),
        r.reason, r.note, issuerOf(r), banSource(r),
      ]
        .map((x) => (x == null ? '' : String(x).toLowerCase()))
        .join('\n');
      return hay.indexOf(q) !== -1;
    }
    function draw() {
      if (!tbl) return;
      const q = filter.input.value.trim().toLowerCase();
      const pool = bmOnly ? rows.filter((r) => banSource(r) === 'battlemetrics') : rows;
      const shown = q ? pool.filter((r) => matchesFilter(r, q)) : pool;
      count.textContent = q || bmOnly
        ? shown.length + ' of ' + rows.length
        : rows.length + (rows.length === 1 ? ' ban' : ' bans');
      emptyBox.textContent = '';
      if (!shown.length) {
        tbl.classList.add('hidden');
        if (!rows.length) {
          emptyBox.append(tab === 'active'
            ? emptyState('shield', 'No active bans', 'Nice and quiet.')
            : emptyState('clock', 'No expired or lifted bans', 'Bans land here once they run out or are lifted.'));
        } else if (!pool.length) {
          emptyBox.append(emptyState('shield',
            tab === 'active' ? 'No active BattleMetrics bans' : 'No expired BattleMetrics bans',
            canImport ? 'Pull them in with Import from BattleMetrics.' : 'An admin can import them from BattleMetrics.',
            canImport && tab === 'active' ? { label: 'Import from BattleMetrics', icon: 'refresh', onClick: () => importFromBm() } : null));
        } else {
          emptyBox.append(emptyState('search', 'No bans match this filter', 'Clear the filter to see all ' + pool.length + '.'));
        }
        return;
      }
      tbl.classList.remove('hidden');
      tbl.update(shown);
    }

    async function load() {
      const my = ++seq;
      list.body.textContent = '';
      list.body.append(skeletonRows(6));
      count.textContent = '';
      let r;
      try { r = await SW.api('/api/bans?active=' + (tab === 'active' ? '1' : '0')); }
      catch (_e) {
        if (my !== seq) return;
        list.body.textContent = '';
        list.body.append(emptyState('ban', 'Could not load bans', 'The server did not answer — try again in a moment.'));
        return;
      }
      if (my !== seq) return;
      rows = listOf(r);
      tbl = SW.ui.table(cols, rows, {
        sort: { key: 'issued', dir: 'desc' },
        class: 'adm-table adm-table--tall',
        emptyText: tab === 'active' ? 'No active bans — nice and quiet' : 'No expired or lifted bans',
      });
      list.body.textContent = '';
      list.body.append(tbl, emptyBox);
      draw();
    }
    filter.input.addEventListener('input', debounce(draw, 120));

    /* ------------------------------------------------- manual ban card */
    if (canBan) {
      const mb = card('Ban by SteamID', { class: 'adm-ban-form' });
      const sidInput = el('input', {
        class: 'input mono', type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false',
        placeholder: '76561198…', 'aria-label': 'SteamId64',
      });
      let interval = '1d';
      const customInput = el('input', {
        class: 'input mono hidden', type: 'text', autocomplete: 'off', spellcheck: 'false',
        placeholder: '0 = permanent, or 30m / 12h / 5d / 2w / 1M / 1y', 'aria-label': 'Custom ban interval',
      });
      const intervalRow = el('div', { class: 'adm-chips' });
      const INTERVALS = [
        { value: '1d', label: '1 day' },
        { value: '3d', label: '3 days' },
        { value: '7d', label: '7 days' },
        { value: '1M', label: '1 month' },
        { value: '0', label: 'Permanent' },
        { value: 'custom', label: 'Custom…' },
      ];
      const intervalChips = [];
      for (const it of INTERVALS) {
        const chip = el('button', { type: 'button', class: 'chip' + (it.value === interval ? ' on' : ''), text: it.label, 'aria-pressed': String(it.value === interval) });
        chip.addEventListener('click', () => {
          interval = it.value;
          intervalChips.forEach(([c, val]) => {
            c.classList.toggle('on', val === interval);
            c.setAttribute('aria-pressed', String(val === interval));
          });
          customInput.classList.toggle('hidden', interval !== 'custom');
          if (interval === 'custom') customInput.focus();
        });
        intervalChips.push([chip, it.value]);
        intervalRow.append(chip);
      }
      const reasonTa = el('textarea', { class: 'input', rows: '3', placeholder: 'Reason (shown to the player and stored)', 'aria-label': 'Ban reason' });
      const noteTa = el('textarea', {
        class: 'input', rows: '2', maxlength: '2000',
        placeholder: 'Only staff with the ban permission see it', 'aria-label': 'Private note',
      });
      const durField = field('Duration', intervalRow);
      durField.append(customInput);
      mb.body.append(
        field('SteamID64', sidInput, 'Works even if A3 Admin has never seen the player.'),
        durField,
        field('Reason', reasonTa),
        field('Private note (optional)', noteTa, 'Never sent to the game or the player.'));
      const mbBtn = iconBtn('Ban SteamID', 'ban', 'danger ghost');
      /* status tray: the confirm reminder, then "Banned … · Attach evidence" */
      const mbTray = el('span', { class: 'adm-note adm-grow adm-mb-tray', text: 'Asks to confirm before anything is sent.' });
      mb.foot().append(mbTray, mbBtn);
      layout.append(mb.el);

      function showBanned(steamId, ban) {
        mbTray.textContent = '';
        const okIcon = el('span', { class: 'adm-mb-ok', 'aria-hidden': 'true' });
        okIcon.innerHTML = icon('check');
        mbTray.append(okIcon, el('span', { class: 'truncate', title: 'Banned ' + steamId, text: 'Banned ' + steamId }));
        if (!ban || ban.id == null) return;
        const attach = el('button', { type: 'button', class: 'adm-link-btn' });
        attach.innerHTML = icon('paperclip');
        attach.append(el('span', { text: 'Attach evidence' }));
        attach.addEventListener('click', () => openEvidenceModal({
          targetType: 'ban',
          targetId: ban.id,
          title: 'Evidence — ' + (ban.playerName && ban.playerName !== '(manual ban)' ? ban.playerName : steamId),
          lead: 'Ban' + (ban.reason ? ' for "' + clip(ban.reason, 140) + '"' : '') + ' · issued just now.',
          canUpload: true,
          onClose(n) { if (n != null && tab === 'active') load(); },
        }));
        mbTray.append(attach);
      }

      mbBtn.addEventListener('click', async () => {
        const steamId = sidInput.value.trim();
        if (!STEAMID_RE.test(steamId)) {
          SW.ui.toast('That does not look like a steamId64 (7656 + 13 digits)', 'error');
          sidInput.classList.add('invalid');
          return;
        }
        sidInput.classList.remove('invalid');
        const iv = interval === 'custom' ? customInput.value.trim() : interval;
        if (!BAN_INTERVAL_RE.test(iv)) {
          SW.ui.toast('Invalid ban interval — use 0 (permanent) or like 30m, 12h, 5d, 2w, 1M, 1y', 'error');
          return;
        }
        const reason = reasonTa.value.trim();
        if (!reason) {
          SW.ui.toast('A ban needs a reason', 'error');
          reasonTa.classList.add('invalid');
          return;
        }
        reasonTa.classList.remove('invalid');
        const v = await SW.ui.confirmModal({
          title: 'Ban ' + steamId,
          body: 'Ban this steamId ' + (iv === '0' ? 'permanently' : 'for ' + iv) + '? If they are online they will be kicked by the ban.',
          danger: true,
          confirmText: 'Ban',
        });
        if (!v) return;
        mbBtn.disabled = true;
        try {
          const body = { steamId, interval: iv, reason };
          const note = noteTa.value.trim();
          if (note) body.note = note;
          const res = await SW.api('/api/bans', { method: 'POST', body });
          const doneTitle = 'Banned ' + steamId + ' (' + (iv === '0' ? 'permanent' : iv) + ')';
          if (res && res.ok !== false && res.rconOk === false) {
            SW.ui.toast(doneTitle, 'ok', {
              detail: 'The game server could not ban them directly (most often: they are not on the server right now). ' +
                'A3 Admin kicks them the moment they join, every time.',
            });
          } else {
            rconResultToast(doneTitle, res);
          }
          sidInput.value = '';
          reasonTa.value = '';
          noteTa.value = '';
          showBanned(steamId, res && res.ban);
          if (tab === 'active') load();
        } catch (_e) { /* toasted */ }
        mbBtn.disabled = false;
      });
    }

    load();
  }

  /* ============================================================ AUDIT view */

  /* tone per action: red = hits players or the round, amber = moderation
   * and server-wide control, neutral for account/config housekeeping */
  const ACTION_TONE = new Map([
    ['ban', 'red'], ['kick', 'red'], ['endMatch', 'red'], ['restartMatch', 'red'],
    ['disbandSquad', 'red'], ['changeLayer', 'red'], ['role-delete', 'red'], ['ban-enforce', 'red'],
    ['join-alert-kick', 'red'],
    ['warn', 'warn'], ['forceTeamChange', 'warn'], ['removeFromSquad', 'warn'],
    ['demoteCommander', 'warn'], ['broadcast', 'warn'], ['setNextLayer', 'warn'],
    ['slomo', 'warn'], ['raw', 'warn'], ['manual-flag', 'warn'], ['quick-command', 'warn'],
    ['bm-import', 'warn'], ['scheduled-run', 'warn'], ['admin-call-reply', 'warn'],
    ['remote-bans-rotate', 'warn'], ['evidence-delete', 'warn'],
  ]);

  /* audit actions that take evidence afterwards -> the perm that may attach */
  const EV_ACTION_PERM = Object.assign(Object.create(null), { warn: 'warn', kick: 'kick', ban: 'ban' });
  const EV_ACTION_VERB = Object.assign(Object.create(null), { warn: 'Warned', kick: 'Kicked', ban: 'Banned' });

  function actionBadge(a) {
    const key = a == null ? '' : String(a);
    if (!key) return null;
    const b = SW.ui.badge(humanize(key), ACTION_TONE.get(key) || 'dim');
    b.title = key;
    return b;
  }

  function fmtDetailVal(v) {
    if (v == null) return '—';
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (Array.isArray(v)) {
      const s = v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', ');
      return s || '—';
    }
    if (typeof v === 'object') {
      try { return JSON.stringify(v); } catch (_e) { return String(v); }
    }
    return String(v);
  }

  /* details arrive parsed (object) or as text; objects become key/value
   * pairs, everything is rendered through textContent */
  function detailPairs(det) {
    if (det == null || det === '') return [];
    if (typeof det !== 'object') return String(det);
    if (Array.isArray(det)) return fmtDetailVal(det);
    const out = [];
    for (const k of Object.keys(det)) {
      const v = det[k];
      if (v == null || v === '') continue;
      out.push([humanize(k), fmtDetailVal(v)]);
    }
    return out;
  }

  function renderAudit(main) {
    this.cleanup = trackEvidence('action',
      (id) => curRows.find((x) => String(x.id) === String(id)) || null,
      (r, n) => setEvidenceCount(r, n, false));
    const view = el('div', { class: 'view view-audit adm fade-in' });
    main.append(view);
    const refreshBtn = iconBtn('Refresh', 'refresh', 'ghost small');
    view.append(pageHead('Audit log',
      'Every panel action and raw RCON command, newest first.', [refreshBtn]).el);

    let page = 0;
    let perGuess = 50;
    let seq = 0;
    let userId = '';
    let action = '';
    let loaded = false;
    const seenUsers = new Map(); /* userId -> username */
    const seenActions = new Set();

    /* toolbar */
    const userSel = el('select', { class: 'input adm-filter', 'aria-label': 'Filter by user' });
    const actSel = el('select', { class: 'input adm-filter', 'aria-label': 'Filter by action' });
    function fillFilterSelects() {
      const prevU = userSel.value;
      userSel.textContent = '';
      userSel.append(el('option', { value: '', text: 'All users' }));
      for (const [uidKey, uname] of seenUsers) {
        userSel.append(el('option', { value: String(uidKey), text: uname }));
      }
      if (prevU && Array.prototype.some.call(userSel.options, (o) => o.value === prevU)) userSel.value = prevU;
      const prevA = actSel.value;
      actSel.textContent = '';
      actSel.append(el('option', { value: '', text: 'All actions' }));
      for (const a of Array.from(seenActions).sort()) {
        actSel.append(el('option', { value: a, text: humanize(a) }));
      }
      if (prevA && Array.prototype.some.call(actSel.options, (o) => o.value === prevA)) actSel.value = prevA;
    }
    fillFilterSelects();
    const resetBtn = el('button', { type: 'button', class: 'btn ghost small hidden', text: 'Clear filters' });
    function syncReset() { resetBtn.classList.toggle('hidden', !userId && !action); }
    userSel.addEventListener('change', () => { userId = userSel.value; page = 0; syncReset(); load(); });
    actSel.addEventListener('change', () => { action = actSel.value; page = 0; syncReset(); load(); });
    resetBtn.addEventListener('click', () => {
      userId = '';
      action = '';
      userSel.value = '';
      actSel.value = '';
      page = 0;
      syncReset();
      load();
    });
    refreshBtn.addEventListener('click', () => load());
    const total = el('span', { class: 'adm-count' });
    const tc = tableCard({ tools: [userSel, actSel, resetBtn, total] });
    view.append(el('div', { class: 'adm-col' }, tc.el));

    function userCell(r) {
      const uidVal = g(r, 'userId', 'user_id');
      if (uidVal == null) return SW.ui.badge('system', 'dim');
      const uname = g(r, 'username', 'userName', 'user');
      return truncSpan(uname != null ? String(uname) : 'user #' + uidVal, 'adm-w-user');
    }

    function targetCell(r) {
      const pid = g(r, 'targetPlayerId', 'target_player_id');
      const pname = g(r, 'playerName', 'player_name', 'targetName', 'target_name');
      if (pid == null && pname == null) return null;
      return el('div', { class: 'adm-who adm-w-target' }, nameLink({ dbId: pid, name: pname || ('#' + pid) }));
    }

    /* details + expandable rcon command/response — textContent/<pre> ONLY */
    function detailsCell(r) {
      const wrap = el('div', { class: 'adm-details' });
      const pairs = detailPairs(g(r, 'details'));
      if (typeof pairs === 'string') {
        if (pairs) {
          wrap.append(el('div', { class: 'adm-details-text wrap-anywhere', title: pairs.length > 240 ? pairs : null, text: clip(pairs, 240) }));
        }
      } else if (pairs.length) {
        const kvs = el('div', { class: 'adm-kvs' });
        for (const [k, v] of pairs) {
          kvs.append(el('span', { class: 'adm-kv' },
            el('span', { class: 'adm-kv-k', text: k }),
            el('span', { class: 'adm-kv-v wrap-anywhere', title: v.length > 160 ? v : null, text: clip(v, 160) })));
        }
        wrap.append(kvs);
      }
      const cmd = g(r, 'rconCommand', 'rcon_command');
      const resp = g(r, 'rconResponse', 'rcon_response');
      const hasCmd = cmd != null && cmd !== '';
      const hasResp = resp != null && resp !== '';
      if (hasCmd || hasResp) {
        const box = el('div', { class: 'adm-rcon-box hidden' });
        if (hasCmd) {
          const p1 = el('pre', { class: 'is-cmd' });
          p1.textContent = '$ ' + String(cmd);
          box.append(p1);
        }
        const p2 = el('pre');
        p2.textContent = hasResp ? String(resp) : '(no response recorded)';
        box.append(p2);
        const btn = el('button', { type: 'button', class: 'adm-rcon-toggle', 'aria-expanded': 'false' });
        btn.innerHTML = SW.icon('chevron-down') + '<span>RCON</span>';
        btn.addEventListener('click', () => {
          const open = box.classList.toggle('hidden') === false;
          btn.setAttribute('aria-expanded', String(open));
          btn.classList.toggle('is-open', open);
        });
        const cmdLine = el('code', {
          class: 'adm-rcon-cmd truncate',
          title: hasCmd ? String(cmd) : null,
          text: hasCmd ? '$ ' + String(cmd) : '(no command recorded)',
        });
        wrap.append(el('div', { class: 'adm-rcon-line' }, btn, cmdLine), box);
      }
      return wrap.childNodes.length ? wrap : null;
    }

    /* warn / kick / ban rows: evidence count + viewer; attaching afterwards
     * takes the perm of the action itself (BATCH3 §1) */
    let curRows = [];
    function setEvidenceCount(r, n, live) {
      if (n === num(g(r, 'evidenceCount', 'evidence_count'))) return;
      r.evidenceCount = n;
      if (!live) tbl.update(curRows);
    }
    function evidenceCell(r) {
      const a = String(g(r, 'action') || '');
      if (!EV_ACTION_PERM[a]) return null;
      const pid = g(r, 'targetPlayerId', 'target_player_id');
      const who = g(r, 'targetName', 'target_name', 'playerName', 'player_name') || (pid != null ? 'player #' + pid : 'unknown player');
      const by = g(r, 'username', 'userName', 'user') || 'system';
      const det = objOf(g(r, 'details')) || {};
      const why = [det.reason, det.message].find((x) => typeof x === 'string' && x.trim() !== '') || '';
      return evidenceControl({
        targetType: 'action',
        targetId: r.id,
        count: g(r, 'evidenceCount', 'evidence_count'),
        canView: true, /* this page needs audit, which may view evidence */
        canUpload: SW.can(EV_ACTION_PERM[a]),
        what: 'this ' + a,
        title: 'Evidence — ' + who,
        lead: EV_ACTION_VERB[a] + ' by ' + by + ' · ' + fmtDayTime(r.time) + (why ? ' — "' + clip(why, 140) + '"' : ''),
        hint: a === 'ban' ? 'These files belong to this audit entry; files on the ban itself are on the Bans page.' : null,
        onCount: (n, live) => setEvidenceCount(r, n, live),
      });
    }

    const cols = [
      {
        key: 'time', label: 'Time', width: '104px', sortable: true,
        sortVal: (r) => num(r.time),
        render: (r) => stampCell(r.time),
      },
      { key: 'user', label: 'User', render: userCell },
      { key: 'action', label: 'Action', render: (r) => actionBadge(g(r, 'action')) },
      { key: 'target', label: 'Target', render: targetCell },
      { key: 'evidence', label: 'Evidence', class: 'adm-td-ev', render: evidenceCell },
      { key: 'details', label: 'Details / RCON', render: detailsCell },
      { key: 'ok', label: 'RCON', width: '72px', render: (r) => rconBadge(g(r, 'rconOk', 'rcon_ok')) },
    ];

    const tbl = SW.ui.table(cols, [], {
      sort: { key: 'time', dir: 'desc' },
      class: 'adm-table adm-table--tall',
      emptyText: 'No audit entries match',
    });
    const emptyBox = el('div', { class: 'adm-table-empty hidden' });
    const pagerBox = el('div', { class: 'adm-pager' });
    tc.foot().append(pagerBox);
    tc.body.append(skeletonRows(8));

    async function load() {
      const my = ++seq;
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per', '50');
      if (userId) params.set('userId', userId);
      if (action) params.set('action', action);
      tc.el.classList.add('is-loading');
      let r;
      try { r = await SW.api('/api/audit?' + params.toString()); }
      catch (_e) {
        if (my !== seq) return;
        tc.el.classList.remove('is-loading');
        if (!loaded) {
          tc.body.textContent = '';
          tc.body.append(emptyState('scroll', 'Could not load the audit log', 'The server did not answer — try Refresh in a moment.'));
        }
        return;
      }
      if (my !== seq) return;
      tc.el.classList.remove('is-loading');
      if (!loaded) {
        loaded = true;
        tc.body.textContent = '';
        tc.body.append(tbl, emptyBox);
      }
      const rows = listOf(r);
      for (const row of rows) {
        const uidVal = g(row, 'userId', 'user_id');
        if (uidVal != null && !seenUsers.has(uidVal)) {
          const uname = g(row, 'username', 'userName', 'user');
          seenUsers.set(uidVal, uname != null ? String(uname) : 'user #' + uidVal);
        }
        const a = g(row, 'action');
        if (a) seenActions.add(String(a));
      }
      fillFilterSelects();
      perGuess = Math.max(perGuess, rows.length);
      const n = num(r && r.total);
      total.textContent = SW.ui.fmtNum(n) + (n === 1 ? ' entry' : ' entries');
      curRows = rows;
      tbl.update(rows);
      tbl.classList.toggle('hidden', !rows.length);
      emptyBox.classList.toggle('hidden', !!rows.length);
      emptyBox.textContent = '';
      if (!rows.length) {
        emptyBox.append((userId || action)
          ? emptyState('search', 'No entries match these filters', 'Clear the filters to see the whole log.')
          : emptyState('scroll', 'Nothing logged yet', 'Admin actions and raw RCON commands appear here as they happen.'));
      }
      pagerBox.textContent = '';
      pagerBox.append(SW.ui.pager({
        page, per: perGuess, total: n,
        onPage: (p) => { page = p; load(); },
      }));
    }
    load();
  }

  /* ============================================================ USERS view */

  /* a role that can still run the panel (users+roles+settings) — handing it
   * out gets the danger treatment the old "→ owner" confirm had */
  function isKeyholderRole(role) {
    const p = (role && role.perms) || {};
    return p.users === true && p.roles === true && p.settings === true;
  }

  function initialOf(name) {
    const first = Array.from(String(name || '?').trim())[0];
    return first ? first.toUpperCase() : '?';
  }

  function renderUsers(main) {
    this.cleanup = () => {};
    const view = el('div', { class: 'view view-users adm fade-in' });
    main.append(view);
    const invBtn = iconBtn('Create invite', 'plus', 'primary');
    view.append(pageHead('Users',
      'Panel accounts and their roles. Invite links let new admins choose their own password.',
      [invBtn]).el);
    const col = el('div', { class: 'adm-col is-loose' });
    view.append(col);

    const meId = SW.state.me && SW.state.me.id;
    let roles = []; /* GET /api/roles rows — feed every role <select> (§1) */

    function roleOptions(sel, selectedId) {
      sel.textContent = '';
      for (const role of roles) {
        const o = el('option', { value: String(role.id), text: role.name });
        if (selectedId != null && Number(selectedId) === Number(role.id)) o.selected = true;
        sel.append(o);
      }
    }

    /* ------------------------------------------------- accounts table */
    const acct = tableCard({ title: 'Accounts' });
    col.append(acct.el);
    acct.body.append(skeletonRows(4));

    function userCell(row) {
      const name = String(row.username || '?');
      const w = el('div', { class: 'adm-user' },
        el('span', { class: 'adm-avatar', 'aria-hidden': 'true', text: initialOf(name) }),
        el('span', { class: 'adm-strong truncate', title: name, text: name }));
      if (row.id === meId) w.append(SW.ui.badge('you', 'accent'));
      if (num(g(row, 'disabled'))) w.append(SW.ui.badge('disabled', 'red'));
      return w;
    }

    function roleCell(r) {
      let curId = g(r, 'roleId', 'role_id');
      if (!roles.length) return truncSpan(String(r.role || '?'));
      const sel = el('select', { class: 'input adm-role-select', 'aria-label': 'Role for ' + (r.username || 'user') });
      roleOptions(sel, curId);
      if (r.id === meId) {
        sel.disabled = true;
        sel.title = 'You cannot change your own role';
        return sel;
      }
      sel.addEventListener('change', async () => {
        const newRole = roles.find((x) => String(x.id) === sel.value);
        if (!newRole) { sel.value = String(curId); return; }
        const v = await SW.ui.confirmModal({
          title: 'Change role',
          body: 'Change ' + (r.username || 'this user') + ' from ' + r.role + ' to ' + newRole.name + '? Their sessions are signed out.',
          confirmText: 'Change role',
          danger: isKeyholderRole(newRole),
        });
        if (!v) { sel.value = String(curId); return; }
        try {
          await SW.api('/api/users/' + encodeURIComponent(r.id), { method: 'POST', body: { roleId: newRole.id } });
          SW.ui.toast('Role updated: ' + (r.username || '') + ' → ' + newRole.name, 'ok');
          r.role = newRole.name;
          r.roleId = newRole.id;
          curId = newRole.id;
        } catch (_e) { sel.value = String(curId); /* toasted (e.g. last keyholder) */ }
      });
      return sel;
    }

    function actionsCell(r, reload) {
      const wrap = el('div', { class: 'adm-cell-actions' });
      const resetBtn = el('button', { type: 'button', class: 'btn ghost small', text: 'Reset password' });
      resetBtn.addEventListener('click', async () => {
        const v = await SW.ui.confirmModal({
          title: 'Reset password — ' + (r.username || 'user'),
          body: 'Sets a new password and signs out all of their sessions.',
          confirmText: 'Set password',
          fields: [{
            name: 'password', label: 'New password', type: 'password', required: true,
            hint: 'Share it with them over a trusted channel.',
          }],
        });
        if (!v) return;
        try {
          await SW.api('/api/users/' + encodeURIComponent(r.id), { method: 'POST', body: { password: v.password } });
          SW.ui.toast('Password reset for ' + (r.username || 'user'), 'ok');
        } catch (_e) { /* toasted */ }
      });
      wrap.append(resetBtn);

      const disabled = !!num(g(r, 'disabled'));
      const toggle = el('button', {
        type: 'button',
        class: 'btn small ' + (disabled ? 'ghost' : 'danger ghost'),
        text: disabled ? 'Enable' : 'Disable',
      });
      if (r.id === meId) {
        toggle.disabled = true;
        toggle.title = 'You cannot disable your own account';
      } else {
        toggle.addEventListener('click', async () => {
          const v = await SW.ui.confirmModal({
            title: (disabled ? 'Enable ' : 'Disable ') + (r.username || 'user'),
            body: disabled
              ? 'Let this user sign in again?'
              : 'They are signed out immediately and cannot sign in until re-enabled.',
            danger: !disabled,
            confirmText: disabled ? 'Enable' : 'Disable',
          });
          if (!v) return;
          try {
            await SW.api('/api/users/' + encodeURIComponent(r.id), { method: 'POST', body: { disabled: !disabled } });
            SW.ui.toast((disabled ? 'Enabled ' : 'Disabled ') + (r.username || 'user'), 'ok');
            reload();
          } catch (_e) { /* toasted */ }
        });
      }
      wrap.append(toggle);
      return wrap;
    }

    async function load() {
      try {
        const rr = await SW.api('/api/roles', { toast: false });
        roles = listOf(rr);
      } catch (_e) { /* keep whatever we had — roleCell degrades to text */ }
      syncAddRoleSel();
      let r;
      try { r = await SW.api('/api/users'); }
      catch (_e) {
        acct.body.textContent = '';
        acct.body.append(emptyState('user-cog', 'Could not load users', 'The server did not answer — reload the page in a moment.'));
        return;
      }
      const rows = listOf(r);
      acct.setCount(rows.length);
      const cols = [
        { key: 'username', label: 'User', render: userCell },
        { key: 'role', label: 'Role', render: roleCell },
        {
          key: 'lastLogin', label: 'Last login', sortable: true,
          sortVal: (row) => num(g(row, 'lastLogin', 'last_login')),
          render: (row) => {
            const v = g(row, 'lastLogin', 'last_login');
            return v ? SW.ui.timeAgo(v) : el('span', { class: 'adm-muted', text: 'never' });
          },
        },
        {
          key: 'created', label: 'Created',
          render: (row) => {
            const ts = g(row, 'createdAt', 'created_at');
            return el('span', { class: 'adm-muted nowrap', title: SW.ui.fmtTime(ts), text: fmtDate(ts) });
          },
        },
        { key: 'actions', label: '', class: 'adm-td-actions', render: (row) => actionsCell(row, load) },
      ];
      acct.body.textContent = '';
      if (!rows.length) {
        acct.body.append(emptyState('user-cog', 'No users', 'Create an invite to bring in your first admin.'));
        return;
      }
      acct.body.append(SW.ui.table(cols, rows, {
        rowClass: (row) => (num(g(row, 'disabled')) ? 'adm-row-disabled' : ''),
        class: 'adm-table',
        emptyText: 'No users',
      }));
    }

    /* ------------------------------------------------- invites (§2) */
    const TTL_OPTIONS = [
      { value: '24', label: '24 hours' },
      { value: '72', label: '3 days' },
      { value: '168', label: '7 days' },
      { value: '720', label: '30 days' },
    ];
    const INVITE_BADGE = { unused: 'ok', used: 'dim', expired: 'dim', revoked: 'red' };

    const inv = tableCard({ title: 'Invites' });
    col.append(inv.el);
    inv.body.append(skeletonRows(3));
    inv.foot().append(el('p', {
      class: 'adm-note',
      text: 'An invite is a single-use link that lets one person create their own account with the role you pick. The link is shown exactly once.',
    }));

    /* the one-time URL modal — the token never comes back from the server */
    function showInviteUrl(res) {
      const url = String((res && res.url) || '');
      const roleName = (res && res.invite && res.invite.roleName) || '';
      const body = el('div', { class: 'adm-modal-stack' });
      body.append(el('p', {
        class: 'modal-text',
        text: 'Send this link to your new ' + (roleName || 'panel member') + '. It works once and is shown only now — A3 Admin does not store it.',
      }));
      const urlText = el('code', { class: 'adm-invite-code', tabindex: '0', title: url });
      urlText.textContent = url; /* server-built URL — textContent only */
      body.append(el('div', { class: 'adm-invite-url' }, urlText, SW.ui.copyBtn(url, 'Copy')));
      if (res && res.invite && res.invite.expiresAt) {
        body.append(el('p', { class: 'hint', text: 'Expires ' + SW.ui.fmtTime(res.invite.expiresAt) + '. You can revoke it from the Invites list until it is used.' }));
      }
      const okBtn = el('button', { type: 'button', class: 'btn primary', text: 'Done' });
      body.append(el('div', { class: 'modal-actions' }, okBtn));
      const m = SW.ui.modal({ title: 'Invite link — copy it now', body });
      okBtn.addEventListener('click', () => m.close());
    }

    async function createInvite() {
      if (!roles.length) { SW.ui.toast('Role list not loaded yet — try again in a moment', 'warn'); return; }
      const viewer = roles.find((x) => x.builtin && x.name === 'viewer') || roles[0];
      const v = await SW.ui.confirmModal({
        title: 'Create invite link',
        body: 'The link lets one person join the panel with the role you pick.',
        confirmText: 'Create invite',
        fields: [
          { name: 'roleId', label: 'Role', type: 'select', options: roles.map((x) => ({ value: String(x.id), label: x.name })), value: String(viewer.id) },
          { name: 'ttlHours', label: 'Expires after', type: 'select', options: TTL_OPTIONS, value: '168' },
        ],
      });
      if (!v) return;
      invBtn.disabled = true;
      try {
        const res = await SW.api('/api/invites', { method: 'POST', body: { roleId: Number(v.roleId), ttlHours: Number(v.ttlHours) } });
        showInviteUrl(res);
        loadInvites();
      } catch (_e) { /* toasted */ }
      invBtn.disabled = false;
    }
    invBtn.addEventListener('click', createInvite);

    function revokeCell(r) {
      if (r.state !== 'unused') return '';
      const b = el('button', { type: 'button', class: 'btn danger ghost small', text: 'Revoke' });
      b.addEventListener('click', async () => {
        const v = await SW.ui.confirmModal({
          title: 'Revoke invite',
          body: 'The ' + String(g(r, 'roleName', 'role_name') || '') + ' invite link stops working immediately.',
          danger: true,
          confirmText: 'Revoke',
        });
        if (!v) return;
        b.disabled = true;
        try {
          await SW.api('/api/invites/' + encodeURIComponent(r.id) + '/revoke', { method: 'POST', body: {} });
          SW.ui.toast('Invite revoked', 'ok');
          loadInvites();
        } catch (_e) { b.disabled = false; /* toasted */ }
      });
      return b;
    }

    async function loadInvites() {
      let r;
      try { r = await SW.api('/api/invites', { toast: false }); }
      catch (_e) {
        inv.body.textContent = '';
        inv.body.append(emptyState('users', 'Could not load invites', 'The server did not answer — reload the page in a moment.'));
        return;
      }
      const rows = listOf(r);
      const open = rows.filter((x) => x.state === 'unused').length;
      inv.setCount(open ? open + ' open' : '');
      inv.body.textContent = '';
      if (!rows.length) {
        inv.body.append(emptyState('users', 'No invites yet', 'An invite is a one-time join link for a new admin.',
          { label: 'Create invite', icon: 'plus', onClick: createInvite }));
        return;
      }
      const cols = [
        {
          key: 'state', label: 'State',
          render: (row) => SW.ui.badge(row.state || '?',
            Object.prototype.hasOwnProperty.call(INVITE_BADGE, row.state) ? INVITE_BADGE[row.state] : 'dim'),
        },
        { key: 'role', label: 'Role', render: (row) => truncSpan(g(row, 'roleName', 'role_name') || '?', 'adm-w-role') },
        {
          key: 'createdBy', label: 'Created by',
          render: (row) => { const n = g(row, 'createdByName', 'created_by_name'); return truncSpan(n == null ? 'system' : n, 'adm-w-user'); },
        },
        {
          key: 'created', label: 'Created', sortable: true,
          sortVal: (row) => num(g(row, 'createdAt', 'created_at')),
          render: (row) => SW.ui.timeAgo(g(row, 'createdAt', 'created_at')),
        },
        {
          key: 'expires', label: 'Expires',
          render: (row) => {
            const ex = g(row, 'expiresAt', 'expires_at');
            if (!ex) return el('span', { class: 'adm-muted', text: 'never' });
            return el('span', { class: 'nowrap' + (num(ex) < Date.now() ? ' adm-muted' : ''), title: SW.ui.fmtTime(ex), text: fmtDate(ex) });
          },
        },
        {
          key: 'usedBy', label: 'Used by',
          render: (row) => { const n = g(row, 'usedByName', 'used_by_name'); return n == null ? null : truncSpan(n, 'adm-w-user'); },
        },
        { key: 'revoke', label: '', class: 'adm-td-actions', render: revokeCell },
      ];
      inv.body.append(SW.ui.table(cols, rows, {
        sort: { key: 'created', dir: 'desc' },
        class: 'adm-table',
        emptyText: 'No invites yet — Create invite makes a one-time join link',
      }));
    }

    /* ------------------------------------------------- add-user card */
    const add = card('Add a user directly', { class: 'adm-add-user' });
    const auName = el('input', { class: 'input', type: 'text', placeholder: 'Username', autocomplete: 'off', 'aria-label': 'New username' });
    const auPass = el('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'new-password', 'aria-label': 'New user password' });
    const auRole = el('select', { class: 'input', 'aria-label': 'New user role' });
    function syncAddRoleSel() {
      const prev = auRole.value;
      const viewer = roles.find((x) => x.builtin && x.name === 'viewer');
      roleOptions(auRole, prev !== '' ? prev : (viewer ? viewer.id : null));
    }
    const auBtn = iconBtn('Create user', 'plus', 'ghost');
    auBtn.type = 'submit';
    const form = el('form', { class: 'adm-add-form' },
      field('Username', auName, null, 'adm-add-name'),
      field('Password', auPass, null, 'adm-add-pass'),
      field('Role', auRole, null, 'adm-add-role'),
      el('div', { class: 'adm-add-submit' }, auBtn));
    add.body.append(form, el('p', {
      class: 'adm-note',
      text: 'Prefer an invite link so new admins pick their own password. Roles and their permissions are managed on the Roles page.',
    }));
    col.append(add.el);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = auName.value.trim();
      const password = auPass.value;
      if (!username || !password) {
        SW.ui.toast('Username and password are required', 'error');
        return;
      }
      const role = roles.find((x) => String(x.id) === auRole.value);
      if (!role) {
        SW.ui.toast('Pick a role (is the role list loaded?)', 'error');
        return;
      }
      auBtn.disabled = true;
      try {
        await SW.api('/api/users', { method: 'POST', body: { username, password, roleId: role.id } });
        SW.ui.toast('User created: ' + username + ' (' + role.name + ')', 'ok');
        auName.value = '';
        auPass.value = '';
        load();
      } catch (_e) { /* toasted */ }
      auBtn.disabled = false;
    });

    load();
    loadInvites();
  }

  /* ============================================================ ROLES view */

  function renderRoles(main) {
    this.cleanup = () => {};
    const view = el('div', { class: 'view view-roles adm fade-in' });
    main.append(view);

    /* viewable with users OR roles; editing needs the roles key (the server
     * 403s writes anyway — we just hide the buttons) */
    const canEdit = SW.can('roles');
    let permCatalog = []; /* GET /api/perms — [{key, group, label}] */

    let createBtn = null;
    if (canEdit) {
      createBtn = iconBtn('Create role', 'plus', 'primary');
      createBtn.addEventListener('click', () => roleModal(null));
    }
    view.append(pageHead('Roles',
      'Roles bundle permissions — every user and invite carries exactly one.' + (canEdit ? '' : ' Editing needs the Manage roles permission.'),
      [createBtn]).el);
    const tc = tableCard({ title: 'Roles' });
    view.append(el('div', { class: 'adm-col' }, tc.el));
    tc.body.append(skeletonRows(4));

    function isOwnerRole(r) { return !!(r && r.builtin && r.name === 'owner'); }
    function grantedCount(role) {
      if (isOwnerRole(role) && permCatalog.length) return permCatalog.length; /* owner holds everything */
      const p = (role && role.perms) || {};
      return Object.keys(p).filter((k) => p[k] === true).length;
    }

    function modalNote(icon, text) {
      const n = el('div', { class: 'adm-modal-note' });
      n.innerHTML = SW.icon(icon);
      n.append(el('span', { text }));
      return n;
    }

    /* create/edit modal: name + permission checkboxes grouped per /api/perms
     * group, each group with a select-all. Builtin: name locked. Owner (and
     * read-only viewers): everything locked, no save. */
    function roleModal(role) {
      const isBuiltin = !!(role && role.builtin);
      const isOwner = isBuiltin && role.name === 'owner';
      const locked = isOwner || !canEdit;
      const form = el('form', { class: 'modal-form adm-role-form' });

      if (isOwner) {
        form.append(modalNote('lock', 'Builtin role — the owner always holds every permission, including ones added by future updates.'));
      } else if (!canEdit) {
        form.append(modalNote('eye', 'Read-only — editing roles needs the Manage roles permission.'));
      }

      const nameInput = el('input', { class: 'input', type: 'text', placeholder: 'e.g. Moderator', maxlength: '32', autocomplete: 'off' });
      if (role) nameInput.value = String(role.name);
      if (isBuiltin || locked) nameInput.disabled = true;
      form.append(field('Role name', nameInput,
        isBuiltin && !isOwner ? 'Builtin role — the name is fixed, the permissions are yours to tune.' : null));

      const checks = new Map(); /* perm key -> checkbox */
      const groups = [];
      for (const p of permCatalog) {
        let grp = groups.find((x) => x.name === p.group);
        if (!grp) { grp = { name: p.group, perms: [] }; groups.push(grp); }
        grp.perms.push(p);
      }
      const totalEl = el('span', { class: 'adm-perm-total' });
      function syncTotal() {
        let n = 0;
        for (const cb of checks.values()) { if (cb.checked) n++; }
        totalEl.textContent = n + ' of ' + checks.size + ' granted';
      }
      const permGrid = el('div', { class: 'adm-perm-grid' });
      groups.forEach((grp) => {
        const gbox = el('div', { class: 'adm-perm-group' });
        const gAll = el('input', { type: 'checkbox', 'aria-label': 'Toggle all ' + grp.name + ' permissions' });
        const gCount = el('span', { class: 'adm-perm-group-count' });
        gbox.append(el('label', { class: 'adm-perm-group-head' },
          gAll, el('span', { class: 'adm-perm-group-name', text: grp.name }), gCount));
        const list = el('div', { class: 'adm-perm-items' });
        const items = [];
        for (const p of grp.perms) {
          const cb = el('input', { type: 'checkbox' });
          cb.checked = isOwner || !!(role && role.perms && role.perms[p.key] === true);
          if (locked) cb.disabled = true;
          checks.set(p.key, cb);
          items.push(cb);
          list.append(el('label', { class: 'adm-perm-item', title: p.key },
            cb,
            el('span', { class: 'adm-perm-label', text: p.label }),
            el('code', { class: 'adm-perm-key', text: p.key })));
        }
        gbox.append(list);
        const syncGroup = () => {
          const on = items.filter((c) => c.checked).length;
          gAll.checked = items.length > 0 && on === items.length;
          gAll.indeterminate = on > 0 && on < items.length;
          gCount.textContent = on + '/' + items.length;
          gbox.classList.toggle('is-full', gAll.checked);
        };
        syncGroup();
        if (locked) gAll.disabled = true;
        gAll.addEventListener('change', () => {
          for (const c of items) c.checked = gAll.checked;
          syncGroup();
          syncTotal();
        });
        for (const c of items) c.addEventListener('change', () => { syncGroup(); syncTotal(); });
        permGrid.append(gbox);
      });
      syncTotal();
      form.append(el('div', { class: 'adm-perm-section' },
        el('div', { class: 'adm-perm-head' }, el('span', { class: 'adm-field-label', text: 'Permissions' }), totalEl),
        permGrid));

      const actions = el('div', { class: 'modal-actions' });
      const cancel = el('button', { type: 'button', class: 'btn ghost', text: locked ? 'Close' : 'Cancel' });
      actions.append(cancel);
      let okBtn = null;
      if (!locked) {
        okBtn = el('button', { type: 'submit', class: 'btn primary', text: role ? 'Save role' : 'Create role' });
        actions.append(okBtn);
      }
      form.append(actions);
      const m = SW.ui.modal({
        title: role ? (locked ? 'Role — ' + role.name : 'Edit role — ' + role.name) : 'Create role',
        body: form, wide: true,
      });
      cancel.addEventListener('click', () => m.close());

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (locked) return;
        const name = nameInput.value.trim();
        if (!isBuiltin && !name) {
          nameInput.classList.add('invalid');
          return;
        }
        nameInput.classList.remove('invalid');
        const perms = {};
        for (const [k, cb] of checks) { if (cb.checked) perms[k] = true; }
        /* a perms edit logs every member out (§1) — make that explicit.
         * Compare as sorted key sets: object key order differs by source. */
        const cur = (role && role.perms) || {};
        const curKeys = Object.keys(cur).filter((k) => cur[k] === true).sort().join(',');
        const permsChanged = !role || curKeys !== Object.keys(perms).sort().join(',');
        if (role && num(role.members) > 0 && permsChanged) {
          const n = num(role.members);
          const sure = await SW.ui.confirmModal({
            title: 'Save "' + (isBuiltin ? role.name : name) + '"?',
            body: 'Saving logs out ' + n + ' member' + (n === 1 ? '' : 's') + ' — they sign back in with the new permissions.',
            danger: true,
            confirmText: 'Save & sign them out',
          });
          if (!sure) return;
        }
        if (okBtn) okBtn.disabled = true;
        try {
          if (role) {
            const body = { perms };
            if (!isBuiltin) body.name = name;
            await SW.api('/api/roles/' + encodeURIComponent(role.id), { method: 'POST', body });
            SW.ui.toast('Role saved: ' + (isBuiltin ? role.name : name), 'ok');
          } else {
            await SW.api('/api/roles', { method: 'POST', body: { name, perms } });
            SW.ui.toast('Role created: ' + name, 'ok');
          }
          m.close();
          load();
        } catch (_e) { if (okBtn) okBtn.disabled = false; /* toasted */ }
      });
      if (!locked) setTimeout(() => nameInput.focus(), 30);
    }

    function actionsCell(r) {
      const wrap = el('div', { class: 'adm-cell-actions' });
      const editBtn = el('button', { type: 'button', class: 'btn ghost small', text: canEdit && !isOwnerRole(r) ? 'Edit' : 'View' });
      editBtn.addEventListener('click', () => roleModal(r));
      wrap.append(editBtn);
      if (canEdit) {
        const delBtn = el('button', { type: 'button', class: 'btn danger ghost small', text: 'Delete' });
        if (r.builtin) {
          delBtn.disabled = true;
          delBtn.title = 'Builtin roles cannot be deleted';
        } else {
          delBtn.addEventListener('click', async () => {
            const v = await SW.ui.confirmModal({
              title: 'Delete role "' + r.name + '"?',
              body: 'Only roles with no members and no open invites can be deleted. This cannot be undone.',
              danger: true,
              confirmText: 'Delete role',
            });
            if (!v) return;
            delBtn.disabled = true;
            try {
              await SW.api('/api/roles/' + encodeURIComponent(r.id) + '/delete', { method: 'POST', body: {} });
              SW.ui.toast('Role deleted: ' + r.name, 'ok');
              load();
            } catch (_e) { delBtn.disabled = false; /* toasted — 409 names the blocker */ }
          });
        }
        wrap.append(delBtn);
      }
      return wrap;
    }

    const cols = [
      {
        key: 'name', label: 'Role',
        render: (r) => {
          const name = String(r.name || '?');
          const w = el('div', { class: 'adm-user' },
            el('span', { class: 'adm-strong truncate adm-w-role', title: name, text: name }));
          if (r.builtin) w.append(SW.ui.badge('builtin', 'dim'));
          return w;
        },
      },
      {
        key: 'perms', label: 'Permissions',
        render: (r) => {
          const n = grantedCount(r);
          const totalN = permCatalog.length;
          const w = el('div', { class: 'adm-coverage' },
            el('span', { class: 'adm-coverage-num', text: n + ' / ' + (totalN || '?') }));
          if (totalN) {
            const fill = el('span', { class: 'adm-meter-fill' });
            /* numeric width only — never untrusted data */
            fill.style.width = Math.round(Math.max(0, Math.min(1, n / totalN)) * 100) + '%';
            w.append(el('span', { class: 'adm-meter', 'aria-hidden': 'true' }, fill));
          }
          return w;
        },
      },
      {
        key: 'members', label: 'Members', align: 'right', sortable: true,
        sortVal: (r) => num(r.members),
        render: (r) => el('span', { class: 'tabular', text: SW.ui.fmtNum(num(r.members)) }),
      },
      {
        key: 'invites', label: 'Open invites', align: 'right',
        render: (r) => el('span', { class: 'tabular', text: SW.ui.fmtNum(num(g(r, 'openInvites', 'open_invites'))) }),
      },
      { key: 'actions', label: '', class: 'adm-td-actions', render: actionsCell },
    ];

    async function load() {
      let roleRows;
      try {
        const results = await Promise.all([
          SW.api('/api/perms', { toast: false }),
          SW.api('/api/roles'),
        ]);
        permCatalog = (results[0] && results[0].perms) || [];
        roleRows = listOf(results[1]);
      } catch (_e) {
        tc.body.textContent = '';
        tc.body.append(emptyState('shield', 'Could not load roles', 'The server did not answer — reload the page in a moment.'));
        return;
      }
      tc.setCount(roleRows.length);
      tc.body.textContent = '';
      if (!roleRows.length) {
        tc.body.append(emptyState('shield', 'No roles', canEdit ? 'Create a role to bundle permissions for your admins.' : null));
        return;
      }
      tc.body.append(SW.ui.table(cols, roleRows, { class: 'adm-table', emptyText: 'No roles' }));
    }
    load();
  }

  /* ========================================================= SETTINGS view */

  /* path with a truncating head and a fixed tail ("C:\Users\…\squadwatch.db")
   * + copy button — never a raw unbreakable string (DESIGN §7 rule 4) */
  function pathEl(p) {
    const s = String(p);
    const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    const text = el('span', { class: 'adm-path-text', title: s });
    if (cut >= 0 && cut < s.length - 1) {
      text.append(el('span', { class: 'adm-path-head', text: s.slice(0, cut + 1) }),
        el('span', { class: 'adm-path-tail', text: s.slice(cut + 1) }));
    } else {
      text.append(el('span', { class: 'adm-path-tail', text: s }));
    }
    return el('span', { class: 'adm-path' }, text, SW.ui.copyBtn(s));
  }

  function settingsSkeleton() {
    const grid = el('div', { class: 'adm-settings-grid', 'aria-hidden': 'true' });
    ['', '', ' adm-set-rb', ' adm-set-bm', '', '', ' adm-set-rt', ' adm-set-qc', ' adm-set-log', ' adm-set-detect'].forEach((c) => {
      grid.append(el('div', { class: 'skeleton block adm-skel-card' + c }));
    });
    return grid;
  }

  /* reason templates (BATCH3 §2) — the server's rules, checked first */
  const TPL_MAX = 60;
  const TPL_ID_RE = /^[a-z0-9-]{1,40}$/;
  const TPL_LABEL_MAX = 40;
  const TPL_REASON_MAX = 480;
  const TPL_KINDS = [
    { value: 'warn', title: 'Warn', noun: 'warning', hint: 'The message appears on the player\'s screen.' },
    { value: 'kick', title: 'Kick', noun: 'kick reason', hint: 'The player sees the reason as they are kicked.' },
    { value: 'ban', title: 'Ban', noun: 'ban reason', hint: 'Sets the reason and how long the ban lasts.' },
  ];
  const TPL_INTERVALS = [
    ['1h', '1 hour'], ['1d', '1 day'], ['3d', '3 days'], ['1w', '1 week'],
    ['2w', '2 weeks'], ['1M', '1 month'], ['0', 'Permanent'],
  ];

  /* GET /api/reason-templates rows -> [{id, kind, label, reason, interval}] */
  function tplRows(r) {
    return listOf(r)
      .filter((x) => x && TPL_KINDS.some((k) => k.value === x.kind))
      .map((x) => ({
        id: x.id == null ? null : String(x.id),
        kind: x.kind,
        label: String(x.label == null ? '' : x.label),
        reason: String(x.reason == null ? '' : x.reason),
        interval: x.interval == null ? '' : String(x.interval),
      }));
  }

  /* ban duration: common choices + Custom… (INTERVAL syntax of admin.js).
   * onChange(value) fires on every edit. -> {el, value(), custom} */
  function intervalPicker(value, ariaLabel, onChange, disabled) {
    const sel = el('select', { class: 'input adm-int-sel', 'aria-label': ariaLabel });
    TPL_INTERVALS.forEach(([v, l]) => sel.append(el('option', { value: v, text: l })));
    sel.append(el('option', { value: 'custom', text: 'Custom…' }));
    const custom = el('input', {
      class: 'input mono adm-int-custom', type: 'text', maxlength: '5', autocomplete: 'off', spellcheck: 'false',
      placeholder: '12h', title: '0 = permanent, or a number with m h d w M y — 30m, 12h, 5d, 2w, 1M, 1y',
      'aria-label': ariaLabel + ' (custom)',
    });
    const v0 = value == null ? '' : String(value);
    if (TPL_INTERVALS.some(([v]) => v === v0)) sel.value = v0;
    else if (v0) { sel.value = 'custom'; custom.value = v0; }
    else sel.value = '1d';
    const read = () => (sel.value === 'custom' ? custom.value.trim() : sel.value);
    const sync = () => custom.classList.toggle('hidden', sel.value !== 'custom');
    sel.addEventListener('change', () => {
      sync();
      if (sel.value === 'custom') custom.focus();
      onChange(read());
    });
    custom.addEventListener('input', () => { custom.classList.remove('invalid'); onChange(read()); });
    if (disabled) { sel.disabled = true; custom.disabled = true; }
    sync();
    return { el: el('div', { class: 'adm-int' }, sel, custom), value: read, custom };
  }

  /* copy text with a label flash; on a refused clipboard the text node is
   * selected so Ctrl+C still works */
  async function copyWithFlash(btn, text, node) {
    try {
      await navigator.clipboard.writeText(String(text));
      const lab = btn.querySelector('.adm-btn-label');
      const was = lab ? lab.textContent : '';
      if (lab) lab.textContent = 'Copied';
      btn.classList.add('is-done');
      setTimeout(() => { if (lab) lab.textContent = was; btn.classList.remove('is-done'); }, 1500);
    } catch (_e) {
      if (node) {
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
      SW.ui.toast('Copy failed — the line is selected, press Ctrl+C', 'warn');
    }
  }

  /* <dbdir>/evidence: evidence files sit next to the database (BATCH3 §1) */
  function evidenceDirOf(dbPath) {
    if (typeof dbPath !== 'string' || !dbPath || dbPath === ':memory:') return null;
    const cut = Math.max(dbPath.lastIndexOf('/'), dbPath.lastIndexOf('\\'));
    return (cut >= 0 ? dbPath.slice(0, cut + 1) : '') + 'evidence';
  }

  /* ctx.query.focus scrolls to a card: quick-commands, battlemetrics,
   * remote-bans, reason-templates, admin-calls, join-alerts, evidence */
  function renderSettings(main, ctx) {
    const unsubs = [];
    let disposed = false;
    this.cleanup = () => { disposed = true; unsubs.forEach((u) => u()); };
    const view = el('div', { class: 'view view-settings adm fade-in' });
    main.append(view);
    const head = pageHead('Settings',
      'Link your Squad server, tune detection and wire up integrations. Saved changes apply live.');
    view.append(head.el);
    const root = el('div', { class: 'adm-col is-loose' });
    view.append(root);
    root.append(settingsSkeleton());

    (async () => {
      let r;
      try { r = await SW.api('/api/settings'); }
      catch (_e) {
        if (disposed) return;
        root.textContent = '';
        root.append(emptyCard('settings', 'Could not load settings', 'This page needs the settings permission and a reachable A3 Admin server.'));
        return;
      }
      if (disposed) return;
      root.textContent = '';
      build(r || {});
    })();

    function kvList(pairs) {
      const dl = el('dl', { class: 'adm-kv-list' });
      for (const [k, v, mod] of pairs) {
        dl.append(el('dt', { text: k }));
        const dd = el('dd', { class: mod && v != null && v !== '' ? 'is-' + mod : null });
        if (v == null || v === '') dd.textContent = '—';
        else if (v.nodeType) dd.append(v);
        else { dd.textContent = String(v); dd.title = String(v); }
        dl.append(dd);
      }
      return dl;
    }

    function stateLine(state, text) {
      return el('div', { class: 'adm-state is-' + state }, dot(state), el('span', { class: 'truncate', text }));
    }

    function build(data) {
      const st = data.status || {};
      const cfg = data.config;
      const cfgObj = cfg && typeof cfg === 'object' ? cfg : {};
      const secrets = data.secretsSet || {};
      const demo = data.demo === true;

      /* =================== editable configuration (§3) ===================
       * Four cards, each saving its own partial patch via POST /api/settings
       * (applied live — no restart). Secret fields are never prefilled:
       * blank = keep (null), Clear = '' (clear), typed text = set. In --demo
       * mode everything renders disabled (the POST would 403 anyway). */

      function textInput(value, o) {
        o = o || {};
        const i = el('input', {
          class: 'input' + (o.mono ? ' mono' : ''),
          type: o.type || 'text',
          placeholder: o.placeholder || '',
          'aria-label': o.label || null,
          spellcheck: o.mono ? 'false' : null,
        });
        if (value != null && value !== '') i.value = String(value);
        if (demo) i.disabled = true;
        return i;
      }
      function numInput(value, o) { return textInput(value, Object.assign({ type: 'number' }, o)); }
      function checkInput(checked, labelText, tile) {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !!checked;
        if (demo) cb.disabled = true;
        const wrap = el('label', { class: tile ? 'adm-check-tile' : 'adm-check' }, cb, el('span', { text: labelText }));
        return { el: wrap, input: cb };
      }
      function secretInput(isSet, ariaLabel) {
        let saved = !!isSet;
        const keepPh = () => (saved ? '•••••• saved — leave blank to keep' : 'not set');
        const i = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: keepPh(), 'aria-label': ariaLabel || 'secret' });
        if (demo) i.disabled = true;
        let cleared = false;
        const clearBtn = el('button', { type: 'button', class: 'btn ghost small', text: 'Clear' });
        if (demo || !saved) clearBtn.disabled = true;
        clearBtn.addEventListener('click', () => {
          cleared = !cleared;
          i.value = '';
          i.disabled = cleared || demo;
          i.placeholder = cleared ? 'will be cleared on Save' : keepPh();
          clearBtn.textContent = cleared ? 'Keep saved' : 'Clear';
        });
        return {
          el: el('div', { class: 'adm-secret' }, i, clearBtn),
          /* null = keep, '' = clear, string = set */
          value() {
            if (cleared) return '';
            return i.value === '' ? null : i.value;
          },
          isSet() { return saved; },
          /* after a save that carried value(): back to "saved, blank keeps" */
          markSaved() {
            if (cleared) saved = false;
            else if (i.value !== '') saved = true;
            cleared = false;
            i.value = '';
            i.disabled = !!demo;
            i.placeholder = keepPh();
            clearBtn.textContent = 'Clear';
            clearBtn.disabled = !!demo || !saved;
          },
        };
      }
      function numOrSkip(input, obj, key) {
        const v = String(input.value).trim();
        if (v === '') return; /* partial patch — untouched fields stay */
        obj[key] = Number(v);
      }
      function testResult() {
        const box = el('span', { class: 'adm-test', role: 'status' });
        return {
          el: box,
          set(state, text) {
            box.className = 'adm-test' + (state ? ' is-' + state : '');
            box.textContent = '';
            if (!text) return;
            box.append(dot(state === 'busy' ? 'busy' : state), el('span', { class: 'adm-test-text', text }));
          },
        };
      }
      function group(title, cls) {
        const gEl = el('div', { class: 'adm-group' + (cls ? ' ' + cls : '') }, el('div', { class: 'adm-subhead', text: title }));
        for (let i = 2; i < arguments.length; i++) { if (arguments[i]) gEl.append(arguments[i]); }
        return gEl;
      }
      /* -> true when the patch was applied (persisted or not) */
      async function saveCard(btn, patch, okText) {
        btn.disabled = true;
        let ok = false;
        try {
          const res = await SW.api('/api/settings', { method: 'POST', body: patch });
          ok = true;
          if (res && res.persistError) {
            SW.ui.toast('Applied live, but config.json was not written: ' + res.persistError, 'warn', { sticky: true });
          } else {
            SW.ui.toast(okText || 'Saved — applied live', 'ok');
          }
        } catch (_e) { /* toasted by SW.api (a 400 lists the validation problems) */ }
        btn.disabled = false;
        return ok;
      }

      if (demo) {
        head.actions.append(SW.ui.badge('demo · read-only', 'warn'));
        const note = el('div', { class: 'notice-banner' });
        note.append(el('span', { class: 'notice-icon', html: SW.icon('lock') }));
        note.append(el('span', { class: 'grow', text: 'Demo settings are fixed — every field below is read-only. Run A3 Admin without --demo to link your own server.' }));
        root.append(note);
      }

      /* ---- Squad server ---- */
      const sq = cfgObj.squad || {};
      const sv = card('Squad server', { class: 'adm-set-server' });
      const svPill = el('span', { class: 'adm-pill' });
      sv.actions.append(svPill);
      if (!demo && !data.linked && !(st.rcon && st.rcon.connected)) {
        const co = el('div', { class: 'callout' });
        co.innerHTML = SW.icon('radio');
        co.append(el('span', { text: 'No Squad server linked yet — enter your RCON details, hit Test connection, then Save.' }));
        sv.body.append(co);
      }
      const svHost = textInput(sq.rconHost, { placeholder: 'e.g. 203.0.113.10', mono: true, label: 'RCON host' });
      const svPort = numInput(sq.rconPort, { placeholder: '21114', label: 'RCON port' });
      const svPass = secretInput(!!secrets.rconPassword, 'RCON password');
      sv.body.append(formGrid(
        field('RCON host', svHost, null, 'adm-w-4 adm-keep'),
        field('Port', svPort, null, 'adm-w-2 adm-keep'),
        field('RCON password', svPass.el, 'Leave blank to keep the saved password.')));
      const svTest = iconBtn('Test connection', 'live', 'ghost small');
      const svTestOut = testResult();
      const svSave = iconBtn('Save', 'check', 'primary small');
      if (demo) { svTest.disabled = true; svSave.disabled = true; }
      sv.foot().append(svTest, svTestOut.el, svSave);

      /* one-shot probe — never touches the live RCON client */
      svTest.addEventListener('click', async () => {
        const host = svHost.value.trim();
        const port = Number(svPort.value);
        if (!host || !port) { SW.ui.toast('Enter the RCON host and port first', 'warn'); return; }
        svTest.disabled = true;
        svTestOut.set('busy', 'Connecting…');
        let res;
        try {
          res = await SW.api('/api/settings/test', {
            method: 'POST', toast: false,
            body: { rconHost: host, rconPort: port, rconPassword: svPass.value() },
          });
        } catch (err) {
          res = { ok: false, error: (err && err.message) || 'connection failed' };
        }
        if (res && res.ok) {
          svTestOut.set('ok', 'Connected: ' + (res.serverName || 'unknown server') + (res.players != null ? ', ' + res.players + ' players' : ''));
        } else {
          svTestOut.set('bad', (res && res.error) || 'connection failed');
        }
        svTest.disabled = false;
      });

      svSave.addEventListener('click', () => {
        const patch = { squad: { rconHost: svHost.value.trim(), rconPassword: svPass.value() } };
        numOrSkip(svPort, patch.squad, 'rconPort');
        saveCard(svSave, patch);
      });

      /* ---- Integrations ---- */
      const weC = cfgObj.webhookEvents || {};
      const it = card('Integrations', { class: 'adm-set-int' });
      const intHook = secretInput(!!secrets.discordWebhook, 'Discord webhook URL');
      const weDefs = [['flags', 'Flags'], ['bans', 'Bans'], ['kicks', 'Kicks'], ['warns', 'Warns'], ['matchEnd', 'Match end']];
      const weChecks = weDefs.map((d) => ({ key: d[0], check: checkInput(weC[d[0]], d[1], true) }));
      const intKey = secretInput(!!secrets.steamApiKey, 'Steam API key');
      it.body.append(
        group('Discord', '',
          field('Webhook URL', intHook.el, 'Event notifications are posted here.'),
          field('Send events for', el('div', { class: 'adm-checks' }, weChecks.map((x) => x.check.el)),
            'Flags also carries the join alerts: watchlisted and flagged players, possible ban evasion.')),
        group('Steam', '',
          field('Steam API key', intKey.el, 'Used to enrich player profiles.')));
      const intSave = iconBtn('Save', 'check', 'primary small');
      if (demo) intSave.disabled = true;
      it.foot().append(el('span', { class: 'adm-grow' }), intSave);
      intSave.addEventListener('click', () => {
        const patch = { discordWebhook: intHook.value(), steamApiKey: intKey.value(), webhookEvents: {} };
        for (const x of weChecks) patch.webhookEvents[x.key] = x.check.input.checked;
        /* the Join alerts card says whether Discord gets them */
        saveCard(intSave, patch).then((ok) => { if (ok) { Object.assign(weC, patch.webhookEvents); ja.syncDiscord(); } });
      });

      /* ---- BattleMetrics ban import (§3) ----
       * The token is a secret like the others: never prefilled, blank keeps
       * it. Ban lists and imports always run with the SAVED token, so a
       * freshly pasted one is saved before either. */
      const bmC = cfgObj.battlemetrics || {};
      const bmTokenSet = !!(secrets.battlemetricsToken || secrets.battlemetrics === true
        || secrets['battlemetrics.token'] || (typeof bmC.token === 'string' && bmC.token !== ''));
      const bm = card('BattleMetrics ban import', { class: 'adm-set-bm' });
      const bmPill = el('span', { class: 'adm-pill' });
      bm.actions.append(bmPill);
      const bmHow = el('div', { class: 'callout adm-bm-how' });
      bmHow.innerHTML = SW.icon('key');
      bmHow.append(el('span', {},
        'Create a token at ',
        el('a', { href: 'https://www.battlemetrics.com/developers', target: '_blank', rel: 'noopener noreferrer', text: 'battlemetrics.com/developers' }),
        ' with ban read access and paste it below — never in chat. It stays on the A3 Admin server and is never shown again.'));
      const bmToken = secretInput(bmTokenSet, 'BattleMetrics API token');
      const savedListId = bmC.banListId != null ? String(bmC.banListId) : '';
      const bmList = el('select', { class: 'input', 'aria-label': 'BattleMetrics ban list' });
      bmList.append(savedListId
        ? el('option', { value: savedListId, text: 'Saved list · ' + savedListId })
        : el('option', { value: '', text: 'Load ban lists to pick one' }));
      const bmLoad = iconBtn('Load ban lists', 'download', 'ghost small');
      const BM_LIST_HINT = 'Import now uses the list picked here; Save keeps it for auto-sync.';
      const bmListField = field('Ban list', el('div', { class: 'adm-inline' }, bmList, bmLoad), BM_LIST_HINT);
      const bmListHint = bmListField.querySelector('.hint');
      const bmAuto = checkInput(bmC.autoSync, 'Auto-sync — re-import on a schedule');
      const bmHours = numInput(bmC.syncHours, { placeholder: '6', label: 'Sync interval in hours' });
      const bmStatus = el('div', { class: 'adm-bm-status' });
      const bmLast = el('div', { class: 'adm-bm-last' });
      bm.body.append(el('div', { class: 'adm-groups adm-groups--2' },
        group('Connection', '', bmHow,
          field('API token', bmToken.el, 'Leave blank to keep the saved token.'),
          bmListField),
        group('Sync', '',
          formGrid(
            el('div', { class: 'adm-field' }, bmAuto.el),
            field('Every', unitInput(bmHours, 'h'), null, 'adm-w-3 adm-pair')),
          bmStatus, bmLast)));
      const bmImport = iconBtn('Import now', 'refresh', 'ghost small');
      const bmOut = testResult();
      const bmSave = iconBtn('Save', 'check', 'primary small');
      if (demo) {
        bmList.disabled = true;
        bmLoad.disabled = true;
        bmImport.disabled = true;
        bmSave.disabled = true;
      }
      bm.foot().append(bmImport, bmOut.el, bmSave);

      function bmWhen(ts) {
        const d = ts - Date.now();
        return el('span', { title: SW.ui.fmtTime(ts), text: d <= 0 ? 'due now' : 'in ' + SW.ui.fmtDur(d / 1000) });
      }
      function drawBmLast(res) {
        bmLast.textContent = '';
        bmLast.append(el('div', { class: 'adm-subhead', text: 'Last import' }), bmResultView(res));
      }
      function drawBmStatus(s) {
        bmStatus.textContent = '';
        if (!s || typeof s !== 'object') {
          setPill(bmPill, null, 'Status unknown');
          bmStatus.append(kvList([['Status', 'unavailable']]));
          return;
        }
        if (s.running) setPill(bmPill, 'busy', 'Importing');
        else if (s.configured) setPill(bmPill, 'ok', 'Ready');
        else setPill(bmPill, null, 'Not set up');
        const lastAt = toMs(g(s, 'lastSyncAt', 'last_sync_at'));
        const nextAt = toMs(g(s, 'nextSyncAt', 'next_sync_at'));
        bmStatus.append(kvList([
          ['Last sync', lastAt ? SW.ui.timeAgo(lastAt) : 'never'],
          ['Next sync', nextAt ? bmWhen(nextAt) : 'not scheduled'],
        ]));
        const lr = g(s, 'lastResult', 'last_result');
        if (lr && typeof lr === 'object') drawBmLast(lr);
      }

      /* status polls every 5 s while an import runs (also one started by
       * auto-sync, or one that outlived a proxy timeout) */
      let bmPoll = null;
      let bmSeq = 0;
      unsubs.push(() => { if (bmPoll) clearTimeout(bmPoll); });
      async function loadBmStatus() {
        const my = ++bmSeq;
        if (bmPoll) { clearTimeout(bmPoll); bmPoll = null; }
        let s = null;
        try { s = await SW.api('/api/battlemetrics/status', { toast: false }); } catch (_e) { s = null; }
        if (disposed || my !== bmSeq) return;
        drawBmStatus(s);
        if (s && s.running) bmPoll = setTimeout(loadBmStatus, 5000);
      }

      /* -> true once a saved token is in place (a pasted one is saved first) */
      async function bmEnsureToken(btn) {
        const t = bmToken.value();
        if (t === '') {
          SW.ui.toast('The token is marked for clearing — press Keep saved or paste a new one', 'warn');
          return false;
        }
        if (t === null) {
          if (bmToken.isSet()) return true;
          SW.ui.toast('Paste your BattleMetrics API token first', 'warn');
          return false;
        }
        const ok = await saveCard(btn, { battlemetrics: { token: t } }, 'BattleMetrics token saved');
        if (ok) bmToken.markSaved();
        return ok;
      }

      /* list names come from BattleMetrics — option text only */
      function fillBanLists(lists) {
        const want = bmList.value || savedListId;
        bmList.textContent = '';
        bmList.append(el('option', { value: '', text: lists.length ? 'Pick a ban list…' : 'No ban lists for this token' }));
        let found = false;
        for (const L of lists) {
          const id = L && L.id != null ? String(L.id) : '';
          if (!id) continue;
          const n = g(L, 'banCount', 'ban_count');
          const o = el('option', { value: id, text: String(L.name || 'Ban list ' + id) + (n != null ? ' · ' + SW.ui.fmtNum(n) + ' bans' : '') });
          if (id === want) { o.selected = true; found = true; }
          bmList.append(o);
        }
        if (want && !found) {
          bmList.append(el('option', { value: want, text: 'Saved list · ' + want + ' (not visible to this token)' }));
          bmList.value = want;
        }
        bmListHint.textContent = lists.length + (lists.length === 1 ? ' ban list' : ' ban lists') + ' found. ' + BM_LIST_HINT;
      }

      bmLoad.addEventListener('click', async () => {
        if (!(await bmEnsureToken(bmLoad))) return;
        bmLoad.disabled = true;
        try {
          const r = await SW.api('/api/battlemetrics/ban-lists');
          if (!disposed) fillBanLists(Array.isArray(r) ? r : listOf(r && (r.lists || r.banLists || r)));
        } catch (_e) { /* toasted — e.g. the token has no ban access */ }
        bmLoad.disabled = false;
      });

      bmSave.addEventListener('click', async () => {
        const patch = { battlemetrics: { banListId: bmList.value, autoSync: bmAuto.input.checked } };
        const tok = bmToken.value();
        if (tok !== null) patch.battlemetrics.token = tok;
        if (patch.battlemetrics.autoSync && !patch.battlemetrics.banListId) {
          SW.ui.toast('Auto-sync needs a ban list — Load ban lists and pick one', 'warn');
          return;
        }
        const hrs = String(bmHours.value).trim();
        if (hrs !== '') {
          const h = Number(hrs);
          if (!(h > 0)) {
            bmHours.classList.add('invalid');
            SW.ui.toast('The sync interval must be a positive number of hours', 'error');
            return;
          }
          patch.battlemetrics.syncHours = h;
        }
        bmHours.classList.remove('invalid');
        if (await saveCard(bmSave, patch)) {
          if (tok !== null) bmToken.markSaved();
          loadBmStatus();
        }
      });

      bmImport.addEventListener('click', async () => {
        if (!(await bmEnsureToken(bmImport))) return;
        const listId = bmList.value;
        if (!listId) { SW.ui.toast('Pick a ban list first — Load ban lists fetches them', 'warn'); return; }
        bmImport.disabled = true;
        setPill(bmPill, 'busy', 'Importing');
        bmOut.set('busy', 'Importing bans from BattleMetrics…');
        const res = await bmImportCall(listId);
        if (disposed) return;
        bmImport.disabled = false;
        if (res) {
          bmOut.set(bmErrors(res).length ? 'bad' : 'ok', bmSummary(res));
          drawBmLast(res);
        } else {
          bmOut.set('', '');
        }
        loadBmStatus();
      });

      /* ---- Quick commands (§2): the presets Admin tools and Raw command
       * show as one-press buttons. Ids key the "last state" read from the
       * audit log, so a row keeps its id when relabelled; new rows get one
       * from their label. ---- */
      function quickEditor() {
        const qc = card('Quick commands', { class: 'adm-set-qc', count: true });
        const list = el('div', { class: 'adm-qce-list', role: 'list', 'aria-label': 'Quick commands' });
        const addSel = el('select', { class: 'input adm-qce-common', 'aria-label': 'Add a common toggle' });
        const addBtn = iconBtn('Add command', 'plus', 'ghost small');
        const stateEl = el('span', { class: 'adm-note adm-grow adm-qce-state' });
        const saveBtn = iconBtn('Save', 'check', 'primary small');
        addSel.disabled = true;
        addBtn.disabled = true;
        saveBtn.disabled = true;
        qc.body.append(
          el('p', {
            class: 'adm-note',
            text: 'One-press presets on Admin tools and Raw command for roles with Run quick commands. A toggle sends its command with 1 (ON) or 0 (OFF); anything else runs exactly as written.',
          }),
          list,
          el('div', { class: 'adm-qce-add' }, addSel, addBtn));
        qc.foot().append(stateEl, saveBtn);

        let model = []; /* [{key, id|null, idHint?, label, command, toggle}] */
        let savedSig = '[]';
        let keySeq = 0;
        let loaded = false;
        const sig = () => JSON.stringify(model.map((x) => [x.id || '', x.label.trim(), x.command.trim(), !!x.toggle]));

        function syncState() {
          if (!loaded) return;
          const dirty = sig() !== savedSig;
          stateEl.textContent = (dirty ? 'Unsaved changes · ' : '') + model.length + ' of ' + QC_MAX;
          stateEl.classList.toggle('is-dirty', dirty);
          saveBtn.disabled = demo || !dirty;
        }

        /* common toggles already in the list are greyed out */
        function fillCommon() {
          const have = new Set(model.map((x) => x.command.trim().toLowerCase()));
          addSel.textContent = '';
          addSel.append(el('option', { value: '', text: 'Add a common toggle…' }));
          QC_COMMON.forEach((t, i) => {
            const added = have.has(t.command.toLowerCase());
            const o = el('option', { value: String(i), text: t.label + ' — ' + t.command + (added ? ' (added)' : '') });
            if (added) o.disabled = true;
            addSel.append(o);
          });
          addSel.value = '';
          const full = model.length >= QC_MAX;
          addSel.disabled = demo || full;
          addBtn.disabled = demo || full;
        }
        const fillCommonSoon = debounce(fillCommon, 300);

        function rowByKey(key) {
          for (const n of Array.from(list.children)) {
            if (n.dataset && n.dataset.key === String(key)) return n;
          }
          return null;
        }

        function rowEl(item, i) {
          const n = i + 1;
          const lab = el('input', {
            class: 'input adm-qce-label', type: 'text', maxlength: String(QC_LABEL_MAX), autocomplete: 'off',
            placeholder: 'Label, e.g. No respawn timer', 'aria-label': 'Label of quick command ' + n,
          });
          lab.value = item.label;
          const cmd = el('input', {
            class: 'input mono adm-qce-cmd', type: 'text', maxlength: '265', autocomplete: 'off', spellcheck: 'false',
            placeholder: 'RCON command, e.g. AdminNoRespawnTimer', 'aria-label': 'Command of quick command ' + n,
          });
          cmd.value = item.command;
          const tg = el('input', { type: 'checkbox', 'aria-label': 'Quick command ' + n + ' is an ON / OFF toggle' });
          tg.checked = !!item.toggle;
          const up = el('button', { type: 'button', class: 'btn ghost small icon-only', title: 'Move up', 'aria-label': 'Move quick command ' + n + ' up', dataset: { act: 'up' } });
          up.innerHTML = SW.icon('chevron-up');
          const down = el('button', { type: 'button', class: 'btn ghost small icon-only', title: 'Move down', 'aria-label': 'Move quick command ' + n + ' down', dataset: { act: 'down' } });
          down.innerHTML = SW.icon('chevron-down');
          const del = el('button', { type: 'button', class: 'btn danger ghost small icon-only', title: 'Remove', 'aria-label': 'Remove quick command ' + n, dataset: { act: 'del' } });
          del.innerHTML = SW.icon('trash');
          up.disabled = demo || i === 0;
          down.disabled = demo || i === model.length - 1;
          if (demo) {
            lab.disabled = true;
            cmd.disabled = true;
            tg.disabled = true;
            del.disabled = true;
          }
          lab.addEventListener('input', () => { item.label = lab.value; lab.classList.remove('invalid'); syncState(); });
          cmd.addEventListener('input', () => { item.command = cmd.value; cmd.classList.remove('invalid'); syncState(); fillCommonSoon(); });
          tg.addEventListener('change', () => { item.toggle = tg.checked; cmd.classList.remove('invalid'); syncState(); });
          return el('div', { class: 'adm-qce-row', role: 'listitem', dataset: { key: String(item.key) } },
            el('span', { class: 'adm-qce-num', 'aria-hidden': 'true', text: String(n) }),
            lab, cmd,
            el('label', { class: 'adm-check adm-qce-toggle', title: 'ON sends 1, OFF sends 0' }, tg, el('span', { text: 'ON / OFF' })),
            el('div', { class: 'adm-qce-acts' }, up, down, del));
        }

        /* focusAct: the button to land on after a move / remove (keyboard) */
        function draw(focusKey, focusAct) {
          list.textContent = '';
          qc.setCount(model.length);
          if (!model.length) {
            list.append(emptyState('zap', 'No quick commands', 'Add a common toggle below, or any RCON command.', null, true));
          } else {
            list.append(el('div', { class: 'adm-qce-head', 'aria-hidden': 'true' },
              el('span', { text: '#' }), el('span', { text: 'Label' }), el('span', { text: 'Command' }),
              el('span', { text: 'Mode' }), el('span')));
            model.forEach((item, i) => list.append(rowEl(item, i)));
          }
          fillCommon();
          syncState();
          const r = focusKey != null ? rowByKey(focusKey) : null;
          if (!r) return;
          let b = focusAct ? r.querySelector('button[data-act="' + focusAct + '"]') : r.querySelector('input');
          if (b && b.disabled && focusAct) b = r.querySelector('button[data-act="' + (focusAct === 'up' ? 'down' : 'up') + '"]');
          if (b && !b.disabled) b.focus();
        }

        list.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-act]');
          if (!b || !list.contains(b) || b.disabled) return;
          const r = b.closest('.adm-qce-row');
          const i = r ? model.findIndex((x) => String(x.key) === r.dataset.key) : -1;
          if (i < 0) return;
          const act = b.dataset.act;
          if (act === 'del') {
            model.splice(i, 1);
            const next = model[i] || model[i - 1];
            draw(next ? next.key : null, 'del');
            if (!next) addBtn.focus();
            return;
          }
          const j = act === 'up' ? i - 1 : i + 1;
          if (j < 0 || j >= model.length) return;
          const t = model[i];
          model[i] = model[j];
          model[j] = t;
          draw(t.key, act);
        });

        function add(item, focusLabel) {
          if (model.length >= QC_MAX) { SW.ui.toast('Up to ' + QC_MAX + ' quick commands', 'warn'); return; }
          item.key = ++keySeq;
          model.push(item);
          draw(focusLabel ? item.key : null);
          const r = rowByKey(item.key);
          if (r && !focusLabel) r.scrollIntoView({ block: 'nearest' });
        }
        addSel.addEventListener('change', () => {
          const t = addSel.value === '' ? null : QC_COMMON[Number(addSel.value)];
          if (t) add({ id: null, idHint: t.id, label: t.label, command: t.command, toggle: true }, false);
        });
        addBtn.addEventListener('click', () => add({ id: null, label: '', command: '', toggle: false }, true));

        /* the server's rules, checked first; marks bad inputs -> problems */
        function validate() {
          const problems = [];
          if (model.length > QC_MAX) problems.push('At most ' + QC_MAX + ' quick commands.');
          model.forEach((item, i) => {
            const r = rowByKey(item.key);
            const lab = r && r.querySelector('.adm-qce-label');
            const cmd = r && r.querySelector('.adm-qce-cmd');
            const at = 'Row ' + (i + 1) + ': ';
            const label = item.label.trim();
            const command = item.command.trim();
            const labBad = !label || Array.from(label).length > QC_LABEL_MAX; /* code points, as the server counts */
            let cmdBad = '';
            if (!QC_CMD_RE.test(command)) {
              cmdBad = at + 'start with an RCON command word (a letter, then letters, digits or _ — 3 to 64 characters), then up to 200 characters of arguments.';
            } else if (item.toggle && !QC_TOGGLE_RE.test(command)) {
              cmdBad = at + 'a toggle is a single command word — A3 Admin adds the 1 or 0.';
            }
            if (labBad) problems.push(at + 'the label needs 1–' + QC_LABEL_MAX + ' characters.');
            if (cmdBad) problems.push(cmdBad);
            if (lab) { lab.classList.toggle('invalid', labBad); lab.setAttribute('aria-invalid', String(labBad)); }
            if (cmd) { cmd.classList.toggle('invalid', !!cmdBad); cmd.setAttribute('aria-invalid', String(!!cmdBad)); }
          });
          return problems;
        }

        /* valid ids stay; the rest come from the toggle hint, the label or
         * the command, made unique with -2, -3 … */
        function assignIds() {
          return uniqueIds(model, QC_ID_RE, (x, taken) =>
            (x.idHint && !taken.has(x.idHint) ? x.idHint : '') || slugOf(x.label) || slugOf(x.command) || 'command');
        }

        function setModel(rows) {
          model = rows.map((x) => ({ key: ++keySeq, id: x.id, label: x.label, command: x.command, toggle: !!x.toggle }));
          loaded = true;
          savedSig = sig();
          draw(null);
        }

        saveBtn.addEventListener('click', async () => {
          const problems = validate();
          if (problems.length) {
            SW.ui.toast(problems[0] + (problems.length > 1 ? ' (+' + (problems.length - 1) + ' more)' : ''), 'error');
            return;
          }
          const ids = assignIds();
          const rows = model.map((x, i) => ({ id: ids[i], label: x.label.trim(), command: x.command.trim(), toggle: !!x.toggle }));
          saveBtn.disabled = true;
          let res = null;
          try { res = await SW.api('/api/quick-commands', { method: 'POST', body: { rows } }); }
          catch (_e) { /* toasted — a 400 names the bad row */ }
          if (disposed) return;
          if (res) {
            setModel(Array.isArray(res.rows) ? qcRows(res) : rows);
            SW.ui.toast('Quick commands saved', 'ok');
          } else {
            syncState();
          }
        });

        async function load() {
          list.textContent = '';
          list.append(skeletonRows(3));
          let r;
          try { r = await SW.api('/api/quick-commands', { toast: false }); }
          catch (e) {
            if (disposed) return;
            list.textContent = '';
            list.append(emptyState('zap', 'Could not load quick commands',
              (e && e.message) || 'The server did not answer.',
              { label: 'Retry', icon: 'refresh', onClick: load }, true));
            return;
          }
          if (disposed) return;
          setModel(qcRows(r));
        }
        return Object.assign(qc, { ready: load() });
      }
      const qe = SW.can('settings') ? quickEditor() : null;

      /* ---- Game log source ---- */
      const lgC = cfgObj.log || {};
      const ftpC = lgC.ftp || {};
      const sftpC = lgC.sftp || {};
      const src = card('Game log source', { class: 'adm-set-log' });
      const logPill = el('span', { class: 'adm-pill' });
      src.actions.append(logPill);
      let mode = lgC.mode === 'ftp' || lgC.mode === 'sftp' ? lgC.mode : 'local';
      const modeSeg = segmented(
        [{ value: 'local', label: 'Local file' }, { value: 'ftp', label: 'FTP' }, { value: 'sftp', label: 'SFTP' }],
        mode, (v) => { mode = v; syncModeBoxes(); }, { label: 'Log source mode' });
      if (demo) modeSeg.disable();

      const localPath = textInput(lgC.path, { mono: true, placeholder: '…\\SquadGame\\Saved\\Logs\\SquadGame.log', label: 'Log file path' });
      const localBox = formGrid(field('SquadGame.log path', localPath, 'The log file on the machine running A3 Admin.'));

      const ftpHost = textInput(ftpC.host, { mono: true, label: 'FTP host' });
      const ftpPort = numInput(ftpC.port, { placeholder: '21', label: 'FTP port' });
      const ftpUser = textInput(ftpC.user, { label: 'FTP user' });
      const ftpPass = secretInput(!!secrets.ftpPassword, 'FTP password');
      const ftpPath = textInput(ftpC.path, { mono: true, label: 'FTP remote log path' });
      const ftpSecure = checkInput(ftpC.secure, 'FTPS (encrypted) — strongly recommended');
      const ftpBox = formGrid(
        field('Host', ftpHost, null, 'adm-w-4 adm-keep'),
        field('Port', ftpPort, null, 'adm-w-2 adm-keep'),
        field('User', ftpUser, null, 'adm-w-3'),
        field('Password', ftpPass.el, null, 'adm-w-3'),
        field('Remote log path', ftpPath),
        el('div', { class: 'adm-field' }, ftpSecure.el,
          el('div', { class: 'hint', text: 'ftp mode needs the optional basic-ftp npm package — install name is in the README.' })));
      ftpBox.classList.add('hidden');

      const sftpHost = textInput(sftpC.host, { mono: true, label: 'SFTP host' });
      const sftpPort = numInput(sftpC.port, { placeholder: '22', label: 'SFTP port' });
      const sftpUser = textInput(sftpC.user, { label: 'SFTP user' });
      const sftpPass = secretInput(!!secrets.sftpPassword, 'SFTP password');
      const sftpKey = textInput(sftpC.privateKeyPath, { mono: true, label: 'SFTP private key path' });
      const sftpPath = textInput(sftpC.path, { mono: true, label: 'SFTP remote log path' });
      const sftpBox = formGrid(
        field('Host', sftpHost, null, 'adm-w-4 adm-keep'),
        field('Port', sftpPort, null, 'adm-w-2 adm-keep'),
        field('User', sftpUser, null, 'adm-w-3'),
        field('Password', sftpPass.el, 'Or point at a private key.', 'adm-w-3'),
        field('Private key path', sftpKey, null, 'adm-w-3'),
        field('Remote log path', sftpPath, null, 'adm-w-3'),
        el('div', { class: 'adm-field' },
          el('div', { class: 'hint', text: 'sftp mode needs the optional ssh2-sftp-client npm package — install name is in the README.' })));
      sftpBox.classList.add('hidden');

      function syncModeBoxes() {
        localBox.classList.toggle('hidden', mode !== 'local');
        ftpBox.classList.toggle('hidden', mode !== 'ftp');
        sftpBox.classList.toggle('hidden', mode !== 'sftp');
      }
      syncModeBoxes();

      const srcPoll = numInput(lgC.pollMs, { placeholder: '1500', label: 'Poll interval ms' });
      const srcTz = numInput(lgC.timezoneOffsetMinutes, { placeholder: '0', label: 'Timezone offset minutes' });
      const srcBackfill = checkInput(lgC.backfill, 'Backfill — parse the whole existing log on start');
      src.body.append(el('div', { class: 'adm-groups adm-groups--2' },
        group('Source', '', field('Mode', modeSeg.el), localBox, ftpBox, sftpBox),
        group('Polling', '',
          formGrid(
            field('Poll interval', unitInput(srcPoll, 'ms'), null, 'adm-w-3 adm-pair'),
            field('Timezone offset', unitInput(srcTz, 'min'), null, 'adm-w-3 adm-pair'),
            el('div', { class: 'adm-field' }, srcBackfill.el)))));

      function buildLogSettings() {
        const lg = { mode, backfill: srcBackfill.input.checked };
        numOrSkip(srcPoll, lg, 'pollMs');
        numOrSkip(srcTz, lg, 'timezoneOffsetMinutes');
        if (mode === 'local') lg.path = localPath.value.trim();
        if (mode === 'ftp') {
          lg.ftp = { host: ftpHost.value.trim(), user: ftpUser.value.trim(), path: ftpPath.value.trim(), secure: ftpSecure.input.checked, password: ftpPass.value() };
          numOrSkip(ftpPort, lg.ftp, 'port');
        }
        if (mode === 'sftp') {
          lg.sftp = { host: sftpHost.value.trim(), user: sftpUser.value.trim(), privateKeyPath: sftpKey.value.trim(), path: sftpPath.value.trim(), password: sftpPass.value() };
          numOrSkip(sftpPort, lg.sftp, 'port');
        }
        return lg;
      }
      const srcTest = iconBtn('Test', 'live', 'ghost small');
      const srcTestOut = testResult();
      const srcSave = iconBtn('Save', 'check', 'primary small');
      if (demo) { srcTest.disabled = true; srcSave.disabled = true; }
      src.foot().append(srcTest, srcTestOut.el, srcSave);
      srcTest.addEventListener('click', async () => {
        srcTest.disabled = true;
        srcTestOut.set('busy', 'Checking…');
        let res;
        try {
          res = await SW.api('/api/settings/test', { method: 'POST', toast: false, body: { log: buildLogSettings() } });
        } catch (err) {
          res = { ok: false, error: (err && err.message) || 'check failed' };
        }
        if (res && res.ok) {
          srcTestOut.set('ok', 'Log found' + (res.sizeBytes != null ? ' — ' + SW.ui.fmtNum(res.sizeBytes) + ' bytes' : ''));
        } else {
          srcTestOut.set('bad', (res && res.error) || 'check failed');
        }
        srcTest.disabled = false;
      });
      srcSave.addEventListener('click', () => {
        saveCard(srcSave, { log: buildLogSettings() });
      });

      /* ---- Detection & housekeeping ---- */
      const flC = cfgObj.flags || {};
      const rtC = cfgObj.retention || {};
      const webC = cfgObj.web || {};
      /* a public URL the server can build links from: an absolute http(s)
       * address, as server/remotebans.js reads it */
      function httpUrlOk(s) {
        try {
          const u = new URL(String(s));
          return u.protocol === 'https:' || u.protocol === 'http:';
        } catch (_e) { return false; }
      }
      let savedPublic = typeof webC.publicUrl === 'string' ? webC.publicUrl.trim() : '';
      const dt = card('Detection & housekeeping', { class: 'adm-set-detect' });
      const hkSpree = numInput(flC.tkSpreeCount, { placeholder: '3', label: 'TK spree count' });
      const hkSpreeWin = numInput(flC.tkSpreeWindowSec, { placeholder: '180', label: 'TK spree window seconds' });
      const hkMass = numInput(flC.massTkCount, { placeholder: '5', label: 'Mass TK count' });
      const hkNewMin = numInput(flC.newPlayerMinutes, { placeholder: '15', label: 'New player minutes' });
      const hkWatch = el('textarea', { class: 'input mono', rows: '5', placeholder: 'one pattern per line', 'aria-label': 'Chat watchlist patterns', spellcheck: 'false' });
      if (Array.isArray(flC.chatWatchlist) && flC.chatWatchlist.length) hkWatch.value = flC.chatWatchlist.join('\n');
      if (demo) hkWatch.disabled = true;
      const hkAuto = checkInput(cfgObj.autoWarnTeamkiller, 'Auto-warn teamkillers');
      const hkAutoMsg = textInput(cfgObj.autoWarnMessage, { placeholder: 'Teamkill detected: {victim}…', label: 'Auto-warn message' });
      const hkChatDays = numInput(rtC.chatDays, { placeholder: '0', label: 'Chat retention days' });
      const hkPopDays = numInput(rtC.popDays, { placeholder: '30', label: 'Population retention days' });
      const hkPublic = textInput(webC.publicUrl, { mono: true, placeholder: 'https://panel.example.com', label: 'Public URL' });
      dt.body.append(el('div', { class: 'adm-groups adm-groups--3' },
        group('Teamkill detection', '',
          formGrid(
            field('Spree count', hkSpree, null, 'adm-w-3 adm-pair'),
            field('Spree window', unitInput(hkSpreeWin, 's'), null, 'adm-w-3 adm-pair'),
            field('Mass TK count', hkMass, null, 'adm-w-3 adm-pair'),
            field('New player', unitInput(hkNewMin, 'min'), null, 'adm-w-3 adm-pair'),
            el('div', { class: 'adm-field' }, hkAuto.el),
            field('Auto-warn message', hkAutoMsg, '{victim} is replaced with the victim\'s name.'))),
        group('Chat watchlist', '',
          field('Patterns', hkWatch, 'One pattern per line — chat matching any of them raises a flag.')),
        group('Housekeeping', '',
          formGrid(
            field('Chat retention', unitInput(hkChatDays, 'days'), '0 keeps chat forever.', 'adm-w-3 adm-pair'),
            field('Pop samples', unitInput(hkPopDays, 'days'), null, 'adm-w-3 adm-pair'),
            field('Public URL', hkPublic, 'The address A3 Admin is reached at — builds invite links and the remote ban list line.')))));
      const hkSave = iconBtn('Save', 'check', 'primary small');
      if (demo) hkSave.disabled = true;
      dt.foot().append(el('span', { class: 'adm-grow' }), hkSave);
      hkSave.addEventListener('click', () => {
        const pub = hkPublic.value.trim();
        const pubBad = pub !== '' && !httpUrlOk(pub);
        hkPublic.classList.toggle('invalid', pubBad);
        if (pubBad) {
          SW.ui.toast('The Public URL must be a full address starting with https:// — e.g. https://panel.example.com', 'error');
          hkPublic.focus();
          return;
        }
        const lines = hkWatch.value.split('\n').map((s) => s.trim()).filter(Boolean);
        const patch = {
          flags: { chatWatchlist: lines },
          autoWarnTeamkiller: hkAuto.input.checked,
          autoWarnMessage: hkAutoMsg.value,
          retention: {},
          web: { publicUrl: pub },
        };
        numOrSkip(hkSpree, patch.flags, 'tkSpreeCount');
        numOrSkip(hkSpreeWin, patch.flags, 'tkSpreeWindowSec');
        numOrSkip(hkMass, patch.flags, 'massTkCount');
        numOrSkip(hkNewMin, patch.flags, 'newPlayerMinutes');
        numOrSkip(hkChatDays, patch.retention, 'chatDays');
        numOrSkip(hkPopDays, patch.retention, 'popDays');
        if (!Object.keys(patch.retention).length) delete patch.retention;
        /* the remote ban list line is built from the public URL */
        saveCard(hkSave, patch).then((ok) => { if (ok) { savedPublic = pub; rb.load(); } });
      });
      hkPublic.addEventListener('input', () => hkPublic.classList.remove('invalid'));

      /* ---- Remote ban list (BATCH3 §3) ----
       * Squad downloads ban files from the URLs listed in the game server's
       * RemoteBanListHosts.cfg. The URL carries a secret key and comes only
       * from GET /api/remote-bans (the config dump masks the key). On / off
       * and EOS ids apply at once through POST /api/remote-bans; a new key
       * through …/rotate. */
      const RB_FILE = 'SquadGame/ServerConfig/RemoteBanListHosts.cfg';
      function remoteBansCard() {
        const c = card('Remote ban list', { class: 'adm-set-rb' });
        const pill = el('span', { class: 'adm-pill' });
        c.actions.append(pill);
        const on = toggleRow(false, 'Serve the ban list to the game server',
          'Squad then enforces every active A3 Admin ban by itself — no Bans.cfg editing.');
        const eos = toggleRow(false, 'Include EOS IDs', 'Also lists bans that only carry the player\'s EOS ID.');
        on.input.disabled = true;
        eos.input.disabled = true;

        const lineCode = el('code', { class: 'adm-rb-code', tabindex: '0', 'aria-label': 'Your remote ban list line' });
        const copyBtn = iconBtn('Copy line', 'copy', 'primary small');
        const rotateBtn = iconBtn('New key', 'key', 'ghost small');
        rotateBtn.title = 'Make a new secret key — the current line stops working';
        const lineBox = el('div', { class: 'adm-rb-line hidden' }, lineCode, el('div', { class: 'adm-rb-line-acts' }, copyBtn, rotateBtn));
        const lineMsg = el('div', { class: 'adm-rb-linemsg' });

        const steps = el('ol', { class: 'adm-steps' });
        function step(title, body, extra) {
          steps.append(el('li', { class: 'adm-step' },
            el('span', { class: 'adm-step-title', text: title }),
            el('span', { class: 'adm-step-body', text: body }),
            extra || null));
        }
        step('Copy your line', 'Press Copy line — it is one URL on one line, key included.');
        step('Open the File Manager', 'In qPanel (Qonzer), open your Squad server, then File Manager.');
        /* the whole path stays readable (wrapped), the copy button pinned */
        step('Open RemoteBanListHosts.cfg', 'Go to this file — if it is missing, create it with exactly this name:',
          el('span', { class: 'adm-rb-file' }, el('code', { class: 'adm-rb-file-path', text: RB_FILE }), SW.ui.copyBtn(RB_FILE)));
        step('Paste it on its own line', 'Add the URL as a new line at the end, then save. Lines starting with // are comments — leave the other lines as they are.');
        step('Restart the game server', 'Restart it from qPanel — Squad reads this file when it starts.');
        step('Check it worked', 'After the restart, Last fetched shows when the game server downloaded the list, and from which address.');

        const status = el('div', { class: 'adm-rb-status' });
        c.body.append(
          callout('shield', 'info', 'Let the game server load its bans straight from A3 Admin. Every active ban — issued here or imported from BattleMetrics — is in the list, and lifting a ban takes it out.'),
          el('div', { class: 'adm-groups adm-groups--2' },
            group('Your line', 'adm-rb-setup', lineBox, lineMsg,
              el('div', { class: 'adm-subhead adm-steps-head', text: 'Set it up on the game server' }), steps),
            group('Status', 'adm-rb-side', on.el, eos.el, status)));
        const refresh = iconBtn('Refresh', 'refresh', 'ghost small');
        c.foot().append(el('span', { class: 'adm-note adm-grow', text: 'Switches here apply at once.' }), refresh);

        let st0 = null; /* last GET /api/remote-bans */
        let seq = 0;

        function goPublicUrl() {
          spotlight(dt.el);
          setTimeout(() => { try { hkPublic.focus({ preventScroll: true }); } catch (_e) { hkPublic.focus(); } }, 450);
        }

        function draw() {
          const enabled = !!st0.enabled;
          const url = typeof st0.url === 'string' ? st0.url : '';
          const lastAt = toMs(g(st0, 'lastFetchAt', 'last_fetch_at'));
          on.input.checked = enabled;
          eos.input.checked = !!st0.includeEos;
          on.input.disabled = demo;
          eos.input.disabled = demo;
          if (!enabled) setPill(pill, null, 'Off');
          else if (lastAt) setPill(pill, 'ok', 'Live');
          else setPill(pill, null, 'Not fetched yet');

          lineMsg.textContent = '';
          const showLine = enabled && !!url;
          lineBox.classList.toggle('hidden', !showLine);
          lineMsg.classList.toggle('hidden', showLine);
          if (showLine) {
            lineCode.textContent = url; /* server-built URL — textContent only */
            lineCode.title = url;
          } else if (!enabled) {
            lineMsg.append(callout('lock', 'info', 'Turn on “Serve the ban list to the game server” to get your line.'));
          } else if (savedPublic && httpUrlOk(savedPublic)) {
            /* the address is fine, so the list has no key yet (switched on
             * in config.json or through the settings API) */
            const make = el('button', { type: 'button', class: 'adm-link-btn', text: 'Make a key' });
            make.disabled = demo;
            make.addEventListener('click', () => rotateKey(make, false));
            lineMsg.append(callout('key', 'warn', [
              'The list has no secret key yet, so there is no line to copy. ', make, ' and the line appears here.',
            ]));
          } else {
            const go = el('button', { type: 'button', class: 'adm-link-btn', text: savedPublic ? 'Fix the Public URL' : 'Set the Public URL' });
            go.addEventListener('click', goPublicUrl);
            lineMsg.append(callout('alert-circle', 'warn', savedPublic
              ? ['The saved Public URL is not a full web address, so the line cannot be built — it must start with https://, for example https://panel.a3server.online. ',
                go, ', save it, and the line appears here.']
              : ['A3 Admin needs its public address to build the line — for example https://panel.a3server.online. ',
                go, ', save it, and the line appears here.']));
          }
          rotateBtn.disabled = demo || !enabled;

          const lines = num(g(st0, 'lines'));
          const skipped = num(g(st0, 'skippedNoSteam', 'skipped_no_steam'));
          const from = g(st0, 'lastFetchFrom', 'last_fetch_from');
          status.textContent = '';
          status.append(kvList([
            ['Lines served', enabled ? SW.ui.fmtNum(lines) : 'none — switched off'],
            ['Last fetched', lastAt ? SW.ui.timeAgo(lastAt) : 'not yet'],
            ['Fetched by', from ? String(from) : null],
          ]));
          if (enabled && skipped > 0) {
            const many = skipped !== 1;
            status.append(el('p', {
              class: 'adm-note',
              text: st0.includeEos
                ? SW.ui.fmtNum(skipped) + (many ? ' active bans have' : ' active ban has') + ' neither a SteamID nor an EOS ID, so the game server cannot be told about ' + (many ? 'them.' : 'it.')
                : SW.ui.fmtNum(skipped) + (many ? ' active bans have' : ' active ban has') + ' no SteamID and ' + (many ? 'are' : 'is') + ' left out — Include EOS IDs lists the ones that have an EOS ID.',
            }));
          }
          status.append(el('p', { class: 'adm-note', text: 'Fetch times are kept in memory — restarting A3 Admin clears them.' }));
        }

        function drawError(e) {
          st0 = null;
          setPill(pill, 'bad', 'Unavailable');
          on.input.disabled = true;
          eos.input.disabled = true;
          rotateBtn.disabled = true;
          lineBox.classList.add('hidden');
          lineMsg.classList.remove('hidden');
          lineMsg.textContent = '';
          lineMsg.append(callout('alert-circle', 'warn', e && e.status === 404
            ? 'This A3 Admin build has no remote ban list yet — update A3 Admin and restart it.'
            : 'Could not read the remote ban list status — try Refresh in a moment.'));
          status.textContent = '';
        }

        async function load() {
          const my = ++seq;
          refresh.disabled = true;
          let r = null;
          let err = null;
          try { r = await SW.api('/api/remote-bans', { toast: false }); } catch (e) { err = e; }
          if (disposed || my !== seq) return;
          refresh.disabled = false;
          if (err) { drawError(err); return; }
          st0 = r && typeof r === 'object' ? r : {};
          draw();
        }

        function persistWarn(res) {
          if (res && res.persistError) {
            SW.ui.toast('Applied live, but config.json was not written: ' + res.persistError, 'warn', { sticky: true });
            return true;
          }
          return false;
        }

        /* the answer carries the fresh status */
        async function apply(patch, revert, okText) {
          on.input.disabled = true;
          eos.input.disabled = true;
          let res = null;
          try { res = await SW.api('/api/remote-bans', { method: 'POST', body: patch }); }
          catch (_e) { revert(); /* toasted by SW.api */ }
          if (disposed) return;
          if (res && !persistWarn(res)) SW.ui.toast(okText, 'ok');
          if (res && typeof res === 'object' && hasOwn(res, 'enabled')) {
            st0 = res;
            draw();
          } else {
            await load();
          }
        }

        on.input.addEventListener('change', async () => {
          const want = on.input.checked;
          if (!want) {
            const v = await SW.ui.confirmModal({
              title: 'Stop serving the ban list?',
              body: 'The game server gets nothing the next time it reads the list, so it stops enforcing A3 Admin bans by itself. A3 Admin still kicks banned players when they join.',
              danger: true,
              confirmText: 'Turn off',
            });
            if (!v) { on.input.checked = true; return; }
          }
          apply({ enabled: want }, () => { on.input.checked = !want; },
            want ? 'Remote ban list on — copy your line next' : 'Remote ban list off');
        });
        eos.input.addEventListener('change', () => {
          const want = eos.input.checked;
          apply({ includeEos: want }, () => { eos.input.checked = !want; }, want ? 'EOS IDs included' : 'EOS IDs left out');
        });
        copyBtn.addEventListener('click', () => {
          if (st0 && st0.url) copyWithFlash(copyBtn, st0.url, lineCode);
        });
        /* replacing: a line exists, and the new key breaks it on the game server */
        async function rotateKey(btn, replacing) {
          if (replacing) {
            const v = await SW.ui.confirmModal({
              title: 'Make a new key?',
              body: 'The current line stops working at once. Replace it in RemoteBanListHosts.cfg with the new line and restart the game server, or it stops receiving bans. Do this when the old line was shared by mistake.',
              danger: true,
              confirmText: 'Make a new key',
            });
            if (!v) return;
          }
          btn.disabled = true;
          try {
            const r = await SW.api('/api/remote-bans/rotate', { method: 'POST', body: {} });
            if (disposed) return;
            if (st0 && r && typeof r.url === 'string') { st0.url = r.url; draw(); }
            if (!persistWarn(r)) {
              if (replacing) SW.ui.toast('New key made — replace the line on the game server, then restart it', 'warn', { timeout: 9000 });
              else SW.ui.toast('Key made — copy your line next', 'ok');
            }
          } catch (_e) { /* toasted */ }
          if (!disposed) load();
        }
        rotateBtn.addEventListener('click', () => rotateKey(rotateBtn, true));
        refresh.addEventListener('click', () => load());
        return { el: c.el, load, ready: load() };
      }

      /* ---- Admin calls (BATCH3 §5): "!admin" in chat alerts the panel and
       * Discord; the caller gets a private in-game reply ---- */
      function adminCallsCard() {
        const C = cfgObj.adminCalls || {};
        const c = card('Admin calls', { class: 'adm-set-ac' });
        const en = toggleRow(C.enabled !== false, 'Players can call an admin from chat',
          'A chat line that starts with a trigger alerts everyone in the panel and on Discord.');
        if (demo) en.input.disabled = true;
        const trig = textInput(Array.isArray(C.triggers) ? C.triggers.join(', ') : '', { placeholder: '!admin', mono: true, label: 'Chat triggers' });
        /* an empty reply is saved as "send none" — the placeholder must not
         * read like a default still in use */
        const reply = textInput(C.reply, { placeholder: 'Empty — no reply is sent', label: 'In-game reply' });
        reply.maxLength = 200;
        const cool = numInput(C.cooldownSec, { placeholder: '60', label: 'Cooldown in seconds' });
        cool.min = '0';
        cool.step = '1';
        const role = textInput(C.discordRoleId, { placeholder: 'e.g. 112233445566778899', mono: true, label: 'Discord role ID' });
        role.inputMode = 'numeric';
        const howto = el('details', { class: 'adm-howto' },
          el('summary', { text: 'Where do I find a role ID?' }),
          el('ol', { class: 'adm-howto-steps' },
            el('li', { text: 'In Discord, open User Settings → Advanced and turn on Developer Mode.' }),
            el('li', { text: 'Open Server Settings → Roles, right-click the role your admins have, then Copy Role ID.' }),
            el('li', { text: 'Paste it here and Save. If the ping never arrives, open that role and turn on “Allow anyone to @mention this role”.' })));
        c.body.append(en.el, formGrid(
          field('Chat triggers', trig, 'Separate with commas. Any capitalisation works.', 'adm-w-4'),
          field('Cooldown', unitInput(cool, 's'), 'Per player.', 'adm-w-2 adm-pair'),
          field('In-game reply', reply, 'Shown privately to the player who called, as an admin warning — e.g. “Admins have been notified - hang tight.” Leave it empty to send no reply.'),
          field('Discord role to ping', role, 'Optional — leave empty to post without a ping.')), howto);
        if (!secrets.discordWebhook) {
          c.body.append(callout('bell', 'warn', 'No Discord webhook yet — calls only show in the panel until you add one under Integrations.'));
        }
        const save = iconBtn('Save', 'check', 'primary small');
        if (demo) save.disabled = true;
        c.foot().append(el('span', { class: 'adm-grow' }), save);

        function splitTriggers(s) {
          const seen = new Set();
          return String(s || '').split(/[,\n]+/).map((x) => x.trim()).filter((x) => {
            const k = x.toLowerCase();
            if (!x || seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        }
        save.addEventListener('click', () => {
          const triggers = splitTriggers(trig.value);
          const rid = role.value.trim();
          const coolV = String(cool.value).trim();
          const trigBad = (en.input.checked && !triggers.length) ? 'Add at least one chat trigger, e.g. !admin'
            : triggers.length > 10 ? 'Up to 10 chat triggers'
              : triggers.some((t) => cpLen(t) > 32) ? 'A chat trigger can be at most 32 characters' : '';
          const roleBad = rid && !/^\d{5,25}$/.test(rid) ? 'The role ID is the long number from Copy Role ID — digits only' : '';
          const coolBad = coolV !== '' && !(Number.isInteger(Number(coolV)) && Number(coolV) >= 0 && Number(coolV) <= 86400)
            ? 'The cooldown is a whole number of seconds, 0 to 86400' : '';
          trig.classList.toggle('invalid', !!trigBad);
          role.classList.toggle('invalid', !!roleBad);
          cool.classList.toggle('invalid', !!coolBad);
          const bad = trigBad || roleBad || coolBad;
          if (bad) { SW.ui.toast(bad, 'error'); return; }
          const patch = { adminCalls: { enabled: en.input.checked, triggers, discordRoleId: rid, reply: reply.value.trim() } };
          numOrSkip(cool, patch.adminCalls, 'cooldownSec');
          saveCard(save, patch).then((ok) => { if (ok) trig.value = triggers.join(', '); });
        });
        return { el: c.el };
      }

      /* ---- Join alerts (BATCH3 §6) ---- */
      function joinAlertsCard() {
        const J = cfgObj.joinAlerts || {};
        const c = card('Join alerts', { class: 'adm-set-ja' });
        const wl = toggleRow(J.watchlist !== false, 'Watchlisted player joins', 'Someone on the watchlist connects.');
        const fl = toggleRow(J.flagged !== false, 'Flagged player joins', 'A player with unreviewed flags connects.');
        const ev = toggleRow(J.banEvasion !== false, 'Possible ban evasion', 'A joining player shares an IP address with an actively banned player.');
        const ak = toggleRow(!!J.autoKickEvasion, 'Auto-kick possible ban evaders', 'Kick them the moment they join, without waiting for an admin.');
        ak.el.classList.add('is-danger');
        [wl, fl, ev, ak].forEach((x) => { if (demo) x.input.disabled = true; });
        function syncAk() {
          if (!ev.input.checked) ak.input.checked = false;
          ak.input.disabled = demo || !ev.input.checked;
        }
        ev.input.addEventListener('change', syncAk);
        syncAk();
        /* Discord gets join alerts (evasion ones as flags) only with the
         * webhook's Flags event ticked — as saved */
        const discordBox = el('div', { class: 'hidden' });
        function syncDiscord() {
          discordBox.textContent = '';
          const off = weC.flags === false;
          discordBox.classList.toggle('hidden', !off);
          if (off) {
            discordBox.append(callout('bell', 'warn',
              'Flags is unticked under Integrations → Send events for, so join alerts only show in the panel, not in Discord.'));
          }
        }
        syncDiscord();
        c.body.append(
          el('div', { class: 'adm-toggles' }, wl.el, fl.el, ev.el),
          el('div', { class: 'adm-divider', role: 'separator' }),
          ak.el,
          callout('warn', 'danger', 'Shared addresses are common — families, LAN cafés, VPNs and mobile networks. Auto-kick can remove innocent players; most servers keep the alert and let an admin decide.'),
          discordBox,
          el('p', { class: 'adm-note', text: 'Alerts show in the panel, and in Discord when a webhook is set and Flags is ticked under Integrations → Send events for. Evasion checks compare IP addresses, so they only work for players whose IP A3 Admin has seen.' }));
        const save = iconBtn('Save', 'check', 'primary small');
        if (demo) save.disabled = true;
        c.foot().append(el('span', { class: 'adm-grow' }), save);
        save.addEventListener('click', async () => {
          if (ak.input.checked && !J.autoKickEvasion) {
            const v = await SW.ui.confirmModal({
              title: 'Turn on auto-kick?',
              body: 'Players who share an IP address with a banned player are kicked the moment they join — innocent family members, LAN café and VPN users included. Every kick is audit-logged.',
              danger: true,
              confirmText: 'Turn on auto-kick',
            });
            if (!v) return;
          }
          const patch = { joinAlerts: { watchlist: wl.input.checked, flagged: fl.input.checked, banEvasion: ev.input.checked, autoKickEvasion: ak.input.checked } };
          if (await saveCard(save, patch)) J.autoKickEvasion = patch.joinAlerts.autoKickEvasion;
        });
        return { el: c.el, syncDiscord };
      }

      /* ---- Evidence uploads (BATCH3 §1) ---- */
      function evidenceCard() {
        const E = cfgObj.evidence || {};
        evMaxMB = num(E.maxMB) || null;
        if (evMaxMB && SW.evidence && typeof SW.evidence.noteLimit === 'function') SW.evidence.noteLimit(evMaxMB);
        const c = card('Evidence uploads', { class: 'adm-set-ev' });
        const mb = numInput(E.maxMB, { placeholder: '50', label: 'Largest file in MB' });
        mb.min = '1';
        mb.max = '100';
        mb.step = '1';
        c.body.append(
          formGrid(field('Largest file', unitInput(mb, 'MB'), 'Per file, 1 to 100. Cloudflare\'s free plan refuses uploads over 100 MB.', 'adm-w-4 adm-pair')),
          el('p', { class: 'adm-note', text: 'Accepted: ' + EV_TYPES_TEXT + ' — checked by content, not by name. Up to ' + EV_PER_TARGET + ' files per ban or action.' }));
        const dir = evidenceDirOf(st.db && st.db.path);
        if (dir) c.body.append(kvList([['Stored in', pathEl(dir)]]));
        const save = iconBtn('Save', 'check', 'primary small');
        if (demo) save.disabled = true;
        c.foot().append(el('span', { class: 'adm-grow' }), save);
        save.addEventListener('click', () => {
          const v = String(mb.value).trim();
          const n = Number(v);
          const bad = v === '' || !Number.isInteger(n) || n < 1 || n > 100;
          mb.classList.toggle('invalid', bad);
          if (bad) { SW.ui.toast('The upload limit is a whole number of MB from 1 to 100', 'error'); return; }
          saveCard(save, { evidence: { maxMB: n } }).then((ok) => {
            if (!ok) return;
            evMaxMB = n;
            if (SW.evidence && typeof SW.evidence.noteLimit === 'function') SW.evidence.noteLimit(n);
          });
        });
        return { el: c.el };
      }

      /* ---- Reason templates (BATCH3 §2): the wording every admin picks
       * from in the Warn / Kick / Ban dialogs, grouped by kind; a ban row
       * also sets the duration. Rows keep their ids across edits; new rows
       * get one from label + kind. ---- */
      function templatesEditor() {
        const c = card('Reason templates', { class: 'adm-set-rt', count: true });
        const msgBox = el('div', { class: 'adm-tpl-msg hidden' });
        const groupsEl = el('div', { class: 'adm-tpl-groups' });
        const stateEl = el('span', { class: 'adm-note adm-grow adm-qce-state' });
        const saveBtn = iconBtn('Save', 'check', 'primary small');
        saveBtn.disabled = true;
        c.body.append(el('p', {
          class: 'adm-note',
          text: 'Shared wording for the Warn, Kick and Ban dialogs — every admin picks from these, and can still edit the text before sending. The reason is what the player sees.',
        }), msgBox, groupsEl);
        c.foot().append(stateEl, saveBtn);

        const slots = Object.create(null); /* kind -> {list, count, add} */
        TPL_KINDS.forEach((k) => {
          const list = el('div', { class: 'adm-tpl-list', role: 'list', 'aria-label': k.title + ' templates' });
          const count = el('span', { class: 'adm-chip-count' });
          const add = iconBtn('Add ' + k.noun, 'plus', 'ghost small');
          add.disabled = true;
          add.addEventListener('click', () => addRow(k.value));
          slots[k.value] = { list, count, add };
          groupsEl.append(el('section', { class: 'adm-tpl-group is-' + k.value },
            el('div', { class: 'adm-tpl-group-head' },
              el('span', { class: 'adm-tpl-kind', text: k.title }), count,
              el('span', { class: 'adm-note adm-tpl-hint', text: k.hint })),
            list,
            el('div', { class: 'adm-tpl-add' }, add)));
        });

        let model = []; /* [{key, id|null, kind, label, reason, interval}] */
        let savedSig = '[]';
        let keySeq = 0;
        let loaded = false;
        const sig = () => JSON.stringify(model.map((x) =>
          [x.id || '', x.kind, x.label.trim(), x.reason.trim(), x.kind === 'ban' ? String(x.interval).trim() : '']));

        function syncState() {
          if (!loaded) return;
          const dirty = sig() !== savedSig;
          stateEl.textContent = (dirty ? 'Unsaved changes · ' : '') + model.length + ' of ' + TPL_MAX;
          stateEl.classList.toggle('is-dirty', dirty);
          saveBtn.disabled = demo || !dirty;
        }

        function rowByKey(key) {
          return groupsEl.querySelector('.adm-tpl-row[data-key="' + String(key) + '"]');
        }

        function rowEl(item, i, n) {
          const kt = TPL_KINDS.find((k) => k.value === item.kind).title;
          const what = kt + ' template ' + (i + 1);
          const lab = el('input', {
            class: 'input adm-tpl-label', type: 'text', maxlength: String(TPL_LABEL_MAX), autocomplete: 'off',
            placeholder: 'Label, e.g. Teamkilling', 'aria-label': what + ' — label',
          });
          lab.value = item.label;
          const rea = el('input', {
            class: 'input adm-tpl-reason', type: 'text', maxlength: String(TPL_REASON_MAX), autocomplete: 'off',
            placeholder: item.kind === 'warn' ? 'Message the player sees' : 'Reason the player sees', 'aria-label': what + ' — text',
          });
          rea.value = item.reason;
          const ivl = item.kind === 'ban'
            ? intervalPicker(item.interval, what + ' — duration', (v) => { item.interval = v; syncState(); }, demo)
            : null;
          const up = el('button', { type: 'button', class: 'btn ghost small icon-only', title: 'Move up', 'aria-label': 'Move ' + what + ' up', dataset: { act: 'up' } });
          up.innerHTML = icon('chevron-up');
          const down = el('button', { type: 'button', class: 'btn ghost small icon-only', title: 'Move down', 'aria-label': 'Move ' + what + ' down', dataset: { act: 'down' } });
          down.innerHTML = icon('chevron-down');
          const del = el('button', { type: 'button', class: 'btn danger ghost small icon-only', title: 'Remove', 'aria-label': 'Remove ' + what, dataset: { act: 'del' } });
          del.innerHTML = icon('trash');
          up.disabled = demo || i === 0;
          down.disabled = demo || i === n - 1;
          if (demo) { lab.disabled = true; rea.disabled = true; del.disabled = true; }
          lab.addEventListener('input', () => { item.label = lab.value; lab.classList.remove('invalid'); syncState(); });
          rea.addEventListener('input', () => { item.reason = rea.value; rea.classList.remove('invalid'); syncState(); });
          return el('div', { class: 'adm-tpl-row' + (ivl ? ' has-int' : ''), role: 'listitem', dataset: { key: String(item.key) } },
            lab, rea, ivl ? ivl.el : null, el('div', { class: 'adm-qce-acts adm-tpl-acts' }, up, down, del));
        }

        /* focusAct: the button to land on after a move / remove (keyboard) */
        function draw(focusKey, focusAct) {
          c.setCount(model.length);
          TPL_KINDS.forEach((k) => {
            const s = slots[k.value];
            const items = model.filter((x) => x.kind === k.value);
            s.list.textContent = '';
            s.count.textContent = String(items.length);
            if (!items.length) {
              s.list.append(el('p', { class: 'adm-note adm-tpl-empty', text: 'No ' + k.noun + ' templates — admins type their own.' }));
            } else {
              items.forEach((item, i) => s.list.append(rowEl(item, i, items.length)));
            }
            s.add.disabled = demo || model.length >= TPL_MAX;
          });
          syncState();
          const r = focusKey != null ? rowByKey(focusKey) : null;
          if (!r) return;
          let b = focusAct ? r.querySelector('button[data-act="' + focusAct + '"]') : r.querySelector('input');
          if (b && b.disabled && focusAct) b = r.querySelector('button[data-act="' + (focusAct === 'up' ? 'down' : 'up') + '"]');
          if (b && !b.disabled) b.focus();
        }

        groupsEl.addEventListener('click', (e) => {
          const b = e.target.closest('button[data-act]');
          if (!b || !groupsEl.contains(b) || b.disabled) return;
          const r = b.closest('.adm-tpl-row');
          const i = r ? model.findIndex((x) => String(x.key) === r.dataset.key) : -1;
          if (i < 0) return;
          const item = model[i];
          const act = b.dataset.act;
          if (act === 'del') {
            const same = model.filter((x) => x.kind === item.kind);
            const pos = same.indexOf(item);
            model.splice(i, 1);
            const next = same[pos + 1] || same[pos - 1];
            draw(next ? next.key : null, 'del');
            if (!next) slots[item.kind].add.focus();
            return;
          }
          /* swap with the nearest row of the same kind */
          let j = i;
          do { j += act === 'up' ? -1 : 1; } while (j >= 0 && j < model.length && model[j].kind !== item.kind);
          if (j < 0 || j >= model.length) return;
          model[i] = model[j];
          model[j] = item;
          draw(item.key, act);
        });

        function addRow(kind) {
          if (model.length >= TPL_MAX) { SW.ui.toast('Up to ' + TPL_MAX + ' reason templates', 'warn'); return; }
          const item = { key: ++keySeq, id: null, kind, label: '', reason: '', interval: kind === 'ban' ? '1d' : '' };
          let last = -1;
          model.forEach((x, idx) => { if (x.kind === kind) last = idx; });
          model.splice(last >= 0 ? last + 1 : model.length, 0, item);
          draw(item.key);
        }

        /* the server's rules, checked first; marks bad inputs -> problems */
        function validate() {
          const problems = [];
          if (model.length > TPL_MAX) problems.push('At most ' + TPL_MAX + ' reason templates.');
          TPL_KINDS.forEach((k) => {
            model.filter((x) => x.kind === k.value).forEach((item, i) => {
              const r = rowByKey(item.key);
              const at = k.title + ' ' + (i + 1) + ': ';
              const label = item.label.trim();
              const reason = item.reason.trim();
              /* as the server counts: label in code points, reason in UTF-16
               * units; one line each (a tab is fine in a reason) */
              const labBad = !label || cpLen(label) > TPL_LABEL_MAX || /[\u0000-\u001f\u007f]/.test(label);
              const reaBad = !reason || reason.length > TPL_REASON_MAX || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(reason);
              const ivBad = item.kind === 'ban' && !BAN_INTERVAL_RE.test(String(item.interval).trim());
              if (labBad) problems.push(at + 'the label needs 1–' + TPL_LABEL_MAX + ' characters.');
              if (reaBad) problems.push(at + 'the text needs 1–' + TPL_REASON_MAX + ' characters.');
              if (ivBad) problems.push(at + 'the duration is 0 (permanent) or like 30m, 12h, 5d, 2w, 1M, 1y.');
              if (!r) return;
              const lab = r.querySelector('.adm-tpl-label');
              const rea = r.querySelector('.adm-tpl-reason');
              const cus = r.querySelector('.adm-int-custom');
              if (lab) { lab.classList.toggle('invalid', labBad); lab.setAttribute('aria-invalid', String(labBad)); }
              if (rea) { rea.classList.toggle('invalid', reaBad); rea.setAttribute('aria-invalid', String(reaBad)); }
              if (cus) { cus.classList.toggle('invalid', ivBad); cus.setAttribute('aria-invalid', String(ivBad)); }
            });
          });
          return problems;
        }

        function setModel(rows) {
          model = rows.map((x) => ({
            key: ++keySeq, id: x.id, kind: x.kind, label: x.label, reason: x.reason,
            interval: x.kind === 'ban' ? (x.interval || '1d') : '',
          }));
          loaded = true;
          savedSig = sig();
          msgBox.classList.add('hidden');
          groupsEl.classList.remove('hidden');
          draw(null);
        }

        saveBtn.addEventListener('click', async () => {
          const problems = validate();
          if (problems.length) {
            SW.ui.toast(problems[0] + (problems.length > 1 ? ' (+' + (problems.length - 1) + ' more)' : ''), 'error');
            return;
          }
          const ids = uniqueIds(model, TPL_ID_RE, (x) => {
            const base = slugOf(x.label).slice(0, 39 - x.kind.length).replace(/-+$/, '');
            return (base ? base + '-' : '') + x.kind;
          });
          const rows = model.map((x, i) => {
            const row = { id: ids[i], kind: x.kind, label: x.label.trim(), reason: x.reason.trim() };
            if (x.kind === 'ban') row.interval = String(x.interval).trim();
            return row;
          });
          saveBtn.disabled = true;
          let res = null;
          try { res = await SW.api('/api/reason-templates', { method: 'POST', body: { rows } }); }
          catch (_e) { /* toasted — a 400 names the bad row */ }
          if (disposed) return;
          if (res) {
            setModel(res && Array.isArray(res.rows) ? tplRows(res) : rows);
            SW.ui.toast('Reason templates saved', 'ok');
          } else {
            syncState();
          }
        });

        async function load() {
          let r;
          try { r = await SW.api('/api/reason-templates', { toast: false }); }
          catch (e) {
            if (disposed) return;
            groupsEl.classList.add('hidden');
            msgBox.classList.remove('hidden');
            msgBox.textContent = '';
            msgBox.append(emptyState('note', 'Could not load the reason templates',
              e && e.status === 404 ? 'This A3 Admin build has no reason templates yet — update A3 Admin and restart it.' : ((e && e.message) || 'The server did not answer.'),
              { label: 'Retry', icon: 'refresh', onClick: load }, true));
            return;
          }
          if (disposed) return;
          setModel(tplRows(r));
        }
        TPL_KINDS.forEach((k) => {
          slots[k.value].list.append(skeletonRows(2));
        });
        return Object.assign(c, { ready: load() });
      }

      const rb = remoteBansCard();
      const ac = adminCallsCard();
      const ja = joinAlertsCard();
      const evc = evidenceCard();
      const rt = SW.can('settings') ? templatesEditor() : null;

      /* balanced grid: server | integrations, then admin calls | join alerts
       * + evidence, share rows; the remote ban list, BattleMetrics, the two
       * preset editors, the mode-dependent log card and the big detection
       * card each get a full row with their groups side by side */
      root.append(el('div', { class: 'adm-settings-grid' },
        sv.el, it.el,
        rb.el, bm.el,
        ac.el, el('div', { class: 'adm-stack adm-set-stack' }, ja.el, evc.el),
        rt ? rt.el : null, qe ? qe.el : null,
        src.el, dt.el));
      const bmReady = loadBmStatus();

      /* =================== status & diagnostics =================== */
      const rconTile = card('RCON', { class: 'adm-status' });
      const logTile = card('Log source', { class: 'adm-status' });
      const dbTile = card('Database', { class: 'adm-status' });
      const verTile = card('Version', { class: 'adm-status' });

      function drawRcon(rc) {
        rc = rc || {};
        const ok = !!rc.connected;
        rconTile.body.textContent = '';
        rconTile.body.append(
          stateLine(ok ? 'ok' : 'bad', ok ? 'Connected' : 'Down'),
          kvList([
            ['Authed', rc.authed == null ? null : (rc.authed ? 'yes' : 'no')],
            ['Since', rc.since ? SW.ui.fmtTime(rc.since) : null],
            ['Last error', rc.lastError ? String(rc.lastError) : null, 'err'],
          ]));
        setPill(svPill, ok ? 'ok' : 'bad', ok ? 'Connected' : 'Offline');
      }
      function drawLog(lg) {
        lg = lg || {};
        const ok = !!lg.ok;
        const lastRead = g(lg, 'lastReadAt', 'last_read_at');
        logTile.body.textContent = '';
        logTile.body.append(
          stateLine(ok ? 'ok' : 'bad', ok ? 'Healthy' : 'Down'),
          kvList([
            ['Mode', lg.mode || '?'],
            ['Lag', lg.lagBytes != null ? fmtBytes(lg.lagBytes) : null],
            ['Last read', lastRead ? SW.ui.timeAgo(lastRead) : null],
            ['Error', lg.error ? String(lg.error) : null, 'err'],
          ]));
        setPill(logPill, ok ? 'ok' : 'bad', ok ? 'Healthy' : 'Down');
      }
      drawRcon(st.rcon);
      drawLog(st.log);

      const db = st.db || {};
      const dbPathRaw = g(db, 'path');
      dbTile.body.append(
        el('div', { class: 'adm-state is-plain' },
          el('span', { class: 'adm-state-value tabular', text: fmtBytes(g(db, 'sizeBytes', 'size_bytes')) })),
        kvList([['Path', dbPathRaw ? pathEl(dbPathRaw) : null]]));

      const ver = g(st, 'version') || g(data, 'version');
      const gameVer = g(st, 'gameVersion', 'game_version')
        || (SW.state.serverInfo && SW.state.serverInfo.gameVersion);
      verTile.body.append(
        el('div', { class: 'adm-state is-plain' },
          el('span', { class: 'adm-state-value truncate', title: ver ? String(ver) : null, text: ver ? String(ver) : '—' })),
        kvList([
          ['Panel', 'A3 Admin'],
          ['Squad server', gameVer ? String(gameVer) : 'unknown'],
        ]));

      /* live status refresh (same payload as the topbar dots) */
      unsubs.push(SW.live.on('status', (s) => {
        if (!s) return;
        if (s.rcon) drawRcon(s.rcon);
        if (s.log) drawLog(s.log);
      }));

      /* --- parser health --- */
      const parser = st.parser || {};
      const unmatched = num(g(parser, 'unmatched24h', 'unmatched_24h'));
      const samples = listOf(g(parser, 'samples')).map((s) => String(s));
      const pStat = SW.ui.statCard({
        icon: 'flame',
        label: 'Unmatched lines (24h)',
        value: SW.ui.fmtNum(unmatched),
        sub: unmatched > 0 ? 'the parser skipped these' : 'everything parsed',
        accent: unmatched > 0 ? 'warn' : undefined,
      });
      pStat.classList.add('hud', 'adm-parser-stat');
      const sampleCard = card('Sample unmatched lines', { class: 'adm-samples' });
      if (samples.length) sampleCard.actions.append(SW.ui.copyBtn(samples.join('\n'), 'Copy all'));
      if (!samples.length) {
        sampleCard.body.append(emptyState('check', 'No unmatched lines captured', 'The parser is keeping up.'));
      } else {
        const pre = el('pre', { class: 'adm-pre' });
        pre.textContent = samples.join('\n'); /* raw log lines — textContent only */
        sampleCard.body.append(pre, el('p', {
          class: 'adm-note',
          text: 'Send these lines along when asking for parser tuning — they are exactly what the parser could not match.',
        }));
      }

      /* --- redacted config dump --- */
      let cfgText;
      if (cfg == null) cfgText = '(no config returned)';
      else if (typeof cfg === 'string') cfgText = cfg;
      else {
        /* the remote ban list key is a secret as well: the dump is made to
         * be pasted into support requests, the line lives in its own card */
        let shown = cfg;
        const rbl = cfg.remoteBanList;
        if (rbl && typeof rbl === 'object' && typeof rbl.key === 'string' && rbl.key !== '') {
          shown = Object.assign({}, cfg, { remoteBanList: Object.assign({}, rbl, { key: '•••' }) });
        }
        try { cfgText = JSON.stringify(shown, null, 2); }
        catch (_e) { cfgText = String(cfg); }
      }
      const cCard = card('Configuration (redacted)', { class: 'adm-config' });
      cCard.actions.append(SW.ui.copyBtn(cfgText, 'Copy'));
      const cPre = el('pre', { class: 'adm-pre' });
      cPre.textContent = cfgText; /* dump — textContent only */
      cCard.body.append(cPre, el('p', {
        class: 'adm-note',
        text: 'config.json as loaded. Secrets (passwords, API keys and tokens, the webhook URL, the remote ban list key) are replaced with •••.',
      }));

      root.append(section('Status & diagnostics',
        el('div', { class: 'adm-status-grid' }, rconTile.el, logTile.el, dbTile.el, verTile.el),
        el('div', { class: 'adm-parser' }, pStat, sampleCard.el),
        cCard.el));

      /* cards above the target may still grow while their data loads, so the
       * spotlight lands once more when every card has settled */
      const focus = ctx && ctx.query ? String(ctx.query.focus || '') : '';
      const FOCUS = {
        'quick-commands': qe, battlemetrics: bm, 'remote-bans': rb, 'remote-ban-list': rb,
        'reason-templates': rt, templates: rt, 'admin-calls': ac, 'join-alerts': ja, evidence: evc,
      };
      const target = hasOwn(FOCUS, focus) ? FOCUS[focus] : null;
      if (target && target.el) {
        spotlight(target.el, Promise.all([bmReady, qe && qe.ready, rt && rt.ready, rb.ready]));
      }
    }
  }

  /* ====================================================== AUTOMATION view */

  /* docs/BATCH3-CONTRACTS.md §4 scheduled tasks. Kinds: broadcast {message}
   * · countdown {action, steps (minutes, largest first), message ({m} =
   * minutes left)} — it starts at its scheduled time with the first warning,
   * the action runs steps[0] minutes later · command {command}. Schedules:
   * interval {everyMinutes 5–1440} · daily {times ['HH:MM'], the A3 Admin
   * server's clock} · once {at, epoch ms}. Optional conditions {minPlayers,
   * maxPlayers} against the live player count. */
  const TASK_KINDS = [
    { value: 'broadcast', label: 'Broadcast', tone: 'accent', hint: 'A message every player on the server sees.' },
    { value: 'countdown', label: 'Countdown', tone: 'red', hint: 'Warns everyone step by step from the scheduled time, then restarts or ends the match.' },
    { value: 'command', label: 'Command', tone: 'warn', hint: 'Any RCON command, sent exactly as written.' },
  ];
  /* Besides settings, each kind takes the perms of the actions it runs — to
   * create, change (the On switch too) or run one (server/scheduler.js
   * KIND_PERMS); deleting takes settings alone. Named as on the Roles page. */
  const KIND_NEEDS = { broadcast: ['broadcast'], countdown: ['broadcast', 'match'], command: ['raw'] };
  const PERM_LABELS = { broadcast: 'Broadcast messages', match: 'Restart / end matches', raw: 'Raw RCON console' };
  /* -> why this user may not handle tasks of kind k, or null */
  function kindLock(k) {
    const miss = (KIND_NEEDS[k] || []).filter((p) => !SW.can(p));
    if (!miss.length) return null;
    return kindInfo(k).label + ' tasks also need the ' + miss.map((p) => '“' + PERM_LABELS[p] + '”').join(' and ')
      + ' permission' + (miss.length > 1 ? 's' : '');
  }
  const COUNTDOWN_ACTIONS = [
    { value: 'restartMatch', label: 'Restart match' },
    { value: 'endMatch', label: 'End match' },
  ];
  const TASK_PLACEHOLDERS = [
    ['{players}', 'players online'], ['{maxPlayers}', 'server slots'], ['{layer}', 'current layer'],
    ['{nextLayer}', 'next layer'], ['{time}', 'server time'],
  ];
  /* the scheduler's rules (server/scheduler.js), checked first */
  const TASK_NAME_MAX = 60;
  const TASK_MSG_MAX = 400; /* message templates; placeholders expand at run time */
  const TASK_CMD_MAX = 480;
  const EVERY_MIN = 5;
  const EVERY_MAX = 1440;
  const STEP_MAX = 60;
  const STEPS_MAX = 10;
  const DAILY_MAX = 24;
  const PLAYERS_MAX = 1000;
  const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const TASK_CMD_RE = /^[A-Za-z][A-Za-z0-9_]{2,63}( [^\r\n\0]+)?$/;
  const RESULT_TONE = { ok: 'ok', skipped: 'warn', failed: 'red', running: 'accent', cancelled: 'dim' };

  /* The A3 Admin server's clock: daily times are its wall clock, so every
   * time on the page is shown — and typed — on it. srvOff (minutes east of
   * UTC) comes with GET /api/schedules; while it is unknown, or equal to the
   * browser's own offset, the browser's local clock is used (DST-correct). */
  let srvOff = null;
  /* the server's live placeholder values (GET /api/schedules), for previews */
  let srvVals = null;
  function srvShifted() {
    return srvOff != null && srvOff !== -new Date().getTimezoneOffset();
  }
  /* ts -> {y, mo, d, h, mi} on the server clock */
  function srvParts(ts) {
    if (srvShifted()) {
      const u = new Date(Number(ts) + srvOff * 60000);
      return { y: u.getUTCFullYear(), mo: u.getUTCMonth(), d: u.getUTCDate(), h: u.getUTCHours(), mi: u.getUTCMinutes() };
    }
    const l = new Date(Number(ts));
    return { y: l.getFullYear(), mo: l.getMonth(), d: l.getDate(), h: l.getHours(), mi: l.getMinutes() };
  }
  function srvHHMM(ts) { const p = srvParts(ts); return pad2(p.h) + ':' + pad2(p.mi); }
  /* "3 Nov 21:00" on the server clock (the year only when not this year) */
  function srvDayTime(ts) {
    if (!Number.isFinite(Number(ts))) return '—';
    const p = srvParts(ts);
    return p.d + ' ' + MONTHS[p.mo] + (p.y !== srvParts(Date.now()).y ? ' ' + p.y : '') + ' ' + pad2(p.h) + ':' + pad2(p.mi);
  }
  /* epoch ms <-> <input type=datetime-local> value on the server clock */
  function srvToInput(ts) {
    const p = srvParts(ts);
    return p.y + '-' + pad2(p.mo + 1) + '-' + pad2(p.d) + 'T' + pad2(p.h) + ':' + pad2(p.mi);
  }
  function srvFromInput(v) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(v || ''));
    if (!m) return NaN;
    if (srvShifted()) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - srvOff * 60000;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  }
  /* "UTC+3" / "UTC−4:30" */
  function utcLabel(off) {
    const sign = off < 0 ? '−' : '+';
    const a = Math.abs(off);
    return 'UTC' + sign + Math.floor(a / 60) + (a % 60 ? ':' + pad2(a % 60) : '');
  }
  const TASK_EXAMPLES = [
    {
      title: 'Discord reminder — every 30 min', name: 'Discord reminder', kind: 'broadcast',
      payload: { message: 'Join our Discord for events, appeals and squad-ups: discord.gg/your-invite' },
      schedule: { type: 'interval', everyMinutes: 30 },
    },
    {
      title: 'Seeding rules — every 15 min below 40 players', name: 'Seeding rules', kind: 'broadcast',
      payload: { message: 'Seeding ({players}/{maxPlayers}) — no FOB or HAB attacks, fight on the middle point. Thanks for seeding!' },
      schedule: { type: 'interval', everyMinutes: 15 }, conditions: { maxPlayers: 40 },
    },
    {
      title: 'Next layer — every 20 min', name: 'Next layer', kind: 'broadcast',
      payload: { message: 'Next layer: {nextLayer}' },
      schedule: { type: 'interval', everyMinutes: 20 },
    },
    {
      /* the schedule is the first warning: 03:50 + 10 min = the 04:00 restart */
      title: 'Nightly match restart at 04:00 — warnings from 03:50', name: 'Nightly match restart', kind: 'countdown',
      payload: { action: 'restartMatch', steps: [10, 5, 1], message: 'Match restart in {m} min — finish your fights!' },
      schedule: { type: 'daily', times: ['03:50'] },
    },
  ];

  function kindInfo(k) {
    return TASK_KINDS.find((x) => x.value === k) || { value: k, label: String(k || '?'), tone: 'dim', hint: '' };
  }
  function actionLabel(a) {
    const x = COUNTDOWN_ACTIONS.find((y) => y.value === a);
    return x ? x.label : String(a || '?');
  }

  /* GET /api/schedules row (camel or snake keys, JSON columns parsed or not) */
  function taskOf(r) {
    const en = g(r, 'enabled');
    return {
      id: g(r, 'id'),
      name: String(g(r, 'name') || ''),
      kind: String(g(r, 'kind') || ''),
      payload: objOf(g(r, 'payload')) || {},
      schedule: objOf(g(r, 'schedule')) || {},
      conditions: objOf(g(r, 'conditions')),
      enabled: en == null ? true : (en === true || en === 1 || en === '1'),
      lastRunAt: toMs(g(r, 'lastRunAt', 'last_run_at')) || null,
      nextRunAt: toMs(g(r, 'nextRunAt', 'next_run_at')) || null,
      lastStatus: g(r, 'lastStatus', 'last_status'),
      lastResult: g(r, 'lastResult', 'last_result'),
      running: !!g(r, 'running'),
      runEndsAt: toMs(g(r, 'runEndsAt', 'run_ends_at')) || null,
    };
  }

  /* 15 -> "Every 15 min", 60 -> "Every hour", 90 -> "Every 1 h 30 min" */
  function everyText(m) {
    m = Math.round(num(m));
    if (m <= 0) return 'Every ? min';
    if (m < 60) return 'Every ' + m + ' min';
    const h = Math.floor(m / 60);
    const r = m % 60;
    if (!r) return h === 1 ? 'Every hour' : 'Every ' + h + ' h';
    return 'Every ' + h + ' h ' + r + ' min';
  }

  function dailyTimes(s) {
    const t = (Array.isArray(s && s.times) ? s.times : []).map(String).filter((x) => HHMM_RE.test(x));
    return t.filter((x, i) => t.indexOf(x) === i).sort();
  }

  /* schedule -> {text, title, icon}: "Every 15 min", "Daily 20:00, 23:00",
   * "Once on 3 Nov 21:00" */
  function scheduleInfo(s) {
    s = s || {};
    if (s.type === 'interval') return { text: everyText(s.everyMinutes), title: null, icon: 'repeat' };
    if (s.type === 'daily') {
      const t = dailyTimes(s);
      if (!t.length) return { text: 'Daily — no times', title: null, icon: 'clock' };
      return {
        text: 'Daily ' + t.slice(0, 4).join(', ') + (t.length > 4 ? ' +' + (t.length - 4) : ''),
        title: 'Daily at ' + t.join(', ') + ' (server time)',
        icon: 'clock',
      };
    }
    if (s.type === 'once') {
      const at = num(s.at);
      return { text: at ? 'Once on ' + srvDayTime(at) : 'Once — no time set', title: at ? new Date(at).toLocaleString() : null, icon: 'calendar' };
    }
    return { text: 'Unknown schedule', title: null, icon: 'clock' };
  }

  /* {minPlayers, maxPlayers} -> "20–40 players" | "20+ players" | "Up to 40 players" | null */
  function conditionsText(c) {
    if (!c) return null;
    const lo = c.minPlayers != null && c.minPlayers !== '' && Number.isFinite(Number(c.minPlayers)) ? Number(c.minPlayers) : null;
    const hi = c.maxPlayers != null && c.maxPlayers !== '' && Number.isFinite(Number(c.maxPlayers)) ? Number(c.maxPlayers) : null;
    if (lo != null && hi != null) return lo + '–' + hi + ' players';
    if (lo != null) return lo + '+ players';
    if (hi != null) return 'Up to ' + hi + ' players';
    return null;
  }

  /* countdown steps: distinct whole minutes, largest first */
  function stepsOf(p) {
    const s = (Array.isArray(p && p.steps) ? p.steps : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    return s.filter((n, i) => s.indexOf(n) === i).sort((a, b) => b - a);
  }

  /* when a countdown task whose first warning goes out at ts runs its
   * action (epoch ms), or null for any other task */
  function cdActionAt(t, ts) {
    const first = t.kind === 'countdown' ? stepsOf(t.payload)[0] : 0;
    return first && ts ? Number(ts) + first * 60000 : null;
  }

  /* "23:55" + 10 min -> "00:05" (wall-clock labels) */
  function hhmmPlus(hm, n) {
    if (!HHMM_RE.test(String(hm))) return String(hm);
    const x = (((Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) + n) % 1440) + 1440) % 1440;
    return pad2(Math.floor(x / 60)) + ':' + pad2(x % 60);
  }

  /* one line on what a task does (table sub-line, confirms) */
  function taskWhat(t) {
    const p = t.payload || {};
    if (t.kind === 'broadcast') return p.message ? '“' + String(p.message) + '”' : '';
    if (t.kind === 'countdown') {
      const s = stepsOf(p);
      return actionLabel(p.action) + (s.length ? ' · warns at ' + s.join(', ') + ' min' : '');
    }
    if (t.kind === 'command') return p.command ? '$ ' + String(p.command) : '';
    return '';
  }

  /* live values for the preview — the server's own (exactly what a run
   * would say), else the panel's live state; an unknown value keeps its
   * placeholder */
  function liveVals() {
    const snap = SW.state.snapshot || {};
    const si = SW.state.serverInfo || snap.serverInfo || {};
    const v = {
      players: si.playerCount != null ? String(si.playerCount) : (snap.teams ? String(onlinePlayers().length) : ''),
      maxPlayers: si.maxPlayers != null ? String(si.maxPlayers) : '',
      layer: String(snap.currentLayer || si.mapName || ''),
      nextLayer: String(snap.nextLayer || si.nextLayer || ''),
      time: srvHHMM(Date.now()),
    };
    if (srvVals) {
      for (const k of ['players', 'maxPlayers', 'layer', 'nextLayer']) {
        const x = srvVals[k];
        if (typeof x === 'string' && x !== '' && x !== '?' && x !== 'unknown') v[k] = x;
      }
    }
    return v;
  }
  function fillText(text, vals, m) {
    return String(text == null ? '' : text).replace(/\{(players|maxPlayers|layer|nextLayer|time|m)\}/g, (all, k) => {
      if (k === 'm') return m != null ? String(m) : all;
      return vals[k] ? vals[k] : all;
    });
  }

  /* a run's outcome — status ok | skipped | failed | running | cancelled
   * plus its message — -> {tone, word, text} | null. A bare message (no
   * status) is read for its word. */
  function taskResult(status, message) {
    let st = typeof status === 'string' ? status.trim().toLowerCase() : '';
    const text = message == null ? '' : String(message).trim();
    if (!st && !text) return null;
    if (!st) {
      const s = text.toLowerCase();
      if (/^skip|skipped|rcon (is )?(down|offline|not connected)|not connected/.test(s)) st = 'skipped';
      else if (/^(fail|error)|failed|refused|denied|timed out|timeout/.test(s)) st = 'failed';
      else st = 'ok';
    }
    return { tone: RESULT_TONE[st] || 'dim', word: st, text: text.toLowerCase() === st ? '' : text };
  }

  /* "Today 21:15" · "Tomorrow 04:00" · "3 Nov 21:00" — server clock */
  function whenAt(ts) {
    const p = srvParts(ts);
    const n = srvParts(Date.now());
    const t = srvParts(Date.now() + 24 * 3600 * 1000);
    if (p.y === n.y && p.mo === n.mo && p.d === n.d) return 'Today ' + srvHHMM(ts);
    if (p.y === t.y && p.mo === t.mo && p.d === t.d) return 'Tomorrow ' + srvHHMM(ts);
    return srvDayTime(ts);
  }
  function dueText(ts) {
    const s = (Number(ts) - Date.now()) / 1000;
    return s <= 30 ? 'due now' : 'in ' + SW.ui.fmtDur(s);
  }

  function nextFullHour() {
    const t = Date.now();
    return t - (t % 3600000) + 3600000;
  }

  /* insert text at the caret of an input / textarea (placeholder chips) */
  function insertAtCaret(input, text) {
    const s = input.selectionStart != null ? input.selectionStart : input.value.length;
    const e = input.selectionEnd != null ? input.selectionEnd : s;
    input.value = input.value.slice(0, s) + text + input.value.slice(e);
    input.focus();
    try { input.setSelectionRange(s + text.length, s + text.length); } catch (_e) { /* not a text field */ }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function renderAutomation(main) {
    let disposed = false;
    let poll = null;
    let ticker = null;
    const onVisible = () => { if (document.visibilityState === 'visible' && loaded) load(true); };
    this.cleanup = () => {
      disposed = true;
      if (poll) clearInterval(poll);
      if (ticker) clearInterval(ticker);
      document.removeEventListener('visibilitychange', onVisible);
    };
    /* the kinds this user may create, change and run (KIND_NEEDS) */
    const allowedKinds = TASK_KINDS.map((k) => k.value).filter((k) => !kindLock(k));
    const view = el('div', { class: 'view view-automation adm fade-in' });
    main.append(view);
    let newBtn = null;
    if (allowedKinds.length) {
      newBtn = iconBtn('New task', 'plus', 'primary');
      newBtn.addEventListener('click', () => taskModal(null, null));
    }
    view.append(pageHead('Automation',
      'Scheduled broadcasts, match countdowns and RCON commands. A3 Admin runs them on its own clock and audit-logs every run.',
      [newBtn]).el);
    const tc = tableCard({ title: 'Scheduled tasks', class: 'adm-auto' });
    const lockBox = el('div', { class: 'hidden' });
    view.append(el('div', { class: 'adm-col' }, lockBox, tc.el));
    tc.body.append(skeletonRows(4));
    const clockNote = el('p', { class: 'adm-note adm-grow' });
    tc.foot().append(clockNote);
    function drawClockNote() {
      clockNote.textContent = (srvShifted()
        ? 'Times are shown on the A3 Admin server\'s clock (' + utcLabel(srvOff) + ' — it is ' + srvHHMM(Date.now()) + ' there now), not yours.'
        : 'Times follow the clock of the PC running A3 Admin.')
        + ' While RCON is down or the player conditions are not met, a run is skipped and logged, and the task waits for its next time.';
    }
    drawClockNote();

    let tasks = [];
    let loaded = false;
    let lastSig = '';
    let seq = 0;

    /* what this role cannot do, said on the page as well: touch screens
     * never show the disabled controls' titles */
    function drawLocks() {
      let text = '';
      if (!allowedKinds.length) {
        text = 'Your role can see and delete scheduled tasks, but not create, change or run them: broadcasts need the “'
          + PERM_LABELS.broadcast + '” permission, countdowns that and “' + PERM_LABELS.match + '”, and commands “' + PERM_LABELS.raw + '”.';
      } else {
        const kinds = TASK_KINDS.map((k) => k.value).filter((k) => kindLock(k) && tasks.some((t) => t.kind === k));
        if (kinds.length) {
          text = kinds.map((k) => kindLock(k) + '.').join(' ')
            + ' You can see and delete ' + (kinds.length > 1 ? 'those' : 'them') + ', but not change or run them.';
        }
      }
      lockBox.textContent = '';
      lockBox.classList.toggle('hidden', !text);
      if (text) lockBox.append(callout('lock', 'info', text));
    }
    drawLocks();

    /* a once task whose time has passed: the server will not switch it
     * back on, only an edit with a new time re-arms it */
    function onceSpent(t) {
      return !t.enabled && t.schedule.type === 'once' && num(t.schedule.at) <= Date.now();
    }
    function pausedText(t) {
      if (!onceSpent(t)) return 'Paused';
      return t.lastRunAt ? 'Done' : 'Time passed';
    }

    /* "Next Today 14:50" · "Paused" — the next-run column in a few words */
    function nextShort(t) {
      if (t.running) {
        if (t.kind !== 'countdown') return 'Running';
        return 'Counting down' + (t.runEndsAt ? ' · ' + actionLabel(t.payload.action).toLowerCase() + ' ' + srvHHMM(t.runEndsAt) : '');
      }
      if (!t.enabled) return pausedText(t);
      if (!t.nextRunAt) return '';
      const actAt = cdActionAt(t, t.nextRunAt);
      return 'Next ' + whenAt(t.nextRunAt) + (actAt ? ' · ' + actionLabel(t.payload.action).toLowerCase() + ' ' + srvHHMM(actAt) : '');
    }

    function taskCell(t) {
      const w = el('div', { class: 'adm-task' },
        el('span', { class: 'adm-task-name truncate', title: t.name || null, text: t.name || 'Untitled task' }));
      const what = taskWhat(t);
      if (what) w.append(el('span', { class: 'adm-task-what truncate' + (t.kind === 'command' ? ' mono' : ''), title: what, text: what }));
      /* narrower layouts (css §14) fold hidden columns in under the name */
      const kb = SW.ui.badge(kindInfo(t.kind).label, kindInfo(t.kind).tone);
      kb.classList.add('adm-tm-kind');
      const meta = el('div', { class: 'adm-task-meta' }, kb,
        el('span', { class: 'adm-tm-sched', text: scheduleInfo(t.schedule).text }));
      const cond = conditionsText(t.conditions);
      if (cond) meta.append(el('span', { class: 'adm-tm-cond', text: cond }));
      const nx = nextShort(t);
      if (nx) meta.append(el('span', { class: 'adm-tm-next', text: nx }));
      w.append(meta);
      return w;
    }

    function scheduleCell(t) {
      const s = scheduleInfo(t.schedule);
      const w = el('span', { class: 'adm-sched', title: (t.kind === 'countdown' ? 'First warning: ' : '') + (s.title || s.text) });
      w.innerHTML = icon(s.icon);
      w.append(el('span', { class: 'adm-sched-text', text: s.text }));
      return w;
    }

    function enabledCell(t) {
      const sw = switchEl(t.enabled, (t.enabled ? 'Pause ' : 'Turn on ') + (t.name || 'task'));
      const lock = kindLock(t.kind);
      if (lock) {
        sw.input.disabled = true;
        sw.el.title = lock;
      } else if (onceSpent(t)) {
        sw.input.disabled = true;
        sw.el.title = 'Its time has passed — edit it and pick a new time to schedule it again';
      } else if (t.running && t.kind === 'countdown') {
        sw.el.title = 'Counting down — switch off to call the countdown off';
      } else {
        sw.el.title = t.enabled ? 'On — switch off to pause' : 'Paused — switch on to run it again';
      }
      sw.input.addEventListener('change', () => setEnabled(t, sw.input));
      return sw.el;
    }

    function lastCell(t) {
      if (!t.lastRunAt) return el('span', { class: 'adm-muted', text: 'Never' });
      const w = el('div', { class: 'adm-when' }, SW.ui.timeAgo(t.lastRunAt));
      const res = taskResult(t.lastStatus, t.lastResult);
      if (res) {
        /* the badge carries the text as its title for when narrow layouts hide it */
        const line = el('span', { class: 'adm-result' }, SW.ui.badge(res.word, res.tone, res.text || null));
        if (res.text) line.append(el('span', { class: 'adm-result-text truncate', title: res.text, text: res.text }));
        w.append(line);
      }
      return w;
    }

    function nextCell(t) {
      if (t.running) {
        const w = el('div', { class: 'adm-when' },
          el('span', { class: 'adm-state-inline' }, dot('busy'), el('span', { text: t.kind === 'countdown' ? 'Counting down' : 'Running' })));
        if (t.runEndsAt) {
          w.append(el('span', {
            class: 'adm-when-rel', title: new Date(t.runEndsAt).toLocaleString(),
            text: actionLabel(t.payload.action) + ' at ' + srvHHMM(t.runEndsAt),
          }));
        }
        return w;
      }
      if (!t.enabled) {
        return el('span', {
          class: 'adm-muted', text: pausedText(t),
          title: onceSpent(t) ? 'Edit it and pick a new time to schedule it again' : null,
        });
      }
      if (!t.nextRunAt) return el('span', { class: 'adm-muted', text: '—' });
      const w = el('div', { class: 'adm-when', title: new Date(t.nextRunAt).toLocaleString() },
        el('span', { class: 'adm-when-at', text: whenAt(t.nextRunAt) }),
        el('span', { class: 'adm-when-rel', dataset: { due: String(t.nextRunAt) }, text: dueText(t.nextRunAt) }));
      /* a countdown starts here with its first warning; the action follows */
      const actAt = cdActionAt(t, t.nextRunAt);
      if (actAt) {
        w.title = 'First warning ' + new Date(t.nextRunAt).toLocaleString() + ' · ' + actionLabel(t.payload.action) + ' ' + new Date(actAt).toLocaleString();
        w.append(el('span', { class: 'adm-when-act', text: actionLabel(t.payload.action) + ' at ' + srvHHMM(actAt) }));
      }
      return w;
    }

    function actionsCell(t) {
      const lock = kindLock(t.kind);
      const run = iconBtn('Run now', 'play', 'ghost small', true);
      const ed = el('button', { type: 'button', class: 'btn ghost small icon-only', 'aria-label': 'Edit ' + (t.name || 'task') });
      ed.innerHTML = icon('edit');
      if (lock) {
        run.disabled = true;
        run.title = lock;
        ed.disabled = true;
        ed.title = lock;
      } else {
        run.addEventListener('click', () => runNow(t, run));
        ed.title = 'Edit';
        ed.addEventListener('click', () => taskModal(t, null));
      }
      const del = el('button', { type: 'button', class: 'btn danger ghost small icon-only', title: 'Delete', 'aria-label': 'Delete ' + (t.name || 'task') });
      del.innerHTML = icon('trash');
      del.addEventListener('click', () => removeTask(t, del));
      return el('div', { class: 'adm-cell-actions' }, run, ed, del);
    }

    const cols = [
      { key: 'name', label: 'Task', render: taskCell },
      { key: 'kind', label: 'Kind', render: (t) => SW.ui.badge(kindInfo(t.kind).label, kindInfo(t.kind).tone) },
      { key: 'schedule', label: 'Schedule', render: scheduleCell },
      {
        key: 'conditions', label: 'Only when',
        render: (t) => { const c = conditionsText(t.conditions); return el('span', { class: c ? 'nowrap' : 'adm-muted', text: c || 'Always' }); },
      },
      { key: 'enabled', label: 'On', render: enabledCell },
      { key: 'last', label: 'Last run', render: lastCell },
      { key: 'next', label: 'Next run', render: nextCell },
      { key: 'actions', label: '', class: 'adm-td-actions', render: actionsCell },
    ];
    const tbl = SW.ui.table(cols, [], {
      class: 'adm-table adm-auto-table',
      rowClass: (t) => (t.enabled ? '' : 'is-paused'),
      emptyText: 'No scheduled tasks',
    });
    const emptyBox = el('div', { class: 'adm-table-empty hidden' });

    /* soonest first; paused ones after, by name */
    function sortTasks(list) {
      return list.slice().sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const na = a.enabled && a.nextRunAt ? a.nextRunAt : Number.MAX_SAFE_INTEGER;
        const nb = b.enabled && b.nextRunAt ? b.nextRunAt : Number.MAX_SAFE_INTEGER;
        if (na !== nb) return na - nb;
        return a.name.localeCompare(b.name);
      });
    }

    function draw() {
      tc.setCount(tasks.length);
      drawLocks();
      const empty = !tasks.length;
      tbl.classList.toggle('hidden', empty);
      emptyBox.classList.toggle('hidden', !empty);
      emptyBox.textContent = '';
      if (!empty) { tbl.update(tasks); return; }
      const box = emptyState('clock', 'No scheduled tasks yet',
        'Remind players of your Discord every 30 minutes, or count down to a nightly match restart.',
        allowedKinds.length ? { label: 'New task', icon: 'plus', onClick: () => taskModal(null, null) } : null);
      const examples = TASK_EXAMPLES.filter((x) => !kindLock(x.kind));
      if (examples.length) {
        const ex = el('div', { class: 'adm-auto-examples' }, el('span', { class: 'adm-note', text: 'Or start from an example:' }));
        examples.forEach((x) => {
          const b = el('button', { type: 'button', class: 'chip', text: x.title });
          b.addEventListener('click', () => taskModal(null, x));
          ex.append(b);
        });
        box.append(ex);
      }
      emptyBox.append(box);
    }

    /* quiet: a background refresh — failures keep the table, and an
     * unchanged list is left alone so focus and open menus survive */
    async function load(quiet) {
      const my = ++seq;
      let r;
      try { r = await SW.api('/api/schedules', { toast: false }); }
      catch (e) {
        if (disposed || my !== seq) return;
        if (loaded) {
          if (!quiet) SW.ui.toast('Could not refresh the scheduled tasks', 'error');
          return;
        }
        tc.body.textContent = '';
        tc.body.append(emptyState('clock', 'Could not load the scheduled tasks',
          e && e.status === 404 ? 'This A3 Admin build has no scheduler yet — update A3 Admin and restart it.'
            : (e && e.status === 403 ? 'Scheduled tasks need the Server settings permission.' : 'The server did not answer — try again in a moment.'),
          { label: 'Retry', icon: 'refresh', onClick: () => load(false) }));
        return;
      }
      if (disposed || my !== seq) return;
      if (r && Number.isFinite(Number(r.utcOffsetMinutes))) srvOff = Number(r.utcOffsetMinutes);
      if (r && r.placeholders && typeof r.placeholders === 'object') srvVals = r.placeholders;
      drawClockNote();
      const next = listOf(r).map(taskOf);
      const sig = JSON.stringify(next);
      if (loaded && quiet && sig === lastSig) return;
      lastSig = sig;
      tasks = sortTasks(next);
      if (!loaded) {
        loaded = true;
        tc.body.textContent = '';
        tc.body.append(tbl, emptyBox);
      }
      draw();
    }

    /* a partial update: the server keeps every field not sent; switching a
     * running countdown off calls it off */
    async function setEnabled(t, input) {
      const on = input.checked;
      input.disabled = true;
      try {
        const res = await SW.api('/api/schedules/' + encodeURIComponent(t.id), { method: 'POST', body: { enabled: on } });
        if (disposed) return;
        SW.ui.toast(res && res.cancelledRun ? 'Countdown called off: ' + (t.name || 'task')
          : (on ? 'Turned on: ' : 'Paused: ') + (t.name || 'task'), 'ok');
        load(false);
      } catch (_e) {
        input.checked = !on;
        input.disabled = false;
      }
    }

    async function runNow(t, btn) {
      const p = t.payload || {};
      const body = t.kind === 'countdown'
        ? 'Starts the countdown now — every player sees the warnings at ' + stepsOf(p).join(', ') + ' min left, then ' + actionLabel(p.action).toLowerCase() + ' runs.'
        : (t.kind === 'command'
          ? 'Sends this RCON command to the game server now: ' + String(p.command || '')
          : 'Sends this broadcast to every player now: ' + fillText(p.message || '', liveVals()));
      const v = await SW.ui.confirmModal({
        title: 'Run "' + (t.name || 'task') + '" now?',
        body,
        danger: t.kind !== 'broadcast',
        confirmText: 'Run now',
      });
      if (!v) return;
      btn.disabled = true;
      try {
        const res = await SW.api('/api/schedules/' + encodeURIComponent(t.id) + '/run', { method: 'POST', body: {} });
        const rr = res && res.result && typeof res.result === 'object' ? taskResult(res.result.status, res.result.message) : null;
        const title = 'Ran: ' + (t.name || 'task') + (rr && rr.text ? ' — ' + rr.text : '');
        const resp = res && res.rconResponse != null ? String(res.rconResponse).trim() : '';
        if (resp) rconResultToast(title, res);
        else SW.ui.toast(title, rr && (rr.word === 'failed' || rr.word === 'skipped') ? 'warn' : 'ok');
        if (!disposed) load(false);
      } catch (_e) { /* toasted */ }
      btn.disabled = false;
    }

    async function removeTask(t, btn) {
      const v = await SW.ui.confirmModal({
        title: 'Delete "' + (t.name || 'task') + '"?',
        body: 'It stops running and is removed for everyone. Past runs stay in the audit log.',
        danger: true,
        confirmText: 'Delete task',
      });
      if (!v) return;
      btn.disabled = true;
      try {
        await SW.api('/api/schedules/' + encodeURIComponent(t.id) + '/delete', { method: 'POST', body: {} });
        if (disposed) return;
        SW.ui.toast('Deleted: ' + (t.name || 'task'), 'ok');
        load(false);
      } catch (_e) { btn.disabled = false; }
    }

    /* create / edit (t) or start from an example (preset) */
    function taskModal(t, preset) {
      const editing = !!t;
      if (editing ? kindLock(t.kind) : !allowedKinds.length) return;
      const src = t || preset || null;
      let kind = src && src.kind ? src.kind : allowedKinds[0];
      if (!editing && kindLock(kind)) kind = allowedKinds[0];
      const S0 = (src && src.schedule) || {};
      let stype = S0.type === 'daily' || S0.type === 'once' ? S0.type : 'interval';
      const P0 = (src && src.payload) || {};
      const C0 = (src && src.conditions) || {};
      const form = el('form', { class: 'adm-task-form', novalidate: true });
      const mark = (node, bad) => { node.classList.toggle('invalid', !!bad); node.setAttribute('aria-invalid', String(!!bad)); };

      function sect(title) {
        const s = el('section', { class: 'adm-task-sect' }, el('h3', { class: 'adm-subhead', text: title }));
        for (let i = 1; i < arguments.length; i++) { if (arguments[i]) s.append(arguments[i]); }
        return s;
      }
      function phChips(target, withM) {
        const row = el('div', { class: 'adm-ph', role: 'group', 'aria-label': 'Insert a placeholder' });
        (withM ? [['{m}', 'minutes left']].concat(TASK_PLACEHOLDERS) : TASK_PLACEHOLDERS).forEach(([tok, what]) => {
          const b = el('button', { type: 'button', class: 'adm-ph-chip', title: 'Insert ' + tok + ' — ' + what, text: tok });
          b.addEventListener('mousedown', (e) => e.preventDefault()); /* the caret stays in the field */
          b.addEventListener('click', () => insertAtCaret(target, tok));
          row.append(b);
        });
        return row;
      }
      /* the server takes one line without control characters */
      const oneLine = (s) => String(s || '').replace(/\s*[\u0000-\u001f\u007f]+\s*/g, ' ').trim();
      function clockHint() {
        if (srvOff == null) return 'Your local time.';
        if (srvShifted()) return 'Server time (' + utcLabel(srvOff) + ', now ' + srvHHMM(Date.now()) + ') — not your clock.';
        return 'Server time — the same clock as yours.';
      }

      /* --- what --- */
      const nameIn = el('input', { class: 'input', type: 'text', maxlength: String(TASK_NAME_MAX), autocomplete: 'off', placeholder: 'e.g. Discord reminder' });
      nameIn.value = src && src.name ? String(src.name) : '';
      const kindSeg = segmented(TASK_KINDS.map((k) => ({ value: k.value, label: k.label })), kind,
        (v) => { kind = v; syncKind(); }, { label: 'Kind' });
      /* kinds this role cannot schedule stay visible, disabled, and say why
       * in a line of their own (touch screens never show titles) */
      const kindLocks = [];
      TASK_KINDS.forEach((k, i) => {
        const why = kindLock(k.value);
        const b = kindSeg.el.children[i];
        if (!why || !b) return;
        b.disabled = true;
        b.title = why;
        kindLocks.push(why + '.');
      });
      const kindHint = el('p', { class: 'adm-note' });
      const kindLockNote = kindLocks.length ? el('p', { class: 'adm-note adm-task-lock', text: kindLocks.join(' ') }) : null;

      const msg = el('textarea', {
        class: 'input', rows: '3', maxlength: String(TASK_MSG_MAX),
        placeholder: 'Message every player sees — e.g. Join our Discord: discord.gg/…', 'aria-label': 'Broadcast message',
      });
      msg.value = kind === 'broadcast' && P0.message ? String(P0.message) : '';
      const bBox = el('div', { class: 'adm-task-kind' }, field('Message', msg),
        el('div', { class: 'adm-task-under' }, phChips(msg, false), counterFor(msg, TASK_MSG_MAX)));

      const cdAction = el('select', { class: 'input', 'aria-label': 'What happens at the end' });
      COUNTDOWN_ACTIONS.forEach((a) => cdAction.append(el('option', { value: a.value, text: a.label })));
      cdAction.value = kind === 'countdown' && P0.action === 'endMatch' ? 'endMatch' : 'restartMatch';
      const cdSteps = el('input', {
        class: 'input mono', type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: 'false',
        placeholder: '10, 5, 1', 'aria-label': 'Warn at these minutes',
      });
      cdSteps.value = kind === 'countdown' && stepsOf(P0).length ? stepsOf(P0).join(', ') : '10, 5, 1';
      const cdMsg = el('textarea', {
        class: 'input', rows: '2', maxlength: String(TASK_MSG_MAX),
        placeholder: 'Match restart in {m} min — finish your fights!', 'aria-label': 'Countdown message',
      });
      cdMsg.value = kind === 'countdown' && P0.message ? String(P0.message) : 'Match restart in {m} min — finish your fights!';
      const cdBox = el('div', { class: 'adm-task-kind' },
        formGrid(
          field('At the end', cdAction, null, 'adm-w-3'),
          field('Warn at', unitInput(cdSteps, 'min'), 'Minutes left, 1 to ' + STEP_MAX + ', up to ' + STEPS_MAX + ' warnings.', 'adm-w-3')),
        field('Warning message', cdMsg),
        el('div', { class: 'adm-task-under' }, phChips(cdMsg, true), counterFor(cdMsg, TASK_MSG_MAX)));

      const cmdIn = el('input', {
        class: 'input mono', type: 'text', maxlength: String(TASK_CMD_MAX), autocomplete: 'off', spellcheck: 'false',
        placeholder: 'e.g. AdminSetFogOfWar 1', 'aria-label': 'RCON command',
      });
      cmdIn.value = kind === 'command' && P0.command ? String(P0.command) : '';
      const cBox = el('div', { class: 'adm-task-kind' },
        field('RCON command', cmdIn, 'Sent exactly as written, like a line on the Raw command page — double-check it.'));

      const preview = el('div', { class: 'adm-task-preview', 'aria-live': 'polite' });

      /* countdown steps typed as "10, 5, 1" -> {list (largest first), bad} */
      function parseSteps(s) {
        const list = [];
        let bad = false;
        for (const p of String(s || '').split(/[\s,;]+/).filter(Boolean)) {
          const n = /^\d{1,4}$/.test(p) ? Number(p) : NaN;
          if (!(n >= 1 && n <= STEP_MAX)) { bad = true; continue; }
          if (list.indexOf(n) === -1) list.push(n);
        }
        list.sort((a, b) => b - a);
        return { list, bad };
      }

      function drawPreview() {
        preview.textContent = '';
        const vals = liveVals();
        if (kind === 'broadcast') {
          const txt = oneLine(msg.value);
          preview.append(el('div', { class: 'adm-pv-head', text: 'In game' }),
            el('div', { class: 'adm-pv-msg' + (txt ? '' : ' is-empty'), text: txt ? fillText(txt, vals) : 'Your message appears here.' }));
        } else if (kind === 'countdown') {
          const steps = parseSteps(cdSteps.value).list;
          preview.append(el('div', { class: 'adm-pv-head', text: 'From the scheduled time' }));
          if (!steps.length) {
            preview.append(el('div', { class: 'adm-pv-msg is-empty', text: 'Add the minutes to warn at, e.g. 10, 5, 1.' }));
          } else {
            const first = steps[0];
            const txt = oneLine(cdMsg.value);
            const ol = el('ol', { class: 'adm-pv-timeline' });
            steps.forEach((m) => ol.append(el('li', {},
              el('span', { class: 'adm-pv-at', text: '+' + (first - m) + ' min' }),
              el('span', { class: 'adm-pv-msg' + (txt ? '' : ' is-empty'), text: txt ? fillText(txt, vals, m) : '(no message)' }))));
            ol.append(el('li', { class: 'is-action' },
              el('span', { class: 'adm-pv-at', text: '+' + first + ' min' }),
              el('span', { class: 'adm-pv-act', text: actionLabel(cdAction.value) })));
            preview.append(ol);
          }
        } else {
          const c = cmdIn.value.trim();
          preview.append(el('div', { class: 'adm-pv-head', text: 'Sends' }),
            el('div', { class: 'adm-pv-cmd' + (c ? '' : ' is-empty'), text: c ? '$ ' + c : 'Your command appears here.' }));
        }
        if (kind !== 'command') {
          preview.append(el('div', { class: 'adm-pv-foot', text: 'Placeholders show live values here; every run fills in the values of that moment.' }));
        }
      }

      /* --- when --- */
      const typeSeg = segmented(
        [{ value: 'interval', label: 'Repeat' }, { value: 'daily', label: 'Daily' }, { value: 'once', label: 'Once' }],
        stype, (v) => { stype = v; syncType(); }, { label: 'Schedule' });

      const every = el('input', {
        class: 'input', type: 'number', min: String(EVERY_MIN), max: String(EVERY_MAX), step: '1', placeholder: '30',
        'aria-label': 'Repeat every, in minutes',
      });
      every.value = S0.type === 'interval' && num(S0.everyMinutes) ? String(num(S0.everyMinutes)) : '30';
      const everyChips = el('div', { class: 'adm-chips' });
      const EVERY_PICKS = [[15, '15 min'], [30, '30 min'], [60, '1 h'], [120, '2 h'], [360, '6 h']];
      EVERY_PICKS.forEach(([v, l]) => {
        const b = el('button', { type: 'button', class: 'chip', text: l, dataset: { v: String(v) } });
        b.addEventListener('click', () => { every.value = String(v); every.dispatchEvent(new Event('input')); });
        everyChips.append(b);
      });
      function syncEveryChips() {
        Array.from(everyChips.children).forEach((b) => {
          const on = b.dataset.v === String(every.value).trim();
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', String(on));
        });
      }
      const iBox = el('div', { class: 'adm-task-when' },
        formGrid(field('Every', unitInput(every, 'min'), EVERY_MIN + ' to ' + EVERY_MAX + ' minutes (24 h).', 'adm-w-3 adm-pair')),
        everyChips);

      /* a new daily schedule starts with the picker set, not with a listed
       * time: the time picked is the one saved unless more are added */
      let times = S0.type === 'daily' ? dailyTimes(S0) : [];
      const timeIn = el('input', { class: 'input', type: 'time', step: '60', 'aria-label': 'Time of day to add' });
      if (!times.length) timeIn.value = '20:00';
      const addTime = iconBtn('Add time', 'plus', 'ghost small');
      const timesBox = el('div', { class: 'adm-times', role: 'list', 'aria-label': 'Times of day' });
      /* the picker's time, when it holds one not in the list yet: a save
       * stores it too */
      function pendingTime() {
        const v = String(timeIn.value || '').slice(0, 5);
        return HHMM_RE.test(v) && times.indexOf(v) === -1 ? v : null;
      }
      /* every time a save would store, sorted */
      function dailyAll() {
        const p = pendingTime();
        return (p ? times.concat([p]) : times.slice()).sort();
      }
      function drawTimes() {
        times.sort();
        timesBox.textContent = '';
        if (!times.length) {
          timesBox.append(el('span', {
            class: 'adm-note',
            text: pendingTime() ? 'Runs at the time picked above — Add time to run at more times a day.' : 'No times yet — add at least one.',
          }));
          return;
        }
        times.forEach((tm) => {
          const x = el('button', { type: 'button', class: 'adm-time-x', title: 'Remove ' + tm, 'aria-label': 'Remove ' + tm });
          x.innerHTML = icon('x');
          x.addEventListener('click', () => { times = times.filter((y) => y !== tm); drawTimes(); syncSummary(); });
          timesBox.append(el('span', { class: 'adm-time', role: 'listitem' }, el('span', { class: 'adm-time-v', text: tm }), x));
        });
      }
      /* -> true when the picker held a time that is now in the list */
      function takeTime() {
        const v = String(timeIn.value || '').slice(0, 5);
        if (!v) return false;
        if (!HHMM_RE.test(v)) { mark(timeIn, true); return false; }
        mark(timeIn, false);
        if (times.indexOf(v) === -1) {
          if (times.length >= DAILY_MAX) { SW.ui.toast('Up to ' + DAILY_MAX + ' times a day', 'warn'); return false; }
          times.push(v);
        }
        timeIn.value = '';
        drawTimes();
        syncSummary();
        return true;
      }
      addTime.addEventListener('click', () => { if (!takeTime()) timeIn.focus(); });
      timeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); takeTime(); } });
      ['input', 'change'].forEach((ev) => timeIn.addEventListener(ev, () => { mark(timeIn, false); drawTimes(); syncSummary(); }));
      const dBox = el('div', { class: 'adm-task-when' },
        field('Add a time', el('div', { class: 'adm-inline adm-time-add' }, timeIn, addTime)),
        timesBox,
        el('p', { class: 'adm-note', text: clockHint() }));

      const atIn = el('input', { class: 'input', type: 'datetime-local', step: '60', 'aria-label': 'Date and time' });
      atIn.value = srvToInput(S0.type === 'once' && num(S0.at) ? num(S0.at) : nextFullHour());
      const oBox = el('div', { class: 'adm-task-when' },
        formGrid(field('On', atIn, clockHint(), 'adm-w-4')));
      const whenSect = sect('When', field('Schedule', typeSeg.el), iBox, dBox, oBox);
      /* a countdown's schedule is its first warning, not its action */
      const whenHead = whenSect.querySelector('h3');

      /* --- only when --- */
      const minIn = el('input', { class: 'input', type: 'number', min: '0', max: String(PLAYERS_MAX), step: '1', placeholder: 'any', 'aria-label': 'At least this many players' });
      const maxIn = el('input', { class: 'input', type: 'number', min: '0', max: String(PLAYERS_MAX), step: '1', placeholder: 'any', 'aria-label': 'At most this many players' });
      if (C0.minPlayers != null) minIn.value = String(C0.minPlayers);
      if (C0.maxPlayers != null) maxIn.value = String(C0.maxPlayers);

      const en = toggleRow(src ? src.enabled !== false : true, 'Enabled', 'A paused task keeps its settings but never runs.');
      const summary = el('p', { class: 'adm-task-summary', 'aria-live': 'polite' });

      /* exactly what a save stores — the picker's pending daily time
       * included — and, for a countdown, when its action runs */
      function syncSummary() {
        let when;
        const daily = dailyAll();
        const at = srvFromInput(atIn.value);
        if (stype === 'interval') when = everyText(Number(every.value) || 0);
        else if (stype === 'daily') when = daily.length ? 'Daily ' + daily.join(', ') : 'Daily — add a time';
        else when = Number.isFinite(at) ? 'Once on ' + srvDayTime(at) : 'Once — pick a time';
        let act = '';
        const first = kind === 'countdown' ? parseSteps(cdSteps.value).list[0] : 0;
        if (first) {
          const a = actionLabel(cdAction.value).toLowerCase();
          if (stype === 'interval') act = a + ' ' + first + ' min after each first warning';
          else if (stype === 'daily') act = daily.length ? a + ' at ' + daily.map((x) => hhmmPlus(x, first)).join(', ') : '';
          else act = Number.isFinite(at) ? a + ' at ' + srvHHMM(at + first * 60000) : '';
        }
        const cond = conditionsText({
          minPlayers: String(minIn.value).trim() === '' ? null : minIn.value,
          maxPlayers: String(maxIn.value).trim() === '' ? null : maxIn.value,
        });
        summary.textContent = kindInfo(kind).label + ' · ' + when
          + (act ? ' · ' + act : '')
          + (cond ? ' · only with ' + cond.replace(/^Up to/, 'up to') : '')
          + (en.input.checked ? '' : ' · paused');
      }
      function syncKind() {
        bBox.classList.toggle('hidden', kind !== 'broadcast');
        cdBox.classList.toggle('hidden', kind !== 'countdown');
        cBox.classList.toggle('hidden', kind !== 'command');
        kindHint.textContent = kindInfo(kind).hint;
        whenHead.textContent = kind === 'countdown' ? 'First warning at' : 'When';
        drawPreview();
        syncSummary();
      }
      function syncType() {
        iBox.classList.toggle('hidden', stype !== 'interval');
        dBox.classList.toggle('hidden', stype !== 'daily');
        oBox.classList.toggle('hidden', stype !== 'once');
        syncSummary();
      }

      [msg, cdMsg, cdSteps, cmdIn].forEach((n) => n.addEventListener('input', () => { mark(n, false); drawPreview(); }));
      cdSteps.addEventListener('input', syncSummary);
      cdAction.addEventListener('change', () => { drawPreview(); syncSummary(); });
      every.addEventListener('input', () => { mark(every, false); syncEveryChips(); syncSummary(); });
      [minIn, maxIn].forEach((n) => n.addEventListener('input', () => { mark(minIn, false); mark(maxIn, false); syncSummary(); }));
      atIn.addEventListener('input', () => { mark(atIn, false); syncSummary(); });
      atIn.addEventListener('change', syncSummary);
      en.input.addEventListener('change', syncSummary);
      nameIn.addEventListener('input', () => mark(nameIn, false));

      /* an example fills every field; the admin still reviews and saves */
      function fill(x) {
        if (kindLock(x.kind)) return;
        nameIn.value = x.name || '';
        kind = x.kind;
        kindSeg.set(kind);
        const p = x.payload || {};
        if (kind === 'broadcast') msg.value = p.message || '';
        if (kind === 'countdown') {
          cdAction.value = p.action === 'endMatch' ? 'endMatch' : 'restartMatch';
          cdSteps.value = stepsOf(p).join(', ');
          cdMsg.value = p.message || '';
        }
        if (kind === 'command') cmdIn.value = p.command || '';
        const s = x.schedule || {};
        stype = s.type === 'daily' || s.type === 'once' ? s.type : 'interval';
        typeSeg.set(stype);
        if (stype === 'interval') every.value = String(num(s.everyMinutes) || 30);
        /* the example's times only — a leftover picker time would be saved too */
        if (stype === 'daily') { times = dailyTimes(s); timeIn.value = ''; mark(timeIn, false); drawTimes(); }
        if (stype === 'once' && num(s.at)) atIn.value = srvToInput(num(s.at));
        const c = x.conditions || {};
        minIn.value = c.minPlayers != null ? String(c.minPlayers) : '';
        maxIn.value = c.maxPlayers != null ? String(c.maxPlayers) : '';
        [msg, cdMsg].forEach((n) => n.dispatchEvent(new Event('input')));
        syncEveryChips();
        syncKind();
        syncType();
        nameIn.focus();
      }

      /* the server's rules, checked first -> {problems: [[node, text]], body} */
      function collect() {
        const problems = [];
        const name = nameIn.value.trim();
        mark(nameIn, !name);
        if (!name) problems.push([nameIn, 'Give the task a name.']);
        let payload;
        let cdLen = 0;
        if (kind === 'broadcast') {
          const m = oneLine(msg.value);
          const bad = !m || m.length > TASK_MSG_MAX;
          mark(msg, bad);
          if (bad) problems.push([msg, 'The message needs 1 to ' + TASK_MSG_MAX + ' characters.']);
          payload = { message: m };
        } else if (kind === 'countdown') {
          const st = parseSteps(cdSteps.value);
          const sBad = st.bad || !st.list.length || st.list.length > STEPS_MAX;
          mark(cdSteps, sBad);
          if (sBad) problems.push([cdSteps, 'Warn up to ' + STEPS_MAX + ' times, each a whole number of minutes from 1 to ' + STEP_MAX + ' — e.g. 10, 5, 1.']);
          cdLen = st.list.length ? st.list[0] : 0;
          const m = oneLine(cdMsg.value);
          const mBad = !m || m.length > TASK_MSG_MAX;
          mark(cdMsg, mBad);
          if (mBad) problems.push([cdMsg, 'The warning message needs 1 to ' + TASK_MSG_MAX + ' characters — {m} becomes the minutes left.']);
          payload = { action: cdAction.value, steps: st.list, message: m };
        } else {
          const c = cmdIn.value.trim();
          const bad = !TASK_CMD_RE.test(c) || c.length > TASK_CMD_MAX || /[\u0000-\u001f\u007f]/.test(c);
          mark(cmdIn, bad);
          if (bad) problems.push([cmdIn, 'Start with an RCON command word, e.g. AdminSetFogOfWar 1 — one line.']);
          payload = { command: c };
        }
        let schedule;
        if (stype === 'interval') {
          const n = Number(String(every.value).trim());
          const bad = !(Number.isInteger(n) && n >= EVERY_MIN && n <= EVERY_MAX);
          const tooShort = !bad && cdLen > 0 && cdLen >= n;
          mark(every, bad || tooShort);
          if (bad) problems.push([every, 'Repeat every ' + EVERY_MIN + ' to ' + EVERY_MAX + ' minutes.']);
          else if (tooShort) problems.push([every, 'The countdown (' + cdLen + ' min) must be shorter than the interval.']);
          schedule = { type: 'interval', everyMinutes: n };
        } else if (stype === 'daily') {
          takeTime(); /* a time picked but not added yet still counts */
          const bad = !times.length;
          mark(timeIn, bad);
          if (bad) problems.push([timeIn, 'Add at least one time of day.']);
          schedule = { type: 'daily', times: times.slice().sort() };
        } else {
          const at = srvFromInput(atIn.value);
          const known = Number.isFinite(at);
          const past = known && en.input.checked && at <= Date.now();
          const far = known && at > Date.now() + 366 * 24 * 3600 * 1000;
          mark(atIn, !known || past || far);
          if (!known) problems.push([atIn, 'Pick a date and time.']);
          else if (past) problems.push([atIn, 'Pick a time in the future.']);
          else if (far) problems.push([atIn, 'Pick a time within the next year.']);
          schedule = { type: 'once', at };
        }
        const lo = String(minIn.value).trim();
        const hi = String(maxIn.value).trim();
        const okN = (v) => v === '' || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= PLAYERS_MAX);
        const order = lo !== '' && hi !== '' && okN(lo) && okN(hi) && Number(lo) > Number(hi);
        mark(minIn, !okN(lo) || order);
        mark(maxIn, !okN(hi) || order);
        if (!okN(lo) || !okN(hi)) problems.push([okN(lo) ? maxIn : minIn, 'Player limits are whole numbers from 0 to ' + PLAYERS_MAX + '.']);
        else if (order) problems.push([minIn, '“At least” cannot be more than “at most”.']);
        const conditions = lo === '' && hi === '' ? null
          : Object.assign({}, lo !== '' ? { minPlayers: Number(lo) } : {}, hi !== '' ? { maxPlayers: Number(hi) } : {});
        return { problems, body: { name, kind, payload, schedule, conditions, enabled: en.input.checked } };
      }

      const cancel = el('button', { type: 'button', class: 'btn ghost', text: 'Cancel' });
      const saveBtn = el('button', { type: 'submit', class: 'btn primary', text: editing ? 'Save task' : 'Create task' });
      let exampleSel = null;
      const examples = editing ? [] : TASK_EXAMPLES.filter((x) => !kindLock(x.kind));
      if (examples.length) {
        exampleSel = el('select', { class: 'input adm-task-example', 'aria-label': 'Start from an example' });
        exampleSel.append(el('option', { value: '', text: 'Start from an example…' }));
        examples.forEach((x, i) => exampleSel.append(el('option', { value: String(i), text: x.title })));
        exampleSel.addEventListener('change', () => {
          const x = examples[Number(exampleSel.value)];
          exampleSel.value = '';
          if (x) fill(x);
        });
      }
      /* a countdown in progress keeps running the task it started with */
      let runNote = null;
      if (editing && t.running && t.kind === 'countdown') {
        runNote = callout('clock', 'warn', 'Counting down now'
          + (t.runEndsAt ? ' — ' + actionLabel(t.payload.action).toLowerCase() + ' at ' + srvHHMM(t.runEndsAt) : '')
          + '. Changes apply from the next run; turning Enabled off calls this countdown off.');
      }
      [
        runNote,
        exampleSel,
        field('Name', nameIn, 'Only admins see it — here and in the audit log.'),
        sect('What', field('Kind', kindSeg.el), kindHint, kindLockNote, bBox, cdBox, cBox, preview),
        whenSect,
        sect('Only when (optional)',
          formGrid(
            field('At least', unitInput(minIn, 'players'), null, 'adm-w-3 adm-pair'),
            field('At most', unitInput(maxIn, 'players'), null, 'adm-w-3 adm-pair')),
          el('p', { class: 'adm-note', text: 'Leave blank for no limit. Outside the range a run is skipped and logged.' })),
        en.el,
        summary,
        el('div', { class: 'modal-actions' }, cancel, saveBtn),
      ].forEach((n) => { if (n) form.append(n); });
      const m = SW.ui.modal({
        title: editing ? 'Edit task — ' + (t.name || 'task') : 'New scheduled task',
        body: form, wide: true, class: 'adm-task-dialog',
      });
      cancel.addEventListener('click', () => m.close());

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        /* a change takes the perms of the kind it had and of the one it gets */
        const lock = kindLock(kind) || (editing ? kindLock(t.kind) : null);
        if (lock) { SW.ui.toast(lock, 'error'); return; }
        const out = collect();
        if (out.problems.length) {
          SW.ui.toast(out.problems[0][1] + (out.problems.length > 1 ? ' (+' + (out.problems.length - 1) + ' more)' : ''), 'error');
          try { out.problems[0][0].focus(); } catch (_e) { /* hidden field */ }
          return;
        }
        saveBtn.disabled = true;
        try {
          const res = editing
            ? await SW.api('/api/schedules/' + encodeURIComponent(t.id), { method: 'POST', body: out.body })
            : await SW.api('/api/schedules', { method: 'POST', body: out.body });
          m.close();
          SW.ui.toast(res && res.cancelledRun
            ? 'Saved: ' + out.body.name + ' — the countdown in progress was called off'
            : (editing ? 'Saved: ' : 'Scheduled: ') + out.body.name, 'ok');
          if (!disposed) load(false);
        } catch (_e) { saveBtn.disabled = false; /* toasted — a 400 names the problem */ }
      });

      drawTimes();
      syncEveryChips();
      syncKind();
      syncType();
      setTimeout(() => { try { nameIn.focus({ preventScroll: true }); } catch (_e) { nameIn.focus(); } }, 60);
    }

    /* relative "in 12m" texts tick between refreshes; the list refreshes
     * every 30 s while the tab is visible */
    ticker = setInterval(() => {
      view.querySelectorAll('[data-due]').forEach((n) => { n.textContent = dueText(Number(n.dataset.due)); });
    }, 15000);
    poll = setInterval(() => { if (document.visibilityState === 'visible' && loaded) load(true); }, 30000);
    document.addEventListener('visibilitychange', onVisible);
    load(false);
  }

  /* ========================================================== route table */

  SW.routes.admin = {
    perm: ['broadcast', 'layer', 'match', 'squad', 'team', 'warn', 'kick', 'ban', 'quickcmd'],
    render(main, ctx) { renderAdmin.call(this, main, ctx); },
    cleanup() {},
  };

  /* the hash stays #/console (bookmarks, nav); `label` names the page in the
   * document title */
  SW.routes.console = {
    label: 'Raw command',
    perm: 'raw',
    render(main, ctx) { renderConsole.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.bans = {
    // Readable with plain view (the API serves the list to any view holder,
    // and the dashboard's Active-bans card links here); the nav entry and
    // every action on the page still gate on the ban perm.
    perm: 'view',
    render(main, ctx) { renderBans.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.audit = {
    perm: 'audit',
    render(main, ctx) { renderAudit.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.users = {
    perm: 'users',
    render(main, ctx) { renderUsers.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.roles = {
    perm: ['roles', 'users'], /* read access feeds the Users UI (§1) */
    render(main, ctx) { renderRoles.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.settings = {
    perm: 'settings',
    render(main, ctx) { renderSettings.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.automation = {
    label: 'Automation',
    perm: 'settings',
    render(main, ctx) { renderAutomation.call(this, main, ctx); },
    cleanup() {},
  };
})();
