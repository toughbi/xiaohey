// QA pass 15: the composer and settings show the concrete model id, not the provider name.
// node .qa/run-15.mjs
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

const home = join(homes, 'labels');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const workspace = join(home, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    models: [
      {
        id: 'deepseek-flash',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'test-key-not-used',
        model: 'deepseek-flash',
        temperature: 0.2,
        maxOutputTokens: 8192,
        contextWindow: 131072,
      },
      {
        id: 'deepseek-pro',
        name: 'DeepSeek 推理',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: 'test-key-not-used',
        model: 'deepseek-v4-pro',
        temperature: 0.2,
        maxOutputTokens: 8192,
        contextWindow: 131072,
      },
    ],
    activeModelId: 'deepseek-flash',
    approval: 'ask',
    allowedCommands: [],
  }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE;
delete env.XIAOHEY_DEMO;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(1200);
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

const chip = page.locator('.model-wrap .tb-chip.model');

await test('J1', 'the composer chip shows the model id', async () => {
  const text = (await chip.innerText()).trim();
  if (text !== 'deepseek-flash') throw new Error(`chip: ${text}`);
});

await test('J2', 'the chip tooltip keeps the friendly name and endpoint', async () => {
  const title = await chip.getAttribute('title');
  if (!title?.includes('DeepSeek') || !title.includes('api.deepseek.com')) throw new Error(`title: ${title}`);
});

await test('J3', 'the model menu lists ids first and names second', async () => {
  await chip.click();
  await page.waitForTimeout(400);
  const items = await page.locator('.model-menu .model-item').allInnerTexts();
  if (!items.some((text) => text.includes('deepseek-flash'))) throw new Error(items.join(' | '));
  if (items.some((text) => text.trim() === 'DeepSeek')) throw new Error('menu still shows only the provider name');
  const first = (await page.locator('.model-menu .model-item strong').first().innerText()).trim();
  if (first !== 'deepseek-flash') throw new Error(`first: ${first}`);
  await page.locator('.model-menu .model-item').nth(1).click();
  await page.waitForTimeout(600);
  const after = (await chip.innerText()).trim();
  if (after !== 'deepseek-v4-pro') throw new Error(`after switch: ${after}`);
  const saved = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  if (saved.activeModelId !== 'deepseek-pro') throw new Error('selection not persisted');
});

await test('J4', 'settings cards title the model id and subtitle the name', async () => {
  await page.locator('.foot-actions button').nth(1).click();
  await page.waitForTimeout(600);
  const cards = page.locator('.model-cards li');
  const first = (await cards.first().locator('.model-row-title span:first-child').innerText()).trim();
  if (first !== 'DeepSeek-Flash') throw new Error(`card title: ${first}`);
  const meta = (await cards.first().locator('.model-row-sub').innerText()).trim();
  if (!meta.startsWith('DeepSeek')) throw new Error(`card meta: ${meta}`);
});

if (app) await app.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-15.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
