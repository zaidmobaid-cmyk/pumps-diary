'use strict';
/* SquadWatch — views.js (stage 2: data views)
 *
 * Registers SW.routes.players (+ profile), SW.routes.matches (+ detail),
 * SW.routes.chat and SW.routes.trolls per spec §14.3 and §19 amendments.
 *
 * Conventions (established by app.js):
 *   - SW.routes[name] = { render(el, ctx), cleanup() }; render runs with
 *     this = route def and reassigns this.cleanup; SW.live.on() unsubscribers
 *     and timers are cleared there.
 *   - CSP: script-src 'self' — NO inline handlers; everything is wired with
 *     SW.ui.el on<event> keys / addEventListener. Every dynamic string goes
 *     through textContent (or SW.esc when composed into innerHTML).
 *   - Flag details, chat messages, reasons, notes, weapon/layer names are all
 *     rendered via textContent per §19.3.25.
 */
(function () {
  const SW = window.SW;
  const el = SW.ui.el;

  /* ======================================================= shared helpers */

  /* g(obj, 'camelCase', 'snake_case', …) -> first defined value. api.js is
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
      class: 'dim small mt-s',
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

  function loading() {
    return el('div', { class: 'center pad-s' }, el('span', { class: 'spinner' }));
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

  function matchLink(matchId, label) {
    if (matchId == null) return null;
    return el('a', { class: 'small nowrap', href: '#/matches/' + encodeURIComponent(matchId), text: label || 'match' });
  }

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
  function prettyDeployable(cn) {
    if (!cn) return '';
    return String(cn).replace(/^BP_/, '').replace(/_C(_\d+)?$/, '').replace(/_/g, ' ');
  }

  /* small render atoms */

  function tkCellNode(v) {
    v = num(v);
    return v > 0 ? el('span', { class: 'td-tk-pos', text: String(v) }) : '0';
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

  /* single-select chip row: chipBar([{value,label}], active, onPick) */
  function chipBar(items, value, onPick) {
    const row = el('div', { class: 'row-wrap' });
    const btns = [];
    const api = { el: row, value };
    api.set = (v) => {
      api.value = v;
      for (const [b, val] of btns) b.classList.toggle('on', val === v);
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

  /* tabs bar + content: tabsView([{id,label,badge?,badgeKind?,hidden?,render(c)}], {active}) */
  function tabsView(defs, opts) {
    opts = opts || {};
    const visible = defs.filter((d) => !d.hidden);
    const wrap = el('div');
    const bar = el('div', { class: 'tabs', role: 'tablist' });
    const content = el('div');
    const btns = new Map();
    function set(id) {
      if (!btns.has(id)) return;
      for (const [k, b] of btns) b.classList.toggle('active', k === id);
      content.textContent = '';
      const d = visible.find((x) => x.id === id);
      try { if (d) d.render(content); } catch (e) {
        console.error('tab ' + id, e);
        content.textContent = '';
        content.append(SW.ui.empty('This tab failed to render — see the browser console'));
      }
    }
    for (const d of visible) {
      const b = el('button', { type: 'button', class: 'tab', role: 'tab' });
      b.textContent = d.label;
      if (d.badge != null && d.badge !== 0 && d.badge !== '0') b.append(SW.ui.badge(String(d.badge), d.badgeKind || 'dim'));
      b.addEventListener('click', () => set(d.id));
      btns.set(d.id, b);
      bar.append(b);
    }
    wrap.append(bar, content);
    if (visible.length) set(opts.active && btns.has(opts.active) ? opts.active : visible[0].id);
    return { el: wrap, set };
  }

  /* shared chat table */
  function chatTable(rows, opts) {
    opts = opts || {};
    const cols = [
      {
        key: 'time', label: 'Time', width: '150px',
        render: (r) => el('span', { class: 'mono small dim nowrap', text: SW.ui.fmtTime(r.time) }),
      },
      { key: 'channel', label: 'Channel', width: '72px', render: (r) => SW.ui.channelChip(r.channel) },
    ];
    if (!opts.hidePlayer) {
      cols.push({ key: 'player', label: 'Player', width: '170px', render: (r) => SW.ui.playerLink(r.player || { name: '?' }) });
    }
    cols.push({
      key: 'message', label: 'Message',
      render: (r) => { const s = el('span', { class: 'feed-msg' }); s.textContent = r.message == null ? '' : String(r.message); return s; },
    });
    if (opts.withMatch) cols.push({ key: 'match', label: 'Match', width: '64px', render: (r) => matchLink(r.matchId) });
    return SW.ui.table(cols, rows, { class: 'chat-table', emptyText: opts.emptyText || 'No chat messages' });
  }

  /* ------------------------------------------------------------ flag rows */

  const FLAG_LABELS = {
    friendly_radio: 'Friendly radio damage',
    radio_unknown: 'Radio damage (unclassified)',
    tk_spree: 'Teamkill spree',
    mass_tk: 'Mass teamkilling',
    new_player_tk: 'New-player teamkill',
    chat_watchlist: 'Watchlisted chat',
    manual: 'Manual flag',
  };
  function flagTypeLabel(t) {
    return FLAG_LABELS[t] || String(t || 'flag').replace(/_/g, ' ');
  }

  /* details may be an object (SSE) or a JSON string (DB rows) */
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

  /* flagRow(f, {hidePlayer, onReviewed}) — container must carry .flag-inbox */
  function flagRow(f, opts) {
    opts = opts || {};
    const reviewed = !!g(f, 'reviewed');
    const row = el('div', { class: 'flag-row' + (reviewed ? ' reviewed' : '') });
    row.append(SW.ui.sevBadge(g(f, 'severity')));
    const main = el('div', { class: 'grow', style: 'min-width:0' });
    const head = el('div', { class: 'row-wrap gap-s' });
    if (!opts.hidePlayer) head.append(SW.ui.playerLink(refOf(playerOfFlag(f))));
    head.append(el('b', { text: flagTypeLabel(g(f, 'type')) }));
    const mid = g(f, 'matchId', 'match_id');
    if (mid != null) head.append(matchLink(mid));
    main.append(head);
    const det = prettyDetails(g(f, 'details'));
    if (det) {
      const dEl = el('div', { class: 'flag-details' });
      dEl.textContent = det;
      main.append(dEl);
    }
    const note = g(f, 'reviewNote', 'review_note');
    if (note) main.append(el('div', { class: 'small goldc', text: 'Review note: ' + note }));
    row.append(main);
    row.append(SW.ui.timeAgo(g(f, 'time')));
    if (reviewed) {
      row.append(SW.ui.badge('reviewed', 'ok'));
    } else if (SW.can('flags')) {
      const btn = el('button', { type: 'button', class: 'btn ghost small', text: 'Review' });
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
          if (v.note) main.append(el('div', { class: 'small goldc', text: 'Review note: ' + v.note }));
          if (opts.onReviewed) opts.onReviewed(f);
        } catch (_e) { btn.disabled = false; /* toasted by SW.api */ }
      });
      row.append(btn);
    }
    return row;
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
      cols.push({ key: 'player', label: 'Player', render: (r) => SW.ui.playerLink(r.player || { name: 'unknown' }) });
    }
    cols.push(
      { key: 'label', label: 'Deployable', render: (r) => r.label || r.deployable || '—' },
      { key: 'category', label: 'Type', render: (r) => catBadge(r.category) },
      { key: 'friendly', label: 'Side', sortable: true, sortVal: (r) => num(r.friendly), render: (r) => sideBadge(r.friendly) },
      { key: 'damage', label: 'Damage', align: 'right', sortable: true, sortVal: (r) => num(r.damage), render: (r) => fmtDmg(r.damage) },
      { key: 'weapon', label: 'Weapon', class: 'mono', render: (r) => r.weapon || r.damageType || '—' }
    );
    if (opts.withMatch) cols.push({ key: 'match', label: 'Match', render: (r) => matchLink(r.matchId) });
    return SW.ui.table(cols, rows, {
      sort: { key: 'time', dir: 'desc' },
      rowClass: (r) => (num(r.friendly) === 1 && r.category === 'radio' ? 'radio-row' : ''),
      emptyText: opts.emptyText || 'No deployable damage recorded',
    });
  }

  function matchDur(m) {
    const a = num(g(m, 'startedAt', 'started_at'));
    if (!a) return '—';
    const b = g(m, 'endedAt', 'ended_at');
    return SW.ui.fmtDur(((b ? num(b) : Date.now()) - a) / 1000);
  }

  /* ========================================================= PLAYERS list */

  const PLAYER_SORT_KEYS = ['last_seen', 'kills', 'teamkills', 'radio', 'playtime'];
  const PLAYER_FILTERS = ['online', 'flagged', 'watchlisted', 'banned'];

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

    const view = el('div', { class: 'view view-players' });
    main.append(view);

    /* toolbar: search + filter chips */
    const search = el('input', {
      class: 'input', type: 'search', value: q,
      placeholder: 'Search name / steamId / eosId…', 'aria-label': 'Search players',
    });
    const sbox = el('div', { class: 'search-box' });
    sbox.innerHTML = SW.icon('search');
    sbox.append(search);
    const chips = chipBar([
      { value: '', label: 'All' },
      { value: 'online', label: 'Online' },
      { value: 'flagged', label: 'Flagged' },
      { value: 'watchlisted', label: 'Watchlisted' },
      { value: 'banned', label: 'Banned' },
    ], filter, (v) => { filter = v; page = 0; load(); });
    view.append(el('div', { class: 'players-toolbar card' }, sbox, chips.el));

    function nameCell(r) {
      const wrap = el('span', { class: 'row gap-s nowrap' });
      wrap.append(el('span', { class: r.online ? 'online-dot' : 'offline-dot', title: r.online ? 'online now' : 'offline' }));
      wrap.append(SW.ui.playerLink(refOf(r)));
      if (r.watchlisted) wrap.append(el('span', { class: 'watch-star', html: SW.icon('star'), title: 'Watchlisted' }));
      if (g(r, 'bannedActive', 'banned_active')) wrap.append(SW.ui.badge('banned', 'red'));
      return wrap;
    }

    const cols = [
      { key: 'name', label: 'Player', render: nameCell },
      { key: 'kills', label: 'Kills', sortable: true, align: 'right', render: (r) => num(r.kills) },
      { key: 'deaths', label: 'Deaths', align: 'right', render: (r) => num(r.deaths) },
      { key: 'kd', label: 'K/D', align: 'right', render: (r) => kdText(r.kills, r.deaths) },
      { key: 'teamkills', label: 'TKs', sortable: true, align: 'right', render: (r) => tkCellNode(r.teamkills) },
      { key: 'tkDeaths', label: 'TK deaths', align: 'right', render: (r) => num(g(r, 'tkDeaths', 'tk_deaths')) },
      {
        key: 'radio', label: 'Radio dmg', sortable: true, align: 'right',
        render: (r) => {
          const v = num(g(r, 'radioFriendly', 'radio_damage_friendly'));
          return v > 0 ? el('span', { class: 'purplec', text: fmtDmg(v) }) : '0';
        },
      },
      {
        key: 'playtime', label: 'Playtime', sortable: true, align: 'right',
        render: (r) => SW.ui.fmtDur(g(r, 'playSeconds', 'play_seconds')),
      },
      {
        key: 'flags', label: 'Flags', align: 'right',
        render: (r) => {
          const n = num(g(r, 'flagsOpen', 'flags_open'));
          return n > 0 ? SW.ui.badge(String(n), 'warn') : '—';
        },
      },
      {
        key: 'last_seen', label: 'Last seen', sortable: true,
        render: (r) => SW.ui.timeAgo(g(r, 'lastSeen', 'last_seen')),
      },
    ];

    const tbl = SW.ui.table(cols, [], {
      sort, storeKey: 'players',
      onSort: (key, dir) => { sort = { key, dir }; page = 0; load(); },
      onRowClick: (r) => { const pid = g(r, 'id', 'dbId'); if (pid != null) SW.navigate('#/players/' + pid); },
      rowClass: (r) => (r.watchlisted ? 'watch-row' : ''),
      emptyText: 'No players found',
    });
    const pagerBox = el('div');
    view.append(tbl, pagerBox);

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
      let r;
      try { r = await SW.api('/api/players?' + params.toString()); } catch (_e) { return; }
      if (my !== seq) return;
      const rows = (r && r.rows) || [];
      perGuess = Math.max(perGuess, rows.length);
      tbl.update(rows);
      pagerBox.textContent = '';
      pagerBox.append(SW.ui.pager({
        page, per: perGuess, total: num(r && r.total),
        onPage: (p) => { page = p; load(); },
      }));
    }
    load();
  }

  /* ======================================================= PLAYER profile */

  function renderProfile(main, ctx) {
    const unsubs = [];
    this.cleanup = () => { unsubs.forEach((u) => u()); };
    const id = ctx.args[0];
    const view = el('div', { class: 'view view-profile' });
    main.append(view);
    view.append(loading());
    (async () => {
      let d;
      try { d = await SW.api('/api/players/' + encodeURIComponent(id)); }
      catch (e) {
        view.textContent = '';
        view.append(SW.ui.empty(e && e.status === 404 ? 'No such player' : 'Could not load this player', 'user'));
        return;
      }
      view.textContent = '';
      buildProfile(view, d || {}, id);
    })();
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

    /* ---- header card ---- */
    const head = el('div', { class: 'card profile-head' });
    const av = el('div', { class: 'avatar' });
    const avatarUrl = g(p, 'avatar');
    if (avatarUrl) {
      const img = el('img', { src: avatarUrl, alt: '' });
      img.addEventListener('error', () => { img.remove(); av.textContent = initials(ref.name); });
      av.append(img);
    } else {
      av.textContent = initials(ref.name);
    }

    const namesCol = el('div', { class: 'profile-names' });
    const h1 = el('h1');
    if (d.online) h1.append(el('span', { class: 'online-dot', title: 'online now' }));
    h1.append(el('span', { text: ref.name }));
    const star = el('span', { class: 'watch-star' + (ref.watchlisted ? '' : ' hidden'), html: SW.icon('star'), title: 'Watchlisted' });
    h1.append(star);
    namesCol.append(h1);

    const pastNames = uniq(listOf(d.names).map((n) => g(n, 'name')).filter((n) => n && n !== ref.name));
    if (pastNames.length) {
      namesCol.append(el('div', { class: 'past-names', text: 'Also seen as: ' + pastNames.join(', ') }));
    }

    function idRow(label, value, link) {
      const r = el('div', { class: 'id-row' });
      r.append(el('span', { class: 'faint', text: label }));
      r.append(el('span', { class: 'ellipsis', text: value }));
      r.append(SW.ui.copyBtn(value));
      if (link) r.append(el('a', { href: link, target: '_blank', rel: 'noopener noreferrer', text: 'steamcommunity' }));
      return r;
    }
    if (ref.eosId) namesCol.append(idRow('EOS', ref.eosId));
    if (ref.steamId) namesCol.append(idRow('Steam', ref.steamId, 'https://steamcommunity.com/profiles/' + encodeURIComponent(ref.steamId)));

    const meta = el('div', { class: 'id-row' });
    meta.append(el('span', { class: 'faint', text: 'first seen' }));
    meta.append(el('span', { text: SW.ui.fmtTime(g(p, 'firstSeen', 'first_seen')) }));
    meta.append(el('span', { class: 'faint', text: 'last seen' }));
    meta.append(SW.ui.timeAgo(g(p, 'lastSeen', 'last_seen')));
    if (d.online && d.session) {
      const since = g(d.session, 'connectAt', 'connect_at');
      if (since) meta.append(el('span', { class: 'good', text: 'online since ' + SW.ui.timeAgoText(since).replace(' ago', '') + ' ago' }));
    }
    namesCol.append(meta);

    /* actions — each button behind its own granular perm (§1) */
    const actions = el('div', { class: 'profile-actions' });
    if (SW.can('flags')) {
      const watchBtn = el('button', { type: 'button', class: 'btn ghost small' });
      const syncWatch = () => {
        watchBtn.innerHTML = SW.icon('star') + '<span>' + (ref.watchlisted ? 'Watching' : 'Watch') + '</span>';
        watchBtn.classList.toggle('goldc', !!ref.watchlisted);
        star.classList.toggle('hidden', !ref.watchlisted);
      };
      syncWatch();
      watchBtn.addEventListener('click', async () => {
        await SW.actions.watch(ref, !ref.watchlisted);
        syncWatch();
      });
      actions.append(watchBtn);
    }
    {
      const mk = (label, icon, fn, danger) => {
        const b = el('button', { type: 'button', class: 'btn small' + (danger ? ' danger ghost' : '') });
        b.innerHTML = SW.icon(icon) + '<span>' + SW.esc(label) + '</span>';
        b.addEventListener('click', fn);
        return b;
      };
      if (SW.can('warn')) actions.append(mk('Warn', 'warn', () => SW.actions.warn(ref)));
      if (SW.can('kick')) actions.append(mk('Kick', 'kick', () => SW.actions.kick(ref)));
      if (SW.can('ban')) actions.append(mk('Ban', 'ban', () => SW.actions.ban(ref), true));
      if (SW.can('team')) actions.append(mk('Force team', 'swap', () => SW.actions.forceTeam(ref)));
      if (SW.can('squad')) actions.append(mk('Unsquad', 'x', () => SW.actions.removeFromSquad(ref)));
      if (SW.can('notes')) actions.append(mk('Note', 'note', () => SW.actions.note(ref)));
      if (SW.can('flags')) actions.append(mk('Flag', 'flag', manualFlag));
    }
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

    head.append(av, namesCol, actions);

    /* ---- stat grid ---- */
    function mini(label, value, cls) {
      const m = el('div', { class: 'mini-stat' + (cls ? ' ' + cls : '') });
      m.append(el('div', { class: 'v', text: value == null ? '—' : String(value) }));
      m.append(el('div', { class: 'l', text: label }));
      return m;
    }
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
    const grid = el('div', { class: 'stat-grid' });
    grid.append(
      mini('Kills', SW.ui.fmtNum(kills)),
      mini('Deaths', SW.ui.fmtNum(deaths)),
      mini('K/D', kdText(kills, deaths)),
      mini('Teamkills', SW.ui.fmtNum(tks), tks > 0 ? 'bad' : ''),
      mini('TK deaths', SW.ui.fmtNum(tkd)),
      mini('Suicides', SW.ui.fmtNum(sui)),
      mini('Revives given', SW.ui.fmtNum(rg), rg > 0 ? 'good' : ''),
      mini('Revives taken', SW.ui.fmtNum(rt)),
      mini('Radio dmg — friendly', fmtDmg(rdf), rdf > 0 ? 'purple' : ''),
      mini('Radio dmg — enemy', fmtDmg(rde)),
      mini('HAB dmg — friendly', fmtDmg(hdf), hdf > 0 ? 'purple' : ''),
      mini('HAB dmg — enemy', fmtDmg(hde)),
      mini('Playtime', SW.ui.fmtDur(g(p, 'playSeconds', 'play_seconds')))
    );

    /* ---- tab data ---- */
    const recentKills = listOf(d.recentKills).map(normKill);
    const recentDeaths = listOf(d.recentDeaths).map(normKill);
    const tkList = listOf(d.tkIncidents).map(normKill);
    const depList = listOf(d.deployableDamage);
    const matchesList = listOf(d.matches);
    const warningsList = listOf(d.warnings);
    const bansList = listOf(d.bans);
    const flagsList = listOf(d.flags);
    const notesList = listOf(d.notes);
    const chatCount = num(g(d, 'chatCount', 'chat_count'));

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
      if (!merged.length) { c.append(SW.ui.empty('No recent kills or deaths', 'swords')); return; }
      const feed = el('div', { class: 'feed' });
      for (const k of merged.slice(0, 100)) {
        const row = SW.ui.killRow(k);
        const ml = matchLink(k.matchId);
        if (ml) row.append(ml);
        feed.append(row);
      }
      c.append(el('div', { class: 'card' }, el('div', { class: 'card-title', text: 'Recent kills & deaths' }), feed));
    }

    function renderMatchesTab(c) {
      const cols = [
        { key: 'layer', label: 'Layer', render: (r) => g(r, 'layer') || '—' },
        {
          key: 'startedAt', label: 'Started', sortable: true,
          sortVal: (r) => num(g(r, 'startedAt', 'started_at')),
          render: (r) => SW.ui.timeAgo(g(r, 'startedAt', 'started_at')),
        },
        { key: 'teamId', label: 'Team', render: (r) => teamBadge(g(r, 'teamId', 'team_id')) },
        { key: 'kills', label: 'K', sortable: true, align: 'right', sortVal: (r) => num(r.kills), render: (r) => num(r.kills) },
        { key: 'deaths', label: 'D', sortable: true, align: 'right', sortVal: (r) => num(r.deaths), render: (r) => num(r.deaths) },
        { key: 'teamkills', label: 'TK', sortable: true, align: 'right', sortVal: (r) => num(r.teamkills), render: (r) => tkCellNode(r.teamkills) },
        { key: 'revives', label: 'Revives', align: 'right', render: (r) => num(r.revives) },
        { key: 'damage', label: 'Damage', align: 'right', sortable: true, sortVal: (r) => num(g(r, 'damage', 'damageDealt', 'damage_dealt')), render: (r) => fmtDmg(g(r, 'damage', 'damageDealt', 'damage_dealt')) },
      ];
      c.append(SW.ui.table(cols, matchesList, {
        sort: { key: 'startedAt', dir: 'desc' },
        onRowClick: (r) => { const mid = g(r, 'matchId', 'match_id', 'id'); if (mid != null) SW.navigate('#/matches/' + mid); },
        emptyText: 'No matches recorded for this player',
      }));
    }

    function renderIncidents(c) {
      /* teamkills */
      const tkSec = SW.ui.section('Teamkills (' + SW.ui.fmtNum(totalOf(d.tkIncidents)) + ')');
      if (tkList.length) {
        const feed = el('div', { class: 'feed' });
        for (const k of tkList.slice().sort((a, b) => num(b.time) - num(a.time))) {
          const row = SW.ui.killRow(k);
          const ml = matchLink(k.matchId);
          if (ml) row.append(ml);
          feed.append(row);
        }
        tkSec.append(el('div', { class: 'card' }, feed));
        const tn = truncNote(d.tkIncidents, 'teamkills');
        if (tn) tkSec.append(tn);
      } else {
        tkSec.append(el('div', { class: 'dim small', text: 'No teamkills recorded.' }));
      }
      /* deployable damage */
      const depSec = SW.ui.section('Deployable damage (' + SW.ui.fmtNum(totalOf(d.deployableDamage)) + ')');
      depSec.append(deployablesTable(depList, { withMatch: true }));
      const dn = truncNote(d.deployableDamage, 'deployable-damage events');
      if (dn) depSec.append(dn);
      c.append(tkSec, depSec);
    }

    function renderChatTab(c) {
      let page = 0;
      let perGuess = 50;
      let seqc = 0;
      const box = el('div');
      const link = el('a', {
        class: 'small',
        href: '#/chat?playerId=' + encodeURIComponent(id) + '&player=' + encodeURIComponent(ref.name),
        text: 'Open in chat search',
      });
      c.append(el('div', { class: 'row mb-s', style: 'justify-content:flex-end' }, link), box);
      async function loadChat() {
        const my = ++seqc;
        box.textContent = '';
        box.append(loading());
        let r;
        try { r = await SW.api('/api/players/' + encodeURIComponent(id) + '/chat?page=' + page + '&per=50'); }
        catch (_e) { box.textContent = ''; box.append(SW.ui.empty('Could not load chat history', 'chat')); return; }
        if (my !== seqc) return;
        box.textContent = '';
        const rows = ((r && r.rows) || []).map(normChat);
        perGuess = Math.max(perGuess, rows.length);
        box.append(chatTable(rows, { hidePlayer: true, withMatch: true, emptyText: 'No chat messages from this player' }));
        const total = num(r && r.total);
        if (total > rows.length || page > 0) {
          box.append(SW.ui.pager({ page, per: perGuess, total, onPage: (pg) => { page = pg; loadChat(); } }));
        }
      }
      loadChat();
    }

    function renderSessions(c) {
      const sTbl = SW.ui.table([
        { key: 'connect', label: 'Connected', render: (r) => SW.ui.fmtTime(g(r, 'connectAt', 'connect_at')) },
        {
          key: 'disconnect', label: 'Disconnected',
          render: (r) => {
            const dc = g(r, 'disconnectAt', 'disconnect_at');
            return dc ? SW.ui.fmtTime(dc) : SW.ui.badge('online', 'green');
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

      const ipTbl = SW.ui.table([
        {
          key: 'ip', label: 'IP',
          render: (r) => el('span', { class: 'row gap-s' }, el('span', { class: 'mono', text: r.ip || '' }), SW.ui.copyBtn(r.ip || '')),
        },
        { key: 'times', label: 'Connections', align: 'right', render: (r) => num(r.times) },
        { key: 'firstSeen', label: 'First seen', render: (r) => SW.ui.fmtTime(g(r, 'firstSeen', 'first_seen')) },
        { key: 'lastSeen', label: 'Last seen', render: (r) => SW.ui.timeAgo(g(r, 'lastSeen', 'last_seen')) },
      ], listOf(d.ips), { emptyText: 'No IP addresses recorded' });

      const altTbl = SW.ui.table([
        { key: 'name', label: 'Player', render: (r) => SW.ui.playerLink(refOf(r)) },
        { key: 'sharedIps', label: 'Shared IPs', align: 'right', render: (r) => num(g(r, 'sharedIps', 'shared_ips')) },
      ], listOf(d.alts), {
        onRowClick: (r) => { const pid = g(r, 'playerId', 'player_id', 'id'); if (pid != null) SW.navigate('#/players/' + pid); },
        emptyText: 'No other accounts share an IP with this player',
      });

      c.append(
        SW.ui.section('Sessions', sTbl),
        SW.ui.section('IP addresses', ipTbl),
        SW.ui.section('Possible alts (shared IPs)', altTbl)
      );
    }

    function isPermBan(r) {
      const raw = g(r, 'intervalRaw', 'interval_raw');
      if (raw != null) return String(raw) === '0';
      return !g(r, 'expiresAt', 'expires_at');
    }
    function banStatus(r) {
      if (g(r, 'unbannedAt', 'unbanned_at')) return SW.ui.badge('unbanned', 'dim');
      const active = num(g(r, 'active'));
      const ex = g(r, 'expiresAt', 'expires_at');
      const live = active === 1 && (isPermBan(r) || num(ex) > Date.now());
      return live ? SW.ui.badge('active', 'red') : SW.ui.badge('expired', 'dim');
    }

    function renderDiscipline(c) {
      const warnTbl = SW.ui.table([
        { key: 'time', label: 'Time', width: '140px', render: (r) => SW.ui.timeAgo(r.time) },
        {
          key: 'message', label: 'Message',
          render: (r) => {
            const s = el('span', { class: 'row-wrap gap-s' });
            const t = el('span');
            t.textContent = r.message == null ? '' : String(r.message);
            s.append(t);
            if (g(r, 'auto')) s.append(SW.ui.badge('auto', 'dim'));
            return s;
          },
        },
      ], warningsList, { emptyText: 'No warnings' });

      const banTbl = SW.ui.table([
        { key: 'issued', label: 'Issued', render: (r) => SW.ui.fmtTime(g(r, 'issuedAt', 'issued_at')) },
        {
          key: 'duration', label: 'Duration',
          render: (r) => {
            if (isPermBan(r)) return el('span', { class: 'ban-perm', text: 'permanent' });
            const raw = g(r, 'intervalRaw', 'interval_raw');
            if (raw) return String(raw);
            const ds = num(g(r, 'durationSec', 'duration_sec'));
            return ds ? SW.ui.fmtDur(ds) : '—';
          },
        },
        {
          key: 'expires', label: 'Expires',
          render: (r) => {
            if (isPermBan(r)) return el('span', { class: 'ban-perm', text: 'never' });
            const ex = num(g(r, 'expiresAt', 'expires_at'));
            if (!ex) return '—';
            if (ex > Date.now() && num(g(r, 'active')) === 1) {
              return el('span', { class: 'ban-countdown', text: 'in ' + SW.ui.fmtDur((ex - Date.now()) / 1000) });
            }
            return SW.ui.fmtTime(ex);
          },
        },
        { key: 'reason', label: 'Reason', render: (r) => (r.reason == null ? '—' : String(r.reason)) },
        { key: 'status', label: 'Status', render: banStatus },
      ], bansList, { emptyText: 'No bans' });

      const flagBox = flagsList.length
        ? el('div', { class: 'card flag-inbox' })
        : SW.ui.empty('No flags on this player', 'flag');
      if (flagsList.length) for (const f of sortFlags(flagsList)) flagBox.append(flagRow(f, { hidePlayer: true }));

      c.append(
        SW.ui.section('Warnings (' + warningsList.length + ')', warnTbl),
        SW.ui.section('Bans (' + bansList.length + ')', banTbl),
        SW.ui.section('Flags (' + flagsList.length + ')', flagBox)
      );
    }

    function renderNotes(c) {
      const box = el('div', { class: 'card' });
      const list = el('div');
      let emptyEl = null;
      function noteRow(n) {
        const r = el('div', { class: 'feed-row' });
        const body = el('div', { class: 'grow', style: 'min-width:0' });
        const t = el('div', { style: 'white-space:pre-wrap;word-break:break-word' });
        t.textContent = n.text == null ? '' : String(n.text);
        body.append(t);
        const by = g(n, 'byUsername', 'username', 'byUser', 'by_user');
        const byTxt = by == null ? '' : (typeof by === 'number' ? 'by user #' + by + ' · ' : 'by ' + by + ' · ');
        body.append(el('div', { class: 'faint small', text: byTxt + SW.ui.fmtTime(n.time) }));
        r.append(body);
        return r;
      }
      if (SW.can('notes')) {
        const ta = el('textarea', { class: 'input', rows: '3', placeholder: 'Add a note visible to admins…', 'aria-label': 'New note' });
        const save = el('button', { type: 'button', class: 'btn primary small', text: 'Save note' });
        save.addEventListener('click', async () => {
          const text = ta.value.trim();
          if (!text) return;
          save.disabled = true;
          try {
            const r = await SW.api('/api/players/' + encodeURIComponent(id) + '/notes', { method: 'POST', body: { text } });
            ta.value = '';
            if (emptyEl) { emptyEl.remove(); emptyEl = null; }
            list.prepend(noteRow((r && r.note) || { text, time: Date.now() }));
            SW.ui.toast('Note saved', 'ok');
          } catch (_e) { /* toasted by SW.api */ }
          save.disabled = false;
        });
        box.append(el('div', { class: 'col mb-m' }, ta, el('div', { class: 'row', style: 'justify-content:flex-end' }, save)));
      }
      if (!notesList.length) {
        emptyEl = SW.ui.empty('No notes yet', 'note');
        list.append(emptyEl);
      } else {
        for (const n of notesList.slice().sort((a, b) => num(b.time) - num(a.time))) list.append(noteRow(n));
      }
      box.append(list);
      c.append(box);
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
      {
        id: 'discipline', label: 'Discipline',
        badge: (warningsList.length + bansList.length + flagsList.length) || null,
        render: renderDiscipline,
      },
      { id: 'notes', label: 'Notes', badge: notesList.length || null, render: renderNotes },
    ]);

    view.append(head, grid, tabs.el);
  }

  /* ========================================================= MATCHES list */

  function matchResultCell(r) {
    const ended = g(r, 'endedAt', 'ended_at');
    const wt = num(g(r, 'winnerTeam', 'winner_team'));
    if (!wt && !ended) return SW.ui.badge('live', 'green');
    if (!wt) return SW.ui.badge('no result', 'dim');
    const wrap = el('span', { class: 'row-wrap gap-s' });
    wrap.append(teamBadge(wt, (g(r, 'winnerFaction', 'winner_faction') || 'Team ' + wt) + ' won'));
    const tk = g(r, 'tickets');
    if (tk != null) wrap.append(el('span', { class: 'mono dim small nowrap', text: '+' + num(tk) + ' tickets' }));
    return wrap;
  }

  function renderMatchesList(main, ctx) {
    const unsubs = [];
    let reloadTimer = null;
    this.cleanup = () => {
      unsubs.forEach((u) => u());
      if (reloadTimer) { clearTimeout(reloadTimer); reloadTimer = null; }
    };
    let page = 0;
    let perGuess = 50;
    let seq = 0;
    const view = el('div', { class: 'view view-matches' });
    main.append(view);

    const cols = [
      {
        key: 'layer', label: 'Layer',
        render: (r) => el('span', { class: 'row gap-s' },
          el('b', { text: g(r, 'layer') || '—' }),
          g(r, 'level') ? el('span', { class: 'faint small', text: g(r, 'level') }) : null),
      },
      { key: 'startedAt', label: 'Started', render: (r) => SW.ui.timeAgo(g(r, 'startedAt', 'started_at')) },
      { key: 'duration', label: 'Duration', align: 'right', render: matchDur },
      { key: 'result', label: 'Result', render: matchResultCell },
      { key: 'players', label: 'Players', align: 'right', render: (r) => num(r.players) },
      { key: 'kills', label: 'Kills', align: 'right', render: (r) => num(r.kills) },
      { key: 'teamkills', label: 'TKs', align: 'right', render: (r) => tkCellNode(r.teamkills) },
    ];
    const tbl = SW.ui.table(cols, [], {
      onRowClick: (r) => { const mid = g(r, 'id', 'matchId'); if (mid != null) SW.navigate('#/matches/' + mid); },
      emptyText: 'No matches recorded yet',
    });
    const pagerBox = el('div');
    view.append(tbl, pagerBox);

    async function load() {
      const my = ++seq;
      let r;
      try { r = await SW.api('/api/matches?page=' + page + '&per=50'); } catch (_e) { return; }
      if (my !== seq) return;
      const rows = (r && r.rows) || [];
      perGuess = Math.max(perGuess, rows.length);
      tbl.update(rows);
      pagerBox.textContent = '';
      pagerBox.append(SW.ui.pager({
        page, per: perGuess, total: num(r && r.total),
        onPage: (p) => { page = p; load(); },
      }));
    }

    /* a NEW_GAME / ROUND_ENDED while watching page 1 refreshes the list */
    unsubs.push(SW.live.on('match', () => {
      if (page !== 0 || reloadTimer) return;
      reloadTimer = setTimeout(() => { reloadTimer = null; load(); }, 1500);
    }));

    load();
  }

  /* ======================================================== MATCH detail */

  function renderMatchDetail(main, ctx) {
    this.cleanup = () => {};
    const id = ctx.args[0];
    const view = el('div', { class: 'view view-match' });
    main.append(view);
    view.append(loading());
    (async () => {
      let d;
      try { d = await SW.api('/api/matches/' + encodeURIComponent(id)); }
      catch (e) {
        view.textContent = '';
        view.append(SW.ui.empty(e && e.status === 404 ? 'No such match' : 'Could not load this match', 'swords'));
        return;
      }
      view.textContent = '';
      buildMatch(view, d || {});
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

    /* header */
    const head = el('div', { class: 'card' });
    head.append(el('h1', { text: g(m, 'layer') || 'Match' }));
    const metaRow = el('div', { class: 'row-wrap dim small' });
    if (g(m, 'level')) metaRow.append(el('span', { text: 'level ' + g(m, 'level') }));
    metaRow.append(el('span', { text: SW.ui.fmtTime(started) }));
    metaRow.append(el('span', { text: 'duration ' + matchDur(m) }));
    metaRow.append(el('span', { class: 'row gap-s' }, teamBadge(1, team1), el('span', { class: 'faint', text: 'vs' }), teamBadge(2, team2)));
    head.append(metaRow);

    /* result banner */
    let banner;
    if (winnerTeam === 1 || winnerTeam === 2) {
      banner = el('div', { class: 'result-banner team' + winnerTeam });
      banner.append(el('span', { html: SW.icon('flag') }));
      banner.append(el('span', { text: (g(m, 'winnerFaction', 'winner_faction') || (winnerTeam === 1 ? team1 : team2)) + ' won the match' }));
      if (g(m, 'tickets') != null) banner.append(el('span', { class: 'tickets', text: num(g(m, 'tickets')) + ' tickets' }));
    } else if (!ended) {
      banner = el('div', { class: 'result-banner' });
      banner.append(el('span', { class: 'online-dot' }));
      banner.append(el('span', { text: 'Match in progress' }));
      banner.append(el('span', { class: 'tickets', text: matchDur(m) }));
    } else {
      banner = el('div', { class: 'result-banner', style: 'border-color:var(--line);background:transparent' });
      banner.append(el('span', { class: 'dim', text: 'Match ended — no result recorded' }));
    }

    /* scoreboard */
    const sbRows = listOf(d.scoreboard).map(normScore);
    function scoreCol(teamId, teamName) {
      const rows = sbRows.filter((r) => r.teamId === teamId);
      const col = el('div');
      col.append(el('div', { class: 'card-title' },
        teamBadge(teamId),
        el('span', { class: 'ellipsis', text: teamName }),
        el('span', { class: 'faint', text: rows.length + ' players' })));
      const cols = [
        { key: 'name', label: 'Player', render: (r) => SW.ui.playerLink({ dbId: r.playerId, name: r.name, eosId: r.eosId, steamId: r.steamId }) },
        { key: 'kills', label: 'K', sortable: true, align: 'right' },
        { key: 'deaths', label: 'D', sortable: true, align: 'right' },
        { key: 'teamkills', label: 'TK', sortable: true, align: 'right', render: (r) => tkCellNode(r.teamkills) },
        { key: 'revives', label: 'Rev', sortable: true, align: 'right' },
        { key: 'damage', label: 'Dmg', sortable: true, align: 'right', sortVal: (r) => r.damage, render: (r) => fmtDmg(r.damage) },
      ];
      col.append(SW.ui.table(cols, rows, {
        class: 'score-t' + teamId,
        sort: { key: 'kills', dir: 'desc' },
        emptyText: 'No players recorded',
      }));
      return col;
    }
    const sbWrap = el('div', { class: 'scoreboard' }, scoreCol(1, team1), scoreCol(2, team2));

    /* tabs */
    const kills = listOf(d.kills).map(normKill);
    const deps = listOf(d.deployables);
    const chat = listOf(d.chat).map(normChat);
    const flags = listOf(d.flags);

    function renderKillsTab(c) {
      let tkOnly = false;
      const chips = chipBar([
        { value: false, label: 'All kills' },
        { value: true, label: 'TK only' },
      ], false, (v) => { tkOnly = v; drawFeed(); });
      const card = el('div', { class: 'card' });
      const feed = el('div', { class: 'feed' });
      card.append(feed);
      function drawFeed() {
        feed.textContent = '';
        const rows = tkOnly ? kills.filter((k) => k && k.teamkill) : kills;
        if (!rows.length) {
          feed.append(SW.ui.empty(tkOnly ? 'No teamkills this match' : 'No kills recorded', 'swords'));
          return;
        }
        for (const k of rows) feed.append(SW.ui.killRow(k));
      }
      drawFeed();
      c.append(el('div', { class: 'mb-s' }, chips.el), card, truncNote(d.kills, 'kills'));
    }

    function renderDepsTab(c) {
      const depRows = deps.map(normDep);
      let cat = '';
      let friendlyOnly = false;
      const catChips = chipBar([
        { value: '', label: 'All' },
        { value: 'radio', label: 'Radio' },
        { value: 'hab', label: 'HAB' },
        { value: 'other', label: 'Other' },
      ], '', (v) => { cat = v; draw(); });
      const fChip = el('button', { type: 'button', class: 'chip', text: 'Friendly only' });
      fChip.addEventListener('click', () => {
        friendlyOnly = !friendlyOnly;
        fChip.classList.toggle('on', friendlyOnly);
        draw();
      });
      const holder = el('div');
      function draw() {
        holder.textContent = '';
        let rows = depRows;
        if (cat) rows = rows.filter((r) => r.category === cat);
        if (friendlyOnly) rows = rows.filter((r) => r.friendly === 1);
        holder.append(deployablesTable(rows, { withPlayer: true, emptyText: 'No deployable damage matches this filter' }));
      }
      draw();
      c.append(el('div', { class: 'row-wrap mb-s' }, catChips.el, fChip), holder, truncNote(d.deployables, 'deployable-damage events'));
    }

    function renderChatTab(c) {
      c.append(chatTable(chat, { emptyText: 'No chat during this match' }), truncNote(d.chat, 'chat messages'));
    }

    function renderFlagsTab(c) {
      if (!flags.length) { c.append(SW.ui.empty('No flags raised this match', 'flag')); return; }
      const wrap = el('div', { class: 'card flag-inbox' });
      for (const f of sortFlags(flags)) wrap.append(flagRow(f));
      c.append(wrap);
    }

    const tabs = tabsView([
      { id: 'kills', label: 'Kill feed', badge: totalOf(d.kills) || null, render: renderKillsTab },
      { id: 'deployables', label: 'Deployables', badge: totalOf(d.deployables) || null, render: renderDepsTab },
      { id: 'chat', label: 'Chat', badge: totalOf(d.chat) || null, render: renderChatTab },
      { id: 'flags', label: 'Flags', badge: totalOf(d.flags) || null, badgeKind: flags.length ? 'warn' : 'dim', render: renderFlagsTab },
    ]);

    view.append(head, banner, SW.ui.section('Scoreboard', sbWrap), tabs.el);
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

    const view = el('div', { class: 'view view-chat' });
    main.append(view);

    /* filters */
    const chanItems = [
      { value: '', label: 'All channels' },
      { value: 'all', label: 'All chat' },
      { value: 'team', label: 'Team' },
      { value: 'squad', label: 'Squad' },
    ];
    if (SW.can('adminChat')) chanItems.push({ value: 'admin', label: 'Admin' });
    const chanChips = chipBar(chanItems, channel, (v) => { channel = v; page = 0; load(); });

    const sInput = el('input', {
      class: 'input', type: 'search', value: q,
      placeholder: 'Search messages…', 'aria-label': 'Search chat messages',
    });
    const sbox = el('div', { class: 'search-box' });
    sbox.innerHTML = SW.icon('search');
    sbox.append(sInput);

    const dl = el('datalist', { id: 'chat-player-dl' });
    const pInput = el('input', {
      class: 'input', list: 'chat-player-dl', autocomplete: 'off',
      placeholder: 'Filter by player…', 'aria-label': 'Filter by player',
    });
    if (ctx.query && ctx.query.player) pInput.value = ctx.query.player;
    else if (playerId) pInput.value = '#' + playerId;
    const clearP = el('button', { type: 'button', class: 'icon-btn', html: SW.icon('x'), title: 'Clear player filter', 'aria-label': 'Clear player filter' });
    clearP.addEventListener('click', () => {
      pInput.value = '';
      if (playerId) { playerId = ''; page = 0; load(); }
    });

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

    view.append(el('div', { class: 'players-toolbar chat-filters card' },
      chanChips.el,
      sbox,
      el('div', { class: 'row gap-s', style: 'flex:0 1 240px;min-width:160px' }, pInput, dl, clearP)));

    const tbl = chatTable([], { withMatch: true, emptyText: 'No chat messages match' });
    const pagerBox = el('div');
    const liveNote = el('div', { class: 'faint small', text: 'Live — new messages appear at the top of page 1 while no filter is set.' });
    view.append(tbl, pagerBox, liveNote);

    function unfiltered() { return page === 0 && !q && !channel && !playerId; }
    function renderPager() {
      pagerBox.textContent = '';
      pagerBox.append(SW.ui.pager({
        page, per: perGuess, total,
        onPage: (p) => { page = p; load(); },
      }));
    }

    async function load() {
      const my = ++seq;
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (channel) params.set('channel', channel);
      if (playerId) params.set('playerId', playerId);
      params.set('page', String(page));
      params.set('per', String(per));
      let r;
      try { r = await SW.api('/api/chat?' + params.toString()); } catch (_e) { return; }
      if (my !== seq) return;
      rows = ((r && r.rows) || []).map(normChat);
      total = num(r && r.total);
      perGuess = Math.max(perGuess, rows.length);
      tbl.update(rows);
      renderPager();
      liveNote.classList.toggle('hidden', !unfiltered());
    }

    /* live append on page 1 when unfiltered (admin rows never reach viewers —
     * the API/SSE already excludes them per §19.3.23) */
    unsubs.push(SW.live.on('chat', (c) => {
      if (!c || !unfiltered()) return;
      rows.unshift(normChat(c));
      if (rows.length > per) rows.pop();
      total++;
      tbl.update(rows);
      renderPager();
    }));

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

  function lbCard(title, icon, rows, valKeys, opts) {
    opts = opts || {};
    const wrap = el('div', { class: 'card' });
    wrap.append(el('div', { class: 'card-title' }, el('span', { html: SW.icon(icon) }), el('span', { text: title })));
    if (!rows.length) {
      wrap.append(el('div', { class: 'dim small', text: 'No data yet' }));
      return wrap;
    }
    const data = rows.slice(0, 10).map((r, i) => Object.assign({ __rank: i + 1 }, r));
    const cols = [
      { key: 'rank', label: '#', width: '36px', render: (r) => String(r.__rank) },
      { key: 'name', label: 'Player', render: (r) => SW.ui.playerLink(refOf(r)) },
      {
        key: 'val', label: opts.valueLabel || 'Count', align: 'right',
        render: (r) => {
          const v = lbValue(r, valKeys);
          return opts.damage ? fmtDmg(v) : SW.ui.fmtNum(num(v));
        },
      },
    ];
    wrap.append(SW.ui.table(cols, data, { emptyText: 'No data' }));
    return wrap;
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

    const view = el('div', { class: 'view view-trolls' });
    main.append(view);

    /* toolbar: review filter + live-watch toggle */
    const chips = chipBar([
      { value: '0', label: 'Unreviewed' },
      { value: '1', label: 'Reviewed' },
      { value: 'all', label: 'All' },
    ], reviewedFilter, (v) => { reviewedFilter = v; page = 0; loadFlags(); });

    let watching = !!SW.prefs.get('trolls-livewatch', false);
    const watchChip = el('button', {
      type: 'button', class: 'chip',
      title: 'Toast every live teamkill and radio-damage event while this page is open',
    });
    watchChip.innerHTML = SW.icon('eye') + '<span></span>';
    const watchLab = watchChip.querySelector('span');
    function applyWatch() {
      watchChip.classList.toggle('on', watching);
      watchLab.textContent = watching ? 'Live watch: on' : 'Live watch: off';
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

    view.append(el('div', { class: 'players-toolbar card' }, chips.el, el('span', { class: 'grow' }), watchChip));

    /* flag inbox */
    const inboxCard = el('div', { class: 'card flag-inbox' });
    const countSpan = el('span', { class: 'flagcount' });
    inboxCard.append(el('div', { class: 'card-title' },
      el('span', { html: SW.icon('flag') }),
      el('span', { text: 'Flag inbox' }),
      countSpan));
    const listBox = el('div');
    const pagerBox = el('div');
    inboxCard.append(listBox, pagerBox);
    view.append(inboxCard);

    async function loadFlags() {
      const my = ++seq;
      listBox.textContent = '';
      listBox.append(loading());
      let r;
      try { r = await SW.api('/api/flags?reviewed=' + encodeURIComponent(reviewedFilter) + '&page=' + page + '&per=50'); }
      catch (_e) {
        if (my === seq) { listBox.textContent = ''; listBox.append(SW.ui.empty('Could not load flags', 'flag')); }
        return;
      }
      if (my !== seq) return;
      listBox.textContent = '';
      const rows = sortFlags((r && r.rows) || []);
      const total = num(r && r.total);
      if (reviewedFilter === '0') countSpan.textContent = total ? total + ' open' : '';
      if (!rows.length) {
        listBox.append(SW.ui.empty(reviewedFilter === '0' ? 'No unreviewed flags — all quiet' : 'No flags', 'flag'));
      } else {
        for (const f of rows) {
          listBox.append(flagRow(f, {
            onReviewed: () => {
              if (reviewedFilter === '0') {
                const n = Math.max(0, (parseInt(countSpan.textContent, 10) || 1) - 1);
                countSpan.textContent = n ? n + ' open' : '';
              }
            },
          }));
        }
      }
      pagerBox.textContent = '';
      if (total > rows.length || page > 0) {
        pagerBox.append(SW.ui.pager({ page, per: 50, total, onPage: (p) => { page = p; loadFlags(); } }));
      }
    }

    /* live flags land at the top of the inbox (app.js already toasts them) */
    unsubs.push(SW.live.on('flag', (f) => {
      if (!f || page !== 0 || reviewedFilter === '1') return;
      const emptyState = listBox.querySelector('.empty-state');
      if (emptyState) emptyState.remove();
      listBox.prepend(flagRow(normFlagEvent(f)));
      if (reviewedFilter === '0') {
        const n = (parseInt(countSpan.textContent, 10) || 0) + 1;
        countSpan.textContent = n + ' open';
      }
    }));

    loadFlags();

    /* leaderboards — §19.1.8: every board is {all, week} */
    const lbSection = el('div', { class: 'section mt-m' });
    lbSection.append(el('h2', { class: 'section-title', text: 'Leaderboards' }));
    const lbBox = el('div');
    lbSection.append(lbBox);
    view.append(lbSection);
    lbBox.append(loading());

    (async () => {
      let t;
      try { t = await SW.api('/api/trolls', { toast: false }); }
      catch (_e) {
        lbBox.textContent = '';
        lbBox.append(SW.ui.empty('Could not load leaderboards', 'shield-alert'));
        return;
      }
      lbBox.textContent = '';
      const lbs = (t && t.leaderboards) || {};
      let period = 'all';
      function pick(board) {
        if (Array.isArray(board)) return board; /* tolerate pre-amendment shape */
        return listOf(board && board[period]);
      }
      const grid = el('div', { class: 'lb-grid' });
      function drawBoards() {
        grid.textContent = '';
        grid.append(
          lbCard('Teamkills', 'skull', pick(lbs.teamkills),
            ['teamkills', 'value', 'count', 'tks'], { valueLabel: 'TKs' }),
          lbCard('Friendly radio damage', 'radio', pick(lbs.radioFriendly),
            ['radioFriendly', 'radio_damage_friendly', 'radioDamageFriendly', 'value', 'damage'], { damage: true, valueLabel: 'Damage' }),
          lbCard('TK victims', 'shield-alert', pick(lbs.tkDeaths),
            ['tkDeaths', 'tk_deaths', 'value', 'count'], { valueLabel: 'TK deaths' }),
          lbCard('Repeat offenders', 'flame', pick(lbs.repeatOffenders),
            ['flags', 'flagCount', 'flag_count', 'count', 'value'], { valueLabel: 'Flags' })
        );
      }
      const periodChips = chipBar([
        { value: 'all', label: 'All time' },
        { value: 'week', label: 'Last 7 days' },
      ], 'all', (v) => { period = v; drawBoards(); });
      lbBox.append(el('div', { class: 'lb-tabs' }, periodChips.el), grid);
      drawBoards();
    })();
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
})();
