import { readFile } from 'node:fs/promises';
import { ensureDir, writeTextAtomic } from '../util.js';
import { fileFingerprint } from '../fingerprint.js';
import { progressFile, memoryRoot } from './memdir.js';
import { metaComment, oneLine, readMetaComments, stamp } from './memmark.js';

/**
 * Working memory: the task's live notebook and write-ahead log.
 *
 * `~/.xiaohei/progress.md` records, per session, every tool step with why it was
 * taken, what came back and what is next. A mutating step is written as
 * "executing" (with the target's before-fingerprint) BEFORE the tool runs and
 * finalized afterwards, so a crash between the disk write and the record leaves
 * an entry that boot-time settlement reconciles against the file on disk.
 */

export type WorkingStatus = 'running' | 'paused' | 'done' | 'failed' | 'interrupted';
export type StepPhase = 'executing' | 'done' | 'failed' | 'interrupted';
export type StepVerdict = 'not-applied' | 'unknown';

export interface WorkingStep {
  at: number;
  turn: number;
  step: number;
  tool: string;
  /** Pairs the write-ahead entry with its finalization. */
  callId?: string;
  phase: StepPhase;
  /** What the tool was called with, short form. */
  detail: string;
  /** Why this tool, from the model's reasoning or the tool's routing rule. */
  intent: string;
  result: string;
  ok: boolean;
  next: string;
  /** Absolute path of the write target; absent for shell/no-target steps. */
  target?: string;
  /** Target fingerprint before execution — the crash-reconcile anchor. */
  before?: string;
  /** Filled at boot settlement for steps interrupted mid-execution. */
  verdict?: StepVerdict;
}

export interface WorkingTask {
  threadId: string;
  title: string;
  cwd: string;
  goal: string;
  status: WorkingStatus;
  startedAt: number;
  updatedAt: number;
  next: string;
  steps: WorkingStep[];
}

export const MAX_STEPS = 120;
export const MAX_TASKS = 20;
export const INTERRUPTED_NEXT = '应用退出时任务中断。下一轮先读工作记忆，从「下一步」继续，不要从头重做。';

const STATUS_LABEL: Record<WorkingStatus, string> = {
  running: '进行中',
  paused: '待继续',
  done: '已完成',
  failed: '失败',
  interrupted: '已中断',
};

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

function sanitizeStep(raw: unknown): WorkingStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const tool = asText(value.tool).trim() || 'step';
  const ok = value.ok !== false;
  const phase: StepPhase =
    value.phase === 'executing' || value.phase === 'done' || value.phase === 'failed' || value.phase === 'interrupted'
      ? value.phase
      : ok
        ? 'done'
        : 'failed';
  return {
    at: typeof value.at === 'number' ? value.at : Date.now(),
    turn: typeof value.turn === 'number' ? value.turn : 0,
    step: typeof value.step === 'number' ? value.step : 0,
    tool,
    callId: asText(value.callId) || undefined,
    phase,
    detail: asText(value.detail),
    intent: asText(value.intent),
    result: asText(value.result),
    ok,
    next: asText(value.next),
    target: asText(value.target) || undefined,
    before: asText(value.before) || undefined,
    verdict: value.verdict === 'not-applied' || value.verdict === 'unknown' ? value.verdict : undefined,
  };
}

function sanitizeTask(raw: Record<string, unknown>): WorkingTask | null {
  const threadId = asText(raw.threadId).trim();
  if (!threadId) return null;
  const status: WorkingStatus =
    raw.status === 'done' || raw.status === 'failed' || raw.status === 'interrupted' || raw.status === 'paused' || raw.status === 'running'
      ? raw.status
      : 'interrupted';
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map(sanitizeStep).filter((step): step is WorkingStep => step !== null).slice(-MAX_STEPS)
    : [];
  return {
    threadId,
    title: asText(raw.title) || threadId,
    cwd: asText(raw.cwd),
    goal: asText(raw.goal),
    status,
    startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : Date.now(),
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    next: asText(raw.next),
    steps,
  };
}

function phaseLabel(step: WorkingStep): string {
  if (step.phase === 'executing') return '执行中';
  if (step.phase === 'interrupted') return step.verdict === 'not-applied' ? '已中断·未落地' : '已中断·待核实';
  return step.ok ? '成功' : '失败';
}

function renderStep(step: WorkingStep, index: number): string {
  const clock = stamp(step.at);
  const args = step.detail.startsWith(step.tool) ? step.detail.slice(step.tool.length).trim() : step.detail;
  return [
    `${index + 1}. ${clock} · 第 ${step.turn} 轮 / 步骤 ${step.step} · ${step.tool} · ${phaseLabel(step)}`,
    `   - 工具：${oneLine(step.tool, 80)}${args ? `（${oneLine(args, 160)}）` : ''}`,
    `   - 为什么：${oneLine(step.intent || '未记录', 300)}`,
    `   - 结果：${phaseLabel(step)} · ${oneLine(step.result || '未记录', 300)}`,
    `   - 下一步：${oneLine(step.next || '继续当前步骤', 240)}`,
  ].join('\n');
}

function renderTask(task: WorkingTask): string {
  const lines: string[] = [
    `## ${oneLine(task.title, 80)} · ${task.threadId}`,
    metaComment('task', task),
    '',
    `- 工作区：${task.cwd || '(未设置)'}`,
    `- 目标：${oneLine(task.goal || '(未记录)', 300)}`,
    `- 状态：${STATUS_LABEL[task.status]}`,
    `- 开始：${stamp(task.startedAt)}`,
    `- 最近更新：${stamp(task.updatedAt)}`,
    `- 下一步：${oneLine(task.next || '(未记录)', 300)}`,
    '',
    '### 步骤',
    '',
    task.steps.length > 0 ? task.steps.map(renderStep).join('\n\n') : '（还没有步骤）',
  ];
  return lines.join('\n');
}

export class WorkingMemory {
  readonly file: string;
  private tasks = new Map<string, WorkingTask>();
  private loaded = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(readonly root: string = memoryRoot()) {
    this.file = progressFile(root);
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await ensureDir(this.root);
    const raw = await readFile(this.file, 'utf8').catch(() => '');
    for (const task of readMetaComments<Record<string, unknown>>(raw, 'task')) {
      const clean = sanitizeTask(task);
      if (clean) this.tasks.set(clean.threadId, clean);
    }
    this.loaded = true;
  }

  tasksSnapshot(): WorkingTask[] {
    return [...this.tasks.values()].map((task) => ({ ...task, steps: [...task.steps] }));
  }

  get(threadId: string): WorkingTask | undefined {
    const task = this.tasks.get(threadId);
    return task ? { ...task, steps: [...task.steps] } : undefined;
  }

  async startTask(input: { threadId: string; title: string; cwd: string; goal: string }): Promise<void> {
    await this.load();
    const now = Date.now();
    const existing = this.tasks.get(input.threadId);
    if (existing) {
      existing.title = input.title || existing.title;
      existing.cwd = input.cwd || existing.cwd;
      if (input.goal.trim()) existing.goal = input.goal.trim();
      existing.status = 'running';
      existing.updatedAt = now;
      if (!existing.next.trim()) existing.next = '开始执行本轮';
    } else {
      this.tasks.set(input.threadId, {
        threadId: input.threadId,
        title: input.title || input.threadId,
        cwd: input.cwd,
        goal: input.goal,
        status: 'running',
        startedAt: now,
        updatedAt: now,
        next: '开始执行本轮',
        steps: [],
      });
    }
    await this.save();
  }

  private ensureTask(threadId: string): WorkingTask {
    const now = Date.now();
    let task = this.tasks.get(threadId);
    if (!task) {
      task = {
        threadId,
        title: threadId,
        cwd: '',
        goal: '',
        status: 'running',
        startedAt: now,
        updatedAt: now,
        next: '',
        steps: [],
      };
      this.tasks.set(threadId, task);
    }
    return task;
  }

  /** Write-ahead entry: flushed to disk BEFORE the tool touches anything. */
  async beginStep(input: {
    threadId: string;
    turn: number;
    step: number;
    tool: string;
    callId: string;
    detail?: string;
    intent?: string;
    target?: string;
    before?: string;
  }): Promise<void> {
    await this.load();
    const task = this.ensureTask(input.threadId);
    task.steps.push({
      at: Date.now(),
      turn: input.turn,
      step: input.step,
      tool: input.tool,
      callId: input.callId,
      phase: 'executing',
      detail: (input.detail ?? '').trim(),
      intent: (input.intent ?? '').trim(),
      result: '',
      ok: false,
      next: '',
      target: input.target,
      before: input.before,
    });
    if (task.steps.length > MAX_STEPS) task.steps = task.steps.slice(-MAX_STEPS);
    task.status = 'running';
    task.updatedAt = Date.now();
    await this.save();
  }

  async recordStep(input: {
    threadId: string;
    turn: number;
    step: number;
    tool: string;
    callId?: string;
    detail?: string;
    intent?: string;
    result?: string;
    ok: boolean;
    next?: string;
  }): Promise<void> {
    await this.load();
    const now = Date.now();
    const task = this.ensureTask(input.threadId);
    const open = input.callId
      ? task.steps.find((step) => step.callId === input.callId && step.phase === 'executing')
      : undefined;
    const detail = (input.detail ?? '').trim();
    const intent = (input.intent ?? '').trim();
    const result = (input.result ?? '').trim();
    const next = (input.next ?? '').trim();
    if (open) {
      open.phase = input.ok ? 'done' : 'failed';
      open.detail = detail || open.detail;
      open.intent = intent || open.intent;
      open.result = result;
      open.ok = input.ok;
      open.next = next;
    } else {
      task.steps.push({
        at: now,
        turn: input.turn,
        step: input.step,
        tool: input.tool,
        callId: input.callId,
        phase: input.ok ? 'done' : 'failed',
        detail,
        intent,
        result,
        ok: input.ok,
        next,
      });
      if (task.steps.length > MAX_STEPS) task.steps = task.steps.slice(-MAX_STEPS);
    }
    task.status = 'running';
    task.updatedAt = now;
    if (next) task.next = next;
    await this.save();
  }

  async finish(input: { threadId: string; status: Exclude<WorkingStatus, 'running'>; next: string }): Promise<void> {
    await this.load();
    const task = this.tasks.get(input.threadId);
    if (!task) return;
    task.status = input.status;
    task.next = input.next.trim();
    task.updatedAt = Date.now();
    await this.save();
  }

  /** A deleted session takes its task notebook with it. */
  async remove(threadId: string): Promise<void> {
    await this.load();
    if (!this.tasks.delete(threadId)) return;
    await this.save();
  }

  /** Anything still "executing" at boot died with the process. Reconcile each
   * orphan against the target's current fingerprint, then settle the task. */
  async settleInterrupted(): Promise<string[]> {
    await this.load();
    const interrupted: string[] = [];
    for (const task of this.tasks.values()) {
      const open = task.steps.filter((step) => step.phase === 'executing');
      for (const step of open) {
        const current = step.target && step.before !== undefined ? await fileFingerprint(step.target) : undefined;
        const verdict: StepVerdict = current !== undefined && current === step.before ? 'not-applied' : 'unknown';
        step.phase = 'interrupted';
        step.verdict = verdict;
        step.ok = false;
        step.result = verdict === 'not-applied' ? '中断时目标未变化，写入没有落地' : '中断时无法确认写入是否落地';
        step.next = verdict === 'not-applied' ? '可以安全重做这一步' : '先重读目标核实现状，再决定是否重做';
      }
      if (task.status !== 'running' && open.length === 0) continue;
      task.status = 'interrupted';
      task.next = open.length > 0 ? `有 ${open.length} 个步骤中断待核实，先读工作记忆再继续` : task.next || INTERRUPTED_NEXT;
      task.updatedAt = Date.now();
      interrupted.push(task.threadId);
    }
    if (interrupted.length > 0) await this.save();
    return interrupted;
  }

  /** Bounded, model-facing view of one task's progress for the system prompt. */
  render(threadId: string, limit = 14): string {
    const task = this.tasks.get(threadId);
    if (!task) return '(this session has no progress recorded yet)';
    const steps = task.steps.slice(-limit);
    const lines: string[] = [
      `任务：${oneLine(task.title, 120)}`,
      `状态：${STATUS_LABEL[task.status]} · 工作区：${task.cwd || '(未设置)'}`,
      `目标：${oneLine(task.goal || '(未记录)', 240)}`,
      `下一步：${oneLine(task.next || '(未记录)', 240)}`,
    ];
    if (task.steps.length > steps.length) lines.push(`（只列最近 ${steps.length}/${task.steps.length} 步，完整记录在 ${this.file}）`);
    for (const step of steps) {
      lines.push(
        `- 第 ${step.turn} 轮/步骤 ${step.step} · ${step.tool}${step.detail ? `（${oneLine(step.detail, 80)}）` : ''} · ${phaseLabel(step)} · 为什么：${oneLine(step.intent || '未记录', 140)} · 结果：${oneLine(step.result || '未记录', 140)} · 下一步：${oneLine(step.next || '-', 100)}`,
      );
    }
    const text = lines.join('\n');
    return text.length > 4000 ? `${text.slice(0, 4000)}\n…（工作记忆更长，完整内容见文件）` : text;
  }

  async save(): Promise<void> {
    // Serialize concurrent sessions writing the shared progress file; render
    // inside the queued task so the last write contains every step.
    const task = this.saving.then(async () => {
      await ensureDir(this.root);
      const ordered = [...this.tasks.values()]
        .sort((a, b) => {
          const rank = (status: WorkingStatus): number =>
            status === 'running' ? 0 : status === 'paused' || status === 'interrupted' ? 1 : 2;
          return rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt;
        })
        .slice(0, MAX_TASKS);
      const lines: string[] = [
        '# 工作记忆 · 任务进展',
        '',
        '> 这是 agent 的任务现场：每一步用了什么工具、为什么、得到什么结果、下一步做什么。',
        '> 任务中断续接从这里开始：写操作执行前先记「执行中」并落盘，完成后更新；崩溃遗留的条目在启动时按指纹对账。HTML 注释是机器可读数据，正文只供人阅读。',
        '',
        `- 最后维护：${stamp(Date.now())}`,
        `- 任务：${ordered.length} 个`,
        '',
        ordered.length > 0 ? ordered.map(renderTask).join('\n\n---\n\n') : '（还没有任务记录）',
        '',
      ];
      await writeTextAtomic(this.file, lines.join('\n'));
    });
    this.saving = task.catch(() => undefined);
    return task;
  }
}
