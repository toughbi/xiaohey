// QA pass 30: composer footer order + clickable workspace chip.
// node .qa/run-30.mjs
import { _electron } from 'playwright-core';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

const home = join(homes, 'footer');
const first = join(home, 'workspace');
const third = join(home, 'third-workspace');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(first, { recursive: true });
await mkdir(third, { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    models: [
      {
        id: 'm',
        name: 'Fake',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'x',
        model: 'fake',
        temperature: 0,
        maxOutputTokens: 128,
        contextWindow: 32000,
      },
    ],
    activeModelId: 'm',
    approval: 'ask',
    allowedCommands: [],
    recentWorkspaces: [third],
  }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: first };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);
await page.locator('.rail-new').click();
await page.waitForTimeout(600);

await test('B1', 'the workspace sits at the left end and the counters at the right end', async () => {
  const firstItem = page.locator('.composer-meta > .cm-item').first();
  const cls = await firstItem.getAttribute('class');
  if (!cls?.includes('cm-workspace')) throw new Error(`first item: ${cls}`);
  const right = page.locator('.composer-meta .cm-right');
  const lastText = (await right.locator('.cm-item').last().innerText()).trim();
  if (!lastText.includes('%')) throw new Error(`right end: ${lastText}`);
  const order = await page.locator('.composer-meta > *').evaluateAll((nodes) => nodes.map((node) => node.className));
  if (!order[0].includes('cm-workspace')) throw new Error(`order: ${order.join(' | ')}`);
});

await test('B2', 'clicking the workspace chip opens the picker next to it', async () => {
  const chip = await page.locator('.cm-workspace').boundingBox();
  await page.locator('.cm-workspace').click();
  await page.waitForTimeout(350);
  if ((await page.locator('.workspace-menu').count()) !== 1) throw new Error('picker missing');
  const menu = await page.locator('.workspace-menu').boundingBox();
  if (Math.abs(menu.x - chip.x) > 260) throw new Error(`menu x ${menu.x} vs chip ${chip.x}`);
  const above = menu.y + menu.height <= chip.y + 12;
  const below = menu.y >= chip.y + chip.height - 12;
  if (!above && !below) throw new Error(`menu not anchored: menu ${menu.y}-${menu.y + menu.height}, chip ${chip.y}-${chip.y + chip.height}`);
  const viewport = await page.evaluate(() => window.innerHeight);
  if (menu.y + menu.height > viewport - 4) throw new Error(`menu leaves the viewport: ${menu.y + menu.height} > ${viewport}`);
  const group = await page.locator('.workspace-group-label').innerText();
  if (group !== '本机') throw new Error(`group: ${group}`);
  const box = await page.locator('.workspace-menu').boundingBox();
  await page.screenshot({ path: join(shots, 'workspace-picker-footer.png'), clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
  return 'anchored to the chip';
});

await test('B3', 'picking a folder from the chip binds it to the waiting session', async () => {
  await page.locator('.workspace-menu [role="menuitem"]', { hasText: 'third-workspace' }).click();
  await page.waitForTimeout(1400);
  const label = (await page.locator('.cm-workspace').innerText()).trim();
  if (!label.includes('third-workspace')) throw new Error(`chip: ${label}`);
});

await test('B4', 'the chip can switch again after a workspace is set', async () => {
  await page.locator('.cm-workspace').click();
  await page.waitForTimeout(300);
  await page.locator('.workspace-menu [role="menuitem"]').filter({ has: page.locator('.workspace-item-name', { hasText: /^workspace$/ }) }).click();
  await page.waitForTimeout(1400);
  const label = (await page.locator('.cm-workspace').innerText()).trim();
  if (label.includes('third')) throw new Error(`chip: ${label}`);
});

if (app) await app.close();
await writeFile(join(shots, 'results-30.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
