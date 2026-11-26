import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ChangeStats, Item, Thread } from '../shared/types.js';
import type { SeedDoc } from './store.js';
import { Checkpoints, countLineDiff } from './runtime/checkpoint.js';
import { buildContract } from './runtime/contract.js';
import { emptyState } from './store.js';
import { uid } from './util.js';

/**
 * Demo seed. Used by `npm run shot` and by first launch in demo mode: a small
 * workspace plus a finished session, so every panel has real content to render
 * without an API key.
 */

const FILES: Record<string, string> = {
  'README.md': `# Northwind Ledger

A small reconciliation console for finance teams. Import a bank export, match it
against invoices, and review the exceptions.

- \`app/page.tsx\` — overview screen
- \`app/globals.css\` — design tokens
- \`lib/match.ts\` — matching rules
`,
  'app/page.tsx': `import { SummaryRow } from '@/components/summary-row';
import { ExceptionTable } from '@/components/exception-table';

export default function Page() {
  return (
    <main className="mx-auto max-w-6xl p-8">
      <header className="mb-10 flex items-center justify-between">
        <div>
          <h1 className="bg-gradient-to-r from-violet-400 to-fuchsia-300 bg-clip-text text-4xl font-extrabold text-transparent">
            Welcome back, Damir! 👋
          </h1>
          <p className="mt-2 text-slate-400">Your AI-powered reconciliation workspace ✨</p>
        </div>
        <button className="rounded-full bg-violet-600 px-6 py-3 font-semibold shadow-[0_0_40px_rgba(139,92,246,0.55)]">
          New import 🚀
        </button>
      </header>

      <section className="grid grid-cols-3 gap-6">
        <SummaryRow label="MATCHED" value="1,284" tone="emerald" />
        <SummaryRow label="EXCEPTIONS" value="37" tone="amber" />
        <SummaryRow label="VALUE AT RISK" value="$48,210.40" tone="rose" />
      </section>

      <ExceptionTable rows={[]} />
    </main>
  );
}
`,
  'app/globals.css': `@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --slop-violet: #8b5cf6;
  --slop-fuchsia: #d946ef;
  --slop-glow: 0 0 40px rgba(139, 92, 246, 0.55);
}

body {
  background: radial-gradient(circle at 20% 0%, #2a1052 0%, #0b0714 55%);
  color: #e7e2f5;
}
`,
  'lib/match.ts': `export interface BankRow {
  id: string;
  amount: number;
  currency: string;
  reference: string;
}

export interface Invoice {
  id: string;
  amount: number;
  currency: string;
  reference: string;
}

/** Exact reference + amount match; everything else is an exception. */
export function matchRows(rows: BankRow[], invoices: Invoice[]) {
  const byReference = new Map(invoices.map((invoice) => [invoice.reference, invoice]));
  const matched: Array<{ row: BankRow; invoice: Invoice }> = [];
  const exceptions: BankRow[] = [];
  for (const row of rows) {
    const invoice = byReference.get(row.reference);
    if (invoice && invoice.amount === row.amount && invoice.currency === row.currency) {
      matched.push({ row, invoice });
    } else {
      exceptions.push(row);
    }
  }
  return { matched, exceptions };
}
`,
};

export async function seedDemoWorkspace(workspace: string): Promise<void> {
  for (const [path, content] of Object.entries(FILES)) {
    const full = join(workspace, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  // A repository makes the branch indicator in the composer meta real.
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: workspace, stdio: 'ignore', timeout: 8000 });
  } catch {
    // git is optional; the footer simply omits the branch
  }
}

/**
 * The edits the demo session claims to have made. Written after the snapshot is
 * captured, so the document panel has a real before/after to compare.
 */
const AFTER: Record<string, string> = {
  'app/page.tsx': `import { SummaryRow } from '@/components/summary-row';
import { ExceptionTable } from '@/components/exception-table';

export default function Page() {
  return (
    <main className="mx-auto max-w-6xl px-8 py-10">
      <header className="mb-10 flex items-end justify-between gap-8 border-b border-stone-200 pb-6">
        <div>
          <h1 className="text-2xl font-medium tracking-tight text-stone-900">October 2026</h1>
          <p className="mt-1 text-sm text-stone-500">1,284 matched · 37 exceptions to review</p>
        </div>
        <button className="h-9 rounded-lg bg-[#2f6b52] px-4 text-sm font-medium text-white">
          New import
        </button>
      </header>

      <section className="grid grid-cols-3 gap-10">
        <SummaryRow label="Matched" value="1,284" detail="+12% vs September" />
        <SummaryRow label="Exceptions" value="37" detail="3 fewer vs September" />
        <SummaryRow label="Value at risk" value="$48,210" detail="4 invoices over 30 days" />
      </section>

      <ExceptionTable rows={[]} />
    </main>
  );
}
`,
};

export async function applyDemoEdits(workspace: string): Promise<void> {
  for (const [path, content] of Object.entries(AFTER)) {
    await writeFile(join(workspace, path), content, 'utf8');
  }
}

/** Same line-count rule the runtime uses, so the demo card and the diff agree. */
function demoChangeStats(): ChangeStats {
  const { additions, deletions } = countLineDiff(FILES['app/page.tsx'], AFTER['app/page.tsx']);
  return {
    additions,
    deletions,
    files: [{ path: 'app/page.tsx', additions, deletions }],
  };
}

export async function buildDemoDoc(home: string, workspace: string): Promise<SeedDoc> {
  const now = Date.now();
  const thread: Thread = {
    id: 'thr_demo_northwind',
    title: '把概览页做成设计过的样子',
    cwd: workspace,
    createdAt: now - 1000 * 60 * 42,
    updatedAt: now - 1000 * 60 * 3,
    status: 'idle',
    turnCount: 1,
    steps: 9,
    totalTokens: 21_480,
    itemCount: 0,
    lastPrompt: '把概览页做成设计过的样子，不要新增功能',
    model: 'deepseek-chat',
  };

  const turnId = 'trn_demo_1';
  const items: Item[] = [];
  const at = (minutesAgo: number): number => now - minutesAgo * 6_000;

  const push = (item: Item): void => {
    items.push(item);
  };

  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'message', at: at(41), status: 'done', role: 'user',
    text: '把概览页做成「设计过的」而不是「生成出来的」。保留三个数字和异常表格，不要新增功能。验收：三个数字含义不变，构建仍然通过。',
  });

  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'notice', at: at(40), status: 'done', tone: 'info',
    title: '任务契约已写入',
    body: '目标：让概览页读起来像财务工具，而不是模板。\n验收：三个数字含义不变 · 不引入 token 之外的圆角和颜色 · 现有组件保留 · 构建通过',
  });

  const plan = [
    { id: 's1', title: '按痕迹清单审计这一屏', status: 'done' as const },
    { id: 's2', title: '定方向：石墨灰、账页纸、一个账本绿', status: 'done' as const },
    { id: 's3', title: '头部和三个数字合成一行', status: 'done' as const },
    { id: 's4', title: '字体、间距和表格状态', status: 'active' as const },
    { id: 's5', title: '跑构建做验收', status: 'pending' as const },
  ];
  push({ id: uid('itm'), threadId: thread.id, turnId, kind: 'plan', at: at(39), status: 'done', steps: plan });

  const callRead = { id: uid('itm'), threadId: thread.id, turnId, kind: 'tool_call', at: at(38), status: 'done', callId: 'call_read_1', name: 'read_file', args: { path: 'app/page.tsx' }, summary: 'read_file app/page.tsx', risk: 'read' } as const;
  push(callRead);
  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'tool_result', at: at(38), status: 'done', callId: 'call_read_1', name: 'read_file', ok: true,
    summary: 'app/page.tsx · 26/26 lines', layer: 'none', retryable: false, files: ['app/page.tsx'], durationMs: 41,
    output: '   1 │ import { SummaryRow } from \'@/components/summary-row\';\n   2 │ import { ExceptionTable } from \'@/components/exception-table\';\n   3 │\n   4 │ export default function Page() {\n   5 │   return (\n   6 │     <main className="mx-auto max-w-6xl p-8">\n   7 │       <header className="mb-10 flex items-center justify-between">',
  });

  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'tool_call', at: at(37), status: 'done', callId: 'call_grep_1', name: 'grep_text',
    args: { pattern: 'gradient|glow|text-transparent|emoji', glob: 'app/**/*.tsx' }, summary: 'grep_text /gradient|glow/', risk: 'read',
  });
  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'tool_result', at: at(37), status: 'done', callId: 'call_grep_1', name: 'grep_text', ok: true,
    summary: '4 hits in 1 file', layer: 'none', retryable: false, files: ['app/page.tsx'], durationMs: 22,
    output: 'app/page.tsx:8: bg-gradient-to-r from-violet-400 to-fuchsia-300 bg-clip-text text-transparent\napp/page.tsx:9: Welcome back, Damir! 👋\napp/page.tsx:17: shadow-[0_0_40px_rgba(139,92,246,0.55)]\napp/page.tsx:24: <SummaryRow label="MATCHED" value="1,284"',
  });

  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'message', at: at(36), status: 'done', role: 'assistant',
    text: '四处痕迹都在头部：紫到粉的渐变标题、写着用户名字的问候、一个 emoji、会发光的胶囊按钮。三个数字本身是对的，但它们并排挤在等宽卡片里、配着全大写加宽字距的小标签，这是模板最典型的读法。\n\n方向：石墨灰中性色偏向账页纸，唯一强调色用一个克制的账本绿，只出现在「已匹配」这个数字和主操作上。数字统一等宽对齐、共用一个基线；头部变成期间而不是问候。',
    evidence: ['read_file:app/page.tsx', 'grep_text:gradient|glow'],
  });

  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'tool_call', at: at(30), status: 'done', callId: 'call_write_1', name: 'edit_file',
    args: { path: 'app/page.tsx', find: 'Welcome back, Damir! 👋', replace: 'October 2026' }, summary: 'edit_file app/page.tsx', risk: 'write',
  });
  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'tool_result', at: at(30), status: 'done', callId: 'call_write_1', name: 'edit_file', ok: true,
    summary: 'edited app/page.tsx · 1 replacement', layer: 'none', retryable: false, files: ['app/page.tsx'], durationMs: 18,
    output: 'app/page.tsx updated',
  });

  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'checkpoint', at: at(30), status: 'done', step: 4,
    label: 'edit_file app/page.tsx', snapshotId: 'step-004', filesTouched: ['app/page.tsx'], additiveOnly: false,
    changeStats: demoChangeStats(),
  });

  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'approval', at: at(26), status: 'done', callId: 'call_shell_1',
    name: 'run_shell', command: 'npm run build', reason: '证明改过的页面仍然能构建', decision: 'allow_once',
  });
  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'tool_call', at: at(26), status: 'done', callId: 'call_shell_1', name: 'run_shell',
    args: { command: 'npm run build', purpose: '证明改过的页面仍然能构建' }, summary: 'npm run build', risk: 'exec',
  });
  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'tool_result', at: at(25), status: 'done', callId: 'call_shell_1', name: 'run_shell', ok: true,
    summary: 'npm run build · exit 0 in 8412ms', layer: 'none', retryable: false, durationMs: 8412,
    output: '$ npm run build\n> next build\n\n  Creating an optimized production build ...\n✓ Compiled successfully\n✓ Linting and checking validity of types\n✓ Collecting page data\n✓ Generating static pages (4/4)\n\nRoute (app)                              Size     First Load JS\n○ /                                      1.2 kB         92.4 kB\n\nDone in 8.4s',
  });

  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'tool_call', at: at(20), status: 'done', callId: 'call_todo_1', name: 'todo_write',
    args: { steps: plan.map((step) => ({ title: step.title, status: step.id === 's4' ? 'active' : step.status })) }, summary: 'plan updated', risk: 'write',
  });
  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'tool_result', at: at(20), status: 'done', callId: 'call_todo_1', name: 'todo_write', ok: true,
    summary: 'plan updated · 3/5 done', layer: 'none', retryable: false, durationMs: 4,
    output: '[done] 按痕迹清单审计这一屏\n[done] 定方向：石墨灰、账页纸、一个账本绿\n[done] 头部和三个数字合成一行\n[active] 字体、间距和表格状态\n[pending] 跑构建做验收',
  });

  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'message', at: at(15), status: 'done', role: 'assistant',
    text: '头部和数字行改完了：标题现在是期间，渐变和发光拿掉了，三个数字共用一个基线、用等宽数字，强调色只出现一次。下一轮是表格：行高、把异常数量收成安静的等宽小字、补一个看得见的键盘焦点。要我继续，还是先停下让你看一眼屏幕？',
    evidence: ['read_file:app/page.tsx', 'edit_file:app/page.tsx', 'run_shell:npm run build'],
  });

  push({
    id: uid('itm'), threadId: thread.id, turnId, kind: 'compaction', at: at(14), status: 'done',
    tokensBefore: 71_240, tokensAfter: 18_930, foldedItems: 6, keptItems: 2,
    summary: '用户要求重做 Northwind 概览页，不新增功能。审计发现渐变标题、问候语、emoji、发光按钮、全大写加宽标签。方向定为石墨灰 + 账页纸 + 一个账本绿。头部已重做，构建 8.4s 通过。剩余：表格状态，然后最终验收。',
  });

  thread.itemCount = items.length;
  const doc: SeedDoc = {
    thread,
    turn: {
      id: turnId,
      threadId: thread.id,
      index: 1,
      prompt: thread.lastPrompt,
      status: 'completed',
      startedAt: at(41),
      endedAt: at(13),
      step: 9,
      stopReason: 'model finished',
    },
    items,
    state: {
      ...emptyState(),
      plan,
      contract: buildContract(
        '把概览页做成设计过的样子，不要新增功能。验收：三个数字含义不变，构建通过。非目标：不改异常表格的数据。',
      ),
      memory: [
        {
          id: uid('mem'), slot: 'pref.copy', value: '界面文案不用感叹号，也不用 emoji', scopeKey: 'workspace',
          scope: { kind: 'workspace' }, source: 'turn 1', createdAt: at(40), updatedAt: at(40), status: 'active',
        },
        {
          id: uid('mem'), slot: 'entity.client', value: 'Northwind Ledger（财务对账控制台）', scopeKey: 'workspace',
          scope: { kind: 'workspace' }, source: 'turn 1', createdAt: at(40), updatedAt: at(40), status: 'active',
        },
      ],
      context: {
        summary:
          'Northwind 概览页重做：审计完成（渐变标题、问候语、emoji、发光按钮、全大写加宽标签），方向已定（石墨灰 + 账本绿），头部和数字行重做完成，构建通过。剩余：表格状态与最终验收。',
        foldedItems: 9,
        compacted: 1,
        tokensUsed: 18_930,
      },
      evidence: ['read_file:app/page.tsx', 'grep_text:gradient|glow', 'edit_file:app/page.tsx', 'run_shell:npm run build'],
    },
    snapshots: [],
  };

  return doc;
}

/**
 * Demo-only activity history, so the heatmap has a plausible shape on first run.
 * Deterministic: the same day index always yields the same count.
 */
export function demoActivity(weeks: number): Array<{ date: string; count: number }> {
  const days: Array<{ date: string; count: number }> = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const total = weeks * 7;
  for (let i = total - 1; i >= 0; i -= 1) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const weekday = date.getDay();
    const seed = (i * 29 + weekday * 7) % 23;
    let count = seed < 9 ? 0 : seed < 15 ? 1 + (i % 3) : seed < 20 ? 4 + (i % 4) : 8 + (i % 5);
    if (weekday === 0 || weekday === 6) count = Math.floor(count / 3);
    if (i === 0) count = Math.max(count, 6);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    days.push({ date: key, count });
  }
  return days;
}

export async function captureDemoSnapshot(home: string, doc: SeedDoc): Promise<void> {
  const checkpoints = new Checkpoints(join(home, 'snapshots'));
  const meta = await checkpoints.capture({
    threadId: doc.thread.id,
    step: 4,
    label: 'edit_file app/page.tsx',
    workspace: doc.thread.cwd,
    state: { items: doc.items, plan: doc.state.plan },
    filesTouched: ['app/page.tsx'],
  });
  doc.snapshots = [
    {
      ...meta,
      changeStats: demoChangeStats(),
    },
  ];
}
