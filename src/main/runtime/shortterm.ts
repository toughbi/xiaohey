import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir, estimateTokens, writeTextAtomic } from '../util.js';
import type { Item } from '../../shared/types.js';
import type { ChatMessage } from './llm.js';
import { sessionDir } from './memdir.js';
import { metaComment, oneLine, readMetaComments, stamp } from './memmark.js';

/**
 * Short-term memory: the conversation window the runtime actually sends.
 *
 * One file per session at `~/.xiaohei/session/<sessionid>.md`, holding the last
 * eight completed rounds verbatim plus a running summary of everything older.
 * At eight rounds (or the session-turn / token threshold) the oldest six are
 * folded into the summary and the newest two stay verbatim — the summary keeps
 * each round's background, decisions, result and next step, so the model loses
 * wording but not the thread.
 */

export interface RoundTool {
  name: string;
  summary: string;
  ok: boolean;
}

export type RoundOutcome = 'completed' | 'failed' | 'cancelled';

export interface RoundRecord {
  index: number;
  at: number;
  prompt: string;
  assistant: string;
  tools: RoundTool[];
  outcome: RoundOutcome;
  /** What this round left as the next step, when known. */
  next?: string;
}

export interface ShortTermState {
  threadId: string;
  title: string;
  workspace: string;
  updatedAt: number;
  totalTurns: number;
  compressed: number;
  summary: string;
  rounds: RoundRecord[];
}

export const COMPRESS_OLD = 6;
export const KEEP_RECENT = 2;
export const RETAIN_ROUNDS = COMPRESS_OLD + KEEP_RECENT;
export const SESSION_TURN_TRIGGER = 20;
export const MAX_SUMMARY_CHARS = 6000;

export const SHORT_TERM_SUMMARY_PROMPT = `你在压缩一次 agent 会话的短期记忆。对每一轮，保留且只保留：
1. 背景/目标：用户这一轮到底要什么，尽量保留原话中的关键名词
2. 关键步骤与决策：做过哪些判断和选择、为什么，带上工具/文件/命令证据
3. 结果：产出了什么、验证结果如何；成功和失败都要写
4. 下一步：这一轮结束时留下的计划或未完成事项
按轮次编号输出，不要寒暄，不要复述已经写进文件的内容。压缩后总长度不超过 500 字。`;

const asText = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Keep one pathological answer from dominating the file and the window. Six
 * thousand tokens leaves room for two verbatim rounds plus summary, prompt and
 * the output reserve even on a conservative 32k window.
 */
const clip = (text: string, maxTokens = 5000): string => {
  if (estimateTokens(text) <= maxTokens) return text;
  let end = Math.min(text.length, maxTokens * 3);
  while (end > 200 && estimateTokens(text.slice(0, end)) > maxTokens) end = Math.floor(end * 0.8);
  return `${text.slice(0, end)}\n…（已截断 ${text.length - end} 字，完整内容见会话记录）`;
};

function sanitizeTool(raw: unknown): RoundTool | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const name = asText(value.name).trim();
  if (!name) return null;
  return { name, summary: oneLine(asText(value.summary), 240), ok: value.ok !== false };
}

function sanitizeRound(raw: Record<string, unknown>): RoundRecord | null {
  const prompt = asText(raw.prompt).trim();
  const assistant = asText(raw.assistant).trim();
  if (!prompt && !assistant) return null;
  const tools = Array.isArray(raw.tools)
    ? raw.tools.map(sanitizeTool).filter((tool): tool is RoundTool => tool !== null).slice(0, 24)
    : [];
  const outcome: RoundOutcome =
    raw.outcome === 'failed' || raw.outcome === 'cancelled' || raw.outcome === 'completed' ? raw.outcome : 'completed';
  return {
    index: typeof raw.index === 'number' && raw.index > 0 ? Math.round(raw.index) : 1,
    at: typeof raw.at === 'number' ? raw.at : Date.now(),
    prompt,
    assistant,
    tools,
    outcome,
    ...(typeof raw.next === 'string' && raw.next.trim() ? { next: raw.next.trim() } : {}),
  };
}

/** Keep the newest sections when the running summary outgrows its cap. */
export function trimSummary(summary: string, max = MAX_SUMMARY_CHARS): string {
  if (summary.length <= max) return summary;
  const sections = summary.split(/\n(?=### 第 )/);
  while (sections.length > 1 && sections.join('\n').length > max) sections.shift();
  const joined = sections.join('\n');
  return joined.length <= max ? joined : joined.slice(joined.length - max);
}

export function mechanicalRoundSummary(rounds: readonly RoundRecord[]): string {
  return rounds
    .map((round) => {
      const goal = oneLine(round.prompt || '(no user text)', 160);
      const tools = round.tools.length > 0 ? round.tools.map((tool) => tool.name).join('、') : '无工具';
      const result = oneLine(round.assistant || round.tools.map((tool) => `${tool.name}:${tool.ok ? 'ok' : '失败'}`).join('；') || '无输出', 200);
      const next = round.next ? oneLine(round.next, 120) : round.outcome === 'completed' ? '无（该轮已完成）' : '先修复失败原因再继续';
      return `- 第 ${round.index} 轮（${stamp(round.at)}）：背景/目标「${goal}」；关键步骤与决策：${tools}；结果：${result}；下一步：${next}。`;
    })
    .join('\n');
}

function renderRound(round: RoundRecord): string {
  const lines: string[] = [
    `### 第 ${round.index} 轮 · ${stamp(round.at)} · ${round.outcome === 'completed' ? '完成' : round.outcome === 'cancelled' ? '已停止' : '失败'}`,
    metaComment('round', round),
    '',
    '**用户**',
    '',
    round.prompt || '(无)',
    '',
    '**助手**',
    '',
    round.assistant || '(无正文)',
  ];
  if (round.tools.length > 0) {
    lines.push('', '**工具步骤**', '');
    for (const tool of round.tools) {
      lines.push(`- ${tool.name} · ${tool.ok ? 'ok' : 'failed'} · ${oneLine(tool.summary, 200)}`);
    }
  }
  if (round.next) lines.push('', `**下一步**：${oneLine(round.next, 200)}`);
  return lines.join('\n');
}

export class ShortTermMemory {
  readonly file: string;
  private state: ShortTermState;
  private loaded = false;

  constructor(
    readonly root: string,
    readonly threadId: string,
    meta: { title?: string; workspace?: string } = {},
  ) {
    this.file = join(sessionDir(root), `${threadId}.md`);
    this.state = {
      threadId,
      title: meta.title ?? '',
      workspace: meta.workspace ?? '',
      updatedAt: Date.now(),
      totalTurns: 0,
      compressed: 0,
      summary: '',
      rounds: [],
    };
  }

  async load(meta?: { title?: string; workspace?: string; turnCount?: number }): Promise<void> {
    if (meta?.title) this.state.title = meta.title;
    if (meta?.workspace) this.state.workspace = meta.workspace;
    if (meta?.turnCount !== undefined) this.state.totalTurns = Math.max(this.state.totalTurns, meta.turnCount);
    if (this.loaded) return;
    const raw = await readFile(this.file, 'utf8').catch(() => '');
    if (raw) {
      const sessions = readMetaComments<Record<string, unknown>>(raw, 'session');
      const summaryMeta = readMetaComments<Record<string, unknown>>(raw, 'summary');
      const rounds = readMetaComments<Record<string, unknown>>(raw, 'round')
        .map(sanitizeRound)
        .filter((round): round is RoundRecord => round !== null);
      const session = sessions[0];
      if (session) {
        this.state = {
          threadId: asText(session.threadId) || this.threadId,
          title: asText(session.title) || this.state.title,
          workspace: asText(session.workspace) || this.state.workspace,
          updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
          totalTurns: typeof session.totalTurns === 'number' ? session.totalTurns : rounds.length,
          compressed: typeof session.compressed === 'number' ? session.compressed : 0,
          summary: typeof summaryMeta[0]?.text === 'string' ? String(summaryMeta[0].text) : '',
          rounds: rounds.sort((a, b) => a.index - b.index),
        };
        if (meta?.turnCount !== undefined) this.state.totalTurns = Math.max(this.state.totalTurns, meta.turnCount);
      } else {
        this.state.rounds = rounds.sort((a, b) => a.index - b.index);
        if (summaryMeta[0] && typeof summaryMeta[0].text === 'string') this.state.summary = summaryMeta[0].text;
      }
    }
    this.loaded = true;
  }

  /** Rebuild from the transcript when upgrading an existing install or after a revert. */
  seedFromItems(
    thread: { title: string; cwd: string; turnCount: number },
    items: readonly Item[],
    legacySummary = '',
    force = false,
  ): boolean {
    if (this.state.rounds.length > 0 && !force) return false;
    const groups = new Map<string, Item[]>();
    for (const item of items) {
      const list = groups.get(item.turnId);
      if (list) list.push(item);
      else groups.set(item.turnId, [item]);
    }
    const built: RoundRecord[] = [];
    for (const group of groups.values()) {
      const prompt = group.find((item) => item.kind === 'message' && item.role === 'user') as
        | { text?: string }
        | undefined;
      const answers = group.filter((item) => item.kind === 'message' && item.role === 'assistant' && item.text.trim());
      const last = answers.at(-1) as { text?: string } | undefined;
      const tools = group
        .filter((item) => item.kind === 'tool_result')
        .map((item) => {
          const result = item as { name?: string; summary?: string; ok?: boolean };
          return { name: result.name ?? 'tool', summary: result.summary ?? '', ok: result.ok !== false };
        });
      const promptText = prompt?.text?.trim() ?? '';
      const answerText = last?.text?.trim() ?? '';
      if (!promptText && !answerText) continue;
      built.push({
        index: built.length + 1,
        at: group[0]?.at ?? Date.now(),
        prompt: clip(promptText),
        assistant: clip(answerText),
        tools,
        outcome: answerText ? 'completed' : 'failed',
      });
    }
    const start = Math.max(1, (thread.turnCount || built.length) - built.length + 1);
    const rounds = built.slice(-RETAIN_ROUNDS).map((round, index) => ({ ...round, index: start + index }));
    this.state = {
      threadId: this.threadId,
      title: thread.title,
      workspace: thread.cwd,
      updatedAt: Date.now(),
      totalTurns: Math.max(thread.turnCount, rounds.at(-1)?.index ?? 0),
      // A forced rebuild (checkpoint revert) must not keep the summary of rounds
      // that no longer exist in the restored transcript.
      compressed: force ? (legacySummary ? this.state.compressed : 0) : this.state.compressed,
      summary: force ? legacySummary : legacySummary || this.state.summary,
      rounds,
    };
    this.loaded = true;
    return rounds.length > 0 || !!legacySummary;
  }

  get summary(): string {
    return this.state.summary;
  }

  get rounds(): RoundRecord[] {
    return [...this.state.rounds];
  }

  get compressed(): number {
    return this.state.compressed;
  }

  get totalTurns(): number {
    return this.state.totalTurns;
  }

  get title(): string {
    return this.state.title;
  }

  hasContent(): boolean {
    return this.state.rounds.length > 0 || this.state.summary.trim().length > 0;
  }

  recordRound(round: Omit<RoundRecord, 'index'> & { index: number }, totalTurns: number): void {
    // A resumed turn must replace its slot, never appear twice in the window.
    this.state.rounds = this.state.rounds.filter((existing) => existing.index !== round.index);
    this.state.rounds.push({ ...round, prompt: clip(round.prompt.trim()), assistant: clip(round.assistant.trim()) });
    this.state.rounds.sort((a, b) => a.index - b.index);
    this.state.totalTurns = Math.max(this.state.totalTurns, totalTurns, round.index);
    this.state.updatedAt = Date.now();
  }

  /** Trigger for the explicit 20-round session threshold (and the 8-round window). */
  shouldCompressByCount(currentTurns = this.state.totalTurns): boolean {
    const turns = Math.max(this.state.totalTurns, currentTurns);
    return this.state.rounds.length >= RETAIN_ROUNDS || (turns >= SESSION_TURN_TRIGGER && this.state.rounds.length > KEEP_RECENT);
  }

  messages(thinking = false): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (this.state.summary.trim()) {
      messages.push({
        role: 'assistant',
        content: `[Folded context from earlier rounds]\n${this.state.summary}`,
        ...(thinking ? { reasoning_content: '' } : {}),
      });
    }
    for (const round of this.state.rounds) {
      if (round.prompt.trim()) messages.push({ role: 'user', content: round.prompt });
      if (round.tools.length > 0) {
        const trace = round.tools.map((tool) => `- ${tool.name} · ${tool.ok ? 'ok' : 'failed'} · ${oneLine(tool.summary, 160)}`).join('\n');
        messages.push({
          role: 'assistant',
          content: `[tool trace of round ${round.index}]\n${trace}`,
          ...(thinking ? { reasoning_content: '' } : {}),
        });
      }
      if (round.assistant.trim()) {
        messages.push({
          role: 'assistant',
          content: round.assistant,
          ...(thinking ? { reasoning_content: '' } : {}),
        });
      }
    }
    return messages;
  }

  /**
   * Fold the older rounds into the summary and keep exactly the newest two
   * verbatim. With the normal eight-round window that is the documented "old
   * six"; if a delayed compression left extra rounds, fold those too rather
   * than letting the window grow past the promise.
   */
  async compress(
    summarize: (folded: readonly RoundRecord[], previousSummary: string) => Promise<string>,
  ): Promise<{ folded: number; from: number; to: number; kept: number; summary: string } | null> {
    const count = Math.max(0, this.state.rounds.length - KEEP_RECENT);
    if (count <= 0) return null;
    const folded = this.state.rounds.slice(0, count);
    const kept = this.state.rounds.slice(count);
    const previous = this.state.summary;
    let body: string;
    try {
      body = (await summarize(folded, previous)).trim();
      if (!body) body = mechanicalRoundSummary(folded);
    } catch {
      body = mechanicalRoundSummary(folded);
    }
    const from = folded[0].index;
    const to = folded[folded.length - 1].index;
    const section = `### 第 ${from}–${to} 轮\n${body}`;
    this.state.summary = trimSummary(previous ? `${previous}\n\n${section}` : section);
    this.state.rounds = kept;
    this.state.compressed += 1;
    this.state.updatedAt = Date.now();
    return { folded: count, from, to, kept: kept.length, summary: this.state.summary };
  }

  async save(): Promise<void> {
    this.state.updatedAt = Date.now();
    await ensureDir(sessionDir(this.root));
    const session = {
      threadId: this.state.threadId,
      title: this.state.title,
      workspace: this.state.workspace,
      updatedAt: this.state.updatedAt,
      totalTurns: this.state.totalTurns,
      compressed: this.state.compressed,
    };
    const lines: string[] = [
      `# 短期记忆 · ${oneLine(this.state.title || this.state.threadId, 80)}`,
      metaComment('session', session),
      '',
      `- 会话：${this.state.threadId}`,
      `- 工作区：${this.state.workspace || '(未设置)'}`,
      `- 最近更新：${stamp(this.state.updatedAt)}`,
      `- 轮次：${this.state.totalTurns}（已压缩 ${this.state.compressed} 次，保留最近 ${this.state.rounds.length} 轮原文）`,
      '',
      '## 历史摘要',
      '',
      metaComment('summary', { text: this.state.summary, compressed: this.state.compressed, updatedAt: this.state.updatedAt }),
      '',
      this.state.summary || '（还没有压缩过）',
      '',
      '## 最近对话',
      '',
      this.state.rounds.length > 0 ? this.state.rounds.map(renderRound).join('\n\n') : '（还没有完成的轮次）',
      '',
    ];
    await writeTextAtomic(this.file, lines.join('\n'));
  }

  /** Session deletion removes its short-term file; long-term memory is global. */
  async deleteFile(): Promise<void> {
    await rm(this.file, { force: true });
  }
}
