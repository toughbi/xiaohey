// QA pass 18: Qoder-style turn process UI (status header, operation rows, thinking rows).
// node .qa/run-18.mjs
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

const PORT = 4796;
let calls = 0;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    calls += 1;
    let afterTool = false;
    try {
      const parsed = JSON.parse(body);
      afterTool = parsed.messages?.[parsed.messages.length - 1]?.role === 'tool';
    } catch {
      afterTool = false;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (afterTool) {
      send({ choices: [{ index: 0, delta: { reasoning_content: '读到了 README，总结成一句话回答。' } }] });
      send({ choices: [{ index: 0, delta: { content: 'README 说明了项目结构和运行方式。' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 30 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    send({ choices: [{ index: 0, delta: { reasoning_content: '先看 README，确认项目怎么跑，再决定要不要改。' } }] });
    // Keep the turn running long enough to observe the live header.
    setTimeout(() => {
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_read_1',
                  type: 'function',
                  function: { name: 'read_file', arguments: JSON.stringify({ path: 'README.md' }) },
                },
              ],
            },
          },
        ],
      });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } });
      res.write('data: [DONE]\n\n');
      res.end();
    }, 1800);
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const home = join(homes, 'process');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const workspace = join(home, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'README.md'), '# Project\n\nnpm start runs the app.\n', 'utf8');
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    models: [
      {
        id: 'fake',
        name: 'Fake',
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        apiKey: 'sk',
        model: 'fake',
        temperature: 0,
        maxOutputTokens: 512,
        contextWindow: 32000,
      },
    ],
    activeModelId: 'fake',
    approval: 'full',
    allowedCommands: [],
  }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE;
delete env.XIAOHEY_DEMO;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(1000);
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
await page.waitForTimeout(600);
await page.locator('.composer textarea').fill('看看 README 怎么运行');
await page.locator('.composer textarea').press('Enter');

await test('R1', 'a running turn is a single status line, not a row list', async () => {
  await page.waitForTimeout(700);
  const head = page.locator('.turn-head');
  if (!(await head.count())) throw new Error('no turn header');
  const text = await head.first().innerText();
  if (!text.includes('正在执行')) throw new Error(`head: ${text}`);
  if (!/\d+\s*秒/.test(text.replace(/\s+/g, ''))) throw new Error(`no seconds: ${text}`);
  if ((await page.locator('.turn-process').count()) !== 0) throw new Error('steps leaked while running');
  if ((await page.locator('.turn-summary').count()) !== 0) throw new Error('summary leaked while running');
  await page.screenshot({ path: join(shots, 'process-running.png') });
});

await test('R8', 'opening the process mid-run folds again when the turn ends', async () => {
  await page.locator('.turn-head').first().click();
  await page.waitForTimeout(300);
  if ((await page.locator('.turn-process').count()) === 0) throw new Error('process did not open');
  await page.waitForFunction(() => document.querySelector('.turn-head')?.innerText.includes('已完成'), null, { timeout: 20000 });
  await page.waitForTimeout(400);
  if ((await page.locator('.turn-process').count()) !== 0) throw new Error('process stayed open after finishing');
  if ((await page.locator('.turn-summary').count()) === 0) throw new Error('no summary after folding');
});

await test('R2', 'operations appear as row-by-row Chinese entries', async () => {
  await page.waitForFunction(() => document.querySelector('.turn-head')?.innerText.includes('已完成'), null, { timeout: 20000 });
  const head = await page.locator('.turn-head').first().innerText();
  if (!head.includes('已完成')) throw new Error(`head: ${head}`);
  if ((await page.locator('.turn-process').count()) !== 0) throw new Error('finished turn should start collapsed');
  await page.locator('.turn-head').first().click();
  await page.waitForTimeout(350);
  const rows = await page.locator('.turn-process .tool-head').allInnerTexts();
  if (!rows.some((row) => row.includes('读取文件'))) throw new Error(`rows: ${rows.join(' | ')}`);
  const label = (await page.locator('.turn-process .tool-name').first().innerText()).trim();
  if (!/[\u4e00-\u9fa5]/.test(label)) throw new Error(`label: ${label}`);
  return rows.map((row) => row.replace(/\s+/g, ' ').trim()).join(' / ');
});

await test('R3', 'thinking rows show 已思考 and expand to the full text', async () => {
  const thoughts = page.locator('.turn-process .thought');
  if ((await thoughts.count()) === 0) throw new Error('no thinking row');
  const head = await page.locator('.turn-process .thought-head').first().innerText();
  if (!head.includes('已思考')) throw new Error(`head: ${head}`);
  await page.locator('.turn-process .thought-head').first().click();
  await page.waitForTimeout(300);
  const text = await page.locator('.thought-text').first().innerText();
  if (!text.includes('README')) throw new Error(`text: ${text}`);
});

await test('R4', 'collapsing the turn hides the operations, expanding brings them back', async () => {
  await page.locator('.turn-head').first().click();
  await page.waitForTimeout(300);
  if ((await page.locator('.turn-process').count()) !== 0) throw new Error('process still visible');
  const head = await page.locator('.turn-head').first().innerText();
  if (!head.includes('已完成')) throw new Error(`head: ${head}`);
  await page.locator('.turn-head').first().click();
  await page.waitForTimeout(300);
  if ((await page.locator('.turn-process').count()) === 0) throw new Error('process did not return');
});

await test('R7', 'a finished turn shows duration + an operation summary and the answer', async () => {
  if ((await page.locator('.turn-process').count()) > 0) {
    await page.locator('.turn-head').first().click();
    await page.waitForTimeout(300);
  }
  const head = await page.locator('.turn-head').first().innerText();
  if (!head.includes('已完成') || !head.includes('用时')) throw new Error(`head: ${head}`);
  const summary = await page.locator('.turn-summary').first().innerText().catch(() => '');
  if (!summary.includes('已')) throw new Error(`summary: ${summary}`);
  if ((await page.locator('.turn-process').count()) !== 0) throw new Error('process leaked into the finished view');
  const answer = await page.locator('.turn-reply .agent-text').innerText();
  if (!answer.trim()) throw new Error('no final answer');
  return `${head.replace(/\s+/g, ' ')} / ${summary.replace(/\s+/g, ' ')}`;
});

await test('R6', 'every finished step carries its own check, not the header', async () => {
  if ((await page.locator('.turn-process').count()) === 0) {
    await page.locator('.turn-head').first().click();
    await page.waitForTimeout(300);
  }
  const checks = await page.locator('.turn-process .step-check').count();
  if (checks < 2) throw new Error(`step checks: ${checks}`);
  if ((await page.locator('.turn-head .turn-check').count()) !== 0) throw new Error('header still has a check');
  return `${checks} checked rows`;
});

await test('R5', 'the answer stays visible while the process is collapsed', async () => {
  await page.locator('.turn-head').first().click();
  await page.waitForTimeout(250);
  const answer = await page.locator('.turn-reply .agent-text').innerText();
  if (!answer.includes('README')) throw new Error(`answer: ${answer}`);
  const answerBottom = await page.locator('.turn-reply').evaluate((node) => node.getBoundingClientRect().height);
  if (answerBottom < 10) throw new Error('answer is not laid out');
  return `${Math.round(answerBottom)}px`;
});

if (app) await app.close();
server.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-18.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
