#!/usr/bin/env node
'use strict';
// SquadWatch boot & wiring (SPEC §16). Everything meets here:
//   config -> db -> auth -> state -> rcon -> logsource -> parser wiring ->
//   admin -> ingest -> steam/webhook -> pollers -> api.listen
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { log } = require('./util');
const { loadConfig } = require('./config');
const { openDb } = require('./db');
const { createAuth } = require('./auth');
const LiveState = require('./state');
const SquadRcon = require('./rcon');
const { createLogSource } = require('./logsource');
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
    if (!cfg.web.host) cfg.web.host = '127.0.0.1';
  }
  if (Number.isFinite(args.port)) cfg.web.port = args.port;

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
  const logsource = createLogSource(cfg.log, { dataDir });
  const tzOff = (cfg.log && cfg.log.timezoneOffsetMinutes) || 0;
  logsource.on('line', (line) => {
    try {
      const ev = parser.parseLogLine(line, tzOff);
      if (ev) bus.emit('log-event', ev);
      else recordUnmatched(line);
    } catch (e) {
      log.warn('parser', `threw on line: ${e.message}`);
      recordUnmatched(line);
    }
  });
  logsource.on('status', (s) => bus.emit('log-status', s));

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
  rcon.on('disconnected', () => bus.emit('rcon-status'));
  rcon.on('error', (e) => log.error('rcon', e && e.message ? e.message : String(e)));

  // state -> bus bridge (api + ingest listen on the bus)
  state.on('serverinfo-updated', (info) => bus.emit('serverinfo-updated', info));

  // ------------------------------------------------------- admin + ingest
  const admin = createAdmin({ db, rcon, state, auth, config: cfg, layersCache: () => state.layers });
  const ingest = new Ingest({ db, state, bus, config: cfg, admin });
  ingest.startTimers();

  // ------------------------------------------------------ steam + webhook
  const steam = createSteam({ db, config: cfg, state });
  if (steam && typeof steam.start === 'function') steam.start();
  const webhook = createWebhook({ config: cfg, bus });
  bus.on('flag', (f) => { try { webhook.postFlag(f); } catch (_e) { /* fire and forget */ } });
  bus.on('match-end', (m) => { try { webhook.postMatchEnd(m); } catch (_e) { /* */ } });
  bus.on('admin-action', (row) => {
    try {
      if (!row || !row.action) return;
      if (row.action === 'kick') webhook.postKick(row);
      else if (row.action === 'ban') webhook.postBan(row);
      else if (row.action === 'warn') webhook.postWarn(row);
    } catch (_e) { /* fire and forget */ }
  });

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

  // -------------------------------------------------------------------- api
  const api = createApi({ db, state, ingest, rcon, bus, auth, admin, config: cfg, parserHealth, version: VERSION });

  rcon.connect();
  logsource.start();

  const host = cfg.web.host || '0.0.0.0';
  const port = cfg.web.port || 8787;
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(port, host, resolve);
  });

  const shownHost = host === '0.0.0.0' ? 'localhost' : host;
  log.info('boot', '────────────────────────────────────────────────');
  log.info('boot', `SquadWatch v${VERSION} up: http://${shownHost}:${port}${cfg.demo ? '  (DEMO MODE)' : ''}`);
  log.info('boot', `db: ${dbPath} (${db.backend})  ·  log: ${cfg.log.mode}  ·  rcon: ${cfg.squad.rconHost}:${cfg.squad.rconPort}`);
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
    try { logsource.stop(); } catch (_e) { /* */ }
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
}

main().catch((e) => {
  log.error('boot', e && e.stack ? e.stack : String(e));
  process.exit(1);
});
