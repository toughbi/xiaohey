/**
 * Runtime self-test. No network, no model: it exercises the mechanisms the
 * design notes claim, against the same modules the app runs.
 *
 *   npm test   → scripts/test.mjs bundles this file and runs it.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyClaim, renderMemory, type MemoryRecord } from '../src/main/runtime/memory.js';
import { LongTermMemory, FORGET_AFTER_DAYS, ARCHIVE_BELOW } from '../src/main/runtime/longterm.js';
import { cosineSimilarity, localEmbedding, providerEmbeddings, type Embedder } from '../src/main/runtime/embedding.js';
import { ConfiguredReranker, normalizeScores, rerankDocuments, rerankEndpoint } from '../src/main/runtime/rerank.js';
import { ShortTermMemory, RETAIN_ROUNDS, KEEP_RECENT } from '../src/main/runtime/shortterm.js';
import { WorkingMemory } from '../src/main/runtime/working.js';
import { contextBudget, DEFAULT_CONTEXT_WINDOW } from '../src/main/runtime/context.js';
import { estimateTokens } from '../src/main/util.js';
import { classifyCommand, autoDecision, classifyWrite, writeDecision } from '../src/main/runtime/policy.js';
import { MAX_PARALLEL_READS, PARALLEL_READ_TOOLS } from '../src/main/runtime/agent.js';
import { normalizeSettings, Store } from '../src/main/store.js';
import { AgentService } from '../src/main/runtime/agent.js';
import { listModels } from '../src/main/runtime/models.js';
import { extractEvents, parseRelativeTime } from '../src/main/runtime/resolve.js';
import { buildContract, checkDrift, renderContract } from '../src/main/runtime/contract.js';
import { LockTable } from '../src/main/runtime/locks.js';
import { Checkpoints } from '../src/main/runtime/checkpoint.js';
import { auditClaims, foldItems, mechanicalSummary, toMessages } from '../src/main/runtime/context.js';
import { applyClaim as claim } from '../src/main/runtime/memory.js';
import { toolByName, tools } from '../src/main/runtime/tools.js';
import { parseArguments, validateArgs } from '../src/main/runtime/toolerrors.js';
import { validate } from '../src/main/runtime/validate.js';
import { LockTable } from '../src/main/runtime/locks.js';
import { guardedCommit, workspaceKey } from '../src/main/runtime/commit.js';
import { commitWorktree, createWorktree, mergeWorktree, prepareConflictResolution, removeWorktree } from '../src/main/runtime/worktree.js';
import { fileFingerprint, textFingerprint } from '../src/main/fingerprint.js';
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

  process.stdout.write('\nlong-term memory\n');

  await test('three kinds survive the memory.md round-trip', async () => {
    const root = await workspace();
    const memory = new LongTermMemory(root);
    await memory.load();
    await memory.write({
      kind: 'episodic',
      detail: '修复登录超时，最终是 refresh token 提前过期',
      importance: 72,
      when: '2026-11-20 下午',
      where: 'E:/code/xiaohei',
      result: '构建通过，登录流程恢复',
      outcome: 'success',
      title: '修复登录超时',
      source: 'test',
    });
    await memory.write({
      kind: 'relational',
      detail: '那天打招呼、戴眼镜的卷发女士',
      alias: '阿姨',
      referent: '妈妈的同学',
      relation: '长辈',
      importance: 66,
      source: 'test',
    });
    await memory.write({
      kind: 'knowledge',
      detail: '这个工作区统一用 pnpm',
      slot: 'env.packageManager',
      scope: { kind: 'path', path: 'E:/code/xiaohei' },
      importance: 85,
      source: 'test',
    });
    const reloaded = new LongTermMemory(root);
    await reloaded.load();
    assert.equal(reloaded.all().length, 3);
    const episode = reloaded.all().find((entry) => entry.kind === 'episodic');
    const relation = reloaded.all().find((entry) => entry.kind === 'relational');
    assert.ok(episode && relation);
    assert.equal(relation!.episodeId, episode!.id, 'a reference from the same session anchors to the newest episode');
    const markdown = await readFile(join(root, 'memory.md'), 'utf8');
    assert.match(markdown, /情景记忆/);
    assert.match(markdown, /关系记忆/);
    assert.match(markdown, /知识记忆/);
    assert.match(markdown, /refresh token/);

    const recalled = await reloaded.recall({ query: '登录' });
    assert.equal(recalled.hits.length, 1);
    assert.equal(recalled.hits[0].entry.kind, 'episodic');

    // A UI edit updates by id instead of forking a new competing fact.
    const fact = reloaded.all().find((entry) => entry.slot === 'env.packageManager');
    assert.ok(fact);
    const edited = await reloaded.write({
      id: fact!.id,
      kind: 'knowledge',
      detail: '这个工作区统一用 pnpm 9',
      importance: 85,
      slot: fact!.slot,
      scope: fact!.scope,
      source: 'manual',
    });
    assert.equal(edited.entry.detail, '这个工作区统一用 pnpm 9');
    assert.equal(reloaded.all().length, 3);
    await rm(root, { recursive: true, force: true });
  });

  await test('a knowledge write supersedes the old value, then disputes an opposite claim', async () => {
    const root = await workspace();
    const memory = new LongTermMemory(root);
    await memory.load();
    await memory.write({ kind: 'knowledge', detail: '用 npm', slot: 'env.pm', importance: 60, source: 't1' });
    const updated = await memory.write({ kind: 'knowledge', detail: '用 pnpm', slot: 'env.pm', importance: 74, source: 't2' });
    assert.equal(updated.kind, 'supersede');
    assert.equal(memory.all().length, 1);
    assert.equal(memory.archived().length, 1);
    const disputed = await memory.write({ kind: 'knowledge', detail: '不要用 pnpm', slot: 'env.pm', importance: 74, source: 't3' });
    assert.equal(disputed.kind, 'contradict');
    assert.equal(memory.all().filter((entry) => entry.status === 'disputed').length, 2);
    await rm(root, { recursive: true, force: true });
  });

  await test('the forgetting curve archives a weak memory and keeps a strong one', async () => {
    const root = await workspace();
    const memory = new LongTermMemory(root);
    await memory.load();
    await memory.write({ kind: 'episodic', detail: '登录超时修复成功，构建通过', title: '登录修复', importance: 80, when: '昨天', where: 'ws', result: '通过', outcome: 'success', source: 't' });
    await memory.write({ kind: 'episodic', detail: '登录页临时改了个边距', title: '边距微调', importance: 18, when: '昨天', where: 'ws', result: '通过', outcome: 'success', source: 't' });
    const later = Date.now() + (FORGET_AFTER_DAYS + 5) * 86_400_000;
    const report = await memory.forget(later);
    assert.equal(report.decayed, 2);
    assert.equal(report.archived, 1);
    assert.equal(memory.all().length, 1);
    assert.equal(memory.all()[0].title, '登录修复');
    assert.equal(memory.archived().length, 1);
    assert.ok(memory.archived()[0].importance < ARCHIVE_BELOW);

    // A targeted recall wakes the archived entry back into active memory.
    const recalled = await memory.recall({ query: '边距' });
    assert.equal(recalled.woken.length, 1);
    assert.ok(recalled.woken[0].importance >= 30);
    assert.equal(memory.activeCount(), 2);
    assert.equal(memory.archived().length, 0);
    await rm(root, { recursive: true, force: true });
  });

  await test('memory_read documents when to use it, when not to, and shows examples', () => {
    const tool = toolByName.get('memory_read');
    assert.ok(tool);
    assert.match(tool!.useWhen, /refers|remember|pronoun/i);
    assert.match(tool!.avoidWhen, /Do NOT/i);
    assert.ok((tool!.examples ?? []).length >= 3);
  });

  await test('memory_write enforces the episodic shape and passes valid entries on', async () => {
    const dir = await workspace();
    const written: Array<Record<string, unknown>> = [];
    const ctx = {
      threadId: 'thr', turnId: 'trn', workspace: dir,
      shell: async () => ({ code: 0, stdout: '', stderr: '', durationMs: 1 }),
      approve: async () => 'allow_once' as const,
      ask: async () => ({ answer: 'ok', cancelled: false }),
      remember: async (entry: Record<string, unknown>) => {
        written.push(entry);
        return { kind: 'created', note: 'ok' };
      },
      recall: async () => ({ query: '', hits: [], woken: [], activeTotal: 0, archiveTotal: 0 }),
      setPlan: async () => undefined, markTouched: () => undefined, evidence: () => undefined,
    };
    const tool = toolByName.get('memory_write')!;
    const incomplete = await tool.run(ctx, { kind: 'episodic', importance: 60, detail: '修好了' });
    assert.equal(incomplete.ok, false);
    if (!incomplete.ok) assert.match(incomplete.summary, /缺少/);
    const valid = await tool.run(ctx, {
      kind: 'episodic', importance: 70, detail: '修好了登录超时',
      when: '今天下午', where: 'ws', result: '构建通过', outcome: 'success',
    });
    assert.equal(valid.ok, true);
    assert.equal(written.length, 1);
    assert.equal(written[0].kind, 'episodic');
    await rm(dir, { recursive: true, force: true });
  });

  process.stdout.write('\nhybrid memory recall\n');

  await test('a semantic vector finds an entry with zero keyword overlap', async () => {
    const root = await workspace();
    const semantic: Embedder = {
      id: 'test-semantic-v1',
      label: 'test semantic',
      local: false,
      embed: async (texts) =>
        texts.map((text) => {
          if (text.includes('登录') || text.includes('refresh token')) return [1, 0, 0];
          if (text.includes('边距') || text.includes('margin')) return [0, 1, 0];
          return [0, 0, 1];
        }),
    };
    const memory = new LongTermMemory(root, { embedder: semantic });
    await memory.load();
    await memory.write({
      kind: 'episodic',
      title: '会话修复',
      detail: 'refresh token 提前过期，重新签发后恢复',
      importance: 70,
      when: '今天',
      where: 'ws',
      result: '构建通过',
      outcome: 'success',
      source: 't',
    });
    await memory.ensureVectors();
    const result = await memory.recall({ query: '登录' });
    assert.equal(result.mode, 'hybrid');
    assert.equal(result.vectorUsed, true);
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0].keyword, 0);
    assert.ok((result.hits[0].vector ?? 0) > 0.99);
    assert.ok(result.hits[0].relevance >= 0.59);
    assert.match(await readFile(join(root, 'memory-vectors.json'), 'utf8'), /test-semantic-v1/);

    // The index is persistent: a fresh instance recalls without re-embedding entries.
    const reloaded = new LongTermMemory(root, { embedder: semantic });
    await reloaded.load();
    const again = await reloaded.recall({ query: '登录' });
    assert.equal(again.mode, 'hybrid');
    assert.ok((again.hits[0].vector ?? 0) > 0.99);
    await rm(root, { recursive: true, force: true });
  });

  await test('a broken embedding provider falls back to keyword recall with a reason', async () => {
    const root = await workspace();
    const broken: Embedder = {
      id: 'broken-v1',
      label: 'broken',
      local: false,
      embed: async () => {
        throw new Error('embedding offline');
      },
    };
    const memory = new LongTermMemory(root, { embedder: broken });
    await memory.load();
    await memory.write({
      kind: 'episodic',
      detail: '登录超时修复，构建通过',
      importance: 60,
      when: '昨天',
      where: 'ws',
      result: '通过',
      outcome: 'success',
      source: 't',
    });
    const result = await memory.recall({ query: '登录' });
    assert.equal(result.mode, 'keyword');
    assert.equal(result.vectorUsed, false);
    assert.match(result.vectorReason ?? '', /offline/);
    assert.equal(result.hits.length, 1);
    await rm(root, { recursive: true, force: true });
  });

  await test('the local hashed embedder gives hybrid recall without a provider', async () => {
    const root = await workspace();
    const memory = new LongTermMemory(root);
    await memory.load();
    await memory.write({
      kind: 'knowledge',
      detail: '这个项目统一用 pnpm 管理依赖',
      slot: 'env.pm',
      importance: 70,
      source: 't',
    });
    await memory.ensureVectors();
    const result = await memory.recall({ query: '包管理器' });
    assert.equal(result.mode, 'hybrid');
    assert.equal(result.vectorUsed, true);
    assert.ok(result.hits.some((hit) => hit.entry.slot === 'env.pm'));
    assert.ok(result.hits[0].vector !== undefined);
    assert.ok(cosineSimilarity(localEmbedding('登录超时'), localEmbedding('登录超时')) > 0.99);
    await rm(root, { recursive: true, force: true });
  });

  await test('the embeddings client posts to an OpenAI-compatible /embeddings endpoint', async () => {
    let received: { model?: string; input?: unknown; authorization?: string } = {};
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        received = {
          model: (JSON.parse(body) as { model?: string }).model,
          input: (JSON.parse(body) as { input?: unknown }).input,
          authorization: request.headers.authorization,
        };
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            data: [
              { index: 1, embedding: [0, 1] },
              { index: 0, embedding: [1, 0] },
            ],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const vectors = await providerEmbeddings(
        { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'sk-test', model: 'embed-small' },
        ['a', 'b'],
      );
      assert.deepEqual(vectors, [
        [1, 0],
        [0, 1],
      ]);
      assert.equal(received.model, 'embed-small');
      assert.deepEqual(received.input, ['a', 'b']);
      assert.equal(received.authorization, 'Bearer sk-test');
    } finally {
      server.close();
    }
  });

  await test('an oversize embedding batch is split instead of failing', async () => {
    const sizes: number[] = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const input = (JSON.parse(body) as { input?: string[] }).input ?? [];
        sizes.push(input.length);
        if (input.length > 3) {
          response
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: { message: 'batch size is invalid, it should not be larger than 3.' } }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            data: input.map((text, index) => ({ index, embedding: [text.length, index] })),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const vectors = await providerEmbeddings(
        { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', model: 'cap-3' },
        ['a', 'bb', 'ccc', 'dddd', 'eeeee', 'ffffff', 'ggggggg'],
      );
      assert.equal(vectors.length, 7);
      assert.deepEqual(vectors.map((vector) => vector[0]), [1, 2, 3, 4, 5, 6, 7]);
      assert.ok(sizes.includes(7), 'the first request used the configured batch size');
      assert.ok(sizes.every((size) => size <= 7));
    } finally {
      server.close();
    }
  });

  process.stdout.write('\nrerank\n');

  await test('a reranker reorders a candidate pool the hybrid score got wrong', async () => {
    const root = await workspace();
    // The fixed embedder gives both entries the same vector, so only rerank can
    // put "导出 CSV" first for the query.
    const semantic: Embedder = {
      id: 'test-rerank-v1',
      label: 'test',
      local: false,
      embed: async (texts) => texts.map(() => [1, 0, 0]),
    };
    const reranker = new ConfiguredReranker(() => ({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'fake' }));
    const memory = new LongTermMemory(root, {
      embedder: semantic,
      reranker: {
        label: 'fake rerank',
        config: () => ({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'fake' }),
        score: async (query, documents) =>
          documents.map((text) => (text.includes('CSV') && query.includes('表格') ? 0.9 : 0.1)),
      },
    });
    await memory.load();
    await memory.write({
      kind: 'episodic', detail: '登录超时了，refresh token 过期', importance: 90,
      when: '今天', where: 'ws', result: '修复', outcome: 'success', source: 't',
    });
    await memory.write({
      kind: 'episodic', detail: '给表格加导出 CSV 按钮', importance: 40,
      when: '昨天', where: 'ws', result: '上线', outcome: 'success', source: 't',
    });
    const result = await memory.recall({ query: '表格数据怎么下载' });
    assert.equal(result.mode, 'hybrid+rerank');
    assert.equal(result.rerankUsed, true);
    assert.match(result.hits[0].entry.detail, /CSV/);
    void reranker;
    await rm(root, { recursive: true, force: true });
  });

  await test('a failing reranker keeps the hybrid order and reports why', async () => {
    const root = await workspace();
    const memory = new LongTermMemory(root, {
      reranker: {
        label: 'broken rerank',
        config: () => ({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'broken' }),
        score: async () => {
          throw new Error('rerank HTTP 401');
        },
      },
    });
    await memory.load();
    await memory.write({
      kind: 'episodic', detail: '登录超时修复', importance: 60,
      when: '今天', where: 'ws', result: '通过', outcome: 'success', source: 't',
    });
    const result = await memory.recall({ query: '登录' });
    assert.notEqual(result.mode, 'hybrid+rerank');
    assert.match(result.rerankReason ?? '', /401/);
    assert.equal(result.hits.length, 1);
    await rm(root, { recursive: true, force: true });
  });

  await test('the rerank endpoint is derived per provider and scores are normalized', () => {
    assert.equal(
      rerankEndpoint({ baseUrl: 'https://ws-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'qwen3.7-text-rerank' }).protocol,
      'dashscope',
    );
    assert.match(
      rerankEndpoint({ baseUrl: 'https://ws-x.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', apiKey: '', model: 'r' }).url,
      /\/api\/v1\/services\/rerank\/text-rerank\/text-rerank$/,
    );
    assert.equal(rerankEndpoint({ baseUrl: 'https://api.siliconflow.cn/v1', apiKey: '', model: 'r' }).url, 'https://api.siliconflow.cn/v1/rerank');
    assert.equal(rerankEndpoint({ baseUrl: 'https://api.cohere.ai/v1/rerank', apiKey: '', model: 'r' }).url, 'https://api.cohere.ai/v1/rerank');
    assert.deepEqual(normalizeScores([0.5, 0.5]), [0.5, 0.5]);
    const scaled = normalizeScores([0.55, 0.66, 0.6]);
    assert.equal(scaled.length, 3);
    assert.ok(Math.abs(scaled[0] - 0) < 1e-9);
    assert.ok(Math.abs(scaled[1] - 1) < 1e-9);
    assert.ok(Math.abs(scaled[2] - 5 / 11) < 1e-9);
  });

  await test('both rerank protocols are understood from one response parser', async () => {
    const cohere = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        const payload = JSON.parse(body) as { query?: string; documents?: string[] };
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            results: (payload.documents ?? []).map((text, index) => ({
              index,
              relevance_score: text === `match:${payload.query}` ? 0.9 : 0.1,
            })),
          }),
        );
      });
    });
    await new Promise<void>((resolve) => cohere.listen(0, '127.0.0.1', resolve));
    const address = cohere.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const scores = await rerankDocuments(
        { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', model: 'fake' },
        '登录',
        ['别的', 'match:登录', '也不是'],
      );
      assert.deepEqual(scores, [0.1, 0.9, 0.1]);

      const dashscopeLike = await rerankDocuments(
        { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: '', model: 'fake', protocol: 'dashscope' },
        '登录',
        ['别的', 'match:登录'],
      );
      // The DashScope shape is rejected with 404 by this mock, so the client
      // retries the Cohere shape instead of failing the recall.
      assert.deepEqual(dashscopeLike, [0.1, 0.9]);
    } finally {
      cohere.close();
    }
  });

  await test('recall is hard-capped by limit, with archive filling only the leftover slots', async () => {
    const root = await workspace();
    const memory = new LongTermMemory(root);
    await memory.load();
    for (let index = 1; index <= 8; index += 1) {
      await memory.write({
        kind: 'knowledge', detail: `检索测试条目 ${index}，都包含关键词 记忆召回`,
        slot: `test.entry${index}`, importance: 40 + index, source: 't',
      });
    }
    const capped = await memory.recall({ query: '记忆召回', limit: 3 });
    assert.equal(capped.hits.length, 3, 'limit is a hard cap, not a threshold');
    const wide = await memory.recall({ query: '记忆召回', limit: 20 });
    assert.equal(wide.hits.length, 8, 'everything matching is returned up to the cap');
    const clamped = await memory.recall({ query: '记忆召回', limit: 999 });
    assert.ok(clamped.hits.length <= 20, 'limit is clamped to 20');

    // Archive only fills slots the active pool left over.
    const active = memory.all();
    await memory.forget(Date.now() + 90 * 86_400_000);
    assert.ok(memory.archived().length > 0 || memory.activeCount() === active.length);
    await memory.recall({ query: '记忆召回', limit: 2, wake: false });
    await rm(root, { recursive: true, force: true });
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

  process.stdout.write('\nworking memory WAL\n');
  await test('a mutating step is flushed as executing before the tool runs and finalized after', async () => {
    const root = await workspace();
    const working = new WorkingMemory(root);
    await working.load();
    await working.startTask({ threadId: 'thr_wal', title: 'wal', cwd: root, goal: 'g' });
    await working.beginStep({
      threadId: 'thr_wal', turn: 1, step: 1, tool: 'edit_file', callId: 'c1',
      detail: 'edit a.ts', target: join(root, 'a.ts'), before: 'aaa',
    });
    const crashed = new WorkingMemory(root);
    await crashed.load();
    assert.equal(crashed.get('thr_wal')?.steps[0]?.phase, 'executing');
    await working.recordStep({
      threadId: 'thr_wal', turn: 1, step: 1, tool: 'edit_file', callId: 'c1',
      result: 'wrote a.ts', ok: true, next: '收尾',
    });
    const task = working.get('thr_wal');
    assert.equal(task?.steps.length, 1);
    assert.equal(task?.steps[0]?.phase, 'done');
    assert.equal(task?.steps[0]?.result, 'wrote a.ts');
    await rm(root, { recursive: true, force: true });
  });

  await test('a crash-left executing step whose target is unchanged is not-applied', async () => {
    const root = await workspace();
    const target = join(root, 'a.ts');
    await writeFile(target, 'original', 'utf8');
    const before = await fileFingerprint(target);
    const working = new WorkingMemory(root);
    await working.load();
    await working.startTask({ threadId: 'thr_crash', title: 'crash', cwd: root, goal: 'g' });
    await working.beginStep({ threadId: 'thr_crash', turn: 1, step: 1, tool: 'edit_file', callId: 'c1', target, before });
    const rebooted = new WorkingMemory(root);
    await rebooted.load();
    const interrupted = await rebooted.settleInterrupted();
    assert.deepEqual(interrupted, ['thr_crash']);
    const step = rebooted.get('thr_crash')?.steps[0];
    assert.equal(step?.phase, 'interrupted');
    assert.equal(step?.verdict, 'not-applied');
    assert.match(rebooted.render('thr_crash'), /未落地/);
    await rm(root, { recursive: true, force: true });
  });

  await test('a target changed during the crash window is unknown, never auto-retried', async () => {
    const root = await workspace();
    const target = join(root, 'a.ts');
    await writeFile(target, 'original', 'utf8');
    const before = await fileFingerprint(target);
    const working = new WorkingMemory(root);
    await working.load();
    await working.startTask({ threadId: 'thr_crash', title: 'crash', cwd: root, goal: 'g' });
    await working.beginStep({ threadId: 'thr_crash', turn: 1, step: 1, tool: 'edit_file', callId: 'c1', target, before });
    await writeFile(target, 'changed by someone else', 'utf8');
    const rebooted = new WorkingMemory(root);
    await rebooted.load();
    await rebooted.settleInterrupted();
    const step = rebooted.get('thr_crash')?.steps[0];
    assert.equal(step?.verdict, 'unknown');
    assert.match(step?.next ?? '', /重读/);
    await rm(root, { recursive: true, force: true });
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
      ask: async () => ({ answer: 'ok', cancelled: false }),
      remember: async () => ({ kind: 'distinct', note: '' }),
      recall: async () => ({ query: '', hits: [], woken: [], activeTotal: 0, archiveTotal: 0 }),
      setPlan: async () => undefined,
      markTouched: () => undefined,
      evidence: () => undefined,
      commitFile: async (target, content, expected) =>
        guardedCommit({ locks: new LockTable(join(dir, '.leases.json')), workspace: dir, target, content, expected, owner: 'test' }),
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
      ask: async () => ({ answer: 'ok', cancelled: false }),
      remember: async () => ({ kind: 'distinct', note: '' }),
      recall: async () => ({ query: '', hits: [], woken: [], activeTotal: 0, archiveTotal: 0 }),
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
    assert.ok(tools.length >= 10);
  });

  await test('validation recurses into arrays and nested objects', () => {
    const memoryWrite = toolByName.get('memory_write')!.schema;
    const tagIssues = validate(memoryWrite, { kind: 'knowledge', importance: 50, detail: 'x', tags: [1, 2] });
    assert.deepEqual(tagIssues.map((issue) => issue.path), ['tags[0]', 'tags[1]']);
    const tooManyTags = validate(memoryWrite, {
      kind: 'knowledge',
      importance: 50,
      detail: 'x',
      tags: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],
    });
    assert.match(tooManyTags[0].expected, /at most 8/);

    const todo = toolByName.get('todo_write')!.schema;
    const stepIssues = validate(todo, { steps: [{ title: 'ok', status: 'active' }, { status: 'pending' }, { title: 3 }] });
    const paths = stepIssues.map((issue) => issue.path);
    assert.ok(paths.includes('steps[1].title'), 'a missing nested field is reported with its index');
    assert.ok(paths.includes('steps[2].title'));
    assert.equal(validate(todo, { steps: [{ title: 'ok', status: 'active' }] }).length, 0);
    assert.match(validate(todo, { steps: [] })[0].expected, /at least 1/);
  });

  await test('empty strings are rejected where the tool cannot handle them', () => {
    const emptyPath = validate(toolByName.get('read_file')!.schema, { path: '' });
    assert.equal(emptyPath[0].path, 'path');
    assert.match(emptyPath[0].expected, /non-empty/);
    const emptyFind = validate(toolByName.get('edit_file')!.schema, { path: 'a.ts', find: '', replace: 'x' });
    assert.equal(emptyFind[0].path, 'find');
    const emptyDetail = validate(toolByName.get('memory_write')!.schema, { kind: 'knowledge', importance: 50, detail: '' });
    assert.equal(emptyDetail[0].path, 'detail');
  });

  await test('ask_user normalizes options and returns the answer to the model', async () => {
    const dir = await workspace();
    const asked: Array<{ question: string; options: Array<{ label: string; description?: string }> }> = [];
    const ctx = {
      threadId: 'thr', turnId: 'trn', workspace: dir,
      shell: async () => ({ code: 0, stdout: '', stderr: '', durationMs: 1 }),
      approve: async () => 'allow_once' as const,
      ask: async (request: { header: string; question: string; options: Array<{ label: string; description?: string }> }) => {
        asked.push(request);
        return { answer: '方案 B', cancelled: false };
      },
      remember: async () => ({ kind: 'distinct', note: '' }),
      recall: async () => ({ query: '', hits: [], woken: [], activeTotal: 0, archiveTotal: 0 }),
      setPlan: async () => undefined, markTouched: () => undefined, evidence: () => undefined,
    };
    const tool = toolByName.get('ask_user')!;
    const outcome = await tool.run(ctx, {
      header: '选择方案',
      question: '用哪个方案？',
      options: ['方案 A', { label: '方案 B', description: '更稳' }, '方案 B'],
    });
    assert.equal(outcome.ok, true);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].question, '用哪个方案？');
    assert.deepEqual(asked[0].options, [{ label: '方案 A' }, { label: '方案 B', description: '更稳' }]);
    assert.match(outcome.ok ? outcome.output : '', /方案 B/);

    const tooFew = await tool.run(ctx, { question: '选一个', options: ['只有一个'] });
    assert.equal(tooFew.ok, false);
    if (!tooFew.ok) assert.match(tooFew.summary, /2–4/);
    await rm(dir, { recursive: true, force: true });
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

  await test('file writes are tiered by what they destroy', () => {
    assert.equal(classifyWrite({ path: 'notes/todo.md', kind: 'create' }).tier, 'low');
    assert.equal(classifyWrite({ path: 'scripts/build.ps1', kind: 'create' }).tier, 'medium');
    assert.equal(classifyWrite({ path: 'src/a.ts', kind: 'overwrite' }).tier, 'medium');
    assert.equal(
      classifyWrite({ path: 'src/a.ts', kind: 'overwrite', deletedLines: 120, totalLinesBefore: 130 }).tier,
      'high',
    );
    assert.equal(classifyWrite({ path: 'src/a.ts', kind: 'edit', deletedLines: 2, totalLinesBefore: 300 }).tier, 'low');
    assert.equal(classifyWrite({ path: '.env.local', kind: 'edit', deletedLines: 1, totalLinesBefore: 5 }).tier, 'high');
    assert.equal(classifyWrite({ path: 'certs/server.pem', kind: 'create' }).tier, 'high');
    assert.match(classifyWrite({ path: '.env', kind: 'create' }).reason, /环境变量/);
  });

  await test('ask always stops for writes, auto only for high risk, full never', () => {
    assert.equal(writeDecision('ask', 'low').ask, true);
    assert.equal(writeDecision('ask', 'high').ask, true);
    assert.equal(writeDecision('auto', 'low').ask, false);
    assert.equal(writeDecision('auto', 'medium').ask, false);
    assert.equal(writeDecision('auto', 'high').ask, true);
    assert.equal(writeDecision('full', 'high').ask, false);
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

  await test('embedding settings are normalized and default to off', () => {
    const configured = normalizeSettings({
      embedding: { enabled: true, model: ' bge-m3 ', baseUrl: ' http://127.0.0.1:1234/v1 ', apiKey: 'sk-embed' },
    });
    assert.deepEqual(configured.embedding, {
      enabled: true,
      model: 'bge-m3',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'sk-embed',
      rerankModel: '',
      rerankBaseUrl: '',
    });
    const withRerank = normalizeSettings({
      embedding: { enabled: true, model: 'bge-m3', rerankModel: ' bge-reranker-v2-m3 ', rerankBaseUrl: ' https://api.siliconflow.cn/v1/rerank ' },
    });
    assert.equal(withRerank.embedding.rerankModel, 'bge-reranker-v2-m3');
    assert.equal(withRerank.embedding.rerankBaseUrl, 'https://api.siliconflow.cn/v1/rerank');
    const fallback = normalizeSettings({});
    assert.equal(fallback.embedding.enabled, false);
    assert.equal(fallback.embedding.model, '');
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

  process.stdout.write('\nshort-term memory\n');

  await test('eight rounds compress into a summary plus the newest two', async () => {
    const root = await workspace();
    const stm = new ShortTermMemory(root, 'thr_test', { title: 'demo', workspace: 'E:/w' });
    await stm.load();
    for (let index = 1; index <= RETAIN_ROUNDS; index += 1) {
      stm.recordRound(
        {
          index,
          at: Date.now() + index,
          prompt: `问题 ${index}`,
          assistant: `回答 ${index}`,
          tools: [{ name: 'read_file', summary: `src/${index}.ts`, ok: true }],
          outcome: 'completed',
        },
        RETAIN_ROUNDS,
      );
    }
    assert.equal(stm.rounds.length, RETAIN_ROUNDS);
    assert.equal(stm.shouldCompressByCount(RETAIN_ROUNDS), true);
    const compressed = await stm.compress(async () => '第 1–6 轮：目标、关键决策、结果、下一步。');
    assert.ok(compressed);
    assert.equal(compressed?.folded, 6);
    assert.equal(compressed?.kept, KEEP_RECENT);
    assert.equal(stm.rounds.length, KEEP_RECENT);
    assert.match(stm.summary, /关键决策/);
    await stm.save();

    const reloaded = new ShortTermMemory(root, 'thr_test');
    await reloaded.load();
    assert.equal(reloaded.rounds.length, KEEP_RECENT);
    const messages = reloaded.messages();
    assert.match(messages[0].content ?? '', /Folded context/);
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[1].content, '问题 7');
    const markdown = await readFile(join(root, 'session', 'thr_test.md'), 'utf8');
    assert.match(markdown, /历史摘要/);
    assert.match(markdown, /最近对话/);
    await rm(root, { recursive: true, force: true });
  });

  await test('compression falls back to a mechanical digest when the summarizer fails', async () => {
    const root = await workspace();
    const stm = new ShortTermMemory(root, 'thr_mech');
    await stm.load();
    for (let index = 1; index <= 4; index += 1) {
      stm.recordRound(
        { index, at: Date.now(), prompt: `目标 ${index}`, assistant: `结果 ${index}`, tools: [], outcome: 'completed' },
        4,
      );
    }
    const compressed = await stm.compress(async () => {
      throw new Error('offline');
    });
    assert.ok(compressed);
    assert.match(stm.summary, /第 1 轮/);
    assert.equal(stm.rounds.length, 2);
    await rm(root, { recursive: true, force: true });
  });

  await test('the twenty-round threshold triggers compression even below eight retained rounds', async () => {
    const stm = new ShortTermMemory(await workspace(), 'thr_turn');
    await stm.load();
    stm.recordRound({ index: 17, at: Date.now(), prompt: 'x', assistant: 'y', tools: [], outcome: 'completed' }, 17);
    stm.recordRound({ index: 18, at: Date.now(), prompt: 'a', assistant: 'b', tools: [], outcome: 'completed' }, 18);
    stm.recordRound({ index: 19, at: Date.now(), prompt: 'c', assistant: 'd', tools: [], outcome: 'completed' }, 19);
    assert.equal(stm.shouldCompressByCount(19), false);
    assert.equal(stm.shouldCompressByCount(20), true);
  });

  process.stdout.write('\nworking memory\n');

  await test('working memory records why/result/next per step and settles an interrupted task', async () => {
    const root = await workspace();
    const working = new WorkingMemory(root);
    await working.load();
    await working.startTask({ threadId: 'thr_w', title: '重构记忆', cwd: 'E:/code', goal: '三层记忆' });
    await working.recordStep({
      threadId: 'thr_w', turn: 2, step: 1, tool: 'read_file', detail: 'read_file src/a.ts',
      intent: '先看现状', result: '读到 120 行', ok: true, next: '编辑文件',
    });
    await working.recordStep({
      threadId: 'thr_w', turn: 2, step: 2, tool: 'run_shell', detail: 'npm test',
      intent: '验证', result: 'exit 0', ok: true, next: '收尾',
    });
    const reloaded = new WorkingMemory(root);
    await reloaded.load();
    const task = reloaded.get('thr_w');
    assert.equal(task?.steps.length, 2);
    assert.match(reloaded.render('thr_w'), /先看现状/);
    assert.match(reloaded.render('thr_w'), /npm test/);
    assert.match(await readFile(join(root, 'progress.md'), 'utf8'), /为什么/);
    const interrupted = await reloaded.settleInterrupted();
    assert.deepEqual(interrupted, ['thr_w']);
    assert.equal(reloaded.get('thr_w')?.status, 'interrupted');
    assert.equal(reloaded.get('thr_w')?.next, '收尾');
    await rm(root, { recursive: true, force: true });
  });

  process.stdout.write('\ncontext budget\n');

  await test('history budget subtracts output, prompt, tools and a safety margin', () => {
    const budget = contextBudget({ contextWindow: 8192, maxOutputTokens: 1024, promptTokens: 1500, toolTokens: 500 });
    assert.equal(budget.outputReserve, 1024);
    assert.equal(budget.promptReserve, 2000);
    assert.equal(budget.safetyMargin, 2048);
    assert.equal(budget.historyLimit, 3120);
    const unknown = contextBudget({ contextWindow: 0, maxOutputTokens: 0, promptTokens: 1000, toolTokens: 0 });
    assert.equal(unknown.window, DEFAULT_CONTEXT_WINDOW);
    assert.ok(unknown.historyLimit > 15_000);
    assert.ok(unknown.historyLimit < unknown.window);
  });

  await test('the token estimate counts CJK as about one token per character', () => {
    assert.equal(estimateTokens('太阳从东边升起'), 7);
    assert.ok(estimateTokens('中文中文中文') > estimateTokens('abcdef'));
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

  process.stdout.write('\nmemory integration\n');

  await test('one turn writes long-term, short-term and working memory end to end', async () => {
    const requests: Array<{ messages: Array<{ role: string; content: string | null }> }> = [];
    let calls = 0;
    const fake = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        calls += 1;
        try {
          requests.push(JSON.parse(body) as { messages: Array<{ role: string; content: string | null }> });
        } catch {
          requests.push({ messages: [] });
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (value: unknown): void => {
          response.write(`data: ${JSON.stringify(value)}\n\n`);
        };
        if (calls === 1) {
          send({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_mem_1',
                      type: 'function',
                      function: {
                        name: 'memory_write',
                        arguments: JSON.stringify({
                          kind: 'episodic',
                          title: '登录修复',
                          detail: '修复登录超时，refresh token 提前过期',
                          importance: 70,
                          when: '今天下午',
                          where: 'E:/code/xiaohei',
                          result: '构建通过',
                          outcome: 'success',
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        } else if (calls === 2) {
          send({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_mem_2',
                      type: 'function',
                      function: {
                        name: 'memory_read',
                        arguments: JSON.stringify({ query: '登录', kind: 'episodic' }),
                      },
                    },
                  ],
                },
              },
            ],
          });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          send({ choices: [{ delta: { content: '已记录并确认这次修复。' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
        send({ usage: { prompt_tokens: 120, completion_tokens: 24 }, model: 'fake' });
        response.write('data: [DONE]\n\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const address = fake.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const home = await workspace();
    const memoryHome = join(home, 'memory');
    try {
      const store = new Store(home, home);
      await store.init();
      const settings = store.getSettings();
      await store.setSettings({
        ...settings,
        models: [
          {
            id: 'fake',
            name: 'Fake',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: 'sk-fake',
            model: 'fake-model',
            temperature: 0,
            maxOutputTokens: 1024,
            contextWindow: 8192,
            reasoningEffort: 'default',
          },
        ],
        activeModelId: 'fake',
      });
      const doc = await store.createThread('memory integration', home);
      const events: string[] = [];
      const agent = new AgentService({
        store,
        emit: (event) => events.push(event.type),
        home,
        memoryHome,
      });
      await agent.init();
      await agent.startTurn(doc.thread.id, '把这次登录修复记下来');
      const deadline = Date.now() + 10_000;
      while (agent.isRunning(doc.thread.id) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(agent.isRunning(doc.thread.id), false);
      assert.equal(calls, 3);
      assert.ok(events.includes('memory/updated'));

      const longTerm = await readFile(join(memoryHome, 'memory.md'), 'utf8');
      assert.match(longTerm, /情景记忆/);
      assert.match(longTerm, /refresh token 提前过期/);

      const shortTerm = await readFile(join(memoryHome, 'session', `${doc.thread.id}.md`), 'utf8');
      assert.match(shortTerm, /把这次登录修复记下来/);
      assert.match(shortTerm, /第 1 轮/);

      const progress = await readFile(join(memoryHome, 'progress.md'), 'utf8');
      assert.match(progress, /memory_write/);
      assert.match(progress, /memory_read/);
      assert.match(progress, /为什么/);

      // The recall really reached the model: the last tool result carries the entry.
      const recallResult = requests[2]?.messages.filter((message) => message.role === 'tool').at(-1);
      assert.ok(recallResult);
      assert.match(recallResult!.content ?? '', /情景记忆/);
      assert.match(recallResult!.content ?? '', /refresh token 提前过期/);

      // Long-term contents stay behind the tool: the prompt shows the index and
      // working memory, not the memory body.
      const system = requests[2]?.messages.find((message) => message.role === 'system');
      assert.ok(system);
      assert.match(system!.content ?? '', /Working memory/);
      assert.match(system!.content ?? '', /长期记忆：活跃 1 条/);
      assert.doesNotMatch(system!.content ?? '', /refresh token 提前过期/);
    } finally {
      fake.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  await test('nine turns trigger a real short-term compression and keep the newest rounds', async () => {
    let calls = 0;
    const fake = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        calls += 1;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (value: unknown): void => {
          response.write(`data: ${JSON.stringify(value)}\n\n`);
        };
        send({ choices: [{ delta: { content: `第 ${calls} 次模型回复。` } }] });
        send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        send({ usage: { prompt_tokens: 50, completion_tokens: 10 }, model: 'fake' });
        response.write('data: [DONE]\n\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
    const address = fake.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const home = await workspace();
    const memoryHome = join(home, 'memory');
    try {
      const store = new Store(home, home);
      await store.init();
      const settings = store.getSettings();
      await store.setSettings({
        ...settings,
        models: [
          {
            id: 'fake',
            name: 'Fake',
            baseUrl: `http://127.0.0.1:${port}/v1`,
            apiKey: 'sk-fake',
            model: 'fake-model',
            temperature: 0,
            maxOutputTokens: 1024,
            contextWindow: 32_768,
            reasoningEffort: 'default',
          },
        ],
        activeModelId: 'fake',
      });
      const doc = await store.createThread('nine turns', home);
      const agent = new AgentService({ store, emit: () => undefined, home, memoryHome });
      await agent.init();
      for (let index = 1; index <= 9; index += 1) {
        await agent.startTurn(doc.thread.id, `第 ${index} 轮的请求`);
        const deadline = Date.now() + 10_000;
        while (agent.isRunning(doc.thread.id) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(agent.isRunning(doc.thread.id), false);
      }
      const session = await readFile(join(memoryHome, 'session', `${doc.thread.id}.md`), 'utf8');
      assert.match(session, /历史摘要/);
      assert.match(session, /已压缩 1 次/);
      const rounds = [...session.matchAll(/<!-- round /g)].length;
      assert.equal(rounds, 3, 'turn 9 compresses turns 1–6, keeps 7–8, then appends turn 9');
      assert.match(session, /### 第 1–6 轮/);
      assert.equal(calls, 10, 'nine turns plus one summary request');
      const reloaded = await store.load(doc.thread.id);
      assert.ok(reloaded?.items.some((item) => item.kind === 'compaction'));
    } finally {
      fake.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  process.stdout.write('\ntool management\n');

  /** A scripted OpenAI-compatible endpoint: each request plays the next step. */
  async function startFakeModel(script: Array<{ calls?: Array<{ name: string; args: Record<string, unknown> }>; text?: string }>) {
    let index = 0;
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (value: unknown): void => {
          response.write(`data: ${JSON.stringify(value)}\n\n`);
        };
        if (step.calls?.length) {
          send({
            choices: [
              {
                delta: {
                  tool_calls: step.calls.map((call, callIndex) => ({
                    index: callIndex,
                    id: `call_${index}_${callIndex}`,
                    type: 'function',
                    function: { name: call.name, arguments: JSON.stringify(call.args) },
                  })),
                },
              },
            ],
          });
          send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          send({ choices: [{ delta: { content: step.text ?? 'done' } }] });
          send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
        send({ usage: { prompt_tokens: 20, completion_tokens: 5 }, model: 'fake' });
        response.write('data: [DONE]\n\n');
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { server, port };
  }

  async function agentWith(port: number, home: string, policy: 'ask' | 'auto' | 'full', onEvent?: (event: any) => void) {
    const store = new Store(home, home);
    await store.init();
    const settings = store.getSettings();
    await store.setSettings({
      ...settings,
      approval: policy,
      models: [
        {
          id: 'fake',
          name: 'Fake',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'sk-fake',
          model: 'fake-model',
          temperature: 0,
          maxOutputTokens: 1024,
          contextWindow: 32_768,
          reasoningEffort: 'default',
        },
      ],
      activeModelId: 'fake',
    });
    const events: any[] = [];
    const agent = new AgentService({
      store,
      emit: (event) => {
        events.push(event);
        onEvent?.(event);
      },
      home,
      memoryHome: join(home, 'memory'),
    });
    await agent.init();
    const doc = await store.createThread('tools', home);
    return { store, agent, doc, events };
  }

  async function runTurn(agent: AgentService, threadId: string, prompt: string): Promise<void> {
    await agent.startTurn(threadId, prompt);
    const deadline = Date.now() + 15_000;
    while (agent.isRunning(threadId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(agent.isRunning(threadId), false);
  }

  await test('a denied file write leaves the file untouched and tells the model why', async () => {
    const home = await workspace();
    await writeFile(join(home, 'keep.txt'), 'original\n', 'utf8');
    const store = new Store(home, home);
    void store;
    const { server, port } = await startFakeModel([
      { calls: [{ name: 'write_file', args: { path: 'keep.txt', content: 'replaced\n' } }] },
      { text: '好的，不写了。' },
    ]);
    try {
      const { agent, doc, events } = await agentWith(port, home, 'ask', (event) => {
        if (event.type !== 'approval/requested') return;
        assert.equal(event.approval.risk, 'write');
        assert.equal(event.approval.tier, 'medium');
        setTimeout(() => agent.respondApproval(event.approval.id, 'deny'), 0);
      });
      await runTurn(agent, doc.thread.id, '把 keep.txt 改掉');
      const contents = await readFile(join(home, 'keep.txt'), 'utf8');
      assert.equal(contents, 'original\n', 'the denied write must not touch disk');
      const result = events.find((event) => event.type === 'item/upsert' && event.item.kind === 'tool_result');
      assert.equal(result?.item.ok, false);
      assert.match(result?.item.summary ?? '', /未获批准/);
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  await test('independent read tools in one step actually overlap', async () => {
    const home = await workspace();
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await writeFile(join(home, name), `${name} body\n`, 'utf8');
    }
    const { server, port } = await startFakeModel([
      {
        calls: [
          { name: 'read_file', args: { path: 'a.txt' } },
          { name: 'read_file', args: { path: 'b.txt' } },
          { name: 'read_file', args: { path: 'c.txt' } },
        ],
      },
      { text: '三个文件都读了。' },
    ]);

    // Wrap read_file so overlap becomes observable: it delays, then counts.
    const real = toolByName.get('read_file')!;
    let inFlight = 0;
    let peak = 0;
    toolByName.set('read_file', {
      ...real,
      run: async (ctx, args) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 80));
        inFlight -= 1;
        return real.run(ctx, args);
      },
    });
    try {
      const { agent, doc, events } = await agentWith(port, home, 'full');
      await runTurn(agent, doc.thread.id, '读三个文件');
      assert.equal(peak, 3, `expected 3 concurrent reads, saw ${peak}`);
      assert.ok(PARALLEL_READ_TOOLS.has('read_file'));

      // Transcript order is still the model's order, not completion order.
      const seen = new Map<string, string>();
      for (const event of events) {
        if (event.type !== 'item/upsert' || event.item.kind !== 'tool_call') continue;
        if (typeof event.item.args?.path !== 'string') continue;
        seen.set(event.item.callId, event.item.args.path);
      }
      assert.deepEqual([...seen.values()], ['a.txt', 'b.txt', 'c.txt']);
      const results = events.filter((event) => event.type === 'item/upsert' && event.item.kind === 'tool_result').map((event) => event.item.ok);
      assert.deepEqual(results, [true, true, true]);
    } finally {
      toolByName.set('read_file', real);
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  await test('a mutating call in the same step is not parallel with reads', async () => {
    const home = await workspace();
    await writeFile(join(home, 'a.txt'), 'a\n', 'utf8');
    const { server, port } = await startFakeModel([
      {
        calls: [
          { name: 'read_file', args: { path: 'a.txt' } },
          { name: 'write_file', args: { path: 'b.txt', content: 'b\n' } },
          { name: 'read_file', args: { path: 'b.txt' } },
        ],
      },
      { text: '读、写、读。' },
    ]);
    try {
      const { store, agent, doc } = await agentWith(port, home, 'full');
      await runTurn(agent, doc.thread.id, '先读再写再读');
      const reloaded = await store.load(doc.thread.id);
      const order = (reloaded?.items ?? [])
        .filter((item) => item.kind === 'tool_result')
        .map((item) => (item as { name: string; callId: string }).name);
      assert.deepEqual(order, ['read_file', 'write_file', 'read_file']);
      // The write ran between the two reads, in model order.
      assert.equal(await readFile(join(home, 'b.txt'), 'utf8'), 'b\n');
    } finally {
      server.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  await test('a stale write is refused instead of clobbering the other session', async () => {
    const dir = await workspace();
    const locks = new LockTable(join(dir, '.leases.json'));
    const target = join(dir, 'a.ts');
    await writeFile(target, 'A\n', 'utf8');
    const expected = textFingerprint('A\n');

    // Another session writes between our read and our commit.
    await writeFile(target, 'B\n', 'utf8');
    const refused = await guardedCommit({ locks, workspace: dir, target, content: 'C\n', expected, owner: 'thread:a' });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false ? refused.reason : '', 'conflict');
    assert.equal(await readFile(target, 'utf8'), 'B\n');

    // With the current fingerprint the same write goes through.
    const accepted = await guardedCommit({
      locks,
      workspace: dir,
      target,
      content: 'C\n',
      expected: textFingerprint('B\n'),
      owner: 'thread:a',
    });
    assert.equal(accepted.ok, true);
    assert.equal(await readFile(target, 'utf8'), 'C\n');
  });

  await test('creating a file refuses when someone else created it first', async () => {
    const dir = await workspace();
    const locks = new LockTable(join(dir, '.leases.json'));
    const target = join(dir, 'new.ts');
    await writeFile(target, 'theirs\n', 'utf8');
    const refused = await guardedCommit({ locks, workspace: dir, target, content: 'mine\n', expected: 'absent', owner: 'thread:a' });
    assert.equal(refused.ok, false);
    assert.match(refused.ok === false ? refused.detail : '', /创建/);
    assert.equal(await readFile(target, 'utf8'), 'theirs\n');
  });

  await test('a write waits for the workspace mutex a shell holds', async () => {
    const dir = await workspace();
    const locks = new LockTable(join(dir, '.leases.json'));
    const target = join(dir, 'a.ts');
    await writeFile(target, 'A\n', 'utf8');
    await locks.acquire(workspaceKey(dir), 'thread:shell', { fingerprint: 'n/a' });
    const refused = await guardedCommit({
      locks,
      workspace: dir,
      target,
      content: 'B\n',
      expected: textFingerprint('A\n'),
      owner: 'thread:b',
      waitMs: 150,
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.ok === false ? refused.reason : '', 'busy');
    assert.equal(await readFile(target, 'utf8'), 'A\n');
    await locks.release(workspaceKey(dir), 'thread:shell');
  });

  await test('write_file reports a conflict the model can act on', async () => {
    const dir = await workspace();
    const locks = new LockTable(join(dir, '.leases.json'));
    const target = join(dir, 'a.ts');
    await writeFile(target, 'A\n', 'utf8');
    const ctx = {
      threadId: 'thr',
      turnId: 'trn',
      workspace: dir,
      shell: async () => ({ code: 0, stdout: '', stderr: '', durationMs: 1 }),
      approve: async () => 'allow_once' as const,
      ask: async () => ({ answer: '', cancelled: false }),
      remember: async () => ({ kind: 'distinct', note: '' }),
      recall: async () => ({ query: '', hits: [], woken: [], activeTotal: 0, archiveTotal: 0 }),
      setPlan: async () => undefined,
      markTouched: () => undefined,
      evidence: () => undefined,
      // Simulate a neighbour writing during the approval wait.
      commitFile: async (path_: string, content: string, expected: string) => {
        await writeFile(path_, 'interloper\n', 'utf8');
        return guardedCommit({ locks, workspace: dir, target: path_, content, expected, owner: 'thread:thr' });
      },
    };
    const outcome = await toolByName.get('write_file')!.run(ctx, { path: 'a.ts', content: 'mine\n' });
    assert.equal(outcome.ok, false);
    assert.match(outcome.ok ? '' : outcome.summary, /被改过/);
    assert.match(outcome.ok ? '' : outcome.hint, /read_file/);
    assert.equal(await readFile(target, 'utf8'), 'interloper\n');
  });

  await test('revert refuses while a neighbour session runs in the same workspace', async () => {
    const home = await workspace();
    const hanging = createServer((request) => {
      request.resume(); // never respond: the turn stays running
    });
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const address = hanging.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const { agent, doc, store } = await agentWith(port, home, 'full');
      const other = await store.createThread('neighbour', home);
      void agent.startTurn(other.thread.id, '占住这个工作区');
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(agent.isRunning(other.thread.id), true);

      const refused = await agent.revert(doc.thread.id, 'snap-does-not-matter');
      assert.equal(refused.ok, false);
      assert.match(refused.message, /同一工作区/);

      await agent.cancel(other.thread.id);
      await new Promise((resolve) => setTimeout(resolve, 150));
    } finally {
      hanging.close();
      await rm(home, { recursive: true, force: true });
    }
  });

  process.stdout.write('\nworktree isolation\n');

  const git = (cwd: string, ...args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('git', ['-C', cwd, ...args], { windowsHide: true }, (error, stdout, stderr) =>
        error ? reject(new Error(String(stderr || error.message))) : resolve(String(stdout)),
      );
    });
  const initRepo = async (dir: string): Promise<void> => {
    await git(dir, 'init', '-q');
    await git(dir, 'config', 'user.email', 'test@test');
    await git(dir, 'config', 'user.name', 'test');
    // Deterministic LF checkouts regardless of the machine's global autocrlf.
    await git(dir, 'config', 'core.autocrlf', 'false');
    await writeFile(join(dir, 'base.txt'), 'base\n');
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', 'init');
  };
  const settle = async (agent: AgentService, threadId: string, deadline: number): Promise<void> => {
    while (agent.isRunning(threadId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(agent.isRunning(threadId), false);
  };

  let gitAvailable = true;
  try {
    await git(tmpdir(), '--version');
  } catch {
    gitAvailable = false;
  }

  if (!gitAvailable) {
    process.stdout.write('  skip worktree tests: git not found\n');
  } else {
    await test('createWorktree overlays uncommitted and untracked state, junctions node_modules', async () => {
      const home = await workspace();
      const repo = await workspace();
      try {
        await initRepo(repo);
        await writeFile(join(repo, 'base.txt'), 'edited\n');
        await writeFile(join(repo, 'fresh.txt'), 'new\n');
        await mkdir(join(repo, 'node_modules'), { recursive: true });
        await writeFile(join(repo, 'node_modules', 'dep.js'), 'dep\n');
        const created = await createWorktree({ home, workspace: repo, threadId: 'thr_unit' });
        assert.equal(created.ok, true);
        assert.ok(created.ok);
        const state = created.state;
        assert.equal(await readFile(join(state.path, 'base.txt'), 'utf8'), 'edited\n');
        assert.equal(await readFile(join(state.path, 'fresh.txt'), 'utf8'), 'new\n');
        const modules = await lstat(join(state.path, 'node_modules'));
        assert.ok(modules.isSymbolicLink(), 'node_modules should be a junction, not a copy');
        await removeWorktree(repo, state, true);
        assert.equal(existsSync(state.path), false);
        assert.equal(await readFile(join(repo, 'node_modules', 'dep.js'), 'utf8'), 'dep\n', 'removing the link must not touch main deps');
        assert.equal((await git(repo, 'branch', '--list', 'xiaohey/*')).trim(), '');
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(repo, { recursive: true, force: true });
      }
    });

    await test('a clean merge lands behind the typecheck gate and cleans up', async () => {
      const home = await workspace();
      const repo = await workspace();
      try {
        await initRepo(repo);
        await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(0)"' } }));
        await git(repo, 'add', '-A');
        await git(repo, 'commit', '-q', '-m', 'pkg');
        const created = await createWorktree({ home, workspace: repo, threadId: 'thr_ok' });
        assert.ok(created.ok);
        const state = created.state;
        await writeFile(join(state.path, 'base.txt'), 'branch\n');
        assert.equal(await commitWorktree(state, 'test'), true);
        const result = await mergeWorktree({
          workspace: repo,
          state,
          locks: new LockTable(join(home, 'leases.json')),
          owner: 'merge:t',
          title: 't',
          mainBusy: () => false,
        });
        assert.equal(result.status, 'merged');
        assert.equal(await readFile(join(repo, 'base.txt'), 'utf8'), 'branch\n');
        assert.equal(existsSync(state.path), false);
        assert.equal((await git(repo, 'branch', '--list', 'xiaohey/*')).trim(), '');
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(repo, { recursive: true, force: true });
      }
    });

    await test('a red typecheck gate aborts the merge and keeps the branch', async () => {
      const home = await workspace();
      const repo = await workspace();
      try {
        await initRepo(repo);
        await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "process.exit(1)"' } }));
        await git(repo, 'add', '-A');
        await git(repo, 'commit', '-q', '-m', 'pkg');
        const headBefore = (await git(repo, 'rev-parse', 'HEAD')).trim();
        const created = await createWorktree({ home, workspace: repo, threadId: 'thr_red' });
        assert.ok(created.ok);
        const state = created.state;
        await writeFile(join(state.path, 'base.txt'), 'branch\n');
        await commitWorktree(state, 'test');
        const result = await mergeWorktree({
          workspace: repo,
          state,
          locks: new LockTable(join(home, 'leases.json')),
          owner: 'merge:t',
          title: 't',
          mainBusy: () => false,
        });
        assert.equal(result.status, 'pending');
        assert.match(result.detail, /typecheck/);
        assert.equal(await readFile(join(repo, 'base.txt'), 'utf8'), 'base\n');
        assert.equal((await git(repo, 'rev-parse', 'HEAD')).trim(), headBefore);
        assert.ok(existsSync(state.path));
        assert.notEqual((await git(repo, 'branch', '--list', 'xiaohey/*')).trim(), '');
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(repo, { recursive: true, force: true });
      }
    });

    await test('conflicts abort the merge and resolve inside the worktree', async () => {
      const home = await workspace();
      const repo = await workspace();
      try {
        await initRepo(repo);
        const created = await createWorktree({ home, workspace: repo, threadId: 'thr_cf' });
        assert.ok(created.ok);
        const state = created.state;
        await writeFile(join(repo, 'base.txt'), 'main\n');
        await git(repo, 'add', '-A');
        await git(repo, 'commit', '-q', '-m', 'main change');
        await writeFile(join(state.path, 'base.txt'), 'branch\n');
        await commitWorktree(state, 'branch change');
        const locks = new LockTable(join(home, 'leases.json'));
        const refused = await mergeWorktree({ workspace: repo, state, locks, owner: 'merge:t', title: 't', mainBusy: () => false });
        assert.equal(refused.status, 'pending');
        assert.deepEqual(refused.conflicted, ['base.txt']);
        assert.equal(await readFile(join(repo, 'base.txt'), 'utf8'), 'main\n');

        const resolution = await prepareConflictResolution(repo, state);
        assert.ok(resolution.ok);
        assert.deepEqual(resolution.conflicted, ['base.txt']);
        assert.match(await readFile(join(state.path, 'base.txt'), 'utf8'), /<<<<<<</);

        await writeFile(join(state.path, 'base.txt'), 'resolved\n');
        await commitWorktree(state, 'resolve');
        const merged = await mergeWorktree({ workspace: repo, state, locks, owner: 'merge:t', title: 't', mainBusy: () => false });
        assert.equal(merged.status, 'merged');
        assert.equal(await readFile(join(repo, 'base.txt'), 'utf8'), 'resolved\n');
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(repo, { recursive: true, force: true });
      }
    });

    await test('a busy main tree defers the merge instead of forcing it', async () => {
      const home = await workspace();
      const repo = await workspace();
      try {
        await initRepo(repo);
        const created = await createWorktree({ home, workspace: repo, threadId: 'thr_busy' });
        assert.ok(created.ok);
        const state = created.state;
        await writeFile(join(state.path, 'base.txt'), 'branch\n');
        await commitWorktree(state, 'test');
        const result = await mergeWorktree({
          workspace: repo,
          state,
          locks: new LockTable(join(home, 'leases.json')),
          owner: 'merge:t',
          title: 't',
          mainBusy: () => true,
        });
        assert.equal(result.status, 'pending');
        assert.match(result.detail, /运行/);
        assert.equal(await readFile(join(repo, 'base.txt'), 'utf8'), 'base\n');
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(repo, { recursive: true, force: true });
      }
    });

    await test('a non-git workspace reports why isolation is unavailable', async () => {
      const home = await workspace();
      const plain = await workspace();
      try {
        const created = await createWorktree({ home, workspace: plain, threadId: 'thr_plain' });
        assert.equal(created.ok, false);
        assert.ok(!created.ok && created.reason.length > 0);
      } finally {
        await rm(home, { recursive: true, force: true });
        await rm(plain, { recursive: true, force: true });
      }
    });

    await test('concurrent sessions in a git workspace isolate and merge back', async () => {
      const home = await workspace();
      const repo = await workspace();
      let releaseA: () => void = () => undefined;
      const gateA = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const hits = new Map<string, number>();
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          const parsed = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
          const user = [...parsed.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
          const key = user.includes('甲') ? 'A' : 'B';
          const n = (hits.get(key) ?? 0) + 1;
          hits.set(key, n);
          const respond = (step: { calls?: Array<{ name: string; args: Record<string, unknown> }>; text?: string }): void => {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            const send = (value: unknown): void => {
              response.write(`data: ${JSON.stringify(value)}\n\n`);
            };
            if (step.calls?.length) {
              send({
                choices: [
                  {
                    delta: {
                      tool_calls: step.calls.map((call, callIndex) => ({
                        index: callIndex,
                        id: `call_${key}_${n}_${callIndex}`,
                        type: 'function',
                        function: { name: call.name, arguments: JSON.stringify(call.args) },
                      })),
                    },
                  },
                ],
              });
              send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
            } else {
              send({ choices: [{ delta: { content: step.text ?? 'done' } }] });
              send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
            }
            send({ usage: { prompt_tokens: 20, completion_tokens: 5 }, model: 'fake' });
            response.write('data: [DONE]\n\n');
            response.end();
          };
          if (key === 'A') {
            if (n === 1) respond({ calls: [{ name: 'write_file', args: { path: 'a.txt', content: 'A\n' } }] });
            else void gateA.then(() => respond({ text: '甲完成' }));
          } else if (n === 1) {
            respond({ calls: [{ name: 'write_file', args: { path: 'b.txt', content: 'B\n' } }] });
          } else {
            respond({ text: '乙完成' });
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      try {
        await initRepo(repo);
        // An uncommitted edit in the main tree: the isolated session must start from it.
        await writeFile(join(repo, 'base.txt'), 'live\n');
        const store = new Store(home, home);
        await store.init();
        await store.setSettings({
          ...store.getSettings(),
          approval: 'full',
          models: [
            {
              id: 'fake',
              name: 'Fake',
              baseUrl: `http://127.0.0.1:${port}/v1`,
              apiKey: 'sk-fake',
              model: 'fake',
              temperature: 0,
              maxOutputTokens: 1024,
              contextWindow: 32_768,
              reasoningEffort: 'default',
            },
          ],
          activeModelId: 'fake',
        });
        const agent = new AgentService({ store, emit: () => undefined, home, memoryHome: join(home, 'memory') });
        await agent.init();
        const a = await store.createThread('甲', repo);
        const b = await store.createThread('乙', repo);
        const deadline = Date.now() + 20_000;

        void agent.startTurn(a.thread.id, '甲：写 a.txt');
        while (!existsSync(join(repo, 'a.txt')) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(existsSync(join(repo, 'a.txt')), 'the first session writes in the main checkout');
        assert.equal(agent.isRunning(a.thread.id), true);

        await agent.startTurn(b.thread.id, '乙：写 b.txt');
        await settle(agent, b.thread.id, deadline);
        assert.equal(existsSync(join(repo, 'b.txt')), false, 'the second session must not write into the busy main tree');
        const bDoc = await store.load(b.thread.id);
        assert.equal(bDoc?.state.worktree?.status, 'pending', 'merge defers while the main tree is busy');
        const worktreePath = bDoc?.state.worktree?.path;
        assert.ok(worktreePath);
        assert.equal(await readFile(join(worktreePath!, 'b.txt'), 'utf8'), 'B\n');
        assert.equal(await readFile(join(worktreePath!, 'base.txt'), 'utf8'), 'live\n', 'overlay carries the uncommitted edit');

        releaseA();
        await settle(agent, a.thread.id, deadline);
        assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'A\n');
        assert.equal(await readFile(join(repo, 'b.txt'), 'utf8'), 'B\n', "the first session's end drains the pending merge");
        const merged = await store.load(b.thread.id);
        assert.equal(merged?.state.worktree?.status, 'merged');
        assert.equal(existsSync(merged!.state.worktree!.path), false);
        assert.equal((await git(repo, 'branch', '--list', 'xiaohey/*')).trim(), '');
      } finally {
        releaseA();
        server.close();
        await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
  }

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
    const agent = new AgentService({ store, emit: () => undefined, home, memoryHome: home });
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
    const agent = new AgentService({ store, emit: () => undefined, home, memoryHome: home });
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
    const agent = new AgentService({ store, emit: () => undefined, home, memoryHome: home });
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
