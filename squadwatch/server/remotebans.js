'use strict';
// Squad remote ban list (docs/BATCH3-CONTRACTS.md §3). The game server reads
// ban files from the URLs in its RemoteBanListHosts.cfg; GET
// /api/remote/bans.cfg?key=K serves the panel's active, unexpired bans there
// in Squad's Bans.cfg line format.
// - Switched off, a wrong key and a missing key all answer exactly like an
//   unknown route (404, same body). The key is compared in constant time and
//   never logged or audited.
// - A line carries an id, the expiry and the reason only — never the private
//   staff note — and only ids that validate, so one bad row can never break
//   the game server's parse of the file.
// - At most 30 fetches a minute per client address, the wrong-key ones included.
// - Audit rows are read by roles without `settings`: a config.json save that
//   failed is recorded as NOT_SAVED, never as the error text (OS messages,
//   paths); the caller's answer carries that text, scrubbed of secrets.
//
// createRemoteBans({db, config, auth, settings: {apply}}) ->
//   {registerRoutes(api), start(), stop()}
const crypto = require('node:crypto');
const { createLoginLimiter } = require('./auth');
const { STEAM_ID_RE } = require('./admin');
const { NOT_SAVED } = require('./config');

const FETCH_PATH = '/api/remote/bans.cfg';
const FETCHES_PER_MINUTE = 30;
const EOS_ID_RE = /^[0-9a-f]{32}$/;

function newKey() {
  return crypto.randomBytes(24).toString('base64url');
}

// Constant time whatever the lengths: both sides are hashed first.
function keyMatches(given, expected) {
  if (typeof expected !== 'string' || expected === '') return false;
  const a = crypto.createHash('sha256').update(String(given == null ? '' : given)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function cleanReason(v) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function createRemoteBans(deps) {
  const d = deps || {};
  const db = d.db;
  const config = d.config || {};
  const auth = d.auth;
  const settings = d.settings;
  if (!db || !auth) throw new Error('remote ban list needs db and auth');
  const limiter = createLoginLimiter({ max: FETCHES_PER_MINUTE, windowMs: 60000 });
  let lastFetch = null; // {at, from}: the latest fetch with the right key

  // Read live: the Settings API changes config.remoteBanList in place.
  function conf() {
    const r = config.remoteBanList && typeof config.remoteBanList === 'object' ? config.remoteBanList : {};
    return {
      enabled: r.enabled === true,
      includeEos: r.includeEos === true,
      key: typeof r.key === 'string' ? r.key : '',
    };
  }

  // Full fetch URL from web.publicUrl, or null without a key or a usable URL.
  function urlFor(key) {
    if (!key) return null;
    const pub = String((config.web && config.web.publicUrl) || '').trim();
    if (!pub) return null;
    let u;
    try {
      u = new URL(pub);
    } catch (_e) {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}${FETCH_PATH}?key=${encodeURIComponent(key)}`;
  }

  // {lines, skippedNoSteam}: one line per active, unexpired ban and id; a ban
  // with no SteamID64 (nor, when EOS lines are on, an EOS id) is left out.
  function buildList() {
    const includeEos = conf().includeEos;
    const rows = db.prepare(
      `SELECT b.id, b.steam_id, b.eos_id, b.expires_at, b.reason, p.steam_id AS p_steam, p.eos_id AS p_eos
         FROM bans b LEFT JOIN players p ON p.id = b.player_id
        WHERE b.active = 1 AND (b.expires_at IS NULL OR b.expires_at > ?) ORDER BY b.id`
    ).all(Date.now());
    const lines = [];
    let skippedNoSteam = 0;
    for (const r of rows) {
      const steam = [r.steam_id, r.p_steam].map((v) => (v == null ? '' : String(v).trim()))
        .find((v) => STEAM_ID_RE.test(v)) || null;
      const eos = includeEos
        ? [r.eos_id, r.p_eos].map((v) => (v == null ? '' : String(v).trim().toLowerCase()))
          .find((v) => EOS_ID_RE.test(v)) || null
        : null;
      if (!steam && !eos) {
        skippedNoSteam++;
        continue;
      }
      const expiry = r.expires_at == null ? 0 : Math.floor(Number(r.expires_at) / 1000);
      const reason = cleanReason(r.reason);
      if (steam) lines.push(`${steam}:${expiry} //${reason}`);
      if (eos) lines.push(`${eos}:${expiry} //${reason}`);
    }
    return { lines, skippedNoSteam };
  }

  function status() {
    const c = conf();
    const { lines, skippedNoSteam } = buildList();
    return {
      enabled: c.enabled,
      includeEos: c.includeEos,
      url: urlFor(c.key),
      lines: lines.length,
      skippedNoSteam,
      lastFetchAt: lastFetch ? lastFetch.at : null,
      lastFetchFrom: lastFetch ? lastFetch.from : null,
    };
  }

  function registerRoutes(api) {
    // Persists + applies like POST /api/settings; its messages never echo
    // secret values.
    function apply(patch) {
      if (!settings || typeof settings.apply !== 'function') throw new api.ApiErr(500, 'settings runtime unavailable');
      let res;
      try {
        res = settings.apply(patch);
      } catch (e) {
        const msg = api.scrubText(e && e.message ? e.message : String(e));
        throw new api.ApiErr(/demo settings/i.test(msg) ? 403 : 400, msg);
      }
      return res && Array.isArray(res.changedPaths) ? res : { changedPaths: [] };
    }
    const savedForAudit = (res) => (res.persistError ? NOT_SAVED : null);
    const savedForCaller = (res) => (res.persistError ? api.scrubText(String(res.persistError)) : null);

    api.route('GET', /^\/api\/remote\/bans\.cfg$/, { public: true }, (ctx) => {
      const lim = limiter.attempt(ctx.ip);
      if (!lim.ok) {
        ctx.res.setHeader('Retry-After', String(lim.retryAfterSec || 60));
        return api.json(ctx.res, 429, { error: 'too many requests — try again shortly' });
      }
      const c = conf();
      const keyOk = keyMatches(ctx.query.get('key'), c.key);
      if (!c.enabled || !keyOk) return api.json(ctx.res, 404, { error: 'not found' });
      const { lines } = buildList();
      lastFetch = { at: Date.now(), from: String(ctx.ip || '').slice(0, 64) || null };
      const res = ctx.res;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(lines.length ? `${lines.join('\n')}\n` : '');
    });

    api.route('GET', /^\/api\/remote-bans$/, { perm: 'settings' }, (ctx) => api.json(ctx.res, 200, status()));

    api.route('POST', /^\/api\/remote-bans\/rotate$/, { perm: 'settings' }, (ctx) => {
      const key = newKey();
      const res = apply({ remoteBanList: { key } });
      lastFetch = null; // fetches with the old key say nothing about the new URL
      auth.audit(ctx.user.id, 'remote-bans-rotate', { details: { persistError: savedForAudit(res) } });
      return api.json(ctx.res, 200, { ok: true, url: urlFor(key), persistError: savedForCaller(res) });
    });

    api.route('POST', /^\/api\/remote-bans$/, { perm: 'settings' }, (ctx) => {
      const patch = {};
      for (const k of ['enabled', 'includeEos']) {
        if (ctx.body[k] === undefined) continue;
        if (typeof ctx.body[k] !== 'boolean') throw new api.ApiErr(400, `${k} must be true or false`);
        patch[k] = ctx.body[k];
      }
      if (!Object.keys(patch).length) throw new api.ApiErr(400, 'nothing to update (enabled, includeEos)');
      const keyGenerated = patch.enabled === true && !conf().key;
      if (keyGenerated) patch.key = newKey();
      const res = apply({ remoteBanList: patch });
      if (res.changedPaths.length) {
        const c = conf();
        auth.audit(ctx.user.id, 'remote-bans-update', {
          details: {
            enabled: c.enabled, includeEos: c.includeEos, keyGenerated,
            changed: res.changedPaths, persistError: savedForAudit(res),
          },
        });
      }
      return api.json(ctx.res, 200, Object.assign({ ok: true, persistError: savedForCaller(res) }, status()));
    });
  }

  return {
    registerRoutes,
    start() {},
    stop() { limiter.stop(); },
  };
}

module.exports = { createRemoteBans, keyMatches };
