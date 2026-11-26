import type { ModelProfile, PlanStep } from '../../shared/types.js';
import { estimateTokens, truncate } from '../util.js';
import type { Contract } from './contract.js';
import type { ResolutionState } from './resolve.js';
import { buildSystemPrompt, contextBudget, promptParts, type ContextBudget } from './context.js';
import { Compressor, renderDigest } from './compressor.js';
import type { ChatMessage } from './llm.js';
import { oneLine } from './memmark.js';
import type { SessionEvent, TurnDigest } from './events.js';
import type { SessionLog } from './sessionlog.js';

/**
 * Context assembly: what the model sees at each step, and why it fits.
 *
 * Three layers, with different trust and decay:
 *  1. a fixed prefix — system, workspace, contract, plan, memory index, tools;
 *  2. history — at most eight completed turns, each at a display level L0–L3;
 *  3. the current turn — the live tool trace, verbatim where it matters.
 *
 * The prefix and the current user message are never rewritten inside a turn:
 * they are the part of the prompt a provider can cache, and the part the model
 * must not see drift. Only history ages, and aging is reversible — an L1 line
 * still names a handle, an L2 artifact still names its raw range, and the raw
 * events never leave the ledger.
 */

export const WINDOW_TURNS = 8;
export const HISTORY_RATIO = 0.5;
export const OBS_RATIO = 0.45;
export const HEADROOM_RATIO = 0.05;
export const L1_TRIGGER = 0.85;
export const L2_TRIGGER = 0.95;
export const EXPAND_BELOW = 0.6;
export const TOOL_RESULT_TOKENS = 4000;
export const TOOL_ARGS_TOKENS = 4000;
export const CURRENT_ARGS_TOKENS = 2000;
export const ASSISTANT_TOKENS = 2000;
export const KEEP_FULL_ARGS_STEPS = 2;
export const MIN_TOOL_PAIRS = 5;
/** Older turns beyond the window are represented by one pointer line each, up to this many. */
const MAX_POINTERS = 8;

export type Level = 0 | 1 | 2 | 3;

export interface AssembleInput {
  log: SessionLog;
  compressor: Compressor;
  model: ModelProfile;
  workspace: string;
  contract: Contract | null;
  plan: PlanStep[];
  resolution: ResolutionState;
  memoryIndex: string;
  verification: string;
  toolList: string;
  toolTokens: number;
  step: number;
  thinking: boolean;
  isolationNote?: string;
  /** Preference nudge to inject once at the tail of this step's messages. */
  nudge?: string;
}

export interface Assembly {
  system: string;
  messages: ChatMessage[];
  budget: ContextBudget;
  historyTokens: number;
  observationTokens: number;
  totalTokens: number;
  levels: Record<number, Level>;
  /** Ratio of the usable budget the assembled context consumes. */
  pressure: number;
  compacted: boolean;
  /** Prefix split, for the context breakdown in the composer. */
  parts: { system: number; memory: number; tools: number };
}

const briefTokens = (tokens: number): string => (tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens));

const textOf = (event: SessionEvent): string => {
  if (event.type === 'tool_result') return 'text' in event.content ? event.content.text : '';
  if (event.type === 'tool_call') return 'text' in event.args ? event.args.text : '';
  return '';
};

function resultLine(
  call: Extract<SessionEvent, { type: 'tool_call' }> | undefined,
  result: Extract<SessionEvent, { type: 'tool_result' }> | undefined,
  level: Level,
): string {
  const name = result?.name ?? call?.name ?? 'tool';
  const target = call?.target ?? '';
  const ok = result?.ok === true;
  const status = result ? (ok ? 'ok' : 'failed') : 'no result';
  const handle = result && 'blob' in result.content ? result.content.handle : '';
  const tokens = result ? (result.content.tokens ?? 0) : 0;
  const failure = result && !result.ok ? ` · ${oneLine(result.summary, 120)}` : '';
  if (level === 0) {
    return `- ${name}${target ? ` ${target}` : ''} · ${status} · ${briefTokens(tokens)} tokens${handle ? ` · ${handle}` : ''}${failure}`;
  }
  return `- ${name}${target ? ` ${target}` : ''} · ${status}${handle ? ` · ${handle}` : ''}${failure}`;
}

/** One completed turn at L0 / L1, as two messages (user request, assistant account). */
function historyTurn(
  turn: number,
  events: readonly SessionEvent[],
  level: 0 | 1,
): { messages: ChatMessage[]; tokens: number } {
  const started = events.find(
    (event): event is Extract<SessionEvent, { type: 'turn_started' }> => event.type === 'turn_started',
  );
  const finished = events.find(
    (event): event is Extract<SessionEvent, { type: 'turn_finished' }> => event.type === 'turn_finished',
  );
  const answers = events.filter(
    (event): event is Extract<SessionEvent, { type: 'assistant_message' }> => event.type === 'assistant_message',
  );
  const calls = new Map(
    events
      .filter((event): event is Extract<SessionEvent, { type: 'tool_call' }> => event.type === 'tool_call')
      .map((event) => [event.callId, event]),
  );
  const results = events.filter(
    (event): event is Extract<SessionEvent, { type: 'tool_result' }> => event.type === 'tool_result',
  );

  const userText = started?.userText ?? '';
  const finalText = answers.at(-1)?.text ?? '';
  const status = finished?.status ?? 'interrupted';
  const lines: string[] = [
    `[第 ${turn} 轮 · ${status}${level === 1 ? ' · L1' : ''}]`,
  ];
  if (results.length > 0 || calls.size > 0) {
    lines.push('[工具摘要]');
    for (const [callId, call] of calls) {
      lines.push(resultLine(call, results.find((result) => result.callId === callId), level));
    }
  }
  if (level === 0) {
    if (finalText.trim()) lines.push('', oneLine(finalText, 1200));
  } else {
    if (finalText.trim()) lines.push('', `${truncate(oneLine(finalText, 400), 400)}`);
    if (finalText.length > 400) lines.push(`(回答原文见第 ${turn} 轮记录，可用 turn_expand(${turn}) 取回)`);
  }
  const messages: ChatMessage[] = [];
  if (userText.trim()) messages.push({ role: 'user', content: userText });
  messages.push({ role: 'assistant', content: lines.join('\n') });
  const tokens = messages.reduce((sum, message) => sum + estimateTokens(message.content ?? '') + 6, 0);
  return { messages, tokens };
}

function pointerTurn(turn: number): ChatMessage {
  return {
    role: 'assistant',
    content: `[第 ${turn} 轮已压缩为指针；用 turn_expand(${turn}) 展开摘要，或 turn_expand(${turn}, "raw") 取回原文]`,
  };
}

/** The `turn_expand` / `session_search` result budget is enforced by the caller. */
function digestMessages(turn: number, digest: TurnDigest): { messages: ChatMessage[]; tokens: number } {
  const text = renderDigest(digest);
  const message: ChatMessage = { role: 'assistant', content: text };
  return { messages: [message], tokens: estimateTokens(text) + 6 };
}

interface CurrentStep {
  step: number;
  assistant?: Extract<SessionEvent, { type: 'assistant_message' }>;
  calls: Array<Extract<SessionEvent, { type: 'tool_call' }>>;
  results: Map<string, Extract<SessionEvent, { type: 'tool_result' }>>;
  notices: Extract<SessionEvent, { type: 'notice' }>[];
}

function groupSteps(events: readonly SessionEvent[]): CurrentStep[] {
  const steps = new Map<number, CurrentStep>();
  for (const event of events) {
    if (event.type === 'turn_started' || event.type === 'turn_finished' || event.type === 'turn_checkpoint') continue;
    const entry: CurrentStep = steps.get(event.step) ?? { step: event.step, calls: [], results: new Map(), notices: [] };
    steps.set(event.step, entry);
    if (event.type === 'assistant_message') entry.assistant = event;
    else if (event.type === 'tool_call') entry.calls.push(event);
    else if (event.type === 'tool_result') entry.results.set(event.callId, event);
    else if (event.type === 'notice') entry.notices.push(event);
  }
  return [...steps.values()].sort((a, b) => a.step - b.step);
}

export class Assembler {
  private readonly log: SessionLog;
  private readonly compressor: Compressor;

  constructor(input: { log: SessionLog; compressor: Compressor }) {
    this.log = input.log;
    this.compressor = input.compressor;
  }

  private async argsText(event: Extract<SessionEvent, { type: 'tool_call' }>, full: boolean): Promise<string> {
    if ('text' in event.args) return event.args.text || '{}';
    if (full) {
      const text = await this.log.blobs.get(event.args.blob).catch(() => '');
      if (text) return text;
    }
    return JSON.stringify({ elided: event.args.handle, digest: event.args.digest, preview: event.args.preview });
  }

  private async renderCurrentTurn(input: AssembleInput, obsBudget: number): Promise<{ messages: ChatMessage[]; tokens: number; elided: number }> {
    const turn = input.log.activeTurn;
    const events = this.log.eventsForTurn(turn);
    const started = events.find(
      (event): event is Extract<SessionEvent, { type: 'turn_started' }> => event.type === 'turn_started',
    );
    const steps = groupSteps(events);
    const messages: ChatMessage[] = [];
    let elided = 0;
    if (started) {
      const attachments = (started.attachments ?? [])
        .map((attachment) => `[附件 ${attachment.handle}: ${briefTokens(attachment.tokens)} tokens, ${attachment.bytes} bytes]`)
        .join('\n');
      messages.push({ role: 'user', content: attachments ? `${started.userText}\n\n${attachments}` : started.userText });
    }

    const stepTokens = (step: CurrentStep, mode: 'full' | 'elided'): number => {
      let total = estimateTokens(step.assistant?.text ?? '') + 8;
      for (const call of step.calls) {
        const args = 'text' in call.args ? call.args.text : call.args.preview;
        const result = step.results.get(call.callId);
        const body = result ? textOf(result) : '';
        total += estimateTokens(args) + estimateTokens(body) + 16;
      }
      return total;
    };

    const kept = new Set<number>();
    const newest = steps.slice(-MIN_TOOL_PAIRS).map((step) => step.step);
    for (const step of newest) kept.add(step);

    let used = messages.reduce((sum, message) => sum + estimateTokens(message.content ?? ''), 0);
    const fullCost = steps.reduce((sum, step) => sum + stepTokens(step, 'full'), 0);
    used += fullCost;
    // Oldest observations are elided first; the newest call/result pairs stay
    // verbatim so the model can act on what it just saw.
    const elide = new Set<number>();
    for (const step of steps) {
      if (used <= obsBudget) break;
      if (kept.has(step.step)) continue;
      elide.add(step.step);
      used -= stepTokens(step, 'full');
      used += stepTokens(step, 'elided');
      elided += 1;
    }

    const recentArgs = new Set(steps.slice(-KEEP_FULL_ARGS_STEPS).map((step) => step.step));
    for (const step of steps) {
      const assistant = step.assistant;
      if (assistant) {
        const long = estimateTokens(assistant.text) > ASSISTANT_TOKENS;
        const text = long && !assistant.final ? truncate(assistant.text, ASSISTANT_TOKENS * 4) : assistant.text;
        if (text.trim()) {
          messages.push({
            role: 'assistant',
            content: text,
            ...(input.thinking || assistant.reasoning ? { reasoning_content: assistant.reasoning && 'text' in assistant.reasoning ? assistant.reasoning.text : '' } : {}),
          });
        }
      }
      for (const call of step.calls) {
        const result = step.results.get(call.callId);
        const fullArgs = recentArgs.has(step.step) && !elide.has(step.step);
        const args = await this.argsText(call, fullArgs);
        const toolCall: NonNullable<ChatMessage['tool_calls']>[number] = {
          id: call.callId,
          type: 'function',
          function: { name: call.name, arguments: args },
        };
        messages.push({
          role: 'assistant',
          content: null,
          ...(input.thinking ? { reasoning_content: '' } : {}),
          tool_calls: [toolCall],
        });
        if (!result) {
          messages.push({
            role: 'tool',
            tool_call_id: call.callId,
            name: call.name,
            content: '(no result: the call was interrupted)',
          });
          continue;
        }
        const big = 'blob' in result.content;
        const wantElide = big || elide.has(step.step);
        if (wantElide && 'blob' in result.content) {
          const line = `[tool_result elided: ${result.name} · ${briefTokens(result.content.tokens)} tokens · handle=${result.content.handle}${
            result.ok ? '' : ` · FAILED: ${oneLine(result.summary, 160)}`
          }]${result.ok ? '' : `\n${truncate(result.hint ?? '', 400)}`}`;
          messages.push({ role: 'tool', tool_call_id: call.callId, name: call.name, content: line });
        } else {
          messages.push({
            role: 'tool',
            tool_call_id: call.callId,
            name: call.name,
            content: truncate(textOf(result), TOOL_RESULT_TOKENS * 4),
          });
        }
      }
      for (const notice of step.notices) {
        if (notice.tone === 'info') continue;
        messages.push({ role: 'system', content: `[runtime] ${notice.title}：${oneLine(notice.body, 300)}` });
      }
    }

    if (input.nudge) messages.push({ role: 'system', content: input.nudge });

    const tokens = messages.reduce((sum, message) => {
      const toolPart = message.tool_calls?.reduce((inner, call) => inner + call.function.arguments.length, 0) ?? 0;
      return sum + estimateTokens(message.content ?? '') + Math.ceil(toolPart / 3.6) + 6;
    }, 0);
    return { messages, tokens, elided };
  }

  /** Assemble one step. History level changes happen here and only here. */
  async assemble(input: AssembleInput): Promise<Assembly> {
    const provisional = buildSystemPrompt({
      workspace: input.workspace,
      contract: input.contract,
      plan: input.plan.map((step) => `- [${step.status}] ${step.title}`).join('\n'),
      memoryIndex: input.memoryIndex,
      resolution: input.resolution,
      verification: input.verification,
      toolList: input.toolList,
      step: input.step,
      budget: 0,
      compacted: false,
      ...(input.isolationNote ? { isolationNote: input.isolationNote } : {}),
    });
    const budget = contextBudget({
      contextWindow: input.model.contextWindow,
      maxOutputTokens: input.model.maxOutputTokens,
      promptTokens: estimateTokens(provisional) + 256,
      toolTokens: input.toolTokens,
    });
    const avail = budget.historyLimit;
    const historyBudget = Math.floor(avail * HISTORY_RATIO);
    const obsBudget = Math.floor(avail * OBS_RATIO);

    const turns = this.log.turnEntries().filter((entry) => entry.status !== 'running');
    const windowTurns = turns.slice(-WINDOW_TURNS);
    const older = turns.slice(0, Math.max(0, turns.length - WINDOW_TURNS));

    const manifest = await this.log.manifestFile();
    const levels: Record<number, Level> = {};
    const rendered = new Map<string, { messages: ChatMessage[]; tokens: number }>();
    const cacheKey = (turn: number, level: Level): string => `${turn}:${level}`;

    // Start from the sticky level recorded last turn, then raise only when the
    // budget demands it. Upgrading is allowed only once pressure is low.
    for (const entry of windowTurns) {
      const eventLevel = entry.level ?? 0;
      const stored = (manifest.levels[entry.turn] ?? eventLevel) as Level;
      levels[entry.turn] = stored;
    }

    const renderAt = async (turn: number, level: Level): Promise<{ messages: ChatMessage[]; tokens: number }> => {
      const events = this.log.eventsForTurn(turn);
      if (level === 0 || level === 1) return historyTurn(turn, events, level);
      if (level === 2) {
        const cached = await this.compressor.cached(turn);
        if (cached) return digestMessages(turn, cached);
        const result = await this.compressor.ensure(turn, { contextWindow: input.model.contextWindow });
        if (result) return digestMessages(turn, result.digest);
        return { messages: [pointerTurn(turn)], tokens: estimateTokens(pointerTurn(turn).content ?? '') };
      }
      return { messages: [pointerTurn(turn)], tokens: estimateTokens(pointerTurn(turn).content ?? '') };
    };

    const costOf = async (turn: number, level: Level): Promise<number> => {
      const key = cacheKey(turn, level);
      const cached = rendered.get(key);
      if (cached) return cached.tokens;
      const result = await renderAt(turn, level);
      rendered.set(key, result);
      return result.tokens;
    };

    let historyTokens = 0;
    for (const entry of windowTurns) historyTokens += await costOf(entry.turn, levels[entry.turn]);

    // Oldest first: raise its level until the window fits its share.
    for (const entry of windowTurns) {
      while (historyTokens > historyBudget && levels[entry.turn] < 3) {
        const before = historyTokens;
        levels[entry.turn] = (levels[entry.turn] + 1) as Level;
        historyTokens = historyTokens - before + (await costOf(entry.turn, levels[entry.turn]));
        if (historyTokens >= before) break;
      }
      if (historyTokens <= historyBudget) break;
    }
    const current = await this.renderCurrentTurn(input, obsBudget);
    const pressure = avail > 0 ? (historyTokens + current.tokens) / avail : 1;
    // Below the expansion threshold a cheaper level is safe again.
    if (pressure < EXPAND_BELOW) {
      for (const entry of windowTurns) {
        if (levels[entry.turn] === 0) continue;
        const upgraded: Level = 0;
        const candidateTokens = historyTokens - (await costOf(entry.turn, levels[entry.turn])) + (await costOf(entry.turn, upgraded));
        if (candidateTokens <= historyBudget * EXPAND_BELOW) {
          levels[entry.turn] = upgraded;
          historyTokens = candidateTokens;
        }
        if (historyTokens > historyBudget * EXPAND_BELOW) break;
      }
    }
    // 85% / 95% of the whole usable budget: batch L1, then L2 from raw events.
    if (pressure > L2_TRIGGER) {
      const compressible = windowTurns.filter((entry) => levels[entry.turn] < 2).slice(0, 3);
      for (const entry of compressible) {
        levels[entry.turn] = 2;
        const result = await renderAt(entry.turn, 2);
        rendered.set(cacheKey(entry.turn, 2), result);
      }
    } else if (pressure > L1_TRIGGER) {
      const batch = windowTurns.filter((entry) => levels[entry.turn] === 0).slice(0, 4);
      for (const entry of batch) levels[entry.turn] = 1;
    }

    const historyMessages: ChatMessage[] = [];
    for (const entry of older.slice(-MAX_POINTERS)) historyMessages.push(pointerTurn(entry.turn));
    if (older.length > MAX_POINTERS) {
      historyMessages.unshift({
        role: 'assistant',
        content: `[更早的 ${older.length - MAX_POINTERS} 轮不在窗口里；用 session_search 按关键词找回]`,
      });
    }
    for (const entry of windowTurns) {
      const level = levels[entry.turn];
      const result = rendered.get(cacheKey(entry.turn, level)) ?? (await renderAt(entry.turn, level));
      historyMessages.push(...result.messages);
    }
    // Levels are sticky across turns: writing them is what makes the badge in
    // the UI and the next turn's window agree. One write, only when changed.
    await this.log.setLevels(levels).catch(() => undefined);

    const messages = [...historyMessages, ...current.messages];

    const system = buildSystemPrompt({
      workspace: input.workspace,
      contract: input.contract,
      plan: input.plan.map((step) => `- [${step.status}] ${step.title}`).join('\n'),
      memoryIndex: input.memoryIndex,
      resolution: input.resolution,
      verification: input.verification,
      toolList: input.toolList,
      step: input.step,
      budget: budget.historyLimit,
      compacted: Object.values(levels).some((level) => level >= 2),
      ...(input.isolationNote ? { isolationNote: input.isolationNote } : {}),
    });

    return {
      system,
      messages,
      budget,
      historyTokens,
      observationTokens: current.tokens,
      totalTokens: historyTokens + current.tokens,
      levels,
      pressure: avail > 0 ? (historyTokens + current.tokens) / avail : 1,
      compacted: Object.values(levels).some((level) => level >= 2),
      parts: promptParts({
        system,
        memoryIndex: input.memoryIndex,
        toolList: input.toolList,
        toolTokens: input.toolTokens,
      }),
    };
  }
}