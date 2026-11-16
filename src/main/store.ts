import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Item, ModelProfile, ModelSettings, PlanStep, Settings, SnapshotMeta, Thread, Turn } from '../shared/types.js';
import type { Contract } from './runtime/contract.js';
import type { JournalRecord } from './runtime/journal.js';
import type { MemoryRecord } from './runtime/memory.js';
import type { ResolutionState } from './runtime/resolve.js';
import type { ContextState } from './runtime/context.js';
import { emptyContext } from './runtime/context.js';
import { emptyResolution } from './runtime/resolve.js';
import { ensureDir, readJson, uid, writeJsonAtomic } from './util.js';

export interface ThreadState {
  plan: PlanStep[];
  memory: MemoryRecord[];
  resolution: ResolutionState;
  contract: Contract | null;
  context: ContextState;
  journal: JournalRecord[];
  evidence: string[];
}

export interface ThreadDoc {
  thread: Thread;
  turn: Turn | null;
  items: Item[];
  state: ThreadState;
  snapshots: SnapshotMeta[];
}

export interface AppIndex {
  workspaceRoot: string;
  activeThreadId: string | null;
  threadOrder: string[];
  /** Tokens spent per local day, `YYYY-MM-DD` → total. */
  tokenDays?: Record<string, number>;
}

export const DEFAULT_PROFILE = {
  id: 'default',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.4,
  maxOutputTokens: 4096,
  contextWindow: 131_072,
} as const;

export const DEFAULT_SETTINGS: Settings = {
  models: [],
  activeModelId: '',
  approval: 'ask',
  allowedCommands: [],
};

export function emptyState(): ThreadState {
  return {
    plan: [],
    memory: [],
    resolution: emptyResolution(),
    contract: null,
    context: emptyContext(),
    journal: [],
    evidence: [],
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
        typeof profile.maxOutputTokens === 'number' ? profile.maxOutputTokens : DEFAULT_PROFILE.maxOutputTokens,
      contextWindow:
        typeof profile.contextWindow === 'number' ? profile.contextWindow : DEFAULT_PROFILE.contextWindow,
      ...(typeof profile.provider === 'string' && profile.provider.trim()
        ? { provider: profile.provider.trim() }
        : {}),
      ...(typeof profile.enabled === 'boolean' ? { enabled: profile.enabled } : {}),
      ...(profile.billing === 'plan' || profile.billing === 'payg' ? { billing: profile.billing } : {}),
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

  return { models, activeModelId, approval, allowedCommands, recentWorkspaces };
}

export class Store {
  readonly settingsFile: string;
  readonly indexFile: string;
  readonly threadsDir: string;
  readonly leasesFile: string;
  readonly snapshotsDir: string;

  private index: AppIndex;
  private settings: Settings;
  readonly docs = new Map<string, ThreadDoc>();
  private saveTimers = new Map<string, NodeJS.Timeout>();
  private indexTimer: NodeJS.Timeout | null = null;

  constructor(readonly home: string, workspaceRoot: string) {
    this.settingsFile = join(home, 'settings.json');
    this.indexFile = join(home, 'index.json');
    this.threadsDir = join(home, 'threads');
    this.leasesFile = join(home, 'leases.json');
    this.snapshotsDir = join(home, 'snapshots');
    this.index = { workspaceRoot, activeThreadId: null, threadOrder: [] };
    this.settings = structuredClone(DEFAULT_SETTINGS);
  }

  async init(): Promise<void> {
    await ensureDir(this.home);
    await ensureDir(this.threadsDir);
    await ensureDir(this.snapshotsDir);
    const rawSettings = await readJson<unknown>(join(this.home, 'settings.json'), null);
    this.settings = normalizeSettings(rawSettings);
    // Repair the file when it was missing, invalid, or still in the old shape,
    // so the next boot does not re-parse garbage.
    if (JSON.stringify(rawSettings) !== JSON.stringify(this.settings)) {
      await writeJsonAtomic(this.settingsFile, this.settings);
    }
    this.index = await readJson(join(this.home, 'index.json'), this.index);
  }

  get workspaceRoot(): string {
    return this.index.workspaceRoot;
  }

  set workspaceRoot(next: string) {
    this.index.workspaceRoot = next;
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
    await this.saveNow(threadId);
    return doc.thread;
  }

  async saveIndex(): Promise<void> {
    await writeJsonAtomic(this.indexFile, this.index);
  }

  tokenDays(): Record<string, number> {
    return this.index.tokenDays ?? {};
  }

  /** Accumulate tokens for one local day; the index is flushed shortly after. */
  addTokens(date: string, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const days = this.index.tokenDays ?? (this.index.tokenDays = {});
    days[date] = (days[date] ?? 0) + Math.round(tokens);
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      void this.saveIndex();
    }, 600);
  }

  /** Give every unanswered tool call an explicit interrupted result. */
  closeOpenToolCalls(doc: ThreadDoc): void {
    const answered = new Set(doc.items.filter((item) => item.kind === 'tool_result').map((item) => item.callId));
    for (const item of doc.items) {
      if (item.kind !== 'tool_call' || answered.has(item.callId)) continue;
      doc.items.push({
        id: uid('itm'),
        threadId: doc.thread.id,
        turnId: item.turnId,
        at: Date.now(),
        status: 'done',
        kind: 'tool_result',
        callId: item.callId,
        name: item.name,
        ok: false,
        summary: '已中断',
        output: '应用退出，工具没有返回结果。',
        layer: 'none',
        retryable: true,
      });
      answered.add(item.callId);
    }
  }

  activeThreadId(): string | null {
    return this.index.activeThreadId;
  }

  async setActive(threadId: string | null): Promise<void> {
    this.index.activeThreadId = threadId;
    await this.saveIndex();
  }

  /**
   * A turn cannot survive the app process. Anything still marked running at
   * boot is a leftover from a quit or a crash: close it so the UI never shows
   * a spinner for a turn that no longer exists.
   */
  async recoverInterrupted(): Promise<void> {
    const threads = await this.listThreads();
    for (const thread of threads) {
      const doc = await this.load(thread.id);
      if (!doc) continue;
      const turnRunning = doc.turn?.status === 'running';
      const threadRunning = doc.thread.status === 'running' || doc.thread.status === 'waiting_approval';
      if (!turnRunning && !threadRunning) continue;
      doc.thread.status = 'idle';
      const turnId = doc.turn?.id ?? [...doc.items].reverse().find((item) => item.turnId)?.turnId ?? 'system';
      if (doc.turn && doc.turn.status === 'running') {
        doc.turn.status = 'cancelled';
        doc.turn.endedAt = Date.now();
      }
      if (!doc.items.some((item) => item.kind === 'notice' && item.title === '应用已退出')) {
        doc.items.push({
          id: uid('itm'),
          threadId: thread.id,
          turnId,
          at: Date.now(),
          status: 'done',
          kind: 'notice',
          tone: 'warn',
          title: '应用已退出',
          body: '上一轮在应用关闭时中断，没有完成。',
        });
      }
      for (const item of doc.items) {
        if (item.status === 'running') item.status = 'cancelled';
      }
      this.closeOpenToolCalls(doc);
      await this.saveNow(thread.id);
    }
  }

  async listThreads(): Promise<Thread[]> {
    const threads: Thread[] = [];
    for (const id of this.index.threadOrder) {
      const doc = await this.load(id);
      if (doc) threads.push(doc.thread);
    }
    return threads;
  }

  async createThread(title: string, cwd?: string): Promise<ThreadDoc> {
    const now = Date.now();
    const thread: Thread = {
      id: uid('thr'),
      title: title.trim() || 'New session',
      cwd: cwd ?? this.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      status: 'idle',
      pinned: false,
      turnCount: 0,
      steps: 0,
      totalTokens: 0,
      itemCount: 0,
      lastPrompt: '',
      model: this.activeModel()?.model ?? '',
    };
    const doc: ThreadDoc = { thread, turn: null, items: [], state: emptyState(), snapshots: [] };
    this.docs.set(thread.id, doc);
    this.index.threadOrder.unshift(thread.id);
    this.index.activeThreadId = thread.id;
    await this.saveIndex();
    await this.saveNow(thread.id);
    return doc;
  }

  async load(threadId: string): Promise<ThreadDoc | null> {
    const cached = this.docs.get(threadId);
    if (cached) return cached;
    const doc = await readJson<ThreadDoc | null>(join(this.threadsDir, `${threadId}.json`), null);
    if (!doc) return null;
    doc.thread.steps ??= 0;
    doc.thread.totalTokens ??= 0;
    doc.state = { ...emptyState(), ...doc.state };
    doc.state.resolution = { ...emptyResolution(), ...doc.state.resolution };
    doc.state.context = { ...emptyContext(), ...doc.state.context };
    this.docs.set(threadId, doc);
    return doc;
  }

  async save(threadId: string): Promise<void> {
    const existing = this.saveTimers.get(threadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.saveTimers.delete(threadId);
      void this.saveNow(threadId);
    }, 350);
    this.saveTimers.set(threadId, timer);
  }

  async saveNow(threadId: string): Promise<void> {
    const doc = this.docs.get(threadId);
    if (!doc) return;
    doc.thread.updatedAt = Date.now();
    doc.thread.itemCount = doc.items.length;
    doc.thread.turnCount = doc.thread.turnCount;
    await writeJsonAtomic(join(this.threadsDir, `${threadId}.json`), doc);
  }

  async flushAll(): Promise<void> {
    for (const threadId of this.docs.keys()) {
      const timer = this.saveTimers.get(threadId);
      if (timer) clearTimeout(timer);
      this.saveTimers.delete(threadId);
      await this.saveNow(threadId);
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.docs.delete(threadId);
    this.index.threadOrder = this.index.threadOrder.filter((id) => id !== threadId);
    if (this.index.activeThreadId === threadId) this.index.activeThreadId = this.index.threadOrder[0] ?? null;
    await this.saveIndex();
    await rm(join(this.threadsDir, `${threadId}.json`), { force: true });
    await rm(join(this.snapshotsDir, threadId), { recursive: true, force: true });
  }

  async seedDemo(doc: ThreadDoc): Promise<void> {
    this.docs.set(doc.thread.id, doc);
    this.index.threadOrder = [doc.thread.id, ...this.index.threadOrder.filter((id) => id !== doc.thread.id)];
    this.index.activeThreadId = doc.thread.id;
    await this.saveIndex();
    await this.saveNow(doc.thread.id);
  }

  async pruneEmpty(): Promise<void> {
    try {
      const files = await readdir(this.threadsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const id = file.replace(/\.json$/, '');
        if (!this.index.threadOrder.includes(id)) await mkdir(this.threadsDir, { recursive: true });
      }
    } catch {
      // best effort only
    }
  }
}
