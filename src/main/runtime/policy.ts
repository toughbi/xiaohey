/**
 * Command risk classification for the `auto` approval policy.
 *
 * `ask` never looks at this — it asks for everything. `full` never looks either.
 * The middle mode needs a deterministic, reviewable list instead of a guess: a
 * command that matches one of these patterns still asks, everything else runs.
 */

export interface RiskVerdict {
  risky: boolean;
  /** Short tag shown next to the approval reason, e.g. `删除文件`. */
  reason: string;
}

interface Rule {
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  { pattern: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+/i, reason: '递归删除' },
  { pattern: /\bdel\s+\/[sfq]/i, reason: '递归删除' },
  { pattern: /\brmdir\s+\/s/i, reason: '递归删除' },
  { pattern: /\bformat\s+[a-z]:/i, reason: '格式化磁盘' },
  { pattern: /\bgit\s+(push\s+--force|push\s+-f|reset\s+--hard|clean\s+-[a-z]*f)/i, reason: '改写 git 历史' },
  { pattern: /\b(truncate|drop\s+table|delete\s+from)\b/i, reason: '破坏数据' },
  { pattern: /\b(shutdown|restart-computer|taskkill|stop-process)\b/i, reason: '影响系统进程' },
  { pattern: /(curl|wget|iwr|irm)[^|]*\|\s*(sh|bash|powershell|pwsh|node)/i, reason: '下载后直接执行' },
  { pattern: /\b(npm|pnpm|yarn)\s+(i|install)\s+(-g|--global)/i, reason: '全局安装' },
  { pattern: /\b(pip|pip3)\s+install\b/i, reason: '安装依赖' },
  { pattern: /\b(winget|choco|scoop)\s+install\b/i, reason: '安装软件' },
  { pattern: /\b(npm|pnpm|yarn)\s+publish\b/i, reason: '发布包' },
  { pattern: /\b(reg\s+add|reg\s+delete|sc\s+(create|delete|config))\b/i, reason: '修改系统配置' },
  { pattern: /\bnet\s+(user|localgroup)\b/i, reason: '修改用户与权限' },
  { pattern: /(^|[\s;])>?\s*[a-z]:\\/i, reason: '写入工作区之外的路径' },
  { pattern: /\bsudo\b|\brunas\b/i, reason: '提权执行' },
];

export function classifyCommand(command: string): RiskVerdict {
  for (const rule of RULES) {
    if (rule.pattern.test(command)) return { risky: true, reason: rule.reason };
  }
  return { risky: false, reason: '' };
}

export interface ApprovalOutcome {
  /** True when the runtime must stop and wait for the user. */
  ask: boolean;
  /** Extra tag appended to the approval reason, empty when nothing was matched. */
  reason: string;
}

/**
 * The whole policy decision in one place, so the three modes can be tested
 * without a model: `ask` always stops, `full` never stops, `auto` stops only on
 * a matched risk pattern.
 */
export function autoDecision(policy: 'ask' | 'auto' | 'full', command: string): ApprovalOutcome {
  if (policy === 'full') return { ask: false, reason: '' };
  if (policy === 'ask') return { ask: true, reason: '' };
  const verdict = classifyCommand(command);
  return { ask: verdict.risky, reason: verdict.reason };
}
