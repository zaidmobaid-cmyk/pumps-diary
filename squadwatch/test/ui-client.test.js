'use strict';
// Browser-side logic of public/app.js and views.js (docs/BATCH3-CONTRACTS.md §7).
//
// The scripts run in a vm sandbox; boot() never runs (readyState stays
// 'loading'). Most tests need no DOM; the dialog, uploader and page tests
// get a small fake one (makeDocument) and a fake XMLHttpRequest they answer.
//
// - the evidence precheck mirrors server/evidence.js: every signature the
//   server's sniff() types is typed the same here, what it refuses is refused
//   here, the plain-text rules (UTF-8, no NUL, 2 MB, no markup, no #!) hold
//   before a byte is sent; the size limit is the server's once known (an
//   evidence list, a 413, Settings) and only the 100 MB ceiling before;
// - each file counts once toward the 20-file cap; a file turned away after
//   a warn / kick / ban went through is reported, never "all attached";
// - one warn / kick / ban request per player at a time, and a failure after
//   the dialog closed is toasted; a zero-count duration is refused;
// - reason templates are the server's per kind, the built-in presets only
//   when none could be loaded;
// - the new flag types have labels, ban-evasion details name the banned
//   account or say it is hidden from the viewer, an auto-kick is reported as
//   sent, not as done; a ban row's own evidence is told apart from the ban's;
// - admin calls chime and toast only for an open call that is new to the
//   page and newer than the page load — never for the backlog, a status
//   update or an old call; handling one updates the inbox; a failed load is
//   never an all-clear and is retried on reconnect; mute toggles share one
//   listener.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { sniff: serverSniff } = require('../server/evidence');

const APP_JS = path.join(__dirname, '..', 'public', 'app.js');
const VIEWS_JS = path.join(__dirname, '..', 'public', 'views.js');

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// fetch(path) answers from `routes`: {path-prefix: [status, json]}
function fakeFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes || {}).find((p) => String(url).startsWith(p));
    if (!key) throw new Error('no network in this test: ' + url);
    const [status, body] = routes[key];
    return jsonResponse(status, body);
  };
}

class FakeEvent {
  constructor(type, init) { Object.assign(this, init); this.type = type; this.defaultPrevented = false; }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() {}
}

// A DOM just big enough for app.js's dialogs, uploader, evidence list and
// dashboard: elements, text, attributes, classes, listeners (no bubbling),
// querySelector(All) over tag / #id / .class / [attr] / :not(…) compounds,
// descendant chains and comma lists. innerHTML keeps its markup as a string
// and builds only the plain <span>s that icon + label buttons carry.
const COMPOUND_RE = /^([a-z][a-z0-9]*|\*)?((?:[.#][\w-]+|\[[^\]]+\]|:not\([^)]*\))*)$/i;
const PART_RE = /[.#][\w-]+|\[[^\]]+\]|:not\([^)]*\)/g;
function matchesOne(n, sel) {
  if (!n || n.nodeType !== 1) return false;
  const m = COMPOUND_RE.exec(sel);
  if (!m) return false;
  if (m[1] && m[1] !== '*' && n.tagName !== m[1].toUpperCase()) return false;
  for (const p of m[2].match(PART_RE) || []) {
    if (p[0] === '.') {
      if (!n.classList.contains(p.slice(1))) return false;
    } else if (p[0] === '#') {
      if (n.getAttribute('id') !== p.slice(1)) return false;
    } else if (p[0] === '[') {
      const a = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(p);
      if (!a || !n.hasAttribute(a[1]) || (a[2] !== undefined && n.getAttribute(a[1]) !== a[2])) return false;
    } else if (matchesOne(n, p.slice(5, -1))) return false;
  }
  return true;
}
function matches(n, selector) {
  return selector.split(',').some((alt) => {
    const chain = alt.trim().split(/\s+/);
    if (!matchesOne(n, chain[chain.length - 1])) return false;
    let i = chain.length - 2;
    for (let p = n.parentNode; p && i >= 0; p = p.parentNode) if (matchesOne(p, chain[i])) i--;
    return i < 0;
  });
}
function makeDocument() {
  const doc = { readyState: 'loading', title: 'A3 Admin', activeElement: null, listeners: [] };
  class FakeNode {
    constructor(tag) {
      this.nodeType = tag === '#text' ? 3 : 1;
      this.tagName = tag === '#text' ? '#text' : String(tag).toUpperCase();
      this.childNodes = [];
      this.parentNode = null;
      this.attrs = new Map();
      this.listeners = [];
      this.dataset = {};
      this.style = {};
      this.data = '';
      this.html = '';
      this.value = '';
    }
    get className() { return this.attrs.get('class') || ''; }
    set className(v) { this.attrs.set('class', String(v)); }
    get classList() {
      const n = this;
      const get = () => n.className.split(/\s+/).filter(Boolean);
      const cl = {
        contains: (c) => get().includes(c),
        add: (...cs) => { n.className = [...new Set(get().concat(cs))].join(' '); },
        remove: (...cs) => { n.className = get().filter((x) => !cs.includes(x)).join(' '); },
        toggle: (c, force) => {
          const on = force === undefined ? !cl.contains(c) : !!force;
          if (on) cl.add(c); else cl.remove(c);
          return on;
        },
      };
      return cl;
    }
    get title() { return this.attrs.get('title') || ''; }
    set title(v) { this.attrs.set('title', String(v)); }
    get disabled() { return this.attrs.has('disabled'); }
    set disabled(v) { if (v) this.attrs.set('disabled', ''); else this.attrs.delete('disabled'); }
    setAttribute(k, v) { this.attrs.set(k, String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map((c) => c.textContent).join(''); }
    set textContent(v) {
      if (this.nodeType === 3) { this.data = String(v); return; }
      for (const c of this.childNodes) c.parentNode = null;
      this.childNodes = [];
      this.html = '';
      if (v != null && v !== '') this.appendChild(doc.createTextNode(v));
    }
    get innerHTML() { return this.html; }
    set innerHTML(v) {
      this.textContent = '';
      this.html = String(v);
      for (const m of this.html.matchAll(/<span(?:\s+class="([^"]*)")?>([^<]*)<\/span>/g)) {
        const s = new FakeNode('span');
        if (m[1]) s.className = m[1];
        if (m[2]) s.textContent = m[2];
        this.appendChild(s);
      }
    }
    insertAdjacentHTML(_where, h) { this.html += h; }
    appendChild(c) {
      if (c.parentNode) c.remove();
      c.parentNode = this;
      this.childNodes.push(c);
      return c;
    }
    append(...cs) { for (const c of cs) this.appendChild(typeof c === 'object' ? c : doc.createTextNode(c)); }
    prepend(...cs) {
      for (const c of cs.reverse()) {
        const n = typeof c === 'object' ? c : doc.createTextNode(c);
        if (n.parentNode) n.remove();
        n.parentNode = this;
        this.childNodes.unshift(n);
      }
    }
    remove() {
      const p = this.parentNode;
      if (!p) return;
      p.childNodes.splice(p.childNodes.indexOf(this), 1);
      this.parentNode = null;
    }
    replaceWith(n) {
      const p = this.parentNode;
      if (!p) return;
      if (n.parentNode) n.remove();
      p.childNodes.splice(p.childNodes.indexOf(this), 1, n);
      n.parentNode = p;
      this.parentNode = null;
    }
    contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === doc.documentElement; }
    get offsetParent() { return this.isConnected ? this.parentNode : null; }
    get offsetWidth() { return 0; }
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => { for (const c of n.childNodes) if (c.nodeType === 1) { if (matches(c, sel)) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
    closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
    addEventListener(t, fn) { this.listeners.push([t, fn]); }
    removeEventListener(t, fn) { this.listeners = this.listeners.filter(([a, b]) => a !== t || b !== fn); }
    dispatchEvent(e) {
      if (!e.target) e.target = this;
      for (const [t, fn] of this.listeners.slice()) if (t === e.type) fn.call(this, e);
      return !e.defaultPrevented;
    }
    click() { this.dispatchEvent(new FakeEvent('click')); }
    focus() {}
    blur() {}
    getContext() { return null; }
  }
  doc.createElement = (t) => new FakeNode(t);
  doc.createTextNode = (s) => { const n = new FakeNode('#text'); n.data = String(s); return n; };
  doc.addEventListener = (t, fn) => { doc.listeners.push([t, fn]); };
  doc.removeEventListener = (t, fn) => { doc.listeners = doc.listeners.filter(([a, b]) => a !== t || b !== fn); };
  doc.documentElement = new FakeNode('html');
  doc.body = new FakeNode('body');
  doc.documentElement.appendChild(doc.body);
  doc.getElementById = (id) => doc.documentElement.querySelector('#' + id);
  doc.querySelector = (s) => doc.documentElement.querySelector(s);
  doc.querySelectorAll = (s) => doc.documentElement.querySelectorAll(s);
  doc.contains = (n) => doc.documentElement.contains(n);
  for (const id of ['modal-root', 'toasts']) {
    const n = new FakeNode('div');
    n.setAttribute('id', id);
    doc.body.appendChild(n);
  }
  return doc;
}

// XMLHttpRequest whose uploads the test answers: xhr.respond(status, json)
function fakeXhr(sent) {
  return class FakeXHR {
    constructor() { this.upload = { addEventListener() {} }; this.on = {}; this.status = 0; this.responseText = ''; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader() {}
    addEventListener(t, fn) { (this.on[t] = this.on[t] || []).push(fn); }
    send(body) { this.body = body; sent.push(this); }
    abort() { this.aborted = true; }
    respond(status, body) {
      this.status = status;
      this.responseText = body == null ? '' : JSON.stringify(body);
      for (const fn of this.on.load || []) fn();
    }
  };
}

// opts: {dom: true} for the fake DOM + XHR; {views: true} adds views.js;
// {fetch(url)} -> response to answer requests by hand
function loadApp(routes, opts) {
  opts = opts || {};
  const store = new Map();
  const noop = () => {};
  const classList = { add: noop, remove: noop, toggle: noop, contains: () => false };
  const document = opts.dom ? makeDocument() : {
    readyState: 'loading',
    title: 'A3 Admin',
    documentElement: { setAttribute: noop, removeAttribute: noop, getAttribute: () => null, classList },
    body: { classList },
    addEventListener: noop,
    removeEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement() { throw new Error('this test renders nothing'); },
  };
  const xhrs = [];
  const fetched = [];
  const winListeners = [];
  const answer = opts.fetch || fakeFetch(routes);
  const sandbox = {
    document,
    location: { hash: '#/login' },
    navigator: { platform: 'test' },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); },
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: noop }),
    requestAnimationFrame: noop,
    addEventListener: (t, fn) => { winListeners.push([t, fn]); },
    removeEventListener: (t, fn) => {
      const i = winListeners.findIndex(([a, b]) => a === t && b === fn);
      if (i !== -1) winListeners.splice(i, 1);
    },
    dispatchEvent: (e) => {
      for (const [t, fn] of winListeners.slice()) if (t === e.type) fn(e);
      return true;
    },
    setInterval: () => 0,
    clearInterval: noop,
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout,
    console,
    Event: FakeEvent,
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    XMLHttpRequest: fakeXhr(xhrs),
    TextDecoder,
    TextEncoder,
    URLSearchParams,
    URL,
    Blob,
    File,
    fetch: async (url, init) => {
      fetched.push(String(url));
      return answer(String(url), init);
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(APP_JS, 'utf8'), sandbox, { filename: 'app.js' });
  if (opts.views) vm.runInContext(fs.readFileSync(VIEWS_JS, 'utf8'), sandbox, { filename: 'views.js' });
  return { SW: sandbox.SW, store, document, xhrs, fetched, winListeners };
}

// a few event-loop turns: Blob reads, fetch answers, promise chains
async function flush(n) {
  for (let i = 0; i < (n || 8); i++) await new Promise((r) => setImmediate(r));
}
// toasts recorded instead of drawn; the background tray gets a handle
function captureToasts(a) {
  const toasts = [];
  a.SW.ui.toast = (msg, kind, opts) => {
    toasts.push({ msg, kind, opts: opts || {} });
    return { el: a.document.createElement('div'), dismiss() {} };
  };
  return toasts;
}
const ADMIN = { id: 4, username: 'mod', role: 'admin', perms: { warn: true, kick: true, ban: true, flags: true } };

const ascii = (s) => Array.from(Buffer.from(s, 'latin1'));
function bytes(head, len) {
  const b = Buffer.alloc(Math.max(len || 64, head.length));
  Buffer.from(head).copy(b);
  return b;
}
// EBML header with a DocType element (0x42 0x82, one-byte size).
function ebml(docType) {
  return bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x80 | docType.length, ...ascii(docType)]);
}
function ftyp(brand) {
  return bytes([0, 0, 0, 0x20, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0]);
}
const fileOf = (buf, name) => new File([buf], name || 'evidence.bin');
const png = (name) => fileOf(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), name);
// a File-like of `size` bytes that starts with `head`: binary types are
// checked from their first bytes only, so nothing that large is allocated
function bigFile(head, size, name) {
  const h = Uint8Array.from(head);
  return { name, size, lastModified: 1, slice: (a, b) => ({ arrayBuffer: async () => h.slice(a, b).buffer }) };
}
const clipMB = (mb, name) => bigFile(ftyp('mp42'), mb * 1024 * 1024 + 1, name || 'clip.mp4');
function evidenceRow(id, filename, target) {
  return {
    id, targetType: (target && target.type) || 'ban', targetId: (target && target.id) || 5, filename, mime: 'image/png',
    size: 64, caption: null, uploadedBy: ADMIN.id, uploader: ADMIN.username, uploadedAt: Date.now(), url: '/api/evidence/' + id + '/file',
  };
}

const CORPUS = [
  ['png', bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['jpeg', bytes([0xff, 0xd8, 0xff, 0xe0])],
  ['gif87', bytes(ascii('GIF87a'))],
  ['gif89', bytes(ascii('GIF89a'))],
  ['webp', bytes([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')])],
  ['riff-wav', bytes([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')])],
  ['mp4-isom', ftyp('isom')],
  ['mp4-mp42', ftyp('mp42')],
  ['mov', ftyp('qt  ')],
  ['heic', ftyp('heic')],
  ['avif', ftyp('avif')],
  ['mif1', ftyp('mif1')],
  ['ftyp-binary-brand', ftyp('\u0001\u0002\u0003\u0004')],
  ['webm', ebml('webm')],
  ['mkv', ebml('matroska')],
  ['ebml-other', ebml('xyz')],
  ['ebml-no-doctype', bytes([0x1a, 0x45, 0xdf, 0xa3, 0x80])],
  ['pdf', bytes(ascii('%PDF-1.7'))],
  ['zip', bytes([0x50, 0x4b, 0x03, 0x04])],
  ['exe', bytes(ascii('MZ'))],
  ['text', Buffer.from('plain words, no signature here at all, only text '.repeat(2))],
];

test('evidence precheck types every signature exactly as the server does', () => {
  const { SW } = loadApp();
  for (const [label, buf] of CORPUS) {
    const server = serverSniff(buf);
    const client = SW.evidence.sniff(new Uint8Array(buf));
    if (server) {
      assert.ok(client && !client.reject, `${label}: the server accepts ${server.mime}, the client must too`);
      assert.strictEqual(client.mime, server.mime, `${label}: same type`);
    } else {
      assert.ok(!client || client.reject, `${label}: the server finds no binary type, the client must not invent one`);
    }
  }
});

test('evidence precheck: accepted files, refusals and the size limit before upload', async () => {
  const { SW } = loadApp();
  const ok = async (buf, name) => {
    const r = await SW.evidence.check(fileOf(buf, name));
    assert.ok(r.ok, `${name} should pass: ${r.error}`);
    return r.info;
  };
  const refused = async (buf, name, re) => {
    const r = await SW.evidence.check(fileOf(buf, name));
    assert.ok(!r.ok && r.error, `${name} should be refused`);
    if (re) assert.match(r.error, re, `${name}: ${r.error}`);
  };
  assert.strictEqual((await ok(CORPUS[0][1], 'shot.png')).kind, 'image');
  assert.strictEqual((await ok(ftyp('mp42'), 'clip.mp4')).kind, 'video');
  assert.strictEqual((await ok(ebml('matroska'), 'clip.mkv')).label, 'MKV');
  assert.strictEqual((await ok(bytes(ascii('%PDF-1.4')), 'report.pdf')).kind, 'pdf');
  // the type comes from the bytes, never the name
  assert.strictEqual((await ok(CORPUS[0][1], 'not-really.txt')).kind, 'image');
  assert.strictEqual((await ok(Buffer.from('[21:04] ChatAll Wardex: <PlayerName> said hi\n'), 'chat.log')).kind, 'text');
  assert.strictEqual((await ok(Buffer.from('﻿UTF-8 with a BOM: Кузнец, 龍の騎士'), 'names.txt')).kind, 'text');

  await refused(Buffer.alloc(0), 'empty.png', /empty/i);
  await refused(ftyp('heic'), 'IMG_0001.HEIC', /HEIC/);
  await refused(ebml('xyz'), 'odd.webm', /recognised/);
  await refused(bytes([0x50, 0x4b, 0x03, 0x04]), 'logs.zip', /Archives/);
  await refused(bytes(ascii('MZ')), 'aimbot.exe', /Programs/);
  await refused(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'diagram.svg', /SVG/);
  await refused(Buffer.from('  <!DOCTYPE html><html></html>'), 'page.txt', /Web pages/);
  await refused(Buffer.from('notes first, then <iframe src="x"></iframe>'), 'notes.txt', /Web pages/);
  await refused(Buffer.from('<p>hello</p>'), 'para.txt', /Web pages/);
  await refused(Buffer.from('  #!/bin/sh\necho hi'), 'run.txt', /scripts/);
  await refused(Buffer.from([0x61, 0x00, 0x62]), 'nul.txt', /UTF-8|supported/);
  await refused(Buffer.from([0x66, 0x6f, 0xff, 0xfe, 0x6f]), 'latin1.txt', /UTF-8/);
  await refused(Buffer.alloc(2 * 1024 * 1024 + 1, 0x61), 'huge.log', /2 MB/);
});

test('evidence size: the 100 MB ceiling until the limit is known, then the limit; open hints follow it', async () => {
  const a = loadApp(null, { dom: true });
  a.SW.state.me = ADMIN; /* no settings permission: the limit is never asked for */
  const { check } = a.SW.evidence;
  assert.strictEqual(a.SW.evidence.maxMB(), null);
  assert.ok((await check(clipMB(70))).ok, 'over the 50 MB default, within what Settings allows: the server decides');
  assert.match((await check(clipMB(100))).error, /the panel takes at most 100 MB per file/);

  const up = a.SW.ui.evidenceUploader({ compact: true });
  const hint = () => up.querySelector('.ev-drop-hint').textContent;
  assert.match(hint(), /within the panel's file size limit/);
  a.SW.evidence.noteLimit(60);
  assert.strictEqual(a.SW.evidence.maxMB(), 60);
  assert.match(hint(), /up to 60 MB each/, 'a learned limit reaches the open uploaders');
  assert.match((await check(clipMB(70))).error, /the limit is 60 MB per file/);
  for (const junk of [0, 101, 'abc', null, -5]) a.SW.evidence.noteLimit(junk);
  assert.strictEqual(a.SW.evidence.maxMB(), 60, 'out-of-range values are ignored');

  up.detach();
  a.SW.evidence.noteLimit(90); /* Settings saved a higher limit */
  assert.ok((await check(clipMB(70))).ok, 'a raised limit lets the clip through');
  assert.match(hint(), /up to 60 MB each/, 'a detached uploader is no longer held for updates');
  assert.ok(!a.fetched.length, 'nothing was fetched to learn it');
});

test('evidence dialog: each uploaded file counts once toward the 20-file cap', async () => {
  const a = loadApp({ '/api/evidence': [200, { rows: [], maxMB: 50 }] }, { dom: true });
  a.SW.state.me = ADMIN;
  a.SW.ui.openEvidence({ targetType: 'ban', targetId: 5, title: 'Evidence · ban #5' });
  await flush();
  assert.strictEqual(a.SW.evidence.maxMB(), 50, 'the list taught the limit');
  const up = a.document.querySelector('.ev-modal .ev-up');
  for (let i = 1; i <= 20; i++) {
    up.addFiles([png('shot-' + i + '.png')]); /* one Ctrl+V at a time */
    await flush();
    assert.strictEqual(a.xhrs.length, i, 'file ' + i + ' goes up');
    a.xhrs[i - 1].respond(200, { ok: true, evidence: evidenceRow(100 + i, 'shot-' + i + '.png') });
    await flush();
  }
  assert.strictEqual(a.document.querySelectorAll('.ev-modal .ev-item.is-rejected').length, 0, 'no false "Limit reached"');
  assert.strictEqual(a.document.querySelector('.ev-dlg-n').textContent, '20');
  up.addFiles([png('one-too-many.png')]);
  await flush();
  const refused = a.document.querySelectorAll('.ev-modal .ev-item.is-rejected');
  assert.strictEqual(refused.length, 1, 'the 21st file is over the cap');
  assert.match(refused[0].querySelector('.ev-item-status').textContent, /Limit reached — at most 20 files per ban/);
  assert.strictEqual(a.xhrs.length, 20, 'and is never sent');
});

// the Ban dialog with a screenshot and a 70 MB clip picked; resolves once
// the ban went through and both uploads are out
async function banWithEvidence(a) {
  a.SW.actions.ban({ dbId: 3, name: 'Wardex' });
  await flush();
  const dlg = a.document.querySelector('.act-modal');
  dlg.querySelector('.act-reason').value = 'Teamkilling at main';
  dlg.querySelector('.ev-up').addFiles([png('shot.png'), clipMB(70)]);
  await flush();
  assert.strictEqual(dlg.querySelectorAll('.ev-item.is-ready').length, 2, 'both pass the precheck while the limit is unknown');
  dlg.querySelector('form').dispatchEvent(new FakeEvent('submit'));
  await flush();
  assert.strictEqual(a.xhrs.length, 2, 'the uploads start once the ban went through');
  assert.match(a.xhrs[0].url, /targetType=ban&targetId=9&/);
  return dlg;
}
const BAN_ROUTES = {
  '/api/reason-templates': [200, { rows: [] }],
  '/api/bans': [200, { ok: true, rconOk: true, ban: { id: 9 }, actionId: 33 }],
};

test('ban dialog: a file the server refuses after the ban keeps the dialog open and says why', async () => {
  const a = loadApp(BAN_ROUTES, { dom: true });
  a.SW.state.me = ADMIN;
  captureToasts(a);
  const dlg = await banWithEvidence(a);
  a.xhrs[0].respond(200, { ok: true, evidence: evidenceRow(1, 'shot.png', { type: 'ban', id: 9 }) });
  a.xhrs[1].respond(413, { error: 'file too large — the limit is 50 MB' });
  await flush();
  assert.strictEqual(dlg.querySelector('.act-status').textContent,
    '1 file not attached: Too large for the server — the limit is 50 MB per file');
  assert.strictEqual(a.SW.evidence.maxMB(), 50, 'the 413 taught the limit');
  await new Promise((r) => setTimeout(r, 1100));
  assert.ok(!dlg.parentNode.classList.contains('is-closing'), 'no auto-close while a picked file is missing');
});

test('ban dialog closed while evidence uploads: the tray reports a refused file', async () => {
  const a = loadApp(BAN_ROUTES, { dom: true });
  a.SW.state.me = ADMIN;
  const toasts = captureToasts(a);
  const dlg = await banWithEvidence(a);
  dlg.querySelector('form').dispatchEvent(new FakeEvent('submit')); /* "Done" while both are uploading */
  assert.ok(dlg.parentNode.classList.contains('is-closing'));
  assert.ok(toasts.some((t) => t.msg === 'Uploading evidence'), 'the uploads moved to the tray');
  a.xhrs[0].respond(200, { ok: true, evidence: evidenceRow(1, 'shot.png', { type: 'ban', id: 9 }) });
  a.xhrs[1].respond(413, { error: 'file too large — the limit is 50 MB' });
  await flush();
  const last = toasts[toasts.length - 1];
  assert.strictEqual(last.msg, '1 evidence file not attached');
  assert.strictEqual(last.kind, 'warn');
  assert.strictEqual(last.opts.detail,
    'Too large for the server — the limit is 50 MB per file · 1 other file was attached · Banned Wardex (1 day)');
  assert.ok(!toasts.some((t) => /^Evidence attached/.test(t.msg)), 'never reported as all attached');
});

test('warn / kick / ban: one request per player at a time; a failure after closing is toasted', async () => {
  const pending = [];
  const a = loadApp(null, {
    dom: true,
    fetch: (url) => {
      if (url.startsWith('/api/reason-templates')) return jsonResponse(200, { rows: [] });
      if (url.startsWith('/api/bans')) return new Promise((resolve) => pending.push(resolve));
      throw new Error('no network in this test: ' + url);
    },
  });
  a.SW.state.me = ADMIN;
  const toasts = captureToasts(a);
  const open = async (ref) => {
    a.SW.actions.ban(ref);
    await flush();
    const all = a.document.querySelectorAll('.act-modal');
    const dlg = all[all.length - 1];
    dlg.querySelector('.act-reason').value = 'Teamkilling at main';
    return dlg;
  };
  const submit = async (dlg) => {
    dlg.querySelector('form').dispatchEvent(new FakeEvent('submit'));
    await flush();
  };

  const first = await open({ dbId: 3, name: 'Wardex' });
  await submit(first);
  assert.strictEqual(pending.length, 1);
  const cancel = first.querySelector('.modal-actions .btn.ghost');
  assert.strictEqual(cancel.textContent, 'Close', 'a sent request cannot be cancelled, so the button does not claim to');

  const second = await open({ dbId: 3, steamId: '76561198000000001', name: 'Wardex' });
  await submit(second);
  assert.strictEqual(pending.length, 1, 'a second dialog for the same player sends nothing while the first is out');
  assert.match(second.querySelector('.act-error').textContent, /A ban for Wardex is still being sent — wait for its result/);

  cancel.click(); /* closed mid-request */
  pending[0](jsonResponse(409, { error: 'Wardex is already banned permanently by zaid. A3 Admin kicks them whenever they join.' }));
  await flush();
  const t = toasts.find((x) => x.msg === 'Could not ban Wardex');
  assert.ok(t, 'the failure is toasted once the form is gone');
  assert.strictEqual(t.kind, 'error');
  assert.match(t.opts.detail, /already banned permanently/);

  await submit(second);
  assert.strictEqual(pending.length, 2, 'once the first answered, the second may send');
});

test('ban duration: a zero count such as 0d is refused; the bare 0 is permanent', async () => {
  const a = loadApp(BAN_ROUTES, { dom: true });
  a.SW.state.me = ADMIN;
  captureToasts(a);
  a.SW.actions.ban({ dbId: 3, name: 'Wardex' });
  await flush();
  const dlg = a.document.querySelector('.act-modal');
  dlg.querySelector('.act-reason').value = 'Teamkilling at main';
  dlg.querySelectorAll('.act-seg .chip').find((b) => b.dataset.v === 'custom').click();
  const custom = dlg.querySelector('.act-custom');
  const expiry = () => dlg.querySelector('.act-expiry').textContent;
  for (const v of ['0d', '0m', '00h']) {
    custom.value = v;
    custom.dispatchEvent(new FakeEvent('input'));
    assert.match(expiry(), /^Type a duration/, v + ' is not a duration');
    dlg.querySelector('form').dispatchEvent(new FakeEvent('submit'));
    await flush();
    assert.match(dlg.querySelector('.act-error').textContent, /Pick a duration/);
  }
  assert.ok(!a.fetched.some((u) => u.startsWith('/api/bans')), 'none of them is sent');
  custom.value = '10d';
  custom.dispatchEvent(new FakeEvent('input'));
  assert.match(expiry(), / · 10 days$/);
  dlg.querySelectorAll('.act-seg .chip').find((b) => b.dataset.v === '0').click();
  assert.strictEqual(expiry(), 'Permanent — never expires');
});

test('reason templates: the server\'s list per kind; the built-in presets only when none could be loaded', async () => {
  const chips = (dlg) => dlg.querySelectorAll('.act-tpl-chip').map((b) => b.textContent);
  const lastDialog = (a) => { const all = a.document.querySelectorAll('.act-modal'); return all[all.length - 1]; };

  const a = loadApp({ '/api/reason-templates': [200, { rows: [{ id: 'tk', kind: 'warn', label: 'TK', reason: 'Stop teamkilling' }] }] }, { dom: true });
  a.SW.state.me = ADMIN;
  a.SW.actions.ban({ dbId: 3, name: 'Wardex' });
  assert.ok(lastDialog(a).querySelector('.act-tpl').classList.contains('hidden'), 'nothing while the first load is out');
  await flush();
  assert.ok(lastDialog(a).querySelector('.act-tpl').classList.contains('hidden'), 'the owner left ban templates empty: no chips');
  assert.deepStrictEqual(chips(lastDialog(a)), []);
  a.SW.actions.warn({ dbId: 3, name: 'Wardex' });
  await flush();
  assert.ok(!lastDialog(a).querySelector('.act-tpl').classList.contains('hidden'));
  assert.deepStrictEqual(chips(lastDialog(a)), ['TK']);

  const b = loadApp({ '/api/reason-templates': [404, { error: 'not found' }] }, { dom: true });
  b.SW.state.me = ADMIN;
  b.SW.actions.kick({ dbId: 3, name: 'Wardex' });
  await flush();
  assert.deepStrictEqual(chips(lastDialog(b)), ['Teamkilling', 'Toxic chat', 'AFK / not in a squad', 'Mic spam', 'Breaking server rules'],
    'a server without templates gets the built-in presets');
});

test('flag labels cover the join-alert types; ban-evasion details name the banned account', () => {
  const { SW } = loadApp();
  assert.strictEqual(SW.ui.flagLabel('watchlist-join'), 'Watchlisted player joined');
  assert.strictEqual(SW.ui.flagLabel('flagged-join'), 'Flagged player joined');
  assert.strictEqual(SW.ui.flagLabel('ban-evasion'), 'Possible ban evasion');
  assert.strictEqual(SW.ui.flagLabel('tk_spree'), 'Teamkill spree');
  assert.strictEqual(SW.ui.flagLabel('some_new-type'), 'Some new type');
  // joinalerts.js details shape, as an object and as the stored JSON string
  const details = { reason: 'Shares an IP address with a banned player', banId: 12, bannedPlayerId: 7, bannedPlayerName: 'Ironhide', sharedIps: 1 };
  for (const d of [details, JSON.stringify(details)]) {
    const ev = SW.ui.evasionOf(d);
    assert.strictEqual(ev.playerId, 7);
    assert.strictEqual(ev.name, 'Ironhide');
    assert.strictEqual(ev.banId, 12);
  }
  assert.strictEqual(SW.ui.evasionOf({ reason: 'Watchlisted player joined' }), null);
  assert.strictEqual(SW.ui.evasionOf('not json'), null);
});

test('flag inbox: a ban-evasion flag redacted for the viewer says the link is hidden, not missing', async () => {
  const flag = (id, details) => ({
    id, playerId: 5, playerName: 'Smurf', time: Date.now() - id * 1000, type: 'ban-evasion', severity: 3,
    matchId: null, details, reviewed: false,
  });
  const a = loadApp({
    '/api/flags': [200, {
      rows: [
        flag(1, { reason: 'Shares an IP address with a banned player', redacted: true }),
        flag(2, { reason: 'Shares an IP address with a banned player', bannedPlayerId: 7, bannedPlayerName: 'Ironhide', banId: 12 }),
      ],
      total: 2,
    }],
    '/api/trolls': [500, { error: 'not in this test' }],
  }, { dom: true, views: true });
  a.SW.state.me = { id: 4, username: 'mod', role: 'mod', perms: { flags: true } };
  const main = a.document.createElement('main');
  a.document.body.append(main);
  a.SW.routes.trolls.render(main, {});
  await flush();
  const rows = main.querySelectorAll('.tro-flag');
  assert.strictEqual(rows.length, 2);
  const [redacted, full] = rows;
  assert.match(redacted.querySelector('.tro-flag-evasion.is-hidden').textContent, /Linked banned account hidden — seeing it needs the “See IPs & alt accounts” permission/);
  assert.strictEqual(redacted.querySelector('.tro-flag-details').textContent, 'reason: Shares an IP address with a banned player',
    'no raw "redacted: true" in the details');
  assert.match(full.querySelector('.tro-flag-evasion').textContent, /^Shares an IP withIronhideban #12$/);
  assert.ok(!full.querySelector('.is-hidden'));
});

test('profile Admin actions: a ban row\'s evidence dialog says the ban\'s own files are on its card', async () => {
  const t = Date.now();
  const profile = {
    player: { id: 3, name: 'Wardex', steamId: '76561198000000001', firstSeen: t - 9e7, lastSeen: t - 1e6 },
    bans: [{ id: 9, playerId: 3, issuedAt: t - 5e5, expiresAt: t + 8e7, durationSec: 86400, intervalRaw: '1d', reason: 'TK', active: true, issuer: 'mod', evidenceCount: 3 }],
    warnings: [], flags: [], notes: [],
    actions: [
      { id: 33, time: t - 5e5, action: 'ban', details: { interval: '1d', reason: 'TK' }, username: 'mod', rconOk: true, evidenceCount: 0 },
      { id: 31, time: t - 6e5, action: 'warn', details: { message: 'Stop' }, username: 'mod', rconOk: true, evidenceCount: 0 },
    ],
  };
  const a = loadApp({
    '/api/players/3': [200, profile],
    '/api/evidence': [200, { rows: [], maxMB: 50 }],
  }, { dom: true, views: true });
  a.SW.state.me = { id: 4, username: 'mod', role: 'admin', perms: { warn: true, kick: true, ban: true, audit: true } };
  const main = a.document.createElement('main');
  a.document.body.append(main);
  a.SW.routes.players.render(main, { args: ['3'], query: {} });
  await flush();
  main.querySelectorAll('.vw-tabs .tab').find((b) => /^Discipline/.test(b.textContent)).click();
  const buttons = main.querySelectorAll('.ev-count');
  assert.deepStrictEqual(buttons.map((b) => b.textContent), ['3', 'Attach', 'Attach'], 'the ban card, then the ban and warn rows');
  buttons[1].click();
  await flush();
  assert.match(a.document.querySelector('.ev-modal .ev-dlg-sub').textContent,
    /^Wardex — ban, .+\. These files belong to this action entry; files on the ban itself are on its ban card above\.$/);
  buttons[2].click();
  await flush();
  const subs = a.document.querySelectorAll('.ev-modal .ev-dlg-sub');
  assert.match(subs[subs.length - 1].textContent, /^Wardex — warn, [^.]+$/, 'warn rows need no such note');
});

test('a ban-evasion join alert reports its auto-kick as sent, not as done', () => {
  const { SW } = loadApp();
  const toasts = [];
  SW.ui.toast = (msg, kind, opts) => { toasts.push({ msg, kind, opts: opts || {} }); return null; };
  SW.sound.chime = () => true;
  const alert = {
    type: 'ban-evasion', time: Date.now() + 1000, player: { dbId: 5, name: 'Smurf' },
    details: { reason: 'Shares an IP address with a banned player', bannedPlayerId: 7, bannedPlayerName: 'Ironhide', banId: 12, autoKick: true },
  };
  SW.state.me = { id: 4, username: 'mod', role: 'admin', perms: { flags: true, ban: true, ips: true, audit: true } };
  SW.live.emit('alert', alert);
  assert.strictEqual(toasts[0].msg, 'Possible ban evasion — Smurf');
  assert.strictEqual(toasts[0].opts.detail,
    'Shares an IP with Ironhide (ban #12) — automatic kick sent (the Audit log shows whether it landed)');
  SW.state.me = { id: 5, username: 'mod2', role: 'admin', perms: { flags: true, ban: true, ips: true } };
  SW.live.emit('alert', alert);
  assert.strictEqual(toasts[1].opts.detail, 'Shares an IP with Ironhide (ban #12) — automatic kick sent', 'no pointer to a log they cannot open');
});

test('admin calls chime only for new open calls newer than the page load', () => {
  const { SW } = loadApp();
  SW.state.me = { id: 4, username: 'mod', role: 'mod', perms: { flags: true } };
  const chimes = [];
  const toasts = [];
  SW.sound.chime = (kind) => { chimes.push(kind); return true; };
  SW.ui.toast = (msg) => { toasts.push(msg); return null; };
  const t = Date.now();
  const call = (id, extra) => Object.assign({
    id, time: t + 1000, status: 'open', playerName: 'Wardex', playerDbId: 3, eosId: null, steamId: null,
    message: '!admin tk at main', handledBy: null, handledByName: null, handledAt: null,
  }, extra);

  SW.adminCalls.onEvent(call(1, { time: t - 10 * 60 * 1000 }));
  assert.deepStrictEqual(chimes, [], 'a call from before the page load stays silent');
  assert.strictEqual(SW.adminCalls.count(), 1, 'but it is listed');

  SW.adminCalls.onEvent(call(2));
  assert.deepStrictEqual(chimes, ['call'], 'a new open call chimes once');
  assert.strictEqual(toasts.length, 1);
  assert.match(toasts[0], /Wardex/);

  SW.adminCalls.onEvent(call(2));
  SW.adminCalls.onEvent(call(2, { status: 'handled', handledBy: 9, handledByName: 'other-admin', handledAt: t + 2000 }));
  assert.deepStrictEqual(chimes, ['call'], 'a repeat or a status update never chimes again');
  assert.strictEqual(SW.adminCalls.count(), 1);
  assert.strictEqual(SW.adminCalls.recent()[0].handledByName, 'other-admin');

  SW.adminCalls.onEvent(call(3, { status: 'handled' }));
  assert.deepStrictEqual(chimes, ['call'], 'a call first seen already handled is silent');

  SW.state.me = { id: 4, username: 'viewer', role: 'viewer', perms: { view: true } };
  SW.adminCalls.onEvent(call(4));
  assert.deepStrictEqual(chimes, ['call'], 'roles that cannot act on calls hear nothing');
});

test('admin calls: the inbox loads, and stays out of sight on a server without the routes', async () => {
  const me = { id: 4, username: 'mod', role: 'mod', perms: { warn: true } };
  const t = Date.now();
  const rows = [
    { id: 7, time: t - 60000, status: 'open', playerName: 'GoodGuy', playerDbId: 5, message: '!admin help' },
    { id: 6, time: t - 90000, status: 'open', playerName: 'Wardex', playerDbId: 3, message: '!admin tk' },
  ];
  const a = loadApp({ '/api/admin-calls': [200, { rows, open: 3 }] });
  a.SW.state.me = me;
  const chimes = [];
  a.SW.sound.chime = (k) => { chimes.push(k); return true; };
  await a.SW.adminCalls.load();
  assert.strictEqual(a.SW.adminCalls.status(), 'ok');
  assert.deepStrictEqual([...a.SW.adminCalls.list().map((c) => c.id)], [7, 6], 'newest first'); // spread: a main-realm array
  assert.strictEqual(a.SW.adminCalls.count(), 3, 'an open call the server counted but did not list still counts');
  assert.deepStrictEqual(chimes, [], 'the backlog never chimes');

  const b = loadApp({ '/api/admin-calls': [404, { error: 'not found' }] });
  b.SW.state.me = me;
  await b.SW.adminCalls.load();
  assert.strictEqual(b.SW.adminCalls.status(), 'unavailable');
  assert.strictEqual(b.SW.adminCalls.count(), 0);
});

test('admin calls: a failed load stays an error until a retry, which a reconnect also makes', async () => {
  const me = { id: 4, username: 'mod', role: 'mod', perms: { warn: true } };
  let up = false;
  const a = loadApp(null, {
    fetch: (url) => {
      if (!url.startsWith('/api/admin-calls?status=open')) throw new Error('no network in this test: ' + url);
      return up ? jsonResponse(200, { rows: [], open: 0 }) : jsonResponse(502, { error: 'bad gateway' });
    },
  });
  a.SW.state.me = me;
  await a.SW.adminCalls.load();
  assert.strictEqual(a.SW.adminCalls.status(), 'error');
  /* a handled call from the stream does not turn a failed load into "all clear" */
  a.SW.adminCalls.onEvent({ id: 9, time: Date.now(), status: 'handled', playerName: 'Wardex', handledBy: 2 });
  assert.strictEqual(a.SW.adminCalls.status(), 'error');
  up = true;
  a.SW.live.emit('hello', { me });
  assert.strictEqual(a.SW.adminCalls.status(), 'loading', 'the reconnect retries, and the retry shows as loading');
  await flush();
  assert.strictEqual(a.SW.adminCalls.status(), 'ok');
  assert.strictEqual(a.fetched.length, 2);
  a.SW.live.emit('hello', { me });
  await flush();
  assert.strictEqual(a.fetched.length, 2, 'a loaded inbox is not refetched on every hello');
});

test('dashboard admin calls: a failed load never reads as "everything is handled"', async () => {
  let up = false;
  const handled = { id: 3, time: Date.now() - 900000, status: 'handled', playerName: 'Wardex', handledBy: 2, handledAt: Date.now() - 600000 };
  const a = loadApp(null, {
    dom: true,
    fetch: (url) => {
      if (url.startsWith('/api/admin-calls?status=open')) return up ? jsonResponse(200, { rows: [], open: 0 }) : jsonResponse(502, { error: 'bad gateway' });
      if (url.startsWith('/api/admin-calls?status=all')) return jsonResponse(200, { rows: [handled] });
      return jsonResponse(500, { error: 'not in this test' });
    },
  });
  a.SW.state.me = { id: 4, username: 'mod', role: 'mod', perms: { warn: true, flags: true } };
  const main = a.document.createElement('main');
  a.document.body.append(main);
  const dash = a.SW.routes.dashboard;
  dash.render(main, {});
  await flush();
  const card = main.querySelector('.dash-calls');
  assert.strictEqual(a.SW.adminCalls.status(), 'error');
  assert.match(card.textContent, /Could not load admin calls/);
  assert.doesNotMatch(card.textContent, /everything is handled/, 'a handled call known from elsewhere is no all-clear');
  assert.match(card.textContent, /Recently handled/);

  up = true;
  card.querySelector('.empty-action').click(); /* Try again */
  assert.ok(card.querySelector('.is-skel'), 'the retry shows as loading');
  await flush();
  assert.match(card.textContent, /No open calls — everything is handled/);
  dash.cleanup();

  /* the next visit after a failure retries by itself */
  up = false;
  const b = loadApp(null, {
    dom: true,
    fetch: (url) => (url.startsWith('/api/admin-calls?status=open') && up
      ? jsonResponse(200, { rows: [], open: 0 })
      : jsonResponse(502, { error: 'bad gateway' })),
  });
  b.SW.state.me = a.SW.state.me;
  await b.SW.adminCalls.load();
  up = true;
  const main2 = b.document.createElement('main');
  b.document.body.append(main2);
  b.SW.routes.dashboard.render(main2, {});
  await flush();
  assert.strictEqual(b.SW.adminCalls.status(), 'ok');
  b.SW.routes.dashboard.cleanup();
});

test('alert sound mute is remembered per browser', () => {
  const { SW, store } = loadApp();
  assert.strictEqual(SW.sound.muted(), false, 'sound is on by default');
  SW.sound.setMuted(true);
  assert.strictEqual(SW.sound.muted(), true);
  assert.strictEqual(store.get('sw:chime-muted'), 'true');
  assert.strictEqual(SW.sound.chime('call'), false, 'muted: nothing plays');
  SW.sound.toggle();
  assert.strictEqual(SW.sound.muted(), false);
});

test('mute toggles share one page-wide listener, so a left page is not kept alive', async () => {
  const a = loadApp(null, {
    dom: true,
    fetch: (url) => (url.startsWith('/api/admin-calls') ? jsonResponse(200, { rows: [], open: 0 }) : jsonResponse(500, { error: 'not in this test' })),
  });
  a.SW.state.me = { id: 4, username: 'mod', role: 'mod', perms: { warn: true, flags: true } };
  const soundListeners = () => a.winListeners.filter(([t]) => t === 'sw:sound').length;
  assert.strictEqual(soundListeners(), 1);
  const dash = a.SW.routes.dashboard;
  let main = null;
  for (let visit = 0; visit < 3; visit++) { /* the dashboard draws a toggle on every visit */
    if (main) { dash.cleanup(); main.remove(); }
    main = a.document.createElement('main');
    a.document.body.append(main);
    dash.render(main, {});
    await flush();
  }
  assert.strictEqual(soundListeners(), 1, 'no listener per toggle');
  const toggle = main.querySelector('.dash-calls .sound-toggle');
  assert.strictEqual(toggle.getAttribute('aria-pressed'), 'false');
  a.SW.sound.setMuted(true);
  assert.strictEqual(toggle.getAttribute('aria-pressed'), 'true', 'the toggle on the page follows a mute');
  assert.ok(toggle.classList.contains('is-muted'));
  a.SW.sound.setMuted(false);
  assert.strictEqual(toggle.getAttribute('aria-pressed'), 'false');
  dash.cleanup();
});
