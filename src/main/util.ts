import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export const uid = (prefix = 'id'): string => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Cheap token estimate for budgeting.
 *
 * English/code averages roughly 3.6 characters per token, but a CJK character is
 * usually one token (sometimes two), so counting all characters as length/3.6
 * would under-count a Chinese prompt by ~3x and let the context overflow the
 * model's window. Count CJK characters (including full-width punctuation) as
 * one token and the rest at the English ratio.
 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/g;

export const estimateTokens = (text: string): number => {
  const cjk = text.match(CJK)?.length ?? 0;
  return Math.ceil(cjk + (text.length - cjk) / 3.6);
};

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Write-then-rename so a crash never leaves a half-written state file. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, JSON.stringify(value, null, 2));
}

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

/** Resolve `child` inside `root`, refusing escapes and absolute paths. */
export function resolveInside(root: string, child: string): string {
  const base = resolve(root);
  const target = resolve(base, child);
  const rel = relative(base, target);
  if (rel.startsWith('..') || rel.includes(`..${sep}`)) {
    throw new Error(`path escapes the workspace: ${child}`);
  }
  return target;
}

export const relativeTo = (root: string, path: string): string =>
  relative(resolve(root), resolve(path)).split(sep).join('/');

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

export function joinHome(home: string, ...parts: string[]): string {
  return join(home, ...parts);
}

/** Deterministic JSON stringify, used for idempotency keys and hashing. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(',')}}`;
}
