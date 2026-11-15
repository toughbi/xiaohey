import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { BrowserWindow, dialog, Notification, shell } from 'electron';
import type {
  ActivityDay,
  ApprovalItem,
  ActivityResult,
  DiffPayload,
  DocumentPayload,
  FileEntry,
  MemoryFact,
  ModelSettings,
  RequestName,
  RequestParams,
  RequestResult,
  RuntimeEvent,
  Settings,
  SnapshotMeta,
  Thread,
  ToolDescriptor,
} from '../shared/types.js';
import { Store, type ThreadDoc } from './store.js';
import { AgentService } from './runtime/agent.js';
import { applyClaim } from './runtime/memory.js';
import { truncate } from './util.js';
import { toolDescriptors } from './runtime/tools.js';
import { testModel } from './runtime/llm.js';
import { listModels } from './runtime/models.js';
import { demoActivity } from './demo.js';
import { relativeTo, resolveInside } from './util.js';

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.css', '.scss', '.html', '.md', '.txt',
  '.yml', '.yaml', '.toml', '.py', '.rs', '.go', '.java', '.sql', '.sh', '.ps1', '.env', '.gitignore',
]);

const MAX_DOC_BYTES = 400_000;

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

function languageOf(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx', '.json': 'json',
    '.css': 'css', '.html': 'html', '.md': 'markdown', '.py': 'python', '.rs': 'rust', '.go': 'go',
    '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.sh': 'shell', '.ps1': 'powershell', '.sql': 'sql',
  };
  return map[ext] ?? 'text';
}

export class AppServer {
  readonly store: Store;
  readonly agent: AgentService;

  constructor(
    home: string,
    workspaceRoot: string,
    private readonly emit: (event: RuntimeEvent) => void,
    readonly demo: boolean,
  ) {
    this.store = new Store(home, workspaceRoot);
    this.agent = new AgentService({ store: this.store, emit, home });
  }

  async init(): Promise<void> {
    await this.store.init();
    await this.agent.init();
    await this.store.recoverInterrupted();
  }

  /** Close running turns before the process exits, then flush them. */
  async shutdown(): Promise<void> {
    for (const [threadId, doc] of this.store.docs) {
      if (doc.thread.status !== 'running' && doc.thread.status !== 'waiting_approval') continue;
      doc.thread.status = 'idle';
      if (doc.turn && doc.turn.status === 'running') {
        doc.turn.status = 'cancelled';
        doc.turn.endedAt = Date.now();
      }
      const turnId = doc.turn?.id ?? [...doc.items].reverse().find((item) => item.turnId)?.turnId ?? 'system';
      if (!doc.items.some((item) => item.kind === 'notice' && item.title === '应用已退出')) {
        doc.items.push({
          id: `itm_shutdown_${threadId}`,
          threadId,
          turnId,
          at: Date.now(),
          status: 'done',
          kind: 'notice',
          tone: 'warn',
          title: '应用已退出',
          body: '上一轮在应用关闭时中断，没有完成。',
        });
      }
      for (const item of doc.items) {
        if (item.status === 'running') item.status = 'cancelled';
      }
    }
    await this.store.flushAll();
  }

  async request<K extends RequestName>(method: K, params: RequestParams<K>): Promise<RequestResult<K>> {
    switch (method) {
      case 'app/info':
        return {
          version: '0.1.0',
          workspace: this.store.workspaceRoot,
          demo: this.demo,
          platform: `${process.platform} ${process.arch}`,
          user: userInfo().username,
        } as RequestResult<K>;

      case 'settings/get':
        return this.store.getSettings() as RequestResult<K>;

      case 'settings/set': {
        const settings = params as Settings;
        const saved = await this.store.setSettings(settings);
        this.emit({ type: 'settings/updated', settings: saved });
        return saved as RequestResult<K>;
      }

      case 'settings/test':
        return (await testModel((params as { model: ModelSettings }).model)) as RequestResult<K>;

      case 'thread/list':
        return (await this.store.listThreads()) as RequestResult<K>;

      case 'thread/create': {
        const { title, workspace } = params as { title?: string; workspace?: string | null };
        let cwd: string | undefined;
        if (workspace === null) {
          // explicitly no workspace: the session waits for one
          cwd = '';
        } else if (workspace) {
          if (!isAbsolute(workspace)) throw new Error('workspace path must be absolute');
          const info = await stat(workspace).catch(() => null);
          if (!info || !info.isDirectory()) throw new Error(`not a folder: ${workspace}`);
          cwd = workspace;
        }
        const doc = await this.store.createThread(title ?? 'New session', cwd);
        this.emit({ type: 'thread/list', threads: await this.store.listThreads() });
        return doc.thread as RequestResult<K>;
      }

      case 'thread/open': {
        const { threadId } = params as { threadId: string };
        const doc = await this.store.load(threadId);
        if (!doc) throw new Error(`unknown thread ${threadId}`);
        await this.store.setActive(threadId);
        return {
          thread: doc.thread,
          items: doc.items,
          turn: doc.turn ?? undefined,
          contract: doc.state.contract
            ? {
                goal: doc.state.contract.goal,
                acceptance: doc.state.contract.acceptance,
                nonGoals: doc.state.contract.nonGoals,
                forbidden: doc.state.contract.forbidden,
              }
            : null,
          plan: doc.state.plan,
        } as RequestResult<K>;
      }

      case 'thread/rename': {
        const { threadId, title } = params as { threadId: string; title: string };
        const doc = await this.store.load(threadId);
        if (!doc) throw new Error(`unknown thread ${threadId}`);
        doc.thread.title = title.slice(0, 80) || 'New session';
        await this.store.saveNow(threadId);
        this.emit({ type: 'thread/updated', thread: doc.thread });
        this.emit({ type: 'thread/list', threads: await this.store.listThreads() });
        return doc.thread as RequestResult<K>;
      }

      case 'thread/set-workspace': {
        const { threadId, workspace } = params as { threadId: string; workspace: string };
        if (!isAbsolute(workspace)) throw new Error('workspace path must be absolute');
        const info = await stat(workspace).catch(() => null);
        if (!info || !info.isDirectory()) throw new Error(`not a folder: ${workspace}`);
        const doc = await this.threadDoc(threadId);
        doc.thread.cwd = workspace;
        doc.thread.updatedAt = Date.now();
        await this.store.saveNow(threadId);
        this.emit({ type: 'thread/list', threads: await this.store.listThreads() });
        this.emit({ type: 'thread/updated', thread: doc.thread });
        return doc.thread as RequestResult<K>;
      }

      case 'thread/pin': {
        const { threadId, pinned } = params as { threadId: string; pinned: boolean };
        const thread = await this.store.setPinned(threadId, pinned);
        this.emit({ type: 'thread/list', threads: await this.store.listThreads() });
        return thread as RequestResult<K>;
      }

      case 'thread/delete': {
        const { threadId } = params as { threadId: string };
        await this.agent.cancel(threadId);
        await this.store.deleteThread(threadId);
        this.emit({ type: 'thread/list', threads: await this.store.listThreads() });
        return { ok: true } as RequestResult<K>;
      }

      case 'turn/start': {
        const { threadId, prompt, attachments } = params as { threadId: string; prompt: string; attachments?: string[] };
        const turn = await this.agent.startTurn(threadId, prompt, attachments ?? []);
        this.emit({ type: 'thread/list', threads: await this.store.listThreads() });
        return turn as RequestResult<K>;
      }

      case 'turn/cancel':
        return { ok: await this.agent.cancel((params as { threadId: string }).threadId) } as RequestResult<K>;

      case 'approval/respond': {
        const { approvalId, decision } = params as { approvalId: string; decision: 'allow_once' | 'allow_always' | 'deny' };
        return { ok: this.agent.respondApproval(approvalId, decision) } as RequestResult<K>;
      }

      case 'context/get': {
        const doc = await this.store.load((params as { threadId: string }).threadId);
        if (!doc) throw new Error('unknown thread');
        return this.gaugeOf(doc) as RequestResult<K>;
      }

      case 'tools/list':
        return toolDescriptors() as ToolDescriptor[] as RequestResult<K>;

      case 'memory/list': {
        const doc = await this.store.load((params as { threadId: string }).threadId);
        if (!doc) return [] as RequestResult<K>;
        return this.facts(doc) as RequestResult<K>;
      }

      case 'memory/delete': {
        const { threadId, slot } = params as { threadId: string; slot: string };
        const doc = await this.store.load(threadId);
        if (!doc) throw new Error('unknown thread');
        doc.state.memory = doc.state.memory.filter((record) => record.slot !== slot);
        await this.store.saveNow(threadId);
        this.emit({ type: 'memory/updated', facts: this.facts(doc) });
        return this.facts(doc) as RequestResult<K>;
      }

      case 'snapshot/list': {
        const { threadId } = params as { threadId: string };
        const doc = await this.store.load(threadId);
        return (doc?.snapshots ?? []) as SnapshotMeta[] as RequestResult<K>;
      }

      case 'snapshot/preview': {
        const { threadId, snapshotId } = params as { threadId: string; snapshotId: string };
        return (await this.agent.previewRevert(threadId, snapshotId)) as RequestResult<K>;
      }

      case 'fs/attach': {
        const { threadId, name, data } = params as { threadId: string; name: string; data: string };
        return (await this.attachFile(threadId, name, data)) as RequestResult<K>;
      }

      case 'snapshot/revert': {
        const { threadId, snapshotId } = params as { threadId: string; snapshotId: string };
        return (await this.agent.revert(threadId, snapshotId)) as RequestResult<K>;
      }

      case 'fs/list': {
        const { threadId, path } = params as { threadId: string; path: string };
        return (await this.listFiles(threadId, path)) as RequestResult<K>;
      }

      case 'fs/read': {
        const { threadId, path } = params as { threadId: string; path: string };
        return (await this.readDocument(threadId, path)) as RequestResult<K>;
      }

      case 'fs/read-image': {
        const { threadId, path } = params as { threadId: string; path: string };
        return (await this.readImage(threadId, path)) as RequestResult<K>;
      }

      case 'fs/files': {
        const { threadId } = params as { threadId: string };
        return (await this.allFiles(threadId)) as RequestResult<K>;
      }

      case 'app/notify': {
        const { title, body } = params as { title: string; body: string };
        if (Notification.isSupported()) {
          const notification = new Notification({ title, body });
          notification.on('click', () => {
            const window = BrowserWindow.getAllWindows()[0];
            if (!window) return;
            if (window.isMinimized()) window.restore();
            window.show();
            window.focus();
          });
          notification.show();
        }
        return { ok: true } as RequestResult<K>;
      }

      case 'app/reveal': {
        const { path, threadId } = params as { path: string; threadId?: string };
        // File paths in the docs panel are relative to the session workspace,
        // which is not necessarily the default root.
        const root = threadId ? (await this.threadDoc(threadId)).thread.cwd : this.store.workspaceRoot;
        const full = resolveInside(root, path);
        await stat(full);
        shell.showItemInFolder(full);
        return { ok: true } as RequestResult<K>;
      }

      case 'thread/markdown': {
        const { threadId } = params as { threadId: string };
        const doc = await this.threadDoc(threadId);
        return { markdown: this.renderMarkdown(doc) } as RequestResult<K>;
      }

      case 'thread/export': {
        const { threadId } = params as { threadId: string };
        return (await this.exportThread(threadId)) as RequestResult<K>;
      }

      case 'approvals/list': {
        const { threadId } = params as { threadId: string };
        const doc = await this.threadDoc(threadId);
        const approvals = doc.items.filter((item): item is ApprovalItem => item.kind === 'approval');
        return approvals.slice().reverse() as RequestResult<K>;
      }

      case 'memory/set': {
        const { threadId, slot, value } = params as { threadId: string; slot: string; value: string };
        const trimmed = value.trim();
        if (!trimmed) throw new Error('memory value is empty');
        const doc = await this.threadDoc(threadId);
        const applied = applyClaim(doc.state.memory, { slot: slot.trim() || 'note.manual', value: trimmed, scope: { kind: 'workspace' }, source: 'manual' });
        doc.state.memory = applied.records;
        await this.store.saveNow(threadId);
        this.emit({ type: 'memory/updated', facts: this.facts(doc) });
        return this.facts(doc) as RequestResult<K>;
      }

      case 'fs/diff': {
        const { threadId, path, snapshotId } = params as { threadId: string; path: string; snapshotId?: string };
        return (await this.diff(threadId, path, snapshotId)) as RequestResult<K>;
      }

      case 'ui/state': {
        const threads = await this.store.listThreads();
        return {
          settings: this.store.getSettings(),
          threads,
          tools: toolDescriptors(),
        } as RequestResult<K>;
      }

      case 'activity/get': {
        const requested = Number((params as { weeks?: number }).weeks ?? 26);
        const weeks = Math.min(52, Math.max(4, Number.isFinite(requested) ? Math.round(requested) : 26));
        return (await this.activity(weeks)) as RequestResult<K>;
      }

      case 'workspace/info': {
        const { threadId } = params as { threadId?: string };
        let path = this.store.workspaceRoot;
        if (threadId) {
          const doc = await this.store.load(threadId);
          if (doc) path = doc.thread.cwd;
        }
        return { path, name: basename(path), branch: await this.gitBranch(path) } as RequestResult<K>;
      }

      case 'workspace/reveal': {
        const { path } = params as { path: string };
        if (!isAbsolute(path)) throw new Error('workspace path must be absolute');
        const info = await stat(path).catch(() => null);
        if (!info || !info.isDirectory()) throw new Error(`not a folder: ${path}`);
        await shell.openPath(path);
        return { ok: true } as RequestResult<K>;
      }

      case 'workspace/rename': {
        const { path, name } = params as { path: string; name: string };
        const clean = name.trim();
        if (!clean) throw new Error('名称不能为空');
        if (/[\\/:*?"<>|]/.test(clean)) throw new Error('名称不能包含 \\ / : * ? " < > |');
        if (!isAbsolute(path)) throw new Error('workspace path must be absolute');
        const target = join(dirname(path), clean);
        if (target === path) return { path } as RequestResult<K>;
        const info = await stat(path).catch(() => null);
        if (!info || !info.isDirectory()) throw new Error(`not a folder: ${path}`);
        await rename(path, target);
        const threads = await this.store.listThreads();
        for (const thread of threads) {
          if (thread.cwd === path) {
            const doc = await this.threadDoc(thread.id);
            doc.thread.cwd = target;
            doc.thread.updatedAt = Date.now();
            await this.store.saveNow(thread.id);
          }
        }
        const settings = this.store.getSettings();
        await this.store.setSettings({
          ...settings,
          recentWorkspaces: (settings.recentWorkspaces ?? []).map((entry) => (entry === path ? target : entry)),
        });
        this.emit({ type: 'thread/list', threads: await this.store.listThreads() });
        return { path: target } as RequestResult<K>;
      }

      case 'workspace/pick': {
        const window = BrowserWindow.getAllWindows()[0];
        const picked = window
          ? await dialog.showOpenDialog(window, {
              title: '打开或新建工作区',
              properties: ['openDirectory', 'createDirectory'],
            })
          : await dialog.showOpenDialog({ title: '打开或新建工作区', properties: ['openDirectory', 'createDirectory'] });
        return { path: picked.canceled ? null : (picked.filePaths[0] ?? null) } as RequestResult<K>;
      }

      case 'provider/models': {
        const { baseUrl, apiKey } = params as { baseUrl: string; apiKey: string };
        return (await listModels(baseUrl ?? '', apiKey ?? '')) as RequestResult<K>;
      }

      case 'app/open-external': {
        const { url } = params as { url: string };
        if (!/^https?:\/\//i.test(url ?? '')) throw new Error('only http(s) links can be opened');
        await shell.openExternal(url);
        return { ok: true } as RequestResult<K>;
      }

      default:
        throw new Error(`unknown request ${String(method)}`);
    }
  }

  /**
   * Activity heatmap data: one entry per local day over the window, counted
   * from real items (messages + tool calls). Demo mode adds a seeded history so
   * the empty state has a plausible shape on a fresh install.
   */
  private async activity(weeks: number): Promise<ActivityResult> {
    const dayKey = (date: Date): string =>
      `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (weeks * 7 - 1));

    const counts = new Map<string, number>();
    let sessionsTouched = 0;
    let steps = 0;

    for (const thread of await this.store.listThreads()) {
      const doc = await this.store.load(thread.id);
      if (!doc) continue;
      let touched = false;
      for (const item of doc.items) {
        if (item.kind !== 'message' && item.kind !== 'tool_call') continue;
        const date = new Date(item.at);
        date.setHours(0, 0, 0, 0);
        if (date < start || date > today) continue;
        touched = true;
        const key = dayKey(date);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      if (touched) sessionsTouched += 1;
      steps += thread.steps ?? 0;
    }

    if (this.demo) {
      for (const day of demoActivity(weeks)) {
        const date = new Date(`${day.date}T00:00:00`);
        if (date < start || date > today) continue;
        counts.set(day.date, (counts.get(day.date) ?? 0) + day.count);
      }
    }

    const days: ActivityDay[] = [];
    for (const cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
      const key = dayKey(cursor);
      days.push({ date: key, count: counts.get(key) ?? 0 });
    }
    const records = days.reduce((sum, day) => sum + day.count, 0);
    const activeDays = days.filter((day) => day.count > 0).length;

    return {
      weeks,
      days,
      summary: {
        sessions: this.demo ? activeDays : sessionsTouched,
        activeDays,
        records,
        steps: this.demo ? records : steps,
      },
    };
  }

  /**
   * Current git branch, if the workspace is a repository. `symbolic-ref` also
   * answers on a repo without commits (an unborn `main`), where `rev-parse`
   * fails; `rev-parse` then covers detached-but-named refs.
   */
  private async gitBranch(cwd: string): Promise<string | null> {
    const run = (args: string[]): Promise<string> =>
      new Promise((resolve, reject) => {
        execFile('git', ['-C', cwd, ...args], { timeout: 4000, windowsHide: true }, (error, stdout) => {
          if (error) reject(error);
          else resolve(String(stdout));
        });
      });
    try {
      const branch = (await run(['symbolic-ref', '--short', 'HEAD'])).trim();
      if (branch) return branch;
    } catch {
      // fall through to rev-parse
    }
    try {
      const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
      return branch && branch !== 'HEAD' ? branch : null;
    } catch {
      return null;
    }
  }

  private gaugeOf(doc: ThreadDoc) {    return {
      tokensUsed: doc.state.context.tokensUsed,
      tokensBudget: this.store.activeModel()?.contextWindow ?? 131_072,
      compacted: doc.state.context.compacted,
      memoryFacts: doc.state.memory.filter((fact) => fact.status !== 'superseded').length,
      evidence: doc.state.evidence.length,
      toolCalls: doc.items.filter((item) => item.kind === 'tool_call').length,
    };
  }

  private facts(doc: ThreadDoc): MemoryFact[] {
    return doc.state.memory.map((record) => ({
      slot: record.slot,
      value: record.value,
      scope: record.scope.kind === 'path' ? `path:${record.scope.path}` : record.scope.kind,
      source: record.source,
      updatedAt: record.updatedAt,
      supersededBy: record.supersededBy,
      conflicts: record.status === 'disputed' ? 1 : 0,
    }));
  }

  private async threadDoc(threadId: string): Promise<ThreadDoc> {
    const doc = await this.store.load(threadId);
    if (!doc) throw new Error(`unknown thread ${threadId}`);
    return doc;
  }

  private async listFiles(threadId: string, path: string): Promise<FileEntry[]> {
    const doc = await this.threadDoc(threadId);
    const dir = resolveInside(doc.thread.cwd, path || '.');
    const entries = await readdir(dir, { withFileTypes: true });
    const result: FileEntry[] = [];
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = join(dir, entry.name);
      const info = await stat(full).catch(() => null);
      if (!info) continue;
      result.push({
        path: relativeTo(doc.thread.cwd, full),
        name: entry.name,
        dir: entry.isDirectory(),
        size: info.size,
        updatedAt: info.mtimeMs,
      });
    }
    return result.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }

  /** Flat list of text files for the @-reference picker. */
  private async allFiles(threadId: string): Promise<FileEntry[]> {
    const doc = await this.threadDoc(threadId);
    const root = doc.thread.cwd;
    const found: FileEntry[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'dist-electron', '.xiaohey', '.dsh', '.agent', 'release']);
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (found.length >= 800 || depth > 6) return;
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (found.length >= 800) return;
        if (entry.name.startsWith('.') && entry.name !== '.env') continue;
        const full = join(dir, entry.name);
        const rel = relativeTo(root, full);
        if (entry.isDirectory()) {
          if (skip.has(entry.name)) continue;
          await walk(full, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        found.push({ path: rel, name: entry.name, dir: false, size: info.size, updatedAt: info.mtimeMs });
      }
    };
    await walk(root, 0);
    return found.sort((a, b) => a.path.localeCompare(b.path));
  }

  private renderMarkdown(doc: ThreadDoc): string {
    const lines: string[] = [
      '# ' + doc.thread.title,
      '',
      '- 会话：' + doc.thread.id,
      '- 模型：' + doc.thread.model,
      '- 轮次：' + doc.thread.turnCount + ' · 步数：' + doc.thread.steps + ' · tokens：' + doc.thread.totalTokens,
      '- 导出时间：' + new Date().toISOString(),
      '',
    ];
    for (const item of doc.items) {
      if (item.kind === 'message') {
        lines.push(item.role === 'user' ? '## 用户' : '## 助手', '', item.text, '');
        continue;
      }
      if (item.kind === 'notice') {
        lines.push('> ' + item.title + '：' + item.body.replace(/\n/g, '\n> '), '');
        continue;
      }
      if (item.kind === 'plan') {
        lines.push('### 计划', '');
        for (const step of item.steps) lines.push(`- [${step.status === 'done' ? 'x' : ' '}] ${step.title}`);
        lines.push('');
        continue;
      }
      if (item.kind === 'tool_call') {
        lines.push('### 工具 · ' + item.name, '', '```json', JSON.stringify(item.args, null, 2), '```', '');
        continue;
      }
      if (item.kind === 'tool_result') {
        lines.push('结果：' + (item.ok ? '成功' : '失败') + ' — ' + item.summary, '', '```', truncate(item.output, 6000), '```', '');
        continue;
      }
      if (item.kind === 'approval') {
        lines.push('- 审批：`' + item.command + '` → ' + (item.decision ?? 'pending'));
        continue;
      }
      if (item.kind === 'checkpoint') {
        const stats = item.changeStats ?? { additions: 0, deletions: 0, files: [] };
        lines.push('- 检查点：' + item.label + '（+' + stats.additions + ' / −' + stats.deletions + '）');
        continue;
      }
    }
    return lines.join('\n');
  }

  private async exportThread(threadId: string): Promise<{ path: string }> {
    const doc = await this.threadDoc(threadId);
    const markdown = this.renderMarkdown(doc);
    const folder = join(doc.thread.cwd, 'exports');
    await mkdir(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:]/g, '-').slice(0, 16);
    const safe = doc.thread.title.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session';
    const file = join(folder, safe + '-' + stamp + '.md');
    await writeFile(file, markdown, 'utf8');
    return { path: relativeTo(doc.thread.cwd, file) };
  }

  /** Store an uploaded / dropped file inside the workspace so it can be referenced. */
  private async attachFile(threadId: string, name: string, data: string): Promise<{ path: string }> {
    const doc = await this.threadDoc(threadId);
    const buffer = Buffer.from(data, 'base64');
    if (buffer.length === 0) throw new Error('文件是空的');
    if (buffer.length > 10 * 1024 * 1024) throw new Error('文件超过 10 MB');
    const safe = name.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'attachment';
    const folder = join(doc.thread.cwd, 'uploads');
    await mkdir(folder, { recursive: true });
    const stamp = Date.now().toString(36);
    const dot = safe.lastIndexOf('.');
    const file = dot > 0 ? `${safe.slice(0, dot)}-${stamp}${safe.slice(dot)}` : `${safe}-${stamp}`;
    await writeFile(join(folder, file), buffer);
    return { path: relativeTo(doc.thread.cwd, join(folder, file)) };
  }

  private async readDocument(threadId: string, path: string): Promise<DocumentPayload> {
    const doc = await this.threadDoc(threadId);
    const full = resolveInside(doc.thread.cwd, path);
    const info = await stat(full);
    if (!info.isFile()) throw new Error(`${path} is not a file`);
    if (!TEXT_EXTENSIONS.has(extname(full).toLowerCase())) {
      return {
        path,
        language: 'binary',
        content: `Binary document (${basename(full)}, ${(info.size / 1024).toFixed(1)} KB). Open it in its own app.`,
        truncated: false,
        updatedAt: info.mtimeMs,
      };
    }
    const buffer = await readFile(full);
    const truncated = buffer.length > MAX_DOC_BYTES;
    return {
      path,
      language: languageOf(full),
      content: buffer.subarray(0, MAX_DOC_BYTES).toString('utf8'),
      truncated,
      updatedAt: info.mtimeMs,
    };
  }

  /** Images are rendered inline in the preview, so hand the renderer a data URL. */
  private async readImage(threadId: string, path: string): Promise<{ dataUrl: string; mime: string } | null> {
    const doc = await this.threadDoc(threadId);
    const full = resolveInside(doc.thread.cwd, path);
    const extension = extname(full).toLowerCase();
    const mime = IMAGE_EXTENSIONS[extension];
    if (!mime) return null;
    const info = await stat(full);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) return null;
    const buffer = await readFile(full);
    return { dataUrl: `data:${mime};base64,${buffer.toString('base64')}`, mime };
  }

  private async diff(threadId: string, path: string, snapshotId?: string): Promise<DiffPayload> {
    const doc = await this.threadDoc(threadId);
    const snapshot = snapshotId
      ? doc.snapshots.find((entry) => entry.id === snapshotId)
      : doc.snapshots.at(-1);
    const current = await readFile(resolveInside(doc.thread.cwd, path), 'utf8').catch(() => '');
    let before = '';
    if (snapshot) {
      before = await readFile(join(this.store.home, 'snapshots', threadId, snapshot.id, 'tree', path), 'utf8').catch(() => '');
    }
    const beforeLines = before.split(/\r?\n/);
    const afterLines = current.split(/\r?\n/);
    const beforeSet = new Map<string, number>();
    for (const line of beforeLines) beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
    let additions = 0;
    for (const line of afterLines) {
      const count = beforeSet.get(line) ?? 0;
      if (count > 0) beforeSet.set(line, count - 1);
      else additions += 1;
    }
    const afterSet = new Map<string, number>();
    for (const line of afterLines) afterSet.set(line, (afterSet.get(line) ?? 0) + 1);
    let deletions = 0;
    for (const line of beforeLines) {
      const count = afterSet.get(line) ?? 0;
      if (count > 0) afterSet.set(line, count - 1);
      else deletions += 1;
    }
    return { path, before, after: current, additions, deletions };
  }
}
