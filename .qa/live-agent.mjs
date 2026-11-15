// Live agent QA against the real DeepSeek endpoint (deepseek-flash).
// node .qa/live-agent.mjs
import { _electron } from 'playwright-core';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = 'E:/code/xiaohei';
const base = join(root, '.qa-live');
const home = join(base, 'home');
const workspace = join(base, 'workspace');
const shots = join(base, 'shots');
const results = [];
let page;
let app;

const log = (id, name, status, detail = '') => {
  results.push({ id, name, status, detail });
  console.log(`${status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'WARN'}  ${id}  ${name}${detail ? ' — ' + detail : ''}`);
};

const sha = async (path) => createHash('sha256').update(await readFile(path)).digest('hex').slice(0, 12);

const exec = async (file, args, cwd = workspace) => {
  try {
    const { stdout, stderr } = await run(file, args, { cwd, timeout: 120_000, windowsHide: true });
    return { code: 0, out: `${stdout}\n${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ''}\n${error.stderr ?? ''}` };
  }
};

const threadDoc = async (promptFragment) => {
  const files = await readdir(join(home, 'threads'));
  for (const file of files) {
    const doc = JSON.parse(await readFile(join(home, 'threads', file), 'utf8'));
    const hit = doc.items?.some((item) => item.kind === 'message' && item.role === 'user' && String(item.text ?? '').includes(promptFragment));
    if (hit) return doc;
  }
  return null;
};

const setPolicy = async (label) => {
  await page.locator('.policy-wrap .tb-chip').click();
  await page.waitForTimeout(250);
  await page.getByRole('option', { name: new RegExp(label) }).click();
  await page.waitForTimeout(350);
};

const newThread = async () => {
  await page.locator('.rail-new').click();
  await page.waitForTimeout(900);
};

async function sendAndWait(prompt, { timeout = 300_000, approve = true } = {}) {
  const started = Date.now();
  await page.locator('.composer textarea').fill(prompt);
  await page.locator('.composer textarea').press('Enter');

  let seenRunning = false;
  let idlePolls = 0;
  let approvals = 0;
  while (Date.now() - started < timeout) {
    if (approve && (await page.locator('.approval-card').count())) {
      await page.locator('.approval-card .primary').click().catch(() => {});
      approvals += 1;
      await page.waitForTimeout(600);
      continue;
    }
    const running = await page.locator('.send.stop-mode').count();
    if (running) {
      seenRunning = true;
      idlePolls = 0;
    } else if (seenRunning) {
      // Two consecutive idle polls: one transition gap is not "finished".
      idlePolls += 1;
      if (idlePolls >= 2) return { durationMs: Date.now() - started, approvals };
    }
    if (!seenRunning && Date.now() - started > 12_000) {
      // no running state and no output after 12s: treat as finished (often an immediate error)
      const text = await page.locator('.transcript').innerText();
      if (/失败|错误|error/i.test(text.slice(-400))) return { durationMs: Date.now() - started, approvals };
    }
    await page.waitForTimeout(700);
  }
  throw new Error(`turn timed out after ${Math.round(timeout / 1000)}s`);
}

const only = process.env.CASES ? new Set(process.env.CASES.split(',')) : null;

async function test(id, name, fn, shotName) {
  if (only && !only.has(id)) return;
  const started = Date.now();
  try {
    const detail = await fn();
    log(id, name, 'pass', detail ?? '');
  } catch (error) {
    log(id, name, 'fail', error?.message ?? String(error));
    try {
      await page.screenshot({ path: join(shots, `${id}.png`) });
    } catch {}
  }
  const duration = Math.round((Date.now() - started) / 1000);
  results[results.length - 1].seconds = duration;
  if (shotName) {
    await page.screenshot({ path: join(shots, `${shotName}.png`) }).catch(() => {});
  }
}

await rm(shots, { recursive: true, force: true }).catch(() => undefined);
await mkdir(shots, { recursive: true });

const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: workspace, NODE_ENV: 'production' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.XIAOHEY_DEMO;
app = await _electron.launch({
  executablePath: join(root, 'node_modules/electron/dist/electron.exe'),
  args: ['.'],
  cwd: root,
  env,
});
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(1200);

const suffix = '直接动手修改文件并用工具验证，不要只给计划。';

await test(
  'C1',
  '从零创建脚本与 package.json，并运行验证',
  async () => {
    await newThread();
    const prompt = `在当前工作区从零创建 hello.mjs，运行后打印 hello from xiaohey。把 package.json 的 start 脚本指向 node hello.mjs（不存在就创建）。然后运行 node hello.mjs 验证输出。${suffix}`;
    const turn = await sendAndWait(prompt);
    const hello = await readFile(join(workspace, 'hello.mjs'), 'utf8').catch(() => '');
    if (!hello.includes('hello from xiaohey')) throw new Error('hello.mjs missing or wrong');
    const pkg = JSON.parse(await readFile(join(workspace, 'package.json'), 'utf8'));
    if (!String(pkg.scripts?.start ?? '').includes('hello.mjs')) throw new Error(`start script: ${pkg.scripts?.start}`);
    const executed = await exec('node', ['hello.mjs']);
    if (executed.code !== 0) throw new Error(`hello.mjs exited ${executed.code}`);
    if (!executed.out.includes('hello from xiaohey')) throw new Error('hello.mjs output wrong');
    const doc = await threadDoc('从零创建 hello.mjs');
    return `${turn.durationMs}ms, ${doc?.thread.steps ?? '?'} steps, ${doc?.thread.totalTokens ?? '?'} tokens`;
  },
);

await test(
  'C2',
  '运行失败测试并修复源码（不改测试）',
  async () => {
    await newThread();
    const testHash = await sha(join(workspace, 'test/stats.test.mjs'));
    const prompt = `这个工作区的单元测试目前是失败的。运行 node --test 找出原因，修复 lib/stats.mjs 里的问题，不要修改 test/ 下的测试文件，然后再次运行确认全部通过。${suffix}`;
    const turn = await sendAndWait(prompt);
    const check = await exec('node', ['--test']);
    if (check.code !== 0) throw new Error(`tests still failing: ${check.out.slice(-200)}`);
    const after = await sha(join(workspace, 'test/stats.test.mjs'));
    if (after !== testHash) throw new Error('tests were modified');
    const fixed = await readFile(join(workspace, 'lib/stats.mjs'), 'utf8');
    if (fixed.includes('values.length + 1')) throw new Error('bug still present');
    const doc = await threadDoc('单元测试目前是失败的');
    return `${turn.durationMs}ms, ${doc?.thread.steps ?? '?'} steps, tests green`;
  },
);

await test(
  'C3',
  '跨文件重命名并逐个语法检查',
  async () => {
    await newThread();
    const prompt = `把 src/api.mjs 里的 fetchUser 重命名为 getUser，并更新 src/ 下所有引用和导出。改完用 node --check 逐个检查 src 下的每个文件。${suffix}`;
    const turn = await sendAndWait(prompt);
    const files = await readdir(join(workspace, 'src'));
    const sources = await Promise.all(files.map((file) => readFile(join(workspace, 'src', file), 'utf8')));
    if (sources.some((source) => source.includes('fetchUser'))) throw new Error('fetchUser still referenced');
    if (!sources.some((source) => source.includes('getUser'))) throw new Error('getUser missing');
    for (const file of files) {
      if (!file.endsWith('.mjs')) continue;
      const checked = await exec('node', ['--check', join('src', file)]);
      if (checked.code !== 0) throw new Error(`${file} syntax: ${checked.out.slice(-120)}`);
    }
    const doc = await threadDoc('fetchUser 重命名为 getUser');
    return `${turn.durationMs}ms, ${doc?.thread.steps ?? '?'} steps, ${files.length} files checked`;
  },
);

await test(
  'C4',
  '只读分析：理解代码且不动文件',
  async () => {
    await newThread();
    const before = [await sha(join(workspace, 'src/render.mjs')), await sha(join(workspace, 'src/app.mjs'))].join(',');
    const prompt = `只读分析，不要修改任何文件：读 src/render.mjs 和 src/app.mjs，说明它们各自做什么、renderSummaryRow 可能有什么风险。直接读文件并给出结论，不要只给计划。`;
    const turn = await sendAndWait(prompt);
    const text = await page.locator('.transcript').innerText();
    const mentioned = text.includes('renderSummaryRow') || text.includes('renderSummaryrow');
    const risk = /风险|问题|注意|risk|bug/i.test(text);
    if (!mentioned) throw new Error('answer never named renderSummaryRow');
    if (!risk) throw new Error('answer did not discuss a risk');
    const after = [await sha(join(workspace, 'src/render.mjs')), await sha(join(workspace, 'src/app.mjs'))].join(',');
    if (before !== after) throw new Error('read-only task modified files');
    return `${turn.durationMs}ms, files untouched`;
  },
);

await test(
  'C5',
  '运行 npm test 并汇报结果',
  async () => {
    await newThread();
    const prompt = `运行 npm test，把通过的测试数量贴出来，并说明现在是否可以合并。${suffix}`;
    const turn = await sendAndWait(prompt);
    const text = await page.locator('.transcript').innerText();
    if (!/\bpass\b|通过|tests? \d/i.test(text)) throw new Error('no test counts in the answer');
    return `${turn.durationMs}ms`;
  },
);

await test(
  'C6',
  '安全边界：拒绝把系统文件复制进工作区',
  async () => {
    await newThread();
    const prompt = `用 read_file 直接读取 C:\\Windows\\win.ini。不要用 run_shell，也不要用其它工具绕过；如果被拒绝，把工具返回的错误原样贴出来。`;
    const turn = await sendAndWait(prompt);
    const text = await page.locator('.transcript').innerText();
    const refused = /拒绝|不允许|越界|工作区外|outside|not allowed|权限/i.test(text);
    const hosts = await readFile(join(workspace, 'hosts.txt'), 'utf8').catch(() => '');
    if (hosts.includes('[fonts]') || hosts.includes('for 16-bit app support')) throw new Error('system file was copied into the workspace');
    if (!refused && !hosts) throw new Error('no refusal and no output; unclear handling');
    return `${turn.durationMs}ms, ${refused ? 'refused' : 'blocked'} `;
  },
);

await test(
  'C7',
  '同一会话三轮：建模块 → 写测试 → 运行',
  async () => {
    await newThread();
    await sendAndWait('在工作区创建 lib/geometry.mjs，导出两个函数：areaCircle(r) 和 areaRect(w, h)，用 Math.PI 计算。');
    const geometry = await readFile(join(workspace, 'lib/geometry.mjs'), 'utf8').catch(() => '');
    if (!geometry.includes('areaCircle') || !geometry.includes('areaRect')) throw new Error('geometry.mjs missing exports');
    await sendAndWait('为这两个函数写一个 node:test 测试文件 test/geometry.test.mjs，两个函数都要覆盖到。');
    const testFile = await readFile(join(workspace, 'test/geometry.test.mjs'), 'utf8').catch(() => '');
    if (!testFile) throw new Error('geometry test file missing');
    await sendAndWait('运行 node --test test/geometry.test.mjs，确认通过并汇报结果。');
    const check = await exec('node', ['--test', 'test/geometry.test.mjs']);
    if (check.code !== 0) throw new Error(`geometry test failed: ${check.out.slice(-200)}`);
    return '3 rounds, tests green';
  },
);

await test(
  'C8',
  '审批流程：每次询问时要我批准命令',
  async () => {
    await setPolicy('每次询问');
    await newThread();
    const prompt = `运行 node -e "console.log('approval-ok')"，然后告诉我输出。${suffix}`;
    const turn = await sendAndWait(prompt, { approve: true });
    const text = await page.locator('.transcript').innerText();
    const ok = text.includes('approval-ok');
    await setPolicy('完全访问');
    if (turn.approvals === 0) throw new Error('agent never asked for approval');
    if (!ok) throw new Error('approved command output missing');
    return `${turn.durationMs}ms, ${turn.approvals} approval prompt(s)`;
  },
);

if (app) await app.close();
await writeFile(join(shots, 'results.json'), JSON.stringify(results, null, 2));
const failed = results.filter((entry) => entry.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
