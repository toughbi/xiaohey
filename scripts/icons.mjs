/**
 * Render the app icon set from one SVG: a black tile with two cream eyes,
 * a vertical bar and a `<` chevron. Run with:  node scripts/icons.mjs
 */
import { _electron } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join as pjoin } from 'node:path';

const root = pjoin(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = pjoin(root, 'build', 'icons');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

function iconSvg(size) {
  const small = size <= 32;
  const stroke = small ? 56 : 48;
  const barWidth = small ? 56 : 48;
  const barHeight = small ? 168 : 160;
  const barX = 161 - barWidth / 2;
  const barY = 256 - barHeight / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#242424"/>
      <stop offset="0.5" stop-color="#1b1b1b"/>
      <stop offset="1" stop-color="#101010"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.5" cy="0.08" r="0.8">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.05"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="104" fill="url(#tile)"/>
  <rect width="512" height="512" rx="104" fill="url(#sheen)"/>
  <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="${barWidth / 2}" fill="#f7ead9"/>
  <path d="M351 200 L257 256 L351 312" fill="none" stroke="#f7ead9" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.buffer.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.buffer)]);
}

await mkdir(outDir, { recursive: true });
const env = { ...process.env, XIAOHEY_HOME: pjoin(root, '.qa-homes', 'icon'), NODE_ENV: 'production' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.XIAOHEY_DEMO;
const app = await _electron.launch({
  executablePath: pjoin(root, 'node_modules/electron/dist/electron.exe'),
  args: ['.'],
  cwd: root,
  env,
});
const page = await app.firstWindow();
await page.waitForSelector('.app');
const rendered = [];
for (const size of SIZES) {
  await page.setContent(`<html><body style="margin:0;background:transparent;overflow:hidden">${iconSvg(size)}</body></html>`);
  await page.waitForTimeout(140);
  const buffer = await page.screenshot({ clip: { x: 0, y: 0, width: size, height: size }, omitBackground: true });
  rendered.push({ size, buffer });
  await writeFile(pjoin(outDir, `icon-${size}.png`), buffer);
}
const big = rendered.find((image) => image.size === 512).buffer;
await writeFile(pjoin(root, 'build', 'icon.png'), big);
await writeFile(pjoin(root, 'build', 'icon.ico'), ico(rendered.filter((image) => [16, 32, 48, 64, 128, 256].includes(image.size))));
await mkdir(pjoin(root, 'src', 'renderer', 'public'), { recursive: true });
await writeFile(pjoin(root, 'src', 'renderer', 'public', 'icon.png'), big);
console.log('icons written', SIZES.join(', '));
await app.close();
