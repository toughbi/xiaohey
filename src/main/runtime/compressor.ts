import { createHash } from 'node:crypto';
import type { ModelProfile } from '../../shared/types.js';
import { estimateTokens, truncate } from '../util.js';
import type { SessionEvent, TurnDigest } from './events.js';
import { complete } from './llm.js';
import { oneLine } from './memmark.js';
import { extractConstraints } from './preferences.js';
import type { SessionLog } from './sessionlog.js';

/**
 * L2 turn compression.
 *
 * Input is always the turn's **raw events**, never an earlier summary, so a
 * summary can never drift into a summary of a summary. The artifact is a JSON
 * digest written under `turns/<n>.v<k>.json` with its provenance recorded in
 * `manifest.json`: which raw sequence range it came from, the hash of that
 * range, the model and the prompt version.
 *
 * Failure is not fatal: if the model cannot answer or answers garbage, a
 * deterministic digest is produced and marked `degraded`. Compression must never
 * be the reason a turn cannot be assembled.
 */

export const L2_TOKENS = 1200;
export const COMPRESS_PROMPT_VERSION = 3;
/** A single compression input may not eat more than this share of the window. */
const MAX_INPUT_RATIO = 0.6;

export const COMPRESS_PROMPT = `你在把 agent 的一轮对话压成结构化摘要，只输出一个 JSON 对象，不要解释、不要 markdown 代码块以外的文字。
输入是这一轮的原始事件（用户消息、工具调用、工具结果、最终回答）。要求：
- 只写事件里有的内容，不要补充推测。
- 保留迟到依赖：后面还可能被问到的细节（文件名、命令、参数、错误、决定）写进 keySteps / decisions / failures / filesChanged。
- 压缩结果控制在 1200 tokens 以内。
字段：
{
  "turn": 轮次号,
  "status": "completed|failed|cancelled|interrupted",
  "goal": "这一轮用户到底要什么，一句话",
  "userInput": "用户输入原文（可截断）",
  "finalAnswer": {"text": "最终回答 ≤600 tokens", "handle": "可选，回答过长时指向原文"},
  "keySteps": [{"tool": "工具名", "target": "目标", "why": "为什么做", "ok": true, "handle": "可选"}],
  "decisions": [{"decision": "决定了什么", "reason": "为什么", "evidence": ["h_…"]}],
  "constraints": ["用户明确表达的约束/偏好"],
  "openQuestions": ["还没解决、下一轮要接着看的问题"],
  "failures": [{"what": "失败的事", "resolution": "怎么处理的"}],
  "filesRead": ["读过的文件"],
  "filesChanged": ["改过的文件"],
  "deliverables": ["交付物"],
  "verification": ["能证明做成了的证据（命令退出码、测试结果）"],
  "next": "下一步该做什么",
  "interrupted": {"lastGoal": "…", "plan": "…", "done": "…", "next": "…"}  // 仅中断轮
}`;

export interface CompactResult {
  digest: TurnDigest;
  artifact: string;
  degraded: boolean;
  cached: boolean;
}

const textOf = (event: SessionEvent): string => {
  if (event.type === 'assistant_message') return event.text;
  if (event.type === 'tool_result') return 'text' in event.content ? event.content.text : event.content.preview;
  if (event.type === 'tool_call') return 'text' in event.args ? event.args.text : event.args.preview;
  return '';
};

export function fallbackDigest(turn: number, events: readonly SessionEvent[]): TurnDigest {
  const started = events.find(
    (event): event is Extract<SessionEvent, { type: 'turn_started' }> => event.type === 'turn_started',
  );
  const finished = events.find(
    (event): event is Extract<SessionEvent, { type: 'turn_finished' }> => event.type === 'turn_finished',
  );
  const calls = events.filter(
    (event): event is Extract<SessionEvent, { type: 'tool_call' }> => event.type === 'tool_call',
  );
  const results = new Map(
    events
      .filter((event): event is Extract<SessionEvent, { type: 'tool_result' }> => event.type === 'tool_result')
      .map((event) => [event.callId, event]),
  );
  const answers = events.filter(
    (event): event is Extract<SessionEvent, { type: 'assistant_message' }> => event.type === 'assistant_message',
  );
  const checkpoint = [...events]
    .reverse()
    .find((event): event is Extract<SessionEvent, { type: 'turn_checkpoint' }> => event.type === 'turn_checkpoint');
  const final = answers.at(-1);
  const userText = started?.userText ?? '';

  const filesRead = new Set<string>();
  const filesChanged = new Set<string>();
  const failures: TurnDigest['failures'] = [];
  const verification: string[] = [];
  const keySteps: TurnDigest['keySteps'] = [];

  for (const call of calls) {
    const result = results.get(call.callId);
    const ok = result?.ok ?? false;
    if (call.target) {
      if (call.risk === 'write') filesChanged.add(call.target);
      else if (call.name === 'read_file' || call.name === 'grep_text') filesRead.add(call.target);
    }
    for (const file of result?.files ?? []) filesChanged.add(file);
    if (result && !result.ok) failures.push({ what: `${call.name} failed: ${result.summary}`, resolution: result.hint ?? '' });
    if (result?.name === 'run_shell') verification.push(`${result.summary} (${result.ok ? 'green' : 'red'})`);
    keySteps.push({
      tool: call.name,
      ...(call.target ? { target: call.target } : {}),
      ok,
      ...('blob' in call.args ? { handle: call.args.handle } : {}),
    });
  }

  const status = finished?.status ?? 'interrupted';
  const digest: TurnDigest = {
    turn,
    status,
    goal: oneLine(userText, 200),
    userInput: truncate(userText, 4000),
    finalAnswer: { text: truncate(final?.text ?? '', 2000) },
    keySteps: keySteps.slice(-12),
    decisions: [],
    constraints: extractConstraints(userText),
    openQuestions: [],
    failures: failures.slice(0, 5),
    filesRead: [...filesRead].slice(0, 30),
    filesChanged: [...filesChanged].slice(0, 30),
    deliverables: [...filesChanged].slice(0, 30),
    verification: verification.slice(-2),
    next: checkpoint?.next ?? '',
  };
  if (status === 'interrupted' || !finished) {
    const lastCall = calls.at(-1);
    const lastResult = lastCall ? results.get(lastCall.callId) : undefined;
    digest.interrupted = {
      lastGoal: lastCall ? `${lastCall.name} ${lastCall.summary ?? ''}`.trim() : '本轮在产出最终回答前被中断',
      plan: checkpoint?.lastPlanLine ?? '',
      done: lastResult ? `${lastResult.name}: ${oneLine(lastResult.summary, 200)}` : '',
      next: checkpoint?.next ?? '先重读相关文件核实现状，再决定是否继续',
    };
  }
  return digest;
}

/** Render the digest for the model, compactly and deterministically. */
export function renderDigest(digest: TurnDigest): string {
  const lines: string[] = [
    `[第 ${digest.turn} 轮 · ${digest.status}]`,
    `目标：${digest.goal}`,
    `用户输入：${oneLine(digest.userInput, 300)}`,
    `关键步骤：${
      digest.keySteps.length > 0
        ? digest.keySteps
            .slice(0, 6)
            .map((step) => `${step.tool}${step.target ? ` ${step.target}` : ''}${step.ok ? '' : '(失败)'}${step.handle ? ` ${step.handle}` : ''}`)
            .join('；')
        : '无工具调用'
    }`,
  ];
  if (digest.constraints.length > 0) lines.push(`约束：${digest.constraints.slice(0, 6).join('；')}`);
  if (digest.filesChanged.length > 0) lines.push(`改动：${digest.filesChanged.slice(0, 8).join('、')}`);
  if (digest.failures.length > 0) {
    lines.push(`失败：${digest.failures.slice(0, 4).map((failure) => `${failure.what}${failure.resolution ? ` → ${failure.resolution}` : ''}`).join('；')}`);
  }
  if (digest.openQuestions.length > 0) lines.push(`未决：${digest.openQuestions.slice(0, 4).join('；')}`);
  if (digest.finalAnswer.text.trim()) lines.push(`最终回答：${oneLine(digest.finalAnswer.text, 600)}`);
  if (digest.next.trim()) lines.push(`下一步：${oneLine(digest.next, 200)}`);
  if (digest.interrupted) {
    lines.push(
      `中断·目标：${oneLine(digest.interrupted.lastGoal, 160)}`,
      `中断·已做：${oneLine(digest.interrupted.done, 160)}`,
      `中断·下一步：${oneLine(digest.interrupted.next, 160)}`,
    );
  }
  return lines.join('\n');
}

const asString = (value: unknown, max: number): string =>
  typeof value === 'string' ? truncate(value.trim(), max) : '';

const stringArray = (value: unknown, max: number, each = 300): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => oneLine(entry, each)).slice(0, max)
    : [];

/** Parse the model's digest, keeping only well-typed fields; null when useless. */
export function parseDigest(text: string, turn: number, base: TurnDigest): TurnDigest | null {
  const cleaned = text.replace(/```json|```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  if (typeof value.goal !== 'string' && typeof value.finalAnswer !== 'object') return null;

  const finalRaw = value.finalAnswer && typeof value.finalAnswer === 'object' ? (value.finalAnswer as Record<string, unknown>) : {};
  const digest: TurnDigest = {
    turn,
    status: ['completed', 'failed', 'cancelled', 'interrupted'].includes(String(value.status))
      ? (value.status as TurnDigest['status'])
      : base.status,
    goal: asString(value.goal, 300) || base.goal,
    userInput: asString(value.userInput, 4000) || base.userInput,
    finalAnswer: {
      text: asString(finalRaw.text, 2400) || base.finalAnswer.text,
      ...(asString(finalRaw.handle, 40) ? { handle: asString(finalRaw.handle, 40) } : base.finalAnswer.handle ? { handle: base.finalAnswer.handle } : {}),
    },
    keySteps: Array.isArray(value.keySteps)
      ? value.keySteps
          .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
          .slice(0, 10)
          .map((entry) => ({
            tool: asString(entry.tool, 60) || 'tool',
            ...(asString(entry.target, 200) ? { target: asString(entry.target, 200) } : {}),
            ...(asString(entry.why, 200) ? { why: asString(entry.why, 200) } : {}),
            ok: entry.ok !== false,
            ...(asString(entry.handle, 40) ? { handle: asString(entry.handle, 40) } : {}),
          }))
      : base.keySteps,
    decisions: Array.isArray(value.decisions)
      ? value.decisions
          .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
          .slice(0, 8)
          .map((entry) => ({
            decision: asString(entry.decision, 300),
            ...(asString(entry.reason, 300) ? { reason: asString(entry.reason, 300) } : {}),
            ...(stringArray(entry.evidence, 6, 40).length > 0 ? { evidence: stringArray(entry.evidence, 6, 40) } : {}),
          }))
          .filter((entry) => entry.decision.length > 0)
      : base.decisions,
    constraints: stringArray(value.constraints, 8).length > 0 ? stringArray(value.constraints, 8) : base.constraints,
    openQuestions: stringArray(value.openQuestions, 8),
    failures: Array.isArray(value.failures)
      ? value.failures
          .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
          .slice(0, 6)
          .map((entry) => ({ what: asString(entry.what, 300), ...(asString(entry.resolution, 300) ? { resolution: asString(entry.resolution, 300) } : {}) }))
          .filter((entry) => entry.what.length > 0)
      : base.failures,
    filesRead: stringArray(value.filesRead, 30, 200).length > 0 ? stringArray(value.filesRead, 30, 200) : base.filesRead,
    filesChanged: stringArray(value.filesChanged, 30, 200).length > 0 ? stringArray(value.filesChanged, 30, 200) : base.filesChanged,
    deliverables: stringArray(value.deliverables, 30, 200).length > 0 ? stringArray(value.deliverables, 30, 200) : base.deliverables,
    verification: stringArray(value.verification, 8),
    next: asString(value.next, 300) || base.next,
  };
  if (value.interrupted && typeof value.interrupted === 'object') {
    const interrupted = value.interrupted as Record<string, unknown>;
    digest.interrupted = {
      lastGoal: asString(interrupted.lastGoal, 300),
      plan: asString(interrupted.plan, 300),
      done: asString(interrupted.done, 300),
      next: asString(interrupted.next, 300),
    };
  } else if (base.interrupted) {
    digest.interrupted = base.interrupted;
  }
  return digest;
}

/** Hard cap: drop the least useful parts before truncating prose. */
export function capDigest(digest: TurnDigest): TurnDigest {
  const capped: TurnDigest = { ...digest };
  if (digest.finalAnswer.text.length > 2400) {
    capped.finalAnswer = { ...digest.finalAnswer, text: truncate(digest.finalAnswer.text, 2400) };
  }
  if (capped.userInput.length > 2000) capped.userInput = truncate(capped.userInput, 2000);
  if (estimateTokens(JSON.stringify(capped)) <= L2_TOKENS) return capped;
  capped.keySteps = capped.keySteps.slice(0, 5);
  capped.decisions = capped.decisions.slice(0, 5);
  capped.failures = capped.failures.slice(0, 3);
  capped.filesChanged = capped.filesChanged.slice(0, 10);
  capped.filesRead = capped.filesRead.slice(0, 10);
  if (estimateTokens(JSON.stringify(capped)) <= L2_TOKENS) return capped;
  capped.userInput = truncate(capped.userInput, 600);
  capped.finalAnswer = { text: truncate(capped.finalAnswer.text, 800), ...(digest.finalAnswer.handle ? { handle: digest.finalAnswer.handle } : {}) };
  capped.openQuestions = capped.openQuestions.slice(0, 3);
  capped.constraints = capped.constraints.slice(0, 4);
  return capped;
}

const hashOf = (value: string): string => createHash('sha1').update(value).digest('hex');

/** Raw-event transcript for the compression call, bounded like any other prompt. */
export function digestTranscript(events: readonly SessionEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    switch (event.type) {
      case 'turn_started':
        lines.push(`## 用户\n${event.userText}`);
        break;
      case 'assistant_message':
        if (event.text.trim()) lines.push(`## assistant\n${oneLine(event.text, 1200)}`);
        break;
      case 'tool_call': {
        const args = textOf(event);
        lines.push(`## 调用 ${event.name} ${event.summary ?? ''}\n${oneLine(args, 700)}`);
        break;
      }
      case 'tool_result':
        lines.push(`## 结果 ${event.name} ${event.ok ? 'ok' : 'FAILED'} ${event.summary}\n${oneLine(textOf(event), 1200)}`);
        break;
      case 'turn_checkpoint':
        lines.push(`## checkpoint\n目标：${oneLine(event.goal, 200)}${event.next ? `\n下一步：${oneLine(event.next, 200)}` : ''}`);
        break;
      case 'notice':
        lines.push(`## 提示 ${event.title}: ${oneLine(event.body, 300)}`);
        break;
      case 'turn_finished':
        lines.push(`## 轮次结束 ${event.status}`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n\n');
}

export class Compressor {
  private readonly inflight = new Map<number, Promise<CompactResult | null>>();

  constructor(
    private readonly log: SessionLog,
    private readonly model: () => ModelProfile | null,
    private readonly onUsage?: (input: number, output: number) => void,
  ) {}

  /** One compression per turn at a time; concurrent callers share the result. */
  ensure(turn: number, options: { contextWindow: number; force?: boolean } = { contextWindow: 32_768 }): Promise<CompactResult | null> {
    const running = this.inflight.get(turn);
    if (running) return running;
    const task = this.runEnsure(turn, options).finally(() => this.inflight.delete(turn));
    this.inflight.set(turn, task);
    return task;
  }

  /** Cached digest for a turn, when the artifact still matches its raw range. */
  async cached(turn: number): Promise<TurnDigest | null> {
    const manifest = await this.log.manifestFile();
    const artifact = manifest.artifacts[String(turn)];
    if (!artifact) return null;
    const events = this.log.eventsForTurn(turn);
    if (events.length === 0) return null;
    if (artifact.sourceHash !== hashOf(events.map((event) => JSON.stringify(event)).join('\n'))) return null;
    const json = await this.log.artifactJson(artifact.artifact);
    if (!json || typeof json !== 'object') return null;
    return json as TurnDigest;
  }

  /** Compress one turn, reusing the artifact when its raw range is unchanged. */
  private async runEnsure(turn: number, options: { contextWindow: number; force?: boolean } = { contextWindow: 32_768 }): Promise<CompactResult | null> {
    const events = this.log.eventsForTurn(turn);
    if (events.length === 0) return null;
    const sourceHash = hashOf(
      events.map((event) => JSON.stringify(event)).join('\n'),
    );
    const manifest = await this.log.manifestFile();
    const existing = manifest.artifacts[String(turn)];
    if (
      !options.force &&
      existing &&
      existing.sourceHash === sourceHash &&
      existing.promptVersion === COMPRESS_PROMPT_VERSION &&
      (await this.log.artifactJson(existing.artifact))
    ) {
      const json = (await this.log.artifactJson(existing.artifact)) as TurnDigest;
      return { digest: json, artifact: existing.artifact, degraded: existing.degraded, cached: true };
    }

    const base = fallbackDigest(turn, events);
    let digest = base;
    let degraded = true;
    let modelName = 'mechanical';
    const profile = this.model();
    if (profile) {
      const transcript = digTranscriptBounded(events, options.contextWindow);
      try {
        const response = await complete(
          { ...profile, temperature: 0 },
          [
            { role: 'system', content: COMPRESS_PROMPT },
            { role: 'user', content: `轮次：${turn}\n\n${transcript}` },
          ],
          { tools: [], retries: 1 },
        );
        this.onUsage?.(response.usage.promptTokens, response.usage.completionTokens);
        const parsed = parseDigest(response.content, turn, base);
        if (parsed) {
          digest = parsed;
          degraded = false;
          modelName = profile.model;
        }
      } catch {
        // Fall through to the deterministic digest; a failed call must not block assembly.
      }
    }
    const capped = capDigest(digest);
    const version = nextVersion(existing?.artifact ?? '');
    const artifact = `turns/${turn}.v${version}.json`;
    await this.log.recordCompact({
      turn,
      rawRange: [events[0].seq, events[events.length - 1].seq],
      sourceHash,
      artifact,
      model: modelName,
      promptVersion: COMPRESS_PROMPT_VERSION,
      degraded,
      digest: capped,
    });
    return { digest: capped, artifact, degraded, cached: false };
  }
}

function nextVersion(previous: string): number {
  const match = /\.v(\d+)\.json$/.exec(previous);
  return match ? Number(match[1]) + 1 : 1;
}

/** Trim the compression input to a share of the window (step digest, then cut). */
function digTranscriptBounded(events: readonly SessionEvent[], contextWindow: number): string {
  const limit = Math.max(2048, Math.round(contextWindow * MAX_INPUT_RATIO));
  let text = digestTranscript(events);
  if (estimateTokens(text) <= limit) return text;

  const reduced = events.map((event) => {
    if (event.type === 'tool_result') {
      const body = textOf(event);
      return { ...event, content: { text: oneLine(body, 400), tokens: estimateTokens(oneLine(body, 400)) } } as SessionEvent;
    }
    if (event.type === 'tool_call') {
      const body = textOf(event);
      return { ...event, args: { text: oneLine(body, 300), tokens: estimateTokens(oneLine(body, 300)) } } as SessionEvent;
    }
    return event;
  });
  text = digestTranscript(reduced);
  if (estimateTokens(text) <= limit) return text;

  // Still too large: keep the head and tail of the turn, which carry the goal
  // and the outcome, and drop the middle with an explicit marker.
  const head = reduced.slice(0, 6);
  const tail = reduced.slice(-10);
  const marker = `## (${reduced.length - head.length - tail.length} 条中间事件已省略)`;
  return [digestTranscript(head), marker, digestTranscript(tail)].join('\n\n');
}