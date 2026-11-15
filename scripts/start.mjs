import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Run the built app. Kept in a script so ELECTRON_RUN_AS_NODE (which turns the
 * Electron binary into plain Node and breaks every API) cannot leak in from the
 * surrounding shell.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { default: electronPath } = await import('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electronPath, ['.'], { cwd: root, stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
