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

/**
 * File-write risk.
 *
 * A write is not one thing: creating a new note, replacing a 400-line file and
 * editing one identifier all hit `write_file`/`edit_file`, but they cost the user
 * very different things if they go wrong. The tier is what `auto` acts on and
 * what the approval card shows; `ask` ignores it and asks for everything.
 */
export type WriteTier = 'low' | 'medium' | 'high';

export interface WriteRiskInput {
  path: string;
  kind: 'create' | 'overwrite' | 'edit';
  addedLines?: number;
  deletedLines?: number;
  totalLinesBefore?: number;
}

export interface WriteRiskVerdict {
  tier: WriteTier;
  reason: string;
}

const SENSITIVE_PATH: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /(^|\/)\.env(\.|$)/i, label: '环境变量文件' },
  { pattern: /(^|\/)\.git\//i, label: 'git 内部文件' },
  { pattern: /(^|\/)\.ssh\//i, label: 'SSH 配置' },
  { pattern: /(^|\/)id_(rsa|ed25519|ecdsa)/i, label: '私钥' },
  { pattern: /\.(pem|key|pfx|p12|keystore)$/i, label: '证书或密钥' },
  { pattern: /(^|\/)(credentials|secrets?)(\.|$)/i, label: '凭据文件' },
  { pattern: /(^|\/)\.(npmrc|netrc|pypirc)$/i, label: '包管理器凭据' },
];

const EXECUTABLE_PATH = /\.(ps1|bat|cmd|sh|bash|exe|msi|dll)$/i;

/** Deleting this much of a file is a rewrite, not an edit. */
export const LARGE_DELETE_LINES = 40;
export const LARGE_DELETE_RATIO = 0.5;

export function classifyWrite(input: WriteRiskInput): WriteRiskVerdict {
  const path = input.path.replace(/\\/g, '/');
  const sensitive = SENSITIVE_PATH.find((rule) => rule.pattern.test(path));
  if (sensitive) return { tier: 'high', reason: `写入${sensitive.label}` };

  const deleted = Math.max(0, Math.round(input.deletedLines ?? 0));
  const before = Math.max(0, Math.round(input.totalLinesBefore ?? 0));
  const ratio = before > 0 ? deleted / before : 0;
  const destructive = deleted >= LARGE_DELETE_LINES || (deleted >= 10 && ratio >= LARGE_DELETE_RATIO);

  if (input.kind === 'overwrite') {
    if (destructive) return { tier: 'high', reason: `整体覆盖，会删掉 ${deleted} 行（原文件 ${before} 行）` };
    return { tier: 'medium', reason: '整体覆盖已有文件' };
  }
  if (input.kind === 'edit') {
    if (destructive) return { tier: 'high', reason: `改动会删掉 ${deleted} 行（原文件 ${before} 行）` };
    return { tier: 'low', reason: '局部替换' };
  }
  if (EXECUTABLE_PATH.test(path)) return { tier: 'medium', reason: '新建可执行脚本' };
  return { tier: 'low', reason: '新建文件' };
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

/**
 * File writes under the same three modes. `ask` stops for every write, `auto`
 * only when the tier is high (destructive overwrite, sensitive path), `full`
 * writes straight through. Low/medium tiers deliberately do not nag: a chat that
 * asks before every one-line edit gets turned off within a day.
 */
export function writeDecision(policy: 'ask' | 'auto' | 'full', tier: WriteTier): ApprovalOutcome {
  if (policy === 'full') return { ask: false, reason: '' };
  if (policy === 'ask') return { ask: true, reason: '' };
  return { ask: tier === 'high', reason: tier === 'high' ? '高风险写入' : '' };
}
