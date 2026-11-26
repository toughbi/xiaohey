import { oneLine } from './memmark.js';

/**
 * Preference detection on user turns.
 *
 * Two jobs, both deliberately narrow:
 *  - `extractConstraints` collects the sentences a user turn states as a
 *    constraint, for the turn digest;
 *  - `detectPreference` finds a sentence that sounds like a durable preference,
 *    so the runtime can nudge the model to call `memory_write`.
 *
 * Neither writes memory. Long-term memory has one writer — the model, on the
 * user's direct statement — because a runtime that writes from tool or page
 * content would let a web page poison the archive.
 */

/** A sentence carrying one of these states a constraint, not just a question. */
const CONSTRAINT_MARKER =
  /不要|不用|别|不需要|不喜欢|不爱|不希望|需要|使用|必须|记住|喜欢|希望|禁止|务必|一定|记得/;

/** Stronger: sounds like it should survive this session. */
const DURABLE_MARKER =
  /以后|今后|下次|往后|从现在起|始终|一律|永远|每次|记住|别用|不要再|必须用|from now on|always|never|remember that|going forward/i;

const splitSentences = (text: string): string[] =>
  text
    .split(/[。！？!?\n；;]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

export function extractConstraints(text: string): string[] {
  const found: string[] = [];
  for (const sentence of splitSentences(text)) {
    if (CONSTRAINT_MARKER.test(sentence)) found.push(oneLine(sentence, 200));
  }
  return [...new Set(found)].slice(0, 12);
}

/** The sentence a nudge should quote, or null when nothing durable was said. */
export function detectPreference(text: string): string | null {
  for (const sentence of splitSentences(text)) {
    if (!DURABLE_MARKER.test(sentence)) continue;
    if (sentence.length < 4) continue;
    return oneLine(sentence, 200);
  }
  return null;
}

/** One injected line; the model decides whether it is durable or one-off. */
export function nudgeText(sentence: string): string {
  return `[runtime] 用户刚表达了可能的长期偏好：「${sentence}」。若确认长期有效，请调用 memory_write(kind=knowledge, slot=…, importance>=70)；若只是一次性要求，忽略。`;
}