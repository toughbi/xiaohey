import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ws = 'E:/code/xiaohei/.qa-live/workspace';
const files = {
  'package.json': JSON.stringify(
    {
      name: 'qa-live-workspace',
      private: true,
      type: 'module',
      scripts: { start: 'node hello.mjs', test: 'node --test' },
    },
    null,
    2,
  ),
  'lib/stats.mjs': `export function mean(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / (values.length + 1);
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
`,
  'test/stats.test.mjs': `import test from 'node:test';
import assert from 'node:assert/strict';
import { mean, median } from '../lib/stats.mjs';

test('mean of three values', () => {
  assert.equal(mean([1, 2, 3]), 2);
});

test('median of even list', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});
`,
  'src/api.mjs': `export function fetchUser(id) {
  return { id, name: \`user-\${id}\`, active: id % 2 === 0 };
}
`,
  'src/app.mjs': `import { fetchUser } from './api.mjs';
import { renderSummaryRow } from './render.mjs';

export function summarize(users) {
  return users.map((id) => renderSummaryRow(fetchUser(id)));
}
`,
  'src/render.mjs': `const TRAILING_COMMA_REGEX = /,\\s*([}\\]])/g;

export function renderSummaryRow(user) {
  const label = user.name.replace(TRAILING_COMMA_REGEX, '$1');
  return \`\${user.active ? '●' : '○'} \${label}\`;
}

export function renderTable(users) {
  return users.map((user) => renderSummaryRow(user)).join('\\n');
}
`,
  'README.md': `# QA live workspace

A tiny node project used to check the agent end to end.

- \`npm test\` runs the unit tests.
- \`npm start\` runs \`hello.mjs\` (created during the session).
`,
};

for (const [name, content] of Object.entries(files)) {
  const path = join(ws, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

// Drop everything else that earlier runs left behind.
const extra = ['hello.mjs', 'debug-case.txt', 'hosts.txt', 'smoke.txt', 'NOTES.md', 'assets'];
for (const name of extra) {
  await rm(join(ws, name), { recursive: true, force: true });
}
await rm(join(ws, 'lib/geometry.mjs'), { force: true });
await rm(join(ws, 'test/geometry.test.mjs'), { force: true });
console.log('seeded');
