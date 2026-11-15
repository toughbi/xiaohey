// QA pass 14: brand mark expressions on hover, icon set files, ICO structure.
// node .qa/run-14.mjs
import { _electron } from 'playwright-core';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'E:/code/xiaohei';
const shots = join(root, '.qa');
const homes = join(root, '.qa-homes');
const results = [];
let page;
let app;

const log = (id, name, status, detail = '') => {
  results.push({ id, name, status, detail });
  console.log(`${status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'WARN'}  ${id}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function test(id, name, fn) {
  try {
    const detail = await fn();
    log(id, name, 'pass', detail ?? '');
  } catch (error) {
    log(id, name, 'fail', error?.message ?? String(error));
    try {
      await page.screenshot({ path: join(shots, `fail-${id}.png`) });
    } catch {}
  }
}

const home = join(homes, 'brand');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'demo-workspace'), XIAOHEY_DEMO: '1' };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(1500);

const mark = page.locator('.titlebar .brand-mark');

await test('I1', 'the titlebar shows the new mark in its idle expression', async () => {
  if ((await mark.count()) !== 1) throw new Error('missing mark');
  const expression = await mark.getAttribute('data-expression');
  if (expression !== 'idle') throw new Error(`expression: ${expression}`);
});

await test('I2', 'hover switches it to the happy face', async () => {
  await mark.hover();
  await page.waitForTimeout(450);
  const expression = await mark.getAttribute('data-expression');
  if (expression !== 'happy') throw new Error(`expression: ${expression}`);
  await page.screenshot({ path: join(shots, 'brand-happy.png'), clip: { x: 0, y: 0, width: 260, height: 44 } });
});

await test('I3', 'pressing pops the surprised face', async () => {
  const box = await mark.boundingBox();
  if (!box) throw new Error('no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(200);
  const expression = await mark.getAttribute('data-expression');
  await page.mouse.up();
  if (expression !== 'surprised') throw new Error(`expression: ${expression}`);
});

await test('I4', 'leaving restores the idle face', async () => {
  await page.mouse.move(700, 400);
  await page.waitForTimeout(350);
  const expression = await mark.getAttribute('data-expression');
  if (expression !== 'idle') throw new Error(`expression: ${expression}`);
});

await test('I5', 'the icon set is complete and the ICO holds every size', async () => {
  const sizes = [16, 24, 32, 48, 64, 128, 256, 512];
  for (const size of sizes) {
    const info = await stat(join(root, 'build', 'icons', `icon-${size}.png`)).catch(() => null);
    if (!info || info.size < 100) throw new Error(`missing icon-${size}.png`);
  }
  const ico = await readFile(join(root, 'build', 'icon.ico'));
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1) throw new Error('not an ICO');
  const count = ico.readUInt16LE(4);
  if (count !== 6) throw new Error(`ico entries: ${count}`);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 16;
    entries.push(ico.readUInt8(offset) || 256);
  }
  return `${sizes.length} PNGs, ICO ${entries.join('/')}`;
});

if (app) await app.close();
const failed = results.filter((entry) => entry.status === 'fail');
await (await import('node:fs/promises')).writeFile(join(shots, 'results-14.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
