import { appendFile, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDir } from '../util.js';
import { normalizeWorkspace } from './commit.js';
import type { UsageRecord } from './events.js';

/**
 * Token accounting, per workspace per Beijing day.
 *
 * The gate for long-term consolidation is a cost fuse, not a quality bar: a day
 * only earns a model pass when the workspace actually spent 50M billed tokens.
 * So the ledger records what was billed — cached reads are subtracted, and the
 * consolidation call itself never counts toward the gate it is testing.
 */

export const usageDayKey = (date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

export function workspaceIdOf(workspace: string): string {
  const normalized = normalizeWorkspace(workspace) || workspace;
  const digest = createHash('sha1').update(normalized).digest('hex').slice(0, 10);
  const name = basename(normalized).replace(/[^A-Za-z0-9_-]+/g, '').slice(0, 24) || 'workspace';
  return `${name}-${digest}`;
}

export interface UsageTotals {
  /** Tokens that count toward the consolidation gate. */
  billable: number;
  input: number;
  output: number;
  cachedRead: number;
  consolidateCalls: number;
  records: number;
}

export class UsageLedger {
  readonly dir: string;
  private readonly cache = new Map<string, UsageRecord[]>();

  constructor(root: string) {
    this.dir = join(root, 'usage');
  }

  fileOf(workspace: string): string {
    return join(this.dir, `${workspaceIdOf(workspace)}.jsonl`);
  }

  async append(record: UsageRecord): Promise<void> {
    await ensureDir(this.dir);
    await appendFile(this.fileOf(record.workspace), `${JSON.stringify(record)}\n`, 'utf8').catch(() => undefined);
    const key = `${workspaceIdOf(record.workspace)}`;
    const cached = this.cache.get(key);
    if (cached) cached.push(record);
  }

  async recordsOf(workspace: string): Promise<UsageRecord[]> {
    const key = workspaceIdOf(workspace);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const raw = await readFile(this.fileOf(workspace), 'utf8').catch(() => '');
    const records: UsageRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as UsageRecord;
        if (record && typeof record.input === 'number') records.push(record);
      } catch {
        // a torn line after a crash: skip it, the next append starts clean
      }
    }
    this.cache.set(key, records);
    return records;
  }

  /** Billable tokens for one workspace on one Beijing day. */
  async totals(workspace: string, dayKey: string): Promise<UsageTotals> {
    const records = (await this.recordsOf(workspace)).filter((record) => record.dayKey === dayKey);
    let input = 0;
    let output = 0;
    let cachedRead = 0;
    let consolidateCalls = 0;
    for (const record of records) {
      if (record.kind === 'consolidate') {
        consolidateCalls += 1;
        continue;
      }
      // Cache hits are cheaper and must not inflate the gate.
      input += Math.max(0, record.input - (record.cachedRead ?? 0));
      output += record.output;
      cachedRead += record.cachedRead ?? 0;
    }
    return { billable: input + output, input, output, cachedRead, consolidateCalls, records: records.length };
  }

  /**
   * Prompt tokens this session sent, and how many of them the provider served
   * from its cache. Scanned across every workspace ledger: switching a thread's
   * folder must not reset the number the composer prints.
   */
  async cacheOf(threadId: string): Promise<{ prompt: number; cached: number }> {
    let prompt = 0;
    let cached = 0;
    for (const workspace of await this.workspaces()) {
      for (const record of await this.recordsOf(workspace)) {
        if (record.sid !== threadId || record.kind === 'consolidate') continue;
        prompt += record.input;
        cached += record.cachedRead ?? 0;
      }
    }
    return { prompt, cached: Math.min(cached, prompt) };
  }

  /** Every workspace that has a ledger file, keyed by its recorded path. */  async workspaces(): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(this.dir).catch(() => [] as string[]);
    const found = new Set<string>();
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const raw = await readFile(join(this.dir, file), 'utf8').catch(() => '');
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const record = JSON.parse(trimmed) as UsageRecord;
          if (record.workspace) {
            found.add(record.workspace);
            break;
          }
        } catch {
          // torn line: keep looking
        }
      }
    }
    return [...found];
  }

  /** Days with any billable activity, newest first. */
  async days(workspace: string): Promise<string[]> {
    const records = await this.recordsOf(workspace);
    return [...new Set(records.map((record) => record.dayKey))].sort();
  }
}