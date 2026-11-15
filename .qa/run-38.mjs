// QA pass 38: frosted chrome — blur on the composer dock and popovers.
// node .qa/run-38.mjs
import { _electron } from 'playwright-core';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'E:/code/xiaohei';
const shots = join(root, '.qa');
const homes = join(root, '.qa-homes');
const results = [];
let page;
let app;

const log = (id, name, status, detail = '') => {
  results.push({ id, name, status, detail });
  console.log(`${status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'WARN'}  ${id}  ${name}${detail ? ' — ' + detail : ''}`);
};

async function test(id, name, fn) {
  try {
    const detail = await fn();
    log(id, name, 'pass', detail ?? '');
  } catch (error) {
    log(id, name, 'fail', error?.message ?? String(error));
    try {
      await page.screenshot({ path: join(shots, `fail-${id}.png`) });
    } catch {}
  }
}

const home = join(homes, 'glass');
await rm(home, { recursive: true, force: true }).catch(() => undefined);
await mkdir(join(home, 'workspace'), { recursive: true });
await writeFile(
  join(home, 'settings.json'),
  JSON.stringify({
    models: [
      {
        id: 'm',
        name: 'Fake',
        provider: 'custom',
        baseUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'x',
        model: 'fake',
        temperature: 0,
        maxOutputTokens: 128,
        contextWindow: 32000,
      },
    ],
    activeModelId: 'm',
    approval: 'ask',
    allowedCommands: [],
    recentWorkspaces: [join(home, 'workspace')],
  }),
);
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'workspace') };
delete env.ELECTRON_RUN_AS_NODE;
app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(900);
await page.locator('.rail-new').click();
await page.waitForTimeout(500);
await page.locator('.workspace-row').click();
await page.waitForTimeout(250);
await page.locator('.workspace-menu .workspace-folder').first().click();
await page.waitForTimeout(600);

const styles = async (selector) =>
  page.locator(selector).first().evaluate((node) => {
    const css = getComputedStyle(node);
    return { backdrop: css.backdropFilter, background: css.backgroundColor, position: css.position };
  });

await test('G1', 'the composer floats in an absolute dock', async () => {
  const dock = await styles('.composer-dock');
  if (dock.position !== 'absolute') throw new Error(`dock: ${dock.position}`);
});

await test('G2', 'the composer is frosted glass', async () => {
  const composer = await styles('.composer');
  if (!composer.backdrop.includes('blur(')) throw new Error(`backdrop: ${composer.backdrop}`);
  if (!/rgba|color\(/.test(composer.background)) throw new Error(`background: ${composer.background}`);
});

await test('G3', 'popovers share the same material', async () => {
  await page.locator('.cm-workspace').click();
  await page.waitForTimeout(350);
  const menu = await styles('.workspace-menu');
  if (!menu.backdrop.includes('blur(')) throw new Error(`backdrop: ${menu.backdrop}`);
  await page.locator('.policy-backdrop').first().click({ force: true }).catch(() => undefined);
});

if (app) await app.close();
await writeFile(join(shots, 'results-38.json'), JSON.stringify(results, null, 2));
const failed = results.filter((item) => item.status === 'fail');
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
