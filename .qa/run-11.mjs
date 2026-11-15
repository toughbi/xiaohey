// QA pass 11: the interactions added after the report (references, copy, export, retry,
// approvals tab, memory editing, shortcuts, jump-to-latest, docs refresh).
// node .qa/run-11.mjs
import { _electron } from 'playwright-core';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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

const home = join(homes, 'features');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const workspace = join(home, 'demo-workspace');
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: workspace, XIAOHEY_DEMO: '1' };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
  args: ['.'],
  cwd: root,
  env,
});
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(1600);

const threadDoc = async () => {
  const files = await readdir(join(home, 'threads'));
  const docs = await Promise.all(files.map((file) => readFile(join(home, 'threads', file), 'utf8')));
  return docs.map((text) => JSON.parse(text)).sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)[0];
};

await test('F1', 'the plus menu can reference a workspace file', async () => {
  await page.locator('.composer-add').click();
  await page.waitForTimeout(250);
  const items = (await page.locator('.plus-menu button').allInnerTexts()).map((text) => text.trim());
  if (items.length !== 2) throw new Error(`menu: ${items.join(',')}`);
  await page.getByRole('menuitem', { name: /引用工作区文件/ }).click();
  await page.waitForTimeout(500);
  await page.locator('.reference-head input').fill('README');
  await page.waitForTimeout(300);
  const row = page.locator('.reference-list button').first();
  if (!(await row.count())) throw new Error('no files in the picker');
  await row.click();
  await page.waitForTimeout(250);
  const value = await page.locator('.composer textarea').inputValue();
  if (!value.startsWith('@')) throw new Error(`value: ${value}`);
  return value;
});

await test('F2', 'a file row can be dragged into the composer', async () => {
  await ensureDocs();
  await page.locator('.docs-tab').filter({ hasText: '文件' }).first().click();
  await page.waitForTimeout(400);
  const draggable = await page.locator('.file-row').filter({ hasText: 'README' }).first().getAttribute('draggable');
  if (draggable !== 'true') throw new Error('file row is not draggable');
  await page.evaluate(() => {
    const textarea = document.querySelector('.composer');
    const transfer = new DataTransfer();
    transfer.setData('text/x-xiaohey-path', 'README.md');
    textarea.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForTimeout(250);
  const value = await page.locator('.composer textarea').inputValue();
  if (!value.includes('@README.md')) throw new Error(`value: ${value}`);
});

await test('F3', 'sending with @reference stores the file contents for the model', async () => {
  await page.locator('.composer textarea').fill('看这个 @README.md 并总结一下');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(3000);
  const doc = await threadDoc();
  const users = doc.items.filter((item) => item.kind === 'message' && item.role === 'user');
  const user = users[users.length - 1];
  if (!user?.references?.length) throw new Error('user message has no references');
  if (user.references[0].path !== 'README.md') throw new Error(`path: ${user.references[0].path}`);
  if (!String(user.references[0].content).includes('Northwind')) throw new Error('reference content missing');
  return `${user.references.length} reference(s)`;
});

await test('F4', 'assistant replies expose a copy button that confirms', async () => {
  await page.waitForFunction(() => !document.querySelector('.send.stop-mode'), null, { timeout: 15000 });
  await page.waitForTimeout(400);
  const block = page.locator('.reply-block').filter({ has: page.locator('.agent-text') }).last();
  await block.hover();
  const copy = page.locator('.reply-actions .message-copy').last();
  if (!(await copy.count())) throw new Error('no copy button');
  await copy.click();
  await page.waitForTimeout(300);
  const done = await copy.evaluate((node) => node.classList.contains('done'));
  if (!done) throw new Error('copy did not confirm');
});

await test('F5', 'the session menu copies the transcript as markdown', async () => {
  await page.locator('.session-head .menu-wrap .ghost.icon').click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '复制为 Markdown' }).click();
  await page.waitForTimeout(500);
  const toast = (await page.locator('.toast').innerText().catch(() => '')).trim();
  if (!toast.includes('已复制')) throw new Error(`toast: ${toast}`);
});

await test('F6', 'the session menu exports a markdown file into exports/', async () => {
  await page.locator('.session-head .menu-wrap .ghost.icon').click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: /导出 .md 到 exports/ }).click();
  await page.waitForTimeout(700);
  const toast = (await page.locator('.toast').innerText().catch(() => '')).trim();
  if (!toast.includes('exports/')) throw new Error(`toast: ${toast}`);
  const folder = join(workspace, 'exports');
  const files = await readdir(folder).catch(() => []);
  if (files.length === 0) throw new Error('no exported file');
  const content = await readFile(join(folder, files[0]), 'utf8');
  if (!content.includes('## 用户')) throw new Error('export looks empty');
  return files[0];
});

await test('F7', 'a failed turn offers a retry button', async () => {
  const failed = (await page.locator('.session-head').innerText()).includes('出错') || (await page.locator('.session-status').innerText().catch(() => '')).includes('出错');
  const retry = page.getByRole('button', { name: '重试上一轮' });
  if (!(await retry.count())) throw new Error(`no retry button (failed=${failed})`);
  await retry.click();
  await page.waitForTimeout(1500);
});

await test('F8', 'the approvals tab lists past decisions', async () => {
  await ensureDocs();
  await page.locator('.docs-tab').filter({ hasText: '审批' }).first().click();
  await page.waitForTimeout(500);
  const text = await page.locator('.docs').innerText();
  if (!/run_shell|read_file|write_file/.test(text)) throw new Error(`no approval rows: ${text.slice(0, 120)}`);
  const rows = await page.locator('.approval-list li').count();
  return `${rows} row(s)`;
});

await test('F9', 'memory can be added and edited from the docs panel', async () => {
  await ensureDocs();
  await page.locator('.docs-tab').filter({ hasText: '记忆' }).first().click();
  await page.waitForTimeout(400);
  const inputs = page.locator('.memory-form input');
  await inputs.nth(0).fill('qa.note');
  await inputs.nth(1).fill('测试里写下的一条记忆');
  await page.getByRole('button', { name: '记下' }).click();
  await page.waitForTimeout(700);
  const text = await page.locator('.memory-list').innerText();
  if (!text.includes('qa.note')) throw new Error('memory entry not listed');
  await page.locator('.memory-list li').filter({ hasText: 'qa.note' }).getByRole('button', { name: '编辑' }).click();
  await page.waitForTimeout(250);
  await page.locator('.memory-edit input').fill('改过的记忆');
  await page.locator('.memory-edit').getByRole('button', { name: '保存' }).click();
  await page.waitForTimeout(700);
  const updated = await page.locator('.memory-list').innerText();
  if (!updated.includes('改过的记忆')) throw new Error('memory edit not applied');
});

await test('F10', 'the files tab can refresh its listing', async () => {
  await ensureDocs();
  await page.locator('.docs-tab').filter({ hasText: '文件' }).first().click();
  await page.waitForTimeout(400);
  await writeFile(join(workspace, 'freshly-added.txt'), 'hello', 'utf8');
  await page.getByRole('button', { name: '刷新' }).click();
  await page.waitForTimeout(700);
  const text = await page.locator('.docs').innerText();
  if (!text.includes('freshly-added.txt')) throw new Error('new file not listed after refresh');
});

await test('F11', 'shortcuts toggle the rail and open settings', async () => {
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(300);
  if ((await page.locator('.rail').count()) !== 0) throw new Error('rail still visible');
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+,');
  await page.waitForTimeout(500);
  if ((await page.locator('.settings-view').count()) !== 1) throw new Error('settings did not open');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /返回应用/ }).click();
  await page.waitForTimeout(300);
});

await test('F12', 'scrolling up exposes a jump-to-latest button', async () => {
  // The turn starts collapsed; expanding it gives the transcript enough height
  // for the jump button to be reachable.
  const head = page.locator('.turn-head').first();
  if ((await head.count()) && (await head.getAttribute('aria-expanded')) === 'false') {
    await head.click();
    await page.waitForTimeout(300);
  }
  await page.locator('.transcript').evaluate((node) => {
    node.scrollTop = 0;
    node.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const jump = page.getByRole('button', { name: '回到最新' });
  if (!(await jump.count())) throw new Error('no jump button');
  await jump.click();
  await page.waitForTimeout(600);
  const distance = await page.locator('.transcript').evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight);
  return `distance ${Math.round(distance)}px`;
});

if (app) await app.close();
await writeFile(join(shots, 'results-11.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
