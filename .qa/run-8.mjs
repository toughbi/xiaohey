// QA pass 8: model list fetched from the provider instead of a fixed catalogue.
// node .qa/run-8.mjs
import { _electron } from 'playwright-core';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

let modelList = ['alpha-model', 'beta-model', 'gamma-model'];
const server = createServer((req, res) => {
  if (req.url === '/v1/models') {
    if (req.headers.authorization === 'Bearer sk-bad') {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'invalid key' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: modelList.map((id) => ({ id })) }));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    req.resume();
    req.on('end', () => {
      if (req.headers.authorization === 'Bearer sk-bad') {
        res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'invalid key' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ready' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 2 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => server.listen(4799, '127.0.0.1', resolve));

const home = join(homes, 'models');
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

const setupCustom = async (baseUrl, key = '') => {
  await page.locator('.foot-actions button').nth(1).click();
  await page.waitForTimeout(400);
  await page.locator('.settings-head .primary').click();
  await page.waitForTimeout(400);
  await page.locator('.model-dialog .select').first().click();
  await page.waitForTimeout(250);
  await page.getByRole('option', { name: /OpenAI Compatible/ }).click();
  await page.waitForTimeout(350);
  const fields = page.locator('.model-dialog .field input');
  await fields.nth(0).fill(baseUrl);
  if (key) await page.locator('.model-dialog input[type="password"]').fill(key);
  await page.waitForTimeout(250);
};

await test('Y1', 'the model list is fetched from the provider on open', async () => {
  await setupCustom('http://127.0.0.1:4799/v1');
  await page.locator('.model-dialog .select').nth(2).click();
  await page.waitForTimeout(1200);
  const rows = (await page.locator('.model-dialog .check-item:not(.all) .mono').allInnerTexts()).map((t) => t.trim());
  if (rows.join(',') !== modelList.join(',')) throw new Error(`rows: ${rows.join(',')}`);
  const source = (await page.locator('.model-dialog .model-source').innerText()).trim();
  if (!source.includes('3 个模型')) throw new Error(`source: ${source}`);
  return source;
});

await test('Y2', 'select all adds one profile per fetched model', async () => {
  await page.locator('.check-item.all').click();
  await page.waitForTimeout(200);
  const label = (await page.locator('.model-dialog .primary').innerText()).trim();
  if (!label.includes('校验并添加模型')) throw new Error(`button: ${label}`);
  await page.locator('.model-dialog .primary').click();
  await page.waitForTimeout(2500);
  if ((await page.locator('.model-dialog').count()) > 0) throw new Error('dialog still open after validation');
  const cards = await page.locator('.model-cards li').count();
  if (cards !== 4) throw new Error(`cards: ${cards}`);
  return `${cards} cards (1 default + 3 added)`;
});

await test('Y3', 'a filter narrows a long list', async () => {
  modelList = Array.from({ length: 12 }, (_, index) => `model-${String(index + 1).padStart(2, '0')}`);
  await page.locator('.settings-head .primary').click();
  await page.waitForTimeout(350);
  await page.locator('.model-dialog .select').first().click();
  await page.waitForTimeout(200);
  await page.getByRole('option', { name: /OpenAI Compatible/ }).click();
  await page.waitForTimeout(300);
  await page.locator('.model-dialog .field input').nth(0).fill('http://127.0.0.1:4799/v1');
  await page.waitForTimeout(250);
  await page.locator('.model-dialog .select').nth(2).click();
  await page.waitForTimeout(1000);
  const filter = page.locator('.model-filter');
  if (!(await filter.count())) throw new Error('no filter input for a long list');
  await filter.fill('model-1');
  await page.waitForTimeout(300);
  const rows = await page.locator('.model-dialog .check-item').count();
  if (rows !== 4) throw new Error(`filtered rows: ${rows} (1 all + 3 matches)`);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  if ((await page.locator('.model-dialog').count()) > 0) throw new Error('dialog did not close');
});

await test('Y4', 'a rejected key shows the reason and allows a manual model name', async () => {
  await page.locator('.settings-head .primary').click();
  await page.waitForTimeout(350);
  await page.locator('.model-dialog .select').first().click();
  await page.waitForTimeout(200);
  await page.getByRole('option', { name: /OpenAI Compatible/ }).click();
  await page.waitForTimeout(300);
  await page.locator('.model-dialog .field input').nth(0).fill('http://127.0.0.1:4799/v1');
  await page.locator('.model-dialog input[type="password"]').fill('sk-bad');
  await page.waitForTimeout(200);
  await page.locator('.model-dialog .select').nth(2).click();
  await page.waitForTimeout(900);
  const error = (await page.locator('.model-fetch-error').innerText()).trim();
  if (!/401|Key/.test(error)) throw new Error(`error: ${error}`);
  await page.locator('.model-manual').fill('manual-model');
  await page.locator('.model-manual').press('Enter');
  await page.waitForTimeout(300);
  const canAdd = await page.locator('.model-dialog .primary').isEnabled();
  if (!canAdd) throw new Error('cannot add after manual entry');
  await page.locator('.model-dialog .primary').click();
  await page.waitForTimeout(2500);
  const refused = await page.locator('.validate-error p').innerText().catch(() => '');
  if (!/401|Key/.test(refused)) throw new Error(`validate: ${refused}`);
  await page.getByRole('button', { name: '仍然添加' }).click();
  await page.waitForTimeout(700);
  const cards = await page.locator('.model-cards li').count();
  return `error "${error.slice(0, 24)}" / validate "${refused.slice(0, 20)}" / cards ${cards}`;
});

if (app) await app.close();
server.close();
await writeFile(join(shots, 'results-8.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
