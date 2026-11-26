import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlanStep } from '../shared/types.js';
import type { SessionEvent } from './runtime/events.js';

/**
 * Ground-truth audit.
 *
 * Progress the model reports is not evidence. These statements are derived from
 * what the ledger recorded and what exists on disk: successful write results,
 * paired calls, plans that claim work nothing touched.
 */

export interface AuditInput {
  plan: PlanStep[];
  events: readonly SessionEvent[];
}

export function audits(input: AuditInput): string[] {
  const lines: string[] = [];
  const events = input.events;
  const calls = new Map<string, Extract<SessionEvent, { type: 'tool_call' }>>();
  const results = new Map<string, Extract<SessionEvent, { type: 'tool_result' }>>();
  for (const event of events) {
    if (event.type === 'tool_call') calls.set(event.callId, event);
    else if (event.type === 'tool_result') results.set(event.callId, event);
  }

  const done = input.plan.filter((step) => step.status === 'done');
  const active = input.plan.filter((step) => step.status === 'active');
  const authored = [...calls.values()].filter((call) => ['write_file', 'edit_file'].includes(call.name));
  if (done.length > 0 && authored.length === 0 && active.length > 0) {
    lines.push(`plan claims ${done.length} finished steps but no write_file/edit_file call was recorded — suspicious`);
  }

  const writes = [...calls.values()].filter((call) => call.risk === 'write');
  const landed = writes.some((call) => results.get(call.callId)?.ok === true);
  if (writes.length > 0 && !landed) {
    lines.push('write calls were attempted but none returned a successful result');
  }

  const turns = new Set(events.filter((event) => event.type === 'turn_started').map((event) => event.turn));
  if (input.plan.length === 0 && turns.size > 1) {
    lines.push('no plan on record for a multi-turn task; write one with todo_write');
  }
  return lines;
}

export async function fileAudit(workspace: string, paths: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const path of paths) {
    try {
      await stat(join(workspace, path));
    } catch {
      missing.push(path);
    }
  }
  return missing;
}