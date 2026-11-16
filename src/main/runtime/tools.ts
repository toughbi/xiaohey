import { exec } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type { ApprovalDecision, PlanStep, QuestionOption, ToolRisk } from '../../shared/types.js';
import type { MemoryScope } from './memory.js';
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
  approve: (request: { name: string; command: string; reason: string; risk: ToolRisk }) => Promise<ApprovalDecision>;
  /** Show a clarification card and resolve with the user's answer. */
  ask: (request: { header: string; question: string; options: QuestionOption[] }) => Promise<{ answer: string; cancelled: boolean }>;
  remember: (claim: { slot: string; value: string; scope: MemoryScope }) => Promise<{ kind: string; note: string }>;
  setPlan: (steps: PlanStep[]) => Promise<void>;
  markTouched: (files: string[]) => void;
  evidence: (tag: string) => void;
}

export interface ToolDefinition {
  name: string;
  risk: ToolRisk;
  mutating: boolean;
  summary: string;
  useWhen: string;
  avoidWhen: string;
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

const pathArg = { type: 'string' as const, description: 'Workspace-relative path, e.g. src/App.tsx' };

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
      try {
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, 'utf8');
      } catch (error) {
        return domainFailure('写入失败', '确认父目录存在；用 list_dir 核对路径后再试。', (error as Error).message);
      }
      const lines = content.split(/\r?\n/).length;
      ctx.markTouched([rel(ctx, target)]);
      return { ok: true, summary: `wrote ${rel(ctx, target)} · ${lines} lines`, output: `${rel(ctx, target)} written (${content.length} chars)`, files: [rel(ctx, target)] };
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
        find: { type: 'string', description: 'Exact text to replace, including indentation' },
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
      await writeFile(target, next, 'utf8');
      ctx.markTouched([rel(ctx, target)]);
      return {
        ok: true,
        summary: `edited ${rel(ctx, target)} · ${occurrences} replacement${occurrences === 1 ? '' : 's'}`,
        output: `${rel(ctx, target)} updated`,
        files: [rel(ctx, target)],
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
        command: { type: 'string', description: 'Command line, e.g. npm test' },
        purpose: { type: 'string', description: 'One line: what this command proves' },
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
          items: { type: 'object' },
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
    name: 'memory_write',
    risk: 'write',
    mutating: false,
    summary: 'Remember one durable fact about this user or workspace.',
    useWhen: 'The user states a stable preference, constraint or environment fact worth keeping across sessions.',
    avoidWhen: 'It is a one-off instruction for this turn, or it is already true in the workspace files.',
    schema: {
      type: 'object',
      properties: {
        slot: { type: 'string', description: 'Dotted slot, e.g. pref.comments or env.packageManager' },
        value: { type: 'string', description: 'The fact, in the user’s own words' },
        scope: { type: 'string', enum: ['workspace', 'global'], description: 'Default workspace' },
      },
      required: ['slot', 'value'],
      additionalProperties: false,
    },
    async run(ctx, args) {
      const scope: MemoryScope = String(args.scope ?? 'workspace') === 'global' ? { kind: 'global' } : { kind: 'workspace' };
      const result = await ctx.remember({ slot: String(args.slot), value: String(args.value), scope });
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
        header: { type: 'string', description: 'Short label for the card, 2–8 chars, e.g. 选择范围' },
        question: { type: 'string', description: 'One focused question, plain text, no markdown' },
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

/** OpenAI-compatible tool definitions. */
export function toolSpecs(): Array<{ type: 'function'; function: { name: string; description: string; parameters: unknown } }> {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: `${tool.summary}\nUse when: ${tool.useWhen}\nDo NOT use when: ${tool.avoidWhen}`,
      parameters: tool.schema,
    },
  }));
}

export function toolDescriptors(): Array<{ name: string; summary: string; risk: ToolRisk; useWhen: string; avoidWhen: string }> {
  return tools.map((tool) => ({ name: tool.name, summary: tool.summary, risk: tool.risk, useWhen: tool.useWhen, avoidWhen: tool.avoidWhen }));
}
