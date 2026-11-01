'use strict';
// Integration test (SPEC §17): boot the REAL server (server/index.js, spawned as
// a child process) against an in-process MockSquad, drive a full scenario
// through the mock's scripting API, and verify it end-to-end through the HTTP
// API — first-run setup token, login cookies, overview/players/matches/chat/
// flags reads, admin kick via RCON, role gating (owner vs viewer), the SSE
// stream, and graceful SIGTERM shutdown.
//
// Everything runs on ephemeral/random ports and in a fresh temp dir; nothing
// touches the repo's data/ dir or any running demo instance.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const { MockSquad } = require('./mock-squad');

const ROOT = path.resolve(__dirname, '..');
const SERVER_JS = path.join(ROOT, 'server', 'index.js');
const RCON_PASSWORD = 'integration-secret';

// ---------------------------------------------------------------- tiny utils

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll `fn` until it returns a truthy value; throws (with the label) on timeout.
async function until(fn, { timeoutMs = 15000, intervalMs = 150, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      lastErr = null;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for: ${label}` +
        (lastErr ? ` (last error: ${lastErr.message})` : '')
      );
    }
    await sleep(intervalMs);
  }
}

// All players of a snapshot (squad members + unassigned across teams).
function snapshotPlayers(snap) {
  const out = [];
  for (const t of (snap && snap.teams) || []) {
    for (const sq of t.squads || []) out.push(...(sq.players || []));
    out.push(...(t.unassigned || []));
  }
  return out;
}

function snapshotSquadNames(snap) {
  const out = [];
  for (const t of (snap && snap.teams) || []) {
    for (const sq of t.squads || []) if (sq.name) out.push(sq.name);
  }
  return out;
}

// fetch wrapper with a cookie jar + the Origin header the CSRF check requires.
function makeApi(base) {
  return async function api(jar, method, p, body) {
    const headers = { origin: base, accept: 'application/json' };
    if (jar && jar.cookie) headers.cookie = jar.cookie;
    const init = { method, headers };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body == null ? {} : body);
    }
    const res = await fetch(base + p, init);
    if (jar && typeof res.headers.getSetCookie === 'function') {
      for (const sc of res.headers.getSetCookie()) {
        const m = /^sw_session=([^;]*)/.exec(sc);
        if (m) jar.cookie = m[1] ? `sw_session=${m[1]}` : null;
      }
    }
    const text = await res.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch (_e) { json = null; }
    }
    return { status: res.status, json, text };
  };
}

// Plain http request reading SSE chunks incrementally (fetch would buffer less
// conveniently); exposes waitFor(regex) over the accumulated stream text.
function openStream(port, cookie) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/stream',
        method: 'GET',
        headers: { cookie, accept: 'text/event-stream' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`/api/stream answered ${res.statusCode}`));
          return;
        }
        res.setEncoding('utf8');
        const stream = {
          req,
          res,
          buf: '',
          waitFor(re, timeoutMs, label) {
            return new Promise((res2, rej2) => {
              if (re.test(stream.buf)) { res2(true); return; }
              const timer = setTimeout(() => {
                cleanup();
                rej2(new Error(`timed out after ${timeoutMs}ms waiting for ${label} on /api/stream`));
              }, timeoutMs);
              const onData = () => { if (re.test(stream.buf)) { cleanup(); res2(true); } };
              const onEnd = () => { cleanup(); rej2(new Error(`stream ended while waiting for ${label}`)); };
              function cleanup() {
                clearTimeout(timer);
                res.removeListener('data', onData);
                res.removeListener('end', onEnd);
              }
              res.on('data', onData);
              res.on('end', onEnd);
            });
          },
          close() { try { req.destroy(); } catch (_e) { /* already gone */ } },
        };
        res.on('data', (c) => { stream.buf += c; }); // registered first: buf is current when waiters run
        resolve(stream);
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function waitExit(child, ms) {
  return new Promise((resolve, reject) => {
    if (child.exitCode != null || child.signalCode != null) {
      resolve({ code: child.exitCode, signal: child.signalCode });
      return;
    }
    const timer = setTimeout(() => reject(new Error(`child did not exit within ${ms}ms`)), ms);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

// Spawn the real server with a config pointing at the mock. web.port 0 is not
// supported, so pick random high ports and retry on EADDRINUSE.
async function startServer({ tmp, logPath, mock, transcript }) {
  let lastFail = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const cfgPath = path.join(tmp, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      web: { port, host: '127.0.0.1' },
      squad: { rconHost: '127.0.0.1', rconPort: mock.port, rconPassword: RCON_PASSWORD },
      log: { mode: 'local', path: logPath, pollMs: 100, backfill: true },
      dbPath: path.join(tmp, 'squadwatch.db'),
      // demo intentionally NOT set: the setup token must only be printed on stdout.
    }, null, 2));

    const child = spawn(process.execPath, [SERVER_JS, '--config', cfgPath], {
      cwd: ROOT,
      // 'ipc' so the shutdown step can request a graceful stop on Windows,
      // where kill() cannot deliver a catchable signal.
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let buf = '';
    const feed = (c) => {
      buf += c;
      transcript.text = (transcript.text + c).slice(-120000);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 15000);
      const check = (c) => {
        feed(c);
        if (/SquadWatch v[^\n]* up: http/.test(buf)) { clearTimeout(timer); resolve('up'); }
      };
      child.stdout.on('data', check);
      child.stderr.on('data', feed);
      child.once('exit', () => { clearTimeout(timer); resolve('exited'); });
    });
    // keep collecting output for diagnostics after boot
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});

    if (outcome === 'up') {
      // (4) parse the one-time setup token from the FIRST-RUN console line.
      const tokenLine = buf.split('\n').find((l) => l.includes('Setup token'));
      const m = tokenLine ? /([0-9a-f]{32})/.exec(tokenLine) : null;
      return { child, port, setupToken: m ? m[1] : null };
    }
    if (child.exitCode == null) child.kill('SIGKILL');
    lastFail = buf.slice(-2000);
    if (outcome === 'timeout') throw new Error(`server did not print the up banner within 15s:\n${lastFail}`);
    if (!/EADDRINUSE|address already in use/i.test(buf)) {
      throw new Error(`server exited before the banner:\n${lastFail}`);
    }
    // port collision: loop and try another one
  }
  throw new Error(`could not find a free web port in 5 attempts:\n${lastFail}`);
}

// -----------------------------------------------------------------------------

test('integration: full boot — MockSquad + real server + HTTP/SSE scenario (SPEC §17)', async () => {
  // (1) temp dir — never the repo data/ dir.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'squadwatch-int-'));
  const logPath = path.join(tmp, 'SquadGame.log');

  // (2) MockSquad on an ephemeral RCON port, writing the log into the temp dir.
  const mock = new MockSquad({ rconPort: 0, logPath, password: RCON_PASSWORD });
  await mock.start();

  const transcript = { text: '' };
  let child = null;
  let stream = null;
  let stepName = 'boot';
  const step = (s) => { stepName = s; };

  try {
    try {
      // ------------------------------------------------- (3)+(4) boot the app
      const app = await startServer({ tmp, logPath, mock, transcript });
      child = app.child;
      assert.ok(app.setupToken, 'FIRST-RUN setup token printed in the console banner');
      const base = `http://127.0.0.1:${app.port}`;
      const api = makeApi(base);
      const owner = { cookie: null };
      const viewer = { cookie: null };

      // ------------------------------------------- (6a) setup token + login
      step('first-run setup + owner login');
      const bs = await api(null, 'GET', '/api/bootstrap');
      assert.strictEqual(bs.status, 200);
      assert.strictEqual(bs.json.needsSetup, true, 'fresh db needs setup');
      assert.strictEqual(bs.json.setupToken, undefined, 'token is never served outside --demo (§19.3.15)');

      const badSetup = await api(owner, 'POST', '/api/setup', {
        username: 'boss', password: 'hunter2hunter2', setupToken: 'deadbeefdeadbeefdeadbeefdeadbeef',
      });
      assert.strictEqual(badSetup.status, 403, 'wrong setup token is rejected');

      const okSetup = await api(owner, 'POST', '/api/setup', {
        username: 'boss', password: 'hunter2hunter2', setupToken: app.setupToken,
      });
      assert.strictEqual(okSetup.status, 200, `setup accepted: ${okSetup.text}`);

      const login = await api(owner, 'POST', '/api/login', { username: 'boss', password: 'hunter2hunter2' });
      assert.strictEqual(login.status, 200, `owner login: ${login.text}`);
      assert.strictEqual(login.json.user.role, 'owner');
      assert.ok(owner.cookie, 'session cookie captured');

      const me = await api(owner, 'GET', '/api/me');
      assert.strictEqual(me.status, 200);
      assert.strictEqual(me.json.user.username, 'boss');

      // --------------------------------------------- (5) drive the scenario
      step('match 1 opens from the NEW_GAME log lines');
      mock.newGame('Yehorivka_RAAS_v1');
      await until(async () => {
        const o = await api(owner, 'GET', '/api/overview');
        return o.json && o.json.snapshot && o.json.snapshot.match ? o.json : null;
      }, { timeoutMs: 10000, label: 'match 1 open in the live snapshot' });

      step('6 players join across 2 teams + squads');
      const alice = mock.addPlayer({ name: 'Alice', teamId: 1 });
      const boris = mock.addPlayer({ name: 'Boris', teamId: 1 });
      const carl = mock.addPlayer({ name: 'Carl', teamId: 1 });
      const dmitri = mock.addPlayer({ name: 'Dmitri', teamId: 2 });
      const erik = mock.addPlayer({ name: 'Erik', teamId: 2 });
      const frank = mock.addPlayer({ name: 'Frank', teamId: 2 });
      mock.createSquad(alice, 'ALPHA');
      mock.createSquad(dmitri, 'DAGGER');

      // Nudge the pollers: drop the RCON socket so the client reconnects
      // (1s backoff) and index.js re-runs ListPlayers/ListSquads/ShowServerInfo
      // immediately — also exercises the reconnect path end-to-end. If the blip
      // were ever a no-op, the regular 15s/30s poll intervals still satisfy the
      // wait below (hence its generous timeout).
      if (mock._sockets && mock._sockets.size) {
        for (const s of [...mock._sockets]) s.destroy();
      }

      step('roster reconciles with teams, squads and match factions');
      const ready = await until(async () => {
        const o = await api(owner, 'GET', '/api/overview');
        const snap = o.json && o.json.snapshot;
        if (!snap || !snap.match || !snap.match.team1 || !snap.match.team2) return null;
        const players = snapshotPlayers(snap);
        if (players.length !== 6) return null;
        if (!players.every((p) => p.teamId != null && p.playerId != null)) return null;
        const squads = snapshotSquadNames(snap);
        if (!squads.includes('ALPHA') || !squads.includes('DAGGER')) return null;
        return o.json;
      }, { timeoutMs: 40000, intervalMs: 200, label: 'roster + team setups in /api/overview' });
      assert.strictEqual(ready.snapshot.match.team1, 'USA_S_CombinedArms', 'ShowServerInfo filled team1');
      assert.strictEqual(ready.snapshot.match.team2, 'RGF_S_CombinedArms', 'ShowServerInfo filled team2');
      assert.strictEqual(ready.counters.playersTotal, 6, 'all six players stored');

      step('chat on several channels');
      mock.chat(alice, 'all', 'rush the grid tango42');
      mock.chat(dmitri, 'team', 'need ammo at main');
      mock.chat(erik, 'squad', 'rally set, regroup');
      await until(async () => {
        const c = await api(owner, 'GET', '/api/chat');
        return c.json && c.json.total >= 3 ? c.json : null;
      }, { timeoutMs: 10000, label: 'all three chat messages stored' });

      step('wounds: one enemy kill, one teamkill');
      mock.wound(alice, dmitri, 'BP_M4_Foregrip', 61);   // team 1 -> team 2: legit
      mock.wound(boris, carl, 'BP_M17', 45);             // team 1 -> team 1: TK
      const borisRow = await until(async () => {
        const r = await api(owner, 'GET', '/api/players?q=Boris');
        const row = r.json && r.json.rows && r.json.rows.find((x) => x.name === 'Boris');
        return row && row.teamkills === 1 ? row : null;
      }, { timeoutMs: 10000, label: 'TK attacker shows teamkills=1 in /api/players' });
      assert.strictEqual(borisRow.teamkills, 1);

      const carlRow = (await api(owner, 'GET', '/api/players?q=Carl')).json.rows.find((x) => x.name === 'Carl');
      assert.ok(carlRow, 'victim row found');
      assert.strictEqual(carlRow.tkDeaths, 1, 'TK victim shows tkDeaths=1');

      const aliceRow = (await api(owner, 'GET', '/api/players?q=Alice')).json.rows.find((x) => x.name === 'Alice');
      assert.strictEqual(aliceRow.kills, 1, 'enemy wound counted as a kill');
      assert.strictEqual(aliceRow.teamkills, 0, 'enemy wound is not a TK');

      const borisProfile = await api(owner, 'GET', `/api/players/${borisRow.id}`);
      assert.strictEqual(borisProfile.status, 200);
      assert.strictEqual(borisProfile.json.player.teamkills, 1);
      assert.strictEqual(borisProfile.json.tkIncidents.total, 1, 'TK incident listed on the profile');
      assert.ok(Array.isArray(borisProfile.json.ips) && borisProfile.json.ips.length >= 1,
        'owner sees connection IPs on the profile');

      step('C4 on a friendly radio -> friendly_radio flag');
      // Erik is team 2 (RGF per ShowServerInfo); BP_FOBRadio_RUS normalizes
      // RUS -> RGF, so this classifies as FRIENDLY radio damage.
      mock.deployableDamage(erik, 'BP_FOBRadio_RUS', 400, 'BP_C4_Explosive');
      const radioFlag = await until(async () => {
        const f = await api(owner, 'GET', '/api/flags?reviewed=0');
        const row = f.json && f.json.rows && f.json.rows.find((x) => x.type === 'friendly_radio');
        return row || null;
      }, { timeoutMs: 10000, label: 'friendly_radio flag in /api/flags' });
      assert.strictEqual(radioFlag.severity, 3);
      assert.strictEqual(radioFlag.playerName, 'Erik');

      const erikProfile = await api(owner, 'GET', `/api/players/${radioFlag.playerId}`);
      assert.ok(erikProfile.json.player.radioDamageFriendly >= 400, 'friendly radio damage aggregated');
      const dep = erikProfile.json.deployableDamage.rows[0];
      assert.strictEqual(dep.category, 'radio');
      assert.strictEqual(dep.friendly, 1);

      step('round end + new game -> two matches');
      mock.roundEnd(2, 250);
      mock.newGame('Narva_AAS_v2');
      const matches = await until(async () => {
        const m = await api(owner, 'GET', '/api/matches');
        return m.json && m.json.total === 2 ? m.json : null;
      }, { timeoutMs: 10000, label: 'two matches in /api/matches' });
      const match1 = matches.rows.find((m) => m.id === 1);
      assert.ok(match1, 'first match listed');
      assert.strictEqual(match1.winnerTeam, 2);
      assert.strictEqual(match1.tickets, 250);
      assert.ok(match1.endedAt != null, 'first match closed by NEW_GAME');

      const detail = await api(owner, 'GET', '/api/matches/1');
      assert.strictEqual(detail.status, 200);
      assert.ok(detail.json.scoreboard.length >= 4, `scoreboard has rows (got ${detail.json.scoreboard.length})`);
      const sbBoris = detail.json.scoreboard.find((r) => r.name === 'Boris');
      assert.ok(sbBoris && sbBoris.teamkills === 1, 'scoreboard carries the TK');
      assert.ok(detail.json.kills.rows.some((k) => k.teamkill === true), 'match kill feed flags the TK');
      assert.ok(detail.json.deployables.some((d) => d.friendly === 1 && d.category === 'radio'),
        'match deployables include the friendly radio hit');

      step('chat search');
      const found = await api(owner, 'GET', `/api/chat?q=${encodeURIComponent('tango42')}`);
      assert.strictEqual(found.status, 200);
      assert.ok(found.json.total >= 1, 'chat search finds the message');
      assert.ok(found.json.rows[0].message.includes('tango42'));
      assert.strictEqual(found.json.rows[0].player.name, 'Alice');

      // ------------------------------------------------------ (7) admin kick
      step('POST /api/admin/kick -> AdminKickById on the mock, roster shrinks');
      const kicked = await api(owner, 'POST', '/api/admin/kick', { playerId: borisRow.id, reason: 'tk griefing' });
      assert.strictEqual(kicked.status, 200, `kick: ${kicked.text}`);
      assert.strictEqual(kicked.json.ok, true);
      assert.strictEqual(kicked.json.rconOk, true, `rcon response: ${kicked.json.rconResponse}`);
      assert.ok(
        mock.commands.includes(`AdminKickById ${boris.playerId} tk griefing`),
        `mock received the ById kick (got: ${mock.commands.filter((c) => c.startsWith('AdminKick')).join(' | ') || 'none'})`
      );
      assert.ok(!mock.players.has(boris.eosId), 'mock removed the player');
      await until(async () => {
        const o = await api(owner, 'GET', '/api/overview');
        const names = snapshotPlayers(o.json.snapshot).map((p) => p.name);
        return names.length === 5 && !names.includes('Boris') ? true : null;
      }, { timeoutMs: 20000, intervalMs: 250, label: 'kicked player gone from the live snapshot' });

      // ------------------------------------- (8) raw console + viewer gating
      step('owner raw console works');
      const raw = await api(owner, 'POST', '/api/admin/raw', { command: 'ShowCurrentMap' });
      assert.strictEqual(raw.status, 200, `raw: ${raw.text}`);
      assert.strictEqual(raw.json.ok, true);
      assert.match(raw.json.response, /Current level is /);

      step('viewer account is read-only and never sees IPs');
      const created = await api(owner, 'POST', '/api/users', {
        username: 'scout', password: 'viewerpass1', role: 'viewer',
      });
      assert.strictEqual(created.status, 200, `user create: ${created.text}`);
      const vLogin = await api(viewer, 'POST', '/api/login', { username: 'scout', password: 'viewerpass1' });
      assert.strictEqual(vLogin.status, 200);
      assert.strictEqual(vLogin.json.user.role, 'viewer');

      const vRaw = await api(viewer, 'POST', '/api/admin/raw', { command: 'ListPlayers' });
      assert.strictEqual(vRaw.status, 403, 'viewer may not use the raw console');
      const vAudit = await api(viewer, 'GET', '/api/audit');
      assert.strictEqual(vAudit.status, 403, 'viewer may not read the audit log (§19.3.23)');
      const vProfile = await api(viewer, 'GET', `/api/players/${borisRow.id}`);
      assert.strictEqual(vProfile.status, 200);
      assert.ok(!('ips' in vProfile.json), 'viewer profile response has no ips field');
      assert.ok(!('alts' in vProfile.json), 'viewer profile response has no alts field');

      const audit = await api(owner, 'GET', '/api/audit');
      assert.strictEqual(audit.status, 200);
      const actions = audit.json.rows.map((r) => r.action);
      assert.ok(actions.includes('kick') && actions.includes('raw'), 'kick + raw audited');

      // --------------------------------------------------------- (9) SSE kill
      step('SSE stream delivers a live kill event');
      stream = await openStream(app.port, owner.cookie);
      await stream.waitFor(/event: hello\n/, 5000, 'hello event');
      mock.wound(alice, frank, 'BP_SVDM_Optic', 52);
      await stream.waitFor(/event: kill\n/, 10000, 'kill event');
      assert.match(stream.buf, /event: kill\ndata: [^\n]*Alice/, 'kill payload names the attacker');
      stream.close();
      stream = null;

      // ------------------------------------------------------- (10) shutdown
      step('graceful shutdown');
      if (process.platform === 'win32') child.send('shutdown');
      else child.kill('SIGTERM');
      const exit = await waitExit(child, 5000);
      assert.strictEqual(exit.code, 0, `clean exit (got code=${exit.code} signal=${exit.signal})`);
      child = null;
    } catch (e) {
      e.message = `[step: ${stepName}] ${e.message}\n--- server output (tail) ---\n${transcript.text.slice(-3000)}`;
      throw e;
    }
  } finally {
    if (stream) stream.close();
    if (child && child.exitCode == null && child.signalCode == null) {
      child.kill('SIGKILL');
      await waitExit(child, 3000).catch(() => {});
    }
    await mock.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
