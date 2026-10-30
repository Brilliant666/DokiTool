import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformWithEsbuild } from 'vite';

const source = await readFile(new URL('../public/downloads/worker.js', import.meta.url), 'utf8');
const origin = 'https://snap.example.test';
const token = 'a'.repeat(32);
const id = number => `task000000000000${number}`;
const bytes = [new Uint8Array([0, 0, 0, 8]), new Uint8Array([102, 116, 121, 112])];

function harness(fetcher) {
  const events = new Map(), timers = new Map(), updates = [], lifetime = [], clientLookups = [], deferredReplies = [];
  let nextTimer = 0;
  let now = 1_000_000;
  const clients = new Map([
    ['page', { id: 'page', url: origin + '/', postMessage: value => updates.push(value.snapshot) }],
    ['reloaded', { id: 'reloaded', url: origin + '/', postMessage: value => updates.push(value.snapshot) }],
    ['foreign', { id: 'foreign', url: 'https://foreign.test/', postMessage() {} }],
  ]);
  const context = vm.createContext({
    self: { location: new URL(origin), clients: { get: async key => { clientLookups.push(key); return clients.get(key); } }, addEventListener: (key, handler) => events.set(key, handler) },
    fetch: fetcher, URL, Response, ReadableStream, AbortController, DOMException, TextDecoder,
    Date: class extends Date { static now() { return now; } },
    setTimeout(callback, delay) { const handle = ++nextTimer; timers.set(handle, { callback, delay }); return handle; },
    clearTimeout: handle => timers.delete(handle),
  });
  vm.runInContext(source, context);
  const send = (message, client = 'page', deferReply = false) => new Promise(resolve => {
    events.get('message')({ data: { protocol: 1, ...message }, source: { id: client }, ports: [{ postMessage: value => deferReply ? deferredReplies.push(() => resolve(value)) : resolve(value) }], waitUntil: promise => lifetime.push(promise) });
  });
  const start = async (number, routes = [], extra = {}) => send({ action: 'start', token, request: { id: id(number), filename: '作品_P1.mp4', url: 'https://cdn.test/primary.mp4', routes, ...extra } });
  const admit = async number => send({ action: 'start', admission: true, token, request: { id: id(number), filename: '作品_P1.mp4', url: 'https://cdn.test/primary.mp4' } });
  const download = async (number, suppliedToken = token, signal) => {
    let response;
    events.get('fetch')({ request: new Request(`${origin}/downloads/file/${id(number)}/${suppliedToken}`, { signal }), respondWith: value => { response = value; }, waitUntil: promise => lifetime.push(promise) });
    return await response;
  };
  const query = async (number, client = 'page') => (await send({ action: 'query', tasks: [{ id: id(number), token }] }, client)).snapshots[0];
  const cancel = number => send({ action: 'cancel', id: id(number), token });
  return { start, admit, send, download, query, cancel, timers, updates, clientLookups,
    get transferTimers() { return [...timers.values()].filter(timer => timer.delay < 600_000); },
    closeClient: key => clients.delete(key), releaseReplies: () => deferredReplies.splice(0).forEach(reply => reply()),
    eventsSettled: () => Promise.all(lifetime), advance: ms => { now += ms; }, async close() {
    for (let number = 1; number <= 5; number++) await cancel(number);
    await Promise.all(lifetime);
  } };
}

function media(parts = bytes, length = 8, onPull = () => {}) {
  let index = 0;
  return new Response(new ReadableStream({ pull(controller) { onPull(); index < parts.length ? controller.enqueue(parts[index++]) : controller.close(); } }, { highWaterMark: 0 }), {
    headers: { 'content-type': 'video/mp4', 'content-length': String(length) },
  });
}

test('streams with backpressure, UTF-8 filename and truthful completion', async t => {
  let pulls = 0;
  const h = harness(async () => media(bytes, 8, () => pulls++)); t.after(() => h.close());
  const reply = await h.start(1);
  assert.match(reply.downloadUrl, /downloads\/file\/task/);
  const response = await h.download(1);
  assert.match(response.headers.get('content-disposition'), /filename\*=UTF-8''%E4%BD%9C%E5%93%81_P1.mp4/);
  assert.equal(pulls, 1, 'only a bounded first chunk is read before the browser pulls');
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 45_000).length, 0, 'backpressure must not start an upstream idle timeout');
  const reader = response.body.getReader();
  assert.deepEqual((await reader.read()).value, bytes[0]);
  assert.equal(pulls, 1);
  assert.deepEqual((await reader.read()).value, bytes[1]);
  assert.equal((await reader.read()).done, true);
  assert.equal((await h.query(1)).status, 'completed');
  assert.equal((await h.query(1)).loaded, 8);
});

test('setup events settle before a stream that remains active for six minutes', { timeout: 1500 }, async t => {
  const h = harness(async () => media()); t.after(() => h.close());
  await h.start(1);
  await h.eventsSettled();
  assert.equal((await h.query(1)).status, 'queued');
  const response = await h.download(1);
  await h.eventsSettled();
  assert.equal(h.timers.size, 0, 'no setup deadline may remain on the active response');
  h.advance(6 * 60_000);
  assert.equal((await h.query(1)).status, 'downloading');
  assert.equal((await response.arrayBuffer()).byteLength, 8);
  const finished = await h.query(1);
  assert.equal(finished.status, 'completed');
  assert.equal(finished.transferElapsed, 360);
});

test('requires a same-origin page and ownership token, including after refresh', async t => {
  const h = harness(async () => media()); t.after(() => h.close());
  assert.match((await h.send({ action: 'ping' }, 'foreign')).error, /校验/);
  await h.start(1);
  assert.equal((await h.download(1, 'b'.repeat(32))).status, 404);
  assert.match((await h.send({ action: 'cancel', id: id(1), token: 'b'.repeat(32) })).error, /无访问权限/);
  assert.equal((await h.query(1, 'reloaded')).status, 'queued');
  const cancelled = await h.send({ action: 'cancel', id: id(1), token }, 'reloaded');
  assert.equal(cancelled.snapshot.status, 'cancelled');
});

test('rejects truncated transfers and never splices a backup after delivery', async t => {
  const fetched = [];
  const h = harness(async url => { fetched.push(url); return media([bytes[0]], 8); }); t.after(() => h.close());
  await h.start(1, ['https://cdn.test/backup.mp4']);
  const response = await h.download(1);
  await assert.rejects(response.arrayBuffer(), /不完整/);
  assert.equal((await h.query(1)).status, 'failed');
  assert.equal(fetched.length, 1);
});

test('can replace a failed route before returning the attachment', async t => {
  const fetched = [];
  const h = harness(async url => { fetched.push(url); return fetched.length === 1 ? new Response('denied', { status: 403 }) : media(); }); t.after(() => h.close());
  await h.start(1, ['https://cdn.test/backup.mp4']);
  const response = await h.download(1);
  assert.equal((await response.arrayBuffer()).byteLength, 8);
  assert.equal((await h.query(1)).url, 'https://cdn.test/backup.mp4');
  assert.equal(fetched.length, 2);
});

test('a browser cancel releases the worker-owned transfer', async t => {
  const h = harness(async () => media()); t.after(() => h.close());
  await h.start(1);
  const response = await h.download(1);
  await response.body.cancel();
  assert.equal((await h.query(1)).status, 'cancelled');
  assert.equal((await h.download(1)).status, 404, 'the attachment URL cannot start a duplicate transfer');
});

test('aborted attachment requests release occupied slots even without a stream cancel callback', async t => {
  const upstreamSignals = [];
  const h = harness(async (_url, options) => { upstreamSignals.push(options.signal); return media(); }); t.after(() => h.close());
  for (const number of [1, 2, 3]) await h.start(number);
  const controllers = [new AbortController(), new AbortController()];
  const first = await h.download(1, token, controllers[0].signal);
  const second = await h.download(2, token, controllers[1].signal);
  const thirdPromise = h.download(3);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await h.query(3)).status, 'queued');
  assert.equal(upstreamSignals.length, 2);
  controllers.forEach(controller => controller.abort());
  const third = await thirdPromise;
  assert.equal((await h.query(1)).status, 'cancelled');
  assert.equal((await h.query(2)).status, 'cancelled');
  assert.equal((await h.query(3)).status, 'downloading');
  assert.ok(upstreamSignals[0].aborted && upstreamSignals[1].aborted);
  assert.equal(upstreamSignals.length, 3);
  await assert.rejects(first.arrayBuffer(), /取消/);
  await assert.rejects(second.arrayBuffer(), /取消/);
  await third.body.cancel();
  assert.equal(h.transferTimers.length, 0);
});

test('a queued or already-aborted attachment never starts an upstream request', async t => {
  let fetched = 0;
  const h = harness(async () => { fetched++; return media(); }); t.after(() => h.close());
  for (const number of [1, 2, 3, 4]) await h.start(number);
  const first = await h.download(1), second = await h.download(2);
  const queued = new AbortController();
  const third = h.download(3, token, queued.signal);
  queued.abort();
  assert.equal((await third).status, 502);
  const aborted = new AbortController(); aborted.abort();
  assert.equal((await h.download(4, token, aborted.signal)).status, 502);
  assert.equal((await h.query(3)).status, 'cancelled');
  assert.equal((await h.query(4)).status, 'cancelled');
  await first.body.cancel(); await second.body.cancel();
  assert.equal(fetched, 2);
});

test('backpressure is reported as stalled without cancelling a paused download', async t => {
  const h = harness(async () => media()); t.after(() => h.close());
  await h.start(1);
  const reader = (await h.download(1)).body.getReader();
  await reader.read();
  h.advance(20_000);
  const paused = await h.query(1);
  assert.equal(paused.status, 'downloading');
  assert.equal(paused.observation, 'stalled');
  assert.equal(paused.loaded, 4);
  assert.equal(paused.speed, 0);
  assert.equal(h.timers.size, 0, 'downstream backpressure must not start an upstream timeout');
  await reader.read();
  assert.equal((await h.query(1)).observation, undefined);
  assert.equal((await h.query(1)).status, 'downloading', 'known length alone is not proof of EOF');
  assert.equal((await reader.read()).done, true);
  assert.equal((await h.query(1)).status, 'completed');
});

test('at most two complete-file transfers run, queued tasks are cancellable', async t => {
  let fetched = 0;
  const h = harness(async () => { fetched++; return media(); }); t.after(() => h.close());
  await h.start(1); await h.start(2); await h.start(3);
  const first = await h.download(1), second = await h.download(2);
  const thirdPromise = h.download(3);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetched, 2);
  assert.equal((await h.query(3)).status, 'queued');
  await first.arrayBuffer();
  const third = await thirdPromise;
  assert.equal(fetched, 3);
  await third.body.cancel(); await second.body.cancel();
});

test('queue expiry fails only the waiting task without fetching it or blocking later work', { timeout: 1500 }, async t => {
  let fetched = 0;
  const h = harness(async () => { fetched++; return media(); }); t.after(() => h.close());
  await h.start(1); await h.start(2); await h.start(3);
  const first = await h.download(1), second = await h.download(2);
  const waiting = h.download(3);
  await new Promise(resolve => setImmediate(resolve));
  const deadline = [...h.timers.values()].find(timer => timer.delay === 120_000);
  assert.ok(deadline);
  h.advance(120_000); deadline.callback();
  assert.equal((await waiting).status, 502);
  const expired = await h.query(3);
  assert.equal(expired.status, 'failed');
  assert.match(expired.error, /等待下载空位超过 2 分钟/);
  assert.equal(fetched, 2, 'an expired queued attachment must never fetch its source');
  assert.equal((await h.query(1)).status, 'downloading');
  assert.equal((await h.query(2)).status, 'downloading');
  assert.equal((await first.arrayBuffer()).byteLength, 8);
  await h.start(4);
  assert.equal((await (await h.download(4)).arrayBuffer()).byteLength, 8);
  assert.equal(fetched, 3, 'the expired task must not re-enter the released slot');
  assert.equal((await second.arrayBuffer()).byteLength, 8);
  assert.equal(h.transferTimers.length, 0);
});

test('one response deadline covers all preparation routes and aborts without another retry', { timeout: 1500 }, async t => {
  const attempts = [];
  const h = harness(async (url, options) => {
    attempts.push({ url, signal: options.signal });
    return url.endsWith('/next.mp4') ? media() : new Promise(() => {});
  }); t.after(() => h.close());
  await h.start(1, ['https://cdn.test/backup.mp4', 'https://cdn.test/last.mp4']);
  const preparing = h.download(1);
  await new Promise(resolve => setImmediate(resolve));
  const deadline = [...h.timers.values()].find(timer => timer.delay === 120_000);
  assert.ok(deadline);
  // Two source attempts time out individually; their retries must not reset the
  // overall header deadline to another two minutes.
  for (let attempt = 0; attempt < 2; attempt++) {
    h.advance(45_000);
    const idle = [...h.timers.values()].find(timer => timer.delay === 45_000);
    assert.ok(idle); idle.callback();
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(attempts.length, 3);
  assert.ok(attempts[0].signal.aborted && attempts[1].signal.aborted);
  assert.equal([...h.timers.values()].find(timer => timer.delay === 120_000), deadline);
  h.advance(30_000); deadline.callback();
  assert.equal((await preparing).status, 502);
  const failed = await h.query(1);
  assert.equal(failed.status, 'failed', 'deadline expiry is not user cancellation');
  assert.match(failed.error, /下载准备超过 2 分钟（含排队）/);
  assert.equal(failed.elapsed, 120);
  assert.ok(attempts.every(attempt => attempt.signal.aborted));
  assert.equal(attempts.length, 3, 'expiry must not repeat a source or silently start another route');
  assert.equal(h.transferTimers.length, 0);
  await h.start(2, [], { url: 'https://cdn.test/next.mp4' });
  assert.equal((await (await h.download(2)).arrayBuffer()).byteLength, 8);
  assert.equal((await h.query(2)).status, 'completed', 'failed preparation releases its slot');
});

test('only pending upstream reads time out; a failed stream never starts another route', async t => {
  let read = 0, fetched = 0;
  const h = harness(async () => {
    fetched++;
    return new Response(new ReadableStream({ pull(controller) { if (!read++) controller.enqueue(bytes[0]); else return new Promise(() => {}); } }, { highWaterMark: 0 }), { headers: { 'content-type': 'video/mp4' } });
  }); t.after(() => h.close());
  await h.start(1, ['https://cdn.test/backup.mp4']);
  const reader = (await h.download(1)).body.getReader();
  await reader.read();
  const pending = reader.read();
  await new Promise(resolve => setImmediate(resolve));
  h.advance(20_000);
  assert.equal((await h.query(1)).observation, undefined, 'an upstream wait is not a downstream pause');
  const timer = [...h.timers.values()].find(timer => timer.delay === 45_000);
  assert.ok(timer); timer.callback();
  await assert.rejects(pending, /45 秒/);
  assert.equal((await h.query(1)).status, 'failed');
  assert.equal(fetched, 1);
});

test('expired claim and unknown task are not reported as completed', async t => {
  const h = harness(async () => media()); t.after(() => h.close());
  await h.start(1);
  [...h.timers.values()].find(timer => timer.delay === 60_000).callback();
  assert.equal((await h.query(1)).status, 'failed');
  assert.equal((await h.download(1)).status, 404);
  assert.equal((await h.send({ action: 'query', tasks: [{ id: id(5), token }] })).snapshots.length, 0);
});

test('partial responses never count as a complete file', async t => {
  const h = harness(async () => new Response(bytes[0], { status: 206, headers: { 'content-type': 'video/mp4', 'content-length': '4', 'content-range': 'bytes 0-3/8' } }));
  t.after(() => h.close());
  await h.start(1);
  assert.equal((await h.download(1)).status, 502);
  assert.equal((await h.query(1)).status, 'failed');
});

test('even HTTP 200 with Content-Range is rejected', async t => {
  const h = harness(async () => new Response(bytes[0], { headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-3/8' } }));
  t.after(() => h.close());
  await h.start(1);
  assert.equal((await h.download(1)).status, 502);
  assert.equal((await h.query(1)).status, 'failed');
});

test('finished elapsed time and average speed remain stable across later queries', async t => {
  const h = harness(async () => media()); t.after(() => h.close());
  await h.start(1);
  const response = await h.download(1);
  h.advance(2000);
  await response.arrayBuffer();
  const finished = await h.query(1);
  h.advance(9000);
  const later = await h.query(1);
  assert.equal(finished.elapsed, 2); assert.equal(finished.averageSpeed, 4);
  assert.equal(later.elapsed, finished.elapsed); assert.equal(later.averageSpeed, finished.averageSpeed);
});

test('worker reports its build and separates total elapsed time from transfer speed', async t => {
  const h = harness(async () => media()); t.after(() => h.close());
  const ping = await h.send({ action: 'ping' });
  assert.equal(ping.workerBuild, 'downloads-20261030.4');
  assert.equal(ping.capabilities.admission, true);
  await h.start(1, [], { startedAt: 995_000 });
  assert.equal((await h.query(1)).elapsed, 5);
  assert.equal((await h.query(1)).transferElapsed, 0);
  const response = await h.download(1);
  assert.equal(response.headers.get('x-dokitool-worker-build'), ping.workerBuild);
  h.advance(2000);
  await response.arrayBuffer();
  const finished = await h.query(1);
  assert.equal(finished.elapsed, 7);
  assert.equal(finished.transferElapsed, 2);
  assert.equal(finished.averageSpeed, 4);
  assert.equal(finished.workerBuild, ping.workerBuild);
  h.advance(5000);
  assert.equal((await h.query(1)).transferElapsed, 2);
  assert.equal((await h.send({ action: 'query', tasks: [] })).workerBuild, ping.workerBuild);
});

test('short delivery bursts are smoothed without delaying reads and idle speed becomes zero', async t => {
  let pulls = 0;
  const h = harness(async () => media([bytes[0], new Uint8Array(40), bytes[1]], 48, () => pulls++));
  t.after(() => h.close());
  await h.start(1);
  const reader = (await h.download(1)).body.getReader();
  h.advance(1000);
  await reader.read();
  h.advance(300);
  await reader.read();
  const burst = await h.query(1);
  assert.equal(burst.loaded, 44);
  assert.equal(pulls, 2, 'progress smoothing does not schedule or delay upstream reads');
  assert.ok(burst.speed > 0 && burst.speed < 40 / 0.3, 'a short burst is averaged over recent delivery history');
  h.advance(4000);
  assert.equal((await h.query(1)).speed, 0);
  await reader.read();
  await reader.read();
});

test('admission is negotiated while legacy clients retain their attachment URL', async t => {
  let fetched = 0;
  const h = harness(async () => { fetched++; return media(); }); t.after(() => h.close());
  const ping = await h.send({ action: 'ping' });
  assert.equal(ping.protocol, 1); assert.equal(ping.capabilities.admission, true);
  const modern = await h.admit(1), legacy = await h.start(2);
  assert.equal(modern.downloadUrl, undefined); assert.equal(modern.snapshot.delivery, 'ready');
  assert.match(legacy.downloadUrl, /\/downloads\/file\//); assert.equal(legacy.snapshot.delivery, undefined);
  assert.equal(fetched, 0, 'admission reserves capacity but never fetches source bytes');
  const first = await h.download(1), second = await h.download(2);
  assert.equal((await h.query(1)).delivery, 'claimed'); assert.equal(fetched, 2);
  await first.arrayBuffer(); await second.arrayBuffer();
});

test('admission can wait beyond five minutes without opening an attachment or starting a media GET', async t => {
  let fetched = 0;
  const h = harness(async () => { fetched++; return media(); }); t.after(() => h.close());
  await h.admit(1); await h.admit(2);
  const first = await h.download(1), second = await h.download(2);
  const waiting = await h.admit(3);
  assert.equal(waiting.snapshot.delivery, 'waiting'); assert.equal(waiting.downloadUrl, undefined);
  assert.equal((await h.download(3)).status, 409, 'a premature attachment cannot claim an unadmitted task');
  assert.equal(h.timers.size, 0, 'only admitted, unclaimed tasks have a claim deadline');
  await h.eventsSettled();
  h.advance(6 * 60_000);
  assert.equal((await h.query(3)).delivery, 'waiting'); assert.equal(fetched, 2);
  await first.arrayBuffer();
  assert.equal((await h.query(3)).delivery, 'ready'); assert.equal(fetched, 2);
  assert.equal([...h.timers.values()].filter(timer => timer.delay === 60_000).length, 1);
  const third = await h.download(3);
  assert.equal(fetched, 3); assert.equal((await h.query(3)).delivery, 'claimed');
  await third.arrayBuffer(); await second.arrayBuffer();
});

test('cancelling waiting and ready admissions releases capacity without fetching media', async t => {
  let fetched = 0;
  const h = harness(async () => { fetched++; return media(); }); t.after(() => h.close());
  await h.admit(1); await h.admit(2); await h.admit(3);
  assert.equal((await h.cancel(3)).snapshot.status, 'cancelled');
  assert.equal((await h.cancel(1)).snapshot.status, 'cancelled');
  assert.equal((await h.admit(4)).snapshot.delivery, 'ready');
  assert.equal((await h.query(3)).status, 'cancelled');
  assert.equal((await h.download(3)).status, 404);
  assert.equal(fetched, 0);
});

test('an admitted task abandoned before claim expires and admits the next waiter', async t => {
  let fetched = 0;
  const h = harness(async () => { fetched++; return media(); }); t.after(() => h.close());
  await h.admit(1); await h.admit(2); await h.admit(3);
  const deadline = [...h.timers.values()].find(timer => timer.delay === 60_000);
  h.advance(60_000); deadline.callback();
  const abandoned = await h.query(1);
  assert.equal(abandoned.status, 'failed'); assert.match(abandoned.error, /浏览器未接收/);
  assert.equal((await h.query(3)).delivery, 'ready'); assert.equal(fetched, 0);
  assert.equal((await h.download(1)).status, 404);
});

test('ready publication may precede START acknowledgement and carries an earlier revision', async t => {
  let fetched = 0;
  const h = harness(async () => { fetched++; return media(); }); t.after(() => h.close());
  const acknowledgement = h.send({ action: 'start', admission: true, token,
    request: { id: id(1), filename: '作品.mp4', url: 'https://cdn.test/primary.mp4' } }, 'page', true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.updates.length, 1); assert.equal(h.updates[0].delivery, 'ready');
  assert.equal(fetched, 0);
  h.releaseReplies();
  const reply = await acknowledgement;
  assert.equal(reply.snapshot.delivery, 'ready'); assert.ok(reply.snapshot.revision > h.updates[0].revision);
  assert.equal(reply.downloadUrl, undefined);
});

test('cancellation before the START acknowledgement leaves a newer terminal snapshot and no media request', async t => {
  let fetched = 0;
  const h = harness(async () => { fetched++; return media(); }); t.after(() => h.close());
  const acknowledgement = h.send({ action: 'start', admission: true, token,
    request: { id: id(1), filename: '作品.mp4', url: 'https://cdn.test/primary.mp4' } }, 'page', true);
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = (await h.cancel(1)).snapshot;
  h.releaseReplies();
  const oldReply = await acknowledgement;
  assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.revision > oldReply.snapshot.revision);
  assert.deepEqual(await h.query(1), cancelled);
  assert.equal((await h.download(1)).status, 404); assert.equal(fetched, 0);
  assert.equal((await h.admit(2)).snapshot.delivery, 'ready', 'cancellation released the reserved slot');
});

test('live revisions advance and terminal history keeps the exact final revision and timings', async t => {
  const h = harness(async () => media()); t.after(() => h.close());
  const start = await h.admit(1), queued = await h.query(1);
  assert.ok(queued.revision > start.snapshot.revision);
  const response = await h.download(1), active = await h.query(1);
  assert.ok(active.revision > queued.revision);
  h.advance(2000); await response.arrayBuffer();
  const finished = await h.query(1);
  assert.equal(finished.status, 'completed'); assert.ok(finished.revision > active.revision);
  h.advance(9000);
  const later = await h.query(1);
  assert.deepEqual(later, finished);
  assert.deepEqual((await h.cancel(1)).snapshot, finished);
  assert.deepEqual((await h.admit(1)).snapshot, finished);
});

test('terminal history does not consume pending capacity, keeps only 100 records and expires automatically', async t => {
  const h = harness(async () => media()); t.after(() => h.close());
  for (let number = 1; number <= 101; number++) {
    assert.equal((await h.start(number)).error, undefined);
    assert.equal((await h.cancel(number)).snapshot.status, 'cancelled');
  }
  assert.equal(await h.query(1), undefined, 'the oldest terminal record is evicted');
  assert.equal((await h.query(2)).status, 'cancelled');
  assert.equal((await h.query(101)).status, 'cancelled');
  assert.equal((await h.admit(102)).snapshot.delivery, 'ready', '100 historical records do not occupy active capacity');
  await h.cancel(102);
  assert.equal(h.timers.size, 1, 'history shares one expiration timer');
  h.advance(600_000);
  [...h.timers.values()][0].callback();
  assert.equal(h.timers.size, 0, 'expiration requires no subsequent page query');
  assert.equal(await h.query(102), undefined);
});

test('pending capacity is bounded independently from history and forget requires ownership and a terminal task', async t => {
  const h = harness(async () => media()); t.after(() => h.close());
  for (let number = 1; number <= 100; number++) assert.equal((await h.admit(number)).error, undefined);
  assert.match((await h.admit(101)).error, /任务过多/);
  assert.match((await h.send({ action: 'forget', id: id(1) })).error, /无效/);
  assert.match((await h.send({ action: 'forget', id: id(1), token: 'b'.repeat(32) })).error, /无访问权限/);
  assert.match((await h.send({ action: 'forget', id: id(1), token })).error, /先停止下载/);
  assert.equal((await h.query(1)).delivery, 'ready');
  await h.cancel(1);
  assert.match((await h.send({ action: 'forget', id: id(1), token: 'b'.repeat(32) })).error, /无访问权限/);
  assert.equal((await h.send({ action: 'forget', id: id(1), token })).forgotten, true);
  assert.equal(await h.query(1), undefined);
  assert.equal((await h.admit(101)).error, undefined);
});

test('progress removes subscribers whose browsing context has disappeared', async t => {
  const h = harness(async () => media([bytes[0], bytes[1], bytes[0]], 12)); t.after(() => h.close());
  await h.admit(1);
  const reader = (await h.download(1)).body.getReader();
  await h.query(1, 'reloaded'); h.closeClient('page');
  h.clientLookups.length = 0;
  h.advance(301); await reader.read(); await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.clientLookups.includes('page'));
  h.clientLookups.length = 0;
  h.advance(301); await reader.read(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.clientLookups.includes('page'), false);
  assert.ok(h.clientLookups.includes('reloaded'));
  await reader.cancel();
});

async function clientHarness(t, respond) {
  const types = await transformWithEsbuild(await readFile(new URL('../src/downloads/types.ts', import.meta.url), 'utf8'), 'types.ts', { loader: 'ts', format: 'esm' });
  const typesUrl = 'data:text/javascript;base64,' + Buffer.from(types.code).toString('base64');
  const bridge = await transformWithEsbuild(await readFile(new URL('../src/downloads/bridge.ts', import.meta.url), 'utf8'), 'bridge.ts', { loader: 'ts', format: 'esm' });
  const bridgeUrl = 'data:text/javascript;base64,' + Buffer.from(bridge.code + `\n// ${Math.random()}`).toString('base64');
  const session = await transformWithEsbuild(await readFile(new URL('../src/downloads/session.ts', import.meta.url), 'utf8'), 'session.ts', { loader: 'ts', format: 'esm' });
  const sessionCode = session.code.replace('"./types"', JSON.stringify(typesUrl)).replace('"./bridge"', JSON.stringify(bridgeUrl));
  const sessionUrl = 'data:text/javascript;base64,' + Buffer.from(sessionCode + `\n// ${Math.random()}`).toString('base64');
  const client = await transformWithEsbuild(await readFile(new URL('../src/downloads/streaming.ts', import.meta.url), 'utf8'), 'streaming.ts', { loader: 'ts', format: 'esm' });
  const code = client.code.replace('"./types"', JSON.stringify(typesUrl)).replace('"./bridge"', JSON.stringify(bridgeUrl)).replace('"./session"', JSON.stringify(sessionUrl));
  const api = await import('data:text/javascript;base64,' + Buffer.from(code + `\n// ${Math.random()}`).toString('base64'));
  const originals = new Map(), storage = new Map(), messages = [], frames = [], timers = new Map();
  let listener, nextTimer = 0, registered = 0;
  const setGlobal = (name, value) => { originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  t.after(() => { for (const [name, descriptor] of originals) descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]; });
  const worker = {
    scriptURL: origin + '/downloads/worker.js', state: 'activated',
    postMessage(message, [port]) {
      messages.push(message);
      const reply = respond ? respond(message) : message.action === 'ping' ? { protocol: 1 } : undefined;
      if (reply !== undefined) port.postMessage(reply);
    },
  };
  const registration = { active: worker, scope: origin + '/downloads/' };
  const serviceWorker = { getRegistration: async () => registration, register: async () => { registered++; return registration; }, addEventListener: (_, handler) => { listener = handler; } };
  setGlobal('navigator', { serviceWorker }); setGlobal('location', new URL(origin)); setGlobal('isSecureContext', true);
  setGlobal('crypto', { randomUUID: () => '12345678-1234-1234-1234-123456789abc' });
  setGlobal('sessionStorage', { getItem: name => storage.get(name), setItem: (name, value) => storage.set(name, value) });
  setGlobal('MessageChannel', class {
    constructor() { this.port1 = { onmessage: null, close() {} }; this.port2 = { postMessage: data => queueMicrotask(() => this.port1.onmessage?.({ data })) }; }
  });
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
      if (frame.src !== '/downloads/bridge.html') return;
      frame.contentWindow = { location: new URL(frame.src, origin), navigator: { serviceWorker: { controller: worker } } };
      frame.contentDocument = { getElementById: name => name === 'dokitool-download-bridge' ? {} : null };
      queueMicrotask(() => frame.dispatch('load'));
    } },
  });
  setGlobal('setTimeout', (callback, delay) => { const handle = ++nextTimer; timers.set(handle, { callback, delay }); return handle; });
  setGlobal('clearTimeout', handle => timers.delete(handle));
  setGlobal('setInterval', (callback, delay) => { const handle = ++nextTimer; timers.set(handle, { callback, delay }); return handle; });
  setGlobal('clearInterval', handle => timers.delete(handle));
  return { api, worker, registration, serviceWorker, messages, frames, timers, storage, get registered() { return registered; },
    get attachments() { return frames.filter(frame => frame.src?.startsWith('/downloads/file/')); },
    get bridges() { return frames.filter(frame => frame.src === '/downloads/bridge.html'); },
    update: snapshot => listener({ source: worker, data: { channel: 'dokitool-download', protocol: 1, snapshot } }),
  };
}
const request = { id: id(1), url: 'https://cdn.test/primary.mp4', routes: [], filename: '作品_P1.mp4' };
const state = (status = 'queued') => ({ id: id(1), transport: 'browser_streaming', status, filename: request.filename, url: request.url, loaded: 0, total: 8, speed: 0, elapsed: 0, averageSpeed: 0 });
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

test('client permits Blob fallback only when capability fails before START', async t => {
  const h = await clientHarness(t);
  globalThis.isSecureContext = false;
  await assert.rejects(h.api.downloadStreaming(request, new AbortController().signal, () => {}), error => error.name === 'StreamingUnavailableError' && error.safeToFallback === true);
  assert.equal(h.messages.length, 0);
});

test('START acknowledgement timeout is ambiguous and must never permit Blob fallback', async t => {
  const h = await clientHarness(t);
  const task = h.api.downloadStreaming(request, new AbortController().signal, () => {});
  await flush();
  assert.ok(h.messages.some(message => message.action === 'start'));
  const timeout = [...h.timers.values()].find(timer => timer.delay === 8000);
  assert.ok(timeout); timeout.callback();
  await assert.rejects(task, error => !error.safeToFallback && /状态未知/.test(error.message));
  assert.equal(h.attachments.length, 0);
  assert.equal(h.bridges[0].removed, undefined, 'an ambiguous START must keep its bridge');
  const saved = h.storage.get('dokitool-downloads-v1');
  assert.ok(saved.includes(request.id)); assert.ok(!saved.includes('cdn.test'));
});

test('client starts one attachment and persists completion without the signed source URL', async t => {
  const h = await clientHarness(t, message => message.action === 'ping' ? { protocol: 1 } : message.action === 'start' ? {
    snapshot: state(), downloadUrl: `/downloads/file/${message.request.id}/${message.token}`,
  } : undefined);
  const observed = [];
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot.status));
  await flush();
  assert.equal(h.attachments.length, 1);
  h.update({ ...state('completed'), loaded: 8 });
  assert.equal((await task).status, 'completed');
  assert.deepEqual(observed, ['queued', 'completed']);
  const saved = h.storage.get('dokitool-downloads-v1');
  assert.match(saved, /completed/); assert.ok(!saved.includes('cdn.test'));
});

test('refresh queries an existing task, does not start a download, and can cancel it', async t => {
  const h = await clientHarness(t, message => message.action === 'ping' ? { protocol: 1 } : message.action === 'query' ? {
    snapshots: [state('downloading')],
  } : message.action === 'cancel' ? { snapshot: state('cancelled') } : undefined);
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: id(1), token, filename: request.filename, savedAt: Date.now() }]));
  const observed = [];
  const restored = await h.api.reconnectStreaming(snapshot => observed.push(snapshot));
  assert.equal(restored[0].status, 'downloading');
  assert.equal(h.attachments.length, 0); assert.equal(h.registered, 0);
  assert.ok(!h.messages.some(message => message.action === 'start'));
  await h.api.cancelStreaming(id(1));
  assert.deepEqual(observed.map(snapshot => snapshot.status), ['downloading', 'downloading', 'cancelled']);
  assert.equal(observed[1].observation, 'unknown', 'cancel intent remains unconfirmed until the Worker replies');
  assert.equal(observed[2].observation, undefined);
});

test('missing worker task restores interruption, rather than restarting or claiming completion', async t => {
  const h = await clientHarness(t, message => message.action === 'ping' ? { protocol: 1 } : message.action === 'query' ? { snapshots: [] } : undefined);
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: id(1), token, filename: request.filename, savedAt: Date.now() }]));
  const observed = [];
  const restored = await h.api.reconnectStreaming(snapshot => observed.push(snapshot));
  assert.equal(restored[0].status, 'interrupted'); assert.equal(observed.length, 1);
  assert.equal(h.attachments.length, 0);
  assert.ok(!h.messages.some(message => message.action === 'start'));
});

test('cancel acknowledgement timeout does not claim the worker stopped', async t => {
  const h = await clientHarness(t, message => message.action === 'ping' ? { protocol: 1 }
    : message.action === 'query' ? { snapshots: [state('downloading')] } : undefined);
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: id(1), token, filename: request.filename, savedAt: Date.now() }]));
  const observed = [];
  await h.api.reconnectStreaming(snapshot => observed.push(snapshot));
  const cancellation = h.api.cancelStreaming(id(1));
  const rejected = assert.rejects(cancellation, /状态未知/);
  await flush();
  const timeout = [...h.timers.values()].find(timer => timer.delay === 8000);
  assert.ok(timeout); timeout.callback();
  await rejected;
  assert.equal(observed.at(-1).status, 'downloading'); assert.equal(observed.at(-1).observation, 'unknown');
  assert.equal(h.api.hasStreamingTask(id(1)), true);
});

test('reconnect query failure still exposes an unknown card and keeps observing', async t => {
  let queryFails = true;
  const h = await clientHarness(t, message => message.action === 'ping' ? { protocol: 1 } : message.action === 'query' ? queryFails ? { error: 'temporary communication failure' } : { snapshots: [state('completed')] } : undefined);
  h.storage.set('dokitool-downloads-v1', JSON.stringify([{ id: id(1), token, filename: request.filename, savedAt: Date.now() }]));
  const observed = [];
  const initial = await h.api.reconnectStreaming(snapshot => observed.push(snapshot.status));
  assert.equal(initial[0].status, 'queued');
  assert.equal(initial[0].observation, 'unknown');
  assert.equal(h.api.hasStreamingTask(id(1)), true);
  queryFails = false;
  [...h.timers.values()].find(timer => timer.delay === 5000).callback();
  await flush();
  assert.deepEqual(observed, ['queued', 'completed']);
  assert.equal(h.api.hasStreamingTask(id(1)), false);
});

test('a transient query timeout does not reject or detach a running stream', async t => {
  let queryFails = true;
  const h = await clientHarness(t, message => message.action === 'ping' ? { protocol: 1 } : message.action === 'start' ? {
    snapshot: state(), downloadUrl: `/downloads/file/${message.request.id}/${message.token}`,
  } : message.action === 'query' && !queryFails ? { snapshots: [state('downloading')] } : undefined);
  const observed = [];
  let settled = false;
  const task = h.api.downloadStreaming(request, new AbortController().signal, snapshot => observed.push(snapshot.status));
  void task.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  [...h.timers.values()].find(timer => timer.delay === 5000).callback();
  await flush();
  [...h.timers.values()].find(timer => timer.delay === 8000).callback();
  await flush();
  assert.equal(settled, false); assert.equal(observed.at(-1), 'queued');
  assert.equal(h.attachments[0].removed, undefined);
  assert.equal(h.bridges[0].removed, undefined);
  queryFails = false;
  h.update({ ...state('completed'), loaded: 8 });
  assert.equal((await task).status, 'completed');
  assert.equal(observed.at(-1), 'completed');
});

test('registration lookup timeout is bounded but does not silently permit Blob fallback', async t => {
  const h = await clientHarness(t);
  h.serviceWorker.getRegistration = () => new Promise(() => {});
  const task = h.api.downloadStreaming(request, new AbortController().signal, () => {});
  await flush();
  assert.equal(h.api.hasStreamingTask(request.id), false);
  [...h.timers.values()].find(timer => timer.delay === 8000).callback();
  await assert.rejects(task, error => /查询或注册超时/.test(error.message) && error.safeToFallback !== true);
  assert.equal(h.messages.length, 0);
});

test('live cancellation acknowledgement failure reports unknown, not cancelled', async t => {
  const h = await clientHarness(t, message => message.action === 'ping' ? { protocol: 1 } : message.action === 'start' ? {
    snapshot: state(), downloadUrl: `/downloads/file/${message.request.id}/${message.token}`,
  } : undefined);
  const observed = [], controller = new AbortController();
  const task = h.api.downloadStreaming(request, controller.signal, snapshot => observed.push(snapshot.status));
  await flush();
  controller.abort();
  await flush();
  [...h.timers.values()].find(timer => timer.delay === 8000).callback();
  await assert.rejects(task, error => error.name === 'StreamingStateUnknownError' && !error.safeToFallback);
  assert.equal(observed.at(-1), 'queued');
  assert.equal(h.api.hasStreamingTask(request.id), true);
  h.update(state('cancelled'));
  assert.equal(observed.at(-1), 'cancelled');
  assert.equal(h.api.hasStreamingTask(request.id), false);
});
