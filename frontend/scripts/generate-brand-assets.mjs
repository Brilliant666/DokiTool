// Generate web-sized derivatives without changing the supplied artwork.
// Originals remain under brand-originals and are never served by Vite.
import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const source = new URL('../brand-originals/', import.meta.url);
const destination = new URL('../src/assets/brand/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const [input, output, width, height] of [
  ['dokitool-wordmark.png', 'dokitool-wordmark.png', 240, 80],
  ['dokitool-favicon.png', 'dokitool-icon-48.png', 48, 48],
  ['dokitool-favicon.png', 'dokitool-touch-180.png', 180, 180],
]) {
  const info = await sharp(fileURLToPath(new URL(input, source)))
    .resize(width, height, { fit: 'inside', withoutEnlargement: true })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(fileURLToPath(new URL(output, destination)));
  console.log(`${output}: ${info.width}x${info.height}, ${info.size} bytes`);
}
const platformInfo = await sharp(fileURLToPath(new URL('platforms/zuiyou.png', source)))
  .resize(96, 96, { fit: 'inside', withoutEnlargement: true })
  .png({ compressionLevel: 9, adaptiveFiltering: true })
  .toFile(fileURLToPath(new URL('../src/assets/platforms/zuiyou.png', import.meta.url)));
console.log(`zuiyou.png: ${platformInfo.width}x${platformInfo.height}, ${platformInfo.size} bytes`);
