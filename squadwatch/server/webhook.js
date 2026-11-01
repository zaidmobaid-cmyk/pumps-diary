'use strict';
// Optional Discord webhook notifier (SPEC §1/§11). Posts simple embeds to
// config.discordWebhook via global fetch. Every post is gated by
// config.webhookEvents, fire-and-forget (errors are logged, never thrown),
// and a complete no-op when no webhook URL is configured.
//
// createWebhook({config, bus?}) ->
//   {postFlag, postBan, postKick, postWarn, postMatchEnd}
// When a bus is provided, flag / match-end / admin-action events are wired up
// automatically (integrator may also call the post* functions directly).

const { log } = require('./util');

const COLORS = {
  red: 0xe5484d,
  amber: 0xf0a020,
  blue: 0x4ba3f5,
  green: 0x30a46c,
  purple: 0x9d7bd8,
};

function createWebhook(deps) {
  const config = (deps && deps.config) || {};
  const bus = deps && deps.bus;
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

  // Fire-and-forget POST of one embed. Never throws.
  function post(embed) {
    const u = url();
    if (!u) return; // no-op when unset
    const body = JSON.stringify({
      username: 'SquadWatch',
      embeds: [Object.assign({ timestamp: new Date().toISOString() }, embed)],
    });
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
  function postFlag(flag) {
    if (!events.flags || !flag) return;
    const sev = flag.severity | 0;
    post({
      title: 'Flag: ' + trunc(flag.type || 'flag', 64) + ' (sev ' + sev + ')',
      color: sev >= 3 ? COLORS.red : sev === 2 ? COLORS.amber : COLORS.blue,
      description: trunc(typeof flag.details === 'string' ? flag.details : JSON.stringify(flag.details || ''), 1000),
      fields: [
        { name: 'Player', value: trunc(playerName(flag.player), 256), inline: true },
        { name: 'Match', value: String(flag.matchId != null ? flag.matchId : '—'), inline: true },
      ],
    });
  }

  // {player|name, interval, reason, by?}
  function postBan(ban) {
    if (!events.bans || !ban) return;
    post({
      title: 'Player banned',
      color: COLORS.red,
      fields: [
        { name: 'Player', value: trunc(playerName(ban.player || ban.name), 256), inline: true },
        { name: 'Interval', value: trunc(ban.interval != null ? ban.interval : 'perm', 64), inline: true },
        { name: 'Reason', value: trunc(ban.reason || '—', 512), inline: false },
        { name: 'By', value: trunc(ban.by || 'system', 128), inline: true },
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
        { name: 'Player', value: trunc(playerName(kick.player || kick.name), 256), inline: true },
        { name: 'Reason', value: trunc(kick.reason || '—', 512), inline: false },
        { name: 'By', value: trunc(kick.by || 'system', 128), inline: true },
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
        { name: 'Player', value: trunc(playerName(warn.player || warn.name), 256), inline: true },
        { name: 'Message', value: trunc(warn.message || '—', 512), inline: false },
        { name: 'By', value: trunc(warn.by || 'system', 128), inline: true },
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

  // Optional bus wiring — the integrator may rely on this or call post* itself.
  if (bus && typeof bus.on === 'function') {
    bus.on('flag', postFlag);
    bus.on('match-end', postMatchEnd);
    bus.on('admin-action', (a) => {
      if (!a || !a.action) return;
      const act = String(a.action).toLowerCase();
      const payload = {
        player: a.player || a.targetName || (a.details && a.details.player),
        reason: a.reason || (a.details && a.details.reason),
        message: a.message || (a.details && a.details.message),
        interval: a.interval || (a.details && a.details.interval),
        by: a.by || a.username || (a.userId == null ? 'system' : 'user #' + a.userId),
        auto: !!a.auto,
      };
      if (act.includes('kick')) postKick(payload);
      else if (act.includes('unban')) void 0;
      else if (act.includes('ban')) postBan(payload);
      else if (act.includes('warn')) postWarn(payload);
    });
  }

  return { postFlag, postBan, postKick, postWarn, postMatchEnd };
}

module.exports = { createWebhook };
