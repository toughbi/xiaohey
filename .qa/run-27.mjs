// QA pass 27: the workspace picker (search, default, recents, new workspace, SSH placeholder).
// node .qa/run-27.mjs
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

const home = join(homes, 'ws-picker');
const first = join(home, 'workspace');
const third = join(home, 'third-workspace');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(first, { recursive: true });
await mkdir(third, { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    models: [],
    activeModelId: '',
    approval: 'ask',
    allowedCommands: [],
    recentWorkspaces: [third],
  }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: first };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);
await page.locator('.rail-new').click();
await page.waitForTimeout(600);

const openMenu = async () => {
  if ((await page.locator('.workspace-menu').count()) === 0) {
    await page.locator('.workspace-row').click();
    await page.waitForTimeout(300);
  }
};

await test('V1', 'the picker has search, 本机, the default entry, the recent folder and the actions', async () => {
  await openMenu();
  const placeholder = await page.locator('.workspace-search input').getAttribute('placeholder');
  if (placeholder !== '搜索名称或路径') throw new Error(`placeholder: ${placeholder}`);
  const group = await page.locator('.workspace-group-label').innerText();
  if (group !== '本机') throw new Error(`group: ${group}`);
  const items = (await page.locator('.workspace-menu [role="menuitem"]').allInnerTexts()).map((text) => text.trim());
  if (!items.some((text) => text.includes('不指定工作区'))) throw new Error(`items: ${items.join(' | ')}`);
  if (!items.some((text) => text.includes('third-workspace'))) throw new Error(`recent missing: ${items.join(' | ')}`);
  if (!items.some((text) => text.includes('新建工作区'))) throw new Error(`new missing: ${items.join(' | ')}`);
  if (!items.some((text) => text.includes('连接 SSH 主机'))) throw new Error(`ssh missing: ${items.join(' | ')}`);
  const checks = await page.locator('.workspace-check').count();
  if (checks !== 1) throw new Error(`checks: ${checks}`);
  const sshDisabled = await page.locator('.workspace-menu button.disabled').isDisabled();
  if (!sshDisabled) throw new Error('SSH item is clickable');
  const box = await page.locator('.workspace-menu').boundingBox();
  await page.screenshot({ path: join(shots, 'workspace-picker.png'), clip: { x: box.x - 6, y: box.y - 6, width: box.width + 12, height: box.height + 12 } });
  return items.length + ' items';
});

await test('V2', 'search filters by folder name', async () => {
  await page.locator('.workspace-search input').fill('third');
  await page.waitForTimeout(300);
  const names = (await page.locator('.workspace-menu [role="menuitem"] .workspace-item-name').allInnerTexts()).map((text) => text.trim());
  if (!names.includes('third-workspace')) throw new Error(`names: ${names.join(' | ')}`);
  if (names.some((name) => name === '不指定工作区')) throw new Error(`filter kept the default: ${names.join(' | ')}`);
  await page.locator('.workspace-search input').fill('');
  await page.waitForTimeout(250);
  return names.join(', ');
});

await test('V3', 'picking a recent folder switches the session workspace', async () => {
  await page.locator('.workspace-menu [role="menuitem"]', { hasText: 'third-workspace' }).click();
  await page.waitForTimeout(1600);
  const banner = await page.locator('.banner').innerText().catch(() => '');
  if (banner) throw new Error(`banner: ${banner}`);
  const current = (await page.locator('.workspace-row').innerText()).trim();
  if (!current.includes('third-workspace')) throw new Error(`workspace row: ${current}`);
  const saved = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  if (saved.recentWorkspaces[0] !== third) throw new Error(`recents: ${saved.recentWorkspaces.join(',')}`);
});

await test('V4', '不指定工作区 opens a session that waits for a folder', async () => {
  await openMenu();
  await page.locator('.workspace-menu [role="menuitem"]', { hasText: '不指定工作区' }).click();
  await page.waitForTimeout(1400);
  const current = (await page.locator('.workspace-row').innerText()).trim();
  if (!current.includes('不指定工作区')) throw new Error(`workspace row: ${current}`);
});

if (app) await app.close();
await writeFile(join(shots, 'results-27.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
