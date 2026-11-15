// QA pass 2: settings page (models from provider, appearance, usage, about).
// node .qa/run-2.mjs
import { _electron } from 'playwright-core';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';

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

// Local OpenAI-compatible provider so the model list is fetched for real.
const stubModels = ['stub-alpha', 'stub-beta', 'stub-gamma'];
const stub = createServer((request, response) => {
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: stubModels.map((id) => ({ id })) }));
    return;
  }
  if (request.url === '/v1/chat/completions') {
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ready' } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2 } })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => stub.listen(4787, '127.0.0.1', resolve));

const home = join(homes, 'settings');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'workspace') };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
  args: ['.'],
  cwd: root,
  env,
});
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);

const openSettings = async () => {
  await page.locator('.foot-actions button').nth(1).click();
  await page.waitForTimeout(450);
};
const closeSettings = async () => {
  await page.getByRole('button', { name: /返回应用/ }).click();
  await page.waitForTimeout(350);
};
const openAdd = async () => {
  await page.locator('.settings-head .primary').click();
  await page.waitForTimeout(400);
};
const pickCustom = async (baseUrl) => {
  await page.locator('.model-dialog .select').first().click();
  await page.waitForTimeout(250);
  await page.getByRole('option', { name: /OpenAI Compatible/ }).click();
  await page.waitForTimeout(320);
  await page.locator('.model-dialog .field input').nth(0).fill(baseUrl);
  await page.waitForTimeout(250);
};
const settingsFile = async () => JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));

await test('T1', 'settings page opens with the four sections', async () => {
  await openSettings();
  const title = (await page.locator('.settings-head h1').innerText()).trim();
  if (title !== '模型') throw new Error(`title: ${title}`);
  const nav = (await page.locator('.settings-nav button').allInnerTexts()).map((t) => t.trim());
  if (nav.join(',') !== '模型,外观,使用统计,关于') throw new Error(`nav: ${nav.join(',')}`);
});

await test('T2', 'the model list comes from the provider, then adds one profile per pick', async () => {
  await openAdd();
  const labels = (await page.locator('.model-dialog .field > span').allInnerTexts()).map((t) => t.trim());
  if (!labels.includes('模型')) throw new Error(`fields: ${labels.join(',')}`);
  await pickCustom('http://127.0.0.1:4787/v1');
  await page.locator('.model-dialog .select').nth(2).click();
  await page.waitForTimeout(1000);
  const rows = (await page.locator('.model-dialog .check-item:not(.all) .mono').allInnerTexts()).map((t) => t.trim());
  if (rows.join(',') !== stubModels.join(',')) throw new Error(`fetched rows: ${rows.join(',')}`);
  await page.locator('.check-item.all').click();
  await page.waitForTimeout(200);
  const label = (await page.locator('.model-dialog .primary').innerText()).trim();
  if (!label.includes('校验并添加模型')) throw new Error(`button: ${label}`);
  await page.locator('.model-dialog .primary').click();
  await page.waitForTimeout(2500);
  if ((await page.locator('.model-dialog').count()) > 0) throw new Error('dialog still open after validation');
  const cards = await page.locator('.model-cards li').count();
  if (cards !== 4) throw new Error(`cards: ${cards}`);
  const saved = await settingsFile();
  if (saved.models.length !== 4) throw new Error(`models in file: ${saved.models.length}`);
  return `${rows.length} fetched, ${cards} cards`;
});

await test('T3', 'switching the active model from the row menu', async () => {
  const rows = page.locator('.model-cards li');
  const target = rows.nth(1);
  const model = await target.getAttribute('data-model');
  await target.getByRole('button', { name: /操作/ }).click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: '设为当前' }).click();
  await page.waitForTimeout(500);
  const activeModel = await page.locator('.model-cards li.active').getAttribute('data-model');
  if (activeModel !== model) throw new Error(`active: ${activeModel} expected ${model}`);
  const saved = await settingsFile();
  const active = saved.models.find((entry) => entry.id === saved.activeModelId);
  if (!active || active.model !== model) throw new Error(`file active: ${active?.model}`);
  return model;
});

await test('T4', 'editing locks provider/type/model and validates the new key', async () => {
  await page.locator('.model-cards li').first().getByRole('button', { name: /操作/ }).click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: '编辑' }).click();
  await page.waitForTimeout(400);
  const labels = (await page.locator('.model-dialog .field > span').allInnerTexts()).map((text) => text.trim());
  if (!labels.includes('供应商') || !labels.includes('类型') || !labels.includes('模型')) {
    throw new Error(`fields: ${labels.join(',')}`);
  }
  const statics = await page.locator('.select-static').count();
  if (statics !== 3) throw new Error(`static selects: ${statics}`);
  const hint = await page.locator('.field-hint').innerText();
  if (!hint.includes('不可更改')) throw new Error(`hint: ${hint}`);
  const placeholder = await page.locator('.input-with-icon input').getAttribute('placeholder');
  if (!placeholder?.includes('留空')) throw new Error(`placeholder: ${placeholder}`);
  await page.locator('.input-with-icon input').fill('sk-edited-key');
  await page.locator('.model-dialog .primary').click();
  await page.waitForTimeout(2200);
  const stillOpen = await page.locator('.model-dialog').count();
  if (stillOpen) {
    const forced = page.getByRole('button', { name: '仍然保存' });
    if (await forced.count()) await forced.click();
  }
  await page.waitForTimeout(500);
  const saved = await settingsFile();
  if (saved.models[0].apiKey !== 'sk-edited-key') throw new Error(`key: ${saved.models[0].apiKey}`);
});

await test('T5', 'an unreachable provider reports why and falls back to a manual model', async () => {
  await openAdd();
  await pickCustom('http://127.0.0.1:9/v1');
  await page.locator('.model-dialog .select').nth(2).click();
  await page.waitForTimeout(1500);
  const error = (await page.locator('.model-fetch-error').innerText()).trim();
  if (!error) throw new Error('no error shown');
  await page.locator('.model-manual').fill('manual-model');
  await page.locator('.model-manual').press('Enter');
  await page.waitForTimeout(250);
  const before = await page.locator('.model-cards li').count();
  await page.locator('.model-dialog .primary').click();
  await page.waitForTimeout(2500);
  const tested = (await page.locator('.validate-error p').innerText()).trim();
  if (!tested) throw new Error('no validation error');
  await page.getByRole('button', { name: '仍然添加' }).click();
  await page.waitForTimeout(600);
  const after = await page.locator('.model-cards li').count();
  if (after !== before + 1) throw new Error(`cards ${before} -> ${after}`);
  return `fetch: ${error.slice(0, 24)} / validate: ${tested.slice(0, 24)}`;
});

await test('T6', 'deleting every model shows the empty state and disables sending', async () => {
  let guard = 0;
  while ((await page.locator('.model-cards li').count()) > 0 && guard < 12) {
    await page.locator('.model-cards li').first().getByRole('button', { name: /操作/ }).click();
    await page.waitForTimeout(200);
    await page.getByRole('menuitem', { name: '删除' }).click();
    await page.waitForTimeout(400);
    guard += 1;
  }
  const empty = (await page.locator('.settings-empty').innerText()).trim();
  if (!empty.includes('暂无自定义模型')) throw new Error(`empty: ${empty}`);
  await closeSettings();
  const chip = (await page.locator('.model-wrap .tb-chip').innerText()).trim();
  if (chip !== '未配置模型') throw new Error(`chip: ${chip}`);
  if (!(await page.locator('.send').isDisabled())) throw new Error('send is enabled without a model');
});

await test('T7', 'adding a model again re-enables the composer', async () => {
  await openSettings();
  await openAdd();
  await pickCustom('http://127.0.0.1:4787/v1');
  await page.locator('.model-dialog .select').nth(2).click();
  await page.waitForTimeout(900);
  await page.locator('.model-dialog .check-item').nth(1).click();
  await page.waitForTimeout(200);
  await page.locator('.model-dialog .primary').click();
  await page.waitForTimeout(600);
  await closeSettings();
  const chip = (await page.locator('.model-wrap .tb-chip').innerText()).trim();
  if (chip === '未配置模型') throw new Error('chip still empty');
  return chip;
});

await test('T8', 'appearance page switches theme', async () => {
  await openSettings();
  await page.getByRole('button', { name: '外观' }).click();
  await page.waitForTimeout(300);
  const cards = await page.locator('.theme-card').count();
  if (cards !== 2) throw new Error(`theme cards: ${cards}`);
  await page.locator('.theme-card.dark').click();
  await page.waitForTimeout(400);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== 'dark') throw new Error(`theme: ${theme}`);
  await page.locator('.theme-card.light').click();
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => document.documentElement.dataset.theme);
  if (back !== 'light') throw new Error(`theme back: ${back}`);
});

await test('T9', 'usage page renders the heatmap and totals', async () => {
  await page.getByRole('button', { name: '使用统计' }).click();
  await page.waitForTimeout(450);
  const cells = await page.locator('.settings-pane .hm-cell').count();
  if (cells < 300) throw new Error(`cells: ${cells}`);
  const stats = (await page.locator('.settings-stats dt').allInnerTexts()).map((t) => t.trim());
  if (stats.join(',') !== '会话数,活跃天数,记录条数') throw new Error(`stats: ${stats.join(',')}`);
  return `${cells} cells`;
});

await test('T10', 'about page lists local runtime facts', async () => {
  await page.getByRole('button', { name: '关于' }).click();
  await page.waitForTimeout(350);
  const keys = (await page.locator('.settings-about dt').allInnerTexts()).map((t) => t.trim());
  if (keys.join(',') !== '版本,运行平台,用户,工作区,分支,模型') throw new Error(`keys: ${keys.join(',')}`);
  const version = (await page.locator('.settings-about dd').first().innerText()).trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`version: ${version}`);
  return version;
});

await test('T11', 'settings search filters the navigation', async () => {
  await page.locator('.settings-search').fill('外观');
  await page.waitForTimeout(300);
  const nav = (await page.locator('.settings-nav button').allInnerTexts()).map((t) => t.trim());
  if (nav.length !== 1 || nav[0] !== '外观') throw new Error(`nav: ${nav.join(',')}`);
  await page.locator('.settings-search').fill('');
  await page.waitForTimeout(250);
  const restored = await page.locator('.settings-nav button').count();
  if (restored !== 4) throw new Error(`restored: ${restored}`);
});

await test('T12', 'model list persists across a settings round-trip', async () => {
  await page.getByRole('button', { name: '模型', exact: true }).click();
  await page.waitForTimeout(300);
  const before = (await page.locator('.model-card-title strong').allInnerTexts()).map((t) => t.trim());
  await closeSettings();
  await openSettings();
  const after = (await page.locator('.model-card-title strong').allInnerTexts()).map((t) => t.trim());
  if (before.join('|') !== after.join('|')) throw new Error(`${before.join('|')} vs ${after.join('|')}`);
  await closeSettings();
  return before.join(', ');
});

if (app) await app.close();
stub.close();
await writeFile(join(shots, 'results-2.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
