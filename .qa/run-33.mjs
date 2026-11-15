// QA pass 33: frameless window with in-app caption buttons.
// node .qa/run-33.mjs
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

const home = join(homes, 'frameless');
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
    recentWorkspaces: [],
  }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'workspace') };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(800);

await test('W1', 'the strip carries three caption buttons', async () => {
  const buttons = page.locator('.window-controls button');
  if ((await buttons.count()) !== 3) throw new Error(`buttons: ${await buttons.count()}`);
  const labels = await buttons.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label')));
  if (labels.join(',') !== '最小化,最大化,关闭') throw new Error(`labels: ${labels.join(',')}`);
});

await test('W2', 'the window is frameless (content fills the bounds)', async () => {
  const sizes = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    return { bounds: win.getBounds(), content: win.getContentBounds() };
  });
  if (sizes.bounds.width !== sizes.content.width || sizes.bounds.height !== sizes.content.height) {
    throw new Error(`frame insets: ${JSON.stringify(sizes)}`);
  }
  return `${sizes.bounds.width}x${sizes.bounds.height}`;
});

await test('W3', 'maximize and restore come from the strip', async () => {
  await page.locator('.window-controls button[aria-label="最大化"]').click();
  await page.waitForTimeout(600);
  const maxed = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized());
  if (!maxed) throw new Error('not maximized');
  if ((await page.locator('.window-controls button[aria-label="还原"]').count()) !== 1) throw new Error('restore icon missing');
  await page.locator('.window-controls button[aria-label="还原"]').click();
  await page.waitForTimeout(500);
  const back = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized());
  if (back) throw new Error('still maximized');
  const bar = await page.locator('.titlebar').boundingBox();
  await page.screenshot({ path: join(shots, 'window-controls.png'), clip: { x: 0, y: 0, width: bar.width, height: bar.height + 4 } });
  return 'toggle ok';
});

if (app) await app.close();
await writeFile(join(shots, 'results-33.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
