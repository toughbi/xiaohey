import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { ChevronRight, File, FileCode2, FileJson, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react';
import { call } from '../lib/client';
import type { FileEntry } from '../../shared/types';
import { fileSize } from '../lib/format';

/**
 * The workspace explorer beside the editor: folders expand in place, files open
 * in the pane to the left. Directories load lazily — a workspace with a deep
 * `src/` should not cost one round trip per folder before it is drawn.
 */

function iconFor(name: string): ReactElement {
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|c|h|cpp|sh|ps1)$/i.test(name)) return <FileCode2 size={14} strokeWidth={1.5} />;
  if (/\.(json|jsonc|yaml|yml|toml|ini)$/i.test(name)) return <FileJson size={14} strokeWidth={1.5} />;
  if (/\.(md|txt|log)$/i.test(name)) return <FileText size={14} strokeWidth={1.5} />;
  return <File size={14} strokeWidth={1.5} />;
}

export function FileTree({
  threadId,
  activePath,
  onOpen,
  refreshToken,
}: {
  threadId: string;
  activePath: string | null;
  onOpen: (path: string) => void;
  /** Bump to reload the root listing after a save or a turn. */
  refreshToken: number;
}) {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (path: string) => {
      const list = await call('fs/list', { threadId, path: path || '.' }).catch(() => null);
      if (list) setChildren((current) => ({ ...current, [path || '.']: list }));
    },
    [threadId],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const keys = ['.', ...expanded];
      await Promise.all(keys.map((key) => load(key)));
    } finally {
      setLoading(false);
    }
  }, [expanded, load]);

  // Root listing, and again whenever the workspace changes.
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    void load('.');
  }, [load]);

  // A save or a turn only changes sizes: reload what is already open instead of
  // collapsing the tree back to the root.
  useEffect(() => {
    if (refreshToken === 0) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const toggle = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (!children[path]) void load(path);
      }
      return next;
    });
  };

  const rows = useMemo(() => {
    const out: Array<{ entry: FileEntry; depth: number }> = [];
    const walk = (dir: string, depth: number): void => {
      for (const entry of children[dir] ?? []) {
        out.push({ entry, depth });
        if (entry.dir && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk('.', 0);
    return out;
  }, [children, expanded]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    const out: FileEntry[] = [];
    for (const list of Object.values(children)) {
      for (const entry of list) {
        if (entry.name.toLowerCase().includes(needle)) out.push(entry);
      }
    }
    return out.sort((left, right) => Number(right.dir) - Number(left.dir) || left.path.localeCompare(right.path));
  }, [children, query]);

  const row = (entry: FileEntry, depth: number) => {
    const open = expanded.has(entry.path);
    return (
      <li key={entry.path}>
        <button
          type="button"
          className={`tree-row ${entry.dir ? 'dir' : 'file'} ${activePath === entry.path ? 'active' : ''}`}
          style={{ paddingLeft: 6 + depth * 13 }}
          title={entry.path}
          onClick={() => (entry.dir ? toggle(entry.path) : onOpen(entry.path))}
          onDoubleClick={() => entry.dir && toggle(entry.path)}
        >
          <span className="tree-chevron">
            {entry.dir ? <ChevronRight size={12} strokeWidth={1.8} className={open ? 'open' : ''} /> : null}
          </span>
          <span className="tree-icon">
            {entry.dir ? (
              open ? (
                <FolderOpen size={14} strokeWidth={1.5} />
              ) : (
                <Folder size={14} strokeWidth={1.5} />
              )
            ) : (
              iconFor(entry.name)
            )}
          </span>
          <span className="tree-name">{entry.name}</span>
          {!entry.dir ? <span className="tree-size mono">{fileSize(entry.size)}</span> : null}
        </button>
      </li>
    );
  };

  return (
    <div className="file-tree">
      <div className="tree-head">
        <input
          className="tree-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="筛选文件…"
          aria-label="筛选文件"
          spellCheck={false}
        />
        <button
          type="button"
          className="ghost icon tiny"
          onClick={() => void reload()}
          aria-label="刷新文件树"
          title="刷新"
          disabled={loading}
        >
          <RefreshCw size={13} strokeWidth={1.6} className={loading ? 'spin' : ''} />
        </button>
      </div>
      <ul className="tree-list">
        {filtered
          ? filtered.map((entry) => row(entry, 0))
          : rows.map(({ entry, depth }) => row(entry, depth))}
      </ul>
      {filtered && filtered.length === 0 ? <p className="tree-empty">已展开的目录里没有匹配项。</p> : null}
      {!filtered && rows.length === 0 ? <p className="tree-empty">工作区是空的。</p> : null}
    </div>
  );
}
