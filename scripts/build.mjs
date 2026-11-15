import { build } from 'vite';
import { build as esbuild } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mainBuildOptions, preloadBuildOptions } from './esbuild.config.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.NODE_ENV = 'production';

async function main() {
  await esbuild({ ...mainBuildOptions, minify: true, sourcemap: false });
  await esbuild({ ...preloadBuildOptions, minify: true, sourcemap: false });
  await build({ configFile: join(projectRoot, 'vite.config.ts'), mode: 'production' });
  console.log('built dist/main, dist/preload, dist/renderer');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
