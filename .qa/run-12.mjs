// QA pass 12: the smaller polish items (file search, onboarding, aria-live,
// settings filtering, single-instance guard).
// node .qa/run-12.mjs
import { _electron } from 'playwright-core';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The docs panel starts closed now: open it on demand before touching its tabs.
async function ensureDocs() {
  if (await page.locator('.docs').count()) return;
  await page.keyboard.press('Control+Shift+B');
  await page.waitForTimeout(400);
}


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

const main = join(homes, 'polish');
await rm(main, { recursive: true, force: true }).catch(() => undefined);
await mkdir(main, { recursive: true });
const env = { ...process.env, XIAOHEY_HOME: main, XIAOHEY_WORKSPACE: join(main, 'demo-workspace'), XIAOHEY_DEMO: '1' };
delete env.ELECTRON_RUN_AS_NODE;

app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(1500);

await test('G1', 'the transcript is announced to assistive tech', async () => {
  const live = await page.locator('.transcript').getAttribute('aria-live');
  if (live !== 'polite') throw new Error(`aria-live: ${live}`);
});

await test('G2', 'the files tab filters names', async () => {
  await ensureDocs();
  await page.locator('.docs-tab').filter({ hasText: '文件' }).first().click();
  await page.waitForTimeout(400);
  const before = await page.locator('.file-row').count();
  await page.locator('.docs-search').fill('README');
  await page.waitForTimeout(300);
  const after = await page.locator('.file-row').count();
  if (after >= before) throw new Error(`${before} -> ${after}`);
  const text = await page.locator('.file-list').innerText();
  if (!text.includes('README.md')) throw new Error('README row missing');
  await page.locator('.docs-search').fill('');
  await page.waitForTimeout(200);
  return `${before} -> ${after}`;
});

await test('G3', 'settings search filters model cards', async () => {
  await page.locator('.foot-actions button').nth(1).click();
  await page.waitForTimeout(450);
  const before = await page.locator('.model-cards li').count();
  await page.locator('.settings-search').fill('deepseek');
  await page.waitForTimeout(350);
  const after = await page.locator('.model-cards li').count();
  if (after === 0) throw new Error('filter removed every model');
  if (after > before) throw new Error(`unexpected count ${after}`);
  await page.locator('.settings-search').fill('');
  await page.waitForTimeout(250);
  const restored = await page.locator('.model-cards li').count();
  if (restored !== before) throw new Error(`restore ${restored} !== ${before}`);
  await page.getByRole('button', { name: /返回应用/ }).click();
  await page.waitForTimeout(300);
});

// A second instance on the same home must hand over to the running one and exit.
await test('G4', 'a second instance exits instead of opening another window', async () => {
  const child = execFile(join(root, 'node_modules/electron/dist/electron.exe'), ['.'], { cwd: root, env, timeout: 15_000 });
  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1));
    setTimeout(() => resolve('timeout'), 12_000);
  });
  if (exitCode === 'timeout') {
    child.kill();
    throw new Error('second instance kept running');
  }
  return `exit ${exitCode}`;
});

if (app) await app.close();

// Fresh install with no model configured gets a call to action instead of dead text.
const freshHome = join(homes, 'polish-fresh');
await rm(freshHome, { recursive: true, force: true }).catch(() => undefined);
await mkdir(freshHome, { recursive: true });
await writeFile(join(freshHome, 'settings.json'), JSON.stringify({ models: [], activeModelId: '', approval: 'ask', allowedCommands: [] }));
const freshEnv = { ...process.env, XIAOHEY_HOME: freshHome, XIAOHEY_WORKSPACE: join(freshHome, 'workspace') };
delete freshEnv.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env: freshEnv });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(1000);
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

await test('G5', 'a fresh install points at settings when no model exists', async () => {
  const cta = page.locator('.empty-cta');
  if (!(await cta.count())) throw new Error('no onboarding button');
  await cta.click();
  await page.waitForTimeout(500);
  if ((await page.locator('.settings-view').count()) !== 1) throw new Error('settings did not open');
});

if (app) await app.close();
await writeFile(join(shots, 'results-12.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
