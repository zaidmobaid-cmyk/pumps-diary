'use strict';
// Optional Steam avatar/persona fetcher (SPEC §1/§11). If config.steamApiKey is
// set, batches ISteamUser/GetPlayerSummaries calls (global fetch) hourly for
// players seen in the last 24h and stores players.avatar/persona_fetched_at.
// Silent no-op without a key; NEVER throws on network failure (log.warn only).
//
// createSteam({db, config}) -> {start(), stop(), fetchNow(steamIds)}

const { log } = require('./util');

const API = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const BATCH = 100; // Steam API max steamids per request
const HOUR_MS = 60 * 60 * 1000;

function createSteam(deps) {
  const db = deps.db;
  const config = deps.config || {};
  const key = String(config.steamApiKey || '').trim();
  let timer = null;

  function enabled() {
    return key.length > 0;
  }

  // Fetch summaries for the given steamIds and store avatar/persona_fetched_at.
  // Resolves with the array of summaries that were applied ([] on any failure).
  async function fetchNow(steamIds) {
    if (!enabled()) return [];
    const ids = Array.from(new Set((steamIds || []).map(String).filter((s) => /^7656\d{13}$/.test(s))));
    if (!ids.length) return [];
    const applied = [];
    for (let off = 0; off < ids.length; off += BATCH) {
      const chunk = ids.slice(off, off + BATCH);
      let players;
      try {
        const url = API + '?key=' + encodeURIComponent(key) + '&steamids=' + chunk.join(',');
        const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
          log.warn('steam', 'GetPlayerSummaries HTTP ' + res.status);
          continue;
        }
        const body = await res.json();
        players = body && body.response && Array.isArray(body.response.players)
          ? body.response.players
          : [];
      } catch (e) {
        log.warn('steam', 'GetPlayerSummaries failed: ' + (e && e.message ? e.message : e));
        continue;
      }
      const now = Date.now();
      for (const p of players) {
        if (!p || !p.steamid) continue;
        const avatar = p.avatarfull || p.avatarmedium || p.avatar || null;
        try {
          db.prepare('UPDATE players SET avatar = ?, persona_fetched_at = ? WHERE steam_id = ?')
            .run(avatar, now, String(p.steamid));
          applied.push(p);
        } catch (e) {
          log.warn('steam', 'failed to store avatar for ' + p.steamid + ': ' + e.message);
        }
      }
    }
    return applied;
  }

  // One sweep: everyone seen in the last 24h who has a steam id.
  async function sweep() {
    if (!enabled()) return;
    let rows;
    try {
      rows = db.prepare(
        'SELECT steam_id FROM players WHERE steam_id IS NOT NULL AND last_seen >= ?'
      ).all(Date.now() - 24 * HOUR_MS);
    } catch (e) {
      log.warn('steam', 'player query failed: ' + e.message);
      return;
    }
    const ids = rows.map((r) => r.steam_id).filter(Boolean);
    if (!ids.length) return;
    const applied = await fetchNow(ids);
    if (applied.length) log.info('steam', 'refreshed ' + applied.length + ' avatars/personas');
  }

  function start() {
    if (!enabled()) return; // silent no-op without a key
    sweep().catch((e) => log.warn('steam', 'sweep failed: ' + (e && e.message ? e.message : e)));
    timer = setInterval(() => {
      sweep().catch((e) => log.warn('steam', 'sweep failed: ' + (e && e.message ? e.message : e)));
    }, HOUR_MS);
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, fetchNow };
}

module.exports = { createSteam };
