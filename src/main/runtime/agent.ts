import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ApprovalDecision,
  ApprovalItem,
  ApprovalRequest,
  CheckpointItem,
  ContextGauge,
  ContextPart,
  Item,
  MessageItem,
  NoticeItem,
  PlanItem,
  PlanStep,
  QuestionItem,
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
import { Assembler, L1_TRIGGER, TOOL_RESULT_TOKENS, type Assembly } from './assembler.js';
import { renderDigest as renderTurnDigest } from './compressor.js';
import { Compressor } from './compressor.js';
import { previewOf } from './blobs.js';
import {
  ConsolidationService,
  beijingParts,
  isConsolidationMinute,
  localDayKey,
  pastConsolidationTime,
  CONSOLIDATION_TOKEN_THRESHOLD,
  type ConsolidationReport,
} from './consolidate.js';
import { SessionSearch } from './sessionsearch.js';
import { detectPreference, nudgeText } from './preferences.js';
import { SessionLog, sessionPaths } from './sessionlog.js';
import { BlobStore } from './blobs.js';
import type { ArgsRef, BlobRef, InlineRef } from './events.js';
import { memoryRoot } from './memdir.js';
import { oneLine } from './memmark.js';
import { extractEvents, mergeResolution, parseRelativeTime, resolveEntities } from './resolve.js';
import { auditClaims, buildSystemPrompt, contextBudget, DEFAULT_CONTEXT_WINDOW, gaugeOf, promptParts, tokensOf, type ContextBudget } from './context.js';
import { complete, LlmError, type ChatMessage, type ToolCall } from './llm.js';
import { autoDecision, writeDecision } from './policy.js';
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
import { domainFailure, noteAttempt, parseArguments, readDomainFailure, schemaRetriesLeft, validateArgs, type RetryLedger, type ToolFailure, type ToolOutcome } from './toolerrors.js';
import { fileFingerprint } from '../fingerprint.js';
import { clamp, estimateTokens, formatDuration, resolveInside, stableStringify, truncate, uid } from '../util.js';

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
/** A new turn waits this long for the previous one to finish committing/merging. */
const SETTLE_WAIT_MS = 30_000;
/**
 * Contract scope is the session (ADR-14): it survives turns and is only rebuilt
 * when the user explicitly starts another task. Auto-rebuilding every turn
 * would silently change the goal the model is working against.
 */
const RESTART_PATTERN = /(?:^|[\s。；;，,：:])(?:新任务|重新开始|从头开始|换个任务|换个话题|start over|new task)/i;
/** Tools whose whole purpose is to return text back into the context. */
const FETCH_TOOLS = new Set(['read_handle', 'turn_expand', 'session_search']);

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
  private readonly compressors = new Map<string, Compressor>();
  private readonly assemblers = new Map<string, Assembler>();
  readonly memory: LongTermMemory;
  /** Pending marks, the 50M gate, the 01:19 pass and idempotency. */
  readonly consolidation: ConsolidationService;

  constructor(private readonly deps: AgentDeps) {
    this.locks = new LockTable(join(deps.home, 'leases.json'));
    this.checkpoints = new Checkpoints(join(deps.home, 'snapshots'));
    const root = deps.memoryHome ?? memoryRoot();
    this.memory = new LongTermMemory(root, {
      embedder: new ConfiguredEmbedder(() => this.embeddingConfig()),
      reranker: new ConfiguredReranker(() => this.rerankConfig()),
    });
    this.consolidation = new ConsolidationService({
      root: deps.home,
      usage: deps.store.usage,
      model: () => this.deps.store.activeModel(),
      sessionsFor: async (workspace) => {
        const sessions = [];
        for (const entry of this.deps.store.sessions.list()) {
          if (normalizeWorkspace(entry.workspace) !== workspace) continue;
          const log = await SessionLog.open(this.deps.home, entry.sid, { write: false });
          if (!log) continue;
          const lastTurn = [...log.turnEntries()].reverse().find((turn) => turn.status !== 'running');
          sessions.push({
            sid: entry.sid,
            workspace: entry.workspace,
            lastTurnDayKey: lastTurn ? localDayKey(lastTurn.endedAt ?? lastTurn.startedAt) : '',
            lastSeq: log.lastSeq,
          });
        }
        return sessions;
      },
      openLog: (sid) => SessionLog.open(this.deps.home, sid),
      writeMemory: (input) => this.memory.write(input),
      recordUsage: async (workspace, input, output) => {
        await this.deps.store.usage.append({
          dayKey: localDayKey(),
          workspace,
          sid: '',
          turn: 0,
          kind: 'consolidate',
          input,
          output,
        });
      },
    });
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
    // Retention is background work: a 90-day-old blob is cold by definition.
    void this.gcBlobs().catch(() => undefined);
    this.startConsolidationScheduler();
    this.catchUpConsolidation();
  }


  /**
   * The old per-thread `state.memory` array was already imported into
   * `memory.md` by the previous release; the entry point stays so the boot path
   * and the demo can still call it.
   */
  async migrateLegacyMemory(): Promise<void> {
    await this.memory.saveIfDirty();
  }

  /** Drop blobs untouched for 90 days; their handles then read as expired. */
  private async gcBlobs(maxAgeDays = 90): Promise<void> {
    for (const entry of this.deps.store.sessions.list()) {
      const paths = sessionPaths(this.deps.home, entry.sid);
      await new BlobStore(paths.blobs, 0).gc(maxAgeDays).catch(() => undefined);
    }
  }

  /** Deleting a session keeps what was distilled from it, marked as orphaned. */
  async purgeSessionMemory(threadId: string): Promise<void> {
    await this.memory.markSourceDeleted(threadId).catch(() => 0);
  }

  /**
   * Boot recovery: settle every ledger the previous process left mid-turn. The
   * repair is written into the ledger — an unfinished turn gets `interrupted`,
   * an unpaired tool call gets an explicit result with `applied=unknown` — so a
   * later reader sees the same story the runtime saw.
   */
  private async recoverInterrupted(): Promise<void> {
    await this.deps.store.recoverInterrupted();
    for (const doc of this.deps.store.docs.values()) {
      if (doc.thread.status !== 'running' && doc.thread.status !== 'waiting_approval' && doc.turn?.status !== 'running') continue;
      doc.thread.status = 'idle';
      if (doc.turn && doc.turn.status === 'running') {
        doc.turn.status = 'cancelled';
        doc.turn.endedAt = Date.now();
        doc.turn.stopReason = 'interrupted by app shutdown';
      }
      for (const item of doc.items) {
        if (item.status === 'running') item.status = 'cancelled';
      }
      this.emitThread(doc.thread);
    }
  }

  /**
   * Return a session to idle when the turn that owned it lost its executor. Used
   * both by recovery and by a stop click on a session this process is not
   * actually running.
   */
  private async markInterrupted(
    doc: ThreadDoc,
    stopReason: string,
    title: string,
    body: string,
    tone: 'warn' | 'stopped' = 'warn',
  ): Promise<void> {
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
    await this.deps.store.settleLog(doc.log).catch(() => undefined);
    doc.thread.status = 'idle';
    await this.recordNotice(doc, { tone, title, body });
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
    await this.markInterrupted(
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

  /**
   * A durable notice: written to the ledger first, so a reload redraws it. The
   * transient `emitNotice` above is for UI state that means nothing tomorrow.
   */
  private async recordNotice(
    doc: ThreadDoc,
    notice: { tone: NoticeItem['tone']; title: string; body: string },
  ): Promise<NoticeItem> {
    const item: NoticeItem = {
      id: uid('itm'),
      threadId: doc.thread.id,
      turnId: doc.turn?.id ?? 'system',
      kind: 'notice',
      at: Date.now(),
      status: 'done',
      tone: notice.tone,
      title: notice.title,
      body: notice.body,
    };
    await doc.log
      .append({
        type: 'notice',
        tone: notice.tone,
        title: notice.title,
        body: notice.body,
        itemId: item.id,
        turn: doc.log.activeTurn,
        step: doc.turn?.step ?? 0,
      })
      .catch(() => undefined);
    doc.items.push(item);
    this.emitItem(item);
    return item;
  }

  private compressorFor(doc: ThreadDoc): Compressor {
    const cached = this.compressors.get(doc.thread.id);
    if (cached) return cached;
    const compressor = new Compressor(doc.log, () => this.deps.store.activeModel(), (input, output) => {
      void this.deps.store.usage.append({
        dayKey: localDayKey(),
        workspace: doc.thread.cwd,
        sid: doc.thread.id,
        turn: doc.log.activeTurn,
        kind: 'context_compress',
        input,
        output,
      });
    });
    this.compressors.set(doc.thread.id, compressor);
    return compressor;
  }

  private assemblerFor(doc: ThreadDoc): Assembler {
    const cached = this.assemblers.get(doc.thread.id);
    if (cached) return cached;
    const assembler = new Assembler({ log: doc.log, compressor: this.compressorFor(doc) });
    this.assemblers.set(doc.thread.id, assembler);
    return assembler;
  }

  /**
   * Content reference: inline while small, blob + handle once it would crowd
   * the ledger. The handle always points at the untruncated original.
   */
  private async refContent(
    doc: ThreadDoc,
    input: { kind: 'tool_result' | 'tool_args' | 'attachment' | 'assistant_text' | 'reasoning' | 'turn_final'; text: string; limit: number; step: number; tool?: string; callId?: string },
  ): Promise<InlineRef | BlobRef> {
    const tokens = estimateTokens(input.text);
    if (tokens <= input.limit) return { text: input.text, tokens };
    const put = await doc.log.blobs.put(input.text);
    const handle = await doc.log.handles.create({
      text: input.text,
      kind: input.kind,
      turn: doc.log.activeTurn,
      step: input.step,
      ...(input.tool ? { tool: input.tool } : {}),
      ...(input.callId ? { callId: input.callId } : {}),
      blob: put.blob,
      bytes: put.bytes,
      tokens: put.tokens,
    });
    return {
      blob: put.blob,
      bytes: put.bytes,
      tokens: put.tokens,
      handle: handle.handle,
      preview: previewOf(input.text),
    };
  }

  /** Tool arguments keep a digest and preview even when the blob holds the rest. */
  private async argsRef(doc: ThreadDoc, name: string, callId: string, step: number, raw: string): Promise<InlineRef | ArgsRef> {
    const tokens = estimateTokens(raw);
    if (tokens <= 4000) return { text: raw, tokens };
    const put = await doc.log.blobs.put(raw);
    const handle = await doc.log.handles.create({
      text: raw,
      kind: 'tool_args',
      turn: doc.log.activeTurn,
      step,
      tool: name,
      callId,
      blob: put.blob,
      bytes: put.bytes,
      tokens: put.tokens,
    });
    return {
      digest: put.sha256,
      blob: put.blob,
      handle: handle.handle,
      bytes: put.bytes,
      tokens: put.tokens,
      preview: previewOf(raw),
    };
  }

  /** Block until a finishing turn releases the session, bounded by a deadline. */
  private async waitSettled(threadId: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.has(threadId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
    if (this.running.has(threadId)) {
      // The finished turn announces itself before its worktree merge is done, so
      // the renderer fires a queued message while the session is still settling.
      // Wait for it instead of refusing a message the user already sent.
      await this.waitSettled(threadId, SETTLE_WAIT_MS);
      if (this.running.has(threadId)) throw new Error('上一轮还在收尾，稍后再发送一次');
    }
    if (!doc.thread.cwd) throw new Error('请选择工作区后再发送');

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
    doc.log.activeTurn = turn.index;
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
    const log = doc.log;
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
      // turn works in its own git worktree. Tools and checkpoints follow the
      // effective tree, so the existing safety layers apply unchanged.
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
        await this.recordNotice(doc, {
          tone: 'info',
          title: `长期记忆已归档 ${maintenance.archived} 条`,
          body: '这些记忆长时间没有被召回，按遗忘曲线衰减后移入 memory-archive.md；再次被明确召回时会自动唤醒。',
        });
      }

      // 1. Open the turn in the ledger first: the user's words are the anchor
      // every later event and every replay hangs off.
      const references = await this.readReferences(doc.thread.cwd, attachments);
      const attachmentRefs: BlobRef[] = [];
      for (const reference of references) {
        const ref = await this.refContent(doc, {
          kind: 'attachment',
          text: reference.content,
          limit: 4000,
          step: 0,
        });
        if ('blob' in ref) attachmentRefs.push({ ...ref, preview: reference.path });
      }
      const userItemId = uid('itm');
      const started = await log.append({
        type: 'turn_started',
        turnId: turn.id,
        userText: prompt,
        ...(attachmentRefs.length > 0 ? { attachments: attachmentRefs } : {}),
        turn: turn.index,
        step: 0,
        itemId: userItemId,
      });
      const userItem: MessageItem = {
        id: userItemId,
        threadId,
        turnId: turn.id,
        kind: 'message',
        at: started.ts,
        status: 'done',
        role: 'user',
        text: prompt,
        ...(references.length > 0 ? { references } : {}),
      };
      push(userItem);
      await this.deps.store.saveNow(threadId);

      // 2. Contract: freeze goal, acceptance, non-goals and forbidden actions.
      // Session-scoped: an explicit "new task" (or a UI rebuild) starts a new one.
      const restart = Boolean(doc.state.contract) && RESTART_PATTERN.test(prompt);
      if (!doc.state.contract || restart) {
        const contract = buildContract(prompt);
        doc.state.contract = contract;
        await log.append({
          type: 'contract_set',
          contract,
          source: restart ? 'reset' : 'first-turn',
          ...(restart ? { reason: '用户明确开始了新任务' } : {}),
          turn: turn.index,
        });
        await this.recordNotice(doc, {
          tone: 'info',
          title: restart ? '任务契约已按新任务重建' : '任务契约已写入',
          body: `目标：${contract.goal}\n验收：${contract.acceptance.join(' · ')}`,
        });
      }

      // 3. Resolution: entities, relative times, event anchors — derived state,
      // written only when it actually changed.
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      const time = parseRelativeTime(prompt, new Date(), timezone);
      const anchors = extractEvents(prompt, new Date(), timezone, 'user_message');
      const entities = resolveEntities(prompt, this.memory.all());
      const merged = mergeResolution(doc.state.resolution, {
        times: time ? [time] : [],
        events: anchors,
        entities: entities.matched,
      });
      const hash = stableStringify(merged);
      if (hash !== doc.state.resolutionHash) {
        doc.state.resolution = merged;
        doc.state.resolutionHash = hash;
        await log.append({ type: 'resolution_updated', state: merged, hash, source: 'turn', turn: turn.index });
      }
      if (time && time.confidence === 'low') {
        await this.recordNotice(doc, {
          tone: 'warn',
          title: '相对时间按推测归一化了',
          body: `“${time.phrase}”没有给具体钟点，按 ${time.fromIso} … ${time.toIso} 处理。若是别的时间窗，直接说。`,
        });
      }

      // Preference nudge: one line, once, only when the user stated something
      // durable. The model decides whether to write it; tool content never does.
      const preference = detectPreference(prompt);

      let assistant: MessageItem | null = null;
      let step = 0;
      let stopReason = 'model finished';
      let lastFinishReason = '';
      let pressureNoticed = false;
      let lastCheckpointStep = 0;
      let wroteSinceCheckpoint = false;
      let lastGauge: Assembly | undefined;

      while (true) {
        step += 1;
        turn.step = step;
        doc.thread.steps += 1;
        if (controller.signal.aborted) {
          stopReason = 'cancelled by the user';
          break;
        }

        // 4. Context assembly: fixed prefix + at most eight completed turns at
        // their sticky level + this turn's live trace. Large observations are
        // elided to handles as the observation budget fills.
        const thinking = doc.state.context.thinking === true;
        const toolList = tools
          .map((tool) => `- ${tool.name} (${tool.risk}) — ${tool.summary} Use when: ${tool.useWhen} Do NOT use: ${tool.avoidWhen}`)
          .join('\n');
        const verification = doc.view.verification();
        const assembly = await this.assemblerFor(doc).assemble({
          log,
          compressor: this.compressorFor(doc),
          model,
          workspace: effectiveWorkspace,
          contract: doc.state.contract,
          plan: doc.state.plan,
          resolution: doc.state.resolution,
          memoryIndex: this.memory.indexNote(),
          verification,
          toolList,
          toolTokens: estimateTokens(JSON.stringify(toolSpecs())),
          step,
          thinking,
          ...(isolationNote ? { isolationNote } : {}),
          ...(step === 1 && preference ? { nudge: nudgeText(preference) } : {}),
        });
        lastGauge = assembly;
        let messages = assembly.messages;
        if (!pressureNoticed && assembly.pressure > L1_TRIGGER) {
          pressureNoticed = true;
          await this.recordNotice(doc, {
            tone: 'warn',
            title: '上下文接近预算，较早的观察已收起为句柄',
            body: '较早的工具结果不再逐字进入模型上下文，但每一步都还在 events.jsonl 里，可以用 read_handle 或 turn_expand 取回。',
          });
        }

        // 5. Milestone re-read of the verbatim requirement.
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

        const modelMessages: ChatMessage[] = [{ role: 'system', content: assembly.system }, ...messages];

        // 6. Model call, streamed into one assistant item. The ledger gets one
        // `assistant_message` when the call completes, never one per token.
        this.deps.emit({
          type: 'runtime/updated',
          runtime: this.status(threadId, 'thinking', `第 ${step} 步 · 调用 ${model.model}`),
          context: this.gauge(doc, assembly),
        });
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

        const reasoningRef = result.reasoning.trim()
          ? await this.refContent(doc, {
              kind: 'reasoning',
              text: result.reasoning.trim(),
              limit: 1000,
              step,
            })
          : undefined;
        await log.append({
          type: 'assistant_message',
          text: assistantItem.text,
          ...(reasoningRef ? { reasoning: reasoningRef } : {}),
          final: result.toolCalls.length === 0,
          ...(lastFinishReason === 'length' ? { truncated: true } : {}),
          turn: turn.index,
          step,
          itemId: assistantItem.id,
        });
        if (reasoningRef && !('blob' in reasoningRef)) {
          push({
            id: `${assistantItem.id}_r`,
            threadId,
            turnId: turn.id,
            kind: 'reasoning',
            at: Date.now(),
            status: 'done',
            text: truncate(result.reasoning.trim(), 1200),
          });
        }

        await this.recordUsage(doc, turn, effectiveWorkspace, 'chat', result.usage);

        if (result.toolCalls.length === 0) {
          // Evidence audit: claims about files nobody read.
          const missing = auditClaims(assistantItem.text, doc.state.evidence);
          if (missing.length > 0) {
            await this.recordNotice(doc, {
              tone: 'warn',
              title: '回答提到了没有读过的文件',
              body: `${missing.join(', ')} — 没有任何 read_file、grep_text 或 glob_files 的结果覆盖它们。核实之后再引用。`,
            });
          }
          break;
        }

        // 7. Tool execution. Consecutive read-only calls run together; anything
        // that mutates, or blocks on the user, keeps its strict order.
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
              const wrote = await this.executeToolGroup(doc, turn, group, step, result.reasoning, controller.signal);
              wroteSinceCheckpoint = wroteSinceCheckpoint || wrote;
            } else {
              const call = calls[cursor];
              const wrote = await this.executeTool(doc, turn, call, step, result.reasoning, controller.signal);
              wroteSinceCheckpoint = wroteSinceCheckpoint || wrote;
              cursor += 1;
            }
          }
        }

        // 8. Checkpoint: after every write step, and every ten read-only steps.
        if (wroteSinceCheckpoint || step - lastCheckpointStep >= 10) {
          await this.writeTurnCheckpoint(doc, turn);
          lastCheckpointStep = step;
          wroteSinceCheckpoint = false;
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
        await this.closeRunningToolCalls(doc, turn, 'stopped by the user', true);
        await this.recordNotice(doc, {
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
        await this.recordNotice(doc, {
          tone: 'warn',
          title: truncated ? '输出被截断' : '模型没有返回正文',
          body: truncated
            ? `本次请求的输出上限是 ${outputCap}，思考占满了这个预算，没有留下正文。点开输入框右下角的模型菜单，在「当前模型设置」里把输出上限调大（以供应商支持为准），或把推理等级调低后再试。`
            : '本轮已结束，但没有生成最终答案。可以继续发一条消息让它总结。',
        });
      }

      // A turn that stops right after a failed tool has not reached its goal,
      // even though the loop ended by itself (the model answered instead of
      // retrying). Report the failure and name the command.
      const endedOnFailure = aborted ? null : this.trailingFailure(doc, turn);
      if (endedOnFailure) {
        stopReason = `最后一步失败：${endedOnFailure.summary}`;
        await this.recordNotice(doc, {
          tone: 'error',
          title: '本轮以失败的命令结束',
          body: `${endedOnFailure.summary}\n\n最后这一步没有成功，之后也没有再执行成功的步骤，目标可能还没完成。说「继续」或「重试」，我会从失败的地方接着做。`,
        });
      }

      turn.status = aborted ? 'cancelled' : endedOnFailure ? 'failed' : 'completed';
      turn.endedAt = Date.now();
      turn.stopReason = stopReason;
      doc.thread.status = 'idle';
      await this.finalizeTurn(doc, turn, lastGauge);
      this.deps.emit({ type: 'turn/updated', turn });
      this.emitThread(doc.thread);
      this.deps.emit({
        type: 'runtime/updated',
        runtime: this.status(threadId, 'idle', `耗时 ${formatDuration(turn.endedAt - turn.startedAt)} · ${step} 步`),
        context: this.gauge(doc, lastGauge),
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
      await this.closeRunningToolCalls(doc, turn, message, aborted);
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
      await this.recordNotice(doc, {
        tone: aborted ? 'stopped' : 'error',
        title: aborted ? '本轮已停止' : '本轮失败',
        body: message,
      });
      await this.finalizeTurn(doc, turn);
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
        doc.state.context.tokensUsed = this.gauge(doc).tokensUsed;
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

  /** Close the ledger book on one turn: checkpoint, then `turn_finished`. */
  private async finalizeTurn(doc: ThreadDoc, turn: Turn, assembly?: Assembly): Promise<void> {
    try {
      await this.writeTurnCheckpoint(doc, turn);
      const lastAnswer = [...doc.items]
        .reverse()
        .find(
          (item): item is MessageItem =>
            item.kind === 'message' && item.role === 'assistant' && item.turnId === turn.id && item.text.trim().length > 0,
        );
      await doc.log.append({
        type: 'turn_finished',
        status:
          turn.status === 'completed'
            ? 'completed'
            : turn.status === 'cancelled'
              ? 'cancelled'
              : turn.status === 'failed'
                ? 'failed'
                : 'interrupted',
        ...(turn.stopReason ? { stopReason: turn.stopReason } : {}),
        ...(lastAnswer
          ? {
              finalText: await this.refContent(doc, {
                kind: 'turn_final',
                text: lastAnswer.text,
                limit: 2000,
                step: turn.step,
              }),
            }
          : {}),
        turn: turn.index,
      });
      if (assembly) doc.state.context.compacted = Object.values(assembly.levels).filter((level) => level >= 2).length;
      await doc.log.flush();
    } catch {
      // A ledger write failure must not leave the session marked as running.
    }
  }

  /**
   * The checkpoint a resumed turn reads: the goal, the last step, what landed,
   * the plan line, and the next step. Written at turn start, after writes and
   * at exit — never as a separate notebook file.
   */
  private async writeTurnCheckpoint(doc: ThreadDoc, turn: Turn): Promise<void> {
    const calls = doc.items.filter(
      (item): item is ToolCallItem => item.kind === 'tool_call' && item.turnId === turn.id,
    );
    const results = new Map(
      doc.items
        .filter((item): item is ToolResultItem => item.kind === 'tool_result' && item.turnId === turn.id)
        .map((item) => [item.callId, item]),
    );
    const lastCall = calls.at(-1);
    const lastResult = lastCall ? results.get(lastCall.callId) : undefined;
    const activePlan = doc.state.plan.find((step) => step.status === 'active') ?? doc.state.plan.find((step) => step.status === 'pending');
    const touched = [
      ...new Set(
        doc.items
          .filter((item): item is CheckpointItem => item.kind === 'checkpoint' && item.turnId === turn.id)
          .flatMap((item) => item.filesTouched),
      ),
    ].slice(0, 12);
    await doc.log
      .append({
        type: 'turn_checkpoint',
        turn: turn.index,
        step: turn.step,
        goal: doc.state.contract?.goal ?? oneLine(turn.prompt, 200),
        ...(lastCall
          ? {
              lastStep: {
                tool: lastCall.name,
                ...(typeof lastCall.args.path === 'string' ? { target: String(lastCall.args.path) } : {}),
                ok: lastResult?.ok !== false,
              },
            }
          : {}),
        ...(touched.length > 0 ? { filesTouched: touched } : {}),
        ...(activePlan ? { lastPlanLine: `[${activePlan.status}] ${activePlan.title}` } : {}),
        ...(activePlan ? { next: `继续计划：${activePlan.title}` } : {}),
      })
      .catch(() => undefined);
  }

  /** The last gauge per thread: `context/get` serves this rather than re-assembling. */
  private lastGauges = new Map<string, ContextGauge>();

  cachedGauge(threadId: string): ContextGauge | null {
    return this.lastGauges.get(threadId) ?? null;
  }

  /**
   * The prompt prefix a fresh step would send, without assembling history. The
   * composer's breakdown needs the system / tools / memory split for a thread
   * nobody has run in this process yet.
   */
  contextLayout(doc: ThreadDoc): { parts: { system: number; memory: number; tools: number }; budget: ContextBudget } {
    const model = this.deps.store.activeModel();
    const window = model?.contextWindow || DEFAULT_CONTEXT_WINDOW;
    const toolList = tools
      .map((tool) => `- ${tool.name} (${tool.risk}) — ${tool.summary} Use when: ${tool.useWhen} Do NOT use: ${tool.avoidWhen}`)
      .join('\n');
    const toolTokens = estimateTokens(JSON.stringify(toolSpecs()));
    const budget = contextBudget({
      contextWindow: window,
      maxOutputTokens: model?.maxOutputTokens ?? 0,
      promptTokens: 0,
      toolTokens,
    });
    const memoryIndex = this.memory.indexNote();
    const system = buildSystemPrompt({
      workspace: doc.thread.cwd ?? '',
      contract: doc.state.contract,
      plan: doc.state.plan.map((step) => `- [${step.status}] ${step.title}`).join('\n'),
      memoryIndex,
      resolution: doc.state.resolution,
      verification: doc.view.verification(),
      toolList,
      step: doc.turn?.step ?? 1,
      budget: budget.historyLimit,
      compacted: doc.state.context.compacted > 0,
    });
    return { parts: promptParts({ system, memoryIndex, toolList, toolTokens }), budget };
  }

  private gauge(doc: ThreadDoc, assembly?: Assembly): ContextGauge {
    if (!assembly) {
      const cached = this.lastGauges.get(doc.thread.id);
      if (cached) return cached;
    }
    const model = this.deps.store.activeModel();
    const window = assembly?.budget.window ?? model?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const messages: ChatMessage[] = assembly
      ? [{ role: 'system', content: assembly.system }, ...assembly.messages]
      : [];
    // The prefix is billed in three parts that the assembler already measured;
    // history and this turn's trace follow. Together they are the used prompt.
    const parts: ContextPart[] = assembly
      ? [
          { id: 'system', tokens: assembly.parts.system },
          { id: 'tools', tokens: assembly.parts.tools },
          { id: 'memory', tokens: assembly.parts.memory },
          { id: 'history', tokens: assembly.historyTokens },
          { id: 'working', tokens: assembly.observationTokens },
        ]
      : [];
    const gauge = gaugeOf({
      messages,
      budget: window,
      compacted: assembly ? Object.values(assembly.levels).filter((level) => level >= 2).length : doc.state.context.compacted,
      memoryFacts: this.memory.activeCount(),
      evidence: doc.state.evidence.length,
      toolCalls: doc.items.filter((item) => item.kind === 'tool_call').length,
      window,
      ...(assembly
        ? { outputReserve: assembly.budget.outputReserve, safetyMargin: assembly.budget.safetyMargin }
        : {}),
      ...(parts.length > 0 ? { parts } : {}),
    });
    this.lastGauges.set(doc.thread.id, gauge);
    return gauge;
  }

  /** One ledger line per model call, priced per workspace and Beijing day. */
  private async recordUsage(
    doc: ThreadDoc,
    turn: Turn,
    workspace: string,
    kind: 'chat' | 'context_compress' | 'consolidate',
    usage: { promptTokens: number; completionTokens: number; cachedTokens?: number },
  ): Promise<void> {
    doc.thread.totalTokens += usage.promptTokens + usage.completionTokens;
    await this.deps.store.usage
      .append({
        dayKey: localDayKey(),
        workspace: normalizeWorkspace(workspace || doc.thread.cwd),
        sid: doc.thread.id,
        turn: turn.index,
        kind,
        input: usage.promptTokens,
        output: usage.completionTokens,
        ...(usage.cachedTokens ? { cachedRead: usage.cachedTokens } : {}),
      })
      .catch(() => undefined);
  }

  private consolidationTimer: NodeJS.Timeout | null = null;
  private lastTriggerDay = '';

  /** Tick once a minute; fire the nightly pass at 01:19 Beijing time. */
  startConsolidationScheduler(): void {
    if (this.consolidationTimer) return;
    this.consolidationTimer = setInterval(() => {
      if (!isConsolidationMinute()) return;
      const dayKey = beijingParts().dayKey;
      if (this.lastTriggerDay === dayKey) return;
      this.lastTriggerDay = dayKey;
      // Just after midnight: process every day older than today.
      void this.consolidation.sweep().catch(() => undefined);
    }, 60_000);
    this.consolidationTimer.unref?.();
  }

  stopConsolidationScheduler(): void {
    if (this.consolidationTimer) clearInterval(this.consolidationTimer);
    this.consolidationTimer = null;
  }

  /** Boot catch-up: after 01:19 the missed pass runs (idempotent per day). */
  catchUpConsolidation(): void {
    if (!pastConsolidationTime()) return;
    void this.consolidation.sweep().catch(() => undefined);
  }

  /**
   * Exit path. It only writes pending marks — no network, no model — because
   * quitting must stay reliable. The next boot or the 01:19 tick finishes the
   * job, and the pending queue is the hand-off.
   */
  async consolidateOnExit(): Promise<void> {
    this.stopConsolidationScheduler();
    await this.markPendingAtExit('exit').catch(() => undefined);
    for (const doc of this.deps.store.docs.values()) {
      await doc.log.flush().catch(() => undefined);
    }
  }

  /** Record, per session, the Beijing day its last turn belongs to. */
  private async markPendingAtExit(reason: 'exit' | 'crash'): Promise<void> {
    const seen = new Set<string>();
    for (const doc of this.deps.store.docs.values()) {
      seen.add(doc.thread.id);
      await this.markPending(doc.log, reason);
    }
    for (const entry of this.deps.store.sessions.list()) {
      if (seen.has(entry.sid)) continue;
      const log = await SessionLog.open(this.deps.home, entry.sid, { write: false });
      if (!log) continue;
      await this.markPending(log, reason);
    }
  }

  private async markPending(log: SessionLog, reason: 'exit' | 'crash' | 'manual'): Promise<void> {
    const last = [...log.turnEntries()].reverse().find((turn) => turn.status !== 'running');
    if (!last) return;
    const dayKey = localDayKey(last.endedAt ?? last.startedAt);
    await this.consolidation.markPending({
      workspace: normalizeWorkspace(log.meta.workspace),
      dayKey,
      sid: log.sid,
      lastSeq: log.lastSeq,
      markedAt: Date.now(),
      reason,
    });
  }

  /** Persist interrupted turns in the ledger and leave a pending mark. */
  async recordInterruptedTurns(): Promise<void> {
    for (const doc of this.deps.store.docs.values()) {
      if (doc.thread.status !== 'running' && doc.thread.status !== 'waiting_approval') continue;
      await this.deps.store.settleLog(doc.log).catch(() => undefined);
      await this.markPending(doc.log, 'crash');
    }
    await this.deps.store.recoverInterrupted().catch(() => undefined);
  }

  /**
   * Distil one day, per workspace. The 50M gate, the daily call limit and
   * idempotency live in `ConsolidationService`; this method is the agent-facing
   * entry point used by the scheduler, the boot catch-up and the manual button.
   */
  async consolidateDay(dayKey: string): Promise<ConsolidationReport> {
    const report: ConsolidationReport = { dayKey, considered: 0, consolidated: [], skipped: [], written: 0 };
    for (const workspace of this.deps.store.trackedWorkspaces()) {
      report.considered += 1;
      const result = await this.consolidation.runDay(workspace, dayKey).catch(
        (error: Error) =>
          ({ workspace, dayKey, status: 'failed' as const, tokens: 0, written: 0, reason: error.message }),
      );
      if (result.status === 'done') {
        report.consolidated.push(`${result.workspace}@${result.dayKey}`);
        report.written += result.written;
      } else {
        report.skipped.push({ workspace: result.workspace, tokens: result.tokens, reason: result.reason ?? result.status });
      }
    }
    if (report.written > 0) {
      this.deps.emit({ type: 'memory/updated', threadId: '', facts: memoryFacts(this.memory.all()) });
    }
    return report;
  }

  /** What the settings panel shows: today's spend, pending marks, gate reasons. */
  async consolidationStatus(): Promise<{
    dayKey: string;
    threshold: number;
    todayTokens: number;
    pending: Array<{ workspace: string; dayKey: string; sid: string; reason: string }>;
    days: Array<{ workspace: string; dayKey: string; status: string; tokens: number; reason?: string; completedAt?: number }>;
  }> {
    const today = localDayKey();
    const state = await this.consolidation.allState();
    const pending = await this.consolidation.pending();
    let todayTokens = 0;
    for (const workspace of this.deps.store.trackedWorkspaces()) {
      todayTokens += (await this.deps.store.usage.totals(workspace, today)).billable;
    }
    return {
      dayKey: today,
      threshold: CONSOLIDATION_TOKEN_THRESHOLD,
      todayTokens,
      pending: pending.map((mark) => ({ workspace: mark.workspace, dayKey: mark.dayKey, sid: mark.sid, reason: mark.reason })),
      days: Object.entries(state).map(([key, record]) => {
        const [workspace, dayKey] = key.split('::');
        return {
          workspace,
          dayKey,
          status: record.status,
          tokens: record.tokens,
          ...(record.lastError ? { reason: record.lastError } : {}),
          ...(record.completedAt ? { completedAt: record.completedAt } : {}),
        };
      }),
    };
  }

private async prepareCall(
    doc: ThreadDoc,
    turn: Turn,
    call: ToolCall,
    step: number,
    reasoning: string | undefined,
    signal: AbortSignal,
  ): Promise<PreparedCall | null> {
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
      await this.recordToolCall(doc, turn, call, step, callItem, callItem.summary);
      doc.items.push(callItem);
      this.emitItem(callItem);
      await this.pushResult(doc, turn, call, failure, 0, undefined);
      return null;
    }

    const parsed = parseArguments(tool.name, call.function.arguments);
    if (!parsed.ok) {
      callItem.status = 'error';
      callItem.summary = parsed.summary;
      await this.recordToolCall(doc, turn, call, step, callItem, parsed.summary);
      doc.items.push(callItem);
      this.emitItem(callItem);
      await this.pushResult(doc, turn, call, parsed, 0, undefined);
      return null;
    }

    callItem.args = parsed.args;
    callItem.summary = summarizeCall(tool, parsed.args);
    // The call is on disk before the tool touches anything: a crash here is a
    // recoverable "unpaired call", not an invisible action.
    await this.recordToolCall(doc, turn, call, step, callItem, callItem.summary);
    doc.items.push(callItem);
    this.emitItem(callItem);

    return {
      tool,
      args: parsed.args,
      callItem,
      context: this.toolContext(doc, turn, step, signal),
      schemaRetries: schemaRetriesLeft(this.ledger, call.id),
    };
  }

  /** Append the `tool_call` event (arguments may be a handle, never the raw blob). */
  private async recordToolCall(
    doc: ThreadDoc,
    turn: Turn,
    call: ToolCall,
    step: number,
    item: ToolCallItem,
    summary: string,
  ): Promise<void> {
    const raw = JSON.stringify(item.args ?? {});
    const args = await this.argsRef(doc, call.function.name, call.id, step, raw);
    const target = typeof item.args?.path === 'string' ? item.args.path : undefined;
    await doc.log
      .append({
        type: 'tool_call',
        callId: call.id,
        name: call.function.name,
        args,
        risk: item.risk,
        phase: 'started',
        summary,
        ...(target ? { target } : {}),
        turn: turn.index,
        step,
        itemId: item.id,
      })
      .catch(() => undefined);
  }

  private async finishCall(
    doc: ThreadDoc,
    turn: Turn,
    call: ToolCall,
    prepared: PreparedCall,
    outcome: ToolOutcome,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const { tool, callItem, schemaRetries } = prepared;

    if (signal.aborted) {
      callItem.status = 'cancelled';
      callItem.summary = '已停止';
      this.emitItem(callItem);
      await this.pushResult(
        doc,
        turn,
        call,
        { ok: false, layer: 'none', summary: '已停止', detail: '用户停止了本轮。', hint: '', retryable: false },
        durationMs,
        tool,
        'cancelled',
      );
      return false;
    }

    if (!outcome.ok && outcome.layer === 'L2-schema') {
      noteAttempt(this.ledger, call.id);
      if (schemaRetries === 0) {
        callItem.status = 'error';
        callItem.summary = `${outcome.summary} · retry budget exhausted`;
        this.emitItem(callItem);
        await this.pushResult(doc, turn, call, { ...outcome, hint: `${outcome.hint}\n\nThe schema retry budget is exhausted. Ask the user or switch tools.` }, durationMs, undefined);
        return false;
      }
    }

    callItem.status = outcome.ok ? 'done' : 'error';
    if (!outcome.ok) callItem.summary = outcome.summary;
    this.emitItem(callItem);
    await this.pushResult(doc, turn, call, outcome, durationMs, tool);
    return outcome.ok && prepared.tool.mutating;
  }

  private async executeTool(
    doc: ThreadDoc,
    turn: Turn,
    call: ToolCall,
    step: number,
    reasoning: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    const prepared = await this.prepareCall(doc, turn, call, step, reasoning, signal);
    if (!prepared) return false;
    const started = Date.now();
    const outcome = await this.invoke(doc, turn, prepared.tool, prepared.args, prepared.context, call.id);
    const mutated = await this.finishCall(doc, turn, call, prepared, outcome, Date.now() - started, signal);
    await this.deps.store.save(doc.thread.id);
    return mutated;
  }

  /**
   * Run a batch of read-only calls together. Calls are recorded in call order
   * before any of them runs, so the transcript reads the same as a serial run;
   * results are finalized in order too, even if they finish out of order.
   */
  private async executeToolGroup(
    doc: ThreadDoc,
    turn: Turn,
    calls: ToolCall[],
    step: number,
    reasoning: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> {
    const prepared: Array<{ call: ToolCall; prep: PreparedCall }> = [];
    for (const call of calls) {
      const prep = await this.prepareCall(doc, turn, call, step, reasoning, signal);
      if (prep) prepared.push({ call, prep });
    }
    if (prepared.length === 0) return false;

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

    let mutated = false;
    for (const entry of settled) {
      mutated = (await this.finishCall(doc, turn, entry.call, entry.prep, entry.outcome, entry.durationMs, signal)) || mutated;
    }
    await this.deps.store.save(doc.thread.id);
    return mutated;
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
        await doc.log
          .append({
            type: 'approval',
            callId: approval.callId,
            name,
            command,
            reason,
            turn: turn.index,
            step,
            itemId: item.id,
          })
          .catch(() => undefined);
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
        await doc.log
          .append({
            type: 'approval',
            callId: approval.callId,
            name,
            command,
            reason,
            decision,
            turn: turn.index,
            step,
            itemId: item.id,
          })
          .catch(() => undefined);
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
        await doc.log
          .append({
            type: 'question',
            questionId: id,
            header,
            question,
            options,
            turn: turn.index,
            step,
            itemId: id,
          })
          .catch(() => undefined);
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
        await doc.log
          .append({
            type: 'question',
            questionId: id,
            header,
            question,
            options,
            ...(answer.answer ? { answer: answer.answer } : {}),
            turn: turn.index,
            step,
            itemId: id,
          })
          .catch(() => undefined);
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
      readHandle: async (handle, offset, limit) => {
        const read = await doc.log.handles.read(handle, {
          turn: doc.log.activeTurn,
          ...(offset !== undefined ? { offset } : {}),
          ...(limit !== undefined ? { limit } : {}),
        });
        if (!read.record || read.expired) {
          return domainFailure(
            read.reason ?? 'handle 不存在',
            'Elided content can expire. Read the file again with read_file — that is the current truth.',
            read.text,
          );
        }
        if (!read.text) {
          return domainFailure(read.reason ?? '这次取回没有内容', 'The per-turn fetch budget is spent. Continue with what you have, or fetch it next turn.', '');
        }
        const head = read.text;
        doc.state.evidence.push(`handle:${handle}`);
        return {
          ok: true,
          summary: `read ${handle} · ${read.tokens} tokens${read.truncated ? ` · ${read.total} chars total` : ''}`,
          output: `${head}${read.truncated ? `\n\n… (${read.total - read.offset - head.length} more characters; continue with offset ${read.offset + head.length})` : ''}`,
          files: [],
        };
      },
      expandTurn: async (turnNumber, mode) => {
        const entries = doc.log.turnEntries();
        const entry = entries.find((candidate) => candidate.turn === turnNumber);
        if (!entry) {
          return domainFailure(`第 ${turnNumber} 轮不存在`, `This session has turns 1–${entries.at(-1)?.turn ?? 0}.`);
        }
        const digest = await this.compressorFor(doc).ensure(turnNumber, {
          contextWindow: this.deps.store.activeModel()?.contextWindow || DEFAULT_CONTEXT_WINDOW,
        });
        if (mode === 'summary') {
          if (!digest) return domainFailure('这一轮没有摘要', 'It has no events yet — it may still be running.');
          return {
            ok: true,
            summary: `turn ${turnNumber} · L2 ${digest.degraded ? '(mechanical)' : ''}`.trim(),
            output: renderTurnDigest(digest.digest),
            files: [],
          };
        }
        const events = doc.log.eventsForTurn(turnNumber);
        const raw = events
          .map((event) => {
            if (event.type === 'turn_started') return `## 用户\n${event.userText}`;
            if (event.type === 'assistant_message') return `## assistant\n${event.text}`;
            if (event.type === 'tool_call') return `## 调用 ${event.name}\n${'text' in event.args ? event.args.text : event.args.preview}`;
            if (event.type === 'tool_result') return `## 结果 ${event.name} (${event.ok ? 'ok' : 'failed'})\n${'text' in event.content ? event.content.text : event.content.preview}`;
            return '';
          })
          .filter(Boolean)
          .join('\n\n');
        const budget = 4000;
        if (estimateTokens(raw) > budget) {
          const digestText = digest ? renderTurnDigest(digest.digest) : '';
          return {
            ok: true,
            summary: `turn ${turnNumber} · 原文超出预算，返回 L2 摘要`,
            output: `${digestText}\n\n(原文约 ${estimateTokens(raw)} tokens；本轮事件范围 ${entry.firstSeq}–${entry.lastSeq})`,
            files: [],
          };
        }
        return { ok: true, summary: `turn ${turnNumber} · raw`, output: raw, files: [] };
      },
      searchSession: async (query, limit) => {
        const hits = await new SessionSearch(doc.log).search(query, { limit });
        if (hits.length === 0) {
          return { ok: true, summary: '没有命中', output: `本会话里没有匹配「${query}」的轮次。`, files: [] };
        }
        const lines = hits.map(
          (hit) =>
            `- 第 ${hit.turn} 轮（${hit.kind === 'summary' ? 'L2 摘要' : '原始事件'}，${hit.score.toFixed(2)}）${hit.handle ? ` · ${hit.handle}` : ''}\n  ${hit.snippet.replace(/\s+/g, ' ')}`,
        );
        return {
          ok: true,
          summary: `${hits.length} 处命中 · ${query}`,
          output: lines.join('\n'),
          files: [],
        };
      },
      blobText: async (handle) => {
        const record = doc.log.handles.get(handle);
        if (!record || record.expired) return null;
        return doc.log.blobs.get(record.blob).catch(() => null);
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
        await doc.log
          .append({ type: 'plan_updated', steps, source: 'model', turn: turn.index, step, itemId: item.id })
          .catch(() => undefined);
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

  /** Schema validation, drift guard, locking and checkpoint for one call. */
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

    try {
      // Capture BEFORE the tool touches disk: a snapshot is the state to go
      // back to, and the change card's 撤销 restores it. The diff numbers are
      // filled in afterwards, once the step has actually run.
      const pre = await this.checkpoints.capture({
        threadId,
        step: turn.step,
        label: `${tool.name} ${target || tool.name}`,
        workspace: context.workspace,
        // A revert restores files and then appends `revert {toSeq}`; storing the
        // ledger position is what makes "the state before this step" replayable.
        state: { toSeq: doc.log.lastSeq, plan: doc.state.plan, contract: doc.state.contract, resolution: doc.state.resolution },
        filesTouched: target ? [target] : [],
      });

      const outcome = await tool.run(context, args);
      {
        const touched = (outcome.ok ? outcome.files : undefined) ?? (target ? [target] : []);
        if (outcome.ok && touched.length > 0) {
          const meta = (await this.checkpoints.restat(threadId, pre.id, context.workspace)) ?? pre;
          doc.snapshots = [...doc.snapshots.filter((snapshot) => snapshot.id !== meta.id), meta];
          doc.view.setSnapshots(doc.snapshots);
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
          await doc.log
            .append({
              type: 'checkpoint',
              snapshot: meta,
              turn: turn.index,
              step: turn.step,
              itemId: item.id,
            })
            .catch(() => undefined);
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
        state: { toSeq: doc.log.lastSeq },
        filesTouched: [],
      });
      doc.snapshots = [...doc.snapshots.filter((entry) => entry.id !== pre.id), pre];
      doc.view.setSnapshots(doc.snapshots);
    } catch {
      // if the pre-snapshot fails, still prefer a correct revert
    }

    const result = await this.checkpoints.revert(threadId, snapshotId, tree);
    if (!result.ok) return { ok: false, message: result.message };

    const restored = result.state as { toSeq?: number } | null;
    const toSeq = typeof restored?.toSeq === 'number' ? restored.toSeq : doc.log.lastSeq;
    const revertedTurns = [
      ...new Set(
        doc.log
          .activeEvents()
          .filter((event) => event.seq > toSeq && event.turn > 0)
          .map((event) => event.turn),
      ),
    ];

    // Events are never deleted: a revert appends a marker and moves to a new
    // epoch. The active view is current epoch + ancestors up to their cut.
    const revertEvent = await doc.log.revertTo(toSeq, `回退到 ${snapshotId}`);
    const projected = doc.view.project();
    doc.items = projected.items;
    doc.turn = projected.turn;
    doc.state.plan = projected.plan;
    doc.state.contract = projected.contract;
    doc.state.resolution = projected.resolution;
    doc.state.evidence = projected.evidence;
    doc.thread.status = 'idle';
    if (revertedTurns.length > 0) {
      await this.memory.markSourceReverted(threadId, Math.min(...revertedTurns)).catch(() => 0);
    }

    const snapshot = doc.snapshots.find((entry) => entry.id === snapshotId);
    await this.recordNotice(doc, {
      tone: 'warn',
      title: `已回退到 ${snapshotId}`,
      body: `${result.message}。第 ${toSeq} 条之后的事件保留在只读旧分支（epoch ${revertEvent.epoch - 1}），当前分支是 epoch ${revertEvent.epoch}；这次回退涉及的文件：${(snapshot?.files ?? []).slice(0, 8).join(', ') || '没有记录'}。没有新理由就别把这些改动再做一遍。`,
    });
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
  /**
   * The last tool result of a turn, when it failed. The loop can stop
   * "normally" right after an unresolved error, because the model answers
   * instead of retrying; that ending is a failure, not a completion.
   */
  private trailingFailure(doc: ThreadDoc, turn: Turn): ToolResultItem | null {
    const results = doc.items.filter(
      (item): item is ToolResultItem =>
        item.kind === 'tool_result' && item.turnId === turn.id && item.status !== 'cancelled',
    );
    const last = results.at(-1);
    return last && last.ok === false ? last : null;
  }

  private async closeRunningToolCalls(doc: ThreadDoc, turn: Turn, message: string, cancelled: boolean): Promise<void> {
    const answered = new Set(
      doc.items.filter((item): item is ToolResultItem => item.kind === 'tool_result').map((item) => item.callId),
    );
    for (const item of doc.items) {
      if (item.kind !== 'tool_call' || item.turnId !== turn.id || answered.has(item.callId)) continue;
      if (item.status === 'running') {
        item.status = cancelled ? 'cancelled' : 'error';
        this.emitItem(item);
      }
      await this.pushResult(
        doc,
        turn,
        { id: item.callId, type: 'function', function: { name: item.name, arguments: '{}' } },
        {
          ok: false,
          layer: 'none',
          summary: cancelled ? '已停止' : '工具没有返回结果',
          detail: cancelled ? '本轮已停止，工具没有返回结果。' : message,
          hint: '',
          retryable: false,
        },
        0,
        undefined,
        cancelled ? 'cancelled' : 'error',
      );
      answered.add(item.callId);
    }
  }

  private async pushResult(
    doc: ThreadDoc,
    turn: Turn,
    call: ToolCall,
    outcome: ToolOutcome,
    durationMs: number,
    tool: ToolDefinition | undefined,
    statusOverride?: ToolResultItem['status'],
  ): Promise<void> {
    const body = outcome.ok ? outcome.output : [outcome.detail, outcome.hint].filter(Boolean).join('\n\n');
    const name = tool?.name ?? call.function.name;
    // A result over 4k tokens is stored as a blob and represented by a handle;
    // the row keeps the preview so the UI can still show something useful.
    // The recovery tools are the exception: the model explicitly asked for this
    // text, and re-eliding it would hand back the same handle it just used.
    const keepInline = FETCH_TOOLS.has(name);
    const content: InlineRef | BlobRef = keepInline
      ? { text: body || outcome.summary, tokens: estimateTokens(body || outcome.summary) }
      : await this.refContent(doc, {
          kind: 'tool_result',
          text: body || outcome.summary,
          limit: TOOL_RESULT_TOKENS,
          step: turn.step,
          tool: name,
          callId: call.id,
        });
    const result: ToolResultItem = {
      id: uid('itm'),
      threadId: doc.thread.id,
      turnId: turn.id,
      kind: 'tool_result',
      at: Date.now(),
      status: statusOverride ?? (outcome.ok ? 'done' : 'error'),
      callId: call.id,
      name,
      ok: outcome.ok,
      summary: outcome.summary,
      output: 'text' in content ? content.text : content.preview,
      layer: outcome.ok ? 'none' : outcome.layer,
      retryable: outcome.ok ? false : outcome.retryable,
      ...(outcome.ok ? {} : { hint: outcome.hint }),
      ...(outcome.ok && outcome.files ? { files: outcome.files } : {}),
      ...(durationMs > 0 ? { durationMs } : {}),
      ...('blob' in content ? { elided: { handle: content.handle, tokens: content.tokens } } : {}),
    };
    await doc.log
      .append({
        type: 'tool_result',
        callId: call.id,
        name,
        ok: outcome.ok,
        content,
        phase: 'done',
        summary: outcome.summary,
        ...(outcome.ok && outcome.files ? { files: outcome.files } : {}),
        layer: result.layer,
        ...(outcome.ok ? {} : { hint: outcome.hint, retryable: outcome.retryable }),
        ...(durationMs > 0 ? { durationMs } : {}),
        turn: turn.index,
        step: turn.step,
        itemId: result.id,
      })
      .catch(() => undefined);
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

export { clamp };

