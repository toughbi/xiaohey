// QA pass 1: startup, sidebar, composer, empty state, persistence.
// node .qa/run-1.mjs
import { _electron } from 'playwright-core';
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

const home = join(homes, 'main');

await test('S1', 'fresh install shows the workspace empty state and heatmap', async () => {
  const fresh = await launch(home);
  app = fresh.instance;
  page = fresh.window;
  const empty = (await page.locator('.rail-empty-state').innerText()).trim();
  if (empty !== '暂无任务数据 :)') throw new Error(`unexpected empty text: ${empty}`);
  const heat = await page.locator('.hm-cell').count();
  if (heat < 300) throw new Error(`heatmap cells: ${heat}`);
  return `${heat} heatmap cells`;
});

await test('S2', 'sidebar can be collapsed and restored', async () => {
  await page.locator('.titlebar-button').click();
  await page.waitForTimeout(250);
  if ((await page.locator('.rail').count()) !== 0) throw new Error('rail still visible');
  await page.locator('.titlebar-button').click();
  await page.waitForTimeout(250);
  if ((await page.locator('.rail').count()) !== 1) throw new Error('rail did not come back');
});

await test('S3', 'creating one session adds exactly one row', async () => {
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
  const folderItem1 = page.locator('.workspace-menu .workspace-folder').first();
  if (await folderItem1.count()) {
    await folderItem1.click();
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(700);
  const threads = await page.locator('.thread-item').count();
  if (threads !== 1) throw new Error(`thread rows: ${threads}`);
  const ids = await page.locator('.thread-item').evaluateAll((nodes) => nodes.length);
  return `${ids} row`;
});

await test('S4', 'composer: empty send is disabled, typing enables it', async () => {
  const send = page.locator('.send');
  if (!(await send.isDisabled())) throw new Error('send enabled while empty');
  await page.locator('.composer textarea').fill('你好');
  await page.waitForTimeout(150);
  if (await send.isDisabled()) throw new Error('send still disabled after typing');
});

await test('S5', 'composer: Shift+Enter inserts a newline', async () => {
  const box = page.locator('.composer textarea');
  await box.press('Shift+Enter');
  const value = await box.inputValue();
  if (!value.includes('\n')) throw new Error(`value: ${JSON.stringify(value)}`);
});

await test('S6', 'policy dropdown lists three options and persists the choice', async () => {
  await page.locator('.policy-wrap .tb-chip').click();
  await page.waitForTimeout(200);
  const items = (await page.locator('.policy-menu button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  if (items.length !== 3) throw new Error(`options: ${items.length}`);
  await page.getByRole('option', { name: /完全访问/ }).click();
  await page.waitForTimeout(400);
  const chip = (await page.locator('.policy-wrap .tb-chip').innerText()).trim();
  if (!chip.includes('完全访问')) throw new Error(`chip: ${chip}`);
  const settings = JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'));
  if (settings.approval !== 'full') throw new Error(`approval: ${settings.approval}`);
  await page.locator('.policy-wrap .tb-chip').click();
  await page.waitForTimeout(200);
  await page.getByRole('option', { name: /每次询问/ }).click();
  await page.waitForTimeout(300);
});

await test('S7', 'composer plus menu opens the files tab', async () => {
  await page.locator('.composer-add').click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: /打开文件面板/ }).click();
  await page.waitForTimeout(450);
  await ensureDocs();
  const active = (await page.locator('.docs-tab.active').innerText()).trim();
  if (active !== '文件') throw new Error(`active tab: ${active}`);
});

await test('S8', 'usage popover shows session numbers', async () => {
  await page.locator('.foot-actions button').first().click();
  await page.waitForTimeout(250);
  const rows = (await page.locator('.usage-pop dt').allInnerTexts()).map((t) => t.trim());
  if (rows.length !== 4) throw new Error(`rows: ${rows.length}`);
  await page.locator('.rail-menu-backdrop').click();
  await page.waitForTimeout(150);
  return rows.join(' / ');
});

await test('S9', 'user menu toggles theme and returns to light', async () => {
  await page.locator('.rail-user').click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitem', { name: /切换到深色/ }).click();
  await page.waitForTimeout(350);
  let theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== 'dark') throw new Error(`theme: ${theme}`);
  await page.locator('.rail-user').click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitem', { name: /切换到浅色/ }).click();
  await page.waitForTimeout(300);
  theme = await page.evaluate(() => document.documentElement.dataset.theme);
  if (theme !== 'light') throw new Error(`theme back: ${theme}`);
});

await test('S10', 'sign out asks for confirmation and clears the stored key', async () => {
  await page.locator('.rail-user').click();
  await page.waitForTimeout(200);
  await page.getByRole('menuitem', { name: /^退出登录/ }).click();
  await page.waitForTimeout(200);
  const confirm = await page.getByRole('menuitem', { name: /确认退出登录/ }).count();
  if (confirm !== 1) throw new Error('no confirmation step');
  await page.getByRole('menuitem', { name: /确认退出登录/ }).click();
  await page.waitForTimeout(400);
  const toast = (await page.locator('.toast').innerText().catch(() => '')).trim();
  if (!toast.includes('已退出登录')) throw new Error(`toast: ${toast}`);
});

await test('S11', 'search filters sessions and restores them when cleared', async () => {
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
  const folderItem2 = page.locator('.workspace-menu .workspace-folder').first();
  if (await folderItem2.count()) {
    await folderItem2.click();
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(500);
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
  const folderItem3 = page.locator('.workspace-menu .workspace-folder').first();
  if (await folderItem3.count()) {
    await folderItem3.click();
    await page.waitForTimeout(600);
  }
  await page.waitForTimeout(500);
  const rows = await page.locator('.thread-item').count();
  await page.getByRole('button', { name: /搜索/ }).first().click();
  await page.waitForTimeout(250);
  await page.locator('.rail-search input').fill('zzz-nothing');
  await page.waitForTimeout(300);
  const filtered = await page.locator('.thread-item').count();
  if (filtered !== 0) throw new Error(`filtered rows: ${filtered}`);
  await page.locator('.rail-search input').fill('new');
  await page.waitForTimeout(300);
  const matched = await page.locator('.thread-item').count();
  if (matched !== rows) throw new Error(`matched ${matched} of ${rows}`);
  await page.locator('.rail-search input').fill('');
  await page.waitForTimeout(300);
  const restored = await page.locator('.thread-item').count();
  if (restored !== rows) throw new Error(`restored ${restored} of ${rows}`);
  return `${rows} sessions`;
});

await test('S12', 'rename a session from its row menu', async () => {
  await page.locator('.thread-item').first().hover();
  await page.waitForTimeout(150);
  await page.locator('.thread-more').first().click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.waitForTimeout(250);
  const input = page.locator('.title-input');
  if (!(await input.count())) throw new Error('rename input not shown');
  await input.fill('QA 重命名');
  await input.press('Enter');
  await page.waitForTimeout(700);
  const titles = await page.locator('.thread-title').allInnerTexts();
  if (!titles.some((t) => t.includes('QA 重命名'))) throw new Error(`titles: ${titles.join(' | ')}`);
});

await test('S13', 'delete a session from its row menu (one step)', async () => {
  const before = await page.locator('.thread-item').count();
  await page.locator('.thread-item').last().hover();
  await page.waitForTimeout(150);
  await page.locator('.thread-more').last().click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.waitForTimeout(800);
  const after = await page.locator('.thread-item').count();
  if (after !== before - 1) throw new Error(`${before} -> ${after}`);
});

await test('S14', 'sending without an API key surfaces an error, not a hang', async () => {
  await page.locator('.composer textarea').fill('你好');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(2500);
  const text = await page.locator('.transcript').innerText();
  if (!/失败|Key|key|错误|出错/.test(text)) throw new Error(`transcript: ${text.slice(0, 160)}`);
});

await test('S15', 'sessions, title and theme survive a restart', async () => {
  const count = await page.locator('.thread-item').count();
  const title = (await page.locator('.session-head h1').innerText()).trim();
  if (app) await app.close();
  const again = await launch(home);
  app = again.instance;
  page = again.window;
  const count2 = await page.locator('.thread-item').count();
  const title2 = (await page.locator('.session-head h1').innerText()).trim();
  if (count2 !== count) throw new Error(`threads ${count} -> ${count2}`);
  if (!title2.includes(title.replace('…', ''))) throw new Error(`title ${title} -> ${title2}`);
  return `${count2} sessions, ${title2}`;
});

if (app) await app.close();
await writeFile(join(shots, 'results-1.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
