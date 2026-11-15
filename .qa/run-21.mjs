// QA pass 21: the model picker is grouped by vendor with a search field.
// node .qa/run-21.mjs
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

const home = join(homes, 'picker');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(join(home, 'workspace'), { recursive: true });
const models = [
  { id: 'm1', name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'x', model: 'deepseek-flash' },
  { id: 'm2', name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'x', model: 'deepseek-v4-pro' },
  { id: 'm3', name: 'MiMo', provider: 'custom', baseUrl: 'https://api.mimo.example/v1', apiKey: 'x', model: 'MiMo-V2.5' },
  { id: 'm4', name: 'MiMo', provider: 'custom', baseUrl: 'https://api.mimo.example/v1', apiKey: 'x', model: 'MiMo-V2.5-Pro' },
];
await writeFile(join(home, 'settings.json'), JSON.stringify({ models, activeModelId: 'm1', approval: 'ask', allowedCommands: [] }));
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'workspace') };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);
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
await page.waitForTimeout(600);
const chip = page.locator('.model-wrap .tb-chip.model');
const openMenu = async () => {
  if ((await page.locator('.model-menu').count()) === 0) {
    await chip.click();
    await page.waitForTimeout(300);
  }
};

await test('M1', 'the picker groups models under their vendor', async () => {
  await openMenu();
  const labels = (await page.locator('.model-group-label').allInnerTexts()).map((text) => text.trim());
  if (labels.length !== 2) throw new Error(`groups: ${labels.join(' | ')}`);
  if (!labels.includes('DeepSeek')) throw new Error(`groups: ${labels.join(' | ')}`);
  const firstGroup = await page.locator('.model-group').first().innerText();
  if (!firstGroup.includes('deepseek-flash') || !firstGroup.includes('deepseek-v4-pro')) {
    throw new Error(`first group: ${firstGroup.replace(/\s+/g, ' ')}`);
  }
  const second = await page.locator('.model-group').nth(1).innerText();
  if (!second.includes('MiMo-V2.5')) throw new Error(`second group: ${second.replace(/\s+/g, ' ')}`);
  return labels.join(' / ');
});

await test('M2', 'the active model is checked and selecting another switches', async () => {
  const active = page.locator('.model-item[aria-selected="true"]');
  if ((await active.count()) !== 1) throw new Error('no checked row');
  const activeText = await active.innerText();
  if (!activeText.includes('deepseek-flash')) throw new Error(`active: ${activeText}`);
  await page.locator('.model-item').filter({ hasText: 'deepseek-v4-pro' }).click();
  await page.waitForTimeout(500);
  if ((await page.locator('.model-menu').count()) !== 0) throw new Error('menu stayed open');
  const text = (await chip.innerText()).trim();
  if (text !== 'deepseek-v4-pro') throw new Error(`chip: ${text}`);
  const saved = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  if (saved.activeModelId !== 'm2') throw new Error('selection not persisted');
});

await test('M3', 'the search filters by model and by vendor', async () => {
  await openMenu();
  const search = page.locator('.model-search input');
  await search.fill('mimo');
  await page.waitForTimeout(300);
  const filtered = (await page.locator('.model-item strong').allInnerTexts()).map((text) => text.trim());
  if (filtered.length !== 2 || !filtered.every((text) => text.startsWith('MiMo'))) {
    throw new Error(`filtered: ${filtered.join(' | ')}`);
  }
  await search.fill('deepseek');
  await page.waitForTimeout(300);
  const byVendor = (await page.locator('.model-item strong').allInnerTexts()).map((text) => text.trim());
  if (byVendor.length !== 2) throw new Error(`by vendor: ${byVendor.join(' | ')}`);
  await search.fill('zzz-nothing');
  await page.waitForTimeout(300);
  if ((await page.locator('.model-empty').count()) === 0) throw new Error('no empty state');
  await search.fill('');
  await page.waitForTimeout(250);
  return `${filtered.length} matches for mimo`;
});

await page.keyboard.press('Escape');
await page.waitForTimeout(200);

if (app) await app.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-21.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
