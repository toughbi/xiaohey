import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Where memory lives.
 *
 * Memory is deliberately user-facing and independent of the Electron profile:
 * `~/.xiaohey` on every platform, so a user can read, back up or edit these
 * files without knowing where the app stores its cache. `XIAOHEY_MEMORY_HOME`
 * (and an explicit constructor root in tests) points somewhere else.
 */
export function memoryRoot(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit;
  const override = process.env.XIAOHEY_MEMORY_HOME;
  if (override && override.trim()) return override;
  return join(homedir(), '.xiaohey');
}

export const MEMORY_FILE = 'memory.md';
export const MEMORY_ARCHIVE_FILE = 'memory-archive.md';
export const MEMORY_VECTOR_FILE = 'memory-vectors.json';
export const SESSION_DIR = 'session';

export const memoryFile = (root: string): string => join(root, MEMORY_FILE);
export const memoryArchiveFile = (root: string): string => join(root, MEMORY_ARCHIVE_FILE);
export const memoryVectorFile = (root: string): string => join(root, MEMORY_VECTOR_FILE);
export const sessionDir = (root: string): string => join(root, SESSION_DIR);
