/**
 * Write-ahead intent journal.
 *
 * A step is read → compute → write. A crash after the write but before the
 * commit leaves the runtime unable to tell "not done" from "done". So each
 * mutating step writes `intent` first (with the before/after fingerprints and an
 * idempotency key), then executes, then writes `committed`. On restart every
 * orphaned `intent` is suspect and is reconciled against ground truth instead of
 * being retried blindly.
 */

export type JournalPhase = 'intent' | 'committed' | 'failed' | 'reconciled';

export interface JournalRecord {
  id: string;
  step: number;
  callId: string;
  tool: string;
  idempotencyKey: string;
  phase: JournalPhase;
  at: number;
  /** Fingerprint of each target before the call. */
  before: Record<string, string>;
  /** Fingerprint each target is expected to have afterwards. */
  after?: Record<string, string>;
  summary: string;
  note?: string;
}

export function intent(
  record: Omit<JournalRecord, 'id' | 'phase' | 'at'>,
  now = Date.now(),
): JournalRecord {
  return { ...record, id: `${record.idempotencyKey}:intent`, phase: 'intent', at: now };
}

export function committed(record: JournalRecord, after: Record<string, string>, summary: string, now = Date.now()): JournalRecord {
  return { ...record, id: `${record.idempotencyKey}:committed`, phase: 'committed', after, at: now, summary };
}

export function failed(record: JournalRecord, note: string, now = Date.now()): JournalRecord {
  return { ...record, id: `${record.idempotencyKey}:failed`, phase: 'failed', at: now, note };
}

export type ReconcileOutcome = 'applied' | 'not-applied' | 'unknown';

/**
 * Compare an orphaned intent with the current fingerprints of its targets.
 * `applied` means the write landed, `not-applied` means it never did, `unknown`
 * means something else touched the files and a human or the model must look.
 */
export function reconcile(record: JournalRecord, current: Record<string, string>): { outcome: ReconcileOutcome; detail: string } {
  const keys = Object.keys(record.before);
  if (keys.length === 0) return { outcome: 'unknown', detail: 'no fingerprint targets recorded' };

  if (record.after) {
    const matchesAfter = keys.every((k) => current[k] === record.after?.[k]);
    if (matchesAfter) return { outcome: 'applied', detail: 'targets match the expected post-write fingerprints' };
  }

  const matchesBefore = keys.every((k) => current[k] === record.before[k]);
  if (matchesBefore) return { outcome: 'not-applied', detail: 'targets are unchanged since the intent was written' };

  return { outcome: 'unknown', detail: 'targets changed in a way the journal cannot attribute; inspect before retrying' };
}

export function orphanIntents(records: JournalRecord[]): JournalRecord[] {
  const settled = new Set(
    records.filter((r) => r.phase !== 'intent').map((r) => r.idempotencyKey),
  );
  return records.filter((r) => r.phase === 'intent' && !settled.has(r.idempotencyKey));
}
