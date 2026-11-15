// QA pass 32: the edited-files card stays visible after the final answer.
// node .qa/run-32.mjs
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

const PORT = 4814;
server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    let afterTool = false;
    try {
      const parsed = JSON.parse(body);
      const messages = parsed.messages ?? [];
      afterTool = messages[messages.length - 1]?.role === 'tool';
    } catch {}
    if (afterTool) {
      send({ choices: [{ index: 0, delta: { content: '已经写好 qa-note.txt。' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 90, completion_tokens: 12 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    send({
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'call_write_1',
                type: 'function',
                function: { name: 'write_file', arguments: JSON.stringify({ path: 'qa-note.txt', content: 'hello qa\n' }) },
              },
            ],
          },
        },
      ],
    });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const home = join(homes, 'result-card');
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
    approval: 'full',
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
await page.locator('.composer textarea').fill('写一个 qa-note.txt');
await page.locator('.composer textarea').press('Enter');
await page.waitForFunction(() => !document.querySelector('.send.stop-mode'), null, { timeout: 30000 });
await page.waitForTimeout(900);

await test('C1', 'a finished turn keeps the edited-files card below the answer', async () => {
  const card = page.locator('.turn-result .artifact');
  if ((await card.count()) !== 1) throw new Error('result card missing');
  const openHead = await page.locator('.turn-head[aria-expanded="false"]').count();
  if (openHead !== 1) throw new Error('process should stay folded');
  const order = await page.evaluate(() => {
    const text = document.querySelector('.agent-text');
    const result = document.querySelector('.turn-result');
    if (!text || !result) return null;
    return text.getBoundingClientRect().top < result.getBoundingClientRect().top;
  });
  if (!order) throw new Error('card is not after the answer');
  await page.screenshot({ path: join(shots, 'result-card.png') });
});

await test('C2', 'the card names the file and its additions', async () => {
  const head = (await page.locator('.turn-result .artifact-title').innerText()).trim();
  if (!head.includes('已编辑 1 个文件')) throw new Error(`head: ${head}`);
  if (!head.includes('+')) throw new Error(`no counts: ${head}`);
  const row = (await page.locator('.turn-result .artifact-file').innerText()).trim();
  if (!row.includes('qa-note.txt')) throw new Error(`row: ${row}`);
  return row.replace(/\s+/g, ' ');
});

await test('C3', 'clicking the file opens its diff in the docs panel', async () => {
  await page.locator('.turn-result .artifact-file').first().click();
  await page.waitForTimeout(900);
  if ((await page.locator('.docs').count()) === 0) throw new Error('docs panel did not open');
  const text = await page.locator('.docs').innerText();
  if (!/qa-note\.txt|hello qa/.test(text)) throw new Error(`docs: ${text.slice(0, 120)}`);
});

await test('C4', 'the copy button sits below the edited-files card', async () => {
  const card = await page.locator('.turn-result').last().boundingBox();
  const copy = await page.locator('.reply-actions .message-copy').last().boundingBox();
  if (!card || !copy) throw new Error('missing card or copy');
  if (copy.y < card.y + card.height - 2) throw new Error(`copy ${copy.y} vs card end ${card.y + card.height}`);
});

if (app) await app.close();
if (server) server.close();
await writeFile(join(shots, 'results-32.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
