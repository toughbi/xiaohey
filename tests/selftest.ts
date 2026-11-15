/**
 * Runtime self-test. No network, no model: it exercises the mechanisms the
 * design notes claim, against the same modules the app runs.
 *
 *   npm test   → scripts/test.mjs bundles this file and runs it.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyClaim, renderMemory, type MemoryRecord } from '../src/main/runtime/memory.js';
import { autoDecision, classifyCommand } from '../src/main/runtime/policy.js';
import { normalizeSettings, Store } from '../src/main/store.js';
import { AgentService } from '../src/main/runtime/agent.js';
import { listModels } from '../src/main/runtime/models.js';
import { extractEvents, parseRelativeTime } from '../src/main/runtime/resolve.js';
import { buildContract, checkDrift, renderContract } from '../src/main/runtime/contract.js';
import { committed, intent, orphanIntents, reconcile } from '../src/main/runtime/journal.js';
import { LockTable } from '../src/main/runtime/locks.js';
import { Checkpoints } from '../src/main/runtime/checkpoint.js';
import { auditClaims, foldItems, mechanicalSummary, toMessages } from '../src/main/runtime/context.js';
import { applyClaim as claim } from '../src/main/runtime/memory.js';
import { toolByName, tools } from '../src/main/runtime/tools.js';
import { parseArguments, validateArgs } from '../src/main/runtime/toolerrors.js';
import type { Item, Turn } from '../src/shared/types.js';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

async function test(name: string, run: () => Promise<void> | void): Promise<void> {
  try {
    await run();
    results.push({ name, ok: true });
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    results.push({ name, ok: false, detail: (error as Error).message });
    process.stdout.write(`  FAIL ${name}\n       ${(error as Error).message}\n`);
  }
}

const workspace = (): Promise<string> => mkdtemp(join(tmpdir(), 'xiaohey-test-'));

function fakeItem(partial: Partial<Item> & Pick<Item, 'kind'>): Item {
  return {
    id: `itm_${Math.random().toString(36).slice(2, 8)}`,
    threadId: 'thr_test',
    turnId: 'trn_test',
    at: Date.now(),
    status: 'done',
    ...partial,
  } as Item;
}

async function main(): Promise<void> {
  process.stdout.write('\nmemory\n');
  await test('supersede retires the previous value in the same scope', () => {
    const records: MemoryRecord[] = [];
    const first = applyClaim(records, { slot: 'pref.comments', value: 'write full comments', scope: { kind: 'workspace' }, source: 't1' });
    const second = applyClaim(first.records, { slot: 'pref.comments', value: 'write full comments and docstrings', scope: { kind: 'workspace' }, source: 't2' });
    assert.equal(second.kind, 'supersede');
    const active = second.records.filter((record) => record.status === 'active');
    assert.equal(active.length, 1);
    assert.equal(active[0].value, 'write full comments and docstrings');
    const retired = second.records.filter((record) => record.status === 'superseded');
    assert.equal(retired.length, 1);
  });

  await test('opposite polarity is disputed, not merged', () => {
    const first = applyClaim([], { slot: 'pref.comments', value: 'write full comments', scope: { kind: 'global' }, source: 't1' });
    const second = applyClaim(first.records, { slot: 'pref.comments', value: 'never add comments', scope: { kind: 'global' }, source: 't2' });
    assert.equal(second.kind, 'contradict');
    assert.equal(second.records.filter((record) => record.status === 'disputed').length, 2);
    assert.match(renderMemory(second.records), /DISPUTED/);
  });

  await test('a different scope is kept as a scoped claim', () => {
    const first = applyClaim([], { slot: 'pref.comments', value: 'write full comments', scope: { kind: 'workspace' }, source: 't1' });
    const second = applyClaim(first.records, { slot: 'pref.comments', value: 'never add comments', scope: { kind: 'path', path: 'vendor/' }, source: 't2' });
    assert.equal(second.kind, 'scope_diff');
    assert.equal(second.records.filter((record) => record.status === 'active').length, 2);
  });

  await test('different slots never conflict', () => {
    const first = applyClaim([], { slot: 'a.b', value: 'x', scope: { kind: 'global' }, source: 't1' });
    const second = applyClaim(first.records, { slot: 'a.c', value: 'y', scope: { kind: 'global' }, source: 't2' });
    assert.equal(second.kind, 'distinct');
  });

  process.stdout.write('\nresolution\n');
  await test('relative weekday + evening time resolves to an absolute window', () => {
    const now = new Date('2026-11-13T13:00:00+08:00');
    const ref = parseRelativeTime('下周三晚上8点先把报告发我', now, 'Asia/Shanghai');
    assert.ok(ref);
    assert.equal(ref.phrase, '周三');
    assert.equal(ref.confidence, 'high');
    const from = new Date(ref.fromIso);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short', hour: '2-digit', hourCycle: 'h23' }).formatToParts(from);
    const weekday = parts.find((part) => part.type === 'weekday')?.value;
    const hour = parts.find((part) => part.type === 'hour')?.value;
    assert.equal(weekday, 'Wed');
    assert.equal(hour, '20');
    assert.ok(from.getTime() > now.getTime());
  });

  await test('a phrase without a clock is flagged low confidence', () => {
    const ref = parseRelativeTime('周五聊一下', new Date('2026-11-13T13:00:00+08:00'), 'Asia/Shanghai');
    assert.ok(ref);
    assert.equal(ref.confidence, 'low');
  });

  await test('events are materialised with a timestamp and a zone', () => {
    const events = extractEvents('我 14:32 到达虹桥站，到了以后再说', new Date('2026-11-13T13:00:00+08:00'), 'Asia/Shanghai', 'user');
    assert.equal(events.length, 1);
    const local = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(events[0].atIso));
    assert.equal(local, '14:32');
  });

  process.stdout.write('\ncontract\n');
  await test('acceptance, non-goals and forbidden lines are extracted', () => {
    const contract = buildContract('重做概览页。验收：npm run build 通过。非目标：不改后端。禁止：改动 app/api/ 目录。');
    assert.ok(contract.acceptance.some((line) => line.includes('npm run build')));
    assert.ok(contract.nonGoals.some((line) => line.includes('后端')));
    assert.ok(contract.forbidden.some((line) => line.includes('app/api/')));
    assert.match(renderContract(contract), /Acceptance/);
  });

  await test('a forbidden path is refused before the write', () => {
    const contract = buildContract('整理样式。禁止：改动 app/api/ 目录。');
    const verdict = checkDrift(contract, { name: 'write_file', args: { path: 'app/api/route.ts' } });
    assert.equal(verdict.action, 'refuse');
  });

  process.stdout.write('\njournal\n');
  await test('an orphaned intent is reconciled against fingerprints', () => {
    const record = intent({ step: 2, callId: 'c1', tool: 'write_file', idempotencyKey: 'k1', before: { 'a.ts': 'before' }, summary: 'write a.ts' });
    assert.equal(orphanIntents([record]).length, 1);
    const settled = committed(record, { 'a.ts': 'after' }, 'wrote a.ts');
    assert.equal(orphanIntents([record, settled]).length, 0);
    assert.equal(reconcile(record, { 'a.ts': 'before' }).outcome, 'not-applied');
    assert.equal(reconcile(record, { 'a.ts': 'something-else' }).outcome, 'unknown');
    assert.equal(reconcile(settled, { 'a.ts': 'after' }).outcome, 'applied');
  });

  process.stdout.write('\nlocks\n');
  await test('an expired lease is broken on startup and reports the stale state', async () => {
    const dir = await workspace();
    const file = join(dir, 'leases.json');
    await writeFile(
      file,
      JSON.stringify([
        { path: join(dir, 'a.ts'), owner: 'thread:dead', pid: 999999, acquiredAt: Date.now() - 600_000, expiresAt: Date.now() - 1, fingerprint: 'stale', brokeStale: false },
      ]),
      'utf8',
    );
    const table = new LockTable(file, 60_000);
    await table.load();
    assert.equal(table.droppedOnLoad, 1);
    const acquired = await table.acquire(join(dir, 'a.ts'), 'thread:live', { fingerprint: 'fresh' });
    assert.ok(acquired.takeover);
    assert.equal(acquired.takeover?.changedSinceStale, true);
    await table.release(join(dir, 'a.ts'), 'thread:live');
    await rm(dir, { recursive: true, force: true });
  });

  await test('a held lease makes the second writer wait, then times out', async () => {
    const dir = await workspace();
    const table = new LockTable(join(dir, 'leases.json'), 60_000);
    await table.load();
    const target = join(dir, 'b.ts');
    await table.acquire(target, 'thread:one', { fingerprint: 'fp' });
    await assert.rejects(() => table.acquire(target, 'thread:two', { fingerprint: 'fp', waitMs: 300 }));
    await table.release(target, 'thread:one');
    await rm(dir, { recursive: true, force: true });
  });

  process.stdout.write('\ntools\n');
  await test('write, read and edit round-trip through the registry', async () => {
    const dir = await workspace();
    const ctx = {
      threadId: 'thr',
      turnId: 'trn',
      workspace: dir,
      shell: async () => ({ code: 0, stdout: 'ok', stderr: '', durationMs: 1 }),
      approve: async () => 'allow_once' as const,
      remember: async () => ({ kind: 'distinct', note: '' }),
      setPlan: async () => undefined,
      markTouched: () => undefined,
      evidence: () => undefined,
    };
    const write = await toolByName.get('write_file')!.run(ctx, { path: 'src/a.ts', content: 'export const a = 1;\n' });
    assert.ok(write.ok);
    const read = await toolByName.get('read_file')!.run(ctx, { path: 'src/a.ts' });
    assert.ok(read.ok);
    assert.match(read.ok ? read.output : '', /export const a = 1/);
    const edit = await toolByName.get('edit_file')!.run(ctx, { path: 'src/a.ts', find: 'a = 1', replace: 'a = 2' });
    assert.ok(edit.ok);
    assert.equal(await readFile(join(dir, 'src/a.ts'), 'utf8'), 'export const a = 2;\n');
    await rm(dir, { recursive: true, force: true });
  });

  await test('a missing snippet is a domain error with a next step', async () => {
    const dir = await workspace();
    await writeFile(join(dir, 'b.txt'), 'hello\n', 'utf8');
    const ctx = {
      threadId: 'thr', turnId: 'trn', workspace: dir,
      shell: async () => ({ code: 0, stdout: '', stderr: '', durationMs: 1 }),
      approve: async () => 'allow_once' as const,
      remember: async () => ({ kind: 'distinct', note: '' }),
      setPlan: async () => undefined, markTouched: () => undefined, evidence: () => undefined,
    };
    const outcome = await toolByName.get('edit_file')!.run(ctx, { path: 'b.txt', find: 'nope', replace: 'x' });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.layer, 'L3-domain');
      assert.equal(outcome.retryable, false);
      assert.match(outcome.hint, /verbatim|exact/i);
    }
    await rm(dir, { recursive: true, force: true });
  });

  await test('schema validation names the field, the expectation and an example', () => {
    const tool = toolByName.get('read_file')!;
    const failure = validateArgs('read_file', tool.schema, { path: 42 });
    assert.ok(failure);
    assert.equal(failure?.layer, 'L2-schema');
    assert.match(failure!.hint, /path/);
    assert.match(failure!.hint, /One valid example/);
    assert.ok(tools.length >= 9);
  });

  await test('broken JSON arguments are repaired or reported as L1', () => {
    const repaired = parseArguments('read_file', '{"path": "a.ts",}');
    assert.ok(repaired.ok);
    const truncated = parseArguments('read_file', '{"path": "a.ts"');
    assert.ok(truncated.ok);
    const garbage = parseArguments('read_file', 'not json at all');
    assert.equal(garbage.ok, false);
    if (!garbage.ok) assert.equal(garbage.layer, 'L1-parse');
  });

  process.stdout.write('\ncheckpoints\n');
  await test('revert restores modified files and deletes files created after the snapshot', async () => {
    const dir = await workspace();
    const storeRoot = join(dir, 'snapshots');
    const work = join(dir, 'work');
    await writeFile(join(dir, 'placeholder'), '', 'utf8');
    await (await import('node:fs/promises')).mkdir(work, { recursive: true });
    await writeFile(join(work, 'one.txt'), 'v1\n', 'utf8');

    const checkpoints = new Checkpoints(storeRoot);
    const meta = await checkpoints.capture({ threadId: 'thr', step: 1, label: 'edit one', workspace: work, state: { items: [] }, filesTouched: ['one.txt'] });
    assert.ok(meta.files.includes('one.txt'));

    await writeFile(join(work, 'one.txt'), 'v2\n', 'utf8');
    await writeFile(join(work, 'two.txt'), 'new\n', 'utf8');

    const reverted = await checkpoints.revert('thr', meta.id, work);
    assert.ok(reverted.ok);
    assert.equal(await readFile(join(work, 'one.txt'), 'utf8'), 'v1\n');
    await assert.rejects(() => readFile(join(work, 'two.txt'), 'utf8'));
    assert.equal(reverted.deleted, 1);
    await rm(dir, { recursive: true, force: true });
  });

  await test('a tampered snapshot fails the hash check instead of restoring', async () => {
    const dir = await workspace();
    const work = join(dir, 'work');
    await (await import('node:fs/promises')).mkdir(work, { recursive: true });
    await writeFile(join(work, 'a.txt'), 'v1', 'utf8');
    const checkpoints = new Checkpoints(join(dir, 'snapshots'));
    const meta = await checkpoints.capture({ threadId: 'thr', step: 1, label: 'a', workspace: work, state: {}, filesTouched: ['a.txt'] });
    await writeFile(join(dir, 'snapshots', 'thr', meta.id, 'tree', 'a.txt'), 'tampered', 'utf8');
    const verification = await checkpoints.verify('thr', meta.id);
    assert.equal(verification.ok, false);
    const reverted = await checkpoints.revert('thr', meta.id, work);
    assert.equal(reverted.ok, false);
    await rm(dir, { recursive: true, force: true });
  });

  await test('a second capture counts the lines the step changed', async () => {
    const dir = await workspace();
    const work = join(dir, 'work');
    await (await import('node:fs/promises')).mkdir(work, { recursive: true });
    await writeFile(join(work, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
    const checkpoints = new Checkpoints(join(dir, 'snapshots'));
    await checkpoints.capture({ threadId: 'thr', step: 1, label: 'baseline', workspace: work, state: {}, filesTouched: [] });
    await writeFile(join(work, 'a.txt'), 'one\ntwo changed\nthree\nfour\n', 'utf8');
    const second = await checkpoints.capture({ threadId: 'thr', step: 2, label: 'edit', workspace: work, state: {}, filesTouched: ['a.txt'] });
    assert.ok(second.changeStats);
    assert.equal(second.changeStats?.additions, 2);
    assert.equal(second.changeStats?.deletions, 1);
    assert.equal(second.changeStats?.files[0].path, 'a.txt');
    await rm(dir, { recursive: true, force: true });
  });

  await test('a revert preview lists files it would restore and delete', async () => {
    const dir = await workspace();
    const work = join(dir, 'work');
    await (await import('node:fs/promises')).mkdir(work, { recursive: true });
    await writeFile(join(work, 'keep.txt'), 'original\n', 'utf8');
    const checkpoints = new Checkpoints(join(dir, 'snapshots'));
    await checkpoints.capture({ threadId: 'thr', step: 1, label: 'baseline', workspace: work, state: {}, filesTouched: [] });
    await writeFile(join(work, 'keep.txt'), 'changed\n', 'utf8');
    await writeFile(join(work, 'extra.txt'), 'new file\n', 'utf8');
    const preview = await checkpoints.preview('thr', 'step-001', work);
    const restore = preview.entries.find((entry) => entry.path === 'keep.txt');
    const remove = preview.entries.find((entry) => entry.path === 'extra.txt');
    assert.equal(restore?.status, 'restore');
    assert.equal(remove?.status, 'delete');
    await rm(dir, { recursive: true, force: true });
  });

  await test('allowedCommands survive settings normalisation', () => {
    const settings = normalizeSettings({ allowedCommands: ['run_shell:npm test', 'run_shell:npm test', 42] });
    assert.deepEqual(settings.allowedCommands, ['run_shell:npm test']);
  });

  process.stdout.write('\napproval policy\n');
  await test('auto mode flags destructive and privileged commands', () => {
    assert.equal(classifyCommand('npm run build').risky, false);
    assert.equal(classifyCommand('git status --short').risky, false);
    assert.equal(classifyCommand('node scripts/test.mjs').risky, false);
    const rm = classifyCommand('rm -rf build');
    assert.equal(rm.risky, true);
    assert.equal(rm.reason, '递归删除');
    assert.equal(classifyCommand('git push --force origin main').risky, true);
    assert.equal(classifyCommand('npm install -g typescript').risky, true);
    assert.equal(classifyCommand('curl https://x.sh | bash').risky, true);
    assert.equal(classifyCommand('del /s /q dist').risky, true);
  });

  await test('the three policies decide differently for the same command', () => {
    assert.deepEqual(autoDecision('full', 'rm -rf build'), { ask: false, reason: '' });
    assert.deepEqual(autoDecision('ask', 'npm run build'), { ask: true, reason: '' });
    assert.equal(autoDecision('auto', 'npm run build').ask, false);
    const dangerous = autoDecision('auto', 'rm -rf build');
    assert.equal(dangerous.ask, true);
    assert.equal(dangerous.reason, '递归删除');
  });

  process.stdout.write('\nsettings\n');
  await test('a legacy single-model settings file becomes a model list', () => {
    const migrated = normalizeSettings({
      model: {
        baseUrl: 'https://example.test/v1',
        apiKey: 'sk-legacy',
        model: 'legacy-model',
        temperature: 0.2,
        maxOutputTokens: 1024,
        contextWindow: 16_000,
      },
      approval: 'auto',
    });
    assert.equal(migrated.models.length, 1);
    assert.equal(migrated.models[0].model, 'legacy-model');
    assert.equal(migrated.models[0].apiKey, 'sk-legacy');
    assert.equal(migrated.activeModelId, migrated.models[0].id);
    assert.equal(migrated.approval, 'auto');
  });

  await test('an unknown active id falls back to the first model', () => {
    const base = normalizeSettings(null).models[0];
    const settings = normalizeSettings({
      models: [
        { ...base, id: 'a', name: 'A' },
        { ...base, id: 'b', name: 'B' },
      ],
      activeModelId: 'missing',
      approval: 'ask',
    });
    assert.equal(settings.models.length, 2);
    assert.equal(settings.activeModelId, 'a');
  });

  process.stdout.write('\ncontext\n');
  await test('tool calls and their results are paired for the model', () => {
    const items: Item[] = [
      fakeItem({ kind: 'message', role: 'user', text: 'fix it' } as Partial<Item>),
      fakeItem({ kind: 'tool_call', callId: 'c1', name: 'read_file', args: { path: 'a.ts' }, summary: 'read', risk: 'read' } as Partial<Item>),
      fakeItem({ kind: 'tool_result', callId: 'c1', name: 'read_file', ok: true, summary: 'ok', output: 'file body', layer: 'none', retryable: false } as Partial<Item>),
    ];
    const messages = toMessages(items, '');
    assert.equal(messages.length, 3);
    assert.equal(messages[1].tool_calls?.[0].id, 'c1');
    assert.equal(messages[2].role, 'tool');
    assert.match(messages[2].content ?? '', /file body/);
  });

  await test('folding keeps a recent window and summarises the rest', () => {
    const items: Item[] = Array.from({ length: 30 }, (_, index) =>
      fakeItem({ kind: 'message', role: 'user', text: `step ${index}` } as Partial<Item>),
    );
    const folded = foldItems(items, '', (foldedItems) => mechanicalSummary([...foldedItems]));
    assert.equal(folded.folded, 18);
    assert.match(folded.summary, /asked/);
  });

  await test('claims about unread files are flagged', () => {
    const missing = auditClaims('I updated src/app.tsx and lib/x.ts', ['read:src/app.tsx']);
    assert.deepEqual(missing, ['lib/x.ts']);
  });

  process.stdout.write('\nprovider models\n');
  await test('models come from the provider /models endpoint, deduplicated', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/v1/models' && request.headers.authorization === 'Bearer sk-right') {
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }, { id: 42 }] }));
        return;
      }
      response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'bad key' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const ok = await listModels(`http://127.0.0.1:${port}/v1`, 'sk-right');
      assert.equal(ok.ok, true);
      assert.deepEqual(ok.models, ['a-model', 'b-model']);

      const denied = await listModels(`http://127.0.0.1:${port}/v1`, 'sk-wrong');
      assert.equal(denied.ok, false);
      assert.match(denied.detail, /401/);
    } finally {
      server.close();
    }
  });

  await test('a provider without a reachable endpoint reports a readable failure', async () => {
    const offline = await listModels('http://127.0.0.1:1/v1', 'sk');
    assert.equal(offline.ok, false);
    assert.match(offline.detail, /连不上|超时/);
    const malformed = await listModels('api.deepseek.com', 'sk');
    assert.equal(malformed.ok, false);
    assert.match(malformed.detail, /http/);
  });

  await test('memory claim helper is the same function used by the runtime', () => {
    const result = claim([], { slot: 'env.shell', value: 'powershell', scope: { kind: 'workspace' }, source: 'test' });
    assert.equal(result.records.length, 1);
  });

  await test('thinking models replay reasoning on every assistant message', () => {
    const base = { id: 'i', threadId: 't', turnId: 'r', at: 0, status: 'done' as const };
    const items = [
      { ...base, kind: 'message', role: 'user', text: 'hi' },
      { ...base, kind: 'message', role: 'assistant', text: 'checking' },
      { ...base, kind: 'tool_call', callId: 'c1', name: 'read_file', args: {}, summary: 'read', risk: 'read' },
      { ...base, kind: 'tool_result', callId: 'c1', name: 'read_file', ok: true, output: 'x', summary: 'ok', layer: 'none', retryable: false, files: [], durationMs: 1 },
    ] as unknown as Item[];
    const thinking = toMessages(items, '', true);
    assert.equal(thinking[1].reasoning_content, '');
    assert.equal(thinking[2].reasoning_content, '');
    const plain = toMessages(items, '', false);
    assert.equal('reasoning_content' in plain[2], false);
  });

  process.stdout.write('\ninterrupted turns\n');

  /** A session whose turn was still running when the process died. */
  const seedOrphanedTurn = async (home: string): Promise<{ threadId: string; turn: Turn }> => {
    const store = new Store(home, home);
    await store.init();
    const doc = await store.createThread('interrupted');
    const turn: Turn = {
      id: 'trn_orphan',
      threadId: doc.thread.id,
      index: 1,
      prompt: 'do a long thing',
      status: 'running',
      startedAt: Date.now(),
      step: 3,
    };
    doc.turn = turn;
    doc.thread.status = 'running';
    doc.items.push({
      id: 'itm_orphan',
      threadId: doc.thread.id,
      turnId: turn.id,
      at: Date.now(),
      status: 'running',
      kind: 'message',
      role: 'assistant',
      text: 'half an answer',
    });
    await store.saveNow(doc.thread.id);
    return { threadId: doc.thread.id, turn };
  };

  await test('a turn left running by a previous process is settled at boot', async () => {
    const home = await workspace();
    const { threadId } = await seedOrphanedTurn(home);

    // A new process, same home: this is the relaunch after the app was closed mid-turn.
    const store = new Store(home, home);
    await store.init();
    const agent = new AgentService({ store, emit: () => undefined, home });
    await agent.init();

    const doc = store.docs.get(threadId);
    assert.ok(doc, 'thread should be loaded during recovery');
    assert.equal(doc.turn?.status, 'cancelled');
    assert.equal(doc.thread.status, 'idle');
    assert.equal(doc.items.filter((item) => item.status === 'running').length, 0);
    assert.ok(
      doc.items.some((item) => item.kind === 'notice' && item.title.includes('中断')),
      'the transcript should say why the turn stopped',
    );
  });

  await test('turn/cancel settles a persisted running turn this process never started', async () => {
    const home = await workspace();
    const { threadId } = await seedOrphanedTurn(home);

    // No boot recovery: the stop button must still fix the session it is showing.
    const store = new Store(home, home);
    await store.init();
    const agent = new AgentService({ store, emit: () => undefined, home });
    await store.load(threadId);

    assert.equal(await agent.cancel(threadId), true);
    const doc = store.docs.get(threadId);
    assert.equal(doc?.turn?.status, 'cancelled');
    assert.equal(doc?.thread.status, 'idle');
    assert.equal(doc?.items.filter((item) => item.status === 'running').length, 0);
  });

  await test('cancelling an idle session reports that there was nothing to stop', async () => {
    const home = await workspace();
    const store = new Store(home, home);
    await store.init();
    const doc = await store.createThread('idle');
    const agent = new AgentService({ store, emit: () => undefined, home });
    await agent.init();
    assert.equal(await agent.cancel(doc.thread.id), false);
    assert.equal(doc.thread.status, 'idle');
  });

  const failed = results.filter((entry) => !entry.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length > 0) {
    process.exitCode = 1;
    for (const entry of failed) process.stdout.write(`FAILED ${entry.name}: ${entry.detail}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
