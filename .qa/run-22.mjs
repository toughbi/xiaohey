// QA pass 22: the model rows (badge, title, vendor · billing, menu, toggle).
// node .qa/run-22.mjs
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

const home = join(homes, 'model-rows');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(join(home, 'workspace'), { recursive: true });
const models = [
  { id: 'm1', name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'x', model: 'deepseek-v4-pro', billing: 'payg', enabled: true },
  { id: 'm2', name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'x', model: 'deepseek-flash', billing: 'payg', enabled: true },
];
await writeFile(join(home, 'settings.json'), JSON.stringify({ models, activeModelId: 'm1', approval: 'ask', allowedCommands: [] }));
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'workspace') };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);
await page.locator('.foot-actions button').nth(1).click();
await page.waitForTimeout(600);

const settingsFile = async () => JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));

await test('N1', 'each row shows the pretty model name and vendor · billing', async () => {
  const rows = page.locator('.model-row');
  if ((await rows.count()) !== 2) throw new Error(`rows: ${await rows.count()}`);
  const title = (await rows.first().locator('.model-row-title span').first().innerText()).trim();
  if (title !== 'DeepSeek-V4-Pro') throw new Error(`title: ${title}`);
  const sub = (await rows.first().locator('.model-row-sub').innerText()).trim();
  if (sub !== 'DeepSeek · Pay As You Go') throw new Error(`sub: ${sub}`);
  if ((await rows.first().locator('.model-badge').count()) !== 1) throw new Error('no badge');
});

await test('N2', 'the toggle disables a model and hides it from the picker', async () => {
  const first = page.locator('.model-row').first();
  const toggle = first.locator('.switch');
  if ((await toggle.getAttribute('aria-checked')) !== 'true') throw new Error('switch not on');
  await toggle.click();
  await page.waitForTimeout(700);
  if ((await toggle.getAttribute('aria-checked')) !== 'false') throw new Error('switch still on');
  if (!(await first.evaluate((node) => node.classList.contains('disabled')))) throw new Error('row not dimmed');
  const saved = await settingsFile();
  if (saved.models.find((entry) => entry.id === 'm1').enabled !== false) throw new Error('enabled flag not saved');
  if (saved.activeModelId === 'm1') throw new Error('disabled model still active');
  await page.getByRole('button', { name: /返回应用/ }).click();
  await page.waitForTimeout(400);
  await page.locator('.model-wrap .tb-chip.model').click();
  await page.waitForTimeout(400);
  const ids = (await page.locator('.model-item strong').allInnerTexts()).map((text) => text.trim());
  if (ids.includes('deepseek-v4-pro')) throw new Error(`picker still lists disabled model: ${ids.join(',')}`);
  if (!ids.includes('deepseek-flash')) throw new Error(`picker lost the enabled model: ${ids.join(',')}`);
  await page.keyboard.press('Escape');
  return ids.join(', ');
});

await test('N3', 'the row menu offers edit and delete, and edit opens the dialog', async () => {
  await page.locator('.foot-actions button').nth(1).click();
  await page.waitForTimeout(500);
  await page.locator('.model-row').first().getByRole('button', { name: /操作/ }).click();
  await page.waitForTimeout(250);
  const items = (await page.locator('.row-menu [role="menuitem"]').allInnerTexts()).map((text) => text.trim());
  if (!items.some((text) => text.includes('编辑')) || !items.some((text) => text.includes('删除'))) {
    throw new Error(`menu: ${items.join(' | ')}`);
  }
  await page.getByRole('menuitem', { name: '编辑' }).click();
  await page.waitForTimeout(400);
  if ((await page.locator('.model-dialog').count()) !== 1) throw new Error('editor did not open');
  if ((await page.locator('.select-static').count()) !== 3) throw new Error('locked fields missing');
  const hint = await page.locator('.field-hint').innerText();
  if (!hint.includes('不可更改')) throw new Error(`hint: ${hint}`);
  const placeholder = await page.locator('.input-with-icon input').getAttribute('placeholder');
  if (!placeholder?.includes('留空')) throw new Error(`placeholder: ${placeholder}`);
  await page.locator('.model-dialog .ghost.icon[aria-label="关闭"]').click();
  await page.waitForTimeout(300);
  return items.join(' / ');
});

await test('N4', 'deleting from the row menu removes the model', async () => {
  const before = await page.locator('.model-row').count();
  await page.locator('.model-row').first().getByRole('button', { name: /操作/ }).click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.waitForTimeout(700);
  const after = await page.locator('.model-row').count();
  const saved = await settingsFile();
  if (after !== before - 1 || saved.models.length !== before - 1) throw new Error(`rows ${before} -> ${after}, file ${saved.models.length}`);
  await page.locator('.settings-pane').screenshot({ path: join(shots, 'settings-models.png') });
});

if (app) await app.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-22.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
