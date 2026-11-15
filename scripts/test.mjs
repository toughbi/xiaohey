import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bundle the TypeScript self-test and run it with Node. */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, '.tmp', 'selftest.cjs');

await build({
  entryPoints: [join(root, 'tests/selftest.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  logLevel: 'warning',
});

const child = spawn(process.execPath, [outfile], { cwd: root, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
