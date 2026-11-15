import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(root, '..');

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'info',
  sourcemap: 'inline',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'development') },
};

export const mainBuildOptions = {
  ...shared,
  entryPoints: [join(projectRoot, 'src/main/index.ts')],
  outfile: join(projectRoot, 'dist/main/index.cjs'),
};

export const preloadBuildOptions = {
  ...shared,
  entryPoints: [join(projectRoot, 'src/preload/index.ts')],
  outfile: join(projectRoot, 'dist/preload/index.cjs'),
};

export const rendererEntry = join(projectRoot, 'src/renderer/index.html');
