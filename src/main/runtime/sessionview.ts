import type {
  ApprovalItem,
  CheckpointItem,
  CompactionItem,
  Item,
  MessageItem,
  NoticeItem,
  PlanStep,
  QuestionItem,
  SnapshotMeta,
  Thread,
  ToolCallItem,
  ToolResultItem,
  Turn,
} from '../../shared/types.js';
import { audits } from '../audit.js';
import type { Contract } from './contract.js';
import { emptyResolution, mergeResolution, type ResolutionState } from './resolve.js';
import type { SessionEvent } from './events.js';
import type { SessionIndexEntry, SessionLog } from './sessionlog.js';

/**
 * Derived views over the ledger.
 *
 * Two consumers share one truth: the model sees context assembled from events
 * (see `assembler.ts`), and the interface sees the same events projected into
 * the row shapes it already draws. Neither reads `events.jsonl` directly, and
 * neither is authoritative — deleting every derived file and replaying the log
 * reproduces both.
 */

export interface SessionSnapshotProvider {
  list(): SnapshotMeta[];
}

export interface ProjectedSession {
  thread: Thread;
  turn: Turn | null;
  items: Item[];
  contract: Contract | null;
  plan: PlanStep[];
  resolution: ResolutionState;
  evidence: string[];
  lastSeq: number;
}

const itemIdFor = (event: SessionEvent): string => event.itemId ?? `itm_${event.sid}_${event.seq}`;

const asRecord = (text: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Events → the row list the renderer already knows how to draw. */
export function projectItems(thread: Thread, events: readonly SessionEvent[]): Item[] {
  const items: Item[] = [];
  const turnIds = new Map<number, string>();
  for (const event of events) {
    if (event.type === 'turn_started') turnIds.set(event.turn, event.turnId);
  }

  for (const event of events) {
    const base = {
      id: itemIdFor(event),
      threadId: thread.id,
      turnId: turnIds.get(event.turn) ?? `turn_${event.turn}`,
      at: event.ts,
    };
    switch (event.type) {
      case 'turn_started':
        items.push({
          ...base,
          kind: 'message',
          status: 'done',
          role: 'user',
          text: event.userText,
        } satisfies MessageItem);
        break;
      case 'assistant_message': {
        const reasoning = event.reasoning && 'text' in event.reasoning ? event.reasoning.text : undefined;
        items.push({
          ...base,
          kind: 'message',
          status: 'done',
          role: 'assistant',
          text: event.text,
          ...(reasoning ? { reasoning } : {}),
        } satisfies MessageItem);
        if (reasoning && reasoning.trim() && event.text.trim()) {
          items.push({
            id: `${base.id}_r`,
            threadId: thread.id,
            turnId: base.turnId,
            at: base.at,
            kind: 'reasoning',
            status: 'done',
            text: reasoning,
          });
        }
        break;
      }
      case 'tool_call':
        items.push({
          ...base,
          kind: 'tool_call',
          status: 'done',
          callId: event.callId,
          name: event.name,
          args: 'text' in event.args ? asRecord(event.args.text) : {},
          summary: event.summary ?? `${event.name} ${event.target ?? ''}`.trim(),
          risk: event.risk,
        } satisfies ToolCallItem);
        break;
      case 'tool_result': {
        const body = 'text' in event.content ? event.content.text : event.content.preview;
        items.push({
          ...base,
          kind: 'tool_result',
          status: event.ok ? 'done' : 'error',
          callId: event.callId,
          name: event.name,
          ok: event.ok,
          summary: event.summary,
          output: body,
          layer: (event.layer as ToolResultItem['layer']) ?? 'none',
          retryable: event.retryable ?? false,
          ...(event.hint ? { hint: event.hint } : {}),
          ...(event.files ? { files: event.files } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...('blob' in event.content ? { elided: { handle: event.content.handle, tokens: event.content.tokens } } : {}),
        } satisfies ToolResultItem);
        break;
      }
      case 'notice':
        items.push({
          ...base,
          kind: 'notice',
          status: 'done',
          tone: event.tone,
          title: event.title,
          body: event.body,
        } satisfies NoticeItem);
        break;
      case 'approval':
        items.push({
          ...base,
          kind: 'approval',
          status: event.decision ? 'done' : 'cancelled',
          callId: event.callId,
          name: event.name,
          command: event.command,
          reason: event.reason,
          ...(event.decision ? { decision: event.decision } : {}),
        } satisfies ApprovalItem);
        break;
      case 'question':
        items.push({
          ...base,
          kind: 'question',
          status: event.answer ? 'done' : 'cancelled',
          header: event.header,
          question: event.question,
          options: event.options,
          ...(event.answer ? { answer: event.answer } : {}),
        } satisfies QuestionItem);
        break;
      case 'checkpoint':
        items.push({
          ...base,
          kind: 'checkpoint',
          status: 'done',
          step: event.step,
          label: event.snapshot.label,
          snapshotId: event.snapshot.id,
          filesTouched: event.snapshot.files,
          additiveOnly: !!event.snapshot.additiveOnly,
          ...(event.snapshot.changeStats ? { changeStats: event.snapshot.changeStats } : {}),
        } satisfies CheckpointItem);
        break;
      case 'revert':
        items.push({
          ...base,
          kind: 'notice',
          status: 'done',
          tone: 'warn',
          title: `已回退到第 ${event.toSeq} 条事件`,
          body: `${event.reason ?? '用户回退'}。旧分支保留在日志里，只读，可审计。`,
        } satisfies NoticeItem);
        break;
      case 'compact':
        items.push({
          ...base,
          kind: 'compaction',
          status: 'done',
          tokensBefore: 0,
          tokensAfter: 0,
          foldedItems: 0,
          keptItems: event.turnRange[1] - event.turnRange[0] + 1,
          summary: `第 ${event.turnRange[0]}–${event.turnRange[1]} 轮已压成 L2 摘要（${event.artifact}）`,
        } satisfies CompactionItem);
        break;
      default:
        break;
    }
  }
  // A row may be written twice as it changes (an approval gains its decision, a
// question its answer): the last event for one id wins, its position stays.
  const byId = new Map<string, Item>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()];
}

export interface DeriveInput {
  log: SessionLog;
  entry: SessionIndexEntry;
  snapshots: SnapshotMeta[];
  /** Model label shown in the session row. */
  model?: string;
}

export class SessionView {
  private readonly log: SessionLog;

  constructor(input: DeriveInput) {
    this.log = input.log;
    this.entry = input.entry;
    this.snapshots = input.snapshots;
    this.model = input.model ?? '';
  }

  private readonly entry: SessionIndexEntry;
  private snapshots: SnapshotMeta[];
  private readonly model: string;

  /** Re-read snapshots after a checkpoint (the provider holds the list). */
  setSnapshots(snapshots: SnapshotMeta[]): void {
    this.snapshots = snapshots;
  }

  private last<T extends SessionEvent['type']>(type: T): Extract<SessionEvent, { type: T }> | null {
    const events = this.log.activeEvents();
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type === type) return event as Extract<SessionEvent, { type: T }>;
    }
    return null;
  }

  contract(): Contract | null {
    return this.last('contract_set')?.contract ?? null;
  }

  plan(): PlanStep[] {
    return this.last('plan_updated')?.steps ?? [];
  }

  resolution(): ResolutionState {
    return this.last('resolution_updated')?.state ?? emptyResolution();
  }

  /** Ground-truth verification, derived every time — never stored. */
  verification(): string {
    const events = this.log.activeEvents();
    const calls = new Map<string, Extract<SessionEvent, { type: 'tool_call' }>>();
    const results: Array<Extract<SessionEvent, { type: 'tool_result' }>> = [];
    for (const event of events) {
      if (event.type === 'tool_call') calls.set(event.callId, event);
      else if (event.type === 'tool_result') results.push(event);
    }
    const lines: string[] = [];
    const writes = results.filter((result) => {
      const call = calls.get(result.callId);
      return result.ok && call?.risk === 'write' && !!call.target;
    });
    if (writes.length > 0) {
      const last = calls.get(writes.at(-1)!.callId);
      lines.push(`${writes.length} write steps committed; last: ${last?.target ?? '(unknown)'}`);
    }
    const shells = results.filter((result) => result.name === 'run_shell');
    for (const shell of shells.slice(-2)) {
      lines.push(`last shell: ${shell.summary} (${shell.ok ? 'green' : 'red'})`);
    }
    const open = [...calls.values()].filter((call) => !results.some((result) => result.callId === call.callId));
    if (open.length > 0) {
      lines.push(`open calls with no result: ${open.map((call) => call.name).join(', ')} (they may not have applied)`);
    }
    const latest = this.snapshots.at(-1);
    if (latest) {
      lines.push(`checkpoint ${latest.id} holds ${latest.files.length} files, ${Math.round(latest.sizeBytes / 1024)} KB`);
    }
    lines.push(...audits({ plan: this.plan(), events }));
    return lines.join('\n');
  }

  /** The row list for the renderer, plus the turn still in flight (if any). */
  project(): ProjectedSession {
    const active = this.log.activeEvents();
    // The ledger's meta is authoritative; the index entry is only a cache.
    const thread: Thread = {
      id: this.entry.sid,
      title: this.log.meta.title || this.entry.title,
      cwd: this.log.meta.workspace || this.entry.workspace,
      createdAt: this.log.meta.createdAt || this.entry.createdAt,
      updatedAt: this.log.meta.updatedAt || this.entry.updatedAt,
      status:
        this.log.meta.status === 'running' || this.log.meta.status === 'waiting_approval' || this.log.meta.status === 'failed'
          ? this.log.meta.status
          : 'idle',
      ...(this.entry.pinned ? { pinned: true } : {}),
      turnCount: Math.max(this.entry.turnCount, this.log.meta.turnCount),
      steps: this.log.meta.steps,
      totalTokens: this.log.meta.totalTokens,
      itemCount: 0,
      lastPrompt: this.log.meta.lastPrompt,
      model: this.model,
    };
    const items = projectItems(thread, active);
    thread.itemCount = items.length;

    let turn: Turn | null = null;
    let lastStarted: Turn | null = null;
    for (const event of active) {
      if (event.type === 'turn_started') {
        const started: Turn = {
          id: event.turnId,
          threadId: thread.id,
          index: event.turn,
          prompt: event.userText,
          status: 'completed',
          startedAt: event.ts,
          step: 0,
        };
        lastStarted = started;
        turn = started;
      } else if (event.type === 'turn_finished' && lastStarted && event.turn === lastStarted.index) {
        lastStarted.status =
          event.status === 'completed'
            ? 'completed'
            : event.status === 'cancelled' || event.status === 'interrupted'
              ? 'cancelled'
              : 'failed';
        lastStarted.endedAt = event.ts;
        if (event.stopReason) lastStarted.stopReason = event.stopReason;
      }
      if (lastStarted && event.turn === lastStarted.index) lastStarted.step = Math.max(lastStarted.step, event.step);
    }
    if (turn && !turn.endedAt) {
      // A turn with no finish event is either live or was settled by recovery;
      // either way "completed" would be a lie.
      turn.status = thread.status === 'running' ? 'running' : 'cancelled';
    }

    const evidence: string[] = [];
    const targets = new Map<string, string | undefined>();
    for (const event of active) {
      if (event.type === 'tool_call') targets.set(event.callId, event.target);
      else if (event.type === 'tool_result' && event.ok) {
        const target = targets.get(event.callId);
        if (target && ['read_file', 'grep_text', 'glob_files', 'list_dir'].includes(event.name)) {
          evidence.push(`read:${target}`);
        }
      }
    }

    return {
      thread,
      turn,
      items,
      contract: this.contract(),
      plan: this.plan(),
      resolution: this.resolution(),
      evidence: [...new Set(evidence)],
      lastSeq: this.log.lastSeq,
    };
  }

  /** Merge a freshly observed reference state without writing an event. */
  merge(next: Partial<ResolutionState>): ResolutionState {
    return mergeResolution(this.resolution(), next);
  }
}