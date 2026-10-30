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
const flush = async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); };

async function harness(t, respond, options = {}) {
  const types = await transformWithEsbuild(await readFile(new URL('../src/downloads/types.ts', import.meta.url), 'utf8'), 'types.ts', { loader: 'ts', format: 'esm' });
  const typesUrl = 'data:text/javascript;base64,' + Buffer.from(types.code).toString('base64');
  const bridge = await transformWithEsbuild(await readFile(new URL('../src/downloads/bridge.ts', import.meta.url), 'utf8'), 'bridge.ts', { loader: 'ts', format: 'esm' });
  const bridgeUrl = 'data:text/javascript;base64,' + Buffer.from(bridge.code + `\n// ${Math.random()}`).toString('base64');
  const client = await transformWithEsbuild(await readFile(new URL('../src/downloads/streaming.ts', import.meta.url), 'utf8'), 'streaming.ts', { loader: 'ts', format: 'esm' });
  const code = client.code.replace('"./types"', JSON.stringify(typesUrl)).replace('"./bridge"', JSON.stringify(bridgeUrl));
  const api = await import('data:text/javascript;base64,' + Buffer.from(code + `\n// ${Math.random()}`).toString('base64'));
  const originals = new Map(), storage = new Map(), messages = [], frames = [], timers = new Map(), stateListeners = new Set();
  let listener, nextTimer = 0, updates = 0, registrations = 0, now = 1_000_000;
  const originalDate = Date;
  const setGlobal = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  };
  t.after(() => { for (const [name, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  const worker = {
    scriptURL: origin + '/downloads/worker.js', state: 'activated',
    addEventListener(type, handler) { if (type === 'statechange') stateListeners.add(handler); },
    removeEventListener(type, handler) { if (type === 'statechange') stateListeners.delete(handler); },
    postMessage(message, [port]) {
      messages.push(message);
      const reply = respond ? respond(message) : message.action === 'ping' ? { protocol: 1, workerBuild: build } : undefined;
      if (reply !== undefined) port.postMessage(reply);
    },
  };
  const registration = { active: worker, scope: origin + '/downloads/', update: async () => { updates++; } };
  setGlobal('navigator', { serviceWorker: {
    getRegistration: async () => registration,
    register: async () => { registrations++; return registration; },
    addEventListener: (_, handler) => { listener = handler; },
  } });
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
  const loadBridge = (frame, { controller = registration.active, marker = true, href = new URL(frame.src, origin).href } = {}) => {
    frame.contentWindow = { location: new URL(href), navigator: { serviceWorker: { controller } } };
    frame.contentDocument = { getElementById: id => marker && id === 'dokitool-download-bridge' ? {} : null };
    frame.dispatch('load');
  };
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
    body: { appendChild(frame) {
      frame.isConnected = true; frames.push(frame);
      if (frame.src === '/downloads/bridge.html' && options.autoLoadBridge !== false) queueMicrotask(() => loadBridge(frame));
    } },
  });
  for (const name of ['setTimeout', 'setInterval']) setGlobal(name, (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; });
  for (const name of ['clearTimeout', 'clearInterval']) setGlobal(name, id => timers.delete(id));
  return {
    api, worker, registration, messages, frames, storage, timers, loadBridge,
    get bridges() { return frames.filter(frame => frame.src === '/downloads/bridge.html'); },
    get attachments() { return frames.filter(frame => frame.src?.startsWith('/downloads/file/')); },
    get updates() { return updates; }, advance: ms => { now += ms; },
    get registrations() { return registrations; },
    get stateListeners() { return stateListeners.size; },
    transition: next => { worker.state = next; for (const handler of [...stateListeners]) handler(); },
    update: (snapshot, source = worker) => listener({ source, data: { channel: 'dokitool-download', protocol: 1, snapshot } }),
    poll: async () => { [...timers.values()].find(timer => timer.delay === 5000).callback(); await flush(); },
    tick: delay => { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); } },
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
  assert.equal(h.attachments.length, 1); assert.equal(h.attachments[0].removed, undefined);
  assert.equal(h.bridges.length, 1); assert.equal(h.bridges[0].removed, undefined);
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
  assert.equal(h.attachments.length, 0); assert.ok(!h.messages.some(message => message.action === 'start'));
  assert.equal(h.bridges.length, 1); assert.equal(h.bridges[0].removed, undefined);
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
  h.tick(4000);
  assert.equal(h.bridges[0].removed, undefined, 'an uncertain START may already own a running transfer');
  h.update(state('cancelled'));
  assert.equal(observed.at(-1).status, 'cancelled'); assert.equal(h.api.hasStreamingTask(request.id), false);
  h.tick(4000);
  assert.equal(h.bridges[0].removed, true);
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

test('update checks use the controlled owner and never send forced activation messages', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: 'previous-build' }
    : message.action === 'start' ? { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` }
      : message.action === 'query' ? { snapshots: [state()] } : undefined);
  let checked = 0, waitingMessages = 0;
  h.registration.update = () => { checked++; return new Promise(() => {}); };
  h.registration.waiting = { postMessage() { waitingMessages++; } };
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  await flush();
  assert.equal(h.attachments.length, 1); assert.equal(h.bridges.length, 1);
  assert.equal(checked, 1); assert.equal(waitingMessages, 0);
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
  assert.equal(h.attachments.length, 1);
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

for (const restoring of [false, true]) {
  const entry = restoring ? 'refresh recovery' : 'new download';

  test(`${entry} waits for an activating worker before loading the bridge or sending RPC`, async t => {
    const h = await harness(t, message => {
      if (message.action === 'ping') return { protocol: 1, workerBuild: build };
      if (message.action === 'start') return { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` };
      if (message.action === 'query') return { snapshots: [state()] };
    });
    h.worker.state = 'activating';
    if (restoring) {
      const { url, routes, ...last } = state();
      h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
    }
    const pending = restoring ? h.api.reconnectStreaming(() => {})
      : h.api.downloadStreaming(request, new AbortController().signal, () => {});
    await flush();
    assert.equal(h.frames.length, 0); assert.equal(h.messages.length, 0);
    assert.equal(h.updates, 0); assert.equal(h.registrations, 0); assert.equal(h.stateListeners, 1);

    h.transition('activated'); await flush();
    assert.equal(h.bridges.length, 1); assert.equal(h.stateListeners, 0); assert.equal(h.registrations, 0);
    if (restoring) {
      assert.equal((await pending)[0].status, 'downloading');
      assert.equal(h.messages.filter(message => message.action === 'query').length, 1);
      assert.equal(h.messages.some(message => message.action === 'start'), false);
      assert.equal(h.attachments.length, 0);
      h.update(state('completed'));
    } else {
      assert.equal(h.messages.filter(message => message.action === 'start').length, 1);
      assert.equal(h.attachments.length, 1);
      h.update(state('completed')); await pending;
    }
  });

  test(`${entry} never loads a bridge or starts media when activation becomes redundant`, async t => {
    const h = await harness(t);
    h.worker.state = 'activating';
    if (restoring) {
      const { url, routes, ...last } = state();
      h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
    }
    const pending = restoring ? h.api.reconnectStreaming(() => {})
      : h.api.downloadStreaming(request, new AbortController().signal, () => {});
    const rejected = restoring ? null
      : assert.rejects(pending, error => error.name === 'StreamingUnavailableError' && error.safeToFallback);
    await flush();
    assert.equal(h.frames.length, 0); assert.equal(h.messages.length, 0); assert.equal(h.stateListeners, 1);

    h.transition('redundant');
    if (restoring) {
      const [restored] = await pending;
      assert.equal(restored.status, 'downloading'); assert.equal(restored.observation, 'unknown');
      assert.equal(restored.loaded, 10 * 1024 ** 2);
    } else {
      await rejected;
      assert.equal(h.api.hasStreamingTask(request.id), false);
    }
    assert.equal(h.frames.length, 0); assert.equal(h.messages.length, 0);
    assert.equal(h.updates, 0); assert.equal(h.registrations, 0); assert.equal(h.stateListeners, 0);
  });
}

test('START and update checks wait for a controlled bridge, rather than a mere iframe element', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build }
    : { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` }, { autoLoadBridge: false });
  const task = h.api.downloadStreaming(request, new AbortController().signal, () => {});
  await flush();
  assert.equal(h.bridges.length, 1);
  assert.equal(h.messages.length, 0);
  assert.equal(h.updates, 0);
  assert.equal(h.attachments.length, 0);
  h.loadBridge(h.bridges[0]); await flush();
  assert.equal(h.messages.filter(message => message.action === 'start').length, 1);
  assert.equal(h.attachments.length, 1);
  h.update(state('completed')); await task;
});

test('bridge failure is eligible for fallback only before START has been sent', async t => {
  const h = await harness(t, undefined, { autoLoadBridge: false });
  const task = h.api.downloadStreaming(request, new AbortController().signal, () => {});
  await flush(); h.bridges[0].dispatch('error');
  await assert.rejects(task, error => error.name === 'StreamingUnavailableError' && error.safeToFallback);
  assert.equal(h.messages.some(message => message.action === 'start'), false);
  assert.equal(h.api.hasStreamingTask(request.id), false);
  h.tick(4000);
  assert.equal(h.bridges[0].removed, true);
});

test('aborting during bridge preparation never starts a transfer and releases its lease', async t => {
  const h = await harness(t, undefined, { autoLoadBridge: false });
  const controller = new AbortController();
  const task = h.api.downloadStreaming(request, controller.signal, () => {});
  await flush(); controller.abort(); h.loadBridge(h.bridges[0]);
  await assert.rejects(task, error => error.name === 'AbortError');
  assert.equal(h.messages.some(message => message.action === 'start'), false);
  assert.equal(h.api.hasStreamingTask(request.id), false);
  h.tick(4000);
  assert.equal(h.bridges[0].removed, true);
});

test('finishing one of two downloads does not release the other download bridge', async t => {
  const other = { ...request, id: 'task0000000000002', filename: '另一作品.mp4' };
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build }
    : message.action === 'start' ? { snapshot: state('downloading', { id: message.request.id, filename: message.request.filename }), downloadUrl: `/downloads/file/${message.request.id}/${message.token}` }
      : undefined);
  const first = h.api.downloadStreaming(request, new AbortController().signal, () => {});
  const second = h.api.downloadStreaming(other, new AbortController().signal, () => {});
  await flush();
  assert.equal(h.bridges.length, 1); assert.equal(h.attachments.length, 2);
  h.update(state('completed')); await first; h.tick(4000);
  assert.equal(h.bridges[0].removed, undefined);
  assert.equal(h.api.hasStreamingTask(other.id), true);
  assert.equal(h.attachments.find(frame => frame.src.includes(other.id)).removed, undefined);
  h.update(state('completed', { id: other.id, filename: other.filename })); await second;
  assert.equal(h.bridges[0].removed, undefined);
  h.tick(4000);
  assert.equal(h.bridges[0].removed, true);
});

test('refresh protects the existing task before querying it and never starts another download', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build }
    : { snapshots: [state()] }, { autoLoadBridge: false });
  const { url, routes, ...last } = state();
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
  const restoration = h.api.reconnectStreaming(() => {});
  await flush();
  assert.equal(h.bridges.length, 1); assert.equal(h.messages.length, 0);
  h.loadBridge(h.bridges[0]);
  const [restored] = await restoration;
  assert.equal(restored.id, request.id); assert.equal(restored.loaded, last.loaded);
  assert.equal(h.attachments.length, 0);
  assert.equal(h.messages.some(message => message.action === 'start'), false);
  const query = h.messages.find(message => message.action === 'query');
  assert.deepEqual(query.tasks, [{ id: request.id, token: 'a'.repeat(32) }]);
});

test('restoring only completed records does not pin an old Worker or check for updates', async t => {
  const h = await harness(t);
  const { url, ...result } = state('completed');
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), result }]));
  const [restored] = await h.api.reconnectStreaming(() => {});
  assert.equal(restored.status, 'completed');
  assert.equal(h.frames.length, 0); assert.equal(h.messages.length, 0); assert.equal(h.updates, 0);
});

test('query, cancellation and terminal cleanup retain the original task owner after registration changes', async t => {
  const h = await harness(t, message => {
    if (message.action === 'ping') return { protocol: 1, workerBuild: build };
    if (message.action === 'start') return { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` };
    if (message.action === 'query') return { snapshots: [state('downloading', { loaded: 20 * 1024 ** 2 })] };
    if (message.action === 'cancel') return { snapshot: state('cancelled') };
    if (message.action === 'forget') return { forgotten: true };
  });
  const observed = [], replacementMessages = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  const cancelled = assert.rejects(task, error => error.name === 'AbortError');
  await flush();
  h.registration.active = { scriptURL: origin + '/downloads/worker.js', state: 'activated', postMessage: message => replacementMessages.push(message) };
  await h.poll();
  assert.equal(observed.at(-1).loaded, 20 * 1024 ** 2);
  await h.api.cancelStreaming(request.id); await cancelled;
  await h.api.forgetStreaming(request.id);
  assert.deepEqual(replacementMessages, []);
  for (const action of ['query', 'cancel', 'forget']) assert.ok(h.messages.some(message => message.action === action));
});

test('a redundant owner is an interruption, not permission to resume through the replacement Worker', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build }
    : { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` });
  const observed = [], replacementMessages = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  const interrupted = assert.rejects(task, /原下载任务已失效/);
  await flush();
  h.worker.state = 'redundant';
  h.registration.active = { scriptURL: origin + '/downloads/worker.js', state: 'activated', postMessage: message => replacementMessages.push(message) };
  await h.poll(); await interrupted;
  assert.equal(observed.at(-1).status, 'interrupted'); assert.equal(observed.at(-1).loaded, 10 * 1024 ** 2);
  assert.equal(h.api.hasStreamingTask(request.id), false); assert.deepEqual(replacementMessages, []);
  assert.equal(h.messages.filter(message => message.action === 'start').length, 1);
  h.tick(4000); assert.equal(h.bridges[0].removed, true);
});

test('progress from a different build cannot complete an owned task', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build }
    : { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` });
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  await flush();
  h.update(state('completed', { workerBuild: 'next-build' }), { scriptURL: origin + '/downloads/worker.js' });
  assert.equal(observed.at(-1).status, 'downloading'); assert.equal(h.api.hasStreamingTask(request.id), true);
  h.update(state('completed', { workerBuild: build })); await task;
});

test('a distinct bridge controller only validates control while parent Worker handles RPC and progress', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build }
    : message.action === 'start' ? { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` }
      : message.action === 'forget' ? { forgotten: true } : undefined, { autoLoadBridge: false });
  let childCalls = 0;
  const childController = {
    state: 'activated', scriptURL: h.worker.scriptURL,
    postMessage() { childCalls++; throw new Error('RPC must belong to the parent page'); },
  };
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  await flush(); h.loadBridge(h.bridges[0], { controller: childController }); await flush();
  assert.notEqual(childController, h.worker);
  assert.equal(h.messages.filter(message => message.action === 'start').length, 1);
  h.update(state('completed'));
  assert.equal((await task).workerBuild, build);
  assert.equal(observed.at(-1).status, 'completed');
  h.tick(4000); assert.equal(h.bridges[0].removed, true);
  await h.api.forgetStreaming(request.id);
  assert.equal(h.messages.filter(message => message.action === 'forget').length, 1);
  assert.equal(childCalls, 0, 'releasing the child realm cannot invalidate the task owner used for cleanup');
  assert.deepEqual(JSON.parse(h.storage.get('dokitool-downloads-v1')), []);
});

test('a different parent Worker cannot publish completion even when its script and build match', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build }
    : { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` });
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  await flush();
  h.update(state('completed', { workerBuild: build }), { scriptURL: h.worker.scriptURL, state: 'activated' });
  assert.equal(observed.at(-1).status, 'downloading'); assert.equal(h.api.hasStreamingTask(request.id), true);
  h.update(state('completed', { workerBuild: build })); await task;
});

for (const retirement of ['before cleanup', 'during cleanup', 'reply timeout']) test(`terminal records can be cleared when the owner is unavailable (${retirement})`, async t => {
  let h;
  h = await harness(t, message => {
    if (message.action === 'ping') return { protocol: 1, workerBuild: build };
    if (message.action === 'start') return { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` };
    if (message.action === 'forget' && retirement === 'during cleanup') {
      h.worker.state = 'redundant';
      return { error: 'owner retired before cleanup finished' };
    }
  });
  const task = h.api.downloadStreaming(request, new AbortController().signal, () => {});
  await flush(); h.update(state('completed')); await task; h.tick(4000);
  const replacementMessages = [];
  h.registration.active = { scriptURL: h.worker.scriptURL, state: 'activated', postMessage: message => replacementMessages.push(message) };
  if (retirement === 'before cleanup') h.worker.state = 'redundant';
  const cleanup = h.api.forgetStreaming(request.id);
  await flush();
  if (retirement === 'reply timeout') h.tick(8000);
  await cleanup;
  assert.deepEqual(JSON.parse(h.storage.get('dokitool-downloads-v1')), []);
  assert.deepEqual(replacementMessages, [], 'cleanup cannot be rebound to the replacement Worker');
  assert.equal(h.bridges.length, 1); assert.equal(h.bridges[0].removed, true);
});

test('a pending saved record cannot be forgotten before restoration confirms it stopped', async t => {
  const h = await harness(t);
  const record = { id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now() };
  h.storage.set('dokitool-downloads-v1', JSON.stringify([record]));
  await assert.rejects(h.api.forgetStreaming(request.id), /先确认下载已停止/);
  assert.deepEqual(JSON.parse(h.storage.get('dokitool-downloads-v1')), [record]);
  assert.equal(h.frames.length, 0); assert.equal(h.messages.length, 0);
});
