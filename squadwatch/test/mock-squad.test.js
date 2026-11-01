'use strict';
// Tests for test/mock-squad.js — speaks raw RCON with a tiny inline client.
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { MockSquad } = require('./mock-squad');

// server/parser.js may not exist yet (written by another agent); fall back to
// raw-format assertions when it is absent.
let parser = null;
try {
  parser = require('../server/parser');
} catch (e) {
  parser = null;
}

// ---- tiny inline RCON client (protocol per SPEC §4.1) ----------------------
function encode(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

class TinyRcon {
  constructor() {
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.chatPackets = [];
    this.waiters = []; // {test(pkt), resolve}
    this.pending = null; // {cmdId, sentinelId, parts, resolve, reject}
    this.nextId = 3;
  }

  connect(port) {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(port, '127.0.0.1', resolve);
      this.sock.on('error', reject);
      this.sock.on('data', (c) => {
        this.buf = Buffer.concat([this.buf, c]);
        this._drain();
      });
    });
  }

  _drain() {
    while (this.buf.length >= 4) {
      const size = this.buf.readInt32LE(0);
      if (this.buf.length < size + 4) return;
      const id = this.buf.readInt32LE(4);
      const type = this.buf.readInt32LE(8);
      const body = this.buf.slice(12, size + 2).toString('utf8');
      this.buf = this.buf.slice(size + 4);
      this._onPacket({ id, type, body });
    }
  }

  _onPacket(pkt) {
    if (pkt.type === 1) this.chatPackets.push(pkt.body);
    if (this.pending && pkt.type === 0) {
      if (pkt.id === this.pending.cmdId) {
        this.pending.parts.push(pkt.body);
        return;
      }
      if (pkt.id === this.pending.sentinelId) {
        const p = this.pending;
        this.pending = null;
        p.resolve(p.parts.join(''));
        return;
      }
    }
    for (let i = 0; i < this.waiters.length; i++) {
      if (this.waiters[i].test(pkt)) {
        const w = this.waiters.splice(i, 1)[0];
        w.resolve(pkt);
        return;
      }
    }
  }

  waitFor(testFn, ms) {
    return new Promise((resolve, reject) => {
      const w = { test: testFn, resolve };
      this.waiters.push(w);
      const t = setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('timed out waiting for packet'));
      }, ms || 3000);
      t.unref();
      const orig = w.resolve;
      w.resolve = (p) => { clearTimeout(t); orig(p); };
    });
  }

  auth(password) {
    const p = this.waitFor((pkt) => pkt.type === 2, 3000);
    this.sock.write(encode(1, 3, password));
    return p; // resolves with the AUTH_RESPONSE packet (id 1 ok, id -1 bad)
  }

  exec(cmd) {
    return new Promise((resolve, reject) => {
      const cmdId = this.nextId;
      this.nextId += 2;
      this.pending = { cmdId, sentinelId: cmdId + 1, parts: [], resolve, reject };
      this.sock.write(encode(cmdId, 2, cmd));
      this.sock.write(encode(cmdId + 1, 2, ''));
      const t = setTimeout(() => {
        if (this.pending && this.pending.cmdId === cmdId) {
          this.pending = null;
          reject(new Error('exec timeout: ' + cmd));
        }
      }, 5000);
      t.unref();
    });
  }

  close() {
    if (this.sock) this.sock.destroy();
  }
}

// ---------------------------------------------------------------------------

test('MockSquad RCON + log writer', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mocksquad-'));
  const logPath = path.join(tmp, 'SquadGame.log');
  const mock = new MockSquad({ rconPort: 0, logPath, password: 'hunter2' });
  await mock.start();

  const clients = [];
  const newClient = async () => {
    const c = new TinyRcon();
    await c.connect(mock.port);
    clients.push(c);
    return c;
  };

  t.after(async () => {
    for (const c of clients) c.close();
    await mock.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('bad password is answered with auth response id -1', async () => {
    const bad = await newClient();
    const resp = await bad.auth('wrong');
    assert.strictEqual(resp.type, 2);
    assert.strictEqual(resp.id, -1);
    bad.close();
  });

  const rcon = await newClient();
  const authResp = await rcon.auth('hunter2');
  assert.strictEqual(authResp.id, 1, 'good password answered with the auth id');

  // seed state
  const alice = mock.addPlayer({ name: 'Alice', teamId: 1 });
  const bob = mock.addPlayer({ name: 'Bob | The <Builder>', teamId: 1 });
  const carol = mock.addPlayer({ name: 'Carol', teamId: 2 });
  mock.createSquad(alice, 'ALPHA');

  await t.test('ListPlayers round-trips in the real format', async () => {
    const text = await rcon.exec('ListPlayers');
    assert.ok(text.includes('----- Active Players -----'));
    assert.ok(text.includes('----- Recently Disconnected Players [Max of 15] -----'));
    if (parser && typeof parser.parseListPlayers === 'function') {
      const parsed = parser.parseListPlayers(text);
      const names = parsed.online.map((p) => p.name);
      assert.ok(names.includes('Alice'), 'parser sees Alice in ' + JSON.stringify(names));
      assert.ok(names.includes('Carol'));
      const a = parsed.online.find((p) => p.name === 'Alice');
      assert.strictEqual(a.eosId, alice.eosId);
      assert.strictEqual(a.steamId, alice.steamId);
      assert.strictEqual(a.teamId, 1);
      assert.strictEqual(a.squadId, 1);
      assert.strictEqual(a.isLeader, true);
    } else {
      // raw-format assertions (§6.4 shape)
      assert.ok(
        text.includes(
          'ID: ' + alice.playerId + ' | Online IDs: EOS: ' + alice.eosId + ' steam: ' +
          alice.steamId + ' | Name: Alice | Team ID: 1 | Squad ID: 1 | Is Leader: True | Role: '
        ),
        'active player line shape:\n' + text
      );
      assert.ok(/\| Squad ID: N\/A \|/.test(text), 'unassigned players render Squad ID: N/A');
    }
  });

  await t.test('ShowServerInfo is JSON with the expected keys', async () => {
    const text = await rcon.exec('ShowServerInfo');
    const info = JSON.parse(text);
    assert.strictEqual(typeof info.ServerName_s, 'string');
    assert.strictEqual(info.PlayerCount_I, '3');
    assert.ok(info.TeamOne_s && info.TeamTwo_s && info.NextLayer_s);
  });

  await t.test('multi-packet responses reassemble via the sentinel echo', async () => {
    const extras = [];
    for (let i = 0; i < 80; i++) extras.push(mock.addPlayer({}));
    const text = await rcon.exec('ListPlayers');
    assert.ok(Buffer.byteLength(text, 'utf8') > 4096, 'response big enough to split');
    const lines = text.split('\n');
    assert.ok(lines.length > 80);
    for (const p of extras) mock.removePlayer(p);
    mock.disconnected.length = 0; // keep later assertions simple
  });

  await t.test('AdminKick removes the player from the next ListPlayers', async () => {
    const resp = await rcon.exec('AdminKickById ' + bob.playerId + ' being rude');
    assert.ok(/^Kicked player \d+\. \[Online IDs= EOS: [0-9a-f]{32} steam: \d{17}\]/.test(resp), resp);
    const text = await rcon.exec('ListPlayers');
    const active = text.split('----- Recently Disconnected')[0];
    assert.ok(!active.includes('Bob | The <Builder>'), 'kicked player gone from active list');
    assert.ok(text.includes('Since Disconnect:'), 'kicked player shows up as recently disconnected');
    assert.ok(mock.commands.some((c) => c.startsWith('AdminKickById ')));
  });

  await t.test('AdminBroadcast arrives as a type-1 packet (and logs)', async () => {
    const before = rcon.chatPackets.length;
    const resp = await rcon.exec('AdminBroadcast Hello squaddies');
    assert.strictEqual(resp, 'Message broadcasted');
    // the sentinel round-trip already synchronized the stream, but poll briefly anyway
    for (let i = 0; i < 50 && rcon.chatPackets.length === before; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(rcon.chatPackets.length > before, 'received a type-1 packet');
    assert.ok(rcon.chatPackets.some((b) => b.includes('Hello squaddies')));
    const log = fs.readFileSync(logPath, 'utf8');
    assert.ok(log.includes('ADMIN COMMAND: Message broadcasted <Hello squaddies> from RCON'));
  });

  await t.test('chat() emits a §6.3-shaped CHAT packet', async () => {
    const before = rcon.chatPackets.length;
    mock.chat(alice, 'all', 'gg : wp');
    for (let i = 0; i < 50 && rcon.chatPackets.length === before; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const body = rcon.chatPackets[rcon.chatPackets.length - 1];
    assert.strictEqual(
      body,
      '[ChatAll] [Online IDs:EOS: ' + alice.eosId + ' steam: ' + alice.steamId + '] Alice : gg : wp'
    );
    if (parser && typeof parser.parseChatPacket === 'function') {
      const p = parser.parseChatPacket(body);
      assert.ok(p, 'parser parses the chat packet');
      assert.strictEqual(p.channel, 'all');
      assert.strictEqual(p.name, 'Alice');
      assert.strictEqual(p.message, 'gg : wp');
    }
  });

  await t.test('wound() writes a §6.1 PLAYER_WOUNDED-shaped log line', async () => {
    mock.wound(carol, alice, 'BP_SVDM_Optic', 41.5);
    const log = fs.readFileSync(logPath, 'utf8');
    const lines = log.trim().split('\n');
    const woundLine = lines.filter((l) => l.includes('Wound()')).pop();
    assert.ok(woundLine, 'a wound line was written');
    const m = /^\[\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3}\]\[\s*\d+\](.*)$/.exec(woundLine);
    assert.ok(m, 'timestamp prefix shape');
    const rest = m[1];
    const WOUND_RE = /^LogSquadTrace: \[DedicatedServer\](?:ASQSoldier::)?Wound\(\): Player:(.+) KillingDamage=-?([\d.]+) from ([^(]+) \(Online IDs:([^)|]+)\| (?:Player )?Controller ID: ([\w\d]+)\) caused by ([A-Za-z0-9_\-]+)_C/;
    const w = WOUND_RE.exec(rest);
    assert.ok(w, 'wound line matches the SPEC §6.1 regex: ' + rest);
    assert.strictEqual(w[1], 'Alice');
    assert.strictEqual(w[2], '41.500000');
    assert.ok(w[4].includes(carol.eosId) && w[4].includes(carol.steamId));
    assert.strictEqual(w[6], 'BP_SVDM_Optic');
    if (parser && typeof parser.parseLogLine === 'function') {
      const ev = parser.parseLogLine(woundLine);
      assert.ok(ev, 'parser parses the wound line');
      assert.strictEqual(ev.event, 'PLAYER_WOUNDED');
    }
  });

  await t.test('connect/disconnect/newGame/roundEnd lines have the right shapes', async () => {
    mock.newGame('Gorodok_RAAS_v1');
    mock.roundEnd(2, 184);
    mock.tick(38.45);
    mock.revive(alice, carol);
    mock.deployableDamage(carol, 'BP_FOBRadio_Woodland', 350, 'BP_C4_Explosive');
    mock.damage(carol, alice, 'BP_AK74_Base', 22.9);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.ok(log.includes('LogWorld: Bringing World /Game/Maps/Gorodok/Gameplay_Layers/Gorodok_RAAS_v1.Gorodok_RAAS_v1 up for play'));
    assert.ok(/LogSquadGameEvents: Display: Team 2, .+ \( \w+ \) has won the match with 184 Tickets on layer Gorodok RAAS v1 \(level Gorodok\)!/.test(log));
    assert.ok(log.includes('LogSquad: USQGameState: Server Tick Rate: 38.45'));
    assert.ok(/LogSquad: Alice \(Online IDs: EOS: [0-9a-f]{32} steam: \d{17}\) has revived Carol \(Online IDs: [^)]+\)\./.test(log));
    assert.ok(/ASQDeployable::TakeDamage\(\): BP_FOBRadio_Woodland_C_\d+: 350\.000000 damage attempt by causer BP_C4_Explosive_C_\d+ instigator Carol with damage type [A-Za-z0-9_\-]+_C health remaining [\d.]+/.test(log));
    assert.ok(/LogSquad: Player:Alice ActualDamage=22\.900000 from Carol \(Online IDs: [^)|]+\| Player Controller ID: [^ )]+\)caused by BP_AK74_Base_C/.test(log));
    assert.ok(log.includes('LogNet: UNetConnection::Close:'), 'kick earlier wrote a disconnect line');
    assert.ok(log.includes('UniqueId: RedpointEOS:' + bob.eosId));
  });

  await t.test('unknown commands are reported', async () => {
    const resp = await rcon.exec('BogusCommand 123');
    assert.strictEqual(resp, 'Unknown command: BogusCommand 123');
  });
});
