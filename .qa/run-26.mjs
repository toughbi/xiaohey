// QA pass 26: markdown stress (long table, long tokens, long code) and plain-text tooltips.
// node .qa/run-26.mjs
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
let server;

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

const longToken = 'x'.repeat(240);
const longLine = 'console.log("' + 'y'.repeat(220) + '");';
const PORT = 4809;
let turn = 0;
server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    turn += 1;
    const content =
      turn === 1
        ? `## 结论\n\n| 名称 | 说明 |\n| --- | --- |\n| **Alpha** | 一个很长的单元格 ${longToken} |\n| Beta | 普通说明 |\n\n1. 第一步\n2. 第二步\n\n\`\`\`js\n${longLine}\n\`\`\`\n`
        : `第二轮回答：\n\n- 列表项\n- 另一个\n\n> 引用一句\n`;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ choices: [{ index: 0, delta: { role: 'assistant', content } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const home = join(homes, 'stress');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(join(home, 'workspace'), { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    models: [
      {
        id: 'm',
        name: 'Fake',
        provider: 'custom',
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        apiKey: 'x',
        model: 'fake',
        temperature: 0,
        maxOutputTokens: 400,
        contextWindow: 32000,
      },
    ],
    activeModelId: 'm',
    approval: 'full',
    allowedCommands: [],
  }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'workspace') };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 640));
await page.waitForTimeout(800);
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
await page.waitForTimeout(500);
await page.locator('.composer textarea').fill('第一轮：给我一个表格和一段很长的代码');
await page.locator('.composer textarea').press('Enter');
await page.waitForTimeout(2200);

await test('S1', 'a wide table scrolls inside its own wrapper', async () => {
  if ((await page.locator('.md-table-wrap table').count()) !== 1) throw new Error('table missing');
  const wrapper = await page.locator('.md-table-wrap').evaluate((node) => ({
    overflowX: getComputedStyle(node).overflowX,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  if (wrapper.overflowX !== 'auto') throw new Error(`overflow-x: ${wrapper.overflowX}`);
  const table = await page.locator('.md-table-wrap table').evaluate((node) => node.getBoundingClientRect().width);
  if (table > wrapper.clientWidth + 2) throw new Error('table escaped its wrapper');
  return `table ${Math.round(table)} in ${wrapper.clientWidth}`;
});

await test('S2', 'the transcript itself never overflows horizontally', async () => {
  const over = await page.locator('.transcript').evaluate((node) => node.scrollWidth - node.clientWidth);
  if (over > 2) throw new Error(`overflow ${over}px`);
  const body = await page.locator('.md-chat').first().evaluate((node) => node.scrollWidth - node.clientWidth);
  if (body > 2) throw new Error(`markdown overflow ${body}px`);
  return 'clean';
});

await test('S3', 'a 240-char token wraps instead of widening the column', async () => {
  const token = page.locator('.md-chat td').first();
  const box = await token.boundingBox();
  const holder = await page.locator('.transcript').boundingBox();
  if (!box) throw new Error('no cell');
  if (box.x + box.width > holder.x + holder.width + 2) throw new Error('cell escaped the column');
  const lines = await token.evaluate((node) => Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight || '20')));
  if (lines < 2) throw new Error(`not wrapped (${lines} lines)`);
  return `${lines} lines`;
});

await test('S4', 'a long code line wraps without widening the block', async () => {
  const block = page.locator('.md-chat .code-panel').first();
  if ((await block.count()) === 0) throw new Error('code block missing');
  const info = await block.evaluate((node) => ({
    overflowX: getComputedStyle(node).overflowX,
    scrollWidth: node.scrollWidth,
    clientWidth: node.clientWidth,
  }));
  if (info.overflowX !== 'clip') throw new Error(`overflow-x: ${info.overflowX}`);
  if (info.scrollWidth > info.clientWidth + 2) throw new Error('code block overflowed');
  const wrap = await page.locator('.md-chat .code-text').first().evaluate((node) => getComputedStyle(node).whiteSpace);
  if (wrap !== 'pre-wrap') throw new Error(`white-space: ${wrap}`);
  return 'wrapped in block';
});

await test('S5', 'the minimap tooltip shows plain text, not markdown', async () => {
  await page.locator('.composer textarea').fill('第二轮：随便聊聊');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(1800);
  await page.locator('.minimap-stripe').first().hover();
  await page.waitForTimeout(400);
  const tip = await page.locator('.minimap-tip').innerText();
  if (/\*\*|`{1,3}|^#{1,6}\s/m.test(tip)) throw new Error(`raw markdown in tooltip: ${tip.slice(0, 80)}`);
  if (!tip.trim()) throw new Error('empty tooltip');
  const box = await page.locator('.transcript-holder').boundingBox();
  await page.screenshot({
    path: join(shots, 'stress-tooltip.png'),
    clip: { x: box.x + box.width - 360, y: box.y, width: 360, height: Math.min(box.height, 380) },
  });
  return tip.slice(0, 30);
});

if (app) await app.close();
if (server) server.close();
await writeFile(join(shots, 'results-26.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
