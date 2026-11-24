import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadDoc } from './store.js';
import type { ToolCallItem } from '../shared/types.js';
import type { WorkingTask } from './runtime/working.js';

/**
 * Ground-truth audit.
 *
 * The progress a model reports is not evidence. This module derives statements
 * from things that exist: runtime-written tool results, the working-memory
 * notebook, the checkpoints and the files themselves.
 */

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function audits(doc: ThreadDoc, task?: WorkingTask): string[] {
  const lines: string[] = [];

  const active = doc.state.plan.filter((step) => step.status === 'active');
  const done = doc.state.plan.filter((step) => step.status === 'done');
  const authored = doc.items.filter((item) => item.kind === 'tool_call' && item.name === 'write_file' || item.kind === 'tool_call' && item.name === 'edit_file');
  if (done.length > 0 && authored.length === 0 && active.length > 0) {
    lines.push(`plan claims ${done.length} finished steps but no write_file/edit_file call succeeded — suspicious`);
  }

  const writes = doc.items.filter((item): item is ToolCallItem => item.kind === 'tool_call' && item.risk === 'write');
  const writeIds = new Set(writes.map((item) => item.callId));
  const landed = doc.items.some((item) => item.kind === 'tool_result' && writeIds.has(item.callId) && item.ok);
  if (writes.length > 0 && !landed) {
    lines.push('write calls were attempted but none returned a successful result');
  }

  const open = (task?.steps ?? []).filter((step) => step.phase === 'executing');
  if (open.length > 0) {
    lines.push(`${open.length} write-ahead step${open.length === 1 ? '' : 's'} still marked executing — reconcile before claiming progress`);
  }

  if (doc.state.contract && doc.state.plan.length === 0 && doc.thread.turnCount > 1) {
    lines.push('no plan on record for a multi-turn task; write one with todo_write');
  }

  return lines;
}

export async function fileAudit(doc: ThreadDoc, paths: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (const path of paths) {
    if (!(await exists(join(doc.thread.cwd, path)))) missing.push(path);
  }
  return missing;
}
