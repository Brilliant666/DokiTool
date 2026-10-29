import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, transformWithEsbuild } from 'vite';
import { parse, compileScript } from '@vue/compiler-sfc';
import { ref, h, createSSRApp, createRenderer, nextTick } from 'vue';
import { renderToString } from '@vue/server-renderer';
import JSZip from 'jszip';

let vite, downloads, ResultSection, HeroSection, platforms;
let clicked, blobs, fetched;
const originals = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
before(async () => {
  vite = await createServer({ server: { middlewareMode: true, ws: false, hmr: false, watch: null }, appType: 'custom' });
  downloads = await vite.ssrLoadModule('/src/composables/useMediaDownload.ts');
  ResultSection = (await vite.ssrLoadModule('/src/components/ResultSection.vue')).default;
  HeroSection = (await vite.ssrLoadModule('/src/components/HeroSection.vue')).default;
  platforms = await vite.ssrLoadModule('/src/utils/platforms.ts');
  globalThis.window = { setTimeout, clearTimeout };
  globalThis.document = { body: { appendChild() {}, style: {} }, createElement() { return { click() { clicked.push({ href: this.href, filename: this.download }); }, remove() {} }; } };
  URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test-${blobs.length}`; };
  URL.revokeObjectURL = () => {};
});
beforeEach(() => {
  clicked = []; blobs = []; fetched = [];
  globalThis.fetch = async (url) => { fetched.push(url); return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4', 'content-length': '4' } }); };
});
after(async () => {
  Object.assign(globalThis, { fetch: originals.fetch, document: originals.document, window: originals.window });
  URL.createObjectURL = originals.createObjectURL; URL.revokeObjectURL = originals.revokeObjectURL;
  await vite?.close();
});

function harness(data, resolver) {
  const store = {
    resultData: data, resultVersion: 1, downloads: [],
    addDownload(input) { const id = this.downloads.length + 1; this.downloads.push({ id, ...input }); return id; },
    updateDownload(id, changes) { Object.assign(this.downloads.find((item) => item.id === id), changes); },
    patchVideo() {},
    cancelDownload(id) { const task = this.downloads.find((item) => item.id === id); task.abortController?.abort(); task.status = 'cancelled'; },
    removeDownload(id) { this.downloads = this.downloads.filter((item) => item.id !== id); },
    clearCompletedDownloads() { this.downloads = this.downloads.filter((item) => !['completed', 'failed', 'cancelled'].includes(item.status)); },
  };
  const currentVideoUrl = ref(data?.url || '');
  const toasts = [];
  const instance = downloads.useMediaDownload({ videoStore: store, currentVideoUrl, resolveVideoUrl: resolver, showToast: (...args) => toasts.push(args) });
  return { store, currentVideoUrl, instance, toasts };
}
async function settled(task) {
  for (let i = 0; i < 300; i++) {
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('download did not settle');
}
const base = { title: '示例', images: [], live_photo: [], video_backup: [], music: {}, extra: {}, url: 'https://media.test/main.mp4' };

test('all nine registered platforms are visible; unsupported platform claims are absent', async () => {
  assert.deepEqual(platforms.supportedPlatforms.map((item) => item.key), ['douyin', 'kuaishou', 'bilibili', 'xhs', 'toutiao', 'weibo', 'pipixia', 'pipigx', 'zuiyou']);
  const html = await renderToString(createSSRApp({ render: () => h(HeroSection, { locale: 'zh-CN', currentPlatform: 'all' }) }));
  for (const platform of platforms.supportedPlatforms) assert.ok(html.includes(platform.name));
  for (const name of ['微视', '西瓜视频', '好看视频', '火山小视频']) assert.ok(!html.includes(name));
});

test('mixed live results retain the complete image gallery and honest metadata', async () => {
  const data = { ...base, type: 'live', author: { name: '作者' }, images: ['https://media.test/static.jpg', 'https://media.test/live.jpg'], live_photo: [{ image: 'https://media.test/live.jpg', video: 'https://media.test/live.mp4' }], extra: { create_time: 1786603757, statistics: { digg_count: 0 }, hashtags: [{ name: '测试话题' }] }, quality: 'original', width: 2160, height: 3840, codec: 'hevc' };
  const render = (value) => renderToString(createSSRApp({ render: () => h(ResultSection, { resultData: value, locale: 'zh-CN', formatNumber: String, formatDuration: String }) }));
  const html = await render(data);
  assert.match(html, /rs-card--gallery/); assert.match(html, /rs-card--live/);
  assert.match(html, /https:\/\/media.test\/static.jpg/);
  assert.match(html, /获赞 0/); assert.match(html, /数据/); assert.match(html, /标签/); assert.match(html, /画质选项/);
  assert.doesNotMatch(html, /未知时间/);
  const unknown = await render({ ...data, extra: {} });
  assert.doesNotMatch(unknown, /获赞 0/);
  const videoHtml = await render({ ...data, type: 'video' });
  assert.match(videoHtml, /原画/); assert.match(videoHtml, /2160×3840/);
});

test('checkbox change toggles once and checkbox key events do not select the episode', async () => {
  const source = await readFile(new URL('../src/components/VideoPlaylist.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'playlist-test', inlineTemplate: true });
  const code = await transformWithEsbuild(script.content, 'VideoPlaylist.ts', { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code.code)(createRequire(import.meta.url), module, module.exports);
  const element = (type) => ({ type, props: {}, children: [], parent: null });
  const renderer = createRenderer({
    createElement: element, createText: (text) => ({ type: '#text', text }), createComment: (text) => ({ type: '#comment', text }),
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    parentNode: (node) => node.parent, nextSibling: () => null,
    insert(node, parent) { node.parent = parent; parent.children.push(node); }, remove() {},
    patchProp(node, key, _, value) { node.props[key] = value; },
  });
  let toggles = 0, selections = 0;
  const root = element('root');
  renderer.createApp(module.exports.default, { videos: [{ index: 1, url: 'https://media.test/video.mp4' }], currentIndex: 0, total: 2, onToggle: () => toggles++, onSelect: () => selections++ }).mount(root);
  await nextTick();
  const find = (node, type) => node.type === type ? node : node.children?.map((child) => find(child, type)).find(Boolean);
  const input = find(root, 'input'), label = input.parent;
  label.props.onClick({ stopPropagation() {} });
  input.props.onChange({ stopPropagation() {} });
  assert.equal(toggles, 1);
  const card = label.parent;
  card.props.onKeydown({ key: ' ', target: input, currentTarget: card, preventDefault() {} });
  assert.equal(selections, 0);
});

test('download uses the same selected source as preview', async () => {
  const { instance, currentVideoUrl, store } = harness({ ...base, video_backup: [{ url: 'https://media.test/backup.mp4' }] });
  currentVideoUrl.value = 'https://media.test/backup.mp4';
  await instance.downloadMainVideo();
  await settled(store.downloads[0]);
  assert.equal(store.downloads[0].status, 'completed');
  assert.ok(fetched.length > 0); assert.ok(fetched.every((url) => url === currentVideoUrl.value));
});

test('a failed lazy episode never produces an empty ZIP; retry re-resolves it', async () => {
  let succeeds = false;
  const { instance, store } = harness(base, async () => succeeds ? { url: 'https://media.test/p2.mp4' } : null);
  await instance.downloadVideosAsZip([{ index: 2, url: '', _cid: '222' }]);
  assert.equal(store.downloads[0].status, 'failed'); assert.equal(clicked.length, 0);
  succeeds = true;
  instance.handleRetryDownload(store.downloads[0].id);
  await settled(store.downloads[0]);
  assert.equal(store.downloads.length, 1); assert.equal(store.downloads[0].status, 'completed');
  const zip = await JSZip.loadAsync(await blobs.at(-1).arrayBuffer());
  assert.equal(Object.keys(zip.files).length, 1);
});

test('ZIP cancellation aborts fetch; retry keeps the original resource snapshot', async () => {
  const oldUrl = 'https://media.test/old.jpg';
  const { instance, store } = harness({ ...base, url: null, images: [oldUrl] });
  let capturedSignal;
  globalThis.fetch = async (_, { signal }) => new Promise((resolve, reject) => {
    capturedSignal = signal;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const pending = instance.downloadAllMedia('images');
  instance.handleCancelDownload(store.downloads[0].id);
  await pending;
  assert.ok(capturedSignal.aborted); assert.equal(store.downloads[0].status, 'cancelled'); assert.equal(clicked.length, 0);
  store.resultData = { ...base, images: ['https://media.test/new.jpg'] };
  globalThis.fetch = async (url) => { fetched.push(url); return new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'image/webp' } }); };
  instance.handleRetryDownload(store.downloads[0].id);
  await settled(store.downloads[0]);
  assert.equal(store.downloads[0].status, 'completed'); assert.deepEqual(fetched, [oldUrl]);
  const zip = await JSZip.loadAsync(await blobs.at(-1).arrayBuffer());
  assert.deepEqual(Object.keys(zip.files), ['image_1.webp']);
});

test('all-media ZIP keeps distinct images and deduplicates live covers', async () => {
  const { instance, store } = harness({ ...base, url: null, images: ['https://one.test/a.jpg', 'https://two.test/a.jpg'], live_photo: [{ image: 'https://one.test/a.jpg', video: 'https://media.test/live.mp4' }] });
  await instance.downloadAllMedia();
  assert.equal(store.downloads[0].status, 'completed');
  const zip = await JSZip.loadAsync(await blobs.at(-1).arrayBuffer());
  assert.deepEqual(Object.keys(zip.files), ['image_1.jpg', 'image_2.jpg', 'live_1_video.mp4']);
  assert.equal(fetched.filter((url) => url === 'https://one.test/a.jpg').length, 1);
});


test('switching a multi-P source preserves its original URL and matching metadata', async () => {
  const { selectMediaSource } = await vite.ssrLoadModule('/src/utils/mediaSource.ts');
  const primary = { index: 2, url: 'https://media.test/p2-original.mp4', quality: 'original', width: 2160, height: 3840, bit_rate: 3000000, bitrate: 3000000, codec: 'hevc', video_backup: [{ url: 'https://media.test/p2-720.mp4', quality: '720p', width: 720, height: 1280, codec: 'h264' }] };
  const selected = selectMediaSource(primary, primary.video_backup[0]);
  assert.equal(selected.width, 720); assert.equal(selected.codec, 'h264');
  assert.equal(selected.bit_rate, undefined);
  assert.equal(selected.bitrate, undefined);
  const original = selected.video_backup.find((source) => source.url === primary.url);
  assert.ok(original);
  const restored = selectMediaSource(selected, original);
  assert.equal(restored.url, primary.url); assert.equal(restored.width, 2160);
  assert.equal(restored.bit_rate, 3000000); assert.equal(restored.codec, 'hevc');
  assert.ok(restored.video_backup.some((source) => source.url === selected.url));
});
