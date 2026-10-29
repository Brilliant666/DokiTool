import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transformWithEsbuild } from 'vite';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, h, markRaw, nextTick, ref } from 'vue';

const require = createRequire(import.meta.url);
const originalGlobals = { window: globalThis.window, document: globalThis.document };
let ResultSection;
before(async () => {
  const utilities = await readFile(new URL('../src/utils/mediaSources.ts', import.meta.url), 'utf8');
  const sourceModule = { exports: {} };
  const sources = await transformWithEsbuild(utilities, 'mediaSources.ts', { loader: 'ts', format: 'cjs' });
  new Function('require', 'module', 'exports', sources.code)(require, sourceModule, sourceModule.exports);
  const content = await readFile(new URL('../src/components/ResultSection.vue', import.meta.url), 'utf8');
  const { descriptor } = parse(content);
  const script = compileScript(descriptor, { id: 'result-layout', inlineTemplate: true,
    templateOptions: { compilerOptions: { hoistStatic: false } } });
  const compiled = await transformWithEsbuild(script.content, 'ResultSection.js', { loader: 'js', format: 'cjs' });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.code)((id) => {
    if (id === './AppIcon.vue') return { __esModule: true, default: { render: () => h('i') } };
    if (id === './VideoPlaylist.vue') return { __esModule: true, default: { render: () => h('div', { class: 'test-playlist' }) } };
    if (id === '../utils/mediaSources') return sourceModule.exports;
    return require(id);
  }, module, module.exports);
  ResultSection = module.exports.default;
});
after(() => Object.assign(globalThis, originalGlobals));

const video = {
  url: 'https://media.test/main.mp4', quality: '1080p', width: 1080, height: 1920,
  codec: 'h264', bit_rate: 1000000, size: 3000000, duration: 24,
  type: 'video', title: '作品标题', _sourceUrl: 'https://www.douyin.com/video/123',
  author: { name: '作者', id: '123' }, images: [], live_photo: [],
  music: { url: 'https://media.test/music.mp3', title: '配乐' },
  extra: { statistics: { digg_count: 123 }, hashtags: [{ name: '标签' }] },
  video_backup: [{ url: 'https://media.test/small.mp4', quality: '720p', width: 720, height: 1280 }],
};
const hasClass = (node, name) => String(node.props.class || '').split(' ').includes(name);

// This renderer supplies measured dimensions rather than a CSS engine. It tests
// which panel controls the baseline, reactive updates, and lifecycle cleanup;
// actual flex sizing/scrollbars remain browser acceptance checks.
async function mount(data = video, desktop = true) {
  const dimensions = { details: 440, tabs: 44, author: 100, width: 380 };
  const listeners = new Map();
  const mediaListeners = new Set();
  const frames = new Map();
  const observers = [];
  let nextFrame = 0;
  let reads = 0;
  const mediaQuery = {
    matches: desktop,
    addEventListener: (_, callback) => mediaListeners.add(callback),
    removeEventListener: (_, callback) => mediaListeners.delete(callback),
  };
  globalThis.window = {
    innerWidth: desktop ? 1280 : 390,
    matchMedia: () => mediaQuery,
    addEventListener(type, callback) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener: (type, callback) => listeners.get(type)?.delete(callback),
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: id => frames.delete(id),
    getComputedStyle(node) {
      return hasClass(node, 'rs-info-col') ? { rowGap: '16px' }
        : { borderTopWidth: '1px', borderBottomWidth: '1px' };
    },
    ResizeObserver: class {
      nodes = new Set();
      disconnects = 0;
      constructor(callback) { this.callback = callback; observers.push(this); }
      observe(node) { this.nodes.add(node); }
      disconnect() { this.nodes.clear(); this.disconnects++; }
    },
  };
  globalThis.document = { body: { style: {} } };
  const element = (type, text = '') => markRaw({ type, text, props: {}, children: [], parent: null, style: {},
    removeAttribute() {}, getAttribute(name) { return this.props[name]; },
    getBoundingClientRect() {
      reads++;
      const height = hasClass(this, 'rs-tab-panel--details') ? dimensions.details
        : hasClass(this, 'rs-tabs') ? dimensions.tabs : hasClass(this, 'rs-card--author') ? dimensions.author : 0;
      return { width: dimensions.width, height };
    },
  });
  const detach = node => {
    if (node.parent) node.parent.children = node.parent.children.filter(item => item !== node);
    node.parent = null;
  };
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
  const state = ref({ resultData: data, resultVersion: 1, currentVideoUrl: data.url,
    locale: 'zh-CN', formatNumber: String, formatDuration: String,
    onSwitchVideo(source) { state.value = { ...state.value, currentVideoUrl: source.url }; },
  });
  const root = element('root');
  const app = renderer.createApp({ render: () => h(ResultSection, state.value) });
  const findAll = (node, match) => [...(match(node) ? [node] : []), ...node.children.flatMap(child => findAll(child, match))];
  const elements = className => findAll(root, node => hasClass(node, className));
  const text = node => [node.text, ...node.children.map(text)].join('');
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      await nextTick();
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback());
    }
    await nextTick();
    assert.equal(frames.size, 0, 'measurements must settle instead of scheduling an update loop');
  };
  app.mount(root);
  await flush();
  return {
    app, state, dimensions, observers, frames, mediaListeners, listeners, elements, flush,
    reads: () => reads,
    main: () => elements('rs-main')[0],
    details: () => elements('rs-tab-panel--details')[0],
    baseline: () => ({ ...elements('rs-main')[0].props.style }),
    async tab(label) {
      const tab = elements('rs-tab').find(node => text(node) === label);
      assert.ok(tab, `expected tab ${label}`); tab.props.onClick(); await flush();
    },
    async viewport(nextDesktop) {
      mediaQuery.matches = nextDesktop;
      window.innerWidth = nextDesktop ? 1280 : 390;
      for (const listener of mediaListeners) listener({ matches: nextDesktop });
      for (const listener of listeners.get('resize') || []) listener();
      await flush();
    },
    async resize() { observers.forEach(observer => observer.callback()); await flush(); },
  };
}

test('desktop single-video tabs use the natural details and author height, never the selected panel', async () => {
  const view = await mount();
  try {
    const baseline = { '--rs-details-card-height': '486px', '--rs-details-column-height': '602px' };
    assert.deepEqual(view.baseline(), baseline);
    const details = view.details();
    for (const tab of ['数据', '画质选项', '标签', '音乐']) {
      await view.tab(tab);
      assert.deepEqual(view.baseline(), baseline);
      assert.ok(hasClass(view.main(), 'rs-main--align-details'));
      assert.equal(view.details(), details, 'one stable details panel is used rather than duplicate interactive content');
      assert.ok(hasClass(details, 'rs-tab-panel--measure'));
      assert.equal(details.props['aria-hidden'], 'true');
      assert.equal(details.props.inert, '');
    }
    await view.tab('详情');
    assert.deepEqual(view.baseline(), baseline);
    assert.equal(view.details().props['aria-hidden'], undefined);
    assert.equal(view.details().props.inert, undefined);
    assert.ok(!hasClass(view.details(), 'rs-tab-panel--measure'));
  } finally { view.app.unmount(); }
});

test('hidden details remeasure on language, selected quality, title wrapping and author changes', async () => {
  const view = await mount();
  try {
    await view.tab('画质选项');
    view.dimensions.details = 510;
    view.state.value = { ...view.state.value, locale: 'en' };
    await view.flush();
    assert.equal(view.baseline()['--rs-details-column-height'], '672px');
    view.dimensions.details = 390;
    view.elements('rs-backup-item')[1].props.onClick();
    await view.flush();
    assert.equal(view.baseline()['--rs-details-column-height'], '552px');
    assert.equal(view.elements('rs-backup-playing')[0].parent, view.elements('rs-backup-hd')[1], 'selection status stays in the heading row');
    view.dimensions.details = 650;
    view.state.value = { ...view.state.value, resultData: { ...video, title: '长标题 '.repeat(40) } };
    await view.flush();
    assert.equal(view.baseline()['--rs-details-column-height'], '812px');
    view.dimensions.width = 320;
    view.dimensions.details = 700;
    await view.resize();
    assert.equal(view.baseline()['--rs-details-column-height'], '862px');
    view.dimensions.author = 140;
    await view.resize();
    assert.equal(view.baseline()['--rs-details-column-height'], '902px');
    view.state.value = { ...view.state.value, resultData: { ...video, author: undefined } };
    await view.flush();
    assert.equal(view.elements('rs-card--author').length, 0);
    assert.deepEqual(view.baseline(), { '--rs-details-card-height': '746px', '--rs-details-column-height': '746px' });
    view.dimensions.details = 400;
    view.dimensions.author = 100;
    view.state.value = { ...view.state.value, resultVersion: 2,
      resultData: { ...video, _sourceUrl: 'https://www.douyin.com/video/456' } };
    await view.flush();
    assert.equal(view.baseline()['--rs-details-column-height'], '562px', 'a new result replaces the previous baseline');
    assert.ok(!hasClass(view.details(), 'rs-tab-panel--measure'), 'a new result opens its visible details');
  } finally { view.app.unmount(); }
});

test('mobile stays in natural flow and entering desktop while another tab is open measures fresh details', async () => {
  const view = await mount(video, false);
  try {
    assert.deepEqual(view.baseline(), {});
    assert.ok(!hasClass(view.main(), 'rs-main--align-details'));
    await view.tab('音乐');
    assert.equal(view.details(), undefined, 'mobile does not retain a hidden measurement panel');
    await view.viewport(true);
    assert.equal(view.baseline()['--rs-details-column-height'], '602px');
    assert.ok(hasClass(view.details(), 'rs-tab-panel--measure'));
    await view.viewport(false);
    assert.deepEqual(view.baseline(), {});
    assert.equal(view.details(), undefined);
    assert.equal(view.observers[0].nodes.size, 0);
  } finally { view.app.unmount(); }
});

test('mixed media, live photos and multi-episode results retain their existing natural layout', async () => {
  const view = await mount();
  try {
    const cases = [
      [{ images: ['https://media.test/photo.jpg'] }, 'rs-card--gallery'],
      [{ type: 'live', live_photo: [{ image: 'https://media.test/photo.jpg', video: 'https://media.test/live.mp4' }] }, 'rs-live-carousel'],
      [{ live_photo: [{ image: 'https://media.test/photo.jpg', video: 'https://media.test/live.mp4' }] }, 'rs-live-carousel'],
      [{ videos: [video, { ...video, url: 'https://media.test/part2.mp4' }] }, 'test-playlist'],
      [{ type: 'collection', videos: [video] }, 'test-playlist'],
    ];
    for (const [changes, mediaClass] of cases) {
      view.state.value = { ...view.state.value, resultData: { ...video, ...changes } };
      await view.flush();
      assert.deepEqual(view.baseline(), {});
      assert.ok(!hasClass(view.main(), 'rs-main--align-details'));
      assert.equal(view.observers[0].nodes.size, 0);
      assert.ok(view.elements(mediaClass).length, `existing ${mediaClass} branch still renders`);
      await view.tab('数据');
      assert.equal(view.details(), undefined);
    }
    view.state.value = { ...view.state.value, resultData: video };
    await view.flush();
    assert.equal(view.baseline()['--rs-details-column-height'], '602px');
  } finally { view.app.unmount(); }
});

test('unmount cancels queued work and detaches layout observers and listeners', async () => {
  const view = await mount();
  view.observers[0].callback();
  await nextTick();
  assert.equal(view.frames.size, 1);
  const reads = view.reads();
  view.app.unmount();
  assert.equal(view.frames.size, 0);
  assert.equal(view.mediaListeners.size, 0);
  assert.equal(view.listeners.get('resize').size, 0);
  assert.equal(view.observers[0].nodes.size, 0);
  view.observers[0].callback();
  await view.flush();
  assert.equal(view.reads(), reads, 'late observer callbacks cannot measure a removed result');
});
