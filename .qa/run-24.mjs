// QA pass 24: the workspace switcher (open/create folder, recents, per-folder sessions).
// node .qa/run-24.mjs
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

const home = join(homes, 'workspaces');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(join(home, 'workspace'), { recursive: true });
const second = join(home, 'second-workspace');
await mkdir(join(second, 'src'), { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({ models: [], activeModelId: '', approval: 'ask', allowedCommands: [], recentWorkspaces: [second] }),
);
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

await test('W1', 'the workspace row opens a switcher with the picker and recents', async () => {
  await page.locator('.workspace-row').click();
  await page.waitForTimeout(300);
  if ((await page.locator('.workspace-menu').count()) !== 1) throw new Error('menu did not open');
  const items = (await page.locator('.workspace-menu button').allInnerTexts()).map((text) => text.trim());
  if (!items.some((text) => text.includes('新建工作区'))) throw new Error(`items: ${items.join(' | ')}`);
  if (!items.some((text) => text === 'second-workspace')) throw new Error(`recents missing: ${items.join(' | ')}`);
  return items.join(' / ');
});

await test('W2', 'a session can be created in another folder and reports that folder', async () => {
  await page.keyboard.press('Escape').catch(() => undefined);
  await page.locator('.policy-backdrop').click({ force: true }).catch(() => undefined);
  const created = await page.evaluate(async (path) => {
    const res = await window.xiaohey.request('thread/create', { title: 'Second', workspace: path });
    const info = await window.xiaohey.request('workspace/info', { threadId: res.value?.id });
    return { ok: res.ok, cwd: res.value?.cwd, info: info.value?.path, name: info.value?.name };
  }, second);
  if (!created.ok) throw new Error('create failed');
  if (created.cwd !== second) throw new Error(`cwd: ${created.cwd}`);
  if (created.info !== second) throw new Error(`info: ${created.info}`);
  return created.name;
});

await test('W3', 'a bogus folder is rejected instead of silently opening', async () => {
  const outcome = await page.evaluate(async () => {
    const res = await window.xiaohey.request('thread/create', { title: 'Bad', workspace: 'relative/nowhere' });
    return { ok: res.ok, error: res.error };
  });
  if (outcome.ok) throw new Error('relative path was accepted');
  if (!/absolute|not a folder/i.test(outcome.error ?? '')) throw new Error(`error: ${outcome.error}`);
  return outcome.error.slice(0, 40);
});

if (app) await app.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-24.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
