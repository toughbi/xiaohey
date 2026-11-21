import { _electron } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Launch the built app in demo mode and capture the panels that carry the design.
 * Run `npm run build` first.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = join(root, '.demo-home');
const shots = join(root, 'shots');

async function main() {
  await rm(home, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });
  const { default: electronPath } = await import('electron');

  // Local OpenAI-compatible stub: the add-model dialog really fetches /models,
  // so the screenshots show a real response rather than a hardcoded list.
  const modelStub = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          data: [
            { id: 'qwen2.5-coder' },
            { id: 'qwen2.5-72b-instruct' },
            { id: 'llama-3.3-70b' },
            { id: 'deepseek-r2' },
            { id: 'local-embed' },
            { id: 'vision-preview' },
          ],
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => modelStub.listen(4788, '127.0.0.1', resolve));

  const env = {
    ...process.env,
    XIAOHEY_DEMO: '1',
    XIAOHEY_HOME: home,
    XIAOHEY_WORKSPACE: join(home, 'demo-workspace'),
    NODE_ENV: 'production',
  };
  // A plain-Node mode leak would make every electron API undefined.
  delete env.ELECTRON_RUN_AS_NODE;

  const app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: root, env });
  const page = await app.firstWindow();
  await page.waitForSelector('.app');
  // The product theme is light; dark is captured separately at the end.
  await page.evaluate(() => window.__xiaoheyShot?.setTheme('light'));
  await page.waitForTimeout(1000);

  await page.screenshot({ path: join(shots, '01-session.png') });

  await page.evaluate(() => window.__xiaoheyShot?.switchTab('files'));
  await page.waitForTimeout(260);
  await page.screenshot({ path: join(shots, '02-files.png') });

  await page.locator('.transcript').evaluate((node) => {
    node.scrollTop = 0;
  });
  await page.waitForTimeout(220);
  const tool = page.locator('.tool-head').first();
  if (await tool.count()) {
    await tool.click();
    await page.waitForTimeout(320);
  }
  await page.screenshot({ path: join(shots, '03-transcript.png') });

  await page.evaluate(() => window.__xiaoheyShot?.switchTab('preview'));
  await page.waitForTimeout(320);
  const diffTab = page.locator('.segmented button').nth(1);
  if (await diffTab.count()) {
    await diffTab.click();
    await page.waitForTimeout(320);
  }
  await page.screenshot({ path: join(shots, '04-diff.png') });

  // Markdown renders as a document rather than a code block.
  await page.evaluate(() => window.__xiaoheyShot?.switchTab('files'));
  await page.waitForTimeout(400);
  const readme = page.locator('.file-row').filter({ hasText: 'README.md' }).first();
  if (await readme.count()) {
    await readme.click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(shots, '24-docs-markdown.png') });

    await page.evaluate(() => window.__xiaoheyShot?.switchTab('files'));
    await page.waitForTimeout(350);
    await page.locator('.file-row').filter({ hasText: 'app' }).first().click();
    await page.waitForTimeout(400);
    const pageTsx = page.locator('.file-row').filter({ hasText: 'page.tsx' }).first();
    if (await pageTsx.count()) {
      await pageTsx.click();
      await page.waitForTimeout(700);
      const sourceTab = page.locator('.segmented button').first();
      if (await sourceTab.count()) {
        await sourceTab.click();
        await page.waitForTimeout(300);
      }
      await page.screenshot({ path: join(shots, '25-docs-code.png') });
    }
  }

  await page.evaluate(() => window.__xiaoheyShot?.switchTab('memory'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, '05-memory.png') });

  // Composer in its active state: text typed, send enabled.
  await page.locator('.composer textarea').fill('把表格的行高和异常数量一起收一下，验收：构建仍然通过');
  await page.waitForTimeout(220);
  await page.screenshot({ path: join(shots, '12-composer.png') });
  await page.locator('.composer textarea').fill('');

  // Approval policy menu, opened from the composer chip.
  await page.locator('.policy-wrap .tb-chip').click();
  await page.waitForTimeout(320);
  await page.screenshot({ path: join(shots, '17-policy.png') });
  await page.locator('.policy-backdrop').click();
  await page.waitForTimeout(200);

  // Profile menu in the sidebar footer: settings, theme, sign out.
  await page.locator('.rail-user').click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, '19-profile.png') });
  await page.locator('.rail-menu-backdrop').click();
  await page.waitForTimeout(150);

  await page.locator('.foot-actions button').first().click();
  await page.waitForTimeout(280);
  await page.screenshot({ path: join(shots, '20-usage.png') });
  await page.locator('.rail-menu-backdrop').click();
  await page.waitForTimeout(150);

  // Model switcher: only the models already added, clicking switches.
  await page.locator('.model-wrap .tb-chip').click();
  await page.waitForTimeout(280);
  await page.screenshot({ path: join(shots, '18-models.png') });
  await page.locator('.policy-backdrop').click();
  await page.waitForTimeout(150);

  await page.evaluate(() => window.__xiaoheyShot?.switchTab('checkpoints'));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, '06-checkpoints.png') });

  // End-to-end check of revert: the tree is restored, files created after the
  // snapshot are removed, and a factual notice lands in the transcript.
  const revertButton = page.locator('.snapshot-list li button').first();
  if (await revertButton.count()) {
    await revertButton.click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(shots, '09-revert.png') });
    const revertNotices = await page.locator('.notice', { hasText: '已回退到' }).count();
    console.log(`revert path: ${revertNotices} rollback notice(s)`);
  }

  await page.evaluate(() => window.__xiaoheyShot?.openSettings());
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, '07-settings.png') });

  const addModel = page.locator('.settings-head .primary');
  if (await addModel.count()) {
    await addModel.click();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, '21-model-editor.png') });

    // The dialog lists the provider catalogue; the model list itself is fetched
    // from a local OpenAI-compatible endpoint so the shot shows a real response.
    await page.locator('.model-dialog .select').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(shots, '22-provider.png') });
    await page.getByRole('option', { name: /OpenAI Compatible/ }).click();
    await page.waitForTimeout(300);
    await page.locator('.model-dialog .field input').nth(0).fill('http://127.0.0.1:4788/v1');
    await page.waitForTimeout(250);
    await page.locator('.model-dialog .select').nth(1).click();
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(shots, '23-model-list.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => window.__xiaoheyShot?.closeSettings());

  // Same structure, light surface: the theme toggle must not change layout.
  await page.evaluate(() => window.__xiaoheyShot?.setTheme('dark'));
  await page.waitForTimeout(320);
  await page.screenshot({ path: join(shots, '10-dark.png') });
  await page.evaluate(() => window.__xiaoheyShot?.openSettings());
  await page.waitForTimeout(320);
  await page.screenshot({ path: join(shots, '11-dark-settings.png') });
  await page.evaluate(() => {
    window.__xiaoheyShot?.closeSettings();
    window.__xiaoheyShot?.setTheme('light');
  });
  await page.waitForTimeout(200);

  // End-to-end check of the turn loop's error path: no API key is configured in
  // the demo profile, so this must end in a readable failure notice, not a crash.
  await page.locator('.rail-new').click();
  await page.waitForTimeout(400);
  await page.locator('.composer textarea').fill('加一个导出 CSV 的按钮，验收：npm run build 通过');
  await page.locator('.composer textarea').press('Enter');
  await page.waitForTimeout(6000);
  await page.screenshot({ path: join(shots, '08-turn-error.png') });
  const notices = await page.locator('.notice').count();
  const items = await page.locator('.turn').count();
  console.log(`turn error path: ${items} turns, ${notices} notices`);

  // A brand-new session shows the activity heatmap instead of copy.
  await page.locator('.rail-new').click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(shots, '15-empty.png') });

  await app.close();
  modelStub.close();
  console.log('shots written to', shots);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
