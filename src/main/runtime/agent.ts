import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ApprovalDecision,
  ApprovalItem,
  ApprovalRequest,
  CheckpointItem,
  CompactionItem,
  ContextGauge,
  Item,
  MessageItem,
  NoticeItem,
  PlanItem,
  PlanStep,
  QuestionItem,
  QuestionOption,
  RuntimeEvent,
  RuntimeStatus,
  Thread,
  ToolCallItem,
  ToolResultItem,
  Turn,
} from '../../shared/types.js';
import type { Store, ThreadDoc } from '../store.js';
import { Checkpoints } from './checkpoint.js';
import { LockTable } from './locks.js';
import { buildContract, checkDrift, MILESTONE_EVERY } from './contract.js';
import { LongTermMemory, memoryFacts } from './longterm.js';
import { ConfiguredEmbedder, type EmbeddingConfig } from './embedding.js';
import { ConfiguredReranker, type RerankConfig } from './rerank.js';
import { ShortTermMemory, SHORT_TERM_SUMMARY_PROMPT, mechanicalRoundSummary, type RoundRecord } from './shortterm.js';
import { WorkingMemory } from './working.js';
import { memoryRoot } from './memdir.js';
import { stamp } from './memmark.js';
import { extractEvents, mergeResolution, parseRelativeTime, resolveEntities } from './resolve.js';
import { audits } from '../audit.js';
import {
  auditClaims,
  buildSystemPrompt,
  contextBudget,
  DEFAULT_CONTEXT_WINDOW,
  gaugeOf,
  shouldCompressHistory,
  toMessages,
  tokensOf,
} from './context.js';
import { complete, LlmError, type ChatMessage, type ToolCall } from './llm.js';
import { classifyCommand, autoDecision, writeDecision } from './policy.js';
import { guardedCommit, normalizeWorkspace, workspaceKey } from './commit.js';
import {
  commitWorktree,
  createWorktree,
  mergeWorktree,
  prepareConflictResolution,
  removeWorktree,
  type WorktreeState,
} from './worktree.js';
import { toolByName, toolSpecs, tools, type ToolExecContext, type ToolDefinition } from './tools.js';
import { noteAttempt, parseArguments, readDomainFailure, schemaRetriesLeft, validateArgs, type RetryLedger, type ToolFailure } from './toolerrors.js';
import { fileFingerprint } from '../fingerprint.js';
import { clamp, estimateTokens, formatDuration, resolveInside, truncate, uid } from '../util.js';

export interface AgentDeps {
  store: Store;
  emit: (event: RuntimeEvent) => void;
  home: string;
  /** Overrides `~/.xiaohey` for tests and the demo profile. */
  memoryHome?: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

interface PendingQuestion {
  threadId: string;
  resolve: (answer: { answer: string; cancelled: boolean }) => void;
}

interface PreparedCall {
  tool: ToolDefinition;
  args: Record<string, unknown>;
  callItem: ToolCallItem;
  context: ToolExecContext;
  schemaRetries: number;
}

/**
 * Tools whose only effect is reading. They take no lease, need no write-ahead
 * entry and capture no checkpoint, so a batch of them can run at the same time.
 * Anything mutating, or that blocks on the user, stays strictly sequential.
 */
const PARALLEL_READ_TOOLS = new Set(['read_file', 'list_dir', 'glob_files', 'grep_text']);
const MAX_PARALLEL_READS = 8;
export { PARALLEL_READ_TOOLS, MAX_PARALLEL_READS };

/**
 * The turn engine.
 *
 * A turn is a bounded loop: assemble context → call the model → execute tool
 * calls under locks/approval → checkpoint → repeat until the model stops
 * asking for tools. Everything the loop needs to survive a crash is written to
 * disk before it is trusted.
 */
export class AgentService {
  private readonly locks: LockTable;
  private readonly checkpoints: Checkpoints;
  private readonly controllers = new Map<string, AbortController>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly allowedCommands = new Map<string, Set<string>>();
  private readonly ledger: RetryLedger = { attempts: new Map() };
  private readonly running = new Set<string>();
  /** threadId → normalized workspace, so a destructive whole-tree action can see its neighbours. */
  private readonly runningCwd = new Map<string, string>();
  /** threadId → normalized *effective* tree (worktree path when isolated), for merge/revert addressing. */
  private readonly trees = new Map<string, string>();
  private readonly sessions = new Map<string, ShortTermMemory>();
  readonly memory: LongTermMemory;
  readonly working: WorkingMemory;

  constructor(private readonly deps: AgentDeps) {
    this.locks = new LockTable(join(deps.home, 'leases.json'));
    this.checkpoints = new Checkpoints(join(deps.home, 'snapshots'));
    const root = deps.memoryHome ?? memoryRoot();
    this.memory = new LongTermMemory(root, {
      embedder: new ConfiguredEmbedder(() => this.embeddingConfig()),
      reranker: new ConfiguredReranker(() => this.rerankConfig()),
    });
    this.working = new WorkingMemory(root);
  }

  /** The embedding provider is the configured one, or the active chat model's endpoint. */
  private embeddingConfig(): EmbeddingConfig | null {
    const settings = this.deps.store.getSettings();
    const embedding = settings.embedding;
    if (!embedding?.enabled || !embedding.model.trim()) return null;
    const active = this.deps.store.activeModel();
    const baseUrl = embedding.baseUrl.trim() || active?.baseUrl.trim() || '';
    const apiKey = embedding.apiKey.trim() || active?.apiKey || '';
    if (!baseUrl) return null;
    return { baseUrl, apiKey, model: embedding.model.trim() };
  }

  /** Reranking is optional and independent of whether vectors are configured. */
  private rerankConfig(): RerankConfig | null {
    const settings = this.deps.store.getSettings();
    const embedding = settings.embedding;
    if (!embedding?.enabled || !embedding.rerankModel?.trim()) return null;
    const active = this.deps.store.activeModel();
    const baseUrl = embedding.rerankBaseUrl?.trim() || embedding.baseUrl.trim() || active?.baseUrl.trim() || '';
    const apiKey = embedding.apiKey.trim() || active?.apiKey || '';
    if (!baseUrl) return null;
    return { baseUrl, apiKey, model: embedding.rerankModel.trim() };
  }

  async init(): Promise<void> {
    // Memory must never keep the app from starting: a read-only or corrupt
    // memory file degrades to "no memory", it does not brick the workspace.
    try {
      await this.memory.load();
      await this.memory.maintain();
      await this.migrateLegacyMemory();
      // Build/refresh vectors in the background: a local index is immediate, a
      // provider index can take a few requests and must not delay boot.
      void this.memory.ensureVectors().catch(() => undefined);
    } catch {
      // Memory tool calls will surface the real error if the user asks for them.
    }
    try {
      await this.working.load();
    } catch {
      // Working memory is a recovery aid; the turn loop still works without it.
    }

    const interrupted = await this.working.settleInterrupted().catch(() => []);
    for (const threadId of interrupted) {
      const doc = await this.deps.store.load(threadId).catch(() => null);
      if (!doc) continue;
      const task = this.working.get(threadId);
      this.emitNotice(threadId, {
        tone: 'warn',
        title: '上一次任务中断，工作记忆已保留',
        body: `进度写在 ${this.working.file}，最近一步：${task?.steps.at(-1)?.tool ?? '无'}。下一步：${task?.next || '先读工作记忆再继续'}。`,
      });
      await this.deps.store.saveNow(threadId);
    }

    await this.locks.load();
    if (this.locks.droppedOnLoad > 0) {
      this.emitNotice(null, {
        tone: 'warn',
        title: `${this.locks.droppedOnLoad} stale lock${this.locks.droppedOnLoad === 1 ? '' : 's'} released`,
        body: 'A previous run crashed while holding a lease. Its targets will be re-read before the next write instead of being retried blindly.',
      });
    }
    await this.recoverInterrupted();
    await this.recoverWorktrees();
  }

  /**
   * The old store kept facts inside each thread's JSON. Move every live record
   * into `memory.md` once, so a user who upgrades does not lose their facts and
   * the new UI has something to show.
   */
  async migrateLegacyMemory(): Promise<void> {
    for (const thread of await this.deps.store.listThreads()) {
      const doc = await this.deps.store.load(thread.id);
      if (doc) await this.migrateDocMemory(doc);
    }
    await this.memory.saveIfDirty();
  }

  private async migrateDocMemory(doc: ThreadDoc): Promise<void> {
    if (doc.state.memory.length === 0) return;
    for (const record of doc.state.memory) this.memory.importLegacy(record, doc.thread.id, doc.thread.cwd);
    doc.state.memory = [];
    await this.memory.saveIfDirty();
    void this.memory.ensureVectors().catch(() => undefined);
    await this.deps.store.saveNow(doc.thread.id);
  }

  /** A deleted session takes its short-term file and progress section with it. */
  async purgeSessionMemory(threadId: string): Promise<void> {
    const stm = this.sessions.get(threadId) ?? new ShortTermMemory(this.memory.root, threadId);
    this.sessions.delete(threadId);
    try {
      await stm.deleteFile();
    } catch {
      // Deleting a session must not fail because a memory file is unreadable.
    }
    try {
      await this.working.remove(threadId);
    } catch {
      // Same for the progress file.
    }
  }

  /**
   * The short-term file is the model's conversation window. It is seeded from
   * the transcript the first time a session is opened after this upgrade, and
   * rebuilt after a checkpoint revert.
   */
  private async shortTermFor(doc: ThreadDoc): Promise<ShortTermMemory> {
    const cached = this.sessions.get(doc.thread.id);
    if (cached) return cached;
    const stm = new ShortTermMemory(this.memory.root, doc.thread.id, {
      title: doc.thread.title,
      workspace: doc.thread.cwd,
    });
    await stm.load({ title: doc.thread.title, workspace: doc.thread.cwd, turnCount: doc.thread.turnCount }).catch(() => undefined);
    if (!stm.hasContent() && doc.items.length > 0) {
      if (stm.seedFromItems(doc.thread, doc.items, doc.state.context.summary)) {
        await stm.save().catch(() => undefined);
      }
    }
    this.sessions.set(doc.thread.id, stm);
    return stm;
  }

  /** A turn that was still running when the app quit stays `running` on disk. On
   * the next launch the composer then offers a stop button that nothing can
   * answer — there is no controller in this process — so the session looks
   * permanently busy. Settle every orphaned turn at boot instead.
   */
  private async recoverInterrupted(): Promise<void> {
    for (const thread of await this.deps.store.listThreads()) {
      if (this.running.has(thread.id)) continue;
      const doc = await this.deps.store.load(thread.id);
      if (!doc) continue;
      const orphaned = doc.turn?.status === 'running' || doc.thread.status === 'running';
      if (!orphaned) continue;
      this.markInterrupted(
        doc,
        'interrupted by app shutdown',
        '上一轮已中断',
        '应用在这一轮结束前被关闭，未完成的步骤已标记为中断，会话恢复为空闲。',
      );
      await this.deps.store.saveNow(thread.id);
    }
  }

  /**
   * Return a session to idle when the turn that owned it lost its executor. Used
   * both by boot recovery and by a stop click on a session this process is not
   * actually running.
   */
  private markInterrupted(
    doc: ThreadDoc,
    stopReason: string,
    title: string,
    body: string,
    tone: 'warn' | 'stopped' = 'warn',
  ): void {
    const threadId = doc.thread.id;
    for (const [id, pending] of this.questions) {
      if (pending.threadId === threadId) {
        pending.resolve({ answer: '', cancelled: true });
        this.questions.delete(id);
      }
    }
    if (doc.turn) {
      doc.turn.status = 'cancelled';
      doc.turn.endedAt = Date.now();
      doc.turn.stopReason = stopReason;
    }
    for (const item of doc.items) {
      if (item.status !== 'running') continue;
      item.status = 'cancelled';
      this.emitItem(item);
    }
    this.deps.store.closeOpenToolCalls(doc);
    doc.thread.status = 'idle';
    this.emitNotice(threadId, { tone, title, body });
    if (doc.turn) this.deps.emit({ type: 'turn/updated', turn: doc.turn });
    this.emitThread(doc.thread);
    this.deps.emit({
      type: 'runtime/updated',
      runtime: this.status(threadId, 'idle', stopReason),
      context: this.gauge(doc),
    });
  }

  /**
   * `turn/cancel` for a turn this process does not own: a session restored from a
   * run that was killed, or a click that arrives after the loop already exited.
   * Stopping must still settle the UI instead of silently doing nothing.
   */
  private async abandonStaleTurn(threadId: string): Promise<boolean> {
    if (this.running.has(threadId)) return false;
    const doc = this.deps.store.docs.get(threadId) ?? (await this.deps.store.load(threadId));
    if (!doc) return false;
    if (doc.turn?.status !== 'running' && doc.thread.status !== 'running') return false;
    this.markInterrupted(
      doc,
      'stopped by the user',
      '本轮已停止',
      '这一轮已经不在运行，已停止并恢复为空闲。已经完成的内容和改动都保留。',
      'stopped',
    );
    await this.deps.store.saveNow(threadId);
    return true;
  }

  status(threadId: string | null, phase: RuntimeStatus['phase'], detail = ''): RuntimeStatus {
    const doc = threadId ? this.deps.store.docs.get(threadId) : undefined;
    return {
      threadId,
      turnId: doc?.turn?.id ?? null,
      phase,
      detail,
      adapters: { llm: true, shell: true, editor: true },
    };
  }

  private emitThread(thread: Thread): void {
    this.deps.emit({ type: 'thread/updated', thread });
  }

  private emitItem(item: Item): void {
    this.deps.emit({ type: 'item/upsert', item });
  }

  private emitNotice(threadId: string | null, notice: { tone: NoticeItem['tone']; title: string; body: string }): void {
    if (!threadId) return;
    const doc = this.deps.store.docs.get(threadId);
    if (!doc) return;
    const item: NoticeItem = {
      id: uid('itm'),
      threadId,
      turnId: doc.turn?.id ?? 'system',
      kind: 'notice',
      at: Date.now(),
      status: 'done',
      tone: notice.tone,
      title: notice.title,
      body: notice.body,
    };
    doc.items.push(item);
    this.emitItem(item);
  }

  isRunning(threadId: string): boolean {
    return this.running.has(threadId);
  }

  async cancel(threadId: string): Promise<boolean> {
    const controller = this.controllers.get(threadId);
    if (!controller) return this.abandonStaleTurn(threadId);
    controller.abort();
    const doc = this.deps.store.docs.get(threadId) ?? (await this.deps.store.load(threadId));
    for (const [id, pending] of this.approvals) {
      if (pending.request.threadId !== threadId) continue;
      pending.resolve('deny');
      this.approvals.delete(id);
      const approval = doc?.items.find((item): item is ApprovalItem => item.kind === 'approval' && item.id === id);
      if (approval) {
        approval.decision = 'deny';
        approval.status = 'cancelled';
        this.emitItem(approval);
      }
    }
    for (const [id, pending] of this.questions) {
      if (pending.threadId !== threadId) continue;
      pending.resolve({ answer: '', cancelled: true });
      this.questions.delete(id);
      const question = doc?.items.find((item): item is QuestionItem => item.kind === 'question' && item.id === id);
      if (question && question.status === 'running') {
        question.status = 'cancelled';
        this.emitItem(question);
      }
    }
    if (doc) {
      // A stop must settle every visible "running" row immediately; the loop's
      // own cleanup follows, but the UI must not keep claiming a tool is live.
      for (const item of doc.items) {
        if (item.threadId !== threadId || item.status !== 'running') continue;
        if (item.kind === 'tool_call' || item.kind === 'approval' || item.kind === 'question') {
          item.status = 'cancelled';
          this.emitItem(item);
        }
      }
      if (doc.thread.status === 'waiting_approval') {
        doc.thread.status = 'running';
        this.emitThread(doc.thread);
      }
    }
    return true;
  }

  respondApproval(approvalId: string, decision: ApprovalDecision): boolean {
    const pending = this.approvals.get(approvalId);
    if (!pending) return false;
    this.approvals.delete(approvalId);
    pending.resolve(decision);
    const doc = this.deps.store['docs'].get(pending.request.threadId);
    if (doc) {
      const approval = doc.items.find((item): item is ApprovalItem => item.kind === 'approval' && item.id === approvalId);
      if (approval) {
        approval.decision = decision;
        approval.status = 'done';
        this.emitItem(approval);
      }
    }
    return true;
  }

  /** Answer a pending clarification question; the waiting tool call then resumes. */
  respondQuestion(questionId: string, answer: string): boolean {
    const pending = this.questions.get(questionId);
    if (!pending) return false;
    const text = answer.trim().slice(0, 2000);
    if (!text) return false;
    this.questions.delete(questionId);
    pending.resolve({ answer: text, cancelled: false });
    return true;
  }

  async startTurn(threadId: string, prompt: string, attachments: string[] = []): Promise<Turn> {
    const doc = await this.deps.store.load(threadId);
    if (!doc) throw new Error(`unknown thread ${threadId}`);
    if (this.running.has(threadId)) throw new Error('a turn is already running in this session');
    if (!doc.thread.cwd) throw new Error('请选择工作区后再发送');
    await this.migrateDocMemory(doc).catch(() => undefined);

    const turn: Turn = {
      id: uid('trn'),
      threadId,
      index: doc.thread.turnCount + 1,
      prompt,
      status: 'running',
      startedAt: Date.now(),
      step: 0,
    };
    doc.turn = turn;
    doc.thread.turnCount += 1;
    doc.thread.status = 'running';
    doc.thread.lastPrompt = prompt;
    doc.thread.title = doc.thread.turnCount === 1 ? prompt.slice(0, 48) || 'New session' : doc.thread.title;
    this.deps.store.save(threadId);
    this.emitThread(doc.thread);
    this.deps.emit({ type: 'turn/updated', turn });

    // Concurrency notice is emitted by setupIsolation inside runTurn, where it
    // knows whether the session got an isolated worktree or fell back to CAS.
    void this.runTurn(doc, turn, prompt, attachments);
    return turn;
  }

  /** Resolve @-referenced files: inside the workspace only, bounded in size. */
  private async readReferences(cwd: string, files: string[]): Promise<Array<{ path: string; content: string }>> {
    const references: Array<{ path: string; content: string }> = [];
    for (const file of files.slice(0, 5)) {
      try {
        const full = resolveInside(cwd, file);
        const buffer = await readFile(full);
        const binary = buffer.subarray(0, 4096).includes(0) || /\.(png|jpe?g|gif|webp|bmp|pdf|zip|exe|dll|ico)$/i.test(file);
        references.push({
          path: file,
          content: binary ? `[binary attachment, ${buffer.length} bytes]` : truncate(buffer.toString('utf8'), 60_000),
        });
      } catch {
        // missing or outside the workspace: skip silently, the model can ask
      }
    }
    return references;
  }

  private async runTurn(doc: ThreadDoc, turn: Turn, prompt: string, attachments: string[] = []): Promise<void> {
    const threadId = doc.thread.id;
    this.running.add(threadId);
    this.runningCwd.set(threadId, normalizeWorkspace(doc.thread.cwd));
    const controller = new AbortController();
    this.controllers.set(threadId, controller);

    const push = <T extends Item>(item: T): T => {
      doc.items.push(item);
      this.emitItem(item);
      return item;
    };

    try {
      // 0. Without a configured model there is nothing to call; fail early with
      // a pointer to Settings instead of sending a broken request.
      const model = this.deps.store.activeModel();
      if (!model) {
        throw new LlmError('还没有可用的模型', 0, false, '打开设置 → 模型，添加一个模型后再发送。');
      }

      // 0.5 Isolation: when another session already runs in this workspace, this
      // turn works in its own git worktree. Tools and checkpoints
      // follow the effective tree, so the existing safety layers apply unchanged.
      const effectiveWorkspace = await this.setupIsolation(doc, turn);
      this.trees.set(threadId, effectiveWorkspace);
      const worktree = doc.state.worktree;
      const isolationNote =
        worktree && worktree.status !== 'merged' && normalizeWorkspace(effectiveWorkspace) === normalizeWorkspace(worktree.path)
          ? `Isolation: this turn runs in a private git worktree at ${worktree.path} (branch ${worktree.branch}); the main checkout is ${doc.thread.cwd}. Relative paths resolve against the worktree. At turn end your changes are committed and merged back into the main checkout, gated on the project's typecheck; conflicts are surfaced, never overwritten.${worktree.conflicted?.length ? ` A pending merge left conflict markers in: ${worktree.conflicted.join(', ')}. Resolve them in the worktree, keeping both sides' intent, then finish the turn — the turn-end commit completes the merge.` : ''}`
          : undefined;

      // Long-term maintenance is time-based, not turn-based: at most one pass
      // every six hours, and the user is told when something was archived.
      const maintenance = await this.memory.maintain().catch(() => null);
      if (maintenance && (maintenance.decayed > 0 || maintenance.archived > 0)) {
        this.deps.emit({ type: 'memory/updated', threadId, facts: memoryFacts(this.memory.all()) });
      }
      if (maintenance && maintenance.archived > 0) {
        push<NoticeItem>({
          id: uid('itm'),
          threadId,
          turnId: turn.id,
          kind: 'notice',
          at: Date.now(),
          status: 'done',
          tone: 'info',
          title: `长期记忆已归档 ${maintenance.archived} 条`,
          body: '这些记忆长时间没有被召回，按遗忘曲线衰减后移入 memory-archive.md；再次被明确召回时会自动唤醒。',
        });
      }

      // 1. Contract: freeze goal, acceptance, non-goals and forbidden actions.
      if (!doc.state.contract) {
        doc.state.contract = buildContract(prompt);
        const item = push<NoticeItem>({
          id: uid('itm'),
          threadId,
          turnId: turn.id,
          kind: 'notice',
          at: Date.now(),
          status: 'done',
          tone: 'info',
          title: '任务契约已写入',
          body: `目标：${doc.state.contract.goal}\n验收：${doc.state.contract.acceptance.join(' · ')}`,
        });
        this.emitItem(item);
      }

      // 2. Resolution: entities, relative times, event anchors.
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      const time = parseRelativeTime(prompt, new Date(), timezone);
      const events = extractEvents(prompt, new Date(), timezone, 'user_message');
      const entities = resolveEntities(prompt, this.memory.all());
      doc.state.resolution = mergeResolution(doc.state.resolution, {
        times: time ? [time] : [],
        events,
        entities: entities.matched,
      });
      if (time && time.confidence === 'low') {
        push<NoticeItem>({
          id: uid('itm'),
          threadId,
          turnId: turn.id,
          kind: 'notice',
          at: Date.now(),
          status: 'done',
          tone: 'warn',
          title: '相对时间按推测归一化了',
          body: `“${time.phrase}”没有给具体钟点，按 ${time.fromIso} … ${time.toIso} 处理。若是别的时间窗，直接说。`,
        });
      }

      // Short-term memory is the model-visible conversation window; working
      // memory is the live task notebook injected into the system prompt.
      const shortTerm = await this.shortTermFor(doc);
      await this.working
        .startTask({
          threadId,
          title: doc.thread.title,
          cwd: effectiveWorkspace,
          goal: doc.state.contract?.goal ?? prompt,
        })
        .catch(() => undefined);

      const references = await this.readReferences(doc.thread.cwd, attachments);
      const userItem: MessageItem = {
        id: uid('itm'),
        threadId,
        turnId: turn.id,
        kind: 'message',
        at: Date.now(),
        status: 'done',
        role: 'user',
        text: prompt,
        ...(references.length > 0 ? { references } : {}),
      };
      push(userItem);

      let assistant: MessageItem | null = null;
      let step = 0;
      let stopReason = 'model finished';
      let lastFinishReason = '';
      let trimmedNotice = false;

      while (true) {
        step += 1;
        turn.step = step;
        doc.thread.steps += 1;
        if (controller.signal.aborted) {
          stopReason = 'cancelled by the user';
          break;
        }

        // 3. Context assembly: short-term memory (summary + last rounds) plus
        // this turn's live trace. Long-term memory stays behind memory_read.
        // The history budget is derived from the model window, its output cap,
        // the system/tool template and a safety margin — not a fixed ratio.
        const thinking = doc.state.context.thinking === true;
        const toolList = tools
          .map((tool) => `- ${tool.name} (${tool.risk}) — ${tool.summary} Use when: ${tool.useWhen} Do NOT use: ${tool.avoidWhen}`)
          .join('\n');
        const verification = await this.verification(doc);
        const planText = doc.state.plan.map((entry) => `- [${entry.status}] ${entry.title}`).join('\n');
        const provisional = buildSystemPrompt({
          workspace: effectiveWorkspace,
          contract: doc.state.contract,
          plan: planText,
          working: this.working.render(threadId),
          memoryIndex: this.memory.indexNote(),
          resolution: doc.state.resolution,
          verification,
          toolList,
          step,
          budget: 0,
          compacted: doc.state.context.compacted > 0,
          isolationNote,
        });
        const budget = contextBudget({
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          promptTokens: estimateTokens(provisional) + 256,
          toolTokens: estimateTokens(JSON.stringify(toolSpecs())),
        });

        let history = shortTerm.messages(thinking);
        let messages = [...history, ...this.currentTurnMessages(doc)];
        if (shouldCompressHistory(tokensOf(messages), budget.historyLimit) || shortTerm.shouldCompressByCount(doc.thread.turnCount)) {
          this.deps.emit({ type: 'runtime/updated', runtime: this.status(threadId, 'compacting', 'compressing older rounds'), context: this.gauge(doc) });
          const folded = await this.compressShortTerm(doc, turn, shortTerm);
          if (folded) {
            history = shortTerm.messages(thinking);
            messages = [...history, ...this.currentTurnMessages(doc)];
          }
          if (tokensOf(messages) > budget.historyLimit) {
            // A single turn can outgrow the window by itself. Keep every message
            // and the newest tool pairs; older pairs survive in working memory.
            const keep = Math.max(1024, budget.historyLimit - tokensOf(history));
            messages = [...history, ...this.currentTurnMessages(doc, keep)];
            if (!trimmedNotice) {
              trimmedNotice = true;
              this.emitNotice(threadId, {
                tone: 'warn',
                title: '本轮上下文超出预算，旧工具步骤已收起',
                body: '较早的工具调用与结果不再进入模型上下文，但每一步都还在工作记忆（progress.md）里，可以按需重读文件。',
              });
            }
          }
        }

        // 4. Milestone re-read of the verbatim requirement.
        const atMilestone = step > 1 && step % MILESTONE_EVERY === 0;
        if (atMilestone && doc.state.contract) {
          messages = [
            ...messages,
            {
              role: 'system',
              content: `Milestone re-read (step ${step}). The original requirement, verbatim:\n\n${doc.state.contract.sourcePrompt}\n\nNon-goals: ${doc.state.contract.nonGoals.join('; ') || 'none stated'}.\nForbidden: ${doc.state.contract.forbidden.join('; ') || 'none stated'}.`,
            },
          ];
        }

        const modelMessages: ChatMessage[] = [
          {
            role: 'system',
            content: buildSystemPrompt({
              workspace: effectiveWorkspace,
              contract: doc.state.contract,
              plan: planText,
              working: this.working.render(threadId),
              memoryIndex: this.memory.indexNote(),
              resolution: doc.state.resolution,
              verification,
              toolList,
              step,
              budget: budget.historyLimit,
              compacted: doc.state.context.compacted > 0,
              isolationNote,
            }),
          },
          ...messages,
        ];

        // 5. Model call, streamed into one assistant item.
        this.deps.emit({ type: 'runtime/updated', runtime: this.status(threadId, 'thinking', `第 ${step} 步 · 调用 ${model.model}`), context: this.gauge(doc) });
        const assistantItem: MessageItem = {
          id: uid('itm'),
          threadId,
          turnId: turn.id,
          kind: 'message',
          at: Date.now(),
          status: 'running',
          role: 'assistant',
          text: '',
        };
        push(assistantItem);
        assistant = assistantItem;

        let lastEmit = 0;
        // The provider pushes tokens far faster than the eye needs, but a 90ms
        // window made the reply land in 15–25 character blocks — visibly
        // "paragraph by paragraph" in Chinese. 30ms (~33fps) keeps the IPC
        // traffic bounded while every frame only advances a few characters.
        const STREAM_EMIT_MS = 16;
        const result = await complete(model, modelMessages, {
          tools: toolSpecs(),
          signal: controller.signal,
          hooks: {
            onText: (delta) => {
              assistantItem.text += delta;
              const now = Date.now();
              if (now - lastEmit >= STREAM_EMIT_MS) {
                lastEmit = now;
                this.emitItem(assistantItem);
              }
            },
            onReasoning: (delta) => {
              if (!delta.trim()) return;
              doc.state.context.tokensUsed += estimateTokens(delta);
            },
          },
        });
        lastFinishReason = result.finishReason;
        assistantItem.status = 'done';
        if (result.reasoning.trim()) assistantItem.reasoning = result.reasoning;
        if (result.reasoning.trim()) doc.state.context.thinking = true;
        this.emitItem(assistantItem);
        doc.thread.totalTokens += result.usage.promptTokens + result.usage.completionTokens;
        {
          const now = new Date();
          const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
          this.deps.store.addTokens(day, result.usage.promptTokens + result.usage.completionTokens);
        }

        if (result.reasoning.trim()) {
          push({
            id: uid('itm'),
            threadId,
            turnId: turn.id,
            kind: 'reasoning',
            at: Date.now(),
            status: 'done',
            text: truncate(result.reasoning.trim(), 1200),
          });
        }

        if (result.toolCalls.length === 0) {
          // Evidence audit: claims about files nobody read.
          const missing = auditClaims(assistantItem.text, doc.state.evidence);
          if (missing.length > 0) {
            push<NoticeItem>({
              id: uid('itm'),
              threadId,
              turnId: turn.id,
              kind: 'notice',
              at: Date.now(),
              status: 'done',
              tone: 'warn',
              title: '回答提到了没有读过的文件',
              body: `${missing.join(', ')} — 没有任何 read_file、grep_text 或 glob_files 的结果覆盖它们。核实之后再引用。`,
            });
          }
          break;
        }

        // 6. Tool execution. Consecutive read-only calls run together; anything that
        // mutates, or blocks on the user, keeps its strict order.
        {
          const calls = result.toolCalls;
          let cursor = 0;
          while (cursor < calls.length) {
            if (controller.signal.aborted) {
              stopReason = 'cancelled by the user';
              break;
            }
            if (PARALLEL_READ_TOOLS.has(calls[cursor].function.name)) {
              const group: ToolCall[] = [];
              while (
                cursor < calls.length &&
                group.length < MAX_PARALLEL_READS &&
                PARALLEL_READ_TOOLS.has(calls[cursor].function.name)
              ) {
                group.push(calls[cursor]);
                cursor += 1;
              }
              await this.executeToolGroup(doc, turn, group, step, result.reasoning, controller.signal);
              for (const call of group) await this.logToolStep(doc, turn, step, call, result.reasoning);
            } else {
              const call = calls[cursor];
              await this.executeTool(doc, turn, call, step, result.reasoning, controller.signal);
              await this.logToolStep(doc, turn, step, call, result.reasoning);
              cursor += 1;
            }
          }
        }
        await this.deps.store.save(threadId);
        this.emitThread(doc.thread);
        if (controller.signal.aborted) {
          stopReason = 'cancelled by the user';
          break;
        }
      }

      // The model decides when it is done: the turn ends only when it stops
      // calling tools (or the user stops it). No step or time cap intervenes.
      const aborted = controller.signal.aborted;
      if (aborted) {
        // A user stop can unwind through the normal loop (no exception): settle
        // any open rows and leave the same neutral notice as the catch path.
        this.closeRunningToolCalls(doc, turn, 'stopped by the user', true);
        this.emitNotice(threadId, {
          tone: 'stopped',
          title: '本轮已停止',
          body: '你手动停止了这一轮，已经完成的内容和改动都保留。',
        });
      } else if (!assistant || assistant.text.trim().length === 0) {
        const truncated = lastFinishReason === 'length';
        const outputCap =
          model.maxOutputTokens > 0
            ? `${Math.round(model.maxOutputTokens / 1024)}K（max_tokens）`
            : '供应商默认的 max_tokens';
        this.emitNotice(threadId, {
          tone: 'warn',
          title: truncated ? '输出被截断' : '模型没有返回正文',
          body: truncated
            ? `本次请求的输出上限是 ${outputCap}，思考占满了这个预算，没有留下正文。点开输入框右下角的模型菜单，在「当前模型设置」里把输出上限调大（以供应商支持为准），或把推理等级调低后再试。`
            : '本轮已结束，但没有生成最终答案。可以继续发一条消息让它总结。',
        });
      }

      turn.status = aborted ? 'cancelled' : 'completed';
      turn.endedAt = Date.now();
      turn.stopReason = stopReason;
      doc.thread.status = 'idle';
      this.deps.emit({ type: 'turn/updated', turn });
      this.emitThread(doc.thread);
      this.deps.emit({
        type: 'runtime/updated',
        runtime: this.status(threadId, 'idle', `耗时 ${formatDuration(turn.endedAt - turn.startedAt)} · ${step} 步`),
        context: this.gauge(doc),
      });
    } catch (error) {
      // Nothing may stay "running" after the loop dies, or the transcript lies
      // about a step that never finished. A user stop is not a failure.
      const aborted = controller.signal.aborted;
      const message = aborted
        ? '你手动停止了这一轮，已经完成的内容和改动都保留。'
        : error instanceof LlmError
          ? `${error.message} — ${error.hint}`
          : (error as Error).message;
      this.closeRunningToolCalls(doc, turn, message, aborted);
      for (const item of doc.items) {
        if (item.status === 'running') {
          item.status = aborted ? 'cancelled' : 'error';
          this.emitItem(item);
        }
      }
      turn.status = aborted ? 'cancelled' : 'failed';
      turn.endedAt = Date.now();
      turn.stopReason = aborted ? 'stopped by the user' : message;
      doc.thread.status = aborted ? 'idle' : 'failed';
      this.emitNotice(doc.thread.id, {
        tone: aborted ? 'stopped' : 'error',
        title: aborted ? '本轮已停止' : '本轮失败',
        body: message,
      });
      this.deps.emit({ type: 'turn/updated', turn });
      this.emitThread(doc.thread);
      this.deps.emit({
        type: 'runtime/updated',
        runtime: this.status(threadId, aborted ? 'idle' : 'error', aborted ? '已停止' : message),
        context: this.gauge(doc),
      });
    } finally {
      try {
        await this.locks.releaseAll(`thread:${threadId}`);
        // Measure before the round is appended to short-term memory; afterwards
        // the same round would be counted twice (history + current transcript).
        const finalGauge = this.gauge(doc);
        try {
          await this.commitRound(doc, turn);
        } catch {
          // Memory persistence is best-effort here: a disk failure must not
          // leave the session marked as running. The transcript is saved below.
        }
        doc.state.context.tokensUsed = finalGauge.tokensUsed;
        await this.deps.store.saveNow(threadId);
      } finally {
        // Release tree occupancy before settling merges so they see the main
        // tree as free, but keep `running` set until everything is on disk:
        // callers (and tests) use it as the signal the session is fully settled.
        this.runningCwd.delete(threadId);
        this.trees.delete(threadId);
        try {
          const state = doc.state.worktree;
          if (state && state.status === 'active') await this.finalizeWorktree(doc, turn, state);
          await this.drainPendingMerges(doc.thread.cwd, threadId);
          await this.deps.store.saveNow(threadId);
        } catch {
          // Merge bookkeeping must never mask the turn's own outcome.
        }
        this.controllers.delete(threadId);
        this.running.delete(threadId);
      }
    }
  }

  private gauge(doc: ThreadDoc): ContextGauge {
    const stm = this.sessions.get(doc.thread.id);
    const history = stm?.messages(doc.state.context.thinking === true) ?? [];
    const messages = [...history, ...this.currentTurnMessages(doc)];
    return gaugeOf({
      messages,
      budget: this.deps.store.activeModel()?.contextWindow || DEFAULT_CONTEXT_WINDOW,
      compacted: doc.state.context.compacted,
      memoryFacts: this.memory.activeCount(),
      evidence: doc.state.evidence.length,
      toolCalls: doc.items.filter((item) => item.kind === 'tool_call').length,
    });
  }

  /**
   * Messages for the turn in progress only. Past rounds come from short-term
   * memory, so `doc.items` (the UI transcript, which can be long) is never sent
   * wholesale.
   */
  private currentTurnMessages(doc: ThreadDoc, maxTokens?: number): ChatMessage[] {
    const turnId = doc.turn?.id;
    let items = turnId ? doc.items.filter((item) => item.turnId === turnId) : doc.items;
    const thinking = doc.state.context.thinking === true;
    if (maxTokens !== undefined && maxTokens > 0) {
      const full = toMessages(items, '', thinking);
      if (tokensOf(full) > maxTokens) items = this.trimToolPairs(items, maxTokens, thinking);
    }
    return toMessages(items, '', thinking);
  }

  /**
   * Keep every user/assistant message and the newest tool call/result pairs.
   * A dropped pair is dropped whole, because an orphaned tool call breaks the
   * OpenAI message contract; the step still exists in working memory.
   */
  private trimToolPairs(items: Item[], maxTokens: number, thinking: boolean): Item[] {
    const messageTokens = tokensOf(toMessages(items.filter((item) => item.kind === 'message'), '', thinking));
    const allowed = new Set<string>();
    let remaining = Math.max(512, maxTokens - messageTokens);
    const calls = items.filter((item): item is ToolCallItem => item.kind === 'tool_call');
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      const call = calls[index];
      const result = items.find((item): item is ToolResultItem => item.kind === 'tool_result' && item.callId === call.callId);
      const cost = estimateTokens(JSON.stringify(call.args)) + (result ? estimateTokens(result.output) : 0) + 24;
      if (allowed.size > 0 && remaining - cost < 0) break;
      allowed.add(call.callId);
      remaining -= cost;
    }
    return items.filter((item) => {
      if (item.kind === 'message') return true;
      if (item.kind === 'tool_call' || item.kind === 'tool_result') return allowed.has(item.callId);
      return true;
    });
  }

  /** Fold older rounds into the short-term summary; emits one visible compaction card. */
  private async compressShortTerm(doc: ThreadDoc, turn: Turn, stm: ShortTermMemory): Promise<boolean> {
    const thinking = doc.state.context.thinking === true;
    const before = tokensOf(stm.messages(thinking));
    const result = await stm.compress((folded, previous) => this.summarizeRounds(folded, previous));
    if (!result) return false;
    await stm.save().catch(() => undefined);
    doc.state.context.summary = stm.summary;
    doc.state.context.compacted = stm.compressed;
    const after = tokensOf(stm.messages(thinking));
    const compaction: CompactionItem = {
      id: uid('itm'),
      threadId: doc.thread.id,
      turnId: turn.id,
      kind: 'compaction',
      at: Date.now(),
      status: 'done',
      tokensBefore: before,
      tokensAfter: after,
      foldedItems: result.folded,
      keptItems: result.kept,
      summary: stm.summary,
    };
    doc.items.push(compaction);
    this.emitItem(compaction);
    return true;
  }

  private async summarizeRounds(folded: readonly RoundRecord[], previous: string): Promise<string> {
    const active = this.deps.store.activeModel();
    if (!active) return mechanicalRoundSummary(folded);
    const transcript = folded
      .map((round) => {
        const tools = round.tools.map((tool) => `- ${tool.name} · ${tool.ok ? 'ok' : 'failed'} · ${tool.summary}`).join('\n');
        return `第 ${round.index} 轮（${stamp(round.at)}）\n用户：${round.prompt}\n工具步骤：\n${tools || '（无）'}\n助手：${round.assistant || '（无正文）'}\n下一步：${round.next || '未记录'}`;
      })
      .join('\n\n');
    try {
      const response = await complete(
        active,
        [
          { role: 'system', content: SHORT_TERM_SUMMARY_PROMPT },
          { role: 'user', content: `${previous ? `已有摘要：\n${previous}\n\n` : ''}需要压缩的轮次：\n${transcript}` },
        ],
        { tools: [], retries: 0 },
      );
      const text = response.content.trim();
      return text || mechanicalRoundSummary(folded);
    } catch {
      return mechanicalRoundSummary(folded);
    }
  }

  /**
   * Close the turn's books: append the round to short-term memory, sync the
   * visible context counters, and leave working memory with a concrete next step
   * so an interruption is resumable.
   */
  private async commitRound(doc: ThreadDoc, turn: Turn): Promise<void> {
    const threadId = doc.thread.id;
    const stm = await this.shortTermFor(doc);
    const items = doc.items.filter((item) => item.turnId === turn.id);
    const user = items.find((item): item is MessageItem => item.kind === 'message' && item.role === 'user');
    const assistants = items.filter(
      (item): item is MessageItem => item.kind === 'message' && item.role === 'assistant' && item.text.trim().length > 0,
    );
    const results = new Map(
      items.filter((item): item is ToolResultItem => item.kind === 'tool_result').map((item) => [item.callId, item]),
    );
    const tools = items
      .filter((item): item is ToolCallItem => item.kind === 'tool_call')
      .map((call) => {
        const result = results.get(call.callId);
        return {
          name: call.name,
          summary: result?.summary ?? call.summary,
          ok: result?.ok !== false,
        };
      });
    const outcome: RoundRecord['outcome'] =
      turn.status === 'completed' ? 'completed' : turn.status === 'cancelled' ? 'cancelled' : 'failed';
    const pending = doc.state.plan.find((entry) => entry.status === 'active') ?? doc.state.plan.find((entry) => entry.status === 'pending');
    const wroteMemory = tools.some((tool) => tool.name === 'memory_write' && tool.ok);
    const next =
      turn.status === 'completed'
        ? pending
          ? `继续计划：${pending.title}`
          : wroteMemory
            ? '本轮计划已走完，长期记忆已写入。'
            : '本轮计划已走完；如果任务/工程整体完成，用 memory_write 写入长期记忆。'
        : turn.status === 'cancelled'
          ? '本轮被用户停止；下一轮先读工作记忆，问用户是否从「下一步」继续。'
          : '本轮失败；下一轮先读工作记忆和错误信息，修复后再继续。';
    stm.recordRound(
      {
        index: turn.index,
        at: turn.startedAt,
        prompt: user?.text ?? turn.prompt,
        assistant: assistants.at(-1)?.text ?? '',
        tools,
        outcome,
        next,
      },
      doc.thread.turnCount,
    );
    await stm.save();
    doc.state.context.summary = stm.summary;
    doc.state.context.compacted = stm.compressed;

    await this.working
      .recordStep({
        threadId,
        turn: turn.index,
        step: turn.step,
        tool: 'turn_end',
        detail: `第 ${turn.index} 轮结束`,
        intent: '收起本轮，写下可续接的下一步',
        result: truncate(assistants.at(-1)?.text ?? outcome, 300),
        ok: outcome === 'completed',
        next,
      })
      .catch(() => undefined);
    await this.working.finish({
      threadId,
      status:
        turn.status === 'completed'
          ? pending
            ? 'paused'
            : 'done'
          : turn.status === 'cancelled'
            ? 'interrupted'
            : 'failed',
      next,
    });
  }

  /** Ground-truth verification: what actually changed on disk, not what the model said. */
  private async verification(doc: ThreadDoc): Promise<string> {
    const lines: string[] = [];
    const task = this.working.get(doc.thread.id);
    const writeSteps = (task?.steps ?? []).filter((step) => step.target && step.phase === 'done' && step.ok);
    if (writeSteps.length > 0) {
      lines.push(`${writeSteps.length} write steps committed; last: ${writeSteps.at(-1)?.detail ?? ''}`);
    }
    const shellResults = doc.items.filter((item): item is ToolResultItem => item.kind === 'tool_result' && item.name === 'run_shell');
    for (const result of shellResults.slice(-2)) {
      lines.push(`last shell: ${result.summary} (${result.ok ? 'green' : 'red'})`);
    }
    const latest = doc.snapshots.at(-1);
    if (latest) {
      lines.push(`checkpoint ${latest.id} holds ${latest.files.length} files, ${Math.round(latest.sizeBytes / 1024)} KB`);
    }
    const audited = audits(doc, task);
    lines.push(...audited);
    return lines.join('\n');
  }

  private prepareCall(
    doc: ThreadDoc,
    turn: Turn,
    call: ToolCall,
    step: number,
    reasoning: string | undefined,
    signal: AbortSignal,
  ): PreparedCall | null {
    const threadId = doc.thread.id;
    const tool = toolByName.get(call.function.name);
    const callItem: ToolCallItem = {
      id: uid('itm'),
      threadId,
      turnId: turn.id,
      kind: 'tool_call',
      at: Date.now(),
      status: 'running',
      callId: call.id,
      name: call.function.name,
      args: {},
      summary: '',
      risk: (tool?.risk ?? 'read') as ToolCallItem['risk'],
      ...(reasoning && reasoning.trim() ? { reasoning } : {}),
    };
    doc.items.push(callItem);
    this.emitItem(callItem);

    // Hallucinated tool name: feed back the legal list, not every schema.
    if (!tool) {
      const legal = tools.map((entry) => `${entry.name} — ${entry.summary}`).join('\n');
      const failure: ToolFailure = {
        ok: false,
        layer: 'L3-domain',
        summary: `unknown tool "${call.function.name}"`,
        detail: 'The tool does not exist in this session.',
        hint: `Call one of these instead:\n${legal}`,
        retryable: true,
      };
      callItem.status = 'error';
      callItem.summary = failure.summary;
      this.emitItem(callItem);
      this.pushResult(doc, turn, call, failure, 0, undefined);
      return null;
    }

    const parsed = parseArguments(tool.name, call.function.arguments);
    if (!parsed.ok) {
      callItem.status = 'error';
      callItem.summary = parsed.summary;
      this.emitItem(callItem);
      this.pushResult(doc, turn, call, parsed, 0, undefined);
      return null;
    }

    callItem.args = parsed.args;
    callItem.summary = summarizeCall(tool, parsed.args);
    this.emitItem(callItem);

    return {
      tool,
      args: parsed.args,
      callItem,
      context: this.toolContext(doc, turn, step, signal),
      schemaRetries: schemaRetriesLeft(this.ledger, call.id),
    };
  }

  private finishCall(
    doc: ThreadDoc,
    turn: Turn,
    call: ToolCall,
    prepared: PreparedCall,
    outcome: Awaited<ReturnType<ToolDefinition['run']>>,
    durationMs: number,
    signal: AbortSignal,
  ): void {
    const { tool, callItem, schemaRetries } = prepared;

    if (signal.aborted) {
      callItem.status = 'cancelled';
      callItem.summary = '已停止';
      this.emitItem(callItem);
      this.pushResult(
        doc,
        turn,
        call,
        { ok: false, layer: 'none', summary: '已停止', detail: '用户停止了本轮。', hint: '', retryable: false },
        durationMs,
        tool,
        'cancelled',
      );
      return;
    }

    if (!outcome.ok && outcome.layer === 'L2-schema') {
      noteAttempt(this.ledger, call.id);
      if (schemaRetries === 0) {
        callItem.status = 'error';
        callItem.summary = `${outcome.summary} · retry budget exhausted`;
        this.emitItem(callItem);
        this.pushResult(doc, turn, call, { ...outcome, hint: `${outcome.hint}\n\nThe schema retry budget is exhausted. Ask the user or switch tools.` }, durationMs, undefined);
        return;
      }
    }

    callItem.status = outcome.ok ? 'done' : 'error';
    if (!outcome.ok) callItem.summary = outcome.summary;
    this.emitItem(callItem);
    this.pushResult(doc, turn, call, outcome, durationMs, tool);
  }

  private async executeTool(doc: ThreadDoc, turn: Turn, call: ToolCall, step: number, reasoning: string | undefined, signal: AbortSignal): Promise<void> {
    const prepared = this.prepareCall(doc, turn, call, step, reasoning, signal);
    if (!prepared) return;
    const started = Date.now();
    const outcome = await this.invoke(doc, turn, prepared.tool, prepared.args, prepared.context, call.id);
    this.finishCall(doc, turn, call, prepared, outcome, Date.now() - started, signal);
    await this.deps.store.save(doc.thread.id);
  }

  /**
   * Run a batch of read-only calls together. Items are still created in call
   * order before any of them runs, so the transcript reads the same as a serial
   * run; results are finalized in order too, even if they finish out of order.
   */
  private async executeToolGroup(
    doc: ThreadDoc,
    turn: Turn,
    calls: ToolCall[],
    step: number,
    reasoning: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const prepared: Array<{ call: ToolCall; prep: PreparedCall }> = [];
    for (const call of calls) {
      const prep = this.prepareCall(doc, turn, call, step, reasoning, signal);
      if (prep) prepared.push({ call, prep });
    }
    if (prepared.length === 0) return;

    const settled = await Promise.all(
      prepared.map(async ({ call, prep }) => {
        const started = Date.now();
        const outcome = await this.invoke(doc, turn, prep.tool, prep.args, prep.context, call.id).catch(
          (error: Error): ToolFailure => ({
            ok: false,
            layer: 'transient',
            summary: 'tool threw',
            detail: error.message,
            hint: 'Retry once; if it throws again the environment is at fault.',
            retryable: true,
          }),
        );
        return { call, prep, outcome, durationMs: Date.now() - started };
      }),
    );

    for (const entry of settled) {
      this.finishCall(doc, turn, entry.call, entry.prep, entry.outcome, entry.durationMs, signal);
    }
    await this.deps.store.save(doc.thread.id);
  }

  /**
   * One line per executed tool in working memory: which tool, why, what came
   * back, and what should happen next. Written immediately so an interrupted
   * turn is resumable step by step.
   */
  private async logToolStep(doc: ThreadDoc, turn: Turn, step: number, call: ToolCall, reasoning?: string): Promise<void> {
    const callItem = [...doc.items]
      .reverse()
      .find((item): item is ToolCallItem => item.kind === 'tool_call' && item.callId === call.id);
    const resultItem = [...doc.items]
      .reverse()
      .find((item): item is ToolResultItem => item.kind === 'tool_result' && item.callId === call.id);
    const name = callItem?.name ?? call.function.name;
    const args = callItem?.args ?? {};
    const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : '';
    const intent =
      purpose ||
      (reasoning?.trim() ? truncate(reasoning.trim().replace(/\s+/g, ' '), 300) : '') ||
      whyForTool(name, args) ||
      toolByName.get(name)?.useWhen ||
      '继续当前步骤';
    try {
      await this.working.recordStep({
        threadId: doc.thread.id,
        turn: turn.index,
        step,
        tool: name,
        callId: call.id,
        detail: callItem?.summary ?? '',
        intent,
        result: resultItem?.summary ?? callItem?.summary ?? '没有返回结果',
        ok: resultItem?.ok === true,
        next: this.nextStep(doc),
      });
    } catch {
      // The progress file is a recovery aid; a write failure must not stop the turn.
    }
  }

  private nextStep(doc: ThreadDoc): string {
    const pending = doc.state.plan.find((entry) => entry.status === 'active') ?? doc.state.plan.find((entry) => entry.status === 'pending');
    return pending ? `继续计划：${pending.title}` : '继续当前任务';
  }

  private toolContext(doc: ThreadDoc, turn: Turn, step: number, signal: AbortSignal): ToolExecContext {
    const threadId = doc.thread.id;
    const workspace = this.trees.get(threadId) ?? doc.thread.cwd;
    return {
      threadId: doc.thread.id,
      turnId: turn.id,
      workspace,
      shell: (command, timeoutMs, cwd) =>
        new Promise((resolvePromise, rejectPromise) => {
          let settled = false;
          const finish = (fn: () => void): void => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', onAbort);
            fn();
          };
          const onAbort = (): void => {
            try {
              if (process.platform === 'win32') {
                exec(`taskkill /pid ${child.pid} /T /F`, () => undefined);
              } else {
                child.kill('SIGKILL');
              }
            } catch {
              // the process may already be gone
            }
            finish(() => rejectPromise(new Error('已中断')));
          };
          const child = exec(
            command,
            { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' },
            (error, stdout, stderr) => {
              if (error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
                finish(() => rejectPromise(new Error(`command timed out after ${timeoutMs}ms`)));
                return;
              }
              finish(() =>
                resolvePromise({ code: error ? (error.code as number) ?? 1 : 0, stdout: String(stdout), stderr: String(stderr), durationMs: 0 }),
              );
            },
          );
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }),
      approve: async ({ name, command, reason: rawReason, risk, tier }) => {
        if (signal.aborted) return 'deny';
        const policy = this.deps.store.getSettings().approval;
        // Commands and file writes share the three modes but not the classifier:
        // a shell command is judged by what it runs, a write by what it destroys.
        const outcome = risk === 'write' ? writeDecision(policy, tier ?? 'medium') : autoDecision(policy, command);
        // 完全访问 / 自动审批放行的动作：nothing waits. Working memory still records it.
        if (!outcome.ask) return 'allow_once';

        const reason = outcome.reason ? `${rawReason} · ${outcome.reason}` : rawReason;
        const signature = `${name}:${command}`;
        const allowed = this.allowedCommands.get(threadId);
        if (allowed?.has(signature)) return 'allow_once';
        if ((this.deps.store.getSettings().allowedCommands ?? []).includes(signature)) return 'allow_once';

        const approval: ApprovalRequest = {
          id: uid('apr'),
          threadId,
          turnId: turn.id,
          callId: `${turn.id}:${step}:${command.slice(0, 24)}`,
          name,
          command,
          reason,
          risk,
          ...(tier ? { tier } : {}),
        };
        const item: ApprovalItem = {
          id: approval.id,
          threadId,
          turnId: turn.id,
          kind: 'approval',
          at: Date.now(),
          status: 'running',
          callId: approval.callId,
          name,
          command,
          reason,
        };
        doc.items.push(item);
        this.emitItem(item);
        doc.thread.status = 'waiting_approval';
        this.emitThread(doc.thread);
        this.deps.emit({ type: 'approval/requested', approval });

        const decision = await new Promise<ApprovalDecision>((resolveDecision) => {
          this.approvals.set(approval.id, {
            request: approval,
            resolve: (value) => {
              if (value === 'allow_always') {
                const set = this.allowedCommands.get(threadId) ?? new Set<string>();
                set.add(signature);
                this.allowedCommands.set(threadId, set);
              }
              resolveDecision(value);
            },
          });
        });

        item.decision = decision;
        item.status = signal.aborted ? 'cancelled' : 'done';
        this.emitItem(item);
        doc.thread.status = 'running';
        this.emitThread(doc.thread);
        return decision;
      },
      ask: async ({ header, question, options }) => {
        if (signal.aborted) return { answer: '', cancelled: true };
        const id = uid('qst');
        let settle!: (answer: { answer: string; cancelled: boolean }) => void;
        const answered = new Promise<{ answer: string; cancelled: boolean }>((resolveAnswer) => {
          settle = resolveAnswer;
        });
        this.questions.set(id, { threadId, resolve: (value) => settle(value) });

        const onAbort = (): void => {
          this.questions.delete(id);
          settle({ answer: '', cancelled: true });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });

        const item: QuestionItem = {
          id,
          threadId,
          turnId: turn.id,
          kind: 'question',
          at: Date.now(),
          status: 'running',
          header,
          question,
          options,
        };
        doc.items.push(item);
        this.emitItem(item);
        this.deps.emit({
          type: 'runtime/updated',
          runtime: this.status(threadId, 'question', header),
          context: this.gauge(doc),
        });
        // Persist the pending card so a crash can still explain what was asked.
        void this.deps.store.save(threadId);

        const answer = await answered;
        signal.removeEventListener('abort', onAbort);
        this.questions.delete(id);
        item.answer = answer.answer;
        item.status = answer.cancelled ? 'cancelled' : 'done';
        this.emitItem(item);
        if (!answer.cancelled) {
          this.deps.emit({
            type: 'runtime/updated',
            runtime: this.status(threadId, 'tool', '收到回答，继续执行'),
            context: this.gauge(doc),
          });
        }
        return answer;
      },
      remember: async (entry) => {
        const scope = entry.scope === 'global' ? { kind: 'global' as const } : { kind: 'path' as const, path: doc.thread.cwd };
        const result = await this.memory.write({
          ...entry,
          scope: entry.kind === 'knowledge' ? scope : undefined,
          source: `${threadId} · 第 ${turn.index} 轮`,
        });
        this.deps.emit({ type: 'memory/updated', threadId, facts: memoryFacts(this.memory.all()) });
        return { kind: result.kind, note: result.note };
      },
      recall: async (input) => {
        const result = await this.memory.recall(input);
        this.deps.emit({ type: 'memory/updated', threadId, facts: memoryFacts(this.memory.all()) });
        return result;
      },
      setPlan: async (steps: PlanStep[]) => {
        doc.state.plan = steps;
        const item: PlanItem = {
          id: uid('itm'),
          threadId,
          turnId: turn.id,
          kind: 'plan',
          at: Date.now(),
          status: 'done',
          steps,
        };
        doc.items.push(item);
        this.emitItem(item);
      },
      markTouched: (files) => {
        for (const file of files) doc.state.evidence.push(`read:${file}`);
      },
      evidence: (tag) => {
        doc.state.evidence.push(tag);
      },
      commitFile: (target, content, expected) =>
        guardedCommit({
          locks: this.locks,
          workspace,
          target,
          content,
          expected,
          owner: `thread:${threadId}`,
        }),
    };
  }

  /** Schema validation, drift guard, locking, write-ahead working memory and checkpoint for one call. */
  private async invoke(
    doc: ThreadDoc,
    turn: Turn,
    tool: ToolDefinition,
    args: Record<string, unknown>,
    context: ToolExecContext,
    callId: string,
  ): Promise<Awaited<ReturnType<ToolDefinition['run']>>> {
    const schemaIssue = validateArgs(tool.name, tool.schema, args);
    if (schemaIssue) return schemaIssue;

    const threadId = doc.thread.id;
    const contract = doc.state.contract;
    if (contract && tool.mutating) {
      // Forbidden actions describe changes. Reading the same path is fine.
      const drift = checkDrift(contract, { name: tool.name, args });
      if (drift.action === 'refuse') {
        return { ok: false, layer: 'L3-domain', summary: 'blocked by the task contract', detail: drift.reason, hint: 'This action is out of scope. Explain why it is needed before trying again.', retryable: false };
      }
    }

    if (!tool.mutating) {
      // Read tools resolve paths at the top of `run`, so a path outside the
      // workspace throws before the tool can return a failure outcome. Keep
      // that throw inside the tool contract: the model gets a failed result
      // it can correct instead of losing the whole turn.
      try {
        return await tool.run(context, args);
      } catch (error) {
        return readDomainFailure(
          (error as Error).message || `${tool.name} failed`,
          `The call did not run. Use a workspace-relative path inside ${context.workspace}, then try again.`,
        );
      }
    }

    const owner = `thread:${threadId}`;
    const target = String(args.path ?? '');
    // `run_shell` may touch any file in the tree, so its lease is the whole
    // workspace; a per-file key would let a shell run beside a write.
    const lockKey = target
      ? resolve(context.workspace, target)
      : tool.name === 'run_shell'
        ? workspaceKey(context.workspace)
        : `exec:${tool.name}`;
    const fingerprint = target ? await fileFingerprint(lockKey) : 'n/a';

    const acquired = await this.locks
      .acquire(lockKey, owner, { fingerprint, waitMs: 20_000 })
      .catch((error: Error) => {
        return { error } as const;
      });

    if ('error' in acquired) {
      return {
        ok: false,
        layer: 'L3-domain',
        summary: 'resource is busy',
        detail: acquired.error.message,
        hint: 'Another step still holds this file. Wait for it to finish instead of forcing the write.',
        retryable: true,
      };
    }

    if (acquired.takeover) {
      const changed = acquired.takeover.changedSinceStale;
      this.emitNotice(threadId, {
        tone: changed ? 'warn' : 'info',
        title: thresholdMessage(changed),
        body: `租约由 ${acquired.takeover.owner}（pid ${acquired.takeover.pid}）持有，已在 ${formatDuration(acquired.takeover.ageMs)} 后过期。${
          changed ? '目标在租约期间变过，所以这次写入前先按地面真相重读了一遍。' : '目标没有变化，写入可以安全重做。'
        }`,
      });
    }

    await this.working
      .beginStep({
        threadId,
        turn: turn.index,
        step: turn.step,
        tool: tool.name,
        callId,
        detail: summarizeCall(tool, args),
        intent: typeof args.purpose === 'string' ? args.purpose.trim() : '',
        target: target ? lockKey : undefined,
        before: target ? fingerprint : undefined,
      })
      .catch(() => undefined);

    try {
      // Capture BEFORE the tool touches disk: a snapshot is the state to go
      // back to, and the change card's 撤销 restores it. The diff numbers are
      // filled in afterwards, once the step has actually run.
      const pre = await this.checkpoints.capture({
        threadId,
        step: turn.step,
        label: `${tool.name} ${target || tool.name}`,
        workspace: context.workspace,
        state: {
          items: doc.items,
          plan: doc.state.plan,
          memory: doc.state.memory,
          contract: doc.state.contract,
          resolution: doc.state.resolution,
          summary: doc.state.context.summary,
          foldedItems: doc.state.context.foldedItems,
        },
        filesTouched: target ? [target] : [],
      });

      const outcome = await tool.run(context, args);
      {
        const touched = (outcome.ok ? outcome.files : undefined) ?? (target ? [target] : []);
        if (outcome.ok && touched.length > 0) {
          const meta = (await this.checkpoints.restat(threadId, pre.id, context.workspace)) ?? pre;
          doc.snapshots = [...doc.snapshots.filter((snapshot) => snapshot.id !== meta.id), meta];
          const item: CheckpointItem = {
            id: uid('itm'),
            threadId,
            turnId: turn.id,
            kind: 'checkpoint',
            at: Date.now(),
            status: 'done',
            step: meta.step,
            label: meta.label,
            snapshotId: meta.id,
            filesTouched: touched,
            additiveOnly: meta.additiveOnly,
            changeStats: meta.changeStats,
          };
          doc.items.push(item);
          this.emitItem(item);
          this.deps.emit({ type: 'snapshot/updated', threadId, snapshots: doc.snapshots });
        }
      }
      return outcome;
    } catch (error) {
      return { ok: false, layer: 'transient', summary: 'tool threw', detail: (error as Error).message, hint: 'Retry once; if it throws again the environment is at fault.', retryable: true };
    } finally {
      await this.locks.release(lockKey, owner);
    }
  }

  /**
   * Revert to a checkpoint: verify hashes, restore the tree, delete files the
   * snapshot never knew, replace the whole conversation state (never truncate a
   * tail that compaction may have rewritten), then inject one factual message so
   * the model does not walk the reverted path again.
   */
  async previewRevert(threadId: string, snapshotId: string) {
    const doc = await this.deps.store.load(threadId);
    if (!doc) return { entries: [] as never[] };
    return this.checkpoints.preview(threadId, snapshotId, this.treeOf(doc));
  }

  /** The tree this session's snapshots address: its worktree while unmerged, else the main checkout. */
  private treeOf(doc: ThreadDoc): string {
    const worktree = doc.state.worktree;
    return worktree && worktree.status !== 'merged' ? worktree.path : doc.thread.cwd;
  }

  async revert(threadId: string, snapshotId: string): Promise<{ ok: boolean; message: string; undoSnapshotId?: string }> {
    const doc = await this.deps.store.load(threadId);
    if (!doc) return { ok: false, message: 'unknown session' };
    if (this.running.has(threadId)) return { ok: false, message: 'stop the running turn before reverting' };

    if (doc.state.worktree?.status === 'merged') {
      return {
        ok: false,
        message: '该会话的隔离副本已合并回主工作区并清理，旧快照不能直接套回主工作区。要撤销这次合并，在主工作区用 git revert 对应的合并提交。',
      };
    }

    // A revert restores the whole tree, so it would silently overwrite whatever
    // another session is doing in the same tree. Isolated worktrees are private,
    // so only sessions sharing this exact tree count as neighbours.
    const tree = this.treeOf(doc);
    const neighbours = [...this.trees.entries()].filter(([id, t]) => id !== threadId && normalizeWorkspace(t) === normalizeWorkspace(tree));
    if (neighbours.length > 0) {
      return {
        ok: false,
        message: `同一工作区还有 ${neighbours.length} 个会话在运行（${neighbours.map(([id]) => id.slice(0, 8)).join('、')}）。回退会覆盖它们的改动，先停止它们再试。`,
      };
    }

    const workspaceLock = workspaceKey(tree);
    try {
      await this.locks.acquire(workspaceLock, `revert:${threadId}`, { fingerprint: 'n/a', waitMs: 5_000 });
    } catch (error) {
      return { ok: false, message: `工作区正忙，先等写操作结束：${(error as Error).message}` };
    }

    try {
      return await this.revertLocked(doc, threadId, snapshotId, tree);
    } finally {
      await this.locks.release(workspaceLock, `revert:${threadId}`);
    }
  }

  private async revertLocked(doc: ThreadDoc, threadId: string, snapshotId: string, tree: string): Promise<{ ok: boolean; message: string; undoSnapshotId?: string }> {

    // Snapshot the current state first: a revert should be undoable too.
    const undoId = `undo-${Date.now().toString(36)}`;
    try {
      const pre = await this.checkpoints.capture({
        threadId,
        id: undoId,
        step: 0,
        label: '回退前',
        workspace: tree,
        state: {
          items: doc.items,
          plan: doc.state.plan,
          memory: doc.state.memory,
          contract: doc.state.contract,
          resolution: doc.state.resolution,
          summary: doc.state.context.summary,
          foldedItems: doc.state.context.foldedItems,
        },
        filesTouched: [],
      });
      doc.snapshots = [...doc.snapshots.filter((entry) => entry.id !== pre.id), pre];
    } catch {
      // if the pre-snapshot fails, still prefer a correct revert
    }

    const result = await this.checkpoints.revert(threadId, snapshotId, tree);
    if (!result.ok) return { ok: false, message: result.message };

    const restored = result.state as
      | { items?: Item[]; plan?: PlanStep[]; memory?: typeof doc.state.memory; contract?: typeof doc.state.contract; resolution?: typeof doc.state.resolution; summary?: string; foldedItems?: number }
      | null;

    if (restored?.items) {
      doc.items = restored.items;
      doc.state.plan = restored.plan ?? doc.state.plan;
      doc.state.memory = restored.memory ?? doc.state.memory;
      doc.state.contract = restored.contract ?? doc.state.contract;
      doc.state.resolution = restored.resolution ?? doc.state.resolution;
      doc.state.context.summary = restored.summary ?? '';
      doc.state.context.foldedItems = restored.foldedItems ?? 0;
    }

    // The short-term window is derived state: rebuild it from the restored
    // transcript, or the model would keep the rounds the revert just removed.
    try {
      const stm = await this.shortTermFor(doc);
      stm.seedFromItems(doc.thread, doc.items, doc.state.context.summary, true);
      await stm.save();
    } catch {
      // A memory rebuild failure must not block the file revert itself.
    }
    await this.working.recordStep({
      threadId,
      turn: doc.turn?.index ?? 0,
      step: 0,
      tool: 'snapshot_revert',
      detail: snapshotId,
      intent: '用户要求回到之前的检查点',
      result: result.message,
      ok: result.ok,
      next: '重新确认当前状态，不要重复被回退掉的改动',
    }).catch(() => undefined);

    const snapshot = doc.snapshots.find((entry) => entry.id === snapshotId);
    const notice: NoticeItem = {
      id: uid('itm'),
      threadId,
      turnId: doc.turn?.id ?? 'system',
      kind: 'notice',
      at: Date.now(),
      status: 'done',
      tone: 'warn',
      title: `已回退到 ${snapshotId}`,
      body: `${result.message}。会话状态换成了快照里的那一份，这次回退涉及的文件：${(snapshot?.files ?? []).slice(0, 8).join(', ') || '没有记录'}。没有新理由就别把这些改动再做一遍。`,
    };
    doc.items.push(notice);
    doc.thread.status = 'idle';
    this.emitItem(notice);
    this.emitThread(doc.thread);
    await this.deps.store.saveNow(threadId);
    return { ok: true, message: result.message, undoSnapshotId: undoId };
  }

  /**
   * Decide where this turn works. The first session in a workspace keeps the
   * main checkout; every additional concurrent session gets its own worktree,
   * so write sets are disjoint by construction. A non-git workspace falls back
   * to the lease/CAS path with a notice — isolation is an optimization, never
   * a prerequisite for running.
   */
  private async setupIsolation(doc: ThreadDoc, turn: Turn): Promise<string> {
    const threadId = doc.thread.id;
    const workspace = doc.thread.cwd;
    const existing = doc.state.worktree;

    if (existing && existing.status !== 'merged') {
      // A previous turn left unmerged work (deferred merge, conflict, or crash):
      // commit what landed and retry the merge before doing anything new.
      await this.finalizeWorktree(doc, turn, existing);
      const settled = doc.state.worktree;
      if (settled && settled.status === 'pending') {
        if (!this.mainTreeBusy(workspace, threadId)) {
          const resolution = await prepareConflictResolution(workspace, settled).catch(() => null);
          if (resolution?.ok) {
            doc.state.worktree = { ...settled, conflicted: resolution.conflicted, detail: resolution.detail };
            this.emitNotice(threadId, {
              tone: resolution.conflicted.length > 0 ? 'warn' : 'info',
              title: resolution.conflicted.length > 0 ? '合并冲突已放入副本，等待解决' : '主工作区改动已并入副本',
              body: `${resolution.detail}解决后正常结束回合即可，收尾时会重新合并回主工作区。`,
            });
          }
        }
        return settled.path;
      }
      // Merged: fall through — this turn may still need a fresh worktree.
    }

    const neighbours = (): Array<[string, string]> =>
      [...this.runningCwd.entries()].filter(([id, cwd]) => id !== threadId && cwd === normalizeWorkspace(workspace));
    if (neighbours().length === 0) return workspace;

    // Serialize check-and-create so two simultaneous starts cannot both claim
    // the main tree. A dedicated key: shells holding the workspace mutex must
    // not push a starting session back into the shared tree.
    const setupKey = `setup:${normalizeWorkspace(workspace)}`;
    await this.locks.acquire(setupKey, `setup:${threadId}`, { fingerprint: 'n/a', waitMs: 10_000 }).catch(() => undefined);
    try {
      const count = neighbours().length;
      if (count === 0) return workspace;
      const created = await createWorktree({ home: this.deps.home, workspace, threadId });
      if (!created.ok) {
        this.emitNotice(threadId, {
          tone: 'info',
          title: '同一工作区还有另一个会话在运行',
          body: `正在并行：${count} 个。${created.reason}，本会话沿用写前校验：写文件前会核对内容有没有被改过，改不动就报冲突；整体回退需要先停掉其他会话。`,
        });
        return workspace;
      }
      doc.state.worktree = created.state;
      this.emitNotice(threadId, {
        tone: 'info',
        title: '本会话在隔离副本中工作',
        body: `同一工作区还有 ${count} 个会话在运行。本回合改动写在独立 git worktree（分支 ${created.state.branch}），回合结束后自动合并回主工作区并跑 typecheck 验证；冲突或验证失败会保留分支提示处理，不会覆盖别人的改动。`,
      });
      return created.state.path;
    } finally {
      await this.locks.release(setupKey, `setup:${threadId}`);
    }
  }

  /** True while another session's turn runs in the main checkout of this workspace. */
  private mainTreeBusy(workspace: string, excludeThreadId: string): boolean {
    const main = normalizeWorkspace(workspace);
    return [...this.trees.entries()].some(([id, tree]) => id !== excludeThreadId && normalizeWorkspace(tree) === main);
  }

  /**
   * Commit the worktree and merge it home, serially and behind the typecheck
   * gate. Success cleans up checkout and branch; anything else keeps both and
   * records a pending state the next turn start (or a neighbour's turn end)
   * retries. Never throws: the turn's own outcome must not be masked.
   */
  private async finalizeWorktree(doc: ThreadDoc, turn: Turn | null, state: WorktreeState): Promise<void> {
    const threadId = doc.thread.id;
    const workspace = doc.thread.cwd;
    try {
      const changed = await commitWorktree(state, `xiaohey: 会话「${doc.thread.title}」${turn ? ` 第 ${turn.index} 轮` : ''}`);
      if (!changed && state.status === 'active') {
        await removeWorktree(workspace, state, true);
        doc.state.worktree = { ...state, status: 'merged', detail: '本回合没有改动，副本已清理。' };
        return;
      }
      const result = await mergeWorktree({
        workspace,
        state,
        locks: this.locks,
        owner: `merge:${threadId}`,
        title: doc.thread.title,
        mainBusy: () => this.mainTreeBusy(workspace, threadId),
      });
      doc.state.worktree = { ...state, status: result.status === 'merged' ? 'merged' : 'pending', detail: result.detail, conflicted: result.conflicted };
      this.emitNotice(threadId, {
        tone: result.status === 'merged' ? 'info' : 'warn',
        title: result.status === 'merged' ? '隔离副本已合并回主工作区' : '改动暂存于隔离分支，待合并',
        body:
          result.status === 'merged'
            ? `${result.detail}分支 ${state.branch} 与副本已清理。`
            : `${result.detail}继续本会话会自动重试合并；也可以直接用 git 处理该分支。`,
      });
    } catch (error) {
      doc.state.worktree = { ...state, status: 'pending', detail: (error as Error).message };
      this.emitNotice(threadId, {
        tone: 'warn',
        title: '隔离副本收尾失败',
        body: `${(error as Error).message}。改动保留在分支 ${state.branch}，继续本会话会自动重试。`,
      });
    }
  }

  /** After any turn ends in a workspace, retry other sessions' deferred merges. */
  private async drainPendingMerges(workspace: string, excludeThreadId: string): Promise<void> {
    if (!workspace) return;
    try {
      for (const thread of await this.deps.store.listThreads()) {
        if (thread.id === excludeThreadId || normalizeWorkspace(thread.cwd) !== normalizeWorkspace(workspace)) continue;
        const doc = await this.deps.store.load(thread.id);
        const state = doc?.state.worktree;
        if (!doc || !state || state.status !== 'pending' || this.running.has(thread.id)) continue;
        await this.finalizeWorktree(doc, null, state);
        await this.deps.store.saveNow(thread.id);
      }
    } catch {
      // Draining is opportunistic; the next turn end or session start retries.
    }
  }

  /** A crash can leave a checkout behind: commit what landed, merge it home. */
  private async recoverWorktrees(): Promise<void> {
    try {
      for (const thread of await this.deps.store.listThreads()) {
        const doc = await this.deps.store.load(thread.id);
        const state = doc?.state.worktree;
        if (!doc || !state || state.status === 'merged' || this.running.has(thread.id)) continue;
        await this.finalizeWorktree(doc, null, state);
        await this.deps.store.saveNow(thread.id);
      }
    } catch {
      // Recovery is best-effort; the next turn start retries.
    }
  }

  /** Deleting a session removes its checkout but keeps an unmerged branch: work is never silently lost. */
  async disposeWorktree(threadId: string): Promise<void> {
    const doc = this.deps.store.docs.get(threadId) ?? (await this.deps.store.load(threadId));
    const state = doc?.state.worktree;
    if (!doc || !state) return;
    if (state.status !== 'merged') await removeWorktree(doc.thread.cwd, state, false).catch(() => undefined);
    doc.state.worktree = null;
    await this.deps.store.saveNow(threadId).catch(() => undefined);
  }

  /**
   * A turn can die between a tool call and its result (a thrown read tool, a
   * store failure). Leave no call spinning: give it a terminal result so the
   * transcript matches the turn status even before the turn is re-opened.
   */
  private closeRunningToolCalls(doc: ThreadDoc, turn: Turn, message: string, cancelled: boolean): void {
    const answered = new Set(
      doc.items.filter((item): item is ToolResultItem => item.kind === 'tool_result').map((item) => item.callId),
    );
    for (const item of doc.items) {
      if (item.kind !== 'tool_call' || item.turnId !== turn.id || answered.has(item.callId)) continue;
      if (item.status === 'running') {
        item.status = cancelled ? 'cancelled' : 'error';
        this.emitItem(item);
      }
      const result: ToolResultItem = {
        id: uid('itm'),
        threadId: doc.thread.id,
        turnId: turn.id,
        kind: 'tool_result',
        at: Date.now(),
        status: cancelled ? 'cancelled' : 'error',
        callId: item.callId,
        name: item.name,
        ok: false,
        summary: cancelled ? '已停止' : '工具没有返回结果',
        output: cancelled ? '本轮已停止，工具没有返回结果。' : message,
        layer: 'none',
        retryable: false,
      };
      doc.items.push(result);
      this.emitItem(result);
      answered.add(item.callId);
    }
  }

  private pushResult(
    doc: ThreadDoc,
    turn: Turn,
    call: ToolCall,
    outcome: Awaited<ReturnType<ToolDefinition['run']>>,
    durationMs: number,
    tool: ToolDefinition | undefined,
    statusOverride?: ToolResultItem['status'],
  ): void {
    const result: ToolResultItem = {
      id: uid('itm'),
      threadId: doc.thread.id,
      turnId: turn.id,
      kind: 'tool_result',
      at: Date.now(),
      status: statusOverride ?? (outcome.ok ? 'done' : 'error'),
      callId: call.id,
      name: tool?.name ?? call.function.name,
      ok: outcome.ok,
      summary: outcome.summary,
      output: outcome.ok ? outcome.output : [outcome.detail, outcome.hint].filter(Boolean).join('\n\n'),
      layer: outcome.ok ? 'none' : outcome.layer,
      retryable: outcome.ok ? false : outcome.retryable,
      hint: outcome.ok ? undefined : outcome.hint,
      files: outcome.ok ? outcome.files : undefined,
      durationMs,
    };
    doc.items.push(result);
    this.emitItem(result);
  }
}

function thresholdMessage(changed: boolean): string {
  return changed ? '失效的租约已接管，目标已重新读取' : '失效的租约已接管';
}

function summarizeCall(tool: ToolDefinition, args: Record<string, unknown>): string {
  if (tool.name === 'run_shell') return truncate(String(args.command ?? ''), 120);
  if (tool.name === 'ask_user') return truncate(String(args.question ?? ''), 120);
  if (typeof args.path === 'string') return `${tool.name} ${args.path}`;
  if (typeof args.pattern === 'string') return `${tool.name} /${args.pattern}/`;
  if (tool.name === 'todo_write') return 'plan updated';
  if (tool.name === 'memory_read') return args.query ? `recall ${truncate(String(args.query), 60)}` : `recall ${args.kind ?? 'all'}`;
  if (tool.name === 'memory_write') return `remember ${args.kind ?? 'memory'}${args.slot ? ` ${String(args.slot)}` : ''}`;
  return tool.summary;
}

/** A concrete "why" for working memory when the model gave no reasoning. */
function whyForTool(name: string, args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : '';
  switch (name) {
    case 'read_file':
      return path ? `读取 ${path}，确认当前内容` : '读取文件确认现状';
    case 'list_dir':
      return `查看 ${String(args.path ?? '.')} 里有什么`;
    case 'glob_files':
      return `按 ${String(args.pattern ?? '')} 查找文件`;
    case 'grep_text':
      return `搜索 ${String(args.pattern ?? '')} 的落点`;
    case 'write_file':
      return path ? `写入 ${path} 的完整内容` : '新建文件';
    case 'edit_file':
      return path ? `修改 ${path} 的目标片段` : '修改文件';
    case 'todo_write':
      return '更新任务计划';
    case 'memory_read':
      return args.query ? `召回与「${String(args.query)}」相关的长期记忆` : '回顾长期记忆';
    case 'memory_write':
      return `写入${String(args.kind ?? '')}长期记忆`;
    case 'ask_user':
      return `向用户确认：${truncate(String(args.question ?? ''), 80)}`;
    default:
      return '';
  }
}

export { clamp };

