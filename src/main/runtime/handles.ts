import { appendFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDir, estimateTokens } from '../util.js';
import type { BlobStore } from './blobs.js';
import { previewOf } from './blobs.js';

/**
 * Handles: short pointers to blob content.
 *
 * A handle is how a message says "the 8.2k-token file is over there" without
 * putting the file in the context. Handles are append-only records in
 * `handles.jsonl`, so resolving one never depends on the model remembering an
 * order, and the same content (same sha256) resolves to one blob.
 *
 * Fetching is budgeted: one fetch is capped and a single handle can be fetched
 * a few times per turn, so a model cannot turn "read the detail" into a second
 * context window.
 */

export type HandleKind =
  | 'tool_result'
  | 'tool_args'
  | 'attachment'
  | 'assistant_text'
  | 'reasoning'
  | 'turn_final'
  | 'compressed';

export interface HandleRecord {
  handle: string;
  blob: string;
  bytes: number;
  tokens: number;
  kind: HandleKind;
  tool?: string;
  argsDigest?: string;
  turn: number;
  step: number;
  callId?: string;
  createdAt: number;
  preview: string;
  expired?: boolean;
}

export const FETCH_TOKENS = 4000;
export const MAX_FETCHES_PER_TURN = 3;
export const HANDLE_TYPES: readonly HandleKind[] = [
  'tool_result',
  'tool_args',
  'attachment',
  'assistant_text',
  'reasoning',
  'turn_final',
  'compressed',
];

const newHandle = (): string => `h_${randomUUID().replace(/-/g, '').slice(0, 10)}`;

export interface HandleInput {
  text: string;
  kind: HandleKind;
  turn: number;
  step: number;
  tool?: string;
  argsDigest?: string;
  callId?: string;
  /** Already-known blob, when the caller put the content itself. */
  blob?: string;
  bytes?: number;
  tokens?: number;
}

export interface HandleRead {
  text: string;
  total: number;
  offset: number;
  tokens: number;
  truncated: boolean;
  record: HandleRecord | null;
  expired?: boolean;
  reason?: string;
}

export class HandleTable {
  readonly file: string;
  private readonly records = new Map<string, HandleRecord>();
  private loaded = false;
  private appendChain: Promise<void> = Promise.resolve();
  /** `turn:handle` → fetches already spent this turn. */
  private readonly fetches = new Map<string, number>();

  constructor(
    readonly dir: string,
    private readonly blobs: BlobStore,
  ) {
    this.file = join(dir, 'handles.jsonl');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const raw = await readFile(this.file, 'utf8').catch(() => '');
    if (!raw) return;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as HandleRecord;
        if (record && typeof record.handle === 'string' && typeof record.blob === 'string') {
          this.records.set(record.handle, record);
        }
      } catch {
        // A torn last line is expected after a crash; the next append rewrites
        // from a clean line boundary.
      }
    }
  }

  get size(): number {
    return this.records.size;
  }

  get(handle: string): HandleRecord | null {
    return this.records.get(handle) ?? null;
  }

  all(): HandleRecord[] {
    return [...this.records.values()];
  }

  /** Store content (or register a known blob) and return the handle record. */
  async create(input: HandleInput): Promise<HandleRecord> {
    await this.load();
    let blob = input.blob;
    let bytes = input.bytes;
    let tokens = input.tokens;
    if (!blob) {
      const put = await this.blobs.put(input.text);
      blob = put.blob;
      bytes = put.bytes;
      tokens = put.tokens;
    }
    const record: HandleRecord = {
      handle: newHandle(),
      blob,
      bytes: bytes ?? Buffer.byteLength(input.text, 'utf8'),
      tokens: tokens ?? estimateTokens(input.text),
      kind: input.kind,
      turn: input.turn,
      step: input.step,
      createdAt: Date.now(),
      preview: previewOf(input.text),
    };
    if (input.tool) record.tool = input.tool;
    if (input.argsDigest) record.argsDigest = input.argsDigest;
    if (input.callId) record.callId = input.callId;
    this.records.set(record.handle, record);
    const line = `${JSON.stringify(record)}\n`;
    this.appendChain = this.appendChain
      .then(async () => {
        await ensureDir(this.dir);
        await appendFile(this.file, line, 'utf8');
      })
      .catch(() => undefined);
    await this.appendChain;
    return record;
  }

  /** Register a known blob without re-reading it. */
  async adopt(record: Omit<HandleRecord, 'handle' | 'createdAt' | 'preview' | 'bytes' | 'tokens'> & {
    preview: string;
    bytes: number;
    tokens: number;
  }): Promise<HandleRecord> {
    await this.load();
    const existing = [...this.records.values()].find(
      (entry) => entry.blob === record.blob && entry.kind === record.kind && entry.turn === record.turn,
    );
    if (existing) return existing;
    const created: HandleRecord = { ...record, handle: newHandle(), createdAt: Date.now() };
    this.records.set(created.handle, created);
    const line = `${JSON.stringify(created)}\n`;
    this.appendChain = this.appendChain
      .then(async () => {
        await ensureDir(this.dir);
        await appendFile(this.file, line, 'utf8');
      })
      .catch(() => undefined);
    await this.appendChain;
    return created;
  }

  /** How many more times this handle may be fetched during this turn. */
  remaining(turn: number, handle: string): number {
    const key = `${turn}:${handle}`;
    return Math.max(0, MAX_FETCHES_PER_TURN - (this.fetches.get(key) ?? 0));
  }

  /**
   * Budgeted read. The text is trimmed to `FETCH_TOKENS`; an exhausted turn
   * budget returns a readable refusal instead of the content.
   */
  async read(
    handle: string,
    options: { turn: number; offset?: number; limit?: number } = { turn: 0 },
  ): Promise<HandleRead> {
    await this.load();
    const record = this.records.get(handle);
    if (!record) {
      return { text: '', total: 0, offset: 0, tokens: 0, truncated: false, record: null, reason: `unknown handle ${handle}` };
    }
    if (record.expired) {
      return {
        text: '',
        total: 0,
        offset: 0,
        tokens: 0,
        truncated: false,
        record,
        expired: true,
        reason: '内容已超过保留期被清理，只有预览还留着',
      };
    }
    const left = this.remaining(options.turn, handle);
    if (left <= 0) {
      return {
        text: '',
        total: record.tokens,
        offset: 0,
        tokens: 0,
        truncated: false,
        record,
        reason: `这一轮已经取回 ${MAX_FETCHES_PER_TURN} 次 ${handle}，改用文件工具核对，或下一轮再取`,
      };
    }
    const key = `${options.turn}:${handle}`;
    this.fetches.set(key, (this.fetches.get(key) ?? 0) + 1);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const charLimit = Math.max(200, Math.floor((options.limit ?? FETCH_TOKENS) * 3.6));
    const range = await this.blobs.getRange(record.blob, offset, charLimit).catch(() => null);
    if (!range) {
      return {
        text: '',
        total: record.tokens,
        offset,
        tokens: 0,
        truncated: false,
        record,
        expired: true,
        reason: 'blob 缺失（可能已被清理）',
      };
    }
    const text = trimToTokens(range.text, options.limit ?? FETCH_TOKENS);
    return {
      text,
      total: range.total,
      offset: range.offset,
      tokens: estimateTokens(text),
      truncated: range.offset + text.length < range.total,
      record,
    };
  }

  /** Turn boundary: the per-turn fetch budget resets. */
  resetTurn(): void {
    this.fetches.clear();
  }

  async markExpired(handles: readonly string[]): Promise<void> {
    for (const handle of handles) {
      const record = this.records.get(handle);
      if (record) record.expired = true;
    }
  }

  async flush(): Promise<void> {
    await this.appendChain;
  }
}

/** Trim text to a token budget without splitting a surrogate pair. */
export function trimToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  let end = Math.min(text.length, Math.ceil(maxTokens * 3.6));
  while (end > 0 && estimateTokens(text.slice(0, end)) > maxTokens) {
    end = Math.floor(end * 0.85);
  }
  if (end <= 0) return '';
  return `${text.slice(0, end)}\n… (truncated at ${maxTokens} tokens)`;
}