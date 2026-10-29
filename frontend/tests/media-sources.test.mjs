import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transformWithEsbuild } from 'vite';
import { parse, compileScript } from '@vue/compiler-sfc';
import { computed, createRenderer, h, markRaw, nextTick, ref } from 'vue';

const require = createRequire(import.meta.url);
let sources, selectSource, ResultSection;
const originals = { window: globalThis.window, document: globalThis.document };
before(async () => {
  async function load(relative) {
    const content = await readFile(new URL(relative, import.meta.url), 'utf8');
    const compiled = await transformWithEsbuild(content, relative, { loader: 'ts', format: 'cjs' });
    const module = { exports: {} };
    new Function('require', 'module', 'exports', compiled.code)(require, module, module.exports);
    return module.exports;
  }
  sources = await load('../src/utils/mediaSources.ts');
  selectSource = (await load('../src/utils/mediaSource.ts')).selectMediaSource;
  const content = await readFile(new URL('../src/components/ResultSection.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(content);
  const script = compileScript(descriptor, { id: 'media-sources', inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } } });
  const compiled = await transformWithEsbuild(script.content, 'ResultSection.js', { loader: 'js', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.code)((id) => {
    if (id === './VideoPlaylist.vue') return { __esModule: true, default: { render: () => null } };
    if (id === '../utils/mediaSources') return sources;
    return require(id);
  }, module, module.exports);
  ResultSection = module.exports.default;
  globalThis.window = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = { body: { style: {} } };
});
after(() => Object.assign(globalThis, originals));

const format = { quality: '2160p', width: 2160, height: 3840, bit_rate: 5058706, codec: 'hevc' };
const url = (route) => `https://media.test/${route}.mp4`;
const base = {
  ...format, url: url('a'), type: 'video', title: '测试', _sourceUrl: 'https://www.douyin.com/video/123',
  images: [], live_photo: [], music: {}, extra: {},
  video_backup: ['b', 'c', 'd'].map(route => ({ ...format, url: url(route) })),
};

test('identical encodings group their routes without merging codecs, raw bitrates or unknown sources', () => {
  const data = { ...base, video_backup: [
    { ...format, url: url('b'), codec: 'H.265' },
    { ...format, url: url('a') },
    { ...format, url: url('different-codec'), codec: 'h264' },
    { ...format, url: url('different-bitrate'), bit_rate: 5058707 },
    { quality: 'unknown', url: url('unknown-a') },
    { quality: 'unknown', url: url('unknown-b') },
    { quality: '2160p', url: url('unverified-a') },
    { quality: '2160p', url: url('unverified-b') },
  ] };
  const groups = sources.groupMediaSources(data);
  assert.equal(groups.length, 7);
  assert.deepEqual(groups[0].sources.map(item => item.url), [url('a'), url('b')]);
  assert.deepEqual(sources.getSameQualityUrls(data, url('b')), [url('b'), url('a')]);
  assert.deepEqual(sources.getSameQualityUrls(data, url('unknown-a')), [url('unknown-a')]);
  assert.deepEqual(sources.getSameQualityUrls(data, url('unrecognised')), [url('unrecognised')]);
});

test('explicit gear IDs can group incomplete metadata but never override conflicting known encoding details', () => {
  const data = { url: url('a'), gear_id: 'vendor-format-1', codec: 'h264', video_backup: [
    { url: url('b'), gear_id: 'vendor-format-1', codec: 'avc1' },
    { url: url('c'), gear_id: 'vendor-format-1', codec: 'hevc' },
    { url: url('d'), gear_name: 'vendor-format-1', codec: 'h264' },
  ] };
  assert.deepEqual(sources.getSameQualityUrls(data, url('a')), [url('a'), url('b')]);
  assert.equal(sources.groupMediaSources(data).length, 3);
});

test('source changes preserve original-file provenance on its own route and clear it on other routes', () => {
  const original = { ...format, index: 1, url: url('original'), original_url: url('cdn'),
    playback_url: '/api/media/weibo?ticket=a.b', media_delivery: 'weibo-relay',
    is_original: true, metadata_source: 'mp4', size: 60342212, segments: [url('old-segment')],
    video_backup: [{ ...format, url: url('b') }] };
  const normalized = sources.getMediaSources(original)[0];
  assert.equal(normalized.is_original, true);
  assert.equal(normalized.metadata_source, 'mp4');
  const changed = selectSource(original, original.video_backup[0]);
  assert.equal(changed.is_original, undefined);
  assert.equal(changed.metadata_source, undefined);
  assert.equal(changed.original_url, undefined);
  assert.equal(changed.segments, undefined);
  const restored = selectSource(changed, changed.video_backup.find(item => item.url === original.url));
  assert.equal(restored.is_original, true);
  assert.equal(restored.metadata_source, 'mp4');
  assert.equal(restored.size, original.size);
  assert.equal(restored.original_url, original.original_url);
});

async function mount(data, selection) {
  const element = (type, text = '') => markRaw({ type, text, props: {}, children: [], parent: null, style: {}, removeAttribute() {}, getAttribute(name) { return this.props[name]; } });
  const detach = (node) => { if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node); node.parent = null; };
  const portal = element('portal');
  const renderer = createRenderer({
    querySelector: () => portal,
    createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; node.children = []; },
    parentNode: node => node.parent, nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    insert(node, parent, anchor) { detach(node); node.parent = parent; const index = parent.children.indexOf(anchor); parent.children.splice(index < 0 ? parent.children.length : index, 0, node); },
    remove: detach,
    patchProp(node, key, _, value) { node.props[key] = value; if (key === 'src') node.src = value; },
  });
  const switched = [], copied = [];
  const state = ref({ resultData: data, resultVersion: 1, selection: selection ? markRaw(selection) : undefined, currentVideoUrl: data.url,
    locale: 'zh-CN', formatNumber: String, formatDuration: String,
    onSwitchVideo(source) {
      switched.push(source.url);
      if (selection) selection.currentVideo.value = selectSource(selection.currentVideo.value, source);
      state.value = { ...state.value, currentVideoUrl: source.url };
    }, onCopyUrl(value) { copied.push(value); },
  });
  const root = element('root');
  const app = renderer.createApp({ render: () => h(ResultSection, state.value) });
  app.mount(root); await nextTick();
  const findAll = (node, match) => [...(match(node) ? [node] : []), ...node.children.flatMap(child => findAll(child, match))];
  const text = node => [node.text, ...node.children.map(text)].join('');
  const buttons = () => findAll(root, node => node.type === 'button');
  return { app, state, switched, copied,
    player: () => findAll(root, node => node.type === 'video')[0],
    alert: () => findAll(root, node => node.props.role === 'alert')[0],
    choices: () => buttons().filter(node => String(node.props.class).split(' ').includes('rs-backup-item')),
    copy: () => buttons().find(node => node.children.some(child => String(child.props.class).includes('fa-copy'))).props.onClick(),
    async showQualities() { buttons().find(node => text(node).includes('画质选项')).props.onClick(); await nextTick(); },
    async fail(player = this.player()) { player.currentSrc = player.src; player.props.onError({ currentTarget: player }); await nextTick(); },
    text: () => text(root),
  };
}

test('quality UI renders one choice per format and only labels probed original files', async () => {
  const view = await mount({ ...base, is_original: true, metadata_source: 'mp4', video_backup: [
    ...base.video_backup, { ...format, url: url('original-unverified'), bit_rate: 60000000, is_original: true },
    { quality: 'unknown', url: url('unknown') },
  ] });
  try {
    await view.showQualities();
    assert.equal(view.choices().length, 3);
    assert.equal(view.text().split('原始文件').length - 1, 1);
    assert.match(view.text(), /4 条线路/);
  } finally { view.app.unmount(); }
});

test('playback tries at most two same-quality alternatives, ignores old events, and manual/new-result choices reset attempts', async () => {
  const view = await mount({ ...base, video_backup: [...base.video_backup,
    { ...format, width: 1080, height: 1920, url: url('lower') }] });
  try {
    const old = view.player();
    await view.fail(); assert.equal(view.player().src, url('b')); assert.equal(view.alert(), undefined);
    await view.fail(old); assert.deepEqual(view.switched, [url('b')]);
    view.copy(); assert.equal(view.copied.at(-1), url('b'));
    await view.fail(); assert.equal(view.player().src, url('c'));
    await view.fail(); assert.ok(view.alert());
    assert.deepEqual(view.switched, [url('b'), url('c')], 'fourth route and lower quality must not be tried');
    await view.showQualities();
    const beforeManual = view.player(); view.choices()[0].props.onClick();
    beforeManual.props.onError({ currentTarget: beforeManual }); await nextTick();
    assert.equal(view.player().src, url('c'), 'an event from the old DOM during the render gap is stale');
    assert.equal(view.alert(), undefined);
    await view.fail(); assert.equal(view.player().src, url('a'), 'manual re-selection resets the bounded attempt budget');
    view.state.value = { ...view.state.value, resultVersion: 2, currentVideoUrl: base.url }; await nextTick();
    await view.fail(); assert.equal(view.player().src, url('b'));
  } finally { view.app.unmount(); }
});

test('unknown sources do not auto-switch to another unknown or a known lower quality', async () => {
  const view = await mount({ ...base, quality: 'unknown', video_backup: [
    { quality: 'unknown', url: url('unknown') }, { ...format, url: url('known') },
  ] });
  try { await view.fail(); assert.ok(view.alert()); assert.deepEqual(view.switched, []); }
  finally { view.app.unmount(); }
});

test('multi-P failover updates the selected episode and resets its budget when the episode changes', async () => {
  const episode = index => ({ ...format, index, url: url('a'), video_backup: [{ ...format, url: url('b') }] });
  const videos = [episode(1), episode(2)];
  const currentVideo = ref(videos[0]);
  const selection = { currentVideo, currentVideoUrl: computed(() => currentVideo.value.url),
    visibleList: ref(videos), selectedIndex: ref(0), collections: ref([]), sectionIndex: ref(0),
    selectedCount: ref(0), total: ref(2), selectedSet: ref(new Set()) };
  const view = await mount({ ...base, videos }, selection);
  try {
    await view.fail(); assert.equal(currentVideo.value.url, url('b'));
    view.copy(); assert.equal(view.copied.at(-1), url('b'));
    const previousPlayer = view.player();
    currentVideo.value = videos[1]; selection.selectedIndex.value = 1; await nextTick();
    assert.notEqual(view.player(), previousPlayer);
    await view.fail(); assert.equal(currentVideo.value.url, url('b'));
    await view.fail(previousPlayer); assert.deepEqual(view.switched, [url('b'), url('b')]);
    await view.fail(); assert.ok(view.alert());
  } finally { view.app.unmount(); }
});
