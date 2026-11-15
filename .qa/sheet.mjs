import { _electron } from 'playwright-core';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = 'E:/code/xiaohei';
const home = join(root, '.qa-homes', 'sheet');
await rm(home, { recursive: true, force: true });
await mkdir(home, { recursive: true });
const env = { ...process.env, XIAOHEY_HOME: home, XIAOHEY_WORKSPACE: join(home, 'demo-workspace'), XIAOHEY_DEMO: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const app = await _electron.launch({ executablePath: join(root, 'node_modules/electron/dist/electron.exe'), args: ['.'], cwd: root, env });
const page = await app.firstWindow();
await page.waitForSelector('.app');
await page.waitForTimeout(1200);

const template = await page.evaluate(() => document.querySelector('.titlebar .brand-mark').outerHTML);

const expressionSvg = (expression) => {
  let svg = template;
  if (expression === 'idle') {
    svg = svg.replace(/<g class="brand-mark-body">[\s\S]*<\/g>/, bodyFor('idle'));
  }
  return svg;
};

// Build the sheet by swapping the rendered body for each expression taken from
// the live component: hover/click each state and copy the markup.
const bodies = {};
for (const [expression, action] of [
  ['idle', async () => {}],
  ['happy', async () => page.locator('.titlebar .brand-mark').hover()],
  ['surprised', async () => {
    const box = await page.locator('.titlebar .brand-mark').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
  }],
  ['wink', async () => {}],
]) {
  await action();
  await page.waitForTimeout(350);
  bodies[expression] = await page.evaluate(() => {
    const mark = document.querySelector('.titlebar .brand-mark');
    return { html: mark.innerHTML, expression: mark.getAttribute('data-expression') };
  });
  await page.mouse.up().catch(() => {});
  await page.mouse.move(700, 400);
  await page.waitForTimeout(200);
}

const resolveVars = (html) =>
  html
    .replaceAll('var(--mark-ink)', '#f7ead9')
    .replaceAll('var(--mark-tile-top)', '#17171a')
    .replaceAll('var(--mark-tile-mid)', '#0c0c0e')
    .replaceAll('var(--mark-tile-bottom)', '#050506')
    .replaceAll('var(--mark-eye)', '#ffffff')
    .replaceAll('var(--mark-pupil)', '#0b0b0d')
    .replaceAll('var(--mark-rim)', 'rgba(255,255,255,.08)');

const body = (inner) => resolveVars(inner);

const expressions = [
  { label: '待机', inner: bodies.idle.html },
  { label: '悬停 · 开心', inner: bodies.happy.html },
  { label: '按下 · 惊讶', inner: bodies.surprised.html },
];

const sheet = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; background: #f6f4ef; font-family: "Segoe UI", system-ui, sans-serif; color: #1c1c1a; }
  .wrap { padding: 34px 40px; }
  h1 { font-size: 15px; margin: 0 0 4px; letter-spacing: .01em; }
  p.sub { margin: 0 0 26px; color: #7a776f; font-size: 12px; }
  .row { display: flex; gap: 34px; margin-bottom: 30px; }
  .cell { display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .cell .art { display: grid; place-items: center; width: 118px; height: 118px; border-radius: 16px; background: #fff; border: 1px solid #e7e3d9; }
  .cell span { font-size: 11px; color: #6c6961; }
  .sizes { display: flex; align-items: flex-end; gap: 22px; }
  .sizes .cell .art { border: none; background: transparent; width: auto; height: auto; }
  .sizes svg { display: block; }
  .label { font-size: 11px; color: #8a877e; margin-bottom: 8px; letter-spacing: .06em; text-transform: uppercase; }
</style></head><body><div class="wrap">
  <h1>xiaohey mark</h1>
  <p class="sub">整块高级黑 + 终端提示符；悬停时光标变宽、尖角轻推，按下时整体收紧，闲置时光标会眨眼。</p>
  <div class="label">expressions</div>
  <div class="row">
    ${expressions
      .map(
        (entry) =>
          `<div class="cell"><div class="art"><svg width="96" height="96" viewBox="0 0 512 512">${body(entry.inner)}</svg></div><span>${entry.label}</span></div>`,
      )
      .join('')}
  </div>
  <div class="label">sizes</div>
  <div class="sizes">
    ${[16, 24, 32, 48, 64, 96]
      .map(
        (size) =>
          `<div class="cell"><svg width="${size}" height="${size}" viewBox="0 0 512 512">${body(bodies.idle.html)}</svg><span>${size}px</span></div>`,
      )
      .join('')}
  </div>
</div></body></html>`;

await page.setContent(sheet);
await page.waitForTimeout(300);
await page.screenshot({ path: join(root, 'shots', 'brand-sheet.png'), fullPage: true });
await app.close();
await rm(home, { recursive: true, force: true });
console.log('sheet written');
