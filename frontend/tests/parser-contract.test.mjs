import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { ref, reactive, createSSRApp } from 'vue';
import { renderToString } from '@vue/server-renderer';

// Load the real TypeScript modules through the project's existing Vite toolchain.
// All network responses below are fixtures; no platform/account/API is contacted.
describe('PHP frontend contract', () => {
let vite, parser, config, selection, antiReplay;
const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
before(async () => {
  vite = await createServer({ server: { middlewareMode: true, hmr: false, watch: null }, appType: 'custom' });
  parser = await vite.ssrLoadModule('/src/composables/useVideoParser.ts');
  config = await vite.ssrLoadModule('/src/services/apiConfig.ts');
  selection = await vite.ssrLoadModule('/src/composables/useVideoSelection.ts');
  antiReplay = (await vite.ssrLoadModule('/src/utils/antiReplay.js')).antiReplayInstance;
  (await vite.ssrLoadModule('/src/services/operationLogger.js')).operationLogger.enableConsole = false;
  globalThis.window = { setTimeout, clearTimeout };
});
after(async () => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  antiReplay?.destroy();
  await vite?.close();
});

const media = 'https://media.example.test/video.mp4';
const good = (data = { url: media, title: 'Fixture' }) => ({ code: 200, data });
function harness(source = 'https://www.bilibili.com/video/BV1234567890?p=2') {
  const store = reactive({
    resultData: null,
    clearResult() { this.resultData = null; },
    setResult(data) { this.resultData = data; },
    initSwiper() {},
  });
  const toasts = [];
  const instance = parser.useVideoParser({
    videoStore: store, locale: ref('zh-CN'), showBackup: ref(false),
    currentVideoUrl: ref(''), showToast: (...args) => toasts.push(args),
  });
  instance.inputUrl.value = source;
  return { store, instance, toasts };
}

test('default PHP API contract uses six same-origin routes; base does not enable encryption', async () => {
  const expected = {
    all: '/api/short_videos', douyin: '/api/douyin', kuaishou: '/api/ksjx',
    bilibili: '/api/bilibili', xhs: '/api/xhsjx', toutiao: '/api/toutiao',
  };
  assert.deepEqual(config.resolveApiConfig({}).endpoints, expected);
  assert.equal(config.resolveApiConfig({ VITE_API_BASE_URL: 'https://snap.example.test/' }).mode, 'php');
  assert.equal(config.resolveApiConfig({ VITE_API_MODE: 'secure' }).mode, 'secure');
  assert.throws(() => config.resolveApiConfig({ VITE_API_MODE: 'typo' }), /VITE_API_MODE/);
  assert.throws(() => config.resolveApiConfig({ VITE_API_BASE_URL: 'https://snap.example.test/api' }), /origin/);
  const secure = await vite.ssrLoadModule('/src/services/secureApiClient.ts');
  assert.equal(secure.secureApiClient, null);
  for (const [platform, route] of Object.entries(expected)) {
    const { instance, store } = harness('https://v.douyin.com/example/?a=1&b=2');
    let requested;
    globalThis.fetch = async (url) => { requested = url; return Response.json(good()); };
    instance.selectPlatform(platform);
    await instance.parseVideo();
    const request = new URL(requested, 'https://snap.example.test');
    assert.equal(request.pathname, route);
    assert.equal(request.searchParams.get('url'), 'https://v.douyin.com/example/?a=1&b=2');
    assert.equal(store.resultData.url, media);
  }
});

test('HTTP 200 with PHP business error clears stale results and shows the server message', async () => {
  const { instance, store, toasts } = harness();
  store.resultData = parser.normalizeResponse(good());
  globalThis.fetch = async () => Response.json({ code: 404, msg: '作品不存在' });
  await instance.parseVideo();
  assert.equal(store.resultData, null);
  assert.equal(instance.parseError.value, '作品不存在');
  assert.equal(toasts.at(-1)[1], 'error');
  for (const code of [0, -1, 201, 400, 403, 500]) {
    assert.throws(() => parser.normalizeResponse({ code, data: { url: media } }), /解析失败|链接格式/);
  }
});

test('empty JSON, malformed JSON, HTTP failure, network failure and timeout are distinct failures', async () => {
  for (const value of [null, {}, { code: 200 }, good({}), good({ images: [null, {}, ' '] }), good({ live_photo: [{ image: '' }] }), good({ video_backup: [{ url: '' }] }), good({ music: { url: '' } })]) {
    assert.throws(() => parser.normalizeResponse(value));
  }
  globalThis.fetch = async () => new Response('<html>gateway failure</html>');
  await assert.rejects(parser.fetchJSON('/api/short_videos'), /返回格式异常/);
  globalThis.fetch = async () => Response.json({ msg: '本地网关暂不可用' }, { status: 502 });
  await assert.rejects(parser.fetchJSON('/api/short_videos'), /本地网关暂不可用/);
  globalThis.fetch = async () => new Response('', { status: 503 });
  await assert.rejects(parser.fetchJSON('/api/short_videos'), /HTTP 503/);
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(parser.fetchJSON('/api/short_videos'), /网络连接失败/);
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  });
  await assert.rejects(parser.fetchJSON('/api/short_videos', 5), /请求超时/);
});

test('video, images, live photos, music and backup links survive the PHP envelope', () => {
  const data = {
    title: 'Mixed resources', url: media,
    images: ['https://media.example.test/1.jpg', null, ''],
    live_photo: [{ image: 'https://media.example.test/live.jpg', video: media }, null, {}],
    video_backup: [{ url: 'https://media.example.test/backup.mp4', quality: '720p' }, {}],
    music: { url: 'https://media.example.test/music.mp3' },
    author: { name: 'Fixture author' },
  };
  const result = parser.normalizeResponse(good(data));
  assert.equal(result.title, data.title);
  assert.deepEqual(result.images, [data.images[0]]);
  assert.deepEqual(result.live_photo, [data.live_photo[0]]);
  assert.deepEqual(result.video_backup, [data.video_backup[0]]);
  assert.deepEqual(result.music, data.music);
  assert.equal(parser.normalizeResponse(good({ images: [data.images[0]] })).type, 'image');
  assert.equal(parser.normalizeResponse(good({ live_photo: [data.live_photo[0]] })).type, 'live');
  assert.equal(parser.normalizeResponse(good({ video_backup: [data.video_backup[0]] })).video_backup.length, 1);
  assert.equal(parser.normalizeResponse(good({ music: data.music })).music.url, data.music.url);
});

test('legacy Bilibili all-part response selects requested P and does not invent links for failures', () => {
  const data = {
    url: 'https://media.example.test/p3.mp4',
    user: { name: 'Uploader', avatar: 'https://media.example.test/avatar.jpg' },
    videos: [
      { index: 1, title: 'First', url: 'https://media.example.test/p1.mp4' },
      { index: 2, title: 'Second', url: 'https://media.example.test/p2.mp4' },
      { index: 3, title: 'Third', error: '无法获取视频链接' },
    ],
  };
  const source = 'https://www.bilibili.com/video/BV1234567890?p=2';
  const result = parser.normalizeResponse(good(data), source);
  assert.equal(result.url, data.videos[1].url);
  assert.equal(result.videos[2].url, '');
  assert.equal(result.videos[2].error, '无法获取视频链接');
  assert.equal(result.author.name, 'Uploader');
  const store = reactive({ resultData: result });
  const selected = selection.useVideoSelection({ videoStore: store });
  selected.syncResult();
  assert.equal(selected.selectedIndex.value, 1);
  assert.equal(selected.currentVideoUrl.value, data.videos[1].url);
  assert.equal(parser.normalizeResponse(good(data), source.replace('p=2', 'p=3')).url, null);
});

test('extra.pages lazy parts and collections keep current episode metadata', () => {
  const result = parser.normalizeResponse(good({
    url: media, extra: { current_page: 2, pages: [{ page: 1, cid: 11 }, { page: 2, cid: 12 }] },
  }), 'https://www.bilibili.com/video/BV1234567890?p=2');
  assert.equal(result.videos[0].url, '');
  assert.equal(result.videos[1].url, media);
  assert.equal(result.videos[1]._cid, '12');
  const collection = parser.normalizeResponse(good({
    type: 'collection', url: media,
    extra: { current_episode: 'BV2222222222' },
    ugc_season: { sections: [
      { title: 'Season 1', episodes: [{ bvid: 'BV1111111111', title: 'One' }] },
      { title: 'Season 2', episodes: [{ bvid: 'BV2222222222', title: 'Two' }] },
    ] },
  }));
  assert.equal(collection.collections.length, 2);
  assert.equal(collection.videos[1]._current, true);
  assert.equal(collection.videos[1].url, media);
});

test('lazy Bilibili resolution uses requested page and fails rather than returning another part', async () => {
  const { instance } = harness();
  let request;
  globalThis.fetch = async (url) => {
    request = new URL(url, 'https://snap.example.test');
    return Response.json(good({ url: media, videos: [
      { index: 1, url: 'https://media.example.test/p1.mp4' },
      { index: 2, url: 'https://media.example.test/p2.mp4' },
    ] }));
  };
  const resolved = await instance.resolveBilibiliPage({ index: 2 });
  assert.equal(request.pathname, '/api/bilibili');
  assert.equal(new URL(request.searchParams.get('url')).searchParams.get('p'), '2');
  assert.equal(resolved.url, 'https://media.example.test/p2.mp4');
  globalThis.fetch = async () => Response.json(good({ url: media, videos: [
    { index: 1, url: media }, { index: 2, error: '无法获取视频链接' },
  ] }));
  assert.equal(await instance.resolveBilibiliPage({ index: 2 }), null);
  globalThis.fetch = async () => Response.json({ code: 404, msg: 'Not found' });
  assert.equal(await instance.resolveBilibiliPage({ index: 2 }), null);
});

test('the multi-part player never renders a different part as fallback for a failed part', async () => {
  const { default: ResultSection } = await vite.ssrLoadModule('/src/components/ResultSection.vue');
  const result = parser.normalizeResponse(good({ url: media, videos: [
    { index: 1, url: media }, { index: 2, error: '无法获取视频链接' },
  ] }));
  const store = reactive({ resultData: result });
  const selected = selection.useVideoSelection({ videoStore: store });
  selected.selectIndex(1);
  const html = await renderToString(createSSRApp(ResultSection, {
    resultData: result, selection: selected, locale: 'zh-CN',
    formatNumber: String, formatDuration: String,
  }));
  const videoTag = html.match(/<video\b[^>]*>/)?.[0];
  assert.ok(videoTag);
  assert.equal(/\ssrc=/.test(videoTag), false, videoTag);
});
});
