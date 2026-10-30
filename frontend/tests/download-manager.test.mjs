import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let createDownloadManager, StreamingUnavailableError;
before(async () => {
  const result = await build({ stdin: {
    contents: 'export { createDownloadManager } from "./src/downloads/manager"; export { StreamingUnavailableError } from "./src/downloads/types";',
    resolveDir: process.cwd(), loader: 'ts',
  }, bundle: true, write: false, platform: 'browser', format: 'esm' });
  ({ createDownloadManager, StreamingUnavailableError } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`));
});

const request = (id = 'one') => ({ id, url: 'https://media.test/video.mp4', routes: [], filename: '作品.mp4' });
const done = (input, transport = 'browser_streaming') => ({ ...input, transport, status: 'completed', loaded: 4, total: 4, speed: 0, elapsed: 1, averageSpeed: 4 });
function harness(overrides = {}) {
  const calls = [];
  const manager = createDownloadManager({
    probeNative: async () => { calls.push('probe'); return null; },
    handoffNative: () => calls.push('native'),
    downloadStreaming: async input => { calls.push('sw'); return done(input); },
    downloadBlob: async input => { calls.push('blob'); return done(input, 'browser_blob'); },
    ...overrides,
  });
  return { manager, calls };
}

test('a verified attachment is handed off without starting SW or Blob', async () => {
  const { manager, calls } = harness({ probeNative: async () => ({ url: request().url, filename: '附件.mp4' }) });
  const result = await manager.run(request(), new AbortController().signal, () => {});
  assert.deepEqual(calls, ['native']);
  assert.equal(result.status, 'handed-off');
  assert.equal(result.filename, '附件.mp4');
});

test('unknown native eligibility chooses streaming', async () => {
  const { manager, calls } = harness();
  await manager.run(request(), new AbortController().signal, () => {});
  assert.deepEqual(calls, ['probe', 'sw']);
});

test('the same-attempt complete-response probe avoids a second GET for both attachment and inline media', async () => {
  for (const attachment of [null, { url: request().url, filename: '附件.mp4' }]) {
    const { manager, calls } = harness();
    await manager.run({ ...request(), probe: { url: request().url, attachment } }, new AbortController().signal, () => {});
    assert.deepEqual(calls, attachment ? ['native'] : ['sw']);
  }
});

test('metadata from a different URL never skips the real native check', async () => {
  const { manager, calls } = harness();
  await manager.run({ ...request(), probe: { url: 'https://other.test/video.mp4', attachment: null } }, new AbortController().signal, () => {});
  assert.deepEqual(calls, ['probe', 'sw']);
});

test('the original click time reaches the transport and includes preparation in total elapsed time', async () => {
  const startedAt = Date.now() - 5000, updates = [];
  const { manager } = harness({ downloadStreaming: async input => {
    assert.equal(input.startedAt, startedAt); return done(input);
  } });
  await manager.run({ ...request(), startedAt }, new AbortController().signal, value => updates.push(value));
  assert.ok(updates[0].elapsed >= 5);
});

test('only explicit pre-start capability failure permits Blob', async () => {
  const { manager, calls } = harness({ downloadStreaming: async () => { throw new StreamingUnavailableError('unsupported'); } });
  assert.equal((await manager.run(request(), new AbortController().signal, () => {})).transport, 'browser_blob');
  assert.deepEqual(calls, ['probe', 'blob']);
});

test('CORS, source failures and lost START acknowledgements never start Blob', async () => {
  for (const error of [new TypeError('Failed to fetch'), new Error('HTTP 403'), Object.assign(new Error('unknown START'), { name: 'StreamingStateUnknownError' })]) {
    const { manager, calls } = harness({ downloadStreaming: async () => { throw error; } });
    await assert.rejects(manager.run(request(), new AbortController().signal, () => {}), err => err === error);
    assert.ok(!calls.includes('blob'));
  }
});

for (const message of ['下载连接页面无效（404）', '下载连接页面加载超时', '下载服务版本不兼容', '下载服务注册失败']) {
  test(`an operational SW failure cannot silently choose Blob: ${message}`, async () => {
    const failure = new Error(message), observed = [];
    const { manager, calls } = harness({ downloadStreaming: async () => { throw failure; } });
    await assert.rejects(manager.run(request(), new AbortController().signal, snapshot => observed.push(snapshot)), error => error === failure);
    assert.deepEqual(calls, ['probe']);
    assert.equal(observed.at(-1).status, 'failed');
    assert.equal(observed.at(-1).error, message);
    assert.equal(observed.some(snapshot => snapshot.transport === 'browser_blob'), false);
  });
}

test('two preparations run, cancelling a queued task never probes or transfers it', async () => {
  const probed = [], release = [];
  const { manager } = harness({ probeNative: input => { probed.push(input.id); return new Promise(resolve => release.push(resolve)); } });
  const first = manager.run(request('first'), new AbortController().signal, () => {});
  const second = manager.run(request('second'), new AbortController().signal, () => {});
  const controller = new AbortController();
  const third = manager.run(request('third'), controller.signal, () => {});
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(probed, ['first', 'second']);
  controller.abort();
  await assert.rejects(third, { name: 'AbortError' });
  release.forEach(resolve => resolve(null));
  await Promise.all([first, second]);
  assert.deepEqual(probed, ['first', 'second']);
});

test('cancellation during eligibility probing cannot start a transfer afterwards', async () => {
  let finish;
  const controller = new AbortController();
  const { manager, calls } = harness({ probeNative: () => new Promise(resolve => { finish = resolve; }) });
  const running = manager.run(request(), controller.signal, () => {});
  await Promise.resolve(); await Promise.resolve();
  controller.abort(); finish(null);
  await assert.rejects(running, { name: 'AbortError' });
  assert.deepEqual(calls, []);
});

test('unconfirmed cancellation retains unknown state rather than claiming cancelled', async () => {
  const controller = new AbortController(), states = [];
  const error = Object.assign(new Error('cancel reply lost'), { name: 'StreamingStateUnknownError' });
  const { manager, calls } = harness({ downloadStreaming: async (input, _signal, observe) => {
    observe({ ...done(input), status: 'interrupted' }); controller.abort(); throw error;
  } });
  await assert.rejects(manager.run(request(), controller.signal, state => states.push(state.status)), err => err === error);
  assert.equal(states.at(-1), 'interrupted');
  assert.ok(!calls.includes('blob'));
});
