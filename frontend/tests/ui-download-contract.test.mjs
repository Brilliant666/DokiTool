import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { createServer, transformWithEsbuild } from 'vite';
import { parse, compileScript } from '@vue/compiler-sfc';
import { ref, h, createSSRApp, createRenderer, nextTick, markRaw } from 'vue';
import { renderToString } from '@vue/server-renderer';
import JSZip from 'jszip';

let vite, downloads, ResultSection, HeroSection, DownloadCard, platforms, parser, antiReplay, mediaSources;
let clicked, blobs, fetched, nativeFrames;
const originals = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, location: globalThis.location, cryptoDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'crypto'), createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, ws: false, hmr: false, watch: null }, appType: 'custom',
    plugins: [{
      name: 'ui-download-acknowledgements',
      enforce: 'pre',
      transform(code, id) {
        if (/[\\/]composables[\\/]useMediaDownload\.ts$/.test(id)) return code.replaceAll('"../downloads/streaming"', '"virtual:ui-download-streaming"');
      },
      resolveId(id) { if (id === 'virtual:ui-download-streaming') return '\0ui-download-streaming'; },
      load(id) {
        if (id !== '\0ui-download-streaming') return;
        return `import * as actual from '/src/downloads/streaming.ts';
          export const cancelStreaming = (...args) => (globalThis.__uiDownloadStreaming?.cancelStreaming || actual.cancelStreaming)(...args);
          export const hasStreamingTask = (...args) => (globalThis.__uiDownloadStreaming?.hasStreamingTask || actual.hasStreamingTask)(...args);
          export const reconnectStreaming = (...args) => (globalThis.__uiDownloadStreaming?.reconnectStreaming || actual.reconnectStreaming)(...args);
          export const forgetStreaming = (...args) => (globalThis.__uiDownloadStreaming?.forgetStreaming || actual.forgetStreaming)(...args);`;
      },
    }],
  });
  downloads = await vite.ssrLoadModule('/src/composables/useMediaDownload.ts');
  // The production coordinator stays lazy; preload it here so assertions measure transfers, not Vite compilation.
  await vite.ssrLoadModule('/src/downloads/manager.ts');
  ResultSection = (await vite.ssrLoadModule('/src/components/ResultSection.vue')).default;
  HeroSection = (await vite.ssrLoadModule('/src/components/HeroSection.vue')).default;
  DownloadCard = (await vite.ssrLoadModule('/src/components/DownloadCard.vue')).default;
  mediaSources = await vite.ssrLoadModule('/src/utils/mediaSources.ts');
  platforms = await vite.ssrLoadModule('/src/utils/platforms.ts');
  parser = await vite.ssrLoadModule('/src/composables/useVideoParser.ts');
  antiReplay = (await vite.ssrLoadModule('/src/utils/antiReplay.js')).antiReplayInstance;
  globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} };
  globalThis.location = { href: 'https://snap.dokitool.com/' };
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
  globalThis.document = { body: { appendChild(element) { if (element.tag === 'iframe') nativeFrames.push(element); }, style: {} }, createElement(tag) { return { tag, setAttribute(name, value) { this[name] = value; }, click() { clicked.push({ href: this.href, filename: this.download, target: this.target }); }, remove() {} }; } };
  URL.createObjectURL = (blob) => { blobs.push(blob); return `blob:test-${blobs.length}`; };
  URL.revokeObjectURL = () => {};
});
beforeEach(() => {
  clicked = []; blobs = []; fetched = []; nativeFrames = [];
  globalThis.fetch = async (url) => { fetched.push(url); return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4', 'content-length': '4' } }); };
});
after(async () => {
  Object.assign(globalThis, { fetch: originals.fetch, document: originals.document, window: originals.window, location: originals.location });
  if (originals.cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', originals.cryptoDescriptor);
  else delete globalThis.crypto;
  URL.createObjectURL = originals.createObjectURL; URL.revokeObjectURL = originals.revokeObjectURL;
  antiReplay?.destroy();
  await vite?.close();
});

function harness(data, resolver, selectionFactory) {
  const store = {
    resultData: data, resultVersion: 1, downloads: [],
    addDownload(input) { const id = this.downloads.length + 1; this.downloads.push({ id, ...input }); return id; },
    updateDownload(id, changes) { Object.assign(this.downloads.find((item) => item.id === id), changes); },
    patchVideo(target, patch) {
      const matches = (video) => video.index === target.index && (video._cid ?? '') === (target._cid ?? '') && (video._bvid ?? '') === (target._bvid ?? '');
      this.resultData = { ...this.resultData, videos: this.resultData.videos?.map(video => matches(video) ? { ...video, ...patch } : video),
        collections: this.resultData.collections?.map(collection => ({ ...collection, episodes: collection.episodes.map(video => matches(video) ? { ...video, ...patch } : video) })) };
    },
    cancelDownload(id) { const task = this.downloads.find((item) => item.id === id); task.abortController?.abort(); task.status = 'cancelled'; },
    removeDownload(id) { this.downloads = this.downloads.filter((item) => item.id !== id); },
    clearCompletedDownloads() { this.downloads = this.downloads.filter((item) => !['completed', 'failed', 'cancelled', 'handed-off', 'interrupted'].includes(item.status)); },
  };
  const currentVideoUrl = ref(data?.url || '');
  const toasts = [];
  const instance = downloads.useMediaDownload({ videoStore: store, currentVideoUrl, resolveVideoUrl: resolver, selection: selectionFactory?.(store), showToast: (...args) => toasts.push(args) });
  return { store, currentVideoUrl, instance, toasts };
}
async function settled(task) {
  for (let i = 0; i < 300; i++) {
    if (['completed', 'failed', 'cancelled', 'handed-off', 'interrupted'].includes(task.status)) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('download did not settle');
}
async function waitUntil(predicate) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('expected asynchronous stage was not reached');
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
  assert.match(videoHtml, /2160p/); assert.match(videoHtml, /2160×3840/);
  assert.doesNotMatch(videoHtml, /原画/); // An unverified label must not imply original quality.
});

test('checkbox change toggles once and checkbox key events do not select the episode', async () => {
  const source = await readFile(new URL('../src/components/VideoPlaylist.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'playlist-test', inlineTemplate: true });
  const code = await transformWithEsbuild(script.content, 'VideoPlaylist.ts', { loader: 'ts', format: 'cjs' });
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', code.code)(
    (id) => id === './AppIcon.vue' ? { __esModule: true, default: { render: () => h('i') } } : require(id),
    module, module.exports,
  );
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

async function mountResultPlayer(data, locale = 'zh-CN') {
  const source = await readFile(new URL('../src/components/ResultSection.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'media-error-test', inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } } });
  const code = await transformWithEsbuild(script.content, 'ResultSection.js', { loader: 'js', format: 'cjs' });
  const module = { exports: {} }, require = createRequire(import.meta.url);
  new Function('require', 'module', 'exports', code.code)(
    (id) => id === './VideoPlaylist.vue' ? { __esModule: true, default: { render: () => null } }
      : id === './AppIcon.vue' ? { __esModule: true, default: { render: () => h('i') } }
      : id === '../utils/mediaSources' ? mediaSources : require(id),
    module, module.exports,
  );
  const element = (type, text = '') => markRaw({ type, text, props: {}, children: [], parent: null, style: {}, removeAttribute() {} });
  const portal = element('portal');
  const detach = (node) => {
    if (node.parent) node.parent.children = node.parent.children.filter((item) => item !== node);
    node.parent = null;
  };
  const renderer = createRenderer({
    querySelector: () => portal,
    createElement: element, createText: (text) => element('#text', text), createComment: (text) => element('#comment', text),
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
    parentNode: (node) => node.parent,
    nextSibling: (node) => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert(node, parent, anchor) { detach(node); node.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, node); },
    remove: detach,
    patchProp(node, key, _, value) { node.props[key] = value; if (key === 'src') node.src = value; },
  });
  const state = ref({ resultData: data, locale, formatNumber: String, formatDuration: String });
  const root = element('root');
  const app = renderer.createApp({ render: () => h(module.exports.default, state.value) });
  app.mount(root); await nextTick();
  const find = (node, match) => match(node) ? node : node.children.map((child) => find(child, match)).find(Boolean);
  return { state, app, player: () => find(root, (node) => node.type === 'video'),
    copyButton: () => find(root, (node) => node.type === 'button' && node.children.some(child => String(child.props.class).includes('fa-copy'))),
    alert: () => find(root, (node) => node.props.role === 'alert'),
    link: () => find(root, (node) => node.type === 'a'),
    text: (node) => node ? [node.text, ...node.children.map((child) => [child.text, ...child.children.map((part) => part.text)].join(''))].join('') : '',
  };
}

test('media failure appears only after an active player error and recovers when switching or loading', async () => {
  const original = 'https://weibo.com/tv/show/1034:123';
  const view = await mountResultPlayer({ ...base, type: 'video', _sourceUrl: original });
  try {
    assert.equal(view.alert(), undefined);
    const firstPlayer = view.player(); firstPlayer.currentSrc = firstPlayer.src;
    firstPlayer.props.onError({ currentTarget: firstPlayer }); await nextTick();
    assert.match(view.text(view.alert()), /该视频源无法在本站直接播放/);
    assert.equal(view.link().props.href, original);
    assert.equal(view.link().props.rel, 'noopener noreferrer');
    view.state.value = { ...view.state.value, currentVideoUrl: 'https://media.test/backup.mp4' }; await nextTick();
    assert.equal(view.alert(), undefined);
    const secondPlayer = view.player(); assert.notEqual(firstPlayer, secondPlayer); secondPlayer.currentSrc = secondPlayer.src;
    firstPlayer.props.onError({ currentTarget: firstPlayer }); await nextTick();
    assert.equal(view.alert(), undefined, 'a removed player cannot show an error for its replacement');
    secondPlayer.props.onError({ currentTarget: secondPlayer }); await nextTick();
    assert.ok(view.alert());
    firstPlayer.props.onLoadeddata({ currentTarget: firstPlayer }); await nextTick();
    assert.ok(view.alert(), 'a stale success cannot hide the current failure');
    secondPlayer.props.onLoadeddata({ currentTarget: secondPlayer }); await nextTick();
    assert.equal(view.alert(), undefined);
  } finally { view.app.unmount(); }
});

test('multi-P media errors use stable work identity and never expose unsafe original links', async () => {
  const view = await mountResultPlayer({ ...base, type: 'video', _sourceUrl: 'https://www.bilibili.com/video/BV1234567890?p=2',
    videos: [{ index: 2, url: base.url }, { index: 3, url: 'https://media.test/p3.mp4' }] }, 'en');
  try {
    let player = view.player(); player.currentSrc = player.src;
    player.props.onError({ currentTarget: player }); await nextTick();
    assert.match(view.text(view.alert()), /This source cannot play directly here/);
    assert.equal(view.link().props.href, 'https://www.bilibili.com/video/BV1234567890?p=2');
    for (const unsafe of ['javascript:alert(1)', 'https://user:secret@example.com/', 'not a URL']) {
      view.state.value = { ...view.state.value, resultData: { ...view.state.value.resultData, _sourceUrl: unsafe } }; await nextTick();
      assert.equal(view.alert(), undefined, 'new work clears the old error even when its media URL matches');
      player = view.player(); player.currentSrc = player.src;
      player.props.onError({ currentTarget: player }); await nextTick();
      assert.ok(view.alert()); assert.equal(view.link(), undefined);
    }
  } finally { view.app.unmount(); }
});

test('download uses the same selected source as preview', async () => {
  const { instance, currentVideoUrl, store } = harness({ ...base, video_backup: [{ url: 'https://media.test/backup.mp4' }] });
  currentVideoUrl.value = 'https://media.test/backup.mp4';
  await instance.downloadMainVideo();
  await settled(store.downloads[0]);
  assert.equal(store.downloads[0].status, 'completed');
  assert.ok(fetched.length > 0); assert.ok(fetched.every((url) => url === currentVideoUrl.value));
});

test('Weibo preview, copy and download use the same selected signed source and describe its delivery', async () => {
  const direct = 'https://f.video.weibocdn.com/o0/original.mp4';
  const backup = '/api/media/weibo?ticket=alternate.signature';
  const data = parser.normalizeResponse({code:200,data:{...base,url:direct,
    playback_url:'/api/media/weibo?ticket=main.signature',media_delivery:'weibo-relay',
    video_backup:[{url:direct+'?alternate=1',playback_url:backup,quality:'720p'}]}});
  const {instance,currentVideoUrl,store} = harness(data);
  currentVideoUrl.value = data.video_backup[0].url;
  const render = (locale, resultData=data) => renderToString(createSSRApp({render:()=>h(ResultSection, {
    resultData,currentVideoUrl:currentVideoUrl.value,locale,formatNumber:String,formatDuration:String})}));
  const html = await render('zh-CN');
  assert.ok(html.includes(backup));
  assert.match(html,/当前通过本站服务播放与下载微博视频/);
  assert.doesNotMatch(html,/当前使用源链接直连播放与下载/);
  assert.match(await render('en'),/Weibo playback and downloads use this site/);
  const view = await mountResultPlayer(data);
  let copied;
  try {
    view.state.value = {...view.state.value,currentVideoUrl:currentVideoUrl.value,onCopyUrl:url=>{copied=url}};
    await nextTick();
    assert.equal(view.player().src,currentVideoUrl.value);
    view.copyButton().props.onClick();
    assert.equal(copied,currentVideoUrl.value);
  } finally { view.app.unmount(); }
  await instance.downloadMainVideo();
  await settled(store.downloads[0]);
  assert.equal(store.downloads[0].status,'completed');
  assert.ok(fetched.length > 0 && fetched.every(url=>new URL(url, location.href).href===new URL(backup, location.href).href), 'media probe, native qualification and complete download all use the selected signed route');
  assert.equal((await blobs.at(-1).arrayBuffer()).byteLength,4);
  const directHtml = await render('zh-CN',base);
  assert.match(directHtml,/当前使用源链接直连播放与下载/);
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
  await waitUntil(() => capturedSignal);
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

const sourceMetadata = { width: 2160, height: 3840, bit_rate: 5000000, codec: 'hevc', quality: '2160p' };
const retryData = () => ({ ...base, ...sourceMetadata, video_backup: [
  { ...sourceMetadata, url: 'https://media.test/same-1.mp4' },
  { ...sourceMetadata, url: 'https://media.test/same-2.mp4' },
  { ...sourceMetadata, url: 'https://media.test/same-3.mp4' },
  { url: 'https://media.test/lower.mp4', width: 720, height: 1280, bit_rate: 1000000, codec: 'h264', quality: '720p' },
] });
const sampleResponse = () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4', 'content-length': '4' } });

/** A bounded native-eligibility GET precedes delivery. Its non-attachment response
 * is deliberately separate from the complete-file attempts asserted below. */
function mockFileTransfer(transfer) {
  const probes = [];
  globalThis.fetch = async (url, options = {}) => {
    if (options.headers?.Range) return sampleResponse();
    if (!probes.length) { probes.push(url); return sampleResponse(); }
    return transfer(url, options);
  };
  return probes;
}

test('file download retries at most three matching-quality routes and synchronizes the successful selection', async () => {
  const { instance, store, currentVideoUrl } = harness(retryData());
  const transfers = [];
  const probes = mockFileTransfer(async (url) => {
    transfers.push(url);
    if (url !== 'https://media.test/same-2.mp4') throw new TypeError('unavailable');
    return sampleResponse();
  });
  await instance.downloadMainVideo(); await settled(store.downloads[0]);
  assert.deepEqual(probes, [base.url]);
  assert.deepEqual(transfers, [base.url, 'https://media.test/same-1.mp4', 'https://media.test/same-2.mp4']);
  assert.equal(store.downloads[0].status, 'completed');
  assert.equal(currentVideoUrl.value, 'https://media.test/same-2.mp4');
  assert.equal(store.downloads[0].url, currentVideoUrl.value);
  assert.equal(store.downloads[0].loaded, 4);
  assert.equal(store.downloads[0].speed, 0);
  assert.equal(clicked.length, 1); assert.match(clicked[0].href, /^blob:/);
});

test('failed routes do not open popups; a deliberate browser handoff stays distinct from completion', async () => {
  const { instance, store } = harness(retryData());
  const transfers = [];
  const probes = mockFileTransfer(async (url) => { transfers.push(url); throw new TypeError('CORS'); });
  await instance.downloadMainVideo(); await settled(store.downloads[0]);
  assert.equal(transfers.length, 3);
  assert.deepEqual(probes, [base.url]);
  assert.equal(store.downloads[0].status, 'failed');
  assert.equal(clicked.length, 0);
  instance.handleBrowserDownload(store.downloads[0].id);
  assert.equal(store.downloads[0].status, 'handed-off');
  assert.equal(store.downloads[0].percent, 0);
  assert.deepEqual(clicked.map(({ href, target }) => ({ href, target })), [{ href: 'https://media.test/same-2.mp4', target: '_blank' }]);
  const tasks = [store.downloads[0], { id: 2, status: 'completed', show: true }, { id: 3, status: 'cancelled' }, { id: 4, status: 'failed' }];
  const html = await renderToString(createSSRApp({ render: () => h(DownloadCard, { downloads: tasks }) }));
  assert.doesNotMatch(html, /全部完成/);
  assert.match(html, /浏览器处理 1/); assert.match(html, /完成 1/); assert.match(html, /失败 1/); assert.match(html, /取消 1/);
  assert.match(html, /本站无法追踪/);
  instance.handleClearCompleted('all'); assert.equal(store.downloads.length, 0);
});

test('eligible native attachment hands off once without Blob progress or a false completed state', async () => {
  const { instance, store } = harness(base);
  let qualificationRequests = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.headers?.Range) return sampleResponse();
    qualificationRequests++;
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4', 'content-length': '4', 'content-disposition': 'attachment; filename="upstream.mp4"' } });
  };
  await instance.downloadMainVideo(); await settled(store.downloads[0]);
  assert.equal(qualificationRequests, 1); assert.equal(blobs.length, 0);
  assert.equal(store.downloads[0].transport, 'browser_native'); assert.equal(store.downloads[0].status, 'handed-off');
  assert.equal(store.downloads[0].percent, 0);
  assert.equal(clicked.length, 0);
  assert.equal(nativeFrames.length, 1); assert.equal(nativeFrames[0].src, base.url);
  assert.equal(nativeFrames[0].sandbox, 'allow-downloads');
  assert.equal(store.downloads[0].filename, 'upstream.mp4');
  const html = await renderToString(createSSRApp({ render: () => h(DownloadCard, { downloads: store.downloads }) }));
  assert.match(html, /本站无法追踪/); assert.doesNotMatch(html, /全部完成|100%/);
});

test('queued cards remain cancellable and interrupted cards never claim completion or invent a retry URL', async () => {
  const render = downloads => renderToString(createSSRApp({ render: () => h(DownloadCard, { downloads }) }));
  const queued = await render([{ id: 1, status: 'queued', statusText: '排队中...', filename: 'queue.mp4', transport: 'browser_streaming' }]);
  assert.match(queued, /排队中|1 个进行中/); assert.match(queued, /title="取消"/);
  assert.doesNotMatch(queued, /清除全部|全部完成|title="重试"/);
  const interrupted = { id: 2, deliveryId: 'lost-worker', transport: 'browser_streaming', status: 'interrupted', statusText: '下载连接已中断', filename: 'lost.mp4', url: '', error: '原任务失效，请重新解析' };
  const missing = await render([interrupted]);
  assert.match(missing, /连接中断 1|原任务失效，请重新解析/); assert.match(missing, /清除全部/);
  assert.doesNotMatch(missing, /全部完成|title="重试"|title="取消"/);
  assert.match(await render([{ ...interrupted, url: base.url }]), /title="重试"/);
});

test('missing crypto.randomUUID still permits bounded browser downloads with distinct page task IDs', async () => {
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) } });
  try {
    const { instance, store } = harness(base);
    for (let i = 0; i < 2; i++) {
      const id = store.addDownload({ filename: `compat-${i}.mp4`, url: base.url });
      await instance.downloadFile(base.url, `compat-${i}.mp4`, id);
    }
    assert.equal(store.downloads.length, 2);
    assert.ok(store.downloads.every(task => task.status === 'completed' && task.transport === 'browser_blob'));
    assert.ok(store.downloads.every(task => typeof task.deliveryId === 'string' && task.deliveryId.length > 0));
    assert.notEqual(store.downloads[0].deliveryId, store.downloads[1].deliveryId);
    assert.equal(blobs.length, 2);
  } finally { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto }); }
});

test('cancelling preparation and queued delivery stops page work before any Worker task exists', async () => {
  const { instance, store } = harness(base);
  const signals = [], controllers = [], jobs = [];
  globalThis.fetch = async (_url, options) => {
    signals.push(options.signal);
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  };
  try {
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController(); controllers.push(controller);
      const url = `${base.url}?part=${i}`;
      const id = store.addDownload({ filename: `queued-${i}.mp4`, url });
      jobs.push(instance.downloadFile(url, `queued-${i}.mp4`, id, controller));
    }
    await waitUntil(() => signals.length === 2 && store.downloads[2].status === 'queued');
    await instance.handleCancelDownload(store.downloads[2].id);
    await jobs[2];
    assert.equal(store.downloads[2].status, 'cancelled'); assert.equal(controllers[2].signal.aborted, true);
    assert.equal(signals.length, 2, 'the cancelled queue entry must never start a probe or transfer');
    await instance.handleCancelDownload(store.downloads[0].id);
    await instance.handleCancelDownload(store.downloads[1].id);
    await Promise.all(jobs);
    assert.ok(signals.every(value => value.aborted));
    assert.ok(store.downloads.every(task => task.status === 'cancelled'));
    assert.equal(clicked.length, 0); assert.equal(blobs.length, 0); assert.equal(nativeFrames.length, 0);
  } finally {
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(jobs);
  }
});

test('double-clicking the same source keeps one active task and one delivery', async () => {
  const { instance, store } = harness(base);
  let resolveHeaders;
  const requests = [];
  mockFileTransfer((url) => {
    requests.push(url);
    return new Promise(resolve => { resolveHeaders = resolve; });
  });
  const firstId = store.addDownload({ filename: 'first.mp4', url: base.url });
  const first = instance.downloadFile(base.url, 'first.mp4', firstId);
  await waitUntil(() => resolveHeaders);
  const duplicateId = store.addDownload({ filename: 'second.mp4', url: base.url });
  await instance.downloadFile(base.url, 'second.mp4', duplicateId);
  assert.equal(store.downloads.length, 1);
  assert.equal(store.downloads[0].id, firstId);
  assert.deepEqual(requests, [base.url]);
  resolveHeaders(sampleResponse()); await first;
  assert.equal(store.downloads[0].status, 'completed');
  assert.equal(clicked.length, 1); assert.equal(blobs.length, 1);
});

async function mockStreamingCancellation(t, cancel) {
  globalThis.__uiDownloadStreaming = { hasStreamingTask: () => true, cancelStreaming: cancel };
  t.after(() => { delete globalThis.__uiDownloadStreaming; });
}

test('a completed Worker acknowledgement wins over a pending page cancellation', async (t) => {
  const { instance, store } = harness(base);
  const controller = new AbortController();
  const id = store.addDownload({ filename: 'race.mp4', url: base.url, status: 'downloading', transport: 'browser_streaming', deliveryId: 'original-task', abortController: controller });
  let cancellations = 0;
  await mockStreamingCancellation(t, async taskId => {
    cancellations++; assert.equal(taskId, 'original-task');
    store.updateDownload(id, { status: 'completed', statusText: '传输完成', loaded: 4, total: 4 });
  });
  await instance.handleCancelDownload(id);
  assert.equal(cancellations, 1); assert.equal(store.downloads[0].status, 'completed');
  assert.equal(store.downloads[0].statusText, '传输完成'); assert.equal(controller.signal.aborted, false);
});

test('native handoff during the cancellation import is never overwritten or sent to the Worker', async (t) => {
  const { instance, store } = harness(base);
  const controller = new AbortController();
  const id = store.addDownload({ filename: 'race.mp4', url: base.url, status: 'preparing', transport: 'browser_streaming', deliveryId: 'original-task', abortController: controller });
  let cancellations = 0;
  await mockStreamingCancellation(t, async () => { cancellations++; });
  const pending = instance.handleCancelDownload(id);
  store.updateDownload(id, { status: 'handed-off', statusText: '已交给浏览器', transport: 'browser_native', abortController: null });
  await pending;
  assert.equal(cancellations, 0); assert.equal(store.downloads[0].status, 'handed-off');
  assert.equal(store.downloads[0].statusText, '已交给浏览器'); assert.equal(controller.signal.aborted, false);
});

test('late cancellation acknowledgements cannot cancel a new attempt reusing the same card', async (t) => {
  const { instance, store } = harness(base);
  const oldController = new AbortController(), newController = new AbortController();
  const id = store.addDownload({ filename: 'race.mp4', url: base.url, status: 'downloading', transport: 'browser_streaming', deliveryId: 'old-task', abortController: oldController });
  let acknowledge;
  await mockStreamingCancellation(t, () => new Promise(resolve => { acknowledge = resolve; }));
  const pending = instance.handleCancelDownload(id);
  await waitUntil(() => acknowledge);
  store.updateDownload(id, { status: 'downloading', statusText: '新任务下载中', deliveryId: 'new-task', abortController: newController });
  acknowledge(); await pending;
  assert.equal(store.downloads[0].status, 'downloading'); assert.equal(store.downloads[0].deliveryId, 'new-task');
  assert.equal(store.downloads[0].statusText, '新任务下载中'); assert.equal(newController.signal.aborted, false);
});

test('a lost cancel acknowledgement does not replace a completion already received', async (t) => {
  const { instance, store } = harness(base);
  const controller = new AbortController();
  const id = store.addDownload({ filename: 'race.mp4', url: base.url, status: 'downloading', transport: 'browser_streaming', deliveryId: 'original-task', abortController: controller });
  await mockStreamingCancellation(t, async () => {
    store.updateDownload(id, { status: 'completed', statusText: '传输完成' });
    throw new Error('acknowledgement lost');
  });
  await instance.handleCancelDownload(id);
  assert.equal(store.downloads[0].status, 'completed'); assert.equal(store.downloads[0].error, undefined);
  assert.equal(controller.signal.aborted, false);
});

test('an uncertain Worker task retains its source and blocks another download until absence is confirmed', async (t) => {
  const { instance, store } = harness(base);
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: { getItem: () => '[]' } });
  t.after(() => {
    if (storageDescriptor) Object.defineProperty(globalThis, 'sessionStorage', storageDescriptor);
    else delete globalThis.sessionStorage;
  });
  let update, stillRunning = true;
  const snapshot = { id: 'uncertain-worker', transport: 'browser_streaming', status: 'downloading', filename: 'original.mp4', url: base.url, loaded: 2, total: 4, speed: 0, elapsed: 1, averageSpeed: 2 };
  await mockStreamingCancellation(t, async () => {});
  Object.assign(globalThis.__uiDownloadStreaming, {
    hasStreamingTask: () => stillRunning,
    reconnectStreaming: async observer => { update = observer; observer(snapshot); return [snapshot]; },
  });
  await instance.restoreDownloads();
  update({ ...snapshot, status: 'interrupted', url: '', error: '应答超时，状态未知' });
  assert.equal(store.downloads[0].url, base.url, 'status-only replies must not erase the original source identity');
  let id = store.addDownload({ filename: 'duplicate.mp4', url: base.url });
  await instance.downloadFile(base.url, 'duplicate.mp4', id);
  assert.equal(store.downloads.length, 1); assert.equal(fetched.length, 0); assert.equal(clicked.length, 0);
  stillRunning = false;
  update({ ...snapshot, status: 'interrupted', url: '', error: '原任务不存在' });
  id = store.addDownload({ filename: 'retry.mp4', url: base.url });
  await instance.downloadFile(base.url, 'retry.mp4', id);
  assert.equal(store.downloads.length, 2); assert.equal(store.downloads[1].status, 'completed');
  assert.equal(clicked.length, 1); assert.equal(blobs.length, 1);
});

test('truncated responses never create a complete file or start a native download', async () => {
  const { instance, store } = harness(base);
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4', 'content-length': '8' } });
  await instance.downloadMainVideo(); await settled(store.downloads[0]);
  assert.equal(store.downloads[0].status, 'failed');
  assert.match(store.downloads[0].error, /下载不完整/);
  assert.equal(clicked.length, 0); assert.equal(blobs.length, 0);
});

test('download preparation is visible and cancellable before its first network response', async () => {
  const { instance, store } = harness(retryData());
  let probeSignal, requests = 0;
  globalThis.fetch = async (_, { signal }) => new Promise((resolve, reject) => {
    requests++; probeSignal = signal;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  const pending = instance.downloadMainVideo();
  assert.equal(store.downloads.length, 1); assert.equal(store.downloads[0].status, 'preparing');
  await Promise.resolve(); await Promise.resolve();
  instance.handleCancelDownload(store.downloads[0].id);
  await pending;
  assert.ok(probeSignal.aborted); assert.equal(requests, 1);
  assert.equal(store.downloads[0].status, 'cancelled'); assert.equal(clicked.length, 0);
});

test('an older download keeps its frozen routes after parsing another work without changing the new player', async () => {
  const { instance, store, currentVideoUrl } = harness(retryData());
  const transfers = [];
  mockFileTransfer(async (url) => {
    transfers.push(url);
    if (url === base.url) {
      store.resultVersion++;
      store.resultData = { ...base, url: 'https://new.test/work.mp4' };
      currentVideoUrl.value = store.resultData.url;
      throw new TypeError('unavailable');
    }
    return sampleResponse();
  });
  await instance.downloadMainVideo(); await settled(store.downloads[0]);
  assert.deepEqual(transfers, [base.url, 'https://media.test/same-1.mp4']);
  assert.equal(currentVideoUrl.value, 'https://new.test/work.mp4');
  assert.equal(store.downloads[0].status, 'completed');
  assert.equal(store.downloads[0].url, 'https://media.test/same-1.mp4');
});

test('waiting and stalled transfer speed use elapsed time and all timers stop at completion', async (t) => {
  let now = 1000, intervalId = 0, bodyController, resolveHeaders;
  const intervals = new Map();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setInterval', (callback) => { intervals.set(++intervalId, callback); return intervalId; });
  t.mock.method(globalThis, 'clearInterval', (id) => { intervals.delete(id); });
  const tick = (milliseconds) => { now += milliseconds; for (const callback of [...intervals.values()]) callback(); };
  const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const body = new ReadableStream({ start(controller) { bodyController = controller; } });
  mockFileTransfer(() => new Promise(resolve => { resolveHeaders = resolve; }));
  const { instance, store } = harness(base);
  const id = store.addDownload({ filename: 'sample.mp4', url: base.url });
  const pending = instance.downloadFile(base.url, 'sample.mp4', id);
  await waitUntil(() => resolveHeaders);
  tick(4000);
  assert.equal(store.downloads[0].status, 'preparing'); assert.equal(store.downloads[0].speed, 0);
  resolveHeaders(new Response(body, { headers: { 'content-type': 'video/mp4', 'content-length': '4' } })); await flush();
  await waitUntil(() => store.downloads[0].status === 'downloading');
  bodyController.enqueue(new Uint8Array([1, 2, 3, 4])); await flush(); tick(1000);
  assert.equal(store.downloads[0].speed, 4);
  assert.equal(store.downloads[0].averageSpeed, 0.8);
  tick(4000);
  assert.equal(store.downloads[0].speed, 0); assert.equal(store.downloads[0].elapsed, 9);
  bodyController.close(); await pending;
  assert.equal(store.downloads[0].status, 'completed'); assert.equal(store.downloads[0].elapsed, 9);
  assert.equal(store.downloads[0].transferred, 4); assert.equal(store.downloads[0].speed, 0);
  assert.equal(intervals.size, 0);
});

test('browser handoff aborts the page transfer without later rewriting its status to cancelled', async () => {
  const { instance, store } = harness(base);
  let signal;
  mockFileTransfer(async (_, options) => new Promise((resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const id = store.addDownload({ filename: 'large.mp4', url: base.url });
  const pending = instance.downloadFile(base.url, 'large.mp4', id);
  await waitUntil(() => signal);
  instance.handleBrowserDownload(id); await pending;
  assert.ok(signal.aborted); assert.equal(store.downloads[0].status, 'handed-off');
  assert.equal(clicked.length, 1);
});

test('unresponsive routes time out and exhaust only the three same-quality candidates', async (t) => {
  const deadlines = new Map(), transfers = [];
  const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay !== 30000) return realTimeout(callback, delay, ...args);
    const token = {}; deadlines.set(token, callback); return token;
  });
  t.mock.method(globalThis, 'clearTimeout', token => { if (!deadlines.delete(token)) realClear(token); });
  const probes = mockFileTransfer(async (url, options) => {
    transfers.push(url);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  const { instance, store } = harness(retryData());
  await instance.downloadMainVideo();
  for (let attempt = 0; attempt < 3; attempt++) {
    await waitUntil(() => transfers.length === attempt + 1 && deadlines.size === 1);
    [...deadlines.values()][0]();
  }
  await settled(store.downloads[0]);
  assert.deepEqual(probes, [base.url]);
  assert.deepEqual(transfers, [base.url, 'https://media.test/same-1.mp4', 'https://media.test/same-2.mp4']);
  assert.equal(store.downloads[0].status, 'failed');
  assert.match(store.downloads[0].error, /30 秒/);
  assert.equal(deadlines.size, 0); assert.equal(clicked.length, 0);
});

test('cancelling the current transfer does not trigger a same-quality retry', async () => {
  const transfers = [];
  mockFileTransfer(async (url, options) => {
    transfers.push(url);
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  const { instance, store } = harness(retryData());
  await instance.downloadMainVideo();
  await waitUntil(() => transfers.length === 1);
  instance.handleCancelDownload(store.downloads[0].id);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.deepEqual(transfers, [base.url]);
  assert.equal(store.downloads[0].status, 'cancelled'); assert.equal(clicked.length, 0);
});

test('default selection with an empty override retains quality metadata and synchronizes failover', async () => {
  const { instance, store, currentVideoUrl } = harness(retryData());
  currentVideoUrl.value = '';
  const transfers = [];
  mockFileTransfer(async (url) => {
    transfers.push(url);
    if (url === base.url) throw new TypeError('unavailable');
    return sampleResponse();
  });
  await instance.downloadMainVideo(); await settled(store.downloads[0]);
  assert.deepEqual(transfers, [base.url, 'https://media.test/same-1.mp4']);
  assert.equal(store.downloads[0].status, 'completed');
  assert.equal(currentVideoUrl.value, 'https://media.test/same-1.mp4');
});

test('multi-P failover follows the effective selected episode instead of the global override', async () => {
  const first = { index: 1, url: 'https://media.test/p1.mp4' };
  const second = { ...retryData(), index: 2, url: 'https://media.test/p2.mp4' };
  const { instance, store, currentVideoUrl } = harness({ ...base, videos: [first, second] }, undefined, store => ({
    selectedIndex: ref(1), currentVideo: { get value() { return store.resultData.videos[1]; } },
  }));
  currentVideoUrl.value = '';
  const transfers = [];
  mockFileTransfer(async (url) => {
    transfers.push(url);
    if (url === second.url) throw new TypeError('unavailable');
    return sampleResponse();
  });
  await instance.downloadMainVideo(); await settled(store.downloads[0]);
  assert.deepEqual(transfers, [second.url, 'https://media.test/same-1.mp4']);
  assert.equal(store.resultData.videos[0].url, first.url);
  assert.equal(store.resultData.videos[1].url, 'https://media.test/same-1.mp4');
  assert.equal(currentVideoUrl.value, 'https://media.test/same-1.mp4');
});

test('browser handoff during failover opens the active route', async () => {
  const { instance, store } = harness(retryData());
  let secondSignal;
  mockFileTransfer(async (url, options) => {
    if (url === base.url) throw new TypeError('unavailable');
    secondSignal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  });
  await instance.downloadMainVideo();
  await waitUntil(() => secondSignal);
  assert.equal(store.downloads[0].url, 'https://media.test/same-1.mp4');
  instance.handleBrowserDownload(store.downloads[0].id);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.ok(secondSignal.aborted);
  assert.equal(clicked[0].href, 'https://media.test/same-1.mp4');
  assert.equal(store.downloads[0].status, 'handed-off');
});

test('lazy preparation timeout settles immediately and late resolver data cannot patch the store', { timeout: 3000 }, async (t) => {
  let expire;
  const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout;
  const fakeTimer = {};
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => delay === 30000 ? (expire = callback, fakeTimer) : realTimeout(callback, delay, ...args));
  t.mock.method(globalThis, 'clearTimeout', timer => { if (timer !== fakeTimer) realClear(timer); });
  const pendingResolvers = [], patches = [];
  const lazy = { index: 1, url: '', _cid: '111' };
  const { instance, store } = harness({ ...base, videos: [lazy, { index: 2, url: base.url }] }, (video, signal) =>
    new Promise(resolve => pendingResolvers.push({ resolve, signal })));
  store.patchVideo = (...args) => patches.push(args);
  const pending = instance.downloadMainVideo();
  assert.equal(pendingResolvers.length, 1);
  expire(); await pending;
  assert.ok(pendingResolvers[0].signal.aborted);
  assert.equal(store.downloads[0].status, 'failed'); assert.match(store.downloads[0].error, /30 秒/);
  pendingResolvers[0].resolve({ url: 'https://media.test/late.mp4' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(patches.length, 0); assert.equal(fetched.length, 0);
  Object.assign(store.downloads[0], { transferred: 123, progressKind: 'bytes' });
  instance.handleRetryDownload(store.downloads[0].id);
  assert.equal(store.downloads[0].transferred, 0); assert.equal(store.downloads[0].progressKind, undefined);
  instance.handleCancelDownload(store.downloads[0].id);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.ok(pendingResolvers[1].signal.aborted);
  assert.equal(store.downloads[0].status, 'cancelled');
});

test('ZIP cancellation aborts lazy resolution without waiting for its ignored signal', { timeout: 3000 }, async () => {
  let resolveLate, signal;
  const patches = [];
  const { instance, store } = harness(base, (video, abortSignal) => {
    signal = abortSignal;
    return new Promise(resolve => { resolveLate = resolve; });
  });
  store.patchVideo = (...args) => patches.push(args);
  const pending = instance.downloadVideosAsZip([{ index: 2, url: '', _cid: '222' }]);
  await waitUntil(() => signal);
  instance.handleCancelDownload(store.downloads[0].id);
  await pending;
  assert.ok(signal.aborted); assert.equal(store.downloads[0].status, 'cancelled');
  resolveLate({ url: 'https://media.test/late-zip.mp4' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(patches.length, 0); assert.equal(fetched.length, 0); assert.equal(clicked.length, 0);
});

test('cancelling during ZIP library preparation never starts media requests or saves a file', async () => {
  const { instance, store } = harness({ ...base, url: null, images: ['https://media.test/zip-preparation.jpg'] });
  const pending = instance.downloadAllMedia('images');
  assert.equal(store.downloads[0].status, 'preparing');
  instance.handleCancelDownload(store.downloads[0].id);
  await pending;
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.downloads[0].status, 'cancelled');
  assert.equal(fetched.length, 0);
  assert.equal(clicked.length, 0);
});

test('particles retain their appearance and speed while pausing offscreen and cleaning up', async () => {
  const source = await readFile(new URL('../src/components/ParticlesCanvas.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'particles-test', inlineTemplate: true });
  const code = await transformWithEsbuild(script.content, 'ParticlesCanvas.js', { loader: 'js', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', code.code)(createRequire(import.meta.url), module, module.exports);
  const saved = { window: globalThis.window, document: globalThis.document, random: Math.random };
  const frames = new Map(), windowListeners = new Map(), documentListeners = new Map(), motionListeners = new Map();
  let sequence = 0, app;
  const paints = [];
  let dots = [];
  const context = {
    clearRect() { dots = []; paints.push(dots); }, beginPath() {},
    arc(x, y, radius) { dots.push({ x, y, radius }); },
    fill() { dots.at(-1).color = this.fillStyle; },
  };
  const motion = { matches: false, addEventListener(name, fn) { motionListeners.set(name, fn); }, removeEventListener(name) { motionListeners.delete(name); } };
  const step = time => {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(time);
  };
  const element = type => ({ type, props: {}, children: [], parent: null, width: 0, height: 0, getContext: () => context });
  const renderer = createRenderer({
    createElement: element, createText: text => ({ type: '#text', text }), createComment: text => ({ type: '#comment', text }),
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    parentNode: node => node.parent, nextSibling: () => null,
    insert(node, parent) { node.parent = parent; parent.children.push(node); },
    remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); },
    patchProp(node, key, _, value) { node.props[key] = value; },
  });
  try {
    Math.random = () => 0.75;
    globalThis.window = {
      innerWidth: 400, innerHeight: 800, matchMedia: () => motion,
      requestAnimationFrame(callback) { frames.set(++sequence, callback); return sequence; },
      cancelAnimationFrame(id) { frames.delete(id); },
      addEventListener(name, fn) { windowListeners.set(name, fn); },
      removeEventListener(name) { windowListeners.delete(name); },
    };
    globalThis.document = {
      hidden: false,
      addEventListener(name, fn) { documentListeners.set(name, fn); },
      removeEventListener(name) { documentListeners.delete(name); },
    };
    app = renderer.createApp(module.exports.default);
    app.mount(element('root'));
    assert.equal(paints.length, 1, 'static particles appear with the first content');
    assert.equal(dots.length, 50);
    assert.deepEqual(dots[0], { x: 300, y: 600, radius: 2.5, color: 'rgba(99, 102, 241, 0.475)' });
    step(0);
    assert.equal(paints.length, 1, 'continuous drawing waits for a content paint opportunity');
    step(1000 / 60);
    step(2000 / 60);
    assert.ok(Math.abs(dots[0].x - 300.125) < 1e-8, 'original 60 Hz speed is unchanged');
    step(2500 / 60);
    assert.ok(Math.abs(dots[0].x - 300.1875) < 1e-8, 'a 120 Hz frame moves only half as far');
    const beforePause = dots[0].x, paintCount = paints.length;
    document.hidden = true; documentListeners.get('visibilitychange')();
    assert.equal(frames.size, 0);
    step(10000);
    assert.equal(paints.length, paintCount);
    document.hidden = false; documentListeners.get('visibilitychange')();
    step(10000); step(10016);
    assert.equal(dots[0].x, beforePause, 'returning from a background tab never jumps');
    motion.matches = true; motionListeners.get('change')();
    assert.equal(frames.size, 0);
    motion.matches = false; motionListeners.get('change')();
    assert.equal(frames.size, 1);
    app.unmount(); app = null;
    assert.equal(frames.size, 0);
    assert.equal(windowListeners.size, 0);
    assert.equal(documentListeners.size, 0);
    assert.equal(motionListeners.size, 0);
  } finally {
    app?.unmount();
    globalThis.window = saved.window; globalThis.document = saved.document; Math.random = saved.random;
  }
});
