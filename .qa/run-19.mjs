// QA pass 19: the conversation column keeps side margins and the user bubble sits right.
// node .qa/run-19.mjs
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

const home = join(homes, 'column');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(home, { recursive: true });
const workspace = join(home, 'workspace');
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'README.md'), '# demo\n', 'utf8');
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: workspace };
delete env.ELECTRON_RUN_AS_NODE;
delete env.XIAOHEY_DEMO;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);
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
await page.locator('.composer textarea').fill('看一下 README 的结构');
await page.locator('.composer textarea').press('Enter');
await page.waitForTimeout(1800);

await test('L1', 'the reply column fills the panel and the text is not capped', async () => {
  const timeline = await page.locator('.timeline').boundingBox();
  const transcript = await page.locator('.transcript').boundingBox();
  if (!timeline || !transcript) throw new Error('missing boxes');
  const share = timeline.width / transcript.width;
  if (share < 0.94) throw new Error(`timeline only fills ${Math.round(share * 100)}%`);
  const reply = page.locator('.turn-reply .agent-text').first();
  if (await reply.count()) {
    const cap = await reply.evaluate((node) => getComputedStyle(node).maxWidth);
    if (cap !== 'none') throw new Error(`agent-text max-width: ${cap}`);
  }
  return `${Math.round(timeline.width)}px in ${Math.round(transcript.width)}px`;
});

await test('L2', 'the composer sits in the same column as the transcript', async () => {
  const transcript = await page.locator('.transcript').boundingBox();
  const wrap = await page.locator('.composer-wrap').boundingBox();
  if (!transcript || !wrap) throw new Error('missing boxes');
  if (Math.abs(wrap.width - transcript.width) > 60) throw new Error(`wrap ${wrap.width} vs ${transcript.width}`);
  const leftGap = Math.abs(wrap.x - transcript.x);
  if (leftGap > 24) throw new Error(`left offsets differ by ${leftGap}`);
  return `${Math.round(wrap.width)}px aligned`;
});

await test('L3', 'my message is a right-aligned bubble, not a full-width bar', async () => {
  const bubble = await page.locator('.turn-user .user-text').first().boundingBox();
  const timeline = await page.locator('.timeline').boundingBox();
  if (!bubble || !timeline) throw new Error('no bubble');
  const share = bubble.width / timeline.width;
  if (share > 0.85) throw new Error(`bubble is ${Math.round(share * 100)}% wide`);
  const rightGap = Math.abs(timeline.x + timeline.width - (bubble.x + bubble.width));
  if (rightGap > 16) throw new Error(`right gap ${Math.round(rightGap)}px`);
  return `${Math.round(share * 100)}% wide, ${Math.round(rightGap)}px from the right`;
});

await test('L4', 'a narrow window still keeps margins and no horizontal overflow', async () => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(900, 800);
  });
  await page.waitForTimeout(900);
  const timeline = await page.locator('.timeline').boundingBox();
  if (!timeline) throw new Error('no timeline');
  const overflow = await page.locator('.transcript').evaluate((node) => node.scrollWidth - node.clientWidth);
  if (overflow > 2) throw new Error(`horizontal overflow ${overflow}px`);
  if (timeline.width < 500) throw new Error(`timeline shrank to ${timeline.width}`);
  await page.screenshot({ path: join(shots, 'column-narrow.png') });
  return `${Math.round(timeline.width)}px at 900px window`;
});

if (app) await app.close();
const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shots, 'results-19.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
