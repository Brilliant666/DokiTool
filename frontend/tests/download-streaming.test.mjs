import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformWithEsbuild } from 'vite';

const origin = 'https://snap.example.test';
const build = 'downloads-20261030.2';
const request = { id: 'task0000000000001', url: 'https://cdn.test/private.mp4?signature=secret', routes: [], filename: '作品.mp4', startedAt: 990_000 };
const state = (status = 'downloading', patch = {}) => ({
  id: request.id, url: request.url, filename: request.filename, transport: 'browser_streaming', status,
  loaded: 10 * 1024 ** 2, total: 100 * 1024 ** 2, speed: 2 * 1024 ** 2,
  elapsed: 15, transferElapsed: 5, averageSpeed: 2 * 1024 ** 2, ...patch,
});
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };

async function harness(t, respond) {
  const types = await transformWithEsbuild(await readFile(new URL('../src/downloads/types.ts', import.meta.url), 'utf8'), 'types.ts', { loader: 'ts', format: 'esm' });
  const typesUrl = 'data:text/javascript;base64,' + Buffer.from(types.code).toString('base64');
  const client = await transformWithEsbuild(await readFile(new URL('../src/downloads/streaming.ts', import.meta.url), 'utf8'), 'streaming.ts', { loader: 'ts', format: 'esm' });
  const code = client.code.replace('"./types"', JSON.stringify(typesUrl));
  const api = await import('data:text/javascript;base64,' + Buffer.from(code + `\n// ${Math.random()}`).toString('base64'));
  const originals = new Map(), storage = new Map(), messages = [], frames = [], timers = new Map();
  let listener, nextTimer = 0, updates = 0, now = 1_000_000;
  const originalDate = Date;
  const setGlobal = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  t.after(() => { for (const [name, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  const worker = {
    scriptURL: origin + '/downloads/worker.js', state: 'activated',
    postMessage(message, [port]) {
      messages.push(message);
      const reply = respond ? respond(message) : message.action === 'ping' ? { protocol: 1, workerBuild: build } : undefined;
      if (reply !== undefined) port.postMessage(reply);
    },
  };
  const registration = { active: worker, scope: origin + '/downloads/', update: async () => { updates++; } };
  setGlobal('navigator', { serviceWorker: { getRegistration: async () => registration, addEventListener: (_, handler) => { listener = handler; } } });
  setGlobal('location', new URL(origin)); setGlobal('isSecureContext', true);
  setGlobal('Date', class extends originalDate { static now() { return now; } });
  setGlobal('crypto', { randomUUID: () => '12345678-1234-1234-1234-123456789abc' });
  setGlobal('sessionStorage', { getItem: name => storage.get(name), setItem: (name, value) => storage.set(name, value) });
  setGlobal('MessageChannel', class {
    constructor() {
      this.port1 = { onmessage: null, close() {} };
      this.port2 = { postMessage: data => queueMicrotask(() => this.port1.onmessage?.({ data })) };
    }
  });
  setGlobal('document', { createElement: () => ({ remove() { this.removed = true; } }), body: { appendChild: frame => frames.push(frame) } });
  for (const name of ['setTimeout', 'setInterval']) setGlobal(name, (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; });
  for (const name of ['clearTimeout', 'clearInterval']) setGlobal(name, id => timers.delete(id));
  return {
    api, worker, registration, messages, frames, storage, timers, get updates() { return updates; }, advance: ms => { now += ms; },
    update: (snapshot, source = worker) => listener({ source, data: { channel: 'dokitool-download', protocol: 1, snapshot } }),
    poll: async () => { [...timers.values()].find(timer => timer.delay === 5000).callback(); await flush(); },
  };
}

test('temporary observation failure preserves progress, identity and the running task', async t => {
  let queryFails = true;
  const h = await harness(t, message => {
    if (message.action === 'ping') return { protocol: 1, workerBuild: build };
    if (message.action === 'start') return { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` };
    if (message.action === 'query') return queryFails ? { error: 'temporary failure' } : { snapshots: [state('downloading', { loaded: 20 * 1024 ** 2 })] };
  });
  const observed = [];
  let settled = false;
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  void task.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  await h.poll();
  const unknown = observed.at(-1);
  assert.equal(unknown.status, 'downloading'); assert.equal(unknown.observation, 'unknown');
  assert.equal(unknown.loaded, 10 * 1024 ** 2); assert.equal(unknown.total, 100 * 1024 ** 2);
  assert.equal(unknown.elapsed, 15); assert.equal(unknown.transferElapsed, 5); assert.equal(unknown.speed, 0);
  assert.equal(unknown.averageSpeed, 2 * 1024 ** 2); assert.equal(unknown.workerBuild, build);
  assert.equal(h.api.hasStreamingTask(request.id), true); assert.equal(settled, false);
  assert.equal(h.frames.length, 1); assert.equal(h.frames[0].removed, undefined);
  queryFails = false;
  await h.poll();
  assert.equal(observed.at(-1).observation, undefined); assert.equal(observed.at(-1).loaded, 20 * 1024 ** 2);
  h.update(state('completed', { loaded: 100 * 1024 ** 2 }));
  assert.equal((await task).status, 'completed');
  assert.equal(h.messages.filter(message => message.action === 'start').length, 1);
});

test('refresh query failure keeps a saved progress checkpoint without retaining source URLs', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build } : { error: 'temporarily offline' });
  const { url, routes, ...last } = state();
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
  const restored = await h.api.reconnectStreaming(() => {});
  assert.equal(restored[0].status, 'downloading'); assert.equal(restored[0].observation, 'unknown');
  assert.equal(restored[0].loaded, 10 * 1024 ** 2); assert.equal(restored[0].url, '');
  assert.equal(h.api.hasStreamingTask(request.id), true);
  assert.equal(h.frames.length, 0); assert.ok(!h.messages.some(message => message.action === 'start'));
});

test('unknown START remains pending rather than reporting a false interruption', async t => {
  const h = await harness(t);
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  await flush();
  [...h.timers.values()].find(timer => timer.delay === 8000).callback();
  await assert.rejects(task, error => error.name === 'StreamingStateUnknownError' && !error.safeToFallback);
  assert.equal(observed.at(-1).status, 'preparing'); assert.equal(observed.at(-1).observation, 'unknown');
  assert.equal(observed.at(-1).elapsed, 10); assert.equal(h.api.hasStreamingTask(request.id), true);
  h.update(state('cancelled'));
  assert.equal(observed.at(-1).status, 'cancelled'); assert.equal(h.api.hasStreamingTask(request.id), false);
});

test('an unconfirmed cancellation retains progress and can accept a later confirmation', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build }
    : message.action === 'query' ? { snapshots: [state()] } : undefined);
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now() }]));
  const observed = [];
  await h.api.reconnectStreaming(snapshot => observed.push(snapshot));
  const cancellation = h.api.cancelStreaming(request.id);
  await flush();
  [...h.timers.values()].find(timer => timer.delay === 8000).callback();
  await assert.rejects(cancellation, /状态未知/);
  assert.equal(observed.at(-1).status, 'downloading'); assert.equal(observed.at(-1).observation, 'unknown');
  assert.equal(observed.at(-1).loaded, 10 * 1024 ** 2); assert.equal(h.api.hasStreamingTask(request.id), true);
  h.update(state('cancelled'));
  assert.equal(observed.at(-1).status, 'cancelled'); assert.equal(h.api.hasStreamingTask(request.id), false);
});

test('update checks do not block an active worker or force a waiting worker to replace it', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: 'previous-build' }
    : message.action === 'start' ? { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` }
      : message.action === 'query' ? { snapshots: [state()] } : undefined);
  let checked = 0, waitingMessages = 0;
  h.registration.update = () => { checked++; return new Promise(() => {}); };
  h.registration.waiting = { postMessage() { waitingMessages++; } };
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  await flush();
  assert.equal(h.frames.length, 1); assert.equal(checked, 1); assert.equal(waitingMessages, 0);
  assert.equal(observed.at(-1).workerBuild, 'previous-build');
  await h.poll();
  assert.equal(checked, 1); assert.equal(waitingMessages, 0);
  h.update(state('completed'));
  await task;
});

test('offline update checks and legacy workers remain usable and identify their version', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1 }
    : message.action === 'start' ? { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` } : undefined);
  h.registration.update = async () => { throw new Error('offline'); };
  const task = h.api.downloadStreaming(request, new AbortController().signal, () => {});
  await flush(); h.update(state('completed'));
  assert.equal((await task).workerBuild, 'legacy');
  const saved = h.storage.get('dokitool-downloads-v1');
  assert.ok(!saved.includes('cdn.test')); assert.ok(!saved.includes('signature'));
});

for (const oldPing of ['reply', 'timeout']) test(`an activating update is reselected when the old worker ping ${oldPing === 'reply' ? 'returns' : 'times out'}`, async t => {
  let h;
  const replacementMessages = [];
  const replacement = {
    scriptURL: origin + '/downloads/worker.js', state: 'activated',
    postMessage(message, [port]) {
      replacementMessages.push(message);
      port.postMessage(message.action === 'ping' ? { protocol: 1, workerBuild: build }
        : { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` });
    },
  };
  h = await harness(t, message => {
    assert.equal(message.action, 'ping', 'START must not reach a retired worker');
    h.worker.state = 'redundant';
    h.registration.active = replacement;
    if (oldPing === 'reply') return { protocol: 1, workerBuild: 'previous-build' };
  });
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  await flush();
  if (oldPing === 'timeout') {
    [...h.timers.values()].find(timer => timer.delay === 8000).callback();
    await flush();
  }
  assert.equal(h.frames.length, 1);
  assert.equal(replacementMessages.filter(message => message.action === 'ping').length, 1);
  assert.equal(replacementMessages.filter(message => message.action === 'start').length, 1);
  assert.equal(observed.at(-1).workerBuild, build);
  h.update(state('completed'), replacement);
  assert.equal((await task).status, 'completed');
});

test('confirmed missing task keeps its last progress but stops polling and duplicate prevention', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build } : { snapshots: [] });
  const { url, routes, ...last } = state();
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
  const [missing] = await h.api.reconnectStreaming(() => {});
  assert.equal(missing.status, 'interrupted'); assert.equal(missing.observation, undefined);
  assert.equal(missing.loaded, 10 * 1024 ** 2); assert.equal(h.api.hasStreamingTask(request.id), false);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 5000).length, 0);
});
