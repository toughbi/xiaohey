import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Eye, CornerDownRight, FileCode2, FolderOpen, PanelLeft, Pencil, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { FilePreview } from './FilePreview';
import { FileTree } from './FileTree';
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
  /** Open without leaving the files tab, so the tree stays beside the content. */
  onOpenFileHere: (path: string) => void;
  onDeleteMemory: (slot: string) => void;
  onRevert: (snapshotId: string) => void;
  onMemorySet: (slot: string, value: string) => void;
  onRefreshFiles: () => void;
  approvals: ApprovalItem[];
  threadId: string;
  onOpenExternal: (url: string) => void;
  /** Surface a failed save in the app banner. */
  onError?: (message: string) => void;
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
  const { width, tab, onTab, doc, diff, memory, snapshots, approvals, view, onView, threadId, onOpenExternal, onMemorySet } = props;
  const [memorySlot, setMemorySlot] = useState('');
  const [memoryValue, setMemoryValue] = useState('');
  const [editing, setEditing] = useState<{ slot: string; value: string } | null>(null);
  const [revertPreview, setRevertPreview] = useState<{ snapshotId: string; entries: Array<{ path: string; status: 'restore' | 'delete'; additions: number; deletions: number; before: string; after: string }> } | null>(null);
  const [openPreviewFile, setOpenPreviewFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editingFile, setEditingFile] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [treeToken, setTreeToken] = useState(0);
  // The explorer can be folded away: some files want the whole column.
  const [treeOpen, setTreeOpen] = useState(() => window.localStorage.getItem('xiaohey-docs-tree') !== 'closed');
  const toggleTree = (): void => {
    setTreeOpen((open) => {
      window.localStorage.setItem('xiaohey-docs-tree', open ? 'closed' : 'open');
      return !open;
    });
  };
  const gutter = useRef<HTMLDivElement | null>(null);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

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

  // A different file cancels any edit in progress: the draft belongs to the old path.
  useEffect(() => {
    setEditingFile(false);
    setDraft('');
  }, [doc?.path]);

  const startEdit = (caret?: number): void => {
    if (!doc) return;
    const text = doc.content;
    setDraft(text);
    setEditingFile(true);
    window.setTimeout(() => {
      const node = textarea.current;
      if (!node) return;
      node.focus();
      const at = typeof caret === 'number' ? Math.max(0, Math.min(caret, text.length)) : text.length;
      node.selectionStart = at;
      node.selectionEnd = at;
    }, 0);
  };

  /** Clicking a line of the read view opens the editor with the caret on it. */
  const editAtClick = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (!doc || editingFile) return;
    if (doc.language === 'binary' || doc.truncated) return;
    const target = event.target as HTMLElement;
    if (target.closest('a, button, img, .md-table-wrap')) return;
    if ((window.getSelection()?.toString() ?? '').trim().length > 0) return;
    const row = target.closest('.code-row');
    let caret: number | undefined;
    if (row && row.parentElement) {
      const index = Array.prototype.indexOf.call(row.parentElement.children, row);
      if (index >= 0) {
        const lines = doc.content.split('\n');
        caret = lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0);
      }
    }
    startEdit(caret);
  };

  const cancelEdit = (): void => {
    setEditingFile(false);
    setDraft('');
  };

  const save = async (): Promise<void> => {
    if (!doc) return;
    setSaving(true);
    try {
      await call('fs/write', { threadId, path: doc.path, text: draft });
      setEditingFile(false);
      setTreeToken((value) => value + 1);
      props.onOpenFileHere(doc.path);
    } catch (reason) {
      props.onError?.(`保存失败：${(reason as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const indent = (element: HTMLTextAreaElement): void => {
    const start = element.selectionStart;
    const end = element.selectionEnd;
    setDraft((current) => `${current.slice(0, start)}  ${current.slice(end)}`);
    window.requestAnimationFrame(() => {
      element.selectionStart = start + 2;
      element.selectionEnd = start + 2;
    });
  };

  const editor = (
    <div className="doc-editor">
      <div className="doc-gutter mono" ref={gutter} aria-hidden="true">
        {draft.split('\n').map((_, index) => (
          <span key={index}>{index + 1}</span>
        ))}
      </div>
      <textarea
        ref={textarea}
        className="doc-textarea mono"
        value={draft}
        spellCheck={false}
        wrap="off"
        aria-label="编辑文件内容"
        onChange={(event) => setDraft(event.target.value)}
        onScroll={(event) => {
          if (gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            event.preventDefault();
            indent(event.currentTarget);
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            void save();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
          }
        }}
      />
    </div>
  );

  // The editor column: the file, or the session overview when nothing is open.
  // The tree is a sibling (left), not part of this column.
  const editorColumn = (
    <div className="docs-editor-pane">
      <div className="docs-main">
        {doc ? (
          <>
            <div className="docs-path">
              <button
                type="button"
                className="ghost icon tiny"
                onClick={toggleTree}
                aria-label={treeOpen ? '隐藏文件目录' : '显示文件目录'}
                title={treeOpen ? '隐藏文件目录' : '显示文件目录'}
              >
                <PanelLeft size={13} strokeWidth={1.6} />
              </button>
              <FileCode2 size={14} strokeWidth={1.5} />
              <span className="mono docs-crumb" title={doc.path}>
                {doc.path}
              </span>
              <span className="mono dim">{doc.language}</span>
              <span className="path-actions">
                {editingFile ? (
                  <>
                    <button type="button" className="mini" onClick={() => void save()} disabled={saving}>
                      {saving ? '保存中…' : '保存'}
                    </button>
                    <button type="button" className="ghost small" onClick={cancelEdit}>
                      取消
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="ghost small edit-button"
                      onClick={() => startEdit()}
                      title="编辑文件（也可以直接点内容里的某一行）"
                      disabled={doc.language === 'binary' || doc.truncated}
                    >
                      <Pencil size={13} strokeWidth={1.6} />
                      编辑
                    </button>
                    <button
                      type="button"
                      className="ghost icon tiny"
                      onClick={() => void call('app/reveal', { path: doc.path, threadId })}
                      aria-label="在资源管理器中显示"
                      title="在资源管理器中显示"
                    >
                      <FolderOpen size={13} strokeWidth={1.6} />
                    </button>
                  </>
                )}
              </span>
            </div>
            {!editingFile && diff && (view === 'diff' || diff.additions > 0 || diff.deletions > 0) ? (
              <div className="segmented">
                <button type="button" className={view === 'source' ? 'active' : ''} onClick={() => onView('source')}>
                  原文
                </button>
                <button type="button" className={view === 'diff' ? 'active' : ''} onClick={() => onView('diff')}>
                  改动 <span className="mono dim">+{diff.additions} −{diff.deletions}</span>
                </button>
              </div>
            ) : null}
            <div
              className={`docs-scroll${editingFile ? ' editing' : ''}`}
              onClick={editAtClick}
              title={
                !editingFile && doc.language !== 'binary' && !doc.truncated
                  ? '点击任意一行即可编辑'
                  : undefined
              }
            >
              {editingFile ? (
                editor
              ) : view === 'diff' && diff ? (
                <DiffView diff={diff} />
              ) : (
                <FilePreview doc={doc} threadId={threadId} onOpenExternal={onOpenExternal} />
              )}
            </div>
          </>
        ) : (
          <>
            <div className="docs-path">
              <button
                type="button"
                className="ghost icon tiny"
                onClick={toggleTree}
                aria-label={treeOpen ? '隐藏文件目录' : '显示文件目录'}
                title={treeOpen ? '隐藏文件目录' : '显示文件目录'}
              >
                <PanelLeft size={13} strokeWidth={1.6} />
              </button>
              <FileCode2 size={14} strokeWidth={1.5} />
              <span className="mono docs-crumb">本会话</span>
              <span className="mono dim">概览</span>
            </div>
            <div className="docs-scroll">
              <Overview contract={props.contract} plan={props.plan} snapshots={snapshots} onOpenFile={props.onOpenFile} />
            </div>
          </>
        )}
      </div>
    </div>
  );

  return (
    <aside className="docs" style={{ width }}>
      {/* The right side of the workspace is an IDE: the tree on the left, the
          editor on the right. Session internals (memory, checkpoints, approvals)
          live in the conversation itself, not here. */}
      <div className={`docs-ide${treeOpen ? '' : ' no-tree'}`}>
        {treeOpen ? (
          <FileTree
            threadId={threadId}
            activePath={doc?.path ?? null}
            onOpen={props.onOpenFileHere}
            refreshToken={treeToken}
          />
        ) : null}
        {editorColumn}
      </div>
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
