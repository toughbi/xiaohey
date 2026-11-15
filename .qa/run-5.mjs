// QA pass 5: real turn loop against a fake OpenAI-compatible endpoint.
// Covers streaming, token accounting, cancellation and error surfacing.
// node .qa/run-5.mjs
import { _electron } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'E:/code/xiaohei';
const shots = join(root, '.qa');
const homes = join(root, '.qa-homes');
const results = [];
let page;
let app;
let mode = 'stream';

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

const PORT = 4789;
const server = createServer((req, res) => {
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  if (mode === 'hang') {
    return; // never respond, keep the turn running
  }
  if (mode === 'error') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'fake upstream exploded' } }));
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
  send({ id: 'chatcmpl-qa', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }] });
  setTimeout(() => {
    send({ id: 'chatcmpl-qa', choices: [{ index: 0, delta: { content: '，这是测试回复。' } }] });
    send({
      id: 'chatcmpl-qa',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  }, 120);
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const home = join(homes, 'turns');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    models: [
      {
        id: 'fake',
        name: 'Fake',
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        apiKey: 'sk-fake',
        model: 'fake-model',
        temperature: 0,
        maxOutputTokens: 512,
        contextWindow: 32000,
      },
    ],
    activeModelId: 'fake',
    approval: 'auto',
  }),
);

app = await _electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
  args: ['.'],
  cwd: root,
  env: (() => { const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'workspace') }; delete env.ELECTRON_RUN_AS_NODE; return env; })(),
});
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
await page.waitForTimeout(500);

await test('W1', 'a streamed reply lands in the transcript', async () => {
  await page.locator('.composer textarea').fill('你好');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(3000);
  const text = await page.locator('.transcript').innerText();
  if (!text.includes('这是测试回复')) throw new Error(`transcript: ${text.slice(0, 200)}`);
  return 'assistant text visible';
});

await test('W2', 'token and step counters update after the turn', async () => {
  const meta = (await page.locator('.composer-meta').innerText()).replace(/\s+/g, ' ');
  if (!/150\s*tok/.test(meta.replace(',', ''))) throw new Error(`meta: ${meta}`);
  const files = await readdir(join(home, 'threads'));
  let totals = null;
  for (const file of files) {
    const doc = JSON.parse(await readFile(join(home, 'threads', file), 'utf8'));
    if (doc.thread.id === doc.thread.id) totals = { tokens: doc.thread.totalTokens, steps: doc.thread.steps, turns: doc.thread.turnCount };
  }
  if (!totals || totals.tokens !== 150) throw new Error(`thread totals: ${JSON.stringify(totals)}`);
  return `${meta.slice(0, 40)} / steps ${totals.steps}`;
});

await test('W3', 'the send button turns into stop while running, and stops the turn', async () => {
  mode = 'hang';
  await page.locator('.composer textarea').fill('请慢一点');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(1200);
  const stopVisible = await page.locator('.send.stop-mode').count();
  if (!stopVisible) throw new Error('stop button not shown while running');
  if ((await page.locator('.send.stop-mode').getAttribute('aria-label')) !== '停止生成') throw new Error('wrong stop label');
  const glyph = await page.locator('.stop-square').boundingBox();
  if (!glyph || glyph.width < 8 || glyph.height < 8) throw new Error('stop glyph missing');
  await page.locator('.send.stop-mode').click();
  await page.waitForTimeout(2200);
  const stillRunning = await page.locator('.send.stop-mode').count();
  if (stillRunning) throw new Error('turn still running after stop');
  const text = await page.locator('.transcript').innerText();
  return /中止|已停止|取消/.test(text) ? 'stopped with notice' : 'stopped (no notice)';
});

await test('W4', 'an upstream 500 surfaces as a readable error', async () => {
  mode = 'error';
  await page.locator('.composer textarea').fill('失败一下');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(2500);
  const text = await page.locator('.transcript').innerText();
  if (!/失败|错误|500/.test(text)) throw new Error(`transcript: ${text.slice(0, 200)}`);
  const hasRaw = /fake upstream exploded/.test(text);
  return hasRaw ? 'upstream message shown' : 'generic message only';
});

await test('W5', 'a second turn still works after a failure', async () => {
  mode = 'stream';
  await page.locator('.composer textarea').fill('再来一次');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(3000);
  const text = await page.locator('.transcript').innerText();
  if (!text.includes('这是测试回复')) throw new Error('no reply after failure');
  const status = (await page.locator('.session-status').innerText().catch(() => '')).trim();
  return status || 'ok';
});

if (app) await app.close();
server.close();
await writeFile(join(shots, 'results-5.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
