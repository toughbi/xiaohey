import { createHash } from 'node:crypto';

/**
 * Secret redaction at the memory boundary.
 *
 * Long-term memory outlives the session it came from, so an API key in a tool
 * result must never be distilled into `memory.md`. The replacement keeps a
 * short hash so two mentions of the same secret still look like the same
 * secret, without being one.
 */

const PATTERNS: RegExp[] = [
  // Provider keys with recognisable prefixes.
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  // PEM private keys, wrapped across lines.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // `password: …`, `api_key = "…"`, `token=…`.
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd)\b\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}["']?/gi,
  // Bearer headers.
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

export const containsSecret = (text: string): boolean => {
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    const hit = pattern.test(text);
    pattern.lastIndex = 0;
    if (hit) return true;
  }
  return false;
};

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, (match) => `[redacted:${createHash('sha256').update(match).digest('hex').slice(0, 8)}]`);
  }
  return out;
}