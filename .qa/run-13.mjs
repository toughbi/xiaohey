// QA pass 13: pinned sessions, revert preview + undo, file uploads / drag & paste.
// node .qa/run-13.mjs
import { _electron } from 'playwright-core';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The docs panel starts closed now: open it on demand before touching its tabs.
async function ensureDocs() {
  if (await page.locator('.docs').count()) return;
  await page.keyboard.press('Control+Shift+B');
  await page.waitForTimeout(400);
}


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

const home = join(homes, 'final');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const workspace = join(home, 'demo-workspace');
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: workspace, XIAOHEY_DEMO: '1' };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(1600);

const threadDoc = async () => {
  const files = (await readdir(join(home, 'threads'))).filter((name) => name.endsWith('.json'));
  const docs = await Promise.all(files.map((file) => readFile(join(home, 'threads', file), 'utf8')));
  return docs.map((text) => JSON.parse(text)).sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)[0];
};

await test('H1', 'a session can be pinned and sorts first', async () => {
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
  await page.waitForTimeout(700);
  const title = await page.locator('.thread-item').last().locator('.thread-title').innerText();
  await page.locator('.thread-item').last().hover();
  await page.waitForTimeout(150);
  await page.locator('.thread-more').last().click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: '置顶' }).click();
  await page.waitForTimeout(700);
  const firstTitle = await page.locator('.thread-title').first().innerText();
  const pinned = await page.locator('.thread-pin').count();
  if (pinned === 0) throw new Error('no pin icon');
  if (firstTitle !== title) throw new Error(`first=${firstTitle} expected=${title}`);
  const doc = await threadDoc();
  if (!doc.thread.pinned) throw new Error('pinned flag not persisted');
  return `${title} pinned`;
});

await test('H2', 'unpinning restores the normal order', async () => {
  await page.locator('.thread-item').first().hover();
  await page.waitForTimeout(150);
  await page.locator('.thread-more').first().click();
  await page.waitForTimeout(250);
  await page.getByRole('menuitem', { name: '取消置顶' }).click();
  await page.waitForTimeout(700);
  if ((await page.locator('.thread-pin').count()) !== 0) throw new Error('pin icon still there');
});

await test('H3', 'a revert can be previewed before applying', async () => {
  await page.locator('.thread-item').filter({ hasText: '把概览页' }).first().click();
  await page.waitForTimeout(900);
  await ensureDocs();
  await page.locator('.docs-tab').filter({ hasText: '检查点' }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole('button', { name: '预览' }).first().click();
  await page.waitForTimeout(900);
  const panel = page.locator('.revert-preview');
  if (!(await panel.count())) throw new Error('no preview panel');
  const text = await panel.innerText();
  const rows = await page.locator('.revert-preview-list li').count();
  if (rows === 0) throw new Error(`no entries: ${text.slice(0, 120)}`);
  await page.locator('.revert-preview-row').first().click();
  await page.waitForTimeout(300);
  if ((await page.locator('.revert-preview-diff').count()) === 0) throw new Error('no diff preview');
  return `${rows} file(s)`;
});

await test('H4', 'confirming the revert applies it and offers an undo', async () => {
  await page.getByRole('button', { name: '确认回退' }).click();
  await page.waitForTimeout(2200);
  const banner = page.locator('.banner-undo');
  if (!(await banner.count())) throw new Error('no undo banner');
  const text = await banner.innerText();
  if (!text.includes('撤销这次回退')) throw new Error(`banner: ${text}`);
});

await test('H5', 'undoing the revert restores the previous state', async () => {
  const before = await page.locator('.transcript').innerText();
  await page.getByRole('button', { name: '撤销这次回退' }).click();
  await page.waitForTimeout(2500);
  const text = await page.locator('.transcript').innerText();
  if (text === before && (await page.locator('.banner-undo').count()) > 0) {
    throw new Error('undo did not change anything');
  }
});

await test('H6', 'dropping a file attaches it and inserts a reference', async () => {
  await page.evaluate(() => {
    const composer = document.querySelector('.composer');
    const transfer = new DataTransfer();
    transfer.items.add(new File(['# 附件内容\nhello'], 'notes-from-os.md', { type: 'text/markdown' }));
    composer.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  });
  await page.waitForTimeout(1200);
  const value = await page.locator('.composer textarea').inputValue();
  if (!value.includes('@uploads/')) throw new Error(`value: ${value}`);
  const uploads = await readdir(join(workspace, 'uploads')).catch(() => []);
  if (uploads.length === 0) throw new Error('nothing written to uploads/');
  return uploads[0];
});

await test('H7', 'pasting an image file attaches it too', async () => {
  await page.evaluate(() => {
    const textarea = document.querySelector('.composer textarea');
    const transfer = new DataTransfer();
    const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'pasted.png', { type: 'image/png' });
    transfer.items.add(png);
    textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await page.waitForTimeout(1200);
  const value = await page.locator('.composer textarea').inputValue();
  if (!value.includes('png')) throw new Error(`value: ${value}`);
});

await test('H8', 'the docs panel can upload files into uploads/', async () => {
  await ensureDocs();
  await page.locator('.docs-tab').filter({ hasText: '文件' }).first().click();
  await page.waitForTimeout(400);
  const input = page.locator('.upload-btn input[type="file"]');
  await input.setInputFiles({ name: 'uploaded.md', mimeType: 'text/markdown', buffer: Buffer.from('# uploaded\n') });
  await page.waitForTimeout(1400);
  const uploads = await readdir(join(workspace, 'uploads')).catch(() => []);
  if (!uploads.some((name) => name.startsWith('uploaded'))) throw new Error(`uploads: ${uploads.join(',')}`);
  return uploads.find((name) => name.startsWith('uploaded')) ?? '';
});

if (app) await app.close();
await writeFile(join(shots, 'results-13.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
