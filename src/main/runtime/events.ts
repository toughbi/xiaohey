import type { PlanStep, SnapshotMeta, ToolRisk } from '../../shared/types.js';
import type { Contract } from './contract.js';
import type { ResolutionState } from './resolve.js';

/**
 * The session event contract.
 *
 * `events.jsonl` is the only source of truth for a session. Everything else —
 * the model's messages, the transcript the UI draws, the resume block after a
 * crash, the search index, the long-term digest — is derived from these lines.
 * The rules that keep that true:
 *
 *  - every line is one immutable event, appended, never edited;
 *  - a correction is a new event (`revert`, a later `plan_updated`, …);
 *  - small payloads are inline, large ones live in `blobs/` behind a `handle`.
 *
 * `seq` is assigned by the single writer; `ts` is only for display.
 */

export interface EventBase {
  v: 1;
  seq: number;
  ts: number;
  sid: string;
  /** Branched on revert; see `SessionMeta.revertChain`. */
  epoch: number;
  /** Logical turn number; may be reused after a revert. */
  turn: number;
  step: number;
  /** Projection row id, so a reload redraws the same rows instead of new ones. */
  itemId?: string;
}

/** Large text in the content-addressed store, addressed by a short handle. */
export interface BlobRef {
  blob: string;
  bytes: number;
  tokens: number;
  handle: string;
  /** Head 200 + tail 200 characters, enough to recognise the content. */
  preview: string;
}

/** Small content that travels with the event. */
export interface InlineRef {
  text: string;
  tokens: number;
}

/** Tool arguments: digest + blob + handle, because `write_file` content can be huge. */
export interface ArgsRef {
  digest: string;
  blob: string;
  handle: string;
  bytes: number;
  tokens: number;
  preview: string;
}

export type ContentRef = InlineRef | BlobRef;

export type TurnStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type SessionEvent =
  | (EventBase & { type: 'session_created'; workspace: string; title: string })
  | (EventBase & { type: 'turn_started'; turnId: string; userText: string; attachments?: BlobRef[] })
  | (EventBase & {
      type: 'assistant_message';
      text: string;
      reasoning?: ContentRef;
      final?: boolean;
      /** Provider reported the output hit its cap. */
      truncated?: boolean;
    })
  | (EventBase & {
      type: 'tool_call';
      callId: string;
      name: string;
      args: InlineRef | ArgsRef;
      risk: ToolRisk;
      phase: 'started';
      summary?: string;
      target?: string;
      beforeHash?: string;
    })
  | (EventBase & {
      type: 'tool_result';
      callId: string;
      name: string;
      ok: boolean;
      content: ContentRef;
      phase: 'done';
      summary: string;
      afterHash?: string;
      files?: string[];
      layer?: string;
      hint?: string;
      retryable?: boolean;
      durationMs?: number;
      /** Set when the process died before the tool returned. */
      interrupted?: true;
      applied?: 'yes' | 'no' | 'unknown';
    })
  | (EventBase & {
      type: 'turn_checkpoint';
      goal: string;
      lastStep?: { tool: string; target?: string; ok: boolean };
      filesTouched?: string[];
      lastPlanLine?: string;
      next?: string;
    })
  | (EventBase & { type: 'turn_finished'; status: TurnStatus; finalText?: ContentRef; stopReason?: string })
  | (EventBase & {
      type: 'compact';
      turnRange: [number, number];
      artifact: string;
      sourceHash: string;
      level: 2 | 3;
      model: string;
      promptVersion: number;
      degraded: boolean;
    })
  | (EventBase & { type: 'contract_set'; contract: Contract; source: 'first-turn' | 'reset' | 'migrated'; reason?: string })
  | (EventBase & { type: 'plan_updated'; steps: PlanStep[]; source: 'model' | 'migrated' })
  | (EventBase & { type: 'resolution_updated'; state: ResolutionState; hash: string; source: 'turn' | 'migrated' })
  | (EventBase & { type: 'revert'; toSeq: number; newEpoch: number; reason?: string })
  | (EventBase & { type: 'consolidated'; workspace: string; dayKey: string; memoryIds: string[]; tokens?: number })
  | (EventBase & { type: 'notice'; tone: 'info' | 'warn' | 'error' | 'stopped'; title: string; body: string })
  | (EventBase & {
      type: 'approval';
      callId: string;
      name: string;
      command: string;
      reason: string;
      decision?: 'allow_once' | 'allow_always' | 'deny';
    })
  | (EventBase & {
      type: 'question';
      questionId: string;
      header: string;
      question: string;
      options: Array<{ label: string; description?: string }>;
      answer?: string;
    })
  | (EventBase & { type: 'checkpoint'; snapshot: SnapshotMeta & { additiveOnly: boolean } })
  | (EventBase & { type: 'recovered'; detail: string; turnId?: string });

export type SessionEventType = SessionEvent['type'];

/** Event types whose line must be on disk before the next step (crash safety). */
export const DURABLE_EVENTS: ReadonlySet<SessionEventType> = new Set([
  'tool_call',
  'tool_result',
  'turn_started',
  'turn_finished',
  'turn_checkpoint',
  'checkpoint',
]);

/** Events that belong to the transcript the UI draws. */
export const TRANSCRIPT_EVENTS: ReadonlySet<SessionEventType> = new Set([
  'turn_started',
  'assistant_message',
  'tool_call',
  'tool_result',
  'notice',
  'approval',
  'question',
  'checkpoint',
  'revert',
]);

export interface SessionMeta {
  sid: string;
  workspace: string;
  /** The tree the session's snapshots address; normally the workspace. */
  root: string;
  effectiveWorkspace?: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  status: 'idle' | 'running' | 'waiting_approval' | 'failed' | 'interrupted';
  schema: 2;
  epoch: number;
  revertChain: Array<{ epoch: number; toSeq: number }>;
  migratedFrom?: string;
  migratedAt?: number;
  /** Prompt+completion tokens spent in this session. */
  totalTokens: number;
  /** Loop steps executed (one step = one model call). */
  steps: number;
  lastPrompt: string;
  model: string;
  /** Isolated checkout while another session holds the main tree. */
  worktree?: unknown;
  /** Set at boot when the process that owned the lock disappeared. */
  recoveredAt?: number;
}

export interface TurnIndexEntry {
  turn: number;
  turnId: string;
  epoch: number;
  firstSeq: number;
  lastSeq: number;
  startedAt: number;
  endedAt?: number;
  status: 'running' | TurnStatus;
  tokens?: number;
  level: 0 | 1 | 2 | 3;
  artifact?: string;
  reverted?: boolean;
}

export interface TurnIndex {
  turns: TurnIndexEntry[];
}

export interface Manifest {
  version: 1;
  artifacts: Record<
    string,
    {
      turn: number;
      rawRange: [number, number];
      sourceHash: string;
      artifact: string;
      model: string;
      promptVersion: number;
      createdAt: number;
      degraded: boolean;
    }
  >;
  levels: Record<number, 0 | 1 | 2 | 3>;
}

export const emptyManifest = (): Manifest => ({ version: 1, artifacts: {}, levels: {} });

/** Structured L2 summary of one turn; always derived from raw events, never from a summary. */
export interface TurnDigest {
  turn: number;
  status: string;
  goal: string;
  userInput: string;
  finalAnswer: { text: string; handle?: string };
  keySteps: Array<{ tool: string; target?: string; why?: string; ok: boolean; handle?: string }>;
  decisions: Array<{ decision: string; reason?: string; evidence?: string[] }>;
  constraints: string[];
  openQuestions: string[];
  failures: Array<{ what: string; resolution?: string }>;
  filesRead: string[];
  filesChanged: string[];
  deliverables: string[];
  verification: string[];
  next: string;
  interrupted?: { lastGoal: string; plan: string; done: string; next: string };
}

export interface UsageRecord {
  dayKey: string;
  workspace: string;
  sid: string;
  turn: number;
  kind: 'chat' | 'context_compress' | 'consolidate';
  input: number;
  output: number;
  cachedRead?: number;
  estimated?: boolean;
}

export interface PendingMark {
  workspace: string;
  dayKey: string;
  sid: string;
  lastSeq: number;
  markedAt: number;
  reason: 'exit' | 'crash' | 'manual';
}

export type ConsolidationStatus = 'pending' | 'deferred' | 'running' | 'done' | 'failed';

export interface ConsolidationRecord {
  status: ConsolidationStatus;
  tokens: number;
  lastAttemptAt?: number;
  completedAt?: number;
  lastError?: string;
  memoryIds?: string[];
  calls?: number;
}

export type ConsolidationState = Record<string, ConsolidationRecord>;

export const consolidationKey = (workspace: string, dayKey: string): string => `${workspace}::${dayKey}`;

export const isBlobRef = (ref: ContentRef | undefined): ref is BlobRef =>
  !!ref && typeof (ref as BlobRef).blob === 'string';

export const isArgsRef = (ref: InlineRef | ArgsRef): ref is ArgsRef =>
  typeof (ref as ArgsRef).digest === 'string';

export const refTokens = (ref: ContentRef | InlineRef | ArgsRef | undefined): number =>
  ref ? (typeof ref.tokens === 'number' ? ref.tokens : 0) : 0;