// Compose a share card from the unchanged supplied wordmark and an SVG layout.
// Regenerate with: node scripts/generate-social-image.mjs
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const wordmark = await readFile(new URL('../brand-originals/dokitool-wordmark.png', import.meta.url));
const output = new URL('../public/social/dokitool-share-v1.png', import.meta.url);
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="background" x2="1" y2="1">
      <stop stop-color="#ffffff"/><stop offset="1" stop-color="#f1efff"/>
    </linearGradient>
    <linearGradient id="accent" x2="1">
      <stop stop-color="#725bff"/><stop offset="1" stop-color="#b04ee8"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#background)"/>
  <circle cx="1110" cy="66" r="200" fill="#e9e3ff" opacity=".6"/>
  <circle cx="1145" cy="655" r="255" fill="#e0eaff" opacity=".55"/>
  <rect x="64" y="64" width="7" height="502" rx="3.5" fill="url(#accent)"/>
  <image href="data:image/png;base64,${wordmark.toString('base64')}" x="100" y="64" width="360" height="120"/>
  <g font-family="Microsoft YaHei, Noto Sans CJK SC, sans-serif">
    <text x="110" y="270" fill="#1e293b" font-size="60" font-weight="700">多平台分享链接解析</text>
    <text x="112" y="341" fill="#64748b" font-size="30">视频与图片 · 资源预览与下载</text>
    <text x="112" y="418" fill="#64748b" font-size="24">抖音 · 快手 · B站 · 小红书 · 今日头条</text>
    <text x="112" y="459" fill="#64748b" font-size="24">微博 · 皮皮虾 · 皮皮搞笑 · 最右</text>
    <text x="112" y="550" fill="#6655d9" font-size="26">snap.dokitool.com</text>
  </g>
</svg>`;

await mkdir(new URL('./', output), { recursive: true });
const info = await sharp(Buffer.from(svg))
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(fileURLToPath(output));
console.log(`dokitool-share-v1.png: ${info.width}x${info.height}, ${info.size} bytes`);
