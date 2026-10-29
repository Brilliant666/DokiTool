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
    if (id === './AppIcon.vue') return { __esModule: true, default: { render: () => h('i') } };
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
    elements: className => findAll(root, node => String(node.props.class).split(' ').includes(className)),
    textOf: text,
    copy: () => buttons().find(node => node.children.some(child => String(child.props.class).includes('fa-copy'))).props.onClick(),
    async showQualities() { buttons().find(node => text(node).includes('画质选项')).props.onClick(); await nextTick(); },
    async showStats() { buttons().find(node => text(node).includes('数据')).props.onClick(); await nextTick(); },
    async showInfo() { buttons().find(node => text(node).includes('详情')).props.onClick(); await nextTick(); },
    async fail(player = this.player()) { player.currentSrc = player.src; player.props.onError({ currentTarget: player }); await nextTick(); },
    text: () => text(root),
  };
}

test('quality UI groups formats and does not call a lower-bitrate original endpoint original quality', async () => {
  const view = await mount({ ...base, is_original: true, metadata_source: 'mp4', video_backup: [
    ...base.video_backup, { ...format, url: url('original-unverified'), bit_rate: 60000000, is_original: true },
    { quality: 'unknown', url: url('unknown') },
  ] });
  try {
    await view.showQualities();
    assert.equal(view.choices().length, 3);
    assert.equal(view.text().split('原始入口').length - 1, 1);
    assert.doesNotMatch(view.text(), /原画/);
    assert.match(view.text(), /4 条线路/);
  } finally { view.app.unmount(); }
});

test('quality names and decimal file sizes distinguish original 4K from compressed 4K and follow the active route', async () => {
  const low = { ...format, bit_rate: 1800000 };
  const view = await mount({ ...base, bit_rate: 52619915, size: 60342212,
    is_original: true, metadata_source: 'mp4', video_backup: [
      { ...low, url: url('lower-a'), size: 2051199 },
      { ...low, url: url('lower-b'), size: 2200000 },
      { ...format, url: url('missing-size'), bit_rate: 900000, size_label: '999 MB' },
    ] });
  try {
    assert.equal(view.textOf(view.elements('rs-quality-tag')[0]), '原画');
    assert.match(view.text(), /画质原画/);
    await view.showQualities();
    assert.deepEqual(view.elements('rs-backup-name').map(view.textOf), ['60.3 MB · 原画', '2.1 MB · 2160p', '大小未知 · 2160p']);
    assert.match(view.text(), /2 条线路/);
    view.choices()[1].props.onClick(); await nextTick();
    assert.equal(view.textOf(view.elements('rs-quality-tag')[0]), '2160p');
    await view.fail();
    assert.equal(view.player().src, url('lower-b'));
    assert.equal(view.textOf(view.elements('rs-backup-name')[1]), '2.2 MB · 2160p');
    await view.showInfo();
    assert.match(view.text(), /画质2160p/);
  } finally { view.app.unmount(); }
});

test('a 720p original endpoint never outranks 4K and an unverified original label never claims original quality', async () => {
  const view = await mount({ ...base, video_backup: [
    { ...format, quality: 'original', width: 720, height: 1280, url: url('720-original'),
      is_original: true, metadata_source: 'mp4', size: 12376415 },
    { url: url('unverified'), quality: 'original', size: 5000000 },
  ] });
  try {
    await view.showQualities();
    assert.deepEqual(view.elements('rs-backup-name').map(view.textOf), ['大小未知 · 2160p', '12.4 MB · 720p', '5.0 MB · 画质未知']);
    assert.match(view.text(), /原始入口/);
    view.choices()[1].props.onClick(); await nextTick();
    assert.equal(view.textOf(view.elements('rs-quality-tag')[0]), '720p');
    assert.doesNotMatch(view.text(), /原画/);
  } finally { view.app.unmount(); }
});

test('invalid or absent byte counts stay unknown and sizes use decimal MB', () => {
  for (const invalid of [undefined, null, '', ' ', true, {}, 0, -1, Infinity, 1.5, 'broken']) {
    assert.equal(sources.formatMediaSize(invalid), '大小未知');
  }
  assert.equal(sources.formatMediaSize(1000000), '1.0 MB');
  assert.equal(sources.formatMediaSize('60342212'), '60.3 MB');
  assert.equal(sources.formatMediaSize(1), '<0.1 MB');
  assert.equal(sources.formatMediaSize(undefined, 'en'), 'Size unknown');
});

test('Douyin zero plays show an explained unknown without overwriting real zeros or raw statistics', async () => {
  const statistics = { play_count: 0, digg_count: 0, comment_count: 1031 };
  const view = await mount({ ...base, extra: { statistics } });
  try {
    await view.showStats();
    assert.deepEqual(view.elements('rs-stat-num').map(view.textOf), ['—', '0', '1031']);
    assert.equal(view.elements('rs-stat-num')[0].props['aria-describedby'], 'rs-play-count-note');
    assert.match(view.text(), /上游返回 0，实际播放量暂无法核实/);
    assert.equal(statistics.play_count, 0);
    view.state.value = { ...view.state.value, resultData: { ...base, extra: { statistics: { ...statistics, play_count: 120 } } } };
    await nextTick();
    assert.equal(view.textOf(view.elements('rs-stat-num')[0]), '120');
    assert.equal(view.elements('rs-stat-note').length, 0);
  } finally { view.app.unmount(); }
});

test('other platforms retain zero plays, missing plays are omitted, and explicit platform works without an input URL', async () => {
  for (const data of [
    { ...base, platform: 'bilibili' },
    { ...base, _sourceUrl: 'https://www.weibo.com/123' },
    { ...base, _sourceUrl: 'https://douyin.com.example.test/123' },
  ]) {
    const view = await mount({ ...data, extra: { statistics: { play_count: 0, digg_count: 0 } } });
    try {
      await view.showStats();
      assert.deepEqual(view.elements('rs-stat-num').map(view.textOf), ['0', '0']);
      assert.equal(view.elements('rs-stat-note').length, 0);
    } finally { view.app.unmount(); }
  }
  const missing = await mount({ ...base, extra: { statistics: { digg_count: 0 } } });
  try { await missing.showStats(); assert.deepEqual(missing.elements('rs-stat-label').map(missing.textOf), ['点赞']); }
  finally { missing.app.unmount(); }
  const explicit = await mount({ ...base, _sourceUrl: undefined, platform: '抖音', extra: { statistics: { play_count: 0 } } });
  try {
    await explicit.showStats();
    assert.equal(explicit.textOf(explicit.elements('rs-stat-num')[0]), '—');
    explicit.state.value = { ...explicit.state.value, locale: 'en' }; await nextTick();
    assert.match(explicit.text(), /actual play count cannot currently be verified/);
  } finally { explicit.app.unmount(); }
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
