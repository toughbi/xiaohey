import type { ChatMessage } from './llm.js';
import type { Contract } from './contract.js';
import type { ResolutionState } from './resolve.js';
import type { ContextGauge, Item } from '../../shared/types.js';
import { renderContract } from './contract.js';
import { renderResolution } from './resolve.js';
import { estimateTokens, truncate } from '../util.js';

/**
 * Context assembly and compaction.
 *
 * Four layers, because they decay at different rates and must be trusted
 * differently:
 *  1. the contract — verbatim original requirement, never summarized;
 *  2. externalized state — plan, resolution, verification — re-read from disk;
 *  3. working memory — the live task notebook, injected so a resumed session
 *     knows its next step without digging through the transcript;
 *  4. short-term memory — the summary plus the last rounds, assembled by
 *     `shortterm.ts`, never the raw unbounded transcript.
 *
 * Long-term memory is NOT injected: the model decides when to call `memory_read`.
 */

export interface ContextState {
  summary: string;
  foldedItems: number;
  compacted: number;
  tokensUsed: number;
  /**
   * True once a reasoning model answered in this thread. Thinking providers
   * require every assistant tool-call message to carry reasoning_content back
   * (even an empty string); plain providers must not receive the extra field.
   */
  thinking?: boolean;
}

export const emptyContext = (): ContextState => ({ summary: '', foldedItems: 0, compacted: 0, tokensUsed: 0, thinking: false });

export interface PromptInput {
  workspace: string;
  contract: Contract | null;
  plan: string;
  /** Task notebook rendered by working memory, injected on purpose. */
  working: string;
  /** One-line statistics about long-term memory; contents stay behind the tool. */
  memoryIndex: string;
  resolution: ResolutionState;
  verification: string;
  toolList: string;
  step: number;
  budget: number;
  compacted: boolean;
  /** Set while the turn runs in an isolated worktree; explains the merge-back. */
  isolationNote?: string;
}

export const SYSTEM_PROMPT = `You are xiaohey, a local coding agent running on the user's Windows desktop.

Operating rules:
- Work from evidence. Every factual claim about the workspace must come from a tool result in this conversation. If you have not checked, say so plainly and check.
- Keep the task contract in view. Re-read the goal, acceptance criteria, non-goals and forbidden actions before each milestone; never rely on your own earlier summary of them.
- Prefer the smallest tool that answers the question. Read before you write. Never retry a failed write unchanged.
- Keep the chrome quiet: short status lines, no filler, no exclamation marks, no emoji.
- When the user's request is ambiguous in a way that changes the work (which entity, which time window, which scope, which preference), call ask_user with one focused question and 2–4 concrete options instead of guessing. The user can always type a custom answer. Do not ask about anything a tool can verify yourself.
- Finish a step with something observable: a file written, a command exiting 0, a test passing. "Done" without proof is not done.
- When you stop calling tools and answer, open the final answer with a short overview of what was actually done this turn — files changed, commands run with their exit status, clarifications answered — then the details. Never claim work the tool results do not show, and say so plainly when nothing was changed.`;

export const MEMORY_POLICY = `Long-term memory is not pasted into this prompt. Decide for yourself when to read it:
- Call memory_read when the user refers to something from before ("上次", "那个客户", "阿姨", "还记得吗"), when a name/role/pronoun needs resolving, or when starting a task that may repeat past work, preferences or failures.
- Do NOT call it every turn, and do not call it for facts a file tool can verify first. Do not pretend to remember anything you have not read in this conversation or recalled through the tool.
- When a task or project is finished — success or failure — call memory_write with one episodic memory (when/where/what happened/result), plus a relational memory for any new reference, plus a knowledge memory for a durable fact or constraint. You choose importance 1–100: 80+ for long-lived constraints and identities, 50–79 for ordinary completed work, 20–49 for useful but narrow details.
- Write when the work is done, not after every step; working memory already records the steps.`;

export function buildSystemPrompt(input: PromptInput): string {
  const sections: string[] = [SYSTEM_PROMPT];
  const now = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  sections.push(
    `Workspace: ${input.workspace}\nLocal time: ${now.toLocaleString('sv-SE')} (${zone})\nStep: ${input.step} of this turn\nContext budget: ${input.budget} tokens`,
  );
  if (input.isolationNote) sections.push(input.isolationNote);

  if (input.contract) {
    sections.push(`## Task contract (verbatim, authoritative)\n${renderContract(input.contract)}`);
  }
  if (input.plan.trim()) {
    sections.push(`## Plan (externalized state, not a summary)\n${input.plan}`);
  }
  sections.push(`## Long-term memory\n${MEMORY_POLICY}${input.memoryIndex ? `\n\n${input.memoryIndex}` : ''}`);
  sections.push(`## Working memory (this session's progress — resume from here after an interruption)\n${input.working}`);
  sections.push(`## Resolved references\n${renderResolution(input.resolution)}`);
  if (input.verification.trim()) {
    sections.push(`## Verification from ground truth\n${input.verification}`);
  }
  sections.push(`## Tools (route with these rules)\n${input.toolList}`);

  if (input.compacted) {
    sections.push('Earlier rounds of this session were compressed into a summary; the summary is context, not proof. Re-read files before relying on details it does not spell out.');
  }
  return sections.join('\n\n');
}

/** Rebuild the model-visible transcript from items. */
export function toMessages(items: Item[], summary: string, thinking = false): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (summary) {
    messages.push({ role: 'assistant', content: `[Folded context from earlier turns]\n${summary}` });
  }

  const results = new Map<string, string>();
  for (const item of items) {
    if (item.kind === 'tool_result') {
      const body = item.ok ? item.output : `${item.summary}\n${item.hint ?? ''}\n${item.output}`;
      results.set(item.callId, body);
    }
  }

  for (const item of items) {
    switch (item.kind) {
      case 'message':
        if (item.role === 'user') {
          const references = item.references ?? [];
          const attached = references.length
            ? `\n\n<referenced-files>\n${references
                .map((reference) => `<file path="${reference.path}">\n${reference.content}\n</file>`)
                .join('\n')}\n</referenced-files>`
            : '';
          messages.push({ role: 'user', content: `${item.text}${attached}` });
        } else if (item.text.trim()) {
          messages.push({
            role: 'assistant',
            content: item.text,
            ...(thinking || item.reasoning ? { reasoning_content: item.reasoning ?? '' } : {}),
          });
        }
        break;
      case 'tool_call': {
        if (item.status === 'cancelled') break;
        const call: ChatMessage = {
          role: 'assistant',
          content: null,
          ...(thinking ? { reasoning_content: item.reasoning ?? '' } : item.reasoning ? { reasoning_content: item.reasoning } : {}),
          tool_calls: [
            {
              id: item.callId,
              type: 'function',
              function: { name: item.name, arguments: JSON.stringify(item.args) },
            },
          ],
        };
        messages.push(call);
        const result = results.get(item.callId);
        messages.push({
          role: 'tool',
          tool_call_id: item.callId,
          name: item.name,
          content: result ? truncate(result, 12_000) : '(no result: the call was interrupted)',
        });
        break;
      }
      default:
        break;
    }
  }
  return messages;
}

export function tokensOf(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    const toolPart = message.tool_calls?.reduce((sum, call) => sum + call.function.arguments.length, 0) ?? 0;
    return total + estimateTokens(message.content ?? '') + Math.ceil(toolPart / 3.6) + 6;
  }, 0);
}

export function gaugeOf(input: {
  messages: ChatMessage[];
  budget: number;
  compacted: number;
  memoryFacts: number;
  evidence: number;
  toolCalls: number;
}): ContextGauge {
  return {
    tokensUsed: tokensOf(input.messages),
    tokensBudget: input.budget,
    compacted: input.compacted,
    memoryFacts: input.memoryFacts,
    evidence: input.evidence,
    toolCalls: input.toolCalls,
  };
}

/**
 * Context budget for the short-term window.
 *
 * The window is shared by prompt, tools, history and completion, so the room
 * left for history is:
 *   window − output reserve − (system prompt + tool schemas) − safety margin.
 * The margin absorbs tokenizer drift, the unmeasured provider-side template and
 * one tool result that arrives after the check. `historyLimit` is therefore the
 * number the short-term memory is measured against.
 */
export interface ContextBudget {
  window: number;
  outputReserve: number;
  promptReserve: number;
  safetyMargin: number;
  historyLimit: number;
}

/** Conservative fallback when the provider does not publish a context size. */
export const DEFAULT_CONTEXT_WINDOW = 32_768;

export function contextBudget(input: {
  contextWindow: number;
  maxOutputTokens: number;
  promptTokens: number;
  toolTokens?: number;
}): ContextBudget {
  const window = input.contextWindow > 0 ? input.contextWindow : DEFAULT_CONTEXT_WINDOW;
  // Unknown output cap: reserve a conservative slice instead of the whole window.
  const outputReserve =
    input.maxOutputTokens > 0 ? input.maxOutputTokens : Math.min(8192, Math.max(1024, Math.round(window * 0.08)));
  const promptReserve = Math.max(0, Math.round(input.promptTokens + (input.toolTokens ?? 0)));
  const safetyMargin = Math.max(2048, Math.min(16_384, Math.round(window * 0.1)));
  const historyLimit = Math.max(2048, window - outputReserve - promptReserve - safetyMargin);
  return { window, outputReserve, promptReserve, safetyMargin, historyLimit };
}

/** Compress a little before the hard limit, because one tool result can be large. */
export const HISTORY_TRIGGER_RATIO = 0.85;

export function shouldCompressHistory(tokens: number, historyLimit: number): boolean {
  return tokens > historyLimit * HISTORY_TRIGGER_RATIO;
}

export const COMPACT_AT = 0.62;
export const KEEP_RECENT_ITEMS = 12;

export function shouldCompact(tokens: number, budget: number): boolean {
  return tokens > budget * COMPACT_AT;
}

/** Deterministic fallback when the summarizer call is unavailable. */
export function mechanicalSummary(items: Item[]): string {
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === 'message' && item.role === 'user') lines.push(`- asked: ${truncate(item.text, 160)}`);
    else if (item.kind === 'message' && item.role === 'assistant' && item.text.trim())
      lines.push(`- answered: ${truncate(item.text.replace(/\s+/g, ' '), 160)}`);
    else if (item.kind === 'tool_call') lines.push(`- called ${item.name}(${truncate(JSON.stringify(item.args), 90)})`);
    else if (item.kind === 'tool_result') lines.push(`  → ${item.ok ? 'ok' : 'failed'}: ${truncate(item.summary, 120)}`);
    else if (item.kind === 'checkpoint') lines.push(`- checkpoint step ${item.step}: ${item.label}`);
    else if (item.kind === 'compaction') lines.push(`- context compacted at step ${item.keptItems}`);
  }
  return lines.slice(-40).join('\n');
}

/**
 * Legacy item-based folding, kept for checkpoint/state compatibility and the
 * self-test. The model-visible history is assembled by `shortterm.ts`.
 */
export function foldItems(
  items: Item[],
  existingSummary: string,
  summarize: (folded: readonly Item[], previous: string) => string,
): { folded: number; summary: string } {
  if (items.length <= KEEP_RECENT_ITEMS) return { folded: 0, summary: existingSummary };
  const keep = items.slice(-KEEP_RECENT_ITEMS);
  const fold = items.slice(0, items.length - KEEP_RECENT_ITEMS);
  const summary = summarize(fold, existingSummary);
  void keep;
  return { folded: fold.length, summary };
}

export function planToText(steps: Array<{ title: string; status: string }>): string {
  if (steps.length === 0) return '';
  return steps.map((step) => `- [${step.status}] ${step.title}`).join('\n');
}

/** Evidence audit: paths the answer mentions that no tool actually read. */
export function auditClaims(text: string, evidence: string[]): string[] {
  const mentioned = [...text.matchAll(/[\w./\\-]+\.(?:tsx?|jsx?|css|json|md|py|rs|html)\b/g)].map((match) => match[0]);
  const known = new Set(evidence.map((entry) => entry.split(':').slice(1).join(':').replace(/\\/g, '/')));
  const missing = new Set<string>();
  for (const path of mentioned) {
    const normalized = path.replace(/\\/g, '/');
    const hit = [...known].some((entry) => entry.endsWith(normalized) || normalized.endsWith(entry));
    if (!hit) missing.add(path);
  }
  return [...missing].slice(0, 5);
}
