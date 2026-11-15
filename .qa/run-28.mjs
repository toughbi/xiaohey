// QA pass 28: new sessions start without a workspace and ask for one before sending.
// node .qa/run-28.mjs
import { _electron } from 'playwright-core';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

const home = join(homes, 'no-workspace');
const first = join(home, 'workspace');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(first, { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({ models: [{ id: 'm', name: 'Fake', provider: 'custom', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', model: 'fake', temperature: 0, maxOutputTokens: 128, contextWindow: 32000 }], activeModelId: 'm', approval: 'ask', allowedCommands: [], recentWorkspaces: [] }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: first };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);

const newest = async () =>
  page.evaluate(async () => {
    const envelope = await window.xiaohey.request('thread/list', {});
    const threads = envelope.value ?? [];
    return threads.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
  });

await test('N1', 'the workspace header add button adds a workspace', async () => {
  const add = page.locator('.rail-add');
  if ((await add.getAttribute('aria-label')) !== '新建工作区') throw new Error('wrong label');
  const icon = await add.locator('svg').getAttribute('data-icon');
  if (icon !== 'folder-plus') throw new Error(`icon: ${icon}`);
});

await test('N2', '新会话 creates a session without a workspace', async () => {
  await page.locator('.rail-new').click();
  await page.waitForTimeout(800);
  const thread = await newest();
  if (thread?.cwd !== '') throw new Error(`cwd: ${JSON.stringify(thread?.cwd)}`);
  const row = (await page.locator('.workspace-row').innerText()).trim();
  if (!row.includes('不指定工作区')) throw new Error(`row: ${row}`);
  return 'cwd empty';
});

await test('N3', 'the composer asks for a workspace', async () => {
  const placeholder = await page.locator('.composer textarea').getAttribute('placeholder');
  if (placeholder !== '请选择工作区…') throw new Error(`placeholder: ${placeholder}`);
  const label = (await page.locator('.cm-workspace').innerText()).trim();
  if (!label.includes('未指定工作区')) throw new Error(`label: ${label}`);
});

await test('N4', 'sending without a workspace shows the prompt and starts no turn', async () => {
  await page.locator('.composer textarea').fill('你好');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(600);
  const prompt = await page.locator('.workspace-prompt').innerText().catch(() => '');
  if (!prompt.includes('请选择工作区')) throw new Error(`prompt: ${prompt}`);
  if ((await page.locator('.send.stop-mode').count()) !== 0) throw new Error('a turn started');
  const thread = await newest();
  if (thread.items !== undefined && thread.items > 0) throw new Error('items leaked');
  const transcript = await page.locator('.transcript').innerText();
  if (transcript.includes('你好')) throw new Error('user message rendered');
  await page.screenshot({ path: join(shots, 'workspace-prompt.png') });
  return 'prompt shown';
});

await test('N5', 'picking a folder can be bound to the waiting session', async () => {
  const thread = await newest();
  const bound = await page.evaluate(async ({ id, path }) => {
    const envelope = await window.xiaohey.request('thread/set-workspace', { threadId: id, workspace: path });
    return { ok: envelope.ok, cwd: envelope.value?.cwd, error: envelope.error };
  }, { id: thread.id, path: first });
  if (!bound.ok) throw new Error(bound.error);
  if (bound.cwd !== first) throw new Error(`cwd: ${bound.cwd}`);
  return 'bound';
});

await test('N6', 'the blocked send keeps the draft and labels the folder', async () => {
  const draft = await page.locator('.composer textarea').inputValue();
  if (draft !== '你好') throw new Error(`draft: ${draft}`);
  return 'draft kept';
});

if (app) await app.close();
await writeFile(join(shots, 'results-28.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
