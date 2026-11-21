import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Brain,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleStop,
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
import { QuestionCard } from './QuestionCard';
import type {
  ApprovalItem,
  CheckpointItem,
  CompactionItem,
  Item,
  MessageItem,
  NoticeItem,
  QuestionItem,
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
  onReview: (path: string, snapshotId?: string) => void;
  onAnswerQuestion: (questionId: string, answer: string) => Promise<void>;
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
  ask_user: '向你提问',
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

function ToolCard({
  call,
  result,
  live,
  onOpenPath,
}: {
  call: ToolCallItem;
  result?: ToolResultItem;
  live: boolean;
  onOpenPath: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // A call only counts as running while its turn is live. Once the turn is
  // over, a call without a result is a failed/cancelled step, never a spinner.
  const running = live && !result && call.status === 'running';
  const cancelled = result?.status === 'cancelled' || (!result && call.status === 'cancelled');
  const failed = !cancelled && (Boolean(result && !result.ok) || (!running && !result));
  const files = result?.files ?? [];

  return (
    <div className={`tool-card ${failed ? 'tool-failed' : ''}`}>
      <button className="tool-head" onClick={() => setOpen((value) => !value)} type="button">
        <span className="tool-glyph">
          {running ? (
            <Loader2 size={14} strokeWidth={2} className="spin" />
          ) : cancelled ? (
            <CircleStop size={14} strokeWidth={1.7} className="step-stopped" />
          ) : failed ? (
            <TriangleAlert size={14} strokeWidth={1.6} className="step-failed" />
          ) : (
            <CircleCheck size={14} strokeWidth={1.7} className="step-check" />
          )}
        </span>
        <span className="tool-name">{toolLabel(call.name)}</span>
        <span className="tool-arg">{call.summary.replace(`${call.name} `, '')}</span>
        <span className="tool-tail">
          {result ? <CopyButton text={result.output || result.summary} label="复制输出" className="tool-copy" /> : null}
          {failed ? <TriangleAlert size={13} strokeWidth={1.6} className="step-failed" /> : null}
          {riskLabel(call) ? <span className={`risk risk-${call.risk}`}>{riskLabel(call)}</span> : null}
          <span className="mono dim">
            {result ? duration(result.durationMs) : running ? '运行中' : cancelled ? '已停止' : '没有结果'}
          </span>
          <ChevronRight size={13} strokeWidth={1.6} className={`chev ${open ? 'open' : ''}`} />
        </span>
      </button>
      {open ? (
        <div className="tool-body">
          {result ? (
            <>
              <div className="tool-summary">
                <span className={failed ? 'text-danger' : cancelled ? 'dim' : 'text-ok'}>{result.summary}</span>
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
            <div className="dim">
              {running
                ? '等待结果…'
                : cancelled
                  ? '本轮已停止，工具没有返回结果。'
                  : '工具没有返回结果，这一轮已经结束。'}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The model's thinking, collapsed to one line until asked. */
/**
 * Hold a fast-changing label for a beat before showing it. The activity text
 * flips between 思考中…/回复中…/tool names as deltas land; without this it
 * re-lays out the status row several times a second and reads as a flicker.
 */
function useSettledText(value: string, holdMs = 500): string {
  const [shown, setShown] = useState(value);
  const latest = useRef(value);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    latest.current = value;
    if (value === shown || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setShown(latest.current);
    }, holdMs);
  }, [value, shown, holdMs]);

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return shown;
}

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

/**
 * The change card: what a step actually wrote, with per-file counts, and the
 * two actions that matter — undo it, or open the diff to review it.
 */
function ChangeCard({
  item,
  onRevert,
  onReview,
  snapshotFor,
}: {
  item: CheckpointItem;
  onRevert: (snapshotId: string) => void;
  onReview: (path: string, snapshotId?: string) => void;
  snapshotFor: (path: string) => string | undefined;
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
            onClick={() => files[0] && onReview(files[0].path, snapshotFor(files[0].path))}
            disabled={files.length === 0}
          >
            审查
          </button>
        </div>
      </div>
      <ul className="artifact-files">
        {shown.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              className="artifact-file"
              onClick={() => onReview(file.path, snapshotFor(file.path))}
            >
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

/**
 * A tool-calling step often opens with a line of narration ("I'll start by
 * looking at the workspace structure."). It is ordinary content, not reasoning,
 * but it reads like thinking and must not sit in the answer column. It lives in
 * the fold with the tools once the turn is over.
 */
function NarrationRow({ item }: { item: MessageItem }) {
  return <p className="process-note">{item.text.trim()}</p>;
}

function NoticeCard({ item }: { item: NoticeItem }) {
  const Icon = item.tone === 'info' ? ShieldAlert : item.tone === 'stopped' ? CircleStop : TriangleAlert;
  return (
    <div className={`notice notice-${item.tone}`}>
      <Icon size={15} strokeWidth={1.5} />
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
      <span className={`chip ${item.status === 'cancelled' ? 'chip-quiet' : item.decision === 'deny' ? 'chip-warn' : 'chip-ok'}`}>
        {item.status === 'cancelled' ? '已取消' : item.decision === 'deny' ? '已拒绝' : item.decision === 'allow_always' ? '本会话允许' : '已允许'}
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

/**
 * One user turn. The first line of the model's reply is always the process row:
 * thinking, tool calls and other machinery sit behind one expand/collapse
 * control. Everything the model says — intermediate output, clarifications and
 * the final answer — is rendered below it in the order it happened.
 */
function TurnBlock({
  turnId,
  items,
  live,
  elapsed,
  results,
  onRevert,
  onOpenPath,
  onReview,
  onAnswerQuestion,
}: {
  turnId: string;
  items: Item[];
  live: boolean;
  elapsed: number;
  results: Map<string, ToolResultItem>;
  onRevert: (snapshotId: string) => void;
  onOpenPath: (path: string) => void;
  onReview: (path: string, snapshotId?: string) => void;
  onAnswerQuestion: (questionId: string, answer: string) => Promise<void>;
}) {
  const stoppedByUser = items.some((item) => item.kind === 'notice' && item.tone === 'stopped');
  const interrupted = stoppedByUser || items.some(
    (item) => item.kind === 'notice' && item.tone === 'warn' && /中断|中止|停止|退出/.test(item.title),
  );
  const failed = interrupted || items.some((item) => item.kind === 'notice' && item.tone === 'error');
  const [open, setOpen] = useState(false);
  // Once the row has been on screen while the turn ran, keep it: unmounting it
  // when the turn closes pulls the answer up by the row's height, which reads
  // as a flash right as the final answer lands.
  const [everLive, setEverLive] = useState(live);
  useLayoutEffect(() => {
    if (live) setEverLive(true);
  }, [live]);

  // A finished turn folds back; while it runs the row stays put so the answer
  // never jumps from above the fold to below it. Layout effect: the fold must
  // land in the same frame as the status flip, not one paint later.
  useLayoutEffect(() => {
    if (!live) setOpen(false);
  }, [live]);

  const isAssistantText = (item: Item): item is MessageItem =>
    item.kind === 'message' && item.role === 'assistant' && item.text.trim().length > 0;
  const users = items.filter((item): item is MessageItem => item.kind === 'message' && item.role === 'user');
  const assistantMessages = items.filter(isAssistantText);
  const finalMessage = assistantMessages[assistantMessages.length - 1];
  // Every assistant message before the answer is narration that led into more
  // tool calls. While the turn runs it stays in the flow so nothing vanishes
  // under the reader; once the turn ends it folds in with the tools.
  const interim = assistantMessages.filter((item) => item.id !== finalMessage?.id);
  const interimIds = new Set(interim.map((item) => item.id));

  // Thinking, tools and the other process cards are the fold's contents.
  const processItems = items.filter(
    (item) =>
      item.kind === 'reasoning' ||
      item.kind === 'approval' ||
      item.kind === 'compaction' ||
      (item.kind === 'notice' && item.tone === 'info') ||
      (item.kind === 'tool_call' && item.name !== 'ask_user') ||
      (item.kind === 'message' && !live && interimIds.has(item.id)),
  );
  const toolCalls = processItems.filter((item): item is ToolCallItem => item.kind === 'tool_call');
  const toolCount = toolCalls.length;
  const hasProcess = processItems.length > 0;
  const hasReasoning = processItems.some((item) => item.kind === 'reasoning');
  const toolSummary = summarizeTools(toolCalls);

  const asking = items.some((item) => item.kind === 'question' && item.status === 'running');
  const streaming = assistantMessages.find((item) => item.status === 'running');
  const lastCall = [...items].reverse().find((item): item is ToolCallItem => item.kind === 'tool_call');
  const callPending =
    Boolean(lastCall) && !items.some((item) => item.kind === 'tool_result' && item.callId === lastCall?.callId);
  const activity = asking
    ? '等待你的回答'
    : callPending && lastCall
      ? `${toolLabel(lastCall.name)} · ${lastCall.summary.replace(`${lastCall.name} `, '')}`
      : streaming
        ? '回复中…'
        : '思考中…';
  const settledActivity = useSettledText(activity);

  const rows: ReactNode[] = [];
  for (const item of processItems) {
    if (item.kind === 'tool_call') {
      rows.push(
        <ToolCard key={item.id} call={item} result={results.get(item.callId)} live={live} onOpenPath={onOpenPath} />,
      );
      continue;
    }
    if (item.kind === 'message') rows.push(<NarrationRow key={item.id} item={item} />);
    else if (item.kind === 'notice') rows.push(<NoticeCard key={item.id} item={item} />);
    else if (item.kind === 'approval') rows.push(<ApprovalRow key={item.id} item={item} />);
    else if (item.kind === 'compaction') rows.push(<CompactionCard key={item.id} item={item} />);
    else if (item.kind === 'reasoning') rows.push(<ThoughtRow key={item.id} item={item} live={live} />);
  }
  if (live && streaming === undefined && !asking) {
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

  // The earliest checkpoint that touched a file holds the state before this
  // turn's edit. Using the latest snapshot instead would already contain the
  // edited file and show a misleading +0/−0 diff.
  const snapshotFor = (path: string): string | undefined =>
    checkpoints.find(
      (checkpoint) =>
        checkpoint.filesTouched.includes(path) ||
        checkpoint.changeStats?.files.some((file) => file.path === path) === true,
    )?.snapshotId ?? resultCard?.snapshotId;

  // The answer is the last assistant message; narration from earlier steps is
  // in the fold. While the turn runs, that narration stays in the flow so the
  // reader can follow it live, then it folds away with the tools.
  const visible = items.filter(
    (item): item is MessageItem | QuestionItem | NoticeItem =>
      (isAssistantText(item) && (live || item.id === finalMessage?.id)) ||
      (item.kind === 'question' && item.status !== 'running') ||
      (item.kind === 'notice' && item.tone !== 'info'),
  );

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

      {hasProcess || live || everLive ? (
        <button
          type="button"
          className="turn-head"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={hasProcess ? open : undefined}
          disabled={!hasProcess}
          title={
            !hasProcess ? undefined : open ? '收起思考与工具调用' : '展开思考与工具调用'
          }
        >
          {hasProcess ? (
            <ChevronRight size={12} strokeWidth={1.8} className={`chev ${open ? 'open' : ''}`} />
          ) : null}
          {live ? (
            <Loader2 size={12} strokeWidth={2} className="spin" />
          ) : stoppedByUser ? (
            <CircleStop size={12} strokeWidth={1.8} className="step-stopped" />
          ) : interrupted ? (
            <TriangleAlert size={12} strokeWidth={1.8} className="warn" />
          ) : failed ? (
            <TriangleAlert size={12} strokeWidth={1.8} className="step-failed" />
          ) : null}
          <span className={`turn-head-label${!live && failed && !interrupted ? ' turn-head-failed' : ''}`}>
            {live ? '正在执行' : stoppedByUser ? '已停止' : interrupted ? '已中断' : failed ? '失败' : '已完成'}
          </span>
          <span className="turn-head-dot">·</span>
          {live ? (
            <span className="turn-head-activity">{settledActivity}</span>
          ) : (
            <span className="turn-head-meta mono">用时 {elapsedText(elapsed)}</span>
          )}
          {!live && toolSummary ? (
            <>
              <span className="turn-head-dot">·</span>
              <span className="turn-head-summary">{toolSummary}</span>
            </>
          ) : null}
          {!live && toolCount > 0 ? (
            <>
              <span className="turn-head-dot">·</span>
              <span className="turn-head-meta mono">{toolCount} 次工具</span>
            </>
          ) : null}
          {hasReasoning ? (
            <>
              <span className="turn-head-dot">·</span>
              <span className="turn-head-meta">已思考</span>
            </>
          ) : null}
          {live ? <span className="turn-head-meta mono turn-head-clock">{elapsedText(elapsed)}</span> : null}
        </button>
      ) : null}

      {open && hasProcess ? <div className="turn-process">{rows}</div> : null}

      <div className="reply-block">
        {visible.map((item) => {
          if (isAssistantText(item)) {
            const isFinal = item.id === finalMessage?.id;
            return (
              <article key={item.id} className={`turn turn-reply${isFinal ? ' turn-final' : ''}`}>
                <div className="agent-text">
                  <MarkdownText text={item.text} />
                  {item.status === 'running' ? <span className="caret" /> : null}
                </div>
                {isFinal && item.evidence && item.evidence.length > 0 ? (
                  <div className="evidence mono">
                    {item.evidence.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          }
          if (item.kind === 'question') {
            return <QuestionCard key={item.id} item={item} onAnswer={onAnswerQuestion} />;
          }
          return <NoticeCard key={item.id} item={item} />;
        })}
      </div>

      {!live && resultCard ? (
        <div className="turn-result">
          <ChangeCard item={resultCard} onRevert={onRevert} onReview={onReview} snapshotFor={snapshotFor} />
        </div>
      ) : null}

      {/* One action row per turn, after everything the turn rendered. Cards
          added later (result, question, notice) never push it up. */}
      {!live && finalMessage ? (
        <div className="message-actions turn-actions">
          <CopyButton text={finalMessage.text} label="复制这段回复" className="message-copy" />
        </div>
      ) : null}
    </section>
  );
}

export function Timeline({ items, turn, running, now, onRevert, onOpenPath, onReview, onAnswerQuestion }: TimelineProps) {
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
            elapsed={Math.max(0, ended - started)}
            results={results}
            onRevert={onRevert}
            onOpenPath={onOpenPath}
            onReview={onReview}
            onAnswerQuestion={onAnswerQuestion}
          />
        );
      })}
    </div>
  );
}
