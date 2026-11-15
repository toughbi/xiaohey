import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** Sha1 of a file's bytes, or `absent` when it does not exist. */
export async function fileFingerprint(path: string): Promise<string> {
  try {
    const buf = await readFile(path);
    return createHash('sha1').update(buf).digest('hex').slice(0, 16);
  } catch {
    return 'absent';
  }
}

export function textFingerprint(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}
