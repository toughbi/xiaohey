import { readJson, writeJsonAtomic } from '../util.js';
import { sleep } from '../util.js';

/**
 * Per-resource leases for the mutating tools.
 *
 * Two mechanisms, because they answer different questions:
 *  - the lease (with a TTL) answers "what if the holder crashed?" — an expired
 *    lease is broken automatically instead of wedging the workspace forever;
 *  - the fingerprint taken at acquisition answers "what did the dead holder
 *    actually do?" — a takeover is only safe once the target is re-read.
 *
 * Idempotency keys live on the tool call itself (see runtime/tools.ts), so a
 * retry after a broken lease never applies a side effect twice.
 */

export interface Lease {
  path: string;
  owner: string;
  pid: number;
  acquiredAt: number;
  expiresAt: number;
  /** Fingerprint of the target when the lease was taken. */
  fingerprint: string;
  brokeStale: boolean;
  staleFingerprint?: string;
}

export interface AcquireResult {
  lease: Lease;
  waitedMs: number;
  /** Set when this acquisition broke an expired lease from a dead owner. */
  takeover?: { owner: string; pid: number; ageMs: number; fingerprintAtAcquire: string; changedSinceStale: boolean };
}

export class LockTable {
  private leases = new Map<string, Lease>();
  private queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly leaseFile: string,
    private readonly ttlMs = 90_000,
  ) {}

  async load(): Promise<void> {
    const stored = await readJson<Lease[]>(this.leaseFile, []);
    const now = Date.now();
    let stale = 0;
    for (const lease of stored) {
      // Expired leases are kept in memory so the next acquisition can report a
      // takeover (and re-read ground truth) instead of silently pretending the
      // previous holder never existed.
      this.leases.set(lease.path, lease);
      if (lease.expiresAt <= now) stale += 1;
    }
    this.droppedOnLoad = stale;
  }

  /** Expired leases swept at startup; each one implies a crash of its holder. */
  droppedOnLoad = 0;

  snapshot(): Lease[] {
    return [...this.leases.values()];
  }

  isLocked(path: string): boolean {
    const lease = this.leases.get(path);
    return Boolean(lease && lease.expiresAt > Date.now());
  }

  async acquire(
    path: string,
    owner: string,
    options: { fingerprint: string; waitMs?: number; ttlMs?: number; onWait?: (holder: Lease) => void },
  ): Promise<AcquireResult> {
    const started = Date.now();
    const waitMs = options.waitMs ?? 15_000;
    const ttlMs = options.ttlMs ?? this.ttlMs;

    const run = async (): Promise<AcquireResult> => {
      for (;;) {
        const now = Date.now();
        const existing = this.leases.get(path);
        if (!existing || existing.expiresAt <= now) {
          const takeover =
            existing && existing.expiresAt <= now
              ? {
                  owner: existing.owner,
                  pid: existing.pid,
                  ageMs: now - existing.acquiredAt,
                  fingerprintAtAcquire: existing.fingerprint,
                  changedSinceStale: existing.fingerprint !== options.fingerprint,
                }
              : undefined;
          const lease: Lease = {
            path,
            owner,
            pid: process.pid,
            acquiredAt: now,
            expiresAt: now + ttlMs,
            fingerprint: options.fingerprint,
            brokeStale: Boolean(takeover),
            staleFingerprint: takeover?.fingerprintAtAcquire,
          };
          this.leases.set(path, lease);
          await this.persist();
          return { lease, waitedMs: now - started, takeover };
        }

        if (now - started > waitMs) {
          throw new Error(`resource busy: ${path} held by ${existing.owner} (pid ${existing.pid})`);
        }
        options.onWait?.(existing);
        await sleep(120);
      }
    };

    // Serialize acquisitions inside this process so two turns cannot both win.
    const previous = this.queues.get(path) ?? Promise.resolve();
    const attempt = previous.then(run, run);
    this.queues.set(
      path,
      attempt.catch(() => undefined),
    );
    return attempt;
  }

  async release(path: string, owner: string): Promise<void> {
    const lease = this.leases.get(path);
    if (lease && lease.owner === owner) {
      this.leases.delete(path);
      await this.persist();
    }
  }

  async releaseAll(owner: string): Promise<void> {
    let changed = false;
    for (const [path, lease] of this.leases) {
      if (lease.owner === owner) {
        this.leases.delete(path);
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.leaseFile, this.snapshot());
  }
}
