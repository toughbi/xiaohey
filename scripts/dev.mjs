import { build, createServer } from 'vite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { context } from 'esbuild';
import { mainBuildOptions, preloadBuildOptions, rendererEntry } from './esbuild.config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(root, '..');

async function main() {
  const renderer = await createServer({
    configFile: join(projectRoot, 'vite.config.ts'),
    server: { host: '127.0.0.1' },
  });
  await renderer.listen();
  const url = renderer.resolvedUrls?.local?.[0] ?? 'http://127.0.0.1:5273/';
  renderer.printUrls();

  const mainCtx = await context(mainBuildOptions);
  const preloadCtx = await context(preloadBuildOptions);
  await mainCtx.watch();
  await preloadCtx.watch();

  const { default: electronPath } = await import('electron');
  // ELECTRON_RUN_AS_NODE turns the binary into a plain Node runtime, which
  // breaks every electron API, so it must not leak into the app process.
  const childEnv = { ...process.env, XIAOHEY_DEV_SERVER_URL: url };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronPath, ['.'], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: childEnv,
  });

  const shutdown = async () => {
    await mainCtx.dispose();
    await preloadCtx.dispose();
    await renderer.close();
  };
  child.on('exit', async (code) => {
    await shutdown();
    process.exit(code ?? 0);
  });
  process.on('SIGINT', async () => {
    child.kill();
    await shutdown();
    process.exit(0);
  });
  void rendererEntry;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
