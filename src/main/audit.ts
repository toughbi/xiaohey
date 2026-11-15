import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ThreadDoc } from './store.js';

/**
 * Ground-truth audit.
 *
 * The progress a model reports is not evidence. This module derives statements
 * from things that exist: the journal, the checkpoints and the files themselves.
 */

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function audits(doc: ThreadDoc): string[] {
  const lines: string[] = [];

  const active = doc.state.plan.filter((step) => step.status === 'active');
  const done = doc.state.plan.filter((step) => step.status === 'done');
  const authored = doc.items.filter((item) => item.kind === 'tool_call' && item.name === 'write_file' || item.kind === 'tool_call' && item.name === 'edit_file');
  if (done.length > 0 && authored.length === 0 && active.length > 0) {
    lines.push(`plan claims ${done.length} finished steps but no write_file/edit_file call succeeded — suspicious`);
  }

  const commits = doc.state.journal.filter((record) => record.phase === 'committed' && record.summary !== 'requested');
  const writes = doc.items.filter((item) => item.kind === 'tool_call' && item.risk === 'write');
  if (writes.length > 0 && commits.length === 0) {
    lines.push('write calls were attempted but the journal holds no committed step');
  }

  const open = doc.state.journal.filter((record) => record.phase === 'intent');
  if (open.length > 0) {
    lines.push(`${open.length} journal intent${open.length === 1 ? '' : 's'} without a commit — reconcile before claiming progress`);
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
