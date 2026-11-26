import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ApprovalDecision, PlanStep, QuestionOption, ToolRisk, WriteTier } from '../../shared/types.js';
import { countLineDiff } from './checkpoint.js';
import { classifyWrite } from './policy.js';
import type { CommitResult } from './commit.js';
import { textFingerprint } from '../fingerprint.js';
import { formatRecall, type MemoryWriteArgs, type RecallArgs, type RecallResult } from './longterm.js';
import { domainFailure, readDomainFailure, transientFailure, type ToolOutcome } from './toolerrors.js';
import type { ToolSchema } from './validate.js';
import { resolveInside } from '../util.js';

/**
 * The tool set. One job each, with routing-oriented descriptions:
 * `Use when` / `Do NOT use when` is what keeps a model from oscillating between
 * two similar tools. Overlapping capabilities are folded into one tool with a
 * mode argument rather than exposed as siblings.
 */

export interface ShellRun {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ToolExecContext {
  threadId: string;
  turnId: string;
  workspace: string;
  shell: (command: string, timeoutMs: number, cwd: string) => Promise<ShellRun>;
  approve: (request: {
    name: string;
    command: string;
    reason: string;
    risk: ToolRisk;
    /** File writes only: drives the `auto` policy and the card copy. */
    tier?: WriteTier;
  }) => Promise<ApprovalDecision>;
  /** Show a clarification card and resolve with the user's answer. */
  ask: (request: { header: string; question: string; options: QuestionOption[] }) => Promise<{ answer: string; cancelled: boolean }>;
  remember: (entry: MemoryWriteArgs) => Promise<{ kind: string; note: string }>;
  /** Long-term recall: the model asks for memory, memory does not volunteer. */
  recall: (input: RecallArgs) => Promise<RecallResult>;
  /** Read blob content through a handle, budgeted per turn. */
  readHandle: (handle: string, offset?: number, limit?: number) => Promise<ToolOutcome>;
  /** Expand a completed turn: cached L2 summary, or raw events within budget. */
  expandTurn: (turn: number, mode: 'summary' | 'raw') => Promise<ToolOutcome>;
  /** Keyword search over this session's ledger and its L2 summaries. */
  searchSession: (query: string, limit: number) => Promise<ToolOutcome>;
  /** Full blob text for a handle; used by write_file_from_handle. */
  blobText: (handle: string) => Promise<string | null>;
  setPlan: (steps: PlanStep[]) => Promise<void>;
  markTouched: (files: string[]) => void;
  evidence: (tag: string) => void;
  /**
   * Compare-and-swap write: succeeds only when the file still matches the
   * fingerprint the tool read. Returns a conflict instead of clobbering another
   * session's change.
   */
  commitFile: (target: string, content: string, expected: string) => Promise<CommitResult>;
}

export interface ToolDefinition {
  name: string;
  risk: ToolRisk;
  mutating: boolean;
  summary: string;
  useWhen: string;
  avoidWhen: string;
  /** Concrete call examples, appended to the tool description the model sees. */
  examples?: string[];
  schema: ToolSchema;
  run: (ctx: ToolExecContext, args: Record<string, unknown>) => Promise<ToolOutcome>;
}

const SKIP = new Set(['.git', 'node_modules', 'dist', 'dist-electron', '.xiaohey', '.dsh', '.agent']);

async function walk(root: string, options: { maxFiles?: number; maxDepth?: number } = {}): Promise<string[]> {
  const files: string[] = [];
  const maxDepth = options.maxDepth ?? 6;
  const maxFiles = options.maxFiles ?? 4000;

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') {
        if (SKIP.has(entry.name)) continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP.has(entry.name)) continue;
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }

  await visit(root, 0);
  return files;
}

function rel(ctx: ToolExecContext, path: string): string {
  return relative(ctx.workspace, path).split('\\').join('/');
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function lineHits(text: string, pattern: RegExp, path: string, limit: number): string[] {
  const hits: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
    if (pattern.test(lines[i])) hits.push(`${path}:${i + 1}: ${lines[i].trim().slice(0, 220)}`);
  }
  return hits;
}

const pathArg = { type: 'string' as const, minLength: 1, description: 'Workspace-relative path, e.g. src/App.tsx' };

export const tools: ToolDefinition[] = [
  {
    name: 'list_dir',
    risk: 'read',
    mutating: false,
    summary: 'List a directory one level deep.',
    useWhen: 'You need to see what exists in a folder before reading or writing.',
    avoidWhen: 'You already know the path, or you are searching by content (use grep_text) or by name pattern (use glob_files).',
    schema: {
      type: 'object',
      properties: {
        path: { ...pathArg, description: 'Directory path, e.g. src or . (default .)' },
        depth: { type: 'integer', minimum: 1, maximum: 3, description: 'Levels to walk, default 1' },
      },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const target = resolveInside(ctx.workspace, String(args.path ?? '.'));
      const depth = Number(args.depth ?? 1);
      try {
        const info = await stat(target);
        if (!info.isDirectory()) return readDomainFailure('not a directory', `\`${args.path}\` is a file. Use read_file instead.`);
      } catch {
        return readDomainFailure('directory not found', `Nothing exists at \`${args.path}\`. Use list_dir on the parent to find the real path.`);
      }
      const entries: string[] = [];
      async function walkDir(dir: string, level: number): Promise<void> {
        if (level > depth) return;
        const items = await readdir(dir, { withFileTypes: true });
        for (const item of items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
          if (SKIP.has(item.name)) continue;
          const full = join(dir, item.name);
          entries.push(`${item.isDirectory() ? 'dir ' : 'file'}  ${rel(ctx, full)}${item.isDirectory() && level < depth ? '/' : ''}`);
          if (item.isDirectory() && level < depth) await walkDir(full, level + 1);
        }
      }
      await walkDir(target, 1);
      ctx.evidence(`list_dir:${rel(ctx, target)}`);
      return {
        ok: true,
        summary: `${entries.length} entries in ${rel(ctx, target) || '.'}`,
        output: entries.slice(0, 400).join('\n') || '(empty)',
        files: [rel(ctx, target)],
      };
    },
  },
  {
    name: 'read_file',
    risk: 'read',
    mutating: false,
    summary: 'Read a text file with line numbers.',
    useWhen: 'You need the current contents of one known file.',
    avoidWhen: 'You are looking for where something lives (use grep_text) or listing a folder (use list_dir).',
    schema: {
      type: 'object',
      properties: {
        path: pathArg,
        offset: { type: 'integer', minimum: 1, description: 'First line, default 1' },
        limit: { type: 'integer', minimum: 1, maximum: 800, description: 'Lines to return, default 400' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const target = resolveInside(ctx.workspace, String(args.path));
      try {
        const info = await stat(target);
        if (info.isDirectory()) return readDomainFailure('path is a directory', 'Use list_dir for folders.');
        if (info.size > 2_000_000) return readDomainFailure('file too large', 'Read it in slices with offset/limit, or grep for the part you need.');
        const text = await readFile(target, 'utf8');
        const offset = Number(args.offset ?? 1);
        const limit = Number(args.limit ?? 400);
        const lines = text.split(/\r?\n/);
        const slice = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = slice.map((line, i) => `${String(offset + i).padStart(4)} │ ${line}`).join('\n');
        ctx.markTouched([rel(ctx, target)]);
        ctx.evidence(`read_file:${rel(ctx, target)}`);
        return {
          ok: true,
          summary: `${rel(ctx, target)} · ${slice.length}/${lines.length} lines`,
          output: numbered || '(empty file)',
          files: [rel(ctx, target)],
        };
      } catch (error) {
        return readDomainFailure(
          'file not readable',
          `Could not read \`${args.path}\`. List the parent folder to confirm the name, then retry.`,
          (error as Error).message,
        );
      }
    },
  },
  {
    name: 'glob_files',
    risk: 'read',
    mutating: false,
    summary: 'Find files by name pattern.',
    useWhen: 'You know part of a filename or extension and need the matching paths.',
    avoidWhen: 'You are searching file contents (use grep_text) or listing one folder (use list_dir).',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob, e.g. **/*.tsx or src/**/*.css' },
        max: { type: 'integer', minimum: 1, maximum: 200, description: 'Matches to return, default 60' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const pattern = String(args.pattern);
      const max = Number(args.max ?? 60);
      const files = await walk(ctx.workspace);
      const matcher = globToRegExp(pattern);
      const matches = files.filter((file) => matcher.test(rel(ctx, file))).slice(0, max);
      ctx.evidence(`glob_files:${pattern}`);
      return {
        ok: true,
        summary: `${matches.length} match${matches.length === 1 ? '' : 'es'} for ${pattern}`,
        output: matches.map((file) => rel(ctx, file)).join('\n') || '(no matches)',
        files: matches.slice(0, 20).map((file) => rel(ctx, file)),
      };
    },
  },
  {
    name: 'grep_text',
    risk: 'read',
    mutating: false,
    summary: 'Search file contents with a regular expression.',
    useWhen: 'You need to locate text, a symbol or a config key across files.',
    avoidWhen: 'You already know the file (use read_file) or you only need a filename (use glob_files).',
    schema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression, e.g. useState\\(' },
        glob: { type: 'string', description: 'Optional path filter, e.g. **/*.tsx' },
        max: { type: 'integer', minimum: 1, maximum: 120, description: 'Hits to return, default 40' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      let matcher: RegExp;
      try {
        matcher = new RegExp(String(args.pattern), 'i');
      } catch (error) {
        return readDomainFailure('invalid regular expression', 'Simplify the pattern, for example escape parentheses.', (error as Error).message);
      }
      const filter = args.glob ? globToRegExp(String(args.glob)) : null;
      const files = await walk(ctx.workspace, { maxFiles: 3000 });
      const hits: string[] = [];
      const max = Number(args.max ?? 40);
      for (const file of files) {
        if (hits.length >= max) break;
        if (filter && !filter.test(rel(ctx, file))) continue;
        const info = await stat(file).catch(() => null);
        if (!info || info.size > 900_000) continue;
        const text = await readFile(file, 'utf8').catch(() => '');
        hits.push(...lineHits(text, matcher, rel(ctx, file), max - hits.length));
      }
      const filesTouched = [...new Set(hits.map((hit) => hit.split(':')[0]))].slice(0, 12);
      ctx.markTouched(filesTouched);
      ctx.evidence(`grep_text:${args.pattern}`);
      return {
        ok: true,
        summary: `${hits.length} hit${hits.length === 1 ? '' : 's'} in ${filesTouched.length} file${filesTouched.length === 1 ? '' : 's'}`,
        output: hits.join('\n') || '(no matches)',
        files: filesTouched,
      };
    },
  },
  {
    name: 'read_handle',
    risk: 'read',
    mutating: false,
    summary: 'Read a blob through its handle, in budgeted slices.',
    useWhen:
      'A tool result in the context was elided to `handle=h_…`, or turn_expand returned a handle, and you now need the original text.',
    avoidWhen:
      'The file still exists — read_file gives you the current truth; the blob is what it was at that step. Do not re-fetch the same handle over and over.',
    examples: ['read_handle { handle: "h_7f3a9c" }', 'read_handle { handle: "h_7f3a9c", offset: 4000, limit: 2000 }'],
    schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', minLength: 3, pattern: '^h_[A-Za-z0-9_]+$', description: 'Handle from an elided result, e.g. h_7f3a9c' },
        offset: { type: 'integer', minimum: 0, description: 'Character offset into the original text, default 0' },
        limit: { type: 'integer', minimum: 200, maximum: 4000, description: 'Token budget for this slice, default 4000' },
      },
      required: ['handle'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      return ctx.readHandle(
        String(args.handle ?? '').trim(),
        typeof args.offset === 'number' ? args.offset : undefined,
        typeof args.limit === 'number' ? args.limit : undefined,
      );
    },
  },
  {
    name: 'turn_expand',
    risk: 'read',
    mutating: false,
    summary: 'Expand a completed turn: its L2 summary, or its raw events within budget.',
    useWhen:
      'A history turn is shown as a compressed summary or a pointer, and you need the decisions, failures or file names behind it.',
    avoidWhen: 'The detail is in a file you can read; re-reading the file is the ground truth, an old turn is not.',
    examples: ['turn_expand { turn: 3 }', 'turn_expand { turn: 3, mode: "raw" }'],
    schema: {
      type: 'object',
      properties: {
        turn: { type: 'integer', minimum: 1, description: 'Turn number from the history badge' },
        mode: {
          type: 'string',
          enum: ['summary', 'raw'],
          description: 'summary (default) returns the structured L2 digest; raw returns the events when they fit the budget',
        },
      },
      required: ['turn'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const turn = Number(args.turn);
      if (!Number.isInteger(turn) || turn < 1) return domainFailure('turn 必须是正整数', 'Pass the turn number shown in the history lines.');
      return ctx.expandTurn(turn, args.mode === 'raw' ? 'raw' : 'summary');
    },
  },
  {
    name: 'session_search',
    risk: 'read',
    mutating: false,
    summary: 'Search this session\'s ledger for a keyword and return turns plus snippets.',
    useWhen:
      'The user refers to something from an earlier turn ("昨天那个登录 bug", "我刚才说的那个配置"), or a detail slid out of the eight-turn window.',
    avoidWhen: 'You can grep the workspace instead — this searches the conversation, not the code.',
    examples: ['session_search { query: "refresh token" }'],
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1, description: 'Keyword or phrase; Chinese and English both work' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'Maximum hits, default 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const query = String(args.query ?? '').trim();
      if (!query) return domainFailure('query 是空的', 'Pass the words you remember in `query`.');
      return ctx.searchSession(query, typeof args.limit === 'number' ? args.limit : 5);
    },
  },
  {
    name: 'write_file_from_handle',
    risk: 'write',
    mutating: true,
    summary: 'Write a file from blob content addressed by a handle.',
    useWhen:
      'You already produced the content once (a big tool result, a previous draft) and need it written to disk without retyping it.',
    avoidWhen: 'You have the text at hand — write_file keeps the content visible in the transcript.',
    schema: {
      type: 'object',
      properties: {
        handle: { type: 'string', minLength: 3, description: 'Handle that points at the content' },
        path: pathArg,
      },
      required: ['handle', 'path'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const handle = String(args.handle ?? '').trim();
      const content = await ctx.blobText(handle);
      if (content === null) {
        return domainFailure(
          `handle ${handle} 没有原文`,
          'The blob expired or the handle is wrong. Use read_handle to check, or write the content directly.',
        );
      }
      const target = resolveInside(ctx.workspace, String(args.path));
      return commitText(ctx, 'write_file_from_handle', target, content, '从 handle 写入');
    },
  },
  {
    name: 'write_file_chunk',
    risk: 'write',
    mutating: true,
    summary: 'Write a long file in chunks: append, or splice at a character offset.',
    useWhen: 'The file is too long for one write_file call, or you are appending a large block to an existing file.',
    avoidWhen: 'The change is a small edit inside an existing file — edit_file keeps the rest intact and is safer.',
    examples: ['write_file_chunk { path: "src/a.ts", content: "…", mode: "append" }'],
    schema: {
      type: 'object',
      properties: {
        path: pathArg,
        content: { type: 'string', description: 'The chunk itself' },
        mode: {
          type: 'string',
          enum: ['append', 'splice'],
          description: 'append (default) adds at the end and creates the file; splice replaces a range at `offset`',
        },
        offset: { type: 'integer', minimum: 0, description: 'Character offset for splice, default end of file' },
        removeLength: { type: 'integer', minimum: 0, description: 'Characters to remove at offset for splice, default 0' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const target = resolveInside(ctx.workspace, String(args.path));
      const chunk = String(args.content ?? '');
      const prior = await readFile(target, 'utf8').catch(() => null);
      const mode = args.mode === 'splice' ? 'splice' : 'append';
      let next: string;
      if (mode === 'append') {
        next = (prior ?? '') + chunk;
      } else {
        if (prior === null) {
          return readDomainFailure('文件不存在，无法按偏移写', 'Use mode: "append" to create the file, or write_file for a fresh file.');
        }
        const offset = Math.max(0, Math.min(prior.length, Number(args.offset ?? prior.length)));
        const removeLength = Math.max(0, Number(args.removeLength ?? 0));
        next = `${prior.slice(0, offset)}${chunk}${prior.slice(offset + removeLength)}`;
      }
      const relative = rel(ctx, target);
      const change = prior === null ? null : countLineDiff(prior, next);
      const verdict = classifyWrite({
        path: relative,
        kind: prior === null ? 'create' : 'edit',
        addedLines: change?.additions ?? next.split(/\r?\n/).length,
        deletedLines: change?.deletions ?? 0,
        totalLinesBefore: prior ? prior.split(/\r?\n/).length : 0,
      });
      const decision = await ctx.approve({
        name: 'write_file_chunk',
        command: relative,
        reason: `${verdict.reason} · ${mode === 'append' ? '追加' : '按偏移替换'} ${chunk.length} 字符`,
        risk: 'write',
        tier: verdict.tier,
      });
      if (decision === 'deny') {
        return domainFailure('写入未获批准', `The user declined writing \`${relative}\`. Do not retry the same chunk.`);
      }
      const committed = await ctx.commitFile(target, next, prior === null ? 'absent' : textFingerprint(prior));
      if (!committed.ok) {
        return domainFailure(
          committed.reason === 'busy' ? '工作区正忙，没有写入' : '文件在写入前被改过，没有写入',
          `${committed.detail} Re-read the file and recompute the offset; do not replay the old chunk.`,
        );
      }
      ctx.markTouched([relative]);
      return {
        ok: true,
        summary: `${mode === 'append' ? 'appended to' : 'spliced'} ${relative} · ${chunk.length} chars`,
        output: `${relative} written (${next.length} chars total)`,
        files: [relative],
      };
    },
  },
  {
    name: 'write_file',
    risk: 'write',
    mutating: true,
    summary: 'Create or overwrite a file.',
    useWhen: 'The file should not exist yet, or its whole content is being replaced deliberately.',
    avoidWhen: 'You are changing part of an existing file — use edit_file so the rest is preserved.',
    schema: {
      type: 'object',
      properties: {
        path: pathArg,
        content: { type: 'string', description: 'Complete file content' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const target = resolveInside(ctx.workspace, String(args.path));
      const content = String(args.content);
      const relative = rel(ctx, target);
      // Read the previous body before writing: the diff decides the risk tier
      // shown on the approval card, and whether this is create or overwrite.
      const prior = await readFile(target, 'utf8').catch(() => null);
      const expected = prior === null ? 'absent' : textFingerprint(prior);
      const change = prior === null ? { additions: content.split(/\r?\n/).length, deletions: 0 } : countLineDiff(prior, content);
      const verdict = classifyWrite({
        path: relative,
        kind: prior === null ? 'create' : 'overwrite',
        addedLines: change.additions,
        deletedLines: change.deletions,
        totalLinesBefore: prior ? prior.split(/\r?\n/).length : 0,
      });
      const decision = await ctx.approve({
        name: 'write_file',
        command: relative,
        reason: `${verdict.reason}${prior === null ? '' : ` · 覆盖 ${prior.split(/\r?\n/).length} 行`}`,
        risk: 'write',
        tier: verdict.tier,
      });
      if (decision === 'deny') {
        return domainFailure(
          '写入未获批准',
          `The user declined writing \`${relative}\`. Do not retry the same write; ask what they want instead, or leave the file untouched.`,
        );
      }
      const committed = await ctx.commitFile(target, content, expected);
      if (!committed.ok) {
        return domainFailure(
          committed.reason === 'busy' ? '工作区正忙，没有写入' : '文件在写入前被改过，没有写入',
          `${committed.detail} 重新 read_file 拿最新内容，再决定是合并还是覆盖；不要用旧内容重试。`,
        );
      }
      const lines = content.split(/\r?\n/).length;
      ctx.markTouched([relative]);
      return { ok: true, summary: `wrote ${relative} · ${lines} lines`, output: `${relative} written (${content.length} chars)`, files: [relative] };
    },
  },
  {
    name: 'edit_file',
    risk: 'write',
    mutating: true,
    summary: 'Replace an exact snippet inside a file.',
    useWhen: 'You know the exact text to change and only that part should change.',
    avoidWhen: 'The file does not exist yet or is being rewritten — use write_file.',
    schema: {
      type: 'object',
      properties: {
        path: pathArg,
        find: { type: 'string', minLength: 1, description: 'Exact text to replace, including indentation' },
        replace: { type: 'string', description: 'Replacement text' },
        all: { type: 'boolean', description: 'Replace every occurrence, default false' },
      },
      required: ['path', 'find', 'replace'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const target = resolveInside(ctx.workspace, String(args.path));
      const find = String(args.find);
      const replacement = String(args.replace);
      let text: string;
      try {
        text = await readFile(target, 'utf8');
      } catch {
        return readDomainFailure('file not found', `\`${args.path}\` does not exist. Use write_file to create it, or list_dir to find the real name.`);
      }
      const occurrences = text.split(find).length - 1;
      if (occurrences === 0) {
        return domainFailure(
          '没有找到要替换的片段',
          'Re-read the file and copy the exact text, including whitespace. The snippet must appear verbatim. Writes are not retried automatically.',
        );
      }
      if (occurrences > 1 && !args.all) {
        return domainFailure(
          `片段出现了 ${occurrences} 次`,
          'Add surrounding context to make the snippet unique, or pass all: true to replace every occurrence.',
        );
      }
      const next = args.all ? text.split(find).join(replacement) : text.replace(find, replacement);
      const relative = rel(ctx, target);
      const change = countLineDiff(text, next);
      const verdict = classifyWrite({
        path: relative,
        kind: 'edit',
        addedLines: change.additions,
        deletedLines: change.deletions,
        totalLinesBefore: text.split(/\r?\n/).length,
      });
      const decision = await ctx.approve({
        name: 'edit_file',
        command: relative,
        reason: `${verdict.reason} · ${occurrences} 处替换`,
        risk: 'write',
        tier: verdict.tier,
      });
      if (decision === 'deny') {
        return domainFailure(
          '修改未获批准',
          `The user declined the edit to \`${relative}\`. Do not retry it unchanged; ask what they want changed.`,
        );
      }
      const committed = await ctx.commitFile(target, next, textFingerprint(text));
      if (!committed.ok) {
        return domainFailure(
          committed.reason === 'busy' ? '工作区正忙，没有写入' : '文件在修改前被改过，没有写入',
          `${committed.detail} 重新 read_file 看最新内容，再重新定位要替换的片段；不要用旧的片段重试。`,
        );
      }
      ctx.markTouched([relative]);
      return {
        ok: true,
        summary: `edited ${relative} · ${occurrences} replacement${occurrences === 1 ? '' : 's'}`,
        output: `${relative} updated`,
        files: [relative],
      };
    },
  },
  {
    name: 'run_shell',
    risk: 'exec',
    mutating: true,
    summary: 'Run one shell command in the workspace.',
    useWhen: 'You need to build, test, typecheck or inspect state no file tool can see.',
    avoidWhen: 'A read_file, grep_text or glob_files call answers it — those are cheaper and need no approval.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', minLength: 1, description: 'Command line, e.g. npm test' },
        purpose: { type: 'string', minLength: 1, description: 'One line: what this command proves' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 180000, description: 'Default 120000' },
      },
      required: ['command', 'purpose'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const command = String(args.command);
      const purpose = String(args.purpose);
      const decision = await ctx.approve({ name: 'run_shell', command, reason: purpose, risk: 'exec' });
      if (decision === 'deny') {
        return domainFailure('command denied by the user', 'Ask what to do instead, or pick a read-only tool. Do not retry the same command.');
      }
      try {
        const result = await ctx.shell(command, Number(args.timeoutMs ?? 120_000), ctx.workspace);
        const output = [`$ ${command}`, `exit ${result.code} · ${result.durationMs}ms`, result.stdout.trim(), result.stderr.trim()]
          .filter(Boolean)
          .join('\n');
        if (result.code !== 0) {
          return {
            ok: false,
            layer: 'L3-domain',
            summary: `command exited ${result.code}`,
            detail: output.slice(0, 6000),
            hint: 'Read the output, fix the cause, and run the command again only after a change.',
            retryable: false,
          };
        }
        ctx.evidence(`run_shell:${command}`);
        return { ok: true, summary: `${command} · exit 0 in ${result.durationMs}ms`, output: output.slice(0, 20_000) };
      } catch (error) {
        return transientFailure(error);
      }
    },
  },
  {
    name: 'todo_write',
    risk: 'write',
    mutating: false,
    summary: 'Replace the task plan.',
    useWhen: 'Starting work with more than two steps, or when a step completes.',
    avoidWhen: 'The task is a single edit — just do it.',
    schema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable id, optional' },
              title: { type: 'string', minLength: 1, maxLength: 160, description: 'One short line describing the step' },
              status: { type: 'string', enum: ['pending', 'active', 'done', 'dropped'], description: 'Default pending' },
            },
            required: ['title'],
          },
          description: 'Array of {title, status} where status is pending | active | done | dropped',
        },
      },
      required: ['steps'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const raw = Array.isArray(args.steps) ? args.steps : [];
      const steps: PlanStep[] = raw
        .map((step, index) => {
          const item = step as Record<string, unknown>;
          const status = String(item.status ?? 'pending');
          const allowed = ['pending', 'active', 'done', 'dropped'];
          return {
            id: String(item.id ?? `s${index + 1}`),
            title: String(item.title ?? '').slice(0, 160),
            status: (allowed.includes(status) ? status : 'pending') as PlanStep['status'],
          };
        })
        .filter((step) => step.title.length > 0)
        .slice(0, 12);
      if (steps.length === 0) return domainFailure('plan is empty', 'Pass at least one step with a title.');
      await ctx.setPlan(steps);
      const done = steps.filter((step) => step.status === 'done').length;
      return { ok: true, summary: `plan updated · ${done}/${steps.length} done`, output: steps.map((s) => `[${s.status}] ${s.title}`).join('\n') };
    },
  },
  {
    name: 'memory_read',
    risk: 'read',
    mutating: false,
    summary: 'Recall long-term memories (episodic / relational / knowledge) about this user, project or past work.',
    useWhen:
      'Use when the user refers to something from before ("last time", "that client", "阿姨", "do you remember"), when a name, role or pronoun needs resolving, or when starting a task that may repeat past work, preferences, decisions or failures. Also use it before asking the user to repeat a stable preference.',
    avoidWhen:
      'Do NOT use it every turn, for facts the current conversation already states, or for anything a file tool can verify first (read_file / grep_text / glob_files). Do NOT use it to fish for general context: pass a concrete query. Do NOT invent memories: if the tool returns nothing, say you do not have that memory and ask.',
    examples: [
      'query: "上次登录超时" — find the past episode and whether the fix worked.',
      'query: "阿姨", kind: "relational" — resolve who that nickname refers to and the episode it is anchored to.',
      'query: "包管理器", kind: "knowledge" — check a stable constraint before choosing a command.',
      'query: "", kind: "episodic", limit: 5 — review the most important past tasks before starting similar work.',
    ],
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to recall. Prefer concrete names, people, files or task keywords; empty means "most important memories".' },
        kind: { type: 'string', enum: ['all', 'episodic', 'relational', 'knowledge'], description: 'Restrict to one memory kind, default all' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum hits, default 5' },
        include_archived: { type: 'boolean', description: 'Also search the forgotten/archive file, default true' },
        wake: { type: 'boolean', description: 'Wake matching archived memories back into active memory, default true' },
      },
      additionalProperties: false,
    },
    async run(ctx, args) {
      const kind = String(args.kind ?? 'all');
      const allowed = ['all', 'episodic', 'relational', 'knowledge'];
      const result = await ctx.recall({
        query: String(args.query ?? ''),
        kind: allowed.includes(kind) ? (kind as RecallArgs['kind']) : 'all',
        limit: Number(args.limit ?? 5),
        includeArchived: args.include_archived !== false,
        wake: args.wake !== false,
      });
      const mode = result.mode === 'hybrid' ? ' · 混合召回' : result.mode === 'keyword' ? ' · 关键词召回' : '';
      return {
        ok: true,
        summary: result.hits.length === 0 ? `长期记忆 · 没有命中` : `长期记忆 · ${result.hits.length} 条${result.woken.length ? ` · 唤醒 ${result.woken.length}` : ''}${mode}`,
        output: formatRecall(result),
      };
    },
  },
  {
    name: 'memory_write',
    risk: 'write',
    mutating: false,
    summary: 'Write one durable long-term memory: an episode, a reference, or a stable fact/constraint.',
    useWhen:
      'Use when a task or project is finished (success or failure) to record what happened and what it taught; when the user corrects how to refer to a person/thing; or when a durable fact or constraint becomes clear and is worth keeping across sessions. Importance is your judgement, 1–100.',
    avoidWhen:
      'Not for one-off instructions for this turn, not for what a workspace file already records, and not for every intermediate step — this turn\'s tool trace already logs the steps. Do not write the same memory twice.',
    examples: [
      'kind: "episodic", when: "2026-11-23 下午", where: "E:/code/xiaohei", detail: "重构记忆管理，新增长期/短期/工作三层", result: "typecheck、测试、构建均通过", outcome: "success", importance: 72 — record a finished task.',
      'kind: "relational", alias: "阿姨", referent: "妈妈的同学", relation: "长辈", detail: "那天打招呼、戴眼镜的卷发女士就是她", episode_id: "mem_xxx", importance: 65 — pin a reference to the episode that introduced it.',
      'kind: "knowledge", slot: "env.packageManager", detail: "这个工作区统一用 pnpm", scope: "workspace", importance: 85 — keep a stable constraint.',
    ],
    schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['episodic', 'relational', 'knowledge'], description: 'Memory kind' },
        importance: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Your judgement: 80+ long-lived constraints/identities, 50–79 ordinary completed work, 20–49 narrow useful details, 1–19 marginal.',
        },
        title: { type: 'string', description: 'Short title, e.g. "修复登录超时" or "阿姨 → 妈妈的同学"' },
        detail: {
          type: 'string',
          minLength: 1,
          maxLength: 4000,
          description:
            'episodic: what happened; relational: how you know who/what this refers to; knowledge: the fact/constraint/statement.',
        },
        when: { type: 'string', description: 'Episodic: when it happened, e.g. 2026-11-23 下午 or 上周三晚上' },
        where: { type: 'string', description: 'Episodic: where it happened, usually the workspace or file' },
        result: { type: 'string', description: 'Episodic: the outcome detail, including the failure reason when it failed' },
        outcome: { type: 'string', enum: ['success', 'failure', 'partial'], description: 'Episodic: did it work' },
        alias: { type: 'string', description: 'Relational: the name/nickname/pronoun used, e.g. 阿姨' },
        referent: { type: 'string', description: 'Relational: who or what it refers to, e.g. 妈妈的同学' },
        relation: { type: 'string', description: 'Relational: optional relation label, e.g. 长辈 / 同事 / 客户系统' },
        episode_id: { type: 'string', description: 'Relational: id of the episodic memory that introduced this reference, if any' },
        slot: { type: 'string', description: 'Knowledge: dotted slot for updates/conflicts, e.g. env.packageManager' },
        scope: { type: 'string', enum: ['workspace', 'global'], description: 'Knowledge: default workspace' },
        tags: {
          type: 'array',
          items: { type: 'string', minLength: 1 },
          maxItems: 8,
          description: 'Optional tags for recall',
        },
      },
      required: ['kind', 'importance', 'detail'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const kind = String(args.kind ?? '');
      if (kind !== 'episodic' && kind !== 'relational' && kind !== 'knowledge') {
        return domainFailure('kind 必须是 episodic / relational / knowledge', 'Pass one of the three memory kinds in `kind`.');
      }
      const detail = String(args.detail ?? '').trim();
      if (!detail) return domainFailure('detail 是空的', 'Describe what happened, who it refers to, or the fact itself in `detail`.');
      const importance = Number(args.importance);
      if (!Number.isFinite(importance) || importance < 1 || importance > 100) {
        return domainFailure('importance 必须是 1–100 的整数', 'Judge how durable this memory is: 80+ for long-lived constraints, 50–79 for ordinary completed work, 20–49 for narrow details.');
      }
      if (kind === 'episodic') {
        const missing = [
          !String(args.when ?? '').trim() ? 'when（何时）' : '',
          !String(args.where ?? '').trim() ? 'where（何地）' : '',
          !String(args.result ?? '').trim() ? 'result（结果）' : '',
          !['success', 'failure', 'partial'].includes(String(args.outcome ?? '')) ? 'outcome（success / failure / partial）' : '',
        ].filter(Boolean);
        if (missing.length > 0) {
          return domainFailure(
            `情景记忆缺少：${missing.join('、')}`,
            'An episodic memory is only useful with 何时 / 何地 / 结果 / 成败. Fill those fields; a failure is as valuable as a success because future you must not repeat it.',
          );
        }
      }
      if (kind === 'relational') {
        if (!String(args.alias ?? '').trim() || !String(args.referent ?? '').trim()) {
          return domainFailure(
            '关系记忆缺少 alias 或 referent',
            'A relational memory is a mapping: `alias` is what the user says ("阿姨"), `referent` is who it actually is ("妈妈的同学"). Add the episode_id when an episode introduced it.',
          );
        }
      }
      const scalar = (value: unknown): string | undefined => {
        const clean = typeof value === 'string' ? value.trim() : '';
        return clean ? clean : undefined;
      };
      const tags = Array.isArray(args.tags)
        ? args.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim().length > 0).slice(0, 8)
        : undefined;
      const result = await ctx.remember({
        kind,
        detail,
        importance: Math.round(importance),
        title: scalar(args.title),
        when: scalar(args.when),
        where: scalar(args.where),
        result: scalar(args.result),
        outcome: ['success', 'failure', 'partial'].includes(String(args.outcome)) ? (args.outcome as MemoryWriteArgs['outcome']) : undefined,
        alias: scalar(args.alias),
        referent: scalar(args.referent),
        relation: scalar(args.relation),
        episodeId: scalar(args.episode_id),
        slot: scalar(args.slot),
        scope: args.scope === 'global' ? 'global' : args.scope === 'workspace' ? 'workspace' : undefined,
        tags,
      });
      return { ok: true, summary: `memory · ${result.kind}`, output: result.note };
    },
  },
  {
    name: 'ask_user',
    risk: 'read',
    mutating: false,
    summary: 'Ask the user one focused question with 2–4 options; they can also type their own answer.',
    useWhen:
      'The request is ambiguous in a way that changes the work (which entity, which time window, which scope, which preference), and no tool can settle it.',
    avoidWhen:
      'A read_file, grep_text, glob_files or list_dir call can answer it — check first. Do not ask about trivial defaults you can state and proceed with.',
    schema: {
      type: 'object',
      properties: {
        header: { type: 'string', minLength: 1, maxLength: 16, description: 'Short label for the card, 2–8 chars, e.g. 选择范围' },
        question: { type: 'string', minLength: 1, description: 'One focused question, plain text, no markdown' },
        options: {
          type: 'array',
          items: { type: 'object' },
          description: '2–4 options as {label, description?}; label is the short answer sent back',
        },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const question = String(args.question ?? '').trim().slice(0, 500);
      if (!question) return domainFailure('question is empty', 'Pass one focused question in `question`.');
      const raw = Array.isArray(args.options) ? args.options : [];
      const options: QuestionOption[] = [];
      for (const entry of raw) {
        const value = typeof entry === 'string' ? { label: entry } : entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
        if (!value) continue;
        const label = String(value.label ?? '').trim().slice(0, 120);
        if (!label || options.some((option) => option.label === label)) continue;
        const description = String(value.description ?? '').trim().slice(0, 200);
        options.push({ label, ...(description ? { description } : {}) });
        if (options.length === 4) break;
      }
      if (options.length < 2) {
        return domainFailure(
          '需要 2–4 个选项',
          'Pass `options` as 2–4 {label, description?} objects. Labels are the short answers, e.g. "方案 A".',
        );
      }
      const header = String(args.header ?? '').trim().slice(0, 24) || '需要你确认';
      const answer = await ctx.ask({ header, question, options });
      if (answer.cancelled) {
        return { ok: false, layer: 'none', summary: '问题已取消', detail: '用户中止了本轮，问题没有回答。', hint: '', retryable: true };
      }
      return {
        ok: true,
        summary: `用户已回答 · ${answer.answer.slice(0, 60)}`,
        output: `用户回答：${answer.answer}`,
      };
    },
  },
];

export const toolByName = new Map(tools.map((tool) => [tool.name, tool]));

/** Shared confirmed-write path for tools whose content comes from a handle. */
async function commitText(
  ctx: ToolExecContext,
  name: string,
  target: string,
  content: string,
  reason: string,
): Promise<ToolOutcome> {
  const relative = rel(ctx, target);
  const prior = await readFile(target, 'utf8').catch(() => null);
  const change = prior === null ? null : countLineDiff(prior, content);
  const verdict = classifyWrite({
    path: relative,
    kind: prior === null ? 'create' : 'overwrite',
    addedLines: change?.additions ?? content.split(/\r?\n/).length,
    deletedLines: change?.deletions ?? 0,
    totalLinesBefore: prior ? prior.split(/\r?\n/).length : 0,
  });
  const decision = await ctx.approve({ name, command: relative, reason: `${verdict.reason} · ${reason}`, risk: 'write', tier: verdict.tier });
  if (decision === 'deny') {
    return domainFailure('写入未获批准', `The user declined writing \`${relative}\`. Do not retry the same write unchanged.`);
  }
  const committed = await ctx.commitFile(target, content, prior === null ? 'absent' : textFingerprint(prior));
  if (!committed.ok) {
    return domainFailure(
      committed.reason === 'busy' ? '工作区正忙，没有写入' : '文件在写入前被改过，没有写入',
      `${committed.detail} Re-read the file and decide again; do not overwrite with stale content.`,
    );
  }
  ctx.markTouched([relative]);
  return {
    ok: true,
    summary: `wrote ${relative} · ${content.split(/\r?\n/).length} lines · ${reason}`,
    output: `${relative} written (${content.length} chars)`,
    files: [relative],
  };
}

/** OpenAI-compatible tool definitions. */
export function toolSpecs(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
  return tools.map((tool) => {
    const examples = tool.examples?.length ? `\nExamples:\n${tool.examples.map((example) => `- ${example}`).join('\n')}` : '';
    return {
      type: 'function' as const,
      function: {
        name: tool.name,
        description: `${tool.summary}\nUse when: ${tool.useWhen}\nDo NOT use when: ${tool.avoidWhen}${examples}`,
        parameters: tool.schema,
      },
    };
  });
}

export function toolDescriptors(): Array<{ name: string; summary: string; risk: ToolRisk; useWhen: string; avoidWhen: string; examples?: string[] }> {
  return tools.map((tool) => ({
    name: tool.name,
    summary: tool.summary,
    risk: tool.risk,
    useWhen: tool.useWhen,
    avoidWhen: tool.avoidWhen,
    ...(tool.examples?.length ? { examples: tool.examples } : {}),
  }));
}
