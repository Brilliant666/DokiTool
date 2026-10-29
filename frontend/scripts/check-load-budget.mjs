// Inspect the production import graph, not a warmed developer browser.
// This is a transfer-size regression guard, not an LCP/weak-network benchmark.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const dist = new URL('../dist/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('.vite/manifest.json', dist), 'utf8'));
const keys = new Set();
const files = new Set(['index.html']);
function visit(key) {
  if (keys.has(key)) return;
  keys.add(key);
  const entry = manifest[key];
  assert.ok(entry, `Missing manifest entry: ${key}`);
  for (const file of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) files.add(file);
  for (const dependency of entry.imports ?? []) visit(dependency);
}
visit('index.html');
const resultKey = 'src/components/ResultSection.vue';
const zipKey = Object.keys(manifest).find(key => manifest[key].name === 'jszip.min');
assert.ok(manifest[resultKey]?.isDynamicEntry, 'Result UI must remain an independent async chunk');
assert.ok(zipKey && manifest[zipKey].isDynamicEntry, 'ZIP must remain an independent async chunk');
assert.ok(!keys.has(resultKey) && !keys.has(zipKey), 'Result UI/ZIP must not be in the initial static import graph');
const assetNames = await readdir(new URL('assets/', dist));
assert.ok(!assetNames.some(name => /\.(woff2?|ttf|otf)$/i.test(name)), 'UI must not regain external font dependencies');

const measured = [];
for (const file of [...files].sort()) {
  const data = await readFile(new URL(file, dist));
  const gzip = /\.(html|js|css|svg)$/.test(file);
  measured.push({ file, rawBytes: data.length, estimatedTransferBytes: gzip ? gzipSync(data).length : data.length });
}
const sum = predicate => measured.filter(predicate).reduce((bytes, file) => bytes + file.estimatedTransferBytes, 0);
const summary = {
  initialJavaScriptBytes: sum(file => file.file.endsWith('.js')),
  initialCssBytes: sum(file => file.file.endsWith('.css')),
  conservativeInitialBytes: sum(() => true),
  budgets: { initialJavaScriptBytes: 100000, initialCssBytes: 16000, conservativeInitialBytes: 240000 },
  note: 'Text estimated with gzip; counts all static images including lazy platform artwork and the touch icon. Excludes API/media. Does not measure LCP, browser caches, connection latency or CPU.',
  files: measured,
};
for (const [metric, budget] of Object.entries(summary.budgets)) {
  assert.ok(summary[metric] <= budget, `${metric}: ${summary[metric]} exceeds ${budget}`);
}
console.log(JSON.stringify(summary, null, 2));
