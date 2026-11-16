import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Check,
  ChevronDown,
  Gauge,
  LogOut,
  Moon,
  MoreHorizontal,
  Pencil,
  SlidersHorizontal,
  Trash2,
  Pin,
  PanelRight,
  Plus,
  PlusCircle,
  Search,
  Settings2,
  Sun,
  Terminal,
} from 'lucide-react';
import type { Thread } from '../../shared/types';
import { createPortal } from 'react-dom';
import type { DocTab } from './DocumentPanel';

interface HistoryRailProps {
  width: number;
  threads: Thread[];
  activeId: string | null;
  workspace: string;
  model: string;
  user: string;
  theme: 'dark' | 'light';
  usage: { turns: number; steps: number; tokens: number; percent: number };
  onSelect: (threadId: string) => void;
  onRename: (threadId: string) => void;
  onPin: (threadId: string, pinned: boolean) => void;
  onDelete: (threadId: string) => void;
  onNew: () => void;
  workspaces: string[];
  workspacePath: string;
  onPickWorkspace: () => void;
  onOpenWorkspace: (path: string) => void;
  defaultWorkspace: string;
  onOpenDefault: () => void;
  pickerRequest: { id: number; rect: { left: number; top: number; bottom: number } } | null;
  onNewInWorkspace: (path: string) => void;
  onRenameWorkspace: (path: string, name: string) => void;
  onRevealWorkspace: (path: string) => void;
  onForgetWorkspace: (path: string) => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
  onOpenTab: (tab: DocTab) => void;
}

export function HistoryRail({
  threads,
  activeId,
  workspace,
  model,
  user,
  theme,
  usage,
  width,
  onSelect,
  onRename,
  onPin,
  onDelete,
  onNew,
  workspaces,
  workspacePath,
  onPickWorkspace,
  onOpenWorkspace,
  defaultWorkspace,
  onOpenDefault,
  pickerRequest,
  onNewInWorkspace,
  onRenameWorkspace,
  onRevealWorkspace,
  onForgetWorkspace,
  onOpenSettings,
  onToggleTheme,
  onSignOut,
  onOpenTab,
}: HistoryRailProps) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [workspaceActions, setWorkspaceActions] = useState(false);
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ top: number; bottom: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const lastPickerRef = useRef(0);

  useEffect(() => {
    if (!pickerRequest || pickerRequest.id === lastPickerRef.current) return;
    lastPickerRef.current = pickerRequest.id;
    const width = 272;
    setMenuAnchor({ top: pickerRequest.rect.top, bottom: pickerRequest.rect.bottom });
    setMenuPos({
      left: Math.max(8, Math.min(pickerRequest.rect.left, window.innerWidth - width - 12)),
      top: pickerRequest.rect.bottom + 6,
    });
    setWorkspaceQuery('');
    setWorkspaceMenu(true);
  }, [pickerRequest]);

  const toggleWorkspaceMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (workspaceMenu) {
      setWorkspaceMenu(false);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    const width = 272;
    setMenuAnchor({ top: rect.top, bottom: rect.bottom });
    setMenuPos({ left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 12)), top: rect.bottom + 4 });
    setWorkspaceQuery('');
    setWorkspaceMenu(true);
  };

  useLayoutEffect(() => {
    if (!workspaceMenu || !menuPos || !menuAnchor || !menuRef.current) return;
    const box = menuRef.current.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 8) {
      setMenuPos((pos) => (pos ? { ...pos, top: Math.max(8, menuAnchor.top - box.height - 8) } : pos));
    }
  }, [workspaceMenu, menuPos, menuAnchor]);

  const workspaceName = workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? '不指定工作区';
  const workspaceCandidates = [workspacePath, defaultWorkspace, ...workspaces]
    .filter((entry, index, list) => entry && list.indexOf(entry) === index);
  const initial = (user.trim()[0] ?? 'x').toUpperCase();
  // The rail is a view of one workspace: switching workspaces must not look
  // like the old sessions moved into the new folder.
  const scoped = workspacePath ? threads.filter((thread) => thread.cwd === workspacePath) : threads;
  const ordered = useMemo(() => {
    const base = pinnedOnly ? scoped.filter((thread) => thread.pinned) : scoped;
    const list = query.trim()
      ? base.filter((thread) => `${thread.title} ${thread.lastPrompt}`.toLowerCase().includes(query.toLowerCase()))
      : base;
    return [...list].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
  }, [scoped, query, pinnedOnly]);

  const closeMenu = (): void => {
    setUserMenu(false);
    setConfirmSignOut(false);
  };

  return (
    <aside className="rail" style={{ width }}>
      <div className="rail-modes">
        <span className="mode active">
          <Terminal size={15} strokeWidth={1.6} />
          编码
        </span>
        <button type="button" className="mode" onClick={() => onOpenTab('files')} title="打开文档区" aria-label="打开文档区">
          <PanelRight size={15} strokeWidth={1.6} />
        </button>
      </div>

      <button type="button" className="rail-new" onClick={onNew}>
        <PlusCircle size={15} strokeWidth={1.6} />
        新会话
      </button>

      <nav className="rail-nav">
        <button type="button" onClick={() => setSearching((value) => !value)} className={searching ? 'selected' : ''}>
          <Search size={16} strokeWidth={1.5} />
          搜索
        </button>
        <button type="button" onClick={() => onOpenTab('files')}>
          <FileText size={16} strokeWidth={1.5} />
          文档
        </button>
        <button type="button" onClick={() => onOpenTab('memory')}>
          <Brain size={16} strokeWidth={1.5} />
          记忆
        </button>
      </nav>

      {searching ? (
        <div className="rail-search">
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
          />
        </div>
      ) : null}

      <div className="rail-section rail-grow">
        <div className="rail-section-head">
          <span className="rail-section-title">工作区</span>
          <div className="rail-head-actions">
            <button
              type="button"
              className={`rail-icon ${searching ? 'active' : ''}`}
              onClick={() => setSearching((value) => !value)}
              title="搜索会话"
              aria-label="搜索会话"
            >
              <Search size={16} strokeWidth={1.7} />
            </button>
            <button
              type="button"
              className={`rail-icon ${pinnedOnly ? 'active' : ''}`}
              onClick={() => setPinnedOnly((value) => !value)}
              title="只看置顶"
              aria-label="只看置顶"
            >
              <SlidersHorizontal size={16} strokeWidth={1.7} />
            </button>
            <button
              type="button"
              className="rail-icon rail-add"
              onClick={onPickWorkspace}
              title="新建工作区"
              aria-label="新建工作区"
            >
              <FolderPlus size={16} strokeWidth={1.7} data-icon="folder-plus" aria-hidden="true" />
            </button>
          </div>
        </div>
        {threads.length === 0 && !workspacePath ? (
          <p className="rail-empty-state">暂无任务数据 :)</p>
        ) : (
          <>
            <div className="workspace-wrap">
              <div className={`workspace-row ${workspaceMenu ? 'open' : ''}`}>
                <button
                  type="button"
                  className="workspace-pick"
                  onClick={toggleWorkspaceMenu}
                  title={workspacePath}
                  aria-haspopup="menu"
                  aria-expanded={workspaceMenu}
                >
                  <Folder size={15} strokeWidth={1.5} />
                  <span className="workspace-name">{workspaceName}</span>
                </button>
                <button
                  type="button"
                  className="workspace-more"
                  onClick={() => setWorkspaceActions((value) => !value)}
                  aria-label="工作区操作"
                  title="工作区操作"
                >
                  <MoreHorizontal size={16} strokeWidth={1.7} />
                </button>
                <button
                  type="button"
                  className="workspace-plus"
                  onClick={() => onNewInWorkspace(workspacePath)}
                  aria-label="新会话"
                  title="新会话 (Ctrl+N)"
                >
                  <PlusCircle size={16} strokeWidth={1.7} />
                </button>
              </div>
              {workspaceMenu && menuPos
              ? createPortal(
                  <>
                    <div className="policy-backdrop" onClick={() => setWorkspaceMenu(false)} />
                    <div className="workspace-menu" role="menu" ref={menuRef} style={{ left: menuPos.left, top: menuPos.top }}>
                    <div className="workspace-search">
                      <Search size={12} strokeWidth={1.7} />
                      <input
                        autoFocus
                        value={workspaceQuery}
                        onChange={(event) => setWorkspaceQuery(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setWorkspaceMenu(false);
                        }}
                        placeholder="搜索名称或路径"
                        aria-label="搜索工作区"
                      />
                    </div>
                    <div className="workspace-group-label">本机</div>
                    {!workspaceQuery.trim() || '不指定工作区'.includes(workspaceQuery.trim()) ? (
                    <button
                      type="button"
                      role="menuitem"
                      className={!workspacePath ? 'active' : ''}
                      onClick={() => {
                        setWorkspaceMenu(false);
                        onOpenDefault();
                      }}
                    >
                      <Folder size={14} strokeWidth={1.6} />
                      <span className="workspace-item-name">不指定工作区</span>
                      {!workspacePath ? <Check size={13} strokeWidth={2} className="workspace-check" /> : null}
                    </button>
                    ) : null}
                    {workspaceCandidates
                      .filter((entry) => !workspaceQuery.trim() || entry.toLowerCase().includes(workspaceQuery.trim().toLowerCase()))
                      .map((entry) => {
                        const active = entry === workspacePath;
                        return (
                          <button
                            key={entry}
                            type="button"
                            role="menuitem"
                            className={active ? 'active workspace-folder' : 'workspace-folder'}
                            onClick={() => {
                              setWorkspaceMenu(false);
                              onOpenWorkspace(entry);
                            }}
                            title={entry}
                          >
                            <Folder size={14} strokeWidth={1.6} />
                            <span className="workspace-item-name">{entry.split(/[\\/]/).filter(Boolean).pop() ?? entry}</span>
                            {active ? <Check size={13} strokeWidth={2} className="workspace-check" /> : null}
                          </button>
                        );
                      })}
                    {workspaceCandidates.length === 0 ? <div className="workspace-empty">还没有打开过工作区</div> : null}
                    <div className="workspace-divider" />
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setWorkspaceMenu(false);
                        onPickWorkspace();
                      }}
                    >
                      <Plus size={14} strokeWidth={1.8} />
                      <span className="workspace-item-name">新建工作区</span>
                    </button>
                    <button type="button" role="menuitem" className="disabled" disabled title="暂不支持">
                      <Terminal size={14} strokeWidth={1.6} />
                      <span className="workspace-item-name">连接 SSH 主机</span>
                    </button>
                  </div>
                  </>,
                  document.body,
                )
              : null}
            {workspaceActions ? (
              <>
                <div className="policy-backdrop" onClick={() => setWorkspaceActions(false)} />
                <div className="workspace-actions" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setWorkspaceActions(false); setRenameValue(workspaceName); }}>
                    <Pencil size={13} strokeWidth={1.7} />
                    重命名
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setWorkspaceActions(false); onRevealWorkspace(workspacePath); }}>
                    <FolderOpen size={13} strokeWidth={1.7} />
                    在文件夹显示
                  </button>
                  <div className="workspace-divider" />
                  <button type="button" role="menuitem" className="danger" onClick={() => { setWorkspaceActions(false); onForgetWorkspace(workspacePath); }}>
                    <Trash2 size={13} strokeWidth={1.7} />
                    删除工作区
                  </button>
                </div>
              </>
            ) : null}
            </div>
            {renameValue !== null ? (
              <>
                <div className="policy-backdrop" onClick={() => setRenameValue(null)} />
                <div className="workspace-rename" role="dialog" aria-label="重命名工作区">
                  <label htmlFor="workspace-rename-input">工作区名称</label>
                  <input
                    id="workspace-rename-input"
                    autoFocus
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        if (renameValue.trim()) {
                          onRenameWorkspace(workspacePath, renameValue.trim());
                          setRenameValue(null);
                        }
                      }
                      if (event.key === 'Escape') setRenameValue(null);
                    }}
                  />
                  <div className="workspace-rename-foot">
                    <button type="button" onClick={() => setRenameValue(null)}>取消</button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => {
                        if (!renameValue.trim()) return;
                        onRenameWorkspace(workspacePath, renameValue.trim());
                        setRenameValue(null);
                      }}
                    >
                      保存
                    </button>
                  </div>
                </div>
              </>
            ) : null}
            {ordered.length === 0 ? (
              <p className="rail-empty-state">暂无任务数据 :)</p>
            ) : (
            <ul className="thread-list">
              {ordered.map((thread) => (
                <li key={thread.id} className="thread-item">
                  <button
                    type="button"
                    className={`thread ${thread.id === activeId ? 'active' : ''}`}
                    onClick={() => onSelect(thread.id)}
                    title={thread.title}
                  >
                    {thread.pinned ? <Pin size={11} strokeWidth={1.8} className="thread-pin" /> : null}
                    <span className="thread-title">{thread.title}</span>
                    <span className="thread-meta">
                      {thread.status === 'running' ? <span className="live">运行中</span> : null}
                      {thread.status === 'failed' ? <span className="text-warn">失败</span> : null}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={`thread-more ${rowMenu === thread.id ? 'open' : ''}`}
                    onClick={() => {
                      setRowMenu(rowMenu === thread.id ? null : thread.id);
                    }}
                    aria-label={`${thread.title} 的操作`}
                    title="更多"
                  >
                    <MoreHorizontal size={14} strokeWidth={1.6} />
                  </button>
                  {rowMenu === thread.id ? (
                    <>
                      <div
                        className="rail-menu-backdrop"
                        onClick={() => {
                          setRowMenu(null);
                        }}
                      />
                      <div className="thread-menu" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setRowMenu(null);
                            onRename(thread.id);
                          }}
                        >
                          重命名
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setRowMenu(null);
                            onPin(thread.id, !thread.pinned);
                          }}
                        >
                          {thread.pinned ? '取消置顶' : '置顶'}
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => {
                            setRowMenu(null);
                            onDelete(thread.id);
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
            )}
          </>
        )}
      </div>

      <div className="rail-foot">
        {userMenu ? (
          <>
            <div className="rail-menu-backdrop" onClick={closeMenu} />
            <div className="rail-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  onOpenSettings();
                }}
              >
                <Settings2 size={14} strokeWidth={1.6} />
                设置
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  closeMenu();
                  onToggleTheme();
                }}
              >
                {theme === 'dark' ? <Sun size={14} strokeWidth={1.6} /> : <Moon size={14} strokeWidth={1.6} />}
                切换到{theme === 'dark' ? '浅色' : '深色'}
              </button>
              <div className="rail-menu-sep" />
              {confirmSignOut ? (
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => {
                    closeMenu();
                    onSignOut();
                  }}
                >
                  <LogOut size={14} strokeWidth={1.6} />
                  确认退出登录
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  className="danger"
                  onClick={() => setConfirmSignOut(true)}
                  title="本机没有账号体系：退出登录会清除保存的模型 API Key，会话与检查点保留"
                >
                  <LogOut size={14} strokeWidth={1.6} />
                  退出登录
                </button>
              )}
            </div>
          </>
        ) : null}

        {usageOpen ? (
          <>
            <div className="rail-menu-backdrop" onClick={() => setUsageOpen(false)} />
            <div className="usage-pop" role="dialog" aria-label="本会话用量">
              <div className="usage-head">
                <span>本会话用量</span>
                <span className="mono dim">{model}</span>
              </div>
              <dl>
                <div>
                  <dt>轮次</dt>
                  <dd className="mono">{usage.turns}</dd>
                </div>
                <div>
                  <dt>步数</dt>
                  <dd className="mono">{usage.steps}</dd>
                </div>
                <div>
                  <dt>累计 token</dt>
                  <dd className="mono">{usage.tokens.toLocaleString('en-US')}</dd>
                </div>
                <div>
                  <dt>上下文已用</dt>
                  <dd className="mono">{usage.percent}%</dd>
                </div>
              </dl>
            </div>
          </>
        ) : null}

        <button
          type="button"
          className="rail-user"
          onClick={() => setUserMenu((value) => !value)}
          aria-haspopup="menu"
          aria-expanded={userMenu}
          title={user}
        >
          <span className="avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="user-name">{user}</span>
        </button>
        <div className="foot-actions">
          <button
            type="button"
            className="ghost icon"
            onClick={() => setUsageOpen((value) => !value)}
            aria-label="本会话用量"
            title="本会话用量"
          >
            <Gauge size={15} strokeWidth={1.5} />
          </button>
          <button type="button" className="ghost icon" onClick={onOpenSettings} aria-label="设置" title="设置">
            <Settings2 size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </aside>
  );
}
