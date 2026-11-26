import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Item, SnapshotMeta } from '../../shared/types.js';
import { estimateTokens, readJson } from '../util.js';
import { previewOf } from './blobs.js';
import type { SessionEventDraft } from './sessionlog.js';
import { sessionPaths, SessionLog } from './sessionlog.js';
import type { SessionIndex } from './sessionlog.js';

/**
 * One-way migration: `threads/<id>.json` → `session/<sid>/events.jsonl`.
 *
 * The old file stays where it is (so `storage.mode=legacy` can still read it and
 * a failed migration never destroys data); `meta.json` is written last and is
 * the commit marker. Re-running is a no-op once the marker exists, which makes
 * the boot path safe to retry.
 *
 * Large tool output and large tool arguments move into `blobs/` + `handles.jsonl`
 * exactly as they would have if the event had been written today.
 */

interface LegacyThread {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  steps?: number;
  totalTokens?: number;
  lastPrompt?: string;
  model?: string;
  status?: string;
  pinned?: boolean;
}

interface LegacyDoc {
  thread: LegacyThread;
  turn?: {
    id: string;
    index: number;
    prompt: string;
    status: string;
    startedAt: number;
    endedAt?: number;
    stopReason?: string;
    step?: number;
  } | null;
  items: Item[];
  state?: {
    plan?: Array<{ id: string; title: string; status: 'pending' | 'active' | 'done' | 'dropped' }>;
    contract?: {
      goal: string;
      acceptance: string[];
      nonGoals: string[];
      forbidden: string[];
      sourcePrompt?: string;
    } | null;
    resolution?: unknown;
  };
  snapshots?: SnapshotMeta[];
}

export interface MigrationReport {
  migrated: string[];
  skipped: number;
  failed: Array<{ sid: string; reason: string }>;
}

const FLUSH_EVERY = 200;

/** Migrate every legacy thread file that has no session yet. */
export async function migrateLegacyThreads(home: string): Promise<MigrationReport> {
  const report: MigrationReport = { migrated: [], skipped: 0, failed: [] };
  const dir = join(home, 'threads');
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const sid = file.replace(/\.json$/, '');
    const paths = sessionPaths(home, sid);
    const meta = await readJson<{ schema?: number; migratedAt?: number } | null>(paths.meta, null);
    if (meta?.schema === 2) {
      report.skipped += 1;
      continue;
    }
    const doc = await readJson<LegacyDoc | null>(join(dir, file), null);
    if (!doc || !doc.thread?.id) {
      report.skipped += 1;
      continue;
    }
    try {
      await importLegacyDoc(home, { ...doc, thread: { ...doc.thread, id: sid } });
      report.migrated.push(sid);
    } catch (error) {
      report.failed.push({ sid, reason: (error as Error).message });
    }
  }
  return report;
}

/** Import one legacy document (also used by demo seeding). */
export async function importLegacyDoc(home: string, doc: LegacyDoc): Promise<void> {
  await migrateDoc(home, doc);
}

async function migrateDoc(home: string, doc: LegacyDoc): Promise<void> {
  const thread = doc.thread;
  const log = await SessionLog.create(home, {
    sid: thread.id,
    workspace: thread.cwd ?? '',
    title: thread.title || 'New session',
    now: thread.createdAt ?? Date.now(),
  });

  const events: SessionEventDraft[] = [];
  const turnIds = new Map<string, number>();
  const order: string[] = [];
  for (const item of doc.items) {
    if (!turnIds.has(item.turnId)) {
      turnIds.set(item.turnId, order.length + 1);
      order.push(item.turnId);
    }
  }
  if (doc.turn && !turnIds.has(doc.turn.id)) {
    turnIds.set(doc.turn.id, order.length + 1);
    order.push(doc.turn.id);
  }

  const turnStatus = new Map<string, { status: string; endedAt?: number; stopReason?: string }>();
  if (doc.turn) {
    turnStatus.set(doc.turn.id, {
      status: doc.turn.status === 'running' ? 'interrupted' : doc.turn.status,
      endedAt: doc.turn.endedAt,
      stopReason: doc.turn.stopReason,
    });
  }

  let lastAssistantIndex = -1;
  for (const item of doc.items) {
    const turn = turnIds.get(item.turnId) ?? 1;
    const step = typeof (item as { step?: number }).step === 'number' ? (item as { step: number }).step : 0;
    const itemId = item.id;
    switch (item.kind) {
      case 'message': {
        if (item.role === 'user') {
          const attachments: Array<{ blob: string; bytes: number; tokens: number; handle: string; preview: string }> = [];
          for (const reference of item.references ?? []) {
            const put = await log.blobs.put(reference.content);
            const handle = await log.handles.create({
              text: reference.content,
              kind: 'attachment',
              turn,
              step,
              blob: put.blob,
              bytes: put.bytes,
              tokens: put.tokens,
            });
            attachments.push({
              blob: put.blob,
              bytes: put.bytes,
              tokens: put.tokens,
              handle: handle.handle,
              preview: reference.path,
            });
          }
          events.push({
            type: 'turn_started',
            turnId: item.turnId,
            userText: item.text,
            ...(attachments.length > 0 ? { attachments } : {}),
            turn,
            itemId,
          });
          lastAssistantIndex = -1;
        } else {
          events.push({
            type: 'assistant_message',
            text: item.text,
            ...(item.reasoning ? { reasoning: { text: item.reasoning.slice(0, 8000), tokens: estimateTokens(item.reasoning.slice(0, 8000)) } } : {}),
            turn,
            step,
            itemId,
          });
          lastAssistantIndex = events.length - 1;
        }
        break;
      }
      case 'reasoning': {
        // Attach to the adjacent assistant message when possible; reasoning is
        // replay context, not its own transcript row.
        const previous = lastAssistantIndex >= 0 ? events[lastAssistantIndex] : null;
        if (previous && previous.type === 'assistant_message' && !previous.reasoning) {
          previous.reasoning = { text: item.text, tokens: estimateTokens(item.text) };
        }
        break;
      }
      case 'tool_call': {
        const raw = JSON.stringify(item.args ?? {});
        const inline = estimateTokens(raw) <= 4000;
        let args: SessionEventDraft & { type: 'tool_call' };
        if (inline) {
          args = { type: 'tool_call', callId: item.callId, name: item.name, args: { text: raw, tokens: estimateTokens(raw) }, risk: item.risk, phase: 'started', summary: item.summary, turn, step, itemId };
        } else {
          const put = await log.blobs.put(raw);
          const handle = await log.handles.create({
            text: raw,
            kind: 'tool_args',
            turn,
            step,
            tool: item.name,
            callId: item.callId,
            blob: put.blob,
            bytes: put.bytes,
            tokens: put.tokens,
          });
          args = {
            type: 'tool_call',
            callId: item.callId,
            name: item.name,
            args: {
              digest: put.sha256,
              blob: put.blob,
              handle: handle.handle,
              bytes: put.bytes,
              tokens: put.tokens,
              preview: previewOf(raw),
            },
            risk: item.risk,
            phase: 'started',
            summary: item.summary,
            turn,
            step,
            itemId,
          };
        }
        const target = typeof item.args?.path === 'string' ? item.args.path : undefined;
        if (target) args = { ...args, target };
        events.push(args);
        break;
      }
      case 'tool_result': {
        const body = item.output || item.summary || '';
        const inline = estimateTokens(body) <= 4000;
        let content: { text: string; tokens: number } | { blob: string; bytes: number; tokens: number; handle: string; preview: string };
        if (inline) content = { text: body, tokens: estimateTokens(body) };
        else {
          const put = await log.blobs.put(body);
          const handle = await log.handles.create({
            text: body,
            kind: 'tool_result',
            turn,
            step,
            tool: item.name,
            callId: item.callId,
            blob: put.blob,
            bytes: put.bytes,
            tokens: put.tokens,
          });
          content = { blob: put.blob, bytes: put.bytes, tokens: put.tokens, handle: handle.handle, preview: previewOf(body) };
        }
        events.push({
          type: 'tool_result',
          callId: item.callId,
          name: item.name,
          ok: item.ok,
          content,
          phase: 'done',
          summary: item.summary,
          ...(item.files ? { files: item.files } : {}),
          layer: item.layer,
          ...(item.hint ? { hint: item.hint } : {}),
          retryable: item.retryable,
          ...(item.durationMs !== undefined ? { durationMs: item.durationMs } : {}),
          turn,
          step,
          itemId,
        });
        break;
      }
      case 'plan':
        events.push({ type: 'plan_updated', steps: item.steps, source: 'migrated', turn, step, itemId });
        break;
      case 'notice':
        events.push({ type: 'notice', tone: item.tone, title: item.title, body: item.body, turn, step, itemId });
        break;
      case 'approval':
        events.push({
          type: 'approval',
          callId: item.callId,
          name: item.name,
          command: item.command,
          reason: item.reason,
          ...(item.decision ? { decision: item.decision } : {}),
          turn,
          step,
          itemId,
        });
        break;
      case 'question':
        events.push({
          type: 'question',
          questionId: item.id,
          header: item.header,
          question: item.question,
          options: item.options,
          ...(item.answer ? { answer: item.answer } : {}),
          turn,
          step,
          itemId,
        });
        break;
      case 'checkpoint':
        events.push({
          type: 'checkpoint',
          snapshot: {
            id: item.snapshotId,
            step: item.step,
            label: item.label,
            at: item.at,
            files: item.filesTouched,
            additiveOnly: item.additiveOnly,
            sizeBytes: 0,
            ...(item.changeStats ? { changeStats: item.changeStats } : {}),
          },
          turn,
          step,
          itemId,
        });
        break;
      default:
        break;
    }
    if (events.length >= FLUSH_EVERY) {
      await log.appendMany(events.splice(0, events.length));
    }
  }

  // Close every migrated turn so nothing looks like it is still running.
  for (const [turnId, index] of turnIds) {
    const finished = events.some((event) => event.type === 'turn_finished' && event.turn === index);
    if (finished) continue;
    const status = turnStatus.get(turnId)?.status ?? 'completed';
    events.push({
      type: 'turn_finished',
      status: status === 'failed' ? 'failed' : status === 'cancelled' ? 'cancelled' : status === 'running' ? 'interrupted' : status === 'interrupted' ? 'interrupted' : 'completed',
      ...(turnStatus.get(turnId)?.stopReason ? { stopReason: turnStatus.get(turnId)?.stopReason } : {}),
      turn: index,
    });
  }

  const contract = doc.state?.contract;
  if (contract) {
    events.push({
      type: 'contract_set',
      contract: {
        goal: contract.goal,
        acceptance: contract.acceptance ?? [],
        nonGoals: contract.nonGoals ?? [],
        forbidden: contract.forbidden ?? [],
        sourcePrompt: contract.sourcePrompt ?? '',
        createdAt: thread.createdAt ?? Date.now(),
      },
      source: 'migrated',
      turn: 0,
    });
  }
  if (doc.state?.plan && doc.state.plan.length > 0) {
    events.push({ type: 'plan_updated', steps: doc.state.plan, source: 'migrated', turn: 0 });
  }
  if (doc.state?.resolution) {
    const resolution = doc.state.resolution as { entities?: unknown[]; times?: unknown[]; events?: unknown[] };
    events.push({
      type: 'resolution_updated',
      state: {
        entities: Array.isArray(resolution.entities) ? (resolution.entities as never[]) : [],
        times: Array.isArray(resolution.times) ? (resolution.times as never[]) : [],
        events: Array.isArray(resolution.events) ? (resolution.events as never[]) : [],
      },
      hash: 'migrated',
      source: 'migrated',
      turn: 0,
    });
  }
  if (events.length > 0) await log.appendMany(events);

  await log.patchMeta({
    migratedFrom: 'threads',
    migratedAt: Date.now(),
    turnCount: Math.max(thread.turnCount ?? 0, turnIds.size),
    steps: thread.steps ?? 0,
    totalTokens: thread.totalTokens ?? 0,
    lastPrompt: thread.lastPrompt ?? '',
    model: thread.model ?? '',
    status: 'idle',
  });
  await log.flush();
  await log.release();
}

/**
 * Seed `session/index.json` from the legacy `index.json` so the sidebar keeps
 * its order and its active session after the upgrade.
 */
export async function seedSessionIndex(home: string, index: SessionIndex): Promise<void> {
  if (index.order.length > 0) return;
  const legacy = await readJson<{ workspaceRoot?: string; activeThreadId?: string | null; threadOrder?: string[] } | null>(
    join(home, 'index.json'),
    null,
  );
  if (!legacy) return;
  if (legacy.workspaceRoot) index.workspaceRoot = legacy.workspaceRoot;
  const order = Array.isArray(legacy.threadOrder) ? legacy.threadOrder : [];
  for (const sid of order) {
    if (index.get(sid)) continue;
    const meta = await readJson<{ workspace?: string; title?: string; createdAt?: number; updatedAt?: number; turnCount?: number; status?: string } | null>(
      sessionPaths(home, sid).meta,
      null,
    );
    if (!meta) continue;
    index.upsert({
      sid,
      workspace: meta.workspace ?? '',
      title: meta.title ?? 'New session',
      createdAt: meta.createdAt ?? Date.now(),
      updatedAt: meta.updatedAt ?? Date.now(),
      turnCount: meta.turnCount ?? 0,
      status: 'idle',
    });
  }
  if (legacy.activeThreadId) index.setActive(legacy.activeThreadId);
  await index.save();
}

/** Legacy per-day token tallies, replayed into the usage ledger once. */
export async function migrateLegacyUsage(
  home: string,
  append: (workspace: string, dayKey: string, tokens: number) => Promise<void> | void,
): Promise<void> {
  const marker = join(home, 'usage', '.migrated');
  if (await stat(marker).then(() => true).catch(() => false)) return;
  const legacy = await readJson<{ workspaceTokenDays?: Record<string, Record<string, number>> } | null>(
    join(home, 'index.json'),
    null,
  );
  if (legacy?.workspaceTokenDays) {
    for (const [workspace, days] of Object.entries(legacy.workspaceTokenDays)) {
      for (const [dayKey, tokens] of Object.entries(days)) {
        if (tokens > 0) await append(workspace, dayKey, tokens);
      }
    }
  }
  const { ensureDir } = await import('../util.js');
  const { writeFile } = await import('node:fs/promises');
  await ensureDir(join(home, 'usage'));
  await writeFile(marker, String(Date.now()), 'utf8').catch(() => undefined);
}

/** Read a legacy thread JSON without importing the store (avoids a cycle). */
export async function readLegacyThread(home: string, sid: string): Promise<LegacyDoc | null> {
  return readJson<LegacyDoc | null>(join(home, 'threads', `${sid}.json`), null);
}

export async function legacyThreadIds(home: string): Promise<string[]> {
  const files = await readdir(join(home, 'threads')).catch(() => [] as string[]);
  return files.filter((file) => file.endsWith('.json')).map((file) => file.replace(/\.json$/, ''));
}

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}