import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transformWithEsbuild } from 'vite';
import { parse, compileScript } from '@vue/compiler-sfc';
import { createRenderer, createSSRApp, h, markRaw, nextTick, ref } from 'vue';
import { renderToString } from '@vue/server-renderer';

const require = createRequire(import.meta.url);
let icons, AppIcon;
before(async () => {
  const source = await readFile(new URL('../src/utils/iconPaths.ts', import.meta.url), 'utf8');
  const paths = await transformWithEsbuild(source, 'iconPaths.ts', { loader: 'ts', format: 'cjs' });
  const dataModule = { exports: {} };
  new Function('require', 'module', 'exports', paths.code)(require, dataModule, dataModule.exports);
  icons = dataModule.exports;
  const { descriptor } = parse(await readFile(new URL('../src/components/AppIcon.vue', import.meta.url), 'utf8'));
  const script = compileScript(descriptor, { id: 'icon-test', inlineTemplate: true });
  const code = await transformWithEsbuild(script.content, 'AppIcon.ts', { loader: 'ts', format: 'cjs' });
  const componentModule = { exports: {} };
  new Function('require', 'module', 'exports', code.code)(
    (id) => id === '../utils/iconPaths' ? icons : require(id), componentModule, componentModule.exports,
  );
  AppIcon = componentModule.exports.default;
});

test('every icon used by templates and dynamic status/platform maps has a local SVG', async () => {
  async function collect(folder) {
    const entries = await readdir(folder, { withFileTypes: true });
    const files = await Promise.all(entries.map(entry => {
      const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), folder);
      return entry.isDirectory() ? collect(url) : /\.(vue|ts|js)$/.test(entry.name) && entry.name !== 'iconPaths.ts'
        ? readFile(url, 'utf8').then(text => [text]) : [];
    }));
    return files.flat();
  }
  const names = new Set((await collect(new URL('../src/', import.meta.url))).flatMap(text => [...text.matchAll(/\bfa-[a-z0-9-]+/g)].map(match => match[0])));
  names.delete('fa-spin');
  for (const name of names) assert.ok(icons.iconForClass(name), `missing SVG: ${name}`);
  assert.ok(names.size > 50, 'exercise icons throughout the application');
});

test('icons render vectors with inherited classes and remain decorative to assistive technology', async () => {
  const html = await renderToString(createSSRApp({ render: () => h(AppIcon, {
    class: ['fas text-indigo-500', { 'fa-check-circle': true, 'fa-times': false }],
    style: { fontSize: '20px' },
  }) }));
  assert.match(html, /<i[^>]+class="app-icon fas text-indigo-500 fa-check-circle"/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /<svg[^>]+viewBox="0 0 512 512"/);
  assert.match(html, /<path d="M256 512/);
  assert.doesNotMatch(html, /[\uE000-\uF8FF]|<use|https?:\/\/(?!www\.w3\.org)/);
});

test('reactive theme and loading class changes replace the rendered path without remounting', async () => {
  const element = type => markRaw({ type, props: {}, children: [], parent: null });
  const renderer = createRenderer({
    createElement: element,
    createText: text => ({ type: '#text', text }), createComment: text => ({ type: '#comment', text }),
    setText(node, text) { node.text = text; }, setElementText(node, text) { node.text = text; },
    parentNode: node => node.parent, nextSibling: () => null,
    insert(node, parent) { node.parent = parent; parent.children.push(node); },
    remove(node) { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); },
    patchProp(node, key, _, value) { node.props[key] = value; },
  });
  const classes = ref('fas fa-moon text-sm');
  const root = element('root');
  const app = renderer.createApp({ render: () => h(AppIcon, { class: classes.value }) });
  app.mount(root);
  const wrapper = root.children[0];
  const path = () => wrapper.children.find(node => node.type === 'svg').children.find(node => node.type === 'path').props.d;
  assert.equal(path(), icons.iconForClass('fa-moon').path);
  classes.value = 'fas fa-sun text-sm'; await nextTick();
  assert.equal(root.children[0], wrapper);
  assert.equal(path(), icons.iconForClass('fa-sun').path);
  classes.value = 'fas fa-spinner fa-spin'; await nextTick();
  assert.equal(path(), icons.iconForClass('fa-spinner').path);
  assert.match(wrapper.props.class, /fa-spin/);
  app.unmount();
});
