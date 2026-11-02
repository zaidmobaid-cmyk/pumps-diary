'use strict';
// Join alerts (docs/BATCH3-CONTRACTS.md §6).
//
// ENGINE — a real db and bus, an admin recorder, a webhook recorder, a fake
//   clock and synchronous processing: the three checks behind their
//   toggles; flag rows plus bus 'flag' in exactly ingest's shape and bus
//   'join-alert'; Discord for watchlist/flagged only; join flags never
//   count as "flagged"; ban evasion only through a shared IP with an
//   active, unexpired ban on ANOTHER player (matched by player id, SteamID
//   or EOS id), never echoing the IP; addresses used months apart or by a
//   crowd link no one; bounded work per join (bans read once, and only
//   when an address is shared); the 10-minute dedupe per player and type;
//   auto-kick by SteamID (in-game id without one) on every join, audited
//   join-alert-kick; stale joins ignored; real ingest log and roster joins
//   feed it, deferred until the name line has landed; a PostLogin line the
//   roster beat gets the evasion check once its IP is stored.
//
// WEBHOOK — postJoinAlert gating and format; watchlist/flagged join flags
//   are not posted a second time as plain flags, ban evasion is; only the
//   warn/kick/ban audit actions post; flag text is markdown-escaped.
//
// IN-PROCESS HTTP — createApi with the module: the flag shows in the flags
//   API and the Trolls inbox without the IP, the kick in the audit log, and
//   the SSE `alert` reaches flag/ban holders but not viewers; join flags
//   never count on the Trolls repeat-offender board.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin, ACTION_NAMES } = require('../server/admin');
const { createApi } = require('../server/api');
const { createWebhook } = require('../server/webhook');
const LiveState = require('../server/state');
const Ingest = require('../server/ingest');
const { createJoinAlerts } = require('../server/joinalerts');

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 2, 1, 21, 0, 0);
const IP = '203.0.113.7';
const IP2 = '198.51.100.9';
const KICK = 'Ban evasion - this account is linked to a banned player';
const eos = (n) => `0002aaaabbbbccccddddeeeeffff${String(n).padStart(4, '0')}`;
const steam = (n) => `765611980000${String(n).padStart(5, '0')}`;

function quietLog() {
  const lines = [];
  const push = (lvl) => (...a) => lines.push([lvl, ...a]);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function seed(db) {
  let n = 0;
  return {
    player({ name, watchlisted = 0, withSteam = true } = {}) {
      n++;
      const id = db.prepare(
        'INSERT INTO players(eos_id, steam_id, name, first_seen, last_seen, watchlisted) VALUES(?,?,?,?,?,?)'
      ).run(eos(n), withSteam ? steam(n) : null, name || `P${n}`, T0 - 86400000, T0, watchlisted).lastInsertRowid;
      return { id, eos: eos(n), steam: withSteam ? steam(n) : null, name: name || `P${n}` };
    },
    ip(p, ip, first = T0 - MIN, last = first) {
      db.prepare('INSERT INTO player_ips(player_id, ip, first_seen, last_seen, times) VALUES(?,?,?,?,1)').run(p.id, ip, first, last);
    },
    ban({ playerId = null, steamId = null, eosId = null, expiresAt = null, active = 1, reason = 'cheating' } = {}) {
      return db.prepare(
        `INSERT INTO bans(player_id, steam_id, eos_id, issued_at, expires_at, reason, active)
         VALUES(?,?,?,?,?,?,?)`
      ).run(playerId, steamId, eosId, T0 - 86400000, expiresAt, reason, active).lastInsertRowid;
    },
    flag(p, type, reviewed = 0) {
      db.prepare('INSERT INTO flags(player_id, time, type, severity, match_id, details, reviewed) VALUES(?,?,?,?,?,?,?)')
        .run(p.id, T0 - 3600000, type, 2, null, '{}', reviewed);
    },
  };
}

function world(t, toggles, { defer } = {}) {
  const db = openDb(':memory:');
  db.migrate();
  const bus = new EventEmitter();
  const clock = { t: T0 };
  const sent = [];
  const admin = {
    async execRaw(user, command, meta) {
      sent.push({ user, command, meta });
      return { ok: true, rconOk: true, command, response: 'ok', auditId: sent.length };
    },
  };
  const posts = [];
  const webhook = { postJoinAlert: (a) => posts.push(a) };
  const state = { players: new Map(), match: { id: 3 }, byEos(e) { return this.players.get(e) || null; } };
  const config = {
    joinAlerts: Object.assign({ watchlist: true, flagged: true, banEvasion: true, autoKickEvasion: false }, toggles || {}),
  };
  const log = quietLog();
  const mod = createJoinAlerts({
    db, bus, state, admin, webhook, config, log, now: () => clock.t, defer: defer || ((fn) => fn()),
  });
  mod.start();
  t.after(() => { mod.stop(); db.close(); });
  const flags = [];
  const alerts = [];
  bus.on('flag', (f) => flags.push(f));
  bus.on('join-alert', (a) => alerts.push(a));
  // ingest's 'player-connected' payload (roster path shape)
  const join = (p, extra) => bus.emit('player-connected', {
    time: clock.t,
    player: Object.assign({
      dbId: p.id, eosId: p.eos, steamId: p.steam, name: p.name, teamId: null, squadId: null,
      sessKills: null, sessDeaths: null, sessTks: null,
    }, extra || {}),
  });
  const rows = (type) => db.prepare(`SELECT * FROM flags WHERE type ${type ? '= ?' : 'IS NOT ?'} ORDER BY id`).all(type || null);
  return { db, bus, clock, sent, posts, state, config, log, mod, flags, alerts, join, rows, s: seed(db) };
}

// ---------------------------------------------------------------- engine

test('watchlisted join: flag row, bus flag in ingest\'s exact shape, join-alert, Discord', (t) => {
  const w = world(t);
  const p = w.s.player({ name: 'Watched', watchlisted: 1 });
  w.join(p);
  const [row] = w.rows('watchlist-join');
  assert.ok(row);
  assert.strictEqual(row.player_id, p.id);
  assert.strictEqual(row.time, T0);
  assert.strictEqual(row.severity, 1);
  assert.strictEqual(row.match_id, 3);
  assert.strictEqual(row.reviewed, 0);
  assert.deepStrictEqual(JSON.parse(row.details), { reason: 'Watchlisted player joined' });

  const details = { reason: 'Watchlisted player joined' };
  assert.deepStrictEqual(w.flags, [{
    time: T0, flagId: row.id, type: 'watchlist-join', severity: 1,
    player: {
      dbId: p.id, eosId: p.eos, steamId: p.steam, name: 'Watched', teamId: null, squadId: null,
      sessKills: null, sessDeaths: null, sessTks: null,
    },
    matchId: 3, details,
  }]);
  const alert = { type: 'watchlist-join', time: T0, player: { dbId: p.id, name: 'Watched' }, details, flagId: row.id, severity: 1 };
  assert.deepStrictEqual(w.alerts, [alert]);
  assert.deepStrictEqual(w.posts, [alert]);

  // the same key set ingest.insertFlag emits
  const bus2 = new EventEmitter();
  let theirs = null;
  bus2.on('flag', (f) => { theirs = f; });
  const ingest = new Ingest({ db: w.db, state: null, bus: bus2, config: { flags: {} }, admin: null });
  t.after(() => ingest.stop());
  const someone = w.s.player({ name: 'Someone else' });
  ingest.insertFlag({ type: 'manual', severity: 2, playerDbId: someone.id, rec: null, matchId: 3, time: T0, details: {} });
  assert.deepStrictEqual(Object.keys(w.flags[0]), Object.keys(theirs));
  assert.deepStrictEqual(Object.keys(w.flags[0].player), Object.keys(theirs.player));

  w.config.joinAlerts.watchlist = false;
  w.clock.t = T0 + 30 * MIN;
  w.join(p);
  assert.strictEqual(w.alerts.length, 1, 'toggled off: no alert');
});

test('flagged join: unreviewed flags count; reviewed ones and the alerts\' own flags never do', (t) => {
  const w = world(t);
  const a = w.s.player({ name: 'Trouble' });
  w.s.flag(a, 'tk_spree');
  w.s.flag(a, 'tk_spree');
  w.s.flag(a, 'friendly_radio');
  w.s.flag(a, 'chat_watchlist', 1);
  w.join(a);
  assert.strictEqual(w.alerts.length, 1);
  assert.deepStrictEqual(w.alerts[0].details, {
    reason: 'Joined with 3 unreviewed flags', unreviewed: 3, types: ['tk_spree', 'friendly_radio'],
  });
  assert.strictEqual(w.alerts[0].type, 'flagged-join');
  assert.strictEqual(w.posts.length, 1, 'flagged joins go to Discord');

  const clean = w.s.player({ name: 'Reformed' });
  w.s.flag(clean, 'tk_spree', 1);
  w.join(clean);
  // only alert flags left unreviewed: no feedback loop on later joins
  const watched = w.s.player({ name: 'Watched', watchlisted: 1 });
  w.s.flag(watched, 'ban-evasion');
  w.s.flag(watched, 'flagged-join');
  w.join(watched);
  w.clock.t = T0 + 15 * MIN;
  w.join(watched);
  assert.deepStrictEqual(w.alerts.map((x) => [x.player.name, x.type]), [
    ['Trouble', 'flagged-join'], ['Watched', 'watchlist-join'], ['Watched', 'watchlist-join'],
  ]);
});

test('ban evasion: a shared IP with another player\'s active, unexpired ban — and never the IP itself', (t) => {
  const w = world(t);
  const banned = w.s.player({ name: 'Banned Bob' });
  w.s.ip(banned, IP);
  const banId = w.s.ban({ playerId: banned.id });
  const alt = w.s.player({ name: 'Fresh Alt' });
  w.s.ip(alt, IP);
  w.s.ip(alt, IP2);
  w.join(alt);
  const [row] = w.rows('ban-evasion');
  assert.ok(row, 'flagged');
  assert.strictEqual(row.severity, 3);
  const details = {
    reason: 'Shares an IP address with a banned player',
    banId, bannedPlayerId: banned.id, bannedPlayerName: 'Banned Bob', sharedIps: 1,
  };
  assert.deepStrictEqual(JSON.parse(row.details), details);
  assert.deepStrictEqual(w.alerts, [{
    type: 'ban-evasion', time: T0, player: { dbId: alt.id, name: 'Fresh Alt' }, details, flagId: row.id, severity: 3,
  }]);
  assert.strictEqual(w.flags[0].type, 'ban-evasion');
  assert.deepStrictEqual(w.posts, [], 'evasion reaches Discord as a flag, not a join alert');
  for (const blob of [row.details, JSON.stringify(w.flags), JSON.stringify(w.alerts)]) {
    assert.ok(!blob.includes(IP) && !blob.includes(IP2), 'no raw IP anywhere');
  }
  assert.deepStrictEqual(w.sent, [], 'auto-kick is off');
});

test('ban evasion: what does not count', (t) => {
  const w = world(t);
  const join = (name, setup) => {
    const other = w.s.player({ name: `${name} other` });
    const me = w.s.player({ name });
    setup(other, me);
    w.join(me);
  };
  join('expired', (o, me) => { w.s.ip(o, '10.0.0.1'); w.s.ip(me, '10.0.0.1'); w.s.ban({ playerId: o.id, expiresAt: T0 - MIN }); });
  join('lifted', (o, me) => { w.s.ip(o, '10.0.0.2'); w.s.ip(me, '10.0.0.2'); w.s.ban({ playerId: o.id, active: 0 }); });
  join('no ip known', (o) => { w.s.ip(o, '10.0.0.3'); w.s.ban({ playerId: o.id }); });
  join('other ip', (o, me) => { w.s.ip(o, '10.0.0.4'); w.s.ip(me, '10.0.0.5'); w.s.ban({ playerId: o.id }); });
  join('banned himself', (o, me) => {
    w.s.ip(o, '10.0.0.6'); w.s.ip(me, '10.0.0.6');
    w.s.ban({ playerId: o.id });
    w.s.ban({ steamId: me.steam }); // ingest's ban enforcement handles this one
  });
  assert.deepStrictEqual(w.rows('ban-evasion'), []);

  w.config.joinAlerts.banEvasion = false;
  const o = w.s.player({ name: 'o' });
  const me = w.s.player({ name: 'me' });
  w.s.ip(o, '10.0.0.7'); w.s.ip(me, '10.0.0.7'); w.s.ban({ playerId: o.id });
  w.join(me);
  assert.deepStrictEqual(w.rows('ban-evasion'), [], 'toggled off');
});

test('ban evasion: a ban matched by the other player\'s SteamID or EOS id counts; permanent bans are named first', (t) => {
  const w = world(t);
  const bySteam = w.s.player({ name: 'Steam-banned' });
  const byEos = w.s.player({ name: 'Eos-banned' });
  w.s.ip(bySteam, '10.1.0.1');
  w.s.ip(byEos, '10.1.0.2');
  w.s.ban({ steamId: bySteam.steam, expiresAt: T0 + 86400000 });
  const permId = w.s.ban({ eosId: byEos.eos.toUpperCase() }); // imported lists may carry upper-case ids
  const alt = w.s.player({ name: 'Both' });
  w.s.ip(alt, '10.1.0.1');
  w.s.ip(alt, '10.1.0.2');
  w.join(alt);
  assert.strictEqual(w.alerts.length, 1, 'one alert per join, however many links');
  assert.strictEqual(w.alerts[0].details.banId, permId, 'the permanent ban first');
  assert.strictEqual(w.alerts[0].details.bannedPlayerName, 'Eos-banned');

  const alt2 = w.s.player({ name: 'Steam link' });
  w.s.ip(alt2, '10.1.0.1');
  w.join(alt2);
  assert.strictEqual(w.alerts[1].details.bannedPlayerName, 'Steam-banned');
});

test('ban evasion: an address used months apart, or one many accounts share, links no one — so nobody is kicked on it', async (t) => {
  const w = world(t, { autoKickEvasion: true });
  const bannedOn = (name, ip, first, last) => {
    const p = w.s.player({ name });
    w.s.ip(p, ip, first, last);
    w.s.ban({ playerId: p.id });
    return p;
  };
  // the ISP handed the banned player's address to someone else four months on
  bannedOn('Banned in autumn', '10.9.0.1', T0 - 200 * DAY, T0 - 120 * DAY);
  const heir = w.s.player({ name: 'New holder of the address' });
  w.s.ip(heir, '10.9.0.1', T0 - 2 * DAY, T0);
  w.join(heir);
  // twenty days apart is inside the window
  bannedOn('Banned this month', '10.9.0.2', T0 - 40 * DAY, T0 - 20 * DAY);
  const alt = w.s.player({ name: 'Alt' });
  w.s.ip(alt, '10.9.0.2');
  w.join(alt);
  // carrier-grade NAT: the banned player and five more accounts on it this month
  bannedOn('Banned behind CGNAT', '100.64.0.1', T0 - 10 * DAY);
  for (let i = 0; i < 5; i++) w.s.ip(w.s.player({ name: `Neighbour ${i}` }), '100.64.0.1', T0 - 3 * DAY);
  const crowd = w.s.player({ name: 'Crowd member' });
  w.s.ip(crowd, '100.64.0.1');
  w.join(crowd);
  // five other accounts, the banned one among them, are still a household
  bannedOn('Banned sibling', '192.0.2.10', T0 - 5 * DAY);
  for (let i = 0; i < 4; i++) w.s.ip(w.s.player({ name: `Sibling ${i}` }), '192.0.2.10', T0 - 5 * DAY);
  const cousin = w.s.player({ name: 'Cousin' });
  w.s.ip(cousin, '192.0.2.10');
  w.join(cousin);
  await flush();
  assert.deepStrictEqual(w.alerts.map((a) => [a.player.name, a.details.bannedPlayerName]), [
    ['Alt', 'Banned this month'], ['Cousin', 'Banned sibling'],
  ]);
  assert.deepStrictEqual(w.sent.map((x) => x.command), [`AdminKick ${alt.steam} ${KICK}`, `AdminKick ${cousin.steam} ${KICK}`]);
});

test('ban evasion: bounded work per join — no pass over bans unless an address is shared, then exactly one', (t) => {
  const w = world(t);
  w.db.tx(() => {
    const ins = w.db.prepare(
      'INSERT INTO bans(player_id, steam_id, eos_id, issued_at, expires_at, reason, active) VALUES(?,?,?,?,?,?,1)'
    );
    for (let i = 0; i < 10000; i++) ins.run(100000 + i, `7656119900${String(i).padStart(7, '0')}`, null, T0 - DAY, null, 'imported');
  });
  // 49 addresses, each shared with five accounts, plus one 3,000 accounts used
  const busy = w.s.player({ name: 'Busy' });
  let banned = null;
  w.db.tx(() => {
    for (let i = 0; i < 49; i++) {
      const ip = `10.20.${i}.1`;
      w.s.ip(busy, ip);
      for (let k = 0; k < 5; k++) {
        const peer = w.s.player({ name: `Peer ${i}-${k}` });
        w.s.ip(peer, ip, T0 - HOUR);
        banned = peer;
      }
    }
    w.s.ip(busy, '100.64.9.9');
    for (let k = 0; k < 3000; k++) w.s.ip(w.s.player({ name: `Exit ${k}` }), '100.64.9.9', T0 - HOUR);
  });
  w.s.ban({ playerId: banned.id });
  const lone = w.s.player({ name: 'Loner' });
  w.s.ip(lone, '10.99.0.1');
  const ran = [];
  const prepare = w.db.prepare;
  w.db.prepare = (sql) => {
    const st = prepare(sql);
    const note = (fn) => (...a) => { ran.push(sql); return fn(...a); };
    return { run: note(st.run), get: note(st.get), all: note(st.all) };
  };
  t.after(() => { w.db.prepare = prepare; });
  const scans = () => ran.splice(0).filter((s) => /\bFROM bans\b/.test(s)).length;

  w.join(lone);
  assert.strictEqual(scans(), 0, 'nobody shares the address: bans are not read');
  const t0 = process.hrtime.bigint();
  w.join(busy);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.strictEqual(scans(), 1, 'one pass over bans for everyone sharing an address');
  assert.deepStrictEqual(w.alerts.map((a) => [a.player.name, a.details.bannedPlayerId, a.details.sharedIps]), [['Busy', banned.id, 1]]);
  assert.ok(ms < 250, `a join with 245 address peers and 10,000 bans took ${ms.toFixed(1)} ms`);
});

test('dedupe: one alert per player per type per 10 minutes', (t) => {
  const w = world(t);
  const p = w.s.player({ name: 'Watched', watchlisted: 1 });
  w.s.flag(p, 'tk_spree');
  const q = w.s.player({ name: 'Other', watchlisted: 1 });
  w.join(p);
  w.join(q);
  w.clock.t = T0 + 5 * MIN;
  w.join(p);
  w.clock.t = T0 + 9 * MIN + 59 * SEC;
  w.join(p);
  w.clock.t = T0 + 10 * MIN;
  w.join(p);
  assert.deepStrictEqual(w.alerts.map((a) => [a.player.name, a.type, a.time]), [
    ['Watched', 'watchlist-join', T0], ['Watched', 'flagged-join', T0], ['Other', 'watchlist-join', T0],
    ['Watched', 'watchlist-join', T0 + 10 * MIN], ['Watched', 'flagged-join', T0 + 10 * MIN],
  ]);
  assert.strictEqual(w.rows('watchlist-join').length, 3);
  assert.strictEqual(w.flags.length, 5);
});

test('auto-kick: an evader is kicked on every join — by SteamID, else by in-game id — audited join-alert-kick', async (t) => {
  const w = world(t, { autoKickEvasion: true });
  const banned = w.s.player({ name: 'Banned' });
  w.s.ip(banned, IP);
  const banId = w.s.ban({ playerId: banned.id });
  const alt = w.s.player({ name: 'Alt' });
  w.s.ip(alt, IP);
  w.join(alt);
  await flush();
  const [row] = w.rows('ban-evasion');
  assert.strictEqual(JSON.parse(row.details).autoKick, true);
  assert.deepStrictEqual(w.sent, [{
    user: null,
    command: `AdminKick ${alt.steam} ${KICK}`,
    meta: {
      action: 'join-alert-kick', targetPlayerId: alt.id,
      details: { flagId: row.id, banId, bannedPlayerId: banned.id, reason: KICK },
    },
  }]);

  // back two minutes later: the alert is deduped, the kick is not
  w.clock.t = T0 + 2 * MIN;
  w.join(alt);
  await flush();
  assert.strictEqual(w.alerts.length, 1);
  assert.strictEqual(w.sent.length, 2);
  assert.strictEqual(w.sent[1].meta.details.flagId, row.id, 'tied to the alert on record');

  // no SteamID anywhere: the live in-game id
  const noSteam = w.s.player({ name: 'NoSteam', withSteam: false });
  w.s.ip(noSteam, IP);
  w.state.players.set(noSteam.eos, { eosId: noSteam.eos, playerId: 17, name: 'NoSteam' });
  w.join(noSteam);
  await flush();
  assert.strictEqual(w.sent[2].command, `AdminKickById 17 ${KICK}`);

  // nothing to select them by: no kick, and the alert does not claim one
  const ghost = w.s.player({ name: 'Ghost', withSteam: false });
  w.s.ip(ghost, IP);
  w.join(ghost);
  await flush();
  assert.strictEqual(w.sent.length, 3);
  assert.strictEqual(w.alerts[w.alerts.length - 1].details.autoKick, undefined);

  w.config.joinAlerts.autoKickEvasion = false;
  w.clock.t = T0 + 30 * MIN;
  w.join(alt);
  await flush();
  assert.strictEqual(w.sent.length, 3, 'off: alert only');
  assert.strictEqual(w.alerts.length, 4);
});

test('stale, unknown or unidentified joins are ignored; a join without a db id is resolved by EOS id', (t) => {
  const w = world(t);
  const p = w.s.player({ name: 'Watched', watchlisted: 1 });
  w.bus.emit('player-connected', { time: T0 - 11 * MIN, player: { dbId: p.id, eosId: p.eos } });
  w.bus.emit('player-connected', { time: T0, player: { dbId: 9999 } });
  w.bus.emit('player-connected', { time: T0, player: {} });
  w.bus.emit('player-connected', null);
  assert.deepStrictEqual(w.alerts, []);
  w.bus.emit('player-connected', { time: T0, player: { dbId: null, eosId: p.eos.toUpperCase() } });
  assert.deepStrictEqual(w.alerts.map((a) => a.player), [{ dbId: p.id, name: 'Watched' }]);

  w.config.joinAlerts = { watchlist: false, flagged: false, banEvasion: false, autoKickEvasion: true };
  w.clock.t = T0 + 20 * MIN;
  w.join(p);
  assert.strictEqual(w.alerts.length, 1, 'every check off');
  w.mod.stop();
  w.config.joinAlerts.watchlist = true;
  w.join(p);
  assert.strictEqual(w.alerts.length, 1, 'stop() detaches from the bus');
  assert.deepStrictEqual(w.log.lines.filter((l) => l[0] !== 'info'), []);
});

test('real ingest joins feed it: the log path (with the IP it just stored, named by the next line) and the roster path', async (t) => {
  const db = openDb(':memory:');
  db.migrate();
  t.after(() => db.close());
  const bus = new EventEmitter();
  const state = new LiveState();
  const sent = [];
  const admin = {
    async execRaw(user, command, meta) { sent.push({ command, meta }); return { ok: true, rconOk: true, command, response: 'ok' }; },
    async execAdmin() { return { ok: true, rconOk: true }; },
  };
  const ingest = new Ingest({ db, state, bus, config: { flags: {} }, admin });
  t.after(() => ingest.stop());
  const mod = createJoinAlerts({
    db, bus, state, admin, webhook: null, log: quietLog(),
    config: { joinAlerts: { watchlist: true, flagged: true, banEvasion: true, autoKickEvasion: true } },
  });
  mod.start();
  t.after(() => mod.stop());
  const alerts = [];
  bus.on('join-alert', (a) => alerts.push(a));
  const now = Date.now();
  const s = seed(db);
  const banned = s.player({ name: 'Banned' });
  s.ip(banned, IP, now - HOUR);
  s.ban({ playerId: banned.id });

  const altEos = 'abcdefabcdefabcdefabcdefabcdef01';
  const altSteam = '76561199000000077';
  bus.emit('log-event', { event: 'PLAYER_CONNECTED', time: now, controller: 'BP_PlayerController_C_2147', ip: IP, eosId: altEos, steamId: altSteam });
  bus.emit('log-event', { event: 'JOIN_SUCCEEDED', time: now, suffixName: 'Sneaky' });
  assert.deepStrictEqual(alerts, [], 'looked at once the rest of the log batch has landed');
  await flush();
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].type, 'ban-evasion');
  assert.strictEqual(alerts[0].player.name, 'Sneaky', 'named by the JOIN_SUCCEEDED line');
  assert.strictEqual(alerts[0].details.bannedPlayerId, banned.id);
  assert.deepStrictEqual(sent.map((x) => x.command), [`AdminKick ${altSteam} ${KICK}`]);

  // roster path: the first poll is a baseline, the next one announces joins
  const watched = s.player({ name: 'Watched', watchlisted: 1 });
  state.applyListPlayers({ online: [] });
  state.applyListPlayers({
    online: [{ playerId: 5, eosId: watched.eos, steamId: watched.steam, name: 'Watched', teamId: 2, squadId: null, isLeader: false, role: 'Rifleman' }],
  });
  await flush();
  assert.deepStrictEqual(alerts.slice(1).map((a) => [a.type, a.player.dbId]), [['watchlist-join', watched.id]]);
});

test('roster first, PostLogin line later: ban evasion is checked once the line has stored the IP — a join linked already is not kicked twice', async (t) => {
  const db = openDb(':memory:');
  db.migrate();
  t.after(() => db.close());
  const bus = new EventEmitter();
  const state = new LiveState();
  const sent = [];
  const admin = {
    async execRaw(user, command, meta) { sent.push({ command, meta }); return { ok: true, rconOk: true, command, response: 'ok' }; },
    async execAdmin() { return { ok: true, rconOk: true }; },
  };
  const ingest = new Ingest({ db, state, bus, config: { flags: {} }, admin });
  t.after(() => ingest.stop());
  const mod = createJoinAlerts({
    db, bus, state, admin, webhook: null, log: quietLog(),
    config: { joinAlerts: { watchlist: true, flagged: true, banEvasion: true, autoKickEvasion: true } },
  });
  mod.start();
  t.after(() => mod.stop());
  const alerts = [];
  bus.on('join-alert', (a) => alerts.push(a));
  const now = Date.now();
  const s = seed(db);
  const banned = s.player({ name: 'Banned' });
  s.ip(banned, IP, now - HOUR);
  s.ban({ playerId: banned.id });
  const known = s.player({ name: 'Known Alt' }); // linked through an address already on record
  s.ip(known, IP, now - HOUR);

  const roster = (p, playerId, name) => ({
    playerId, eosId: p.eosId, steamId: p.steamId, name, teamId: 1, squadId: null, isLeader: false, role: 'Rifleman',
  });
  const fresh = { eosId: 'abcdefabcdefabcdefabcdefabcdef02', steamId: '76561199000000078' };
  const knownIds = { eosId: known.eos, steamId: known.steam };
  state.applyListPlayers({ online: [] });
  state.applyListPlayers({ online: [roster(fresh, 7, 'Fresh Alt'), roster(knownIds, 8, 'Known Alt')] });
  await flush();
  assert.deepStrictEqual(alerts.map((a) => [a.player.name, a.details.bannedPlayerId]), [['Known Alt', banned.id]],
    'at the roster join only an address already on record can link');
  assert.deepStrictEqual(sent.map((x) => x.command), [`AdminKick ${known.steam} ${KICK}`]);

  // the lagging PostLogin lines: ingest stores the IPs and adopts the
  // roster's sessions without announcing them again
  let announced = 0;
  bus.on('player-connected', () => { announced++; });
  const line = (p, controller, ip) => bus.emit('log-event', {
    event: 'PLAYER_CONNECTED', time: Date.now() - 20 * SEC, controller, ip, eosId: p.eosId, steamId: p.steamId,
  });
  line(fresh, 'BP_PlayerController_C_2148', IP);
  line(knownIds, 'BP_PlayerController_C_2149', IP2);
  await flush();
  assert.strictEqual(announced, 0, 'both lines were adopted, not announced');
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM player_ips WHERE ip = ?').get(IP).n, 3);
  assert.deepStrictEqual(alerts.slice(1).map((a) => [a.type, a.player.name, a.details.bannedPlayerId]), [['ban-evasion', 'Fresh Alt', banned.id]]);
  assert.deepStrictEqual(sent.slice(1).map((x) => x.command), [`AdminKick ${fresh.steamId} ${KICK}`], 'the known alt is not kicked twice');
});

// --------------------------------------------------------------- webhook

test('webhook: watchlist/flagged join flags post once (as join alerts); ban evasion posts as a flag', async (t) => {
  const posted = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 204 }; };
  t.after(() => { globalThis.fetch = prev; });
  const bus = new EventEmitter();
  const config = { discordWebhook: 'https://discord.example/api/webhooks/1/x', webhookEvents: { flags: true } };
  const wh = createWebhook({ config, bus });
  const player = { dbId: 4, name: 'Watched' };
  for (const type of ['watchlist-join', 'flagged-join', 'ban-evasion', 'tk_spree']) {
    bus.emit('flag', { time: T0, flagId: 1, type, severity: 1, player, matchId: null, details: { reason: 'r' } });
  }
  await flush();
  assert.deepStrictEqual(posted.map((p) => p.embeds[0].title), ['Flag: ban-evasion (sev 1)', 'Flag: tk_spree (sev 1)']);

  wh.postJoinAlert({ type: 'watchlist-join', time: T0, player: { dbId: 4, name: '**Watched**' }, details: { reason: 'Watchlisted player joined' } });
  wh.postJoinAlert({ type: 'flagged-join', time: T0, player: { dbId: 5, name: null }, details: { reason: 'Joined with 2 unreviewed flags' } });
  await flush();
  const [a, b] = posted.slice(2);
  assert.strictEqual(a.embeds[0].title, 'Watchlisted player joined: \\*\\*Watched\\*\\*');
  assert.strictEqual(a.embeds[0].description, 'Watchlisted player joined');
  assert.deepStrictEqual(a.allowed_mentions, { parse: [] });
  assert.strictEqual(b.embeds[0].title, 'Flagged player joined: player #5');
  assert.deepStrictEqual(b.embeds[0].fields.map((f) => [f.name, f.value]), [['Player', 'player #5'], ['Player id', '#5']]);

  // an evader is kicked on every rejoin: those kicks are not posted one by one
  config.webhookEvents.kicks = true;
  bus.emit('admin-action', { id: 1, time: T0, userId: null, action: 'join-alert-kick', details: '{}', rconOk: 1 });
  bus.emit('admin-action', { id: 2, time: T0, userId: 1, action: 'kick', details: '{}', rconOk: 1 });
  await flush();
  assert.deepStrictEqual(posted.slice(4).map((p) => p.embeds[0].title), ['Player kicked'], 'only the admin\'s own kick');

  config.webhookEvents.flags = false;
  wh.postJoinAlert({ type: 'watchlist-join', time: T0, player, details: {} });
  bus.emit('flag', { time: T0, flagId: 2, type: 'ban-evasion', severity: 3, player, matchId: null, details: {} });
  await flush();
  assert.strictEqual(posted.length, 5, 'join alerts follow the flags switch');
});

function recordPosts(t) {
  const posted = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 204 }; };
  t.after(() => { globalThis.fetch = prev; });
  return posted;
}

test('webhook: of every audited action only warn, kick and ban post — never a note edit, a remote ban list change or an evasion kick', async (t) => {
  const posted = recordPosts(t);
  const bus = new EventEmitter();
  const config = {
    discordWebhook: 'https://discord.example/api/webhooks/1/x',
    webhookEvents: { flags: true, bans: true, kicks: true, warns: true, matchEnd: true },
  };
  createWebhook({ config, bus });
  const db = openDb(':memory:');
  db.migrate();
  t.after(() => db.close());
  const auth = createAuth({ db, config, bus });
  t.after(() => auth.loginLimiter.stop());
  const punishments = ['warn', 'kick', 'ban'];
  const others = [
    ...ACTION_NAMES.filter((a) => !punishments.includes(a)),
    'unban', 'note', 'watch', 'manual-flag', 'flag-review', 'user-create', 'user-update', 'setup',
    'role-create', 'role-update', 'role-delete', 'invite-create', 'invite-revoke', 'invite-use',
    'settings-update', 'settings-test', 'quick-command', 'quick-commands-update', 'bm-import', 'ban-enforce',
    // docs/BATCH3-CONTRACTS.md
    'evidence-upload', 'evidence-delete', 'ban-note-update', 'templates-update', 'remote-bans-rotate', 'remote-bans-update',
    'schedule-create', 'schedule-update', 'schedule-delete', 'scheduled-run', 'admin-call-reply', 'admin-call-handled',
    'join-alert-kick',
  ];
  for (const action of others) auth.audit(1, action, { targetPlayerId: 2, details: { banId: 3, reason: 'r' } });
  await flush();
  assert.deepStrictEqual(posted.map((p) => p.embeds[0].title), []);
  for (const action of punishments) auth.audit(1, action, { targetPlayerId: 2, details: { reason: 'r' } });
  await flush();
  assert.deepStrictEqual(posted.map((p) => p.embeds[0].title), ['Player warned', 'Player kicked', 'Player banned']);
});

test('webhook: player-controlled text in a flag post is escaped — it renders as typed, never as a link', async (t) => {
  const posted = recordPosts(t);
  const bus = new EventEmitter();
  createWebhook({ config: { discordWebhook: 'https://discord.example/api/webhooks/1/x', webhookEvents: { flags: true } }, bus });
  const details = {
    reason: 'Shares an IP address with a banned player', banId: 2, bannedPlayerId: 3,
    bannedPlayerName: '[Appeal here](https://phish.example) @everyone', sharedIps: 1,
  };
  const chat = 'go to <https://y.example> and [click](https://y.example) "now"';
  bus.emit('flag', { time: T0, flagId: 1, type: 'ban-evasion', severity: 3, player: { dbId: 4, name: '**[me](https://x.example)**' }, matchId: null, details });
  bus.emit('flag', { time: T0, flagId: 2, type: 'chat_watchlist', severity: 2, player: { dbId: 5, name: 'Chatty' }, matchId: 9, details: { message: chat } });
  await flush();
  // Discord drops a backslash in front of punctuation when it renders
  const rendered = (s) => s.replace(/\\([^0-9A-Za-z\s])/g, '$1');
  // markdown characters left outside a backslash escape
  const live = (s) => {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') i++;
      else if ('[]()<>*_~`|#@:-'.includes(s[i])) out.push(s[i]);
    }
    return out;
  };
  const [a, b] = posted;
  assert.strictEqual(rendered(a.embeds[0].description), JSON.stringify(details));
  assert.strictEqual(rendered(a.embeds[0].fields[0].value), '**[me](https://x.example)**');
  assert.strictEqual(rendered(b.embeds[0].description), JSON.stringify({ message: chat }));
  for (const s of [a.embeds[0].description, a.embeds[0].fields[0].value, b.embeds[0].description]) {
    assert.deepStrictEqual(live(s), [], s);
  }
});

// --------------------------------------------------------- in-process HTTP

test('HTTP: the alert lands in the flags API and the Trolls inbox without the IP, the kick in the audit log, SSE to flag/ban holders only', async (t) => {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = { joinAlerts: { watchlist: true, flagged: true, banEvasion: true, autoKickEvasion: true } };
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const auth = createAuth({ db, config: cfg, bus });
  const sentCmds = [];
  const rcon = {
    status: { connected: true, authed: true },
    async exec(cmd) { sentCmds.push(cmd); return `Kicked player: ${cmd}`; },
  };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const mod = createJoinAlerts({ db, bus, state, admin, auth, webhook: null, config: cfg, log: quietLog() });
  const server = createApi({ db, state, rcon, bus, auth, admin, config: cfg, extensions: [mod] });
  mod.start();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => mod.stop());
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  let n = 0;
  const as = (role) => {
    n++;
    const roleRef = role && typeof role === 'object' ? auth.createRole(`custom-${n}`, role).id : role;
    const u = auth.createUser(`user${n}`, 'password-123', roleRef);
    const cookie = `sw_session=${auth.createSession(u.id, {}).token}`;
    return {
      cookie,
      get: async (p) => {
        const res = await fetch(base + p, { headers: { cookie, accept: 'application/json' } });
        const text = await res.text();
        return { status: res.status, text, json: JSON.parse(text) };
      },
    };
  };
  async function stream(who) {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { headers: { cookie: who.cookie }, signal: ctrl.signal });
    const events = [];
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      try {
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block);
            const data = /^data: (.*)$/m.exec(block);
            if (ev) events.push({ event: ev[1], data: data ? JSON.parse(data[1]) : null });
          }
        }
      } catch (_e) { /* aborted at teardown */ }
    })();
    t.after(() => ctrl.abort());
    const until = async (pred) => {
      const end = Date.now() + 3000;
      for (;;) {
        const hit = events.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`no matching SSE event; got ${events.map((e) => e.event).join(',')}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    await until((e) => e.event === 'hello');
    return { events, until };
  }

  const owner = as('owner');
  const viewer = as('viewer');
  const banHolder = as({ view: true, stream: true, ban: true });
  const ownerStream = await stream(owner);
  const viewerStream = await stream(viewer);
  const banStream = await stream(banHolder);

  const s = seed(db);
  const banned = s.player({ name: 'Banned' });
  s.ip(banned, IP);
  s.ban({ playerId: banned.id });
  const alt = s.player({ name: 'Alt' });
  s.ip(alt, IP);
  bus.emit('player-connected', {
    time: Date.now(),
    player: { dbId: alt.id, eosId: alt.eos, steamId: alt.steam, name: 'Alt', teamId: 1, squadId: null, sessKills: 0, sessDeaths: 0, sessTks: 0 },
  });

  const alert = await ownerStream.until((e) => e.event === 'alert');
  assert.strictEqual(alert.data.type, 'ban-evasion');
  assert.strictEqual(alert.data.player.dbId, alt.id);
  await banStream.until((e) => e.event === 'alert');
  await ownerStream.until((e) => e.event === 'flag' && e.data.type === 'ban-evasion');
  bus.emit('broadcast', { time: Date.now(), message: 'sentinel', from: 'test' });
  await viewerStream.until((e) => e.event === 'broadcast');
  assert.deepStrictEqual(viewerStream.events.filter((e) => e.event === 'alert'), [], 'viewers never get join alerts');

  const flags = await owner.get('/api/flags?reviewed=0');
  assert.strictEqual(flags.status, 200);
  const f = flags.json.rows.find((r) => r.type === 'ban-evasion');
  assert.ok(f, flags.text);
  assert.strictEqual(f.playerId, alt.id);
  assert.strictEqual(f.playerName, 'Alt');
  assert.strictEqual(f.severity, 3);
  assert.strictEqual(f.details.bannedPlayerId, banned.id);
  const trolls = await owner.get('/api/trolls');
  assert.strictEqual(trolls.json.openFlags[0].type, 'ban-evasion', 'severity 3 tops the inbox');
  for (const r of [flags, trolls]) assert.ok(!r.text.includes(IP), 'the IP never leaves through these');

  for (let i = 0; i < 50 && !sentCmds.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepStrictEqual(sentCmds, [`AdminKick ${alt.steam} ${KICK}`]);
  const audit = await owner.get('/api/audit?action=join-alert-kick');
  assert.strictEqual(audit.status, 200, audit.text);
  assert.strictEqual(audit.json.rows.length, 1);
  assert.strictEqual(audit.json.rows[0].targetPlayerId, alt.id);
  assert.strictEqual(audit.json.rows[0].userId, null, 'a system action');
  assert.strictEqual(audit.json.rows[0].details.bannedPlayerId, banned.id);
  assert.strictEqual(audit.json.rows[0].rconOk, true);
});

test('HTTP: join-alert flags record a connection, not behaviour — rejoining never makes a repeat offender on the Trolls board', async (t) => {
  const db = openDb(':memory:');
  db.migrate();
  const cfg = { joinAlerts: { watchlist: true, flagged: true, banEvasion: true, autoKickEvasion: false } };
  const bus = new EventEmitter();
  const auth = createAuth({ db, config: cfg, bus });
  const rcon = { status: { connected: true, authed: true }, async exec(cmd) { return `Executed: ${cmd}`; } };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const clock = { t: Date.now() - 2 * HOUR };
  const mod = createJoinAlerts({
    db, bus, state, admin, auth, webhook: null, config: cfg, log: quietLog(), now: () => clock.t, defer: (fn) => fn(),
  });
  const server = createApi({ db, state, rcon, bus, auth, admin, config: cfg, extensions: [mod] });
  mod.start();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => mod.stop());
  t.after(() => auth.loginLimiter.stop());
  const base = `http://127.0.0.1:${server.address().port}`;
  const u = auth.createUser('owner1', 'password-123', 'owner');
  const cookie = `sw_session=${auth.createSession(u.id, {}).token}`;

  const s = seed(db);
  const tkFlag = (p, at) => db.prepare('INSERT INTO flags(player_id, time, type, severity, match_id, details) VALUES(?,?,?,?,?,?)')
    .run(p.id, at, 'tk_spree', 2, null, '{}');
  const watched = s.player({ name: 'Watched', watchlisted: 1 });
  const oneTk = s.player({ name: 'OneTk' });
  tkFlag(oneTk, clock.t - HOUR);
  const offender = s.player({ name: 'Offender' });
  tkFlag(offender, clock.t - HOUR);
  tkFlag(offender, clock.t - 30 * MIN);
  const banned = s.player({ name: 'Banned' });
  s.ip(banned, IP);
  s.ban({ playerId: banned.id });
  const evader = s.player({ name: 'Evader' });
  s.ip(evader, IP);

  // three joins each, past the 10-minute dedupe: a join flag every time
  for (let i = 0; i < 3; i++) {
    for (const p of [watched, oneTk, offender, evader]) {
      bus.emit('player-connected', { time: clock.t, player: { dbId: p.id, eosId: p.eos, steamId: p.steam, name: p.name } });
    }
    clock.t += 11 * MIN;
  }
  const count = (type) => db.prepare('SELECT COUNT(*) AS n FROM flags WHERE type = ?').get(type).n;
  assert.deepStrictEqual(['watchlist-join', 'flagged-join', 'ban-evasion'].map(count), [3, 6, 3]);

  const res = await fetch(`${base}/api/trolls`, { headers: { cookie, accept: 'application/json' } });
  assert.strictEqual(res.status, 200);
  const board = (await res.json()).leaderboards.repeatOffenders;
  const want = [{ id: offender.id, name: 'Offender', value: 2 }];
  assert.deepStrictEqual(board.all, want, 'only behaviour flags count, all time');
  assert.deepStrictEqual(board.week, want, 'and in the last 7 days');
});
