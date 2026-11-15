// QA pass 37: "show in explorer" resolves against the session workspace.
// node .qa/run-37.mjs
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

const home = join(homes, 'reveal');
const first = join(home, 'workspace');
const second = join(home, 'second-workspace');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(join(first), { recursive: true });
await mkdir(second, { recursive: true });
await writeFile(join(second, 'guide.md'), '# guide\n\nSecond workspace file.\n');
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    models: [
      {
        id: 'm',
        name: 'Fake',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1/v1',
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
    recentWorkspaces: [second],
  }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: first };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);
await page.locator('.rail-new').click();
await page.waitForTimeout(500);
await page.locator('.workspace-row').click();
await page.waitForTimeout(250);
await page.locator('.workspace-menu [role="menuitem"]', { hasText: 'second-workspace' }).click();
await page.waitForTimeout(1200);

const thread = await page.evaluate(async () => {
  const envelope = await window.xiaohey.request('thread/list', {});
  return (envelope.value ?? []).slice().sort((a, b) => b.updatedAt - a.updatedAt)[0];
});

await test('E1', 'a file path resolves inside the session workspace', async () => {
  const result = await page.evaluate(async (id) => {
    const envelope = await window.xiaohey.request('app/reveal', { path: 'guide.md', threadId: id });
    return { ok: envelope.ok, error: envelope.error ?? null };
  }, thread.id);
  if (!result.ok) throw new Error(result.error ?? 'reveal failed');
  return 'revealed';
});

await test('E2', 'the same relative path outside that workspace is rejected', async () => {
  const result = await page.evaluate(async () => {
    const envelope = await window.xiaohey.request('app/reveal', { path: 'guide.md' });
    return { ok: envelope.ok, error: envelope.error ?? null };
  });
  if (result.ok) throw new Error('default root should not have that file');
  return result.error?.slice(0, 40) ?? 'rejected';
});

await test('E3', 'the docs panel button passes the session id', async () => {
  await page.keyboard.press('Control+Shift+B');
  await page.waitForTimeout(400);
  await page.locator('.docs-tab', { hasText: '文件' }).click();
  await page.waitForTimeout(600);
  await page.waitForTimeout(900);
  const file = page.locator('.file-row', { hasText: 'guide.md' }).first();
  if ((await file.count()) === 0) throw new Error('file row missing');
  await file.click();
  await page.waitForTimeout(700);
  const reveal = page.getByRole('button', { name: '在资源管理器中显示' }).first();
  if ((await reveal.count()) === 0) throw new Error('reveal button missing');
  await reveal.click();
  await page.waitForTimeout(600);
  if ((await page.locator('.banner').count()) > 0) throw new Error('reveal showed an error');
  await page.screenshot({ path: join(shots, 'reveal-docs.png') });
});

if (app) await app.close();
await writeFile(join(shots, 'results-37.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
