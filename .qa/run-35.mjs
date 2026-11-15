// QA pass 35: copy affordance sits below the message and only shows on hover.
// node .qa/run-35.mjs
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

const PORT = 4820;
server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '这是回复，用来测试复制按钮的位置。\n' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const home = join(homes, 'copy');
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
await page.locator('.composer textarea').fill('你好，测试复制按钮');
await page.locator('.composer textarea').press('Enter');
await page.waitForFunction(() => !document.querySelector('.send.stop-mode'), null, { timeout: 20000 });
await page.waitForTimeout(700);

await test('C1', 'the copy button sits under the user message', async () => {
  const text = await page.locator('.turn-user .user-text').last().boundingBox();
  const copy = await page.locator('.turn-user .message-copy').last().boundingBox();
  if (!text || !copy) throw new Error('missing user copy');
  if (copy.y < text.y + text.height - 2) throw new Error(`copy at ${copy.y}, text ends ${text.y + text.height}`);
});

await test('C2', 'the copy button sits under the reply', async () => {
  const text = await page.locator('.turn-reply .agent-text').last().boundingBox();
  const copy = await page.locator('.reply-actions .message-copy').last().boundingBox();
  if (!text || !copy) throw new Error('missing reply copy');
  if (copy.y < text.y + text.height - 2) throw new Error(`copy at ${copy.y}, text ends ${text.y + text.height}`);
});

await test('C3', 'it stays hidden until the message is hovered', async () => {
  const user = page.locator('.turn-user').last();
  const reply = page.locator('.reply-block').last();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(300);
  const beforeUser = await page.locator('.turn-user .message-actions').last().evaluate((node) => getComputedStyle(node).opacity);
  await user.hover();
  await page.waitForTimeout(350);
  const afterUser = await page.locator('.turn-user .message-actions').last().evaluate((node) => getComputedStyle(node).opacity);
  if (beforeUser !== '0') throw new Error(`user actions visible: ${beforeUser}`);
  if (afterUser !== '1') throw new Error(`user actions not visible on hover: ${afterUser}`);
  await reply.hover();
  await page.waitForTimeout(350);
  const afterReply = await page.locator('.reply-actions').last().evaluate((node) => getComputedStyle(node).opacity);
  if (afterReply !== '1') throw new Error(`reply actions not visible on hover: ${afterReply}`);
  await page.screenshot({ path: join(shots, 'copy-hover.png') });
});

await test('C4', 'clicking it confirms the copy', async () => {
  await page.locator('.reply-block').last().hover();
  const copy = page.locator('.reply-actions .message-copy').last();
  await copy.click();
  await page.waitForTimeout(250);
  if (!(await copy.evaluate((node) => node.classList.contains('done')))) throw new Error('no confirmation');
});

if (app) await app.close();
if (server) server.close();
await writeFile(join(shots, 'results-35.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
