'use strict';
/* A3 Admin frontend core — app.js
 *
 * Establishes the single global namespace `window.SW` used by every stage.
 * (The namespace, the `sw_session` cookie and the `sw:` storage keys keep
 * their SquadWatch-era names so sessions and preferences survive.)
 *   SW.esc(s)                 HTML-escape (use for any string placed in innerHTML)
 *   SW.api(path, opts)        fetch wrapper (401 -> login, errors -> toast + throw)
 *   SW.icon(name, cls)        inline SVG icon markup string
 *   SW.theme                  current() / set('dark'|'light') / toggle() — dark is the default
 *   SW.ui                     components (toast, modal, confirmModal, popover, table,
 *                             pager, statCard, badge, sevBadge, channelChip, timeAgo,
 *                             fmtDur, fmtClock, fmtTime, fmtNum, sparkline, playerLink,
 *                             playerPopover, copyBtn, killRow, chatRow, feedRow, feedTime,
 *                             flashIn, rconToast, empty, logFeedEmpty, skeleton, pageHead,
 *                             trunc, brandMark, section, el, cssVar, prettyWeapon,
 *                             openLayerPicker, panelPopover, flagLabel, fmtBytes,
 *                             evidenceUploader, evidenceList, evidenceButton,
 *                             openEvidence, evidenceLightbox — evidence API below)
 *   SW.evidence               maxMB() (null until known), noteLimit(mb), check(file)
 *                             precheck mirroring the server's magic-byte rules,
 *                             tray(uploader, label)
 *   SW.sound                  muted(), setMuted(bool), toggle(), chime('call'|'alert');
 *                             window 'sw:sound' {muted} fires on changes
 *   SW.adminCalls             can(), list(), recent(), count(), on(fn) -> unsub, load(),
 *                             loadRecent(), handle(id) — the in-game !admin call inbox
 *   SW.logFeed                game-log health: state(), missing(), copy(what), needs(what);
 *                             '_logfeed' {state} fires on SW.live whenever it changes
 *   SW.live                   SSE pubsub: on(evt, fn) -> unsub, start(), stop(), up.
 *                             Internal events: '_conn' {up, stopped?} and '_resync'
 *                             {downMs} — the latter fires after the stream recovers
 *                             from a drop (overview already refetched): views refetch.
 *                             Internal '_action' {kind, playerId, target, res} fires after
 *                             a warn/kick/ban succeeds; '_evidence' {targetType, targetId}
 *                             after evidence is added or deleted.
 *   SW.routes                 hash route name -> { render(el, ctx), cleanup(), perm?, label? }
 *   SW.actions                admin actions (dialog + POST + rcon toast); warn/kick/ban
 *                             resolve to {kind, res, target:{type, id}|null} or null
 *   SW.state                  { me, bootstrap, overview, snapshot, serverInfo, status,
 *                               tickRate, tickHist, layers, layerInfo, layersCachedAt }
 *   SW.prefs                  localStorage ('sw:' prefix) get/set/del
 *   SW.can(perm), SW.canAny(perms), SW.navigate(hash), SW.currentRouteName()
 *
 * CSP: script-src 'self' — NO inline scripts or on*= attributes anywhere.
 * Everything is wired via addEventListener / delegation from this file, and
 * every game- or user-controlled string goes through textContent or SW.esc.
 * Shell / auth / dashboard styling lives in css/shell.css (docs/DESIGN.md).
 */
(function () {
  const SW = (window.SW = window.SW || {});
  const BRAND = 'A3 Admin';

  /* --------------------------------------------------------------- theme
   * Night ops (dark) is the DEFAULT: no attribute on <html>. 'light'
   * ("Daylight") sets data-theme="light". Applied as soon as this script runs
   * so the first render already uses the stored choice; persisted under the
   * raw key 'sw_theme' ('light' | 'dark'). Canvases re-read their tokens on
   * every draw, so a switch dispatches 'resize' (and 'sw:theme') to redraw.
   */
  function syncThemeMeta() {
    try {
      const meta = document.querySelector('meta[name="theme-color"]');
      const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (meta && bg) meta.setAttribute('content', bg);
    } catch (_e) { /* styles not ready yet */ }
  }
  function applyThemeAttr(light) {
    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }
  SW.theme = {
    current() {
      return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    },
    set(t) {
      const light = t === 'light';
      const root = document.documentElement;
      /* one frame without transitions so every surface flips together */
      root.classList.add('theme-switching');
      applyThemeAttr(light);
      try { localStorage.setItem('sw_theme', light ? 'light' : 'dark'); } catch (_e) { /* storage blocked */ }
      syncThemeMeta();
      window.dispatchEvent(new Event('resize'));
      try { window.dispatchEvent(new CustomEvent('sw:theme', { detail: { theme: light ? 'light' : 'dark' } })); } catch (_e) { /* ignore */ }
      requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
    },
    toggle() { SW.theme.set(SW.theme.current() === 'light' ? 'dark' : 'light'); },
  };
  (function applyStoredTheme() {
    let t = null;
    try { t = localStorage.getItem('sw_theme'); } catch (_e) { t = null; }
    applyThemeAttr(t === 'light');
    syncThemeMeta();
  })();

  SW.state = {
    me: null,
    bootstrap: null,
    overview: null,
    snapshot: null,
    serverInfo: null,
    status: {},
    tickRate: null,
    tickHist: [],
    layers: null,
    layerInfo: null,
    layersCachedAt: null,
  };
  SW.routes = SW.routes || {};
  SW.ui = SW.ui || {};
  SW.actions = SW.actions || {};

  /* ----------------------------------------------------------------- esc */

  SW.esc = function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  /* --------------------------------------------------------------- prefs */

  SW.prefs = {
    get(k, dflt) {
      try {
        const v = localStorage.getItem('sw:' + k);
        return v == null ? dflt : JSON.parse(v);
      } catch (_e) { return dflt; }
    },
    set(k, v) {
      try { localStorage.setItem('sw:' + k, JSON.stringify(v)); } catch (_e) { /* ignore */ }
    },
    del(k) {
      try { localStorage.removeItem('sw:' + k); } catch (_e) { /* ignore */ }
    },
  };

  /* --------------------------------------------------------------- icons */

  const ICONS = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
    live: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    'user-cog': '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h4.5"/><circle cx="18" cy="16" r="3"/><path d="M18 11.5V13"/><path d="M18 19v1.5"/><path d="M22 16h-1.5"/><path d="M15.5 16H14"/>',
    'user-plus': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>',
    'user-minus': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="23" y1="11" x2="17" y2="11"/>',
    'user-x': '<path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="18" y1="8" x2="23" y2="13"/><line x1="23" y1="8" x2="18" y2="13"/>',
    swords: '<polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/><polyline points="14.5 6.5 18 3 21 3 21 6 17.5 9.5"/><line x1="5" y1="14" x2="9" y2="18"/><line x1="7" y1="17" x2="4" y2="20"/><line x1="3" y1="19" x2="5" y2="21"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    'shield-alert': '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    gavel: '<path d="m14 13-7.5 7.5a2.12 2.12 0 1 1-3-3L11 10"/><path d="m16 16 6-6"/><path d="m8 8 6-6"/><path d="m9 7 8 8"/><path d="m21 11-8-8"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    ban: '<circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>',
    scroll: '<path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1H10v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2h4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.9 4.9 1.4 1.4"/><path d="m17.7 17.7 1.4 1.4"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m4.9 19.1 1.4-1.4"/><path d="m17.7 6.3 1.4-1.4"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    warn: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    kick: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6"/><line x1="17" y1="8" x2="22" y2="13"/><line x1="22" y1="8" x2="17" y2="13"/>',
    swap: '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
    radio: '<circle cx="12" cy="12" r="2"/><path d="M4.93 19.07a10 10 0 0 1 0-14.14"/><path d="M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    hab: '<path d="M3 21h18"/><path d="M5 21V10l7-6 7 6v11"/><path d="M9 21v-6h6v6"/>',
    skull: '<circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><path d="M8 20v2h8v-2"/><path d="m12.5 17-.5-1-.5 1h1z"/><path d="M16 20a2 2 0 0 0 1.56-3.25 8 8 0 1 0-11.12 0A2 2 0 0 0 8 20"/>',
    crosshair: '<circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/>',
    target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
    'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
    'chevron-up': '<polyline points="6 15 12 9 18 15"/>',
    'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
    'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
    'chevrons-left': '<polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>',
    'chevrons-right': '<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>',
    'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
    'arrow-up-right': '<line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    broadcast: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    map: '<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>',
    layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    play: '<polygon points="6 4 20 12 6 20"/>',
    pause: '<line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
    edit: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
    filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
    server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>',
    signal: '<path d="M2 20h.01"/><path d="M7 20v-4"/><path d="M12 20v-8"/><path d="M17 20V8"/><path d="M22 4v16"/>',
    'trending-up': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
    zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    'alert-circle': '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    'check-circle': '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    'x-circle': '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    'wifi-off': '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    volume: '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>',
    'volume-x': '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>',
    paperclip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
    film: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  };

  SW.icon = function icon(name, cls) {
    const body = ICONS[name] || ICONS.dot;
    return '<svg class="icon' + (cls ? ' ' + SW.esc(cls) : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
  };

  /* ------------------------------------------------------------ brand mark
   * The A3 Community logo — faceted gold "A" + silver "3" — as transparent
   * PNGs (docs/DESIGN.md §1, §9). Never recolored, outlined or cropped;
   * css/shell.css adds the hairline edge it needs on the light theme. The
   * width/height attributes reserve its box so nothing shifts while it loads.
   * The mark itself reads "A3"; the lockup adds the ADMIN wordmark.
   */
  const MARK_SM = { src: 'brand/a3-mark-sm.png', w: 134, h: 96 };
  const MARK_LG = { src: 'brand/a3-mark.png', w: 401, h: 287 };
  function markImg(height, large) {
    const m = large ? MARK_LG : MARK_SM;
    const hgt = Math.max(12, Math.round(Number(height) || 30));
    const wid = Math.round((hgt * m.w) / m.h);
    return '<img class="brand-mark" src="' + m.src + '" alt="A3" width="' + wid + '" height="' + hgt + '" decoding="async" draggable="false">';
  }
  SW.ui.brandMark = markImg;
  SW.logoSvg = function logoSvg(size) { return markImg(size || 30); }; /* legacy name, now the PNG mark */

  /* ----------------------------------------------------------- DOM helper
   * el(tag, attrs, ...children) — attrs: class, text, html (caller escapes),
   * dataset:{}, on<event>: fn (addEventListener, NOT an inline attribute),
   * anything else -> setAttribute. children: nodes / strings / arrays / null.
   */
  function el(tag, attrs) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') n.className = v;
        else if (k === 'text') n.textContent = v;
        else if (k === 'html') n.innerHTML = v;
        else if (k === 'dataset') Object.assign(n.dataset, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2), v);
        else if (v === true) n.setAttribute(k, '');
        else n.setAttribute(k, String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) appendChild(n, arguments[i]);
    return n;
  }
  function appendChild(n, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach((x) => appendChild(n, x)); return; }
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  SW.ui.el = el;

  function reducedMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (_e) { return false; }
  }

  /* last interaction was the keyboard? (focus the first menu item then) */
  let kbNav = false;
  document.addEventListener('keydown', () => { kbNav = true; }, true);
  document.addEventListener('mousedown', () => { kbNav = false; }, true);
  document.addEventListener('touchstart', () => { kbNav = false; }, { capture: true, passive: true });

  /* ----------------------------------------------------------------- api */

  /* Live alerts (admin calls, join alerts) toast and chime only for events
   * newer than this page load. Event times are server clock; clockSkew
   * (server minus browser, from the HTTP Date header — whole seconds, so
   * the mid-second is assumed) maps them onto the browser clock. */
  const BOOT_AT = Date.now();
  let clockSkew = 0;
  function noteServerDate(h) {
    const t = Date.parse(h || '');
    if (Number.isFinite(t)) clockSkew = t + 500 - Date.now();
  }
  function isAfterBoot(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) return true; /* untimed live events are live */
    return t - clockSkew >= BOOT_AT;
  }

  /* the session is gone: drop to the sign-in page (shared by SW.api and
   * the evidence uploader's XHRs) */
  function signedOut() {
    SW.state.me = null;
    const name = SW.currentRouteName();
    if (name !== 'login' && name !== 'setup' && name !== 'join') {
      SW.live.stop();
      clearToasts();
      document.body.classList.add('chrome-hidden');
      SW.navigate('#/login');
    }
  }
  /* toasts (sticky ones included) belong to the session that raised them */
  function clearToasts() {
    const root = document.getElementById('toasts');
    if (root) root.textContent = '';
  }

  SW.api = async function api(path, opts) {
    opts = opts || {};
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      if (opts.toast !== false) SW.ui.toast('Network error — server unreachable', 'error');
      throw e;
    }
    noteServerDate(res.headers.get('date'));
    if (res.status === 401 && opts.on401 !== 'ignore') {
      signedOut();
      const err = new Error('Not signed in');
      err.status = 401;
      throw err;
    }
    let data = null;
    const ctype = res.headers.get('content-type') || '';
    if (ctype.indexOf('application/json') !== -1) {
      try { data = await res.json(); } catch (_e) { data = null; }
    } else {
      try { data = await res.text(); } catch (_e) { data = null; }
    }
    if (!res.ok) {
      const msg = data && typeof data === 'object' && data.error ? data.error : 'HTTP ' + res.status;
      const err = new Error(msg);
      err.status = res.status;
      err.body = data;
      if (opts.toast !== false) SW.ui.toast(msg, 'error');
      throw err;
    }
    return data;
  };

  /* -------------------------------------------------------------- toasts
   * Bottom-right stack; status edge + icon. opts: {pre, sticky, timeout,
   * icon (overrides the status icon), detail (a quieter second line),
   * actions: [{label, onClick | href, primary}]}. Returns {el, dismiss};
   * callers may append extra controls to el (views-admin adds an expander).
   */
  const TOAST_ICONS = { ok: 'check-circle', error: 'x-circle', warn: 'alert-circle', info: 'info' };
  SW.ui.toast = function toast(msg, kind, opts) {
    kind = kind || 'info';
    opts = opts || {};
    const root = document.getElementById('toasts');
    if (!root) return null;
    const t = el('div', { class: 'toast ' + kind, role: kind === 'error' ? 'alert' : 'status' });
    t.append(el('span', { class: 'toast-icon', html: SW.icon(opts.icon || TOAST_ICONS[kind] || 'info') }));
    const body = el('div', { class: 'toast-body' });
    body.textContent = String(msg == null ? '' : msg);
    t.append(body);
    if (opts.detail != null && opts.detail !== '') {
      t.append(el('div', { class: 'toast-detail', text: String(opts.detail) }));
    }
    if (opts.pre) {
      const p = el('pre', { class: 'toast-pre' });
      p.textContent = String(opts.pre);
      t.append(p);
    }
    let timer = null;
    let gone = false;
    const dismiss = () => {
      if (gone) return;
      gone = true;
      if (timer) clearTimeout(timer);
      t.classList.add('out');
      setTimeout(() => t.remove(), reducedMotion() ? 0 : 200);
    };
    if (opts.actions && opts.actions.length) {
      const row = el('div', { class: 'toast-actions' });
      for (const a of opts.actions) {
        if (!a || !a.label) continue;
        const b = el(a.href ? 'a' : 'button', {
          class: 'btn small ' + (a.primary ? 'primary' : 'ghost'),
          type: a.href ? null : 'button', href: a.href || null, text: a.label,
        });
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (a.onClick) a.onClick(e);
          dismiss();
        });
        row.append(b);
      }
      t.append(row);
    }
    t.addEventListener('click', dismiss);
    root.append(t);
    while (root.children.length > 6) root.firstChild.remove();
    if (!opts.sticky) {
      timer = setTimeout(dismiss, opts.timeout || (opts.pre ? 9000 : 5000));
      /* hovering holds the toast so long messages can be read */
      t.addEventListener('mouseenter', () => { if (timer) { clearTimeout(timer); timer = null; } });
      t.addEventListener('mouseleave', () => { if (!gone && !timer) timer = setTimeout(dismiss, 2500); });
    }
    return { el: t, dismiss };
  };

  /* `res` from an admin endpoint: {ok, rconOk, rconResponse|response}. */
  SW.ui.rconToast = function rconToast(title, res) {
    const bad = res && (res.ok === false || res.rconOk === false);
    const pre = res ? (res.rconResponse != null ? res.rconResponse : res.response) : null;
    SW.ui.toast(title, bad ? 'warn' : 'ok', pre ? { pre: String(pre).slice(0, 800) } : {});
  };

  /* -------------------------------------------------------------- modals
   * modal({title, body (node | caller-escaped html), wide, danger, class,
   * onClose}) -> {el, body, close}. Enter/exit hooks: .modal-backdrop gets
   * .is-open on the next frame and .is-closing while it animates out
   * (css/shell.css).
   */
  let modalSeq = 0;
  /* close() of every open modal: a route change (browser Back, a link inside
   * a dialog) closes them, since they belong to the page being left */
  const openModals = new Set();
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  SW.ui.modal = function modal(o) {
    o = o || {};
    const root = document.getElementById('modal-root');
    const backdrop = el('div', { class: 'modal-backdrop' });
    const titleId = 'sw-modal-' + (++modalSeq);
    const box = el('div', {
      class: 'modal' + (o.wide ? ' wide' : '') + (o.danger ? ' danger' : '') + (o.class ? ' ' + o.class : ''),
      role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId,
    });
    const head = el('div', { class: 'modal-head' });
    if (o.danger) head.append(el('span', { class: 'modal-head-icon', html: SW.icon('warn') }));
    head.append(el('h3', { class: 'modal-title', id: titleId, text: o.title || '' }));
    const xBtn = el('button', { class: 'icon-btn modal-x', html: SW.icon('x'), 'aria-label': 'Close', title: 'Close', type: 'button' });
    head.append(xBtn);
    const content = el('div', { class: 'modal-body' });
    if (typeof o.body === 'string') content.innerHTML = o.body; // caller escapes
    else if (o.body) content.append(o.body);
    box.append(head, content);
    backdrop.append(box);
    const opener = document.activeElement;
    let closed = false;
    root.append(backdrop);
    requestAnimationFrame(() => { if (!closed) backdrop.classList.add('is-open'); });
    const isTop = () => {
      const open = root.querySelectorAll('.modal-backdrop:not(.is-closing)');
      return open.length && open[open.length - 1] === backdrop;
    };
    function close() {
      if (closed) return;
      closed = true;
      openModals.delete(close);
      document.removeEventListener('keydown', onKey);
      backdrop.classList.remove('is-open');
      backdrop.classList.add('is-closing');
      setTimeout(() => backdrop.remove(), reducedMotion() ? 0 : 180);
      if (opener && opener.focus && document.contains(opener) && !document.querySelector('#modal-root .modal-backdrop:not(.is-closing)')) {
        try { opener.focus({ preventScroll: true }); } catch (_e) { /* ignore */ }
      }
      if (o.onClose) o.onClose();
    }
    function onKey(e) {
      if (!isTop()) return;
      if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') { /* keep focus inside the dialog */
        const f = Array.prototype.filter.call(box.querySelectorAll(FOCUSABLE), (n) => n.offsetParent !== null);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKey);
    openModals.add(close);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    xBtn.addEventListener('click', close);
    setTimeout(() => {
      if (closed || box.contains(document.activeElement)) return;
      const f = content.querySelector(FOCUSABLE);
      try { (f || xBtn).focus({ preventScroll: true }); } catch (_e) { /* ignore */ }
    }, 60);
    return { el: box, body: content, close };
  };

  /* confirmModal({title, body, danger, confirmText, fields}) -> Promise<obj|null>
   * field: {name, label, type:'text'|'textarea'|'select'|'number'|'password'|'checkbox',
   *         options:[{value,label}|string], placeholder, value, required, rows,
   *         presets:[string] (clickable chips that fill the field), hint}
   * The footer (.modal-actions) right-aligns Cancel + the confirm button,
   * which is solid red (.btn.danger.solid) for danger confirms.
   */
  SW.ui.confirmModal = function confirmModal(o) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
      const uid = 'f' + (++modalSeq) + '-';
      const form = el('form', { class: 'modal-form' });
      if (o.body) {
        const b = el('div', { class: 'modal-text' });
        if (typeof o.body === 'string') b.textContent = o.body;
        else b.append(o.body);
        form.append(b);
      }
      const inputs = {};
      const fields = o.fields || [];
      for (const f of fields) {
        const id = uid + f.name;
        const wrap = el('div', { class: 'field' + (f.type === 'checkbox' ? ' field-check' : '') });
        let input;
        if (f.type === 'select') {
          input = el('select', { class: 'input', id });
          for (const opt of f.options || []) {
            const val = opt && typeof opt === 'object' ? opt.value : opt;
            const lab = opt && typeof opt === 'object' && opt.label != null ? opt.label : String(val);
            const oEl = el('option', { value: String(val), text: lab });
            if (f.value != null && String(f.value) === String(val)) oEl.selected = true;
            input.append(oEl);
          }
        } else if (f.type === 'textarea') {
          input = el('textarea', { class: 'input', id, rows: String(f.rows || 3), placeholder: f.placeholder || '' });
          if (f.value != null) input.value = String(f.value);
        } else if (f.type === 'checkbox') {
          input = el('input', { type: 'checkbox', id });
          if (f.value) input.checked = true;
        } else {
          input = el('input', { class: 'input', id, type: f.type || 'text', placeholder: f.placeholder || '' });
          if (f.value != null) input.value = String(f.value);
        }
        inputs[f.name] = input;
        if (f.type === 'checkbox') {
          const lab = el('label', { class: 'check-label', for: id });
          lab.textContent = f.label || f.name;
          wrap.append(input, lab);
        } else {
          if (f.label) wrap.append(el('label', { text: f.label, for: id }));
          wrap.append(input);
        }
        if (f.presets && f.presets.length) {
          const row = el('div', { class: 'chip-row preset-row' });
          for (const p of f.presets) {
            const chip = el('button', { type: 'button', class: 'chip preset', text: p, title: p });
            chip.addEventListener('click', () => { input.value = p; input.dispatchEvent(new Event('input')); input.focus(); });
            row.append(chip);
          }
          wrap.append(row);
        }
        if (f.hint) wrap.append(el('div', { class: 'hint', text: f.hint }));
        input.addEventListener('input', () => input.classList.remove('invalid'));
        form.append(wrap);
      }
      const actions = el('div', { class: 'modal-actions' });
      const cancel = el('button', { type: 'button', class: 'btn ghost', text: 'Cancel' });
      const ok = el('button', { type: 'submit', class: 'btn ' + (o.danger ? 'danger solid' : 'primary'), text: o.confirmText || 'Confirm' });
      actions.append(cancel, ok);
      form.append(actions);
      const m = SW.ui.modal({ title: o.title, body: form, danger: o.danger, wide: o.wide, onClose: () => done(null) });
      cancel.addEventListener('click', () => m.close());
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const out = {};
        let bad = false;
        let firstBad = null;
        for (const f of fields) {
          const inp = inputs[f.name];
          const v = f.type === 'checkbox' ? inp.checked : inp.value.trim();
          if (f.required && (v === '' || v == null)) { inp.classList.add('invalid'); bad = true; if (!firstBad) firstBad = inp; continue; }
          inp.classList.remove('invalid');
          out[f.name] = v;
        }
        if (bad) { if (firstBad) firstBad.focus(); return; }
        done(out);
        m.close();
      });
      const first = form.querySelector('input:not([type=checkbox]), textarea, select');
      if (first) setTimeout(() => first.focus(), 30);
    });
  };

  /* ------------------------------------------------------------- popover
   * popover(anchor, items, {align:'start'|'end'}) — item: {label, icon,
   * danger, onClick} | '-' separator | {header} | {heading, sub} (a title
   * block). Calling it again for the anchor that owns the open popover
   * closes it (toggle).
   */
  let activePopover = null;
  let activeAnchor = null;
  SW.ui.closePopover = function closePopover() {
    if (activePopover) { activePopover.remove(); activePopover = null; }
    if (activeAnchor) { activeAnchor.setAttribute('aria-expanded', 'false'); activeAnchor = null; }
  };

  SW.ui.popover = function popover(anchor, items, opts) {
    opts = opts || {};
    if (activePopover && activeAnchor === anchor) { SW.ui.closePopover(); return null; }
    SW.ui.closePopover();
    const root = document.getElementById('popover-root');
    const pop = el('div', { class: 'popover', role: 'menu' });
    for (const it of items) {
      if (it === '-') { pop.append(el('div', { class: 'popover-sep', role: 'separator' })); continue; }
      if (it.header) { pop.append(el('div', { class: 'popover-header', text: it.header })); continue; }
      if (it.heading != null) {
        const tb = el('div', { class: 'popover-title' });
        const main = String(it.heading);
        tb.append(el('div', { class: 'popover-title-main truncate', text: main, title: main }));
        if (it.sub) tb.append(el('div', { class: 'popover-title-sub truncate', text: String(it.sub), title: String(it.sub) }));
        pop.append(tb);
        continue;
      }
      const b = el('button', { type: 'button', class: 'popover-item' + (it.danger ? ' danger' : ''), role: 'menuitem' });
      b.innerHTML = (it.icon ? SW.icon(it.icon) : '') + '<span></span>';
      b.querySelector('span').textContent = it.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); SW.ui.closePopover(); if (it.onClick) it.onClick(); });
      pop.append(b);
    }
    pop.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const list = Array.prototype.slice.call(pop.querySelectorAll('.popover-item'));
      if (!list.length) return;
      e.preventDefault();
      const i = list.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i <= 0 ? list.length - 1 : i - 1);
      list[next].focus();
    });
    root.append(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 200;
    const ph = pop.offsetHeight || 100;
    let x = opts.align === 'end' ? r.right - pw : r.left;
    x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
    let y = r.bottom + 6;
    if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
    pop.style.left = Math.round(x) + 'px';
    pop.style.top = Math.round(y) + 'px';
    activePopover = pop;
    activeAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    if (kbNav) {
      const firstItem = pop.querySelector('.popover-item');
      if (firstItem) firstItem.focus();
    }
    return pop;
  };

  /* panelPopover(anchor, node, {align, class, label}) — a popover holding
   * arbitrary content (the admin-call inbox). Shares the menu machinery:
   * one open at a time, the anchor toggles it, outside press / Escape /
   * resize / page scroll close it. Returns the panel or null (toggled off). */
  SW.ui.panelPopover = function panelPopover(anchor, node, opts) {
    opts = opts || {};
    if (activePopover && activeAnchor === anchor) { SW.ui.closePopover(); return null; }
    SW.ui.closePopover();
    const root = document.getElementById('popover-root');
    const pop = el('div', {
      class: 'popover popover-panel' + (opts.class ? ' ' + opts.class : ''),
      role: 'dialog', 'aria-label': opts.label || null,
    }, node);
    root.append(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 320;
    let x = opts.align === 'end' ? r.right - pw : r.left;
    x = Math.max(8, Math.min(x, window.innerWidth - pw - 8));
    pop.style.left = Math.round(x) + 'px';
    pop.style.top = Math.round(r.bottom + 6) + 'px';
    activePopover = pop;
    activeAnchor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    if (kbNav) {
      const f = pop.querySelector(FOCUSABLE);
      if (f) f.focus({ preventScroll: true });
    }
    return pop;
  };
  document.addEventListener('mousedown', (e) => {
    if (!activePopover || activePopover.contains(e.target)) return;
    if (activeAnchor && activeAnchor.contains(e.target)) return; /* the anchor's own click toggles */
    SW.ui.closePopover();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !activePopover) return;
    e.preventDefault(); /* this Escape is spent: the drawer stays open */
    const a = activeAnchor;
    SW.ui.closePopover();
    if (a && a.focus && document.contains(a)) a.focus();
  });
  window.addEventListener('resize', () => SW.ui.closePopover());
  window.addEventListener('scroll', (e) => {
    if (activePopover && e.target && e.target.nodeType === 1 && activePopover.contains(e.target)) return;
    SW.ui.closePopover();
  }, true);

  /* --------------------------------------------------- player link + menu
   * playerLink(ref, {class}) — ref is a playerRef {dbId, eosId, steamId, name,
   * teamId, squadId, sessKills, sessDeaths, sessTks} (any subset). Click opens
   * the action popover: Profile / Warn / Kick / Ban / Force team / Remove from
   * squad / Watch / Note (each behind its own perm). The full name is the
   * title, so a truncated name is always recoverable.
   */
  SW.ui.playerLink = function playerLink(ref, opts) {
    opts = opts || {};
    ref = ref || {};
    const name = ref.name || 'unknown';
    const s = el('span', {
      class: 'plink' + (opts.class ? ' ' + opts.class : ''),
      tabindex: '0', role: 'button', title: name, 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    });
    s.textContent = name;
    const open = (e) => { e.preventDefault(); e.stopPropagation(); SW.ui.playerPopover(s, ref); };
    s.addEventListener('click', open);
    s.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); });
    return s;
  };

  SW.ui.playerPopover = function playerPopover(anchor, ref) {
    const items = [];
    let sub = null;
    if (ref.steamId) sub = 'Steam ' + ref.steamId;
    else if (ref.eosId) sub = 'EOS ' + ref.eosId;
    items.push({ heading: ref.name || 'Unknown player', sub });
    items.push({
      label: 'Profile', icon: 'user',
      onClick: () => {
        if (ref.dbId || ref.id) SW.navigate('#/players/' + (ref.dbId || ref.id));
        else SW.ui.toast('No stored profile for this player yet', 'warn');
      },
    });
    if (ref.dbId || ref.id || ref.steamId || ref.eosId || ref.name) {
      /* each action behind its own granular perm (§1) */
      const mod = [];
      if (SW.can('warn')) mod.push({ label: 'Warn', icon: 'warn', onClick: () => SW.actions.warn(ref) });
      if (SW.can('kick')) mod.push({ label: 'Kick', icon: 'kick', onClick: () => SW.actions.kick(ref) });
      if (SW.can('ban')) mod.push({ label: 'Ban', icon: 'ban', danger: true, onClick: () => SW.actions.ban(ref) });
      if (SW.can('team')) mod.push({ label: 'Force team change', icon: 'swap', onClick: () => SW.actions.forceTeam(ref) });
      if (SW.can('squad')) mod.push({ label: 'Remove from squad', icon: 'x', onClick: () => SW.actions.removeFromSquad(ref) });
      if (mod.length) { items.push('-'); for (const it of mod) items.push(it); }
      const extra = [];
      if (SW.can('flags')) extra.push({ label: ref.watchlisted ? 'Unwatch' : 'Watch', icon: 'eye', onClick: () => SW.actions.watch(ref, !ref.watchlisted) });
      if (SW.can('notes')) extra.push({ label: 'Add note', icon: 'note', onClick: () => SW.actions.note(ref) });
      if (extra.length) { items.push('-'); for (const it of extra) items.push(it); }
    }
    SW.ui.popover(anchor, items);
  };

  /* ------------------------------------------------------ small components */

  SW.ui.badge = function badge(text, kind, title) {
    const b = el('span', { class: 'badge' + (kind ? ' ' + kind : ''), title: title || null });
    b.textContent = String(text == null ? '' : text);
    return b;
  };

  SW.ui.sevBadge = function sevBadge(sev) {
    const s = Math.min(3, Math.max(1, Number(sev) || 1));
    return SW.ui.badge('S' + s, 'sev' + s, 'Severity ' + s + ' of 3');
  };

  /* human names for flag types; unknown types read as their id */
  const FLAG_LABELS = {
    friendly_radio: 'Friendly radio damage',
    radio_unknown: 'Radio damage (unclassified)',
    tk_spree: 'Teamkill spree',
    mass_tk: 'Mass teamkilling',
    new_player_tk: 'New-player teamkill',
    chat_watchlist: 'Watchlisted chat',
    manual: 'Manual flag',
    'watchlist-join': 'Watchlisted player joined',
    'flagged-join': 'Flagged player joined',
    'ban-evasion': 'Possible ban evasion',
  };
  /* join-alert flag types: the 'alert' event already toasts these */
  const JOIN_ALERT_FLAGS = new Set(['watchlist-join', 'flagged-join', 'ban-evasion']);
  SW.ui.flagLabel = function flagLabel(type) {
    const t = String(type || 'flag');
    if (Object.prototype.hasOwnProperty.call(FLAG_LABELS, t)) return FLAG_LABELS[t];
    const s = t.replace(/[_-]+/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  SW.ui.fmtBytes = function fmtBytes(n) {
    n = Math.max(0, Number(n) || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
    return (n / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  };

  function chanKey(channel) {
    return String(channel || 'all').toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'all';
  }
  /* channel chip colors: all=accent2, team=green, squad=dim, admin=gold */
  SW.ui.channelChip = function channelChip(channel) {
    const ch = String(channel || 'all');
    const c = el('span', { class: 'chip chan ch-' + chanKey(ch), title: 'Channel: ' + ch });
    c.textContent = ch;
    return c;
  };

  /* single-line text that may be long: .truncate + the full text as title */
  SW.ui.trunc = function trunc(text, cls, tag) {
    const s = text == null ? '' : String(text);
    return el(tag || 'span', { class: 'truncate' + (cls ? ' ' + cls : ''), text: s, title: s || null });
  };

  SW.ui.timeAgoText = function timeAgoText(ts) {
    ts = Number(ts);
    if (!ts) return '—';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 10) return 'now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 48) return h + 'h ago';
    const d = Math.floor(h / 24);
    if (d < 14) return d + 'd ago';
    return new Date(ts).toLocaleDateString();
  };

  /* auto-refreshing "4m ago" span (global 30s sweep) */
  SW.ui.timeAgo = function timeAgo(ts) {
    const sp = el('span', { class: 'timeago', title: ts ? new Date(Number(ts)).toLocaleString() : '' });
    if (ts) sp.dataset.ts = String(ts);
    sp.textContent = SW.ui.timeAgoText(ts);
    return sp;
  };
  setInterval(() => {
    document.querySelectorAll('.timeago[data-ts]').forEach((n) => {
      const ts = Number(n.dataset.ts);
      if (ts) n.textContent = SW.ui.timeAgoText(ts);
    });
  }, 30000);

  SW.ui.fmtDur = function fmtDur(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm';
    return (sec % 60) + 's';
  };

  SW.ui.fmtClock = function fmtClock(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const mm = (m < 10 ? '0' : '') + m;
    const ss = (s < 10 ? '0' : '') + s;
    return h ? h + ':' + mm + ':' + ss : mm + ':' + ss;
  };

  SW.ui.fmtTime = function fmtTime(ts) { return ts ? new Date(Number(ts)).toLocaleString() : '—'; };
  /* "2 Nov 16:12" (the year only when it is not this one) — the visible date
   * format the admin pages use; fmtTime's locale string belongs in titles */
  const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  SW.ui.fmtDayTime = function fmtDayTime(ts) {
    const d = new Date(Number(ts));
    if (!ts || Number.isNaN(d.getTime())) return '—';
    const p = (x) => (x < 10 ? '0' : '') + x;
    const y = d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
    return d.getDate() + ' ' + SHORT_MONTHS[d.getMonth()] + y + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  SW.ui.fmtNum = function fmtNum(n) { return (Number(n) || 0).toLocaleString(); };

  /* cssVar('--token') — read a theme token off <html>. Called on every canvas
   * draw so charts pick up the active theme's palette. */
  SW.ui.cssVar = function cssVar(name, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback || '#888888';
    } catch (_e) { return fallback || '#888888'; }
  };

  /* sparkline(canvas, numbers, {width, height, color, min, max, fill}) */
  SW.ui.sparkline = function sparkline(canvas, series, opts) {
    opts = opts || {};
    const dpr = window.devicePixelRatio || 1;
    const w = opts.width || canvas.clientWidth || 110;
    const h = opts.height || canvas.clientHeight || 30;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const data = (series || []).map(Number).filter((n) => Number.isFinite(n));
    if (data.length < 2) return;
    const min = opts.min != null ? opts.min : Math.min.apply(null, data);
    const max = opts.max != null ? opts.max : Math.max.apply(null, data);
    const span = (max - min) || 1;
    const stepX = w / (data.length - 1);
    const color = opts.color || SW.ui.cssVar('--chart-line', '#5AB0FF');
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = i * stepX;
      const y = h - 3 - ((data[i] - min) / span) * (h - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    if (opts.fill !== false) {
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  };

  /* skeleton('line'|'block', width?) — shimmer placeholder while a first
   * fetch is in flight (DESIGN §5). */
  SW.ui.skeleton = function skeleton(kind, width) {
    const s = el('span', { class: 'skeleton ' + (kind === 'block' ? 'block' : 'line'), 'aria-hidden': 'true' });
    if (width != null) s.style.width = typeof width === 'number' ? width + 'px' : String(width);
    return s;
  };

  /* statCard({icon, label, value, sub, accent:'red'|'warn'|'gold'|'green', href,
   * onClick, title, spark:[...], meter:bool, loading:bool, crossfade:bool, class})
   * -> element with .set(value, sub?, {title, subTitle}), .setSpark(series, color),
   * .setMeter(0..1). Label on top, icon chip top-right, value single-line
   * (ellipsis + title) in the display face, optional sub-line; .hud brackets.
   */
  SW.ui.statCard = function statCard(o) {
    o = o || {};
    const clickable = !!(o.href || o.onClick);
    const card = el(o.href ? 'a' : 'div', {
      class: 'stat-card stat-tile hud' + (o.accent ? ' accent-' + o.accent : '') + (clickable ? ' clickable' : '') + (o.class ? ' ' + o.class : ''),
      href: o.href || null,
      title: o.title || null,
    });
    if (o.onClick && !o.href) {
      card.setAttribute('role', 'button');
      card.tabIndex = 0;
      card.addEventListener('keydown', (e) => {
        if (e.target !== card) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); o.onClick(e); }
      });
    }
    const top = el('div', { class: 'stat-top' });
    const labEl = el('div', { class: 'stat-label truncate' });
    labEl.textContent = o.label || '';
    top.append(labEl);
    if (o.icon) top.append(el('span', { class: 'stat-icon', html: SW.icon(o.icon) }));
    const valRow = el('div', { class: 'stat-valrow' });
    const valEl = el('div', { class: 'stat-value display tabular truncate' });
    valRow.append(valEl);
    const subEl = el('div', { class: 'stat-sub truncate' });
    card.append(top, valRow, subEl);
    let meter = null;
    if (o.meter) {
      meter = el('div', { class: 'stat-meter', 'aria-hidden': 'true' }, el('i'));
      card.append(meter);
    }
    let sparkCv = null;
    const ensureSpark = () => {
      if (!sparkCv) { sparkCv = el('canvas', { class: 'stat-spark', 'aria-hidden': 'true' }); valRow.append(sparkCv); }
      return sparkCv;
    };
    function setValue(v, title) {
      const s = v == null ? '—' : String(v);
      const wasLoading = valEl.classList.contains('is-loading');
      const changed = wasLoading || valEl.textContent !== s;
      valEl.classList.remove('is-loading');
      valEl.textContent = s;
      valEl.title = title != null ? String(title) : s;
      if (changed && (o.crossfade || wasLoading) && card.isConnected && !reducedMotion()) {
        valEl.classList.remove('xfade');
        void valEl.offsetWidth; /* restart the cross-fade */
        valEl.classList.add('xfade');
      }
    }
    function setSub(sub, title) {
      subEl.textContent = '';
      subEl.removeAttribute('title');
      if (sub == null || sub === '') return;
      if (typeof sub === 'string' || typeof sub === 'number') {
        subEl.textContent = String(sub);
        subEl.title = title != null ? String(title) : String(sub);
      } else {
        subEl.append(sub);
        if (title != null) subEl.title = String(title);
      }
    }
    if (o.loading) {
      valEl.classList.add('is-loading');
      valEl.append(SW.ui.skeleton('line'));
    } else setValue(o.value);
    if (o.sub != null) setSub(o.sub);
    if (o.spark) requestAnimationFrame(() => SW.ui.sparkline(ensureSpark(), o.spark, { width: 64, height: 24, color: o.sparkColor }));
    if (o.onClick) card.addEventListener('click', o.onClick);
    card.set = function (value, sub, opts2) {
      opts2 = opts2 || {};
      if (value !== undefined) setValue(value, opts2.title);
      if (sub !== undefined) setSub(sub, opts2.subTitle);
    };
    card.setSpark = function (series, color) {
      SW.ui.sparkline(ensureSpark(), series, { width: 64, height: 24, color: color || o.sparkColor });
    };
    card.setMeter = function (frac) {
      if (!meter) return;
      const f = Math.max(0, Math.min(1, Number(frac) || 0));
      meter.firstChild.style.transform = 'scaleX(' + f.toFixed(3) + ')';
      meter.classList.toggle('full', f >= 0.98);
    };
    return card;
  };

  /* table(cols, rows, opts) -> .table-wrap element with .update(rows)
   * col: {key, label, sortable, render(row)->node|string, sortVal(row), align:'right',
   *       width, class, truncate} — plain strings from render/row[key] are set via
   *       textContent; long ones also become the cell title (truncate:true wraps
   *       them in .truncate). The wrapper scrolls horizontally, never the page.
   * opts: {sort:{key,dir}, storeKey (persist sort in localStorage), onSort(key,dir)
   *       (server-side mode: no local sort), rowClass(row), onRowClick(row), emptyText,
   *       stickyFirst (first column .sticky-col), class}
   */
  SW.ui.table = function table(cols, rows, opts) {
    opts = opts || {};
    let data = rows || [];
    const storeKey = opts.storeKey ? 'sort:' + opts.storeKey : null;
    let sort = opts.sort || (storeKey ? SW.prefs.get(storeKey, null) : null);
    const wrap = el('div', { class: 'table-wrap' + (opts.class ? ' ' + opts.class : '') });
    const t = el('table', { class: 'table' });
    const thead = el('thead');
    const trh = el('tr');
    const cellClass = (c, i, base) => [base || '', c.align === 'right' ? 'num' : '', (opts.stickyFirst && i === 0) ? 'sticky-col' : '']
      .filter(Boolean).join(' ');
    cols.forEach((c, i) => {
      const th = el('th', {
        scope: 'col',
        class: (cellClass(c, i, c.sortable ? 'sortable' : '') || null),
        style: c.width ? 'width:' + c.width : null,
      });
      const lbl = el('span', { class: 'th-label' });
      lbl.textContent = c.label != null ? c.label : c.key;
      th.append(lbl);
      if (c.sortable) {
        th.tabIndex = 0;
        th.append(el('span', { class: 'sort-arrow', 'aria-hidden': 'true' }));
        const go = () => {
          const dir = sort && sort.key === c.key && sort.dir === 'desc' ? 'asc' : 'desc';
          sort = { key: c.key, dir };
          if (storeKey) SW.prefs.set(storeKey, sort);
          if (opts.onSort) { opts.onSort(c.key, dir); markSort(); return; }
          renderBody();
          markSort();
        };
        th.addEventListener('click', go);
        th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      }
      trh.append(th);
    });
    thead.append(trh);
    const tbody = el('tbody');
    t.append(thead, tbody);
    wrap.append(t);
    function markSort() {
      Array.prototype.forEach.call(trh.children, (th, i) => {
        const c = cols[i];
        const on = !!(sort && c && sort.key === c.key);
        th.classList.toggle('sorted-asc', on && sort.dir === 'asc');
        th.classList.toggle('sorted-desc', on && sort.dir === 'desc');
        if (c && c.sortable) th.setAttribute('aria-sort', on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none');
      });
    }
    function sortedRows() {
      if (!sort || opts.onSort) return data;
      const c = cols.find((x) => x.key === sort.key);
      if (!c) return data;
      const dir = sort.dir === 'asc' ? 1 : -1;
      return data.slice().sort((a, b) => {
        const va = c.sortVal ? c.sortVal(a) : a[c.key];
        const vb = c.sortVal ? c.sortVal(b) : b[c.key];
        if (va == null && vb == null) return 0;
        if (va == null) return 1;
        if (vb == null) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir;
        return String(va).localeCompare(String(vb)) * dir;
      });
    }
    function renderBody() {
      tbody.textContent = '';
      const rs = sortedRows();
      if (!rs.length) {
        const td = el('td', { colspan: String(cols.length), class: 'empty-cell' });
        td.textContent = opts.emptyText || 'Nothing here yet';
        tbody.append(el('tr', { class: 'empty-row' }, td));
        return;
      }
      for (const row of rs) {
        const tr = el('tr', { class: opts.rowClass ? (opts.rowClass(row) || null) : null });
        cols.forEach((c, i) => {
          const td = el('td', { class: (cellClass(c, i, c.class || '') + (c.align === 'right' ? ' tabular' : '')).trim() || null });
          const out = c.render ? c.render(row) : row[c.key];
          if (out == null || out === '') { td.textContent = '—'; td.classList.add('nil'); }
          else if (out.nodeType) td.append(out);
          else {
            const s = String(out);
            if (c.truncate) td.append(el('span', { class: 'truncate cell-trunc', text: s, title: s }));
            else {
              td.textContent = s;
              if (s.length > 24) td.title = s;
            }
          }
          tr.append(td);
        });
        if (opts.onRowClick) {
          tr.classList.add('clickable');
          tr.addEventListener('click', (e) => {
            if (e.target.closest('.plink, button, a, input, select')) return;
            opts.onRowClick(row);
          });
        }
        tbody.append(tr);
      }
    }
    renderBody();
    markSort();
    wrap.update = function (newRows) { data = newRows || []; renderBody(); };
    return wrap;
  };

  /* pager({page (0-based), per, total, onPage(newPage)}) */
  SW.ui.pager = function pager(o) {
    const per = o.per || 50;
    const pages = Math.max(1, Math.ceil((o.total || 0) / per));
    const w = el('div', { class: 'pager' });
    const prev = el('button', { type: 'button', class: 'btn ghost small icon-only', html: SW.icon('chevron-left'), 'aria-label': 'Previous page', title: 'Previous page' });
    const next = el('button', { type: 'button', class: 'btn ghost small icon-only', html: SW.icon('chevron-right'), 'aria-label': 'Next page', title: 'Next page' });
    const lab = el('span', { class: 'pager-label dim tabular' });
    lab.textContent = 'Page ' + (o.page + 1) + ' of ' + pages + ' · ' + SW.ui.fmtNum(o.total || 0) + ' rows';
    prev.disabled = o.page <= 0;
    next.disabled = o.page >= pages - 1;
    prev.addEventListener('click', () => o.onPage(o.page - 1));
    next.addEventListener('click', () => o.onPage(o.page + 1));
    w.append(prev, lab, next);
    return w;
  };

  SW.ui.copyBtn = function copyBtn(text, label) {
    const b = el('button', { type: 'button', class: 'icon-btn copybtn', title: 'Copy', 'aria-label': 'Copy' });
    const idle = SW.icon('copy') + (label ? '<span>' + SW.esc(label) + '</span>' : '');
    b.innerHTML = idle;
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(String(text));
        b.innerHTML = SW.icon('check') + (label ? '<span>' + SW.esc(label) + '</span>' : '');
        b.classList.add('copied');
        setTimeout(() => { b.innerHTML = idle; b.classList.remove('copied'); }, 1200);
      } catch (_err) {
        SW.ui.toast('Copy failed', 'error');
      }
    });
    return b;
  };

  /* empty(title, icon, {hint, action:{label, href|onClick, icon}, compact})
   * — centered icon + one-line title + optional hint/primary action. Keeps the
   * legacy .empty-state class (views look it up to clear it). */
  SW.ui.empty = function empty(text, iconName, opts) {
    opts = opts || {};
    const d = el('div', { class: 'empty empty-state' + (opts.compact ? ' compact' : '') + (opts.class ? ' ' + opts.class : '') });
    d.innerHTML = SW.icon(iconName || 'search'); /* direct child: style.css draws its radar disc */
    d.append(el('p', { class: 'empty-title', text: text || 'Nothing here' }));
    if (opts.hint) d.append(el('p', { class: 'empty-hint', text: opts.hint }));
    if (opts.action && opts.action.label) {
      const a = opts.action;
      const b = el(a.href ? 'a' : 'button', {
        class: 'btn primary small empty-action', href: a.href || null, type: a.href ? null : 'button',
        html: (a.icon ? SW.icon(a.icon) : '') + '<span></span>',
      });
      b.querySelector('span').textContent = a.label;
      if (a.onClick) b.addEventListener('click', a.onClick);
      d.append(b);
    }
    return d;
  };

  /* logFeedEmpty({what, compact}) — the empty state of a list fed only by
   * the game log while that feed is off or failing (SW.logFeed.missing()):
   * it says so, with a Settings shortcut for holders of the settings perm,
   * instead of claiming there is nothing to show. */
  SW.ui.logFeedEmpty = function logFeedEmpty(o) {
    o = o || {};
    const c = SW.logFeed.copy(o.what);
    return SW.ui.empty(c.title, 'scroll', { compact: o.compact, hint: c.hint, action: c.action, class: 'logfeed-empty' });
  };

  /* pageHead({title, sub (string|node), actions:[nodes]}) -> .page-head; the
   * sub element is exposed as .subEl so callers can update it in place. */
  SW.ui.pageHead = function pageHead(o) {
    o = o || {};
    const h = el('div', { class: 'page-head' });
    const left = el('div', { class: 'page-head-main' });
    left.append(el('h1', { class: 'page-title', text: o.title || '' }));
    const sub = el('div', { class: 'page-sub truncate' });
    if (o.sub != null) {
      if (typeof o.sub === 'string') { sub.textContent = o.sub; sub.title = o.sub; }
      else sub.append(o.sub);
    }
    left.append(sub);
    h.append(left);
    if (o.actions && o.actions.length) h.append(el('div', { class: 'page-actions' }, o.actions));
    h.subEl = sub;
    return h;
  };

  SW.ui.section = function section(title) {
    const s = el('section', { class: 'section' });
    if (title) s.append(el('h2', { class: 'section-title', text: title }));
    for (let i = 1; i < arguments.length; i++) appendChild(s, arguments[i]);
    return s;
  };

  /* ------------------------------------------------------ feed row builders
   * One anatomy for every feed (DESIGN §5): time gutter · icon · content
   * (names truncate, title = full name) · trailing meta. killRow / chatRow
   * take §7 enriched payloads and are reused by all stages (dashboard feeds,
   * live feed, match detail, profile timelines). Pass {flash:true} — or wrap
   * with SW.ui.flashIn(row) — only for rows that arrive live, never backfill.
   */
  SW.ui.flashIn = function flashIn(node) {
    if (!node || !node.classList || reducedMotion()) return node;
    node.classList.add('flash-in');
    setTimeout(() => node.classList.remove('flash-in'), 1500);
    return node;
  };

  /* gutter clock: "21:04:13" today, "Nov 2" for older events (full date-time
   * in the title) — the same format the Live feed uses */
  function clockText(ts) {
    const n = Number(ts);
    const d = new Date(n);
    if (!n || Number.isNaN(d.getTime())) return '—';
    const p = (x) => (x < 10 ? '0' : '') + x;
    if (d.toDateString() === new Date().toDateString()) return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function feedTime(ts) {
    return el('span', { class: 'feed-time mono', text: clockText(ts), title: Number(ts) ? SW.ui.fmtTime(ts) : null });
  }
  SW.ui.feedTime = feedTime;

  /* feedRow({kind, time, icon, iconClass, main:[nodes], meta:[nodes], flash}) */
  SW.ui.feedRow = function feedRow(o) {
    o = o || {};
    const row = el('div', { class: 'feed-row ui-row' + (o.kind ? ' ' + o.kind : '') });
    row.append(feedTime(o.time));
    row.append(el('span', { class: 'feed-icon' + (o.iconClass ? ' ' + o.iconClass : ''), html: o.icon ? SW.icon(o.icon) : '' }));
    row.append(el('span', { class: 'feed-main' }, o.main || null));
    if (o.meta) row.append(el('span', { class: 'feed-meta' }, o.meta));
    if (o.flash) SW.ui.flashIn(row);
    return row;
  };

  /* "BP_M4_M68_Woodland_C_2147480342" -> "M4 M68 Woodland" (raw stays the title) */
  SW.ui.prettyWeapon = function prettyWeapon(w) {
    const raw = String(w == null ? '' : w);
    const s = raw.replace(/^BP_/i, '').replace(/_C(_\d+)?$/i, '').replace(/_\d{5,}$/, '').replace(/_/g, ' ').trim();
    return s || raw;
  };

  SW.ui.killRow = function killRow(k, opts) {
    k = k || {};
    const tk = !!k.teamkill;
    const died = k.kind === 'die';
    const row = el('div', { class: 'feed-row ui-row kill' + (tk ? ' tk' : '') + (died ? ' died' : '') + (k.suicide ? ' suicide' : '') });
    row.append(feedTime(k.time));
    row.append(el('span', {
      class: 'feed-icon' + (tk ? ' is-tk' : ''),
      html: SW.icon(tk ? 'warn' : (k.suicide || died ? 'skull' : 'crosshair')),
    }));
    const main = el('span', { class: 'feed-main' });
    if (k.suicide) {
      main.append(SW.ui.playerLink(k.victim || {}));
      main.append(el('span', { class: 'feed-verb', text: 'died (suicide)' }));
    } else {
      if (k.attacker) main.append(SW.ui.playerLink(k.attacker));
      else main.append(el('span', { class: 'feed-verb', text: 'environment' }));
      main.append(el('span', { class: 'kill-arrow', html: SW.icon('chevron-right') }));
      main.append(SW.ui.playerLink(k.victim || {}));
      if (died) main.append(el('span', { class: 'feed-verb', text: 'gave up' }));
    }
    row.append(main);
    if (tk || k.weapon) {
      const meta = el('span', { class: 'feed-meta' });
      if (tk) meta.append(SW.ui.badge('TK', 'red', 'Teamkill'));
      if (k.weapon) meta.append(el('span', { class: 'feed-weapon mono truncate', text: SW.ui.prettyWeapon(k.weapon), title: String(k.weapon) }));
      row.append(meta);
    }
    if (opts && opts.flash) SW.ui.flashIn(row);
    return row;
  };

  SW.ui.chatRow = function chatRow(c, opts) {
    c = c || {};
    const ch = chanKey(c.channel);
    const row = el('div', { class: 'feed-row ui-row chat-line chan-' + ch + (ch === 'admin' ? ' admin-chat' : '') });
    row.append(feedTime(c.time));
    row.append(el('span', { class: 'feed-icon chan-icon ch-' + ch, html: SW.icon('chat') }));
    const main = el('span', { class: 'feed-main chat-main' });
    main.append(SW.ui.channelChip(c.channel));
    main.append(SW.ui.playerLink(c.player || { name: '?' }));
    const msg = el('span', { class: 'feed-msg wrap-anywhere' });
    msg.textContent = c.message || '';
    main.append(msg);
    row.append(main);
    if (opts && opts.flash) SW.ui.flashIn(row);
    return row;
  };

  /* ------------------------------------------------------------- evidence
   * Files attached to a ban (targetType 'ban', the bans.id) or to an admin
   * action ('action', the admin_actions id of a warn / kick / ban) —
   * docs/BATCH3-CONTRACTS.md §1. The server types a file by its magic bytes;
   * SW.evidence.check() mirrors those rules and the size limit, so a file
   * that would bounce is refused before a byte is sent. Uploads use
   * XMLHttpRequest for its upload progress events (fetch has none).
   *
   * The page CSP allows neither blob: images nor blob: media, so picked
   * images get canvas thumbnails (createImageBitmap) and other kinds an
   * icon; stored files are same-origin URLs and render directly.
   *
   *   SW.ui.evidenceUploader({targetType, targetId, existing, readyText, noun,
   *       compact, onUploaded(evidence), onState(state)}) -> element with addFiles(list),
   *       setTarget(type, id), start(), state(), busy(), hasFiles(),
   *       onState(fn) -> unsub, retryFailed(), target(), setDropTarget(node),
   *       detach(). Without a targetId picked files wait until setTarget() +
   *       start() (the warn / kick / ban dialogs upload once the action went
   *       through). In-flight uploads outlive the element. existing: the
   *       target's stored file count — a number, or a function whose count
   *       includes this uploader's finished uploads (a list fed by
   *       onUploaded). state() counts {done, failed, active, checking, …,
   *       refused}: files turned away once uploading began, with their
   *       reasons in refusedWhy.
   *   SW.ui.evidenceList({targetType, targetId, rows?, count?, compact,
   *       allowDelete, emptyText, onChange(rows)}) -> element with reload(),
   *       add(evidence), rows(), count(): image thumbnails, video tiles,
   *       PDF / text chips, the lightbox, delete where allowed.
   *   SW.ui.evidenceButton({targetType, targetId, count, title, subtitle,
   *       canUpload, onChange(rows)}) -> a paperclip + count button (setCount(n))
   *       that opens openEvidence().
   *   SW.ui.openEvidence({targetType, targetId, title, subtitle, canUpload,
   *       onChange(rows), onClose}) -> {close}: the list + an uploader.
   *   SW.ui.evidenceLightbox(rows, index, {onDelete(row)}) -> {close}
   */
  const MB = 1024 * 1024;
  const EV_TEXT_MAX = 2 * MB;
  const EV_MAX_FILES = 20;
  const EV_CAPTION_MAX = 300;
  const EV_CEILING_MB = 100; /* the largest evidence.maxMB Settings accepts */
  const EV_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm,' +
    'video/x-matroska,.mp4,.m4v,.mov,.webm,.mkv,application/pdf,.pdf,text/plain,.txt,.log,.csv,.json,.md';
  const EV_TYPES = 'PNG, JPEG, GIF, WEBP, MP4, MOV, WEBM, MKV, PDF or plain text';
  const EV_BUSY_STATES = { queued: 1, uploading: 1 };
  const EV_LIVE_STATES = { ready: 1, queued: 1, uploading: 1, done: 1, failed: 1 };

  let evMaxMB = null;
  let evLimitAsked = false;
  const evHintSyncs = new Set(); /* attached uploaders' drop-zone hints */
  function evNoteLimit(mb) {
    const n = Number(mb);
    if (!Number.isFinite(n) || n < 1 || n > EV_CEILING_MB || n === evMaxMB) return;
    evMaxMB = n;
    for (const fn of Array.from(evHintSyncs)) {
      try { fn(); } catch (e) { console.error('evidence hint', e); }
    }
  }
  /* the limit lives in Settings — readable to settings holders only;
   * everyone else learns it from an evidence list or a 413. Until it is
   * known only the ceiling is checked here, and the server decides. */
  function evLearnLimit() {
    if (evLimitAsked || evMaxMB != null || !SW.can('settings')) return;
    evLimitAsked = true;
    SW.api('/api/settings', { toast: false }).then((r) => {
      const ev = r && r.config && r.config.evidence;
      if (ev) evNoteLimit(ev.maxMB);
    }).catch(() => { /* the server's 413 still teaches it */ });
  }
  /* the per-file limit in MB, or null while unknown */
  function evLimit() { return evMaxMB; }
  /* why a file of `size` bytes is too large, or null */
  function evTooLarge(size) {
    const limit = evMaxMB != null ? evMaxMB : EV_CEILING_MB;
    if (size <= limit * MB) return null;
    return 'Too large — ' + SW.ui.fmtBytes(size) + (evMaxMB != null
      ? '; the limit is ' + limit + ' MB per file'
      : '; the panel takes at most ' + limit + ' MB per file');
  }

  function evAscii(b, at, n) {
    let s = '';
    for (let i = at; i < at + n && i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }
  function evBytesAt(b, at, sig) {
    if (b.length < at + sig.length) return false;
    for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
    return true;
  }
  /* The rules below mirror server/evidence.js sniff() / textAllowed(). */
  /* ISO-BMFF brands of still images (HEIC / AVIF): an ftyp box, not a video */
  const FTYP_STILL = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs',
    'mif1', 'mif2', 'msf1', 'miaf']);
  /* the EBML header's DocType ('webm' / 'matroska'), or null */
  function ebmlDocType(b) {
    const lim = Math.min(b.length, 64);
    for (let i = 4; i + 2 < lim; i++) {
      if (b[i] !== 0x42 || b[i + 1] !== 0x82) continue;
      const first = b[i + 2];
      let len = 1;
      while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
      if (len > 8 || i + 2 + len > lim) return null;
      let size = first & (0xff >> len);
      for (let k = 1; k < len; k++) size = size * 256 + b[i + 2 + k];
      const start = i + 2 + len;
      if (size < 1 || size > 16 || start + size > lim) return null;
      return evAscii(b, start, size).replace(/\0+$/, '');
    }
    return null;
  }
  /* the binary type the first bytes declare; {reject} for a known
   * container the panel refuses; null = no signature (maybe plain text) */
  function sniffEvidence(b) {
    if (!b || !b.length) return null;
    if (evBytesAt(b, 0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return { kind: 'image', mime: 'image/png', label: 'PNG' };
    if (evBytesAt(b, 0, [0xFF, 0xD8, 0xFF])) return { kind: 'image', mime: 'image/jpeg', label: 'JPEG' };
    const gif = evAscii(b, 0, 6);
    if (gif === 'GIF87a' || gif === 'GIF89a') return { kind: 'image', mime: 'image/gif', label: 'GIF' };
    if (evAscii(b, 0, 4) === 'RIFF' && evAscii(b, 8, 4) === 'WEBP') return { kind: 'image', mime: 'image/webp', label: 'WEBP' };
    if (b.length >= 12 && evAscii(b, 4, 4) === 'ftyp') {
      const brand = evAscii(b, 8, 4);
      if (FTYP_STILL.has(brand)) return { reject: 'HEIC / AVIF photos are not accepted — export the picture as JPEG or PNG' };
      if (!/^[\x20-\x7e]{4}$/.test(brand)) return { reject: 'This video could not be recognised — export it as MP4' };
      return brand === 'qt  ' ? { kind: 'video', mime: 'video/quicktime', label: 'MOV' } : { kind: 'video', mime: 'video/mp4', label: 'MP4' };
    }
    if (evBytesAt(b, 0, [0x1A, 0x45, 0xDF, 0xA3])) {
      const doc = ebmlDocType(b);
      if (doc === 'webm') return { kind: 'video', mime: 'video/webm', label: 'WEBM' };
      if (doc === 'matroska') return { kind: 'video', mime: 'video/x-matroska', label: 'MKV' };
      return { reject: 'This video could not be recognised — export it as MP4 or WEBM' };
    }
    if (evAscii(b, 0, 5) === '%PDF-') return { kind: 'pdf', mime: 'application/pdf', label: 'PDF' };
    return null;
  }
  function evExt(name) {
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }
  const EV_TEXT_EXT = /^(txt|log|csv|json|md|cfg|ini)$/;
  /* why a file is refused — specific where the name or bytes tell us */
  function evUnsupported(name, b) {
    const e = evExt(name);
    if (/^(zip|rar|7z|gz|tgz|tar|bz2|xz)$/.test(e) || evBytesAt(b, 0, [0x50, 0x4B, 0x03, 0x04]) ||
      evAscii(b, 0, 4) === 'Rar!' || evBytesAt(b, 0, [0x37, 0x7A, 0xBC, 0xAF])) {
      return 'Archives are not accepted — attach the files inside instead';
    }
    if (/^(exe|msi|dll|scr|com|bat|cmd|ps1|sh|vbs|js|jar|apk|app|dmg)$/.test(e) || evAscii(b, 0, 2) === 'MZ') {
      return 'Programs and scripts cannot be attached';
    }
    if (/^(svg|html?|xml|xhtml)$/.test(e)) return 'Web pages and SVG are not accepted — attach a screenshot or PDF instead';
    if (/^(bmp|tiff?|ico|psd|raw|cr2|nef|dng|heic|heif|avif)$/.test(e)) return 'This image format is not accepted — save it as PNG or JPEG';
    if (/^(avi|wmv|flv|mpe?g|3gp|ts|ogv|ogg)$/.test(e)) return 'This video format is not accepted — use MP4, MOV, WEBM or MKV';
    if (/^(mp3|wav|m4a|flac|aac|opus)$/.test(e)) return 'Audio files are not accepted — attach a video clip instead';
    if (/^(docx?|xlsx?|pptx?|odt|ods|rtf|pages)$/.test(e)) return 'Office documents are not accepted — export a PDF instead';
    return 'Not a supported file — use ' + EV_TYPES;
  }
  /* text a browser could sniff — or a desktop program open — as HTML / SVG /
   * XML is refused like markup files are */
  const EV_MARKUP_START_RE = new RegExp(
    '^\\s*<(?:!doctype|!--|\\?xml|(?:a|b|base|body|br|div|embed|font|form|frame|frameset|h1|head|html|iframe|img|' +
    'link|math|meta|object|p|script|style|svg|table|template|title)(?=[\\s/>]|$))', 'i');
  const EV_MARKUP_ANY_RE = /<(?:!doctype|\?xml|(?:embed|frame|frameset|html|iframe|object|script|svg)(?=[\s/>]))/i;

  /* evCheck(file) -> Promise<{ok, info:{kind, mime, label}} | {error}> */
  async function evCheck(file) {
    const name = String((file && file.name) || 'file');
    const size = Number(file && file.size) || 0;
    if (!size) return { error: 'This file is empty' };
    const big = evTooLarge(size);
    if (big) return { error: big };
    let head;
    try { head = new Uint8Array(await file.slice(0, 64).arrayBuffer()); }
    catch (_e) { return { error: 'This file could not be read' }; }
    const t = sniffEvidence(head);
    if (t && t.reject) return { error: t.reject };
    if (t) return { ok: true, info: t };
    if (size > EV_TEXT_MAX) {
      return { error: EV_TEXT_EXT.test(evExt(name)) ? 'Text files are limited to 2 MB — trim it or attach a screenshot' : evUnsupported(name, head) };
    }
    let buf;
    try { buf = new Uint8Array(await file.arrayBuffer()); }
    catch (_e) { return { error: 'This file could not be read' }; }
    if (buf.indexOf(0) !== -1) return { error: evUnsupported(name, head) };
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (_e) {
      return { error: EV_TEXT_EXT.test(evExt(name)) ? 'Text files must be UTF-8 — save it again as UTF-8' : evUnsupported(name, head) };
    }
    if (/^\s*#!/.test(text) || EV_MARKUP_START_RE.test(text) || EV_MARKUP_ANY_RE.test(text)) {
      return { error: 'Web pages, SVG and scripts are not accepted — attach a screenshot or PDF instead' };
    }
    return { ok: true, info: { kind: 'text', mime: 'text/plain', label: 'TXT' } };
  }

  /* uploads queued or in flight, page-wide: leaving would cut them off */
  let evActive = 0;
  window.addEventListener('beforeunload', (e) => {
    if (evActive <= 0) return;
    e.preventDefault();
    e.returnValue = '';
  });
  function dragHasFiles(e) {
    const types = e && e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true;
    return false;
  }
  /* a file dropped beside a drop zone must not make the browser leave the
   * panel to display it; zones handle their own drops first */
  window.addEventListener('dragover', (e) => {
    if (e.defaultPrevented || !dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'none';
  });
  window.addEventListener('drop', (e) => {
    if (!e.defaultPrevented && dragHasFiles(e)) e.preventDefault();
  });

  function finePointer() {
    try { return window.matchMedia('(pointer: fine)').matches; } catch (_e) { return true; }
  }
  function isTopModal(node) {
    const open = document.querySelectorAll('#modal-root .modal-backdrop:not(.is-closing)');
    return !!(open.length && open[open.length - 1].contains(node));
  }
  /* "C:\fakepath\shot.png" / control characters -> a tidy file name */
  function evCleanName(n) {
    const s = String(n == null ? '' : n).split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
    return (s || 'file').slice(0, 200);
  }
  function evStamp() {
    const d = new Date();
    const p = (x) => (x < 10 ? '0' : '') + x;
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  const EV_KIND_ICON = { image: 'image', video: 'film', pdf: 'file', text: 'note' };

  let evSeq = 0;
  SW.ui.evidenceUploader = function evidenceUploader(o) {
    o = o || {};
    evLearnLimit();
    let target = o.targetId != null && o.targetType ? { type: String(o.targetType), id: Number(o.targetId) } : null;
    let started = !!target;
    const items = [];
    const stateSubs = new Set();
    if (typeof o.onState === 'function') stateSubs.add(o.onState);
    const uid = 'evu' + (++evSeq);
    const touch = !finePointer();

    const input = el('input', { type: 'file', multiple: true, accept: EV_ACCEPT, class: 'ev-up-input', tabindex: '-1', 'aria-hidden': 'true' });
    const zone = el('button', { type: 'button', class: 'ev-drop', 'aria-describedby': uid + '-hint' });
    const zoneTitle = el('span', { class: 'ev-drop-title' });
    if (touch) zoneTitle.append('Tap to add photos, clips or files');
    else zoneTitle.append('Drop files here or ', el('b', { text: 'browse' }));
    const zoneHint = el('span', { class: 'ev-drop-hint', id: uid + '-hint' });
    zone.append(el('span', { class: 'ev-drop-ic', html: SW.icon('upload'), 'aria-hidden': 'true' }),
      el('span', { class: 'ev-drop-text' }, zoneTitle, zoneHint));
    const list = el('div', { class: 'ev-up-list', role: 'list', 'aria-label': 'Files to attach' });
    const root = el('div', { class: 'ev-up' + (o.compact ? ' compact' : '') }, zone, input, list);
    function syncHint() {
      const paste = touch ? '' : ' · paste a screenshot with ' + (/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘V' : 'Ctrl+V');
      const limit = evLimit();
      zoneHint.textContent = EV_TYPES + (limit != null ? ' — up to ' + limit + ' MB each' : ' — within the panel\'s file size limit') + paste;
    }
    syncHint();
    evHintSyncs.add(syncHint);
    zone.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      addFiles(input.files);
      input.value = '';
    });

    /* ---- drag and drop: the whole dialog is a target while files hover */
    let dropTarget = null;
    let dragDepth = 0;
    function onDragEnter(e) {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      root.classList.add('is-over');
    }
    function onDragOver(e) {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
    function onDragLeave(e) {
      if (!dragHasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) root.classList.remove('is-over');
    }
    function onDrop(e) {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      root.classList.remove('is-over');
      addFiles(e.dataTransfer.files);
    }
    function setDropTarget(node) {
      if (dropTarget) {
        dropTarget.removeEventListener('dragenter', onDragEnter);
        dropTarget.removeEventListener('dragover', onDragOver);
        dropTarget.removeEventListener('dragleave', onDragLeave);
        dropTarget.removeEventListener('drop', onDrop);
      }
      dropTarget = node || null;
      if (!dropTarget) return;
      dropTarget.addEventListener('dragenter', onDragEnter);
      dropTarget.addEventListener('dragover', onDragOver);
      dropTarget.addEventListener('dragleave', onDragLeave);
      dropTarget.addEventListener('drop', onDrop);
    }
    setDropTarget(root);

    /* ---- paste: screenshots straight from the clipboard */
    function onPaste(e) {
      if (!root.isConnected) return;
      const scope = (dropTarget && dropTarget !== root) ? dropTarget : (root.closest('.modal') || root);
      const inside = scope.contains(e.target) || ((e.target === document.body || e.target === document.documentElement) && isTopModal(scope));
      if (!inside) return;
      const cd = e.clipboardData;
      if (!cd) return;
      let files = Array.prototype.slice.call(cd.files || []);
      if (!files.length && cd.items) {
        for (const it of Array.prototype.slice.call(cd.items)) {
          if (it.kind !== 'file') continue;
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      files = files.map((f) => {
        if (!/^image\//.test(f.type || '') || (f.name && !/^image\.\w+$/i.test(f.name))) return f;
        const ext = (f.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
        try { return new File([f], 'screenshot-' + evStamp() + '.' + ext, { type: f.type }); } catch (_e) { return f; }
      });
      addFiles(files);
    }
    document.addEventListener('paste', onPaste);

    function existingCount() {
      const v = typeof o.existing === 'function' ? o.existing() : o.existing;
      return Math.max(0, Number(v) || 0);
    }
    function setState(it, s) {
      const was = !!EV_BUSY_STATES[it.state];
      const now = !!EV_BUSY_STATES[s];
      it.state = s;
      /* turned away once uploading began, when nobody may be watching the
       * list (a confirmed action, the tray): state() reports these */
      if (s === 'rejected') it.refused = started;
      if (was !== now) evActive += now ? 1 : -1;
    }
    function reject(it, why) {
      setState(it, 'rejected');
      it.error = why;
      draw(it);
    }
    /* files held toward the per-target cap; a finished upload is already in
     * a counting existing() */
    function liveCount(except) {
      const listed = typeof o.existing === 'function';
      return items.filter((x) => x !== except && EV_LIVE_STATES[x.state] && !(listed && x.state === 'done')).length;
    }

    function addFiles(fileList) {
      const files = Array.prototype.slice.call(fileList || []);
      for (const f of files) {
        if (!f) continue;
        const dupe = items.some((x) => x.state !== 'rejected' && x.file !== f && x.rawName === f.name &&
          x.size === f.size && x.lastModified === f.lastModified);
        if (dupe || items.some((x) => x.file === f)) continue;
        const it = {
          file: f, rawName: f.name, name: evCleanName(f.name), size: Number(f.size) || 0, lastModified: f.lastModified,
          state: 'checking', progress: 0, loaded: 0, error: null, info: null, caption: '', evidence: null, xhr: null,
        };
        it.el = itemEl(it);
        items.push(it);
        list.append(it.el.row);
        draw(it);
        checkItem(it);
      }
      sync();
    }

    async function checkItem(it) {
      const r = await evCheck(it.file);
      if (it.removed) return;
      if (!r.ok) {
        reject(it, r.error);
      } else if (liveCount(it) + existingCount() >= EV_MAX_FILES) {
        reject(it, 'Limit reached — at most ' + EV_MAX_FILES + ' files per ' + (o.noun || (target ? evNoun(target.type) : 'action')));
      } else {
        it.info = r.info;
        setState(it, started ? 'queued' : 'ready');
        if (it.info.kind === 'image') drawThumb(it);
        draw(it);
      }
      pump();
      sync();
    }

    /* image thumbnail: decode (downscaled where supported) onto a canvas */
    async function drawThumb(it) {
      if (typeof createImageBitmap !== 'function') return;
      let bmp = null;
      try { bmp = await createImageBitmap(it.file, { resizeWidth: 160, resizeQuality: 'medium' }); }
      catch (_e) {
        try { bmp = await createImageBitmap(it.file); } catch (_e2) { bmp = null; }
      }
      if (!bmp) return;
      if (it.removed || !bmp.width || !bmp.height) { if (bmp.close) bmp.close(); return; }
      const S = 96;
      const cv = el('canvas', { class: 'ev-thumb-cv', width: String(S), height: String(S), 'aria-hidden': 'true' });
      const ctx = cv.getContext('2d');
      if (ctx) {
        const k = Math.max(S / bmp.width, S / bmp.height);
        const w = bmp.width * k;
        const h = bmp.height * k;
        ctx.drawImage(bmp, (S - w) / 2, (S - h) / 2, w, h);
      }
      if (bmp.close) bmp.close();
      it.thumbDrawn = true;
      it.el.thumb.textContent = '';
      it.el.thumb.classList.add('has-img');
      it.el.thumb.append(cv);
    }

    function itemEl(it) {
      const row = el('div', { class: 'ev-item is-checking', role: 'listitem' });
      const thumb = el('span', { class: 'ev-thumb', 'aria-hidden': 'true', html: SW.icon('file') });
      const name = el('span', { class: 'ev-item-name truncate', text: it.name, title: it.name });
      const size = el('span', { class: 'ev-item-size tabular', text: SW.ui.fmtBytes(it.size) });
      const status = el('span', { class: 'ev-item-status' });
      const bar = el('span', { class: 'ev-bar', 'aria-hidden': 'true' }, el('i'));
      const cap = el('input', {
        class: 'input ev-cap hidden', type: 'text', maxlength: String(EV_CAPTION_MAX), placeholder: 'Caption — what does this show?',
        'aria-label': 'Caption for ' + it.name,
      });
      cap.addEventListener('input', () => { it.caption = cap.value; });
      const main = el('div', { class: 'ev-item-main' },
        el('div', { class: 'ev-item-line' }, name, size), el('div', { class: 'ev-item-line' }, status), bar, cap);
      const capBtn = el('button', {
        type: 'button', class: 'icon-btn ev-capbtn', html: SW.icon('edit'),
        title: 'Add a caption', 'aria-label': 'Add a caption to ' + it.name,
      });
      capBtn.addEventListener('click', () => {
        cap.classList.toggle('hidden');
        if (!cap.classList.contains('hidden')) cap.focus();
      });
      const retry = el('button', {
        type: 'button', class: 'icon-btn ev-retry', html: SW.icon('refresh'),
        title: 'Retry this upload', 'aria-label': 'Retry uploading ' + it.name,
      });
      retry.addEventListener('click', () => retryItem(it));
      const remove = el('button', { type: 'button', class: 'icon-btn ev-remove', html: SW.icon('x') });
      remove.addEventListener('click', () => removeItem(it));
      row.append(thumb, main, el('div', { class: 'ev-item-acts' }, capBtn, retry, remove));
      return { row, thumb, status, bar, cap, capBtn, retry, remove };
    }

    function statusText(it) {
      const lbl = it.info ? it.info.label + ' · ' : '';
      switch (it.state) {
        case 'checking': return 'Checking…';
        case 'ready': return lbl + (o.readyText || 'Ready');
        case 'queued': return lbl + 'Waiting to upload…';
        case 'uploading':
          return Math.round(it.progress * 100) + '% · ' + SW.ui.fmtBytes(Math.min(it.loaded, it.size)) + ' of ' + SW.ui.fmtBytes(it.size);
        case 'done': return lbl + (it.duplicate ? 'Already attached' : 'Uploaded');
        case 'failed': return it.error || 'Upload failed';
        case 'rejected': return it.error || 'Not allowed';
        default: return '';
      }
    }
    function drawBar(it) {
      const p = it.state === 'done' ? 1 : (it.state === 'uploading' ? Math.max(0.02, it.progress) : 0);
      it.el.bar.firstChild.style.transform = 'scaleX(' + p.toFixed(3) + ')';
    }
    function draw(it) {
      const e = it.el;
      const kind = it.info ? it.info.kind : null;
      e.row.className = 'ev-item is-' + it.state + (kind ? ' kind-' + kind : '');
      e.status.textContent = statusText(it);
      e.status.title = it.error || '';
      if (!it.thumbDrawn) {
        e.thumb.innerHTML = SW.icon(it.state === 'rejected' ? 'alert-circle' : (EV_KIND_ICON[kind] || 'file'));
      }
      const editable = it.state === 'checking' || it.state === 'ready' || it.state === 'queued' || it.state === 'failed';
      e.capBtn.classList.toggle('hidden', !editable);
      e.cap.disabled = !editable;
      if (!editable && !it.caption) e.cap.classList.add('hidden');
      e.retry.classList.toggle('hidden', it.state !== 'failed');
      e.remove.classList.toggle('hidden', it.state === 'done');
      const rmLabel = it.state === 'uploading' ? 'Cancel this upload' : 'Remove';
      e.remove.title = rmLabel;
      e.remove.setAttribute('aria-label', rmLabel + ': ' + it.name);
      e.bar.classList.toggle('hidden', !(it.state === 'uploading' || it.state === 'done'));
      drawBar(it);
    }

    function pump() {
      if (!target || !started) return;
      let active = items.filter((x) => x.state === 'uploading').length;
      for (const it of items) {
        if (active >= 2) break;
        if (it.state !== 'queued') continue;
        /* a limit learned since its check (a sibling's 413) */
        const big = evTooLarge(it.size);
        if (big) { reject(it, big); continue; }
        active++;
        send(it);
      }
    }

    function send(it) {
      setState(it, 'uploading');
      it.progress = 0;
      it.loaded = 0;
      it.error = null;
      draw(it);
      const x = new XMLHttpRequest();
      it.xhr = x;
      const q = new URLSearchParams();
      q.set('targetType', target.type);
      q.set('targetId', String(target.id));
      q.set('filename', it.name);
      const cap = String(it.caption || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (cap) q.set('caption', Array.from(cap).slice(0, EV_CAPTION_MAX).join(''));
      const tgt = target;
      const finish = (status, text) => {
        if (it.xhr !== x) return; /* cancelled or superseded */
        it.xhr = null;
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_e) { data = null; }
        const msg = data && typeof data === 'object' && data.error ? String(data.error) : '';
        if (status >= 200 && status < 300 && data && data.ok !== false && data.evidence) {
          it.evidence = data.evidence;
          it.duplicate = !!data.duplicate;
          it.progress = 1;
          setState(it, 'done');
          draw(it);
          if (o.onUploaded) { try { o.onUploaded(data.evidence); } catch (e) { console.error('evidence onUploaded', e); } }
          SW.live.emit('_evidence', { targetType: tgt.type, targetId: tgt.id, evidence: data.evidence });
        } else {
          /* rejected: retrying cannot help; failed: it might */
          let s = 'failed';
          let err;
          const said = msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : '';
          if (status === 401) { err = 'Signed out — sign in again, then retry'; signedOut(); }
          else if (status === 413) {
            const m = /(\d{1,3})\s*MB/i.exec(msg);
            if (m) evNoteLimit(m[1]);
            s = 'rejected';
            err = 'Too large for the server' + (evMaxMB != null ? ' — the limit is ' + evMaxMB + ' MB per file' : '');
          } else if (status === 415 || status === 409 || status === 403 || status === 400) {
            s = 'rejected';
            err = said || (status === 415 ? 'The server did not accept this file type' : 'The server refused this file');
          } else if (status === 0) err = 'Upload interrupted — check the connection, then retry';
          else err = said || 'Upload failed (HTTP ' + status + ')';
          setState(it, s);
          it.error = err;
          draw(it);
        }
        pump();
        sync();
      };
      x.open('POST', '/api/evidence?' + q.toString(), true);
      x.setRequestHeader('Content-Type', (it.info && it.info.mime) || 'application/octet-stream');
      x.upload.addEventListener('progress', (e) => {
        if (it.xhr !== x || !e.lengthComputable || !e.total) return;
        it.loaded = e.loaded;
        it.progress = Math.min(0.99, e.loaded / e.total); /* the last step waits for the server's answer */
        it.el.status.textContent = statusText(it);
        drawBar(it);
        sync();
      });
      x.addEventListener('load', () => finish(x.status, x.responseText));
      x.addEventListener('error', () => finish(0, ''));
      x.addEventListener('timeout', () => finish(0, ''));
      try { x.send(it.file); } catch (_e) { finish(0, ''); }
    }

    function removeItem(it) {
      it.removed = true;
      if (it.xhr) {
        const x = it.xhr;
        it.xhr = null;
        try { x.abort(); } catch (_e) { /* already done */ }
      }
      setState(it, 'removed');
      const i = items.indexOf(it);
      if (i !== -1) items.splice(i, 1);
      it.el.row.remove();
      pump();
      sync();
    }
    function retryItem(it) {
      if (it.state !== 'failed') return;
      it.error = null;
      setState(it, target && started ? 'queued' : 'ready');
      draw(it);
      pump();
      sync();
    }

    function summary() {
      const s = {
        total: 0, checking: 0, ready: 0, queued: 0, uploading: 0, done: 0, failed: 0, rejected: 0, bytes: 0, sent: 0,
        refused: 0, refusedWhy: [],
      };
      for (const it of items) {
        s.total++;
        s[it.state] = (s[it.state] || 0) + 1;
        if (it.state === 'rejected' && it.refused) {
          s.refused++;
          if (it.error && s.refusedWhy.indexOf(it.error) === -1) s.refusedWhy.push(it.error);
        }
        if (it.state === 'queued' || it.state === 'uploading' || it.state === 'done') {
          s.bytes += it.size;
          s.sent += it.state === 'done' ? it.size : (it.state === 'uploading' ? it.size * it.progress : 0);
        }
      }
      s.active = s.queued + s.uploading;
      s.progress = s.bytes ? s.sent / s.bytes : 0;
      return s;
    }
    function sync() {
      root.classList.toggle('has-items', items.length > 0);
      const s = summary();
      for (const fn of Array.from(stateSubs)) {
        try { fn(s); } catch (e) { console.error('evidence state', e); }
      }
    }

    root.addFiles = addFiles;
    root.setTarget = (type, id) => { target = { type: String(type), id: Number(id) }; };
    root.start = () => {
      if (!target) return;
      started = true;
      for (const it of items) {
        if (it.state === 'ready') { setState(it, 'queued'); draw(it); }
      }
      pump();
      sync();
    };
    root.state = summary;
    root.busy = () => { const s = summary(); return s.active > 0 || (started && s.checking > 0); };
    root.hasFiles = () => items.some((x) => x.state !== 'rejected');
    root.onState = (fn) => { stateSubs.add(fn); return () => stateSubs.delete(fn); };
    root.retryFailed = () => { for (const it of items.slice()) retryItem(it); };
    root.target = () => (target ? { type: target.type, id: target.id } : null);
    root.setDropTarget = setDropTarget;
    root.detach = () => {
      document.removeEventListener('paste', onPaste);
      evHintSyncs.delete(syncHint);
      setDropTarget(null);
    };
    root.openPicker = () => input.click();
    return root;
  };

  /* ---- stored evidence: rows {id, targetType, targetId, filename, mime,
   * size, caption, uploadedBy, uploader, uploadedAt, url} */
  function evKind(row) {
    const m = String((row && row.mime) || '').toLowerCase();
    if (m.indexOf('image/') === 0) return 'image';
    if (m.indexOf('video/') === 0) return 'video';
    if (m === 'application/pdf') return 'pdf';
    return 'text';
  }
  function evFileUrl(row) {
    const u = String((row && row.url) || '');
    if (/^\/api\/evidence\/\d+\/file$/.test(u)) return u;
    return '/api/evidence/' + encodeURIComponent(String(row && row.id)) + '/file';
  }
  function evCanView() { return SW.canAny(['ban', 'kick', 'warn', 'audit']); }
  /* the uploader, or someone holding both ban and settings */
  function evCanDelete(row) {
    const me = SW.state.me;
    if (!me || !row || !SW.canAny(['warn', 'kick', 'ban'])) return false;
    if (row.uploadedBy != null && Number(row.uploadedBy) === Number(me.id)) return true;
    return SW.can('ban') && SW.can('settings');
  }
  function evWho(row) {
    if (row.uploader) return String(row.uploader);
    return row.uploadedBy != null ? 'user #' + row.uploadedBy : 'unknown';
  }
  function evTitle(row) {
    const head = row.caption ? row.caption + ' — ' + (row.filename || 'file') : (row.filename || 'file');
    return head + '\n' + SW.ui.fmtBytes(row.size) + ' · by ' + evWho(row) + (row.uploadedAt ? ' · ' + SW.ui.fmtTime(row.uploadedAt) : '');
  }
  function evNoun(type) { return type === 'ban' ? 'ban' : 'action'; }

  async function evDelete(row) {
    const ok = await SW.ui.confirmModal({
      title: 'Delete this evidence?',
      body: '“' + (row.filename || 'file') + '” is removed from this ' + evNoun(row.targetType) +
        ' for everyone. The deletion is recorded in the audit log.',
      danger: true,
      confirmText: 'Delete',
    });
    if (!ok) return false;
    try { await SW.api('/api/evidence/' + encodeURIComponent(row.id) + '/delete', { method: 'POST', body: {} }); }
    catch (_e) { return false; }
    SW.ui.toast('Evidence deleted', 'ok');
    SW.live.emit('_evidence', { targetType: row.targetType, targetId: row.targetId, deleted: row.id });
    return true;
  }

  SW.ui.evidenceList = function evidenceList(o) {
    o = o || {};
    const root = el('div', { class: 'ev-list' + (o.compact ? ' compact' : '') });
    let rows = null;
    let seq = 0;
    function sorted(listIn) {
      return listIn.slice().sort((a, b) => (Number(a.uploadedAt) || 0) - (Number(b.uploadedAt) || 0) ||
        (Number(a.id) || 0) - (Number(b.id) || 0));
    }
    function changed() {
      if (!o.onChange) return;
      try { o.onChange(rows ? rows.slice() : []); } catch (e) { console.error('evidence onChange', e); }
    }
    function skeleton() {
      root.textContent = '';
      const g = el('div', { class: 'ev-grid', 'aria-busy': 'true', 'aria-label': 'Loading evidence' });
      const n = Math.min(4, Math.max(1, Number(o.count) || 2));
      for (let i = 0; i < n; i++) g.append(el('div', { class: 'ev-tile is-skel' }, el('span', { class: 'skeleton block' })));
      root.append(g);
    }
    async function load() {
      const my = ++seq;
      if (!rows) skeleton();
      let r;
      try {
        r = await SW.api('/api/evidence?targetType=' + encodeURIComponent(o.targetType) +
          '&targetId=' + encodeURIComponent(o.targetId), { toast: false });
      } catch (e) {
        if (my !== seq || (e && e.status === 401)) return;
        root.textContent = '';
        root.append(SW.ui.empty('Could not load the evidence', 'wifi-off', {
          compact: true, hint: (e && e.message) || 'The server did not answer',
          action: { label: 'Try again', icon: 'refresh', onClick: load },
        }));
        return;
      }
      if (my !== seq) return;
      if (r && r.maxMB != null) evNoteLimit(r.maxMB);
      rows = sorted(Array.isArray(r && r.rows) ? r.rows : []);
      draw();
      changed();
    }
    function openAt(row) {
      const all = rows || [];
      SW.ui.evidenceLightbox(all, Math.max(0, all.indexOf(row)), { onDelete: removeRow });
    }
    function removeRow(row) {
      if (!rows) return;
      rows = rows.filter((x) => x !== row && x.id !== row.id);
      draw();
      changed();
    }
    function delBtn(row, cls) {
      const b = el('button', {
        type: 'button', class: 'icon-btn ' + cls, html: SW.icon('trash'),
        title: 'Delete', 'aria-label': 'Delete ' + (row.filename || 'evidence'),
      });
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (await evDelete(row)) removeRow(row);
      });
      return b;
    }
    function mediaTile(row) {
      const k = evKind(row);
      const url = evFileUrl(row);
      const label = row.caption || row.filename || (k === 'video' ? 'Video' : 'Image');
      const fig = el('figure', { class: 'ev-tile is-' + k, role: 'listitem' });
      const btn = el('button', { type: 'button', class: 'ev-tile-btn', title: evTitle(row), 'aria-label': 'Open ' + (row.filename || label) });
      if (k === 'image') {
        const img = el('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
        img.addEventListener('error', () => {
          img.remove();
          btn.classList.add('is-broken');
          btn.insertAdjacentHTML('afterbegin', SW.icon('image'));
        });
        btn.append(img);
      } else {
        /* no request until it is opened: a list of clips would otherwise
         * pull (and abort) range requests for every one of them */
        btn.classList.add('is-clip');
        btn.append(el('span', { class: 'ev-clip-ic', html: SW.icon('film'), 'aria-hidden': 'true' }),
          el('span', { class: 'ev-play', html: SW.icon('play'), 'aria-hidden': 'true' }),
          el('span', { class: 'ev-tile-dur mono', text: SW.ui.fmtBytes(row.size) }));
      }
      btn.addEventListener('click', () => openAt(row));
      fig.append(btn, el('figcaption', { class: 'ev-tile-cap truncate', text: label, title: label }));
      if (o.allowDelete !== false && evCanDelete(row)) fig.append(delBtn(row, 'ev-tile-del reveal-on-hover'));
      return fig;
    }
    function docChip(row) {
      const k = evKind(row);
      const name = row.filename || (k === 'pdf' ? 'document.pdf' : 'notes.txt');
      const wrap = el('div', { class: 'ev-doc-wrap', role: 'listitem' });
      const b = el('button', { type: 'button', class: 'ev-doc', title: evTitle(row), html: SW.icon(EV_KIND_ICON[k] || 'file') });
      b.append(el('span', { class: 'ev-doc-name truncate', text: row.caption || name }),
        el('span', { class: 'ev-doc-kind', text: k === 'pdf' ? 'PDF' : 'TXT' }),
        el('span', { class: 'ev-doc-size mono', text: SW.ui.fmtBytes(row.size) }));
      b.addEventListener('click', () => openAt(row));
      wrap.append(b);
      if (o.allowDelete !== false && evCanDelete(row)) wrap.append(delBtn(row, 'ev-doc-del'));
      return wrap;
    }
    function draw() {
      root.textContent = '';
      const all = rows || [];
      if (!all.length) {
        root.append(el('p', { class: 'ev-none', text: o.emptyText || 'No evidence attached yet.' }));
        return;
      }
      const media = all.filter((r) => { const k = evKind(r); return k === 'image' || k === 'video'; });
      const docs = all.filter((r) => { const k = evKind(r); return k !== 'image' && k !== 'video'; });
      if (media.length) {
        const grid = el('div', { class: 'ev-grid', role: 'list', 'aria-label': 'Images and videos' });
        for (const r of media) grid.append(mediaTile(r));
        root.append(grid);
      }
      if (docs.length) {
        const chips = el('div', { class: 'ev-docs', role: 'list', 'aria-label': 'Documents' });
        for (const r of docs) chips.append(docChip(r));
        root.append(chips);
      }
    }

    root.reload = load;
    root.add = (ev) => {
      if (!ev || ev.id == null) return;
      rows = sorted((rows || []).filter((x) => x.id !== ev.id).concat([ev]));
      draw();
      changed();
    };
    root.rows = () => (rows ? rows.slice() : []);
    root.count = () => (rows ? rows.length : Math.max(0, Number(o.count) || 0));
    if (Array.isArray(o.rows)) { rows = sorted(o.rows); draw(); } else load();
    return root;
  };

  /* lightbox: one file at a time on a dark stage; ←/→ (or a swipe) step
   * through the set, the original opens or downloads from the info row */
  SW.ui.evidenceLightbox = function evidenceLightbox(rowsIn, index, opts) {
    opts = opts || {};
    const list = (rowsIn || []).slice();
    if (!list.length) return null;
    let i = Math.max(0, Math.min(list.length - 1, Number(index) || 0));
    let textSeq = 0;
    const stage = el('div', { class: 'ev-stage' });
    const prev = el('button', { type: 'button', class: 'ev-nav prev', html: SW.icon('chevron-left'), title: 'Previous (←)', 'aria-label': 'Previous file' });
    const next = el('button', { type: 'button', class: 'ev-nav next', html: SW.icon('chevron-right'), title: 'Next (→)', 'aria-label': 'Next file' });
    const cap = el('div', { class: 'ev-lb-cap wrap-anywhere' });
    const meta = el('div', { class: 'ev-lb-meta' });
    const acts = el('div', { class: 'ev-lb-acts' });
    const stageWrap = el('div', { class: 'ev-stage-wrap' + (list.length > 1 ? ' has-nav' : '') }, stage, prev, next);
    const body = el('div', { class: 'ev-lb' },
      stageWrap, el('div', { class: 'ev-lb-info' }, el('div', { class: 'ev-lb-text' }, cap, meta), acts));
    const m = SW.ui.modal({
      title: '', class: 'ev-lightbox', wide: true, body,
      onClose: () => {
        stopMedia();
        document.removeEventListener('keydown', onKey);
      },
    });
    const titleEl = m.el.querySelector('.modal-title');
    function stopMedia() {
      const v = stage.querySelector('video');
      if (v) { try { v.pause(); } catch (_e) { /* detached */ } }
    }
    function metaBit(text, cls) { meta.append(el('span', { class: 'ev-lb-bit' + (cls ? ' ' + cls : ''), text })); }
    function show() {
      stopMedia();
      textSeq++;
      const row = list[i];
      const k = evKind(row);
      const url = evFileUrl(row);
      const name = row.filename || 'evidence';
      titleEl.textContent = name;
      titleEl.title = name;
      stage.textContent = '';
      stage.className = 'ev-stage is-' + k;
      if (k === 'image') {
        stage.append(el('img', { src: url, alt: row.caption || name, decoding: 'async', draggable: 'false' }));
      } else if (k === 'video') {
        stage.append(el('video', { src: url, controls: true, playsinline: true, preload: 'metadata' }));
      } else if (k === 'text') {
        const pre = el('pre', { class: 'ev-text', text: 'Loading…' });
        stage.append(pre);
        const my = textSeq;
        fetch(url, { credentials: 'same-origin' })
          .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.text(); })
          .then((t) => {
            if (my !== textSeq) return;
            pre.textContent = t.length > 200000 ? t.slice(0, 200000) + '\n\n… (cut short here — download the file for the rest)' : t;
          })
          .catch(() => { if (my === textSeq) pre.textContent = 'Could not load this text file — try downloading it.'; });
      } else {
        const card = el('div', { class: 'ev-file-card', html: SW.icon('file') });
        card.append(el('div', { class: 'ev-file-name wrap-anywhere', text: name }),
          el('div', { class: 'ev-file-sub', text: 'PDF · ' + SW.ui.fmtBytes(row.size) + ' — opens after downloading' }));
        const dl = el('a', { class: 'btn primary', href: url, download: name, html: SW.icon('download') + '<span>Download PDF</span>' });
        card.append(dl);
        stage.append(card);
      }
      cap.textContent = row.caption || '';
      cap.classList.toggle('hidden', !row.caption);
      meta.textContent = '';
      if (list.length > 1) metaBit((i + 1) + ' of ' + list.length, 'mono');
      metaBit('by ' + evWho(row));
      if (row.uploadedAt) metaBit(SW.ui.fmtDayTime(row.uploadedAt));
      metaBit(SW.ui.fmtBytes(row.size), 'mono');
      acts.textContent = '';
      if (k === 'image' || k === 'video') {
        acts.append(el('a', {
          class: 'btn ghost small', href: url, target: '_blank', rel: 'noopener noreferrer',
          html: SW.icon('external') + '<span>Open original</span>',
        }));
      }
      if (k !== 'pdf') acts.append(el('a', { class: 'btn ghost small', href: url, download: name, html: SW.icon('download') + '<span>Download</span>' }));
      if (opts.onDelete && evCanDelete(row)) {
        const del = el('button', { type: 'button', class: 'btn danger ghost small', html: SW.icon('trash') + '<span>Delete</span>' });
        del.addEventListener('click', async () => {
          if (!(await evDelete(row))) return;
          list.splice(i, 1);
          try { opts.onDelete(row); } catch (e) { console.error('evidence onDelete', e); }
          if (!list.length) { m.close(); return; }
          i = Math.min(i, list.length - 1);
          show();
        });
        acts.append(del);
      }
      prev.classList.toggle('hidden', list.length < 2);
      next.classList.toggle('hidden', list.length < 2);
      stageWrap.classList.toggle('has-nav', list.length > 1);
    }
    function step(d) {
      if (list.length < 2) return;
      i = (i + d + list.length) % list.length;
      show();
    }
    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    function onKey(e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (!isTopModal(m.el) || (e.target && e.target.closest && e.target.closest('video, input, textarea, select'))) return;
      e.preventDefault();
      step(e.key === 'ArrowLeft' ? -1 : 1);
    }
    document.addEventListener('keydown', onKey);
    /* touch: a horizontal swipe on the stage steps too */
    let swipe = null;
    stage.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' || (e.target && e.target.closest('video, pre'))) return;
      swipe = { x: e.clientX, y: e.clientY };
    });
    stage.addEventListener('pointerup', (e) => {
      if (!swipe) return;
      const dx = e.clientX - swipe.x;
      const dy = e.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
    });
    stage.addEventListener('pointercancel', () => { swipe = null; });
    show();
    return { close: m.close };
  };

  /* the list + an uploader in one dialog (bans, audit rows, profiles) */
  SW.ui.openEvidence = function openEvidence(o) {
    o = o || {};
    const type = String(o.targetType || '');
    if (!type || o.targetId == null) return null;
    const canUpload = o.canUpload != null ? !!o.canUpload : (type === 'ban' ? SW.can('ban') : SW.canAny(['warn', 'kick', 'ban']));
    const countEl = el('span', { class: 'ev-dlg-n tabular' });
    const list = SW.ui.evidenceList({
      targetType: type, targetId: o.targetId,
      emptyText: canUpload ? 'Nothing attached yet — add the first file below.' : 'No evidence attached.',
      onChange: (rows) => {
        countEl.textContent = rows.length ? String(rows.length) : '';
        if (o.onChange) o.onChange(rows);
      },
    });
    const body = el('div', { class: 'ev-dlg' });
    if (o.subtitle) body.append(el('p', { class: 'modal-text ev-dlg-sub', text: String(o.subtitle) }));
    body.append(el('section', { class: 'ev-dlg-sec' }, el('h4', { class: 'ev-dlg-k' }, el('span', { text: 'Attached' }), countEl), list));
    let up = null;
    if (canUpload) {
      up = SW.ui.evidenceUploader({ targetType: type, targetId: o.targetId, existing: () => list.count(), onUploaded: (ev) => list.add(ev) });
      body.append(el('section', { class: 'ev-dlg-sec' }, el('h4', { class: 'ev-dlg-k', text: 'Add evidence' }), up));
    }
    const closeBtn = el('button', { type: 'button', class: 'btn ghost', text: 'Close' });
    body.append(el('div', { class: 'modal-actions' }, closeBtn));
    const title = o.title || 'Evidence';
    const m = SW.ui.modal({
      title, wide: true, class: 'ev-modal', body,
      onClose: () => {
        if (up) {
          up.detach();
          if (up.busy()) SW.evidence.tray(up, title);
        }
        if (o.onClose) o.onClose();
      },
    });
    if (up) up.setDropTarget(m.el);
    closeBtn.addEventListener('click', () => m.close());
    return { close: m.close };
  };

  /* paperclip + count; opens the evidence dialog for its target */
  SW.ui.evidenceButton = function evidenceButton(o) {
    o = o || {};
    let n = Math.max(0, Number(o.count) || 0);
    const canUp = o.canUpload != null ? !!o.canUpload : (o.targetType === 'ban' ? SW.can('ban') : SW.canAny(['warn', 'kick', 'ban']));
    const b = el('button', { type: 'button', class: 'btn ghost small ev-count' });
    function sync() {
      b.innerHTML = SW.icon('paperclip');
      b.append(el('span', { text: n ? String(n) : (canUp ? 'Attach' : '0') }));
      b.classList.toggle('has-ev', n > 0);
      const t = n ? n + ' evidence file' + (n === 1 ? '' : 's') + ' — open' : (canUp ? 'Attach evidence' : 'No evidence attached');
      b.title = t;
      b.setAttribute('aria-label', t);
      b.disabled = !evCanView() || (!n && !canUp);
    }
    sync();
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      SW.ui.openEvidence({
        targetType: o.targetType, targetId: o.targetId, title: o.title, subtitle: o.subtitle, canUpload: canUp,
        onChange: (rows) => {
          n = rows.length;
          sync();
          if (o.onChange) o.onChange(rows);
        },
      });
    });
    b.setCount = (c) => { n = Math.max(0, Number(c) || 0); sync(); };
    return b;
  };

  /* an uploader summary's refused files, as one line */
  function evRefusedWhy(s) { return (s.refusedWhy || []).join(' · '); }
  function evRefusedText(s) {
    const why = evRefusedWhy(s);
    return s.refused + ' file' + (s.refused === 1 ? '' : 's') + ' not attached' + (why ? ': ' + why : '');
  }

  /* background tray: a closed dialog's uploads keep going here */
  function evTray(up, label) {
    if (!up || !up.busy()) return;
    const t = SW.ui.toast('Uploading evidence', 'info', { sticky: true, icon: 'upload', detail: label || null });
    if (!t) return;
    t.el.classList.add('ev-tray');
    const line = el('div', { class: 'toast-detail ev-tray-line tabular' });
    const bar = el('div', { class: 'toast-progress', 'aria-hidden': 'true' }, el('i'));
    t.el.append(line, bar);
    let off = null;
    function update(s) {
      const all = s.done + s.failed + s.active + s.checking;
      line.textContent = s.done + ' of ' + all + ' uploaded' + (s.active ? ' · ' + Math.round(s.progress * 100) + '%' : '');
      bar.firstChild.style.transform = 'scaleX(' + Math.max(0.02, s.progress).toFixed(3) + ')';
      if (s.active || s.checking) return;
      if (off) off();
      t.dismiss();
      const tgt = up.target();
      const open = tgt ? { label: 'Open', onClick: () => SW.ui.openEvidence({ targetType: tgt.type, targetId: tgt.id, title: label }) } : null;
      if (s.failed) {
        SW.ui.toast(s.failed + ' evidence file' + (s.failed === 1 ? '' : 's') + ' failed to upload', 'error', {
          sticky: true, detail: [label, s.refused ? evRefusedText(s) : null].filter(Boolean).join(' · ') || null,
          actions: [
            { label: 'Retry', primary: true, onClick: () => { up.retryFailed(); evTray(up, label); } },
            open,
          ],
        });
      } else if (s.refused) {
        SW.ui.toast(s.refused + ' evidence file' + (s.refused === 1 ? '' : 's') + ' not attached', s.done ? 'warn' : 'error', {
          sticky: true,
          detail: [evRefusedWhy(s), s.done ? s.done + ' other file' + (s.done === 1 ? ' was' : 's were') + ' attached' : null, label]
            .filter(Boolean).join(' · '),
          actions: [open],
        });
      } else if (s.done) {
        SW.ui.toast('Evidence attached — ' + s.done + ' file' + (s.done === 1 ? '' : 's'), 'ok', { detail: label || null });
      }
    }
    off = up.onState(update);
    update(up.state());
  }

  SW.evidence = {
    maxMB: evLimit,
    noteLimit: evNoteLimit, /* a limit learned elsewhere, such as a Settings save */
    check: evCheck,
    sniff: sniffEvidence,
    tray: evTray,
    canView: evCanView,
  };

  /* -------------------------------------------------------------- actions
   * Warn / kick / ban open one dialog each: reason templates (kind-filtered;
   * a ban template also sets the duration), the reason, a ban's private
   * note, and evidence that uploads once the action went through
   * (actionId for warn / kick, ban.id for a ban). Other actions use a
   * confirm modal; results go through SW.ui.rconToast and every action
   * swallows its own errors (SW.api already toasts them).
   */

  const WARN_PRESETS = [
    'Teamkilling is logged — apologize in all chat.',
    'Do not damage friendly FOB radios.',
    'Keep chat civil. Final warning.',
    'Join a squad or you will be kicked.',
    'Follow your squad leader\'s orders.',
  ];
  const KICK_PRESETS = [
    'Teamkilling',
    'Toxic chat',
    'AFK / not in a squad',
    'Mic spam',
    'Breaking server rules',
  ];
  const BAN_REASON_PRESETS = [
    'Intentional teamkilling',
    'Destroying friendly FOB radios',
    'Toxic behaviour',
    'Cheating / exploiting',
    'Repeated rule breaking',
  ];
  const BAN_INTERVALS = [
    { value: '1d', label: '1 day' },
    { value: '3d', label: '3 days' },
    { value: '1w', label: '1 week' },
    { value: '1M', label: '1 month' },
    { value: '0', label: 'Permanent' },
    { value: 'custom', label: 'Custom…' },
  ];
  /* the server's interval syntax without a zero count: the server stores
   * '0d' as a permanent ban — permanent is the bare '0' */
  const INTERVAL_RE = /^(0|[1-9]\d{0,2}[mhdwMy])$/;

  function targetBody(ref, extra) {
    const body = Object.assign({}, extra);
    const dbId = ref.dbId != null ? ref.dbId : ref.id;
    if (dbId != null) body.playerId = dbId;
    else if (ref.steamId) body.steamId = ref.steamId;
    return body;
  }

  /* GET /api/reason-templates -> {rows:[{id, kind, label, reason, interval?}]}
   * (BATCH3 §2): cached, and revalidated whenever a dialog opens. The
   * built-in presets above stand in only while no list could be loaded (an
   * older server, a network error); a kind the owner left empty has none. */
  const ACTION_KINDS = { warn: 1, kick: 1, ban: 1 };
  let tplCache = null;
  let tplTried = false;
  let tplInflight = null;
  function loadTemplates() {
    if (tplInflight) return tplInflight;
    tplInflight = SW.api('/api/reason-templates', { toast: false })
      .then((r) => {
        if (r && r.maxMB != null) evNoteLimit(r.maxMB);
        tplCache = (r && Array.isArray(r.rows) ? r.rows : [])
          .filter((t) => t && ACTION_KINDS[t.kind] && t.label && t.reason);
        return tplCache;
      })
      .catch(() => tplCache)
      .finally(() => { tplInflight = null; tplTried = true; });
    return tplInflight;
  }
  /* the chips for one kind: the server's templates, the presets when none
   * could be loaded, nothing while the first load is out */
  function templatesFor(kind) {
    if (tplCache) return tplCache.filter((t) => t.kind === kind);
    return tplTried ? ACTION_COPY[kind].presets.map((p) => ({ label: p, reason: p })) : [];
  }

  const REASON_MAX = 480;
  const NOTE_MAX = 2000;
  const ACTION_COPY = {
    warn: {
      verb: 'Warn', done: 'Warned', noun: 'warning', confirm: 'Send warning', busy: 'Sending the warning…', field: 'Message',
      hint: 'Shown on the player\'s screen.', presets: WARN_PRESETS, url: '/api/admin/warn', key: 'message',
    },
    kick: {
      verb: 'Kick', done: 'Kicked', noun: 'kick', confirm: 'Kick player', busy: 'Kicking…', field: 'Reason', danger: true,
      hint: 'Shown to the player as they are removed.', presets: KICK_PRESETS, url: '/api/admin/kick', key: 'reason',
    },
    ban: {
      verb: 'Ban', done: 'Banned', noun: 'ban', confirm: 'Ban player', busy: 'Banning…', field: 'Reason', danger: true,
      hint: 'Shown to the player now and whenever they try to rejoin.', presets: BAN_REASON_PRESETS, url: '/api/bans', key: 'reason',
    },
  };
  /* warn / kick / ban requests still out, by kind and player id: a second
   * dialog for the same player waits for the first answer */
  const actionsOut = new Set();
  function actionKeys(kind, ref) {
    const dbId = ref.dbId != null ? ref.dbId : ref.id;
    const keys = [];
    if (dbId != null) keys.push(kind + ':p' + dbId);
    if (ref.steamId) keys.push(kind + ':s' + ref.steamId);
    return keys;
  }
  const INTERVAL_UNIT = { m: ['minute', 60], h: ['hour', 3600], d: ['day', 86400], w: ['week', 604800], M: ['month', 2592000], y: ['year', 31536000] };
  function intervalLabel(v) {
    if (v === '0') return 'permanent';
    const m = /^(\d{1,3})([mhdwMy])$/.exec(String(v || ''));
    if (!m) return String(v || '');
    const n = Number(m[1]);
    return n + ' ' + INTERVAL_UNIT[m[2]][0] + (n === 1 ? '' : 's');
  }
  function intervalSec(v) {
    const m = /^(\d{1,3})([mhdwMy])$/.exec(String(v || ''));
    return m ? Number(m[1]) * INTERVAL_UNIT[m[2]][1] : 0;
  }

  /* actionDialog(kind, ref) -> Promise<{kind, res, target} | null>, settled
   * as soon as the action went through (or on close without one) */
  function actionDialog(kind, ref) {
    const C = ACTION_COPY[kind];
    const name = ref.name || ref.steamId || 'player';
    const dbId = ref.dbId != null ? ref.dbId : ref.id;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
      let busy = false;
      let sent = null;
      let closed = false;
      let autoClose = null;
      const uid = 'act' + (++modalSeq) + '-';

      const form = el('form', { class: 'modal-form act-form', novalidate: true });
      const fields = el('div', { class: 'act-fields' });
      if (kind === 'ban' && dbId == null) {
        fields.append(el('p', { class: 'modal-text', text: 'Banning by Steam ID ' + (ref.steamId || '') + ' — this player has no stored profile yet.' }));
      }

      /* ---- templates: one tap fills the reason (and a ban's duration) */
      const tplRow = el('div', { class: 'act-tpls', role: 'group', 'aria-labelledby': uid + 'tpl' });
      const tplField = el('div', { class: 'field act-tpl' }, el('div', { class: 'act-label', id: uid + 'tpl', text: 'Templates' }), tplRow);
      fields.append(tplField);

      /* ---- ban duration: presets + custom, with the expiry spelled out */
      let interval = '1d';
      let customIn = null;
      let expiry = null;
      const durBtns = [];
      if (kind === 'ban') {
        const seg = el('div', { class: 'act-seg', role: 'group', 'aria-labelledby': uid + 'dur' });
        for (const d of BAN_INTERVALS) {
          const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false', text: d.label.replace('…', ''), dataset: { v: d.value } });
          b.addEventListener('click', () => setDur(d.value, true));
          durBtns.push(b);
          seg.append(b);
        }
        customIn = el('input', {
          class: 'input mono act-custom hidden', type: 'text', maxlength: '4', autocomplete: 'off', spellcheck: 'false',
          placeholder: 'e.g. 14d', 'aria-label': 'Custom duration',
        });
        customIn.addEventListener('input', () => { customIn.classList.remove('invalid'); syncExpiry(); });
        expiry = el('div', { class: 'act-expiry', 'aria-live': 'polite' });
        fields.append(el('div', { class: 'field act-dur' },
          el('div', { class: 'act-label', id: uid + 'dur', text: 'Duration' }), seg, customIn, expiry));
      }

      /* ---- the reason / message */
      const reason = el('textarea', {
        class: 'input act-reason', id: uid + 'reason', rows: '3', maxlength: String(REASON_MAX),
        placeholder: kind === 'warn' ? 'What should they stop doing?' : 'Why is this happening?',
      });
      const counter = el('span', { class: 'act-count tabular', 'aria-hidden': 'true' });
      fields.append(el('div', { class: 'field act-reason-field' },
        el('div', { class: 'act-label-row' }, el('label', { for: uid + 'reason', text: C.field }), counter),
        reason, el('div', { class: 'hint', text: C.hint })));

      /* ---- a ban's private note (BATCH3 §1) */
      let note = null;
      if (kind === 'ban') {
        note = el('textarea', {
          class: 'input act-note', id: uid + 'note', rows: '2', maxlength: String(NOTE_MAX),
          placeholder: 'Context for other admins — alts, links, what happened',
        });
        fields.append(el('div', { class: 'field act-note-field' },
          el('label', { for: uid + 'note' }, 'Private note', el('span', { class: 'act-opt', text: 'optional · staff only' })),
          note,
          el('div', { class: 'hint', text: 'Only people who can ban see it — never the player, Bans.cfg or the remote ban list.' })));
      }

      /* ---- evidence: picked now, uploaded once the action went through */
      const up = SW.ui.evidenceUploader({ readyText: 'Ready — uploads after you confirm', compact: true, noun: kind === 'ban' ? 'ban' : 'action' });
      const evField = el('div', { class: 'field act-ev' },
        el('div', { class: 'act-label' }, 'Evidence', el('span', { class: 'act-opt', text: 'optional' })), up);

      const doneBox = el('div', { class: 'act-done hidden', role: 'status' });
      const err = el('div', { class: 'act-error hidden', role: 'alert' });
      const status = el('span', { class: 'act-status truncate', 'aria-live': 'polite' });
      const cancel = el('button', { type: 'button', class: 'btn ghost', text: 'Cancel' });
      const retryAll = el('button', { type: 'button', class: 'btn ghost hidden', html: SW.icon('refresh') + '<span>Retry failed</span>' });
      const okLabel = el('span', { text: C.confirm });
      const ok = el('button', { type: 'submit', class: 'btn ' + (C.danger ? 'danger solid' : 'primary') },
        el('span', { class: 'btn-spinner', 'aria-hidden': 'true' }), okLabel);
      form.append(doneBox, fields, evField, err, el('div', { class: 'modal-actions' }, status, cancel, retryAll, ok));

      const m = SW.ui.modal({
        title: C.verb + ' ' + name, danger: !!C.danger, class: 'act-modal act-' + kind, body: form,
        onClose: () => {
          closed = true;
          up.detach();
          if (autoClose) clearTimeout(autoClose);
          if (sent && up.busy()) SW.evidence.tray(up, sent.label);
          finish(sent ? sent.result : null);
        },
      });
      up.setDropTarget(m.el);
      cancel.addEventListener('click', () => m.close());
      retryAll.addEventListener('click', () => up.retryFailed());

      function showError(msg) {
        err.textContent = '';
        err.append(el('span', { class: 'act-error-ic', html: SW.icon('alert-circle'), 'aria-hidden': 'true' }), el('span', { text: msg }));
        err.classList.remove('hidden');
      }
      function hideError() { err.classList.add('hidden'); }

      /* templates for this kind (templatesFor); the chip of the template
       * the fields still match stays lit */
      const chipTpl = new Map();
      function drawTemplates() {
        tplRow.textContent = '';
        chipTpl.clear();
        const list = templatesFor(kind);
        tplField.classList.toggle('hidden', !list.length);
        for (const t of list) {
          const iv = kind === 'ban' && t.interval != null && t.interval !== '' ? String(t.interval) : null;
          const b = el('button', {
            type: 'button', class: 'chip act-tpl-chip', 'aria-pressed': 'false',
            title: String(t.reason) + (iv ? ' — ' + intervalLabel(iv) : ''),
          }, el('span', { class: 'truncate', text: String(t.label) }));
          if (iv) b.append(el('span', { class: 'act-tpl-dur mono', text: iv === '0' ? 'perm' : iv }));
          b.addEventListener('click', () => applyTemplate(t));
          chipTpl.set(b, t);
          tplRow.append(b);
        }
        markTemplate();
      }
      function applyTemplate(t) {
        reason.value = String(t.reason).slice(0, REASON_MAX);
        reason.classList.remove('invalid');
        if (kind === 'ban' && t.interval != null && INTERVAL_RE.test(String(t.interval))) setDur(String(t.interval), false);
        hideError();
        syncCount();
        markTemplate();
      }
      function markTemplate() {
        const v = reason.value.trim();
        for (const [b, t] of chipTpl) {
          let on = !!v && String(t.reason).trim() === v;
          if (on && kind === 'ban' && t.interval != null && t.interval !== '') on = currentInterval() === String(t.interval);
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
      }

      function setDur(v, fromClick) {
        const preset = v !== 'custom' && BAN_INTERVALS.some((d) => d.value === v);
        if (preset) {
          interval = v;
          customIn.classList.add('hidden');
        } else {
          interval = 'custom';
          if (v !== 'custom') customIn.value = v;
          customIn.classList.remove('hidden');
          if (fromClick) customIn.focus();
        }
        for (const b of durBtns) {
          const on = b.dataset.v === interval;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        syncExpiry();
        markTemplate();
      }
      function currentInterval() {
        return interval === 'custom' ? String(customIn.value || '').trim() : interval;
      }
      function syncExpiry() {
        const v = currentInterval();
        expiry.className = 'act-expiry';
        if (!INTERVAL_RE.test(v)) {
          expiry.textContent = 'Type a duration: 30m, 12h, 5d, 2w, 1M or 1y — 0 is permanent';
          if (v) expiry.classList.add('is-bad');
          return;
        }
        if (v === '0') {
          expiry.textContent = 'Permanent — never expires';
          expiry.classList.add('is-perm');
          return;
        }
        const at = new Date(Date.now() + intervalSec(v) * 1000);
        expiry.textContent = 'Expires ' + at.toLocaleDateString('en-GB', { weekday: 'short' }) + ' ' + SW.ui.fmtDayTime(at.getTime()) +
          ' · ' + intervalLabel(v);
      }
      function syncCount() {
        const n = reason.value.length;
        counter.textContent = n + ' / ' + REASON_MAX;
        counter.classList.toggle('is-near', n > REASON_MAX - 60);
      }
      reason.addEventListener('input', () => {
        reason.classList.remove('invalid');
        syncCount();
        markTemplate();
      });

      function setBusy(on) {
        busy = on;
        ok.disabled = on;
        ok.classList.toggle('is-busy', on);
        for (const n of fields.querySelectorAll('input, textarea, button')) n.disabled = on;
        status.textContent = on ? C.busy : '';
        /* a sent request cannot be called back; closing only hides it */
        cancel.textContent = on ? 'Close' : 'Cancel';
      }

      /* after the action: the fields give way to the upload progress */
      function syncUploads(s) {
        const all = s.done + s.failed + s.active + s.checking;
        retryAll.classList.toggle('hidden', !(s.failed && !s.active));
        status.title = '';
        if (s.active || s.checking) {
          status.textContent = 'Uploading evidence · ' + s.done + ' of ' + all + ' done · ' + Math.round(s.progress * 100) + '%';
          return;
        }
        if (s.failed) {
          status.textContent = s.failed + ' upload' + (s.failed === 1 ? '' : 's') + ' failed — retry, or close and attach later';
          return;
        }
        if (s.refused) {
          /* stays open: nothing else would say these files are missing */
          if (autoClose) { clearTimeout(autoClose); autoClose = null; }
          status.textContent = evRefusedText(s);
          status.title = status.textContent;
          return;
        }
        status.textContent = s.done ? 'All evidence attached' : '';
        if (s.done && !autoClose) autoClose = setTimeout(() => m.close(), 900);
      }
      function enterUploads(target) {
        form.classList.add('is-sent');
        doneBox.textContent = '';
        doneBox.append(el('span', { class: 'act-done-ic', html: SW.icon('check-circle'), 'aria-hidden': 'true' }),
          el('span', { class: 'act-done-text', text: sent.label }));
        doneBox.classList.remove('hidden');
        cancel.classList.add('hidden');
        ok.className = 'btn primary';
        ok.disabled = false;
        okLabel.textContent = 'Done';
        if (!target) {
          showError('Saved — but the panel returned no id to attach evidence to. Add it later from the ' +
            (kind === 'ban' ? 'Bans page.' : 'Audit log.'));
          return;
        }
        up.setTarget(target.type, target.id);
        up.onState(syncUploads);
        up.start();
        syncUploads(up.state());
      }

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (sent) { m.close(); return; }
        if (busy) return;
        hideError();
        const text = reason.value.trim();
        if (!text) {
          reason.classList.add('invalid');
          reason.focus();
          showError(C.field + ' is required — pick a template or write one.');
          return;
        }
        const body = targetBody(ref, { [C.key]: text });
        let iv = null;
        if (kind === 'ban') {
          iv = currentInterval();
          if (!INTERVAL_RE.test(iv)) {
            customIn.classList.add('invalid');
            customIn.focus();
            showError('Pick a duration — or type one like 14d (0 is permanent).');
            return;
          }
          body.interval = iv;
          const nv = note.value.trim();
          if (nv) body.note = nv;
        }
        const keys = actionKeys(kind, ref);
        if (keys.some((k) => actionsOut.has(k))) {
          showError('A ' + C.noun + ' for ' + name + ' is still being sent — wait for its result.');
          return;
        }
        setBusy(true);
        keys.forEach((k) => actionsOut.add(k));
        let res = null;
        try { res = await SW.api(C.url, { method: 'POST', body, toast: false }); }
        catch (ex) {
          setBusy(false);
          if (ex && ex.status === 401) { m.close(); return; }
          const msg = (ex && ex.message) || 'The panel server did not answer — try again.';
          if (closed) {
            /* closed while the request was out: no form is left to show it */
            const why = msg.charAt(0).toUpperCase() + msg.slice(1);
            SW.ui.toast('Could not ' + kind + ' ' + name, 'error', {
              detail: why + (up.hasFiles() ? (/[.!?]$/.test(why) ? ' ' : '. ') + 'The evidence picked for it was not uploaded.' : ''),
              timeout: 12000,
            });
            return;
          }
          showError(msg);
          return;
        } finally {
          keys.forEach((k) => actionsOut.delete(k));
        }
        setBusy(false);
        const label = C.done + ' ' + name + (kind === 'ban' ? ' (' + intervalLabel(iv) + ')' : '');
        if (kind === 'ban' && res && res.ok !== false && res.rconOk === false) {
          /* the ban is saved and enforced; only Squad's own AdminBan missed —
           * usually because the player had already left */
          SW.ui.toast(label, 'ok', {
            detail: 'The game server could not ban them directly (most often: they are not on the server right now). ' +
              'A3 Admin kicks them the moment they join, every time.',
            pre: res.rconResponse != null ? String(res.rconResponse).slice(0, 300) : null,
          });
        } else {
          SW.ui.rconToast(label, res);
        }
        let target = null;
        if (kind === 'ban') {
          if (res && res.ban && res.ban.id != null) target = { type: 'ban', id: Number(res.ban.id) };
        } else if (res && res.actionId != null) target = { type: 'action', id: Number(res.actionId) };
        const result = { kind, res, target };
        sent = { result, label };
        SW.live.emit('_action', { kind, playerId: dbId != null ? dbId : null, target, res });
        finish(result);
        if (closed) {
          /* closed while the request was out, yet the action went through:
           * the files picked for it still go up, in the background tray */
          if (target && up.hasFiles()) {
            up.setTarget(target.type, target.id);
            up.start();
            SW.evidence.tray(up, label);
          }
          return;
        }
        if (!up.hasFiles()) { m.close(); return; }
        enterUploads(target);
      });

      if (kind === 'ban') setDur('1d', false);
      syncCount();
      drawTemplates();
      loadTemplates().then(() => { if (!sent && !closed) drawTemplates(); });
      /* fine pointers start typing; touch keeps the keyboard down so the
       * templates stay in view */
      if (finePointer()) { try { reason.focus({ preventScroll: true }); } catch (_e) { /* ignore */ } }
    });
  }

  function openAction(kind, ref) {
    ref = ref || {};
    const dbId = ref.dbId != null ? ref.dbId : ref.id;
    if (kind !== 'ban' && dbId == null) {
      SW.ui.toast('Cannot ' + kind + ' ' + (ref.name || 'this player') + ' — no stored profile yet', 'warn');
      return Promise.resolve(null);
    }
    if (kind === 'ban' && dbId == null && !ref.steamId) {
      SW.ui.toast('Cannot ban: no player id or Steam ID known', 'error');
      return Promise.resolve(null);
    }
    return actionDialog(kind, ref).catch((e) => { console.error('action dialog', e); return null; });
  }
  SW.actions.warn = function warn(ref) { return openAction('warn', ref); };
  SW.actions.kick = function kick(ref) { return openAction('kick', ref); };
  /* Works for online players, DB players, and never-seen steamIds
   * (recently-disconnected "ban anyway" passes {name, steamId, eosId}). */
  SW.actions.ban = function ban(ref) { return openAction('ban', ref); };

  SW.actions.forceTeam = async function forceTeam(ref) {
    try {
      const v = await SW.ui.confirmModal({
        title: 'Force team change',
        body: 'Switch ' + (ref.name || 'this player') + ' to the other team?',
        confirmText: 'Switch team',
      });
      if (!v) return;
      const res = await SW.api('/api/admin/forceTeamChange', { method: 'POST', body: targetBody(ref) });
      SW.ui.rconToast('Team switched: ' + (ref.name || ''), res);
    } catch (_e) { /* toasted */ }
  };

  SW.actions.removeFromSquad = async function removeFromSquad(ref) {
    try {
      const v = await SW.ui.confirmModal({
        title: 'Remove from squad',
        body: 'Remove ' + (ref.name || 'this player') + ' from their squad?',
        confirmText: 'Remove',
      });
      if (!v) return;
      const res = await SW.api('/api/admin/removeFromSquad', { method: 'POST', body: targetBody(ref) });
      SW.ui.rconToast('Removed from squad: ' + (ref.name || ''), res);
    } catch (_e) { /* toasted */ }
  };

  SW.actions.watch = async function watch(ref, on) {
    const dbId = ref.dbId != null ? ref.dbId : ref.id;
    if (dbId == null) { SW.ui.toast('No stored profile to watchlist yet', 'warn'); return; }
    try {
      await SW.api('/api/players/' + dbId + '/watch', { method: 'POST', body: { on: !!on } });
      ref.watchlisted = !!on;
      SW.ui.toast((on ? 'Watching ' : 'Unwatched ') + (ref.name || 'player'), 'ok');
    } catch (_e) { /* toasted */ }
  };

  SW.actions.note = async function note(ref) {
    const dbId = ref.dbId != null ? ref.dbId : ref.id;
    if (dbId == null) { SW.ui.toast('No stored profile to attach a note to yet', 'warn'); return; }
    try {
      const v = await SW.ui.confirmModal({
        title: 'Note on ' + (ref.name || 'player'),
        confirmText: 'Save note',
        fields: [{ name: 'text', label: 'Note (visible to admins)', type: 'textarea', required: true, rows: 4 }],
      });
      if (!v) return;
      await SW.api('/api/players/' + dbId + '/notes', { method: 'POST', body: { text: v.text } });
      SW.ui.toast('Note saved', 'ok');
    } catch (_e) { /* toasted */ }
  };

  SW.actions.broadcast = async function broadcast(initial) {
    try {
      const v = await SW.ui.confirmModal({
        title: 'Broadcast to all players',
        confirmText: 'Broadcast',
        fields: [{ name: 'message', label: 'Message', type: 'textarea', required: true, value: initial || '' }],
      });
      if (!v) return;
      const res = await SW.api('/api/admin/broadcast', { method: 'POST', body: { message: v.message } });
      SW.ui.rconToast('Broadcast sent', res);
    } catch (_e) { /* toasted */ }
  };

  /* direct send, no modal (live view quick box) */
  SW.actions.broadcastSend = async function broadcastSend(message) {
    const res = await SW.api('/api/admin/broadcast', { method: 'POST', body: { message } });
    SW.ui.rconToast('Broadcast sent', res);
    return res;
  };

  /* ------------------------------------------------------ layer catalog
   * GET /api/layers -> {layers, layerInfo: [{name, modId, level, mode}],
   * cachedAt}. SW.state.layers keeps the plain names (views read it, and
   * setting it to null forces a refetch); SW.state.layerInfo holds the
   * entries the picker groups and badges. A list that still carries RCON's
   * " (modid)" workshop suffix is stripped, de-duplicated and parsed here,
   * so no view ever offers a name the server would reject.
   */
  const LAYER_SUFFIX_RE = /^(.+?)\s+\((\d+)\)$/;
  const PICKER_MODES = new Set(['aas', 'raas', 'fraas', 'invasion', 'insurgency', 'skirmish', 'tc', 'seed',
    'destruction', 'training', 'tanks', 'trackattack', 'track']);
  /* one RCON faction or unit-type token (NEXT-CONTRACTS §1) */
  const LP_PART_RE = /^[A-Za-z0-9_]{1,48}$/;
  /* the built-in vanilla codes and unit types (§1) — suggestions keep
   * working while GET /api/factions is unreachable */
  const VANILLA_FACTIONS = ['ADF', 'BAF', 'CAF', 'IMF', 'INS', 'MEA', 'PLA', 'PLAAGF', 'PLANMC', 'RGF',
    'TLF', 'USA', 'USMC', 'VDV', 'WPMC'];
  const UNIT_TYPES = ['CombinedArms', 'LightInfantry', 'Mechanized', 'Motorized', 'Armored', 'Support',
    'AirAssault', 'AmphibiousAssault', 'Combined'];

  function lpNorm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[\s_]+/g, ' ').trim(); }
  /* ShowServerInfo may spell "SU Kokan Invasion v1" where RCON says SU_Kokan_Invasion_v1 */
  function sameLayer(a, b) { return !!a && !!b && lpNorm(a) === lpNorm(b); }
  /* "SU_Sumari_Seed_v1" -> "SU": a workshop mod's prefix (vanilla names open with the map) */
  function modPrefixOf(name) {
    const m = /^([A-Z][A-Z0-9]{1,5})_/.exec(String(name == null ? '' : name));
    return m ? m[1] : null;
  }
  /* best-effort level / mode for servers that send no layerInfo:
   * "SU_Sumari_Seed_v1" -> Sumari · Seed (mod prefix and version dropped) */
  function guessLayerParts(name) {
    let parts = String(name).split('_').filter(Boolean);
    if (parts.length > 2 && modPrefixOf(name)) parts = parts.slice(1);
    while (parts.length > 1 && /^v\d+$/i.test(parts[parts.length - 1])) parts.pop();
    let i = 1;
    for (let k = 1; k < parts.length; k++) {
      if (PICKER_MODES.has(parts[k].toLowerCase())) { i = k; break; }
    }
    return { level: parts.slice(0, i).join(' '), mode: parts.slice(i).join(' ') };
  }
  function normCatalog(r) {
    const out = [];
    const seen = new Set();
    function add(name, modId, level, mode, mod) {
      const n = String(name == null ? '' : name).trim();
      const key = lpNorm(n);
      if (!n || seen.has(key)) return;
      seen.add(key);
      const id = modId == null || modId === '' ? null : String(modId);
      const guess = guessLayerParts(n);
      const L = {
        name: n,
        key,
        modId: id,
        level: level ? String(level) : guess.level,
        mode: mode ? String(mode) : guess.mode,
        mod: mod === true || id != null || !!modPrefixOf(n),
      };
      L.hay = lpNorm([L.name, L.level, L.mode, L.mod ? 'mod modded' : 'vanilla', id || ''].join(' '));
      out.push(L);
    }
    if (r && Array.isArray(r.layerInfo) && r.layerInfo.length) {
      for (const L of r.layerInfo) if (L && L.name) add(L.name, L.modId, L.level, L.mode, L.mod);
    } else {
      for (const raw of (r && Array.isArray(r.layers) ? r.layers : [])) {
        const s = String(raw == null ? '' : raw).trim();
        const m = LAYER_SUFFIX_RE.exec(s);
        add(m ? m[1] : s, m ? m[2] : null);
      }
    }
    return out;
  }

  /* concurrent callers share one request; an empty cached list refetches */
  let catalogInflight = null;
  function loadLayerCatalog(force) {
    const have = Array.isArray(SW.state.layers) && SW.state.layers.length > 0 && Array.isArray(SW.state.layerInfo);
    if (!force && have) return Promise.resolve(SW.state.layerInfo);
    if (catalogInflight) return catalogInflight;
    catalogInflight = SW.api('/api/layers', { toast: false }).then((r) => {
      const infos = normCatalog(r);
      SW.state.layerInfo = infos;
      SW.state.layers = infos.map((L) => L.name);
      SW.state.layersCachedAt = r && r.cachedAt != null ? Number(r.cachedAt) : null;
      return infos;
    }).finally(() => { catalogInflight = null; });
    return catalogInflight;
  }

  /* GET /api/factions (§1), normalized: known [{code, mod}] and types always
   * include the built-ins; combos keyed by lpNorm(layer). Only a 401
   * propagates — anything else degrades to the built-in suggestions. */
  async function loadFactions() {
    let r = null;
    try { r = await SW.api('/api/factions', { toast: false }); }
    catch (e) { if (e && e.status === 401) throw e; }
    const known = [];
    const seenK = new Set();
    const addK = (code, mod) => {
      const c = String(code == null ? '' : code).split('+')[0].trim();
      if (!LP_PART_RE.test(c) || seenK.has(c.toUpperCase())) return;
      seenK.add(c.toUpperCase());
      known.push({ code: c, mod: mod === true || !!modPrefixOf(c) });
    };
    for (const k of (r && Array.isArray(r.known) ? r.known : [])) {
      if (k && typeof k === 'object') addK(k.code, k.mod); else addK(k, false);
    }
    VANILLA_FACTIONS.forEach((c) => addK(c, false));
    const types = [];
    const seenT = new Set();
    for (const t of (r && Array.isArray(r.types) ? r.types : []).concat(UNIT_TYPES)) {
      const s = String(t == null ? '' : t).trim();
      if (LP_PART_RE.test(s) && !seenT.has(s.toLowerCase())) { seenT.add(s.toLowerCase()); types.push(s); }
    }
    const combos = new Map();
    const src = r && r.combos && typeof r.combos === 'object' ? r.combos : {};
    for (const name of Object.keys(src)) {
      const rows = (Array.isArray(src[name]) ? src[name] : []).filter((c) => c && c.team1 && c.team2);
      if (rows.length) combos.set(lpNorm(name), rows);
    }
    const side = (x) => (x && x.layer
      ? { layer: String(x.layer), team1: x.team1 ? String(x.team1) : null, team2: x.team2 ? String(x.team2) : null }
      : null);
    return { known, types, combos, current: side(r && r.current), next: side(r && r.next) };
  }

  SW.actions.fetchLayers = async function fetchLayers() {
    if (Array.isArray(SW.state.layers) && SW.state.layers.length) return SW.state.layers;
    await loadLayerCatalog(true);
    return SW.state.layers || [];
  };

  /* direct sends without the picker; factions optional: {team1, team2} */
  function layerBody(layer, now, f) {
    const body = { layer, now: !!now };
    if (f && f.team1 && f.team2) { body.team1 = f.team1; body.team2 = f.team2; }
    return body;
  }
  SW.actions.setNextLayer = async function setNextLayer(layer, factions) {
    const res = await SW.api('/api/admin/changeLayer', { method: 'POST', body: layerBody(layer, false, factions) });
    SW.ui.rconToast('Next layer set: ' + layer, res);
    return res;
  };

  SW.actions.changeLayerNow = async function changeLayerNow(layer, factions) {
    try {
      const c = await SW.ui.confirmModal({
        title: 'Change layer NOW?',
        body: 'This ends the current match immediately and loads ' + layer + '.',
        danger: true,
        confirmText: 'Change now',
      });
      if (!c) return;
      const res = await SW.api('/api/admin/changeLayer', { method: 'POST', body: layerBody(layer, true, factions) });
      SW.ui.rconToast('Changing layer to ' + layer, res);
    } catch (_e) { /* toasted */ }
  };

  /* the older "layer control" entry point opens the picker */
  SW.actions.layerDialog = function layerDialog(o) { return SW.ui.openLayerPicker(o); };

  /* ------------------------------------------------------- layer picker */

  let lpSeq = 0;

  /* lpCombo({placeholder, label, options() -> [{value, tag}], onChange,
   * onCommit}) -> {el, input}: a text input with a filtered suggestion list
   * (ARIA combobox: arrows move, Enter picks, Escape closes only the list).
   * Free text stays allowed — the list suggests, the caller validates. */
  function lpCombo(o) {
    const id = 'lpc' + (++lpSeq);
    const input = el('input', {
      class: 'input mono', type: 'text', placeholder: o.placeholder, 'aria-label': o.label,
      autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '97',
      role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': id,
    });
    const box = el('div', { class: 'lp-combo-list', id, role: 'listbox', 'aria-label': o.label, hidden: true });
    let items = [];
    let active = -1;
    function setActive(i) {
      const opts = box.children;
      if (opts[active]) { opts[active].classList.remove('is-active'); opts[active].setAttribute('aria-selected', 'false'); }
      active = i;
      const opt = opts[i];
      if (!opt) { input.removeAttribute('aria-activedescendant'); return; }
      opt.classList.add('is-active');
      opt.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', opt.id);
      const top = opt.offsetTop;
      const bottom = top + opt.offsetHeight;
      if (top < box.scrollTop) box.scrollTop = top;
      else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
    }
    function close() {
      setActive(-1);
      box.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
    /* browse: a value that already names an option opens the whole list */
    function open(browse) {
      const all = o.options();
      const q = input.value.trim().toLowerCase();
      const exact = all.some((it) => it.value.toLowerCase() === q);
      const head = [];
      const rest = [];
      for (const it of all) {
        const v = it.value.toLowerCase();
        if (!q || (browse && exact) || v.indexOf(q) === 0) head.push(it);
        else if (v.indexOf(q) !== -1) rest.push(it);
      }
      items = head.concat(rest);
      active = -1;
      box.textContent = '';
      if (!items.length) { close(); return; }
      items.forEach((it, i) => {
        const opt = el('div', { class: 'lp-combo-opt', role: 'option', id: id + '-' + i, 'aria-selected': 'false', dataset: { i: String(i) } });
        opt.append(el('span', { class: 'mono truncate', text: it.value, title: it.value }));
        if (it.tag) opt.append(SW.ui.badge(it.tag, 'gold'));
        box.append(opt);
      });
      box.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (exact) setActive(items.findIndex((it) => it.value.toLowerCase() === q));
    }
    function pick(i) {
      const it = items[i];
      if (!it) return;
      input.value = it.value;
      close();
      if (o.onCommit) o.onCommit();
      if (o.onChange) o.onChange();
    }
    input.addEventListener('click', () => { if (box.hidden) open(true); });
    input.addEventListener('input', () => { open(false); if (o.onChange) o.onChange(); });
    input.addEventListener('change', () => { if (o.onCommit) o.onCommit(); });
    input.addEventListener('blur', close);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (box.hidden) {
          open(true);
          if (!box.hidden && active === -1) setActive(e.key === 'ArrowDown' ? 0 : items.length - 1);
          return;
        }
        const n = items.length;
        setActive(e.key === 'ArrowDown' ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
      } else if (e.key === 'Enter') {
        if (!box.hidden && active >= 0) { e.preventDefault(); pick(active); }
      } else if (e.key === 'Escape') {
        if (!box.hidden) { e.preventDefault(); e.stopPropagation(); close(); } /* the dialog stays open */
      } else if (e.key === 'Tab') close();
    });
    box.addEventListener('mousedown', (e) => e.preventDefault()); /* focus stays in the input */
    box.addEventListener('click', (e) => {
      const opt = e.target.closest('.lp-combo-opt');
      if (opt) pick(Number(opt.dataset.i));
    });
    return { el: el('div', { class: 'lp-combo' }, input, box), input };
  }

  function lpSendButton(label, icon, cls) {
    const b = el('button', { type: 'button', class: cls + ' lp-send' }, el('span', { class: 'btn-spinner', 'aria-hidden': 'true' }));
    b.insertAdjacentHTML('beforeend', SW.icon(icon));
    b.append(el('span', { text: label }));
    return b;
  }

  /* SW.ui.openLayerPicker({now, layer, team1, team2}) -> Promise<the last
   * accepted send {layer, team1, team2, now, res} | null>, settled on close.
   * Every layer change goes through it: a searchable list grouped by level
   * (MOD badge on workshop layers); optional factions — both teams or
   * neither, faction + unit type each, suggested from GET /api/factions
   * with the layer's own mod prefix first, plus one-click combos learned
   * for that layer; a live preview of the exact RCON line; "Set as next
   * layer" and "Change now" (danger confirm); the server's reply inline.
   * `now` makes Change now the primary action; layer / team* preselect.
   */
  SW.ui.openLayerPicker = function openLayerPicker(opts) {
    const o = opts || {};
    if (!SW.can('layer')) {
      SW.ui.toast('Your role cannot change layers', 'warn');
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const uid = 'lp' + (++lpSeq);
      const preferNow = o.now === true;
      let catalog = null;   /* LayerInfo[]; null while loading */
      let loadError = null;
      let fx = null;        /* loadFactions() result; null while loading */
      let sel = null;       /* the chosen LayerInfo */
      let query = '';
      let kind = 'all';     /* all | vanilla | mod */
      let shown = [];       /* visible options, in list order */
      let comboBtns = [];
      let busy = false;
      let closed = false;
      let lastSent = null;
      let qTimer = null;

      /* ---- now playing / up next: a click picks that layer + factions */
      const ctxBox = el('div', { class: 'lp-context' });

      /* ---- browse: search, vanilla/modded filter, grouped listbox */
      const search = el('input', {
        class: 'input', type: 'search', placeholder: 'Search map, mode or mod…', autocomplete: 'off',
        spellcheck: 'false', 'aria-label': 'Search layers', 'aria-controls': uid + '-list',
      });
      const sbox = el('div', { class: 'search-box lp-search' });
      sbox.innerHTML = SW.icon('search');
      sbox.append(search);
      const kinds = el('div', { class: 'lp-kinds', role: 'group', 'aria-label': 'Layer source' });
      const kindBtns = [['all', 'All'], ['vanilla', 'Vanilla'], ['mod', 'Modded']].map(([k, label]) => {
        const n = el('span', { class: 'lp-kind-n tabular' });
        const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': 'false' }, el('span', { text: label }), n);
        b.addEventListener('click', () => {
          if (kind === k) return;
          kind = k;
          syncKinds();
          drawList(true);
        });
        kinds.append(b);
        return { k, b, n };
      });
      const countEl = el('span', { class: 'lp-count tabular' });
      const reloadBtn = el('button', {
        type: 'button', class: 'icon-btn lp-reload', html: SW.icon('refresh'),
        title: 'Reload the layer list', 'aria-label': 'Reload the layer list',
      });
      reloadBtn.addEventListener('click', () => loadCatalog(true));
      const list = el('div', { class: 'lp-list', id: uid + '-list', role: 'listbox', tabindex: '0', 'aria-label': 'Layers' });
      const browse = el('div', { class: 'lp-browse' }, sbox, el('div', { class: 'lp-bar' }, kinds, countEl, reloadBtn), list);

      /* ---- detail: selection, factions, RCON preview, server reply */
      const selBox = el('div', { class: 'lp-sel' });
      const t1 = teamRow(1);
      const t2 = teamRow(2);
      const swapBtn = el('button', {
        type: 'button', class: 'icon-btn', html: SW.icon('swap'),
        title: 'Swap the two teams', 'aria-label': 'Swap the two teams',
      });
      swapBtn.addEventListener('click', () => {
        const a = [t1.f.input.value, t1.t.input.value];
        t1.f.input.value = t2.f.input.value;
        t1.t.input.value = t2.t.input.value;
        t2.f.input.value = a[0];
        t2.t.input.value = a[1];
        sync();
      });
      const clearBtn = el('button', { type: 'button', class: 'btn ghost small', text: 'Clear' });
      clearBtn.addEventListener('click', () => { setTeams('', ''); t1.f.input.focus(); });
      const combosBox = el('div', { class: 'lp-combos' });
      const facMsg = el('p', { class: 'lp-fac-msg', 'aria-live': 'polite' });
      const facBox = el('section', { class: 'lp-fac', 'aria-labelledby': uid + '-fac' },
        el('div', { class: 'lp-fac-head' },
          el('h4', { class: 'lp-label', id: uid + '-fac', text: 'Choose factions' }),
          el('span', { class: 'lp-optional', text: 'optional', title: 'Leave both teams empty to keep the layer\'s default factions' }),
          el('span', { class: 'lp-fac-tools' }, swapBtn, clearBtn)),
        combosBox,
        el('div', { class: 'lp-teams' }, t1.el, t2.el),
        facMsg);
      const cmdNext = el('code', { class: 'lp-cmd-v' });
      const cmdNow = el('code', { class: 'lp-cmd-v' });
      const preview = el('div', { class: 'lp-preview' },
        el('div', { class: 'lp-label', text: 'RCON command' }),
        el('div', { class: 'lp-cmds' },
          el('div', { class: 'lp-cmd' }, el('span', { class: 'lp-cmd-k', text: 'Next' }), cmdNext),
          el('div', { class: 'lp-cmd is-now' }, el('span', { class: 'lp-cmd-k', text: 'Now' }), cmdNow)));
      const result = el('div', { class: 'lp-result hidden', role: 'status' });
      const detail = el('div', { class: 'lp-detail' }, selBox, facBox, preview, result);

      /* ---- footer: the rightmost (primary) send is "next" unless o.now */
      const closeBtn = el('button', { type: 'button', class: 'btn ghost', text: 'Close' });
      const nextBtn = lpSendButton('Set as next layer', 'chevrons-right', preferNow ? 'btn ghost' : 'btn primary');
      const nowBtn = lpSendButton('Change now', 'zap', 'btn danger ghost');
      const actions = el('div', { class: 'modal-actions lp-actions' }, closeBtn,
        preferNow ? nextBtn : nowBtn, preferNow ? nowBtn : nextBtn);

      const m = SW.ui.modal({
        title: 'Change layer', wide: true, class: 'lp-modal',
        body: el('div', { class: 'lp-wrap' }, el('div', { class: 'lp' }, ctxBox, browse, detail), actions),
        onClose: () => {
          closed = true;
          if (qTimer) clearTimeout(qTimer);
          resolve(lastSent);
        },
      });
      closeBtn.addEventListener('click', () => m.close());
      nextBtn.addEventListener('click', () => send(false));
      nowBtn.addEventListener('click', () => send(true));

      function teamRow(n) {
        const row = {};
        row.f = lpCombo({ placeholder: 'Faction', label: 'Team ' + n + ' faction', options: factionOptions, onChange: sync, onCommit: () => splitPlus(row) });
        row.t = lpCombo({ placeholder: 'Unit type', label: 'Team ' + n + ' unit type', options: typeOptions, onChange: sync });
        row.el = el('div', { class: 'lp-team t' + n },
          el('span', { class: 'lp-team-k', text: 'Team ' + n }),
          row.f.el, el('span', { class: 'lp-plus', text: '+', 'aria-hidden': 'true' }), row.t.el);
        return row;
      }
      /* "SU_IDF+Combined" typed or pasted into a faction box splits itself */
      function splitPlus(row) {
        const v = row.f.input.value.trim();
        const i = v.indexOf('+');
        if (i === -1) return;
        row.f.input.value = v.slice(0, i);
        if (!row.t.input.value.trim()) row.t.input.value = v.slice(i + 1);
        sync();
      }
      function setTeams(a, b) {
        for (const [row, v] of [[t1, a], [t2, b]]) {
          const s = String(v == null ? '' : v);
          const i = s.indexOf('+');
          row.f.input.value = i === -1 ? s : s.slice(0, i);
          row.t.input.value = i === -1 ? '' : s.slice(i + 1);
        }
        sync();
      }

      /* suggestions: factions sharing the layer's mod prefix (SU_ on SU_
       * layers) first, then the layer's own kind (mod / vanilla), then the rest */
      function factionOptions() {
        const known = fx ? fx.known : VANILLA_FACTIONS.map((c) => ({ code: c, mod: false }));
        const pre = sel ? modPrefixOf(sel.name) : null;
        const modLayer = !!(sel && sel.mod);
        const rank = (k) => {
          if (pre && k.code.indexOf(pre + '_') === 0) return 0;
          return (modLayer ? k.mod : !k.mod) ? 1 : 2;
        };
        return known.slice()
          .sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code))
          .map((k) => ({ value: k.code, tag: k.mod ? 'MOD' : null }));
      }
      function typeOptions() {
        return (fx ? fx.types : UNIT_TYPES).map((t) => ({ value: t }));
      }

      function teamState(row) {
        let f = row.f.input.value.trim();
        let ty = row.t.input.value.trim();
        const plus = f.indexOf('+');
        if (plus !== -1 && !ty) { ty = f.slice(plus + 1); f = f.slice(0, plus); }
        if (!f && !ty) return { empty: true };
        if (!f) return { error: 'add a faction for the unit type', bad: row.f.input };
        if (!LP_PART_RE.test(f)) return { error: 'faction codes use only letters, digits and _', bad: row.f.input };
        if (ty && !LP_PART_RE.test(ty)) return { error: 'unit types use only letters, digits and _', bad: row.t.input };
        return { value: ty ? f + '+' + ty : f };
      }
      /* both teams or neither (§1) */
      function factionState() {
        for (const i of [t1.f.input, t1.t.input, t2.f.input, t2.t.input]) i.classList.remove('invalid');
        const a = teamState(t1);
        const b = teamState(t2);
        if (a.error) { a.bad.classList.add('invalid'); return { error: 'Team 1: ' + a.error + '.', hard: true }; }
        if (b.error) { b.bad.classList.add('invalid'); return { error: 'Team 2: ' + b.error + '.', hard: true }; }
        if (a.empty && b.empty) return { none: true };
        if (a.empty || b.empty) return { error: 'Set both teams — or clear both to keep the layer\'s default factions.' };
        return { team1: a.value, team2: b.value };
      }
      function drawCmd(line, now, st) {
        line.textContent = '';
        line.append((now ? 'AdminChangeLayer' : 'AdminSetNextLayer') + ' ');
        if (!sel) { line.append(el('span', { class: 'lp-ph', text: '<pick a layer>' })); return; }
        line.append(sel.name);
        if (st.team1) line.append(' ' + st.team1 + ' ' + st.team2);
        else if (st.error) line.append(el('span', { class: 'lp-ph', text: ' <factions incomplete>' }));
      }
      function sync() {
        const st = factionState();
        facMsg.textContent = st.error || '';
        facMsg.classList.toggle('is-bad', !!st.hard);
        drawCmd(cmdNext, false, st);
        drawCmd(cmdNow, true, st);
        const ready = !!sel && !st.error && !busy;
        nextBtn.disabled = !ready;
        nowBtn.disabled = !ready;
        for (const { b, c } of comboBtns) {
          const on = !!st.team1 && st.team1 === String(c.team1) && st.team2 === String(c.team2);
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        return st;
      }

      /* what is on now / queued next: /api/factions (exact) else the snapshot */
      function liveLayer(which) {
        const side = fx && fx[which];
        if (side && side.layer) return side.layer;
        const snap = SW.state.snapshot || {};
        const si = SW.state.serverInfo || snap.serverInfo || {};
        return which === 'current' ? (snap.currentLayer || si.mapName || '') : (snap.nextLayer || si.nextLayer || '');
      }
      function ctxCard(label, k, name, side) {
        const L = catalog && name ? catalog.find((x) => x.key === lpNorm(name)) : null;
        const facs = side && side.team1 && side.team2 && sameLayer(side.layer, name) ? side.team1 + ' vs ' + side.team2 : '';
        const card = el(L ? 'button' : 'div', {
          class: 'lp-ctx is-' + k, type: L ? 'button' : null,
          title: L ? 'Pick ' + L.name + (facs ? ' with ' + facs : '') : ((name || '') + (facs ? ' · ' + facs : '')) || null,
        });
        card.append(el('span', { class: 'lp-ctx-k', text: label }));
        card.append(el('span', { class: 'lp-ctx-v truncate', text: name || '—' }));
        if (facs) card.append(el('span', { class: 'lp-ctx-f mono truncate', text: facs }));
        if (L) {
          card.addEventListener('click', () => {
            select(L, true);
            if (facs) setTeams(side.team1, side.team2);
          });
        }
        return card;
      }
      function drawContext() {
        ctxBox.textContent = '';
        ctxBox.append(ctxCard('Now playing', 'now', liveLayer('current'), fx && fx.current),
          ctxCard('Up next', 'next', liveLayer('next'), fx && fx.next));
      }

      function drawSel() {
        selBox.textContent = '';
        selBox.append(el('div', { class: 'lp-label', text: 'Selected layer' }));
        if (!sel) {
          selBox.append(el('p', { class: 'lp-sel-none', text: 'Pick a layer from the list.' }));
          return;
        }
        selBox.append(el('div', { class: 'lp-sel-name display truncate', text: sel.name, title: sel.name }));
        const meta = el('div', { class: 'lp-sel-meta' });
        meta.append(el('span', { class: 'lp-sel-part', text: sel.level || '—' }));
        if (sel.mode) meta.append(el('span', { class: 'lp-sel-part', text: sel.mode }));
        if (sel.mod) meta.append(SW.ui.badge('MOD', 'gold', sel.modId ? 'Workshop item ' + sel.modId : 'Modded layer'));
        if (sel.modId) meta.append(el('span', { class: 'lp-sel-mod mono', text: sel.modId, title: 'Steam Workshop id' }));
        if (sameLayer(sel.name, liveLayer('current'))) meta.append(SW.ui.badge('playing now', 'green'));
        if (sameLayer(sel.name, liveLayer('next'))) meta.append(SW.ui.badge('next', 'accent'));
        selBox.append(meta);
      }

      /* one-click chips for the faction combos learned on this layer */
      function drawCombos() {
        combosBox.textContent = '';
        comboBtns = [];
        combosBox.classList.toggle('hidden', !sel);
        if (!sel) return;
        if (!fx) { combosBox.append(el('span', { class: 'lp-combos-none', text: 'Loading learned factions…' })); return; }
        const seen = (fx.combos.get(sel.key) || []).slice()
          .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0) || (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0))
          .slice(0, 8);
        if (!seen.length) {
          combosBox.append(el('span', { class: 'lp-combos-none', text: 'No factions learned for this layer yet — every match played on it is remembered.' }));
          return;
        }
        combosBox.append(el('span', { class: 'lp-combos-k', text: 'Played here' }));
        for (const c of seen) {
          const n = Number(c.count) || 0;
          const b = el('button', {
            type: 'button', class: 'chip lp-combo-chip', 'aria-pressed': 'false',
            title: c.team1 + ' vs ' + c.team2 + (n ? ' — seen ' + n + (n === 1 ? ' time' : ' times') : '') +
              (c.lastSeen ? ', last ' + SW.ui.timeAgoText(c.lastSeen) : ''),
          },
          el('span', { class: 'mono truncate', text: String(c.team1) }),
          el('span', { class: 'lp-vs', text: 'vs' }),
          el('span', { class: 'mono truncate', text: String(c.team2) }));
          if (n > 1) b.append(el('span', { class: 'lp-combo-n tabular', text: '×' + n }));
          b.addEventListener('click', () => setTeams(c.team1, c.team2));
          comboBtns.push({ b, c });
          combosBox.append(b);
        }
      }

      function syncKinds() {
        const all = catalog ? catalog.length : 0;
        const mods = catalog ? catalog.filter((L) => L.mod).length : 0;
        const useful = mods > 0 && mods < all;
        kinds.classList.toggle('hidden', !useful);
        if (!useful && catalog) kind = 'all'; /* a reload in flight keeps the choice */
        for (const { k, b, n } of kindBtns) {
          const on = kind === k;
          b.classList.toggle('on', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          n.textContent = SW.ui.fmtNum(k === 'all' ? all : (k === 'mod' ? mods : all - mods));
        }
      }

      function drawList(resetScroll) {
        const keep = resetScroll ? 0 : list.scrollTop;
        list.textContent = '';
        shown = [];
        list.removeAttribute('aria-activedescendant');
        if (!catalog) {
          list.setAttribute('aria-busy', 'true');
          for (let i = 0; i < 10; i++) {
            list.append(el('div', { class: 'lp-skel', 'aria-hidden': 'true' }, SW.ui.skeleton('line', (38 + ((i * 23) % 47)) + '%')));
          }
          countEl.textContent = '';
          return;
        }
        list.removeAttribute('aria-busy');
        if (!catalog.length) {
          countEl.textContent = '';
          list.append(SW.ui.empty(loadError ? 'Could not load the layer list' : 'No layer list yet', 'map', {
            compact: true,
            hint: loadError || 'It comes from RCON ListLayers — is the server linked and answering?',
            action: { label: 'Try again', icon: 'refresh', onClick: () => loadCatalog(true) },
          }));
          return;
        }
        const toks = lpNorm(query).split(' ').filter(Boolean);
        const groups = new Map();
        let total = 0;
        for (const L of catalog) {
          if ((kind === 'vanilla' && L.mod) || (kind === 'mod' && !L.mod)) continue;
          total++;
          if (toks.length && !toks.every((t) => L.hay.indexOf(t) !== -1)) continue;
          const lv = L.level || 'Other';
          if (!groups.has(lv)) groups.set(lv, []);
          groups.get(lv).push(L);
        }
        const curKey = lpNorm(liveLayer('current'));
        const nextKey = lpNorm(liveLayer('next'));
        const frag = document.createDocumentFragment();
        for (const lv of Array.from(groups.keys()).sort((a, b) => a.localeCompare(b))) {
          const rows = groups.get(lv).sort((a, b) => a.name.localeCompare(b.name));
          const g = el('div', { class: 'lp-group', role: 'group', 'aria-label': lv });
          g.append(el('div', { class: 'lp-group-head', 'aria-hidden': 'true' },
            el('span', { class: 'truncate', text: lv, title: lv }),
            el('span', { class: 'lp-group-n tabular', text: String(rows.length) })));
          for (const L of rows) {
            const i = shown.length;
            shown.push(L);
            const opt = el('div', { class: 'lp-opt', role: 'option', id: uid + '-o' + i, 'aria-selected': 'false', dataset: { i: String(i) } });
            opt.append(el('span', { class: 'lp-opt-name truncate', text: L.name, title: L.name }));
            const tags = [];
            if (curKey && L.key === curKey) tags.push(SW.ui.badge('now', 'green', 'Playing now'));
            if (nextKey && L.key === nextKey) tags.push(SW.ui.badge('next', 'accent', 'Queued as the next layer'));
            if (L.mod) tags.push(SW.ui.badge('MOD', 'gold', L.modId ? 'Workshop item ' + L.modId : 'Modded layer'));
            if (tags.length) opt.append(el('span', { class: 'lp-opt-tags' }, tags));
            g.append(opt);
          }
          frag.append(g);
        }
        list.append(frag);
        countEl.textContent = (shown.length === total ? '' : SW.ui.fmtNum(shown.length) + ' of ') + SW.ui.fmtNum(total) + ' layers';
        if (!shown.length) {
          list.append(SW.ui.empty('No layers match', 'search', { compact: true, hint: 'Try part of a map, mode or mod name.' }));
        }
        list.scrollTop = keep;
        markSel(false);
      }

      function markSel(scroll) {
        const old = list.querySelector('.lp-opt.is-sel');
        if (old) { old.classList.remove('is-sel'); old.setAttribute('aria-selected', 'false'); }
        const i = sel ? shown.indexOf(sel) : -1;
        const opt = i === -1 ? null : list.querySelector('.lp-opt[data-i="' + i + '"]');
        if (!opt) { list.removeAttribute('aria-activedescendant'); return; }
        opt.classList.add('is-sel');
        opt.setAttribute('aria-selected', 'true');
        list.setAttribute('aria-activedescendant', opt.id);
        if (!scroll) return;
        /* keep the row clear of its group's sticky head */
        const head = opt.parentNode && opt.parentNode.firstChild;
        const top = opt.offsetTop - (head && head !== opt ? head.offsetHeight : 0);
        const bottom = opt.offsetTop + opt.offsetHeight;
        if (top < list.scrollTop) list.scrollTop = Math.max(0, top);
        else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
      }

      function select(L, scroll) {
        if (!L) return;
        if (sel !== L) {
          sel = L;
          drawSel();
          drawCombos();
        }
        markSel(scroll);
        sync();
      }
      function step(delta) {
        if (!shown.length) return;
        let i = sel ? shown.indexOf(sel) : -1;
        if (i === -1) i = delta > 0 ? 0 : shown.length - 1;
        else i = Math.max(0, Math.min(shown.length - 1, i + delta));
        select(shown[i], true);
      }
      function navKey(e) {
        const d = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 }[e.key];
        if (!d) return false;
        e.preventDefault();
        step(d);
        return true;
      }
      search.addEventListener('input', () => {
        if (qTimer) clearTimeout(qTimer);
        qTimer = setTimeout(() => { qTimer = null; query = search.value; drawList(true); }, 70);
      });
      search.addEventListener('keydown', (e) => {
        if (navKey(e)) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          if (shown.length && (!sel || shown.indexOf(sel) === -1)) select(shown[0], true);
        } else if (e.key === 'Escape' && search.value) {
          e.preventDefault();
          e.stopPropagation(); /* the first Escape clears the search, the next one closes */
          search.value = '';
          query = '';
          drawList(true);
          markSel(true);
        }
      });
      list.addEventListener('keydown', (e) => {
        if (navKey(e)) return;
        if ((e.key === 'Home' || e.key === 'End') && shown.length) {
          e.preventDefault();
          select(shown[e.key === 'Home' ? 0 : shown.length - 1], true);
        }
      });
      list.addEventListener('click', (e) => {
        const opt = e.target.closest('.lp-opt[data-i]');
        if (opt && list.contains(opt)) select(shown[Number(opt.dataset.i)], true);
      });

      async function loadCatalog(force) {
        catalog = null;
        loadError = null;
        syncKinds();
        drawList(true);
        let infos = [];
        try { infos = await loadLayerCatalog(force); }
        catch (e) {
          if (e && e.status === 401) { m.close(); return; }
          loadError = (e && e.message) || 'Request failed';
        }
        if (closed) return;
        catalog = Array.isArray(infos) ? infos : [];
        if (sel) sel = catalog.find((x) => x.key === sel.key) || sel;
        else if (o.layer) sel = catalog.find((x) => x.key === lpNorm(o.layer)) || null;
        syncKinds();
        drawContext();
        drawSel();
        drawCombos();
        drawList(true);
        markSel(true);
        sync();
      }
      async function loadFx() {
        try { fx = await loadFactions(); }
        catch (e) {
          if (e && e.status === 401) m.close();
          return;
        }
        if (closed) return;
        drawContext();
        drawSel();
        drawCombos();
        if (catalog) drawList(false);
        sync();
      }

      function showResult(now, cmd, res, err, bad) {
        result.textContent = '';
        result.className = 'lp-result ' + (bad ? 'is-bad' : 'is-ok');
        let title;
        if (err) {
          if (!err.status) title = 'Not sent — the panel server did not answer';
          else if (err.status === 400) title = 'Not sent — the panel rejected it';
          else if (err.status === 502) title = 'RCON command failed';
          else title = 'Not sent';
        } else if (bad) title = 'The server answered with an error';
        else title = now ? 'Layer change sent — the match is ending' : 'Next layer set';
        const head = el('div', { class: 'lp-result-head' });
        head.innerHTML = SW.icon(bad ? 'x-circle' : 'check-circle');
        head.append(el('span', { class: 'lp-result-title', text: title }), el('span', { class: 'lp-result-time mono', text: clockText(Date.now()) }));
        result.append(head);
        const sent = (res && res.command) || cmd;
        if (!err && sent) result.append(el('div', { class: 'lp-result-cmd mono wrap-anywhere', text: String(sent) }));
        const out = el('pre', { class: 'lp-result-out' });
        if (err) out.textContent = err.message || 'Request failed';
        else {
          const reply = res && (res.rconResponse != null ? res.rconResponse : res.response);
          out.textContent = reply == null || String(reply).trim() === '' ? '(no reply text)' : String(reply);
        }
        result.append(out);
        requestAnimationFrame(() => { if (!closed) result.scrollIntoView({ block: 'nearest' }); });
      }

      async function send(now) {
        const st = sync();
        if (!sel || st.error || busy) return;
        const layer = sel.name;
        const facs = st.team1 ? { team1: st.team1, team2: st.team2 } : null;
        if (now) {
          const ok = await SW.ui.confirmModal({
            title: 'Change layer now?',
            danger: true,
            confirmText: 'Change now',
            body: 'This ends the current match immediately for every player and loads ' + layer +
              (facs ? ' with ' + facs.team1 + ' vs ' + facs.team2 : '') + '.',
          });
          if (!ok || closed) return;
        }
        const cmd = (now ? 'AdminChangeLayer ' : 'AdminSetNextLayer ') + layer + (facs ? ' ' + facs.team1 + ' ' + facs.team2 : '');
        const btn = now ? nowBtn : nextBtn;
        busy = true;
        btn.classList.add('is-busy');
        sync();
        let res = null;
        let err = null;
        try { res = await SW.api('/api/admin/changeLayer', { method: 'POST', body: layerBody(layer, now, facs), toast: false }); }
        catch (e) { err = e; }
        busy = false;
        btn.classList.remove('is-busy');
        if (closed) return;
        if (err && err.status === 401) { m.close(); return; }
        const bad = !!err || !!(res && (res.ok === false || res.rconOk === false));
        showResult(now, cmd, res, err, bad);
        sync();
        if (bad) return;
        lastSent = { layer, team1: facs ? facs.team1 : null, team2: facs ? facs.team2 : null, now: !!now, res };
        if (!now && fx) {
          fx.next = { layer, team1: lastSent.team1, team2: lastSent.team2 };
          drawContext();
          drawSel();
          drawList(false);
        }
      }

      if (o.team1 || o.team2) setTeams(o.team1, o.team2);
      drawContext();
      drawSel();
      drawCombos();
      drawList(true);
      sync();
      loadCatalog(false);
      loadFx();
      /* fine pointers start typing in the search; touch starts on the list
       * (no on-screen keyboard popping over the dialog) */
      setTimeout(() => {
        if (closed) return;
        let fine = true;
        try { fine = window.matchMedia('(pointer: fine)').matches; } catch (_e) { fine = true; }
        try { (fine ? search : list).focus({ preventScroll: true }); } catch (_e) { /* ignore */ }
      }, 30);
    });
  };

  /* ------------------------------------------------------------- SSE live
   * SW.live.on(evt, fn) -> unsubscribe fn. Events (spec §13 + §19.6):
   * hello, kill, chat, deployable, flag, connect, disconnect, players, match,
   * serverinfo, tick, status, broadcast, pop, revive, squad, admincall,
   * alert (BATCH3 §5/§6). Internal: '_conn' {up, stopped?}; '_resync'
   * {downMs} after a recovered outage; '_action' / '_evidence' (see top).
   * '*' subscribes to everything as fn(evt, data).
   *
   * Resync: a 'hello' that follows a drop means events were missed while
   * the stream was down, so the overview/status is refetched and '_resync'
   * is emitted for views to refetch their own data.
   */
  SW.live = (function () {
    const subs = new Map();
    const EVENTS = ['kill', 'chat', 'deployable', 'flag', 'connect', 'disconnect',
      'players', 'match', 'serverinfo', 'tick', 'status', 'broadcast', 'pop', 'revive', 'squad',
      'admincall', 'alert'];
    let es = null;
    let retryTimer = null;
    let backoff = 1000;
    let wanted = false;
    let everHello = false; /* a hello arrived on an earlier connection */
    let downAt = 0;        /* start of the current outage (0 = none) */
    const live = { up: false };

    function emit(evt, data) {
      const set = subs.get(evt);
      if (set) for (const fn of Array.from(set)) { try { fn(data); } catch (e) { console.error('live handler (' + evt + ')', e); } }
      const any = subs.get('*');
      if (any) for (const fn of Array.from(any)) { try { fn(evt, data); } catch (e) { console.error('live handler (*)', e); } }
    }
    function parse(e) {
      try { return JSON.parse(e.data); } catch (_err) { return e.data; }
    }
    function handler(evt) {
      return function (e) { emit(evt, parse(e)); };
    }
    function onHello(e) {
      const d = parse(e);
      const recovered = everHello && downAt > 0;
      const downMs = recovered ? Date.now() - downAt : 0;
      everHello = true;
      downAt = 0;
      emit('hello', d);
      if (recovered) resyncAfterOutage(downMs);
    }
    function markDown() {
      live.up = false;
      if (!downAt) downAt = Date.now();
      emit('_conn', { up: false });
    }
    function scheduleRetry() {
      if (!wanted || retryTimer) return;
      retryTimer = setTimeout(() => { retryTimer = null; if (wanted) live.start(); }, backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
    live.start = function start() {
      wanted = true;
      if (es) return;
      try { es = new EventSource('/api/stream'); } catch (_e) { markDown(); scheduleRetry(); return; }
      es.addEventListener('hello', onHello);
      for (const evt of EVENTS) es.addEventListener(evt, handler(evt));
      es.onopen = () => { backoff = 1000; live.up = true; emit('_conn', { up: true }); };
      es.onerror = () => {
        markDown();
        if (es && es.readyState === 2) { es.close(); es = null; scheduleRetry(); } // CLOSED -> manual retry
      };
    };
    live.stop = function stop() {
      wanted = false;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (es) { es.close(); es = null; }
      live.up = false;
      everHello = false;
      downAt = 0;
      backoff = 1000;
      emit('_conn', { up: false, stopped: true });
    };
    live.active = function active() { return wanted; };
    live.emit = emit; /* internal: synthetic events such as '_resync' */
    live.on = function on(evt, fn) {
      if (!subs.has(evt)) subs.set(evt, new Set());
      subs.get(evt).add(fn);
      return () => live.off(evt, fn);
    };
    live.off = function off(evt, fn) {
      const s = subs.get(evt);
      if (s) s.delete(fn);
    };
    return live;
  })();

  /* after a recovered outage: refetch overview/status, then tell the views */
  let resyncBusy = false;
  function resyncAfterOutage(downMs) {
    if (resyncBusy) return;
    resyncBusy = true;
    Promise.resolve(refreshOverview()).catch(() => null).then(() => {
      resyncBusy = false;
      SW.live.emit('_resync', { downMs, at: Date.now() });
    });
  }

  /* ------------------------------------------------------ game-log health
   * Kills, teamkills, deployable (radio/HAB) damage, the flags they raise,
   * match start/end and the tick rate arrive ONLY through the game log
   * (SquadGame.log); chat and the roster ride RCON. status.log from the
   * overview / SSE 'status': {mode, ok, error?} — ok is null while no log
   * source is configured (or one is still starting), false while it fails.
   * state(): 'unknown' (no status yet) | 'ok' | 'off' | 'down'. Log-fed
   * empty states use copy() instead of claiming nothing happened, and
   * re-render on '_logfeed' {state}, emitted whenever the state changes.
   */
  SW.logFeed = {
    state() {
      const lg = SW.state.status && SW.state.status.log;
      if (!lg || typeof lg !== 'object') return 'unknown';
      if (lg.mode === 'local' && lg.path === '') return 'off';
      if (lg.ok === true) return 'ok';
      return lg.ok === false ? 'down' : 'off';
    },
    missing() {
      const s = SW.logFeed.state();
      return s === 'off' || s === 'down';
    },
    /* empty-state copy: what = plural subject, e.g. 'Kills and teamkills' */
    copy(what) {
      const down = SW.logFeed.state() === 'down';
      const lg = (SW.state.status && SW.state.status.log) || {};
      const can = SW.can('settings');
      let hint = (what || 'Kills, teamkills and radio damage') + ' come from SquadGame.log';
      if (down) {
        const err = lg.error ? String(lg.error).trim().replace(/[\s.!?]+$/, '') : '';
        hint += ' — the log feed is failing' + (err ? ': ' + err : '') + '.';
      } else hint += can ? ' — no log source is connected yet.' : ' — ask the server owner to connect the log feed.';
      return {
        title: down ? 'The game log feed is down' : 'Waiting for the game log',
        hint,
        action: can ? { label: down ? 'Check log feed' : 'Connect log feed', href: '#/settings', icon: 'settings' } : null,
      };
    },
    /* title text for a readout the log feeds, or null while the feed is fine */
    needs(what) {
      const s = SW.logFeed.state();
      if (s === 'down') return what + ' needs the game log feed (SquadGame.log), which is failing right now';
      if (s === 'off') return what + ' needs the game log feed (SquadGame.log), which is not connected';
      return null;
    },
  };
  let logFeedSeen = 'unknown';

  /* global SSE subscriptions feeding SW.state + topbar */
  function applyStatus(st) {
    if (!st) return;
    SW.state.status = Object.assign({}, SW.state.status, { rcon: st.rcon || SW.state.status.rcon, log: st.log || SW.state.status.log });
    if (st.tickRate != null) SW.state.tickRate = Number(st.tickRate);
    if (st.serverInfo) SW.state.serverInfo = st.serverInfo;
    const lf = SW.logFeed.state();
    if (lf !== logFeedSeen) {
      logFeedSeen = lf;
      SW.live.emit('_logfeed', { state: lf });
    }
  }
  SW.live.on('hello', (d) => {
    if (d && typeof d === 'object') {
      if (d.snapshot) SW.state.snapshot = d.snapshot;
      if (d.me) {
        const prev = SW.state.me;
        SW.state.me = d.me;
        /* a role/perm edit lands on the next SSE connect — rebuild the chrome
         * (nav + role badge) when it changed, not on every reconnect */
        if (prev && (prev.role !== d.me.role ||
          JSON.stringify(prev.perms || null) !== JSON.stringify(d.me.perms || null))) renderShell();
      }
      const callsSt = SW.adminCalls.status();
      if (SW.adminCalls.can() && (callsSt === 'idle' || callsSt === 'error')) SW.adminCalls.load();
      updateTopbar();
    }
  });
  SW.live.on('players', (snap) => {
    if (snap && typeof snap === 'object') { SW.state.snapshot = snap; updateTopbar(); }
  });
  SW.live.on('serverinfo', (si) => {
    if (si && typeof si === 'object') {
      SW.state.serverInfo = si;
      if (SW.state.snapshot) SW.state.snapshot.serverInfo = si;
      updateTopbar();
    }
  });
  SW.live.on('status', (st) => { applyStatus(st); updateTopbar(); });
  SW.live.on('tick', (t) => {
    const rate = typeof t === 'number' ? t : (t && (t.tickRate != null ? t.tickRate : t.rate));
    if (rate != null && Number.isFinite(Number(rate))) {
      SW.state.tickRate = Number(rate);
      SW.state.tickHist.push(Number(rate));
      if (SW.state.tickHist.length > 60) SW.state.tickHist.shift();
      updateTopbar();
    }
  });
  SW.live.on('match', (m) => {
    if (m && typeof m === 'object' && SW.state.snapshot) {
      SW.state.snapshot.match = Object.assign({}, SW.state.snapshot.match, {
        id: m.matchId != null ? m.matchId : (SW.state.snapshot.match && SW.state.snapshot.match.id),
        layer: m.layer, level: m.level,
        startedAt: m.startedAt, endedAt: m.endedAt,
      });
      updateTopbar();
    }
  });
  SW.live.on('flag', (f) => {
    if (!f || !SW.can('flags') || JOIN_ALERT_FLAGS.has(String(f.type))) return; /* 'alert' covers join alerts */
    const who = (f.player && f.player.name) || f.playerName || 'unknown player';
    SW.ui.toast('Flag S' + (f.severity || '?') + ': ' + SW.ui.flagLabel(f.type) + ' — ' + who, 'warn');
  });

  /* ---------------------------------------------------------------- sound
   * A short two-note chime for new admin calls and join alerts, synthesized
   * with WebAudio (no audio files). Browsers let an AudioContext start only
   * after a user gesture, so it is created on the first press; a chime
   * asked for before that stays silent. Muting is per browser
   * ('sw:chime-muted'); window 'sw:sound' {muted} fires on changes.
   */
  SW.sound = (function () {
    const AC = window.AudioContext || window.webkitAudioContext;
    const GESTURES = ['pointerdown', 'keydown', 'touchend'];
    /* soft sine notes a fifth / a fourth apart: rising for a call, falling for an alert */
    const TUNES = { call: [[587.33, 0], [880, 0.15]], alert: [[880, 0], [659.25, 0.15]] };
    let ctx = null;
    let gestured = false;
    let lastAt = 0;
    function audio() {
      if (!AC || !gestured) return null;
      if (!ctx) { try { ctx = new AC(); } catch (_e) { ctx = null; } }
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
      return ctx;
    }
    function onGesture() {
      gestured = true;
      const c = audio();
      if (c && c.state === 'running') GESTURES.forEach((ev) => document.removeEventListener(ev, onGesture, true));
    }
    GESTURES.forEach((ev) => document.addEventListener(ev, onGesture, true));
    /* a bell-ish tone: the fundamental plus a quiet octave, 12ms attack,
     * exponential decay */
    function tone(c, out, t0, freq, dur, peak) {
      for (const [mul, amp] of [[1, 1], [2, 0.16]]) {
        const osc = c.createOscillator();
        const g = c.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq * mul, t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak * amp, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        osc.connect(g);
        g.connect(out);
        osc.start(t0);
        osc.stop(t0 + dur + 0.05);
      }
    }
    const api = {
      muted() { return !!SW.prefs.get('chime-muted', false); },
      setMuted(on) {
        SW.prefs.set('chime-muted', !!on);
        try { window.dispatchEvent(new CustomEvent('sw:sound', { detail: { muted: !!on } })); } catch (_e) { /* ignore */ }
        if (!on) { lastAt = 0; api.chime('call'); } /* turning it on plays a sample */
      },
      toggle() { api.setMuted(!api.muted()); },
      /* -> true when it played (not muted, audio unlocked, not within 1.2s of the last) */
      chime(kind) {
        if (api.muted()) return false;
        const now = Date.now();
        if (now - lastAt < 1200) return false;
        const c = audio();
        if (!c || c.state !== 'running') return false;
        lastAt = now;
        const out = c.createGain();
        out.gain.value = 0.9;
        const lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 4200;
        out.connect(lp);
        lp.connect(c.destination);
        const t0 = c.currentTime + 0.02;
        for (const [freq, at] of TUNES[kind] || TUNES.call) tone(c, out, t0 + at, freq, 0.6, 0.13);
        return true;
      },
    };
    return api;
  })();

  /* ---------------------------------------------------------- admin calls
   * In-game "!admin" calls (BATCH3 §5). The open ones (GET
   * /api/admin-calls?status=open, kept current by SSE 'admincall') feed the
   * topbar bell and the dashboard card; recent() holds handled calls seen
   * this session plus loadRecent()'s backfill. A call that is new to this
   * page, open and newer than the page load toasts and chimes — the
   * initial load and later status updates never do.
   */
  function firstOf(o, keys) {
    for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k];
    return null;
  }
  SW.adminCalls = (function () {
    const open = new Map();
    const handled = new Map();
    const seen = new Set();
    const subs = new Set();
    let hidden = 0;          /* open calls the server counted but did not list */
    /* idle | loading | ok | error | unavailable (a server without the
     * admin-calls routes: the bell and the card stay out of the way) */
    let status = 'idle';
    let inflight = null;
    let recentAsked = false;
    function can() { return SW.canAny(['flags', 'warn', 'kick', 'ban']); }
    function norm(c) {
      if (!c || typeof c !== 'object' || c.id == null) return null;
      const p = c.player && typeof c.player === 'object' ? c.player : {};
      const dbId = firstOf(c, ['playerDbId', 'playerId', 'player_id']);
      return {
        id: Number(c.id),
        time: Number(c.time) || 0,
        status: String(c.status || 'open') === 'handled' ? 'handled' : 'open',
        playerName: String(firstOf(c, ['playerName', 'player_name']) || p.name || 'unknown player'),
        playerDbId: dbId != null ? dbId : firstOf(p, ['dbId', 'id']),
        eosId: firstOf(c, ['eosId', 'eos_id']) || p.eosId || null,
        steamId: firstOf(c, ['steamId', 'steam_id']) || p.steamId || null,
        message: c.message == null ? '' : String(c.message),
        handledBy: firstOf(c, ['handledBy', 'handled_by']),
        handledByName: firstOf(c, ['handledByName', 'handledByUsername', 'handlerName']),
        handledAt: Number(firstOf(c, ['handledAt', 'handled_at'])) || null,
      };
    }
    function emit(info) {
      for (const fn of Array.from(subs)) {
        try { fn(info || {}); } catch (e) { console.error('admin calls handler', e); }
      }
    }
    function put(c) {
      const prev = open.get(c.id) || handled.get(c.id);
      if (prev && !c.handledByName && prev.handledByName && String(prev.handledBy) === String(c.handledBy)) c.handledByName = prev.handledByName;
      if (c.status === 'open') {
        open.set(c.id, c);
        handled.delete(c.id);
        return;
      }
      open.delete(c.id);
      handled.set(c.id, c);
      if (handled.size > 30) {
        const oldest = Array.from(handled.values()).sort((a, b) => (a.handledAt || a.time) - (b.handledAt || b.time))[0];
        if (oldest) handled.delete(oldest.id);
      }
    }
    function load() {
      if (!can()) return Promise.resolve();
      if (inflight) return inflight;
      const startedAt = Date.now();
      /* a refresh keeps what is shown; a first load or a retry shows loading */
      status = (open.size || handled.size) && status !== 'error' ? status : 'loading';
      emit();
      inflight = SW.api('/api/admin-calls?status=open', { toast: false }).then((r) => {
        const rows = (r && Array.isArray(r.rows) ? r.rows : []).map(norm).filter(Boolean);
        const listed = new Set(rows.map((c) => c.id));
        /* calls the stream delivered while this request was out stay */
        for (const c of Array.from(open.values())) {
          if (!listed.has(c.id) && !(c.arrivedAt >= startedAt)) open.delete(c.id);
        }
        for (const c of rows) { seen.add(c.id); put(c); }
        const total = Number(r && r.open);
        const openListed = rows.filter((c) => c.status === 'open').length;
        hidden = Number.isFinite(total) ? Math.max(0, total - openListed) : 0;
        status = 'ok';
        emit();
      }).catch((e) => {
        if (e && e.status === 401) return;
        status = e && e.status === 404 ? 'unavailable' : 'error';
        emit();
      }).finally(() => { inflight = null; });
      return inflight;
    }
    /* handled calls for context (the dashboard card), once per session */
    function loadRecent() {
      if (!can() || recentAsked) return;
      recentAsked = true;
      SW.api('/api/admin-calls?status=all&limit=50', { toast: false }).then((r) => {
        const rows = (r && Array.isArray(r.rows) ? r.rows : []).map(norm).filter(Boolean);
        let added = false;
        for (const c of rows) {
          if (c.status !== 'handled' || open.has(c.id) || handled.has(c.id)) continue;
          seen.add(c.id);
          put(c);
          added = true;
        }
        if (added) emit();
      }).catch(() => { recentAsked = false; });
    }
    function announce(c) {
      SW.sound.chime('call');
      const actions = [{ label: 'Handle', primary: true, onClick: () => { handle(c.id); } }];
      if (c.playerDbId != null) actions.push({ label: 'Profile', href: '#/players/' + encodeURIComponent(c.playerDbId) });
      SW.ui.toast('Admin call — ' + c.playerName, 'warn', {
        icon: 'bell', detail: c.message ? '“' + c.message + '”' : null, actions, timeout: 15000,
      });
    }
    function onEvent(raw) {
      if (!can()) return;
      const c = norm(raw);
      if (!c) return;
      if (status === 'unavailable') status = 'ok'; /* the server has them after all */
      const fresh = !seen.has(c.id);
      seen.add(c.id);
      c.arrivedAt = Date.now();
      if (fresh && c.status === 'handled' && hidden > 0) hidden--;
      put(c);
      const ring = fresh && c.status === 'open' && isAfterBoot(c.time);
      emit({ call: c, ring });
      if (ring) announce(c);
    }
    async function handle(id) {
      const key = Number(id);
      const was = open.get(key);
      const me = SW.state.me || {};
      if (was) {
        put(Object.assign({}, was, { status: 'handled', handledBy: me.id, handledByName: me.username || null, handledAt: Date.now() }));
        emit();
      }
      try {
        const r = await SW.api('/api/admin-calls/' + encodeURIComponent(key) + '/handle', { method: 'POST', body: {} });
        const c = norm(r && r.call);
        if (c) { put(c); emit(); }
        return true;
      } catch (_e) {
        if (was) { put(was); emit(); }
        return false;
      }
    }
    function reset() {
      open.clear();
      handled.clear();
      seen.clear();
      hidden = 0;
      status = 'idle';
      recentAsked = false;
      emit();
    }
    return {
      can,
      status: () => status,
      list: () => Array.from(open.values()).sort((a, b) => b.time - a.time || b.id - a.id),
      recent: () => Array.from(handled.values()).sort((a, b) => (b.handledAt || b.time) - (a.handledAt || a.time)),
      count: () => open.size + hidden,
      on(fn) { subs.add(fn); return () => subs.delete(fn); },
      load, loadRecent, handle, reset, onEvent,
    };
  })();
  SW.live.on('admincall', (c) => SW.adminCalls.onEvent(c));
  SW.live.on('_resync', () => { if (SW.adminCalls.can()) SW.adminCalls.load(); });

  /* ---------------------------------------------------------- join alerts
   * SSE 'alert' {type, time, player:{dbId, name}, details} (BATCH3 §6): a
   * watchlisted or flagged player joined, or a join shares an IP with a
   * banned account. Each toasts with a way to the profile and chimes. */
  const JOIN_ALERT_COPY = {
    watchlist: { title: 'Watchlisted player joined', icon: 'eye', kind: 'warn' },
    flagged: { title: 'Flagged player joined', icon: 'flag', kind: 'warn' },
    evasion: { title: 'Possible ban evasion', icon: 'shield-alert', kind: 'error' },
  };
  function joinAlertKind(type) {
    const t = String(type || '').toLowerCase();
    if (t.indexOf('evasion') !== -1) return 'evasion';
    if (t.indexOf('flag') !== -1) return 'flagged';
    if (t.indexOf('watch') !== -1) return 'watchlist';
    return null;
  }
  function detailsObj(d) {
    if (d && typeof d === 'object') return d;
    if (typeof d === 'string' && /^\s*\{/.test(d)) { try { return JSON.parse(d); } catch (_e) { return {}; } }
    return {};
  }
  /* the banned account behind a ban-evasion alert or flag (key spellings
   * vary): {playerId, name, banId, reason} or null */
  SW.ui.evasionOf = function evasionOf(details) {
    const d = detailsObj(details);
    const b = (d.banned && typeof d.banned === 'object') ? d.banned
      : ((d.bannedPlayer && typeof d.bannedPlayer === 'object') ? d.bannedPlayer : {});
    let id = firstOf(d, ['bannedPlayerId', 'bannedId', 'banned_player_id', 'bannedDbId']);
    if (id == null) id = firstOf(b, ['dbId', 'id']);
    let nm = firstOf(d, ['bannedPlayerName', 'bannedName', 'banned_name']);
    if (nm == null) nm = b.name != null ? b.name : null;
    const banId = firstOf(d, ['banId', 'ban_id']);
    if (id == null && nm == null && banId == null) return null;
    return { playerId: id, name: nm == null ? null : String(nm), banId, reason: d.reason ? String(d.reason) : null };
  };
  SW.live.on('alert', (a) => {
    if (!a || typeof a !== 'object' || !SW.canAny(['flags', 'ban']) || !isAfterBoot(a.time)) return;
    const k = joinAlertKind(a.type);
    const copy = JOIN_ALERT_COPY[k] || { title: 'Join alert', icon: 'alert-circle', kind: 'warn' };
    const p = a.player && typeof a.player === 'object' ? a.player : {};
    const who = p.name || a.playerName || 'unknown player';
    const pid = p.dbId != null ? p.dbId : p.id;
    const d = detailsObj(a.details);
    let detail = d.reason ? String(d.reason) : null;
    const actions = [];
    if (pid != null) actions.push({ label: 'Profile', primary: k === 'evasion', href: '#/players/' + encodeURIComponent(pid) });
    if (k === 'evasion') {
      const ev = SW.ui.evasionOf(d);
      if (ev && (ev.name || ev.banId != null)) {
        detail = 'Shares an IP with ' + (ev.name || 'a banned player') + (ev.banId != null ? ' (ban #' + ev.banId + ')' : '');
      }
      if (ev && ev.playerId != null) actions.push({ label: 'Banned account', href: '#/players/' + encodeURIComponent(ev.playerId) });
      /* set before the kick is sent; its outcome is only in the audit log */
      if (d.autoKick) {
        detail = (detail ? detail + ' — ' : '') + 'automatic kick sent' + (SW.can('audit') ? ' (the Audit log shows whether it landed)' : '');
      }
    }
    if (detail && detail.toLowerCase() === copy.title.toLowerCase()) detail = null;
    SW.ui.toast(copy.title + ' — ' + who, copy.kind, { icon: copy.icon, detail, actions, timeout: k === 'evasion' ? 20000 : 10000 });
    SW.sound.chime('alert');
  });

  /* connection banner: shows while the live stream is down (after a short
   * grace so a proxy recycling the connection never flashes it), clears on
   * reconnect, hides when the stream is stopped on purpose (sign-out). */
  let bannerTimer = null;
  function setConnBanner(show) {
    const b = document.getElementById('conn-banner');
    if (!b) return;
    if (!show) {
      if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
      b.classList.add('hidden');
      return;
    }
    if (bannerTimer || !b.classList.contains('hidden')) return;
    bannerTimer = setTimeout(() => {
      bannerTimer = null;
      if (!SW.live.up && SW.live.active()) b.classList.remove('hidden');
    }, 1200);
  }
  function initConnBanner() {
    const b = document.getElementById('conn-banner');
    if (!b || b.dataset.ready === '1') return;
    b.dataset.ready = '1';
    b.setAttribute('role', 'status');
    b.textContent = '';
    b.append(el('span', { class: 'conn-banner-icon', html: SW.icon('wifi-off') }));
    b.append(el('span', { class: 'conn-banner-text', text: 'Live link lost — reconnecting' }));
    b.append(el('span', { class: 'conn-banner-sub', text: 'figures may be stale until it is back' }));
    b.append(el('span', { class: 'conn-banner-bar', 'aria-hidden': 'true' }));
  }
  SW.live.on('_conn', (c) => {
    setConnBanner(!(c && (c.up || c.stopped)));
    updateTopbar();
  });

  /* ------------------------------------------------------------- router */

  /* Granular permissions (docs/ROLES-INVITES-SETTINGS.md §1): /api/me and the
   * SSE hello carry me.perms = {permKey: true}; unknown keys deny. Fallbacks:
   * a bare {role} user maps through the builtin min-role matrix, and a role
   * name passed as `perm` still works as the legacy rank gate. */
  const ROLE_RANK = { viewer: 1, admin: 2, owner: 3 };
  const PERM_MIN_ROLE = {
    view: 'viewer', stream: 'viewer',
    notes: 'admin', flags: 'admin', warn: 'admin', kick: 'admin', ban: 'admin',
    broadcast: 'admin', team: 'admin', squad: 'admin', layer: 'admin', match: 'admin',
    ips: 'admin', adminChat: 'admin', audit: 'admin',
    slomo: 'owner', raw: 'owner', users: 'owner', roles: 'owner', settings: 'owner',
  };
  SW.can = function can(perm) {
    const me = SW.state.me;
    if (!me) return false;
    if (ROLE_RANK[perm]) return (ROLE_RANK[me.role] || 0) >= ROLE_RANK[perm]; /* legacy role-string gate */
    if (me.perms && typeof me.perms === 'object') return me.perms[perm] === true;
    const min = PERM_MIN_ROLE[perm];
    if (!min) return false;
    return (ROLE_RANK[me.role] || 0) >= ROLE_RANK[min];
  };
  /* canAny('users') / canAny(['roles', 'users']) — any one key grants access */
  SW.canAny = function canAny(perms) {
    if (!Array.isArray(perms)) return SW.can(perms);
    return perms.some((p) => SW.can(p));
  };

  function parseHash() {
    let h = location.hash || '';
    h = h.replace(/^#\/?/, '');
    let query = {};
    const qi = h.indexOf('?');
    if (qi >= 0) {
      try { query = Object.fromEntries(new URLSearchParams(h.slice(qi + 1)).entries()); } catch (_e) { query = {}; }
      h = h.slice(0, qi);
    }
    const segs = h.split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch (_e) { return s; } });
    return { name: segs[0] || '', args: segs.slice(1), query, path: h };
  }
  SW.currentRouteName = function currentRouteName() { return parseHash().name; };
  SW.navigate = function navigate(hash) {
    if (location.hash === hash) handleRoute();
    else location.hash = hash;
  };

  const AUTH_ROUTES = { login: 1, setup: 1, join: 1 };

  /* the sidebar's name for a page wins, so the tab title always matches the
   * nav (route #/console is labelled "Raw command") */
  function routeTitle(target, parsed, known) {
    if (AUTH_ROUTES[target]) return BRAND;
    if (!known) return 'Not found · ' + BRAND;
    let label = ROUTE_LABELS[target] || (SW.routes[target] && SW.routes[target].label);
    if (target === 'players' && parsed.args.length) label = 'Player';
    if (target === 'matches' && parsed.args.length) label = 'Match';
    if (!label) label = target.charAt(0).toUpperCase() + target.slice(1);
    return label + ' · ' + BRAND;
  }

  /* route content fades in on every render (DESIGN §6) */
  function fadeIn(main) {
    Array.prototype.forEach.call(main.children, (c) => c.classList.add('fade-in'));
  }

  let currentView = null;

  function handleRoute() {
    const main = document.getElementById('main');
    if (!main) return;
    const parsed = parseHash();
    const authed = !!SW.state.me;
    const target = parsed.name || (authed ? 'dashboard' : 'login');
    if (!authed && !AUTH_ROUTES[target]) { location.hash = '#/login'; return; }
    if (authed && AUTH_ROUTES[target]) { location.hash = '#/dashboard'; return; }
    if (currentView && typeof currentView.cleanup === 'function') {
      try { currentView.cleanup(); } catch (e) { console.error('cleanup', e); }
    }
    currentView = null;
    SW.ui.closePopover();
    document.body.classList.toggle('chrome-hidden', !!AUTH_ROUTES[target]);
    setDrawer(false);
    main.textContent = '';
    const def = SW.routes[target];
    document.title = routeTitle(target, parsed, !!def);
    syncTitleBadge();
    if (!def) {
      updateNavActive('');
      main.append(SW.ui.empty('Page not found', 'map', {
        hint: 'There is no “' + target + '” page in ' + BRAND + '.',
        action: { label: 'Back to the dashboard', href: '#/dashboard', icon: 'dashboard' },
      }));
      fadeIn(main);
      return;
    }
    const need = def.perm || def.role; /* perm: key or [keys] (any grants) */
    if (need && !SW.canAny(need)) {
      updateNavActive(target);
      main.append(SW.ui.empty('You do not have access to this page', 'lock', {
        hint: 'Your role is missing the permission it needs — ask an owner.',
      }));
      fadeIn(main);
      return;
    }
    currentView = def;
    updateNavActive(target);
    try {
      def.render.call(def, main, { args: parsed.args, query: parsed.query, name: target });
    } catch (e) {
      console.error('render ' + target, e);
      main.append(SW.ui.empty('This view failed to render', 'warn', { hint: 'See the browser console for details.' }));
    }
    fadeIn(main);
    main.scrollTop = 0;
  }
  window.addEventListener('hashchange', () => { for (const c of [...openModals]) c(); });
  window.addEventListener('hashchange', handleRoute);

  /* --------------------------------------------------------- shell + nav */

  /* Sidebar sections; perm: a key or [keys] (any one grants). A section's
   * label shows only when at least one of its items is visible. */
  const NAV = [
    { group: 'Operations', items: [
      { route: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      { route: 'live', label: 'Live', icon: 'live' },
    ] },
    { group: 'Intel', items: [
      { route: 'players', label: 'Players', icon: 'users' },
      { route: 'matches', label: 'Matches', icon: 'swords' },
      { route: 'chat', label: 'Chat', icon: 'chat' },
      { route: 'trolls', label: 'Trolls', icon: 'shield-alert' },
    ] },
    { group: 'Admin', items: [
      { route: 'admin', label: 'Admin tools', icon: 'gavel', perm: ['broadcast', 'layer', 'match', 'squad', 'team', 'warn', 'kick', 'ban'] },
      { route: 'bans', label: 'Bans', icon: 'ban', perm: 'ban' },
      { route: 'audit', label: 'Audit log', icon: 'scroll', perm: 'audit' },
      { route: 'console', label: 'Raw command', icon: 'terminal', perm: 'raw' },
    ] },
    { group: 'System', items: [
      { route: 'users', label: 'Users', icon: 'user-cog', perm: 'users' },
      { route: 'roles', label: 'Roles', icon: 'shield', perm: ['roles', 'users'] },
      { route: 'automation', label: 'Automation', icon: 'clock', perm: 'settings' },
      { route: 'settings', label: 'Settings', icon: 'settings', perm: 'settings' },
    ] },
  ];
  const ROUTE_LABELS = {};
  NAV.forEach((g) => g.items.forEach((it) => { ROUTE_LABELS[it.route] = it.label; }));

  function updateNavActive(target) {
    document.querySelectorAll('#sidebar .nav-item').forEach((a) => {
      const on = a.dataset.route === target;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  /* mobile drawer (<768px): body.drawer-open; closes on backdrop click,
   * route change, Escape, and when the viewport grows past the breakpoint */
  function setDrawer(open) {
    const on = !!open;
    const was = document.body.classList.contains('drawer-open');
    document.body.classList.toggle('drawer-open', on);
    const t = document.querySelector('#topbar .drawer-toggle');
    if (t) {
      t.setAttribute('aria-expanded', on ? 'true' : 'false');
      t.setAttribute('aria-label', on ? 'Close menu' : 'Open menu');
    }
    if (on && !was && kbNav) {
      const first = document.querySelector('#sidebar .nav-item.active') || document.querySelector('#sidebar .nav-item');
      if (first) setTimeout(() => first.focus({ preventScroll: true }), 60);
    }
  }
  function ensureDrawerBackdrop() {
    if (document.getElementById('drawer-backdrop')) return;
    const bd = el('div', { id: 'drawer-backdrop', 'aria-hidden': 'true' });
    bd.addEventListener('click', () => setDrawer(false));
    document.body.append(bd);
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !document.body.classList.contains('drawer-open')) return;
    if (document.querySelector('#modal-root .modal-backdrop:not(.is-closing)') || activePopover) return;
    setDrawer(false);
    const t = document.querySelector('#topbar .drawer-toggle');
    if (t) t.focus();
  });
  try {
    const mqWide = window.matchMedia('(min-width: 768px)');
    const onMq = () => { if (mqWide.matches) setDrawer(false); };
    if (mqWide.addEventListener) mqWide.addEventListener('change', onMq);
    else if (mqWide.addListener) mqWide.addListener(onMq);
  } catch (_e) { /* old browser */ }

  async function logout() {
    /* body:{} so the POST carries the JSON content-type the server requires */
    try { await SW.api('/api/logout', { method: 'POST', body: {}, toast: false }); } catch (_e) { /* ignore */ }
    SW.live.stop();
    SW.state.me = null;
    SW.state.overview = null;
    SW.adminCalls.reset();
    clearToasts();
    setDrawer(false);
    document.body.classList.add('chrome-hidden');
    SW.navigate('#/login');
  }
  SW.logout = logout;

  function syncThemeBtn() {
    const b = document.getElementById('tb-theme');
    if (!b) return;
    const toLight = SW.theme.current() === 'dark'; /* the icon/label name the TARGET theme */
    b.innerHTML = SW.icon(toLight ? 'sun' : 'moon');
    b.setAttribute('aria-label', toLight ? 'Switch to light theme' : 'Switch to dark theme');
    b.title = toLight ? 'Light theme' : 'Dark theme';
  }
  window.addEventListener('sw:theme', syncThemeBtn);

  function initialOf(name) {
    const m = String(name || '').match(/[A-Za-z0-9]/);
    return m ? m[0].toUpperCase() : '?';
  }

  /* ------------------------------------------------ admin-call surfaces
   * soundToggle(): the per-browser mute switch (bell inbox + dashboard).
   * callRow(call, {plainName}): one call — caller, when, message, Handle;
   * plainName links the name to the profile instead of the player menu
   * (inside a popover, whose anchor the menu would lose). */
  function syncSoundToggle(b) {
    const muted = SW.sound.muted();
    b.innerHTML = SW.icon(muted ? 'volume-x' : 'volume');
    b.title = muted ? 'Alert sound is off — turn it on' : 'Alert sound is on — mute it';
    b.setAttribute('aria-pressed', muted ? 'true' : 'false');
    b.classList.toggle('is-muted', muted);
  }
  function soundToggle() {
    const b = el('button', { type: 'button', class: 'icon-btn sound-toggle', 'aria-label': 'Mute alert sound' });
    syncSoundToggle(b);
    b.addEventListener('click', (e) => { e.stopPropagation(); SW.sound.toggle(); });
    return b;
  }
  /* one listener for every toggle on the page: a listener per button would
   * keep each detached page alive until the next mute change */
  window.addEventListener('sw:sound', () => {
    for (const b of Array.from(document.querySelectorAll('.sound-toggle'))) syncSoundToggle(b);
  });

  function handlerText(c) {
    if (c.handledByName) return String(c.handledByName);
    const me = SW.state.me;
    if (me && c.handledBy != null && String(c.handledBy) === String(me.id)) return 'you';
    if (typeof c.handledBy === 'string' && c.handledBy) return c.handledBy;
    return 'an admin';
  }
  function callRow(c, o) {
    o = o || {};
    const done = c.status === 'handled';
    const row = el('div', { class: 'call-row' + (done ? ' is-handled' : ''), dataset: { id: String(c.id) } });
    row.append(el('span', { class: 'call-ic', html: SW.icon(done ? 'check' : 'bell'), 'aria-hidden': 'true' }));
    const body = el('div', { class: 'call-body' });
    const top = el('div', { class: 'call-top' });
    const ref = { dbId: c.playerDbId, name: c.playerName, eosId: c.eosId, steamId: c.steamId };
    if (!o.plainName && c.playerDbId != null) top.append(SW.ui.playerLink(ref, { class: 'call-name truncate' }));
    else if (c.playerDbId != null) {
      top.append(el('a', {
        class: 'call-name truncate', href: '#/players/' + encodeURIComponent(c.playerDbId),
        text: c.playerName, title: 'Open the profile of ' + c.playerName,
      }));
    } else top.append(el('span', { class: 'call-name truncate', text: c.playerName, title: c.playerName }));
    const when = SW.ui.timeAgo(c.time);
    when.classList.add('call-time');
    top.append(when);
    body.append(top);
    const msg = c.message ? c.message : 'No message';
    body.append(el('div', { class: 'call-msg' + (c.message ? '' : ' is-empty'), text: msg, title: c.message || null }));
    if (done) {
      body.append(el('div', {
        class: 'call-handled',
        text: 'Handled by ' + handlerText(c) + (c.handledAt ? ' · ' + SW.ui.timeAgoText(c.handledAt) : ''),
      }));
    }
    row.append(body);
    if (!done) {
      const b = el('button', {
        type: 'button', class: 'btn ghost small call-handle', title: 'Mark this call as handled',
        html: SW.icon('check') + '<span>Handle</span>',
      });
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        b.disabled = true;
        if (!(await SW.adminCalls.handle(c.id))) b.disabled = false;
      });
      row.append(b);
    }
    return row;
  }

  function callsEmpty(compact) {
    if (SW.adminCalls.status() === 'error') {
      return SW.ui.empty('Could not load admin calls', 'wifi-off', {
        compact, hint: 'New calls still arrive live.',
        action: { label: 'Try again', icon: 'refresh', onClick: () => SW.adminCalls.load() },
      });
    }
    return SW.ui.empty('No open admin calls', 'bell', { compact, hint: 'Players reach you from game chat — for example by typing !admin.' });
  }

  /* the bell's inbox: open calls, newest first, live while it is open */
  function openCallsPanel(anchor) {
    const content = el('div', { class: 'calls-pop' });
    const n = el('span', { class: 'calls-pop-n tabular' });
    content.append(el('div', { class: 'calls-pop-head' },
      el('span', { class: 'calls-pop-title', text: 'Admin calls' }), n, soundToggle()));
    const listBox = el('div', { class: 'calls-pop-list' });
    content.append(listBox);
    function draw(info) {
      const rows = SW.adminCalls.list();
      const c = SW.adminCalls.count();
      n.textContent = c ? c + ' open' : '';
      listBox.textContent = '';
      if (!rows.length) {
        if (SW.adminCalls.status() === 'loading') listBox.append(el('div', { class: 'calls-skel' }, SW.ui.skeleton('line'), SW.ui.skeleton('line')));
        else listBox.append(callsEmpty(true));
        return;
      }
      for (const call of rows) {
        const row = callRow(call, { plainName: true });
        if (info && info.ring && info.call && info.call.id === call.id) SW.ui.flashIn(row);
        listBox.append(row);
      }
    }
    draw();
    const pop = SW.ui.panelPopover(anchor, content, { align: 'end', class: 'calls-pop-wrap', label: 'Admin calls' });
    if (!pop) return;
    const off = SW.adminCalls.on((info) => {
      if (!pop.isConnected) { off(); return; }
      draw(info);
    });
    if (SW.adminCalls.status() === 'error') SW.adminCalls.load();
  }

  function bellButton() {
    const b = el('button', {
      type: 'button', class: 'icon-btn tb-bell', id: 'tb-bell', 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      html: SW.icon('bell'),
    });
    b.append(el('span', { class: 'tb-bell-n tabular hidden', 'aria-hidden': 'true' }));
    b.addEventListener('click', (e) => { e.stopPropagation(); openCallsPanel(b); });
    b.addEventListener('animationend', () => b.classList.remove('ring'));
    syncBell(b, false);
    return b;
  }
  function syncBell(b, ring) {
    b = b || document.getElementById('tb-bell');
    syncTitleBadge();
    if (!b) return;
    b.classList.toggle('hidden', SW.adminCalls.status() === 'unavailable');
    const n = SW.adminCalls.count();
    const badge = b.querySelector('.tb-bell-n');
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.classList.toggle('hidden', !n);
    }
    b.classList.toggle('has-open', n > 0);
    const label = n ? 'Admin calls — ' + n + ' open' : 'Admin calls';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (ring && !reducedMotion()) {
      b.classList.remove('ring');
      void b.offsetWidth; /* restart the ring */
      b.classList.add('ring');
    }
  }
  /* "(2) Dashboard · A3 Admin" while calls wait — visible from other tabs */
  function syncTitleBadge() {
    const base = document.title.replace(/^\(\d+\+?\) /, '');
    const n = SW.state.me && SW.adminCalls.can() ? SW.adminCalls.count() : 0;
    const next = n ? '(' + (n > 99 ? '99+' : n) + ') ' + base : base;
    if (document.title !== next) document.title = next;
  }
  SW.adminCalls.on((info) => syncBell(null, !!(info && info.ring)));

  function renderShell() {
    const sb = document.getElementById('sidebar');
    const tb = document.getElementById('topbar');
    if (!sb || !tb) return;
    sb.textContent = '';
    tb.textContent = '';
    document.body.classList.remove('chrome-hidden');
    document.body.classList.toggle('sb-collapsed', !!SW.prefs.get('sidebar', false));
    initConnBanner();
    ensureDrawerBackdrop();

    /* ---- sidebar: brand lockup (mark + ADMIN) */
    const head = el('div', { class: 'sb-head' });
    const brand = el('a', { class: 'brand', href: '#/dashboard', title: BRAND });
    brand.innerHTML = markImg(30) + '<span class="brand-word">ADMIN</span>';
    head.append(brand);
    const sbClose = el('button', { type: 'button', class: 'icon-btn sb-close', html: SW.icon('x'), 'aria-label': 'Close menu', title: 'Close menu' });
    sbClose.addEventListener('click', () => setDrawer(false));
    head.append(sbClose);
    sb.append(head);

    /* ---- nav sections */
    const nav = el('nav', { class: 'nav', 'aria-label': 'Sections' });
    for (const g of NAV) {
      const items = g.items.filter((it) => !it.perm || SW.canAny(it.perm));
      if (!items.length) continue;
      const grp = el('div', { class: 'nav-group', role: 'group', 'aria-label': g.group });
      grp.append(el('div', { class: 'nav-sep', text: g.group, 'aria-hidden': 'true' }));
      for (const item of items) {
        const a = el('a', { class: 'nav-item', href: '#/' + item.route, dataset: { route: item.route }, title: item.label });
        a.innerHTML = SW.icon(item.icon) + '<span class="nav-label"></span>';
        a.querySelector('.nav-label').textContent = item.label;
        grp.append(a);
      }
      nav.append(grp);
    }
    nav.addEventListener('click', (e) => { if (e.target.closest('.nav-item')) setDrawer(false); });
    sb.append(nav);

    /* ---- foot: rail toggle + version */
    const foot = el('div', { class: 'sb-foot' });
    const coll = el('button', { type: 'button', class: 'icon-btn sb-collapse' });
    const syncColl = () => {
      const c = document.body.classList.contains('sb-collapsed');
      coll.innerHTML = SW.icon(c ? 'chevrons-right' : 'chevrons-left') + '<span class="nav-label">' + (c ? 'Expand' : 'Collapse') + '</span>';
      coll.title = c ? 'Expand sidebar' : 'Collapse sidebar';
      coll.setAttribute('aria-label', coll.title);
      coll.setAttribute('aria-pressed', c ? 'true' : 'false');
    };
    syncColl();
    coll.addEventListener('click', () => {
      document.body.classList.toggle('sb-collapsed');
      SW.prefs.set('sidebar', document.body.classList.contains('sb-collapsed'));
      syncColl();
      window.dispatchEvent(new Event('resize')); /* canvases re-measure */
    });
    foot.append(coll);
    const ver = SW.state.bootstrap && SW.state.bootstrap.version;
    if (ver) {
      const v = 'v' + String(ver).replace(/^v/i, '');
      foot.append(el('span', { class: 'sb-version mono truncate', text: v, title: BRAND + ' ' + v }));
    }
    sb.append(foot);

    /* ---- topbar: [drawer toggle][mark] server identity · status chips · actions */
    const toggle = el('button', {
      type: 'button', class: 'icon-btn drawer-toggle', html: SW.icon('menu'),
      'aria-label': 'Open menu', 'aria-controls': 'sidebar', 'aria-expanded': 'false', title: 'Menu',
    });
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setDrawer(!document.body.classList.contains('drawer-open'));
    });
    const mark = el('a', { class: 'tb-mark', href: '#/dashboard', title: BRAND, html: markImg(26) });

    const ident = el('div', { class: 'tb-ident', id: 'tb-ident' });
    ident.append(el('span', { class: 'live-dot', id: 'tb-live', 'aria-hidden': 'true' }));
    ident.append(el('span', { class: 'tb-server truncate', id: 'tb-servername', text: BRAND }));

    const chips = el('div', { class: 'tb-chips', role: 'group', 'aria-label': 'Server status' });
    chips.innerHTML =
      '<div class="tb-layers">' +
        '<span class="tb-chip layer" id="tb-layer">' + SW.icon('map') + '<span class="tb-chip-v truncate">—</span></span>' +
        '<span class="tb-arrow" aria-hidden="true">' + SW.icon('chevron-right') + '</span>' +
        '<span class="tb-chip layer dimmed" id="tb-next"><span class="tb-chip-k">Next</span><span class="tb-chip-v truncate">—</span></span>' +
      '</div>' +
      '<span class="tb-chip" id="tb-players" title="Players / max slots (+ queue)">' + SW.icon('users') +
        '<span class="tb-chip-v tabular">—</span><span class="tb-queue tabular hidden"></span></span>' +
      '<span class="tb-chip" id="tb-tick" title="Server tick rate">' + SW.icon('gauge') +
        '<span class="tb-chip-v tabular">—</span><span class="tb-unit">tps</span></span>' +
      '<span class="tb-chip" id="tb-clock" title="Match time">' + SW.icon('clock') +
        '<span class="tb-chip-v tabular">--:--</span></span>' +
      '<span class="tb-chip tb-status">' +
        '<span class="tb-dot" id="tb-dot-rcon" title="RCON"><span class="dot" id="dot-rcon"></span><span class="tb-dot-k">RCON</span></span>' +
        '<span class="tb-dot" id="tb-dot-log" title="Log source"><span class="dot" id="dot-log"></span><span class="tb-dot-k">LOG</span></span>' +
      '</span>';
    /* layer holders: the now/next pair opens the layer picker */
    const tbLayers = chips.querySelector('.tb-layers');
    if (tbLayers && SW.can('layer')) {
      tbLayers.classList.add('is-action');
      tbLayers.setAttribute('role', 'button');
      tbLayers.tabIndex = 0;
      const openPicker = (e) => { e.preventDefault(); SW.ui.openLayerPicker(); };
      tbLayers.addEventListener('click', openPicker);
      tbLayers.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openPicker(e); });
    }

    const actions = el('div', { class: 'tb-actions' });
    const themeBtn = el('button', { type: 'button', class: 'icon-btn theme-btn', id: 'tb-theme' });
    themeBtn.addEventListener('click', () => SW.theme.toggle());
    const me = SW.state.me || {};
    const um = el('button', { type: 'button', class: 'user-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false', title: me.username ? me.username + ' (' + (me.role || '') + ')' : null });
    um.append(el('span', { class: 'user-avatar', text: initialOf(me.username), 'aria-hidden': 'true' }));
    um.append(el('span', { class: 'user-name truncate', text: me.username || '' }));
    um.append(SW.ui.badge(me.role || '', 'role-badge' + (me.role === 'owner' ? ' gold' : ' dim')));
    um.insertAdjacentHTML('beforeend', SW.icon('chevron-down', 'user-chev'));
    um.addEventListener('click', (e) => {
      e.stopPropagation();
      const dark = SW.theme.current() === 'dark';
      const items = [
        { heading: me.username || 'Signed in', sub: me.role ? 'Role: ' + me.role : null },
        { label: dark ? 'Light theme' : 'Dark theme', icon: dark ? 'sun' : 'moon', onClick: () => SW.theme.toggle() },
      ];
      if (SW.canAny(['flags', 'warn', 'kick', 'ban'])) {
        const muted = SW.sound.muted();
        items.push({ label: muted ? 'Turn alert sound on' : 'Mute alert sound', icon: muted ? 'volume' : 'volume-x', onClick: () => SW.sound.toggle() });
      }
      items.push('-', { label: 'Sign out', icon: 'logout', onClick: logout });
      SW.ui.popover(um, items, { align: 'end' });
    });
    if (SW.adminCalls.can()) actions.append(bellButton());
    actions.append(themeBtn, um);
    tb.append(toggle, mark, ident, chips, actions);
    syncThemeBtn();

    updateTopbar();
    updateNavActive(parseHash().name || 'dashboard');
  }

  /* -------------------------------------------------------- topbar status */

  function setChip(id, text, title) {
    const chip = document.getElementById(id);
    if (!chip) return null;
    const v = chip.querySelector('.tb-chip-v');
    if (v) v.textContent = text;
    if (title != null) chip.title = title;
    return chip;
  }

  function updateTopbar() {
    const snap = SW.state.snapshot || {};
    const si = SW.state.serverInfo || snap.serverInfo || {};
    const st = SW.state.status || {};
    const name = si.serverName || (SW.state.bootstrap && SW.state.bootstrap.serverName) || BRAND;
    const sn = document.getElementById('tb-servername');
    if (sn) { sn.textContent = name; sn.title = name; }
    const cur = snap.currentLayer || si.mapName || '—';
    const nxt = snap.nextLayer || si.nextLayer || '—';
    const pick = SW.can('layer') ? ' — click to change' : '';
    setChip('tb-layer', cur, 'Current layer: ' + cur + pick);
    setChip('tb-next', nxt, 'Next layer: ' + nxt + pick);
    const queue = (Number(si.publicQueue) || 0) + (Number(si.reservedQueue) || 0);
    const pc = si.playerCount != null ? si.playerCount : '—';
    const mx = si.maxPlayers != null ? si.maxPlayers : '—';
    const pChip = setChip('tb-players', pc + '/' + mx, 'Players ' + pc + ' / ' + mx + (queue > 0 ? ' · ' + queue + ' in queue' : ''));
    if (pChip) {
      const q = pChip.querySelector('.tb-queue');
      if (q) { q.textContent = queue > 0 ? '+' + queue : ''; q.classList.toggle('hidden', !(queue > 0)); }
    }
    const tick = SW.state.tickRate != null ? SW.state.tickRate : snap.tickRate;
    const tChip = setChip('tb-tick', tick != null ? Number(tick).toFixed(0) : '—', tick != null
      ? 'Server tick rate: ' + Number(tick).toFixed(1) + ' tps'
      : (SW.logFeed.needs('Server tick rate') || 'Server tick rate — none reported in the game log yet'));
    if (tChip) {
      tChip.classList.toggle('bad', tick != null && tick < 20);
      tChip.classList.toggle('warnc', tick != null && tick >= 20 && tick < 30);
      tChip.classList.toggle('is-empty', tick == null);
    }
    syncClockChip();
    const rc = st.rcon || null;
    const lg = st.log || null;
    const rcState = !rc ? 'idle' : (rc.connected ? 'ok' : (rc.lastError ? 'bad' : 'idle'));
    const dr = document.getElementById('dot-rcon');
    if (dr) {
      dr.className = 'dot ' + rcState;
      const w = document.getElementById('tb-dot-rcon');
      if (w) w.title = 'RCON: ' + (!rc ? 'waiting for status' : (rc.connected ? 'connected' : (rc.lastError || 'not linked')));
    }
    const dl = document.getElementById('dot-log');
    if (dl) {
      dl.className = 'dot ' + (!lg ? 'idle' : (lg.ok ? 'ok' : 'bad'));
      const w = document.getElementById('tb-dot-log');
      if (w) w.title = 'Log source (' + ((lg && lg.mode) || '?') + '): ' + (!lg ? 'waiting for status' : (lg.ok ? 'ok' : (lg.error || 'down')));
    }
    /* live LED beside the server name: RCON health + (when streamed) SSE link */
    const led = document.getElementById('tb-live');
    if (led) {
      const streamed = SW.can('stream');
      let state = rcState;
      let label = 'RCON ' + (rcState === 'ok' ? 'connected' : (rcState === 'bad' ? 'down' : 'not linked'));
      if (rcState === 'ok' && streamed && !SW.live.up) { state = 'warn'; label += ' · live link reconnecting'; }
      else if (streamed && SW.live.up) label += ' · live';
      led.className = 'live-dot ' + state;
      const ident = document.getElementById('tb-ident');
      if (ident) ident.title = name + ' — ' + label;
    }
  }
  SW.updateTopbar = updateTopbar;

  /* topbar match clock — 1s sweep. The match start comes from the game log,
   * so an empty clock says why in its title. */
  function syncClockChip() {
    const chip = document.getElementById('tb-clock');
    if (!chip) return;
    const v = chip.querySelector('.tb-chip-v');
    if (!v) return;
    const m = SW.state.snapshot && SW.state.snapshot.match;
    const start = m && (m.inProgressAt || m.in_progress_at || m.startedAt || m.started_at);
    const running = !!(m && start && !(m.endedAt || m.ended_at));
    v.textContent = running ? SW.ui.fmtClock((Date.now() - Number(start)) / 1000) : '--:--';
    const title = running ? 'Match time'
      : (SW.logFeed.needs('Match time') || 'Match time — starts at the next map change the game log reports');
    if (chip.title !== title) chip.title = title;
    chip.classList.toggle('is-empty', !running);
  }
  setInterval(syncClockChip, 1000);

  /* overview fetch — concurrent callers share one in-flight request */
  let overviewInflight = null;
  function refreshOverview() {
    if (overviewInflight) return overviewInflight;
    overviewInflight = (async () => {
      try {
        const o = await SW.api('/api/overview', { toast: false });
        SW.state.overview = o;
        if (o && o.snapshot) SW.state.snapshot = o.snapshot;
        if (o && o.status) applyStatus(o.status);
        updateTopbar();
        return o;
      } catch (_e) {
        return null;
      } finally {
        overviewInflight = null;
      }
    })();
    return overviewInflight;
  }
  SW.refreshOverview = refreshOverview;

  /* ------------------------------------------------------------ auth flow */

  async function afterLogin() {
    SW.adminCalls.reset(); /* nothing carries over from an earlier session */
    renderShell();
    if (SW.can('stream')) SW.live.start(); // the server 403s /api/stream without it
    refreshOverview();
    SW.adminCalls.load();
    SW.navigate('#/dashboard');
  }

  /* centered .auth-card (.hud brackets) on the glow background:
   * big A3 mark + ADMIN wordmark + COMMUNITY caption, then title + form */
  let authSeq = 0;
  function authShell(main, o) {
    const wrap = el('div', { class: 'auth-wrap' });
    const card = el('div', { class: 'auth-card card hud' });
    const brand = el('div', { class: 'auth-brand' });
    brand.innerHTML = markImg(96, true);
    brand.append(el('div', { class: 'auth-word' }, el('span', { text: 'ADMIN' })));
    brand.append(el('div', { class: 'auth-caption' }, el('span', { text: 'COMMUNITY' })));
    card.append(brand);
    if (o.title) card.append(el('h1', { class: 'auth-title', text: o.title }));
    const sub = el('p', { class: 'auth-sub' });
    if (o.sub) sub.textContent = o.sub;
    card.append(sub);
    wrap.append(card);
    const ver = SW.state.bootstrap && SW.state.bootstrap.version;
    wrap.append(el('div', { class: 'auth-foot mono', text: BRAND + (ver ? ' · v' + String(ver).replace(/^v/i, '') : '') }));
    main.append(wrap);
    return { wrap, card, sub };
  }
  function authField(label, input, addon, hint) {
    const id = 'auth-' + (++authSeq);
    input.id = id;
    const f = el('div', { class: 'field auth-field' });
    f.append(el('label', { for: id, text: label }));
    if (addon) f.append(el('div', { class: 'input-group' }, input, addon));
    else f.append(input);
    if (hint) f.append(el('div', { class: 'hint', text: hint }));
    input.addEventListener('input', () => input.classList.remove('invalid'));
    return f;
  }
  function revealBtn(input) {
    const b = el('button', { type: 'button', class: 'input-addon', title: 'Show password', 'aria-label': 'Show password', html: SW.icon('eye') });
    b.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.innerHTML = SW.icon(show ? 'eye-off' : 'eye');
      b.title = show ? 'Hide password' : 'Show password';
      b.setAttribute('aria-label', b.title);
      input.focus();
    });
    return b;
  }
  function authError() {
    const box = el('div', { class: 'auth-err hidden', role: 'alert' });
    const txt = el('span', { class: 'auth-err-text' });
    box.append(el('span', { class: 'auth-err-icon', html: SW.icon('alert-circle') }), txt);
    return {
      el: box,
      show(msg) { txt.textContent = String(msg || ''); box.classList.remove('hidden'); },
      hide() { box.classList.add('hidden'); },
    };
  }
  function submitBtn(label) {
    const b = el('button', { class: 'btn primary wide auth-submit', type: 'submit' });
    const spin = el('span', { class: 'btn-spinner', 'aria-hidden': 'true' });
    const lab = el('span', { class: 'auth-submit-label', text: label });
    b.append(spin, lab);
    b.insertAdjacentHTML('beforeend', SW.icon('arrow-right', 'auth-submit-arrow'));
    b.busy = (on, busyText) => {
      b.disabled = !!on;
      b.classList.toggle('is-busy', !!on);
      lab.textContent = on ? (busyText || label) : label;
    };
    return b;
  }
  function shake(card) {
    card.classList.remove('shake');
    void card.offsetWidth; /* restart animation */
    card.classList.add('shake');
  }
  /* first empty required input -> error + focus; returns true when all set */
  function requireFilled(pairs, err, card) {
    for (const [input, msg] of pairs) {
      if (!String(input.value || '').trim()) {
        input.classList.add('invalid');
        err.show(msg);
        input.focus();
        shake(card);
        return false;
      }
    }
    return true;
  }

  /* LOGIN view (chrome hidden) */
  SW.routes.login = {
    label: 'Sign in',
    render(main) {
      const a = authShell(main, { title: 'Sign in', sub: 'Use your panel account to continue.' });
      const form = el('form', { class: 'auth-form', novalidate: true });
      const u = el('input', { class: 'input', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, placeholder: 'Your username' });
      const p = el('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true, placeholder: 'Your password' });
      const err = authError();
      const btn = submitBtn('Sign in');
      form.append(authField('Username', u), authField('Password', p, revealBtn(p)), err.el, btn);
      a.card.append(form);
      if (SW.state.bootstrap && SW.state.bootstrap.needsSetup) {
        const alt = el('div', { class: 'auth-alt' });
        alt.append('First run? ', el('a', { href: '#/setup', text: 'Create the owner account' }));
        a.card.append(alt);
      }
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.hide();
        if (!requireFilled([[u, 'Enter your username'], [p, 'Enter your password']], err, a.card)) return;
        btn.busy(true, 'Signing in…');
        try {
          const r = await SW.api('/api/login', {
            method: 'POST',
            body: { username: u.value.trim(), password: p.value },
            toast: false, on401: 'ignore',
          });
          SW.state.me = (r && r.user) || null;
          if (!SW.state.me) throw new Error('Login failed');
          await afterLogin();
        } catch (ex) {
          err.show(ex && ex.status === 429 ? 'Too many attempts — wait a few minutes, then try again' : ((ex && ex.message) || 'Login failed'));
          shake(a.card);
        } finally {
          btn.busy(false);
        }
      });
      setTimeout(() => u.focus(), 30);
    },
    cleanup() {},
  };

  /* SETUP view — first-run owner creation; setupToken per spec 19.3.15
   * (printed in the server console at boot — the operator types it in). */
  SW.routes.setup = {
    label: 'First-run setup',
    render(main) {
      const a = authShell(main, { title: 'Create the owner account', sub: 'First run — this account holds every permission.' });
      const form = el('form', { class: 'auth-form', novalidate: true });
      const u = el('input', { class: 'input', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, placeholder: 'Owner username' });
      const p1 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, placeholder: 'Choose a password' });
      const p2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, placeholder: 'Repeat the password' });
      const tok = el('input', { class: 'input mono', type: 'text', autocomplete: 'off', spellcheck: 'false', required: true, placeholder: 'Setup token' });
      // Demo mode serves the token via /api/bootstrap (§19.3.15) — prefill it
      // so trying the demo never requires console access.
      if (SW.state.bootstrap && SW.state.bootstrap.setupToken) tok.value = SW.state.bootstrap.setupToken;
      const err = authError();
      const btn = submitBtn('Create owner account');
      form.append(
        authField('Username', u),
        authField('Password', p1, revealBtn(p1)),
        authField('Repeat password', p2),
        authField('Setup token', tok, null, 'Printed in the server console at boot.'),
        err.el, btn
      );
      a.card.append(form);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.hide();
        if (!requireFilled([[u, 'Choose an owner username'], [p1, 'Choose a password'], [p2, 'Repeat the password'], [tok, 'Enter the setup token from the server console']], err, a.card)) return;
        if (p1.value !== p2.value) {
          p2.classList.add('invalid');
          err.show('Passwords do not match');
          p2.focus();
          shake(a.card);
          return;
        }
        btn.busy(true, 'Creating account…');
        try {
          await SW.api('/api/setup', {
            method: 'POST',
            body: { username: u.value.trim(), password: p1.value, setupToken: tok.value.trim() },
            toast: false, on401: 'ignore',
          });
          const r = await SW.api('/api/login', {
            method: 'POST',
            body: { username: u.value.trim(), password: p1.value },
            toast: false, on401: 'ignore',
          });
          SW.state.me = (r && r.user) || null;
          if (SW.state.bootstrap) SW.state.bootstrap.needsSetup = false;
          if (SW.state.me) await afterLogin();
          else SW.navigate('#/login');
        } catch (ex) {
          err.show((ex && ex.message) || 'Setup failed');
          shake(a.card);
        } finally {
          btn.busy(false);
        }
      });
      setTimeout(() => u.focus(), 30);
    },
    cleanup() {},
  };

  /* JOIN view — public invite-claim page at #/join/<token>
   * (docs/ROLES-INVITES-SETTINGS.md §2). Mirrors setup: whitelisted in
   * handleRoute/boot, chrome hidden, and POST /api/join sets the session
   * cookie so success drops straight into the panel like login does. */
  SW.routes.join = {
    label: 'Join',
    render(main, ctx) {
      const token = (ctx.args && ctx.args[0]) || '';
      const a = authShell(main, { title: 'Join the panel', sub: '' });
      const box = el('div', { class: 'auth-join' });
      a.card.append(box);

      function deadLink(msg) {
        box.textContent = '';
        a.sub.textContent = '';
        const dead = el('div', { class: 'auth-dead' });
        dead.append(el('span', { class: 'auth-dead-icon', html: SW.icon('alert-circle') }));
        dead.append(el('p', {
          class: 'auth-note',
          text: msg || 'This invite link is no longer valid — it may have been used, revoked or expired. Ask the person who invited you for a fresh one.',
        }));
        box.append(dead);
        const alt = el('div', { class: 'auth-alt' });
        alt.append(el('a', { href: '#/login', text: 'Go to sign in' }));
        box.append(alt);
      }

      if (!token) { deadLink('This invite link is incomplete — copy the full URL you were sent.'); return; }
      const checking = el('div', { class: 'auth-checking' });
      checking.append(el('span', { class: 'btn-spinner', 'aria-hidden': 'true' }), el('span', { text: 'Checking your invite…' }));
      box.append(checking);

      (async () => {
        let peek = null;
        try {
          peek = await SW.api('/api/join?token=' + encodeURIComponent(token), { toast: false, on401: 'ignore' });
        } catch (ex) {
          deadLink(ex && ex.status === 429
            ? 'Too many attempts from this address — wait a minute, then reload this page.'
            : 'Could not check this invite — is the panel server reachable?');
          return;
        }
        if (!peek || !peek.valid) { deadLink(); return; }
        box.textContent = '';
        a.sub.textContent = '';
        a.sub.append('You\'ve been invited to ');
        a.sub.append(el('b', { text: peek.serverName || BRAND }));
        a.sub.append(' as ');
        a.sub.append(el('b', { text: peek.roleName || 'a member' }));
        a.sub.append('. Pick a username and password to join.');
        const form = el('form', { class: 'auth-form', novalidate: true });
        const u = el('input', { class: 'input', type: 'text', autocomplete: 'username', autocapitalize: 'none', spellcheck: 'false', required: true, placeholder: 'Choose a username' });
        const p1 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, placeholder: 'Choose a password' });
        const p2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', required: true, placeholder: 'Repeat the password' });
        const err = authError();
        const btn = submitBtn('Create account & join');
        form.append(authField('Username', u), authField('Password', p1, revealBtn(p1)), authField('Repeat password', p2), err.el, btn);
        box.append(form);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          err.hide();
          if (!requireFilled([[u, 'Choose a username'], [p1, 'Choose a password'], [p2, 'Repeat the password']], err, a.card)) return;
          if (p1.value !== p2.value) {
            p2.classList.add('invalid');
            err.show('Passwords do not match');
            p2.focus();
            shake(a.card);
            return;
          }
          btn.busy(true, 'Joining…');
          try {
            const r = await SW.api('/api/join', {
              method: 'POST',
              body: { token, username: u.value.trim(), password: p1.value },
              toast: false, on401: 'ignore',
            });
            SW.state.me = (r && r.user) || null;
            if (!SW.state.me) throw new Error('Join failed');
            await afterLogin();
          } catch (ex) {
            err.show(ex && ex.status === 429 ? 'Too many attempts — wait a few minutes, then try again' : ((ex && ex.message) || 'Join failed'));
            shake(a.card);
          } finally {
            btn.busy(false);
          }
        });
        setTimeout(() => u.focus(), 30);
      })();
    },
    cleanup() {},
  };

  /* --------------------------------------------------------- dashboard view */

  /* "Narva_RAAS_v1" -> {map:'Narva', mode:'RAAS v1', pretty:'Narva RAAS v1'};
   * the raw layer name always stays available as a title. */
  const LAYER_MODES = new Set(['aas', 'raas', 'invasion', 'insurgency', 'skirmish', 'tc', 'seed',
    'destruction', 'training', 'tanks', 'trackattack', 'track']);
  function parseLayer(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s || s === '—') return null;
    const parts = s.split(/[_\s]+/).filter(Boolean);
    let idx = -1;
    for (let i = 1; i < parts.length; i++) {
      if (LAYER_MODES.has(parts[i].toLowerCase())) { idx = i; break; }
    }
    if (idx > 0) {
      const map = parts.slice(0, idx).join(' ');
      const mode = parts.slice(idx).join(' ');
      return { map, mode, pretty: map + ' ' + mode };
    }
    const pretty = parts.join(' ');
    return { map: pretty, mode: '', pretty };
  }

  function hhmm(t) {
    const d = new Date(Number(t));
    const h = d.getHours();
    const m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function niceScale(maxV) {
    const steps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2500, 5000];
    let step = steps[steps.length - 1];
    for (const s of steps) { if (maxV / s <= 4) { step = s; break; } }
    return { step, top: Math.max(step * 2, Math.ceil(maxV / step) * step) };
  }

  /* drop samples older than 24h (relative to the newest sample, so client
   * clock skew never prunes good data) */
  function prunePop(arr) {
    if (!arr || !arr.length) return;
    const cutoff = Number(arr[arr.length - 1][0]) - 24 * 3600 * 1000;
    let i = 0;
    while (i < arr.length && Number(arr[i][0]) < cutoff) i++;
    if (i > 0) arr.splice(0, i);
  }

  /* Population chart: players area + line, dashed queue line, nice y-scale,
   * hover crosshair with a tooltip. Every draw re-reads the theme tokens, so
   * it follows theme switches; a ResizeObserver keeps it crisp when the
   * sidebar collapses. samples: [[t, players, queue, tickRate], ...] */
  function popChart(plot, onSummary) {
    const canvas = el('canvas', { class: 'pop-chart', role: 'img', 'aria-label': 'Players and queue over the last 24 hours' });
    const tip = el('div', { class: 'chart-tip', 'aria-hidden': 'true' });
    const skel = el('div', { class: 'skeleton block chart-skel', 'aria-hidden': 'true' });
    const emptyBox = SW.ui.empty('No population samples yet', 'trending-up', {
      compact: true, hint: 'A sample is recorded every few minutes while the server runs',
    });
    emptyBox.classList.add('chart-empty', 'hidden');
    plot.append(canvas, tip, skel, emptyBox);
    let data = null; /* null = still loading */
    let hover = -1;
    let geo = null;
    let raf = 0;
    let dead = false;

    function schedule() {
      if (raf || dead) return;
      raf = requestAnimationFrame(() => { raf = 0; draw(); });
    }
    function chartDot(ctx, x, y, fill, ring, r) {
      ctx.beginPath(); ctx.arc(x, y, r + 2, 0, Math.PI * 2); ctx.fillStyle = ring; ctx.fill();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = fill; ctx.fill();
    }
    function tipRow(cls, label, v) {
      return el('div', { class: 'chart-tip-row' },
        el('i', { class: 'lg-dot ' + cls }),
        el('span', { text: label }),
        el('b', { class: 'tabular', text: String(Number(v) || 0) }));
    }
    function showTip(s, x) {
      tip.textContent = '';
      tip.append(el('div', { class: 'chart-tip-time mono', text: hhmm(s[0]) }));
      tip.append(tipRow('players', 'Players', s[1]));
      tip.append(tipRow('queue', 'Queue', s[2]));
      tip.classList.add('show');
      const tw = tip.offsetWidth || 120;
      let left = x + 14;
      if (left + tw > geo.w - 4) left = x - 14 - tw;
      tip.style.transform = 'translate(' + Math.round(Math.max(4, left)) + 'px, 6px)';
    }
    function draw() {
      if (dead) return;
      const w = Math.max(40, Math.round(plot.clientWidth));
      const h = Math.max(40, Math.round(plot.clientHeight));
      const loading = data == null;
      const rows = data || [];
      const empty = !loading && rows.length < 2;
      skel.classList.toggle('hidden', !loading);
      emptyBox.classList.toggle('hidden', !empty);
      canvas.classList.toggle('hidden', loading || empty);
      if (loading || empty) { geo = null; tip.classList.remove('show'); return; }
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      /* theme tokens, re-read on every draw */
      const cLabel = SW.ui.cssVar('--chart-label', '#5C6878');
      const cGrid = SW.ui.cssVar('--chart-grid', 'rgba(148,170,196,.08)');
      const cQueue = SW.ui.cssVar('--chart-queue', 'rgba(227,189,34,.75)');
      const cLine = SW.ui.cssVar('--chart-line', '#5AB0FF');
      const cFill = SW.ui.cssVar('--chart-fill', 'rgba(90,176,255,.14)');
      const cCross = SW.ui.cssVar('--line-strong', 'rgba(148,170,196,.2)');
      const cRing = SW.ui.cssVar('--panel', '#10151B');
      const mono = SW.ui.cssVar('--mono', 'monospace');

      const padL = 2;
      const padR = 34;
      const padT = 10;
      const padB = 22;
      const plotW = Math.max(10, w - padL - padR);
      const plotH = Math.max(10, h - padT - padB);
      const t0 = Number(rows[0][0]);
      const t1 = Number(rows[rows.length - 1][0]);
      const span = Math.max(1, t1 - t0);
      let maxV = 0;
      for (const s of rows) maxV = Math.max(maxV, Number(s[1]) || 0, Number(s[2]) || 0);
      const scale = niceScale(maxV);
      const X = (t) => padL + ((Number(t) - t0) / span) * plotW;
      const Y = (v) => padT + (1 - Math.min(scale.top, Math.max(0, Number(v) || 0)) / scale.top) * plotH;
      const base = padT + plotH;

      /* players area, faded toward the baseline */
      ctx.beginPath();
      ctx.moveTo(X(rows[0][0]), base);
      for (const s of rows) ctx.lineTo(X(s[0]), Y(s[1]));
      ctx.lineTo(X(rows[rows.length - 1][0]), base);
      ctx.closePath();
      ctx.fillStyle = cFill;
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      const fade = ctx.createLinearGradient(0, padT, 0, base);
      fade.addColorStop(0, 'rgba(0,0,0,0)');
      fade.addColorStop(1, 'rgba(0,0,0,0.85)');
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();

      /* grid + y labels */
      ctx.font = '500 10px ' + mono;
      ctx.lineWidth = 1;
      ctx.strokeStyle = cGrid;
      ctx.fillStyle = cLabel;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.setLineDash([2, 4]);
      for (let v = 0; v <= scale.top + 0.001; v += scale.step) {
        const y = Math.round(Y(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
        ctx.fillText(String(v), padL + plotW + 8, y);
      }
      ctx.setLineDash([]);
      /* x labels */
      ctx.textBaseline = 'alphabetic';
      const n = plotW < 360 ? 3 : 5;
      for (let i = 0; i < n; i++) {
        const t = t0 + (span * i) / (n - 1);
        ctx.textAlign = i === 0 ? 'left' : (i === n - 1 ? 'right' : 'center');
        ctx.fillText(hhmm(t), X(t), h - 6);
      }
      /* queue — dashed brand-gold line */
      ctx.beginPath();
      rows.forEach((s, i) => { const x = X(s[0]); const y = Y(s[2]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.strokeStyle = cQueue;
      ctx.lineWidth = 1.25;
      ctx.lineJoin = 'round';
      ctx.setLineDash([4, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
      /* players — main line */
      ctx.beginPath();
      rows.forEach((s, i) => { const x = X(s[0]); const y = Y(s[1]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.strokeStyle = cLine;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
      const last = rows[rows.length - 1];
      chartDot(ctx, X(last[0]), Y(last[1]), cLine, cRing, 3);

      geo = { t0, span, padL, plotW, rows, w };
      if (hover >= 0 && hover < rows.length) {
        const s = rows[hover];
        const x = Math.round(X(s[0])) + 0.5;
        ctx.strokeStyle = cCross;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, base); ctx.stroke();
        chartDot(ctx, x, Y(s[2]), cQueue, cRing, 2.5);
        chartDot(ctx, x, Y(s[1]), cLine, cRing, 3.5);
        showTip(s, x);
      } else {
        tip.classList.remove('show');
      }
    }
    function summarize() {
      const rows = data || [];
      if (!onSummary) return;
      if (!rows.length) { onSummary(null); return; }
      let peak = 0;
      let sum = 0;
      for (const s of rows) { const v = Number(s[1]) || 0; peak = Math.max(peak, v); sum += v; }
      onSummary({ now: Number(rows[rows.length - 1][1]) || 0, peak, avg: Math.round(sum / rows.length) });
    }
    function onMove(e) {
      if (!geo) return;
      const r = canvas.getBoundingClientRect();
      const t = geo.t0 + ((e.clientX - r.left - geo.padL) / geo.plotW) * geo.span;
      const rows = geo.rows;
      let lo = 0;
      let hi = rows.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (Number(rows[mid][0]) < t) lo = mid; else hi = mid;
      }
      const idx = Math.abs(Number(rows[lo][0]) - t) <= Math.abs(Number(rows[hi][0]) - t) ? lo : hi;
      if (idx !== hover) { hover = idx; schedule(); }
    }
    function onLeave() { if (hover !== -1) { hover = -1; schedule(); } }
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    let ro = null;
    if (typeof ResizeObserver === 'function') { ro = new ResizeObserver(() => schedule()); ro.observe(plot); }
    const onWin = () => schedule();
    window.addEventListener('resize', onWin);
    window.addEventListener('sw:theme', onWin);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => schedule()).catch(() => {});
    schedule();
    return {
      set(samples) { data = Array.isArray(samples) ? samples : []; hover = -1; summarize(); schedule(); },
      redraw: schedule,
      destroy() {
        dead = true;
        if (raf) cancelAnimationFrame(raf);
        if (ro) ro.disconnect();
        window.removeEventListener('resize', onWin);
        window.removeEventListener('sw:theme', onWin);
      },
    };
  }

  /* skeleton feed row (first fetch in flight) */
  function skelRow(i) {
    const r = el('div', { class: 'feed-row ui-row feed-skel', 'aria-hidden': 'true' });
    r.append(SW.ui.skeleton('line'), SW.ui.skeleton('line'));
    r.append(SW.ui.skeleton('line', (34 + ((i * 29) % 46)) + '%'));
    return r;
  }

  /* dashboard panel: a card with a header row (signal-ticked .card-title on
   * the left, tools on the right, hairline below) and a body */
  function dashPanel(title, cls) {
    const card = el('section', { class: 'card dash-panel' + (cls ? ' ' + cls : '') });
    const head = el('div', { class: 'dash-panel-head' });
    const t = el('h2', { class: 'card-title' });
    t.append(el('span', { class: 'truncate', text: title }));
    const tools = el('div', { class: 'dash-panel-tools' });
    head.append(t, tools);
    const body = el('div', { class: 'dash-panel-body' });
    card.append(head, body);
    return { card, title: t, tools, body };
  }

  /* a dashboard feed panel: pause toggle (persisted), fixed-height scrolling
   * list. Backfill via fill(); live rows via push() (flash-in). o.logFed
   * (the subject, e.g. 'Kills and teamkills') marks a feed only the game
   * log fills: while that feed is missing its empty state says so, and
   * reword() swaps the copy when the log state changes. */
  function feedCard(o) {
    let paused = !!SW.prefs.get('feed-paused:' + o.key, false);
    const p = dashPanel(o.title, 'feed-card');
    const card = p.card;
    const pausedTag = SW.ui.badge('Paused', 'amber feed-paused');
    p.title.append(pausedTag);
    const btn = el('button', { type: 'button', class: 'icon-btn feed-pause' });
    function sync() {
      btn.innerHTML = SW.icon(paused ? 'play' : 'pause');
      btn.title = paused ? 'Resume feed' : 'Pause feed';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      btn.classList.toggle('active', paused);
      pausedTag.classList.toggle('hidden', !paused);
      card.classList.toggle('is-paused', paused);
    }
    sync();
    btn.addEventListener('click', () => {
      paused = !paused;
      SW.prefs.set('feed-paused:' + o.key, paused);
      sync();
    });
    p.tools.append(btn);
    const list = el('div', { class: 'feed dash-feed', role: 'log', 'aria-label': o.title });
    p.body.classList.add('flush');
    p.body.append(list);
    let skel = false;
    function emptyNode() {
      if (o.logFed && SW.logFeed.missing()) return SW.ui.logFeedEmpty({ what: o.logFed, compact: true });
      return SW.ui.empty(o.emptyText, o.icon, { compact: true, hint: o.emptyHint });
    }
    return {
      card,
      isPaused: () => paused,
      skeleton(n) {
        list.textContent = '';
        for (let i = 0; i < (n || 8); i++) list.append(skelRow(i));
        skel = true;
      },
      fill(rows) {
        skel = false;
        list.textContent = '';
        for (const r of rows) list.append(r);
        if (!rows.length) list.append(emptyNode());
      },
      reword() {
        const em = list.firstElementChild;
        if (em && list.children.length === 1 && em.classList.contains('empty') && !em.classList.contains('feed-fail')) {
          em.replaceWith(emptyNode());
        }
      },
      fail(msg) {
        skel = false;
        list.textContent = '';
        list.append(SW.ui.empty(msg, 'wifi-off', { compact: true, hint: 'New events will still appear here live', class: 'feed-fail' }));
      },
      push(row) {
        if (skel) { list.textContent = ''; skel = false; }
        const em = list.querySelector('.empty');
        if (em) em.remove();
        list.prepend(SW.ui.flashIn(row));
        while (list.children.length > 50) list.lastChild.remove();
      },
    };
  }

  let popCache = null; /* last /api/pop samples, so a revisit draws instantly */

  SW.routes.dashboard = {
    label: 'Dashboard',
    render(main) {
      const unsubs = [];
      const timers = [];
      let alive = true;
      let chart = null;
      this.cleanup = () => {
        alive = false;
        unsubs.forEach((u) => u());
        timers.forEach((t) => clearInterval(t));
        if (chart) chart.destroy();
      };

      const page = el('div', { class: 'view view-dashboard' });
      main.append(page);

      /* --- page head: "Overview" + server name; quick actions by perm --- */
      const actions = [];
      if (SW.can('broadcast')) {
        const b = el('button', { type: 'button', class: 'btn ghost', html: SW.icon('broadcast') + '<span>Broadcast</span>' });
        b.addEventListener('click', () => SW.actions.broadcast());
        actions.push(b);
      }
      if (SW.can('layer')) {
        const b = el('button', { type: 'button', class: 'btn', html: SW.icon('map') + '<span>Change layer</span>' });
        b.addEventListener('click', () => SW.ui.openLayerPicker());
        actions.push(b);
      }
      const head = SW.ui.pageHead({ title: 'Overview', sub: '', actions });
      page.append(head);
      function syncHead() {
        const si = SW.state.serverInfo || (SW.state.snapshot && SW.state.snapshot.serverInfo) || {};
        const nm = si.serverName || (SW.state.bootstrap && SW.state.bootstrap.serverName) || '';
        head.subEl.textContent = nm || 'No server reporting yet';
        head.subEl.title = nm;
      }

      /* --- "no server linked" hero (settings holders only, dismissable) ---
       * Unconfigured RCON reports connected:false with lastError:null — a real
       * outage always carries a lastError, so this only shows when unlinked. */
      const hero = el('section', { class: 'card hud link-hero hidden' });
      hero.append(el('span', { class: 'link-hero-icon', html: SW.icon('radio') }));
      const heroText = el('div', { class: 'link-hero-text' });
      heroText.append(el('h2', { class: 'link-hero-title', text: 'No Squad server linked yet' }));
      heroText.append(el('p', { class: 'link-hero-sub', text: 'Point ' + BRAND + ' at your server\'s RCON to bring this dashboard to life.' }));
      hero.append(heroText);
      const heroActions = el('div', { class: 'link-hero-actions' });
      heroActions.append(el('a', { class: 'btn primary', href: '#/settings', html: SW.icon('settings') + '<span>Open Settings</span>' }));
      const heroDismiss = el('button', { type: 'button', class: 'btn ghost', text: 'Dismiss' });
      heroDismiss.addEventListener('click', () => {
        SW.prefs.set('unlinked-dismissed', true);
        hero.classList.add('hidden');
      });
      heroActions.append(heroDismiss);
      hero.append(heroActions);
      page.append(hero);
      function syncLinkHero() {
        if (!SW.can('settings') || SW.prefs.get('unlinked-dismissed', false)) { hero.classList.add('hidden'); return; }
        const rc = (SW.state.status && SW.state.status.rcon) || null;
        const unlinked = !!rc && !rc.connected && rc.lastError == null;
        hero.classList.toggle('hidden', !unlinked);
      }

      /* --- stat tiles (6 -> 3 -> 2 columns, equal heights) --- */
      const haveSnap = !!(SW.state.snapshot || SW.state.serverInfo);
      const haveOv = !!SW.state.overview;
      const canLayer = SW.can('layer');
      const stats = el('div', { class: 'dash-stats' });
      const cPlayers = SW.ui.statCard({ icon: 'users', label: 'Players', loading: !haveSnap, meter: true, crossfade: true });
      const cLayer = SW.ui.statCard({
        icon: 'map', label: 'Layer', loading: !haveSnap, class: 'stat-layer',
        onClick: canLayer ? () => SW.ui.openLayerPicker() : null,
        title: canLayer ? 'Change layer' : null,
      });
      const cMatch = SW.ui.statCard({ icon: 'clock', label: 'Match time', value: '--:--' });
      const cFlags = SW.ui.statCard({ icon: 'flag', label: 'Open flags', loading: !haveOv, href: '#/trolls', crossfade: true });
      const cBans = SW.ui.statCard({ icon: 'ban', label: 'Active bans', loading: !haveOv, href: SW.can('ban') ? '#/bans' : null, crossfade: true });
      const cTks = SW.ui.statCard({ icon: 'skull', label: 'TKs today', loading: !haveOv, crossfade: true });
      stats.append(cPlayers, cLayer, cMatch, cFlags, cBans, cTks);
      page.append(stats);

      /* --- population chart + open flags --- */
      const mid = el('div', { class: 'dash-mid' });
      const cp = dashPanel('Population · 24h', 'dash-chart');
      const legend = el('div', { class: 'chart-legend' });
      legend.append(
        el('span', { class: 'lg' }, el('i', { class: 'lg-dot players' }), 'Players'),
        el('span', { class: 'lg' }, el('i', { class: 'lg-dot queue' }), 'Queue'));
      cp.tools.append(legend);
      const chartStats = el('div', { class: 'chart-stats' });
      const statBits = {};
      for (const k of ['Now', 'Peak', 'Avg']) {
        const v = el('b', { class: 'display tabular', text: '—' });
        chartStats.append(el('span', { class: 'chart-stat' }, el('span', { class: 'chart-stat-k', text: k }), v));
        statBits[k] = v;
      }
      const plot = el('div', { class: 'chart-plot' });
      cp.body.append(chartStats, plot);
      chart = popChart(plot, (sm) => {
        statBits.Now.textContent = sm ? String(sm.now) : '—';
        statBits.Peak.textContent = sm ? String(sm.peak) : '—';
        statBits.Avg.textContent = sm ? String(sm.avg) : '—';
      });

      const fp = dashPanel('Open flags', 'dash-flags');
      const flagsCount = el('span', { class: 'dash-count tabular hidden' });
      fp.title.append(flagsCount);
      const allLink = el('a', { class: 'card-link', href: '#/trolls' });
      allLink.append(el('span', { text: 'Review all' }));
      allLink.insertAdjacentHTML('beforeend', SW.icon('arrow-right'));
      fp.tools.append(allLink);
      const flagsList = el('div', { class: 'dash-flag-list' });
      fp.body.classList.add('flush');
      fp.body.append(flagsList);

      /* admin calls above the flags: the two things waiting on an admin */
      const side = el('div', { class: 'dash-side' });
      if (SW.adminCalls.can()) {
        const cc = dashPanel('Admin calls', 'dash-calls');
        const callsCount = el('span', { class: 'dash-count tabular hidden' });
        cc.title.append(callsCount);
        cc.tools.append(soundToggle());
        const callList = el('div', { class: 'call-list', role: 'list', 'aria-label': 'Admin calls' });
        cc.body.classList.add('flush');
        cc.body.append(callList);
        const drawCalls = (info) => {
          if (!alive) return;
          cc.card.classList.toggle('hidden', SW.adminCalls.status() === 'unavailable');
          const openRows = SW.adminCalls.list();
          const recentRows = SW.adminCalls.recent().slice(0, 3);
          const n = SW.adminCalls.count();
          callsCount.textContent = SW.ui.fmtNum(n);
          callsCount.classList.toggle('hidden', !n);
          cc.card.classList.toggle('has-open', n > 0);
          callList.textContent = '';
          /* no open calls listed: only a load that answered may call that all clear */
          const st = SW.adminCalls.status();
          if (!openRows.length) {
            if (st === 'loading' || st === 'idle') {
              for (let i = 0; i < 2; i++) {
                const r = el('div', { class: 'dash-flag is-skel', 'aria-hidden': 'true' });
                r.append(SW.ui.skeleton('line', 26), SW.ui.skeleton('line', (52 + i * 14) + '%'));
                callList.append(r);
              }
            } else if (st === 'error' || !recentRows.length) {
              callList.append(callsEmpty(true));
            } else {
              callList.append(el('div', { class: 'call-clear' },
                el('span', { class: 'call-clear-ic', html: SW.icon('check-circle'), 'aria-hidden': 'true' }),
                el('span', { text: 'No open calls — everything is handled' })));
            }
          }
          for (const c of openRows) {
            const row = callRow(c);
            if (info && info.ring && info.call && info.call.id === c.id) SW.ui.flashIn(row);
            callList.append(row);
          }
          if (recentRows.length) {
            callList.append(el('div', { class: 'call-sep', text: 'Recently handled' }));
            for (const c of recentRows) callList.append(callRow(c));
          }
        };
        unsubs.push(SW.adminCalls.on(drawCalls));
        drawCalls();
        const callsSt = SW.adminCalls.status();
        if (callsSt === 'idle' || callsSt === 'error') SW.adminCalls.load();
        SW.adminCalls.loadRecent();
        side.append(cc.card);
      }
      side.append(fp.card);
      mid.append(cp.card, side);
      page.append(mid);

      /* --- kill + chat feeds (2 columns, stack <1024px, equal heights) --- */
      const feeds = el('div', { class: 'dash-feeds' });
      const kills = feedCard({
        title: 'Kill feed', key: 'kills', icon: 'crosshair', emptyText: 'No kills yet',
        emptyHint: 'Kills stream in live while a match is running', logFed: 'Kills, teamkills and radio damage',
      });
      const chats = feedCard({ title: 'Chat feed', key: 'chat', icon: 'chat', emptyText: 'No chat yet', emptyHint: 'In-game chat appears here as it is said' });
      feeds.append(kills.card, chats.card);
      page.append(feeds);

      /* --- data --- */
      const FLAG_ROWS = 6;
      let flagsOpen = null;
      let flagsShown = null; /* the last flag list rendered (null until loaded) */
      let tksToday = null;

      function setFlagsCount(n) {
        flagsOpen = n;
        cFlags.set(SW.ui.fmtNum(n), n > 0 ? 'Awaiting review' : 'All clear');
        cFlags.classList.toggle('accent-warn', n > 0);
        flagsCount.textContent = SW.ui.fmtNum(n);
        flagsCount.classList.toggle('hidden', !(n > 0));
      }
      /* teamkills are counted from the game log: without it a 0 means nothing */
      function setTks(n) {
        tksToday = n;
        const need = SW.logFeed.needs('The teamkill count');
        cTks.set(SW.ui.fmtNum(n), need ? 'Needs the game log' : 'Since 00:00 UTC', { subTitle: need || 'Teamkills since 00:00 UTC' });
        cTks.classList.toggle('accent-red', n > 0);
      }
      /* a flag row opens the review inbox; the name keeps its player menu */
      function flagRow(f) {
        const r = el('div', { class: 'dash-flag', title: 'Open the review inbox' });
        r.append(SW.ui.sevBadge(f.severity));
        const body = el('div', { class: 'dash-flag-body' });
        body.append(SW.ui.playerLink(f.player || { name: (f.playerName || 'unknown'), dbId: f.playerId }));
        const type = SW.ui.flagLabel(f.type);
        body.append(el('span', { class: 'dash-flag-type truncate', text: type, title: type }));
        r.append(body);
        r.append(SW.ui.timeAgo(f.time));
        r.addEventListener('click', (e) => {
          if (e.target.closest('.plink, a, button')) return;
          SW.navigate('#/trolls');
        });
        return r;
      }
      function renderFlags(list) {
        flagsShown = list;
        flagsList.textContent = '';
        if (!list.length) {
          flagsList.append(SW.logFeed.missing()
            ? SW.ui.logFeedEmpty({ what: 'Teamkill streaks and friendly radio damage', compact: true })
            : SW.ui.empty('No open flags', 'shield', { compact: true, hint: 'Teamkill streaks, radio damage and other trouble land here' }));
          return;
        }
        for (const f of list.slice(0, FLAG_ROWS)) flagsList.append(flagRow(f));
      }
      function flagsSkeleton() {
        flagsList.textContent = '';
        for (let i = 0; i < 4; i++) {
          const r = el('div', { class: 'dash-flag is-skel', 'aria-hidden': 'true' });
          r.append(SW.ui.skeleton('line', 26), SW.ui.skeleton('line', (40 + i * 11) + '%'));
          flagsList.append(r);
        }
      }
      function pushFlag(f) {
        const em = flagsList.querySelector('.empty, .is-skel');
        if (em) flagsList.textContent = '';
        flagsShown = null;
        flagsList.prepend(SW.ui.flashIn(flagRow(f)));
        while (flagsList.children.length > FLAG_ROWS) flagsList.lastChild.remove();
        if (flagsOpen != null) setFlagsCount(flagsOpen + 1);
      }
      function applyOverview(o, first) {
        const counters = o.counters || {};
        setFlagsCount(Number(counters.flagsOpen) || 0);
        const bans = Number(counters.bansActive) || 0;
        cBans.set(SW.ui.fmtNum(bans), bans > 0 ? 'Currently enforced' : 'None active');
        setTks(Number(counters.tksToday) || 0);
        const recent = o.recent || {};
        if (first || !kills.isPaused()) kills.fill((recent.kills || []).slice(0, 50).map((k) => SW.ui.killRow(k)));
        if (first || !chats.isPaused()) chats.fill((recent.chat || []).slice(0, 50).map((c) => SW.ui.chatRow(c)));
        renderFlags(recent.flags || []);
      }
      function loadFailed() {
        kills.fail('Could not load recent kills');
        chats.fail('Could not load recent chat');
        flagsList.textContent = '';
        flagsList.append(SW.ui.empty('Could not load flags', 'wifi-off', { compact: true }));
        for (const c of [cFlags, cBans, cTks]) c.set('—', 'Unavailable');
      }

      function syncCards() {
        const snap = SW.state.snapshot;
        const si = SW.state.serverInfo || (snap && snap.serverInfo) || {};
        if (snap || SW.state.serverInfo) {
          const pc = si.playerCount;
          const mx = si.maxPlayers;
          const queue = (Number(si.publicQueue) || 0) + (Number(si.reservedQueue) || 0);
          cPlayers.set((pc != null ? pc : '—') + '/' + (mx != null ? mx : '—'), queue > 0 ? '+' + queue + ' in queue' : 'No queue');
          cPlayers.setMeter(pc != null && Number(mx) > 0 ? Number(pc) / Number(mx) : 0);
          const cur = (snap && snap.currentLayer) || si.mapName || '';
          const nxt = (snap && snap.nextLayer) || si.nextLayer || '';
          const lc = parseLayer(cur);
          const ln = parseLayer(nxt);
          const sub = (lc && lc.mode ? lc.mode + ' · ' : '') + 'Next: ' + (ln ? ln.pretty : '—');
          cLayer.set(lc ? lc.map : '—', sub, {
            title: cur ? 'Current layer: ' + cur : 'No layer reported',
            subTitle: 'Next layer: ' + (nxt || '—'),
          });
        }
        const tick = SW.state.tickRate != null ? SW.state.tickRate : (snap && snap.tickRate);
        const tickNeed = tick == null ? SW.logFeed.needs('The tick rate') : null;
        cMatch.set(undefined, tickNeed ? 'Needs the game log' : 'Tick ' + (tick != null ? Number(tick).toFixed(1) : '—') + ' tps',
          { subTitle: tickNeed || 'Server tick rate' });
        if (SW.state.tickHist.length > 1) {
          const tok = tick != null && tick < 20 ? '--red' : (tick != null && tick < 30 ? '--gold' : '--green');
          cMatch.setSpark(SW.state.tickHist, SW.ui.cssVar(tok, '#34D399'));
        }
        syncHead();
      }
      function tickClock() {
        const m = SW.state.snapshot && SW.state.snapshot.match;
        const start = m && (m.inProgressAt || m.in_progress_at || m.startedAt || m.started_at);
        if (start && !(m.endedAt || m.ended_at)) { cMatch.set(SW.ui.fmtClock((Date.now() - Number(start)) / 1000)); return; }
        cMatch.set('--:--', undefined, {
          title: SW.logFeed.needs('Match time') || 'Match time starts at the next map change the game log reports',
        });
      }

      async function loadPop() {
        try {
          const pop = await SW.api('/api/pop?hours=24', { toast: false });
          popCache = (pop && Array.isArray(pop.samples)) ? pop.samples : [];
        } catch (_e) {
          if (!popCache) popCache = [];
        }
        if (alive) chart.set(popCache);
      }

      /* first paint: cached overview when we have one (no skeleton flash on
       * revisits), skeletons otherwise; then refresh */
      let applied = false;
      if (SW.state.overview) { applyOverview(SW.state.overview, true); applied = true; }
      else { kills.skeleton(8); chats.skeleton(8); flagsSkeleton(); }
      syncCards();
      syncLinkHero();
      tickClock();
      if (popCache) chart.set(popCache);

      (async () => {
        const o = await refreshOverview();
        if (!alive) return;
        if (o) { applyOverview(o, !applied); applied = true; }
        else if (!applied) loadFailed();
        syncCards();
        syncLinkHero();
        await loadPop();
      })();

      timers.push(setInterval(tickClock, 1000));

      unsubs.push(SW.live.on('kill', (k) => {
        if (!k) return;
        if (k.teamkill && k.kind === 'wound' && tksToday != null) setTks(tksToday + 1);
        if (!kills.isPaused()) kills.push(SW.ui.killRow(k));
      }));
      unsubs.push(SW.live.on('chat', (c) => { if (c && !chats.isPaused()) chats.push(SW.ui.chatRow(c)); }));
      unsubs.push(SW.live.on('flag', (f) => { if (f) pushFlag(f); }));
      unsubs.push(SW.live.on('hello', syncCards));
      unsubs.push(SW.live.on('serverinfo', syncCards));
      unsubs.push(SW.live.on('players', syncCards));
      unsubs.push(SW.live.on('tick', syncCards));
      unsubs.push(SW.live.on('match', () => { syncCards(); tickClock(); }));
      unsubs.push(SW.live.on('status', () => { syncLinkHero(); syncCards(); }));
      /* the game log came up or went away: re-word everything it feeds */
      unsubs.push(SW.live.on('_logfeed', () => {
        if (!alive) return;
        kills.reword();
        if (flagsShown && !flagsShown.length) renderFlags(flagsShown);
        if (tksToday != null) setTks(tksToday);
        syncCards();
        tickClock();
      }));
      unsubs.push(SW.live.on('pop', (s) => {
        /* pop event: single sample {time, players, queue, tickRate} or array row */
        if (!s) return;
        const row = Array.isArray(s) ? s : [s.time, s.players, s.queue, s.tickRate];
        if (row[0] == null) return;
        if (!popCache) popCache = [];
        popCache.push(row);
        prunePop(popCache);
        chart.set(popCache);
      }));
      /* the stream recovered from a drop: events were missed — the overview
       * was just refetched, so repaint from it and refetch the samples */
      unsubs.push(SW.live.on('_resync', () => {
        if (!alive) return;
        if (SW.state.overview) { applyOverview(SW.state.overview, !applied); applied = true; }
        syncCards();
        syncLinkHero();
        loadPop();
      }));
    },
    cleanup() {},
  };

  /* -------------------------------------------------------------- live view
   * Stage-1 fallback only: views.js (loaded after this file) registers the
   * full Live page over this route. */

  function abbrevRole(role) {
    if (!role) return '';
    const parts = String(role).split('_').filter(Boolean);
    if (parts.length >= 2) return parts[1];
    return parts[0] || '';
  }

  SW.routes.live = {
    render(main) {
      const unsubs = [];
      let renderTimer = null;
      let lastRender = 0;
      this.cleanup = () => {
        unsubs.forEach((u) => u());
        if (renderTimer) clearTimeout(renderTimer);
      };

      const page = el('div', { class: 'view view-live' });
      main.append(page);

      /* admin topline: broadcast quick box + the layer picker — each tool
       * behind its own perm (§1) */
      if (SW.can('broadcast') || SW.can('layer')) {
        const tools = el('div', { class: 'card live-tools' });
        if (SW.can('broadcast')) {
          const bWrap = el('div', { class: 'tool-group grow' });
          const bInput = el('input', { class: 'input grow', placeholder: 'Broadcast message to all players…', maxlength: '480', 'aria-label': 'Broadcast message' });
          const bBtn = el('button', { type: 'button', class: 'btn primary', html: SW.icon('broadcast') + '<span>Send</span>' });
          const sendB = async () => {
            const msg = bInput.value.trim();
            if (!msg) return;
            bBtn.disabled = true;
            try { await SW.actions.broadcastSend(msg); bInput.value = ''; } catch (_e) { /* toasted */ }
            bBtn.disabled = false;
          };
          bBtn.addEventListener('click', sendB);
          bInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendB(); });
          bWrap.append(bInput, bBtn);
          tools.append(bWrap);
        }
        if (SW.can('layer')) {
          const lBtn = el('button', { type: 'button', class: 'btn', html: SW.icon('map') + '<span>Change layer</span>' });
          lBtn.addEventListener('click', () => SW.ui.openLayerPicker());
          tools.append(el('div', { class: 'tool-group' }, lBtn));
        }
        page.append(tools);
      }

      const rosterWrap = el('div', { class: 'live-grid' });
      const discWrap = el('div', { class: 'card disc-panel' });
      page.append(rosterWrap, discWrap);

      function playerRow(p) {
        const row = el('div', { class: 'player-row' });
        if (p.isLeader) row.append(el('span', { class: 'sl-star', html: SW.icon('star'), title: 'Squad leader' }));
        row.append(SW.ui.playerLink(p, { class: 'grow' }));
        const role = abbrevRole(p.role);
        if (role) row.append(el('span', { class: 'role-tag mono', text: role, title: String(p.role || '') }));
        const tks = Number(p.sessTks) || 0;
        const kd = el('span', { class: 'kd mono' + (tks > 0 ? ' has-tk' : '') });
        kd.innerHTML = '<i>K</i>' + (Number(p.sessKills) || 0) +
          ' <i>D</i>' + (Number(p.sessDeaths) || 0) +
          ' <i class="' + (tks > 0 ? 'tkc' : '') + '">TK</i>' + tks;
        row.append(kd);
        return row;
      }

      function squadCard(sq) {
        const c = el('div', { class: 'squad-card' });
        const head = el('div', { class: 'squad-head' });
        if (sq.squadId != null) head.append(el('span', { class: 'squad-id mono', text: String(sq.squadId) }));
        head.append(el('span', { class: 'squad-name', text: sq.name || 'Squad', title: sq.name || 'Squad' }));
        if (sq.locked) head.append(el('span', { class: 'squad-lock', html: SW.icon('lock'), title: 'Locked squad' }));
        const n = sq.players ? sq.players.length : (sq.size || 0);
        head.append(el('span', { class: 'squad-size dim', text: String(n) }));
        c.append(head);
        for (const p of sq.players || []) c.append(playerRow(p));
        return c;
      }

      function renderRoster() {
        rosterWrap.textContent = '';
        const snap = SW.state.snapshot;
        if (!snap || !snap.teams || !snap.teams.length) {
          rosterWrap.append(SW.ui.empty('No live roster yet — waiting for RCON ListPlayers', 'live'));
          renderDisc();
          return;
        }
        for (const team of snap.teams) {
          const col = el('div', { class: 'team-col team' + (team.teamId === 2 ? '2' : '1') });
          const count = (team.squads || []).reduce((n, s) => n + ((s.players && s.players.length) || 0), 0) + ((team.unassigned && team.unassigned.length) || 0);
          const head = el('div', { class: 'team-head' });
          head.append(el('span', { class: 'team-name', text: team.name || ('Team ' + team.teamId) }));
          head.append(el('span', { class: 'team-count dim', text: count + ' players' }));
          col.append(head);
          for (const sq of team.squads || []) col.append(squadCard(sq));
          if (team.unassigned && team.unassigned.length) {
            const u = el('div', { class: 'squad-card unassigned' });
            const uh = el('div', { class: 'squad-head' });
            uh.append(el('span', { class: 'squad-name dim', text: 'Unassigned' }));
            uh.append(el('span', { class: 'squad-size dim', text: String(team.unassigned.length) }));
            u.append(uh);
            for (const p of team.unassigned) u.append(playerRow(p));
            col.append(u);
          }
          rosterWrap.append(col);
        }
        renderDisc();
      }

      function renderDisc() {
        discWrap.textContent = '';
        discWrap.append(el('div', { class: 'card-title', text: 'Recently disconnected' }));
        const snap = SW.state.snapshot;
        const list = (snap && snap.recentlyDisconnected) || [];
        if (!list.length) {
          discWrap.append(el('div', { class: 'dim small pad-s', text: 'Nobody left recently' }));
          return;
        }
        for (const d of list) {
          const row = el('div', { class: 'disc-row' });
          row.append(SW.ui.playerLink(d, { class: 'grow' }));
          const since = d.sinceDisconnect || (d.disconnectedAt ? SW.ui.timeAgoText(d.disconnectedAt) : '');
          row.append(el('span', { class: 'dim small mono', text: since }));
          if (SW.can('ban')) {
            const b = el('button', { type: 'button', class: 'btn danger ghost small', text: 'Ban anyway' });
            b.addEventListener('click', () => SW.actions.ban(d));
            row.append(b);
          }
          discWrap.append(row);
        }
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

      unsubs.push(SW.live.on('players', () => scheduleRender()));
      unsubs.push(SW.live.on('serverinfo', () => scheduleRender()));
      unsubs.push(SW.live.on('match', () => scheduleRender()));
      unsubs.push(SW.live.on('connect', () => scheduleRender()));
      unsubs.push(SW.live.on('disconnect', () => scheduleRender()));
      unsubs.push(SW.live.on('_resync', () => scheduleRender()));
      unsubs.push(SW.live.on('kill', (k) => {
        if (!k || k.kind !== 'wound') return;
        if (k.attacker && !k.suicide) bump(k.attacker, 'sessKills');
        if (k.victim) bump(k.victim, 'sessDeaths');
        if (k.teamkill && k.attacker) bump(k.attacker, 'sessTks');
        scheduleRender();
      }));

      if (!SW.state.snapshot) refreshOverview().then(() => { lastRender = Date.now(); renderRoster(); });
      lastRender = Date.now();
      renderRoster();
    },
    cleanup() {},
  };

  /* ----------------------------------------------------------------- boot */

  async function boot() {
    try { SW.state.bootstrap = await SW.api('/api/bootstrap', { toast: false, on401: 'ignore' }); }
    catch (_e) { SW.state.bootstrap = {}; }
    try {
      const r = await SW.api('/api/me', { toast: false, on401: 'ignore' });
      SW.state.me = (r && r.user) || null;
    } catch (_e) { SW.state.me = null; }

    if (SW.state.me) {
      renderShell();
      if (SW.can('stream')) SW.live.start(); // no stream perm -> REST only
      refreshOverview();
      SW.adminCalls.load();
      handleRoute();
    } else {
      document.body.classList.add('chrome-hidden');
      const bs = SW.state.bootstrap || {};
      if (bs.needsSetup && !/^#\/(setup|join)/.test(location.hash)) location.hash = '#/setup';
      else if (!/^#\/(login|setup|join)/.test(location.hash)) location.hash = '#/login';
      handleRoute();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
