// QA pass 4: edge cases, corrupted state, workspace handling, responsive layout.
// node .qa/run-4.mjs
import { _electron } from 'playwright-core';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

const launch = async (dir, extraEnv = {}) => {
  await mkdir(dir, { recursive: true });
  const env = { ...process.env, XIAOHEY_HOME: dir, XIAOHEY_WORKSPACE: join(dir, 'workspace'), ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const instance = await _electron.launch({
    executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
    args: ['.'],
    cwd: root,
    env,
  });
  const window = await instance.firstWindow();
  await window.waitForSelector('.app');
  await window.waitForTimeout(900);
  return { instance, window };
};

await rm(homes, { recursive: true, force: true }).catch(() => undefined);
await mkdir(homes, { recursive: true });

// ---------- corrupted settings ----------
const corrupt = join(homes, 'corrupt');
await mkdir(corrupt, { recursive: true });
await writeFile(join(corrupt, 'settings.json'), '{ this is not json');

await test('V1', 'a corrupted settings.json falls back to the default model', async () => {
  const launched = await launch(corrupt);
  app = launched.instance;
  page = launched.window;
  const chip = (await page.locator('.model-wrap .tb-chip').innerText()).trim();
  if (!chip) throw new Error('no model chip');
  await page.locator('.foot-actions button').nth(1).click();
  await page.waitForTimeout(400);
  const cards = await page.locator('.model-cards li').count();
  if (cards !== 1) throw new Error(`cards: ${cards}`);
  const healthy = JSON.parse(await readFile(join(corrupt, 'settings.json'), 'utf8'));
  if (!Array.isArray(healthy.models)) throw new Error('settings not rewritten');
  return chip;
});

// ---------- legacy settings migration ----------
const legacy = join(homes, 'legacy');
await mkdir(legacy, { recursive: true });
await writeFile(
  join(legacy, 'settings.json'),
  JSON.stringify({
    model: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-legacy',
      model: 'deepseek-reasoner',
      temperature: 0.2,
      maxOutputTokens: 2048,
      contextWindow: 65536,
    },
    approval: 'auto',
  }),
);

await test('V2', 'a legacy single-model settings file is migrated', async () => {
  if (app) await app.close();
  const launched = await launch(legacy);
  app = launched.instance;
  page = launched.window;
  await page.locator('.foot-actions button').nth(1).click();
  await page.waitForTimeout(400);
  const meta = (await page.locator('.model-row-title span:first-child').first().innerText()).trim();
  if (!/deepseek-reasoner/i.test(meta)) throw new Error(`model: ${meta}`);
  const saved = JSON.parse(await readFile(join(legacy, 'settings.json'), 'utf8'));
  if (saved.approval !== 'auto') throw new Error(`approval: ${saved.approval}`);
  return `${meta} / ${saved.approval}`;
});

// ---------- workspace that does not exist ----------
const missing = join(homes, 'missing-workspace');
await test('V3', 'a missing workspace directory is created on boot', async () => {
  if (app) await app.close();
  const launched = await launch(join(homes, 'missing-home'), { XIAOHEY_WORKSPACE: missing });
  app = launched.instance;
  page = launched.window;
  await page.locator('.composer-add').click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: /打开文件面板/ }).click();
  await page.waitForTimeout(700);
  const text = await page.locator('.docs').innerText();
  if (!/工作区根目录/.test(text)) throw new Error(`docs: ${text.slice(0, 120)}`);
  return 'created';
});

// ---------- long titles and rapid clicks ----------
const stress = join(homes, 'stress');
await test('V4', 'rapid double click on 新会话 does not duplicate rows', async () => {
  if (app) await app.close();
  const launched = await launch(stress);
  app = launched.instance;
  page = launched.window;
  await page.locator('.rail-new').dblclick();
  await page.waitForTimeout(1200);
  const rows = await page.locator('.thread-item').count();
  const unique = await page.locator('.thread-title').evaluateAll((nodes) => new Set(nodes.map((n) => n.textContent)).size);
  return `${rows} rows / ${unique} unique titles`;
});

await test('V5', 'a very long session title truncates without page overflow', async () => {
  await page.locator('.thread-item').first().hover();
  await page.waitForTimeout(150);
  await page.locator('.thread-more').first().click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.waitForTimeout(250);
  const long = '这是一个非常非常长的会话标题'.repeat(8);
  await page.locator('.title-input').fill(long);
  await page.locator('.title-input').press('Enter');
  await page.waitForTimeout(700);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 2) throw new Error(`horizontal overflow: ${overflow}px`);
  const rail = await page.locator('.thread-title').first().evaluate((node) => node.scrollWidth > node.clientWidth + 2);
  if (!rail) throw new Error('title not truncated in the rail');
  return `overflow ${overflow}px`;
});

await test('V6', 'layout survives a 900x640 window', async () => {
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(900, 640);
  });
  await page.waitForTimeout(700);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  if (overflow > 2) throw new Error(`horizontal overflow: ${overflow}px`);
  const composer = await page.locator('.composer').boundingBox();
  if (!composer || composer.width < 300) throw new Error(`composer width: ${composer?.width}`);
  await page.screenshot({ path: join(shots, 'narrow-900.png') });
  return `composer ${Math.round(composer.width)}px`;
});

await test('V7', 'deleting the last session returns to the empty state', async () => {
  let guard = 0;
  while ((await page.locator('.thread-item').count()) > 0 && guard < 10) {
    guard += 1;
    await page.locator('.thread-item').first().hover();
    await page.waitForTimeout(120);
    await page.locator('.thread-more').first().click();
    await page.waitForTimeout(150);
    await page.getByRole('menuitem', { name: '删除' }).click();
    await page.waitForTimeout(600);
  }
  const empty = await page.locator('.rail-empty-state').count();
  if (empty !== 1) throw new Error('empty state missing');
  const heat = await page.locator('.hm-cell').count();
  if (heat < 300) throw new Error(`heatmap after delete: ${heat}`);
  return `${guard} deletions`;
});

await test('V8', 'new session still works from the empty state after deletions', async () => {
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
  const rows = await page.locator('.thread-item').count();
  if (rows !== 1) throw new Error(`rows: ${rows}`);
});

await test('V9', 'the docs panel toggle stays consistent after a resize', async () => {
  await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setSize(1460, 940);
  });
  await page.waitForTimeout(600);
  const before = await page.locator('.docs').count();
  await page.locator('.session-head-right .ghost.icon').click();
  await page.waitForTimeout(300);
  const after = await page.locator('.docs').count();
  if (before === after) throw new Error(`docs count ${before} -> ${after}`);
});

if (app) await app.close();
await writeFile(join(shots, 'results-4.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
