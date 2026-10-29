import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist/index.html');
const template = await readFile(output, 'utf8');
assert.ok(template.includes('<div id="app"></div>'), 'Expected the clean client build before prerendering');

// Vue exposes its renderer at the same locked version as the client runtime.
// The temporary server bundle is never copied into the static release.
await build({
  root,
  build: {
    ssr: 'src/ssr/entry-server.ts',
    outDir: '.ssg',
    emptyOutDir: true,
    copyPublicDir: false,
    manifest: false,
    minify: false,
    rollupOptions: { output: { entryFileNames: 'entry-server.mjs' } },
  },
});
const { renderHome } = await import(pathToFileURL(path.join(root, '.ssg/entry-server.mjs')).href);
const markup = await renderHome();
assert.ok(markup.includes('data-initial-url'), 'The prerendered homepage must expose the editable URL input');
assert.ok(markup.includes('正在准备'), 'The prerendered parser must honestly indicate it is not interactive yet');

// Runs before the stylesheet, touching only <html> (outside Vue's subtree).
// Storage access is optional: private/restricted browsing must still render.
const themeBootstrap = `<script id="dokitool-theme-bootstrap">(()=>{let t;try{t=localStorage.getItem('theme')}catch{}const d=t==='dark'||(t!=='light'&&!!window.matchMedia?.('(prefers-color-scheme: dark)').matches);document.documentElement.classList.toggle('dark',d);document.documentElement.style.colorScheme=d?'dark':'light'})()</script>`;
const noScript = '<noscript><p style="padding:1rem;text-align:center">页面内容已显示；解析和下载需要 JavaScript，请启用后重试。</p></noscript>';
const html = template
  .replace('<div id="app"></div>', `<div id="app" data-prerendered="true">${markup}</div>${noScript}`)
  .replace(/(<meta charset="UTF-8"\s*\/>)/i, `$1\n    ${themeBootstrap}`);
assert.ok(html.includes(themeBootstrap), 'The early theme bootstrap must precede the page styles');
await writeFile(output, html, 'utf8');
console.log(`Prerendered the existing Vue homepage (${Buffer.byteLength(html)} HTML bytes); no runtime server required.`);
