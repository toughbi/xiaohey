import { useState, type CSSProperties } from 'react';
import { Check, ChevronLeft, Eye, Upload, CornerDownRight, File, FileCode2, Folder, FolderOpen, Pencil, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { FilePreview } from './FilePreview';
import { CopyButton } from './CopyButton';
import { call } from '../lib/client';
import type {
  ApprovalItem,
  DiffPayload,
  DocumentPayload,
  FileEntry,
  MemoryFact,
  PlanStep,
  SnapshotMeta,
  TaskContract,
} from '../../shared/types';
import { basename, fileSize, relativeTime } from '../lib/format';
import { diffStats, foldDiff, lineDiff } from '../lib/diff';

export type DocTab = 'files' | 'preview' | 'memory' | 'checkpoints' | 'approvals';

interface DocumentPanelProps {
  width: number;
  tab: DocTab;
  onTab: (tab: DocTab) => void;
  dir: string;
  files: FileEntry[];
  doc: DocumentPayload | null;
  diff: DiffPayload | null;
  memory: MemoryFact[];
  snapshots: SnapshotMeta[];
  contract: TaskContract | null;
  plan: PlanStep[];
  view: 'source' | 'diff';
  onView: (view: 'source' | 'diff') => void;
  onNavigate: (path: string) => void;
  onOpenFile: (path: string) => void;
  onDeleteMemory: (slot: string) => void;
  onRevert: (snapshotId: string) => void;
  onMemorySet: (slot: string, value: string) => void;
  onRefreshFiles: () => void;
  approvals: ApprovalItem[];
  threadId: string;
  onOpenExternal: (url: string) => void;
}

const TABS: Array<{ id: DocTab; label: string }> = [
  { id: 'files', label: '文件' },
  { id: 'preview', label: '文档' },
  { id: 'memory', label: '记忆' },
  { id: 'checkpoints', label: '检查点' },
  { id: 'approvals', label: '审批' },
];

const MEMORY_KIND_LABEL: Record<MemoryFact['kind'], string> = {
  episodic: '情景',
  relational: '关系',
  knowledge: '知识',
};

const MEMORY_OUTCOME_LABEL: Record<string, string> = {
  success: '成功',
  failure: '失败',
  partial: '部分完成',
};

export function DocumentPanel(props: DocumentPanelProps) {
  const { width, tab, onTab, dir, files, doc, diff, memory, snapshots, approvals, view, onView, threadId, onOpenExternal, onMemorySet, onRefreshFiles } = props;
  const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '.';
  const [memorySlot, setMemorySlot] = useState('');
  const [memoryValue, setMemoryValue] = useState('');
  const [editing, setEditing] = useState<{ slot: string; value: string } | null>(null);
  const [fileQuery, setFileQuery] = useState('');
  const [revertPreview, setRevertPreview] = useState<{ snapshotId: string; entries: Array<{ path: string; status: 'restore' | 'delete'; additions: number; deletions: number; before: string; after: string }> } | null>(null);
  const [openPreviewFile, setOpenPreviewFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const previewRevert = async (snapshotId: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await call('snapshot/preview', { threadId, snapshotId });
      setRevertPreview({ snapshotId, entries: result.entries });
    } finally {
      setBusy(false);
    }
  };

  const uploadFiles = async (files: FileList | null): Promise<void> => {
    if (!files) return;
    setBusy(true);
    try {
      for (const file of Array.from(files).slice(0, 5)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = '';
        for (let index = 0; index < bytes.length; index += 8192) {
          binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        }
        await call('fs/attach', { threadId, name: file.name, data: btoa(binary) });
      }
      props.onRefreshFiles();
    } finally {
      setBusy(false);
    }
  };
  const saveMemory = (slot: string, value: string): void => {
    if (!value.trim()) return;
    onMemorySet(slot.trim(), value.trim());
    setMemorySlot('');
    setMemoryValue('');
    setEditing(null);
  };

  return (
    <aside className="docs" style={{ width }}>
      <div className="docs-tabs" role="tablist">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={`docs-tab ${tab === entry.id ? 'active' : ''}`}
            onClick={() => onTab(entry.id)}
          >
            {entry.label}
            {entry.id === 'memory' && memory.length > 0 ? <span className="mono dim">{memory.length}</span> : null}
            {entry.id === 'checkpoints' && snapshots.length > 0 ? <span className="mono dim">{snapshots.length}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'files' ? (
        <div className="docs-body">
          <div className="docs-path">
            <button type="button" className="ghost icon" onClick={() => props.onNavigate(parent)} aria-label="上一级">
              <ChevronLeft size={14} strokeWidth={1.6} />
            </button>
            <span className="mono">{dir === '.' ? '工作区根目录' : dir}</span>
            <span className="path-actions">
              <label className="ghost icon tiny upload-btn" title="上传文件到 uploads/" aria-label="上传文件">
                <Upload size={13} strokeWidth={1.6} />
                <input type="file" multiple hidden onChange={(event) => void uploadFiles(event.target.files)} />
              </label>
              <button type="button" className="ghost icon tiny" onClick={() => props.onRefreshFiles()} aria-label="刷新" title="刷新">
                <RefreshCw size={13} strokeWidth={1.6} />
              </button>
            </span>
          </div>
          <input
            className="docs-search"
            value={fileQuery}
            onChange={(event) => setFileQuery(event.target.value)}
            placeholder="筛选文件…"
            aria-label="筛选文件"
          />
          <ul className="file-list">
            {files
              .filter((entry) => !fileQuery.trim() || entry.name.toLowerCase().includes(fileQuery.trim().toLowerCase()))
              .map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className="file-row"
                  draggable={!entry.dir}
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/x-xiaohei-path', entry.path);
                    event.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => (entry.dir ? props.onNavigate(entry.path) : props.onOpenFile(entry.path))}
                >
                  <span className="file-icon">
                    {entry.dir ? <Folder size={15} strokeWidth={1.5} /> : <File size={15} strokeWidth={1.5} />}
                  </span>
                  <span className="file-name">{entry.name}</span>
                  <span className="mono dim file-meta">{entry.dir ? '' : fileSize(entry.size)}</span>
                </button>
              </li>
              ))}
          </ul>
          {files.length === 0 ? <p className="docs-empty">这个目录是空的。</p> : null}
        </div>
      ) : null}

      {tab === 'preview' ? (
        <div className="docs-body">
          {doc ? (
            <>
              <div className="docs-path">
                <FileCode2 size={14} strokeWidth={1.5} />
                <span className="mono">{doc.path}</span>
                <span className="mono dim">{doc.language}</span>
                <span className="mono dim">{relativeTime(doc.updatedAt)}</span>
                <span className="path-actions">
                  <button
                    type="button"
                    className="ghost icon tiny"
                    onClick={() => void call('app/reveal', { path: doc.path, threadId })}
                    aria-label="在资源管理器中显示"
                    title="在资源管理器中显示"
                  >
                    <FolderOpen size={13} strokeWidth={1.6} />
                  </button>
                  <CopyButton text={doc.content} label="复制文件内容" className="tiny-copy" />
                </span>
              </div>
              {diff && (view === 'diff' || diff.additions > 0 || diff.deletions > 0) ? (
                <div className="segmented">
                  <button type="button" className={view === 'source' ? 'active' : ''} onClick={() => onView('source')}>
                    原文
                  </button>
                  <button type="button" className={view === 'diff' ? 'active' : ''} onClick={() => onView('diff')}>
                    改动 <span className="mono dim">+{diff.additions} −{diff.deletions}</span>
                  </button>
                </div>
              ) : null}
              {view === 'diff' && diff ? <DiffView diff={diff} /> : <FilePreview doc={doc} threadId={threadId} onOpenExternal={onOpenExternal} />}
            </>
          ) : (
            <Overview contract={props.contract} plan={props.plan} snapshots={snapshots} onOpenFile={props.onOpenFile} />
          )}
        </div>
      ) : null}

      {tab === 'memory' ? (
        <div className="docs-body">
          <div className="docs-note">
            <CornerDownRight size={14} strokeWidth={1.5} />
            <span>长期记忆分情景 / 关系 / 知识三类，模型需要时会自己读；冲突的会标出来，不会自动挑一个。</span>
          </div>
          <div className="memory-form">
            <input
              value={memorySlot}
              onChange={(event) => setMemorySlot(event.target.value)}
              placeholder="槽位，例如 env.packageManager"
              aria-label="记忆槽位"
            />
            <input
              value={memoryValue}
              onChange={(event) => setMemoryValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveMemory(memorySlot, memoryValue);
              }}
              placeholder="要记住的事实或约束"
              aria-label="记忆内容"
            />
            <button type="button" className="mini" onClick={() => saveMemory(memorySlot, memoryValue)} disabled={!memoryValue.trim()}>
              记下
            </button>
          </div>
          <ul className="memory-list">
            {memory.map((fact) => (
              <li key={fact.id} className={fact.conflicts ? 'disputed' : ''}>
                <div className="memory-head">
                  <span className="chip chip-quiet mono">{MEMORY_KIND_LABEL[fact.kind]}</span>
                  <span className="mono memory-slot">{fact.slot}</span>
                  <span className="chip chip-quiet mono">{fact.importance}</span>
                  {fact.kind === 'knowledge' ? (
                    <button type="button" className="ghost icon tiny" onClick={() => setEditing({ slot: fact.slot, value: fact.value })} aria-label="编辑">
                      <Pencil size={13} strokeWidth={1.5} />
                    </button>
                  ) : null}
                  <button type="button" className="ghost icon tiny" onClick={() => props.onDeleteMemory(fact.slot)} aria-label="删除">
                    <Trash2 size={13} strokeWidth={1.5} />
                  </button>
                </div>
                {fact.title && fact.title !== fact.slot ? <p className="memory-value memory-title">{fact.title}</p> : null}
                {editing?.slot === fact.slot ? (
                  <div className="memory-edit">
                    <input
                      autoFocus
                      value={editing.value}
                      onChange={(event) => setEditing({ slot: fact.slot, value: event.target.value })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveMemory(fact.slot, editing.value);
                        if (event.key === 'Escape') setEditing(null);
                      }}
                    />
                    <button type="button" className="ghost icon tiny" onClick={() => saveMemory(fact.slot, editing.value)} aria-label="保存">
                      <Check size={13} strokeWidth={2} />
                    </button>
                    <button type="button" className="ghost icon tiny" onClick={() => setEditing(null)} aria-label="取消">
                      <X size={13} strokeWidth={1.6} />
                    </button>
                  </div>
                ) : (
                  <p className="memory-value">{fact.value}</p>
                )}
                <div className="mono dim memory-meta">
                  {fact.source} · {relativeTime(fact.updatedAt)}
                  {fact.outcome ? ` · ${MEMORY_OUTCOME_LABEL[fact.outcome] ?? fact.outcome}` : ''}
                  {fact.conflicts ? ' · 冲突待澄清' : ''}
                  {fact.archived ? ' · 已归档' : ''}
                </div>
              </li>
            ))}
          </ul>
          {memory.length === 0 ? <p className="docs-empty">还没有记住任何事。任务完成后模型会写入情景记忆，稳定的偏好和约束会写成知识记忆。</p> : null}
        </div>
      ) : null}

      {tab === 'checkpoints' ? (
        <div className="docs-body">
          <div className="docs-note">
            <CornerDownRight size={14} strokeWidth={1.5} />
            <span>每一步一份完整快照，回退会同时还原文件与会话状态。</span>
          </div>
          {revertPreview ? (
            <div className="revert-preview">
              <div className="revert-preview-head">
                <span>回退到 {revertPreview.snapshotId} 会改动 {revertPreview.entries.length} 个文件</span>
                <span className="revert-preview-actions">
                  <button type="button" className="mini" onClick={() => props.onRevert(revertPreview.snapshotId)} disabled={busy}>
                    确认回退
                  </button>
                  <button type="button" className="mini" onClick={() => setRevertPreview(null)}>
                    取消
                  </button>
                </span>
              </div>
              <ul className="revert-preview-list">
                {revertPreview.entries.map((entry) => (
                  <li key={entry.path}>
                    <button type="button" className="revert-preview-row" onClick={() => setOpenPreviewFile(openPreviewFile === entry.path ? null : entry.path)}>
                      <span className={`chip ${entry.status === 'delete' ? 'chip-danger' : 'chip-quiet'} mono`}>{entry.status === 'delete' ? '删除' : '还原'}</span>
                      <span className="mono revert-preview-path">{entry.path}</span>
                      <span className="mono dim">+{entry.additions} −{entry.deletions}</span>
                    </button>
                    {openPreviewFile === entry.path ? (
                      <pre className="revert-preview-diff">{renderPreviewDiff(entry.before, entry.after)}</pre>
                    ) : null}
                  </li>
                ))}
              </ul>
              {revertPreview.entries.length === 0 ? <p className="docs-empty">这个快照和当前状态一致，回退不会改动文件。</p> : null}
            </div>
          ) : null}
          <ul className="snapshot-list">
            {[...snapshots].reverse().map((snapshot) => (
              <li key={snapshot.id}>
                <div>
                  <div className="snapshot-head">
                    <span className="mono">{snapshot.id}</span>
                    <span className="mono dim">{fileSize(snapshot.sizeBytes)}</span>
                    {snapshot.additiveOnly ? <span className="chip chip-quiet">仅新增</span> : null}
                  </div>
                  <p className="snapshot-label">{snapshot.label}</p>
                  <div className="mono dim snapshot-meta">
                    {snapshot.files.length} 个文件 · {relativeTime(snapshot.at)}
                  </div>
                </div>
                <span className="snapshot-actions">
                  <button type="button" className="ghost small" onClick={() => void previewRevert(snapshot.id)} disabled={busy}>
                    <Eye size={13} strokeWidth={1.6} />
                    预览
                  </button>
                  <button type="button" className="ghost small" onClick={() => props.onRevert(snapshot.id)}>
                    <RotateCcw size={13} strokeWidth={1.6} />
                    回退
                  </button>
                </span>
              </li>
            ))}
          </ul>
          {snapshots.length === 0 ? <p className="docs-empty">还没有检查点。第一次写入之后会自动生成。</p> : null}
        </div>
      ) : null}

      {tab === 'approvals' ? (
        <div className="docs-body">
          <div className="docs-note">
            <CornerDownRight size={14} strokeWidth={1.5} />
            <span>本会话被拦下审批过的命令；「总是允许」的会写进设置，之后同类命令不再询问。</span>
          </div>
          <ul className="approval-list">
            {approvals.map((entry) => (
              <li key={entry.id}>
                <div className="approval-row-head">
                  <span className="mono">{entry.name}</span>
                  <span className={`chip ${entry.decision === 'deny' ? 'chip-danger' : 'chip-quiet'} mono`}>
                    {entry.decision === 'deny' ? '已拒绝' : entry.decision === 'allow_always' ? '本会话允许' : entry.decision === 'allow_once' ? '允许一次' : '待处理'}
                  </span>
                </div>
                <pre className="approval-row-command mono">{entry.command}</pre>
                {entry.reason ? <p className="approval-row-reason">{entry.reason}</p> : null}
              </li>
            ))}
          </ul>
          {approvals.length === 0 ? <p className="docs-empty">还没有需要审批的动作。</p> : null}
        </div>
      ) : null}
    </aside>
  );
}

/** Compact line diff for the revert preview: removals then additions per hunk. */
function renderPreviewDiff(before: string, after: string): string {
  const lines = lineDiff(before, after);
  if (!lines) return '改动太大，无法预览'
  return lines
    .map((line) => `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '} ${line.text}`)
    .join('\n')
    .slice(0, 8000);
}

function Overview({
  contract,
  plan,
  snapshots,
  onOpenFile,
}: {
  contract: TaskContract | null;
  plan: PlanStep[];
  snapshots: SnapshotMeta[];
  onOpenFile: (path: string) => void;
}) {
  const touched = [...new Set(snapshots.flatMap((snapshot) => snapshot.files))].slice(-6);
  const active = plan.find((step) => step.status === 'active');
  const done = plan.filter((step) => step.status === 'done').length;

  return (
    <div className="overview">
      {contract ? (
        <section className="overview-block">
          <h3>这次任务的契约</h3>
          <p className="overview-goal">{contract.goal}</p>
          <ul className="overview-list">
            {contract.acceptance.slice(0, 4).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {contract.forbidden.length > 0 ? (
            <p className="overview-forbidden mono">不做：{contract.forbidden.join(' · ')}</p>
          ) : null}
        </section>
      ) : null}

      {plan.length > 0 ? (
        <section className="overview-block">
          <h3>
            计划 <span className="mono dim">{done}/{plan.length}</span>
          </h3>
          {active ? <p className="overview-goal">正在做：{active.title}</p> : null}
          <ol className="overview-list ordered">
            {plan.map((step) => (
              <li key={step.id} className={`plan-${step.status}`}>
                {step.title}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {touched.length > 0 ? (
        <section className="overview-block">
          <h3>动过的文件</h3>
          <div className="tool-files">
            {touched.map((file) => (
              <button key={file} type="button" className="file-chip mono" onClick={() => onOpenFile(file)}>
                {file}
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <p className="overview-hint">
        从「文件」打开任意文档。写入之后这里会出现原文与改动的对比，检查点可以整步回退。
      </p>
    </div>
  );
}

function DiffView({ diff }: { diff: DiffPayload }) {
  const lines = lineDiff(diff.before, diff.after);
  if (!lines) return <div className="docs-warn">改动太大，逐行比较已关闭。看「原文」。</div>;
  const stats = diffStats(lines);
  const folded = foldDiff(lines);
  const lastLine = folded.reduce((max, line) => {
    if (line.type === 'gap') return max;
    return Math.max(max, (line.type === 'add' ? line.after : line.before) ?? 0);
  }, 1);
  return (
    <div className="diff-panel">
      <div className="diff-stats mono">
        +{stats.additions} / −{stats.deletions} · 对比 {basename(diff.path)} 的上一份快照
      </div>
      <div className="diff-body" style={{ '--code-gutter': `${Math.max(2, String(lastLine).length)}ch` } as CSSProperties}>
        {folded.map((line, index) =>
          line.type === 'gap' ? (
            <div key={index} className="diff-row gap">
              <span className="diff-lineno">·</span>
              <span className="diff-sign" />
              <span className="diff-text dim">{line.text}</span>
            </div>
          ) : (
            <div key={index} className={`diff-row ${line.type}`}>
              <span className="diff-lineno">{line.type === 'add' ? line.after : line.before}</span>
              <span className="diff-sign">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}</span>
              <span className="diff-text">{line.text || ' '}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
