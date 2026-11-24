/**
 * Markdown files double as memory storage: the prose is for the user, the HTML
 * comment carries the machine-readable record. JSON is written on one line, so
 * the comment can never span a section, and `-->` inside a value is escaped so
 * it cannot close the comment early.
 */

export function metaComment(tag: string, value: unknown): string {
  const json = JSON.stringify(value)
    .replace(/-->/g, '--\\u003e')
    .replace(/<!--/g, '\\u003c!--');
  return `<!-- ${tag} ${json} -->`;
}

export function readMetaComments<T>(text: string, tag: string): T[] {
  const pattern = new RegExp(`<!--\\s*${tag}\\s+(\\{[\\s\\S]*?\\})\\s*-->`, 'g');
  const found: T[] = [];
  for (const match of text.matchAll(pattern)) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) found.push(parsed as T);
    } catch {
      // A hand-edited comment that no longer parses is skipped, never fatal:
      // the human-readable body above it is still there.
    }
  }
  return found;
}

/** Local wall-clock stamp, stable enough to sort and readable in a diff. */
export function stamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Markdown-safe single line: headings and list markers in content must not fork the layout. */
export function oneLine(text: string, max = 240): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}
