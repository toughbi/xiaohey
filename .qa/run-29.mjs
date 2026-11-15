// QA pass 29: queueing messages while a turn runs + insert-now mode.
// node .qa/run-29.mjs
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

const PORT = 4812;
server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({ choices: [{ index: 0, delta: { content: '收到，正在处理。\n' } }] });
    // keep the turn running long enough to queue a message
    setTimeout(() => {
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      res.write('data: [DONE]\n\n');
      res.end();
    }, 2600);
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const home = join(homes, 'queue');
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
        maxOutputTokens: 128,
        contextWindow: 32000,
      },
    ],
    activeModelId: 'm',
    approval: 'ask',
    allowedCommands: [],
    recentWorkspaces: [join(home, 'workspace')],
  }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'workspace') };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);
await page.locator('.rail-new').click();
await page.waitForTimeout(500);
await page.locator('.workspace-row').click();
await page.waitForTimeout(250);
await page.locator('.workspace-menu .workspace-folder').first().click();
await page.waitForTimeout(600);

const sendNow = async (text) => {
  await page.locator('.composer textarea').fill(text);
  await page.locator('.composer textarea').press('Enter');
};

await test('Q1', 'typing while a turn runs queues instead of sending', async () => {
  await sendNow('第一轮：慢慢来');
  await page.waitForTimeout(500);
  if ((await page.locator('.send.stop-mode').count()) !== 1) throw new Error('not running');
  await sendNow('排队一');
  await page.waitForTimeout(400);
  const head = await page.locator('.queue-title').innerText();
  if (!head.includes('1 条排队消息')) throw new Error(`head: ${head}`);
  if ((await page.locator('.queue-item .queue-text').first().innerText()) !== '排队一') throw new Error('row text');
  if ((await page.locator('.composer textarea').inputValue()) !== '') throw new Error('draft not cleared');
  return 'queued';
});

await test('Q2', 'a second message joins the queue; edit and delete work', async () => {
  await sendNow('排队二');
  await page.waitForTimeout(300);
  const count = await page.locator('.queue-item').count();
  if (count !== 2) throw new Error(`items: ${count}`);
  await page.locator('.queue-actions button[aria-label="编辑"]').first().click();
  await page.locator('.queue-edit').fill('排队一（改）');
  await page.locator('.queue-edit').press('Enter');
  await page.waitForTimeout(200);
  const text = await page.locator('.queue-item .queue-text').first().innerText();
  if (text !== '排队一（改）') throw new Error(`edited: ${text}`);
  await page.locator('.queue-actions button[aria-label="删除"]').last().click();
  await page.waitForTimeout(200);
  if ((await page.locator('.queue-item').count()) !== 1) throw new Error('delete failed');
  const box = await page.locator('.queue-panel').boundingBox();
  await page.screenshot({ path: join(shots, 'queue-panel.png'), clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height + 90, 260) } });
  return 'edited + deleted';
});

await test('Q3', 'the queued message starts a new turn when the first finishes', async () => {
  const seen = await page.locator('.transcript .bubble-user, .transcript .user-text').count();
  await page.waitForFunction(() => !document.querySelector('.send.stop-mode'), null, { timeout: 12000 });
  await page.waitForTimeout(1200);
  const users = await page.locator('.transcript .user-text').allInnerTexts();
  if (users.length < 2) throw new Error(`user messages: ${users.length}`);
  if (!users.some((text) => text.includes('排队一（改）'))) throw new Error(`second turn missing: ${users.join(' | ')}`);
  if ((await page.locator('.queue-item').count()) !== 0) throw new Error('queue not drained');
  return `${users.length} turns`;
});

await test('Q4', 'insert-now aborts the running turn and sends immediately', async () => {
  await sendNow('第三轮：继续慢');
  await page.waitForTimeout(500);
  await sendNow('插队消息');
  await page.waitForTimeout(400);
  await page.locator('.queue-actions button[aria-label="立即发送"]').last().click();
  await page.waitForTimeout(4200);
  const users = await page.locator('.transcript .user-text').allInnerTexts();
  if (!users.some((text) => text.includes('插队消息'))) throw new Error(`insert missing: ${users.join(' | ')}`);
  if ((await page.locator('.queue-item').count()) !== 0) throw new Error('queue not empty');
  return 'inserted';
});

await test('Q5', 'the queue can collapse and expand', async () => {
  if ((await page.locator('.queue-item').count()) === 0) {
    // seed one entry again if the queue drained
    await sendNow('第四轮：再慢一点');
    await page.waitForSelector('.send.stop-mode', { timeout: 8000 });
    await sendNow('折叠测试');
    await page.waitForTimeout(300);
  }
  await page.locator('.queue-title').click();
  await page.waitForTimeout(250);
  if ((await page.locator('.queue-item').count()) !== 0) throw new Error('rows still visible');
  await page.locator('.queue-title').click();
  await page.waitForTimeout(250);
  if ((await page.locator('.queue-item').count()) === 0) throw new Error('rows did not come back');
  return 'collapsed + expanded';
});

if (app) await app.close();
if (server) server.close();
await writeFile(join(shots, 'results-29.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
