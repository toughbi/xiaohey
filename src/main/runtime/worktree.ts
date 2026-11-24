import { exec, execFile } from 'node:child_process';
import { cp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeWorkspace, workspaceKey } from './commit.js';
import type { LockTable } from './locks.js';
import { readJson } from '../util.js';

/**
 * On-demand git worktrees for concurrent sessions in one workspace.
 *
 * The first session keeps the main checkout; every additional concurrent
 * session gets its own worktree on an `xiaohey/<threadId>` branch, so their
 * write sets are disjoint by construction and the per-file lease/CAS layer
 * only has to guard the main tree and external edits.
 *
 * A worktree branches from committed HEAD, but the main tree's live state is
 * mostly *uncommitted* (the file tools write directly). Creation therefore
 * overlays the main tree's uncommitted delta — tracked patch plus untracked
 * files — so an isolated session starts from the same truth the incumbent
 * sees, not from a stale commit. node_modules is junctioned, not copied.
 *
 * Merge-back is serial (workspace mutex), gated on the project's typecheck
 * when one exists, and never destructive: conflicts or a red gate abort the
 * merge and keep the branch, surfacing a pending state instead of guessing.
 * Because the main tree's live state is uncommitted and git won't merge over
 * local modifications, the merge first lands those modifications as a commit.
 */

export interface WorktreeState {
  path: string;
  branch: string;
  /** Main tree's branch at creation; empty when detached, baseHead is used then. */
  baseBranch: string;
  baseHead: string;
  status: 'active' | 'pending' | 'merged';
  createdAt: number;
  detail?: string;
  /** Files with conflict markers left in the worktree for the model to resolve. */
  conflicted?: string[];
}

export type CreateResult = { ok: true; state: WorktreeState } | { ok: false; reason: string };
export type MergeResult = { status: 'merged' | 'pending'; detail: string; conflicted?: string[] };

const APP_IDENTITY = ['-c', 'user.name=xiaohey', '-c', 'user.email=xiaohey@local'];
const MERGE_WAIT_MS = 3_000;
const VALIDATION_TIMEOUT_MS = 180_000;
const OVERLAY_FILE_CAP = 4_000;

function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim() || `git ${args[0]} failed`));
        else resolvePromise(String(stdout));
      },
    );
  });
}

export function worktreeRoot(home: string, workspace: string): string {
  const hash = createHash('sha1').update(normalizeWorkspace(workspace)).digest('hex').slice(0, 12);
  return join(home, 'worktrees', hash);
}

interface GitReady {
  head: string;
  branch: string;
}

/** A repo with at least one commit and no merge/rebase/cherry-pick in progress. */
async function gitReady(workspace: string): Promise<GitReady | null> {
  try {
    const head = (await git(workspace, ['rev-parse', '--verify', 'HEAD'])).trim();
    if (!head) return null;
    const gitDir = (await git(workspace, ['rev-parse', '--absolute-git-dir'])).trim();
    for (const marker of ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD', 'BISECT_LOG']) {
      if (existsSync(join(gitDir, marker))) return null;
    }
    let branch = '';
    try {
      branch = (await git(workspace, ['symbolic-ref', '--short', 'HEAD'])).trim();
    } catch {
      // detached HEAD: branch stays empty, merges use baseHead
    }
    return { head, branch };
  } catch {
    return null;
  }
}

async function branchExists(workspace: string, branch: string): Promise<boolean> {
  try {
    await git(workspace, ['rev-parse', '--verify', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create (or reuse after a crash) the session's isolated checkout. Returns a
 * reason string when isolation is unavailable — the caller falls back to the
 * lease/CAS path and tells the user why.
 */
export async function createWorktree(input: { home: string; workspace: string; threadId: string }): Promise<CreateResult> {
  const { home, workspace, threadId } = input;
  const ready = await gitReady(workspace);
  if (!ready) return { ok: false, reason: '工作区不是 git 仓库、还没有提交，或正处在 merge/rebase 中' };

  const path = join(worktreeRoot(home, workspace), threadId);
  const branch = `xiaohey/${threadId}`;

  if (existsSync(path)) {
    if (!existsSync(join(path, '.git'))) return { ok: false, reason: `副本目录已存在且不是 worktree：${path}` };
    return {
      ok: true,
      state: { path, branch, baseBranch: ready.branch, baseHead: ready.head, status: 'active', createdAt: Date.now() },
    };
  }

  try {
    await git(workspace, ['worktree', 'prune']);
    await mkdir(dirname(path), { recursive: true });
    const addArgs = (await branchExists(workspace, branch))
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path, 'HEAD'];
    await git(workspace, addArgs, 120_000);
  } catch (error) {
    return { ok: false, reason: `创建 worktree 失败：${(error as Error).message}` };
  }

  // Overlay the main tree's live (uncommitted) state onto the fresh checkout.
  try {
    const patch = await git(workspace, ['diff', 'HEAD', '--binary'], 60_000);
    if (patch.trim()) {
      const patchFile = join(home, 'tmp', `overlay-${threadId}.patch`);
      await mkdir(dirname(patchFile), { recursive: true });
      await writeFile(patchFile, patch, 'utf8');
      try {
        await git(path, ['apply', '--whitespace=nowarn', patchFile], 60_000);
      } finally {
        await rm(patchFile, { force: true });
      }
    }
    const untracked = (await git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'], 60_000))
      .split('\0')
      .filter((file) => file && !file.startsWith('node_modules/'));
    for (const file of untracked.slice(0, OVERLAY_FILE_CAP)) {
      const destination = join(path, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(workspace, file), destination);
    }
  } catch (error) {
    await git(workspace, ['worktree', 'remove', '--force', path]).catch(() => undefined);
    await git(workspace, ['branch', '-D', branch]).catch(() => undefined);
    return { ok: false, reason: `同步主工作区未提交改动失败：${(error as Error).message}` };
  }

  // Dependencies are shared, not copied: a junction costs nothing and removes
  // with the link, never through it.
  const mainModules = join(workspace, 'node_modules');
  const copyModules = join(path, 'node_modules');
  if (existsSync(mainModules) && !existsSync(copyModules)) {
    await symlink(mainModules, copyModules, 'junction').catch(() => undefined);
  }

  return {
    ok: true,
    state: { path, branch, baseBranch: ready.branch, baseHead: ready.head, status: 'active', createdAt: Date.now() },
  };
}

/** Commit everything the session changed in its worktree. False when nothing changed. */
export async function commitWorktree(state: WorktreeState, message: string): Promise<boolean> {
  const status = await git(state.path, ['status', '--porcelain', '--', '.', ':(exclude)node_modules']);
  if (!status.trim()) return false;
  // Exclude node_modules explicitly: it is a junction into the main tree, and
  // git add -A would otherwise stage the main tree's dependencies through it.
  await git(state.path, ['add', '-A', '--', '.', ':(exclude)node_modules']);
  await git(state.path, [...APP_IDENTITY, 'commit', '-m', message], 60_000);
  return true;
}

/** The cheap semantic gate: the project's own typecheck, with its own package manager. */
async function validationCommand(workspace: string): Promise<string | null> {
  const pkg = await readJson<{ scripts?: Record<string, string> }>(join(workspace, 'package.json'), {});
  if (!pkg.scripts?.typecheck) return null;
  const manager = existsSync(join(workspace, 'pnpm-lock.yaml'))
    ? 'pnpm'
    : existsSync(join(workspace, 'yarn.lock'))
      ? 'yarn'
      : 'npm';
  return `${manager} run typecheck`;
}

function runValidation(workspace: string, command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolvePromise) => {
    exec(
      command,
      { cwd: workspace, timeout: VALIDATION_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh' },
      (error, stdout, stderr) => {
        const output = [String(stdout), String(stderr)].filter(Boolean).join('\n').trim();
        resolvePromise({ ok: !error, output: output.slice(-4_000) });
      },
    );
  });
}

/**
 * Merge the session branch back into the main tree, serially. The merge stays
 * uncommitted while the validation gate runs; a conflict or a red gate aborts
 * it, keeping the branch and the worktree for a later retry or manual rescue.
 */
export async function mergeWorktree(input: {
  workspace: string;
  state: WorktreeState;
  locks: LockTable;
  owner: string;
  title: string;
  /** True while another session's turn is running in the main tree. */
  mainBusy: () => boolean;
}): Promise<MergeResult> {
  const { workspace, state, locks, owner, title, mainBusy } = input;
  if (mainBusy()) return { status: 'pending', detail: '主工作区还有会话在运行，等它结束后自动重试合并。' };

  const key = workspaceKey(workspace);
  try {
    await locks.acquire(key, owner, { fingerprint: 'n/a', waitMs: MERGE_WAIT_MS });
  } catch (error) {
    return { status: 'pending', detail: `工作区正忙，稍后自动重试合并：${(error as Error).message}` };
  }

  const gate = await validationCommand(workspace);
  try {
    if (mainBusy()) return { status: 'pending', detail: '主工作区还有会话在运行，等它结束后自动重试合并。' };
    // The main tree is mostly uncommitted — the file tools write directly, and
    // git refuses to merge over local modifications even when they match the
    // incoming result. Land them first: this is kept work, and committing it is
    // what makes the merge legal. The merge notice tells the user it happened.
    const dirty = await git(workspace, ['status', '--porcelain', '--', '.', ':(exclude)node_modules']);
    const landed = dirty.trim().length > 0;
    if (landed) {
      await git(workspace, ['add', '-A', '--', '.', ':(exclude)node_modules']);
      await git(workspace, [...APP_IDENTITY, 'commit', '-m', 'xiaohey: 落定主工作区未提交改动（合并前）'], 60_000);
    }
    let mergeOutput: string;
    try {
      mergeOutput = await git(workspace, ['merge', '--no-ff', '--no-commit', state.branch], 60_000);
    } catch (error) {
      const conflicted = (await git(workspace, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      await git(workspace, ['merge', '--abort']).catch(() => undefined);
      const message = (error as Error).message;
      return {
        status: 'pending',
        detail: conflicted.length > 0
          ? `合并冲突（${conflicted.slice(0, 8).join('、')}），改动保留在分支 ${state.branch}。`
          : `无法合并：${message.slice(0, 400)}。改动保留在分支 ${state.branch}。`,
        conflicted,
      };
    }

    if (!mergeOutput.includes('Already up to date')) {
      if (gate) {
        const verdict = await runValidation(workspace, gate);
        if (!verdict.ok) {
          await git(workspace, ['merge', '--abort']).catch(() => undefined);
          return {
            status: 'pending',
            detail: `合并后 ${gate} 未通过，已撤销合并，改动保留在分支 ${state.branch}。\n${verdict.output.slice(-1_200)}`,
          };
        }
      }
      await git(workspace, [...APP_IDENTITY, 'commit', '-m', `xiaohey: 合并会话「${title}」`], 60_000);
    }

    await removeWorktree(workspace, state, true);
    return {
      status: 'merged',
      detail: `${landed ? '主工作区的未提交改动已先落定为一个提交。' : ''}${gate ? `合并后 ${gate} 通过。` : '工作区没有 typecheck 脚本，未做语义验证。'}`,
    };
  } catch (error) {
    await git(workspace, ['merge', '--abort']).catch(() => undefined);
    return { status: 'pending', detail: `合并失败：${(error as Error).message}。改动保留在分支 ${state.branch}。` };
  } finally {
    await locks.release(key, owner);
  }
}

/**
 * A pending merge with conflicts is resolved in the session's own worktree:
 * merge the main line *into* the branch, leave the conflict markers there, and
 * let the model edit them with the normal file tools. The turn-end commit then
 * completes the reverse merge and the forward merge becomes clean.
 */
export async function prepareConflictResolution(workspace: string, state: WorktreeState): Promise<{ ok: boolean; conflicted: string[]; detail: string }> {
  const target = state.baseBranch || state.baseHead;
  try {
    await git(state.path, ['merge', '--no-commit', target], 60_000);
    return { ok: true, conflicted: [], detail: '主工作区的改动已并入副本，没有冲突。' };
  } catch (error) {
    const conflicted = (await git(state.path, ['diff', '--name-only', '--diff-filter=U']).catch(() => ''))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (conflicted.length > 0) {
      return { ok: true, conflicted, detail: `冲突文件已留在副本中：${conflicted.slice(0, 8).join('、')}。` };
    }
    await git(state.path, ['merge', '--abort']).catch(() => undefined);
    return { ok: false, conflicted: [], detail: `无法把主工作区改动并入副本：${(error as Error).message}` };
  }
}

/**
 * Remove the worktree checkout. The node_modules junction is unlinked first so
 * no recursive delete can ever reach the main tree's dependencies. An unmerged
 * branch is kept — deleting a session must not delete work that never landed.
 */
export async function removeWorktree(workspace: string, state: WorktreeState, deleteBranch: boolean): Promise<void> {
  const modules = join(state.path, 'node_modules');
  if (existsSync(modules)) await rm(modules, { force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  await git(workspace, ['worktree', 'remove', '--force', state.path]).catch(async () => {
    await rm(state.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  });
  await git(workspace, ['worktree', 'prune']).catch(() => undefined);
  if (deleteBranch) await git(workspace, ['branch', '-d', state.branch]).catch(() => undefined);
  const parent = dirname(state.path);
  const siblings = await readdir(parent).catch(() => ['placeholder']);
  if (siblings.length === 0) await rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
}