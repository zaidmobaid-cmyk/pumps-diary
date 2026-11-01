'use strict';
/* SquadWatch — views-admin.js (stage 3: admin surfaces)
 *
 * Registers SW.routes.admin / console / bans / audit / users / settings per
 * spec §14.3 + §19 amendments (login + setup live in app.js).
 *
 * Conventions (established by app.js / views.js):
 *   - SW.routes[name] = { role?, render(el, ctx), cleanup() }; render runs with
 *     this = route def and reassigns this.cleanup; SW.live.on() unsubscribers,
 *     timers and document-level listeners are cleared there.
 *   - Role gates mirror the app.js NAV table: admin + bans + audit are admin+,
 *     console / users / settings are owner-only (§19.3.23: audit is admin+).
 *   - CSP: script-src 'self' — NO inline handlers; everything is wired with
 *     addEventListener / SW.ui.el on<event> keys.
 *   - §19.3.25 XSS sinks: console output, audit rcon_command / rcon_response,
 *     unmatched parser samples, flag details, config dumps and every rcon
 *     response shown to the user are rendered via textContent / <pre> ONLY.
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

  function loading() {
    return el('div', { class: 'center pad-s' }, el('span', { class: 'spinner' }));
  }

  function fmtBytes(n) {
    n = num(n);
    if (n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : String(Math.round(n))) + ' ' + units[i];
  }

  function fmtHMS(ts) {
    const d = new Date(Number(ts) || Date.now());
    const p = (x) => (x < 10 ? '0' : '') + x;
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /* button with icon + label (label via textContent) */
  function iconBtn(label, icon, cls) {
    const b = el('button', { type: 'button', class: 'btn ' + (cls || '') });
    b.innerHTML = SW.icon(icon) + '<span></span>';
    b.querySelector('span').textContent = label;
    return b;
  }

  function cardTitle(iconName, text) {
    const t = el('div', { class: 'card-title' });
    t.innerHTML = SW.icon(iconName);
    t.append(el('span', { text }));
    return t;
  }

  /* same selector preference as app.js targetBody (private there) */
  function targetBody(ref, extra) {
    const body = Object.assign({}, extra);
    const dbId = ref && (ref.dbId != null ? ref.dbId : ref.id);
    if (dbId != null) body.playerId = dbId;
    else if (ref && ref.steamId) body.steamId = ref.steamId;
    return body;
  }

  function rconOkBadge(v) {
    if (v === 1 || v === true || v === '1') return SW.ui.badge('rcon ok', 'ok');
    if (v === 0 || v === false || v === '0') return SW.ui.badge('rcon fail', 'red');
    return SW.ui.badge('n/a', 'dim');
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
   * snapshot refreshes (keyed by eosId, falling back to steamId/name). */
  function playerPicker(ariaLabel) {
    const sel = el('select', { class: 'input', 'aria-label': ariaLabel || 'Online player' });
    let refs = [];
    function keyOf(p) { return p.eosId || p.steamId || ('n:' + (p.name || '')); }
    function rebuild() {
      const prev = sel.value !== '' && refs[Number(sel.value)] ? keyOf(refs[Number(sel.value)]) : null;
      refs = onlinePlayers().sort((a, b) => {
        if (num(a.teamId) !== num(b.teamId)) return num(a.teamId) - num(b.teamId);
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
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

  /* ============================================================ ADMIN view */

  const BC_PRESET_KEY = 'bc-presets';
  const BC_PRESET_CAP = 12;

  function renderAdmin(main) {
    const unsubs = [];
    this.cleanup = () => { unsubs.forEach((u) => u()); };

    const view = el('div', { class: 'view view-admin' });
    main.append(view);
    const grid = el('div', { class: 'admin-grid' });
    view.append(grid);

    /* ---------------------------------------------- broadcast composer */
    const bcCard = el('div', { class: 'card' });
    bcCard.append(cardTitle('broadcast', 'Broadcast'));
    const bcTa = el('textarea', {
      class: 'input', rows: '3', maxlength: '480',
      placeholder: 'Message shown to every player on the server…',
      'aria-label': 'Broadcast message',
    });
    const bcSend = iconBtn('Send broadcast', 'broadcast', 'primary');
    const bcSave = el('button', { type: 'button', class: 'btn ghost small', text: 'Save as preset' });
    const bcRow = el('div', { class: 'row mt-s' }, bcSave, el('span', { class: 'grow' }), bcSend);
    const presetBox = el('div', { class: 'chip-row' });
    bcCard.append(bcTa, bcRow, presetBox, el('div', {
      class: 'hint',
      text: 'Presets are saved in this browser only.',
    }));
    grid.append(bcCard);

    function getPresets() {
      const p = SW.prefs.get(BC_PRESET_KEY, []);
      return Array.isArray(p) ? p.filter((x) => typeof x === 'string' && x.trim()) : [];
    }
    function drawPresets() {
      presetBox.textContent = '';
      const presets = getPresets();
      if (!presets.length) {
        presetBox.append(el('span', { class: 'faint small', text: 'No saved presets yet.' }));
        return;
      }
      presets.forEach((msg, i) => {
        const chip = el('span', { class: 'chip preset-chip', tabindex: '0', role: 'button', title: msg });
        const txt = el('span', { class: 'preset-text' });
        txt.textContent = msg;
        const delBtn = el('button', { type: 'button', class: 'icon-btn preset-del', 'aria-label': 'Delete preset', title: 'Delete preset' });
        delBtn.innerHTML = SW.icon('x');
        delBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const next = getPresets();
          next.splice(i, 1);
          SW.prefs.set(BC_PRESET_KEY, next);
          drawPresets();
        });
        const use = () => { bcTa.value = msg; bcTa.focus(); };
        chip.addEventListener('click', use);
        chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); use(); } });
        chip.append(txt, delBtn);
        presetBox.append(chip);
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
      } catch (_e) { /* toasted by SW.api */ }
      bcSend.disabled = false;
    });
    bcTa.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); bcSend.click(); }
    });

    /* ------------------------------------------------- layer control */
    const layerCard = el('div', { class: 'card' });
    layerCard.append(cardTitle('map', 'Layer control'));
    const curVal = el('dd', { class: 'ellipsis' });
    const nextVal = el('dd', { class: 'ellipsis' });
    const kv = el('dl', { class: 'kv' },
      el('dt', { text: 'Current layer' }), curVal,
      el('dt', { text: 'Next layer' }), nextVal);
    layerCard.append(kv);
    const lSearch = el('input', {
      class: 'input mt-s', type: 'search',
      placeholder: 'Search layers…', 'aria-label': 'Search layers',
    });
    const lList = el('div', { class: 'layer-list' });
    const lFoot = el('div', { class: 'row mt-s' });
    const lCount = el('span', { class: 'faint small grow' });
    const lRefresh = iconBtn('Refresh list', 'refresh', 'ghost small');
    lFoot.append(lCount, lRefresh);
    layerCard.append(lSearch, lList, lFoot);
    grid.append(layerCard);

    let layers = [];
    let layersLoading = false;
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
      curVal.textContent = currentLayerName() || '—';
      nextVal.textContent = nextLayerName() || '—';
    }

    async function confirmSetNext(layer) {
      const v = await SW.ui.confirmModal({
        title: 'Set next layer',
        body: 'Set "' + layer + '" as the next layer? It loads when the current match ends.',
        confirmText: 'Set next',
      });
      if (!v) return;
      try { await SW.actions.setNextLayer(layer); } catch (_e) { /* toasted */ }
    }

    function drawLayers() {
      lList.textContent = '';
      if (layersLoading) {
        lList.append(el('div', { class: 'pad-s' }, el('span', { class: 'spinner' })));
        return;
      }
      const q = lSearch.value.trim().toLowerCase();
      const cur = currentLayerName();
      const next = nextLayerName();
      const rows = q ? layers.filter((L) => L.toLowerCase().indexOf(q) !== -1) : layers;
      lCount.textContent = layers.length
        ? rows.length + ' / ' + layers.length + ' layers'
        : '';
      if (!layers.length) {
        lList.append(el('div', { class: 'pad-s dim small', text: 'No layer list yet — is RCON connected?' }));
        return;
      }
      if (!rows.length) {
        lList.append(el('div', { class: 'pad-s dim small', text: 'No layers match this search' }));
        return;
      }
      for (const L of rows) {
        const item = el('div', { class: 'layer-item' + (L === cur ? ' current' : '') });
        const name = el('span', { class: 'layer-name' });
        name.textContent = L;
        name.title = L;
        item.append(name);
        if (L === next) item.append(SW.ui.badge('next', 'accent'));
        const bNext = el('button', { type: 'button', class: 'btn ghost small', text: 'Set next' });
        bNext.addEventListener('click', () => confirmSetNext(L));
        const bNow = el('button', { type: 'button', class: 'btn danger ghost small', text: 'Change now' });
        bNow.addEventListener('click', () => SW.actions.changeLayerNow(L)); /* danger confirm inside */
        item.append(bNext, bNow);
        lList.append(item);
      }
    }

    async function loadLayers(force) {
      if (force) SW.state.layers = null;
      layersLoading = true;
      drawLayers();
      try { layers = await SW.actions.fetchLayers(); }
      catch (_e) { layers = []; }
      layersLoading = false;
      drawLayers();
    }
    lSearch.addEventListener('input', debounce(drawLayers, 150));
    lRefresh.addEventListener('click', () => loadLayers(true));

    /* ------------------------------------------------- match control */
    const matchCard = el('div', { class: 'card' });
    matchCard.append(cardTitle('clock', 'Match'));
    const mInfo = el('div', { class: 'dim small mb-s' });
    const bRestart = iconBtn('Restart match', 'refresh', 'danger ghost');
    const bEnd = iconBtn('End match', 'flag', 'danger');
    matchCard.append(mInfo, el('div', { class: 'row-wrap' }, bRestart, bEnd),
      el('div', { class: 'hint', text: 'Both actions ask twice — they hit every player on the server.' }));
    grid.append(matchCard);

    function syncMatchInfo() {
      mInfo.textContent = '';
      const m = SW.state.snapshot && SW.state.snapshot.match;
      if (!m || !g(m, 'startedAt', 'started_at')) {
        mInfo.textContent = 'No live match data yet.';
        return;
      }
      mInfo.append(el('b', { text: m.layer || currentLayerName() || 'Unknown layer' }));
      mInfo.append(el('span', { text: ' — started ' }));
      mInfo.append(SW.ui.timeAgo(g(m, 'startedAt', 'started_at')));
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
    const sqCard = el('div', { class: 'card' });
    sqCard.append(cardTitle('users', 'Squad tools'));
    const teamSel = el('select', { class: 'input', 'aria-label': 'Team' });
    const squadSel = el('select', { class: 'input', 'aria-label': 'Squad' });
    const bDisband = iconBtn('Disband squad', 'x', 'danger ghost small');
    sqCard.append(
      el('div', { class: 'field' }, el('label', { text: 'Team' }), teamSel),
      el('div', { class: 'field' }, el('label', { text: 'Squad' }), squadSel),
      el('div', { class: 'row', style: 'justify-content:flex-end' }, bDisband),
      el('hr')
    );
    const cmdPicker = playerPicker('Commander to demote');
    const bDemote = iconBtn('Demote commander', 'chevron-down', 'small');
    sqCard.append(
      el('div', { class: 'field' }, el('label', { text: 'Demote commander' }), cmdPicker.el),
      el('div', { class: 'row', style: 'justify-content:flex-end' }, bDemote)
    );
    grid.append(sqCard);

    function teamsOf() { return (SW.state.snapshot && SW.state.snapshot.teams) || []; }
    function rebuildTeamSel() {
      const prev = teamSel.value;
      teamSel.textContent = '';
      const teams = teamsOf();
      if (!teams.length) {
        teamSel.append(el('option', { value: '', text: 'No live roster yet' }));
        rebuildSquadSel();
        return;
      }
      for (const t of teams) {
        const o = el('option', { value: String(t.teamId) });
        o.textContent = 'Team ' + t.teamId + ' — ' + (t.name || '');
        teamSel.append(o);
      }
      if (prev && Array.prototype.some.call(teamSel.options, (o) => o.value === prev)) teamSel.value = prev;
      rebuildSquadSel();
    }
    function rebuildSquadSel() {
      const prev = squadSel.value;
      squadSel.textContent = '';
      const team = teamsOf().find((t) => String(t.teamId) === teamSel.value);
      const squads = (team && team.squads) || [];
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
    const qaCard = el('div', { class: 'card' });
    qaCard.append(cardTitle('gavel', 'Player quick actions'));
    const qaPicker = playerPicker('Player for quick actions');
    qaCard.append(el('div', { class: 'field' }, el('label', { text: 'Online player' }), qaPicker.el));
    const qaRow = el('div', { class: 'row-wrap' });
    function qa(label, icon, fn, danger) {
      const b = iconBtn(label, icon, 'small' + (danger ? ' danger ghost' : ''));
      b.addEventListener('click', () => {
        const ref = qaPicker.current();
        if (!ref) { SW.ui.toast('Pick a player first', 'warn'); return; }
        fn(ref); /* SW.actions.* confirm + POST + rcon toast */
      });
      return b;
    }
    qaRow.append(
      qa('Warn', 'warn', (r) => SW.actions.warn(r)),
      qa('Kick', 'kick', (r) => SW.actions.kick(r)),
      qa('Ban', 'ban', (r) => SW.actions.ban(r), true),
      qa('Force team', 'swap', (r) => SW.actions.forceTeam(r)),
      qa('Unsquad', 'x', (r) => SW.actions.removeFromSquad(r))
    );
    qaCard.append(qaRow, el('div', {
      class: 'hint',
      text: 'Offline players: open their profile from the Players page for the same actions.',
    }));
    grid.append(qaCard);

    /* ------------------------------------------------ live wiring */
    const syncLive = debounce(() => {
      syncLayerKv();
      syncMatchInfo();
      drawLayers();
      rebuildTeamSel();
      cmdPicker.rebuild();
      qaPicker.rebuild();
    }, 400);
    unsubs.push(SW.live.on('players', syncLive));
    unsubs.push(SW.live.on('serverinfo', syncLive));
    unsubs.push(SW.live.on('match', syncLive));
    unsubs.push(SW.live.on('connect', syncLive));
    unsubs.push(SW.live.on('disconnect', syncLive));

    syncLayerKv();
    syncMatchInfo();
    rebuildTeamSel();
    loadLayers(false);
    if (!SW.state.snapshot) {
      SW.refreshOverview().then(() => {
        syncLayerKv(); syncMatchInfo(); rebuildTeamSel(); cmdPicker.rebuild(); qaPicker.rebuild(); drawLayers();
      });
    }
  }

  /* ========================================================== CONSOLE view */

  /* §4.3 admin command catalog (placeholders stripped on insert) */
  const CMD_CATALOG = [
    'ListPlayers',
    'ListSquads',
    'ShowServerInfo',
    'ShowCurrentMap',
    'ShowNextMap',
    'ListLayers',
    'ListCommands 1',
    'AdminBroadcast <msg>',
    'AdminChangeLayer <layer>',
    'AdminSetNextLayer <layer>',
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
  ];
  const HIST_KEY = 'console-history';
  const HIST_CAP = 100;
  const OUT_CAP = 400;

  function renderConsole(main) {
    const docKey = (e) => {
      if (e.ctrlKey && !e.altKey && !e.metaKey && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        clearOut();
      }
    };
    this.cleanup = () => { document.removeEventListener('keydown', docKey); };
    document.addEventListener('keydown', docKey);

    const view = el('div', { class: 'view view-console' });
    main.append(view);
    const wrap = el('div', { class: 'console' });
    view.append(wrap);

    /* terminal panel */
    const panel = el('div', { class: 'console-panel' });
    const out = el('div', { class: 'console-out', role: 'log', 'aria-label': 'Console output', tabindex: '0' });
    const inRow = el('div', { class: 'console-input-row' });
    const ac = el('div', { class: 'console-ac hidden', role: 'listbox' });
    const prompt = el('span', { class: 'prompt', text: 'rcon>' });
    const input = el('input', {
      class: 'console-input', type: 'text', autocomplete: 'off', spellcheck: 'false',
      placeholder: 'RCON command — ↑/↓ history, Tab completes, Ctrl+L clears',
      'aria-label': 'RCON command',
    });
    inRow.append(ac, prompt, input);
    panel.append(out, inRow);
    wrap.append(panel);

    /* quick commands sidebar */
    const quick = el('div', { class: 'console-quick' });
    function quickBtn(cmd, icon) {
      const b = iconBtn(cmd, icon, 'ghost small');
      b.addEventListener('click', () => run(cmd));
      quick.append(b);
      return b;
    }
    const quickBtns = [
      quickBtn('ListPlayers', 'users'),
      quickBtn('ShowServerInfo', 'dashboard'),
      quickBtn('ListSquads', 'shield'),
      quickBtn('ShowNextMap', 'map'),
    ];
    const clearBtn = iconBtn('Clear (Ctrl+L)', 'x', 'ghost small');
    clearBtn.addEventListener('click', clearOut);
    quick.append(clearBtn);
    wrap.append(quick);

    /* ---- output (textContent-only per §19.3.25) ---- */
    function line(kind, text, ts) {
      const d = el('div', { class: 'console-line' + (kind ? ' ' + kind : '') });
      const t = el('span', { class: 'c-time' });
      t.textContent = fmtHMS(ts);
      d.append(t);
      const body = el('span');
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
      push('c-resp', 'console cleared — Ctrl+L', true);
    }
    push('c-resp', 'SquadWatch RCON console — raw commands go straight to the game server and are audit-logged.', true);

    /* ---- history (localStorage, cap 100) ---- */
    let hist = SW.prefs.get(HIST_KEY, []);
    if (!Array.isArray(hist)) hist = [];
    hist = hist.filter((h) => typeof h === 'string').slice(-HIST_CAP);
    let histPos = hist.length; /* hist.length == not navigating */
    let draft = '';
    function pushHistory(cmd) {
      if (hist[hist.length - 1] !== cmd) hist.push(cmd);
      if (hist.length > HIST_CAP) hist = hist.slice(-HIST_CAP);
      SW.prefs.set(HIST_KEY, hist);
      histPos = hist.length;
      draft = '';
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
      Array.prototype.forEach.call(ac.children, (n, i) => n.classList.toggle('sel', i === acSel));
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
        const item = el('div', { class: 'console-ac-item', role: 'option' });
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
    let busy = false;
    function setBusy(b) {
      busy = b;
      quickBtns.forEach((btn) => { btn.disabled = b; });
      prompt.textContent = b ? '…' : 'rcon>';
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

    setTimeout(() => input.focus(), 30);
  }

  /* ============================================================= BANS view */

  const BAN_INTERVAL_RE = /^(0|\d{1,3}[mhdwMy])$/;
  const STEAMID_RE = /^7656\d{13}$/;

  function banIsPerm(r) {
    const raw = g(r, 'intervalRaw', 'interval_raw');
    if (raw != null && raw !== '') return String(raw) === '0';
    return !g(r, 'expiresAt', 'expires_at');
  }

  function issuerOf(r) {
    const v = g(r, 'issuerName', 'issuer', 'issuedByName', 'issued_by_name', 'byUsername', 'by_username', 'issuedByUsername');
    if (v != null && v !== '') return String(v);
    const id = g(r, 'issuedBy', 'issued_by');
    if (id == null) return 'system';
    return 'user #' + id;
  }

  function renderBans(main) {
    this.cleanup = () => {};
    const view = el('div', { class: 'view view-bans' });
    main.append(view);

    /* toolbar: tabs + export */
    let tab = 'active'; /* 'active' | 'expired' */
    const tabs = el('div', { class: 'tabs' });
    const tActive = el('button', { type: 'button', class: 'tab active', role: 'tab', text: 'Active' });
    const tExpired = el('button', { type: 'button', class: 'tab', role: 'tab', text: 'Expired' });
    tabs.append(tActive, tExpired);
    const exportA = el('a', { class: 'btn ghost small', href: '/api/export/bans.cfg', download: 'Bans.cfg' });
    exportA.innerHTML = SW.icon('download') + '<span>Export Bans.cfg</span>';
    view.append(el('div', { class: 'row mb-s' }, tabs, el('span', { class: 'grow' }), exportA));

    const listBox = el('div');
    view.append(listBox);

    function setTab(t) {
      tab = t;
      tActive.classList.toggle('active', t === 'active');
      tExpired.classList.toggle('active', t === 'expired');
      load();
    }
    tActive.addEventListener('click', () => setTab('active'));
    tExpired.addEventListener('click', () => setTab('expired'));

    function playerCell(r) {
      const wrap = el('div', { class: 'col', style: 'gap:2px;min-width:0' });
      wrap.append(SW.ui.playerLink({
        dbId: g(r, 'playerId', 'player_id'),
        name: g(r, 'playerName', 'player_name', 'name') || 'unknown',
        steamId: g(r, 'steamId', 'steam_id'),
      }));
      const sid = g(r, 'steamId', 'steam_id');
      if (sid) wrap.append(el('span', { class: 'mono faint small', text: String(sid) }));
      return wrap;
    }

    function expiryCell(r) {
      if (g(r, 'unbannedAt', 'unbanned_at')) {
        return el('span', { class: 'row gap-s' },
          SW.ui.badge('unbanned', 'dim'),
          el('span', { class: 'faint small', text: SW.ui.fmtTime(g(r, 'unbannedAt', 'unbanned_at')) }));
      }
      if (banIsPerm(r)) return el('span', { class: 'ban-perm', text: 'permanent' });
      const ex = num(g(r, 'expiresAt', 'expires_at'));
      if (!ex) return '—';
      if (ex > Date.now() && num(g(r, 'active')) === 1) {
        return el('span', { class: 'ban-countdown', title: SW.ui.fmtTime(ex), text: 'in ' + SW.ui.fmtDur((ex - Date.now()) / 1000) });
      }
      return el('span', { class: 'dim', text: SW.ui.fmtTime(ex) });
    }

    function unbanCell(r) {
      if (num(g(r, 'active')) !== 1) return SW.ui.badge('inactive', 'dim');
      const b = el('button', { type: 'button', class: 'btn ghost small', text: 'Unban' });
      b.addEventListener('click', async () => {
        const name = g(r, 'playerName', 'player_name', 'name') || 'this player';
        const v = await SW.ui.confirmModal({
          title: 'Unban ' + name,
          body: 'Mark this ban inactive in SquadWatch? Squad has no RCON unban command — if the ban also lives in the server\'s Bans.cfg you must update that file too (guidance shown after).',
          confirmText: 'Unban',
        });
        if (!v) return;
        b.disabled = true;
        try {
          const res = await SW.api('/api/bans/' + encodeURIComponent(g(r, 'id', 'banId')) + '/unban', { method: 'POST', body: {} });
          const noteText = (res && res.note) ? String(res.note) : 'Ban marked inactive.';
          const body = el('div');
          const p = el('p', { class: 'modal-text' });
          p.textContent = noteText; /* API guidance — textContent only */
          body.append(p);
          const again = el('a', { class: 'btn ghost small', href: '/api/export/bans.cfg', download: 'Bans.cfg' });
          again.innerHTML = SW.icon('download') + '<span>Export fresh Bans.cfg</span>';
          const okBtn = el('button', { type: 'button', class: 'btn primary small', text: 'Got it' });
          body.append(el('div', { class: 'modal-actions' }, again, okBtn));
          const m = SW.ui.modal({ title: 'Ban lifted — one more step', body });
          okBtn.addEventListener('click', () => m.close());
          load();
        } catch (_e) { b.disabled = false; /* toasted by SW.api */ }
      });
      return b;
    }

    async function load() {
      listBox.textContent = '';
      listBox.append(loading());
      let r;
      try { r = await SW.api('/api/bans?active=' + (tab === 'active' ? '1' : '0')); }
      catch (_e) {
        listBox.textContent = '';
        listBox.append(SW.ui.empty('Could not load bans', 'ban'));
        return;
      }
      listBox.textContent = '';
      const rows = listOf(r);
      const cols = [
        { key: 'player', label: 'Player', render: playerCell },
        {
          key: 'reason', label: 'Reason',
          render: (row) => { const s = el('span', { class: 'feed-msg' }); s.textContent = row.reason == null ? '—' : String(row.reason); return s; },
        },
        { key: 'issuer', label: 'Issued by', render: (row) => issuerOf(row) },
        {
          key: 'issued', label: 'Issued', sortable: true,
          sortVal: (row) => num(g(row, 'issuedAt', 'issued_at')),
          render: (row) => el('span', { class: 'nowrap small dim', text: SW.ui.fmtTime(g(row, 'issuedAt', 'issued_at')) }),
        },
        {
          key: 'expires', label: 'Expires', sortable: true,
          sortVal: (row) => (banIsPerm(row) ? Infinity : num(g(row, 'expiresAt', 'expires_at'))),
          render: expiryCell,
        },
        { key: 'rcon', label: 'RCON', render: (row) => rconOkBadge(g(row, 'rconOk', 'rcon_ok')) },
        { key: 'unban', label: '', render: unbanCell },
      ];
      listBox.append(SW.ui.table(cols, rows, {
        sort: { key: 'issued', dir: 'desc' },
        emptyText: tab === 'active' ? 'No active bans — nice and quiet' : 'No expired or lifted bans',
      }));
    }

    /* ------------------------------------------------- manual ban card */
    const mbCard = el('div', { class: 'card mt-m ban-form' });
    mbCard.append(cardTitle('ban', 'Manual ban by steamId'));
    const sidInput = el('input', {
      class: 'input mono', type: 'text', inputmode: 'numeric',
      placeholder: '76561198…', 'aria-label': 'SteamId64',
    });
    let interval = '1d';
    const customInput = el('input', {
      class: 'input mono hidden', type: 'text',
      placeholder: '0 = permanent, or 30m / 12h / 5d / 2w / 1M / 1y', 'aria-label': 'Custom ban interval',
    });
    const intervalRow = el('div', { class: 'chip-row' });
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
      const chip = el('button', { type: 'button', class: 'chip' + (it.value === interval ? ' on' : ''), text: it.label });
      chip.addEventListener('click', () => {
        interval = it.value;
        intervalChips.forEach(([c, val]) => c.classList.toggle('on', val === interval));
        customInput.classList.toggle('hidden', interval !== 'custom');
        if (interval === 'custom') customInput.focus();
      });
      intervalChips.push([chip, it.value]);
      intervalRow.append(chip);
    }
    const reasonTa = el('textarea', { class: 'input', rows: '2', placeholder: 'Reason (shown to the player and stored)', 'aria-label': 'Ban reason' });
    const mbBtn = iconBtn('Ban steamId', 'ban', 'danger');
    mbCard.append(
      el('div', { class: 'field' }, el('label', { text: 'SteamId64' }), sidInput,
        el('div', { class: 'hint', text: 'Works even if the player has never been seen by SquadWatch.' })),
      el('div', { class: 'field' }, el('label', { text: 'Duration' }), intervalRow, customInput),
      el('div', { class: 'field' }, el('label', { text: 'Reason' }), reasonTa),
      el('div', { class: 'row', style: 'justify-content:flex-end' }, mbBtn)
    );
    view.append(mbCard);

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
        const res = await SW.api('/api/bans', { method: 'POST', body: { steamId, interval: iv, reason } });
        rconResultToast('Banned ' + steamId + ' (' + (iv === '0' ? 'permanent' : iv) + ')', res);
        sidInput.value = '';
        reasonTa.value = '';
        if (tab === 'active') load();
      } catch (_e) { /* toasted */ }
      mbBtn.disabled = false;
    });

    load();
  }

  /* ============================================================ AUDIT view */

  function renderAudit(main) {
    this.cleanup = () => {};
    const view = el('div', { class: 'view view-audit' });
    main.append(view);

    let page = 0;
    let perGuess = 50;
    let seq = 0;
    let userId = '';
    let action = '';
    const seenUsers = new Map(); /* userId -> username */
    const seenActions = new Set();

    /* toolbar */
    const userSel = el('select', { class: 'input', 'aria-label': 'Filter by user', style: 'max-width:200px' });
    const actSel = el('select', { class: 'input', 'aria-label': 'Filter by action', style: 'max-width:220px' });
    function fillFilterSelects() {
      const prevU = userSel.value;
      userSel.textContent = '';
      userSel.append(el('option', { value: '', text: 'All users' }));
      for (const [uid, uname] of seenUsers) {
        userSel.append(el('option', { value: String(uid), text: uname }));
      }
      if (prevU && Array.prototype.some.call(userSel.options, (o) => o.value === prevU)) userSel.value = prevU;
      const prevA = actSel.value;
      actSel.textContent = '';
      actSel.append(el('option', { value: '', text: 'All actions' }));
      for (const a of Array.from(seenActions).sort()) {
        actSel.append(el('option', { value: a, text: a }));
      }
      if (prevA && Array.prototype.some.call(actSel.options, (o) => o.value === prevA)) actSel.value = prevA;
    }
    fillFilterSelects();
    userSel.addEventListener('change', () => { userId = userSel.value; page = 0; load(); });
    actSel.addEventListener('change', () => { action = actSel.value; page = 0; load(); });
    const refreshBtn = iconBtn('Refresh', 'refresh', 'ghost small');
    refreshBtn.addEventListener('click', () => load());
    view.append(el('div', { class: 'players-toolbar card' },
      el('span', { class: 'dim small', text: 'Filter:' }), userSel, actSel,
      el('span', { class: 'grow' }), refreshBtn));

    const listBox = el('div');
    const pagerBox = el('div');
    view.append(listBox, pagerBox);

    function userCell(r) {
      const uid = g(r, 'userId', 'user_id');
      if (uid == null) return SW.ui.badge('system', 'dim');
      const uname = g(r, 'username', 'userName', 'user');
      return el('span', { class: 'nowrap', text: uname != null ? String(uname) : 'user #' + uid });
    }

    function targetCell(r) {
      const pid = g(r, 'targetPlayerId', 'target_player_id');
      const pname = g(r, 'playerName', 'player_name', 'targetName', 'target_name');
      if (pid == null && pname == null) return '—';
      return SW.ui.playerLink({ dbId: pid, name: pname || ('#' + pid) });
    }

    /* details + expandable rcon command/response — textContent/<pre> ONLY */
    function detailsCell(r) {
      const wrap = el('div', { style: 'min-width:0' });
      const det = g(r, 'details');
      if (det != null && det !== '') {
        const s = String(det);
        const span = el('div', { class: 'small', style: 'word-break:break-word' });
        span.textContent = s.length > 160 ? s.slice(0, 160) + '…' : s;
        if (s.length > 160) span.title = s;
        wrap.append(span);
      }
      const cmd = g(r, 'rconCommand', 'rcon_command');
      const resp = g(r, 'rconResponse', 'rcon_response');
      if ((cmd != null && cmd !== '') || (resp != null && resp !== '')) {
        const btn = el('button', { type: 'button', class: 'btn ghost small expand-btn' });
        btn.innerHTML = SW.icon('chevron-down') + '<span>rcon</span>';
        const box = el('div', { class: 'audit-resp hidden' });
        if (cmd != null && cmd !== '') {
          const p1 = el('pre');
          p1.textContent = '$ ' + String(cmd);
          box.append(p1);
        }
        const p2 = el('pre');
        p2.textContent = resp == null || resp === '' ? '(no response recorded)' : String(resp);
        box.append(p2);
        btn.addEventListener('click', () => {
          const open = box.classList.toggle('hidden');
          btn.innerHTML = SW.icon(open ? 'chevron-down' : 'chevron-up') + '<span>rcon</span>';
        });
        wrap.append(btn, box);
      }
      return wrap;
    }

    const cols = [
      {
        key: 'time', label: 'Time', width: '150px', sortable: true,
        sortVal: (r) => num(r.time),
        render: (r) => el('span', { class: 'mono small dim nowrap', text: SW.ui.fmtTime(r.time) }),
      },
      { key: 'user', label: 'User', width: '130px', render: userCell },
      {
        key: 'action', label: 'Action', width: '150px',
        render: (r) => el('span', { class: 'mono small', text: String(g(r, 'action') || '—') }),
      },
      { key: 'target', label: 'Target', width: '160px', render: targetCell },
      { key: 'details', label: 'Details / RCON', render: detailsCell },
      { key: 'ok', label: 'OK', width: '90px', render: (r) => rconOkBadge(g(r, 'rconOk', 'rcon_ok')) },
    ];

    const tbl = SW.ui.table(cols, [], {
      sort: { key: 'time', dir: 'desc' },
      emptyText: 'No audit entries match',
    });
    listBox.append(tbl);

    async function load() {
      const my = ++seq;
      const params = new URLSearchParams();
      params.set('page', String(page));
      params.set('per', '50');
      if (userId) params.set('userId', userId);
      if (action) params.set('action', action);
      let r;
      try { r = await SW.api('/api/audit?' + params.toString()); } catch (_e) { return; }
      if (my !== seq) return;
      const rows = listOf(r);
      for (const row of rows) {
        const uid = g(row, 'userId', 'user_id');
        if (uid != null && !seenUsers.has(uid)) {
          const uname = g(row, 'username', 'userName', 'user');
          seenUsers.set(uid, uname != null ? String(uname) : 'user #' + uid);
        }
        const a = g(row, 'action');
        if (a) seenActions.add(String(a));
      }
      fillFilterSelects();
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

  /* ============================================================ USERS view */

  const ROLES = ['viewer', 'admin', 'owner'];

  function renderUsers(main) {
    this.cleanup = () => {};
    const view = el('div', { class: 'view view-users' });
    main.append(view);
    const listBox = el('div');
    view.append(listBox);

    const meId = SW.state.me && SW.state.me.id;

    function roleCell(r) {
      const sel = el('select', { class: 'input', 'aria-label': 'Role for ' + (r.username || 'user'), style: 'min-width:100px;padding:4px 8px' });
      for (const role of ROLES) {
        const o = el('option', { value: role, text: role });
        if (String(r.role) === role) o.selected = true;
        sel.append(o);
      }
      if (r.id === meId) {
        sel.disabled = true;
        sel.title = 'You cannot change your own role';
        return sel;
      }
      sel.addEventListener('change', async () => {
        const newRole = sel.value;
        const v = await SW.ui.confirmModal({
          title: 'Change role',
          body: 'Change ' + (r.username || 'this user') + ' from ' + r.role + ' to ' + newRole + '? Their sessions are signed out.',
          confirmText: 'Change role',
          danger: newRole === 'owner',
        });
        if (!v) { sel.value = String(r.role); return; }
        try {
          await SW.api('/api/users/' + encodeURIComponent(r.id), { method: 'POST', body: { role: newRole } });
          SW.ui.toast('Role updated: ' + (r.username || '') + ' → ' + newRole, 'ok');
          r.role = newRole;
        } catch (_e) { sel.value = String(r.role); /* toasted (e.g. last owner) */ }
      });
      return sel;
    }

    function actionsCell(r, reload) {
      const wrap = el('div', { class: 'row gap-s nowrap', style: 'justify-content:flex-end' });
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
        class: 'btn small ' + (disabled ? '' : 'danger ghost'),
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
      listBox.textContent = '';
      listBox.append(loading());
      let r;
      try { r = await SW.api('/api/users'); }
      catch (_e) {
        listBox.textContent = '';
        listBox.append(SW.ui.empty('Could not load users', 'user-cog'));
        return;
      }
      listBox.textContent = '';
      const rows = listOf(r);
      const cols = [
        {
          key: 'username', label: 'User',
          render: (row) => {
            const wrap = el('span', { class: 'row gap-s nowrap' });
            wrap.append(el('b', { text: String(row.username || '?') }));
            if (row.id === meId) wrap.append(SW.ui.badge('you', 'accent'));
            if (num(g(row, 'disabled'))) wrap.append(SW.ui.badge('disabled', 'red'));
            return wrap;
          },
        },
        { key: 'role', label: 'Role', width: '140px', render: roleCell },
        {
          key: 'lastLogin', label: 'Last login', sortable: true,
          sortVal: (row) => num(g(row, 'lastLogin', 'last_login')),
          render: (row) => {
            const v = g(row, 'lastLogin', 'last_login');
            return v ? SW.ui.timeAgo(v) : el('span', { class: 'faint', text: 'never' });
          },
        },
        {
          key: 'created', label: 'Created',
          render: (row) => el('span', { class: 'small dim nowrap', text: SW.ui.fmtTime(g(row, 'createdAt', 'created_at')) }),
        },
        { key: 'actions', label: '', render: (row) => actionsCell(row, load) },
      ];
      listBox.append(SW.ui.table(cols, rows, {
        rowClass: (row) => (num(g(row, 'disabled')) ? 'users-row-disabled' : ''),
        emptyText: 'No users',
      }));
    }

    /* add-user card */
    const addCard = el('div', { class: 'card mt-m' });
    addCard.append(cardTitle('plus', 'Add user'));
    const auName = el('input', { class: 'input', type: 'text', placeholder: 'Username', autocomplete: 'off', 'aria-label': 'New username' });
    const auPass = el('input', { class: 'input', type: 'password', placeholder: 'Password', autocomplete: 'new-password', 'aria-label': 'New user password' });
    const auRole = el('select', { class: 'input', 'aria-label': 'New user role' });
    for (const role of ROLES) auRole.append(el('option', { value: role, text: role }));
    auRole.value = 'viewer';
    const auBtn = iconBtn('Create user', 'plus', 'primary');
    const form = el('form', { class: 'form-row' },
      el('div', { class: 'field grow', style: 'margin:0' }, el('label', { text: 'Username' }), auName),
      el('div', { class: 'field grow', style: 'margin:0' }, el('label', { text: 'Password' }), auPass),
      el('div', { class: 'field', style: 'margin:0' }, el('label', { text: 'Role' }), auRole),
      auBtn);
    auBtn.type = 'submit';
    addCard.append(form, el('div', {
      class: 'hint',
      text: 'viewer: read-only (no IPs, no actions) · admin: all moderation tools + IPs · owner: everything incl. console, users, settings.',
    }));
    view.append(addCard);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = auName.value.trim();
      const password = auPass.value;
      if (!username || !password) {
        SW.ui.toast('Username and password are required', 'error');
        return;
      }
      auBtn.disabled = true;
      try {
        await SW.api('/api/users', { method: 'POST', body: { username, password, role: auRole.value } });
        SW.ui.toast('User created: ' + username + ' (' + auRole.value + ')', 'ok');
        auName.value = '';
        auPass.value = '';
        auRole.value = 'viewer';
        load();
      } catch (_e) { /* toasted */ }
      auBtn.disabled = false;
    });

    load();
  }

  /* ========================================================= SETTINGS view */

  function renderSettings(main) {
    const unsubs = [];
    this.cleanup = () => { unsubs.forEach((u) => u()); };
    const view = el('div', { class: 'view view-settings' });
    main.append(view);
    view.append(loading());

    (async () => {
      let r;
      try { r = await SW.api('/api/settings'); }
      catch (_e) {
        view.textContent = '';
        view.append(SW.ui.empty('Could not load settings (owner only)', 'settings'));
        return;
      }
      view.textContent = '';
      build(r || {});
    })();

    function kvList(pairs) {
      const dl = el('dl', { class: 'kv' });
      for (const [k, v] of pairs) {
        dl.append(el('dt', { text: k }));
        const dd = el('dd');
        if (v == null || v === '') dd.textContent = '—';
        else if (v.nodeType) dd.append(v);
        else dd.textContent = String(v);
        dl.append(dd);
      }
      return dl;
    }

    function statusDot(ok) {
      return el('span', { class: 'row gap-s' },
        el('span', { class: 'dot ' + (ok ? 'ok' : 'bad') }),
        el('span', { class: ok ? 'good' : 'bad', text: ok ? 'connected' : 'down' }));
    }

    function build(data) {
      const st = data.status || {};
      const cfg = data.config;

      /* --- status cards --- */
      const rconCard = el('div', { class: 'card' });
      const logCard = el('div', { class: 'card' });

      function drawRcon(rc) {
        rc = rc || {};
        rconCard.textContent = '';
        rconCard.append(cardTitle('live', 'RCON'));
        rconCard.append(kvList([
          ['Status', statusDot(!!rc.connected)],
          ['Authed', rc.authed == null ? null : (rc.authed ? 'yes' : 'no')],
          ['Since', rc.since ? SW.ui.fmtTime(rc.since) : null],
          ['Last error', rc.lastError ? String(rc.lastError) : '—'],
        ]));
      }
      function drawLog(lg) {
        lg = lg || {};
        logCard.textContent = '';
        logCard.append(cardTitle('scroll', 'Log source'));
        logCard.append(kvList([
          ['Mode', lg.mode || '?'],
          ['Status', statusDot(!!lg.ok)],
          ['Lag', lg.lagBytes != null ? fmtBytes(lg.lagBytes) : null],
          ['Last read', g(lg, 'lastReadAt', 'last_read_at') ? SW.ui.timeAgo(g(lg, 'lastReadAt', 'last_read_at')) : null],
          ['Error', lg.error ? String(lg.error) : '—'],
        ]));
      }
      drawRcon(st.rcon);
      drawLog(st.log);

      const db = st.db || {};
      const dbCard = el('div', { class: 'card' });
      dbCard.append(cardTitle('dashboard', 'Database'));
      const dbPath = String(g(db, 'path') || '—');
      dbCard.append(kvList([
        ['Path', el('span', { class: 'row gap-s', style: 'min-width:0' },
          el('span', { class: 'mono small ellipsis', title: dbPath, text: dbPath }),
          g(db, 'path') ? SW.ui.copyBtn(dbPath) : null)],
        ['Size', fmtBytes(g(db, 'sizeBytes', 'size_bytes'))],
      ]));

      const verCard = el('div', { class: 'card' });
      verCard.append(cardTitle('shield', 'Version'));
      const gameVer = g(st, 'gameVersion', 'game_version')
        || (SW.state.serverInfo && SW.state.serverInfo.gameVersion);
      verCard.append(kvList([
        ['SquadWatch', g(st, 'version') || g(data, 'version') || '—'],
        ['Squad server', gameVer || 'unknown'],
      ]));

      view.append(el('div', { class: 'status-grid' }, rconCard, logCard, dbCard, verCard));

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
      const pSection = SW.ui.section('Parser health');
      const pGrid = el('div', { class: 'row-wrap', style: 'align-items:stretch' });
      pGrid.append(SW.ui.statCard({
        icon: 'flame',
        label: 'Unmatched lines (24h)',
        value: SW.ui.fmtNum(unmatched),
        sub: unmatched > 0 ? 'the parser skipped these' : 'everything parsed',
        accent: unmatched > 0 ? 'warn' : undefined,
      }));
      pSection.append(pGrid);
      const sampleCard = el('div', { class: 'card unmatched-samples mt-s' });
      const sHead = el('div', { class: 'card-title' });
      sHead.innerHTML = SW.icon('scroll');
      sHead.append(el('span', { text: 'Sample unmatched lines' }), el('span', { class: 'grow' }));
      if (samples.length) sHead.append(SW.ui.copyBtn(samples.join('\n'), 'Copy all'));
      sampleCard.append(sHead);
      if (!samples.length) {
        sampleCard.append(el('div', { class: 'dim small', text: 'No unmatched lines captured — the parser is keeping up.' }));
      } else {
        const pre = el('pre');
        pre.textContent = samples.join('\n'); /* raw log lines — textContent only */
        sampleCard.append(pre, el('div', {
          class: 'hint',
          text: 'Send these lines along when asking for parser tuning — they are exactly what the parser could not match.',
        }));
      }
      pSection.append(sampleCard);
      view.append(pSection);

      /* --- redacted config dump --- */
      const cSection = SW.ui.section('Configuration (redacted)');
      const cCard = el('div', { class: 'card config-dump' });
      let cfgText;
      if (cfg == null) cfgText = '(no config returned)';
      else if (typeof cfg === 'string') cfgText = cfg;
      else {
        try { cfgText = JSON.stringify(cfg, null, 2); }
        catch (_e) { cfgText = String(cfg); }
      }
      const cHead = el('div', { class: 'card-title' });
      cHead.innerHTML = SW.icon('settings');
      cHead.append(el('span', { text: 'config.json as loaded' }), el('span', { class: 'grow' }), SW.ui.copyBtn(cfgText, 'Copy'));
      const cPre = el('pre');
      cPre.textContent = cfgText; /* dump — textContent only */
      cCard.append(cHead, cPre, el('div', {
        class: 'hint',
        text: 'Secrets (rconPassword, ftp/sftp passwords, API keys, webhook URL) are replaced with ••• by the server.',
      }));
      cSection.append(cCard);
      view.append(cSection);
    }
  }

  /* ========================================================== route table */

  SW.routes.admin = {
    role: 'admin',
    render(main, ctx) { renderAdmin.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.console = {
    role: 'owner',
    render(main, ctx) { renderConsole.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.bans = {
    role: 'admin',
    render(main, ctx) { renderBans.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.audit = {
    role: 'admin',
    render(main, ctx) { renderAudit.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.users = {
    role: 'owner',
    render(main, ctx) { renderUsers.call(this, main, ctx); },
    cleanup() {},
  };

  SW.routes.settings = {
    role: 'owner',
    render(main, ctx) { renderSettings.call(this, main, ctx); },
    cleanup() {},
  };
})();
