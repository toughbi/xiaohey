// QA pass 34: live reply sits above the running line; process icons share one column.
// node .qa/run-34.mjs
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

const PORT = 4819;
server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    let lastRole = '';
    let usedTool = false;
    try {
      const parsed = JSON.parse(body);
      const messages = parsed.messages ?? [];
      lastRole = messages[messages.length - 1]?.role ?? '';
      usedTool = messages.some((message) => message.role === 'tool');
    } catch {}
    if (lastRole === 'tool' || usedTool) {
      setTimeout(() => {
        send({ choices: [{ index: 0, delta: { content: '看完了，项目结构是 src 和 test。\n' } }] });
        send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
      }, 1800);
      return;
    }
    send({ choices: [{ index: 0, delta: { role: 'assistant', content: '我会先查看工作区的结构。\n' } }] });
    send({ choices: [{ index: 0, delta: { reasoning_content: '先读 README，再决定下一步。' } }] });
    setTimeout(() => {
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'c1',
                  type: 'function',
                  function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
                },
              ],
            },
          },
        ],
      });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    }, 2200);
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const home = join(homes, 'order-align');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(join(home, 'workspace'), { recursive: true });
await writeFile(join(home, 'workspace', 'README.md'), '# demo\n\nA tiny project.\n');
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
await page.locator('.composer textarea').fill('看看项目结构');
await page.locator('.composer textarea').press('Enter');
await page.waitForTimeout(2600);
await page.locator('.turn-head').click();
await page.waitForTimeout(400);

await test('L1', 'while running, the sentence sits above the running line', async () => {
  const order = await page.evaluate(() => {
    const head = document.querySelector('.turn-head');
    const reply = document.querySelector('.turn-reply');
    if (!head || !reply) return null;
    return Boolean(reply.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  if (!order) throw new Error('reply is not above the running line');
  if (!(await page.locator('.send.stop-mode').count())) throw new Error('turn is not running');
  if ((await page.locator('.reply-actions').count()) !== 0) throw new Error('copy shown before the reply finished');
  const label = await page.locator('.turn-head-label').first().evaluate((node) => ({
    whiteSpace: getComputedStyle(node).whiteSpace,
    height: node.getBoundingClientRect().height,
  }));
  if (label.whiteSpace !== 'nowrap') throw new Error('label can wrap: ' + label.whiteSpace);
  if (label.height > 22) throw new Error('label wrapped: ' + label.height);
});

await test('L2', 'thought and tool rows share one icon column', async () => {
  await page.waitForFunction(() => !document.querySelector('.send.stop-mode'), null, { timeout: 20000 });
  await page.waitForTimeout(600);
  if ((await page.locator('.turn-head[aria-expanded="false"]').count()) > 0) {
    await page.locator('.turn-head').click();
    await page.waitForTimeout(400);
  }
  const glyphs = await page.evaluate(() => {
    const th = document.querySelector('.thought-head');
    const tl = document.querySelector('.turn-process .tool-head');
    const thought = document.querySelector('.thought-glyph')?.getBoundingClientRect().x ?? null;
    const tool = document.querySelector('.tool-glyph')?.getBoundingClientRect().x ?? null;
    return {
      thought,
      tool,
      thoughtPad: th ? getComputedStyle(th).paddingLeft : null,
      toolPad: tl ? getComputedStyle(tl).paddingLeft : null,
      thoughtX: th ? th.getBoundingClientRect().x : null,
      toolX: tl ? tl.getBoundingClientRect().x : null,
      glyphCss: (() => {
        const g = document.querySelector('.thought-glyph');
        if (!g) return null;
        const c = getComputedStyle(g);
        return { marginLeft: c.marginLeft, transform: c.transform, display: c.display, width: c.width };
      })(),
    };
  });
  if (glyphs.thought === null || glyphs.tool === null) throw new Error('missing rows: ' + JSON.stringify(glyphs));
  if (Math.abs(glyphs.thought - glyphs.tool) > 1) throw new Error(JSON.stringify(glyphs));
  return `icons at ${Math.round(glyphs.thought)}`;
});

await test('L3', 'after finishing, the header comes first and the answer below', async () => {
  await page.waitForFunction(() => !document.querySelector('.send.stop-mode'), null, { timeout: 20000 });
  await page.waitForTimeout(800);
  const order = await page.evaluate(() => {
    const head = document.querySelector('.turn-head');
    const reply = document.querySelector('.turn-reply');
    if (!head || !reply) return null;
    return Boolean(head.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  if (!order) throw new Error('header is not above the answer when finished');
  const shot = await page.locator('.turn-block').first().boundingBox();
  await page.screenshot({ path: join(shots, 'live-order.png'), clip: { x: shot.x, y: shot.y, width: Math.min(shot.width, 900), height: Math.min(shot.height, 420) } });
});

if (app) await app.close();
if (server) server.close();
await writeFile(join(shots, 'results-34.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
