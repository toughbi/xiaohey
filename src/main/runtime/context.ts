import type { ChatMessage } from './llm.js';
import type { Contract } from './contract.js';
import type { MemoryRecord } from './memory.js';
import type { ResolutionState } from './resolve.js';
import type { ContextGauge, Item } from '../../shared/types.js';
import { renderMemory } from './memory.js';
import { renderContract } from './contract.js';
import { renderResolution } from './resolve.js';
import { estimateTokens, truncate } from '../util.js';

/**
 * Context assembly and compaction.
 *
 * Three layers, because they decay at different rates and must be trusted
 * differently:
 *  1. the contract — verbatim original requirement, never summarized;
 *  2. externalized state — plan, memory, resolution, verification — re-read
 *     from disk each turn instead of recalled from the transcript;
 *  3. the transcript — compacted when it grows, folding the oldest items into a
 *     summary that keeps decisions and evidence rather than chatter.
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
  memory: MemoryRecord[];
  resolution: ResolutionState;
  plan: string;
  verification: string;
  toolList: string;
  step: number;
  budget: number;
  compacted: boolean;
}

export const SYSTEM_PROMPT = `You are xiaohey, a local coding agent running on the user's Windows desktop.

Operating rules:
- Work from evidence. Every factual claim about the workspace must come from a tool result in this conversation. If you have not checked, say so plainly and check.
- Keep the task contract in view. Re-read the goal, acceptance criteria, non-goals and forbidden actions before each milestone; never rely on your own earlier summary of them.
- Prefer the smallest tool that answers the question. Read before you write. Never retry a failed write unchanged.
- Keep the chrome quiet: short status lines, no filler, no exclamation marks, no emoji.
- When the user's request is ambiguous in a way that changes the work (which entity, which time window, which scope, which preference), call ask_user with one focused question and 2–4 concrete options instead of guessing. The user can always type a custom answer. Do not ask about anything a tool can verify yourself.
- Finish a step with something observable: a file written, a command exiting 0, a test passing. "Done" without proof is not done.`;

export function buildSystemPrompt(input: PromptInput): string {
  const sections: string[] = [SYSTEM_PROMPT];
  sections.push(`Workspace: ${input.workspace}\nStep: ${input.step} of this turn\nContext budget: ${input.budget} tokens`);

  if (input.contract) {
    sections.push(`## Task contract (verbatim, authoritative)\n${renderContract(input.contract)}`);
  }
  if (input.plan.trim()) {
    sections.push(`## Plan (externalized state, not a summary)\n${input.plan}`);
  }
  sections.push(`## Memory\n${renderMemory(input.memory)}`);
  sections.push(`## Resolved references\n${renderResolution(input.resolution)}`);
  if (input.verification.trim()) {
    sections.push(`## Verification from ground truth\n${input.verification}`);
  }
  sections.push(`## Tools (route with these rules)\n${input.toolList}`);

  if (input.compacted) {
    sections.push('Context was compacted earlier in this session; the folded summary is the first assistant message. Treat it as context, not as proof.');
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
  memory: MemoryRecord[];
  evidence: number;
  toolCalls: number;
}): ContextGauge {
  return {
    tokensUsed: tokensOf(input.messages),
    tokensBudget: input.budget,
    compacted: input.compacted,
    memoryFacts: input.memory.filter((fact) => fact.status !== 'superseded').length,
    evidence: input.evidence,
    toolCalls: input.toolCalls,
  };
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

export const SUMMARY_PROMPT = `Summarize the folded part of this agent session for your own future use.
Keep, in this order and no prose:
1. what the user actually asked for, in their words where possible
2. decisions made and facts verified, each with its evidence (file path or command)
3. what was tried and failed, with the reason
4. open questions and what the next step should be
Drop greetings, restated plans and anything already written to a file. Maximum 220 words.`;

/**
 * Compact: fold the oldest items into `summary` while keeping a recent window
 * intact, so the model still sees verbatim tool output for the current work.
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
