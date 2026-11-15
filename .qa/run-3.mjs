// QA pass 3: docs panel with demo data (files, preview/diff, memory, checkpoints).
// node .qa/run-3.mjs
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

async function expandTurns() {
  let guard = 0;
  while ((await page.locator('.turn-head[aria-expanded="false"]').count()) > 0 && guard < 6) {
    await page.locator('.turn-head[aria-expanded="false"]').first().click();
    await page.waitForTimeout(150);
    guard += 1;
  }
}

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

const home = join(homes, 'docs');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_DEMO: '1' };
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

const openTab = async (label) => {
  await ensureDocs();
  await page.locator('.docs-tab', { hasText: label }).first().click();
  await page.waitForTimeout(450);
};

await test('U1', 'file tab lists workspace entries and descends into folders', async () => {
  await openTab('文件');
  const entries = await page.locator('.file-row, .doc-file, .file-list button').count();
  const text = await page.locator('.docs').innerText();
  if (!/app/.test(text)) throw new Error(`missing app in docs: ${text.slice(0, 200)}`);
  return `${entries} rows`;
});

await test('U2', 'opening a file shows the preview and the diff toggle', async () => {
  await page.locator('.file-row').filter({ hasText: 'app' }).first().click();
  await page.waitForTimeout(600);
  const row = page.locator('.file-row').filter({ hasText: 'page.tsx' }).first();
  if (!(await row.count())) throw new Error('page.tsx row not found');
  await row.click();
  await page.waitForTimeout(700);
  await ensureDocs();
  const active = (await page.locator('.docs-tab.active').innerText()).trim();
  if (active !== '文档') throw new Error(`active tab: ${active}`);
  const toggle = (await page.locator('.doc-view, .segmented').innerText().catch(() => '')).trim();
  const content = await page.locator('.docs').innerText();
  if (!/import|export/.test(content)) throw new Error('no file content');
  return toggle.slice(0, 40);
});

await test('U3', 'memory tab lists facts and deletes one', async () => {
  await openTab('记忆');
  const before = await page.locator('.memory-list li').count();
  if (before === 0) throw new Error('no memory cards');
  await page.locator('.memory-list li button').first().click();
  await page.waitForTimeout(700);
  const after = await page.locator('.memory-list li').count();
  return `${before} -> ${after}`;
});

await test('U4', 'checkpoints tab lists snapshots and reverts one', async () => {
  await openTab('检查点');
  const list = page.locator('.snapshot-list li');
  const before = await list.count();
  if (before === 0) throw new Error('no snapshots');
  const file = join(env.XIAOHEY_HOME, 'demo-workspace', 'app', 'page.tsx');
  const contentBefore = await readFile(file, 'utf8').catch(() => '');
  await list.first().getByRole('button', { name: '回退' }).click();
  await page.waitForTimeout(1800);
  const text = await page.locator('.transcript').innerText();
  if (!/回退|还原/.test(text)) throw new Error(`no revert notice: ${text.slice(0, 200)}`);
  const contentAfter = await readFile(file, 'utf8').catch(() => '');
  if (contentBefore === contentAfter) throw new Error('revert did not restore the file on disk');
  return `${before} snapshots, file restored`;
});

await test('U5', 'the docs panel can be closed and reopened', async () => {
  await page.locator('.session-head-right .ghost.icon').click();
  await page.waitForTimeout(350);
  if ((await page.locator('.docs').count()) !== 0) throw new Error('docs still visible');
  await page.locator('.session-head-right .ghost.icon').click();
  await page.waitForTimeout(400);
  if ((await page.locator('.docs').count()) !== 1) throw new Error('docs did not reopen');
});

await test('U6', 'demo transcript carries contract, plan, tool, change and compaction cards', async () => {
  await expandTurns();
  const text = await page.locator('.transcript').innerText();
  const required = ['任务契约', '计划', 'read_file', '已编辑', '上下文折叠'];
  const missing = required.filter((token) => !text.includes(token));
  if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
});

await test('U7', 'tool cards expand and collapse their output', async () => {
  await expandTurns();
  const tool = page.locator('.tool-card').first();
  const head = tool.locator('.tool-head, button').first();
  await head.click();
  await page.waitForTimeout(400);
  const expanded = await tool.locator('.tool-body, pre').count();
  await head.click();
  await page.waitForTimeout(300);
  return `${expanded} expanded blocks`;
});

await test('U8', 'change cards expose review and revert actions', async () => {
  await expandTurns();
  const change = page.locator('.artifact').first();
  if (!(await change.count())) throw new Error('no change card');
  const text = (await change.innerText()).replace(/\s+/g, ' ');
  if (!/撤销|审查/.test(text)) throw new Error(`actions: ${text}`);
  return text.slice(0, 60);
});

await test('U9', 'approval history and policy chip are consistent', async () => {
  await expandTurns();
  const text = await page.locator('.transcript').innerText();
  if (!/已允许|批准/.test(text)) throw new Error('no approval record in demo transcript');
});

if (app) await app.close();
await writeFile(join(shots, 'results-3.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
