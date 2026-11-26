import { createHash } from 'node:crypto';
import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ensureDir, estimateTokens } from '../util.js';

/**
 * Content-addressed blob store: `blobs/<aa>/<sha256>`.
 *
 * Large text (tool results, tool arguments, attachments, long reasoning) is
 * written here once and addressed by hash. That buys three things a single
 * JSONL file cannot: the ledger stays small and scannable, reading the same
 * file twice stores one copy, and deleting a session deletes one directory.
 *
 * Blobs are immutable and never read in order — only through a handle or a
 * hash recorded in an event.
 */

const PREVIEW_HEAD = 200;
const PREVIEW_TAIL = 200;

export interface BlobPut {
  /** Relative path `<aa>/<sha256>`. */
  blob: string;
  bytes: number;
  tokens: number;
  sha256: string;
}

export function previewOf(text: string): string {
  if (text.length <= PREVIEW_HEAD + PREVIEW_TAIL) return text;
  return `${text.slice(0, PREVIEW_HEAD)} … ${text.slice(-PREVIEW_TAIL)}`;
}

export function sha256Of(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** `blobs/<aa>/<sha256>` is the canonical event field; tolerate a bare path too. */
export function normalizeBlobPath(blob: string): string {
  return blob.replace(/^blobs[/\\]/, '');
}

export class BlobStore {
  private readonly cache = new Map<string, string>();
  private readonly cacheLimit: number;
  private readonly pending = new Map<string, Promise<BlobPut>>();

  constructor(readonly dir: string, cacheLimit = 8) {
    this.cacheLimit = cacheLimit;
  }

  private pathOf(blob: string): string {
    return join(this.dir, ...normalizeBlobPath(blob).split('/'));
  }

  /** Dedupe by content hash; concurrent puts of the same text share one write. */
  async put(text: string): Promise<BlobPut> {
    const sha256 = sha256Of(text);
    const blob = `${sha256.slice(0, 2)}/${sha256.slice(2)}`;
    const bytes = Buffer.byteLength(text, 'utf8');
    const result: BlobPut = { blob, bytes, tokens: estimateTokens(text), sha256 };
    const running = this.pending.get(blob);
    if (running) return running;
    if (await this.exists(blob)) {
      this.remember(blob, text);
      return result;
    }
    const task = (async (): Promise<BlobPut> => {
      const target = this.pathOf(blob);
      await ensureDir(dirname(target));
      // Write-then-rename so a crash never leaves a half-written blob.
      const tmp = `${target}.${process.pid}.tmp`;
      await writeFile(tmp, text, 'utf8');
      await rename(tmp, target);
      this.remember(blob, text);
      return result;
    })();
    this.pending.set(blob, task);
    try {
      return await task;
    } finally {
      this.pending.delete(blob);
    }
  }

  private remember(blob: string, text: string): void {
    if (this.cacheLimit <= 0) return;
    this.cache.delete(blob);
    this.cache.set(blob, text);
    while (this.cache.size > this.cacheLimit) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  async exists(blob: string): Promise<boolean> {
    try {
      const info = await stat(this.pathOf(blob));
      return info.isFile();
    } catch {
      return false;
    }
  }

  async get(blob: string): Promise<string> {
    const cached = this.cache.get(blob);
    if (cached !== undefined) return cached;
    const text = await readFile(this.pathOf(blob), 'utf8');
    this.remember(blob, text);
    return text;
  }

  /** Read a character window; used by `read_handle` to bound one fetch. */
  async getRange(blob: string, offset = 0, chars?: number): Promise<{ text: string; total: number; offset: number }> {
    const text = await this.get(blob);
    const start = Math.max(0, Math.min(offset, text.length));
    if (chars === undefined) return { text: text.slice(start), total: text.length, offset: start };
    return { text: text.slice(start, start + Math.max(0, chars)), total: text.length, offset: start };
  }

  async bytes(blob: string): Promise<number> {
    try {
      return (await stat(this.pathOf(blob))).size;
    } catch {
      return 0;
    }
  }

  /** Retention sweep: blobs untouched for `days` are dropped. */
  async gc(maxAgeDays: number, now = Date.now()): Promise<number> {
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    let shards: string[] = [];
    try {
      shards = await readdir(this.dir);
    } catch {
      return 0;
    }
    for (const shard of shards) {
      if (shard.length !== 2) continue;
      let files: string[] = [];
      try {
        files = await readdir(join(this.dir, shard));
      } catch {
        continue;
      }
      for (const file of files) {
        const full = join(this.dir, shard, file);
        if (file.endsWith('.tmp')) {
          await unlink(full).catch(() => undefined);
          continue;
        }
        try {
          const info = await stat(full);
          if (info.mtimeMs < cutoff) {
            await unlink(full);
            this.cache.delete(`${shard}/${file}`);
            removed += 1;
          }
        } catch {
          // already gone
        }
      }
    }
    return removed;
  }
}