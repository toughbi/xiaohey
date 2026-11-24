import { fileFingerprint, textFingerprint } from '../fingerprint.js';
import { writeTextAtomic } from '../util.js';
import type { LockTable } from './locks.js';

/**
 * Compare-and-swap for file writes.
 *
 * Two agents (two sessions, or a session plus a shell) can touch one workspace.
 * A per-file lease keeps them from writing the same file *simultaneously*, but it
 * does not stop this sequence:
 *
 *   agent A reads a.ts  →  agent B rewrites a.ts  →  agent A writes its stale copy
 *
 * So the write itself re-reads the file and refuses unless its fingerprint still
 * matches what the caller saw. The workspace mutex around the check-and-write is
 * what closes the remaining gap: `run_shell` holds it for the whole command, so a
 * shell that edits files cannot interleave with a commit either.
 *
 * The critical section is a read, a compare and one atomic rename — milliseconds,
 * never an approval wait. Approvals happen before this call, while holding only
 * the file lease, so a user staring at an approval card does not block the
 * workspace.
 */

export type CommitResult = { ok: true; fingerprint: string } | { ok: false; reason: 'conflict' | 'busy'; detail: string };

export const WORKSPACE_LOCK_WAIT_MS = 3_000;

/** One key per workspace, case-folded because Windows paths are not case-sensitive. */
export function normalizeWorkspace(workspace: string): string {
  return workspace.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

export function workspaceKey(workspace: string): string {
  return `ws:${normalizeWorkspace(workspace)}`;
}

export interface CommitOptions {
  locks: LockTable;
  workspace: string;
  /** Absolute path being written. */
  target: string;
  content: string;
  /** Fingerprint the caller believed the file had; `absent` for a new file. */
  expected: string;
  owner: string;
  waitMs?: number;
}

export async function guardedCommit(options: CommitOptions): Promise<CommitResult> {
  const { locks, workspace, target, content, expected, owner, waitMs = WORKSPACE_LOCK_WAIT_MS } = options;
  const key = workspaceKey(workspace);

  try {
    await locks.acquire(key, owner, { fingerprint: 'n/a', waitMs });
  } catch (error) {
    return {
      ok: false,
      reason: 'busy',
      detail: `另一个会话正在这个工作区执行命令（${(error as Error).message}）。等它结束后重新读取文件再写。`,
    };
  }

  try {
    const current = await fileFingerprint(target);
    if (current !== expected) {
      const detail =
        expected === 'absent'
          ? '文件在这一步期间被创建了'
          : current === 'absent'
            ? '文件在这一步期间被删除或移动了'
            : '文件在这一步期间被其他地方修改过';
      return { ok: false, reason: 'conflict', detail };
    }
    await writeTextAtomic(target, content);
    return { ok: true, fingerprint: textFingerprint(content) };
  } finally {
    await locks.release(key, owner);
  }
}