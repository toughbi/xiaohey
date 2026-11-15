// QA pass 6: tool loop, approval card, write + revert through the UI.
// node .qa/run-6.mjs
import { _electron } from 'playwright-core';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';

// The docs panel starts closed now: open it on demand before touching its tabs.
async function ensureDocs() {
  if (await page.locator('.docs').count()) return;
  await page.keyboard.press('Control+Shift+B');
  await page.waitForTimeout(400);
}

// Finished turns fold their process away; open them before inspecting it.
async function expandTurns() {
  let guard = 0;
  while ((await page.locator('.turn-head[aria-expanded="false"]').count()) > 0 && guard < 6) {
    await page.locator('.turn-head[aria-expanded="false"]').first().click();
    await page.waitForTimeout(150);
    guard += 1;
  }
}


const root = 'E:/code/xiaohei';
const shots = join(root, '.qa');
const homes = join(root, '.qa-homes');
const results = [];
let page;
let app;
let mode = 'tool';

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

const PORT = 4791;
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    if (!req.url?.includes('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let afterTool = false;
    try {
      const parsed = JSON.parse(body);
      const messages = parsed.messages ?? [];
      afterTool = messages[messages.length - 1]?.role === 'tool';
    } catch {
      afterTool = false;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    if (afterTool) {
      send({ choices: [{ index: 0, delta: { content: mode === 'write' ? '写好了。' : '命令已执行。' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 90, completion_tokens: 12 } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const call =
      mode === 'write'
        ? {
            index: 0,
            id: 'call_write_1',
            type: 'function',
            function: { name: 'write_file', arguments: JSON.stringify({ path: 'qa-note.txt', content: 'hello qa\n' }) },
          }
        : {
            index: 0,
            id: 'call_shell_1',
            type: 'function',
            function: { name: 'run_shell', arguments: JSON.stringify({ command: 'echo qa-approved', purpose: 'verify approval flow' }) },
          };
    send({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [call] } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 80, completion_tokens: 20 } });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const launchWith = async (dir, approval) => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'settings.json'),
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
      approval,
    }),
  );
  const env = { ...process.env, XIAOHEY_HOME: dir, XIAOHEY_WORKSPACE: join(dir, 'workspace') };
  delete env.ELECTRON_RUN_AS_NODE;
  const instance = await _electron.launch({
    executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
    args: ['.'],
    cwd: root,
    env,
  });
  const window = await instance.firstWindow();
  await window.waitForSelector('.app');
  await window.waitForTimeout(900);
  await window.locator('.rail-new').click();
  {
    // A new session starts without a folder; bind one the way a user would.
    await window.waitForTimeout(400);
    if ((await window.locator('.workspace-menu').count()) === 0) {
      await window.locator('.workspace-row').click();
      await window.waitForTimeout(250);
    }
    const folderItem = window.locator('.workspace-menu .workspace-folder').first();
    if (await folderItem.count()) {
      await folderItem.click();
      await window.waitForTimeout(600);
    }
  }
  await window.waitForTimeout(500);
  return { instance, window };
};

// ---------- approval flow ----------
const askDir = join(homes, 'approval');
const asked = await launchWith(askDir, 'ask');
app = asked.instance;
page = asked.window;

await test('G1', 'a mutating tool call asks for approval before running', async () => {
  await page.locator('.composer textarea').fill('执行一条命令');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(2500);
  const card = await page.locator('.approval-card').count();
  if (!card) {
    const text = await page.locator('.transcript').innerText();
    throw new Error(`no approval card; transcript: ${text.slice(0, 200)}`);
  }
  const command = (await page.locator('.approval-command').innerText()).trim();
  return command.slice(0, 60);
});

await test('G2', 'allowing once runs the tool and continues the turn', async () => {
  await page.locator('.approval-card .primary').click();
  await page.waitForTimeout(3000);
  const text = await page.locator('.transcript').innerText();
  if (!text.includes('命令已执行')) throw new Error(`no follow-up reply: ${text.slice(0, 200)}`);
  if (await page.locator('.approval-card').count()) throw new Error('approval card still visible');
  const tools = await page.locator('.tool-card').count();
  return `${tools} tool cards`;
});

await test('G3', 'tool output can be expanded', async () => {
  await expandTurns();
  const tool = page.locator('.tool-card').last();
  await tool.locator('button').first().click();
  await page.waitForTimeout(400);
  const text = (await tool.innerText()).replace(/\s+/g, ' ');
  if (!/qa-approved/.test(text)) throw new Error(`tool body: ${text.slice(0, 120)}`);
  return text.slice(0, 60);
});

await test('G4', 'denying a call is recorded and the turn still finishes', async () => {
  await page.locator('.composer textarea').fill('再执行一条');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(2500);
  const card = await page.locator('.approval-card').count();
  if (!card) throw new Error('no approval card for the second call');
  await page.locator('.approval-card .mini.danger').click();
  await page.waitForTimeout(2500);
  await expandTurns();
  const text = await page.locator('.transcript').innerText();
  if (!/拒绝|denied/i.test(text)) throw new Error(`no denial record: ${text.slice(-200)}`);
});

await app.close();

// ---------- write + revert ----------
mode = 'write';
const writeDir = join(homes, 'writes');
const writes = await launchWith(writeDir, 'full');
app = writes.instance;
page = writes.window;

await test('G5', 'an auto-approved write produces a change card', async () => {
  await page.locator('.composer textarea').fill('写一个文件');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(3500);
  await expandTurns();
  const artifact = page.locator('.artifact').first();
  if (!(await artifact.count())) {
    const text = await page.locator('.transcript').innerText();
    throw new Error(`no artifact; transcript: ${text.slice(0, 240)}`);
  }
  const info = (await artifact.innerText()).replace(/\s+/g, ' ');
  if (!/已编辑/.test(info)) throw new Error(`artifact: ${info}`);
  const created = await readFile(join(writeDir, 'workspace', 'qa-note.txt'), 'utf8').catch(() => '');
  if (!created.includes('hello qa')) throw new Error('file not written to disk');
  return info.slice(0, 60);
});

await test('G6', 'reverting from the change card restores the file', async () => {
  await expandTurns();
  const artifact = page.locator('.artifact').first();
  await artifact.getByRole('button', { name: /撤销/ }).click();
  await page.waitForTimeout(3000);
  const toast = (await page.locator('.toast').innerText().catch(() => '')).trim();
  const transcript = await page.locator('.transcript').innerText();
  const exists = await readFile(join(writeDir, 'workspace', 'qa-note.txt'), 'utf8').catch(() => null);
  if (exists !== null) throw new Error(`file still present; toast="${toast}"; tail="${transcript.slice(-160)}"`);
  return toast || 'reverted';
});

await test('G7', 'the checkpoints tab lists the snapshot from the write', async () => {
  await ensureDocs();
  await page.locator('.docs-tab').filter({ hasText: '检查点' }).first().click();
  await page.waitForTimeout(600);
  const count = await page.locator('.snapshot-list li').count();
  if (count === 0) throw new Error('no snapshots listed');
  return `${count} snapshots`;
});

if (app) await app.close();
server.close();
await writeFile(join(shots, 'results-6.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
