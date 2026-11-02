#!/usr/bin/env node
'use strict';
// SquadWatch boot & wiring (SPEC §16). Everything meets here:
//   config -> db -> auth -> state -> rcon -> logsource -> parser wiring ->
//   admin -> ingest -> steam/webhook -> pollers -> api.listen
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { log } = require('./util');
const { loadConfig, applySettingsPatch, persistUserConfig } = require('./config');
const { openDb } = require('./db');
const { createAuth } = require('./auth');
const LiveState = require('./state');
const SquadRcon = require('./rcon');
const { createLogSource, modeAvailable } = require('./logsource');
const parser = require('./parser');
const Ingest = require('./ingest');
const { createAdmin } = require('./admin');
const { createApi } = require('./api');
const { createSteam } = require('./steam');
const { createWebhook } = require('./webhook');

const ROOT = path.resolve(__dirname, '..');
const VERSION = (() => {
  try { return require('../package.json').version || '0.0.0'; } catch (_e) { return '0.0.0'; }
})();

// ------------------------------------------------------------------ CLI args
function parseArgs(argv) {
  const a = { demo: false, port: null, config: null, createAdmin: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--demo') a.demo = true;
    else if (v === '--port') a.port = parseInt(argv[++i], 10);
    else if (v === '--config') a.config = argv[++i];
    else if (v === '--create-admin') {
      const user = argv[++i];
      const pass = argv[++i];
      const role = argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? argv[++i] : 'admin';
      a.createAdmin = { user, pass, role };
    } else if (v === '--help' || v === '-h') {
      console.log('usage: node server/index.js [--demo] [--port N] [--config path] [--create-admin user pass [role]]');
      process.exit(0);
    }
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ----------------------------------------------------------------- config
  let configPath = args.config || path.join(ROOT, 'config.json');
  if (!fs.existsSync(configPath)) {
    if (args.demo) {
      configPath = path.join(ROOT, 'config.example.json'); // demo needs no real creds
    } else {
      log.error('boot', `no config at ${configPath} — copy config.example.json to config.json (or run with --demo)`);
      process.exit(1);
    }
  }
  const cfg = loadConfig(configPath);

  let demo = null;
  if (args.demo) {
    cfg.demo = true;
    const dataDir = path.join(ROOT, 'data');
    demo = await require('./demo').startDemo({ dataDir });
    cfg.squad = { rconHost: demo.rconHost, rconPort: demo.rconPort, rconPassword: demo.rconPassword };
    cfg.log = Object.assign({}, cfg.log, { mode: 'local', path: demo.logPath, backfill: true, pollMs: 700 });
    cfg.dbPath = path.join(dataDir, 'demo.db');
    if (!cfg.web) cfg.web = {};
    // Always bind demo to loopback: config defaults set web.host to 0.0.0.0,
    // and /api/bootstrap serves the owner-setup token in demo (SPEC §19.3.15
    // allows that only because demo stays local).
    cfg.web.host = '127.0.0.1';
    // Demo fabricates flags/kicks/players nonstop — never deliver them to a
    // real config.json's Discord channel or burn its Steam API key.
    cfg.discordWebhook = '';
    cfg.steamApiKey = '';
  }
  if (Number.isFinite(args.port)) cfg.web.port = args.port;
  if (cfg.demo === true && !args.demo) {
    // "demo": true left in config.json — keep the panel local rather than open.
    log.warn('boot', 'config.json sets demo:true without the --demo flag; binding to 127.0.0.1. Remove "demo": true for a real deployment.');
    cfg.web.host = '127.0.0.1';
  }

  const dbPath = path.isAbsolute(cfg.dbPath) ? cfg.dbPath : path.join(ROOT, cfg.dbPath);
  const dataDir = path.dirname(dbPath);

  // --------------------------------------------------------------- db + auth
  const db = openDb(dbPath);
  db.migrate();
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  const auth = createAuth({ db, config: cfg, bus });

  if (args.createAdmin) {
    const { user, pass, role } = args.createAdmin;
    if (!user || !pass) { log.error('boot', '--create-admin needs: <username> <password> [role]'); process.exit(1); }
    const u = auth.createUser(user, pass, role);
    log.info('boot', `created ${u.role} "${u.username}" (id ${u.id})`);
    db.close();
    if (demo) await demo.stop();
    process.exit(0);
  }

  // ------------------------------------------------------------ live pieces
  const state = new LiveState();
  const rcon = new SquadRcon({
    host: cfg.squad.rconHost,
    port: cfg.squad.rconPort,
    password: cfg.squad.rconPassword,
  });

  // -------------------------------------------------- parser health tracking
  const unmatchedTimes = [];
  const unmatchedSamples = [];
  function recordUnmatched(line) {
    const now = Date.now();
    unmatchedTimes.push(now);
    if (unmatchedTimes.length > 20000) unmatchedTimes.splice(0, unmatchedTimes.length - 10000);
    unmatchedSamples.push(line.length > 300 ? line.slice(0, 300) + '…' : line);
    if (unmatchedSamples.length > 10) unmatchedSamples.shift();
    if (cfg.logUnparsed) log.info('parser', `unmatched: ${line.slice(0, 200)}`);
  }
  const parserHealth = {
    count24h() {
      const cutoff = Date.now() - 86400000;
      let i = 0;
      while (i < unmatchedTimes.length && unmatchedTimes[i] < cutoff) i++;
      if (i > 0) unmatchedTimes.splice(0, i);
      return unmatchedTimes.length;
    },
    samples() { return unmatchedSamples.slice(); },
  };

  // ------------------------------------------------------------- log source
  // Swappable: saving new log settings replaces the instance (its mode/path
  // are baked at construction) while the web server and ingest stay up.
  const src = { logsource: null };
  const tzOff = () => Number((cfg.log && cfg.log.timezoneOffsetMinutes) || 0);
  function logConfigured() {
    const l = cfg.log || {};
    if (l.mode === 'ftp') return !!(l.ftp && l.ftp.host);
    if (l.mode === 'sftp') return !!(l.sftp && l.sftp.host);
    return !!l.path; // local
  }
  function attachLogsource(ls) {
    ls.on('line', (line) => {
      try {
        const ev = parser.parseLogLine(line, tzOff());
        if (ev) bus.emit('log-event', ev);
        else recordUnmatched(line);
      } catch (e) {
        log.warn('parser', `threw on line: ${e.message}`);
        recordUnmatched(line);
      }
    });
    ls.on('status', (s) => bus.emit('log-status', s));
    return ls;
  }
  src.logsource = attachLogsource(createLogSource(cfg.log, { dataDir }));

  // ---------------------------------------------------------------- rcon i/o
  rcon.on('chat-packet', (body) => {
    try {
      const p = parser.parseChatPacket(body);
      if (p) bus.emit('chat-packet-parsed', p);
    } catch (e) {
      log.warn('parser', `chat packet threw: ${e.message}`);
    }
  });
  rcon.on('connected', () => { bus.emit('rcon-status'); kickPolls(true); });
  rcon.on('disconnected', () => {
    state.noteRconDown(); // next ListSquads is a baseline, not disband evidence
    bus.emit('rcon-status');
  });
  rcon.on('error', (e) => log.error('rcon', e && e.message ? e.message : String(e)));

  // state -> bus bridge (api + ingest listen on the bus)
  state.on('serverinfo-updated', (info) => bus.emit('serverinfo-updated', info));
  state.on('squad-disbanded', (ev) => bus.emit('squad-disbanded', ev));

  // ------------------------------------------------------- admin + ingest
  const admin = createAdmin({ db, rcon, state, auth, config: cfg, layersCache: () => state.layers });
  const ingest = new Ingest({ db, state, bus, config: cfg, admin });
  ingest.startTimers();

  // ------------------------------------------------------ steam + webhook
  let steam = createSteam({ db, config: cfg, state });
  if (steam && typeof steam.start === 'function') steam.start();
  // createWebhook self-wires its bus listeners (flag / match-end /
  // admin-action) — wiring them again here double-posted every Discord alert.
  createWebhook({ config: cfg, bus });

  // ---------------------------------------------------------------- pollers
  const timers = [];
  const lastPollErr = new Map();
  function pollErr(tag, e) {
    const msg = e && e.message ? e.message : String(e);
    if (lastPollErr.get(tag) !== msg) {
      lastPollErr.set(tag, msg);
      log.warn('poll', `${tag}: ${msg}`);
    }
  }
  function connected() { const s = rcon.status; return s && s.connected && s.authed; }

  async function pollPlayers() {
    if (!connected()) return;
    try {
      const parsed = parser.parseListPlayers(await rcon.exec('ListPlayers'));
      state.applyListPlayers(parsed);
      bus.emit('players-updated');
      lastPollErr.delete('players');
    } catch (e) { pollErr('players', e); }
  }
  async function pollSquads() {
    if (!connected()) return;
    try {
      state.applyListSquads(parser.parseListSquads(await rcon.exec('ListSquads')));
      lastPollErr.delete('squads');
    } catch (e) { pollErr('squads', e); }
  }
  async function pollServerInfo() {
    if (!connected()) return;
    try {
      const info = parser.parseServerInfo(await rcon.exec('ShowServerInfo'));
      if (info) state.applyServerInfo(info);
      lastPollErr.delete('serverinfo');
    } catch (e) { pollErr('serverinfo', e); }
  }
  async function pollNextMap() {
    if (!connected()) return;
    try {
      const r = parser.parseNextMap(await rcon.exec('ShowNextMap'));
      if (r && r.layer) state.nextLayer = r.layer;
      lastPollErr.delete('nextmap');
    } catch (e) { pollErr('nextmap', e); }
  }
  async function refreshLayers() {
    if (!connected()) return;
    try {
      const layers = parser.parseLayers(await rcon.exec('ListLayers'));
      if (Array.isArray(layers) && layers.length) {
        state.layers = layers;
        state.layersCachedAt = Date.now();
      }
      lastPollErr.delete('layers');
    } catch (e) { pollErr('layers', e); }
  }
  function kickPolls(withLayers) {
    if (withLayers) refreshLayers();
    pollServerInfo().then(pollPlayers).then(pollSquads).then(pollNextMap);
  }
  timers.push(setInterval(pollPlayers, 15000));
  timers.push(setInterval(pollSquads, 15000));
  timers.push(setInterval(pollServerInfo, 30000));
  timers.push(setInterval(pollNextMap, 60000));
  timers.push(setInterval(refreshLayers, 6 * 3600 * 1000));

  // ------------------------------------- runtime settings (docs/R-I-S §3)
  // The Settings API changes cfg IN PLACE (ingest/webhook/api read it live),
  // persists to config.json, and re-points the live pieces: the SAME rcon
  // instance is retargeted (api/admin/pollers hold it by closure), the
  // logsource is swapped via the src holder, steam is rebuilt on key change.
  function applySettings(patch) {
    if (args.demo) throw new Error('demo settings are fixed');
    // Refuse an ftp/sftp save while its optional package is missing BEFORE
    // anything is applied or persisted — otherwise the change half-applies
    // (cfg + config.json already switched, logsource dead) and the next boot
    // would trip over the same throw.
    const candidateMode = patch && patch.log && typeof patch.log.mode === 'string'
      ? patch.log.mode : cfg.log.mode;
    if (candidateMode === 'ftp' || candidateMode === 'sftp') {
      const avail = modeAvailable(candidateMode);
      if (!avail.ok) throw new Error(avail.error);
    }
    const res = applySettingsPatch(cfg, patch);
    if (!res.changedPaths.length) return res;
    try {
      persistUserConfig(configPath, res.changedPaths, cfg);
    } catch (e) {
      log.warn('settings', `config.json write failed: ${e.message}`);
      res.persistError = e.message;
    }
    const touched = (prefix) => res.changedPaths.some((p) => p === prefix || p.startsWith(prefix + '.'));
    if (touched('squad')) {
      rcon.close();
      rcon.host = cfg.squad.rconHost;
      rcon.port = cfg.squad.rconPort;
      rcon.password = cfg.squad.rconPassword;
      if (cfg.squad.rconHost) rcon.connect(); // also recovers a bad-password stop
      else bus.emit('rcon-status');
    }
    if (touched('log')) {
      const old = src.logsource;
      try { old.stop(); } catch (_e) { /* */ }
      // A tick in flight when stop() lands may still emit: detach so the dying
      // instance can neither double-ingest lines nor overwrite the status the
      // new instance is about to report.
      old.removeAllListeners('line');
      old.removeAllListeners('status');
      bus.emit('log-status', { mode: cfg.log.mode, ok: null });
      src.logsource = attachLogsource(createLogSource(cfg.log, { dataDir }));
      if (logConfigured()) {
        try {
          src.logsource.start();
        } catch (e) {
          log.error('settings', `log source failed to start: ${e.message}`);
          bus.emit('log-status', { mode: cfg.log.mode, ok: false, error: e.message });
        }
      }
    }
    if (touched('steamApiKey')) {
      try { if (steam && steam.stop) steam.stop(); } catch (_e) { /* */ }
      steam = createSteam({ db, config: cfg, state });
      if (steam && typeof steam.start === 'function') steam.start();
    }
    if (touched('flags.chatWatchlist') && typeof ingest.refreshWatchlist === 'function') {
      ingest.refreshWatchlist();
    }
    log.info('settings', `applied: ${res.changedPaths.join(', ')}`);
    return res;
  }

  // One-shot RCON probe with candidate credentials — its own throwaway client,
  // the live connection is never touched. null password = use the saved one.
  function testRcon({ host, port, password } = {}) {
    const h = String(host == null ? '' : host).trim();
    const p = Number(port);
    if (!h || !Number.isInteger(p) || p < 1 || p > 65535) {
      return Promise.resolve({ ok: false, error: 'enter the RCON host and port first' });
    }
    // null/absent = saved password; '' tests a genuinely empty password, the
    // same meaning '' has when saving (clear) — Test must validate what Save
    // would produce.
    const pass = password == null ? cfg.squad.rconPassword : String(password);
    return new Promise((resolve) => {
      const probe = new SquadRcon({ host: h, port: p, password: pass });
      let done = false;
      let timer = null;
      const finish = (out) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { probe.close(); } catch (_e) { /* */ }
        resolve(out);
      };
      timer = setTimeout(() => finish({ ok: false, error: 'timed out — host unreachable, port closed, or not an RCON port' }), 8000);
      probe.on('error', (e) => {
        const m = e && e.message ? String(e.message) : 'connection failed';
        if (/auth failed/i.test(m)) finish({ ok: false, error: 'connected, but the RCON password is wrong' });
        // other socket errors: keep waiting — the dial timeout reports once
      });
      probe.on('connected', () => {
        probe.exec('ShowServerInfo', 6000).then((body) => {
          let info = null;
          try { info = parser.parseServerInfo(body); } catch (_e) { info = null; }
          finish({
            ok: true,
            serverName: (info && info.serverName) || null,
            players: info && info.playerCount != null ? info.playerCount : null,
          });
        }).catch((e) => finish({ ok: false, error: `connected and authed, but ShowServerInfo failed: ${e.message}` }));
      });
      probe.connect();
    });
  }

  // One-shot log-source probe (docs/R-I-S §3): local = stat the file; ftp/sftp
  // = dep check, then connect + stat. Patch semantics mirror save: null/absent
  // field = use the saved value.
  async function testLog(logPatch) {
    const given = logPatch || {};
    const mode = typeof given.mode === 'string' && given.mode ? given.mode : cfg.log.mode;
    if (mode === 'local') {
      const p = String(given.path != null ? given.path : cfg.log.path || '');
      if (!p) return { ok: false, error: 'enter the SquadGame.log path first' };
      try {
        const st = fs.statSync(p);
        return { ok: true, sizeBytes: st.size };
      } catch (e) {
        return { ok: false, error: `cannot read ${p}: ${e.code || e.message}` };
      }
    }
    if (mode !== 'ftp' && mode !== 'sftp') return { ok: false, error: `unknown log mode "${mode}"` };
    const avail = modeAvailable(mode);
    if (!avail.ok) return { ok: false, error: avail.error };
    const patchSub = {};
    const sub0 = given[mode] || {};
    for (const k of Object.keys(sub0)) if (sub0[k] != null) patchSub[k] = sub0[k];
    const sub = Object.assign({}, cfg.log[mode], patchSub);
    if (!sub.host) return { ok: false, error: 'enter the host first' };
    if (!sub.path) return { ok: false, error: 'enter the remote log path first' };
    try {
      if (mode === 'ftp') {
        const ftpLib = require('basic-ftp');
        const client = new ftpLib.Client(8000);
        try {
          await client.access({
            host: sub.host, port: sub.port || 21, user: sub.user,
            password: sub.password, secure: !!sub.secure,
          });
          const size = await client.size(sub.path);
          return { ok: true, sizeBytes: size };
        } finally {
          client.close();
        }
      }
      const SftpClient = require('ssh2-sftp-client');
      const client = new SftpClient();
      try {
        await client.connect({
          host: sub.host, port: sub.port || 22, username: sub.user,
          password: sub.password || undefined,
          privateKey: sub.privateKeyPath ? fs.readFileSync(sub.privateKeyPath) : undefined,
          readyTimeout: 8000,
        });
        const st = await client.stat(sub.path);
        return { ok: true, sizeBytes: st.size };
      } finally {
        try { await client.end(); } catch (_e) { /* */ }
      }
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : 'connection failed' };
    }
  }

  // -------------------------------------------------------------------- api
  // demoCli is deliberately the CLI flag, never cfg.demo: config.json must not
  // be able to turn on demo-only conveniences like the bootstrap setup token.
  const api = createApi({
    db, state, ingest, rcon, bus, auth, admin, config: cfg, parserHealth,
    version: VERSION, demoCli: args.demo,
    runtime: { applySettings, testRcon, testLog },
  });

  if (cfg.squad.rconHost) rcon.connect();
  else log.info('boot', 'no Squad server linked yet — open Settings in the panel to connect one');
  if (logConfigured()) {
    // Never let the log source take the whole panel down (a missing optional
    // ftp/sftp package, a bad path): boot on, report it in the status strip.
    try {
      src.logsource.start();
    } catch (e) {
      log.error('boot', `log source failed to start: ${e.message} — fix it in Settings`);
      bus.emit('log-status', { mode: cfg.log.mode, ok: false, error: e.message });
    }
  } else {
    log.info('boot', 'log source not configured — set it in Settings to enable kill/chat tracking');
  }

  const host = cfg.web.host || '0.0.0.0';
  const port = cfg.web.port || 8787;
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(port, host, resolve);
  });

  const shownHost = host === '0.0.0.0' ? 'localhost' : host;
  log.info('boot', '────────────────────────────────────────────────');
  log.info('boot', `SquadWatch v${VERSION} up: http://${shownHost}:${port}${cfg.demo ? '  (DEMO MODE)' : ''}`);
  const rconShown = cfg.squad.rconHost ? `${cfg.squad.rconHost}:${cfg.squad.rconPort}` : 'not linked (set in Settings)';
  log.info('boot', `db: ${dbPath} (${db.backend})  ·  log: ${cfg.log.mode}  ·  rcon: ${rconShown}`);
  if (auth.setupToken) {
    log.info('boot', `FIRST RUN — create the owner account in the browser. Setup token: ${auth.setupToken}`);
  }
  log.info('boot', '────────────────────────────────────────────────');

  // --------------------------------------------------------------- shutdown
  let shuttingDown = false;
  async function shutdown(sig) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('boot', `${sig} — shutting down`);
    for (const t of timers) clearInterval(t);
    try { src.logsource.stop(); } catch (_e) { /* */ }
    try { if (ingest.stop) ingest.stop(); else ingest.stopTimers(); } catch (_e) { /* */ }
    try { if (steam && steam.stop) steam.stop(); } catch (_e) { /* */ }
    try { rcon.close(); } catch (_e) { /* */ }
    try { api.close(); } catch (_e) { /* */ }
    if (demo) { try { await demo.stop(); } catch (_e) { /* */ } }
    try { db.close(); } catch (_e) { /* */ }
    process.exit(0);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Windows cannot deliver catchable signals to a child (kill() there is
  // TerminateProcess), so a parent needing a graceful stop spawns us with an
  // IPC channel and sends 'shutdown' instead.
  if (process.send) process.on('message', (m) => { if (m === 'shutdown') shutdown('IPC'); });
}

main().catch((e) => {
  log.error('boot', e && e.stack ? e.stack : String(e));
  process.exit(1);
});
