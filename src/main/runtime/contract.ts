/**
 * The task contract.
 *
 * Long tasks drift because four things decay: goal, state, acceptance and
 * scope. The contract freezes the first, third and fourth into a file the agent
 * re-reads verbatim at every milestone instead of trusting a decaying summary.
 */

export interface Contract {
  goal: string;
  acceptance: string[];
  nonGoals: string[];
  forbidden: string[];
  sourcePrompt: string;
  createdAt: number;
}

const ACCEPTANCE_HINTS =
  /(?:验收|acceptance|done when|complete when|done means|should (?:pass|return|show)|必须|要能|要求|通过)/i;
const NON_GOAL_HINTS = /(?:非目标|non-goal|不要做|不做|别改|out of scope|not needed|不用管)/i;
const FORBIDDEN_HINTS = /(?:禁止|不许|别碰|never touch|don't touch|forbidden|不要修改|不能改)/i;

function sentences(prompt: string): string[] {
  return prompt
    .split(/[\n。；;]+/)
    .map((line) => line.trim().replace(/^[-*]\s*/, ''))
    .filter((line) => line.length > 0 && line.length < 240);
}

/** Derive a contract from the first user message; explicit lines win over guessed ones. */
export function buildContract(prompt: string): Contract {
  const lines = sentences(prompt);
  const pick = (hint: RegExp): string[] => lines.filter((line) => hint.test(line)).slice(0, 6);

  const acceptance = pick(ACCEPTANCE_HINTS);
  const nonGoals = pick(NON_GOAL_HINTS);
  // A forbidden line like "禁止：改动 app/api/ 目录" carries the path after the
  // marker; keep that payload but drop the marker itself.
  const forbidden = pick(FORBIDDEN_HINTS)
    .map((line) => {
      const at = line.search(FORBIDDEN_HINTS);
      const tail = at >= 0 ? line.slice(at) : line;
      return tail.replace(/^(禁止|不许|别碰|forbidden|never touch|don'?t touch|不要修改|不能改)\s*[:：]?\s*/i, '').trim();
    })
    .filter((line) => line.length > 0 && line.length <= 120)
    .slice(0, 6);

  const goal = lines.find((line) => !NON_GOAL_HINTS.test(line))?.slice(0, 300) ?? prompt.slice(0, 300);

  return {
    goal,
    acceptance: acceptance.length > 0 ? acceptance : ['The requested behaviour is observable in the workspace', 'Existing checks still pass'],
    nonGoals,
    forbidden,
    sourcePrompt: prompt,
    createdAt: Date.now(),
  };
}

export function renderContract(contract: Contract): string {
  const list = (items: string[]): string => (items.length === 0 ? '  (none)' : items.map((i) => `  - ${i}`).join('\n'));
  return [
    `Goal: ${contract.goal}`,
    'Acceptance (the only truth — do not self-report success):',
    list(contract.acceptance),
    'Non-goals:',
    list(contract.nonGoals),
    'Forbidden actions:',
    list(contract.forbidden),
  ].join('\n');
}

export interface DriftVerdict {
  drift: boolean;
  reason: string;
  action: 'continue' | 'confirm' | 'refuse';
}

/**
 * Cheap deterministic scope guard, run before every write/exec tool. It only
 * reports what it can prove: a forbidden path or a destructive command.
 */
export function checkDrift(contract: Contract, call: { name: string; args: Record<string, unknown> }): DriftVerdict {
  const target = String(call.args.path ?? call.args.pattern ?? '');
  const command = String(call.args.command ?? '');
  const haystack = `${target}\n${command}`;

  for (const rule of contract.forbidden) {
    // A rule like "禁止：改动 app/api/ 目录" hides its path inside prose, so the
    // path-shaped tokens are what gets matched, not the sentence.
    const tokens = (rule.match(/[A-Za-z0-9_.\-/\\]{3,}/g) ?? []).filter((token) => /[/\\.]/.test(token));
    for (const token of tokens) {
      if (haystack.includes(token)) {
        return { drift: true, reason: `契约禁止：${rule}`, action: 'refuse' };
      }
    }
  }

  if (call.name === 'run_shell' && /(rm\s+-rf\s+\/|del\s+\/[sfq]\s+\*|format\s+[a-z]:|git\s+push\s+--force)/i.test(command)) {
    return { drift: true, reason: 'destructive command outside the task scope', action: 'confirm' };
  }

  return { drift: false, reason: 'inside scope', action: 'continue' };
}

/** Milestone re-read: every N steps the original prompt is injected verbatim. */
export const MILESTONE_EVERY = 4;
