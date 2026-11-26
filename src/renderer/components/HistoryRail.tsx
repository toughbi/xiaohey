import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Check,
  Loader2,
  LogOut,
  Moon,
  MoreHorizontal,
  Pencil,
  SlidersHorizontal,
  Trash2,
  Pin,
  Plus,
  PlusCircle,
  Search,
  Settings,
  Sun,
  Terminal,
  TriangleAlert,
} from 'lucide-react';
import type { Thread } from '../../shared/types';
import { createPortal } from 'react-dom';
import type { DocTab } from './DocumentPanel';

interface HistoryRailProps {
  width: number;
  threads: Thread[];
  activeId: string | null;
  user: string;
  theme: 'dark' | 'light';
  onSelect: (threadId: string) => void;
  onRename: (threadId: string) => void;
  onPin: (threadId: string, pinned: boolean) => void;
  onDelete: (threadId: string) => void;
  onNew: () => void;
  workspaces: string[];
  workspacePath: string;
  onNewWorkspace: () => void;
  onOpenWorkspace: (path: string) => void;
  defaultWorkspace: string;
  onOpenDefault: () => void;
  pickerRequest: { id: number; rect: { left: number; top: number; bottom: number } } | null;
  onNewInWorkspace: (path: string) => void;
  onRenameWorkspace: (path: string, name: string) => void;
  onRevealWorkspace: (path: string) => void;
  onDeleteWorkspace: (path: string) => void;
  onOpenSettings: () => void;
  onToggleTheme: () => void;
  onSignOut: () => void;
  onOpenTab: (tab: DocTab) => void;
}

export function HistoryRail({
  threads,
  activeId,
  user,
  theme,
  width,
  onSelect,
  onRename,
  onPin,
  onDelete,
  onNew,
  workspaces,
  workspacePath,
  onNewWorkspace,
  onOpenWorkspace,
  defaultWorkspace,
  onOpenDefault,
  pickerRequest,
  onNewInWorkspace,
  onRenameWorkspace,
  onRevealWorkspace,
  onDeleteWorkspace,
  onOpenSettings,
  onToggleTheme,
  onSignOut,
  onOpenTab,
}: HistoryRailProps) {
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [workspaceMenu, setWorkspaceMenu] = useState(false);
  const [workspaceQuery, setWorkspaceQuery] = useState('');
  const [actionsPath, setActionsPath] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ path: string; value: string } | null>(null);
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

  const workspaceNameOf = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? '不指定工作区';

  // The rail is a workspace history, not a single-workspace view: every folder
  // the user has opened stays here. Order is by when the workspace was added,
  // not by which one is active or last used, so clicking a row or creating a
  // session in it never makes the list jump under the pointer. A newly created
  // workspace still lands at the top.
  const workspaceEntries = useMemo(() => {
    const paths: string[] = [];
    const add = (path: string): void => {
      if (path && !paths.includes(path)) paths.push(path);
    };
    for (const path of workspaces) add(path);
    for (const thread of threads) {
      if (thread.cwd) add(thread.cwd);
    }
    const activity = new Map<string, number>();
    for (const thread of threads) {
      if (!thread.cwd) continue;
      activity.set(thread.cwd, Math.max(activity.get(thread.cwd) ?? 0, thread.updatedAt));
    }
    for (const [path] of [...activity.entries()].sort((left, right) => right[1] - left[1])) add(path);
    if (workspacePath) add(workspacePath);
    const entries = paths.map((path) => ({
      path,
      name: workspaceNameOf(path),
      sessions: threads.filter((thread) => thread.cwd === path),
    }));
    // Sessions that have not picked a folder yet would otherwise disappear the
    // moment a real workspace becomes active; keep them reachable at the top.
    const unassigned = threads.filter((thread) => !thread.cwd);
    if (unassigned.length > 0) {
      entries.unshift({ path: '', name: '不指定工作区', sessions: unassigned });
    }
    return entries;
  }, [threads, workspacePath, workspaces]);

  const workspaceCandidates = [workspacePath, defaultWorkspace, ...workspaces]
    .filter((entry, index, list) => entry && list.indexOf(entry) === index);
  const initial = (user.trim()[0] ?? 'x').toUpperCase();

  // Pinned sessions stay on top; the rest keep their creation order. Never
  // sort by updatedAt: sending a message would yank that session to the top.
  const orderedSessions = (sessions: Thread[]): Thread[] => {
    const base = pinnedOnly ? sessions.filter((thread) => thread.pinned) : sessions;
    const list = query.trim()
      ? base.filter((thread) => `${thread.title} ${thread.lastPrompt}`.toLowerCase().includes(query.toLowerCase()))
      : base;
    return [...list].sort(
      (a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.createdAt - a.createdAt,
    );
  };

  const closeMenu = (): void => {
    setUserMenu(false);
    setConfirmSignOut(false);
  };

  return (
    <aside className="rail" style={{ width }}>

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
              onClick={onNewWorkspace}
              title="新建工作区"
              aria-label="新建工作区"
            >
              <FolderPlus size={16} strokeWidth={1.7} data-icon="folder-plus" aria-hidden="true" />
            </button>
          </div>
        </div>
        {workspaceEntries.length === 0 ? (
          <p className="rail-empty-state">暂无工作区数据:)</p>
        ) : (
          <ul className="workspace-list">
            {workspaceEntries.map((entry) => {
              const active = entry.path === workspacePath;
              const sessions = orderedSessions(entry.sessions);
              return (
                <li key={entry.path || '__unassigned__'} className={`workspace-entry ${active ? 'active' : ''}`}>
                  <div className={`workspace-row ${active && workspaceMenu ? 'open' : ''}`}>
                    <button
                      type="button"
                      className="workspace-pick"
                      onClick={
                        active
                          ? toggleWorkspaceMenu
                          : () => {
                              if (entry.path) onOpenWorkspace(entry.path);
                              else if (sessions.length > 0) onSelect(sessions[0].id);
                              else onOpenDefault();
                            }
                      }
                      title={entry.path || '不指定工作区'}
                      aria-current={active ? 'true' : undefined}
                      aria-haspopup={active ? 'menu' : undefined}
                      aria-expanded={active ? workspaceMenu : undefined}
                    >
                      {active ? (
                        <FolderOpen size={15} strokeWidth={1.7} className="workspace-folder-active" />
                      ) : (
                        <Folder size={15} strokeWidth={1.5} />
                      )}
                      <span className="workspace-name">{entry.name}</span>
                    </button>
                    {entry.path ? (
                      <button
                        type="button"
                        className={`workspace-more ${actionsPath === entry.path ? 'open' : ''}`}
                        onClick={() => setActionsPath(actionsPath === entry.path ? null : entry.path)}
                        aria-label={`${entry.name} 的工作区操作`}
                        title="工作区操作"
                      >
                        <MoreHorizontal size={16} strokeWidth={1.7} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="workspace-plus"
                      onClick={() => onNewInWorkspace(entry.path)}
                      aria-label={active ? '新会话' : `在 ${entry.name} 新建会话`}
                      title="新会话 (Ctrl+N)"
                    >
                      <PlusCircle size={16} strokeWidth={1.7} />
                    </button>
                  </div>

                  {active && workspaceMenu && menuPos
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
                              .filter((candidate) => !workspaceQuery.trim() || candidate.toLowerCase().includes(workspaceQuery.trim().toLowerCase()))
                              .map((candidate) => {
                                const current = candidate === workspacePath;
                                return (
                                  <button
                                    key={candidate}
                                    type="button"
                                    role="menuitem"
                                    className={current ? 'active workspace-folder' : 'workspace-folder'}
                                    onClick={() => {
                                      setWorkspaceMenu(false);
                                      onOpenWorkspace(candidate);
                                    }}
                                    title={candidate}
                                  >
                                    <Folder size={14} strokeWidth={1.6} />
                                    <span className="workspace-item-name">{workspaceNameOf(candidate)}</span>
                                    {current ? <Check size={13} strokeWidth={2} className="workspace-check" /> : null}
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
                                onNewWorkspace();
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

                  {entry.path && actionsPath === entry.path ? (
                    <>
                      <div className="policy-backdrop" onClick={() => setActionsPath(null)} />
                      <div className="workspace-actions" role="menu">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setActionsPath(null);
                            setRenameTarget({ path: entry.path, value: entry.name });
                          }}
                        >
                          <Pencil size={13} strokeWidth={1.7} />
                          重命名
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setActionsPath(null);
                            onRevealWorkspace(entry.path);
                          }}
                        >
                          <FolderOpen size={13} strokeWidth={1.7} />
                          在文件夹显示
                        </button>
                        <div className="workspace-divider" />
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          title="删除工作区及其全部会话"
                          onClick={() => {
                            setActionsPath(null);
                            onDeleteWorkspace(entry.path);
                          }}
                        >
                          <Trash2 size={13} strokeWidth={1.7} />
                          删除
                        </button>
                      </div>
                    </>
                  ) : null}

                  {sessions.length === 0 ? (
                    <p className="workspace-empty-state">暂无会话数据:)</p>
                  ) : (
                    <ul className="thread-list">
                      {sessions.map((thread) => (
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
                              {thread.status === 'running' ? (
                                <span className="thread-running" role="img" aria-label="运行中" title="运行中">
                                  <Loader2 size={12} strokeWidth={2} className="spin" />
                                </span>
                              ) : null}
                              {thread.status === 'failed' ? (
                                <span className="thread-failed" role="img" aria-label="失败" title="失败">
                                  <TriangleAlert size={12} strokeWidth={1.8} />
                                </span>
                              ) : null}
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
                </li>
              );
            })}
          </ul>
        )}

        {renameTarget !== null ? (
          <>
            <div className="policy-backdrop" onClick={() => setRenameTarget(null)} />
            <div className="workspace-rename" role="dialog" aria-label="重命名工作区">
              <label htmlFor="workspace-rename-input">工作区名称</label>
              <input
                id="workspace-rename-input"
                autoFocus
                value={renameTarget.value}
                onChange={(event) => setRenameTarget({ ...renameTarget, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    const name = renameTarget.value.trim();
                    if (name) {
                      onRenameWorkspace(renameTarget.path, name);
                      setRenameTarget(null);
                    }
                  }
                  if (event.key === 'Escape') setRenameTarget(null);
                }}
              />
              <div className="workspace-rename-foot">
                <button type="button" onClick={() => setRenameTarget(null)}>取消</button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    const name = renameTarget.value.trim();
                    if (!name) return;
                    onRenameWorkspace(renameTarget.path, name);
                    setRenameTarget(null);
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          </>
        ) : null}
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
                <Settings size={14} strokeWidth={1.6} />
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
            onClick={onOpenSettings}
            aria-label="设置"
            title="设置"
          >
            <Settings size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    </aside>
  );
}
