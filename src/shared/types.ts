/**
 * xiaohey wire protocol.
 *
 * The renderer never touches the agent runtime directly: the main process is an
 * app server that owns threads, turns and items, and the renderer is one client
 * (the same split Codex uses between its app server and its clients).
 */

export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny';

/**
 * How much the runtime asks before it acts.
 * `ask`  — every command waits for a decision.
 * `auto` — only commands that match a known risk pattern ask.
 * `full` — nothing asks; working memory still records every step.
 */
export type ApprovalPolicy = 'ask' | 'auto' | 'full';

export type ReasoningEffort = 'default' | 'low' | 'medium' | 'high';

export interface ModelSettings {
  /** OpenAI-compatible base URL, without the trailing /chat/completions. */
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxOutputTokens: number;
  /** Budget used for context accounting and compaction. */
  contextWindow: number;
  /** Sent as `reasoning_effort` when it is not "default". */
  reasoningEffort?: ReasoningEffort;
}

export interface ModelProfile extends ModelSettings {
  id: string;
  /** Display name in the model list, e.g. "DeepSeek V4" or "本地 llama". */
  name: string;
  /** Vendor id from the provider catalog, used to group the model picker. */
  provider?: string;
  /** Disabled models stay configured but are hidden from the picker. */
  enabled?: boolean;
  /** How the vendor bills this key: plan or pay-as-you-go. */
  billing?: 'plan' | 'payg';
  /** Provenance for limits: only metadata-derived or user-entered values are shown. */
  contextWindowSource?: 'metadata' | 'user';
  maxOutputTokensSource?: 'metadata' | 'user';
}

export interface EmbeddingSettings {
  /** Off means: local hashed vectors + keyword matching (still hybrid, not semantic). */
  enabled: boolean;
  /** Empty reuses the active chat model's base URL. */
  baseUrl: string;
  /** Empty reuses the active chat model's API key. */
  apiKey: string;
  /** Required when enabled, e.g. text-embedding-3-small / bge-m3 / nomic-embed-text. */
  model: string;
  /** Optional reranker; empty disables the rerank stage. */
  rerankModel: string;
  /** Optional rerank endpoint; empty derives it from baseUrl. */
  rerankBaseUrl: string;
}

export interface Settings {
  /** Every model the user added. Configuration happens in Settings only. */
  models: ModelProfile[];
  /** Which one the runtime uses; switching is a selection, not an edit. */
  activeModelId: string;
  approval: ApprovalPolicy;
  /** "<tool>:<command>" pairs the user allowed permanently. */
  allowedCommands: string[];
  /** Folders opened through the workspace picker, most recent first. */
  recentWorkspaces?: string[];
  /** Optional embedding provider for semantic long-term memory recall. */
  embedding: EmbeddingSettings;
}

export type ItemKind =
  | 'message'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'plan'
  | 'notice'
  | 'compaction'
  | 'checkpoint'
  | 'approval'
  | 'question';

export type ItemStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface ItemBase {
  id: string;
  threadId: string;
  turnId: string;
  kind: ItemKind;
  at: number;
  status: ItemStatus;
}

export interface MessageItem extends ItemBase {
  kind: 'message';
  role: 'user' | 'assistant';
  text: string;
  /** Facts in the answer that were backed by a tool call (evidence constraint). */
  evidence?: string[];
  /** Full reasoning text, replayed to thinking models on later calls. */
  reasoning?: string;
  /** Files the user referenced with @path; contents go to the model, not the bubble. */
  references?: Array<{ path: string; content: string }>;
}

export interface ReasoningItem extends ItemBase {
  kind: 'reasoning';
  text: string;
}

export type ToolRisk = 'read' | 'write' | 'exec';

export interface ToolCallItem extends ItemBase {
  kind: 'tool_call';
  callId: string;
  name: string;
  args: Record<string, unknown>;
  summary: string;
  risk: ToolRisk;
  /** Authoritative tool description used for routing, short form. */
  description?: string;
  /** Reasoning that produced this call; replayed to thinking models. */
  reasoning?: string;
}

export type ErrorLayer = 'L1-parse' | 'L2-schema' | 'L3-domain' | 'transient' | 'none';

export interface ToolResultItem extends ItemBase {
  kind: 'tool_result';
  callId: string;
  name: string;
  ok: boolean;
  summary: string;
  output: string;
  layer: ErrorLayer;
  retryable: boolean;
  /** Structured repair hint fed back to the model. */
  hint?: string;
  /** Paths the tool touched, for checkpoints and the document panel. */
  files?: string[];
  durationMs?: number;
}

export interface PlanStep {
  id: string;
  title: string;
  status: 'pending' | 'active' | 'done' | 'dropped';
}

export interface PlanItem extends ItemBase {
  kind: 'plan';
  steps: PlanStep[];
}

export interface NoticeItem extends ItemBase {
  kind: 'notice';
  tone: 'info' | 'warn' | 'error' | 'stopped';
  title: string;
  body: string;
}

export interface CompactionItem extends ItemBase {
  kind: 'compaction';
  tokensBefore: number;
  tokensAfter: number;
  foldedItems: number;
  keptItems: number;
  summary: string;
}

export interface CheckpointItem extends ItemBase {
  kind: 'checkpoint';
  step: number;
  label: string;
  snapshotId: string;
  filesTouched: string[];
  additiveOnly: boolean;
  changeStats?: ChangeStats;
}

export interface ApprovalItem extends ItemBase {
  kind: 'approval';
  callId: string;
  name: string;
  command: string;
  reason: string;
  decision?: ApprovalDecision;
}

export interface QuestionOption {
  /** Short answer; this label is what the model receives back. */
  label: string;
  description?: string;
}

/** One clarification question the assistant asked mid-turn. */
export interface QuestionItem extends ItemBase {
  kind: 'question';
  header: string;
  question: string;
  options: QuestionOption[];
  /** The chosen option label, or the user's free-form answer. */
  answer?: string;
}

export type Item =
  | MessageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem
  | PlanItem
  | NoticeItem
  | CompactionItem
  | CheckpointItem
  | ApprovalItem
  | QuestionItem;

export type ThreadStatus = 'idle' | 'running' | 'waiting_approval' | 'failed';

export interface Thread {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  status: ThreadStatus;
  pinned?: boolean;
  turnCount: number;
  /** Loop steps executed across the whole session (one step = one model call). */
  steps: number;
  /** Prompt + completion tokens spent in this session so far. */
  totalTokens: number;
  itemCount: number;
  lastPrompt: string;
  model: string;
}

export type TurnStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface Turn {
  id: string;
  threadId: string;
  index: number;
  prompt: string;
  status: TurnStatus;
  startedAt: number;
  endedAt?: number;
  step: number;
  /** Why the turn stopped: model finished, budget, guard, error. */
  stopReason?: string;
}

export interface ContextGauge {
  tokensUsed: number;
  tokensBudget: number;
  compacted: number;
  memoryFacts: number;
  evidence: number;
  toolCalls: number;
}

export interface RuntimeStatus {
  threadId: string | null;
  turnId: string | null;
  phase: 'idle' | 'thinking' | 'tool' | 'approval' | 'question' | 'compacting' | 'error';
  detail: string;
  adapters: { llm: boolean; shell: boolean; editor: boolean };
}

export type WriteTier = 'low' | 'medium' | 'high';

export interface ApprovalRequest {
  id: string;
  threadId: string;
  turnId: string;
  callId: string;
  name: string;
  command: string;
  reason: string;
  risk: ToolRisk;
  /** Set for file writes: how destructive the change is. */
  tier?: WriteTier;
}

export interface FileEntry {
  path: string;
  name: string;
  dir: boolean;
  size: number;
  updatedAt: number;
}

export interface DocumentPayload {
  path: string;
  language: string;
  content: string;
  truncated: boolean;
  updatedAt: number;
}

export interface DiffPayload {
  path: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
}

export type MemoryKind = 'episodic' | 'relational' | 'knowledge';

export interface MemoryFact {
  id: string;
  kind: MemoryKind;
  /** Human-readable title; the UI shows it above the value. */
  title: string;
  /** Display key: the knowledge slot, or the entry id for episodes/relations. */
  slot: string;
  value: string;
  scope: string;
  source: string;
  /** 1–100, judged by the model when the memory was written. */
  importance: number;
  createdAt: number;
  updatedAt: number;
  /** Present when the entry was cleared to the archive file. */
  archived?: boolean;
  outcome?: string;
  supersededBy?: string;
  conflicts?: number;
}

export interface FileChangeStat {
  path: string;
  additions: number;
  deletions: number;
}

export interface ChangeStats {
  additions: number;
  deletions: number;
  files: FileChangeStat[];
}

export interface SnapshotMeta {
  id: string;
  step: number;
  label: string;
  at: number;
  files: string[];
  additiveOnly: boolean;
  sizeBytes: number;
  changeStats?: ChangeStats;
}

export interface ActivityDay {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Messages + tool calls that day. */
  count: number;
  /** Prompt + completion tokens spent that day. */
  tokens: number;
}

export interface ActivityResult {
  weeks: number;
  days: ActivityDay[];
  summary: { sessions: number; activeDays: number; records: number; steps: number };
}

export interface TaskContract {
  goal: string;
  acceptance: string[];
  nonGoals: string[];
  forbidden: string[];
}

export interface ToolDescriptor {
  name: string;
  summary: string;
  risk: ToolRisk;
  useWhen: string;
  avoidWhen: string;
}

export type RuntimeEvent =
  | { type: 'thread/updated'; thread: Thread }
  | { type: 'thread/list'; threads: Thread[] }
  | { type: 'turn/updated'; turn: Turn }
  | { type: 'item/upsert'; item: Item }
  | { type: 'runtime/updated'; runtime: RuntimeStatus; context: ContextGauge }
  | { type: 'approval/requested'; approval: ApprovalRequest }
  | { type: 'settings/updated'; settings: Settings }
  | { type: 'memory/updated'; threadId: string; facts: MemoryFact[] }
  | { type: 'snapshot/updated'; threadId: string; snapshots: SnapshotMeta[] };

export interface RequestMap {
  'app/info': {
    params: { demo: boolean };
    result: { version: string; workspace: string; demo: boolean; platform: string; user: string };
  };
  'settings/get': { params: Record<string, never>; result: Settings };
  'settings/set': { params: Settings; result: Settings };
  'settings/test': {
    params: { model: ModelSettings };
    result: { ok: boolean; detail: string; latencyMs: number };
  };
  'thread/list': { params: Record<string, never>; result: Thread[] };
  'thread/create': { params: { title?: string; workspace?: string | null }; result: Thread };
  'thread/set-workspace': { params: { threadId: string; workspace: string }; result: Thread };
  'thread/open': {
    params: { threadId: string };
    result: { thread: Thread; items: Item[]; turn?: Turn; contract: TaskContract | null; plan: PlanStep[] };
  };
  'thread/rename': { params: { threadId: string; title: string }; result: Thread };
  'thread/delete': { params: { threadId: string }; result: { ok: boolean } };
  'turn/start': { params: { threadId: string; prompt: string; attachments?: string[] }; result: Turn };
  'thread/export': { params: { threadId: string }; result: { path: string } };
  'thread/markdown': { params: { threadId: string }; result: { markdown: string } };
  'approvals/list': { params: { threadId: string }; result: ApprovalItem[] };
  'memory/set': {
    params: { threadId: string; slot: string; value: string; kind?: MemoryKind; importance?: number };
    result: MemoryFact[];
  };
  'fs/files': { params: { threadId: string }; result: FileEntry[] };
  'app/reveal': { params: { path: string; threadId?: string }; result: { ok: boolean } };
  'app/notify': { params: { title: string; body: string }; result: { ok: boolean } };
  'thread/pin': { params: { threadId: string; pinned: boolean }; result: Thread };
  'snapshot/preview': {
    params: { threadId: string; snapshotId: string };
    result: { entries: Array<{ path: string; status: 'restore' | 'delete'; additions: number; deletions: number; before: string; after: string }> };
  };
  'fs/attach': { params: { threadId: string; name: string; data: string }; result: { path: string } };
  'turn/cancel': { params: { threadId: string }; result: { ok: boolean } };
  'approval/respond': { params: { approvalId: string; decision: ApprovalDecision }; result: { ok: boolean } };
  'question/respond': { params: { questionId: string; answer: string }; result: { ok: boolean } };
  'context/get': { params: { threadId: string }; result: ContextGauge };
  'tools/list': { params: Record<string, never>; result: ToolDescriptor[] };
  'memory/list': { params: { threadId?: string; includeArchived?: boolean }; result: MemoryFact[] };
  'memory/delete': { params: { threadId?: string; slot: string }; result: MemoryFact[] };
  'snapshot/list': { params: { threadId: string }; result: SnapshotMeta[] };
  'snapshot/revert': { params: { threadId: string; snapshotId: string }; result: { ok: boolean; message: string; undoSnapshotId?: string } };
  'fs/list': { params: { threadId: string; path: string }; result: FileEntry[] };
  'fs/read': { params: { threadId: string; path: string }; result: DocumentPayload };
  'fs/read-image': { params: { threadId: string; path: string }; result: { dataUrl: string; mime: string } | null };
  'fs/diff': { params: { threadId: string; path: string; snapshotId?: string }; result: DiffPayload };
  'ui/state': { params: Record<string, never>; result: { settings: Settings; threads: Thread[]; tools: ToolDescriptor[] } };
  'activity/get': { params: { weeks?: number }; result: ActivityResult };
  'workspace/info': {
    params: { threadId?: string };
    result: { path: string; name: string; branch: string | null };
  };
  'workspace/pick': { params: Record<string, never>; result: { path: string | null } };
  'workspace/reveal': { params: { path: string }; result: { ok: boolean } };
  'workspace/rename': { params: { path: string; name: string }; result: { path: string } };
  'workspace/delete': { params: { path: string }; result: { ok: boolean; deleted: number } };
  'provider/models': {
    params: { baseUrl: string; apiKey: string };
    result: {
      ok: boolean;
      models: string[];
      limits: Record<string, { contextWindow?: number; maxOutputTokens?: number }>;
      detail: string;
    };
  };
  'app/open-external': { params: { url: string }; result: { ok: boolean } };
}

export type RequestName = keyof RequestMap;
export type RequestParams<K extends RequestName> = RequestMap[K]['params'];
export type RequestResult<K extends RequestName> = RequestMap[K]['result'];
