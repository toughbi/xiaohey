import { estimateTokens } from '../util.js';
import { renderDigest } from './compressor.js';
import type { SessionEvent, TurnDigest } from './events.js';
import type { SessionLog } from './sessionlog.js';

/**
 * Session search: the recovery path for context that slid out of the window.
 *
 * It reads the ledger (and L2 artifacts), never a vector database: the source of
 * truth is already a sorted append-only file that can be scanned, so the index
 * is an optimization, not a dependency. Results carry a turn number, a snippet
 * and a handle — never a whole document, because the caller then decides whether
 * to expand it with `turn_expand` or `read_handle`, and that expansion counts
 * against the same budget as any other observation.
 */

export interface SearchHit {
  turn: number;
  snippet: string;
  score: number;
  /** Handle when the matching text lives in a blob. */
  handle?: string;
  at: number;
  kind: 'event' | 'summary';
}

const SNIPPET = 160;

function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s,，、;；/|]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

/** Substring first, then term and CJK-bigram coverage — same shape as memory recall. */
export function scoreText(haystack: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const text = haystack.toLowerCase();
  if (text.includes(q)) return 1;
  // Chinese queries often carry spaces around numbers ("第 1 轮"), and a term
  // split at those spaces would match every turn. Compare the compact form too,
  // and never let a single CJK character count as a term.
  const compact = q.replace(/\s+/g, '');
  if (compact.length >= 2 && /[\u2e80-\u9fff]/.test(compact) && text.replace(/\s+/g, '').includes(compact)) return 1;
  const parts = terms(q).filter((term) => term.length >= 2 || /[a-z0-9_.-]{2,}/i.test(term));
  if (parts.length === 0) return 0;
  let score = 0;
  for (const term of parts) {
    if (text.includes(term)) {
      score += 1;
      continue;
    }
    if (term.length >= 2) {
      const grams: string[] = [];
      for (let index = 0; index < term.length - 1; index += 1) grams.push(term.slice(index, index + 2));
      const hit = grams.filter((gram) => text.includes(gram)).length;
      score += grams.length > 0 ? hit / grams.length : 0;
    }
  }
  return score / parts.length;
}

function snippetAround(text: string, query: string): string {
  const lower = text.toLowerCase();
  const q = query.trim().toLowerCase();
  let at = q ? lower.indexOf(q) : 0;
  if (at < 0) {
    for (const term of terms(q)) {
      at = lower.indexOf(term);
      if (at >= 0) break;
    }
  }
  if (at < 0) return text.replace(/\s+/g, ' ').slice(0, SNIPPET);
  const start = Math.max(0, at - Math.floor(SNIPPET / 2));
  const body = text.slice(start, start + SNIPPET).replace(/\s+/g, ' ');
  return `${start > 0 ? '…' : ''}${body}${start + SNIPPET < text.length ? '…' : ''}`;
}

/** Text an event contributes to search, plus the handle that can expand it. */
/** How much a hit in this kind of event counts (the user's words beat a plan echo). */
const WEIGHT: Partial<Record<SessionEvent['type'], number>> = {
  turn_started: 1,
  assistant_message: 1,
  tool_result: 0.85,
  tool_call: 0.8,
  notice: 0.5,
  turn_checkpoint: 0.45,
};

function eventText(event: SessionEvent): { text: string; handle?: string } {
  switch (event.type) {
    case 'turn_started':
      return { text: event.userText };
    case 'assistant_message':
      return { text: event.text, ...(event.reasoning && 'blob' in event.reasoning ? { handle: event.reasoning.handle } : {}) };
    case 'tool_call':
      return {
        text: `${event.name} ${event.summary ?? ''} ${event.target ?? ''} ${'text' in event.args ? event.args.text : event.args.preview}`,
        ...('blob' in event.args ? { handle: event.args.handle } : {}),
      };
    case 'tool_result':
      return {
        text: `${event.name} ${event.summary} ${'text' in event.content ? event.content.text : event.content.preview}`,
        ...('blob' in event.content ? { handle: event.content.handle } : {}),
      };
    case 'notice':
      return { text: `${event.title} ${event.body}` };
    case 'turn_checkpoint':
      return { text: `${event.goal} ${event.next ?? ''}` };
    default:
      return { text: '' };
  }
}

export class SessionSearch {
  constructor(private readonly log: SessionLog) {}

  /** Search the active view of one session. */
  async search(query: string, options: { limit?: number; includeSummary?: boolean } = {}): Promise<SearchHit[]> {
    const limit = Math.max(1, Math.min(20, options.limit ?? 5));
    const hits: SearchHit[] = [];
    const seenTurns = new Set<number>();
    for (const event of this.log.activeEvents()) {
      const { text, handle } = eventText(event);
      if (!text.trim()) continue;
      const score = scoreText(text, query) * (WEIGHT[event.type] ?? 0.5);
      if (score <= 0) continue;
      hits.push({
        turn: event.turn,
        snippet: snippetAround(text, query),
        score,
        ...(handle ? { handle } : {}),
        at: event.ts,
        kind: 'event',
      });
      seenTurns.add(event.turn);
    }

    if (options.includeSummary !== false) {
      const manifest = await this.log.manifestFile();
      for (const artifact of Object.values(manifest.artifacts)) {
        const json = (await this.log.artifactJson(artifact.artifact)) as TurnDigest | null;
        if (!json || typeof json !== 'object') continue;
        const rendered = `${renderDigest(json)} ${json.keySteps.map((step) => `${step.tool} ${step.target ?? ''}`).join(' ')}`;
        const score = scoreText(rendered, query);
        if (score <= 0) continue;
        if (seenTurns.has(json.turn)) continue;
        hits.push({
          turn: json.turn,
          snippet: snippetAround(rendered, query),
          score: score * 0.9,
          at: artifact.createdAt,
          kind: 'summary',
        });
      }
    }

    hits.sort((a, b) => b.score - a.score || b.turn - a.turn);
    return hits.slice(0, limit);
  }

  /** Cheap token estimate for budget decisions before returning hits. */
  estimate(limit = 5): number {
    return estimateTokens('x'.repeat(SNIPPET * limit));
  }
}