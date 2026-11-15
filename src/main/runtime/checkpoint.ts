import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { SnapshotMeta } from '../../shared/types.js';
import { ensureDir, readJson, writeJsonAtomic } from '../util.js';

/**
 * Shadow-git-free checkpoints, one immutable tree per completed step.
 *
 * The point of a full tree instead of a diff is revert: restoring only the files
 * a step touched leaves behind files the step created. Each capture also stores
 * the conversational state, so a revert replaces the whole state instead of
 * truncating a tail that may already have been compacted.
 */

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-electron', '.xiaohey', '.dsh', '.agent']);

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split('\\').join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (rel.split('/').some((part) => SKIP_DIRS.has(part))) continue;
      await walk(root, full, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function hash(buffer: Buffer): string {
  return createHash('sha1').update(buffer).digest('hex');
}

async function hashTree(root: string, files: string[]): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const file of files) {
    try {
      result[file] = hash(await readFile(join(root, file)));
    } catch {
      result[file] = 'absent';
    }
  }
  return result;
}

export interface CaptureInput {
  threadId: string;
  step: number;
  label: string;
  workspace: string;
  state: unknown;
  filesTouched: string[];
  id?: string;
}

interface MetaFile extends SnapshotMeta {
  hashes: Record<string, string>;
}

/** Line counts for one file, computed as a multiset difference (cheap, no LCS). */
export function countLineDiff(before: string, after: string): { additions: number; deletions: number } {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const counts = new Map<string, number>();
  for (const line of beforeLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of afterLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  const afterCounts = new Map<string, number>();
  for (const line of afterLines) afterCounts.set(line, (afterCounts.get(line) ?? 0) + 1);
  let deletions = 0;
  for (const line of beforeLines) {
    const left = afterCounts.get(line) ?? 0;
    if (left > 0) afterCounts.set(line, left - 1);
    else deletions += 1;
  }
  return { additions, deletions };
}

export class Checkpoints {
  constructor(private readonly root: string) {}

  private dir(threadId: string, id: string): string {
    return join(this.root, threadId, id);
  }

  async capture(input: CaptureInput): Promise<SnapshotMeta & { additiveOnly: boolean }> {
    const files = await walk(input.workspace);
    const hashes = await hashTree(input.workspace, files);
    const previous = (await this.list(input.threadId)).at(-1);
    const previousHashes = previous ? await this.hashesOf(input.threadId, previous.id) : {};
    const changed = files.filter((file) => previousHashes[file] !== hashes[file]);
    const additiveOnly = previous
      ? changed.every((file) => !previousHashes[file]) && Object.keys(previousHashes).every((file) => hashes[file] !== undefined)
      : false;

    const id = input.id ?? `step-${String(input.step).padStart(3, '0')}`;
    const target = this.dir(input.threadId, id);
    await rm(target, { recursive: true, force: true });
    await mkdir(join(target, 'tree'), { recursive: true });
    for (const file of files) {
      const destination = join(target, 'tree', file);
      await mkdir(join(destination, '..'), { recursive: true });
      await cp(join(input.workspace, file), destination);
    }

    let sizeBytes = 0;
    for (const file of files) {
      sizeBytes += (await stat(join(input.workspace, file))).size;
    }

    const meta: MetaFile = {
      id,
      step: input.step,
      label: input.label,
      at: Date.now(),
      files,
      additiveOnly,
      sizeBytes,
      hashes,
      changeStats: await this.changeStats(input.threadId, previous?.id, input.workspace, files, hashes, previousHashes),
    };
    await writeJsonAtomic(join(target, 'meta.json'), meta);
    await writeJsonAtomic(join(target, 'state.json'), { step: input.step, filesTouched: input.filesTouched, state: input.state });
    return meta;
  }

  async list(threadId: string): Promise<SnapshotMeta[]> {
    const base = join(this.root, threadId);
    try {
      const entries = await readdir(base, { withFileTypes: true });
      const metas: SnapshotMeta[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const meta = await readJson<MetaFile | null>(join(base, entry.name, 'meta.json'), null);
        if (!meta) continue;
        const { hashes: _hashes, ...rest } = meta;
        metas.push(rest);
      }
      return metas.sort((a, b) => a.step - b.step);
    } catch {
      return [];
    }
  }

  private async hashesOf(threadId: string, id: string): Promise<Record<string, string>> {
    const meta = await readJson<MetaFile | null>(join(this.root, threadId, id, 'meta.json'), null);
    return meta?.hashes ?? {};
  }

  /**
   * Per-file additions/deletions against the previous snapshot, so the change
   * card in the transcript can show real numbers instead of a bare file list.
   */
  private async changeStats(
    threadId: string,
    previousId: string | undefined,
    workspace: string,
    files: string[],
    hashes: Record<string, string>,
    previousHashes: Record<string, string>,
  ): Promise<{ additions: number; deletions: number; files: { path: string; additions: number; deletions: number }[] }> {
    if (!previousId) return { additions: 0, deletions: 0, files: [] };
    const previousTree = join(this.root, threadId, previousId, 'tree');
    const changed = files.filter((file) => previousHashes[file] !== hashes[file]).slice(0, 60);
    const results: { path: string; additions: number; deletions: number }[] = [];
    for (const file of changed) {
      try {
        const current = await readFile(join(workspace, file));
        if (current.length > 512_000) continue;
        const before = await readFile(join(previousTree, file)).catch(() => Buffer.from(''));
        if (before.length > 512_000) continue;
        const { additions, deletions } = countLineDiff(before.toString('utf8'), current.toString('utf8'));
        if (additions === 0 && deletions === 0) continue;
        results.push({ path: file, additions, deletions });
      } catch {
        continue;
      }
    }
    return {
      additions: results.reduce((sum, file) => sum + file.additions, 0),
      deletions: results.reduce((sum, file) => sum + file.deletions, 0),
      files: results,
    };
  }

  /**
   * Fill in a snapshot's diff after the step ran: compares the stored tree
   * (the state before the change) with the workspace as it is now.
   */
  async restat(threadId: string, id: string, workspace: string): Promise<(SnapshotMeta & { additiveOnly: boolean }) | null> {
    const dir = this.dir(threadId, id);
    const meta = await readJson<MetaFile | null>(join(dir, 'meta.json'), null);
    if (!meta) return null;
    const files = await walk(workspace);
    const currentHashes = await hashTree(workspace, files);
    const changed = files.filter((file) => meta.hashes[file] !== currentHashes[file]).slice(0, 60);
    const entries: { path: string; additions: number; deletions: number }[] = [];
    for (const file of changed) {
      try {
        const current = await readFile(join(workspace, file));
        if (current.length > 512_000) continue;
        const before = await readFile(join(dir, 'tree', file)).catch(() => Buffer.from(''));
        if (before.length > 512_000) continue;
        const { additions, deletions } = countLineDiff(before.toString('utf8'), current.toString('utf8'));
        if (additions === 0 && deletions === 0) continue;
        entries.push({ path: file, additions, deletions });
      } catch {
        continue;
      }
    }
    const next: MetaFile = {
      ...meta,
      additiveOnly: changed.every((file) => meta.hashes[file] === undefined),
      changeStats: {
        additions: entries.reduce((sum, file) => sum + file.additions, 0),
        deletions: entries.reduce((sum, file) => sum + file.deletions, 0),
        files: entries,
      },
    };
    await writeJsonAtomic(join(dir, 'meta.json'), next);
    const { hashes: _hashes, ...rest } = next;
    return rest;
  }

  /** What a revert would change: files to restore and files to delete, with line counts. */
  async preview(
    threadId: string,
    id: string,
    workspace: string,
  ): Promise<{ entries: Array<{ path: string; status: 'restore' | 'delete'; additions: number; deletions: number; before: string; after: string }> }> {
    const dir = this.dir(threadId, id);
    const meta = await readJson<MetaFile | null>(join(dir, 'meta.json'), null);
    if (!meta) return { entries: [] };
    const currentFiles = await walk(workspace);
    const known = new Set(meta.files);
    const entries: Array<{ path: string; status: 'restore' | 'delete'; additions: number; deletions: number; before: string; after: string }> = [];
    for (const file of currentFiles.filter((entry) => !known.has(entry))) {
      const after = await readFile(join(workspace, file), 'utf8').catch(() => '');
      entries.push({ path: file, status: 'delete', additions: 0, deletions: after.split(/\r?\n/).length, before: after, after: '' });
    }
    for (const file of meta.files) {
      const treeFile = join(dir, 'tree', file);
      const current = await readFile(join(workspace, file), 'utf8').catch(() => null);
      const snapshotContent = await readFile(treeFile, 'utf8').catch(() => '');
      if (current === snapshotContent) continue;
      if (current !== null && (current.length > 200_000 || snapshotContent.length > 200_000)) continue;
      const { additions, deletions } = countLineDiff(current ?? '', snapshotContent);
      if (additions === 0 && deletions === 0) continue;
      entries.push({ path: file, status: 'restore', additions, deletions, before: current ?? '', after: snapshotContent });
    }
    return { entries: entries.slice(0, 80) };
  }

  async stateOf(threadId: string, id: string): Promise<{ step: number; filesTouched: string[]; state: unknown } | null> {
    return readJson(join(this.root, threadId, id, 'state.json'), null);
  }

  /** Hash-verify a snapshot before trusting it to overwrite the workspace. */
  async verify(threadId: string, id: string): Promise<{ ok: boolean; detail: string; bad: string[] }> {
    const dir = this.dir(threadId, id);
    const meta = await readJson<MetaFile | null>(join(dir, 'meta.json'), null);
    if (!meta) return { ok: false, detail: 'snapshot metadata missing', bad: [] };
    const bad: string[] = [];
    for (const [file, expected] of Object.entries(meta.hashes)) {
      try {
        const actual = hash(await readFile(join(dir, 'tree', file)));
        if (actual !== expected) bad.push(file);
      } catch {
        bad.push(file);
      }
    }
    return {
      ok: bad.length === 0,
      detail: bad.length === 0 ? `${meta.files.length} files verified` : `${bad.length} files failed the hash check`,
      bad,
    };
  }

  /**
   * Restore a snapshot: verify, delete everything the snapshot does not know
   * about, then copy its tree back. Returns the file-level summary for the
   * factual rollback message the model receives.
   */
  async revert(threadId: string, id: string, workspace: string): Promise<{ ok: boolean; message: string; restored: number; deleted: number; state: unknown }> {
    const verification = await this.verify(threadId, id);
    if (!verification.ok) {
      return { ok: false, message: `快照 ${id} 完整性校验未通过：${verification.detail}`, restored: 0, deleted: 0, state: null };
    }
    const dir = this.dir(threadId, id);
    const meta = await readJson<MetaFile | null>(join(dir, 'meta.json'), null);
    if (!meta) return { ok: false, message: '快照元数据缺失', restored: 0, deleted: 0, state: null };

    const current = await walk(workspace);
    const known = new Set(meta.files);
    const toDelete = current.filter((file) => !known.has(file));
    for (const file of toDelete) {
      await rm(join(workspace, file), { force: true });
    }
    for (const file of meta.files) {
      const destination = join(workspace, file);
      await mkdir(join(destination, '..'), { recursive: true });
      await cp(join(dir, 'tree', file), destination);
    }

    const state = await this.stateOf(threadId, id);
    return {
      ok: true,
      restored: meta.files.length,
      deleted: toDelete.length,
      state: state?.state ?? null,
      message: `已还原 ${meta.files.length} 个文件，并删除了回退点之后新建的 ${toDelete.length} 个文件`,
    };
  }

  async writeBlob(threadId: string, id: string, relativePath: string, content: string): Promise<string> {
    const path = join(this.dir(threadId, id), 'blobs', relativePath.replace(/[\\/]/g, '__'));
    await ensureDir(join(path, '..'));
    await writeFile(path, content, 'utf8');
    return path;
  }
}
