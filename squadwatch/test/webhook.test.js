'use strict';
// Discord posts for audited warns, kicks and bans (server/webhook.js), over
// the real API, admin, auth bus and a recorded fetch. auth.audit emits the
// stored row — details as their JSON text, ids instead of names — so the
// webhook parses the details and looks the names up in the db: the player,
// the warn message or kick/ban reason, the ban length ('perm' for 0, words
// otherwise) and the admin. Player-controlled text is markdown-escaped.
// Without a db, or when a lookup fails, the posts still carry the text and
// name ids instead; a failed lookup never breaks the audit.
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const { openDb } = require('../server/db');
const { createAuth } = require('../server/auth');
const { createAdmin } = require('../server/admin');
const { createApi } = require('../server/api');
const { createWebhook } = require('../server/webhook');
const LiveState = require('../server/state');

const DISCORD_URL = 'https://discord.example.test/api/webhooks/1/x';
const EVENTS = { flags: true, bans: true, kicks: true, warns: true, matchEnd: true };

// Discord drops a backslash in front of punctuation when it renders.
const rendered = (s) => s.replace(/\\([^0-9A-Za-z\s])/g, '$1');

// Posts to DISCORD_URL are recorded, never sent.
function recordPosts(t) {
  const posts = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, init) => {
    if (!String(url).startsWith(DISCORD_URL)) return realFetch(url, init);
    posts.push(JSON.parse(init.body));
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  // [title, [[field, value as rendered], ...]] per post
  const shown = () => posts.map((p) => [p.embeds[0].title, p.embeds[0].fields.map((f) => [f.name, rendered(f.value)])]);
  return { posts, shown };
}

async function harness(t, { withDb = true } = {}) {
  const db = openDb(':memory:');
  db.migrate();
  const bus = new EventEmitter();
  const cfg = { discordWebhook: DISCORD_URL, webhookEvents: Object.assign({}, EVENTS) };
  const rec = recordPosts(t);
  createWebhook(withDb ? { config: cfg, bus, db } : { config: cfg, bus });
  const auth = createAuth({ db, config: cfg, bus });
  const rcon = { status: { connected: true, authed: true }, async exec(cmd) { return `Executed: ${cmd}`; } };
  const state = new LiveState();
  const admin = createAdmin({ db, rcon, state, auth, config: cfg });
  const server = createApi({ db, state, rcon, auth, admin, config: cfg });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    auth.loginLimiter.stop();
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const user = auth.createUser('Mod_[A3]', 'password-123', 'owner');
  const cookie = `sw_session=${auth.createSession(user.id, {}).token}`;
  const post = async (p, body) => {
    const res = await fetch(base + p, {
      method: 'POST', headers: { origin: base, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const text = await res.text();
    assert.strictEqual(res.status, 200, `${p}: ${text}`);
    return JSON.parse(text);
  };
  const T = Date.now();
  const player = (name, n) => Number(db.prepare('INSERT INTO players(name, steam_id, eos_id, first_seen, last_seen) VALUES(?,?,?,?,?)')
    .run(name, `7656119800000${String(n).padStart(4, '0')}`, `0002${String(n).padStart(28, '0')}`, T, T).lastInsertRowid);
  return { admin, user, post, player, posts: rec.posts, shown: rec.shown };
}

test('panel warns, kicks and bans post the player, their text, the ban length and the admin', async (t) => {
  const h = await harness(t);
  const griefer = h.player('Griefer', 1);
  const other = h.player('Other', 2);

  await h.post('/api/admin/warn', { playerId: griefer, message: 'Stop teamkilling' });
  await h.post('/api/admin/kick', { playerId: griefer, reason: 'Teamkilling' });
  await h.post('/api/bans', { playerId: griefer, interval: '1d', reason: 'Intentional teamkilling' });
  await h.post('/api/bans', { playerId: griefer, interval: '0', reason: 'Back at it' });
  await h.post('/api/bans', { playerId: other, interval: '2w', reason: 'Radio griefing' });
  await h.post('/api/bans', { steamId: '76561198000009999', interval: '1M', reason: 'Cheating' });
  // ingest's auto-warn: a system action
  await h.admin.execAdmin(null, 'warn', { playerId: other, message: 'Teamkill detected: Griefer. TKs are logged.' });

  assert.deepStrictEqual(h.shown(), [
    ['Player warned', [['Player', 'Griefer'], ['Message', 'Stop teamkilling'], ['By', 'Mod_[A3]']]],
    ['Player kicked', [['Player', 'Griefer'], ['Reason', 'Teamkilling'], ['By', 'Mod_[A3]']]],
    ['Player banned', [['Player', 'Griefer'], ['Interval', '1 day'], ['Reason', 'Intentional teamkilling'], ['By', 'Mod_[A3]']]],
    ['Player banned', [['Player', 'Griefer'], ['Interval', 'perm'], ['Reason', 'Back at it'], ['By', 'Mod_[A3]']]],
    ['Player banned', [['Player', 'Other'], ['Interval', '2 weeks'], ['Reason', 'Radio griefing'], ['By', 'Mod_[A3]']]],
    ['Player banned', [['Player', '(manual ban)'], ['Interval', '1 month'], ['Reason', 'Cheating'], ['By', 'Mod_[A3]']]],
    ['Player warned', [['Player', 'Other'], ['Message', 'Teamkill detected: Griefer. TKs are logged.'], ['By', 'system']]],
  ]);
});

test('player-controlled text in a warn, kick or ban post is escaped — it renders as typed, never as a link', async (t) => {
  const h = await harness(t);
  const name = '**[Appeal here](https://phish.example)** @everyone';
  const id = h.player(name, 1);
  const message = 'Teamkill detected: [me](https://x.example). TKs are logged.';
  await h.post('/api/admin/warn', { playerId: id, message });
  await h.post('/api/admin/kick', { playerId: id, reason: '`kicked` ~~now~~' });
  await h.post('/api/bans', { playerId: id, interval: '1d', reason: 'see <https://y.example>' });
  // markdown characters left outside a backslash escape
  const live = (s) => {
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\') i++;
      else if ('[]()<>*_~`|#@:-'.includes(s[i])) out.push(s[i]);
    }
    return out;
  };
  assert.strictEqual(h.posts.length, 3);
  for (const p of h.posts) {
    for (const f of p.embeds[0].fields) assert.deepStrictEqual(live(f.value), [], `${f.name}: ${f.value}`);
  }
  assert.deepStrictEqual(h.shown().map(([, fields]) => fields.slice(0, 2)), [
    [['Player', name], ['Message', message]],
    [['Player', name], ['Reason', '`kicked` ~~now~~']],
    [['Player', name], ['Interval', '1 day']],
  ]);
  assert.deepStrictEqual(h.shown()[2][1][2], ['Reason', 'see <https://y.example>']);
});

test('without a db the posts keep their text and name ids', async (t) => {
  const h = await harness(t, { withDb: false });
  const id = h.player('Griefer', 1);
  await h.post('/api/admin/kick', { playerId: id, reason: 'Teamkilling' });
  await h.post('/api/bans', { playerId: id, interval: '3d', reason: 'TK spree' });
  assert.deepStrictEqual(h.shown(), [
    ['Player kicked', [['Player', `player #${id}`], ['Reason', 'Teamkilling'], ['By', `user #${h.user.id}`]]],
    ['Player banned', [['Player', `player #${id}`], ['Interval', '3 days'], ['Reason', 'TK spree'], ['By', `user #${h.user.id}`]]],
  ]);
});

test('a failing name lookup never breaks the audit, the listeners after it or the post', async (t) => {
  const rec = recordPosts(t);
  const db = openDb(':memory:');
  db.migrate();
  t.after(() => db.close());
  const bus = new EventEmitter();
  const cfg = { discordWebhook: DISCORD_URL, webhookEvents: Object.assign({}, EVENTS) };
  createWebhook({ config: cfg, bus, db: { prepare() { throw new Error('database is not open'); } } });
  const after = [];
  bus.on('admin-action', (a) => after.push(a.action));
  const auth = createAuth({ db, config: cfg, bus });
  t.after(() => auth.loginLimiter.stop());
  const id = auth.audit(1, 'ban', { targetPlayerId: 5, details: { interval: '1d', reason: 'r' } });
  assert.ok(Number(id) > 0);
  assert.deepStrictEqual(after, ['ban']);
  assert.deepStrictEqual(rec.shown(), [
    ['Player banned', [['Player', 'player #5'], ['Interval', '1 day'], ['Reason', 'r'], ['By', 'user #1']]],
  ]);
});
