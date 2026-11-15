// QA pass 36: a turn left running by a quit is recovered on the next launch.
// node .qa/run-36.mjs
import { _electron } from 'playwright-core';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';

const root = 'E:/code/xiaohei';
const shots = join(root, '.qa');
const homes = join(root, '.qa-homes');
const results = [];
let app;
let page;
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

const PORT = 4821;
server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '开始处理…\n' } }] })}\n\n`);
    // never finish: the app will be quit mid-turn
    setTimeout(() => res.end(), 60_000);
  });
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const home = join(homes, 'recover');
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

const launch = async () => {
  app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
  page = await app.firstWindow();
  await page.waitForSelector('.app');
  await page.waitForTimeout(800);
};

await launch();
await page.locator('.rail-new').click();
await page.waitForTimeout(500);
await page.locator('.workspace-row').click();
await page.waitForTimeout(250);
await page.locator('.workspace-menu .workspace-folder').first().click();
await page.waitForTimeout(600);
await page.locator('.composer textarea').fill('跑一个很久的任务');
await page.locator('.composer textarea').press('Enter');
await page.waitForSelector('.send.stop-mode', { timeout: 8000 });
await page.waitForTimeout(800);
const running = await page.evaluate(async () => {
  const envelope = await window.xiaohey.request('thread/list', {});
  return (envelope.value ?? [])[0]?.status;
});
console.log('status before quit:', running);

// hard close while the turn is still open
await app.close();

// simulate a crash that left the running state on disk
const { readdir, readFile: rf, writeFile: wf } = await import('node:fs/promises');
const dir = join(home, 'threads');
const files = await readdir(dir);
const target = join(dir, files.find((name) => name.endsWith('.json')));
const doc = JSON.parse(await rf(target, 'utf8'));
doc.thread.status = 'running';
if (doc.turn) doc.turn.status = 'running';
await wf(target, JSON.stringify(doc), 'utf8');

await launch();
await page.waitForTimeout(500);
const state = await page.evaluate(async () => {
  const envelope = await window.xiaohey.request('thread/list', {});
  const threads = envelope.value ?? [];
  const thread = threads.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const doc = await window.xiaohey.request('thread/open', { threadId: thread.id });
  return {
    status: thread.status,
    turn: doc.value?.turn?.status,
    notices: (doc.value?.items ?? []).filter((item) => item.kind === 'notice').map((item) => item.title),
  };
});
console.log('after relaunch:', JSON.stringify(state));

await test('R1', 'the thread is no longer running after a restart', async () => {
  if (state.status !== 'idle') throw new Error(`status: ${state.status}`);
  if ((await page.locator('.send.stop-mode').count()) !== 0) throw new Error('stop button still visible');
});

await test('R2', 'the interrupted turn is closed, not left live', async () => {
  if (state.turn !== 'cancelled') throw new Error(`turn: ${state.turn}`);
  await page.locator('.thread-item').first().click();
  await page.waitForTimeout(700);
  const head = await page.locator('.turn-head-label').first().innerText();
  if (head.includes('正在执行')) throw new Error(`header: ${head}`);
  if (!head.includes('已中断')) throw new Error(`header should say 已中断: ${head}`);
});

await test('R3', 'a warning notice explains the interruption', async () => {
  const notice = state.notices.find((title) => /中断|退出/.test(title));
  if (!notice) throw new Error(`notices: ${state.notices.join(',')}`);
  const text = await page.locator('.transcript').innerText();
  if (!text.includes(notice)) throw new Error('notice not rendered');
  const box = await page.locator('.transcript').boundingBox();
  await page.screenshot({ path: join(shots, 'recover-turn.png'), clip: { x: box.x, y: box.y, width: Math.min(box.width, 900), height: 360 } });
});

await test('R4', 'a thread marked running without a turn record is recovered too', async () => {
  await app.close();
  const { readdir, readFile: rf, writeFile: wf } = await import('node:fs/promises');
  const dir = join(home, 'threads');
  const file = join(dir, (await readdir(dir)).find((name) => name.endsWith('.json')));
  const doc = JSON.parse(await rf(file, 'utf8'));
  delete doc.turn;
  doc.thread.status = 'running';
  await wf(file, JSON.stringify(doc), 'utf8');
  await launch();
  await page.waitForTimeout(600);
  const after = await page.evaluate(async () => {
    const envelope = await window.xiaohey.request('thread/list', {});
    return (envelope.value ?? [])[0]?.status;
  });
  if (after !== 'idle') throw new Error(`status: ${after}`);
  const transcript = await page.locator('.transcript').innerText().catch(() => '');
  if ((await page.locator('.send.stop-mode').count()) !== 0) throw new Error('still running');
});

if (app) await app.close();
if (server) server.close();
await writeFile(join(shots, 'results-36.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
