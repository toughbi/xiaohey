// QA pass 23: assistant replies render Markdown, user messages stay plain.
// node .qa/run-23.mjs
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

const PORT = 4799;
server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send({
      choices: [
        {
          index: 0,
          delta: {
            content:
              '你好，我是 **xiaohey**。当前工作区是 `C:\\Users\\xiaoli\\Documents\\xiaohey`。\n\n- 第一项\n- 第二项\n\n```js\nconsole.log("hi");\n```\n',
          },
        },
      ],
    });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 30 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const home = join(homes, 'markdown');
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
        maxOutputTokens: 256,
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
await page.locator('.composer textarea').fill('你好，给我一段 `code` 和 **加粗**');
await page.locator('.composer textarea').press('Enter');
await page.waitForTimeout(2500);

await test('R1', 'inline code in the reply is rendered, not shown as backticks', async () => {
  const codes = (await page.locator('.agent-text code').allInnerTexts()).map((text) => text.trim());
  if (!codes.includes('C:\\Users\\xiaoli\\Documents\\xiaohey')) throw new Error(`codes: ${codes.join(' | ')}`);
  const text = await page.locator('.agent-text').innerText();
  if (text.includes('`C:\\Users')) throw new Error('raw backticks leaked into the reply');
  return codes[0];
});

await test('R2', 'bold, lists and fenced blocks render as elements', async () => {
  if ((await page.locator('.agent-text strong').count()) === 0) throw new Error('no bold');
  if ((await page.locator('.agent-text li').count()) !== 2) throw new Error('list items missing');
  if ((await page.locator('.agent-text .code-panel').count()) !== 1) throw new Error('no code block');
  const code = (await page.locator('.agent-text .code-text').first().innerText()).trim();
  if (!code.includes('console.log')) throw new Error(`block: ${code}`);
  return 'strong + 2 li + pre';
});

await test('R3', 'my own message keeps the backticks as typed', async () => {
  const text = await page.locator('.turn-user .user-text').innerText();
  if (!text.includes('`code`')) throw new Error(`user text: ${text}`);
  if ((await page.locator('.turn-user .user-text code').count()) !== 0) throw new Error('user text was formatted');
});

if (app) await app.close();
if (server) server.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-23.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
