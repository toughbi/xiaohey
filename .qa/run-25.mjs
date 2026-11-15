// QA pass 25: the turn minimap (stripes, hover summary, click to jump).
// node .qa/run-25.mjs
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

const PORT = 4804;
let count = 0;
server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    count += 1;
    send({ choices: [{ index: 0, delta: { content: `第 ${count} 轮回答。\n\n${'内容行内容行内容行。'.repeat(14)}` } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const home = join(homes, 'minimap');
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
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1000, 620));
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

await test('M1', 'a single-turn session shows no rail', async () => {
  await page.locator('.composer textarea').fill('第一轮：看看这个项目');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(1600);
  if ((await page.locator('.minimap').count()) !== 0) throw new Error('rail rendered for one turn');
});

await test('M2', 'each turn gets a stripe, in document order', async () => {
  for (const text of ['第二轮：改一下代码', '第三轮：跑测试']) {
    await page.locator('.composer textarea').fill(text);
    await page.locator('.composer textarea').press('Enter');
    await page.waitForTimeout(1500);
  }
  const stripes = page.locator('.minimap-stripe');
  const total = await stripes.count();
  if (total !== 3) throw new Error(`stripes: ${total}`);
  const tops = await page.locator('.minimap-slot').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().top)));
  for (let index = 1; index < tops.length; index += 1) {
    if (tops[index] <= tops[index - 1]) throw new Error(`positions: ${tops.join(',')}`);
  }
  const holder = await page.locator('.transcript-holder').boundingBox();
  const center = (tops[0] + tops[tops.length - 1]) / 2 - holder.y;
  const middle = holder.height / 2;
  if (Math.abs(center - middle) > 12) throw new Error(`not centered: ${center} vs ${middle}`);
  return `${total} stripes, centered ${Math.round(center)}/${Math.round(middle)}`;
});

await test('M3', 'hovering a stripe shows its summary without resizing', async () => {
  const first = page.locator('.minimap-stripe').first();
  const before = await first.evaluate((node) => {
    const css = getComputedStyle(node);
    return { width: css.width, height: css.height, color: css.backgroundColor };
  });
  await first.hover();
  await page.waitForTimeout(300);
  const tip = await page.locator('.minimap-tip').innerText();
  if (!tip.includes('第一轮')) throw new Error(`tip title: ${tip}`);
  if (!/回答|内容/.test(tip)) throw new Error(`tip excerpt: ${tip}`);
  if ((await page.locator('.minimap-tip strong').count()) !== 1) throw new Error('tooltip has no title');
  const after = await first.evaluate((node) => {
    const css = getComputedStyle(node);
    return { width: css.width, height: css.height, color: css.backgroundColor, hovered: node.classList.contains('hovered') };
  });
  if (!after.hovered) throw new Error('stripe did not enter hover state');
  if (after.width !== before.width || after.height !== before.height) {
    throw new Error(`stripe changed size: ${before.width}x${before.height} -> ${after.width}x${after.height}`);
  }
  if (after.color === before.color) throw new Error(`color unchanged ${before.color}`);
  return `${after.width}x${after.height}, darker`;
});

await test('M4', 'clicking a stripe scrolls to that turn', async () => {
  await page.locator('.transcript').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.waitForTimeout(300);
  const before = await page.locator('.transcript').evaluate((node) => node.scrollTop);
  await page.locator('.minimap-stripe').last().click();
  await page.waitForTimeout(800);
  const after = await page.locator('.transcript').evaluate((node) => node.scrollTop);
  if (after <= before) throw new Error(`scrollTop ${before} -> ${after}`);
  const box = await page.locator('.transcript-holder').boundingBox();
  await page.screenshot({ path: join(shots, 'minimap.png'), clip: { x: box.x + box.width - 300, y: box.y, width: 300, height: Math.min(box.height, 360) } });
  return `${before} -> ${Math.round(after)}`;
});

await test('M5', 'the transcript scrollbar is hidden', async () => {
  const metrics = await page.locator('.transcript').evaluate((node) => ({
    scrollbar: node.offsetWidth - node.clientWidth,
    css: getComputedStyle(node).scrollbarWidth,
  }));
  if (metrics.scrollbar > 1) throw new Error(`scrollbar takes ${metrics.scrollbar}px`);
  if (metrics.css !== 'none') throw new Error(`scrollbar-width: ${metrics.css}`);
});

if (app) await app.close();
if (server) server.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-25.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
