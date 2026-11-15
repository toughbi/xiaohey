// QA pass 17: the docs panel is closed on a fresh start and remembers the user's choice.
// node .qa/run-17.mjs
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

const home = join(homes, 'docs-default');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const workspace = join(home, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'README.md'), '# demo\n', 'utf8');
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE;
delete env.XIAOHEY_DEMO;

const launch = async () => {
  const instance = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
  const window = await instance.firstWindow();
  await window.waitForSelector('.app');
  await window.waitForTimeout(900);
  return { instance, window };
};

const first = await launch();
app = first.instance;
page = first.window;
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
await page.waitForTimeout(800);

await test('N1', 'a fresh workspace does not open the docs panel', async () => {
  if ((await page.locator('.docs').count()) !== 0) throw new Error('docs panel is visible');
  if ((await page.locator('.panel-splitter').count()) !== 0) throw new Error('splitter is visible');
  const sessionWidth = await page.locator('.session').evaluate((node) => Math.round(node.getBoundingClientRect().width));
  return `session ${sessionWidth}px`;
});

await test('N2', 'the header toggle opens it and shows the splitter', async () => {
  await page.locator('.session-head-right .ghost.icon').click();
  await page.waitForTimeout(500);
  if ((await page.locator('.docs').count()) !== 1) throw new Error('docs did not open');
  if ((await page.locator('.panel-splitter').count()) !== 1) throw new Error('splitter missing');
});

await test('N3', 'the choice survives a restart', async () => {
  await app.close();
  const again = await launch();
  app = again.instance;
  page = again.window;
  if ((await page.locator('.docs').count()) !== 1) throw new Error('docs closed after restart');
  await page.locator('.session-head-right .ghost.icon').click();
  await page.waitForTimeout(400);
  if ((await page.locator('.docs').count()) !== 0) throw new Error('docs did not close');
  await app.close();
  const third = await launch();
  app = third.instance;
  page = third.window;
  if ((await page.locator('.docs').count()) !== 0) throw new Error('closed state not remembered');
});

if (app) await app.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-17.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
