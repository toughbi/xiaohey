// QA pass 20: the workspace rail has no horizontal scrollbar and can be resized.
// node .qa/run-20.mjs
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

const home = join(homes, 'rail-resize');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const workspace = join(home, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'README.md'), '# demo\n', 'utf8');
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE;
delete env.XIAOHEY_DEMO;

const launch = async () => {
  const instance = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
  const window = await instance.firstWindow();
  await window.waitForSelector('.app');
  await window.waitForTimeout(900);
  return { instance, window };
};

const first = await launch();
app = first.instance;
page = first.window;
await page.locator('.rail-new').click();
  {
    // A new session starts without a folder; bind one the way a user would.
    await page.waitForTimeout(400);
    if ((await page.locator('.workspace-menu').count()) === 0) {
      await page.locator('.workspace-row').click();
      await page.waitForTimeout(250);
    }
    const folderItem = page.locator('.workspace-menu .workspace-folder').first();
    if (await folderItem.count()) {
      await folderItem.click();
      await page.waitForTimeout(600);
    }
  }
  const folderItem = page.locator('.workspace-menu .workspace-folder').first();
  if (await folderItem.count()) {
    await folderItem.click();
    await page.waitForTimeout(600);
  }
await page.waitForTimeout(700);

const railWidth = async () => Math.round((await page.locator('.rail').boundingBox()).width);

const dragRail = async (dx) => {
  const box = await page.locator('.rail-splitter').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + 220;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
};

await test('Q1', 'the workspace list has no horizontal scrollbar', async () => {
  const info = await page.locator('.rail-grow').evaluate((node) => ({
    overflowX: getComputedStyle(node).overflowX,
    overflowY: getComputedStyle(node).overflowY,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  if (info.overflowX === 'auto' || info.overflowX === 'scroll') throw new Error(`overflow-x: ${info.overflowX}`);
  if (info.scrollWidth > info.clientWidth + 2) throw new Error(`overflow ${info.scrollWidth - info.clientWidth}px`);
  return `${info.overflowX}, ${info.scrollWidth}/${info.clientWidth}`;
});

await test('Q2', 'dragging the separator widens the rail', async () => {
  const before = await railWidth();
  await dragRail(90);
  const after = await railWidth();
  if (after < before + 60) throw new Error(`${before} -> ${after}`);
  return `${before} -> ${after}`;
});

await test('Q3', 'the rail width survives a restart', async () => {
  const width = await railWidth();
  await app.close();
  const again = await launch();
  app = again.instance;
  page = again.window;
  const restored = await railWidth();
  if (Math.abs(restored - width) > 6) throw new Error(`${width} -> ${restored}`);
  return `${restored}px`;
});

await test('Q4', 'keyboard arrows and double click reset the width', async () => {
  await page.locator('.rail-splitter').focus();
  const before = await railWidth();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  const after = await railWidth();
  if (after <= before) throw new Error(`${before} -> ${after}`);
  const box = await page.locator('.rail-splitter').boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + 200);
  await page.waitForTimeout(350);
  const reset = await railWidth();
  if (Math.abs(reset - 232) > 4) throw new Error(`reset ${reset}`);
  return `${before} -> ${after} -> ${reset}`;
});

await test('Q5', 'the rail clamps at its maximum', async () => {
  await dragRail(600);
  const width = await railWidth();
  if (width > 424) throw new Error(`width ${width}`);
  return `${width}px`;
});

if (app) await app.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-20.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
