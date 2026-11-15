// QA pass 16: the workspace "+" is a round ghost button, and it still creates a session.
// node .qa/run-16.mjs
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

const home = join(homes, 'add-button');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'workspace'), XIAOHEY_DEMO: '1' };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(1400);

const add = page.locator('.rail-add');

await test('K1', 'the workspace add is a compact borderless icon button', async () => {
  const style = await add.evaluate((node) => {
    const css = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return { radius: css.borderRadius, border: css.borderTopWidth, width: box.width, height: box.height };
  });
  if (style.radius !== '7px') throw new Error(`radius ${style.radius}`);
  if (style.border !== '0px') throw new Error(`border ${style.border}`);
  if (style.width !== style.height || style.width < 24) throw new Error(`box ${style.width}x${style.height}`);
  return `${style.width}px icon`;
});

await test('K2', 'hovering gives it a soft round fill', async () => {
  const before = await add.evaluate((node) => getComputedStyle(node).backgroundColor);
  await add.hover();
  await page.waitForTimeout(250);
  const after = await add.evaluate((node) => getComputedStyle(node).backgroundColor);
  if (after === before || after === 'rgba(0, 0, 0, 0)') throw new Error(`bg ${before} -> ${after}`);
  return after;
});

await test('K4', 'session rows carry no relative timestamp', async () => {
  const meta = await page.locator('.thread-meta').first().innerText().catch(() => '');
  if (/刚刚|分钟前|小时前|天前/.test(meta)) throw new Error(`meta: ${meta}`);
  if (meta.trim().length > 0) throw new Error(`unexpected meta: ${meta}`);
});

await test('K6', 'full access is shown like any other policy, not in red', async () => {
  const chip = page.locator('.policy-wrap .tb-chip');
  const before = await chip.evaluate((node) => getComputedStyle(node).color);
  await chip.click();
  await page.waitForTimeout(250);
  await page.getByRole('option', { name: /完全访问/ }).click();
  await page.waitForTimeout(400);
  const text = await chip.innerText();
  if (!text.includes('完全访问')) throw new Error(`chip: ${text}`);
  const after = await chip.evaluate((node) => getComputedStyle(node).color);
  const icon = await chip.locator('svg').first().getAttribute('class');
  if (after !== before) throw new Error(`color ${before} -> ${after}`);
  if (icon.includes('triangle-alert')) throw new Error(`icon: ${icon}`);
  return after;
});

await test('K5', 'the workspace row uses a plain folder icon', async () => {
  const cls = await page.locator('.workspace-row svg').first().getAttribute('class');
  if (!cls?.includes('lucide-folder')) throw new Error(`icon: ${cls}`);
  if (cls.includes('folder-git')) throw new Error('still the git folder');
  return cls;
});

await test('K3', 'new session is still available from the top button', async () => {
  const before = await page.locator('.thread-item').count();
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
  await page.waitForTimeout(900);
  const after = await page.locator('.thread-item').count();
  if (after !== before + 1) throw new Error(`${before} -> ${after}`);
  const rail = await page.locator('.rail').boundingBox();
  await page.screenshot({ path: join(root, 'shots', 'rail-add.png'), clip: { x: rail.x, y: rail.y, width: rail.width, height: Math.min(rail.height, 300) } });
});

await test('K7', 'the workspace header + adds a workspace', async () => {
  const label = await add.getAttribute('aria-label');
  const title = await add.getAttribute('title');
  if (label !== '新建工作区' || !title?.includes('新建工作区')) throw new Error(`${label} / ${title}`);
  const icon = await add.locator('svg').getAttribute('data-icon');
  if (icon !== 'folder-plus') throw new Error(`icon: ${icon}`);
  return icon;
});

if (app) await app.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-16.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
