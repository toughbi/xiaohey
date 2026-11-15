import type { ErrorLayer } from '../../shared/types.js';
import { positiveExample, schemaSnippet, validate, type ToolSchema, type ValidationIssue } from './validate.js';

/**
 * Tool-argument failure taxonomy.
 *
 * L1 — the arguments never arrive as JSON. Deterministic repair, no model round trip.
 * L2 — JSON parses but the schema rejects it. Bounded retries, each one carrying
 *      new information (schema slice, offending field, expected value, one example).
 * L3 — the schema passes but the semantics are wrong. Domain hint with a next step;
 *      read-only calls may retry, writes never retry automatically.
 */

export interface ToolFailure {
  ok: false;
  layer: ErrorLayer;
  summary: string;
  detail: string;
  hint: string;
  retryable: boolean;
}

export interface ToolSuccess<T = unknown> {
  ok: true;
  summary: string;
  output: string;
  data?: T;
  files?: string[];
}

export type ToolOutcome<T = unknown> = ToolSuccess<T> | ToolFailure;

/** Heuristic JSON repair: code fences, smart quotes, trailing commas, single quotes. */
export function repairJson(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
  }
  text = text
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/^[^{[]*/, '');
  // A truncated object is the most common real failure; close what is open.
  const opens = (text.match(/{/g) ?? []).length;
  const closes = (text.match(/}/g) ?? []).length;
  if (opens > closes) text += '}'.repeat(opens - closes);
  return text;
}

export function parseArguments(name: string, raw: string): { ok: true; args: Record<string, unknown> } | ToolFailure {
  try {
    const parsed = JSON.parse(raw || '{}') as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {
        ok: false,
        layer: 'L1-parse',
        summary: 'arguments are not a JSON object',
        detail: `tool ${name} received ${typeof parsed}`,
        hint: 'Resend the call with a single JSON object of arguments.',
        retryable: true,
      };
    }
    return { ok: true, args: parsed as Record<string, unknown> };
  } catch (error) {
    const repaired = repairJson(raw);
    try {
      const parsed = JSON.parse(repaired) as Record<string, unknown>;
      return { ok: true, args: parsed };
    } catch {
      return {
        ok: false,
        layer: 'L1-parse',
        summary: 'arguments were not valid JSON',
        detail: `${(error as Error).message}; repair attempt also failed`,
        hint: 'Resend the call with valid JSON only — no prose, no code fences.',
        retryable: true,
      };
    }
  }
}

export function schemaFailure(name: string, schema: ToolSchema, issues: ValidationIssue[]): ToolFailure {
  const first = issues[0];
  return {
    ok: false,
    layer: 'L2-schema',
    summary: `${name}: ${issues.length} argument${issues.length === 1 ? '' : 's'} rejected`,
    detail: issues.map((i) => `${i.path}: expected ${i.expected}, got ${i.actual}`).join('; '),
    hint: [
      `Field \`${first.path}\` should be ${first.expected} but was ${first.actual}.`,
      'Valid arguments:',
      schemaSnippet(schema),
      `One valid example: ${positiveExample(schema)}`,
    ].join('\n'),
    retryable: true,
  };
}

export function domainFailure(summary: string, hint: string, detail = ''): ToolFailure {
  return { ok: false, layer: 'L3-domain', summary, detail, hint, retryable: false };
}

export function readDomainFailure(summary: string, hint: string, detail = ''): ToolFailure {
  return { ok: false, layer: 'L3-domain', summary, detail, hint, retryable: true };
}

export function transientFailure(error: unknown): ToolFailure {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    layer: 'transient',
    summary: 'transient failure',
    detail: message,
    hint: 'Retry with backoff; the environment, not the request, failed.',
    retryable: true,
  };
}

export interface RetryLedger {
  attempts: Map<string, number>;
}

export const RETRY_BUDGET = { schema: 2, transient: 3 } as const;

export function schemaRetriesLeft(ledger: RetryLedger, callId: string): number {
  const used = ledger.attempts.get(callId) ?? 0;
  return Math.max(0, RETRY_BUDGET.schema - used);
}

export function noteAttempt(ledger: RetryLedger, callId: string): number {
  const used = (ledger.attempts.get(callId) ?? 0) + 1;
  ledger.attempts.set(callId, used);
  return used;
}

export async function withBackoff<T>(run: (attempt: number) => Promise<T>, attempts = RETRY_BUDGET.transient): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
    }
  }
  throw lastError;
}

export function validateArgs(name: string, schema: ToolSchema, args: Record<string, unknown>): ToolFailure | null {
  const issues = validate(schema, args);
  return issues.length > 0 ? schemaFailure(name, schema, issues) : null;
}
