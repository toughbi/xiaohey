// Real-model QA: DeepSeek flash, rendering + interaction scenarios, repeated runs.
// node .qa/live2.mjs            (iterations default 3)
import { _electron } from 'playwright-core';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = 'E:/code/xiaohei';
const base = join(root, '.qa-live2');
const home = join(base, 'home');
const workspace = join(base, 'workspace');
const shotDir = join(root, '.qa');
const ITERATIONS = Number(process.env.ITERATIONS ?? 3);
const FILTER = (process.env.ONLY ?? '').split(',').filter(Boolean);

const KEY = process.env.DEEPSEEK_KEY;
if (!KEY) {
  console.error('DEEPSEEK_KEY is required');
  process.exit(2);
}

const results = [];
let app;
let page;
const record = (run, id, name, status, detail = '') => {
  results.push({ run, id, name, status, detail });
  console.log(`${status === 'pass' ? 'PASS' : 'FAIL'}  run${run} ${id}  ${name}${detail ? ' — ' + detail : ''}`);
};

const seedWorkspace = async () => {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(join(workspace, 'lib'), { recursive: true });
  await mkdir(join(workspace, 'test'), { recursive: true });
  await writeFile(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'live-shop', version: '1.0.0', type: 'module', scripts: { test: 'node --test' } }, null, 2),
  );
  await writeFile(
    join(workspace, 'lib', 'stats.mjs'),
    `export function mean(values) {\n  const total = values.reduce((sum, value) => sum + value, 0);\n  return total / (values.length + 1);\n}\n`,
  );
  await writeFile(
    join(workspace, 'test', 'stats.test.mjs'),
    `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mean } from '../lib/stats.mjs';\n\ntest('mean of three values', () => {\n  assert.equal(mean([1, 2, 3]), 2);\n});\n`,
  );
  await writeFile(join(workspace, 'README.md'), '# live-shop\n\nA tiny stats helper used by the checkout page.\n', 'utf8');
};

const writeSettings = async (approval = 'full') => {
  await mkdir(home, { recursive: true });
  await writeFile(
    join(home, 'settings.json'),
    JSON.stringify({
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek',
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: KEY,
          model: 'deepseek-flash',
          temperature: 0.2,
          maxOutputTokens: 4096,
          contextWindow: 131072,
          billing: 'payg',
          enabled: true,
        },
      ],
      activeModelId: 'deepseek-flash',
      approval,
      allowedCommands: [],
      recentWorkspaces: [],
    }),
  );
};

const launch = async () => {
  if (app) await app.close().catch(() => undefined);
  const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: workspace };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await _electron.launch({
    executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
    args: ['.'],
    cwd: root,
    env,
  });
  page = await app.firstWindow();
  await page.waitForSelector('.app');
  await page.waitForTimeout(700);
  await page.locator('.rail-new').click();
  await page.waitForTimeout(500);
};

const waitTurn = async (timeout = 180_000) => {
  const started = Date.now();
  let seen = false;
  while (Date.now() - started < timeout) {
    const stop = await page.locator('.send.stop-mode').count();
    if (stop) seen = true;
    else if (seen) {
      await page.waitForTimeout(600);
      return Date.now() - started;
    }
    await page.waitForTimeout(300);
  }
  throw new Error('turn did not finish');
};

const send = async (text) => {
  await page.locator('.composer textarea').fill(text);
  await page.locator('.composer textarea').press('Enter');
};

const overflow = async (selector) =>
  page.locator(selector).evaluate((node) => Math.max(0, node.scrollWidth - node.clientWidth));

const answerText = async () => page.locator('.agent-text').last().innerText();

const scenario = async (run, id, name, fn) => {
  if (FILTER.length && !FILTER.includes(id)) return;
  try {
    const started = Date.now();
    const detail = await fn();
    record(run, id, name, 'pass', `${detail ?? ''} · ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (error) {
    record(run, id, name, 'fail', (error?.message ?? String(error)).slice(0, 200));
    try {
      await page.screenshot({ path: join(shotDir, `live-fail-${run}-${id}.png`) });
    } catch {}
  }
};

for (let run = 1; run <= ITERATIONS; run += 1) {
  await seedWorkspace();
  await writeSettings('full');
  await launch();

  await scenario(run, 'R1', '行内代码与列表渲染', async () => {
    await send('你好。用两句话介绍你自己，并在句子里给一个行内代码 `npm test`，再列两个无序列表项。');
    await waitTurn();
    const text = await answerText();
    if (text.trim().length < 10) throw new Error('empty answer');
    if ((await page.locator('.agent-text code').count()) === 0) throw new Error('inline code missing');
    if ((await page.locator('.agent-text li').count()) < 2) throw new Error('list missing');
    const over = await overflow('.transcript');
    if (over > 2) throw new Error(`transcript overflow ${over}px`);
    if ((await page.locator('.turn-process').count()) !== 0) throw new Error('process not folded');
    await page.screenshot({ path: join(shotDir, `live-${run}-R1.png`) });
    return `${text.length} chars`;
  });

  await scenario(run, 'R2', '表格与引用渲染', async () => {
    await send('用 Markdown 表格对比 Jest、Vitest、node:test 三个框架（列：名称、启动速度、上手难度），再给一句引用。不要调用工具。');
    await waitTurn();
    if ((await page.locator('.md-chat table').count()) !== 1) throw new Error('table missing');
    if ((await page.locator('.md-chat th').count()) < 3) throw new Error('table head missing');
    if ((await page.locator('.md-chat blockquote').count()) === 0) throw new Error('blockquote missing');
    const over = await overflow('.transcript');
    if (over > 2) throw new Error(`transcript overflow ${over}px`);
    await page.screenshot({ path: join(shotDir, `live-${run}-R2.png`) });
    return `${await page.locator('.md-chat td').count()} cells`;
  });

  await scenario(run, 'R3', '围栏代码块渲染', async () => {
    await send('给我一段 5 行的 JavaScript 代码，放在围栏代码块里，只输出代码块，不要解释。');
    await waitTurn();
    if ((await page.locator('.md-chat pre code').count()) === 0) throw new Error('code block missing');
    const code = await page.locator('.md-chat pre code').innerText();
    if (!code.includes('\n')) throw new Error('code block lost line breaks');
    const over = await overflow('.transcript');
    if (over > 2) throw new Error(`transcript overflow ${over}px`);
    await page.screenshot({ path: join(shotDir, `live-${run}-R3.png`) });
    return `${code.split('\n').length} lines`;
  });

  await scenario(run, 'T1', '创建文件并运行测试', async () => {
    await send('在工作区里创建 greet.mjs（导出 greet(name) 返回 "Hello, name!"），再创建 test/greet.test.mjs 用 node:test 测它，最后运行 npm test，把结果告诉我。');
    await waitTurn();
    const over = await overflow('.transcript');
    if (over > 2) throw new Error(`transcript overflow ${over}px`);
    const exists = await stat(join(workspace, 'greet.mjs')).then(() => true).catch(() => false);
    if (!exists) throw new Error('greet.mjs missing');
    // expand the finished process and check the operation rows
    await page.locator('.turn-head').last().click();
    await page.waitForTimeout(300);
    const rows = (await page.locator('.turn-process .tool-name').allInnerTexts()).join(' ');
    await page.locator('.turn-head').last().click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: join(shotDir, `live-${run}-T1.png`) });
    return `file ok / ${rows.slice(0, 40)}`;
  });

  await scenario(run, 'B1', '修复失败测试且不改测试', async () => {
    const before = createHash('sha256').update(await readFile(join(workspace, 'test', 'stats.test.mjs'))).digest('hex');
    await send('test/stats.test.mjs 现在失败。运行 node --test 找出原因，修复 lib/stats.mjs 里的问题；不要修改测试文件，修好后再次运行确认全部通过。');
    await waitTurn();
    const after = createHash('sha256').update(await readFile(join(workspace, 'test', 'stats.test.mjs'))).digest('hex');
    if (before !== after) throw new Error('test file was modified');
    const text = await answerText();
    if (!/通过|pass/i.test(text)) throw new Error(`answer does not report success: ${text.slice(0, 80)}`);
    await page.screenshot({ path: join(shotDir, `live-${run}-B1.png`) });
    return 'tests green';
  });

  await scenario(run, 'A1', '真实审批：每次询问', async () => {
    await launch();
    await page.locator('.policy-wrap .tb-chip').click();
    await page.waitForTimeout(250);
    await page.getByRole('option', { name: /每次询问/ }).click();
    await page.waitForTimeout(400);
    await send('运行 npm test 看看现在的测试状态，并告诉我结果。');
    let approvals = 0;
    const started = Date.now();
    while (Date.now() - started < 120_000) {
      if (await page.locator('.approval-card').count()) {
        approvals += 1;
        await page.locator('.approval-card .primary').click();
        await page.waitForTimeout(500);
        continue;
      }
      const stop = await page.locator('.send.stop-mode').count();
      if (!stop && approvals > 0) break;
      await page.waitForTimeout(400);
    }
    if (approvals === 0) throw new Error('no approval card');
    await page.waitForTimeout(800);
    if ((await page.locator('.turn-process').count()) !== 0) throw new Error('process not folded after approval turn');
    await page.screenshot({ path: join(shotDir, `live-${run}-A1.png`) });
    return `${approvals} approval(s)`;
  });

  await scenario(run, 'M1', '多轮对话的 minimap', async () => {
    await writeSettings('full');
    await launch();
    for (const text of ['第一轮：用一句话说明这个项目', '第二轮：这个项目最该先改什么', '第三轮：给一个下一步建议']) {
      await send(text);
      await waitTurn();
    }
    const stripes = await page.locator('.minimap-stripe').count();
    if (stripes !== 3) throw new Error(`stripes: ${stripes}`);
    await page.locator('.minimap-stripe').first().hover();
    await page.waitForTimeout(400);
    const tip = await page.locator('.minimap-tip').innerText();
    if (!/第一轮|项目/.test(tip)) throw new Error(`tooltip: ${tip.slice(0, 40)}`);
    const box = await page.locator('.transcript-holder').boundingBox();
    await page.screenshot({
      path: join(shotDir, `live-${run}-M1.png`),
      clip: { x: box.x + box.width - 340, y: box.y, width: 340, height: Math.min(box.height, 420) },
    });
    return '3 stripes';
  });

  await app.close().catch(() => undefined);
}

const failed = results.filter((entry) => entry.status === 'fail');
await writeFile(join(shotDir, 'results-live2.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
