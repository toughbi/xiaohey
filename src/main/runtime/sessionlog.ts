import { open, readFile, stat, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDir, readJson, writeJsonAtomic, writeTextAtomic } from '../util.js';
import { BlobStore } from './blobs.js';
import { HandleTable } from './handles.js';
import {
  DURABLE_EVENTS,
  emptyManifest,
  type EventBase,
  type Manifest,
  type SessionEvent,
  type SessionEventType,
  type SessionMeta,
  type TurnDigest,
  type TurnIndex,
  type TurnIndexEntry,
} from './events.js';

/**
 * The session ledger: `session/<sid>/events.jsonl`, append-only.
 *
 * One writer per session (the process that holds the lock). Everything else in
 * this folder is derived: `turns.index.json` can be rebuilt, the manifest can
 * be rebuilt, blobs and handles are content addressed. Losing any of those
 * costs a recomputation; losing `events.jsonl` costs the session.
 */

export interface SessionPaths {
  dir: string;
  meta: string;
  events: string;
  turnsIndex: string;
  blobs: string;
  handles: string;
  turns: string;
  manifest: string;
  lock: string;
}

export const sessionRoot = (root: string): string => join(root, 'session');
export const sessionDir = (root: string, sid: string): string => join(sessionRoot(root), sid);

export function sessionPaths(root: string, sid: string): SessionPaths {
  const dir = sessionDir(root, sid);
  return {
    dir,
    meta: join(dir, 'meta.json'),
    events: join(dir, 'events.jsonl'),
    turnsIndex: join(dir, 'turns.index.json'),
    blobs: join(dir, 'blobs'),
    handles: join(dir, 'handles.jsonl'),
    turns: join(dir, 'turns'),
    manifest: join(dir, 'manifest.json'),
    lock: join(dir, 'lock'),
  };
}

/** Distributes `Omit` across the event union so `type` still discriminates. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type SessionEventDraft = DistributiveOmit<SessionEvent, 'v' | 'seq' | 'ts' | 'sid' | 'epoch' | 'turn' | 'step'> & {
  turn?: number;
  step?: number;
  itemId?: string;
};

export interface SessionLockInfo {
  pid: number;
  instanceId: string;
  heartbeat: number;
  sid: string;
}

export const LOCK_HEARTBEAT_MS = 10_000;
export const LOCK_STALE_MS = 30_000;

export function pidAlive(pid: number): boolean {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class SessionLog {
  /** Every ledger with an open writer, so a process exit never leaks a handle. */
  static readonly OPEN = new Set<SessionLog>();
  private readonly list: SessionEvent[] = [];
  private seq = 0;
  private handle: FileHandle | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private metaDirty = false;
  private indexDirty = false;
  private manifest: Manifest = emptyManifest();
  private manifestLoaded = false;
  private currentTurn = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private owned = false;

  readonly paths: SessionPaths;
  readonly blobs: BlobStore;
  readonly handles: HandleTable;

  private constructor(
    readonly root: string,
    private metadata: SessionMeta,
  ) {
    this.paths = sessionPaths(root, metadata.sid);
    this.blobs = new BlobStore(this.paths.blobs);
    this.handles = new HandleTable(this.paths.dir, this.blobs);
  }

  /** Create a session (writes `meta.json`, then the `session_created` event). */
  static async create(
    root: string,
    input: { sid?: string; workspace: string; title: string; now?: number },
  ): Promise<SessionLog> {
    const now = input.now ?? Date.now();
    const meta: SessionMeta = {
      sid: input.sid ?? `thr_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      workspace: input.workspace,
      root: input.workspace,
      title: input.title.trim() || 'New session',
      createdAt: now,
      updatedAt: now,
      turnCount: 0,
      status: 'idle',
      schema: 2,
      epoch: 1,
      revertChain: [],
      totalTokens: 0,
      steps: 0,
      lastPrompt: '',
      model: '',
    };
    const log = new SessionLog(root, meta);
    await ensureDir(log.paths.dir);
    await ensureDir(log.paths.turns);
    await writeJsonAtomic(log.paths.meta, meta);
    await log.openWriter();
    log.owned = true;
    await log.append({ type: 'session_created', workspace: meta.workspace, title: meta.title });
    await log.writeLock();
    log.startHeartbeat();
    return log;
  }

  /** Open an existing session; null when it does not exist. */
  static async open(root: string, sid: string, options: { write?: boolean } = {}): Promise<SessionLog | null> {
    const paths = sessionPaths(root, sid);
    const meta = await readJson<SessionMeta | null>(paths.meta, null);
    if (!meta) return null;
    const log = new SessionLog(root, { ...meta, schema: 2 });
    await log.load();
    if (options.write === false) return log;
    const status = await log.acquireLock();
    if (status === 'owned') {
      await log.openWriter();
      log.startHeartbeat();
    }
    return log;
  }

  get meta(): SessionMeta {
    return this.metadata;
  }

  get sid(): string {
    return this.metadata.sid;
  }

  get writable(): boolean {
    return this.owned;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** The logical turn the next append lands in unless it names one. */
  get activeTurn(): number {
    return this.currentTurn;
  }

  set activeTurn(turn: number) {
    this.currentTurn = turn;
  }

  private async openWriter(): Promise<void> {
    await ensureDir(this.paths.dir);
    this.handle = await open(this.paths.events, 'a');
    SessionLog.OPEN.add(this);
  }

  /** Parse the ledger, healing a torn last line and isolating mid-file damage. */
  async load(): Promise<void> {
    await ensureDir(this.paths.dir);
    let raw = await readFile(this.paths.events, 'utf8').catch(() => '');
    let isolated = '';
    if (raw && !raw.endsWith('\n')) {
      // The process died mid-append: the last line is not a complete event.
      const cut = raw.lastIndexOf('\n') + 1;
      isolated = raw.slice(cut);
      raw = raw.slice(0, cut);
      await writeTextAtomic(this.paths.events, raw);
    }
    const parsed: SessionEvent[] = [];
    let damaged = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as SessionEvent;
        if (!event || typeof event.seq !== 'number' || typeof event.type !== 'string') throw new Error('bad event');
        parsed.push(event);
      } catch {
        damaged += 1;
      }
    }
    if (damaged > 0) {
      const backup = `${this.paths.events}.corrupt-${Date.now()}`;
      await writeTextAtomic(backup, raw);
      // Keep every line that parsed; the damaged ones are preserved in `backup`.
      await writeTextAtomic(this.paths.events, parsed.map((event) => `${JSON.stringify(event)}\n`).join(''));
    }
    parsed.sort((a, b) => a.seq - b.seq);
    this.list.length = 0;
    this.list.push(...parsed);
    this.seq = parsed.reduce((max, event) => Math.max(max, event.seq), 0);
    const lastTurn = parsed.filter((event) => event.type === 'turn_started').at(-1);
    this.currentTurn = lastTurn ? lastTurn.turn : 0;
    if (damaged > 0 || isolated) {
      this.metadata.updatedAt = Date.now();
      await writeJsonAtomic(this.paths.meta, this.metadata);
    }
    await this.handles.load();
    await this.manifestFile();
    await this.writeTurnIndex();
  }

  /**
   * Single-writer lock. Owned when free, stale, or already ours; a live foreign
   * writer means this process may only read.
   */
  async acquireLock(): Promise<'owned' | 'readonly'> {
    const info = await readJson<SessionLockInfo | null>(this.paths.lock, null);
    const now = Date.now();
    if (info && info.instanceId !== instanceId()) {
      const stale = now - info.heartbeat > LOCK_STALE_MS && !pidAlive(info.pid);
      if (!stale) return 'readonly';
    }
    this.owned = true;
    await this.writeLock();
    return 'owned';
  }

  private async writeLock(): Promise<void> {
    const info: SessionLockInfo = {
      pid: process.pid,
      instanceId: instanceId(),
      heartbeat: Date.now(),
      sid: this.metadata.sid,
    };
    await writeJsonAtomic(this.paths.lock, info).catch(() => undefined);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => void this.writeLock(), LOCK_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  async release(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    await this.flush();
    await this.writeTurnIndex();
    if (this.metaDirty) {
      this.metaDirty = false;
      await writeJsonAtomic(this.paths.meta, this.metadata).catch(() => undefined);
    }
    if (this.handle) {
      await this.handle.close().catch(() => undefined);
      this.handle = null;
      SessionLog.OPEN.delete(this);
    }
    if (this.owned) {
      const info = await readJson<SessionLockInfo | null>(this.paths.lock, null);
      if (!info || info.instanceId === instanceId()) {
        await writeFile(this.paths.lock, JSON.stringify({ ...info, releasedAt: Date.now() }), 'utf8').catch(
          () => undefined,
        );
      }
      this.owned = false;
    }
  }

  /** All events in write order, including reverted branches. */
  all(): readonly SessionEvent[] {
    return this.list;
  }

  /**
   * The active view: events of the current epoch plus, for every ancestor
   * epoch, events up to the sequence its revert cut at. Reverted branches stay
   * on disk for audit.
   */
  activeEvents(): SessionEvent[] {
    const chain = new Map(this.metadata.revertChain.map((entry) => [entry.epoch, entry.toSeq]));
    const epoch = this.metadata.epoch;
    return this.list.filter((event) => {
      if (event.epoch === epoch) return true;
      const cut = chain.get(event.epoch);
      return cut !== undefined && event.seq <= cut;
    });
  }

  eventsForTurn(turn: number, options: { includeReverted?: boolean } = {}): SessionEvent[] {
    const source = options.includeReverted ? this.list : this.activeEvents();
    return source.filter((event) => event.turn === turn);
  }

  private async ready(): Promise<void> {
    if (this.handle) return;
    if (!this.owned) {
      const status = await this.acquireLock();
      if (status !== 'owned') throw new Error(`session ${this.metadata.sid} is read-only: another instance is writing`);
    }
    await this.openWriter();
  }

  async append(draft: SessionEventDraft): Promise<SessionEvent> {
    const [event] = await this.appendMany([draft]);
    return event;
  }

  /** Append in order, one fsync for the whole batch when any event is durable. */
  async appendMany(drafts: readonly SessionEventDraft[]): Promise<SessionEvent[]> {
    if (drafts.length === 0) return [];
    await this.ready();
    const created: SessionEvent[] = [];
    const lines: string[] = [];
    let durable = false;
    for (const draft of drafts) {
      // A `turn_started` without an explicit number opens the next turn; every
      // other event belongs to the turn already open (turn 0 = session-level).
      const turn =
        draft.turn !== undefined
          ? draft.turn
          : draft.type === 'turn_started'
            ? this.currentTurn + 1
            : this.currentTurn;
      const base: EventBase = {
        v: 1,
        seq: this.seq + 1,
        ts: Date.now(),
        sid: this.metadata.sid,
        epoch: this.metadata.epoch,
        turn,
        step: draft.step ?? 0,
      };
      if (draft.itemId) base.itemId = draft.itemId;
      const event = { ...draft, ...base } as SessionEvent;
      this.seq = base.seq;
      created.push(event);
      this.list.push(event);
      lines.push(`${JSON.stringify(event)}\n`);
      if (DURABLE_EVENTS.has(event.type as SessionEventType)) durable = true;
      this.note(event);
    }
    this.metadata.updatedAt = Date.now();
    this.metaDirty = true;
    const payload = lines.join('');
    this.writeChain = this.writeChain.then(async () => {
      const handle = this.handle;
      if (!handle) return;
      await handle.write(payload);
      if (durable) await handle.datasync();
    });
    await this.writeChain;
    if (created.some((event) => event.type === 'turn_started' || event.type === 'turn_finished')) {
      this.metaDirty = false;
      await writeJsonAtomic(this.paths.meta, this.metadata).catch(() => undefined);
    }
    return created;
  }

  private note(event: SessionEvent): void {
    switch (event.type) {
      case 'turn_started':
        this.currentTurn = event.turn;
        this.metadata.turnCount = Math.max(this.metadata.turnCount, event.turn);
        this.metadata.status = 'running';
        this.metadata.lastPrompt = event.userText.slice(0, 200);
        this.indexDirty = true;
        break;
      case 'turn_finished':
        this.metadata.status =
          event.status === 'completed' ? 'idle' : event.status === 'cancelled' ? 'idle' : 'failed';
        this.indexDirty = true;
        break;
      case 'session_created':
        this.metadata.workspace = event.workspace;
        this.metadata.title = event.title;
        break;
      case 'revert':
        this.metadata.epoch = event.newEpoch;
        this.metadata.revertChain = [...this.metadata.revertChain, { epoch: event.epoch, toSeq: event.toSeq }];
        this.indexDirty = true;
        break;
      case 'plan_updated':
      case 'contract_set':
      case 'resolution_updated':
      case 'consolidated':
        break;
      default:
        break;
    }
  }

  /** Update metadata (title, workspace, worktree, totals) and persist shortly. */
  async patchMeta(patch: Partial<SessionMeta>): Promise<void> {
    Object.assign(this.metadata, patch);
    this.metadata.updatedAt = Date.now();
    await writeJsonAtomic(this.paths.meta, this.metadata).catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.writeChain;
    if (this.metaDirty) {
      this.metaDirty = false;
      await writeJsonAtomic(this.paths.meta, this.metadata).catch(() => undefined);
    }
    if (this.indexDirty) {
      this.indexDirty = false;
      await this.writeTurnIndex().catch(() => undefined);
    }
  }

  /** Derived turn index; rebuilt from active events (cheap, deterministic). */
  turnEntries(): TurnIndexEntry[] {
    const active = this.activeEvents();
    const byTurn = new Map<number, TurnIndexEntry>();
    for (const event of active) {
      if (event.turn <= 0) continue;
      let entry = byTurn.get(event.turn);
      if (!entry) {
        entry = {
          turn: event.turn,
          turnId: '',
          epoch: event.epoch,
          firstSeq: event.seq,
          lastSeq: event.seq,
          startedAt: event.ts,
          status: 'running',
          level: this.manifest.levels[event.turn] ?? 0,
          reverted: false,
        };
        byTurn.set(event.turn, entry);
      }
      entry.lastSeq = Math.max(entry.lastSeq, event.seq);
      entry.firstSeq = Math.min(entry.firstSeq, event.seq);
      if (event.type === 'turn_started') {
        entry.turnId = event.turnId;
        entry.startedAt = event.ts;
      } else if (event.type === 'turn_finished') {
        entry.status = event.status;
        entry.endedAt = event.ts;
      } else if (event.type === 'compact') {
        entry.artifact = event.artifact;
        entry.level = event.level;
      }
    }
    const artifactByTurn = new Map(Object.values(this.manifest.artifacts).map((entry) => [entry.turn, entry.artifact]));
    for (const entry of byTurn.values()) {
      if (!entry.artifact) entry.artifact = artifactByTurn.get(entry.turn);
      if (!entry.artifact) entry.level = this.manifest.levels[entry.turn] ?? entry.level;
    }
    return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
  }

  async writeTurnIndex(): Promise<void> {
    const index: TurnIndex = { turns: this.turnEntries() };
    await writeJsonAtomic(this.paths.turnsIndex, index).catch(() => undefined);
  }

  /** Turns that started but never finished — the crash signal. */
  unfinishedTurns(): TurnIndexEntry[] {
    return this.turnEntries().filter((entry) => entry.status === 'running');
  }

  /** A tool call with no result in the active view. */
  orphanToolCalls(): Array<{ seq: number; turn: number; step: number; callId: string; name: string; args: string }> {
    const answered = new Set(
      this.activeEvents()
        .filter((event): event is Extract<SessionEvent, { type: 'tool_result' }> => event.type === 'tool_result')
        .map((event) => event.callId),
    );
    const out: Array<{ seq: number; turn: number; step: number; callId: string; name: string; args: string }> = [];
    for (const event of this.activeEvents()) {
      if (event.type !== 'tool_call' || answered.has(event.callId)) continue;
      out.push({
        seq: event.seq,
        turn: event.turn,
        step: event.step,
        callId: event.callId,
        name: event.name,
        args: 'text' in event.args ? event.args.text : event.args.preview,
      });
    }
    return out;
  }

  /** Append the revert marker and move to a new epoch. */
  async revertTo(toSeq: number, reason?: string): Promise<SessionEvent> {
    const newEpoch = this.metadata.epoch + 1;
    const event = await this.append({ type: 'revert', toSeq, newEpoch, turn: 0, ...(reason ? { reason } : {}) });
    this.currentTurn = 0;
    return event;
  }

  async manifestFile(): Promise<Manifest> {
    if (this.manifestLoaded) return this.manifest;
    this.manifest = await readJson<Manifest>(this.paths.manifest, emptyManifest());
    if (!this.manifest.artifacts) this.manifest.artifacts = {};
    if (!this.manifest.levels) this.manifest.levels = {};
    this.manifestLoaded = true;
    return this.manifest;
  }

  async saveManifest(): Promise<void> {
    this.manifestLoaded = true;
    await writeJsonAtomic(this.paths.manifest, this.manifest).catch(() => undefined);
  }

  async setLevel(turn: number, level: 0 | 1 | 2 | 3): Promise<void> {
    const manifest = await this.manifestFile();
    manifest.levels[turn] = level;
    await this.saveManifest();
  }

  /** Persist several sticky levels in one write (assembly recalculates a window). */
  async setLevels(levels: Record<number, 0 | 1 | 2 | 3>): Promise<void> {
    const manifest = await this.manifestFile();
    let changed = false;
    for (const [key, level] of Object.entries(levels)) {
      const turn = Number(key);
      if (manifest.levels[turn] === level) continue;
      manifest.levels[turn] = level;
      changed = true;
    }
    if (changed) await this.saveManifest();
  }

  /** Persist an L2 artifact + manifest lineage + the `compact` event. */
  async recordCompact(input: {
    turn: number;
    rawRange: [number, number];
    sourceHash: string;
    artifact: string;
    model: string;
    promptVersion: number;
    degraded: boolean;
    digest: TurnDigest;
  }): Promise<void> {
    const manifest = await this.manifestFile();
    manifest.artifacts[String(input.turn)] = {
      turn: input.turn,
      rawRange: input.rawRange,
      sourceHash: input.sourceHash,
      artifact: input.artifact,
      model: input.model,
      promptVersion: input.promptVersion,
      createdAt: Date.now(),
      degraded: input.degraded,
    };
    manifest.levels[input.turn] = 2;
    await ensureDir(this.paths.turns);
    await writeJsonAtomic(join(this.paths.dir, input.artifact), input.digest).catch(() => undefined);
    await this.saveManifest();
    // `turn: 0` on purpose: a compact marker belongs to the session, not to
    // the turn it describes — appending it to that turn would change the very
    // source hash the artifact is keyed on.
    await this.append({
      type: 'compact',
      turn: 0,
      turnRange: [input.turn, input.turn],
      artifact: input.artifact,
      sourceHash: input.sourceHash,
      level: 2,
      model: input.model,
      promptVersion: input.promptVersion,
      degraded: input.degraded,
    });
  }

  async artifactJson(artifact: string): Promise<unknown | null> {
    return readJson<unknown | null>(join(this.paths.dir, artifact), null);
  }

  /** Bytes currently held by the ledger, for the settings panel. */
  async diskUsage(): Promise<{ events: number; blobs: number }> {
    const events = await stat(this.paths.events).then((info) => info.size).catch(() => 0);
    let blobs = 0;
    const { readdir } = await import('node:fs/promises');
    const shards = await readdir(this.paths.blobs).catch(() => [] as string[]);
    for (const shard of shards) {
      const files = await readdir(join(this.paths.blobs, shard)).catch(() => [] as string[]);
      for (const file of files) {
        blobs += await stat(join(this.paths.blobs, shard, file)).then((info) => info.size).catch(() => 0);
      }
    }
    return { events, blobs };
  }
}

const INSTANCE_ID = `inst_${process.pid}_${randomUUID().slice(0, 8)}`;
const instanceId = (): string => INSTANCE_ID;

export interface SessionIndexEntry {
  sid: string;
  workspace: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  status: SessionMeta['status'];
  pinned?: boolean;
  /** Denormalised for the sidebar, so listing sessions opens no ledger. */
  steps?: number;
  totalTokens?: number;
  model?: string;
  lastPrompt?: string;
}

export interface SessionIndexFile {
  version: 1;
  workspaceRoot: string;
  active: string | null;
  order: string[];
  sessions: Record<string, SessionIndexEntry>;
}

export const emptySessionIndex = (workspaceRoot: string): SessionIndexFile => ({
  version: 1,
  workspaceRoot,
  active: null,
  order: [],
  sessions: {},
});

/** `session/index.json`: the list the sidebar reads without opening any session. */
export class SessionIndex {
  readonly file: string;
  private state: SessionIndexFile;

  constructor(root: string, workspaceRoot: string) {
    this.file = join(sessionRoot(root), 'index.json');
    this.state = emptySessionIndex(workspaceRoot);
  }

  async load(): Promise<void> {
    const raw = await readJson<SessionIndexFile | null>(this.file, null);
    if (raw && Array.isArray(raw.order) && raw.sessions) {
      this.state = {
        version: 1,
        workspaceRoot: raw.workspaceRoot ?? this.state.workspaceRoot,
        active: raw.active ?? null,
        order: raw.order.filter((sid) => typeof sid === 'string'),
        sessions: raw.sessions,
      };
    }
  }

  get workspaceRoot(): string {
    return this.state.workspaceRoot;
  }

  set workspaceRoot(next: string) {
    this.state.workspaceRoot = next;
  }

  get active(): string | null {
    return this.state.active;
  }

  get order(): string[] {
    return this.state.order;
  }

  get(sid: string): SessionIndexEntry | null {
    return this.state.sessions[sid] ?? null;
  }

  list(): SessionIndexEntry[] {
    return this.state.order
      .map((sid) => this.state.sessions[sid])
      .filter((entry): entry is SessionIndexEntry => !!entry);
  }

  upsert(entry: SessionIndexEntry): void {
    this.state.sessions[entry.sid] = { ...this.state.sessions[entry.sid], ...entry };
    if (!this.state.order.includes(entry.sid)) this.state.order.unshift(entry.sid);
  }

  remove(sid: string): void {
    delete this.state.sessions[sid];
    this.state.order = this.state.order.filter((id) => id !== sid);
    if (this.state.active === sid) this.state.active = this.state.order[0] ?? null;
  }

  setActive(sid: string | null): void {
    this.state.active = sid;
  }

  setPinned(sid: string, pinned: boolean): void {
    const entry = this.state.sessions[sid];
    if (entry) entry.pinned = pinned;
  }

  async save(): Promise<void> {
    await writeJsonAtomic(this.file, this.state);
  }
}

// A test or a crashed test process may leave a writer open; close it before the
// process drains so no file descriptor is reclaimed by the garbage collector.
process.once('beforeExit', () => {
  for (const log of [...SessionLog.OPEN]) void log.release().catch(() => undefined);
});