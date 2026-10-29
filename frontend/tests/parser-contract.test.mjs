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
  vite = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom' });
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

test('all nine platform choices use the six existing same-origin routes', async () => {
  const expected = {
    all: '/api/short_videos', douyin: '/api/douyin', kuaishou: '/api/ksjx',
    bilibili: '/api/bilibili', xhs: '/api/xhsjx', toutiao: '/api/toutiao',
    weibo: '/api/short_videos', pipixia: '/api/short_videos',
    pipigx: '/api/short_videos', zuiyou: '/api/short_videos',
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

test('Weibo delivery binds main and alternate signed URLs to the actual API origin', () => {
  const source = 'https://weibo.com/tv/show/1034:1234567890123';
  const direct = 'https://f.video.weibocdn.com/o0/original.mp4';
  const path = '/api/media/weibo?ticket=payload.signature';
  const backupPath = '/api/media/weibo?ticket=alternate.signature';
  const raw = { url: direct, playback_url: path, media_delivery: 'weibo-relay', quality: '1080p', width: 1920, height: 1080,
    video_backup: [{url: direct + '?backup=1', playback_url: backupPath, quality: '720p', width: 1280, height: 720}] };
  const previousBase = config.apiConfig.baseUrl, previousLocation = globalThis.window.location;
  try {
    globalThis.window.location = {origin:'https://snap.example.test'};
    config.apiConfig.baseUrl = '';
    const sameOrigin = parser.normalizeResponse(good(raw), source);
    assert.equal(sameOrigin.url, 'https://snap.example.test' + path);
    assert.equal(sameOrigin.original_url, direct);
    assert.equal(sameOrigin.width, 1920);
    assert.equal(sameOrigin.video_backup[0].url, 'https://snap.example.test' + backupPath);
    assert.equal(sameOrigin.video_backup[0].original_url, direct + '?backup=1');
    assert.equal(sameOrigin.video_backup[0].width, 1280);
    assert.equal(sameOrigin.video_backup[0].media_delivery, 'weibo-relay');
    config.apiConfig.baseUrl = 'https://api.example.test';
    const remoteApi = parser.normalizeResponse(good(raw), source);
    assert.equal(remoteApi.url, 'https://api.example.test' + path);
    assert.equal(remoteApi.video_backup[0].url, 'https://api.example.test' + backupPath);
    assert.equal(remoteApi._sourceUrl, source);
    globalThis.window.location = undefined;
    assert.equal(parser.resolveWeiboPlaybackUrl(path, '', undefined), path, 'SSR keeps only the validated relative route');
  } finally {
    config.apiConfig.baseUrl = previousBase; globalThis.window.location = previousLocation;
  }
});

test('invalid or missing Weibo delivery tickets never silently fall back to a blocked CDN', () => {
  const raw = {url:media, media_delivery:'weibo-relay'};
  for (const path of [undefined, '', '/api/media/weibo', '//evil.test/api/media/weibo?ticket=a.b',
    'https://api.example.test/api/media/weibo?ticket=a.b', '/api/media/weibo?ticket=a.b&url=https://evil.test',
    '/api/media/weibo?ticket=a.b&ticket=c.d', '/api/media/weibo?ticket=a.b#fragment',
    '/api/media/../weibo?ticket=a.b', '/api/media/weibo?ticket=a%2Eb']) {
    assert.throws(() => parser.normalizeResponse(good({...raw,playback_url:path})), /微博播放链接无效/);
  }
  assert.throws(() => parser.normalizeResponse(good({...raw,playback_url:'/api/media/weibo?ticket=a.b',video_backup:[{url:media}]})), /微博播放链接无效/);
  assert.throws(() => parser.normalizeResponse(good({...raw,playback_url:'/api/media/weibo?ticket=a.b',video_backup:[media]})), /微博备用播放链接缺失/);
  assert.throws(() => parser.resolveWeiboPlaybackUrl('/api/media/weibo?ticket=a.b','https://user:pass@api.example.test'), /配置异常/);
  assert.throws(() => parser.resolveWeiboPlaybackUrl('/api/media/weibo?ticket=a.b','https://api.example.test/path'), /配置异常/);
  assert.equal(parser.normalizeResponse(good({url:media,playback_url:'https://evil.test/'})).url,media,'unmarked platform response cannot replace its source');
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

test('legacy fields and both backup shapes retain usable media without overriding the main source', () => {
  const higher = 'https://media.example.test/2160p.mp4';
  const result = parser.normalizeResponse(good({
    video: media, imgurl: ['https://media.example.test/still.jpg'],
    music: 'https://media.example.test/audio.mp3',
    width: '1280', height: '720', bit_rate: '1000000', codec: 'h264',
    video_backup: [higher, { url: 'https://media.example.test/alternate.mp4', width: '2160', height: '3840', bitrate: '2500000', codec: 'hevc' }],
  }));
  assert.equal(result.url, media);
  assert.deepEqual(result.images, ['https://media.example.test/still.jpg']);
  assert.equal(result.music.url, 'https://media.example.test/audio.mp3');
  assert.equal(result.video_backup[0].url, higher);
  assert.equal(result.video_backup[1].width, 2160);
  assert.equal(result.video_backup[1].bit_rate, 2500000);
  assert.equal(result.video_backup[1].bitrate, 2500000);
  assert.equal(result.width, 1280);
  assert.equal(result.bit_rate, 1000000);
  assert.equal(result.codec, 'h264');
  assert.equal(parser.normalizeResponse(good({ video_backup: [higher] })).url, higher);
  assert.equal(parser.normalizeResponse(good({ imgurl: ['https://media.example.test/1.jpg'] })).type, 'image');
  assert.equal(parser.normalizeResponse(good({ music: 'https://media.example.test/audio.mp3' })).music.url, 'https://media.example.test/audio.mp3');
  const still = parser.normalizeResponse(good({ type: 'image', url: 'https://media.example.test/1.jpg', images: ['https://media.example.test/1.jpg'] }));
  assert.equal(still.url, null, 'an image URL must not be rendered as the main video');
});

test('top-level publication, stats and tags reach the UI with zero distinguished from missing', () => {
  const result = parser.normalizeResponse(good({
    url: media, create_time: 1786603757, publish_time: '2026-08-13 14:49:17',
    statistics: { digg_count: 0, comment_count: '12' },
    hashtags: ['风景', { name: '旅行' }, {}], video_tags: [{ name: '摄影' }],
    extra: { statistics: { share_count: 3 } },
  }));
  assert.equal(result.extra.create_time, 1786603757);
  assert.equal(result.extra.publish_time, '2026-08-13 14:49:17');
  assert.deepEqual(result.extra.statistics, { digg_count: 0, comment_count: 12, share_count: 3 });
  assert.deepEqual(result.extra.hashtags.map((tag) => tag.name), ['风景', '旅行']);
  assert.equal(result.extra.video_tags[0].name, '摄影');
  assert.equal(parser.normalizeResponse(good()).extra.statistics, undefined);
});

test('a new input after success makes a fresh request immediately', async () => {
  const { instance, store } = harness('https://v.douyin.com/first/');
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(url); return Response.json(good({ url: media, title: `Result ${requests.length}` })); };
  await instance.parseVideo();
  assert.equal(store.resultData.title, 'Result 1');
  instance.inputUrl.value = 'https://v.douyin.com/second/';
  assert.equal(store.resultData, null);
  await instance.parseVideo();
  assert.equal(requests.length, 2);
  assert.equal(store.resultData.title, 'Result 2');
});

test('input changes cancel old parsing and stale responses cannot overwrite the next result', async () => {
  const { instance, store, toasts } = harness('https://v.douyin.com/first/');
  let finishFirst, firstSignal;
  globalThis.fetch = async (_url, options) => {
    firstSignal = options.signal;
    return new Promise((resolve) => { finishFirst = resolve; });
  };
  const first = instance.parseVideo();
  await instance.parseVideo(); // Duplicate click must not start another request.
  instance.inputUrl.value = 'https://v.douyin.com/second/';
  assert.equal(firstSignal.aborted, true);
  globalThis.fetch = async () => Response.json(good({ url: media, title: 'Second' }));
  await instance.parseVideo();
  finishFirst(Response.json(good({ url: media, title: 'First' })));
  await first;
  assert.equal(store.resultData.title, 'Second');
  assert.equal(toasts.filter((toast) => toast[1] === 'success').length, 1);
  assert.equal(instance.parseButton.isLoading.value, false);
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

test('short-link responses honor backend current_page and preserve lazy part identifiers', () => {
  const result = parser.normalizeResponse(good({
    url: media,
    videos: [{ index: 1, cid: 11, page: 1, url: '', lazyResolve: true }, { index: 2, cid: 12, page: 2, url: media }],
    extra: { current_page: 2 },
  }), 'https://b23.tv/example');
  assert.equal(result.url, media);
  assert.equal(result.videos[1]._current, true);
  assert.equal(result.videos[0]._cid, '11');
  assert.equal(result.videos[0]._page, 1);
  assert.equal(result.videos[0]._resolved, false);
  assert.equal(result.videos[0].url, '');
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

  // The lazy response's primary URL belongs to the newly requested P, not the input's P.
  globalThis.fetch = async () => Response.json(good({ url: media,
    extra: { current_page: 3, pages: [{ page: 1, cid: 11 }, { page: 2, cid: 12 }, { page: 3, cid: 13 }] },
  }));
  assert.equal((await instance.resolveBilibiliPage({ index: 3 })).url, media);
});

test('a lazy part response from the previous input is discarded', async () => {
  const { instance } = harness();
  let finish;
  globalThis.fetch = async () => new Promise((resolve) => { finish = resolve; });
  const resolving = instance.resolveBilibiliPage({ index: 2 });
  instance.inputUrl.value = 'https://www.bilibili.com/video/BV9876543210?p=1';
  finish(Response.json(good({ url: media })));
  assert.equal(await resolving, null);
});

test('cancelling a lazy download aborts its Bilibili API request', async () => {
  const { instance } = harness();
  const controller = new AbortController();
  let requestSignal;
  globalThis.fetch = async (_url, { signal }) => new Promise((_resolve, reject) => {
    requestSignal = signal;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const resolving = instance.resolveBilibiliPage({ index: 2 }, controller.signal);
  controller.abort();
  assert.equal(requestSignal.aborted, true);
  assert.equal(await resolving, null);
});

test('part metadata stays with its source and retry keeps the original work after a new parse', async () => {
  const original = 'https://www.bilibili.com/video/BV1234567890?p=1';
  const result = parser.normalizeResponse(good({url: media, quality: '1080p', width: 1920, height: 1080,
    video_backup: [media + '?mirror=1'], extra: {current_page: 1, bvid: 'BV1234567890'},
    videos: [{index: 1, cid: '11', url: media}, {index: 2, cid: '12', url: '', lazyResolve: true}],
  }), original);
  assert.equal(result.videos[0].video_backup[0].url, media + '?mirror=1');
  assert.equal(result.videos[0].width, 1920);
  assert.equal(result.videos[1].video_backup.length, 0);
  assert.equal(result.videos[1].width, undefined);
  const savedPart = {...result.videos[1]};
  const {instance, store} = harness(original);
  instance.inputUrl.value = 'https://www.bilibili.com/video/BV9876543210?p=1';
  store.resultData = parser.normalizeResponse(good({url: media + '?new-work=1'}), instance.inputUrl.value);
  let requested;
  globalThis.fetch = async (url) => { requested = new URL(url, 'https://snap.example.test').searchParams.get('url');
    return Response.json(good({url: media + '?old-part=2', quality:'720p', width:1280, height:720,
      video_backup:[media+'?old-backup=2'], extra:{current_page:2},
      videos:[{index:1,url:''},{index:2,url:media+'?old-part=2'}]})); };
  const resolved = await instance.resolveBilibiliPage(savedPart);
  assert.match(requested, /BV1234567890/);
  assert.equal(new URL(requested).searchParams.get('p'), '2');
  assert.equal(resolved.url, media + '?old-part=2');
  assert.equal(resolved.video_backup[0].url, media+'?old-backup=2');
  assert.equal(resolved.width,1280);
  assert.equal(store.resultData.url, media+'?new-work=1');
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
