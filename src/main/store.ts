import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Item,
  ModelProfile,
  ModelSettings,
  PlanStep,
  Settings,
  SnapshotMeta,
  Thread,
  Turn,
} from '../shared/types.js';
import type { Contract } from './runtime/contract.js';
import type { MemoryRecord } from './runtime/memory.js';
import type { ResolutionState } from './runtime/resolve.js';
import type { ContextState } from './runtime/context.js';
import type { WorktreeState } from './runtime/worktree.js';
import { emptyContext } from './runtime/context.js';
import { emptyResolution } from './runtime/resolve.js';
import { normalizeWorkspace } from './runtime/commit.js';
import { Checkpoints } from './runtime/checkpoint.js';
import {
  sessionPaths,
  sessionRoot,
  SessionIndex,
  SessionLog,
  type SessionIndexEntry,
} from './runtime/sessionlog.js';
import { SessionView } from './runtime/sessionview.js';
import { migrateLegacyThreads, migrateLegacyUsage, seedSessionIndex } from './runtime/migration.js';
import { UsageLedger } from './runtime/usage.js';
import type { SessionMeta } from './runtime/events.js';
import { ensureDir, readJson, writeJsonAtomic } from './util.js';

/**
 * The session registry.
 *
 * There is no thread document on disk any more: a session is a directory with
 * an append-only `events.jsonl`, and everything this class hands to the app is
 * derived by replaying it (see `sessionview.ts`). The in-memory `ThreadDoc` is
 * a projection kept hot for the running turn, not a file format.
 *
 * `session/index.json` is the sidebar's read path: listing sessions never opens
 * a ledger. It can be rebuilt from the session directories at any time.
 */

export interface ThreadState {
  plan: PlanStep[];
  /**
   * @deprecated Legacy per-thread memory. Always empty now; long-term memory
   * lives in `~/.xiaohei/memory.md` and is never part of a session document.
   */
  memory: MemoryRecord[];
  resolution: ResolutionState;
  contract: Contract | null;
  context: ContextState;
  evidence: string[];
  /** Hash of the last resolution written, so an unchanged state writes nothing. */
  resolutionHash?: string;
  /** Isolated checkout while another session holds the main tree; null when none. */
  worktree: WorktreeState | null;
}

export type SeedDoc = Omit<ThreadDoc, 'log' | 'view'>;

export interface ThreadDoc {
  thread: Thread;
  turn: Turn | null;
  items: Item[];
  state: ThreadState;
  snapshots: SnapshotMeta[];
  /** The ledger this document is a view of. */
  log: SessionLog;
  view: SessionView;
}

export interface AppIndex {
  workspaceRoot: string;
  activeThreadId: string | null;
  threadOrder: string[];
}

export const DEFAULT_PROFILE = {
  id: 'default',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.4,
  maxOutputTokens: 0,
  contextWindow: 131_072,
  reasoningEffort: 'default',
} as const;

export const DEFAULT_SETTINGS: Settings = {
  models: [],
  activeModelId: '',
  approval: 'ask',
  allowedCommands: [],
  embedding: { enabled: false, baseUrl: '', apiKey: '', model: '', rerankModel: '', rerankBaseUrl: '' },
};

export function emptyState(): ThreadState {
  return {
    plan: [],
    memory: [],
    resolution: emptyResolution(),
    contract: null,
    context: emptyContext(),
    evidence: [],
    worktree: null,
  };
}

/**
 * Settings arrive from disk, from the settings dialog and from the model
 * switcher, so every entry point funnels through here: one profile shape, a
 * valid active id, and a legacy `model` field upgraded into the first profile.
 */
export function normalizeSettings(raw: unknown): Settings {
  const fallback = structuredClone(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return fallback;
  const value = raw as Record<string, unknown>;

  const asProfile = (entry: unknown, index: number): ModelProfile => {
    const profile = (entry ?? {}) as Partial<ModelProfile>;
    return {
      id: typeof profile.id === 'string' && profile.id.trim() ? profile.id : `model-${index + 1}`,
      name:
        typeof profile.name === 'string' && profile.name.trim()
          ? profile.name.trim()
          : typeof profile.model === 'string' && profile.model.trim()
            ? profile.model.trim()
            : `模型 ${index + 1}`,
      baseUrl: typeof profile.baseUrl === 'string' ? profile.baseUrl : DEFAULT_PROFILE.baseUrl,
      apiKey: typeof profile.apiKey === 'string' ? profile.apiKey : '',
      model: typeof profile.model === 'string' && profile.model.trim() ? profile.model : DEFAULT_PROFILE.model,
      temperature: typeof profile.temperature === 'number' ? profile.temperature : DEFAULT_PROFILE.temperature,
      maxOutputTokens:
        typeof profile.maxOutputTokens === 'number' && profile.maxOutputTokens > 0 ? profile.maxOutputTokens : 0,
      contextWindow:
        typeof profile.contextWindow === 'number' && profile.contextWindow > 0 ? profile.contextWindow : 0,
      reasoningEffort:
        profile.reasoningEffort === 'low' ||
        profile.reasoningEffort === 'medium' ||
        profile.reasoningEffort === 'high'
          ? profile.reasoningEffort
          : 'default',
      ...(typeof profile.provider === 'string' && profile.provider.trim()
        ? { provider: profile.provider.trim() }
        : {}),
      ...(typeof profile.enabled === 'boolean' ? { enabled: profile.enabled } : {}),
      ...(profile.billing === 'plan' || profile.billing === 'payg' ? { billing: profile.billing } : {}),
      ...(profile.contextWindowSource === 'metadata' || profile.contextWindowSource === 'user'
        ? { contextWindowSource: profile.contextWindowSource }
        : {}),
      ...(profile.maxOutputTokensSource === 'metadata' || profile.maxOutputTokensSource === 'user'
        ? { maxOutputTokensSource: profile.maxOutputTokensSource }
        : {}),
    };
  };

  let models: ModelProfile[] = Array.isArray(value.models) ? value.models.map(asProfile) : [];
  const hasModelsKey = Array.isArray(value.models);
  if (!hasModelsKey) {
    const legacy = value.model as Partial<ModelSettings> | undefined;
    models =
      legacy && typeof legacy === 'object'
        ? [asProfile({ ...legacy, id: DEFAULT_PROFILE.id, name: DEFAULT_PROFILE.name }, 0)]
        : fallback.models;
  }

  const ids = new Set(models.map((profile) => profile.id));
  const activeModelId =
    models.length === 0
      ? ''
      : typeof value.activeModelId === 'string' && ids.has(value.activeModelId)
        ? value.activeModelId
        : models[0].id;
  const approval = ['ask', 'auto', 'full'].includes(String(value.approval))
    ? (value.approval as Settings['approval'])
    : fallback.approval;

  const recentWorkspaces = Array.isArray(value.recentWorkspaces)
    ? [...new Set(value.recentWorkspaces.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))].slice(0, 8)
    : [];

  const allowedCommands = Array.isArray(value.allowedCommands)
    ? [...new Set(value.allowedCommands.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))]
    : [];

  const embeddingRaw = (value.embedding ?? {}) as Partial<Settings['embedding']>;
  const embedding = {
    enabled: embeddingRaw.enabled === true,
    baseUrl: typeof embeddingRaw.baseUrl === 'string' ? embeddingRaw.baseUrl.trim() : '',
    apiKey: typeof embeddingRaw.apiKey === 'string' ? embeddingRaw.apiKey : '',
    model: typeof embeddingRaw.model === 'string' ? embeddingRaw.model.trim() : '',
    rerankModel: typeof embeddingRaw.rerankModel === 'string' ? embeddingRaw.rerankModel.trim() : '',
    rerankBaseUrl: typeof embeddingRaw.rerankBaseUrl === 'string' ? embeddingRaw.rerankBaseUrl.trim() : '',
  };

  return { models, activeModelId, approval, allowedCommands, recentWorkspaces, embedding };
}

export class Store {
  readonly settingsFile: string;
  readonly leasesFile: string;
  readonly snapshotsDir: string;
  /** The old per-thread JSON directory; only read by the migration. */
  readonly legacyThreadsDir: string;
  readonly usage: UsageLedger;
  readonly checkpoints: Checkpoints;
  readonly sessions: SessionIndex;

  private settings: Settings;
  readonly docs = new Map<string, ThreadDoc>();
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    readonly home: string,
    workspaceRoot: string,
  ) {
    this.settingsFile = join(home, 'settings.json');
    this.leasesFile = join(home, 'leases.json');
    this.snapshotsDir = join(home, 'snapshots');
    this.legacyThreadsDir = join(home, 'threads');
    this.usage = new UsageLedger(home);
    this.checkpoints = new Checkpoints(this.snapshotsDir);
    this.sessions = new SessionIndex(home, workspaceRoot);
    this.settings = structuredClone(DEFAULT_SETTINGS);
  }

  async init(): Promise<void> {
    await ensureDir(this.home);
    await ensureDir(sessionRoot(this.home));
    await ensureDir(this.snapshotsDir);
    const rawSettings = await readJson<unknown>(join(this.home, 'settings.json'), null);
    this.settings = normalizeSettings(rawSettings);
    // Repair the file when it was missing, invalid, or still in the old shape,
    // so the next boot does not re-parse garbage.
    if (JSON.stringify(rawSettings) !== JSON.stringify(this.settings)) {
      await writeJsonAtomic(this.settingsFile, this.settings);
    }
    await this.sessions.load();
    // P0: existing sessions must open after the upgrade. Migration is idempotent
    // (meta.migratedAt is the marker) and never deletes the legacy file.
    await migrateLegacyThreads(this.home).catch(() => ({ migrated: [], skipped: 0, failed: [] }));
    await seedSessionIndex(this.home, this.sessions);
    await this.reconcileIndex();
    await migrateLegacyUsage(this.home, async (workspace, dayKey, tokens) => {
      await this.usage.append({
        dayKey,
        workspace,
        sid: 'legacy',
        turn: 0,
        kind: 'chat',
        input: tokens,
        output: 0,
        estimated: true,
      });
    }).catch(() => undefined);
    await this.sessions.save();
  }

  /**
   * Meta.json is authoritative for a session's state, the index is its cache:
   * a crash can leave the index a debounce behind, so every boot re-reads the
   * sessions on disk and merges them back in.
   */
  private async reconcileIndex(): Promise<void> {
    const dir = sessionRoot(this.home);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const meta = await readJson<SessionMeta | null>(sessionPaths(this.home, entry.name).meta, null);
      if (!meta) continue;
      this.sessions.upsert(this.entryOf(meta));
    }
  }

  private entryOf(meta: SessionMeta): SessionIndexEntry {
    const existing = this.sessions.get(meta.sid);
    return {
      sid: meta.sid,
      workspace: meta.workspace,
      title: meta.title,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      turnCount: meta.turnCount,
      status: meta.status,
      ...(existing?.pinned ? { pinned: true } : {}),
      steps: meta.steps,
      totalTokens: meta.totalTokens,
      model: meta.model,
      lastPrompt: meta.lastPrompt,
    };
  }

  get workspaceRoot(): string {
    return this.sessions.workspaceRoot;
  }

  set workspaceRoot(next: string) {
    this.sessions.workspaceRoot = next;
    void this.sessions.save();
  }

  getSettings(): Settings {
    return structuredClone(this.settings);
  }

  /** The profile the runtime actually calls; null when the list is empty. */
  activeModel(): ModelProfile | null {
    return (
      this.settings.models.find((profile) => profile.id === this.settings.activeModelId) ??
      this.settings.models[0] ??
      null
    );
  }

  async setSettings(next: Settings): Promise<Settings> {
    this.settings = normalizeSettings(next);
    await writeJsonAtomic(this.settingsFile, this.settings);
    return this.getSettings();
  }

  async setPinned(threadId: string, pinned: boolean): Promise<Thread> {
    const doc = await this.load(threadId);
    if (!doc) throw new Error(`unknown thread ${threadId}`);
    doc.thread.pinned = pinned;
    this.sessions.setPinned(threadId, pinned);
    await this.sessions.save();
    return doc.thread;
  }

  async saveIndex(): Promise<void> {
    await this.sessions.save();
  }

  /** Tokens per local day across every workspace, for the activity heatmap. */
  async tokenDays(): Promise<Record<string, number>> {
    const totals: Record<string, number> = {};
    for (const workspace of await this.usage.workspaces()) {
      for (const record of await this.usage.recordsOf(workspace)) {
        if (record.kind === 'consolidate') continue;
        totals[record.dayKey] = (totals[record.dayKey] ?? 0) + record.input + record.output;
      }
    }
    return totals;
  }

  /** Legacy shim: record a chat spend without a full usage record. */
  addTokens(day: string, tokens: number, workspace?: string): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    void this.usage.append({
      dayKey: day,
      workspace: workspace?.trim() ? normalizeWorkspace(workspace) : this.workspaceRoot,
      sid: '',
      turn: 0,
      kind: 'chat',
      input: Math.round(tokens),
      output: 0,
      estimated: true,
    });
  }

  async workspaceTokens(workspace: string, date: string): Promise<number> {
    return (await this.usage.totals(workspace, date)).billable;
  }

  /** Every workspace that has a token tally, for the consolidation sweep. */
  trackedWorkspaces(): string[] {
    return [...new Set(this.sessions.list().map((entry) => normalizeWorkspace(entry.workspace)).filter(Boolean))];
  }

  activeThreadId(): string | null {
    return this.sessions.active;
  }

  async setActive(threadId: string | null): Promise<void> {
    this.sessions.setActive(threadId);
    await this.sessions.save();
  }

  /**
   * A turn cannot survive the app process. Anything the ledger still shows as
   * running is a leftover from a quit or a crash: close it in the ledger (not by
   * editing a file), give every orphaned tool call an explicit `interrupted`
   * result, and record what a resumed turn should know.
   */
  async recoverInterrupted(): Promise<void> {
    for (const entry of this.sessions.list()) {
      if (entry.status !== 'running' && entry.status !== 'waiting_approval') continue;
      const log = await SessionLog.open(this.home, entry.sid);
      if (!log) continue;
      try {
        await this.settleLog(log);
        this.sessions.upsert(this.entryOf(log.meta));
      } finally {
        await log.release();
      }
    }
    await this.sessions.save().catch(() => undefined);
  }

  /** Mark every unfinished turn and orphaned call in one ledger as interrupted. */
  async settleLog(log: SessionLog): Promise<void> {
    const unfinished = log.unfinishedTurns();
    const orphans = log.orphanToolCalls();
    if (unfinished.length === 0 && orphans.length === 0) {
      if (log.meta.status !== 'idle') await log.patchMeta({ status: 'idle' });
      return;
    }
    for (const call of orphans) {
      await log.append({
        type: 'tool_result',
        turn: call.turn,
        step: call.step,
        callId: call.callId,
        name: call.name,
        ok: false,
        content: { text: '应用中断，工具没有返回结果。', tokens: 12 },
        phase: 'done',
        summary: '已中断',
        interrupted: true,
        applied: 'unknown',
        layer: 'none',
        retryable: true,
      });
    }
    for (const turn of unfinished) {
      await log.append({
        type: 'recovered',
        turn: turn.turn,
        detail: `第 ${turn.turn} 轮在应用退出时中断，补记结束状态。`,
        turnId: turn.turnId,
      });
      await log.append({
        type: 'turn_finished',
        turn: turn.turn,
        status: 'interrupted',
        stopReason: '应用已退出，本轮没有完成',
      });
    }
    await log.patchMeta({ status: 'idle', recoveredAt: Date.now() });
    await log.flush();
  }

  async listThreads(): Promise<Thread[]> {
    return this.sessions
      .list()
      .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt)
      .map((entry) => this.threadOf(entry));
  }

  private threadOf(entry: SessionIndexEntry): Thread {
    return {
      id: entry.sid,
      title: entry.title,
      cwd: entry.workspace,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      status:
        entry.status === 'running' || entry.status === 'waiting_approval' || entry.status === 'failed'
          ? entry.status
          : 'idle',
      ...(entry.pinned ? { pinned: true } : {}),
      turnCount: entry.turnCount,
      steps: entry.steps ?? 0,
      totalTokens: entry.totalTokens ?? 0,
      itemCount: 0,
      lastPrompt: entry.lastPrompt ?? '',
      model: entry.model ?? this.activeModel()?.name ?? '',
    };
  }

  async createThread(title: string, cwd?: string): Promise<ThreadDoc> {
    const log = await SessionLog.create(this.home, {
      workspace: cwd ?? this.workspaceRoot,
      title: title.trim() || 'New session',
    });
    this.sessions.upsert(this.entryOf(log.meta));
    this.sessions.setActive(log.sid);
    await this.sessions.save();
    const doc = this.docOf(log, [], null);
    this.docs.set(log.sid, doc);
    return doc;
  }

  private docOf(log: SessionLog, snapshots: SnapshotMeta[], cachedItems?: Item[] | null): ThreadDoc {
    const entry = this.sessions.get(log.sid) ?? this.entryOf(log.meta);
    const view = new SessionView({
      log,
      entry,
      snapshots,
      model: this.activeModel()?.name ?? '',
    });
    const projected = view.project();
    if (cachedItems) {
      projected.items = cachedItems;
      projected.thread.itemCount = cachedItems.length;
    }
    const thinking = log.all().some((event) => event.type === 'assistant_message' && !!event.reasoning);
    const compacted = log.all().filter((event) => event.type === 'compact').length;
    return {
      thread: projected.thread,
      turn: projected.turn,
      items: projected.items,
      state: {
        plan: projected.plan,
        memory: [],
        resolution: projected.resolution,
        contract: projected.contract,
        context: { ...emptyContext(), thinking, compacted },
        evidence: projected.evidence,
        worktree: (log.meta.worktree as WorktreeState | undefined) ?? null,
      },
      snapshots,
      log,
      view,
    };
  }

  async load(threadId: string): Promise<ThreadDoc | null> {
    const cached = this.docs.get(threadId);
    if (cached) return cached;
    const log = await SessionLog.open(this.home, threadId, { write: false });
    if (!log) {
      // A session directory that vanished is not a session any more.
      this.sessions.remove(threadId);
      return null;
    }
    const snapshots = await this.checkpoints.list(threadId).catch(() => []);
    const doc = this.docOf(log, snapshots);
    this.docs.set(threadId, doc);
    return doc;
  }

  /** Debounced index/meta flush; the ledger itself is written eagerly. */
  async save(threadId: string): Promise<void> {
    const existing = this.saveTimers.get(threadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.saveTimers.delete(threadId);
      void this.saveNow(threadId);
    }, 250);
    this.saveTimers.set(threadId, timer);
  }

  async saveNow(threadId: string): Promise<void> {
    const doc = this.docs.get(threadId);
    if (!doc) return;
    doc.thread.updatedAt = Date.now();
    doc.thread.itemCount = doc.items.length;
    doc.thread.turnCount = Math.max(doc.thread.turnCount, doc.log.meta.turnCount);
    this.sessions.upsert({
      sid: threadId,
      workspace: doc.thread.cwd,
      title: doc.thread.title,
      createdAt: doc.thread.createdAt,
      updatedAt: doc.thread.updatedAt,
      turnCount: doc.thread.turnCount,
      status: doc.log.meta.status,
      steps: doc.thread.steps,
      totalTokens: doc.thread.totalTokens,
      model: doc.thread.model,
      lastPrompt: doc.thread.lastPrompt,
      ...(doc.thread.pinned ? { pinned: true } : {}),
    });
    await doc.log.patchMeta({
      workspace: doc.thread.cwd,
      root: doc.thread.cwd,
      title: doc.thread.title,
      status: doc.log.meta.status,
      turnCount: doc.thread.turnCount,
      steps: doc.thread.steps,
      totalTokens: doc.thread.totalTokens,
      lastPrompt: doc.thread.lastPrompt,
      model: doc.thread.model,
      worktree: doc.state.worktree,
    });
    await doc.log.flush();
    // Status and turn count are read back at boot to decide what needs
    // recovery, so the index is written eagerly rather than debounced.
    await this.sessions.save().catch(() => undefined);
  }

  async flushAll(): Promise<void> {
    for (const threadId of this.docs.keys()) {
      const timer = this.saveTimers.get(threadId);
      if (timer) clearTimeout(timer);
      this.saveTimers.delete(threadId);
      await this.saveNow(threadId);
    }
  }

  /** Flush, then close every ledger handle: the process is going away. */
  async close(): Promise<void> {
    await this.flushAll();
    for (const doc of this.docs.values()) {
      await doc.log.release().catch(() => undefined);
    }
    this.docs.clear();
    await this.sessions.save().catch(() => undefined);
  }

  async deleteThread(threadId: string): Promise<void> {
    const doc = this.docs.get(threadId);
    if (doc) await doc.log.release().catch(() => undefined);
    this.docs.delete(threadId);
    this.sessions.remove(threadId);
    await this.sessions.save();
    await rm(sessionPaths(this.home, threadId).dir, { recursive: true, force: true });
    await rm(join(this.snapshotsDir, threadId), { recursive: true, force: true });
  }

  /**
   * Demo mode builds a transcript in memory; importing it through the same
   * mapping the migration uses keeps one code path for "items become events".
   */
  async seedDemo(doc: SeedDoc): Promise<void> {
    await this.importDoc(doc);
    const loaded = await this.load(doc.thread.id);
    if (loaded) {
      this.sessions.setActive(loaded.thread.id);
      await this.sessions.save();
    }
  }

  private async importDoc(doc: SeedDoc): Promise<void> {
    const { importLegacyDoc } = await import('./runtime/migration.js');
    await importLegacyDoc(this.home, {
      thread: {
        id: doc.thread.id,
        title: doc.thread.title,
        cwd: doc.thread.cwd,
        createdAt: doc.thread.createdAt,
        updatedAt: doc.thread.updatedAt,
        turnCount: doc.thread.turnCount,
        steps: doc.thread.steps,
        totalTokens: doc.thread.totalTokens,
        lastPrompt: doc.thread.lastPrompt,
        model: doc.thread.model,
        status: doc.thread.status,
      },
      turn: doc.turn,
      items: doc.items,
      state: {
        plan: doc.state.plan,
        contract: doc.state.contract,
        resolution: doc.state.resolution,
      },
      snapshots: doc.snapshots,
    });
    const meta = await readJson<SessionMeta | null>(sessionPaths(this.home, doc.thread.id).meta, null);
    if (meta) this.sessions.upsert(this.entryOf(meta));
  }

  async pruneEmpty(): Promise<void> {
    // A session exists only once `session_created` is on disk, so there is no
    // empty thread file to prune; the signature stays for call-site stability.
  }
}