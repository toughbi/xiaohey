// QA pass 7: first-launch composer usability (regression for the disabled input).
// node .qa/run-7.mjs
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

const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '第一句话收到。' } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6 } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
});
await new Promise((resolve) => server.listen(4795, '127.0.0.1', resolve));

const launch = async (dir, extraEnv = {}) => {
  await mkdir(dir, { recursive: true });
  const env = { ...process.env, XIAOHEY_HOME: dir, XIAOHEY_WORKSPACE: join(dir, 'workspace'), ...extraEnv };
  delete env.ELECTRON_RUN_AS_NODE;
  const instance = await _electron.launch({
    executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
    args: ['.'],
    cwd: root,
    env,
  });
  const window = await instance.firstWindow();
  await window.waitForSelector('.app');
  await window.waitForTimeout(1000);
  return { instance, window };
};

// ---------- fresh install, model already configured ----------
const fresh = join(homes, 'first-send');
await rm(fresh, { recursive: true, force: true }).catch(() => undefined);
await mkdir(fresh, { recursive: true });
await writeFile(
  join(fresh, 'settings.json'),
  JSON.stringify({
    models: [
      {
        id: 'fake',
        name: 'Fake',
        baseUrl: 'http://127.0.0.1:4795/v1',
        apiKey: 'sk',
        model: 'fake',
        temperature: 0,
        maxOutputTokens: 256,
        contextWindow: 32000,
      },
    ],
    activeModelId: 'fake',
    approval: 'auto',
  }),
);

await test('X1', 'first launch with no session still accepts typing', async () => {
  const launched = await launch(fresh);
  app = launched.instance;
  page = launched.window;
  const disabled = await page.locator('.composer textarea').isDisabled();
  if (disabled) throw new Error('textarea is disabled on the first screen');
  await page.locator('.composer textarea').click();
  await page.locator('.composer textarea').fill('你好');
  const value = await page.locator('.composer textarea').inputValue();
  if (value !== '你好') throw new Error(`value: ${value}`);
});

await test('X2', 'the first message creates the session and runs it', async () => {
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(3000);
  const threads = await page.locator('.thread-item').count();
  if (threads !== 1) throw new Error(`threads: ${threads}`);
  const title = (await page.locator('.session-head h1').innerText()).trim();
  if (title !== '你好') throw new Error(`title: ${title}`);
  const text = await page.locator('.transcript').innerText();
  if (!text.includes('第一句话收到')) throw new Error(`transcript: ${text.slice(0, 120)}`);
  return title;
});

await test('X3', 'empty send is still blocked before typing', async () => {
  const disabled = await page.locator('.send').isDisabled();
  if (!disabled) throw new Error('send enabled with an empty composer');
});

if (app) await app.close();

// ---------- no model configured ----------
const noModel = join(homes, 'no-model');
await rm(noModel, { recursive: true, force: true }).catch(() => undefined);
await mkdir(noModel, { recursive: true });
await writeFile(join(noModel, 'settings.json'), JSON.stringify({ models: [], activeModelId: '', approval: 'ask' }));

await test('X4', 'without a model typing works, sending is blocked with a hint', async () => {
  const launched = await launch(noModel);
  app = launched.instance;
  page = launched.window;
  const placeholder = await page.locator('.composer textarea').getAttribute('placeholder');
  if (!placeholder.includes('设置')) throw new Error(`placeholder: ${placeholder}`);
  await page.locator('.composer textarea').fill('没有模型');
  const sendDisabled = await page.locator('.send').isDisabled();
  if (!sendDisabled) throw new Error('send enabled without a model');
  const clickable = await page.locator('.composer textarea').isEditable();
  if (!clickable) throw new Error('textarea not editable');
  return placeholder;
});

if (app) await app.close();
server.close();
await writeFile(join(shots, 'results-7.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
