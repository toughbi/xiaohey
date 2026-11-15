// QA pass 9: the docs panel splitter (drag, keyboard, persistence, clamps).
// node .qa/run-9.mjs
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

const home = join(homes, 'splitter');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    models: [
      {
        id: 'fake',
        name: 'Fake',
        baseUrl: 'http://127.0.0.1:4794/v1',
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
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'workspace') };
delete env.ELECTRON_RUN_AS_NODE;

const launch = async () => {
  const instance = await _electron.launch({
    executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
    args: ['.'],
    cwd: root,
    env,
  });
  const window = await instance.firstWindow();
  await window.waitForSelector('.app');
  await window.waitForTimeout(900);
  return { instance, window };
};

const docsWidth = () => page.locator('.docs').evaluate((node) => Math.round(node.getBoundingClientRect().width));
const dragSplitter = async (dx) => {
  const box = await page.locator('.panel-splitter').boundingBox();
  if (!box) throw new Error('no splitter box');
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(startX + dx, y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(250);
};

const first = await launch();
app = first.instance;
page = first.window;
// The docs panel starts closed; open it so the splitter exists.
await page.keyboard.press('Control+Shift+B');
await page.waitForTimeout(500);

await test('Z1', 'the workspace exposes a draggable separator', async () => {
  const separator = page.locator('.panel-splitter');
  if (!(await separator.count())) throw new Error('no separator');
  const role = await separator.getAttribute('role');
  if (role !== 'separator') throw new Error(`role: ${role}`);
  const before = await docsWidth();
  return `docs ${before}px`;
});

await test('Z2', 'dragging left widens the docs panel and narrows the conversation', async () => {
  const sessionBefore = await page.locator('.session').evaluate((node) => Math.round(node.getBoundingClientRect().width));
  const before = await docsWidth();
  await dragSplitter(-140);
  const after = await docsWidth();
  const sessionAfter = await page.locator('.session').evaluate((node) => Math.round(node.getBoundingClientRect().width));
  if (after < before + 80) throw new Error(`docs ${before} -> ${after}`);
  if (sessionAfter >= sessionBefore) throw new Error(`session ${sessionBefore} -> ${sessionAfter}`);
  return `docs ${before}→${after}, session ${sessionBefore}→${sessionAfter}`;
});

await test('Z3', 'dragging right narrows it again and respects the minimum', async () => {
  const before = await docsWidth();
  await dragSplitter(600);
  const after = await docsWidth();
  if (after > 300) throw new Error(`docs still ${after}`);
  if (after < 279) throw new Error(`below minimum: ${after}`);
  return `${before}→${after} (min 280)`;
});

await test('Z4', 'double click restores the default width', async () => {
  const box = await page.locator('.panel-splitter').boundingBox();
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  const width = await docsWidth();
  if (Math.abs(width - 372) > 4) throw new Error(`width ${width}`);
});

await test('Z5', 'the keyboard arrows move the separator', async () => {
  await page.locator('.panel-splitter').focus();
  const before = await docsWidth();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(250);
  const after = await docsWidth();
  if (after <= before) throw new Error(`${before} -> ${after}`);
  return `${before}→${after}`;
});

await test('Z6', 'the width survives a restart', async () => {
  const width = await docsWidth();
  await app.close();
  const again = await launch();
  app = again.instance;
  page = again.window;
  const restored = await docsWidth();
  if (Math.abs(restored - width) > 4) throw new Error(`${width} -> ${restored}`);
  return `${restored}px`;
});

await test('Z7', 'closing the docs panel keeps the separator out of the way', async () => {
  await page.locator('.session-head-right .ghost.icon').click();
  await page.waitForTimeout(300);
  if ((await page.locator('.panel-splitter').count()) !== 0) throw new Error('separator visible while docs closed');
  await page.locator('.session-head-right .ghost.icon').click();
  await page.waitForTimeout(300);
  if ((await page.locator('.panel-splitter').count()) !== 1) throw new Error('separator missing after reopen');
});

if (app) await app.close();
await writeFile(join(shots, 'results-9.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
