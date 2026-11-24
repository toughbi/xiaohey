import { estimateTokens } from '../util.js';

/**
 * Reference resolution for follow-up turns.
 *
 * Three kinds, three mechanisms:
 *  - entities: a registry of what the product/workspace actually calls things, so
 *    "客户" maps to a known record or asks which one;
 *  - times: deterministic relative-time parsing to an absolute window in a zone
 *    (the model never does date math alone);
 *  - events: an event object with a timestamp, materialized at the turn that
 *    produced it, so later turns can anchor to it ("到了之后").
 */

export interface EntityRef {
  term: string;
  canonical: string;
  kind: string;
  source: string;
}

export interface TimeRef {
  phrase: string;
  fromIso: string;
  toIso: string;
  timezone: string;
  confidence: 'high' | 'low';
}

export interface EventRef {
  id: string;
  label: string;
  atIso: string;
  timezone: string;
  source: string;
}

export interface ResolutionState {
  entities: EntityRef[];
  times: TimeRef[];
  events: EventRef[];
}

export const emptyResolution = (): ResolutionState => ({ entities: [], times: [], events: [] });

const WEEKDAYS: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
const CN_NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function zoneParts(now: Date, timezone: string): { y: number; m: number; d: number; day: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { y: Number(get('year')), m: Number(get('month')), d: Number(get('day')), day: weekdayIndex };
}

/** Interpret a wall-clock date in a zone without pulling in a date library. */
function isoInZone(y: number, m: number, d: number, hour: number, minute: number, timezone: string): string {
  const guess = Date.UTC(y, m - 1, d, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = formatter.formatToParts(new Date(guess));
  const get = (type: string): number => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'));
  return new Date(guess - (asUtc - guess)).toISOString();
}

const EVENING = { from: 18, to: 22 };
const AFTERNOON = { from: 13, to: 18 };
const MORNING = { from: 9, to: 12 };

/**
 * Parse relative expressions like 周三 / 明天下午 / 3 天后 / 晚上 8 点.
 * Deterministic, with a confidence flag: low-confidence phrases are surfaced to
 * the user instead of silently guessed.
 */
export function parseRelativeTime(text: string, now: Date, timezone: string): TimeRef | null {
  const { y, m, d, day } = zoneParts(now, timezone);
  const base = Date.UTC(y, m - 1, d);
  const dayMs = 86_400_000;
  let target = base;
  let phrase = '';
  let confidence: TimeRef['confidence'] = 'high';

  const weekday = text.match(/(?:这周|本周|下周)?周([一二三四五六日天])/);
  const tomorrow = text.match(/明天|明日/);
  const today = text.match(/今天|今日/);
  const dayAfter = text.match(/后天/);
  const inDays = text.match(/(\d+|一|两|二|三|四|五|六|七)\s*天(?:之)?后/);
  const explicitDate = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);

  if (explicitDate) {
    phrase = explicitDate[0];
    const month = Number(explicitDate[1]);
    const date = Number(explicitDate[2]);
    target = Date.UTC(y, month - 1, date);
    if (target < base) target = Date.UTC(y + 1, month - 1, date);
  } else if (weekday) {
    phrase = weekday[0];
    const wanted = WEEKDAYS[weekday[1]];
    const delta = (wanted - day + 7) % 7 || 7;
    target = base + delta * dayMs;
  } else if (dayAfter) {
    phrase = '后天';
    target = base + 2 * dayMs;
  } else if (tomorrow) {
    phrase = '明天';
    target = base + dayMs;
  } else if (today) {
    phrase = '今天';
    target = base;
  } else if (inDays) {
    phrase = inDays[0];
    const count = CN_NUM[inDays[1]] ?? Number(inDays[1]);
    target = base + count * dayMs;
  }

  if (!phrase) return null;

  let hourFrom = 9;
  let hourTo = 18;
  let minute = 0;
  const explicitHour = text.match(/(\d{1,2})\s*[点:：]\s*(\d{1,2})?/);
  if (text.match(/晚上|夜里/)) {
    hourFrom = EVENING.from;
    hourTo = EVENING.to;
  } else if (text.match(/下午/)) {
    hourFrom = AFTERNOON.from;
    hourTo = AFTERNOON.to;
  } else if (text.match(/上午|早上/)) {
    hourFrom = MORNING.from;
    hourTo = MORNING.to;
  } else if (!explicitHour) {
    confidence = 'low';
  }

  if (explicitHour) {
    let hour = Number(explicitHour[1]);
    minute = explicitHour[2] ? Number(explicitHour[2]) : 0;
    if (hour <= 12 && (text.match(/下午|晚上|夜里/))) hour = hour >= 12 ? hour : hour + 12;
    hourFrom = hour;
    hourTo = hour + 1;
    confidence = 'high';
  }

  const date = new Date(target);
  const target2 = { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };

  return {
    phrase,
    fromIso: isoInZone(target2.y, target2.m, target2.d, hourFrom, minute, timezone),
    toIso: isoInZone(target2.y, target2.m, target2.d, hourTo, 0, timezone),
    timezone,
    confidence,
  };
}

const EVENT_WORDS: Array<{ re: RegExp; label: string }> = [
  { re: /到达|到站|抵达|arriv\w*/i, label: 'arrival' },
  { re: /会议|开会|meeting/i, label: 'meeting' },
  { re: /发布|上线|deploy|release/i, label: 'deploy' },
];

/**
 * Materialize event anchors mentioned in a message into timestamped objects.
 * The clock time may appear before or after the event word, so they are matched
 * independently; an event word without a clock stays unresolved on purpose.
 */
export function extractEvents(text: string, now: Date, timezone: string, source: string): EventRef[] {
  const { y, m, d } = zoneParts(now, timezone);
  const clocks = [...text.matchAll(/(?<!\d)(\d{1,2})[:：](\d{2})(?!\d)/g)];
  if (clocks.length === 0) return [];

  const events: EventRef[] = [];
  for (const word of EVENT_WORDS) {
    const match = text.match(word.re);
    if (!match) continue;
    const clock = clocks[0];
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) continue;
    const start = Math.max(0, (match.index ?? 0) - 12);
    events.push({
      id: `evt_${word.label}_${hour}${minute}`,
      label: text.slice(start, start + 36).replace(/\s+/g, ' ').trim(),
      atIso: isoInZone(y, m, d, hour, minute, timezone),
      timezone,
      source,
    });
  }
  return events;
}

/**
 * Pull entity candidates out of long-term memory so a pronoun can be linked.
 *
 * Two shapes feed this: relational memories (alias → referent) and knowledge
 * memories slotted `entity.<term>`. A structural type keeps the resolver usable
 * by the legacy store and by `memory.md` alike.
 */
export interface MemoryEntitySource {
  slot?: string;
  value?: string;
  detail?: string;
  alias?: string;
  referent?: string;
  source: string;
  status?: string;
}

export function resolveEntities(text: string, facts: MemoryEntitySource[]): { matched: EntityRef[]; ambiguous: EntityRef[][] } {
  const matched: EntityRef[] = [];
  const ambiguous: EntityRef[][] = [];
  const active = facts.filter((fact) => fact.status !== 'superseded' && fact.status !== 'disputed');
  for (const fact of active) {
    const alias = fact.alias?.trim();
    if (alias) {
      if (text.includes(alias)) {
        matched.push({ term: alias, canonical: fact.referent?.trim() || fact.detail || alias, kind: 'relation', source: fact.source });
      }
      continue;
    }
    if (!fact.slot?.startsWith('entity.')) continue;
    const term = fact.slot.slice('entity.'.length);
    if (!text.includes(term)) continue;
    const ref: EntityRef = { term, canonical: fact.value ?? fact.detail ?? term, kind: 'entity', source: fact.source };
    matched.push(ref);
    const alternatives = active.filter(
      (other) => other !== fact && other.slot?.startsWith(`entity.${term}.`),
    );
    if (alternatives.length > 0) {
      ambiguous.push([ref, ...alternatives.map((alt) => ({ term, canonical: alt.value ?? alt.detail ?? term, kind: 'entity', source: alt.source }))]);
    }
  }
  return { matched, ambiguous };
}

export function renderResolution(state: ResolutionState): string {
  const lines: string[] = [];
  for (const time of state.times.slice(-3)) {
    lines.push(`- "${time.phrase}" → ${time.fromIso} … ${time.toIso} (${time.timezone}, ${time.confidence} confidence)`);
  }
  for (const event of state.events.slice(-3)) {
    lines.push(`- event "${event.label}" happened at ${event.atIso} (${event.timezone})`);
  }
  for (const entity of state.entities.slice(-4)) {
    lines.push(`- "${entity.term}" → ${entity.canonical}`);
  }
  return lines.length === 0 ? '(nothing resolved yet)' : lines.join('\n');
}

/** Merge new resolutions into the persisted state, keeping it small. */
export function mergeResolution(base: ResolutionState, next: Partial<ResolutionState>): ResolutionState {
  return {
    entities: [...base.entities, ...(next.entities ?? [])].slice(-12),
    times: [...base.times, ...(next.times ?? [])].slice(-8),
    events: [...base.events, ...(next.events ?? [])].slice(-8),
  };
}

export function resolutionTokens(state: ResolutionState): number {
  return estimateTokens(JSON.stringify(state));
}
