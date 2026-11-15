export type DiffLine = { type: 'same' | 'add' | 'del'; text: string; before?: number; after?: number };

/**
 * Line diff with an LCS table, capped so a huge file cannot freeze the panel.
 * For files beyond the cap the panel falls back to a visible "too large" notice.
 */
export function lineDiff(before: string, after: string, cap = 600): DiffLine[] | null {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);
  if (a.length > cap || b.length > cap) return null;

  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      lines.push({ type: 'same', text: a[i], before: i + 1, after: j + 1 });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      lines.push({ type: 'del', text: a[i], before: i + 1 });
      i += 1;
    } else {
      lines.push({ type: 'add', text: b[j], after: j + 1 });
      j += 1;
    }
  }
  while (i < a.length) {
    lines.push({ type: 'del', text: a[i], before: i + 1 });
    i += 1;
  }
  while (j < b.length) {
    lines.push({ type: 'add', text: b[j], after: j + 1 });
    j += 1;
  }
  return lines;
}

export function diffStats(lines: DiffLine[]): { additions: number; deletions: number } {
  return {
    additions: lines.filter((line) => line.type === 'add').length,
    deletions: lines.filter((line) => line.type === 'del').length,
  };
}

/** Collapse long runs of unchanged lines, keeping a few around each change. */
export function foldDiff(lines: DiffLine[], context = 3): Array<DiffLine | { type: 'gap'; text: string }> {
  const keep = new Set<number>();
  lines.forEach((line, index) => {
    if (line.type === 'same') return;
    for (let i = index - context; i <= index + context; i += 1) {
      if (i >= 0 && i < lines.length) keep.add(i);
    }
  });
  if (lines.every((line) => line.type === 'same')) {
    return lines.slice(0, context * 2).map((line) => line);
  }
  const result: Array<DiffLine | { type: 'gap'; text: string }> = [];
  let gap = 0;
  lines.forEach((line, index) => {
    if (keep.has(index)) {
      if (gap > 0) {
        result.push({ type: 'gap', text: `${gap} 行未改动` });
        gap = 0;
      }
      result.push(line);
    } else {
      gap += 1;
    }
  });
  if (gap > 0) result.push({ type: 'gap', text: `${gap} 行未改动` });
  return result;
}
