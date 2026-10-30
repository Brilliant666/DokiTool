import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { webcrypto } from 'node:crypto';
import { createServer, transformWithEsbuild } from 'vite';
import { parse, compileScript } from '@vue/compiler-sfc';
import { ref, computed, h, createSSRApp, createRenderer, nextTick, markRaw } from 'vue';
import { renderToString } from '@vue/server-renderer';
import JSZip from 'jszip';

let vite, downloads, ResultSection, HeroSection, DownloadCard, platforms, parser, antiReplay, mediaSources, mediaContract, selectionModule, configuration;
let clicked, blobs, fetched, nativeFrames;
const originals = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window, location: globalThis.location, cryptoDescriptor: Object.getOwnPropertyDescriptor(globalThis, 'crypto'), createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL };
before(async () => {
  vite = await createServer({
    server: { middlewareMode: true, ws: false, hmr: false, watch: null }, appType: 'custom',
    plugins: [{
      name: 'ui-download-acknowledgements',
      enforce: 'pre',
      transform(code, id) {
        if (/[\\/]composables[\\/]useMediaDownload\.ts$/.test(id)) return code.replaceAll('"../downloads/streaming"', '"virtual:ui-download-streaming"').replaceAll('"../downloads/manager"', '"virtual:ui-download-manager"');
      },
      resolveId(id) { if (id === 'virtual:ui-download-streaming') return '\0ui-download-streaming'; if (id === 'virtual:ui-download-manager') return '\0ui-download-manager'; },
      load(id) {
        if (id === '\0ui-download-manager') return `import { downloadManager as actual } from '/src/downloads/manager.ts';
          export const downloadManager = { run: (...args) => (globalThis.__uiDownloadManager || actual).run(...args) };`;
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
  mediaContract = await vite.ssrLoadModule('/src/utils/mediaContract.ts');
  selectionModule = await vite.ssrLoadModule('/src/composables/useVideoSelection.ts');
  configuration = await vite.ssrLoadModule('/src/services/apiConfig.ts');
  mediaSources = await vite.ssrLoadModule('/src/utils/mediaSources.ts');
  platforms = await vite.ssrLoadModule('/src/utils/platforms.ts');
  parser = await vite.ssrLoadModule('/src/composables/useVideoParser.ts');
  antiReplay = (await vite.ssrLoadModule('/src/utils/antiReplay.js')).antiReplayInstance;
  globalThis.window = { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} };
  globalThis.location = { href: 'https://snap.dokitool.com/', origin: 'https://snap.dokitool.com' };
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

// These historical scenario inputs are test factories only. Production consumes
// exclusively the unified item contract; fixtures encode the server's decision.
function fixtureItem(input, index = 1, type = 'video') {
  if (input.variants || input.state) return input;
  const id = `item-${input.index || index}`;
  if (!input.url && (input._cid || input._bvid)) return { id, type, index:input.index || index, title:input.title, state:'deferred', default:null, default_unavailable_reason:'needs_resolve', resolve_url:`/api/resolve?token=${id}` };
  const candidates = [input, ...(input.video_backup || [])].filter(source => source.url);
  const groups = new Map();
  for (const source of candidates) {
    const key = JSON.stringify([source.width,source.height,source.bit_rate,source.codec,source.quality]);
    const variant = groups.get(key) || { id:`v${groups.size}`, metadata:{width:source.width,height:source.height,bitrate_bps:source.bit_rate,video_codec:source.codec,duration_ms:source.duration ? source.duration * 1000 : undefined,extension:type === 'image' ? 'jpg' : 'mp4'}, delivery:{kind:'file',sources:[]} };
    if (source.quality && source.quality !== 'original') variant.label = source.quality;
    variant.delivery.sources.push({id:`s${variant.delivery.sources.length}`,url:source.playback_url || source.url,...(source.playback_url || source.url.startsWith('/api/') ? {access:'relay'} : {}),...(source.size ? {size_bytes:source.size} : {})});
    groups.set(key,variant);
  }
  const variants = [...groups.values()];
  if (!variants.length) return {id,type,state:'unavailable',default:null,default_unavailable_reason:'unavailable',error:{code:'UNAVAILABLE',message:'资源不可用'}};
  const source = variants[0].delivery.sources[0];
  return {id,type,index:input.index || index,title:input.title,source_url:input._sourceUrl,variants,default:{variant_id:variants[0].id,source_id:source.id,url:source.url,...(source.access ? {access:source.access} : {})}};
}
function fixture(input) {
  if (input?.items) return input;
  const items = (input.videos?.length ? input.videos : input.url ? [input] : []).map((item,index)=>fixtureItem(item,index+1));
  const liveCovers = new Set((input.live_photo || []).map(item=>item.image));
  for (const [index,url] of (input.images || []).entries()) if (!liveCovers.has(url)) { const item=fixtureItem({url},index+1,'image'); item.id=`image-${index+1}`; items.push(item); }
  for (const [index,pair] of (input.live_photo || []).entries()) items.push({id:`live-${index+1}`,type:'live_photo',variants:[{id:'pair',delivery:{kind:'pair',resources:[{id:'image',role:'image',metadata:{extension:'jpg'},delivery:{kind:'file',sources:[{url:pair.image}]}},{id:'motion',role:'motion',metadata:{extension:'mp4'},delivery:{kind:'file',sources:[{url:pair.video}]}}]}}],default:null,default_unavailable_reason:'processing_required'});
  const statistics = Object.fromEntries(Object.entries(input.extra?.statistics || {}).map(([key,value])=>[({digg_count:'likes',play_count:'plays',comment_count:'comments',share_count:'shares',collect_count:'saves'})[key] || key,{value}]));
  return {platform:'fixture',title:input.title,source_url:input._sourceUrl,items,default_item_id:items[0]?.id,author:input.author ? {...input.author,avatar:input.author.avatar ? {url:input.author.avatar} : undefined} : undefined,published_at:input.extra?.create_time ? new Date(input.extra.create_time*1000).toISOString() : undefined,statistics,tags:(input.extra?.hashtags || []).map(tag=>tag.name)};
}
function harness(data, resolver, selectionFactory) {
  const result = ref(fixture(data)), toasts = [];
  const store = {
    get resultData() { return result.value; }, set resultData(value) { result.value = fixture(value); selection.syncResult(); }, resultVersion:1,downloads:[],
    addDownload(input) { const id=this.downloads.length+1;this.downloads.push({id,...input});return id; },
    updateDownload(id,changes) { Object.assign(this.downloads.find(item=>item.id===id),changes); },
    replaceItem(item) { result.value = {...result.value,items:result.value.items.map(old=>old.id===item.id?item:old)}; },
    cancelDownload(id) { const task=this.downloads.find(item=>item.id===id);task.abortController?.abort();task.status='cancelled'; },
    removeDownload(id) {this.downloads=this.downloads.filter(item=>item.id!==id);},
    clearCompletedDownloads() {this.downloads=this.downloads.filter(item=>!['completed','failed','cancelled','handed-off','interrupted'].includes(item.status));}
  };
  const selection = markRaw(selectionModule.useVideoSelection({videoStore:store})); selection.syncResult();
  if (selectionFactory) selection.selectIndex(selectionFactory(store).selectedIndex.value);
  const currentVideoUrl = computed({get:()=>selection.currentVideoUrl.value,set:url=>{
    if (!url) {selection.resetDefault();return;}
    const item=selection.currentVideo.value;
    for (const variant of item?.variants || []) if (variant.delivery.kind==='file') for (const source of variant.delivery.sources) if(mediaContract.sourceUrl(source)===url || source.url===url) {selection.choose({variant_id:variant.id,source_id:source.id});return;}
    throw new Error('Test must explicitly declare its selected source');
  }});
  const resolveItem = async (item,signal) => { const resolved=await resolver?.(item,signal); if (!resolved) throw new Error('解析失败'); return resolved.variants || resolved.state ? resolved : {...fixtureItem(resolved,item.index),id:item.id}; };
  const instance = downloads.useMediaDownload({videoStore:store,selection,resolveItem,showToast:(...args)=>toasts.push(args)});
  return {store,currentVideoUrl,instance,toasts,selection};
}
function resultProps(data, locale='zh-CN') { const context=harness(data);return {resultData:context.store.resultData,selection:context.selection,resultVersion:context.store.resultVersion,locale,formatNumber:String,formatDuration:String}; }
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
  assert.deepEqual(platforms.supportedPlatforms.value.map((item) => item.id), ['douyin', 'kuaishou', 'bilibili', 'xiaohongshu', 'toutiao', 'weibo', 'pipixia', 'pipigx', 'zuiyou']);
  const html = await renderToString(createSSRApp({ render: () => h(HeroSection, { locale: 'zh-CN', currentPlatform: 'all' }) }));
  for (const platform of platforms.supportedPlatforms.value) assert.ok(html.includes(platform.name));
  for (const name of ['微视', '西瓜视频', '好看视频', '火山小视频']) assert.ok(!html.includes(name));
});

test('mixed live results retain the complete image gallery and honest metadata', async () => {
  const data = { ...base, type: 'live', author: { name: '作者' }, images: ['https://media.test/static.jpg', 'https://media.test/live.jpg'], live_photo: [{ image: 'https://media.test/live.jpg', video: 'https://media.test/live.mp4' }], extra: { create_time: 1786603757, statistics: { digg_count: 0 }, hashtags: [{ name: '测试话题' }] }, quality: 'original', width: 2160, height: 3840, codec: 'hevc' };
  const render = (value) => renderToString(createSSRApp({ render: () => h(ResultSection, resultProps(value)) }));
  const html = await render(data);
  assert.match(html, /rs-card--gallery/); assert.match(html, /rs-card--live/);
  assert.match(html, /https:\/\/media.test\/static.jpg/);
  assert.match(html, /获赞 0/); assert.match(html, /数据/); assert.match(html, /标签/); assert.match(html, /画质选项/);
  assert.doesNotMatch(html, /未知时间/);
  const unknown = await render({ ...data, extra: {} });
  assert.doesNotMatch(unknown, /获赞 0/);
  const videoHtml = await render({ ...data, type: 'video' });
  assert.match(videoHtml, /2160p/);
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
    (id) => id === './AppIcon.vue' ? { __esModule:true,default:{render:()=>h('i')} } : id === '../utils/mediaContract' ? mediaContract : id === '../utils/mediaSources' ? mediaSources : id === '../services/apiConfig' ? configuration : require(id),
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
  renderer.createApp(module.exports.default, { videos: [fixtureItem({index:1,url:'https://media.test/video.mp4'})], currentIndex: 0, total: 2, onToggle: () => toggles++, onSelect: () => selections++ }).mount(root);
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
      : id === '../utils/mediaSources' ? mediaSources : id === '../utils/mediaContract' ? mediaContract : id === '../services/apiConfig' ? configuration : require(id),
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
  const state = ref(resultProps(data,locale));
  state.value.onSwitchVideo = choice => state.value.selection.choose(choice);
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
  const view = await mountResultPlayer({ ...base, type:'video',_sourceUrl:original,video_backup:[{url:'https://media.test/backup.mp4',quality:'720p'}] });
  try {
    assert.equal(view.alert(), undefined);
    const firstPlayer = view.player(); firstPlayer.currentSrc = firstPlayer.src;
    firstPlayer.props.onError({ currentTarget: firstPlayer }); await nextTick();
    assert.match(view.text(view.alert()), /该视频源无法在本站直接播放/);
    assert.equal(view.link().props.href, original);
    assert.equal(view.link().props.rel, 'noopener noreferrer');
    view.state.value.selection.choose({variant_id:'v1',source_id:'s0'}); await nextTick();
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
      view.state.value = {...view.state.value,resultVersion:(view.state.value.resultVersion||0)+1,resultData:{...view.state.value.resultData,source_url:unsafe}}; await nextTick();
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

test('relay preview, copy and download consume the identical signed source', async () => {
  const data=fixture({...base,playback_url:'/api/media/weibo?ticket=main.signature',video_backup:[{url:'https://cdn.test/other',playback_url:'/api/media/weibo?ticket=alternate.signature',quality:'720p'}]});
  const {instance,currentVideoUrl,store,selection}=harness(data); selection.choose({variant_id:'v1',source_id:'s0'});
  const html=await renderToString(createSSRApp({render:()=>h(ResultSection,{...resultProps(data),selection})}));
  assert.match(html,/当前通过本站媒体服务播放与下载/);assert.ok(html.includes('ticket=alternate.signature'));
  const view=await mountResultPlayer(data); let copied;
  try {view.state.value.selection.choose({variant_id:'v1',source_id:'s0'});view.state.value.onCopyUrl=url=>copied=url;await nextTick();assert.equal(view.player().src,currentVideoUrl.value);view.copyButton().props.onClick();assert.equal(copied,currentVideoUrl.value);}
  finally {view.app.unmount();}
  await instance.downloadMainVideo();await settled(store.downloads[0]);assert.equal(store.downloads[0].status,'completed');assert.ok(fetched.every(url=>url===currentVideoUrl.value));
});

test('a failed lazy episode never produces an empty ZIP; retry re-resolves it', async () => {
  let succeeds = false;
  const { instance, store } = harness(base, async () => succeeds ? { url: 'https://media.test/p2.mp4' } : null);
  await instance.downloadVideosAsZip([fixtureItem({index:2,url:'',_cid:'222'})]);
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
  assert.equal(Object.keys(zip.files).length,1);assert.match(Object.keys(zip.files)[0],/\.jpg$/);
});

test('all-media ZIP keeps distinct images and deduplicates live covers', async () => {
  const { instance, store } = harness({ ...base, url: null, images: ['https://one.test/a.jpg', 'https://two.test/a.jpg'], live_photo: [{ image: 'https://one.test/a.jpg', video: 'https://media.test/live.mp4' }] });
  await instance.downloadAllMedia();
  assert.equal(store.downloads[0].status, 'completed');
  const zip = await JSZip.loadAsync(await blobs.at(-1).arrayBuffer());
  assert.equal(Object.keys(zip.files).length,3);assert.equal(Object.keys(zip.files).filter(name=>name.endsWith('.jpg')).length,2);assert.equal(Object.keys(zip.files).filter(name=>name.endsWith('.mp4')).length,1);
  assert.equal(fetched.filter((url) => url === 'https://one.test/a.jpg').length, 1);
});


test('explicit variant switching preserves every original variant and its metadata', () => {
  const data=fixture({...base,width:2160,height:3840,bit_rate:3000000,codec:'hevc',video_backup:[{url:'https://media.test/lower.mp4',width:720,height:1280,codec:'h264'}]});
  const {store,selection}=harness(data);const before=JSON.stringify(store.resultData);
  selection.choose({variant_id:'v1'});assert.equal(selection.currentTarget.value.variant.metadata.width,720);assert.equal(selection.currentTarget.value.variant.metadata.bitrate_bps,undefined);
  selection.resetDefault();assert.equal(selection.currentTarget.value.variant.metadata.width,2160);assert.equal(JSON.stringify(store.resultData),before);
});

const sourceMetadata = { width: 2160, height: 3840, bit_rate: 5000000, codec: 'hevc', quality: '2160p' };
const retryData = () => ({ ...base, ...sourceMetadata, video_backup: [
  { ...sourceMetadata, url: 'https://media.test/same-1.mp4' },
  { ...sourceMetadata, url: 'https://media.test/same-2.mp4' },
  { ...sourceMetadata, url: 'https://media.test/same-3.mp4' },
  { url: 'https://media.test/lower.mp4', width: 720, height: 1280, bit_rate: 1000000, codec: 'h264', quality: '720p' },
] });
const sampleResponse = () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4', 'content-length': '4' } });

/** One shared media/attachment probe precedes complete-file delivery. */
function mockFileTransfer(transfer) {
  const probes = [];
  globalThis.fetch = async (url, options = {}) => {
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

test('bulk history clearing removes only confirmed ended tasks while active and uncertain tasks remain', async () => {
  const { instance, store } = harness(base);
  const ids = {
    completed: store.addDownload({ status: 'completed', filename: 'done.mp4' }),
    cancelled: store.addDownload({ status: 'cancelled', filename: 'cancelled.mp4' }),
    failed: store.addDownload({ status: 'failed', filename: 'failed.mp4' }),
    active: store.addDownload({ status: 'downloading', filename: 'live.mp4', abortController: new AbortController() }),
    queued: store.addDownload({ status: 'queued', filename: 'queued.mp4' }),
    uncertain: store.addDownload({ status: 'cancelled', observation: 'unknown', filename: 'unconfirmed.mp4' }),
  };
  const activeSignal = store.downloads.find(task => task.id === ids.active).abortController.signal;
  await instance.handleClearCompleted('all');
  assert.deepEqual(store.downloads.map(task => task.id), [ids.active, ids.queued, ids.uncertain]);
  assert.equal(activeSignal.aborted, false);
  assert.equal(store.downloads.find(task => task.id === ids.uncertain).observation, 'unknown');
  assert.equal(fetched.length, 0);
});

test('queued cards remain cancellable and interrupted cards never claim completion or invent a retry URL', async () => {
  const render = downloads => renderToString(createSSRApp({ render: () => h(DownloadCard, { downloads }) }));
  const queued = await render([{ id: 1, status: 'queued', statusText: '排队中...', filename: 'queue.mp4', transport: 'browser_streaming' }]);
  assert.match(queued, /排队中|1 个进行中/); assert.match(queued, /title="取消"/);
  assert.doesNotMatch(queued, /清除已结束|全部完成|title="重试"/);
  const interrupted = { id: 2, deliveryId: 'lost-worker', transport: 'browser_streaming', status: 'interrupted', statusText: '下载连接已中断', filename: 'lost.mp4', url: '', error: '原任务失效，请重新解析' };
  const missing = await render([interrupted]);
  assert.match(missing, /连接中断 1|原任务失效，请重新解析/); assert.match(missing, /清除已结束/);
  assert.doesNotMatch(missing, /全部完成|title="重试"|title="取消"/);
  assert.match(await render([{ ...interrupted, url: base.url }]), /title="重试"/);
});

test('ordinary MP4 shares one preparation probe before its complete-file transfer', async () => {
  const { instance, store } = harness(base);
  await instance.downloadMainVideo(); await settled(store.downloads[0]);
  assert.deepEqual(fetched, [base.url, base.url]);
  assert.equal(blobs.length, 1); assert.equal(await blobs[0].arrayBuffer().then(value => value.byteLength), 4);
});

test('uncertain and stalled downloads preserve progress, allow cancellation, and hide source navigation', async () => {
  const render = item => renderToString(createSSRApp({ render: () => h(DownloadCard, { downloads: [item] }) }));
  const item = { id: 1, status: 'downloading', filename: 'sample.mp4', progressKind: 'bytes',
    loaded: 10 * 1024 ** 2, total: 100 * 1024 ** 2, percent: 10, transferred: 10 * 1024 ** 2,
    elapsed: 7, transferElapsed: 5, averageSpeed: 2 * 1024 ** 2, nativeAvailable: true, url: base.url, workerBuild: 'test-build' };
  for (const observation of [undefined, 'unknown', 'stalled']) {
    const html = await render({ ...item, observation });
    assert.match(html, /10 MB/); assert.match(html, /100 MB/); assert.match(html, /title="取消"/);
    assert.doesNotMatch(html, /打开源链接|title="重试"|清除已结束|下载连接已中断/);
    assert.match(html, /总用时 7.0 秒/); assert.match(html, /传输均速 2 MB\/s/);
    assert.match(html, /data-worker-build="test-build"/);
    if (observation === 'unknown') assert.match(html, /暂时无法获取进度/);
    if (observation === 'stalled') assert.match(html, /传输暂无进展/);
  }
  assert.match(await render({ ...item, status: 'failed' }), /打开源链接/);
  assert.match(await render({ ...item, status: 'cancelled' }), /打开源链接/);
});

test('an unconfirmed cancellation keeps progress and cannot open a second download', async (t) => {
  const { instance, store } = harness(base);
  const controller = new AbortController();
  const id = store.addDownload({ filename: 'sample.mp4', url: base.url, status: 'downloading', transport: 'browser_streaming',
    deliveryId: 'original-task', abortController: controller, nativeAvailable: true, loaded: 1024, total: 4096 });
  await mockStreamingCancellation(t, async () => { throw new Error('temporary communication failure'); });
  await instance.handleCancelDownload(id);
  assert.equal(store.downloads[0].observation, 'unknown');
  assert.equal(store.downloads[0].status, 'downloading'); assert.equal(store.downloads[0].loaded, 1024);
  instance.handleBrowserDownload(id);
  assert.equal(clicked.length, 0); assert.equal(controller.signal.aborted, false);
});

test('a late unknown-start error cannot erase the observed active transfer progress', async (t) => {
  const { instance, store } = harness(base);
  globalThis.__uiDownloadManager = { async run(request, _signal, observe) {
    observe({ id: request.id, transport: 'browser_streaming', status: 'downloading', url: base.url, filename: request.filename,
      loaded: 1024, total: 4096, elapsed: 6, transferElapsed: 4, speed: 256, averageSpeed: 256, observation: 'unknown' });
    const error = new Error('acknowledgement lost'); error.name = 'StreamingStateUnknownError'; throw error;
  } };
  t.after(() => { delete globalThis.__uiDownloadManager; });
  const id = store.addDownload({ filename: 'sample.mp4', url: base.url });
  await instance.downloadFile(base.url, 'sample.mp4', id);
  assert.equal(store.downloads[0].status, 'downloading'); assert.equal(store.downloads[0].observation, 'unknown');
  assert.equal(store.downloads[0].loaded, 1024); assert.equal(store.downloads[0].total, 4096);
});

test('confirmed loss of a Worker task wins over a late cancellation error', async (t) => {
  const { instance, store } = harness(base);
  const id = store.addDownload({ filename: 'sample.mp4', url: base.url, status: 'downloading', transport: 'browser_streaming',
    deliveryId: 'original-task', abortController: new AbortController(), loaded: 1024 });
  await mockStreamingCancellation(t, async () => {
    store.updateDownload(id, { status: 'interrupted', observation: undefined, error: '原任务已失效' });
    throw new Error('task missing');
  });
  await instance.handleCancelDownload(id);
  assert.equal(store.downloads[0].status, 'interrupted'); assert.equal(store.downloads[0].observation, undefined);
  assert.equal(store.downloads[0].error, '原任务已失效');
});

test('missing crypto.randomUUID still permits Blob downloads with distinct page task IDs', async () => {
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

function retryRaceHarness(t) {
  const context = harness(base), acknowledgements = [], deliveries = [];
  // Match Pinia's real update behavior: captured task objects become stale.
  context.store.updateDownload = (id, changes) => {
    const index = context.store.downloads.findIndex(task => task.id === id);
    if (index >= 0) context.store.downloads[index] = { ...context.store.downloads[index], ...changes };
  };
  const id = context.store.addDownload({ filename: 'retry.mp4', url: base.url, status: 'failed',
    transport: 'browser_streaming', deliveryId: 'old-task', abortController: null });
  globalThis.__uiDownloadStreaming = { forgetStreaming: taskId => new Promise(resolve => {
    acknowledgements.push({ taskId, resolve });
  }) };
  globalThis.__uiDownloadManager = { run(request, _signal, observe) {
    const snapshot = { id: request.id, filename: request.filename, url: request.url, transport: 'browser_streaming',
      status: 'downloading', loaded: 0, total: 4, speed: 0, elapsed: 0, averageSpeed: 0 };
    observe(snapshot);
    return new Promise(resolve => deliveries.push({ request, finish() {
      const completed = { ...snapshot, status: 'completed', loaded: 4 };
      observe(completed); resolve(completed);
    } }));
  } };
  t.after(() => {
    deliveries.forEach(delivery => delivery.finish());
    delete globalThis.__uiDownloadStreaming; delete globalThis.__uiDownloadManager;
  });
  return { ...context, id, acknowledgements, deliveries };
}

test('double retry clicks share one pending acknowledgement and start only one new delivery', async (t) => {
  const { instance, id, acknowledgements, deliveries } = retryRaceHarness(t);
  const first = instance.handleRetryDownload(id);
  await waitUntil(() => acknowledgements.length === 1);
  const second = instance.handleRetryDownload(id);
  await new Promise(resolve => setImmediate(resolve));
  acknowledgements[0].resolve();
  await waitUntil(() => deliveries.length === 1);
  acknowledgements.slice(1).forEach(ack => ack.resolve());
  deliveries.forEach(delivery => delivery.finish());
  await Promise.all([first, second]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(acknowledgements.length, 1);
  assert.equal(deliveries.length, 1);
});

test('clearing while retry awaits acknowledgement cannot remove the new delivery card', async (t) => {
  const { instance, store, id, acknowledgements, deliveries } = retryRaceHarness(t);
  const retry = instance.handleRetryDownload(id);
  await waitUntil(() => acknowledgements.length === 1);
  const clear = instance.handleClearCompleted('all');
  await new Promise(resolve => setImmediate(resolve));
  acknowledgements[0].resolve();
  await waitUntil(() => deliveries.length === 1);
  acknowledgements.slice(1).forEach(ack => ack.resolve());
  await clear;
  assert.equal(store.downloads.length, 1);
  assert.equal(store.downloads[0].deliveryId, deliveries[0].request.id);
  assert.equal(store.downloads[0].status, 'downloading');
  deliveries.forEach(delivery => delivery.finish());
  await retry;
});

test('retrying while clear awaits acknowledgement cannot start a delivery for a removed card', async (t) => {
  const { instance, store, id, acknowledgements, deliveries } = retryRaceHarness(t);
  const clear = instance.handleClearCompleted(id);
  await waitUntil(() => acknowledgements.length === 1);
  const retry = instance.handleRetryDownload(id);
  await new Promise(resolve => setImmediate(resolve));
  acknowledgements.slice(1).forEach(ack => ack.resolve());
  await new Promise(resolve => setImmediate(resolve));
  acknowledgements[0].resolve();
  await Promise.all([clear, retry]);
  assert.equal(store.downloads.length, 0);
  assert.equal(deliveries.length, 0);
});

test('retry stays exclusive while same-source recovery checks await the streaming module', async (t) => {
  const { instance, store, id, acknowledgements, deliveries } = retryRaceHarness(t);
  store.updateDownload(id, { nativeAvailable: true });
  store.addDownload({ filename: 'older.mp4', url: base.url, status: 'interrupted', deliveryId: 'older-task' });
  const concurrent = [];
  globalThis.__uiDownloadStreaming.hasStreamingTask = () => {
    if (!concurrent.length) {
      concurrent.push(instance.handleRetryDownload(id), instance.handleClearCompleted(id));
      instance.handleBrowserDownload(id);
    }
    return false;
  };
  let retrySettled = false;
  const retry = instance.handleRetryDownload(id).then(() => { retrySettled = true; });
  await waitUntil(() => acknowledgements.length === 1);
  acknowledgements[0].resolve();
  await waitUntil(() => deliveries.length === 1);
  await new Promise(resolve => setImmediate(resolve));
  const confirmationCount = acknowledgements.length;
  const finishedBeforeDelivery = retrySettled;
  acknowledgements.slice(1).forEach(ack => ack.resolve());
  deliveries.forEach(delivery => delivery.finish());
  await Promise.all([retry, ...concurrent]);
  assert.equal(finishedBeforeDelivery, false, 'retry must own its asynchronous delivery until it settles');
  assert.equal(confirmationCount, 1, 'retry must stay locked before downloadFile assigns the new attempt');
  assert.equal(clicked.length, 0, 'source recovery must not hand off a second download while retry owns this card');
  assert.equal(store.downloads.some(task => task.id === id), true);
});

test('clear all reserves legacy segment cards before awaiting the first Worker acknowledgement', async (t) => {
  const { instance, store, acknowledgements } = retryRaceHarness(t);
  const id = store.addDownload({ filename: 'segments.mp4', status: 'failed', abortController: null,
    segments: ['https://media.test/segment-1.mp4', 'https://media.test/segment-2.mp4'] });
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('segment unavailable'); };
  const clear = instance.handleClearCompleted('all');
  await waitUntil(() => acknowledgements.length === 1);
  await instance.handleRetryDownload(id);
  const legacy = store.downloads.find(task => task.id === id);
  assert.equal(legacy.status, 'failed'); assert.equal(legacy.abortController, null);
  assert.equal(legacy.deliveryId, undefined); assert.equal(legacy.transport, undefined);
  acknowledgements[0].resolve(); await clear;
  assert.equal(requests, 0, 'a pending clear must reserve later cards before legacy retries can reuse their identity');
  assert.equal(store.downloads.length, 0);
});

for (const action of ['handleRetryDownload', 'handleClearCompleted']) {
  test(`${action} ignores a late acknowledgement after the card changes attempt`, async (t) => {
    const { instance, store, id, acknowledgements, deliveries } = retryRaceHarness(t);
    const pending = instance[action](id);
    await waitUntil(() => acknowledgements.length === 1);
    const controller = new AbortController();
    store.updateDownload(id, { deliveryId: 'new-task', abortController: controller, status: 'downloading' });
    acknowledgements[0].resolve(); await pending;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(store.downloads.length, 1);
    assert.equal(store.downloads[0].deliveryId, 'new-task');
    assert.equal(store.downloads[0].abortController, controller);
    assert.equal(deliveries.length, 0);
  });
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
  await waitUntil(() => probeSignal);
  await instance.handleCancelDownload(store.downloads[0].id);
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
      currentVideoUrl.value = 'https://new.test/work.mp4';
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
  assert.equal(store.downloads[0].averageSpeed, 4);
  assert.equal(store.downloads[0].transferElapsed, 1, 'preparation waits are excluded from transfer speed');
  tick(4000);
  assert.equal(store.downloads[0].speed, 0); assert.equal(store.downloads[0].elapsed, 9);
  bodyController.close(); await pending;
  assert.equal(store.downloads[0].status, 'completed'); assert.equal(store.downloads[0].elapsed, 9);
  assert.equal(store.downloads[0].transferred, 4); assert.equal(store.downloads[0].speed, 0);
  assert.equal(intervals.size, 0);
});

test('a stale source-link click never aborts an active transfer; recovery is available after cancellation', async () => {
  const { instance, store } = harness(base);
  let signal;
  mockFileTransfer(async (_, options) => new Promise((resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const id = store.addDownload({ filename: 'large.mp4', url: base.url });
  const pending = instance.downloadFile(base.url, 'large.mp4', id);
  await waitUntil(() => signal);
  instance.handleBrowserDownload(id);
  assert.equal(signal.aborted, false); assert.equal(clicked.length, 0);
  await instance.handleCancelDownload(id); await pending;
  assert.equal(store.downloads[0].status, 'cancelled');
  instance.handleBrowserDownload(id);
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
  assert.equal(store.resultData.items[0].default.url,first.url);
  assert.equal(store.resultData.items[1].default.url,second.url, 'server default is immutable; failover is selection state');
  assert.equal(currentVideoUrl.value, 'https://media.test/same-1.mp4');
});

test('a source-link click during failover is ignored and explicit cancellation preserves the recovery route', async () => {
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
  assert.equal(secondSignal.aborted, false); assert.equal(clicked.length, 0);
  await instance.handleCancelDownload(store.downloads[0].id);
  await settled(store.downloads[0]);
  instance.handleBrowserDownload(store.downloads[0].id);
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
  const pending = instance.downloadVideosAsZip([fixtureItem({index:2,url:'',_cid:'222'})]);
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


test('a ZIP uses the explicit source and does not reset to the first route', async () => {
  const data=fixture(retryData());const {instance,store,selection}=harness(data);
  selection.choose({variant_id:'v0',source_id:'s2'});
  await instance.downloadVideosAsZip(store.resultData.items);
  assert.equal(store.downloads[0].status,'completed');assert.deepEqual(fetched,['https://media.test/same-2.mp4']);
});

test('pending variants are visible but cannot call resolve or download a lower file under their name', async () => {
  const data=fixture(base);data.items[0].variants.push({id:'original-pending',state:'deferred',label:'原始入口（待解析）',provenance:'original_endpoint',reason:{code:'PENDING_CAPABILITY',message:'原始入口解析尚未接入'}});
  let resolves=0;const {instance,store,selection}=harness(data,async()=>{resolves++;return fixtureItem(base)});
  const html=await renderToString(createSSRApp({render:()=>h(ResultSection,{...resultProps(data),selection})}));
  assert.ok(html.includes('画质选项'));
  selection.choose({variant_id:'original-pending'});await instance.downloadMainVideo();
  assert.equal(store.downloads[0].status,'failed');assert.match(store.downloads[0].error,/待解析/);assert.equal(resolves,0);assert.equal(fetched.length,0);
});

test('a refreshed server default cannot overwrite the variant frozen when a task was created', async () => {
  const data=fixture({...base,video_backup:[{url:'https://media.test/lower.mp4',quality:'720p'}]});
  const item=data.items[0];item.resolve_url='/api/resolve?item_id='+item.id;
  item.variants[0].delivery.sources[0].expires_at='2020-01-01T00:00:00Z';item.default.expires_at='2020-01-01T00:00:00Z';
  let refreshes=0;const {instance,store}=harness(data,async()=>{
    refreshes++; const fresh=structuredClone(item);delete fresh.variants[0].delivery.sources[0].expires_at;
    fresh.default={variant_id:'v1',source_id:'s0',url:'https://media.test/lower.mp4'};return fresh;
  });
  await instance.downloadMainVideo();await settled(store.downloads[0]);
  assert.equal(refreshes,1);assert.equal(store.downloads[0].status,'completed');assert.ok(fetched.every(url=>url===base.url));
});

test('mixed albums keep their only video reachable after selecting an image',()=>{
  const data=fixture({...base,images:['https://media.test/picture.jpg']});const {selection}=harness(data);
  selection.selectItem('image-1');assert.equal(selection.currentVideo.value.type,'image');assert.equal(selection.isMulti.value,true);
  selection.selectIndex(0);assert.equal(selection.currentVideo.value.type,'video');assert.equal(selection.currentVideoUrl.value,base.url);
});
test('opaque item identifiers never collide with object prototype keys',()=>{
  for(const id of ['constructor','__proto__','toString']){
    const data=fixture(base);data.items[0].id=id;data.default_item_id=id;const {selection}=harness(data);
    assert.equal(selection.currentSelection.value,null);assert.equal(selection.currentTarget.value.kind,'file');selection.choose({variant_id:'v0',source_id:'s0'});assert.equal(selection.currentTarget.value.kind,'file');selection.resetDefault();assert.equal(selection.currentSelection.value,null);
  }
});

test('a disappeared explicit live-photo version cannot borrow a new pair for preview or download', async () => {
  const data = fixture({ ...base, url: null, live_photo: [{ image: 'https://media.test/old-live.jpg', video: 'https://media.test/old-live.mp4' }] });
  const { instance, store, selection, toasts } = harness(data);
  selection.choose({ variant_id: 'pair' });
  const refreshed = structuredClone(data.items[0]);
  refreshed.variants[0].id = 'replacement-pair';
  refreshed.variants[0].delivery.resources[0].delivery.sources[0].url = 'https://media.test/new-live.jpg';
  refreshed.variants[0].delivery.resources[1].delivery.sources[0].url = 'https://media.test/new-live.mp4';
  store.replaceItem(refreshed);
  const html = await renderToString(createSSRApp({ render: () => h(ResultSection, { ...resultProps(store.resultData), selection }) }));
  assert.doesNotMatch(html, /https:\/\/media.test\/new-live\.(?:mp4|jpg)/);
  instance.downloadLiveVideo(store.resultData.items[0]);
  instance.downloadLiveCover(store.resultData.items[0]);
  assert.equal(store.downloads.length, 0);
  assert.equal(fetched.length, 0);
  assert.equal(toasts.length, 2);
  assert.ok(toasts.every(([message]) => /所选实况版本已不可用/.test(message)));
  selection.resetDefault();
  instance.downloadLiveVideo(store.resultData.items[0]);
  await settled(store.downloads[0]);
  assert.equal(store.downloads[0].status, 'completed');
  assert.ok(fetched.every(url => url === 'https://media.test/new-live.mp4'));
});

test('live-photo ZIP rejects a short resource against its declared source size', async () => {
  for (const contentLength of [undefined, '4']) {
    const data = fixture({ ...base, url: null, live_photo: [{ image: 'https://media.test/live.jpg', video: 'https://media.test/live.mp4' }] });
    data.items[0].variants[0].delivery.resources[1].delivery.sources[0].size_bytes = 8;
    const { instance, store } = harness(data);
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), {
      headers: { 'content-type': 'video/mp4', ...(contentLength ? { 'content-length': contentLength } : {}) },
    });
    await instance.downloadAllMedia();
    assert.equal(store.downloads[0].status, 'failed');
    assert.match(store.downloads[0].error, /不完整/);
    assert.equal(clicked.length, 0);
    assert.equal(blobs.length, 0);
  }
});

test('ZIP names use the received MIME only when declared media metadata is absent', async () => {
  const data = fixture({ ...base, url: null, images: ['https://media.test/opaque-static'], live_photo: [{ image: 'https://media.test/opaque-cover', video: 'https://media.test/opaque-motion' }] });
  delete data.items[0].variants[0].metadata;
  for (const resource of data.items[1].variants[0].delivery.resources) delete resource.metadata;
  globalThis.fetch = async url => new Response(new Uint8Array([1, 2, 3, 4]), {
    headers: { 'content-type': url.endsWith('static') ? 'image/png' : url.endsWith('cover') ? 'image/jpeg' : 'video/mp4' },
  });
  const { instance, store } = harness(data);
  await instance.downloadAllMedia();
  assert.equal(store.downloads[0].status, 'completed');
  const zip = await JSZip.loadAsync(await blobs.at(-1).arrayBuffer());
  const names = Object.keys(zip.files);
  assert.equal(names.length, 3);
  assert.ok(names.some(name => name.endsWith('.png')));
  assert.ok(names.some(name => name.endsWith('_image.jpg')));
  assert.ok(names.some(name => name.endsWith('_motion.mp4')));
  assert.ok(names.every(name => !name.endsWith('.bin')));
});

test('a resolved live-photo pair is reused for archive construction and retry', async () => {
  const data = fixture({ ...base, url: null, live_photo: [{ image: 'https://media.test/live.jpg', video: 'https://media.test/live.mp4' }] });
  const fresh = structuredClone(data.items[0]);
  data.items[0].resolve_url = '/api/resolve?item_id=live-1';
  for (const resource of data.items[0].variants[0].delivery.resources) resource.delivery.sources[0].expires_at = '2020-01-01T00:00:00Z';
  let resolves = 0;
  const { instance, store, selection } = harness(data, async () => {
    resolves++;
    assert.equal(resolves, 1, 'the resolved snapshot must not be discarded');
    return fresh;
  });
  selection.choose({ variant_id: 'pair' });
  globalThis.fetch = async () => { throw new Error('temporary resource failure'); };
  await instance.downloadMainVideo();
  assert.equal(store.downloads[0].status, 'failed');
  assert.equal(resolves, 1);
  globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-type': 'video/mp4' } });
  instance.handleRetryDownload(store.downloads[0].id);
  await settled(store.downloads[0]);
  assert.equal(store.downloads[0].status, 'completed');
  assert.equal(resolves, 1);
});

test('a deferred ZIP item keeps its resolved variant and source across retry', async () => {
  const lazy = { id: 'part-2', type: 'video', state: 'deferred', default: null, default_unavailable_reason: 'needs_resolve', resolve_url: '/api/resolve?item_id=part-2' };
  const resolved = fixtureItem({ ...base, video_backup: [{ url: 'https://media.test/lower.mp4', quality: '720p' }] });
  resolved.id = lazy.id;
  resolved.resolve_url = lazy.resolve_url;
  let resolves = 0;
  const { instance, store } = harness({ platform: 'fixture', items: [lazy] }, async () => {
    resolves++;
    const fresh = structuredClone(resolved);
    if (resolves > 1) fresh.default = { variant_id: 'v1', source_id: 's0', url: 'https://media.test/lower.mp4' };
    return fresh;
  });
  const domainBefore = JSON.stringify(store.resultData);
  globalThis.fetch = async url => { fetched.push(url); throw new Error('temporary CDN failure'); };
  await instance.downloadVideosAsZip(store.resultData.items);
  assert.equal(store.downloads[0].status, 'failed');
  assert.equal(resolves, 1);
  globalThis.fetch = async url => { fetched.push(url); return sampleResponse(); };
  instance.handleRetryDownload(store.downloads[0].id);
  await settled(store.downloads[0]);
  assert.equal(store.downloads[0].status, 'completed');
  assert.equal(resolves, 1, 'retry reuses the resolved private snapshot');
  assert.deepEqual(fetched, [base.url, base.url], 'retry must not switch to a new server default');
  assert.equal(JSON.stringify(store.resultData), domainBefore, 'a ZIP task never writes its resolved state into the result store');
});
