// QA pass 31: workspace header actions, workspace row menu, rename/delete/pinned filter.
// node .qa/run-31.mjs
import { _electron } from 'playwright-core';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

const home = join(homes, 'rail-actions');
const first = join(home, 'workspace');
const second = join(home, 'second-workspace');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(first, { recursive: true });
await mkdir(second, { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    models: [
      {
        id: 'm',
        name: 'Fake',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'x',
        model: 'fake',
        temperature: 0,
        maxOutputTokens: 128,
        contextWindow: 32000,
      },
    ],
    activeModelId: 'm',
    approval: 'ask',
    allowedCommands: [],
    recentWorkspaces: [second],
  }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: first };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);

const newest = async () =>
  page.evaluate(async () => {
    const envelope = await window.xiaohey.request('thread/list', {});
    return (envelope.value ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
  });

await test('H1', 'the workspace header has search, filter and add', async () => {
  const buttons = page.locator('.rail-head-actions button');
  if ((await buttons.count()) !== 3) throw new Error(`buttons: ${await buttons.count()}`);
  const titles = await buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title')));
  if (!titles[0]?.includes('搜索')) throw new Error(`titles: ${titles.join(' | ')}`);
  if (!titles[1]?.includes('置顶')) throw new Error(`titles: ${titles.join(' | ')}`);
  if (!titles[2]?.includes('新建工作区')) throw new Error(`titles: ${titles.join(' | ')}`);
});

await test('H2', 'the row add button creates a session inside the open workspace', async () => {
  await page.locator('.rail-new').click();
  await page.waitForTimeout(600);
  await page.locator('.workspace-pick').click();
  await page.waitForTimeout(300);
  await page.locator('.workspace-menu .workspace-folder').first().click();
  await page.waitForTimeout(900);
  const before = (await newest())?.id;
  await page.locator('.workspace-plus').click();
  await page.waitForTimeout(900);
  const thread = await newest();
  if (thread?.cwd !== first) throw new Error(`cwd: ${JSON.stringify(thread?.cwd)}`);
  if (thread?.id === before) throw new Error('no new session created');
  return 'cwd bound';
});

await test('H3', 'the workspace row menu lists rename, reveal and delete', async () => {
  await page.locator('.workspace-more').click();
  await page.waitForTimeout(300);
  const items = (await page.locator('.workspace-actions [role="menuitem"]').allInnerTexts()).map((text) => text.trim());
  if (!items.some((text) => text.includes('重命名'))) throw new Error(`items: ${items.join(' | ')}`);
  if (!items.some((text) => text.includes('在文件夹显示'))) throw new Error(`items: ${items.join(' | ')}`);
  if (!items.some((text) => text.includes('删除工作区'))) throw new Error(`items: ${items.join(' | ')}`);
  const box = await page.locator('.workspace-actions').boundingBox();
  await page.screenshot({ path: join(shots, 'workspace-actions.png'), clip: { x: box.x - 190, y: box.y - 44, width: box.width + 200, height: box.height + 60 } });
  await page.keyboard.press('Escape');
  await page.locator('.policy-backdrop').first().click({ force: true }).catch(() => undefined);
  return items.length + ' items';
});

await test('H4', 'rename moves the folder and updates the session', async () => {
  await page.locator('.workspace-more').click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.waitForTimeout(300);
  const dialog = page.locator('.workspace-rename');
  if ((await dialog.count()) !== 1) throw new Error('dialog missing');
  await page.locator('.workspace-rename input').fill('renamed-ws');
  await page.getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(1500);
  const renamed = join(home, 'renamed-ws');
  const exists = await stat(renamed).then(() => true).catch(() => false);
  if (!exists) throw new Error('folder not renamed');
  const thread = await newest();
  if (thread.cwd !== renamed) throw new Error(`thread cwd: ${thread.cwd}`);
  const row = (await page.locator('.workspace-name').innerText()).trim();
  if (!row.includes('renamed-ws')) throw new Error(`row: ${row}`);
  return 'renamed';
});

await test('H5', 'delete workspace removes it from the recent list', async () => {
  await page.locator('.workspace-more').click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: '删除工作区' }).click();
  await page.waitForTimeout(900);
  const saved = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  if ((saved.recentWorkspaces ?? []).includes(join(home, 'renamed-ws'))) throw new Error('still in recents');
});

await test('H6', 'the filter shows pinned sessions only', async () => {
  const before = await page.locator('.thread-item').count();
  const thread = await newest();
  await page.evaluate(async (id) => {
    await window.xiaohey.request('thread/pin', { threadId: id, pinned: true });
  }, thread.id);
  await page.waitForTimeout(700);
  await page.locator('.rail-icon[title="只看置顶"]').click();
  await page.waitForTimeout(400);
  const pinned = await page.locator('.thread-item').count();
  if (pinned !== 1) throw new Error(`pinned rows: ${pinned} (before ${before})`);
  await page.locator('.rail-icon[title="只看置顶"]').click();
  await page.waitForTimeout(300);
  return `${pinned} of ${before}`;
});

if (app) await app.close();
await writeFile(join(shots, 'results-31.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
