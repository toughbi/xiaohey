// QA pass 10: document preview renders by file type.
// node .qa/run-10.mjs
import { _electron } from 'playwright-core';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

const home = join(homes, 'preview');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });

const launch = async () => {
  const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_DEMO: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const instance = await _electron.launch({
    executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
    args: ['.'],
    cwd: root,
    env,
  });
  const window = await instance.firstWindow();
  await window.waitForSelector('.app');
  await window.waitForTimeout(1500);
  return { instance, window };
};

// Seed the demo workspace once; extra files are added afterwards so the demo
// snapshot (and therefore the diff for app/page.tsx) stays intact.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=',
  'base64',
);
await mkdir(join(home, 'demo-workspace', 'assets'), { recursive: true });
await writeFile(join(home, 'demo-workspace', 'assets', 'logo.png'), png);
await writeFile(
  join(home, 'demo-workspace', 'NOTES.md'),
  [
    '# 预览测试',
    '',
    '一段说明，带 **粗体** 和 `inline code`。',
    '',
    '| 列 | 值 |',
    '| --- | --- |',
    '| a | 1 |',
    '',
    '```ts',
    'export const answer: number = 42;',
    'const label = `v${answer}`;',
    '```',
    '',
    '[OpenAI](https://openai.com)',
  ].join('\n'),
);

const relaunch = await launch();
app = relaunch.instance;
page = relaunch.window;

const openFiles = async () => {
  await ensureDocs();
  await page.locator('.docs-tab').filter({ hasText: '文件' }).first().click();
  await page.waitForTimeout(400);
  // walk back to the workspace root so each case starts from the same place
  for (let guard = 0; guard < 6; guard += 1) {
    const label = (await page.locator('.docs-path span').first().innerText()).trim();
    if (label === '工作区根目录') break;
    await page.locator('.docs-path button[aria-label="上一级"]').click();
    await page.waitForTimeout(350);
  }
};

await test('A1', 'markdown renders as a document, not raw text', async () => {
  await openFiles();
  const row = page.locator('.file-row').filter({ hasText: 'README.md' }).first();
  if (!(await row.count())) throw new Error('README.md not listed');
  await row.click();
  await page.waitForTimeout(700);
  const heading = (await page.locator('.md-body h1').first().innerText()).trim();
  if (!heading) throw new Error('no rendered heading');
  const raw = await page.locator('.code-panel').count();
  if (raw) throw new Error('markdown still rendered as code');
  const listItems = await page.locator('.md-body li').count();
  const codeBlocks = await page.locator('.md-body .code-panel').count();
  return `h1 "${heading}", ${listItems} list items, ${codeBlocks} fenced blocks`;
});

await test('A2', 'fenced code, tables and inline code render in markdown', async () => {
  await openFiles();
  await page.locator('.file-row').filter({ hasText: 'NOTES.md' }).first().click();
  await page.waitForTimeout(700);
  const tokens = await page.locator('.md-body .code-panel .token').count();
  if (tokens < 3) throw new Error(`tokens: ${tokens}`);
  const rows = await page.locator('.md-body table tr').count();
  if (rows < 2) throw new Error(`table rows: ${rows}`);
  const inline = await page.locator('.md-inline-code').count();
  if (inline < 1) throw new Error('no inline code');
  const link = await page.locator('.md-body a').count();
  if (link < 1) throw new Error('no link');
  return `${tokens} tokens, ${rows} table rows`;
});

await test('A3', 'source files are syntax highlighted with a gutter', async () => {
  await openFiles();
  await page.locator('.file-row').filter({ hasText: 'app' }).first().click();
  await page.waitForTimeout(500);
  await page.locator('.file-row').filter({ hasText: 'page.tsx' }).first().click();
  await page.waitForTimeout(700);
  const keywords = await page.locator('.docs .code-panel .token.keyword').count();
  if (keywords < 3) throw new Error(`keyword tokens: ${keywords}`);
  const gutters = await page.locator('.code-gutter').count();
  if (gutters < 10) throw new Error(`gutters: ${gutters}`);
  const meta = (await page.locator('.code-panel-head').innerText()).trim();
  return `${keywords} keyword tokens, ${gutters} lines`;
});

await test('A4', 'images render inline instead of a binary notice', async () => {
  await openFiles();
  await page.locator('.file-row').filter({ hasText: 'assets' }).first().click();
  await page.waitForTimeout(500);
  await page.locator('.file-row').filter({ hasText: 'logo.png' }).first().click();
  await page.waitForTimeout(900);
  const image = page.locator('.image-preview img');
  if (!(await image.count())) {
    const text = await page.locator('.docs').innerText();
    throw new Error(`no image; docs: ${text.slice(0, 160)}`);
  }
  const src = await image.getAttribute('src');
  if (!src?.startsWith('data:image/')) throw new Error(`src: ${String(src).slice(0, 40)}`);
  return `${src.slice(0, 24)}…`;
});

await test('A5', 'switching back to 改动 still shows the line diff', async () => {
  await openFiles();
  await page.locator('.file-row').filter({ hasText: 'app' }).first().click();
  await page.waitForTimeout(500);
  await page.locator('.file-row').filter({ hasText: 'page.tsx' }).first().click();
  await page.waitForTimeout(700);
  const diffTab = page.locator('.segmented button').filter({ hasText: '改动' }).first();
  if (!(await diffTab.count())) throw new Error('no diff toggle for an edited file');
  await diffTab.click();
  await page.waitForTimeout(500);
  const lines = await page.locator('.diff-row.add, .diff-row.del').count();
  if (lines < 2) throw new Error(`diff lines: ${lines}`);
  return `${lines} changed lines`;
});

await test('A6', 'an unknown text type still reads as plain text', async () => {
  await openFiles();
  await page.locator('.file-row').filter({ hasText: 'lib' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('.file-row').filter({ hasText: 'match.ts' }).first().click();
  await page.waitForTimeout(600);
  const text = await page.locator('.code-text').first().innerText();
  if (!text.length) throw new Error('empty preview');
});

if (app) await app.close();
await writeFile(join(shots, 'results-10.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
