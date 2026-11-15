import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDot,
  FileDiff,
  FileText,
  FolderSearch,
  ListChecks,
  Loader2,
  PencilLine,
  RotateCcw,
  Search,
  ShieldAlert,
  SquareTerminal,
  TriangleAlert,
} from 'lucide-react';
import { CopyButton } from './CopyButton';
import { MarkdownText } from './MarkdownText';
import type {
  ApprovalItem,
  CheckpointItem,
  CompactionItem,
  Item,
  NoticeItem,
  PlanItem,
  ReasoningItem,
  ToolCallItem,
  ToolResultItem,
  Turn,
} from '../../shared/types';
import { duration } from '../lib/format';

interface TimelineProps {
  items: Item[];
  turn?: Turn | null;
  running: boolean;
  /** Tick used for the live elapsed counter. */
  now: number;
  onRevert: (snapshotId: string) => void;
  onOpenPath: (path: string) => void;
  onReview: (path: string) => void;
}

const TOOL_ICON: Record<string, ReactNode> = {
  read_file: <FileText size={15} strokeWidth={1.5} />,
  list_dir: <FolderSearch size={15} strokeWidth={1.5} />,
  glob_files: <FolderSearch size={15} strokeWidth={1.5} />,
  grep_text: <Search size={15} strokeWidth={1.5} />,
  write_file: <PencilLine size={15} strokeWidth={1.5} />,
  edit_file: <PencilLine size={15} strokeWidth={1.5} />,
  run_shell: <SquareTerminal size={15} strokeWidth={1.5} />,
  todo_write: <ListChecks size={15} strokeWidth={1.5} />,
  memory_write: <Brain size={15} strokeWidth={1.5} />,
};

const TOOL_LABEL: Record<string, string> = {
  read_file: '读取文件',
  list_dir: '浏览目录',
  glob_files: '查找文件',
  grep_text: '搜索文本',
  write_file: '写入文件',
  edit_file: '编辑文件',
  run_shell: '执行命令',
  todo_write: '更新计划',
  memory_write: '写入记忆',
};

function summarizeTools(calls: ToolCallItem[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (key: string, text: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(text);
  };
  for (const call of calls) {
    if (call.name === 'read_file') add('read', '读取文件');
    else if (call.name === 'grep_text') add('grep', '搜索代码');
    else if (call.name === 'write_file' || call.name === 'edit_file') add('write', '写入文件');
    else if (call.name === 'run_shell') add('exec', '执行命令');
    else if (call.name === 'list_dir' || call.name === 'glob_files') add('browse', '浏览目录');
    else if (call.name === 'todo_write') add('todo', '更新计划');
    else if (call.name === 'memory_write') add('memory', '写入记忆');
    else add(call.name, '执行工具');
  }
  if (parts.length === 0) return '';
  const head = `已${parts.slice(0, 3).join('、')}`;
  return parts.length > 3 ? `${head}等` : head;
}

function toolLabel(name: string): string {
  return TOOL_LABEL[name] ?? name;
}

function riskLabel(call: ToolCallItem): string | null {
  if (call.risk === 'exec') return '命令';
  if (call.risk === 'write') return '写入';
  return null;
}

function elapsedText(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function ToolCard({ call, result, onOpenPath }: { call: ToolCallItem; result?: ToolResultItem; onOpenPath: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  const failed = Boolean(result && !result.ok);
  const files = result?.files ?? [];

  return (
    <div className={`tool-card ${failed ? 'tool-failed' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((value) => !value)} type="button">
        <span className="tool-glyph">
          {result ? (
            failed ? (
              <TriangleAlert size={14} strokeWidth={1.6} className="step-failed" />
            ) : (
              <CircleCheck size={14} strokeWidth={1.7} className="step-check" />
            )
          ) : (
            <Loader2 size={14} strokeWidth={2} className="spin" />
          )}
        </span>
        <span className="tool-name">{toolLabel(call.name)}</span>
        <span className="tool-arg">{call.summary.replace(`${call.name} `, '')}</span>
        <span className="tool-tail">
          {result ? <CopyButton text={result.output || result.summary} label="复制输出" className="tool-copy" /> : null}
          {failed ? <TriangleAlert size={13} strokeWidth={1.6} className="warn" /> : null}
          {riskLabel(call) ? <span className={`risk risk-${call.risk}`}>{riskLabel(call)}</span> : null}
          <span className="mono dim">{result ? duration(result.durationMs) : '运行中'}</span>
          <ChevronRight size={13} strokeWidth={1.6} className={`chev ${open ? 'open' : ''}`} />
        </span>
      </button>
      {open ? (
        <div className="tool-body">
          {result ? (
            <>
              <div className="tool-summary">
                <span className={failed ? 'text-warn' : 'text-ok'}>{result.summary}</span>
                {result.layer !== 'none' ? <span className="chip chip-quiet mono">{result.layer}</span> : null}
              </div>
              {failed && result.hint ? <pre className="hint">{result.hint}</pre> : null}
              <pre className="output">{result.output || '(无输出)'}</pre>
              {files.length > 0 ? (
                <div className="tool-files">
                  {files.slice(0, 6).map((file) => (
                    <button key={file} type="button" className="file-chip mono" onClick={() => onOpenPath(file)}>
                      {file}
                    </button>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="dim">等待结果…</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The model's thinking, collapsed to one line until asked. */
function ThoughtRow({ item, live }: { item: ReasoningItem; live: boolean }) {
  const [open, setOpen] = useState(false);
  const preview = item.text.replace(/\s+/g, ' ').trim();
  return (
    <div className={`thought ${open ? 'open' : ''}`}>
      <button type="button" className="thought-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        {live ? (
          <Loader2 size={14} strokeWidth={2} className="spin thought-glyph" />
        ) : (
          <CircleCheck size={14} strokeWidth={1.7} className="step-check thought-glyph" />
        )}
        <span className="thought-label">{live ? '思考中' : '已思考'}</span>
        {!open ? <span className="thought-preview">{preview}</span> : null}
        <ChevronDown size={12} strokeWidth={1.6} className={`chev ${open ? 'flip' : ''}`} />
      </button>
      {open ? <pre className="thought-text">{item.text}</pre> : null}
    </div>
  );
}

function PlanCard({ item }: { item: PlanItem }) {
  const done = item.steps.filter((step) => step.status === 'done').length;
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-label">计划</span>
        <span className="mono dim">
          {done}/{item.steps.length}
        </span>
      </div>
      <ol className="plan-list">
        {item.steps.map((step) => (
          <li key={step.id} className={`plan-step step-${step.status}`}>
            {step.status === 'done' ? (
              <CircleCheck size={14} strokeWidth={1.6} />
            ) : step.status === 'active' ? (
              <CircleDot size={14} strokeWidth={1.8} />
            ) : (
              <span className="plan-dot" />
            )}
            <span>{step.title}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The change card: what a step actually wrote, with per-file counts, and the
 * two actions that matter — undo it, or open the diff to review it.
 */
function ChangeCard({
  item,
  onRevert,
  onReview,
}: {
  item: CheckpointItem;
  onRevert: (snapshotId: string) => void;
  onReview: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const stats = item.changeStats;
  const files = stats?.files.length
    ? stats.files
    : item.filesTouched.map((path) => ({ path, additions: 0, deletions: 0 }));
  const shown = expanded ? files : files.slice(0, 3);
  const remaining = files.length - shown.length;

  return (
    <div className="artifact">
      <div className="artifact-head">
        <span className="artifact-glyph">
          <FileDiff size={16} strokeWidth={1.5} />
        </span>
        <div className="artifact-title">
          <span>已编辑 {files.length} 个文件</span>
          {stats ? (
            <span className="counts mono">
              <span className="add">+{stats.additions}</span> <span className="del">−{stats.deletions}</span>
            </span>
          ) : (
            <span className="mono dim">{item.snapshotId}</span>
          )}
        </div>
        <div className="artifact-actions">
          <button type="button" className="mini" onClick={() => onRevert(item.snapshotId)}>
            <RotateCcw size={12} strokeWidth={1.7} />
            撤销
          </button>
          <button
            type="button"
            className="mini"
            onClick={() => files[0] && onReview(files[0].path)}
            disabled={files.length === 0}
          >
            审查
          </button>
        </div>
      </div>
      <ul className="artifact-files">
        {shown.map((file) => (
          <li key={file.path}>
            <button type="button" className="artifact-file" onClick={() => onReview(file.path)}>
              <span className="mono path">{file.path}</span>
              <span className="mono counts">
                <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {remaining > 0 || expanded ? (
        <button type="button" className="artifact-more" onClick={() => setExpanded((value) => !value)}>
          {remaining > 0 ? `再显示 ${remaining} 个文件` : '收起'}
          <ChevronDown size={13} strokeWidth={1.6} className={expanded ? 'flip' : ''} />
        </button>
      ) : null}
    </div>
  );
}

function NoticeCard({ item }: { item: NoticeItem }) {
  return (
    <div className={`notice notice-${item.tone}`}>
      <ShieldAlert size={15} strokeWidth={1.5} />
      <div>
        <strong>{item.title}</strong>
        <p>{item.body}</p>
      </div>
    </div>
  );
}

function ApprovalRow({ item }: { item: ApprovalItem }) {
  return (
    <div className="approval-done">
      <span className="mono">$ {item.command}</span>
      <span className={`chip ${item.decision === 'deny' ? 'chip-warn' : 'chip-ok'}`}>
        {item.decision === 'deny' ? '已拒绝' : item.decision === 'allow_always' ? '本会话允许' : '已允许'}
      </span>
    </div>
  );
}

function CompactionCard({ item }: { item: CompactionItem }) {
  return (
    <details className="compaction">
      <summary>
        上下文折叠 · {item.foldedItems} 项 · {Math.round(item.tokensBefore / 100) / 10}k →{' '}
        {Math.round(item.tokensAfter / 100) / 10}k tokens
      </summary>
      <p>{item.summary}</p>
    </details>
  );
}

/** One user turn: process rows collapse under "已处理 / 执行中", the answer stays out. */
function TurnBlock({
  turnId,
  items,
  live,
  latest,
  elapsed,
  results,
  onRevert,
  onOpenPath,
  onReview,
}: {
  turnId: string;
  items: Item[];
  live: boolean;
  latest: boolean;
  elapsed: number;
  results: Map<string, ToolResultItem>;
  onRevert: (snapshotId: string) => void;
  onOpenPath: (path: string) => void;
  onReview: (path: string) => void;
}) {
  const interrupted = items.some(
    (item) => item.kind === 'notice' && item.tone === 'warn' && /中断|退出/.test(item.title),
  );
  const failed = interrupted || items.some((item) => item.kind === 'notice' && item.tone === 'error');
  const [open, setOpen] = useState(false);

  // Errors and warnings are not "process": they stay outside the fold so a
  // failure is never hidden behind a click.
  const alerts = items.filter((item): item is NoticeItem => item.kind === 'notice' && item.tone !== 'info');

  // Process is folded by default. If the user opened it during a run, the
  // moment the turn ends it folds back so the answer is what remains.
  useEffect(() => {
    if (!live) setOpen(false);
  }, [live]);

  const users = items.filter((item): item is Extract<Item, { kind: 'message' }> => item.kind === 'message' && item.role === 'user');
  const assistantMessages = items.filter(
    (item): item is Extract<Item, { kind: 'message' }> => item.kind === 'message' && item.role === 'assistant' && item.text.trim().length > 0,
  );
  const finalMessage = assistantMessages[assistantMessages.length - 1];
  const processItems = items.filter(
    (item) =>
      item.kind !== 'tool_result' &&
      item.kind !== 'message' &&
      item.id !== finalMessage?.id &&
      !alerts.some((alert) => alert.id === item.id),
  );
  const processMessages = items.filter(
    (item): item is Extract<Item, { kind: 'message' }> => item.kind === 'message' && item.role === 'assistant' && item.id !== finalMessage?.id && item.text.trim().length > 0,
  );
  const toolCount = processItems.filter((item) => item.kind === 'tool_call').length;

  const streaming = assistantMessages.find((item) => item.status === 'running');
  const lastCall = [...items].reverse().find((item): item is ToolCallItem => item.kind === 'tool_call');
  const callPending =
    Boolean(lastCall) && !items.some((item) => item.kind === 'tool_result' && item.callId === lastCall?.callId);
  const activity = callPending && lastCall
    ? `${toolLabel(lastCall.name)} · ${lastCall.summary.replace(`${lastCall.name} `, '')}`
    : '思考中…';

  const rows: ReactNode[] = [];
  for (const item of processItems) {
    if (item.kind === 'tool_call') {
      rows.push(<ToolCard key={item.id} call={item} result={results.get(item.callId)} onOpenPath={onOpenPath} />);
      continue;
    }
    if (item.kind === 'notice') rows.push(<NoticeCard key={item.id} item={item} />);
    else if (item.kind === 'plan') rows.push(<PlanCard key={item.id} item={item} />);
    else if (item.kind === 'approval') rows.push(<ApprovalRow key={item.id} item={item} />);
    else if (item.kind === 'compaction') rows.push(<CompactionCard key={item.id} item={item} />);
    else if (item.kind === 'reasoning') rows.push(<ThoughtRow key={item.id} item={item} live={live} />);
  }
  if (live && streaming === undefined) {
    rows.push(
      <div key="waiting" className="step-waiting">
        <Loader2 size={14} strokeWidth={2} className="spin" />
        思考中…
      </div>,
    );
  }

  const checkpoints = items.filter((item): item is CheckpointItem => item.kind === 'checkpoint');
  let resultCard: CheckpointItem | null = null;
  if (checkpoints.length > 0) {
    const files = new Map<string, { path: string; additions: number; deletions: number }>();
    let additions = 0;
    let deletions = 0;
    for (const checkpoint of checkpoints) {
      const changed = checkpoint.changeStats?.files.length
        ? checkpoint.changeStats.files
        : checkpoint.filesTouched.map((path) => ({ path, additions: 0, deletions: 0 }));
      for (const file of changed) files.set(file.path, file);
      additions += checkpoint.changeStats?.additions ?? 0;
      deletions += checkpoint.changeStats?.deletions ?? 0;
    }
    if (files.size > 0) {
      const last = checkpoints[checkpoints.length - 1];
      resultCard = {
        ...last,
        changeStats: {
          additions,
          deletions,
          files: [...files.values()].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)),
        },
        filesTouched: [...files.keys()],
      };
    }
  }

  const hasProcess = rows.length > 0 || toolCount > 0 || processMessages.length > 0;

  const reply = finalMessage ? (
    <article key={finalMessage.id} className="turn turn-reply">
      <div className="agent-text">
        <MarkdownText text={finalMessage.text} />
        {finalMessage.status === 'running' && streaming?.id === finalMessage.id ? <span className="caret" /> : null}
      </div>
      {finalMessage.evidence && finalMessage.evidence.length > 0 ? (
        <div className="evidence mono">
          {finalMessage.evidence.map((tag) => (
            <span key={tag}>{tag}</span>
          ))}
        </div>
      ) : null}
    </article>
  ) : null;

  return (
    <section className="turn-block" data-turn={turnId}>
      {users.map((item) => (
        <article key={item.id} className="turn turn-user">
          <p className="user-text">{item.text}</p>
          <div className="message-actions user-actions">
            <CopyButton text={item.text} label="复制这条提问" className="message-copy user-copy" />
          </div>
        </article>
      ))}

      {live ? <div className="reply-block">{reply}</div> : null}

      {hasProcess ? (
        <button type="button" className="turn-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <ChevronRight size={12} strokeWidth={1.8} className={`chev ${open ? 'open' : ''}`} />
          {live ? <Loader2 size={12} strokeWidth={2} className="spin" /> : failed ? <TriangleAlert size={12} strokeWidth={1.8} className="warn" /> : null}
          <span className="turn-head-label">{live ? '正在执行' : failed ? '已中断' : '已完成'}</span>
          <span className="turn-head-dot">·</span>
          {live ? (
            <span className="turn-head-activity">{activity}</span>
          ) : (
            <span className="turn-head-meta mono">用时 {elapsedText(elapsed)}</span>
          )}
          {live ? <span className="turn-head-meta mono turn-head-clock">{elapsedText(elapsed)}</span> : null}
          {!live && toolCount > 0 && open ? (
            <>
              <span className="turn-head-dot">·</span>
              <span className="turn-head-meta mono">{toolCount} 次工具</span>
            </>
          ) : null}
        </button>
      ) : null}

      {alerts.map((item) => (
        <NoticeCard key={item.id} item={item} />
      ))}

      {!open && hasProcess && !live ? (
        <div className="turn-summary">
          {summarizeTools(processItems.filter((item): item is ToolCallItem => item.kind === 'tool_call'))}
        </div>
      ) : null}

      {open && hasProcess ? (
        <div className="turn-process">
          {rows}
          {processMessages.map((item) => (
            <div key={item.id} className="process-text">
              <MarkdownText text={item.text} />
            </div>
          ))}
        </div>
      ) : null}

      {!live ? (
        <div className="reply-block">
          {reply}
          {resultCard ? (
            <div className="turn-result">
              <ChangeCard item={resultCard} onRevert={onRevert} onReview={onReview} />
            </div>
          ) : null}
          {finalMessage && finalMessage.status !== 'running' ? (
            <div className="message-actions reply-actions">
              <CopyButton text={finalMessage.text} label="复制这段回复" className="message-copy" />
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function Timeline({ items, turn, running, now, onRevert, onOpenPath, onReview }: TimelineProps) {
  const results = useMemo(() => {
    const map = new Map<string, ToolResultItem>();
    for (const item of items) {
      if (item.kind === 'tool_result') map.set(item.callId, item);
    }
    return map;
  }, [items]);

  const groups = useMemo(() => {
    const list: Array<{ id: string; items: Item[] }> = [];
    for (const item of items) {
      const last = list[list.length - 1];
      if (!last || last.id !== item.turnId) list.push({ id: item.turnId, items: [item] });
      else last.items.push(item);
    }
    return list;
  }, [items]);

  return (
    <div className="timeline">
      {groups.map((group) => {
        const live = Boolean(running && turn && turn.id === group.id);
        const first = group.items[0];
        const last = group.items[group.items.length - 1];
        const started = live && turn ? turn.startedAt : first.at;
        const ended = live ? now : (turn && turn.id === group.id ? turn.endedAt : undefined) ?? last.at;
        return (
          <TurnBlock
            key={group.id}
            turnId={group.id}
            items={group.items}
            live={live}
            latest={group.id === groups[groups.length - 1].id}
            elapsed={Math.max(0, ended - started)}
            results={results}
            onRevert={onRevert}
            onOpenPath={onOpenPath}
            onReview={onReview}
          />
        );
      })}
    </div>
  );
}
