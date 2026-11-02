'use strict';
// Optional Discord webhook notifier (SPEC §1/§11). Posts simple embeds to
// config.discordWebhook via global fetch. Every post is gated by
// config.webhookEvents (admin calls by adminCalls.enabled instead),
// fire-and-forget (errors are logged, never thrown), and a complete no-op
// when no webhook URL is configured.
//
// createWebhook({config, bus?, db?}) ->
//   {postFlag, postBan, postKick, postWarn, postMatchEnd, postAdminCall, postJoinAlert}
// When a bus is provided, flag / match-end / admin-action events are wired up
// automatically (integrator may also call the post* functions directly). The
// admin-action row names ids only: with a db, warn/kick/ban posts name the
// player and the admin; without one they show the ids.

const { log } = require('./util');

const COLORS = {
  red: 0xe5484d,
  amber: 0xf0a020,
  blue: 0x4ba3f5,
  green: 0x30a46c,
  purple: 0x9d7bd8,
};

// docs/BATCH3-CONTRACTS.md §6: these join flags reach Discord through
// postJoinAlert; posting them as plain flags too would double every alert.
const JOIN_ALERT_FLAGS = new Set(['watchlist-join', 'flagged-join']);
const JOIN_ALERT_TITLES = { 'watchlist-join': 'Watchlisted player joined', 'flagged-join': 'Flagged player joined' };
const DISCORD_ROLE_RE = /^\d{5,25}$/;

// Player names and chat are player-controlled: escape Discord markdown so a
// message cannot render as a masked link, a fake mention or formatting.
function mdEscape(s) {
  return String(s == null ? '' : s).replace(/[\\*_~`|>[\]()#<@:-]/g, '\\$&');
}

// A Squad ban interval (server/admin.js INTERVAL_RE) in words; '0' and a
// missing one are permanent.
const INTERVAL_UNITS = { m: 'minute', h: 'hour', d: 'day', w: 'week', M: 'month', y: 'year' };
function intervalText(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '' || s === '0') return 'perm';
  const m = /^(\d{1,4})([mhdwMy])$/.exec(s);
  if (!m) return s;
  const n = Number(m[1]);
  return `${n} ${INTERVAL_UNITS[m[2]]}${n === 1 ? '' : 's'}`;
}

// Audit details travel as the stored JSON text.
function detailsOf(v) {
  if (v && typeof v === 'object') return v;
  if (typeof v !== 'string' || v === '') return {};
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? o : {};
  } catch (_e) {
    return {};
  }
}

function createWebhook(deps) {
  const config = (deps && deps.config) || {};
  const bus = deps && deps.bus;
  const db = deps && deps.db;
  const events = config.webhookEvents || {};

  function url() {
    return String(config.discordWebhook || '').trim();
  }

  function trunc(s, n) {
    const v = String(s == null ? '' : s);
    return v.length > n ? v.slice(0, n - 1) + '…' : v;
  }

  function playerName(p) {
    if (!p) return 'unknown';
    if (typeof p === 'string') return p;
    return p.name || p.steamId || p.eosId || 'unknown';
  }

  // Fire-and-forget POST of one embed. Never throws. `extra` may carry a
  // message `content` and its `allowed_mentions`.
  function post(embed, extra) {
    const u = url();
    if (!u) return; // no-op when unset
    const payload = {
      username: 'A3 Admin',
      embeds: [Object.assign({ timestamp: new Date().toISOString() }, embed)],
    };
    if (extra && extra.content) payload.content = extra.content;
    if (extra && extra.allowed_mentions) payload.allowed_mentions = extra.allowed_mentions;
    const body = JSON.stringify(payload);
    try {
      fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10000),
      }).then((res) => {
        if (!res.ok) log.warn('webhook', 'discord responded ' + res.status);
      }).catch((e) => {
        log.warn('webhook', 'post failed: ' + (e && e.message ? e.message : e));
      });
    } catch (e) {
      log.warn('webhook', 'post failed: ' + (e && e.message ? e.message : e));
    }
  }

  // flag payload per §7: {time, flagId, type, severity, player, matchId, details}
  // Details carry player-controlled text (chat lines, a banned player's
  // name): escaped, which Discord renders as the very same characters.
  function postFlag(flag) {
    if (!events.flags || !flag) return;
    const sev = flag.severity | 0;
    post({
      title: 'Flag: ' + trunc(flag.type || 'flag', 64) + ' (sev ' + sev + ')',
      color: sev >= 3 ? COLORS.red : sev === 2 ? COLORS.amber : COLORS.blue,
      description: mdEscape(trunc(typeof flag.details === 'string' ? flag.details : JSON.stringify(flag.details || ''), 1000)),
      fields: [
        { name: 'Player', value: mdEscape(trunc(playerName(flag.player), 256)), inline: true },
        { name: 'Match', value: String(flag.matchId != null ? flag.matchId : '—'), inline: true },
      ],
    });
  }

  // Ban/kick/warn fields are escaped like flags: player names, and the
  // auto-warn text that quotes one, are player-controlled.
  // {player|name, interval, reason, by?}
  function postBan(ban) {
    if (!events.bans || !ban) return;
    post({
      title: 'Player banned',
      color: COLORS.red,
      fields: [
        { name: 'Player', value: mdEscape(trunc(playerName(ban.player || ban.name), 256)), inline: true },
        { name: 'Interval', value: mdEscape(trunc(intervalText(ban.interval), 64)), inline: true },
        { name: 'Reason', value: mdEscape(trunc(ban.reason || '—', 512)), inline: false },
        { name: 'By', value: mdEscape(trunc(ban.by || 'system', 128)), inline: true },
      ],
    });
  }

  // {player|name, reason, by?}
  function postKick(kick) {
    if (!events.kicks || !kick) return;
    post({
      title: 'Player kicked',
      color: COLORS.amber,
      fields: [
        { name: 'Player', value: mdEscape(trunc(playerName(kick.player || kick.name), 256)), inline: true },
        { name: 'Reason', value: mdEscape(trunc(kick.reason || '—', 512)), inline: false },
        { name: 'By', value: mdEscape(trunc(kick.by || 'system', 128)), inline: true },
      ],
    });
  }

  // {player|name, message, by?, auto?}
  function postWarn(warn) {
    if (!events.warns || !warn) return;
    post({
      title: warn.auto ? 'Player auto-warned' : 'Player warned',
      color: COLORS.blue,
      fields: [
        { name: 'Player', value: mdEscape(trunc(playerName(warn.player || warn.name), 256)), inline: true },
        { name: 'Message', value: mdEscape(trunc(warn.message || '—', 512)), inline: false },
        { name: 'By', value: mdEscape(trunc(warn.by || 'system', 128)), inline: true },
      ],
    });
  }

  // match-end payload per §7: {matchId, layer, level, team1, team2, startedAt,
  //                            winnerTeam, winnerFaction, tickets, endedAt}
  function postMatchEnd(m) {
    if (!events.matchEnd || !m) return;
    const mins = m.startedAt && m.endedAt ? Math.round((m.endedAt - m.startedAt) / 60000) : null;
    post({
      title: 'Match ended: ' + trunc(m.layer || '?', 128),
      color: COLORS.green,
      fields: [
        {
          name: 'Winner',
          value: trunc((m.winnerFaction || ('Team ' + (m.winnerTeam != null ? m.winnerTeam : '?'))) +
            (m.tickets != null ? ' (+' + m.tickets + ' tickets)' : ''), 256),
          inline: true,
        },
        { name: 'Duration', value: mins != null ? mins + ' min' : '—', inline: true },
      ],
    });
  }

  // In-game admin call (BATCH3 §5): {id, time, playerName, steamId, eosId,
  // message, roleId}. Not gated by webhookEvents — adminCalls.enabled is its
  // switch. Only the role in `content` may ping (allowed_mentions); the
  // player's text stays in the embed, where nothing pings.
  function postAdminCall(call) {
    if (!call) return;
    const roleId = DISCORD_ROLE_RE.test(String(call.roleId == null ? '' : call.roleId)) ? String(call.roleId) : '';
    const who = call.playerName || call.steamId || call.eosId || 'unknown';
    post({
      title: 'In-game admin call',
      color: COLORS.amber,
      description: trunc(mdEscape(call.message || '—'), 1000),
      fields: [
        { name: 'Player', value: trunc(mdEscape(who), 256), inline: true },
        { name: 'SteamID', value: trunc(call.steamId || '—', 64), inline: true },
        { name: 'Call', value: '#' + (call.id != null ? call.id : '?'), inline: true },
      ],
    }, roleId
      ? { content: `<@&${roleId}> admin call from in game`, allowed_mentions: { roles: [roleId] } }
      : { allowed_mentions: { parse: [] } });
  }

  // Watchlisted / flagged player joined (BATCH3 §6): the join-alert bus
  // payload {type, time, player: {dbId, name}, details}. Gated like flags —
  // every join alert is also a flag row. Ban evasion goes out as its flag.
  function postJoinAlert(alert) {
    if (!events.flags || !alert) return;
    const p = alert.player || {};
    const d = alert.details && typeof alert.details === 'object' ? alert.details : {};
    const name = p.name ? mdEscape(p.name) : (p.dbId != null ? 'player #' + p.dbId : 'unknown');
    post({
      title: trunc(JOIN_ALERT_TITLES[alert.type] || 'Join alert', 128) + ': ' + trunc(name, 128),
      color: alert.type === 'flagged-join' ? COLORS.amber : COLORS.purple,
      description: trunc(mdEscape(d.reason || alert.type || ''), 1000),
      fields: [
        { name: 'Player', value: trunc(name, 256), inline: true },
        { name: 'Player id', value: p.dbId != null ? '#' + p.dbId : '—', inline: true },
      ],
    }, { allowed_mentions: { parse: [] } });
  }

  // Audited actions that post, by exact name. Every other audit row stays
  // off Discord: ban enforcement and evasion kicks (one per rejoin), ban
  // note edits, remote ban list changes and the like are no new punishment.
  const ACTION_POSTS = new Map([['warn', postWarn], ['kick', postKick], ['ban', postBan]]);

  // The `name` column of one row, or null. Runs inside auth.audit's emit:
  // a failed lookup must not throw there.
  function nameById(sql, id) {
    if (!db || typeof db.prepare !== 'function' || id == null) return null;
    try {
      const r = db.prepare(sql).get(id);
      const v = r && r.name != null ? String(r.name).trim() : '';
      return v || null;
    } catch (e) {
      log.warn('webhook', 'name lookup failed: ' + (e && e.message ? e.message : e));
      return null;
    }
  }

  // Optional bus wiring — the integrator may rely on this or call post* itself.
  if (bus && typeof bus.on === 'function') {
    bus.on('flag', (f) => {
      if (f && JOIN_ALERT_FLAGS.has(f.type)) return;
      postFlag(f);
    });
    bus.on('match-end', postMatchEnd);
    bus.on('admin-action', (a) => {
      if (!a || !a.action) return;
      const send = ACTION_POSTS.get(String(a.action).toLowerCase());
      if (!send || !url()) return;
      const d = detailsOf(a.details);
      send({
        player: a.player || a.targetName || d.player
          || nameById('SELECT name FROM players WHERE id = ?', a.targetPlayerId)
          || (a.targetPlayerId == null ? null : 'player #' + a.targetPlayerId),
        reason: a.reason || d.reason,
        message: a.message || d.message,
        interval: a.interval || d.interval,
        by: a.by || a.username
          || nameById('SELECT username AS name FROM users WHERE id = ?', a.userId)
          || (a.userId == null ? 'system' : 'user #' + a.userId),
        auto: !!a.auto,
      });
    });
  }

  return { postFlag, postBan, postKick, postWarn, postMatchEnd, postAdminCall, postJoinAlert };
}

module.exports = { createWebhook };
