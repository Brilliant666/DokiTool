import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build as bundle } from 'esbuild';

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
  // Bundle the real module graph so session/bridge refactors cannot silently use stale mocks.
  const entry = options.withStore ? { stdin: {
    contents: `export * from './src/downloads/streaming';
      export { useMediaDownload } from './src/composables/useMediaDownload';
      export { useVideoSelection } from './src/composables/useVideoSelection';
      export { useVideoStore } from './src/stores/video';
      export { createPinia } from 'pinia';`,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
  }, define: { 'import.meta.env': '{}', __VUE_OPTIONS_API__: 'true', __VUE_PROD_DEVTOOLS__: 'false' } }
    : { entryPoints: [fileURLToPath(new URL('../src/downloads/streaming.ts', import.meta.url))] };
  const { outputFiles } = await bundle({ ...entry, bundle: true, write: false, platform: 'browser', format: 'esm' });
  const code = outputFiles[0].text;
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
      const reply = respond ? respond(message, port) : message.action === 'ping' ? { protocol: 1, workerBuild: build } : undefined;
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
      let closed = false;
      this.port1 = { onmessage: null, close() { closed = true; } };
      this.port2 = { postMessage: data => queueMicrotask(() => { if (!closed) this.port1.onmessage?.({ data }); }) };
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
    api, worker, registration, messages, frames, storage, timers, loadBridge, setGlobal,
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
  assert.equal(observed.at(-1).status, 'queued'); assert.equal(observed.at(-1).observation, 'unknown');
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

test('query miss is observation uncertainty, never proof that the transfer failed', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build } : { snapshots: [] });
  const { url, routes, ...last } = state();
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
  const [missing] = await h.api.reconnectStreaming(() => {});
  assert.equal(missing.status, 'downloading'); assert.equal(missing.observation, 'unknown');
  assert.equal(missing.loaded, 10 * 1024 ** 2); assert.equal(h.api.hasStreamingTask(request.id), true);
  assert.equal(h.messages.some(message => ['start', 'cancel'].includes(message.action)), false);
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
      : assert.rejects(pending, error => error.name !== 'StreamingUnavailableError' && !error.safeToFallback);
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

test('bridge loading failure remains an operational failure and never permits Blob fallback', async t => {
  const h = await harness(t, undefined, { autoLoadBridge: false });
  const task = h.api.downloadStreaming(request, new AbortController().signal, () => {});
  await flush(); h.bridges[0].dispatch('error');
  await assert.rejects(task, error => error.name !== 'StreamingUnavailableError' && !error.safeToFallback);
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
  assert.equal(h.messages.filter(message => message.action === 'ping').length, 1, 'concurrent starts share one capability handshake');
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

test('a redundant owner permits result lookup only, never replacement START or false failure', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build }
    : { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` });
  const observed = [], replacementMessages = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  const interrupted = assert.rejects(task, error => error.name === 'StreamingStateUnknownError');
  await flush();
  h.worker.state = 'redundant';
  h.registration.active = { scriptURL: origin + '/downloads/worker.js', state: 'activated', postMessage(message, [port]) {
    replacementMessages.push(message); port.postMessage(message.action === 'ping' ? { protocol: 1, workerBuild: 'next-build' } : { snapshots: [], unavailable: [{ id: request.id, ownerGone: true }] });
  } };
  await h.poll(); h.advance(60_001); await h.poll(); await interrupted;
  assert.equal(observed.at(-1).status, 'downloading'); assert.equal(observed.at(-1).recoveryExpired, true);
  assert.equal(observed.at(-1).loaded, 10 * 1024 ** 2);
  assert.equal(h.api.hasStreamingTask(request.id), false);
  assert.ok(replacementMessages.every(message => ['ping', 'query'].includes(message.action)));
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

test('only a genuinely unsupported browser exposes the explicit Blob fallback error', async t => {
  const h = await harness(t);
  h.setGlobal('isSecureContext', false);
  await assert.rejects(h.api.downloadStreaming(request, new AbortController().signal, () => {}), error => error.name === 'StreamingUnavailableError' && error.safeToFallback === true);
  assert.equal(h.frames.length, 0); assert.equal(h.messages.length, 0);
  assert.equal(h.api.hasStreamingTask(request.id), false);
});

for (const failure of ['missing bridge document', 'bridge timeout', 'protocol mismatch']) {
  test(`${failure} is reported without claiming unsupported-browser fallback`, async t => {
    const h = await harness(t, message => message.action === 'ping' ? { protocol: 2, workerBuild: build } : undefined, { autoLoadBridge: false });
    const task = h.api.downloadStreaming(request, new AbortController().signal, () => {});
    const rejected = assert.rejects(task, error => error.name !== 'StreamingUnavailableError' && !error.safeToFallback);
    await flush();
    if (failure === 'missing bridge document') h.loadBridge(h.bridges[0], { marker: false });
    else if (failure === 'bridge timeout') h.tick(8000);
    else h.loadBridge(h.bridges[0]);
    await rejected;
    assert.equal(h.messages.some(message => message.action === 'start'), false);
    assert.equal(h.attachments.length, 0);
    assert.equal(h.api.hasStreamingTask(request.id), false);
  });
}

const admissionPing = { protocol: 1, workerBuild: 'downloads-admission', capabilities: { admission: true } };
const admittedState = (delivery, revision, patch = {}) => state(delivery === 'claimed' ? 'downloading' : 'queued', {
  delivery, revision, loaded: 0, workerBuild: admissionPing.workerBuild, ...patch,
});

test('a fixed recovery deadline survives empty queries and refresh, then manual query can restore terminal', async t => {
  let found = false;
  const instance = 'owner-instance';
  const h = await harness(t, message => message.action === 'ping' ? { ...admissionPing, workerInstance: instance }
    : { workerInstance: instance, snapshots: found ? [admittedState('claimed', 12, { status: 'completed', workerInstance: instance })] : [] });
  const { url, ...last } = admittedState('claimed', 10, { workerInstance: instance });
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
  const observed = []; await h.api.reconnectStreaming(value => observed.push(value));
  const deadline = observed.at(-1).recoveryDeadline;
  h.advance(35_000); await h.poll(); assert.equal(observed.at(-1).recoveryDeadline, deadline);
  h.advance(25_001); await h.poll();
  assert.equal(observed.at(-1).recoveryExpired, true);
  assert.match(observed.at(-1).error, /无法确认下载结果，请查看浏览器下载列表/);
  assert.equal([...h.timers.values()].some(timer => timer.delay === 5000), false);
  h.tick(4000); assert.notEqual(h.bridges[0].removed, true, 'query misses alone cannot release a possibly live owner');
  const count = h.messages.length;
  await h.api.reconnectStreaming(() => {});
  assert.equal(h.messages.length, count + 1, 'expired recovery permits one read-only result check');
  assert.equal(observed.at(-1).recoveryDeadline, deadline, 'the result check cannot renew the recovery window');
  assert.equal([...h.timers.values()].some(timer => timer.delay === 5000), false);
  await h.api.reconnectStreaming(() => {});
  assert.equal(h.messages.length, count + 1, 'repeated restoration in the same page cannot repeat the check');
  found = true; await h.api.queryStreaming(request.id);
  assert.equal(observed.at(-1).status, 'completed');
  assert.equal(h.messages.some(message => ['start', 'cancel'].includes(message.action)), false);
  assert.equal(h.attachments.length, 0);
  h.tick(4000); assert.equal(h.bridges[0].removed, true);
});

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`expired refresh reads a stored ${status} result once without restarting observation or delivery`, async t => {
    const instance = 'original-instance';
    const h = await harness(t, message => message.action === 'ping'
      ? { ...admissionPing, workerInstance: 'replacement-instance' }
      : { snapshots: [admittedState('claimed', 12, { status, workerInstance: instance, filename: '作品.mp4', error: status === 'failed' ? 'truncated' : undefined })] });
    const { url, ...last } = admittedState('claimed', 10, { workerInstance: instance, filename: '作品.bin' });
    const deadline = Date.now() - 1;
    h.storage.set('dokitool-downloads-v1', JSON.stringify([{
      id: request.id, token: 'a'.repeat(32), filename: last.filename, savedAt: Date.now(),
      recoveryDeadline: deadline, ownerGone: true, last,
    }]));
    const observed = [];
    const [restored] = await h.api.reconnectStreaming(value => observed.push(value));
    assert.equal(restored.status, status);
    assert.equal(observed.at(-1).filename, '作品.mp4');
    assert.equal(restored.observation, undefined);
    assert.equal(restored.recoveryDeadline, undefined);
    assert.equal(h.messages.filter(message => message.action === 'query').length, 1);
    assert.deepEqual(h.messages.find(message => message.action === 'query').tasks, [{ id: request.id, token: 'a'.repeat(32), workerInstance: instance }]);
    assert.equal(h.messages.some(message => ['start', 'cancel'].includes(message.action)), false);
    assert.equal(h.attachments.length, 0);
    assert.equal([...h.timers.values()].some(timer => timer.delay === 5000), false);
    await h.api.reconnectStreaming(() => {});
    assert.equal(h.messages.filter(message => message.action === 'query').length, 1);
    h.tick(4000); assert.equal(h.bridges[0].removed, true);
  });
}

for (const response of ['missing', 'active', 'wrong instance', 'old revision', 'wrong id', 'query error']) {
  test(`expired refresh keeps its original deadline when a result check returns ${response}`, async t => {
    const instance = 'original-instance';
    const candidate = admittedState('claimed', response === 'old revision' ? 9 : 12, {
      status: response === 'active' ? 'downloading' : 'completed',
      workerInstance: response === 'wrong instance' ? 'different-instance' : instance,
      ...(response === 'wrong id' ? { id: 'another0000000001' } : {}),
    });
    const h = await harness(t, message => message.action === 'ping'
      ? { ...admissionPing, workerInstance: instance }
      : response === 'query error' ? { error: 'temporary failure' }
        : { snapshots: response === 'missing' ? [] : [candidate] });
    const { url, ...last } = admittedState('claimed', 10, { workerInstance: instance });
    const deadline = Date.now() - 1;
    h.storage.set('dokitool-downloads-v1', JSON.stringify([{
      id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(),
      recoveryDeadline: deadline, cancelRequested: true, last,
    }]));
    const observed = []; await h.api.reconnectStreaming(value => observed.push(value));
    assert.equal(h.messages.filter(message => message.action === 'query').length, 1);
    assert.equal(observed.at(-1).observation, 'unknown');
    assert.equal(observed.at(-1).recoveryExpired, true);
    assert.equal(observed.at(-1).recoveryDeadline, deadline);
    assert.equal(JSON.parse(h.storage.get('dokitool-downloads-v1'))[0].recoveryDeadline, deadline);
    assert.equal(h.messages.some(message => ['start', 'cancel'].includes(message.action)), false);
    assert.equal(h.attachments.length, 0);
    assert.equal([...h.timers.values()].some(timer => timer.delay === 5000), false);
    if (response === 'active') {
      h.update(admittedState('claimed', 13, { workerInstance: instance }));
      assert.equal(observed.at(-1).recoveryDeadline, deadline, 'subscribed progress must not reopen automatic observation');
      assert.equal([...h.timers.values()].some(timer => timer.delay === 5000), false);
      h.update(admittedState('claimed', 14, { status: 'completed', workerInstance: instance }));
      assert.equal(observed.at(-1).status, 'completed', 'a same-owner late terminal remains authoritative');
    }
    await h.api.reconnectStreaming(() => {});
    assert.equal(h.messages.filter(message => message.action === 'query').length, 1);
  });
}

test('old client-inferred interrupted is rechecked, but confirmed terminal summaries remain absorbing', async t => {
  const h = await harness(t, message => message.action === 'ping' ? admissionPing
    : { snapshots: [admittedState('claimed', 5, { workerInstance: 'old-instance', status: 'completed' })] });
  const { url, ...result } = admittedState('claimed', 900, { status: 'interrupted' });
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), result }]));
  const observed = []; await h.api.reconnectStreaming(value => observed.push(value));
  assert.equal(observed.at(-1).status, 'completed', 'legacy revision without an execution identity must not reject durable evidence');
  const queries = h.messages.length; await h.api.queryStreaming(request.id);
  assert.equal(h.messages.length, queries); h.update(admittedState('claimed', 901, { status: 'failed', workerInstance: 'old-instance' }));
  assert.equal(observed.at(-1).status, 'completed');
});

test('same-build restart reports old active ownership gone without adopting a new execution', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { ...admissionPing, workerInstance: 'new-instance' }
    : { snapshots: [], workerInstance: 'new-instance', unavailable: [{ id: request.id, ownerGone: true }] });
  const { url, ...last } = admittedState('claimed', 20, { workerInstance: 'old-instance' });
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
  const observed = []; await h.api.reconnectStreaming(value => observed.push(value));
  assert.equal(observed.at(-1).observation, 'unknown'); assert.equal(observed.at(-1).ownerGone, true);
  assert.equal(observed.at(-1).workerInstance, 'old-instance');
  h.update(admittedState('claimed', 100, { status: 'completed', workerInstance: 'new-instance' }));
  assert.notEqual(observed.at(-1).status, 'completed');
  h.tick(4000); assert.equal(h.bridges[0].removed, true);
  h.advance(60_001); await h.poll(); assert.equal(observed.at(-1).recoveryExpired, true);
  assert.equal(h.messages.some(message => ['start', 'cancel'].includes(message.action)), false);
});

for (const alreadyExpired of [false, true]) {
  test(`legacy build-only recovery releases a replaced owner${alreadyExpired ? ' after a saved deadline' : ''} without inventing a result`, async t => {
    const h = await harness(t, message => message.action === 'ping'
      ? { protocol: 1, workerBuild: 'downloads-20261031.1', workerInstance: 'current-instance' }
      : message.action === 'forget' ? { forgotten: true }
        : { snapshots: [], unavailable: [{ id: request.id, ownerGone: false }] });
    const { url, ...last } = state('downloading', { workerBuild: 'downloads-20261030.4' });
    h.storage.set('dokitool-downloads-v1', JSON.stringify([{
      id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last,
      ...(alreadyExpired ? { recoveryDeadline: Date.now() - 1 } : {}),
    }]));
    const observed = []; await h.api.reconnectStreaming(value => observed.push(value));
    assert.equal(observed.at(-1).status, 'downloading');
    assert.equal(observed.at(-1).observation, 'unknown');
    assert.equal(observed.at(-1).ownerGone, true, 'a verified replacement build cannot own the legacy in-memory transfer');
    assert.equal(h.api.hasStreamingTask(request.id), false);
    h.tick(4000); assert.equal(h.bridges[0].removed, true);
    if (!alreadyExpired) { h.advance(60_001); await h.poll(); }
    assert.equal(observed.at(-1).recoveryExpired, true);
    assert.match(observed.at(-1).error, /无法确认下载结果/);
    assert.equal([...h.timers.values()].some(timer => timer.delay === 5000), false);
    assert.equal(h.messages.filter(message => message.action === 'query').length, 1);
    await h.api.forgetStreaming(request.id);
    assert.deepEqual(JSON.parse(h.storage.get('dokitool-downloads-v1')), []);
    assert.equal(h.messages.some(message => ['start', 'cancel'].includes(message.action)), false);
    assert.equal(h.attachments.length, 0);
  });
}

test('legacy build replacement still queries for a trusted terminal instead of stopping at ownerGone', async t => {
  let found = false;
  const h = await harness(t, message => message.action === 'ping'
    ? { protocol: 1, workerBuild: 'downloads-20261031.1', workerInstance: 'current-instance' }
    : { snapshots: found ? [state('completed', { workerBuild: 'downloads-20261030.4', revision: 2 })] : [] });
  const { url, ...last } = state('downloading', { workerBuild: 'downloads-20261030.4', revision: 1 });
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
  const observed = []; await h.api.reconnectStreaming(value => observed.push(value));
  assert.equal(h.messages.filter(message => message.action === 'query').length, 1);
  assert.equal(observed.at(-1).ownerGone, true);
  h.tick(4000); assert.equal(h.bridges[0].removed, true);
  h.advance(60_001); await h.poll();
  found = true; await h.api.queryStreaming(request.id);
  assert.equal(observed.at(-1).status, 'completed');
  assert.equal(observed.at(-1).observation, undefined);
  assert.equal(observed.at(-1).ownerGone, undefined);
  assert.equal(h.messages.filter(message => message.action === 'query').length, 2);
  assert.equal(h.messages.some(message => ['start', 'cancel'].includes(message.action)), false);
  assert.equal(h.attachments.length, 0);
});

for (const alreadyRestored of [false, true]) test(`legacy build-only recovery clears through the real composable, Pinia store and streaming module${alreadyRestored ? ' after refreshing an expired record' : ''}`, async t => {
  const h = await harness(t, message => message.action === 'ping'
    ? { protocol: 1, workerBuild: 'downloads-20261031.1', workerInstance: 'current-instance' }
    : message.action === 'forget' ? { forgotten: true } : { snapshots: [] }, { withStore: true });
  const { url, ...last } = state('downloading', { workerBuild: 'downloads-20261030.4' });
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{
    id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last,
    ...(alreadyRestored ? { recoveryDeadline: Date.now() - 1, ownerGone: true } : {}),
  }]));
  const store = h.api.useVideoStore(h.api.createPinia());
  const toasts = [];
  const ui = h.api.useMediaDownload({ videoStore: store, selection: h.api.useVideoSelection({ videoStore: store }), resolveItem: async item => item, showToast: (...args) => toasts.push(args) });
  await ui.restoreDownloads();
  assert.equal(store.downloads.length, 1);
  assert.equal(store.downloads[0].ownerGone, true);
  if (!alreadyRestored) { h.advance(60_001); await h.poll(); h.tick(4000); }
  assert.equal(store.downloads[0].recoveryExpired, true);
  await ui.handleClearCompleted(alreadyRestored ? 'all' : store.downloads[0].id);
  assert.deepEqual(toasts, []);
  assert.equal(h.messages.filter(message => message.action === 'forget').length, 1);
  assert.equal(store.downloads.length, 0);
  assert.deepEqual(JSON.parse(h.storage.get('dokitool-downloads-v1')), []);
  assert.equal(h.messages.some(message => ['start', 'cancel'].includes(message.action)), false);
});

for (const [savedBuild, activeBuild] of [
  ['downloads-20261030.4', 'downloads-20261030.4'],
  [undefined, 'downloads-20261031.1'],
  ['legacy', 'downloads-20261031.1'],
  ['downloads-20261030.4', undefined],
]) {
  test(`legacy query misses do not prove retirement when build evidence is ${savedBuild} / ${activeBuild}`, async t => {
    const h = await harness(t, message => message.action === 'ping'
      ? { protocol: 1, workerBuild: activeBuild, workerInstance: 'current-instance' } : { snapshots: [] });
    const { url, ...last } = state('downloading', { workerBuild: savedBuild });
    h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
    const observed = []; await h.api.reconnectStreaming(value => observed.push(value));
    h.advance(60_001); await h.poll(); h.tick(4000);
    assert.equal(observed.at(-1).recoveryExpired, true);
    assert.equal(observed.at(-1).observation, 'unknown');
    assert.equal(observed.at(-1).ownerGone, undefined);
    assert.equal(h.api.hasStreamingTask(request.id), true);
    assert.notEqual(h.bridges[0].removed, true);
    await assert.rejects(h.api.forgetStreaming(request.id), /先确认下载已停止/);
    assert.equal(h.messages.some(message => ['start', 'cancel', 'forget'].includes(message.action)), false);
  });
}

test('uncertainty accepts the same execution authoritative failure and rejects older or conflicting terminals', async t => {
  const instance = 'original-instance';
  const h = await harness(t, message => message.action === 'ping' ? { ...admissionPing, workerInstance: instance } : { snapshots: [] });
  const { url, ...last } = admittedState('claimed', 10, { workerInstance: instance });
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
  const observed = []; await h.api.reconnectStreaming(value => observed.push(value));
  h.update(admittedState('claimed', 9, { status: 'completed', workerInstance: instance }));
  assert.equal(observed.at(-1).observation, 'unknown');
  h.update(admittedState('claimed', 11, { status: 'failed', error: 'truncated', workerInstance: instance }));
  assert.equal(observed.at(-1).status, 'failed');
  h.update(admittedState('claimed', 12, { status: 'completed', workerInstance: instance }));
  assert.equal(observed.at(-1).status, 'failed', 'completed is not privileged over a confirmed failure');
});

test('admission waits without an attachment and opens exactly once when the Worker reports ready', async t => {
  const h = await harness(t, message => message.action === 'ping' ? admissionPing
    : message.action === 'start' ? { snapshot: admittedState('waiting', 1) } : undefined);
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  await flush();
  const start = h.messages.find(message => message.action === 'start');
  assert.equal(start.admission, true);
  assert.equal(h.api.hasStreamingTask(request.id), true);
  assert.equal(h.attachments.length, 0, 'a queued admission must not create a long-lived attachment fetch');
  assert.equal(observed.at(-1).delivery, 'waiting');

  h.update(admittedState('ready', 2)); await flush();
  assert.equal(h.attachments.length, 1);
  assert.equal(h.attachments[0].src, `/downloads/file/${request.id}/${start.token}`);
  h.update(admittedState('ready', 2));
  h.update(admittedState('claimed', 3, { loaded: 1024 }));
  h.update(admittedState('ready', 2)); await flush();
  assert.equal(h.attachments.length, 1);
  assert.equal(observed.at(-1).delivery, 'claimed');
  assert.equal(observed.at(-1).loaded, 1024);
  h.update(admittedState('claimed', 4, { status: 'completed', loaded: 100 * 1024 ** 2 }));
  assert.equal((await task).status, 'completed');
  assert.equal(h.messages.filter(message => message.action === 'start').length, 1);
});

test('a legacy Worker without admission capability keeps its original downloadUrl flow', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: 'downloads-20261030.3' }
    : message.action === 'start' ? { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` } : undefined);
  const task = h.api.downloadStreaming(request, new AbortController().signal, () => {});
  await flush();
  assert.notEqual(h.messages.find(message => message.action === 'start').admission, true);
  assert.equal(h.attachments.length, 1);
  h.update(state('completed')); await task;
});

for (const delivery of ['waiting', 'ready', 'claimed']) {
  test(`refresh recovery of admission ${delivery} never sends another START`, async t => {
    const h = await harness(t, message => message.action === 'ping' ? admissionPing
      : message.action === 'query' ? { snapshots: [admittedState(delivery, 4)] } : undefined);
    const { url, ...last } = admittedState(delivery, 3);
    h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last }]));
    const [restored] = await h.api.reconnectStreaming(() => {});
    assert.equal(restored.id, request.id); assert.equal(restored.delivery, delivery);
    assert.equal(h.messages.some(message => message.action === 'start'), false);
    assert.equal(h.attachments.length, delivery === 'ready' ? 1 : 0);
    if (delivery === 'ready') assert.equal(h.attachments[0].src, `/downloads/file/${request.id}/${'a'.repeat(32)}`);
    h.update(admittedState('claimed', 5, { status: 'completed', loaded: 100 * 1024 ** 2 }));
  });
}

test('a lost admission START acknowledgement remains unknown and later readiness never duplicates START', async t => {
  let startPort;
  const h = await harness(t, (message, port) => {
    if (message.action === 'ping') return admissionPing;
    if (message.action === 'start') { startPort = port; return undefined; }
    if (message.action === 'query') return { snapshots: [admittedState('ready', 2)] };
  });
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  const rejected = assert.rejects(task, error => error.name === 'StreamingStateUnknownError' && !error.safeToFallback);
  await flush(); h.tick(8000); await rejected;
  assert.equal(observed.at(-1).observation, 'unknown');
  assert.equal(h.attachments.length, 0); assert.equal(h.api.hasStreamingTask(request.id), true);
  await h.poll();
  assert.equal(h.attachments.length, 1); assert.equal(observed.at(-1).delivery, 'ready');
  startPort.postMessage({ snapshot: admittedState('waiting', 1) }); await flush();
  assert.equal(observed.at(-1).delivery, 'ready'); assert.equal(h.attachments.length, 1);
  assert.equal(h.messages.filter(message => message.action === 'start').length, 1);
  h.update(admittedState('claimed', 3, { status: 'completed', loaded: 100 * 1024 ** 2 }));
});

test('revisions reject delayed query results and terminal state absorbs later snapshots', async t => {
  let queryPort;
  const h = await harness(t, (message, port) => {
    if (message.action === 'ping') return admissionPing;
    if (message.action === 'start') return { snapshot: admittedState('ready', 1) };
    if (message.action === 'query') { queryPort = port; return undefined; }
  });
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  await flush();
  h.update(admittedState('claimed', 3, { loaded: 20 * 1024 ** 2 }));
  const poll = h.poll(); await flush();
  h.update(admittedState('claimed', 4, { loaded: 30 * 1024 ** 2 }));
  queryPort.postMessage({ snapshots: [admittedState('claimed', 2, { loaded: 10 * 1024 ** 2 })] }); await poll; await flush();
  assert.equal(observed.at(-1).revision, 4); assert.equal(observed.at(-1).loaded, 30 * 1024 ** 2);
  h.update(admittedState('claimed', 5, { status: 'completed', loaded: 100 * 1024 ** 2 })); await task;
  h.update(admittedState('claimed', 6, { loaded: 40 * 1024 ** 2 }));
  h.update(admittedState('claimed', 7, { status: 'failed', error: 'late stale failure' }));
  assert.equal(observed.at(-1).status, 'completed');
  assert.equal(observed.at(-1).loaded, 100 * 1024 ** 2);
  assert.equal(h.api.hasStreamingTask(request.id), false);
});

test('legacy snapshots without revisions cannot move bytes or lifecycle stages backwards', async t => {
  const h = await harness(t, message => message.action === 'ping' ? { protocol: 1, workerBuild: build }
    : message.action === 'start' ? { snapshot: state(), downloadUrl: `/downloads/file/${request.id}/${message.token}` } : undefined);
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  await flush();
  h.update(state('downloading', { loaded: 30 * 1024 ** 2 }));
  h.update(state('downloading', { loaded: 5 * 1024 ** 2 }));
  h.update(state('preparing', { loaded: 30 * 1024 ** 2 }));
  assert.equal(observed.at(-1).loaded, 30 * 1024 ** 2);
  assert.equal(observed.at(-1).status, 'downloading');
  h.update(state('completed', { loaded: 100 * 1024 ** 2 })); await task;
  h.update(state('downloading', { loaded: 100 * 1024 ** 2 }));
  assert.equal(observed.at(-1).status, 'completed');
});

test('clearing restored terminal records can send token-authenticated forget to the active Worker', async t => {
  const h = await harness(t, message => message.action === 'ping' ? admissionPing
    : message.action === 'forget' ? { forgotten: true } : undefined);
  const { url, ...result } = admittedState('claimed', 5, { status: 'completed', loaded: 100 * 1024 ** 2 });
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), result }]));
  await h.api.reconnectStreaming(() => {});
  assert.equal(h.messages.length, 0, 'restoring a terminal summary alone does not contact the Worker');
  await h.api.forgetStreaming(request.id);
  const forgotten = h.messages.find(message => message.action === 'forget');
  assert.ok(forgotten, 'clear must release retained terminal entries instead of only hiding local cards');
  assert.equal(forgotten.id, request.id); assert.equal(forgotten.token, 'a'.repeat(32));
  assert.equal(h.messages.some(message => ['start', 'cancel'].includes(message.action)), false);
  assert.equal(h.frames.length, 0, 'terminal-history cleanup must not retain a new bridge');
  assert.equal(h.updates, 0); assert.equal(h.registrations, 0);
  assert.deepEqual(JSON.parse(h.storage.get('dokitool-downloads-v1')), []);
});

test('an explicit START refusal fails cleanly instead of becoming an uncertain live task', async t => {
  const h = await harness(t, message => message.action === 'ping' ? admissionPing
    : message.action === 'start' ? { error: '下载任务过多，请清理后重试' } : undefined);
  const observed = [];
  await assert.rejects(h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot)), /下载任务过多/);
  assert.equal(observed.at(-1).status, 'failed'); assert.equal(observed.at(-1).observation, undefined);
  assert.equal(h.api.hasStreamingTask(request.id), false); assert.equal(h.attachments.length, 0);
  h.tick(4000); assert.equal(h.bridges[0].removed, true);
});

test('cancelling an admitted waiting task never opens an attachment or restarts delivery', async t => {
  const h = await harness(t, message => message.action === 'ping' ? admissionPing
    : message.action === 'start' ? { snapshot: admittedState('waiting', 1) }
      : message.action === 'cancel' ? { snapshot: admittedState('waiting', 2, { status: 'cancelled' }) } : undefined);
  const task = h.api.downloadStreaming(request, new AbortController().signal, () => {});
  const cancelled = assert.rejects(task, { name: 'AbortError' });
  await flush(); await h.api.cancelStreaming(request.id); await cancelled;
  h.update(admittedState('ready', 3)); await flush();
  assert.equal(h.attachments.length, 0); assert.equal(h.api.hasStreamingTask(request.id), false);
  assert.equal(h.messages.filter(message => message.action === 'start').length, 1);
  h.tick(4000); assert.equal(h.bridges[0].removed, true);
});

test('one old pending download survives a hundred newer terminal records and refresh only queries the pending task', async t => {
  const h = await harness(t, message => message.action === 'ping' ? admissionPing
    : message.action === 'query' ? { snapshots: [admittedState('claimed', 3, { loaded: 20 * 1024 ** 2 })] } : undefined);
  const { url, ...last } = admittedState('claimed', 2, { loaded: 10 * 1024 ** 2 });
  const oldPending = { id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now() - 25 * 60 * 60_000, last };
  const completed = Array.from({ length: 100 }, (_, index) => {
    const id = `completed${String(index).padStart(16, '0')}`;
    const { url: _url, ...result } = admittedState('claimed', 5, { id, status: 'completed', loaded: 100 * 1024 ** 2 });
    return { id, token: 'b'.repeat(32), filename: `已完成${index}.mp4`, savedAt: Date.now(), result };
  });
  h.storage.set('dokitool-downloads-v1', JSON.stringify([oldPending, ...completed]));
  const restored = await h.api.reconnectStreaming(() => {});
  assert.equal(restored.find(snapshot => snapshot.id === request.id)?.status, 'downloading');
  assert.equal(h.api.hasStreamingTask(request.id), true);
  const queries = h.messages.filter(message => message.action === 'query');
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].tasks, [{ id: request.id, token: oldPending.token }]);
  assert.equal(h.messages.filter(message => message.action === 'ping').length, 1);
  assert.equal(h.bridges.length, 1); assert.equal(h.bridges[0].removed, undefined);
  assert.equal(h.attachments.length, 0);
  assert.ok(JSON.parse(h.storage.get('dokitool-downloads-v1')).some(key => key.id === request.id), 'a checkpoint write must not evict the pending record');
  h.update(admittedState('claimed', 4, { status: 'completed', loaded: 100 * 1024 ** 2 }));
  h.tick(4000); assert.equal(h.bridges[0].removed, true);
});

test('ten restored pending tasks share one handshake and one grouped query', async t => {
  const records = Array.from({ length: 10 }, (_, index) => ({
    id: `pending${String(index).padStart(16, '0')}`, token: `${index}`.repeat(32), filename: `等待${index}.mp4`,
  }));
  const h = await harness(t, message => message.action === 'ping' ? admissionPing
    : message.action === 'query' ? { snapshots: message.tasks.map(({ id }) => admittedState('waiting', 2, { id })) } : undefined);
  h.storage.set('dokitool-downloads-v1', JSON.stringify(records.map(key => ({ ...key, savedAt: Date.now() }))));
  const restored = await h.api.reconnectStreaming(() => {});
  assert.equal(restored.length, 10);
  assert.equal(h.messages.filter(message => message.action === 'ping').length, 1);
  const queries = h.messages.filter(message => message.action === 'query');
  assert.equal(queries.length, 1); assert.equal(queries[0].tasks.length, 10);
  assert.equal(h.bridges.length, 1); assert.equal(h.attachments.length, 0);
  assert.equal(h.messages.some(message => message.action === 'start'), false);
  records.forEach(({ id }) => h.update(admittedState('waiting', 3, { id, status: 'cancelled' })));
  h.tick(4000); assert.equal(h.bridges[0].removed, true);
});

test('a ready push cannot claim an admitted attachment while cancellation awaits acknowledgement', async t => {
  let cancelPort;
  const h = await harness(t, (message, port) => {
    if (message.action === 'ping') return admissionPing;
    if (message.action === 'start') return { snapshot: admittedState('waiting', 1) };
    if (message.action === 'cancel') { cancelPort = port; return undefined; }
  });
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot));
  const cancelled = assert.rejects(task, { name: 'AbortError' });
  await flush();
  const cancelling = h.api.cancelStreaming(request.id);
  const alsoCancelling = h.api.cancelStreaming(request.id);
  await flush();
  assert.equal(h.messages.filter(message => message.action === 'cancel').length, 1, 'one task shares an in-flight cancellation request');
  h.update(admittedState('ready', 2)); await flush();
  assert.equal(h.attachments.length, 0);
  assert.notEqual(observed.at(-1).status, 'cancelled', 'intent does not establish a confirmed terminal outcome');
  assert.equal(h.api.hasStreamingTask(request.id), true);
  assert.equal(JSON.parse(h.storage.get('dokitool-downloads-v1'))[0].cancelRequested, true);
  h.tick(4000); assert.equal(h.bridges[0].removed, undefined);
  cancelPort.postMessage({ snapshot: admittedState('waiting', 3, { status: 'cancelled' }) });
  await Promise.all([cancelling, alsoCancelling, cancelled]);
  assert.equal(observed.at(-1).status, 'cancelled'); assert.equal(h.attachments.length, 0);
});

test('AbortSignal cancellation suppresses ready delivery before its Worker reply arrives', async t => {
  let cancelPort;
  const h = await harness(t, (message, port) => {
    if (message.action === 'ping') return admissionPing;
    if (message.action === 'start') return { snapshot: admittedState('waiting', 1) };
    if (message.action === 'cancel') { cancelPort = port; return undefined; }
  });
  const controller = new AbortController(), observed = [];
  const task = h.api.downloadStreaming(request, controller.signal, snapshot => observed.push(snapshot));
  const cancelled = assert.rejects(task, { name: 'AbortError' });
  await flush(); controller.abort();
  h.update(admittedState('ready', 2)); await flush();
  assert.equal(h.attachments.length, 0); assert.equal(h.api.hasStreamingTask(request.id), true);
  assert.notEqual(observed.at(-1).status, 'cancelled');
  assert.equal(h.messages.filter(message => message.action === 'cancel').length, 1);
  assert.equal(JSON.parse(h.storage.get('dokitool-downloads-v1'))[0].cancelRequested, true);
  cancelPort.postMessage({ snapshot: admittedState('waiting', 3, { status: 'cancelled' }) });
  await cancelled;
  assert.equal(h.attachments.length, 0); assert.equal(observed.at(-1).status, 'cancelled');
});

test('refresh preserves unconfirmed cancellation intent and reissues cancel without claiming a ready attachment', async t => {
  let cancelPort;
  const h = await harness(t, (message, port) => {
    if (message.action === 'ping') return admissionPing;
    if (message.action === 'query') return { snapshots: [admittedState('ready', 2)] };
    if (message.action === 'cancel') { cancelPort = port; return undefined; }
  });
  const { url, ...last } = admittedState('waiting', 1);
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: request.id, token: 'a'.repeat(32), filename: request.filename, savedAt: Date.now(), last, cancelRequested: true }]));
  const observed = [];
  const restoration = h.api.reconnectStreaming(snapshot => observed.push(snapshot));
  await flush();
  assert.equal(h.attachments.length, 0);
  assert.equal(h.messages.some(message => message.action === 'start'), false);
  const cancellations = h.messages.filter(message => message.action === 'cancel');
  assert.equal(cancellations.length, 1);
  assert.equal(cancellations[0].id, request.id); assert.equal(cancellations[0].token, 'a'.repeat(32));
  assert.equal(observed.at(-1).observation, 'unknown', 'a ready query cannot confirm the outstanding cancellation');
  assert.notEqual(observed.at(-1).status, 'cancelled');
  assert.equal(h.api.hasStreamingTask(request.id), true);
  h.update(admittedState('ready', 3)); await flush();
  assert.equal(h.attachments.length, 0); assert.equal(observed.at(-1).observation, 'unknown', 'a later ready push cannot clear cancellation uncertainty');
  cancelPort.postMessage({ snapshot: admittedState('waiting', 4, { status: 'cancelled' }) });
  await restoration; await flush();
  assert.equal(observed.at(-1).status, 'cancelled'); assert.equal(observed.at(-1).observation, undefined);
  assert.equal(h.api.hasStreamingTask(request.id), false); assert.equal(h.attachments.length, 0);
});
