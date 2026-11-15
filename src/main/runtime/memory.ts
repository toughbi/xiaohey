import { uid } from '../util.js';

export type MemoryScope =
  | { kind: 'global' }
  | { kind: 'workspace' }
  | { kind: 'path'; path: string };

export type MemoryStatus = 'active' | 'superseded' | 'disputed';

export interface MemoryRecord {
  id: string;
  /** Dotted slot, e.g. `pref.comments` or `env.python`. */
  slot: string;
  value: string;
  scopeKey: string;
  scope: MemoryScope;
  source: string;
  createdAt: number;
  updatedAt: number;
  status: MemoryStatus;
  supersededBy?: string;
  /** Records the competing claim when status is `disputed`. */
  conflictWith?: string;
}

export type ConflictKind = 'supersede' | 'contradict' | 'scope_diff' | 'distinct';

const NEGATION =
  /(^|[^a-z])(no|not|never|don't|dont|avoid|without|disable|off)([^a-z]|$)|不|别|勿|禁止|不要|无需|不用|关掉|禁用/i;

const NEGATION_EN =
  /\b(no|not|never|don't|dont|avoid|without|disable|disabled|off)\b|不|别|勿|禁止|不要|无需|不用|关掉|禁用/i;

export function scopeKeyOf(scope: MemoryScope): string {
  switch (scope.kind) {
    case 'global':
      return 'global';
    case 'workspace':
      return 'workspace';
    case 'path':
      return `path:${scope.path.replace(/\\/g, '/')}`;
  }
}

function polarity(value: string): 'positive' | 'negative' | 'unknown' {
  if (NEGATION_EN.test(value)) return 'negative';
  if (value.trim().length === 0) return 'unknown';
  return 'positive';
}

/**
 * The four cases from the memory-conflict note:
 * value updates, opposite polarity, scope differences, and merely similar
 * statements that are not conflicts at all. Similarity is deliberately not a
 * signal here.
 */
export function classify(existing: MemoryRecord, next: { slot: string; value: string; scope: MemoryScope }): ConflictKind {
  if (existing.slot !== next.slot) return 'distinct';
  const sameScope = existing.scopeKey === scopeKeyOf(next.scope);
  if (!sameScope) return 'scope_diff';
  if (existing.value.trim().toLowerCase() === next.value.trim().toLowerCase()) return 'distinct';
  const a = polarity(existing.value);
  const b = polarity(next.value);
  if (a !== 'unknown' && b !== 'unknown' && a !== b) return 'contradict';
  return 'supersede';
}

export interface MemoryApplyResult {
  records: MemoryRecord[];
  kind: ConflictKind;
  record: MemoryRecord;
  note: string;
}

/**
 * Apply one claim to the store. `supersede` retires the old value, `contradict`
 * keeps both but marks them disputed so the agent must ask instead of guessing,
 * and `scope_diff` keeps both scoped claims live.
 */
export function applyClaim(
  records: MemoryRecord[],
  claim: { slot: string; value: string; scope: MemoryScope; source: string },
  now = Date.now(),
): MemoryApplyResult {
  const scopeKey = scopeKeyOf(claim.scope);
  const sameSlot = records.filter((r) => r.slot === claim.slot);
  const scoped = sameSlot.filter((r) => r.scopeKey === scopeKey && r.status !== 'superseded');

  if (scoped.length === 0) {
    const record: MemoryRecord = {
      id: uid('mem'),
      slot: claim.slot,
      value: claim.value,
      scopeKey,
      scope: claim.scope,
      source: claim.source,
      createdAt: now,
      updatedAt: now,
      status: 'active',
    };
    // Same slot, different scope: a scoped rule that coexists with the others
    // rather than replacing them, which is only visible if we say so.
    const otherScopes = sameSlot.filter((entry) => entry.scopeKey !== scopeKey && entry.status !== 'superseded');
    const kind: ConflictKind = otherScopes.length > 0 ? 'scope_diff' : 'distinct';
    const note =
      kind === 'scope_diff'
        ? `Remembered ${claim.slot} for ${scopeKey}; the ${otherScopes[0].scopeKey} claim still stands in its own scope.`
        : `Remembered ${claim.slot}.`;
    return { records: [...records, record], kind, record, note };
  }

  const current = scoped[scoped.length - 1];
  const kind = classify(current, claim);

  if (kind === 'distinct') {
    return { records, kind, record: current, note: `${claim.slot} already holds this value.` };
  }

  if (kind === 'contradict') {
    const disputed: MemoryRecord = {
      ...current,
      id: uid('mem'),
      value: claim.value,
      status: 'disputed',
      conflictWith: current.id,
      updatedAt: now,
    };
    const marked: MemoryRecord = { ...current, status: 'disputed', conflictWith: disputed.id, updatedAt: now };
    return {
      records: [...records.filter((r) => r.id !== current.id), marked, disputed],
      kind,
      record: disputed,
      note: `${claim.slot} now has two opposite claims. Ask which one wins before relying on it.`,
    };
  }

  // supersede, or a scoped claim that had drifted into the same scope
  const replacement: MemoryRecord = {
    id: uid('mem'),
    slot: claim.slot,
    value: claim.value,
    scopeKey,
    scope: claim.scope,
    source: claim.source,
    createdAt: now,
    updatedAt: now,
    status: 'active',
  };
  const retired = records.map((r) =>
    r.id === current.id ? { ...r, status: 'superseded' as MemoryStatus, supersededBy: replacement.id, updatedAt: now } : r,
  );
  return {
    records: [...retired, replacement],
    kind,
    record: replacement,
    note: `${claim.slot}: ${current.value} → ${claim.value}.`,
  };
}

const SCOPE_LABEL: Record<string, string> = { global: 'global', workspace: 'workspace' };

export function renderMemory(records: MemoryRecord[], limit = 24): string {
  const active = records.filter((r) => r.status !== 'superseded').slice(-limit);
  if (active.length === 0) return '(empty)';
  return active
    .map((r) => {
      const scope = r.scope.kind === 'path' ? `path:${r.scope.path}` : SCOPE_LABEL[r.scope.kind];
      const flag = r.status === 'disputed' ? ' [DISPUTED — ask before using]' : '';
      return `- ${r.slot} = ${r.value} (${scope})${flag}`;
    })
    .join('\n');
}

export function activeFacts(records: MemoryRecord[]): MemoryRecord[] {
  return records.filter((r) => r.status !== 'superseded');
}

export { NEGATION };
