'use strict';
/* SquadWatch frontend core — app.js
 *
 * Establishes the single global namespace `window.SW` used by every stage:
 *   SW.esc(s)                 HTML-escape (use for any string placed in innerHTML)
 *   SW.api(path, opts)        fetch wrapper (401 -> login, errors -> toast + throw)
 *   SW.icon(name, cls)        inline SVG icon markup string
 *   SW.ui                     components (toast, modal, confirmModal, popover, table,
 *                             pager, statCard, badge, sevBadge, channelChip, timeAgo,
 *                             fmtDur, fmtClock, fmtTime, fmtNum, sparkline, playerLink,
 *                             playerPopover, copyBtn, killRow, chatRow, rconToast,
 *                             empty, section, el)
 *   SW.live                   SSE pubsub: on(evt, fn) -> unsub, start(), stop(), up
 *   SW.routes                 hash route name -> { render(el, ctx), cleanup(), perm? }
 *   SW.actions                admin actions (confirm modal + POST + rcon toast)
 *   SW.state                  { me, bootstrap, overview, snapshot, serverInfo, status,
 *                               tickRate, tickHist, layers }
 *   SW.prefs                  localStorage ('sw:' prefix) get/set/del
 *   SW.can(perm), SW.canAny(perms), SW.navigate(hash), SW.currentRouteName()
 *
 * CSP: script-src 'self' — NO inline scripts or on*= attributes anywhere.
 * Everything is wired via addEventListener / delegation from this file.
 */
(function () {
  const SW = (window.SW = window.SW || {});

  /* --------------------------------------------------------------- theme
   * Light is the default (no attribute). 'dark' sets data-theme="dark" on
   * <html>. Applied here, at script parse time, so the first render never
   * flashes the wrong theme. Persisted under the raw key 'sw_theme'.
   */
  SW.theme = {
    current() {
      return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    },
    set(t) {
      if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('sw_theme', t === 'dark' ? 'dark' : 'light'); } catch (_e) { /* storage blocked */ }
      /* canvases re-read their css tokens on every draw; nudge a redraw now */
      window.dispatchEvent(new Event('resize'));
    },
    toggle() { SW.theme.set(SW.theme.current() === 'dark' ? 'light' : 'dark'); },
  };
  (function applyStoredTheme() {
    let t = null;
    try { t = localStorage.getItem('sw_theme'); } catch (_e) { t = null; }
    if (t === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    else document.documentElement.removeAttribute('data-theme');
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
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
    'chevron-up': '<polyline points="6 15 12 9 18 15"/>',
    'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
    'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    broadcast: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    map: '<polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21"/><line x1="9" y1="3" x2="9" y2="18"/><line x1="15" y1="6" x2="15" y2="21"/>',
    play: '<polygon points="6 4 20 12 6 20"/>',
    pause: '<line x1="9" y1="5" x2="9" y2="19"/><line x1="15" y1="5" x2="15" y2="19"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
    note: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    dot: '<circle cx="12" cy="12" r="4"/>',
  };

  SW.icon = function icon(name, cls) {
    const body = ICONS[name] || ICONS.dot;
    return '<svg class="icon' + (cls ? ' ' + SW.esc(cls) : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  };

  function logoSvg(size) {
    const s = size || 26;
    return '<svg class="logo-mark" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 22s8-3.5 8-10V5.5L12 2 4 5.5V12c0 6.5 8 10 8 10z"/>' +
      '<circle cx="12" cy="11" r="5.2" opacity="0.5"/>' +
      '<circle cx="12" cy="11" r="2.2" opacity="0.8"/>' +
      '<path d="M12 11l3.6-3.6"/>' +
      '</svg>';
  }
  SW.logoSvg = logoSvg;

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

  /* ----------------------------------------------------------------- api */

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
    if (res.status === 401 && opts.on401 !== 'ignore') {
      SW.state.me = null;
      const name = SW.currentRouteName();
      if (name !== 'login' && name !== 'setup' && name !== 'join') {
        SW.live.stop();
        document.body.classList.add('chrome-hidden');
        SW.navigate('#/login');
      }
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

  /* -------------------------------------------------------------- toasts */

  SW.ui.toast = function toast(msg, kind, opts) {
    kind = kind || 'info';
    opts = opts || {};
    const root = document.getElementById('toasts');
    if (!root) return null;
    const t = el('div', { class: 'toast ' + kind, role: 'status' });
    const body = el('div', { class: 'toast-body' });
    body.textContent = String(msg == null ? '' : msg);
    t.append(body);
    if (opts.pre) {
      const p = el('pre', { class: 'toast-pre' });
      p.textContent = String(opts.pre);
      t.append(p);
    }
    let timer = null;
    const dismiss = () => {
      if (timer) clearTimeout(timer);
      t.classList.add('out');
      setTimeout(() => t.remove(), 180);
    };
    t.addEventListener('click', dismiss);
    root.append(t);
    while (root.children.length > 6) root.firstChild.remove();
    if (!opts.sticky) {
      timer = setTimeout(dismiss, opts.timeout || (opts.pre ? 9000 : 5000));
    }
    return { el: t, dismiss };
  };

  /* `res` from an admin endpoint: {ok, rconOk, rconResponse|response}. */
  SW.ui.rconToast = function rconToast(title, res) {
    const bad = res && (res.ok === false || res.rconOk === false);
    const pre = res ? (res.rconResponse != null ? res.rconResponse : res.response) : null;
    SW.ui.toast(title, bad ? 'warn' : 'ok', pre ? { pre: String(pre).slice(0, 800) } : {});
  };

  /* -------------------------------------------------------------- modals */

  SW.ui.modal = function modal(o) {
    const root = document.getElementById('modal-root');
    const backdrop = el('div', { class: 'modal-backdrop' });
    const box = el('div', {
      class: 'modal' + (o.wide ? ' wide' : '') + (o.danger ? ' danger' : ''),
      role: 'dialog', 'aria-modal': 'true',
    });
    const head = el('div', { class: 'modal-head' }, el('h3', { text: o.title || '' }));
    const xBtn = el('button', { class: 'icon-btn', html: SW.icon('x'), 'aria-label': 'Close', type: 'button' });
    head.append(xBtn);
    const content = el('div', { class: 'modal-body' });
    if (typeof o.body === 'string') content.innerHTML = o.body; // caller escapes
    else if (o.body) content.append(o.body);
    box.append(head, content);
    backdrop.append(box);
    root.append(backdrop);
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
      if (o.onClose) o.onClose();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    xBtn.addEventListener('click', close);
    return { el: box, body: content, close };
  };

  /* confirmModal({title, body, danger, confirmText, fields}) -> Promise<obj|null>
   * field: {name, label, type:'text'|'textarea'|'select'|'number'|'password'|'checkbox',
   *         options:[{value,label}|string], placeholder, value, required, rows,
   *         presets:[string] (clickable chips that fill the field), hint}
   */
  SW.ui.confirmModal = function confirmModal(o) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };
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
        const wrap = el('div', { class: 'field' + (f.type === 'checkbox' ? ' field-check' : '') });
        let input;
        if (f.type === 'select') {
          input = el('select', { class: 'input', id: 'f-' + f.name });
          for (const opt of f.options || []) {
            const val = opt && typeof opt === 'object' ? opt.value : opt;
            const lab = opt && typeof opt === 'object' && opt.label != null ? opt.label : String(val);
            const oEl = el('option', { value: String(val), text: lab });
            if (f.value != null && String(f.value) === String(val)) oEl.selected = true;
            input.append(oEl);
          }
        } else if (f.type === 'textarea') {
          input = el('textarea', { class: 'input', id: 'f-' + f.name, rows: String(f.rows || 3), placeholder: f.placeholder || '' });
          if (f.value != null) input.value = String(f.value);
        } else if (f.type === 'checkbox') {
          input = el('input', { type: 'checkbox', id: 'f-' + f.name });
          if (f.value) input.checked = true;
        } else {
          input = el('input', { class: 'input', id: 'f-' + f.name, type: f.type || 'text', placeholder: f.placeholder || '' });
          if (f.value != null) input.value = String(f.value);
        }
        inputs[f.name] = input;
        if (f.type === 'checkbox') {
          const lab = el('label', { class: 'check-label', for: 'f-' + f.name });
          lab.textContent = f.label || f.name;
          wrap.append(input, lab);
        } else {
          if (f.label) wrap.append(el('label', { text: f.label, for: 'f-' + f.name }));
          wrap.append(input);
        }
        if (f.presets && f.presets.length) {
          const row = el('div', { class: 'chip-row' });
          for (const p of f.presets) {
            const chip = el('button', { type: 'button', class: 'chip', text: p });
            chip.addEventListener('click', () => { input.value = p; input.dispatchEvent(new Event('input')); input.focus(); });
            row.append(chip);
          }
          wrap.append(row);
        }
        if (f.hint) wrap.append(el('div', { class: 'hint', text: f.hint }));
        form.append(wrap);
      }
      const actions = el('div', { class: 'modal-actions' });
      const cancel = el('button', { type: 'button', class: 'btn ghost', text: 'Cancel' });
      const ok = el('button', { type: 'submit', class: 'btn ' + (o.danger ? 'danger' : 'primary'), text: o.confirmText || 'Confirm' });
      actions.append(cancel, ok);
      form.append(actions);
      const m = SW.ui.modal({ title: o.title, body: form, danger: o.danger, wide: o.wide, onClose: () => done(null) });
      cancel.addEventListener('click', () => m.close());
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const out = {};
        let bad = false;
        for (const f of fields) {
          const inp = inputs[f.name];
          const v = f.type === 'checkbox' ? inp.checked : inp.value.trim();
          if (f.required && (v === '' || v == null)) { inp.classList.add('invalid'); bad = true; continue; }
          inp.classList.remove('invalid');
          out[f.name] = v;
        }
        if (bad) return;
        done(out);
        m.close();
      });
      const first = form.querySelector('input:not([type=checkbox]), textarea, select');
      if (first) setTimeout(() => first.focus(), 30);
    });
  };

  /* ------------------------------------------------------------- popover */

  let activePopover = null;
  SW.ui.closePopover = function closePopover() {
    if (activePopover) { activePopover.remove(); activePopover = null; }
  };

  /* popover(anchorEl, items) — item: {label, icon, danger, onClick} or '-' separator */
  SW.ui.popover = function popover(anchor, items) {
    SW.ui.closePopover();
    const root = document.getElementById('popover-root');
    const pop = el('div', { class: 'popover', role: 'menu' });
    for (const it of items) {
      if (it === '-') { pop.append(el('div', { class: 'popover-sep' })); continue; }
      if (it.header) { pop.append(el('div', { class: 'popover-header', text: it.header })); continue; }
      const b = el('button', { type: 'button', class: 'popover-item' + (it.danger ? ' danger' : ''), role: 'menuitem' });
      b.innerHTML = (it.icon ? SW.icon(it.icon) : '') + '<span></span>';
      b.querySelector('span').textContent = it.label;
      b.addEventListener('click', (e) => { e.stopPropagation(); SW.ui.closePopover(); if (it.onClick) it.onClick(); });
      pop.append(b);
    }
    root.append(pop);
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth || 200;
    const ph = pop.offsetHeight || 100;
    let x = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
    let y = r.bottom + 6;
    if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
    activePopover = pop;
    return pop;
  };
  document.addEventListener('mousedown', (e) => {
    if (activePopover && !activePopover.contains(e.target)) SW.ui.closePopover();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') SW.ui.closePopover(); });
  window.addEventListener('resize', () => SW.ui.closePopover());
  window.addEventListener('scroll', () => SW.ui.closePopover(), true);

  /* --------------------------------------------------- player link + menu
   * playerLink(ref, {class}) — ref is a playerRef {dbId, eosId, steamId, name,
   * teamId, squadId, sessKills, sessDeaths, sessTks} (any subset). Click opens
   * the action popover: Profile / Warn / Kick / Ban / Force team / Remove from
   * squad / Watch / Note (actions admin+ only).
   */
  SW.ui.playerLink = function playerLink(ref, opts) {
    opts = opts || {};
    ref = ref || {};
    const s = el('span', { class: 'plink' + (opts.class ? ' ' + opts.class : ''), tabindex: '0', role: 'button' });
    s.textContent = ref.name || 'unknown';
    const open = (e) => { e.preventDefault(); e.stopPropagation(); SW.ui.playerPopover(s, ref); };
    s.addEventListener('click', open);
    s.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); });
    return s;
  };

  SW.ui.playerPopover = function playerPopover(anchor, ref) {
    const items = [];
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

  SW.ui.badge = function badge(text, kind) {
    const b = el('span', { class: 'badge' + (kind ? ' ' + kind : '') });
    b.textContent = String(text == null ? '' : text);
    return b;
  };

  SW.ui.sevBadge = function sevBadge(sev) {
    const s = Number(sev) || 1;
    return SW.ui.badge('S' + s, 'sev' + Math.min(3, Math.max(1, s)));
  };

  /* channel chip colors: all=accent2, team=green, squad=dim, admin=gold */
  SW.ui.channelChip = function channelChip(channel) {
    const ch = String(channel || 'all');
    const c = el('span', { class: 'chip chan ch-' + ch });
    c.textContent = ch;
    return c;
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
    const color = opts.color || SW.ui.cssVar('--chart-line', '#2563eb');
    ctx.beginPath();
    for (let i = 0; i < data.length; i++) {
      const x = i * stepX;
      const y = h - 3 - ((data[i] - min) / span) * (h - 6);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
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

  /* statCard({icon, label, value, sub, accent:'red'|'warn'|'gold'|'blue', href,
   * onClick, spark:[...]}) -> element with .set(value, sub?) updater */
  SW.ui.statCard = function statCard(o) {
    const card = el(o.href ? 'a' : 'div', {
      class: 'stat-card' + (o.accent ? ' accent-' + o.accent : '') + ((o.href || o.onClick) ? ' clickable' : ''),
      href: o.href || null,
    });
    if (o.icon) card.append(el('div', { class: 'stat-icon', html: SW.icon(o.icon) }));
    const main = el('div', { class: 'stat-main' });
    const valEl = el('div', { class: 'stat-value' });
    valEl.textContent = o.value == null ? '—' : String(o.value);
    const labEl = el('div', { class: 'stat-label' });
    labEl.textContent = o.label || '';
    const subEl = el('div', { class: 'stat-sub' });
    if (o.sub != null) {
      if (typeof o.sub === 'string') subEl.textContent = o.sub; else subEl.append(o.sub);
    }
    main.append(valEl, labEl, subEl);
    card.append(main);
    let sparkCv = null;
    if (o.spark) {
      sparkCv = el('canvas', { class: 'stat-spark' });
      card.append(sparkCv);
      requestAnimationFrame(() => SW.ui.sparkline(sparkCv, o.spark, { width: 92, height: 30, color: o.sparkColor }));
    }
    if (o.onClick) card.addEventListener('click', o.onClick);
    card.set = function (value, sub) {
      if (value !== undefined) valEl.textContent = value == null ? '—' : String(value);
      if (sub !== undefined) { subEl.textContent = ''; if (typeof sub === 'string') subEl.textContent = sub; else if (sub) subEl.append(sub); }
    };
    card.setSpark = function (series, color) {
      if (!sparkCv) { sparkCv = el('canvas', { class: 'stat-spark' }); card.append(sparkCv); }
      SW.ui.sparkline(sparkCv, series, { width: 92, height: 30, color: color || o.sparkColor });
    };
    return card;
  };

  /* table(cols, rows, opts) -> element with .update(rows)
   * col: {key, label, sortable, render(row)->node|string, sortVal(row), align:'right',
   *       width, class} — plain strings from render/row[key] are set via textContent.
   * opts: {sort:{key,dir}, storeKey (persist sort in localStorage), onSort(key,dir)
   *       (server-side mode: no local sort), rowClass(row), onRowClick(row), emptyText}
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
    cols.forEach((c) => {
      const th = el('th', {
        class: (c.align === 'right' ? 'num' : '') + (c.sortable ? ' sortable' : ''),
        style: c.width ? 'width:' + c.width : null,
      });
      const lbl = el('span');
      lbl.textContent = c.label != null ? c.label : c.key;
      th.append(lbl);
      if (c.sortable) {
        th.append(el('span', { class: 'sort-arrow' }));
        th.addEventListener('click', () => {
          const dir = sort && sort.key === c.key && sort.dir === 'desc' ? 'asc' : 'desc';
          sort = { key: c.key, dir };
          if (storeKey) SW.prefs.set(storeKey, sort);
          if (opts.onSort) { opts.onSort(c.key, dir); markSort(); return; }
          renderBody();
          markSort();
        });
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
        th.classList.toggle('sorted-asc', !!(sort && c && sort.key === c.key && sort.dir === 'asc'));
        th.classList.toggle('sorted-desc', !!(sort && c && sort.key === c.key && sort.dir === 'desc'));
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
        tbody.append(el('tr', {}, td));
        return;
      }
      for (const row of rs) {
        const tr = el('tr', { class: opts.rowClass ? (opts.rowClass(row) || '') : null });
        for (const c of cols) {
          const td = el('td', { class: (c.align === 'right' ? 'num ' : '') + (c.class || '') });
          const out = c.render ? c.render(row) : row[c.key];
          if (out == null || out === '') td.textContent = '—';
          else if (out.nodeType) td.append(out);
          else td.textContent = String(out);
          tr.append(td);
        }
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
    const prev = el('button', { type: 'button', class: 'btn ghost small icon-only', html: SW.icon('chevron-left'), 'aria-label': 'Previous page' });
    const next = el('button', { type: 'button', class: 'btn ghost small icon-only', html: SW.icon('chevron-right'), 'aria-label': 'Next page' });
    const lab = el('span', { class: 'pager-label dim' });
    lab.textContent = 'page ' + (o.page + 1) + ' / ' + pages + ' — ' + SW.ui.fmtNum(o.total || 0) + ' rows';
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

  SW.ui.empty = function empty(text, iconName) {
    const d = el('div', { class: 'empty-state' });
    d.innerHTML = SW.icon(iconName || 'search');
    d.append(el('p', { text: text || 'Nothing here' }));
    return d;
  };

  SW.ui.section = function section(title) {
    const s = el('section', { class: 'section' });
    if (title) s.append(el('h2', { class: 'section-title', text: title }));
    for (let i = 1; i < arguments.length; i++) appendChild(s, arguments[i]);
    return s;
  };

  /* ------------------------------------------------------ feed row builders
   * killRow(kill) / chatRow(chat) with §7 enriched payloads — reusable by all
   * stages (dashboard feeds, match detail, profile timelines).
   */
  SW.ui.killRow = function killRow(k) {
    const row = el('div', { class: 'feed-row kill' + (k.teamkill ? ' tk' : '') + (k.kind === 'die' ? ' died' : '') });
    const main = el('span', { class: 'feed-main' });
    if (k.suicide) {
      main.append(SW.ui.playerLink(k.victim || {}));
      main.append(el('span', { class: 'dim', text: ' died (suicide)' }));
    } else {
      if (k.attacker) main.append(SW.ui.playerLink(k.attacker));
      else main.append(el('span', { class: 'dim', text: 'environment' }));
      main.append(el('span', { class: 'kill-arrow', html: SW.icon('skull') }));
      main.append(SW.ui.playerLink(k.victim || {}));
      if (k.kind === 'die') main.append(el('span', { class: 'faint small', text: ' gave up' }));
    }
    row.append(main);
    if (k.teamkill) row.append(SW.ui.badge('TK', 'red'));
    if (k.weapon) row.append(el('span', { class: 'feed-meta mono dim', text: k.weapon }));
    row.append(SW.ui.timeAgo(k.time));
    return row;
  };

  SW.ui.chatRow = function chatRow(c) {
    const row = el('div', { class: 'feed-row chat-line' });
    row.append(SW.ui.channelChip(c.channel));
    row.append(SW.ui.playerLink(c.player || { name: '?' }));
    const msg = el('span', { class: 'feed-msg' });
    msg.textContent = c.message || '';
    row.append(msg);
    row.append(SW.ui.timeAgo(c.time));
    return row;
  };

  /* -------------------------------------------------------------- actions
   * Admin actions: confirm modal (reason/duration fields with presets) then
   * POST to the spec §13 endpoint, result via SW.ui.rconToast. Every action
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
  const INTERVAL_RE = /^(0|\d{1,3}[mhdwMy])$/;

  function targetBody(ref, extra) {
    const body = Object.assign({}, extra);
    const dbId = ref.dbId != null ? ref.dbId : ref.id;
    if (dbId != null) body.playerId = dbId;
    else if (ref.steamId) body.steamId = ref.steamId;
    return body;
  }

  SW.actions.warn = async function warn(ref) {
    try {
      const v = await SW.ui.confirmModal({
        title: 'Warn ' + (ref.name || 'player'),
        confirmText: 'Send warning',
        fields: [{ name: 'message', label: 'Message (shown on their screen)', type: 'textarea', required: true, presets: WARN_PRESETS }],
      });
      if (!v) return;
      const res = await SW.api('/api/admin/warn', { method: 'POST', body: targetBody(ref, { message: v.message }) });
      SW.ui.rconToast('Warned ' + (ref.name || 'player'), res);
    } catch (_e) { /* toasted by SW.api */ }
  };

  SW.actions.kick = async function kick(ref) {
    try {
      const v = await SW.ui.confirmModal({
        title: 'Kick ' + (ref.name || 'player'),
        danger: true,
        confirmText: 'Kick',
        fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true, presets: KICK_PRESETS }],
      });
      if (!v) return;
      const res = await SW.api('/api/admin/kick', { method: 'POST', body: targetBody(ref, { reason: v.reason }) });
      SW.ui.rconToast('Kicked ' + (ref.name || 'player'), res);
    } catch (_e) { /* toasted */ }
  };

  /* Works for online players, DB players, and never-seen steamIds
   * (recently-disconnected "ban anyway" passes {name, steamId, eosId}). */
  SW.actions.ban = async function ban(ref) {
    try {
      const fields = [
        { name: 'interval', label: 'Duration', type: 'select', options: BAN_INTERVALS, value: '1d' },
        { name: 'customInterval', label: 'Custom interval (0 = permanent, or 30m / 12h / 5d / 2w / 1M / 1y)', type: 'text', placeholder: 'e.g. 14d' },
        { name: 'reason', label: 'Reason', type: 'textarea', required: true, presets: BAN_REASON_PRESETS },
      ];
      const noDbId = ref.dbId == null && ref.id == null;
      if (noDbId && !ref.steamId) {
        SW.ui.toast('Cannot ban: no player id or steamId known', 'error');
        return;
      }
      const v = await SW.ui.confirmModal({
        title: 'Ban ' + (ref.name || ref.steamId || 'player'),
        danger: true,
        confirmText: 'Ban player',
        body: noDbId ? 'Banning by steamId ' + (ref.steamId || '') : undefined,
        fields,
      });
      if (!v) return;
      const interval = v.interval === 'custom' ? String(v.customInterval || '').trim() : v.interval;
      if (!INTERVAL_RE.test(interval)) {
        SW.ui.toast('Invalid ban interval — use 0 (permanent) or like 30m, 12h, 5d, 2w, 1M, 1y', 'error');
        return;
      }
      const res = await SW.api('/api/bans', { method: 'POST', body: targetBody(ref, { interval, reason: v.reason }) });
      SW.ui.rconToast('Banned ' + (ref.name || ref.steamId || 'player') + ' (' + (interval === '0' ? 'permanent' : interval) + ')', res);
    } catch (_e) { /* toasted */ }
  };

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

  SW.actions.setNextLayer = async function setNextLayer(layer) {
    const res = await SW.api('/api/admin/changeLayer', { method: 'POST', body: { layer, now: false } });
    SW.ui.rconToast('Next layer set: ' + layer, res);
    return res;
  };

  SW.actions.changeLayerNow = async function changeLayerNow(layer) {
    try {
      const c = await SW.ui.confirmModal({
        title: 'Change layer NOW?',
        body: 'This ends the current match immediately and loads ' + layer + '.',
        danger: true,
        confirmText: 'Change now',
      });
      if (!c) return;
      const res = await SW.api('/api/admin/changeLayer', { method: 'POST', body: { layer, now: true } });
      SW.ui.rconToast('Changing layer to ' + layer, res);
    } catch (_e) { /* toasted */ }
  };

  SW.actions.fetchLayers = async function fetchLayers() {
    if (SW.state.layers) return SW.state.layers;
    const r = await SW.api('/api/layers', { toast: false });
    SW.state.layers = (r && r.layers) || [];
    return SW.state.layers;
  };

  /* layer picker dialog (dashboard layer card, admins) */
  SW.actions.layerDialog = async function layerDialog() {
    let layers;
    try { layers = await SW.actions.fetchLayers(); } catch (_e) { SW.ui.toast('Could not load layer list', 'error'); return; }
    if (!layers.length) { SW.ui.toast('Layer list is empty (RCON down?)', 'warn'); return; }
    try {
      const v = await SW.ui.confirmModal({
        title: 'Layer control',
        confirmText: 'Apply',
        fields: [
          { name: 'layer', label: 'Layer', type: 'select', options: layers },
          { name: 'now', label: 'Change immediately (ends the current match)', type: 'checkbox' },
        ],
      });
      if (!v || !v.layer) return;
      if (v.now) { await SW.actions.changeLayerNow(v.layer); return; }
      await SW.actions.setNextLayer(v.layer);
    } catch (_e) { /* toasted */ }
  };

  /* ------------------------------------------------------------- SSE live
   * SW.live.on(evt, fn) -> unsubscribe fn. Events (spec §13 + §19.6):
   * hello, kill, chat, deployable, flag, connect, disconnect, players, match,
   * serverinfo, tick, status, broadcast, pop, revive. Internal: '_conn' {up}.
   * '*' subscribes to everything as fn(evt, data).
   */
  SW.live = (function () {
    const subs = new Map();
    const EVENTS = ['hello', 'kill', 'chat', 'deployable', 'flag', 'connect', 'disconnect',
      'players', 'match', 'serverinfo', 'tick', 'status', 'broadcast', 'pop', 'revive'];
    let es = null;
    let retryTimer = null;
    let backoff = 1000;
    let wanted = false;
    const live = { up: false };

    function emit(evt, data) {
      const set = subs.get(evt);
      if (set) for (const fn of Array.from(set)) { try { fn(data); } catch (e) { console.error('live handler (' + evt + ')', e); } }
      const any = subs.get('*');
      if (any) for (const fn of Array.from(any)) { try { fn(evt, data); } catch (e) { console.error('live handler (*)', e); } }
    }
    function handler(evt) {
      return function (e) {
        let d = null;
        try { d = JSON.parse(e.data); } catch (_err) { d = e.data; }
        emit(evt, d);
      };
    }
    function scheduleRetry() {
      if (!wanted || retryTimer) return;
      retryTimer = setTimeout(() => { retryTimer = null; if (wanted) live.start(); }, backoff);
      backoff = Math.min(backoff * 2, 15000);
    }
    live.start = function start() {
      wanted = true;
      if (es) return;
      try { es = new EventSource('/api/stream'); } catch (_e) { scheduleRetry(); return; }
      for (const evt of EVENTS) es.addEventListener(evt, handler(evt));
      es.onopen = () => { backoff = 1000; live.up = true; emit('_conn', { up: true }); };
      es.onerror = () => {
        live.up = false;
        emit('_conn', { up: false });
        if (es && es.readyState === 2) { es = null; scheduleRetry(); } // CLOSED -> manual retry
      };
    };
    live.stop = function stop() {
      wanted = false;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (es) { es.close(); es = null; }
      live.up = false;
    };
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

  /* global SSE subscriptions feeding SW.state + topbar */
  function applyStatus(st) {
    if (!st) return;
    SW.state.status = Object.assign({}, SW.state.status, { rcon: st.rcon || SW.state.status.rcon, log: st.log || SW.state.status.log });
    if (st.tickRate != null) SW.state.tickRate = Number(st.tickRate);
    if (st.serverInfo) SW.state.serverInfo = st.serverInfo;
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
    if (f && SW.can('flags')) {
      const who = (f.player && f.player.name) || 'unknown player';
      SW.ui.toast('Flag S' + (f.severity || '?') + ': ' + (f.type || 'flag') + ' — ' + who, 'warn');
    }
  });
  SW.live.on('_conn', (c) => {
    const b = document.getElementById('conn-banner');
    if (b) b.classList.toggle('hidden', !!(c && c.up));
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

  let currentView = null;

  function handleRoute() {
    const main = document.getElementById('main');
    if (!main) return;
    const parsed = parseHash();
    const authed = !!SW.state.me;
    let target = parsed.name || (authed ? 'dashboard' : 'login');
    if (!authed && target !== 'login' && target !== 'setup' && target !== 'join') { location.hash = '#/login'; return; }
    if (authed && (target === 'login' || target === 'setup' || target === 'join')) { location.hash = '#/dashboard'; return; }
    if (currentView && typeof currentView.cleanup === 'function') {
      try { currentView.cleanup(); } catch (e) { console.error('cleanup', e); }
    }
    currentView = null;
    SW.ui.closePopover();
    document.body.classList.toggle('chrome-hidden', target === 'login' || target === 'setup' || target === 'join');
    document.body.classList.remove('drawer-open');
    main.textContent = '';
    const def = SW.routes[target];
    if (!def) { main.append(SW.ui.empty('Unknown page: ' + target)); return; }
    const need = def.perm || def.role; /* perm: key or [keys] (any grants) */
    if (need && !SW.canAny(need)) { main.append(SW.ui.empty('You do not have access to this page', 'lock')); return; }
    currentView = def;
    updateNavActive(target);
    try {
      def.render.call(def, main, { args: parsed.args, query: parsed.query, name: target });
    } catch (e) {
      console.error('render ' + target, e);
      main.append(SW.ui.empty('This view failed to render — see the browser console'));
    }
    main.scrollTop = 0;
  }
  window.addEventListener('hashchange', handleRoute);

  /* --------------------------------------------------------- shell + nav */

  /* perm: a key or [keys] (any one grants); the Admin separator shows only
   * when at least one item after it is visible. */
  const NAV = [
    { route: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { route: 'live', label: 'Live', icon: 'live' },
    { route: 'players', label: 'Players', icon: 'users' },
    { route: 'matches', label: 'Matches', icon: 'swords' },
    { route: 'chat', label: 'Chat', icon: 'chat' },
    { route: 'trolls', label: 'Trolls', icon: 'shield-alert' },
    { sep: 'Admin' },
    { route: 'admin', label: 'Admin tools', icon: 'gavel', perm: ['broadcast', 'layer', 'match', 'squad', 'team', 'warn', 'kick', 'ban'] },
    { route: 'bans', label: 'Bans', icon: 'ban', perm: 'ban' },
    { route: 'audit', label: 'Audit log', icon: 'scroll', perm: 'audit' },
    { route: 'console', label: 'Console', icon: 'terminal', perm: 'raw' },
    { route: 'users', label: 'Users', icon: 'user-cog', perm: 'users' },
    { route: 'roles', label: 'Roles', icon: 'shield', perm: ['roles', 'users'] },
    { route: 'settings', label: 'Settings', icon: 'settings', perm: 'settings' },
  ];

  function updateNavActive(target) {
    document.querySelectorAll('#sidebar .nav-item').forEach((a) => {
      a.classList.toggle('active', a.dataset.route === target);
    });
  }

  async function logout() {
    /* body:{} so the POST carries the JSON content-type the server requires */
    try { await SW.api('/api/logout', { method: 'POST', body: {}, toast: false }); } catch (_e) { /* ignore */ }
    SW.live.stop();
    SW.state.me = null;
    SW.state.overview = null;
    document.body.classList.add('chrome-hidden');
    SW.navigate('#/login');
  }
  SW.logout = logout;

  function renderShell() {
    const sb = document.getElementById('sidebar');
    const tb = document.getElementById('topbar');
    if (!sb || !tb) return;
    sb.textContent = '';
    tb.textContent = '';
    document.body.classList.remove('chrome-hidden');
    document.body.classList.toggle('sb-collapsed', !!SW.prefs.get('sidebar', false));

    /* sidebar */
    const logo = el('a', { class: 'logo', href: '#/dashboard' });
    logo.innerHTML = logoSvg(26) + '<span class="logo-word">SQUAD<b>WATCH</b></span>';
    sb.append(logo);
    const nav = el('nav', { class: 'nav' });
    let pendingSep = null;
    for (const item of NAV) {
      if (item.sep) { pendingSep = item.sep; continue; }
      if (item.perm && !SW.canAny(item.perm)) continue;
      if (pendingSep) { nav.append(el('div', { class: 'nav-sep', text: pendingSep })); pendingSep = null; }
      const a = el('a', { class: 'nav-item', href: '#/' + item.route, dataset: { route: item.route }, title: item.label });
      a.innerHTML = SW.icon(item.icon) + '<span class="nav-label"></span>';
      a.querySelector('.nav-label').textContent = item.label;
      a.addEventListener('click', () => document.body.classList.remove('drawer-open'));
      nav.append(a);
    }
    sb.append(nav);
    const foot = el('div', { class: 'sb-foot' });
    const coll = el('button', { type: 'button', class: 'icon-btn sb-collapse', title: 'Collapse sidebar' });
    const syncColl = () => { coll.innerHTML = SW.icon(document.body.classList.contains('sb-collapsed') ? 'chevron-right' : 'chevron-left'); };
    syncColl();
    coll.addEventListener('click', () => {
      document.body.classList.toggle('sb-collapsed');
      SW.prefs.set('sidebar', document.body.classList.contains('sb-collapsed'));
      syncColl();
    });
    foot.append(coll);
    sb.append(foot);

    /* topbar */
    const burger = el('button', { type: 'button', class: 'icon-btn tb-burger', html: SW.icon('menu'), 'aria-label': 'Menu' });
    burger.addEventListener('click', (e) => { e.stopPropagation(); document.body.classList.toggle('drawer-open'); });
    const name = el('div', { class: 'tb-server', id: 'tb-servername', text: 'SquadWatch' });
    const mid = el('div', { class: 'tb-mid' });
    mid.innerHTML = '<span class="tb-chip layer" id="tb-layer" title="current layer">—</span>' +
      '<span class="tb-arrow">' + SW.icon('chevron-right') + '</span>' +
      '<span class="tb-chip layer dimmed" id="tb-next" title="next layer">—</span>';
    const right = el('div', { class: 'tb-right' });
    right.innerHTML = '<span class="tb-chip" id="tb-players" title="players / max (+queue)">—</span>' +
      '<span class="tb-chip" id="tb-tick" title="server tick rate">— tps</span>' +
      '<span class="tb-chip mono" id="tb-clock" title="match time">--:--</span>' +
      '<span class="tb-dot" id="tb-dot-rcon" title="RCON"><span class="dot" id="dot-rcon"></span></span>' +
      '<span class="tb-dot" id="tb-dot-log" title="Log source"><span class="dot" id="dot-log"></span></span>';
    const themeBtn = el('button', { type: 'button', class: 'icon-btn theme-btn', id: 'tb-theme' });
    const syncThemeBtn = () => {
      const dark = SW.theme.current() === 'dark';
      themeBtn.innerHTML = SW.icon(dark ? 'sun' : 'moon');
      themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      themeBtn.title = dark ? 'Light theme' : 'Dark theme';
    };
    syncThemeBtn();
    themeBtn.addEventListener('click', () => { SW.theme.toggle(); syncThemeBtn(); });
    const um = el('button', { type: 'button', class: 'user-btn' });
    um.innerHTML = SW.icon('user') + '<span class="user-name"></span><span class="badge dim role-badge"></span>' + SW.icon('chevron-down');
    um.querySelector('.user-name').textContent = SW.state.me ? SW.state.me.username : '';
    um.querySelector('.role-badge').textContent = SW.state.me ? SW.state.me.role : '';
    um.addEventListener('click', (e) => {
      e.stopPropagation();
      SW.ui.popover(um, [{ label: 'Sign out', icon: 'logout', onClick: logout }]);
    });
    right.append(themeBtn, um);
    tb.append(burger, name, mid, right);

    /* mobile drawer backdrop (once) */
    if (!document.getElementById('drawer-backdrop')) {
      const bd = el('div', { id: 'drawer-backdrop' });
      bd.addEventListener('click', () => document.body.classList.remove('drawer-open'));
      document.body.append(bd);
    }
    updateTopbar();
    updateNavActive(parseHash().name || 'dashboard');
  }

  function updateTopbar() {
    const snap = SW.state.snapshot || {};
    const si = SW.state.serverInfo || snap.serverInfo || {};
    const st = SW.state.status || {};
    const set = (id, txt) => { const n = document.getElementById(id); if (n) n.textContent = txt; };
    set('tb-servername', si.serverName || (SW.state.bootstrap && SW.state.bootstrap.serverName) || 'SquadWatch');
    set('tb-layer', snap.currentLayer || si.mapName || '—');
    set('tb-next', snap.nextLayer || si.nextLayer || '—');
    const queue = (Number(si.publicQueue) || 0) + (Number(si.reservedQueue) || 0);
    const pc = si.playerCount != null ? si.playerCount : '—';
    const mx = si.maxPlayers != null ? si.maxPlayers : '—';
    set('tb-players', pc + '/' + mx + (queue > 0 ? ' (+' + queue + ')' : ''));
    const tick = SW.state.tickRate != null ? SW.state.tickRate : snap.tickRate;
    const tickEl = document.getElementById('tb-tick');
    if (tickEl) {
      tickEl.textContent = (tick != null ? Number(tick).toFixed(0) : '—') + ' tps';
      tickEl.classList.toggle('bad', tick != null && tick < 20);
      tickEl.classList.toggle('warnc', tick != null && tick >= 20 && tick < 30);
    }
    const rc = st.rcon || {};
    const lg = st.log || {};
    const dr = document.getElementById('dot-rcon');
    if (dr) {
      dr.className = 'dot ' + (rc.connected ? 'ok' : 'bad');
      const w = document.getElementById('tb-dot-rcon');
      if (w) w.title = 'RCON: ' + (rc.connected ? 'connected' : (rc.lastError || 'disconnected'));
    }
    const dl = document.getElementById('dot-log');
    if (dl) {
      dl.className = 'dot ' + (lg.ok ? 'ok' : 'bad');
      const w = document.getElementById('tb-dot-log');
      if (w) w.title = 'Log source (' + (lg.mode || '?') + '): ' + (lg.ok ? 'ok' : (lg.error || 'down'));
    }
  }
  SW.updateTopbar = updateTopbar;

  /* topbar match clock — 1s sweep */
  setInterval(() => {
    const n = document.getElementById('tb-clock');
    if (!n) return;
    const m = SW.state.snapshot && SW.state.snapshot.match;
    const start = m && (m.inProgressAt || m.in_progress_at || m.startedAt || m.started_at);
    if (!m || !start || m.endedAt || m.ended_at) { n.textContent = '--:--'; return; }
    n.textContent = SW.ui.fmtClock((Date.now() - Number(start)) / 1000);
  }, 1000);

  async function refreshOverview() {
    try {
      const o = await SW.api('/api/overview', { toast: false });
      SW.state.overview = o;
      if (o && o.snapshot) SW.state.snapshot = o.snapshot;
      if (o && o.status) applyStatus(o.status);
      updateTopbar();
      return o;
    } catch (_e) { return null; }
  }
  SW.refreshOverview = refreshOverview;

  /* ------------------------------------------------------------ auth flow */

  async function afterLogin() {
    renderShell();
    if (SW.can('stream')) SW.live.start(); // the server 403s /api/stream without it
    refreshOverview();
    SW.navigate('#/dashboard');
  }

  function logoBlock() {
    const d = el('div', { class: 'auth-logo' });
    d.innerHTML = logoSvg(40) + '<span class="logo-word big">SQUAD<b>WATCH</b></span>';
    return d;
  }

  /* LOGIN view (chrome hidden) */
  SW.routes.login = {
    render(main) {
      const card = el('div', { class: 'auth-card card' });
      card.append(logoBlock());
      const form = el('form', { class: 'auth-form' });
      const u = el('input', { class: 'input', type: 'text', placeholder: 'Username', autocomplete: 'username', required: true, 'aria-label': 'Username' });
      const p = el('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'current-password', required: true, 'aria-label': 'Password' });
      const errBox = el('div', { class: 'auth-err hidden' });
      const btn = el('button', { class: 'btn primary wide', type: 'submit', text: 'Sign in' });
      form.append(u, p, errBox, btn);
      card.append(form);
      if (SW.state.bootstrap && SW.state.bootstrap.needsSetup) {
        const alt = el('div', { class: 'auth-alt' });
        alt.append('First run? ', el('a', { href: '#/setup', text: 'Create the owner account' }));
        form.append(alt);
      }
      main.append(el('div', { class: 'auth-wrap' }, card));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        btn.disabled = true;
        errBox.classList.add('hidden');
        try {
          const r = await SW.api('/api/login', {
            method: 'POST',
            body: { username: u.value.trim(), password: p.value },
            toast: false, on401: 'ignore',
          });
          SW.state.me = (r && r.user) || null;
          if (!SW.state.me) throw new Error('Login failed');
          await afterLogin();
        } catch (err) {
          errBox.textContent = err && err.status === 429 ? 'Too many attempts — wait a minute' : ((err && err.message) || 'Login failed');
          errBox.classList.remove('hidden');
          card.classList.remove('shake');
          void card.offsetWidth; /* restart animation */
          card.classList.add('shake');
        } finally {
          btn.disabled = false;
        }
      });
      setTimeout(() => u.focus(), 30);
    },
    cleanup() {},
  };

  /* SETUP view — first-run owner creation; setupToken per spec 19.3.15
   * (printed in the server console at boot — the operator types it in). */
  SW.routes.setup = {
    render(main) {
      const card = el('div', { class: 'auth-card card' });
      card.append(logoBlock());
      card.append(el('p', { class: 'auth-note dim', text: 'First run — create the owner account.' }));
      const form = el('form', { class: 'auth-form' });
      const u = el('input', { class: 'input', type: 'text', placeholder: 'Owner username', autocomplete: 'username', required: true, 'aria-label': 'Username' });
      const p1 = el('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'new-password', required: true, 'aria-label': 'Password' });
      const p2 = el('input', { class: 'input', type: 'password', placeholder: 'Repeat password', autocomplete: 'new-password', required: true, 'aria-label': 'Repeat password' });
      const tok = el('input', { class: 'input mono', type: 'text', placeholder: 'Setup token', autocomplete: 'off', required: true, 'aria-label': 'Setup token' });
      const hint = el('div', { class: 'hint', text: 'The setup token is printed in the server console at boot.' });
      // Demo mode serves the token via /api/bootstrap (§19.3.15) — prefill it
      // so trying the demo never requires console access.
      if (SW.state.bootstrap && SW.state.bootstrap.setupToken) tok.value = SW.state.bootstrap.setupToken;
      const errBox = el('div', { class: 'auth-err hidden' });
      const btn = el('button', { class: 'btn primary wide', type: 'submit', text: 'Create owner account' });
      form.append(u, p1, p2, tok, hint, errBox, btn);
      card.append(form);
      main.append(el('div', { class: 'auth-wrap' }, card));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        errBox.classList.add('hidden');
        if (p1.value !== p2.value) {
          errBox.textContent = 'Passwords do not match';
          errBox.classList.remove('hidden');
          return;
        }
        btn.disabled = true;
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
        } catch (err) {
          errBox.textContent = (err && err.message) || 'Setup failed';
          errBox.classList.remove('hidden');
          card.classList.remove('shake');
          void card.offsetWidth;
          card.classList.add('shake');
        } finally {
          btn.disabled = false;
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
    render(main, ctx) {
      const token = (ctx.args && ctx.args[0]) || '';
      const card = el('div', { class: 'auth-card card' });
      card.append(logoBlock());
      const box = el('div');
      card.append(box);
      main.append(el('div', { class: 'auth-wrap' }, card));

      function deadLink(msg) {
        box.textContent = '';
        box.append(el('p', {
          class: 'auth-note dim',
          text: msg || 'This invite link is no longer valid — it may have been used, revoked or expired. Ask the person who invited you for a fresh one.',
        }));
        box.append(el('div', { class: 'auth-alt' }, el('a', { href: '#/login', text: 'Go to sign in' })));
      }

      if (!token) { deadLink('This invite link is incomplete — copy the full URL you were sent.'); return; }
      box.append(el('div', { class: 'auth-note dim', text: 'Checking your invite…' }));

      (async () => {
        let peek = null;
        try {
          peek = await SW.api('/api/join?token=' + encodeURIComponent(token), { toast: false, on401: 'ignore' });
        } catch (err) {
          deadLink(err && err.status === 429
            ? 'Too many attempts from this address — wait a minute, then reload this page.'
            : 'Could not check this invite — is the panel server reachable?');
          return;
        }
        if (!peek || !peek.valid) { deadLink(); return; }
        box.textContent = '';
        const note = el('p', { class: 'auth-note dim' });
        note.append('You\'ve been invited to ');
        note.append(el('b', { text: peek.serverName || 'SquadWatch' }));
        note.append(' as ');
        note.append(el('b', { text: peek.roleName || 'a member' }));
        note.append('. Pick a username and password to join.');
        box.append(note);
        const form = el('form', { class: 'auth-form' });
        const u = el('input', { class: 'input', type: 'text', placeholder: 'Username', autocomplete: 'username', required: true, 'aria-label': 'Username' });
        const p1 = el('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'new-password', required: true, 'aria-label': 'Password' });
        const p2 = el('input', { class: 'input', type: 'password', placeholder: 'Repeat password', autocomplete: 'new-password', required: true, 'aria-label': 'Repeat password' });
        const errBox = el('div', { class: 'auth-err hidden' });
        const btn = el('button', { class: 'btn primary wide', type: 'submit', text: 'Create account & join' });
        form.append(u, p1, p2, errBox, btn);
        box.append(form);
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          errBox.classList.add('hidden');
          if (p1.value !== p2.value) {
            errBox.textContent = 'Passwords do not match';
            errBox.classList.remove('hidden');
            return;
          }
          btn.disabled = true;
          try {
            const r = await SW.api('/api/join', {
              method: 'POST',
              body: { token, username: u.value.trim(), password: p1.value },
              toast: false, on401: 'ignore',
            });
            SW.state.me = (r && r.user) || null;
            if (!SW.state.me) throw new Error('Join failed');
            await afterLogin();
          } catch (err) {
            errBox.textContent = err && err.status === 429 ? 'Too many attempts — wait a minute' : ((err && err.message) || 'Join failed');
            errBox.classList.remove('hidden');
            card.classList.remove('shake');
            void card.offsetWidth;
            card.classList.add('shake');
          } finally {
            btn.disabled = false;
          }
        });
        setTimeout(() => u.focus(), 30);
      })();
    },
    cleanup() {},
  };

  /* --------------------------------------------------------- dashboard view */

  function drawPopChart(canvas, samples) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || (canvas.parentElement && canvas.parentElement.clientWidth) || 600;
    const h = 170;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px Inter, system-ui, sans-serif';
    /* re-read theme tokens on every draw so the chart follows theme switches */
    const cLabel = SW.ui.cssVar('--chart-label', '#8795aa');
    const cGrid = SW.ui.cssVar('--chart-grid', '#e8edf4');
    const cQueue = SW.ui.cssVar('--chart-queue', 'rgba(217,119,6,0.65)');
    const cLine = SW.ui.cssVar('--chart-line', '#2563eb');
    const cFill = SW.ui.cssVar('--chart-fill', 'rgba(37,99,235,0.10)');
    if (!samples || samples.length < 2) {
      ctx.fillStyle = cLabel;
      ctx.fillText('no population samples yet', 12, h / 2);
      return;
    }
    const t0 = samples[0][0];
    const t1 = samples[samples.length - 1][0];
    const span = Math.max(1, t1 - t0);
    let maxP = 10;
    for (const s of samples) maxP = Math.max(maxP, Number(s[1]) || 0, Number(s[2]) || 0);
    const X = (t) => 8 + ((t - t0) / span) * (w - 46);
    const Y = (v) => h - 18 - (v / maxP) * (h - 32);
    ctx.strokeStyle = cGrid;
    ctx.fillStyle = cLabel;
    ctx.lineWidth = 1;
    for (const frac of [0, 0.5, 1]) {
      const v = Math.round(maxP * frac);
      const y = Y(v);
      ctx.beginPath(); ctx.moveTo(8, y); ctx.lineTo(w - 38, y); ctx.stroke();
      ctx.fillText(String(v), w - 32, y + 3);
    }
    const fmtT = (t) => { const d = new Date(t); const hh = d.getHours(); const mm = d.getMinutes(); return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm; };
    ctx.fillText(fmtT(t0), 8, h - 5);
    const endLab = fmtT(t1);
    ctx.fillText(endLab, w - 38 - ctx.measureText(endLab).width, h - 5);
    /* queue — faint amber line */
    ctx.beginPath();
    samples.forEach((s, i) => { const x = X(s[0]); const y = Y(Number(s[2]) || 0); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.strokeStyle = cQueue;
    ctx.lineWidth = 1;
    ctx.stroke();
    /* players — main line + fill */
    ctx.beginPath();
    samples.forEach((s, i) => { const x = X(s[0]); const y = Y(Number(s[1]) || 0); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.strokeStyle = cLine;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();
    ctx.lineTo(X(t1), h - 18);
    ctx.lineTo(X(t0), h - 18);
    ctx.closePath();
    ctx.fillStyle = cFill;
    ctx.fill();
  }

  function feedHeader(title, pauseKey) {
    const head = el('div', { class: 'card-title feed-head' });
    head.append(el('span', { text: title }));
    let paused = !!SW.prefs.get('feed-paused:' + pauseKey, false);
    const btn = el('button', { type: 'button', class: 'icon-btn feed-pause' });
    const sync = () => {
      btn.innerHTML = SW.icon(paused ? 'play' : 'pause');
      btn.title = paused ? 'Resume feed' : 'Pause feed';
      btn.classList.toggle('active', paused);
    };
    sync();
    btn.addEventListener('click', () => {
      paused = !paused;
      SW.prefs.set('feed-paused:' + pauseKey, paused);
      sync();
    });
    head.append(btn);
    return { el: head, isPaused: () => paused };
  }

  function pushFeed(container, row, cap) {
    container.prepend(row);
    const max = cap || 50;
    while (container.children.length > max) container.lastChild.remove();
  }

  SW.routes.dashboard = {
    render(main) {
      const unsubs = [];
      const timers = [];
      this.cleanup = () => {
        unsubs.forEach((u) => u());
        timers.forEach((t) => clearInterval(t));
        window.removeEventListener('resize', onResize);
      };

      const page = el('div', { class: 'view view-dashboard' });
      main.append(page);

      /* --- "no server linked" banner (settings holders only, dismissable) ---
       * Unconfigured RCON reports connected:false with lastError:null — a real
       * outage always carries a lastError, so this only shows when unlinked. */
      const linkBanner = el('div', { class: 'notice-banner hidden' });
      linkBanner.append(el('span', { class: 'notice-icon', html: SW.icon('radio') }));
      linkBanner.append(el('span', { class: 'grow', text: 'No Squad server linked yet — point SquadWatch at your server\'s RCON to bring this dashboard to life.' }));
      linkBanner.append(el('a', { class: 'btn small primary', href: '#/settings', text: 'Open Settings' }));
      const linkDismiss = el('button', { type: 'button', class: 'icon-btn', html: SW.icon('x'), 'aria-label': 'Dismiss', title: 'Dismiss' });
      linkDismiss.addEventListener('click', () => {
        SW.prefs.set('unlinked-dismissed', true);
        linkBanner.classList.add('hidden');
      });
      linkBanner.append(linkDismiss);
      page.append(linkBanner);
      function syncLinkBanner() {
        if (!SW.can('settings') || SW.prefs.get('unlinked-dismissed', false)) return;
        const rc = (SW.state.status && SW.state.status.rcon) || null;
        const unlinked = !!rc && !rc.connected && rc.lastError == null;
        linkBanner.classList.toggle('hidden', !unlinked);
      }

      /* --- stat cards row --- */
      const cardsRow = el('div', { class: 'stat-row' });
      const cPlayers = SW.ui.statCard({ icon: 'users', label: 'Players', value: '—' });
      const cLayer = SW.ui.statCard({
        icon: 'map', label: 'Current layer', value: '—',
        onClick: SW.can('layer') ? () => SW.actions.layerDialog() : null,
      });
      if (SW.can('layer')) cLayer.title = 'Layer control';
      const cMatch = SW.ui.statCard({ icon: 'clock', label: 'Match time', value: '--:--' });
      const cFlags = SW.ui.statCard({ icon: 'flag', label: 'Open flags', value: '—', href: '#/trolls' });
      const cBans = SW.ui.statCard({ icon: 'ban', label: 'Active bans', value: '—', href: '#/bans' });
      const cTks = SW.ui.statCard({ icon: 'skull', label: 'TKs today', value: '—' });
      cardsRow.append(cPlayers, cLayer, cMatch, cFlags, cBans, cTks);
      page.append(cardsRow);

      /* --- alerts strip --- */
      const alerts = el('div', { class: 'alerts-strip hidden' });
      page.append(alerts);
      function alertRow(f) {
        const r = el('div', { class: 'alert-row' });
        r.append(SW.ui.sevBadge(f.severity));
        r.append(SW.ui.playerLink(f.player || { name: (f.playerName || 'unknown'), dbId: f.playerId }));
        r.append(el('span', { class: 'alert-type', text: String(f.type || 'flag').replace(/_/g, ' ') }));
        r.append(SW.ui.timeAgo(f.time));
        const go = el('a', { class: 'btn ghost small', href: '#/trolls', text: 'Review' });
        r.append(go);
        return r;
      }
      function pushAlert(f) {
        alerts.classList.remove('hidden');
        pushFeed(alerts, alertRow(f), 5);
      }

      /* --- population chart --- */
      const chartCard = el('div', { class: 'card chart-card' });
      chartCard.append(el('div', { class: 'card-title', text: 'Population — last 24h' }));
      const legend = el('div', { class: 'chart-legend dim small' });
      legend.innerHTML = '<span class="lg-dot players"></span>players <span class="lg-dot queue"></span>queue';
      chartCard.append(legend);
      const popCanvas = el('canvas', { class: 'pop-chart' });
      chartCard.append(popCanvas);
      page.append(chartCard);
      let popSamples = [];
      function redrawPop() { drawPopChart(popCanvas, popSamples); }
      const onResize = () => redrawPop();
      window.addEventListener('resize', onResize);

      /* --- feeds --- */
      const feeds = el('div', { class: 'grid cols-2 feeds-row' });
      const killHead = feedHeader('Kill feed', 'kills');
      const killFeed = el('div', { class: 'feed' });
      const killCard = el('div', { class: 'card feed-card' }, killHead.el, killFeed);
      const chatHead = feedHeader('Chat feed', 'chat');
      const chatFeed = el('div', { class: 'feed' });
      const chatCard = el('div', { class: 'card feed-card' }, chatHead.el, chatFeed);
      feeds.append(killCard, chatCard);
      page.append(feeds);

      /* --- data load --- */
      (async () => {
        const o = await refreshOverview();
        if (o) {
          const counters = o.counters || {};
          cFlags.set(SW.ui.fmtNum(counters.flagsOpen || 0));
          if ((counters.flagsOpen || 0) > 0) cFlags.classList.add('accent-warn');
          cBans.set(SW.ui.fmtNum(counters.bansActive || 0));
          cTks.set(SW.ui.fmtNum(counters.tksToday || 0));
          if ((counters.tksToday || 0) > 0) cTks.classList.add('accent-red');
          const recent = o.recent || {};
          for (const k of (recent.kills || []).slice(0, 50)) killFeed.append(SW.ui.killRow(k));
          for (const c of (recent.chat || []).slice(0, 50)) chatFeed.append(SW.ui.chatRow(c));
          for (const f of (recent.flags || []).slice(0, 5).reverse()) pushAlert(f);
        }
        syncCards();
        syncLinkBanner();
        try {
          const pop = await SW.api('/api/pop?hours=24', { toast: false });
          popSamples = (pop && pop.samples) || [];
          redrawPop();
        } catch (_e) { redrawPop(); }
      })();

      function syncCards() {
        const snap = SW.state.snapshot || {};
        const si = SW.state.serverInfo || snap.serverInfo || {};
        const queue = (Number(si.publicQueue) || 0) + (Number(si.reservedQueue) || 0);
        cPlayers.set(
          (si.playerCount != null ? si.playerCount : '—') + '/' + (si.maxPlayers != null ? si.maxPlayers : '—'),
          queue > 0 ? '+' + queue + ' in queue' : 'no queue'
        );
        cLayer.set(snap.currentLayer || si.mapName || '—', 'next: ' + (snap.nextLayer || si.nextLayer || '—'));
        const tick = SW.state.tickRate != null ? SW.state.tickRate : snap.tickRate;
        cMatch.set(undefined, 'tick ' + (tick != null ? Number(tick).toFixed(1) : '—'));
        if (SW.state.tickHist.length > 1) cMatch.setSpark(SW.state.tickHist, SW.ui.cssVar('--green', '#16a34a'));
      }

      timers.push(setInterval(() => {
        const m = SW.state.snapshot && SW.state.snapshot.match;
        const start = m && (m.inProgressAt || m.in_progress_at || m.startedAt || m.started_at);
        cMatch.set(start && !(m.endedAt || m.ended_at) ? SW.ui.fmtClock((Date.now() - Number(start)) / 1000) : '--:--');
      }, 1000));

      unsubs.push(SW.live.on('kill', (k) => { if (!killHead.isPaused() && k) pushFeed(killFeed, SW.ui.killRow(k), 50); }));
      unsubs.push(SW.live.on('chat', (c) => { if (!chatHead.isPaused() && c) pushFeed(chatFeed, SW.ui.chatRow(c), 50); }));
      unsubs.push(SW.live.on('flag', (f) => { if (f) pushAlert(f); }));
      unsubs.push(SW.live.on('serverinfo', syncCards));
      unsubs.push(SW.live.on('players', syncCards));
      unsubs.push(SW.live.on('tick', syncCards));
      unsubs.push(SW.live.on('match', syncCards));
      unsubs.push(SW.live.on('status', syncLinkBanner));
      unsubs.push(SW.live.on('pop', (s) => {
        /* pop event: single sample {time, players, queue, tickRate} or array row */
        if (!s) return;
        const row = Array.isArray(s) ? s : [s.time, s.players, s.queue, s.tickRate];
        if (row[0] != null) { popSamples.push(row); redrawPop(); }
      }));
    },
    cleanup() {},
  };

  /* -------------------------------------------------------------- live view */

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

      /* admin topline: broadcast quick box + next layer quick set — each tool
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
          const lWrap = el('div', { class: 'tool-group' });
          const dl = el('datalist', { id: 'layers-dl' });
          const lInput = el('input', { class: 'input', placeholder: 'Next layer…', list: 'layers-dl', 'aria-label': 'Next layer' });
          const lBtn = el('button', { type: 'button', class: 'btn', text: 'Set next' });
          lBtn.addEventListener('click', async () => {
            const L = lInput.value.trim();
            if (!L) return;
            lBtn.disabled = true;
            try { await SW.actions.setNextLayer(L); lInput.value = ''; } catch (_e) { /* toasted */ }
            lBtn.disabled = false;
          });
          lWrap.append(lInput, dl, lBtn);
          tools.append(lWrap);
          SW.actions.fetchLayers().then((layers) => {
            dl.textContent = '';
            for (const L of layers) dl.append(el('option', { value: L }));
          }).catch(() => { /* rcon down */ });
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
        if (role) row.append(el('span', { class: 'role-tag mono', text: role }));
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
        head.append(el('span', { class: 'squad-name', text: sq.name || 'Squad' }));
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
