import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { MemoryFact } from '../../shared/types.js';
import { clamp, ensureDir, uid, writeTextAtomic } from '../util.js';
import { redactSecrets } from './redact.js';
import { ConfiguredEmbedder, cosineSimilarity, type Embedder } from './embedding.js';
import { normalizeScores, MAX_RERANK_DOCUMENTS, type Reranker } from './rerank.js';
import { classify, scopeKeyOf, type MemoryRecord, type MemoryScope } from './memory.js';
import { memoryArchiveFile, memoryFile, memoryRoot, memoryVectorFile } from './memdir.js';
import { metaComment, oneLine, readMetaComments, stamp } from './memmark.js';

/**
 * Long-term memory.
 *
 * Three kinds, because they answer different questions and decay differently:
 *  - episodic   what happened, where, when, and whether it worked;
 *  - relational how to refer to a person/thing, usually anchored to an episode;
 *  - knowledge  stable facts and constraints.
 *
 * The file is `~/.xiaohei/memory.md`, archived entries go to
 * `~/.xiaohei/memory-archive.md`. The model is not given the contents in its
 * prompt: it decides when to call `memory_read`, which is what makes memory a
 * decision instead of a background dump.
 *
 * Forgetting follows the shape of the Ebbinghaus curve: only entries untouched
 * for `FORGET_AFTER_DAYS` decay, each decay interval multiplies importance by
 * exp(-interval / stability) where stability grows with importance, and an entry
 * that falls below `ARCHIVE_BELOW` is moved to the archive. A recall wakes an
 * archived entry back into the active file.
 *
 * Recall is hybrid. Keyword scoring (substring + CJK character bigram coverage)
 * still catches exact names and slots; a vector index (`memory-vectors.json`)
 * catches wording that shares meaning but not characters. The two scores are
 * fused before the importance/recency rank. Without an embedding provider the
 * vector side falls back to a local hashed-lexical vector, so recall still works
 * offline; a configured OpenAI-compatible `/embeddings` endpoint makes it
 * semantic.
 */

export type MemoryKind = 'episodic' | 'relational' | 'knowledge';
export type MemoryStatus = 'active' | 'disputed';
export type EpisodicOutcome = 'success' | 'failure' | 'partial' | 'unknown';
export type ArchiveReason = 'forgotten' | 'superseded' | 'manual';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  title: string;
  /** The primary statement: what happened / who someone is / the fact. */
  detail: string;
  /** 1–100, chosen by the model at write time. */
  importance: number;
  createdAt: number;
  updatedAt: number;
  lastRecalledAt?: number;
  lastDecayedAt: number;
  recallCount: number;
  decayCount: number;
  source: string;
  status: MemoryStatus;
  /** Episodic: 何时、何地、结果。 */
  when?: string;
  where?: string;
  result?: string;
  outcome?: EpisodicOutcome;
  /** Relational: 指代 → 指称对象，以及关联的情景记忆 id。 */
  alias?: string;
  referent?: string;
  relation?: string;
  episodeId?: string;
  /** Knowledge: stable fact/constraint, optionally slotted for conflict handling. */
  slot?: string;
  scope?: MemoryScope;
  tags?: string[];
  /** Archive bookkeeping. */
  archivedAt?: number;
  archiveReason?: ArchiveReason;
  supersededBy?: string;
  conflictWith?: string;
  /** Consolidation lineage: one key per (kind, session, turn range, title). */
  dedupeKey?: string;
  sourceSession?: string;
  sourceTurns?: [number, number];
  /** The session that produced this memory was deleted; the memory is kept. */
  sourceDeleted?: boolean;
  /** The source turns were reverted, so the memory needs a second look. */
  sourceReverted?: boolean;
  confidence?: 'high' | 'medium' | 'low';
  /** Where the statement came from: user statement, tool output, model inference. */
  trust?: 'user' | 'tool' | 'assistant';
}

export interface MemoryWriteArgs {
  kind: MemoryKind;
  detail: string;
  importance: number;
  title?: string;
  when?: string;
  where?: string;
  result?: string;
  outcome?: EpisodicOutcome;
  alias?: string;
  referent?: string;
  relation?: string;
  episodeId?: string;
  slot?: string;
  scope?: 'global' | 'workspace';
  tags?: string[];
}

export interface MemoryWriteInput extends Omit<MemoryWriteArgs, 'scope'> {
  scope?: MemoryScope;
  source: string;
  /** Set only by the UI to edit an existing entry in place. */
  id?: string;
  dedupeKey?: string;
  sourceSession?: string;
  sourceTurns?: [number, number];
  confidence?: 'high' | 'medium' | 'low';
  trust?: 'user' | 'tool' | 'assistant';
}

export type WriteVerdict = 'created' | 'supersede' | 'contradict' | 'distinct';

export interface WriteReceipt {
  kind: WriteVerdict;
  entry: MemoryEntry;
  note: string;
}

export interface RecallArgs {
  query?: string;
  kind?: MemoryKind | 'all';
  limit?: number;
  includeArchived?: boolean;
  wake?: boolean;
}

export interface RecallHit {
  entry: MemoryEntry;
  archived: boolean;
  /** Fused score used for ranking (hybrid or keyword-only). */
  relevance: number;
  keyword?: number;
  vector?: number;
}

export type RecallMode = 'hybrid' | 'keyword' | 'browse' | 'hybrid+rerank';

export interface RecallResult {
  query: string;
  hits: RecallHit[];
  woken: MemoryEntry[];
  activeTotal: number;
  archiveTotal: number;
  mode: RecallMode;
  vectorUsed: boolean;
  vectorLabel?: string;
  /** Why the vector side was skipped (provider error, dimension mismatch, ...). */
  vectorReason?: string;
  rerankUsed?: boolean;
  rerankLabel?: string;
  /** Why reranking was skipped after being configured. */
  rerankReason?: string;
}

export interface ForgetReport {
  checkedAt: number;
  decayed: number;
  archived: number;
  entries: Array<{ id: string; title: string; from: number; to: number; archived: boolean }>;
}

export const MEMORY_KINDS: readonly MemoryKind[] = ['episodic', 'relational', 'knowledge'];
export const KIND_LABEL: Record<MemoryKind, string> = {
  episodic: '情景记忆',
  relational: '关系记忆',
  knowledge: '知识记忆',
};
export const KIND_HINT: Record<MemoryKind, string> = {
  episodic: '何时、何地、发生了什么、结果如何（成功或失败）',
  relational: '某个称呼指代谁/什么，通常关联到一段情景',
  knowledge: '稳定的事实、约束或陈述',
};

export const FORGET_AFTER_DAYS = 30;
export const ARCHIVE_BELOW = 15;
export const RECALL_BOOST = 4;
export const WAKE_IMPORTANCE = 30;
export const MAX_ACTIVE = 400;
export const MAX_TAGS = 8;

/** Hybrid recall: vector dominates semantics, keyword keeps exact names/slots safe. */
export const HYBRID_VECTOR_WEIGHT = 0.6;
export const HYBRID_KEYWORD_WEIGHT = 0.4;
export const MIN_KEYWORD_RELEVANCE = 0.2;
export const MIN_ARCHIVED_KEYWORD_RELEVANCE = 0.5;
/**
 * Calibrated against two embedders: local hashing puts related pairs at
 * 0.30–0.36 and unrelated at ~0, qwen-class models put related pairs at
 * 0.36–0.75 and unrelated at ~0.2. So 0.30 admits real matches without turning
 * every entry into a candidate; archived entries need a stronger signal because
 * waking is a write.
 */
export const MIN_VECTOR_SIMILARITY = 0.3;
export const MIN_ARCHIVED_VECTOR_SIMILARITY = 0.45;
/**
 * Rerank blending. Rerank scores are min-max normalized per pool first, so a
 * provider that returns 0.55–0.66 and one that returns 0–1 behave the same.
 */
export const RERANK_WEIGHT = 0.7;
export const RERANK_IMPORTANCE_WEIGHT = 0.2;
export const RERANK_RECENCY_WEIGHT = 0.1;
export const RERANK_POOL_FACTOR = 4;
export const RERANK_POOL_MIN = 20;
export const VECTOR_CANDIDATE_FACTOR = 3;
export const MAX_VECTOR_ENTRIES = 800;

const DAY = 86_400_000;

const isKind = (value: unknown): value is MemoryKind =>
  typeof value === 'string' && (MEMORY_KINDS as readonly string[]).includes(value);

/** Recency weight used by both the hybrid rank and the rerank blend. */
const recencyOf = (entry: MemoryEntry, now = Date.now()): number => {
  const ageDays = Math.max(0, (now - (entry.lastRecalledAt ?? entry.updatedAt)) / DAY);
  return 1 / (1 + ageDays / 60);
};

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const clean = value.trim();
  return clean.length > 0 ? clean : undefined;
};

const outcomeOf = (value: unknown): EpisodicOutcome | undefined =>
  value === 'success' || value === 'failure' || value === 'partial' || value === 'unknown' ? value : undefined;

const scopeOf = (value: unknown): MemoryScope | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'global') return { kind: 'global' };
  if (raw.kind === 'workspace') return { kind: 'workspace' };
  if (raw.kind === 'path' && typeof raw.path === 'string' && raw.path.trim()) return { kind: 'path', path: raw.path.trim() };
  return undefined;
};

const sameScope = (a: MemoryScope | undefined, b: MemoryScope | undefined): boolean =>
  scopeKeyOf(a ?? { kind: 'global' }) === scopeKeyOf(b ?? { kind: 'global' });

const titleOf = (input: { kind: MemoryKind; title?: string; detail: string; alias?: string; referent?: string; slot?: string }): string => {
  if (input.title && input.title.trim()) return oneLine(input.title, 120);
  if (input.kind === 'relational' && input.alias) {
    return oneLine(input.referent ? `${input.alias} → ${input.referent}` : input.alias, 120);
  }
  if (input.kind === 'knowledge' && input.slot) return oneLine(input.slot, 120);
  return oneLine(input.detail, 120);
};

function sanitizeEntry(raw: Record<string, unknown>, now = Date.now()): MemoryEntry | null {
  const detail = text(raw.detail);
  if (!detail) return null;
  const kind = isKind(raw.kind) ? raw.kind : 'knowledge';
  const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const importance = typeof raw.importance === 'number' ? clamp(Math.round(raw.importance), 1, 100) : 50;
  const status = raw.status === 'disputed' ? 'disputed' : 'active';
  const tags = Array.isArray(raw.tags)
    ? [...new Set(raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0))].slice(0, MAX_TAGS)
    : undefined;
  const entry: MemoryEntry = {
    id: text(raw.id) ?? uid('mem'),
    kind,
    title: text(raw.title) ?? titleOf({ kind, detail, alias: text(raw.alias), referent: text(raw.referent), slot: text(raw.slot) }),
    detail,
    importance,
    createdAt,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : createdAt,
    lastDecayedAt:
      typeof raw.lastDecayedAt === 'number' && Number.isFinite(raw.lastDecayedAt) ? raw.lastDecayedAt : createdAt,
    recallCount: typeof raw.recallCount === 'number' && raw.recallCount > 0 ? Math.round(raw.recallCount) : 0,
    decayCount: typeof raw.decayCount === 'number' && raw.decayCount > 0 ? Math.round(raw.decayCount) : 0,
    source: text(raw.source) ?? 'imported',
    status,
  };
  if (typeof raw.lastRecalledAt === 'number') entry.lastRecalledAt = raw.lastRecalledAt;
  const when = text(raw.when);
  const where = text(raw.where);
  const result = text(raw.result);
  const outcome = outcomeOf(raw.outcome);
  const alias = text(raw.alias);
  const referent = text(raw.referent);
  const relation = text(raw.relation);
  const episodeId = text(raw.episodeId);
  const slot = text(raw.slot);
  const scope = scopeOf(raw.scope);
  if (when) entry.when = when;
  if (where) entry.where = where;
  if (result) entry.result = result;
  if (outcome) entry.outcome = outcome;
  if (alias) entry.alias = alias;
  if (referent) entry.referent = referent;
  if (relation) entry.relation = relation;
  if (episodeId) entry.episodeId = episodeId;
  if (slot) entry.slot = slot;
  if (scope) entry.scope = scope;
  if (tags?.length) entry.tags = tags;
  if (typeof raw.archivedAt === 'number') entry.archivedAt = raw.archivedAt;
  if (raw.archiveReason === 'forgotten' || raw.archiveReason === 'superseded' || raw.archiveReason === 'manual') {
    entry.archiveReason = raw.archiveReason;
  }
  const supersededBy = text(raw.supersededBy);
  const conflictWith = text(raw.conflictWith);
  if (supersededBy) entry.supersededBy = supersededBy;
  if (conflictWith) entry.conflictWith = conflictWith;
  const dedupeKey = text(raw.dedupeKey);
  const sourceSession = text(raw.sourceSession);
  if (dedupeKey) entry.dedupeKey = dedupeKey;
  if (sourceSession) entry.sourceSession = sourceSession;
  if (Array.isArray(raw.sourceTurns) && raw.sourceTurns.length === 2 && raw.sourceTurns.every((value) => typeof value === 'number')) {
    entry.sourceTurns = [raw.sourceTurns[0] as number, raw.sourceTurns[1] as number];
  }
  if (raw.sourceDeleted === true) entry.sourceDeleted = true;
  if (raw.sourceReverted === true) entry.sourceReverted = true;
  if (raw.confidence === 'high' || raw.confidence === 'medium' || raw.confidence === 'low') entry.confidence = raw.confidence;
  if (raw.trust === 'user' || raw.trust === 'tool' || raw.trust === 'assistant') entry.trust = raw.trust;
  return entry;
}

export function memoryFacts(entries: readonly MemoryEntry[]): MemoryFact[] {
  return [...entries]
    .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
    .map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      slot: entry.slot ?? entry.id,
      value: entry.detail,
      scope: entry.scope ? (entry.scope.kind === 'path' ? `path:${entry.scope.path}` : entry.scope.kind) : 'global',
      source: entry.source,
      importance: entry.importance,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      ...(entry.archivedAt ? { archived: true } : {}),
      ...(entry.outcome ? { outcome: entry.outcome } : {}),
      ...(entry.status === 'disputed' ? { conflicts: 1 } : {}),
    }));
}

/** A rough match score in [0,1]: substring first, then term / CJK-bigram overlap. */
export function relevanceOf(entry: MemoryEntry, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const haystack = [
    entry.title,
    entry.detail,
    entry.alias,
    entry.referent,
    entry.relation,
    entry.slot,
    entry.when,
    entry.where,
    entry.result,
    ...(entry.tags ?? []),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  if (haystack.includes(q)) return 1;
  const terms = q.split(/[\s,，、;；/|]+/).filter(Boolean);
  if (terms.length === 0) return 0;
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 1;
      continue;
    }
    if (term.length >= 2) {
      const grams: string[] = [];
      for (let i = 0; i < term.length - 1; i += 1) grams.push(term.slice(i, i + 2));
      const hit = grams.filter((gram) => haystack.includes(gram)).length;
      score += grams.length > 0 ? hit / grams.length : 0;
    }
  }
  return score / terms.length;
}

function renderEntry(entry: MemoryEntry): string {
  const lines: string[] = [`### ${oneLine(entry.title, 120)}`, metaComment('memory', entry)];
  if (entry.kind === 'episodic') {
    if (entry.when) lines.push(`- 时间：${entry.when}`);
    if (entry.where) lines.push(`- 地点：${entry.where}`);
    lines.push(`- 经过：${entry.detail}`);
    lines.push(`- 结果：${entry.outcome ? `${entry.outcome} · ` : ''}${entry.result ?? '未记录'}`);
  } else if (entry.kind === 'relational') {
    if (entry.alias) lines.push(`- 指代：${entry.alias}${entry.referent ? ` → ${entry.referent}` : ''}`);
    if (entry.relation) lines.push(`- 关系：${entry.relation}`);
    if (entry.episodeId) lines.push(`- 关联情景：${entry.episodeId}`);
    lines.push(`- 内容：${entry.detail}`);
  } else {
    if (entry.slot) lines.push(`- 槽位：${entry.slot}`);
    lines.push(`- 事实：${entry.detail}`);
  }
  if (entry.tags?.length) lines.push(`- 标签：${entry.tags.join('、')}`);
  lines.push(`- 重要度：${entry.importance}/100`);
  lines.push(`- 来源：${entry.source} · ${stamp(entry.createdAt)}${entry.lastRecalledAt ? ` · 最近召回 ${stamp(entry.lastRecalledAt)}` : ''}`);
  if (entry.status === 'disputed') lines.push('- 状态：与另一条记录冲突，使用前先确认');
  if (entry.archivedAt) {
    lines.push(`- 归档：${stamp(entry.archivedAt)}（${entry.archiveReason === 'superseded' ? '被新记录取代' : entry.archiveReason === 'manual' ? '手动归档' : '遗忘曲线清理'}）`);
    if (entry.supersededBy) lines.push(`- 取代者：${entry.supersededBy}`);
  }
  return lines.join('\n');
}

function renderDoc(entries: MemoryEntry[], archivedCount: number, now: number): string {
  const lines: string[] = [
    '# 长期记忆',
    '',
    '> xiaohey 的长期记忆，分三类：情景（何时/何地/发生了什么/结果）、关系（称呼与指代）、知识（事实/约束/陈述）。',
    '> 每条记录下面的 HTML 注释是机器可读数据，正文只供人阅读；增删改请用界面或 `memory_write`。',
    `> 重要度由模型在写入时判断（1–100）。超过 ${FORGET_AFTER_DAYS} 天没有被写入或召回的记忆会按遗忘曲线衰减，低于 ${ARCHIVE_BELOW} 分时归档到 memory-archive.md；再次被读到时会被唤醒。`,
    '> 召回使用向量 + 关键词混合；向量索引存在 memory-vectors.json，可删除，会自动重建。',
    '',
    `- 最后维护：${stamp(now)}`,
    `- 活跃：${entries.length} 条（情景 ${entries.filter((entry) => entry.kind === 'episodic').length} / 关系 ${entries.filter((entry) => entry.kind === 'relational').length} / 知识 ${entries.filter((entry) => entry.kind === 'knowledge').length}） · 归档：${archivedCount} 条`,
  ];
  for (const kind of MEMORY_KINDS) {
    const group = entries
      .filter((entry) => entry.kind === kind)
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
    lines.push('', `## ${KIND_LABEL[kind]}`);
    if (group.length === 0) lines.push('', '（暂无）');
    else lines.push('', group.map(renderEntry).join('\n\n'));
  }
  return `${lines.join('\n')}\n`;
}

function renderArchiveDoc(entries: MemoryEntry[], now: number): string {
  const lines: string[] = [
    '# 长期记忆 · 归档',
    '',
    '> 这里保存按遗忘曲线清理或已被新记录取代的记忆。它们不再进入默认召回结果，但当一次召回明确命中时会被唤醒并移回 memory.md。',
    '',
    `- 最后维护：${stamp(now)}`,
    `- 归档：${entries.length} 条`,
  ];
  if (entries.length > 0) lines.push('', entries.map(renderEntry).join('\n\n'));
  return `${lines.join('\n')}\n`;
}

interface VectorRecord {
  /** Content hash; a changed entry is re-embedded instead of using a stale vector. */
  hash: string;
  v: number[];
}

interface VectorIndex {
  version: 1;
  embedder: string;
  dimension: number;
  vectors: Record<string, VectorRecord>;
}

const emptyVectorIndex = (embedder: string): VectorIndex => ({ version: 1, embedder, dimension: 0, vectors: {} });

const contentHash = (entry: MemoryEntry): string =>
  createHash('sha1').update(memoryEmbeddingText(entry)).digest('hex');

/** Natural text handed to the embedder; labels are omitted to keep local hashing clean. */
export function memoryEmbeddingText(entry: MemoryEntry): string {
  return [
    entry.title,
    entry.detail,
    entry.alias ? `${entry.alias} ${entry.referent ?? ''}` : '',
    entry.relation,
    entry.slot,
    entry.when,
    entry.where,
    entry.result,
    entry.outcome,
    ...(entry.tags ?? []),
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('。')
    .slice(0, 8000);
}

export class LongTermMemory {
  readonly file: string;
  readonly archiveFile: string;
  readonly vectorFile: string;
  readonly embedder: Embedder;
  readonly reranker?: Reranker;
  private entries: MemoryEntry[] = [];
  private archive: MemoryEntry[] = [];
  private loaded = false;
  private dirty = false;
  private lastForgetAt = 0;
  private saving: Promise<void> = Promise.resolve();
  private vectorIndex: VectorIndex;
  private vectorsLoaded = false;
  private vectorSaving: Promise<void> = Promise.resolve();
  private indexQueue: Promise<number> = Promise.resolve(0);
  private lastVectorError = '';

  constructor(
    readonly root: string = memoryRoot(),
    options: { embedder?: Embedder; reranker?: Reranker } = {},
  ) {
    this.file = memoryFile(root);
    this.archiveFile = memoryArchiveFile(root);
    this.vectorFile = memoryVectorFile(root);
    this.embedder = options.embedder ?? new ConfiguredEmbedder(() => null);
    this.reranker = options.reranker;
    this.vectorIndex = emptyVectorIndex(this.embedder.id);
  }

  async load(force = false): Promise<void> {
    if (this.loaded && !force) return;
    await ensureDir(this.root);
    const [main, archived] = await Promise.all([
      readFile(this.file, 'utf8').catch(() => null),
      readFile(this.archiveFile, 'utf8').catch(() => null),
    ]);
    this.entries = readMetaComments<Record<string, unknown>>(main ?? '', 'memory')
      .map((raw) => sanitizeEntry(raw))
      .filter((entry): entry is MemoryEntry => entry !== null && !entry.archivedAt);
    this.archive = readMetaComments<Record<string, unknown>>(archived ?? '', 'memory')
      .map((raw) => sanitizeEntry(raw))
      .filter((entry): entry is MemoryEntry => entry !== null && !!entry.archivedAt);
    this.loaded = true;
    // First launch: materialise both files with their headers so the user can
    // find the store where the design says it is.
    if (main === null || archived === null) await this.save();
  }

  async save(): Promise<void> {
    // Serialize writes: two turns or the panel can write at once, and a stale
    // render must never land after a newer one. The render happens inside the
    // queued task so it always reflects the latest in-memory state.
    const task = this.saving.then(async () => {
      const now = Date.now();
      await Promise.all([
        writeTextAtomic(this.file, renderDoc(this.entries, this.archive.length, now)),
        writeTextAtomic(this.archiveFile, renderArchiveDoc(this.archive, now)),
      ]);
      this.dirty = false;
    });
    this.saving = task.catch(() => undefined);
    return task;
  }

  async saveIfDirty(): Promise<void> {
    if (this.dirty) await this.save();
  }

  private async loadVectors(): Promise<void> {
    if (this.vectorsLoaded) return;
    this.vectorsLoaded = true;
    try {
      const raw = await readFile(this.vectorFile, 'utf8');
      const parsed = JSON.parse(raw) as Partial<VectorIndex> | null;
      if (!parsed || parsed.version !== 1 || typeof parsed.embedder !== 'string') return;
      if (!parsed.vectors || typeof parsed.vectors !== 'object') return;
      const vectors: Record<string, VectorRecord> = {};
      for (const [id, record] of Object.entries(parsed.vectors)) {
        const candidate = record as Partial<VectorRecord> | null;
        if (!candidate || typeof candidate.hash !== 'string' || !Array.isArray(candidate.v)) continue;
        const vector: number[] = [];
        for (const value of candidate.v) {
          if (typeof value !== 'number' || !Number.isFinite(value)) break;
          vector.push(value);
        }
        if (vector.length === 0 || vector.length !== candidate.v.length) continue;
        vectors[id] = { hash: candidate.hash, v: vector };
      }
      const dimension =
        typeof parsed.dimension === 'number' && parsed.dimension > 0
          ? parsed.dimension
          : (Object.values(vectors)[0]?.v.length ?? 0);
      this.vectorIndex = { version: 1, embedder: parsed.embedder, dimension, vectors };
    } catch {
      // First run, or a partially written index: rebuild from memory.md.
    }
  }

  private async saveVectors(): Promise<void> {
    const task = this.vectorSaving.then(async () => {
      const selected = [...this.entries, ...this.archive]
        .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
        .slice(0, MAX_VECTOR_ENTRIES);
      const allowed = new Set(selected.map((entry) => entry.id));
      const vectors: Record<string, VectorRecord> = {};
      for (const [id, record] of Object.entries(this.vectorIndex.vectors)) {
        if (allowed.has(id)) vectors[id] = record;
      }
      this.vectorIndex.vectors = vectors;
      await writeTextAtomic(this.vectorFile, JSON.stringify({ ...this.vectorIndex, vectors }));
    });
    this.vectorSaving = task.catch(() => undefined);
    return task;
  }

  /**
   * Build or refresh the vector index. Local hashing is immediate; a provider
   * works in batches and is allowed to fail (recall then falls back to keyword).
   * Returns the number of entries freshly embedded.
   *
   * Passes are serialized: a write can schedule an index while a recall is
   * already indexing, and two concurrent passes would each compute "missing"
   * against a stale view and drop entries. The queue makes every caller's set
   * eventually land, and a pass with nothing missing is a cheap no-op.
   */
  async ensureVectors(entries: MemoryEntry[] = this.all(true)): Promise<number> {
    await this.load();
    await this.loadVectors();
    const embedderId = this.embedder.id;
    if (this.vectorIndex.embedder !== embedderId) {
      this.vectorIndex = emptyVectorIndex(embedderId);
      this.vectorsLoaded = true;
    }
    const pending = [...entries];
    const run = this.indexQueue.then(() => this.runEnsureVectors(pending));
    this.indexQueue = run.catch(() => 0);
    return run;
  }

  private async runEnsureVectors(entries: MemoryEntry[]): Promise<number> {
    const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()]
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
      .slice(0, MAX_VECTOR_ENTRIES);
    const missing = unique.filter((entry) => {
      const record = this.vectorIndex.vectors[entry.id];
      if (!record) return true;
      if (record.hash !== contentHash(entry)) return true;
      return this.vectorIndex.dimension > 0 && record.v.length !== this.vectorIndex.dimension;
    });
    if (missing.length === 0) return 0;
    try {
      const vectors = await this.embedder.embed(missing.map(memoryEmbeddingText));
      if (vectors.length !== missing.length) throw new Error('embedding 返回数量不匹配');
      const dimension = vectors[0]?.length ?? 0;
      if (!dimension || vectors.some((vector) => vector.length !== dimension)) {
        throw new Error('embedding 返回维度不一致');
      }
      if (this.vectorIndex.dimension > 0 && this.vectorIndex.dimension !== dimension) {
        this.vectorIndex = emptyVectorIndex(this.embedder.id);
      }
      this.vectorIndex.dimension = dimension;
      for (let index = 0; index < missing.length; index += 1) {
        this.vectorIndex.vectors[missing[index].id] = {
          hash: contentHash(missing[index]),
          v: vectors[index].map((value) => Math.round(value * 1_000_000) / 1_000_000),
        };
      }
      this.lastVectorError = '';
      await this.saveVectors();
      return missing.length;
    } catch (error) {
      this.lastVectorError = (error as Error).message || 'embedding failed';
      return 0;
    }
  }

  vectorStatus(): { embedder: string; label: string; dimension: number; indexed: number; error?: string } {
    return {
      embedder: this.embedder.id,
      label: this.embedder.label,
      dimension: this.vectorIndex.dimension,
      indexed: Object.keys(this.vectorIndex.vectors).length,
      ...(this.lastVectorError ? { error: this.lastVectorError } : {}),
    };
  }

  private async scheduleIndex(entries: MemoryEntry[]): Promise<void> {
    // A memory that was just written must be recallable at once: its keyword
    // score can be below the candidate gate, and without a vector it would be
    // invisible until some later pass. So the write waits for the index pass —
    // one embedding request (~0.2s) — and a provider failure is swallowed inside
    // runEnsureVectors, so it degrades to keyword instead of failing the write.
    const task = this.ensureVectors(this.embedder.local ? this.all(true) : entries).catch(() => undefined);
    await task;
  }

  /** Wait for pending memory/vector writes; used by tests and shutdown paths. */
  async flush(): Promise<void> {
    await this.indexQueue.catch(() => 0);
    await this.saving.catch(() => undefined);
    await this.vectorSaving.catch(() => undefined);
  }

  all(includeArchived = false): MemoryEntry[] {
    return includeArchived ? [...this.entries, ...this.archive] : [...this.entries];
  }

  archived(): MemoryEntry[] {
    return [...this.archive];
  }

  activeCount(): number {
    return this.entries.length;
  }

  /** Memory written for a session that no longer exists, kept but marked. */
  findBySourceSession(sessionId: string): MemoryEntry[] {
    return [...this.entries, ...this.archive].filter((entry) => entry.sourceSession === sessionId);
  }

  /** Deleting a session keeps its derived memories and marks them. */
  async markSourceDeleted(sessionId: string): Promise<number> {
    const hits = this.findBySourceSession(sessionId);
    if (hits.length === 0) return 0;
    for (const entry of hits) entry.sourceDeleted = true;
    await this.save();
    return hits.length;
  }

  /** A revert invalidates what was distilled from the reverted turns. */
  async markSourceReverted(sessionId: string, upToTurn: number): Promise<number> {
    const hits = this.findBySourceSession(sessionId).filter(
      (entry) => !entry.sourceTurns || entry.sourceTurns[1] >= upToTurn,
    );
    if (hits.length === 0) return 0;
    for (const entry of hits) entry.sourceReverted = true;
    await this.save();
    return hits.length;
  }

  countByKind(): Record<MemoryKind, number> {
    const counts: Record<MemoryKind, number> = { episodic: 0, relational: 0, knowledge: 0 };
    for (const entry of this.entries) counts[entry.kind] += 1;
    return counts;
  }

  indexNote(): string {
    const counts = this.countByKind();
    return `长期记忆：活跃 ${this.entries.length} 条（情景 ${counts.episodic} / 关系 ${counts.relational} / 知识 ${counts.knowledge}） · 归档 ${this.archive.length} 条。文件：${this.file}`;
  }

  private makeEntry(input: MemoryWriteInput, now: number, status: MemoryStatus = 'active'): MemoryEntry {
    const kind = input.kind;
    const detail = input.detail.trim().slice(0, 4000);
    const entry: MemoryEntry = {
      id: uid('mem'),
      kind,
      title: titleOf({ kind, title: input.title, detail, alias: input.alias, referent: input.referent, slot: input.slot }),
      detail,
      importance: clamp(Math.round(input.importance || 50), 1, 100),
      createdAt: now,
      updatedAt: now,
      lastDecayedAt: now,
      recallCount: 0,
      decayCount: 0,
      source: input.source,
      status,
    };
    const field = (value: string | undefined, max = 500): string | undefined => value?.trim().slice(0, max);
    if (kind === 'episodic') {
      const when = field(input.when);
      const where = field(input.where);
      const result = field(input.result);
      if (when) entry.when = when;
      if (where) entry.where = where;
      if (result) entry.result = result;
      entry.outcome = outcomeOf(input.outcome) ?? 'unknown';
    }
    if (kind === 'relational') {
      const alias = field(input.alias, 120);
      const referent = field(input.referent, 300);
      const relation = field(input.relation, 120);
      if (alias) entry.alias = alias;
      if (referent) entry.referent = referent;
      if (relation) entry.relation = relation;
      if (input.episodeId?.trim()) entry.episodeId = input.episodeId.trim().slice(0, 120);
      // A reference usually comes from a moment: link it to the newest episode
      // written by the same session unless the model named one explicitly.
      if (!entry.episodeId) {
        const session = input.source.split(' · ')[0];
        const episode = [...this.entries]
          .reverse()
          .find((item) => item.kind === 'episodic' && (!session || item.source.startsWith(session)));
        if (episode) entry.episodeId = episode.id;
      }
    }
    if (kind === 'knowledge') {
      if (input.slot?.trim()) entry.slot = input.slot.trim().slice(0, 160);
      if (input.scope) entry.scope = input.scope;
    }
    if (input.tags?.length) {
      entry.tags = [...new Set(input.tags.map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, MAX_TAGS);
    }
    if (input.dedupeKey?.trim()) entry.dedupeKey = input.dedupeKey.trim().slice(0, 200);
    if (input.sourceSession?.trim()) entry.sourceSession = input.sourceSession.trim().slice(0, 80);
    if (input.sourceTurns) entry.sourceTurns = input.sourceTurns;
    if (input.confidence) entry.confidence = input.confidence;
    if (input.trust) entry.trust = input.trust;
    return entry;
  }

  /**
   * Write one memory. Knowledge with a slot uses the same conflict vocabulary as
   * the legacy store: an update supersedes the old value (archived), an opposite
   * claim keeps both and marks them disputed so the agent must ask.
   */
  async write(input: MemoryWriteInput): Promise<WriteReceipt> {
    await this.load();
    if (!input.detail || !input.detail.trim()) throw new Error('memory detail is empty');
    // Memory outlives the session: strip secrets before anything is stored.
    input = {
      ...input,
      detail: redactSecrets(input.detail),
      ...(input.title ? { title: redactSecrets(input.title) } : {}),
      ...(input.result ? { result: redactSecrets(input.result) } : {}),
      ...(input.when ? { when: redactSecrets(input.when) } : {}),
      ...(input.where ? { where: redactSecrets(input.where) } : {}),
      ...(input.alias ? { alias: redactSecrets(input.alias) } : {}),
      ...(input.referent ? { referent: redactSecrets(input.referent) } : {}),
    };
    // Consolidation is idempotent: the same (kind, session, turn range, title)
    // never produces a second entry, even if the pass is retried.
    if (input.dedupeKey && !input.id) {
      const existing =
        this.entries.find((entry) => entry.dedupeKey === input.dedupeKey) ??
        this.archive.find((entry) => entry.dedupeKey === input.dedupeKey);
      if (existing) {
        return { kind: 'distinct', entry: existing, note: `已存在同一条记忆（${existing.title}），这次没有重复写入。` };
      }
    }
    const now = Date.now();
    const kind = input.kind;

    // A direct edit from the memory panel updates the entry in place: the user
    // is correcting a value, not making a new competing claim.
    if (input.id) {
      const current = this.entries.find((entry) => entry.id === input.id && entry.status === 'active');
      if (current) {
        current.detail = input.detail.trim().slice(0, 4000);
        current.title = titleOf({
          kind: current.kind,
          title: input.title,
          detail: current.detail,
          alias: input.alias ?? current.alias,
          referent: input.referent ?? current.referent,
          slot: input.slot ?? current.slot,
        });
        current.importance = clamp(Math.round(input.importance || current.importance), 1, 100);
        if (current.kind === 'knowledge' && input.slot) current.slot = input.slot;
        if (current.kind === 'knowledge' && input.scope) current.scope = input.scope;
        current.updatedAt = now;
        current.lastDecayedAt = now;
        if (input.tags?.length) current.tags = input.tags.slice(0, MAX_TAGS);
        await this.save();
        await this.scheduleIndex([current]);
        return { kind: 'distinct', entry: current, note: `已更新「${current.title}」，重要度 ${current.importance}/100。` };
      }
    }

    if (kind === 'knowledge' && input.slot) {
      const scope = input.scope ?? { kind: 'global' as const };
      const current = [...this.entries]
        .reverse()
        .find((entry) => entry.kind === 'knowledge' && entry.slot === input.slot && entry.status === 'active' && sameScope(entry.scope, scope));
      if (current) {
        const verdict = classify(this.asLegacyRecord(current), { slot: input.slot, value: input.detail, scope });
        if (verdict === 'distinct') {
          current.importance = Math.max(current.importance, clamp(Math.round(input.importance || 50), 1, 100));
          current.updatedAt = now;
          current.lastDecayedAt = now;
          this.dirty = true;
          await this.save();
          await this.scheduleIndex([current]);
          return { kind: 'distinct', entry: current, note: `知识记忆里已经有「${current.title}」，没有重复写入；重要度保持 ${current.importance}。` };
        }
        if (verdict === 'contradict') {
          const disputed = this.makeEntry(input, now, 'disputed');
          current.status = 'disputed';
          current.conflictWith = disputed.id;
          current.updatedAt = now;
          disputed.conflictWith = current.id;
          this.entries.push(disputed);
          this.dirty = true;
          await this.save();
          await this.scheduleIndex([disputed]);
          return {
            kind: 'contradict',
            entry: disputed,
            note: `「${input.slot}」出现两个相反的说法，已并列保留并标记为冲突。使用前先问用户以哪个为准。`,
          };
        }
        // supersede: archive the old value, keep it recallable.
        this.entries = this.entries.filter((entry) => entry.id !== current.id);
        this.archive.unshift({ ...current, archivedAt: now, archiveReason: 'superseded', updatedAt: now });
        this.dirty = true;
        const replacement = this.makeEntry(input, now);
        this.archive[0].supersededBy = replacement.id;
        this.entries.push(replacement);
        await this.save();
        await this.scheduleIndex([replacement]);
        return {
          kind: 'supersede',
          entry: replacement,
          note: `知识记忆「${input.slot}」已更新，旧值归档、可在需要时召回。`,
        };
      }
    }

    const duplicate = this.entries.find(
      (entry) => entry.kind === kind && entry.status === 'active' && entry.title === titleOf({ kind, title: input.title, detail: input.detail, alias: input.alias, referent: input.referent, slot: input.slot }) && entry.detail === input.detail.trim(),
    );
    if (duplicate) {
      duplicate.importance = Math.max(duplicate.importance, clamp(Math.round(input.importance || 50), 1, 100));
      duplicate.updatedAt = now;
      duplicate.lastDecayedAt = now;
      await this.save();
      await this.scheduleIndex([duplicate]);
      return { kind: 'distinct', entry: duplicate, note: `这条${KIND_LABEL[kind]}已经存在，只更新了重要度（${duplicate.importance}）。` };
    }

    const entry = this.makeEntry(input, now);
    this.entries.push(entry);
    await this.enforceCap(now);
    await this.save();
    await this.scheduleIndex([entry]);
    return { kind: 'created', entry, note: `已写入${KIND_LABEL[kind]}「${entry.title}」，重要度 ${entry.importance}/100。` };
  }

  /** Hybrid recall (vector + keyword), with waking for archived matches. */
  async recall(args: RecallArgs = {}): Promise<RecallResult> {
    await this.load();
    const query = (args.query ?? '').trim();
    const kind = args.kind && args.kind !== 'all' ? args.kind : 'all';
    const limit = clamp(Math.round(args.limit ?? 5), 1, 20);
    const includeArchived = args.includeArchived ?? true;
    const wake = args.wake ?? true;
    const now = Date.now();
    await this.loadVectors();

    let queryVector: number[] | null = null;
    let vectorReason = '';
    if (query) {
      try {
        const [vector] = await this.embedder.embed([query]);
        queryVector = vector && vector.length > 0 ? vector : null;
        if (!queryVector) vectorReason = 'embedding 返回空向量';
      } catch (error) {
        vectorReason = (error as Error).message || 'embedding 调用失败';
      }
    }
    if (queryVector) {
      if (this.vectorIndex.embedder !== this.embedder.id) {
        this.vectorIndex = emptyVectorIndex(this.embedder.id);
      }
      if (this.vectorIndex.dimension > 0 && queryVector.length !== this.vectorIndex.dimension) {
        vectorReason = `向量维度不一致（query ${queryVector.length} / index ${this.vectorIndex.dimension}）`;
        queryVector = null;
        void this.ensureVectors(this.all(true)).catch(() => undefined);
      }
    }
    if (queryVector) {
      if (this.embedder.local) {
        // Local hashing is cheap and deterministic: make the whole index ready
        // before scoring so every entry can contribute a vector score.
        await this.ensureVectors(this.all(true)).catch(() => undefined);
      } else {
        // A provider backfill can be many requests; recall with what is already
        // indexed and let the background pass finish the rest.
        void this.ensureVectors(this.all(true)).catch(() => undefined);
      }
    }
    if (queryVector && this.vectorIndex.dimension === 0) {
      vectorReason = '向量索引尚未建立';
      queryVector = null;
    }
    const vectorActive = queryVector !== null;

    const vectorOf = (entry: MemoryEntry): number | undefined => {
      if (!queryVector) return undefined;
      const record = this.vectorIndex.vectors[entry.id];
      if (!record || record.v.length !== queryVector.length) return undefined;
      // A pending re-index after an edit must not leak the old vector.
      if (record.hash !== contentHash(entry)) return undefined;
      return clamp(cosineSimilarity(queryVector, record.v), 0, 1);
    };

    const rank = (entry: MemoryEntry, relevance: number): number => {
      return relevance * 0.65 + (entry.importance / 100) * 0.25 + recencyOf(entry, now) * 0.1;
    };

    const fuse = (keyword: number, vector: number | undefined): number =>
      vector === undefined ? keyword : HYBRID_VECTOR_WEIGHT * vector + HYBRID_KEYWORD_WEIGHT * keyword;

    const score = (entries: MemoryEntry[]): RecallHit[] =>
      entries
        .filter((entry) => kind === 'all' || entry.kind === kind)
        .map((entry) => {
          const keyword = relevanceOf(entry, query);
          const vector = vectorOf(entry);
          return {
            entry,
            archived: false,
            keyword,
            ...(vector === undefined ? {} : { vector }),
            relevance: query ? fuse(keyword, vector) : 1,
          };
        });

    const activeScored = score(this.entries);
    const vectorTop = new Set(
      activeScored
        .filter((hit) => hit.vector !== undefined && hit.vector >= MIN_VECTOR_SIMILARITY)
        .sort((a, b) => (b.vector ?? 0) - (a.vector ?? 0))
        .slice(0, Math.max(limit * VECTOR_CANDIDATE_FACTOR, 10))
        .map((hit) => hit.entry.id),
    );

    const activeCandidates = activeScored
      .filter((hit) => (query ? (hit.keyword ?? 0) >= MIN_KEYWORD_RELEVANCE || vectorTop.has(hit.entry.id) : true))
      .sort((a, b) => rank(b.entry, b.relevance) - rank(a.entry, a.relevance));

    const archivedCandidates =
      includeArchived && query
        ? score(this.archive).filter(
            (hit) =>
              (hit.keyword ?? 0) >= MIN_ARCHIVED_KEYWORD_RELEVANCE ||
              (hit.vector !== undefined && hit.vector >= MIN_ARCHIVED_VECTOR_SIMILARITY),
          )
        : [];

    // Reranking only reorders candidates; a wider pool is what lets it help.
    // Capped at the rerank client's document limit: asking for more would leave
    // the extras unscored (0) and silently unable to reach the result list.
    const rerankConfig = query && this.reranker ? this.reranker.config() : null;
    const poolSize = rerankConfig
      ? Math.min(MAX_RERANK_DOCUMENTS, Math.max(limit * RERANK_POOL_FACTOR, RERANK_POOL_MIN))
      : Number.POSITIVE_INFINITY;
    let active = activeCandidates.slice(0, poolSize);
    let archivedCandidatesPool = [...archivedCandidates]
      .sort((a, b) => rank(b.entry, a.relevance) - rank(a.entry, a.relevance))
      .slice(0, poolSize);

    let rerankUsed = false;
    let rerankReason = '';
    if (rerankConfig && this.reranker && active.length + archivedCandidatesPool.length > 0) {
      const activeCount = active.length;
      const combined = [...active, ...archivedCandidatesPool];
      try {
        const raw = await this.reranker.score(query, combined.map((hit) => memoryEmbeddingText(hit.entry)));
        // Normalize per pool: the two pools never compete for the same slots.
        const rescore = (hits: RecallHit[], slice: number[]): RecallHit[] => {
          const normalized = normalizeScores(slice);
          return hits
            .map((hit, index) => ({
              ...hit,
              relevance:
                RERANK_WEIGHT * (normalized[index] ?? 0) +
                RERANK_IMPORTANCE_WEIGHT * (hit.entry.importance / 100) +
                RERANK_RECENCY_WEIGHT * recencyOf(hit.entry),
            }))
            .sort((a, b) => b.relevance - a.relevance);
        };
        active = rescore(active, raw.slice(0, activeCount));
        archivedCandidatesPool = rescore(archivedCandidatesPool, raw.slice(activeCount));
        rerankUsed = true;
      } catch (error) {
        rerankReason = (error as Error).message || 'rerank 调用失败';
      }
    }

    active = active.slice(0, limit);
    const archivedHits = archivedCandidatesPool.slice(0, Math.max(0, limit - active.length));

    for (const hit of active) {
      hit.entry.lastRecalledAt = now;
      hit.entry.recallCount += 1;
      if (query) {
        hit.entry.importance = clamp(hit.entry.importance + RECALL_BOOST, 1, 100);
        hit.entry.lastDecayedAt = now;
      }
    }

    const woken: MemoryEntry[] = [];
    for (const hit of archivedHits) {
      const entry = hit.entry;
      entry.lastRecalledAt = now;
      entry.recallCount += 1;
      if (wake) {
        this.archive = this.archive.filter((item) => item.id !== entry.id);
        delete entry.archivedAt;
        delete entry.archiveReason;
        delete entry.supersededBy;
        entry.status = 'active';
        entry.importance = clamp(Math.max(entry.importance, WAKE_IMPORTANCE), 1, 100);
        entry.lastDecayedAt = now;
        entry.updatedAt = now;
        this.entries.push(entry);
        woken.push(entry);
      }
    }

    if (active.length > 0 || woken.length > 0) {
      this.dirty = true;
      await this.save();
    }

    return {
      query,
      hits: [
        ...active.map((hit) => ({ ...hit, archived: false })),
        ...archivedHits.map((hit) => ({
          ...hit,
          archived: !woken.some((entry) => entry.id === hit.entry.id),
        })),
      ],
      woken,
      activeTotal: this.entries.length,
      archiveTotal: this.archive.length,
      mode: query ? (rerankUsed ? 'hybrid+rerank' : vectorActive ? 'hybrid' : 'keyword') : 'browse',
      vectorUsed: vectorActive,
      vectorLabel: this.embedder.label,
      ...(vectorReason ? { vectorReason } : {}),
      ...(rerankUsed ? { rerankUsed: true } : {}),
      ...(this.reranker ? { rerankLabel: this.reranker.label } : {}),
      ...(rerankReason ? { rerankReason } : {}),
    };
  }

  /**
   * Periodic maintenance without a scheduler: the first turn after six idle
   * hours runs the forgetting pass. Boot also calls this, so a machine that is
   * only opened occasionally still forgets on the next launch.
   */
  async maintain(now = Date.now()): Promise<ForgetReport | null> {
    if (now - this.lastForgetAt < 6 * 3_600_000) return null;
    this.lastForgetAt = now;
    return this.forget(now);
  }

  /**
   * The forgetting pass. Only entries older than FORGET_AFTER_DAYS since their
   * last touch decay; the decay is exponential per interval and slower for
   * important memories, so a key constraint survives where a passing detail
   * fades. Crossing ARCHIVE_BELOW moves the entry to the archive file.
   */
  async forget(now = Date.now()): Promise<ForgetReport> {
    await this.load();
    this.lastForgetAt = now;
    const report: ForgetReport = { checkedAt: now, decayed: 0, archived: 0, entries: [] };
    for (const entry of [...this.entries]) {
      if (entry.status === 'disputed') continue;
      const intervalDays = Math.max(0, (now - entry.lastDecayedAt) / DAY);
      if (intervalDays < FORGET_AFTER_DAYS) continue;
      const from = entry.importance;
      const stability = 45 + from * 2;
      const next = Math.max(1, Math.round(from * Math.exp(-intervalDays / stability)));
      entry.importance = next;
      entry.lastDecayedAt = now;
      entry.decayCount += 1;
      entry.updatedAt = now;
      report.decayed += 1;
      const archived = next < ARCHIVE_BELOW;
      if (archived) {
        this.entries = this.entries.filter((item) => item.id !== entry.id);
        this.archive.unshift({ ...entry, archivedAt: now, archiveReason: 'forgotten' });
        report.archived += 1;
      }
      report.entries.push({ id: entry.id, title: entry.title, from, to: next, archived });
    }
    await this.enforceCap(now);
    if (report.decayed > 0 || report.archived > 0 || this.dirty) {
      this.dirty = true;
      await this.save();
    }
    return report;
  }

  async delete(idOrSlot: string): Promise<boolean> {
    await this.load();
    const key = idOrSlot.trim();
    if (!key) return false;
    const before = this.entries.length + this.archive.length;
    this.entries = this.entries.filter((entry) => entry.id !== key && entry.slot !== key);
    this.archive = this.archive.filter((entry) => entry.id !== key && entry.slot !== key);
    const changed = this.entries.length + this.archive.length !== before;
    if (changed) await this.save();
    return changed;
  }

  /** Import a legacy per-thread record once, at boot or before the first turn. */
  importLegacy(record: MemoryRecord, source: string, workspace?: string): boolean {
    if (record.status === 'superseded') return false;
    if (!record.value.trim()) return false;
    const duplicate = [...this.entries, ...this.archive].find(
      (entry) => entry.kind === 'knowledge' && entry.slot === record.slot && entry.detail === record.value.trim(),
    );
    if (duplicate) return false;
    const now = record.updatedAt || Date.now();
    const scope =
      record.scope.kind === 'workspace' && workspace?.trim() ? ({ kind: 'path', path: workspace.trim() } as MemoryScope) : record.scope;
    const entry: MemoryEntry = {
      id: record.id || uid('mem'),
      kind: 'knowledge',
      title: oneLine(record.slot, 120),
      detail: record.value.trim(),
      importance: 50,
      createdAt: record.createdAt || now,
      updatedAt: now,
      lastDecayedAt: now,
      recallCount: 0,
      decayCount: 0,
      source: `${source} · 迁移`,
      status: record.status === 'disputed' ? 'disputed' : 'active',
      slot: record.slot,
      scope,
    };
    if (record.conflictWith) entry.conflictWith = record.conflictWith;
    this.entries.unshift(entry);
    this.dirty = true;
    return true;
  }

  private async enforceCap(now: number): Promise<void> {
    if (this.entries.length <= MAX_ACTIVE) return;
    const excess = this.entries.length - MAX_ACTIVE;
    const doomed = [...this.entries]
      .filter((entry) => entry.status !== 'disputed')
      .sort((a, b) => a.importance - b.importance || a.updatedAt - b.updatedAt)
      .slice(0, excess);
    if (doomed.length === 0) return;
    const ids = new Set(doomed.map((entry) => entry.id));
    this.entries = this.entries.filter((entry) => !ids.has(entry.id));
    for (const entry of doomed) this.archive.unshift({ ...entry, archivedAt: now, archiveReason: 'manual' });
    this.dirty = true;
  }

  private asLegacyRecord(entry: MemoryEntry): MemoryRecord {
    const scope = entry.scope ?? { kind: 'global' };
    return {
      id: entry.id,
      slot: entry.slot ?? '',
      value: entry.detail,
      scopeKey: scopeKeyOf(scope),
      scope,
      source: entry.source,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      status: entry.status === 'disputed' ? 'disputed' : 'active',
    };
  }
}

/** Model-facing rendering of one recall, bounded so a tool result stays small. */
export function formatRecall(result: RecallResult): string {
  if (result.hits.length === 0) {
    const fallback =
      result.mode === 'keyword' && result.vectorReason ? `；向量不可用：${result.vectorReason.slice(0, 120)}` : '';
    return `没有找到匹配的长期记忆（活跃 ${result.activeTotal} 条，归档 ${result.archiveTotal} 条${fallback}）。可以换一个关键词，或直接问用户。`;
  }
  const mode =
    result.mode === 'hybrid+rerank'
      ? `向量+关键词召回，再由 ${result.rerankLabel ?? 'rerank 模型'}重排`
      : result.mode === 'hybrid'
        ? `向量+关键词混合召回${result.vectorLabel ? ` · ${result.vectorLabel}` : ''}`
        : result.mode === 'keyword'
          ? `关键词召回${result.vectorReason ? `（向量不可用：${result.vectorReason.slice(0, 120)}）` : ''}`
          : '按重要度浏览';
  const rerankNote =
    result.mode !== 'hybrid+rerank' && result.rerankReason ? `（重排未生效：${result.rerankReason.slice(0, 120)}）` : '';
  const head = `找到 ${result.hits.length} 条相关长期记忆（${mode}${rerankNote}）${result.woken.length > 0 ? `，其中 ${result.woken.length} 条已从归档唤醒` : ''}。这些是过去的情景/关系/知识，不是当前工作区的证据；涉及文件或命令的结论仍需重新读取核实。`;
  const blocks = result.hits.map((hit, index) => {
    const entry = hit.entry;
    const lines: string[] = [
      `${index + 1}. [${KIND_LABEL[entry.kind]} · 重要度 ${entry.importance} · ${stamp(entry.createdAt)}${hit.archived ? ' · 已归档' : ''}${entry.status === 'disputed' ? ' · 冲突待澄清' : ''}] ${entry.title}`,
      `   - id：${entry.id}`,
    ];
    if (entry.kind === 'episodic') {
      if (entry.when) lines.push(`   - 时间：${entry.when}`);
      if (entry.where) lines.push(`   - 地点：${entry.where}`);
      lines.push(`   - 经过：${entry.detail}`);
      lines.push(`   - 结果：${entry.outcome ?? 'unknown'}${entry.result ? ` · ${entry.result}` : ''}`);
    } else if (entry.kind === 'relational') {
      if (entry.alias) lines.push(`   - 指代：${entry.alias}${entry.referent ? ` → ${entry.referent}` : ''}`);
      if (entry.relation) lines.push(`   - 关系：${entry.relation}`);
      if (entry.episodeId) lines.push(`   - 关联情景：${entry.episodeId}`);
      lines.push(`   - 内容：${entry.detail}`);
    } else {
      if (entry.slot) lines.push(`   - 槽位：${entry.slot}`);
      lines.push(`   - 事实：${entry.detail}`);
    }
    lines.push(`   - 来源：${entry.source}`);
    return lines.join('\n');
  });
  const body = `${head}\n${blocks.join('\n')}`;
  return body.length > 6000 ? `${body.slice(0, 6000)}\n…（更多记忆已省略）` : body;
}
