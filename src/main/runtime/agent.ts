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
  MemoryFact,
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
import { applyClaim, type MemoryRecord, type MemoryScope } from './memory.js';
import { extractEvents, mergeResolution, parseRelativeTime, resolveEntities } from './resolve.js';
import { audits } from '../audit.js';
import {
  auditClaims,
  buildSystemPrompt,
  foldItems,
  gaugeOf,
  mechanicalSummary,
  shouldCompact,
  SUMMARY_PROMPT,
  toMessages,
} from './context.js';
import { complete, LlmError, type ChatMessage, type ToolCall } from './llm.js';
import { committed, failed, intent, orphanIntents, reconcile, type JournalRecord, type ReconcileOutcome } from './journal.js';
import { classifyCommand, autoDecision } from './policy.js';
import { toolByName, toolSpecs, tools, type ToolExecContext, type ToolDefinition } from './tools.js';
import { noteAttempt, parseArguments, readDomainFailure, schemaRetriesLeft, validateArgs, type RetryLedger, type ToolFailure } from './toolerrors.js';
import { fileFingerprint } from '../fingerprint.js';
import { clamp, estimateTokens, formatDuration, resolveInside, stableStringify, truncate, uid } from '../util.js';

export interface AgentDeps {
  store: Store;
  emit: (event: RuntimeEvent) => void;
  home: string;
}

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
}

interface PendingQuestion {
  threadId: string;
  resolve: (answer: { answer: string; cancelled: boolean }) => void;
}

/**
 * The turn engine.
 *
 * A turn is a bounded loop: assemble context → call the model → execute tool
 * calls under locks/journal/approval → checkpoint → repeat until the model stops
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

  constructor(private readonly deps: AgentDeps) {
    this.locks = new LockTable(join(deps.home, 'leases.json'));
    this.checkpoints = new Checkpoints(join(deps.home, 'snapshots'));
  }

  async init(): Promise<void> {
    await this.locks.load();
    if (this.locks.droppedOnLoad > 0) {
      this.emitNotice(null, {
        tone: 'warn',
        title: `${this.locks.droppedOnLoad} stale lock${this.locks.droppedOnLoad === 1 ? '' : 's'} released`,
        body: 'A previous run crashed while holding a lease. Its targets will be re-read before the next write instead of being retried blindly.',
      });
    }
    await this.recoverInterrupted();
  }

  /**
   * A turn that was still running when the app quit stays `running` on disk. On
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

  private emitContext(threadId: string, doc: ThreadDoc): void {
    const messages = toMessages(doc.items.slice(doc.state.context.foldedItems), doc.state.context.summary);
    const gauge: ContextGauge = gaugeOf({
      messages,
      budget: this.deps.store.activeModel()?.contextWindow ?? 131_072,
      compacted: doc.state.context.compacted,
      memory: doc.state.memory,
      evidence: doc.state.evidence.length,
      toolCalls: doc.items.filter((item) => item.kind === 'tool_call').length,
    });
    doc.state.context.tokensUsed = gauge.tokensUsed;
    this.deps.emit({ type: 'runtime/updated', runtime: this.status(threadId, 'thinking', `${gauge.tokensUsed} tokens in context`), context: gauge });
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
      const entities = resolveEntities(prompt, doc.state.memory);
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

      // 3. Reconcile journal entries orphaned by a previous crash.
      const orphans = orphanIntents(doc.state.journal);
      for (const orphan of orphans) {
        const current: Record<string, string> = {};
        for (const path of Object.keys(orphan.before)) current[path] = await fileFingerprint(path);
        const verdict = reconcile(orphan, current);
        doc.state.journal.push({
          ...orphan,
          id: `${orphan.idempotencyKey}:reconciled`,
          phase: 'reconciled',
          note: `${verdict.outcome}: ${verdict.detail}`,
          at: Date.now(),
        });
        push<NoticeItem>({
          id: uid('itm'),
          threadId,
          turnId: turn.id,
          kind: 'notice',
          at: Date.now(),
          status: 'done',
          tone: verdict.outcome === 'unknown' ? 'warn' : 'info',
          title: `已对账中断的步骤 ${orphan.step}（${orphan.tool}）`,
          body: `${OUTCOME_LABEL[verdict.outcome]} — ${verdict.detail}。没有自动重试。`,
        });
      }

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

      while (true) {
        step += 1;
        turn.step = step;
        doc.thread.steps += 1;
        if (controller.signal.aborted) {
          stopReason = 'cancelled by the user';
          break;
        }

        // 4. Context assembly + compaction. The context window covers prompt +
        // completion, so keep room for the configured max output instead of
        // filling the whole window with messages. Unknown metadata falls back
        // to a conservative internal budget; it is not shown as model metadata.
        let messages = this.messagesFor(doc);
        const contextBudget = model.contextWindow > 0 ? model.contextWindow : 131_072;
        const outputReserve = model.maxOutputTokens > 0 ? model.maxOutputTokens : 0;
        const budget = Math.max(4096, contextBudget - outputReserve);
        if (shouldCompact(estimateTokens(JSON.stringify(messages)), budget)) {
          this.deps.emit({ type: 'runtime/updated', runtime: this.status(threadId, 'compacting', 'folding older steps'), context: this.gauge(doc) });
          const folded = await this.compact(doc, turn, messages);
          if (folded) messages = this.messagesFor(doc);
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

        const modelMessages: ChatMessage[] = [
          {
            role: 'system',
            content: buildSystemPrompt({
              workspace: doc.thread.cwd,
              contract: doc.state.contract,
              memory: doc.state.memory,
              resolution: doc.state.resolution,
              plan: doc.state.plan.map((s) => `- [${s.status}] ${s.title}`).join('\n'),
              verification: await this.verification(doc),
              toolList: tools.map((tool) => `- ${tool.name} (${tool.risk}) — ${tool.summary} Use when: ${tool.useWhen} Do NOT use: ${tool.avoidWhen}`).join('\n'),
              step,
              budget,
              compacted: doc.state.context.compacted > 0,
            }),
          },
          ...messages,
        ];

        // 6. Model call, streamed into one assistant item.
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

        // 7. Tool execution, one call at a time (mutating calls are serialized).
        for (const call of result.toolCalls) {
          if (controller.signal.aborted) {
            stopReason = 'cancelled by the user';
            break;
          }
          await this.executeTool(doc, turn, call, step, result.reasoning, controller.signal);
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
      this.running.delete(threadId);
      this.controllers.delete(threadId);
      await this.locks.releaseAll(`thread:${threadId}`);
      doc.state.context.tokensUsed = this.gauge(doc).tokensUsed;
      await this.deps.store.saveNow(threadId);
    }
  }

  private gauge(doc: ThreadDoc): ContextGauge {
    const messages = toMessages(doc.items.slice(doc.state.context.foldedItems), doc.state.context.summary);
    return gaugeOf({
      messages,
      budget: this.deps.store.activeModel()?.contextWindow ?? 131_072,
      compacted: doc.state.context.compacted,
      memory: doc.state.memory,
      evidence: doc.state.evidence.length,
      toolCalls: doc.items.filter((item) => item.kind === 'tool_call').length,
    });
  }

  private messagesFor(doc: ThreadDoc): ChatMessage[] {
    return toMessages(doc.items.slice(doc.state.context.foldedItems), doc.state.context.summary, doc.state.context.thinking === true);
  }

  /** Fold older items into a summary; falls back to a mechanical digest when the model is unavailable. */
  private async compact(doc: ThreadDoc, turn: Turn, messages: ChatMessage[]): Promise<boolean> {
    const before = doc.state.context.tokensUsed || estimateTokens(JSON.stringify(messages));
    const items = doc.items;
    const foldable = Math.max(0, items.length - (items.length - doc.state.context.foldedItems) % 0 - 0);
    const boundary = Math.max(doc.state.context.foldedItems, items.length - 12);
    const slice = items.slice(0, boundary);
    if (slice.length === doc.state.context.foldedItems) return false;

    const foldedText = slice
      .slice(doc.state.context.foldedItems)
      .map((item) => {
        if (item.kind === 'message') return `${item.role}: ${truncate(item.text, 500)}`;
        if (item.kind === 'tool_call') return `tool ${item.name}(${truncate(JSON.stringify(item.args), 200)})`;
        if (item.kind === 'tool_result') return `result ${item.ok ? 'ok' : 'failed'}: ${truncate(item.summary, 200)}`;
        if (item.kind === 'checkpoint') return `checkpoint ${item.step}: ${item.label}`;
        return '';
      })
      .filter(Boolean)
      .join('\n');

    let summary: string;
    try {
      const active = this.deps.store.activeModel();
      if (!active) return false;
      const response = await complete(active, [
        { role: 'system', content: SUMMARY_PROMPT },
        { role: 'user', content: `${doc.state.context.summary ? `Existing summary:\n${doc.state.context.summary}\n\n` : ''}Fold these steps:\n${foldedText}` },
      ], { tools: [], retries: 0 });
      summary = response.content.trim() || mechanicalSummary(slice);
    } catch {
      summary = mechanicalSummary(slice);
    }

    doc.state.context.summary = summary;
    doc.state.context.foldedItems = boundary;
    doc.state.context.compacted += 1;
    const after = estimateTokens(JSON.stringify(toMessages(items.slice(boundary), summary)));
    doc.state.context.tokensUsed = after;

    const compaction: CompactionItem = {
      id: uid('itm'),
      threadId: doc.thread.id,
      turnId: turn.id,
      kind: 'compaction',
      at: Date.now(),
      status: 'done',
      tokensBefore: before,
      tokensAfter: after,
      foldedItems: boundary,
      keptItems: items.length - boundary,
      summary,
    };
    doc.items.push(compaction);
    this.emitItem(compaction);
    void foldable;
    return true;
  }

  /** Ground-truth verification: what actually changed on disk, not what the model said. */
  private async verification(doc: ThreadDoc): Promise<string> {
    const lines: string[] = [];
    const committedSteps = doc.state.journal.filter((record) => record.phase === 'committed');
    if (committedSteps.length > 0) {
      lines.push(`${committedSteps.length} write steps committed; last: ${committedSteps.at(-1)?.summary ?? ''}`);
    }
    const shellResults = doc.items.filter((item): item is ToolResultItem => item.kind === 'tool_result' && item.name === 'run_shell');
    for (const result of shellResults.slice(-2)) {
      lines.push(`last shell: ${result.summary} (${result.ok ? 'green' : 'red'})`);
    }
    const latest = doc.snapshots.at(-1);
    if (latest) {
      lines.push(`checkpoint ${latest.id} holds ${latest.files.length} files, ${Math.round(latest.sizeBytes / 1024)} KB`);
    }
    const audited = audits(doc);
    lines.push(...audited);
    return lines.join('\n');
  }

  private async executeTool(doc: ThreadDoc, turn: Turn, call: ToolCall, step: number, reasoning: string | undefined, signal: AbortSignal): Promise<void> {
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
      return;
    }

    const parsed = parseArguments(tool.name, call.function.arguments);
    if (!parsed.ok) {
      callItem.status = 'error';
      callItem.summary = parsed.summary;
      this.emitItem(callItem);
      this.pushResult(doc, turn, call, parsed, 0, undefined);
      return;
    }

    callItem.args = parsed.args;
    callItem.summary = summarizeCall(tool, parsed.args);
    this.emitItem(callItem);

    const schemaRetries = schemaRetriesLeft(this.ledger, call.id);
    const context = this.toolContext(doc, turn, step, signal);

    const started = Date.now();
    const outcome = await this.invoke(doc, turn, tool, parsed.args, context, call.id);
    const durationMs = Date.now() - started;

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
    await this.deps.store.save(threadId);
  }

  private toolContext(doc: ThreadDoc, turn: Turn, step: number, signal: AbortSignal): ToolExecContext {
    const threadId = doc.thread.id;
    return {
      threadId: doc.thread.id,
      turnId: turn.id,
      workspace: doc.thread.cwd,
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
      approve: async ({ name, command, reason: rawReason, risk }) => {
        if (signal.aborted) return 'deny';
        const policy = this.deps.store.getSettings().approval;
        const outcome = autoDecision(policy, command);
        // 完全访问 / 自动审批放行的命令：nothing waits. The journal still records it.
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
      remember: async ({ slot, value, scope }) => {
        const result = applyClaim(doc.state.memory, { slot, value, scope: scope as MemoryScope, source: `turn ${turn.index}` });
        doc.state.memory = result.records;
        this.deps.emit({ type: 'memory/updated', threadId, facts: factsOf(doc.state.memory) });
        return { kind: result.kind, note: result.note };
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
    };
  }

  /** Schema validation, drift guard, locking, journal and checkpoint for one call. */
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
    const lockKey = target ? resolve(context.workspace, target) : `exec:${tool.name}`;
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

    const idempotencyKey = `${callId}:${stableStringify(args).length}:${hashText(stableStringify(args))}`;
    const record = intent({
      step: turn.step,
      callId,
      tool: tool.name,
      idempotencyKey,
      before: target ? { [lockKey]: fingerprint } : {},
      summary: summarizeCall(tool, args),
    });
    doc.state.journal.push(record);

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
        const after = target ? await fileFingerprint(lockKey) : 'n/a';
        doc.state.journal.push(committed(record, target ? { [lockKey]: after } : {}, outcome.ok ? outcome.summary : 'failed'));
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
      doc.state.journal.push(failed(record, (error as Error).message));
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
    return this.checkpoints.preview(threadId, snapshotId, doc.thread.cwd);
  }

  async revert(threadId: string, snapshotId: string): Promise<{ ok: boolean; message: string; undoSnapshotId?: string }> {
    const doc = await this.deps.store.load(threadId);
    if (!doc) return { ok: false, message: 'unknown session' };
    if (this.running.has(threadId)) return { ok: false, message: 'stop the running turn before reverting' };

    // Snapshot the current state first: a revert should be undoable too.
    const undoId = `undo-${Date.now().toString(36)}`;
    try {
      const pre = await this.checkpoints.capture({
        threadId,
        id: undoId,
        step: 0,
        label: '回退前',
        workspace: doc.thread.cwd,
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

    const result = await this.checkpoints.revert(threadId, snapshotId, doc.thread.cwd);
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
    doc.state.journal = doc.state.journal.filter((record) => record.phase !== 'intent');
    this.emitItem(notice);
    this.emitThread(doc.thread);
    await this.deps.store.saveNow(threadId);
    return { ok: true, message: result.message, undoSnapshotId: undoId };
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

const OUTCOME_LABEL: Record<ReconcileOutcome, string> = {
  applied: '已落地',
  'not-applied': '未落地',
  unknown: '无法判定',
};

/** Memory records carry structure; the wire type is the flattened view. */
function factsOf(records: MemoryRecord[]): MemoryFact[] {
  return records.map((record) => ({
    slot: record.slot,
    value: record.value,
    scope: record.scope.kind === 'path' ? `path:${record.scope.path}` : record.scope.kind,
    source: record.source,
    updatedAt: record.updatedAt,
    supersededBy: record.supersededBy,
    conflicts: record.status === 'disputed' ? 1 : 0,
  }));
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function summarizeCall(tool: ToolDefinition, args: Record<string, unknown>): string {
  if (tool.name === 'run_shell') return truncate(String(args.command ?? ''), 120);
  if (tool.name === 'ask_user') return truncate(String(args.question ?? ''), 120);
  if (typeof args.path === 'string') return `${tool.name} ${args.path}`;
  if (typeof args.pattern === 'string') return `${tool.name} /${args.pattern}/`;
  if (tool.name === 'todo_write') return 'plan updated';
  if (tool.name === 'memory_write') return `remember ${args.slot}`;
  return tool.summary;
}

export { clamp };

