import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';

const origin = 'https://snap.example.test';
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

async function harness(t) {
  const transformed = await transformWithEsbuild(await readFile(new URL('../src/downloads/bridge.ts', import.meta.url), 'utf8'), 'bridge.ts', { loader: 'ts', format: 'esm' });
  const api = await import('data:text/javascript;base64,' + Buffer.from(transformed.code + `\n// ${Math.random()}`).toString('base64'));
  const originals = new Map(), frames = [], timers = new Map();
  let nextTimer = 0;
  const setGlobal = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  t.after(() => { for (const [name, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  const worker = { scriptURL: origin + '/downloads/worker.js', state: 'activated' };
  setGlobal('location', new URL(origin));
  setGlobal('setTimeout', (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; });
  setGlobal('clearTimeout', id => timers.delete(id));
  setGlobal('document', {
    createElement() {
      const handlers = new Map();
      return {
        isConnected: false,
        addEventListener: (type, handler) => handlers.set(type, handler),
        removeEventListener: (type, handler) => { if (handlers.get(type) === handler) handlers.delete(type); },
        dispatch(type) { handlers.get(type)?.(); },
        remove() { this.removed = true; this.isConnected = false; },
      };
    },
    body: { appendChild(frame) { frame.isConnected = true; frames.push(frame); } },
  });
  return {
    api, worker, frames, timers,
    load(frame, options = {}) {
      frame.contentWindow = {
        location: new URL(options.href || frame.src, origin),
        navigator: { serviceWorker: { controller: options.controller === undefined ? worker : options.controller } },
      };
      frame.contentDocument = { getElementById: id => options.marker !== false && id === 'dokitool-download-bridge' ? {} : null };
      frame.dispatch('load');
    },
    tick(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    },
  };
}

test('bridge does not resolve until a real controlled document has loaded', async t => {
  const h = await harness(t);
  h.api.retainBridge('first');
  let settled = false;
  const connection = h.api.connectBridge();
  void connection.then(() => { settled = true; });
  await flush();
  assert.equal(settled, false);
  assert.equal(h.frames.length, 1);
  h.load(h.frames[0], { href: 'about:blank' });
  await flush();
  assert.equal(settled, false, 'the initial empty iframe is not a controlled document');
  h.load(h.frames[0]);
  assert.equal(await connection, h.worker);
  assert.equal(await h.api.connectBridge(), h.worker);
  assert.equal(h.frames.length, 1);
});

for (const [label, options] of [
  ['SPA fallback instead of the bridge document', { marker: false }],
  ['a redirected document', { href: origin + '/index.html' }],
  ['an uncontrolled document', { controller: null }],
  ['an unrelated Worker', { controller: { state: 'activated', scriptURL: origin + '/other.js' } }],
  ['a retired Worker', { controller: { state: 'redundant', scriptURL: origin + '/downloads/worker.js' } }],
]) test(`bridge rejects ${label} before a download can start`, async t => {
  const h = await harness(t);
  h.api.retainBridge('first');
  const connection = h.api.connectBridge();
  h.load(h.frames[0], options);
  await assert.rejects(connection, /下载连接/);
  assert.equal(h.frames[0].removed, true);
  assert.equal(h.timers.size, 0);
});

test('concurrent tasks share one bridge and only the last release starts retirement', async t => {
  const h = await harness(t);
  h.api.retainBridge('first');
  h.api.retainBridge('second');
  const first = h.api.connectBridge(), second = h.api.connectBridge();
  assert.equal(h.frames.length, 1);
  h.load(h.frames[0]);
  assert.equal(await first, await second);
  h.api.releaseBridge('first');
  h.tick(4000);
  assert.equal(h.frames[0].removed, undefined);
  h.api.releaseBridge('second');
  assert.equal(h.frames[0].removed, undefined, 'the handoff grace period remains intact');
  h.tick(4000);
  assert.equal(h.frames[0].removed, true);
});

test('a new task during retirement keeps the existing controlled bridge', async t => {
  const h = await harness(t);
  h.api.retainBridge('first');
  const first = h.api.connectBridge(); h.load(h.frames[0]); await first;
  h.api.releaseBridge('first');
  h.api.retainBridge('second');
  h.tick(4000);
  assert.equal(h.frames[0].removed, undefined);
  assert.equal(await h.api.connectBridge(), h.worker);
  assert.equal(h.frames.length, 1);
  h.api.releaseBridge('second'); h.tick(4000);
  assert.equal(h.frames[0].removed, true);
});

test('failed bridge loading can be retried without reusing its rejected connection', async t => {
  const h = await harness(t);
  h.api.retainBridge('first');
  const failed = h.api.connectBridge(); h.frames[0].dispatch('error');
  await assert.rejects(failed, /加载失败/);
  const retry = h.api.connectBridge(); h.load(h.frames[1]);
  assert.equal(await retry, h.worker);
  assert.equal(h.frames[0].removed, true);
});

test('release while loading rejects that connection and leaves no dangling frame or timeout', async t => {
  const h = await harness(t);
  h.api.retainBridge('first');
  const connection = h.api.connectBridge();
  h.api.releaseBridge('first'); h.tick(4000);
  await assert.rejects(connection, /已释放/);
  assert.equal(h.frames[0].removed, true);
  assert.equal(h.timers.size, 0);
});
