import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2,
  MoreHorizontal,
  PanelLeft,
  PanelRight,
  RotateCcw,
  SquareTerminal,
  TriangleAlert,
} from 'lucide-react';
import type {
  ActivityResult,
  ApprovalPolicy,
  ApprovalItem,
  ApprovalRequest,
  ContextGauge,
  DiffPayload,
  DocumentPayload,
  FileEntry,
  Item,
  MemoryFact,
  ModelProfile,
  PlanItem,
  PlanStep,
  RuntimeEvent,
  RuntimeStatus,
  Settings,
  SnapshotMeta,
  TaskContract,
  Thread,
  Turn,
} from '../shared/types';
import { call, subscribe } from './lib/client';
import { HistoryRail } from './components/HistoryRail';
import { QueuedMessages, type QueuedMessage } from './components/QueuedMessages';
import { TaskList } from './components/TaskList';
import { QuestionCard } from './components/QuestionCard';
import { Timeline } from './components/Timeline';
import { TurnMinimap } from './components/TurnMinimap';
import { Composer } from './components/Composer';
import { DocumentPanel, type DocTab } from './components/DocumentPanel';
import { TerminalDock } from './components/TerminalDock';
import { setFileOpener } from './lib/fileLinks';
import { SettingsView } from './components/SettingsView';
import { BrandMark } from './components/BrandMark';
import { ActivityCard } from './components/ActivityHeatmap';

const PHASE_LABEL: Record<RuntimeStatus['phase'], string> = {
  idle: '空闲',
  thinking: '思考中',
  tool: '执行工具',
  approval: '等待许可',
  question: '等待回答',
  compacting: '折叠上下文',
  error: '失败',
};

/** Splitter bounds: the docs panel may shrink to a rail, never below a readable column. */
const DOCS_MIN = 280;
const DOCS_MAX = 980;
const DOCS_DEFAULT = 372;
const RAIL_MIN = 200;
const RAIL_MAX = 420;
const RAIL_DEFAULT = 232;

export function App() {  const [settings, setSettings] = useState<Settings | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [workspace, setWorkspace] = useState('');
  const [demo, setDemo] = useState(false);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  /** Context level per turn id (L0–L3), from the compression manifest. */
  const [turnLevels, setTurnLevels] = useState<Record<string, 0 | 1 | 2 | 3>>({});
  const [turn, setTurn] = useState<Turn | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [gauge, setGauge] = useState<ContextGauge | null>(null);
  /** Prompt tokens this session sent, and how many the provider had cached. */
  const [cacheHit, setCacheHit] = useState<{ prompt: number; cached: number } | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  /** Approvals belong to a thread; switching away must not lose the request. */
  const pendingApprovals = useRef<Record<string, ApprovalRequest>>({});
  /** Threads we asked to stop; late approval events must not reopen the card. */
  const stopping = useRef<Set<string>>(new Set());

  const [tab, setTab] = useState<DocTab>('files');
  const [dir, setDir] = useState('.');
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [doc, setDoc] = useState<DocumentPayload | null>(null);
  const [diff, setDiff] = useState<DiffPayload | null>(null);
  const [view, setView] = useState<'source' | 'diff'>('source');
  const [memory, setMemory] = useState<MemoryFact[]>([]);
  const [snapshots, setSnapshots] = useState<SnapshotMeta[]>([]);
  const [contract, setContract] = useState<TaskContract | null>(null);
  const [plan, setPlan] = useState<PlanStep[]>([]);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [railWidth, setRailWidth] = useState<number>(() => {
    const stored = Number(window.localStorage.getItem('xiaohey-rail-width'));
    return Number.isFinite(stored) && stored >= RAIL_MIN ? Math.min(stored, RAIL_MAX) : RAIL_DEFAULT;
  });
  const railDrag = useRef<{ startX: number; startWidth: number } | null>(null);
  const railWidthRef = useRef(railWidth);

  const applyRailWidth = useCallback((next: number, persist: boolean): void => {
    const maxByWindow = Math.max(RAIL_MIN, window.innerWidth - 640);
    const clamped = Math.max(RAIL_MIN, Math.min(Math.min(RAIL_MAX, maxByWindow), next));
    railWidthRef.current = clamped;
    setRailWidth(clamped);
    if (persist) window.localStorage.setItem('xiaohey-rail-width', String(clamped));
  }, []);
  // The session is the workspace; the IDE column opens on demand (header button,
  // rail 文档, a file link) and its state is remembered once the reader opens it.
  // The session is the workspace; the IDE column stays closed until the reader
  // asks for it (header button, rail 文档, a file link). That is the launch default.
  const [docsOpen, setDocsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  /** Once opened, the dock stays mounted: closing it hides the panel, not the shells. */
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [docsWidth, setDocsWidth] = useState<number>(() => {
    const stored = Number(window.localStorage.getItem('xiaohey-docs-width'));
    return Number.isFinite(stored) && stored >= DOCS_MIN ? Math.min(stored, DOCS_MAX) : 372;
  });
  const splitDrag = useRef<{ startX: number; startWidth: number } | null>(null);

  const applyDocsWidth = useCallback((next: number, persist: boolean): void => {
    const maxByWindow = Math.max(DOCS_MIN, window.innerWidth - 560);
    const clamped = Math.max(DOCS_MIN, Math.min(Math.min(DOCS_MAX, maxByWindow), next));
    setDocsWidth(clamped);
    if (persist) window.localStorage.setItem('xiaohey-docs-width', String(clamped));
  }, []);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [user, setUser] = useState('');
  const [activity, setActivity] = useState<ActivityResult | null>(null);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [showJump, setShowJump] = useState(false);
  const [undoRevert, setUndoRevert] = useState<{ snapshotId: string; message: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastStatus = useRef<string | undefined>(undefined);
  const [workspaceInfo, setWorkspaceInfo] = useState<{ path: string; name: string; branch: string | null } | null>(null);
  const [defaultWorkspace, setDefaultWorkspace] = useState('');
  const [workspacePrompt, setWorkspacePrompt] = useState(false);
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const [queueMode, setQueueMode] = useState<'queue' | 'insert'>('queue');
  const [workspaceMenuRequest, setWorkspaceMenuRequest] = useState<{ id: number; rect: { left: number; top: number; bottom: number } } | null>(null);
  /** A revert reloads the thread; sending before it lands would race it. */
  const openingThread = useRef<Promise<boolean> | null>(null);
  const reverting = useRef<Promise<void> | null>(null);

  const [version, setVersion] = useState('');
  const [platform, setPlatform] = useState('');
  const [maximized, setMaximized] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const stored = window.localStorage.getItem('xiaohey-theme');
    return stored === 'dark' ? 'dark' : 'light';
  });

  const scroller = useRef<HTMLDivElement>(null);
  /** The dock floats over the transcript; its height is published as `--dock-h`. */
  const dockRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);
  /**
   * The reader owns the scroll position, not the layout. Only a gesture (wheel,
   * touch, scrollbar drag) may detach the view from the bottom; a resize, a
   * growing dock or a reflow must never be mistaken for "the user scrolled up".
   */
  const userScrollUntil = useRef(0);
  const scrollbarDrag = useRef(false);
  /** Set while the "回到最新" glide runs, so the frame follower keeps its hands off. */
  const smoothUntil = useRef(0);
  const noteUserScroll = (): void => {
    userScrollUntil.current = Date.now() + 220;
  };
  const distanceToBottom = (node: HTMLElement): number =>
    node.scrollHeight - node.scrollTop - node.clientHeight;

  const running = turn?.status === 'running' || thread?.status === 'running';

  const startingQueued = useRef(false);
  const queueRetry = useRef(0);
  const [queueTick, setQueueTick] = useState(0);
  useEffect(() => {
    if (running || !activeId || startingQueued.current) return;
    const next = queues[activeId]?.[0];
    if (!next) return;
    startingQueued.current = true;
    // Dequeue only once the turn really started. A refused start (the
    // previous turn still committing) must not swallow what was queued.
    void send(next.text)
      .then((ok) => {
        if (ok) {
          queueRetry.current = 0;
          setQueues((current) => ({
            ...current,
            [activeId]: (current[activeId] ?? []).filter((item) => item.id !== next.id),
          }));
          return;
        }
        if (queueRetry.current < 3) {
          queueRetry.current += 1;
          window.setTimeout(() => setQueueTick((tick) => tick + 1), 800);
        }
      })
      .finally(() => {
        startingQueued.current = false;
      });
  }, [running, queues, activeId, queueTick]);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    const sync = (): void => {
      void window.xiaohey.windowControl('state').then((result) => setMaximized(result.maximized));
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  // Layout effect: the theme attribute must be on the document *before* children's
  // passive effects read the CSS variables (the terminal paints its surface from
  // --panel, and would otherwise repaint with the previous theme's colours).
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('xiaohey-theme', theme);
    void window.xiaohey.setTheme(theme);
  }, [theme]);

  const mergeItem = useCallback((incoming: Item) => {
    setItems((current) => {
      const index = current.findIndex((item) => item.id === incoming.id);
      if (index === -1) return [...current, incoming];
      const next = current.slice();
      next[index] = incoming;
      return next;
    });
  }, []);

  useEffect(() => {
    void call('workspace/info', {})
      .then((info) => setDefaultWorkspace(info.path))
      .catch(() => undefined);
  }, []);

  const refreshSide = useCallback(async () => {
    if (!activeId) return;
    const [memoryFacts, snapshotList, fileList, gaugeValue, approvalList] = await Promise.all([
      call('memory/list', { threadId: activeId }).catch(() => []),
      call('snapshot/list', { threadId: activeId }).catch(() => []),
      call('fs/list', { threadId: activeId, path: dir }).catch(() => []),
      call('context/get', { threadId: activeId }).catch(() => null),
      call('approvals/list', { threadId: activeId }).catch(() => []),
    ]);
    setMemory(memoryFacts);
    setSnapshots(snapshotList);
    setFiles(fileList);
    if (gaugeValue) setGauge(gaugeValue);
    setApprovals(approvalList);
    void call('workspace/info', { threadId: activeId ?? undefined })
      .then((value) => setWorkspaceInfo(value))
      .catch(() => undefined);
  }, [activeId, dir]);

  const handleEvent = useCallback(
    (event: RuntimeEvent) => {
      switch (event.type) {
        case 'item/upsert':
          // A turn in another thread keeps emitting while we look at this one.
          // Its items must never leak into the open transcript.
          if (event.item.threadId !== activeId) return;
          mergeItem(event.item);
          if (event.item.kind === 'plan') setPlan(event.item.steps);
          break;
        case 'turn/updated':
          if (event.turn.status !== 'running') {
            stopping.current.delete(event.turn.threadId);
            delete pendingApprovals.current[event.turn.threadId];
            if (event.turn.threadId === activeId) setApproval(null);
          }
          if (event.turn.threadId !== activeId) return;
          setTurn(event.turn);
          if (event.turn.status !== 'running') {
            if (event.turn.status === 'cancelled') {
              setItems((current) =>
                current.map((item) => {
                  if (item.turnId !== event.turn.id || item.status !== 'running') return item;
                  if (item.kind === 'approval') return { ...item, status: 'cancelled', decision: 'deny' };
                  if (item.kind === 'tool_call' || item.kind === 'question') return { ...item, status: 'cancelled' };
                  return item;
                }),
              );
            }
            window.setTimeout(() => void refreshSide(), 250);
          }
          break;
        case 'thread/updated':
          setThreads((current) => current.map((entry) => (entry.id === event.thread.id ? event.thread : entry)));
          if (event.thread.id === activeId) setThread(event.thread);
          break;
        case 'thread/list':
          setThreads(event.threads);
          break;
        case 'runtime/updated':
          if (event.runtime.threadId !== activeId) return;
          setRuntime(event.runtime);
          setGauge(event.context);
          break;
        case 'approval/requested':
          if (stopping.current.has(event.approval.threadId)) {
            void call('approval/respond', { approvalId: event.approval.id, decision: 'deny' }).catch(() => undefined);
            return;
          }
          pendingApprovals.current[event.approval.threadId] = event.approval;
          if (event.approval.threadId === activeId) setApproval(event.approval);
          break;
        case 'memory/updated':
          // Long-term memory is global; a background session's write still
          // belongs in the panel of the session the user is looking at.
          setMemory(event.facts);
          break;
        case 'snapshot/updated':
          if (event.threadId !== activeId) return;
          setSnapshots(event.snapshots);
          break;
        case 'settings/updated':
          setSettings(event.settings);
          break;
        default:
          break;
      }
    },
    [activeId, mergeItem, refreshSide],
  );

  const openFile = async (
    path: string,
    threadId = activeId,
    mode: 'source' | 'diff' = 'source',
    snapshotId?: string,
    quiet = false,
    /** Keep the current tab: the files tab shows the tree beside the content. */
    stay = false,
  ): Promise<void> => {
    if (!threadId) return;
    try {
      const [document, delta] = await Promise.all([
        call('fs/read', { threadId, path }),
        call('fs/diff', { threadId, path, ...(snapshotId ? { snapshotId } : {}) }).catch(() => null),
      ]);
      setDoc(document);
      setDiff(delta);
      setView(mode);
      if (!stay) setTab('preview');
      // A quiet (background) restore of the last edited file must not open the IDE
      // column by itself: the session opens alone until the reader asks for it.
      if (!quiet) setDocsOpen(true);
    } catch (reason) {
      const message = (reason as Error).message;
      // The thread can be deleted while its document request is in flight, and
      // a best-effort auto-open of the last touched file can point at a file
      // that has since been moved or deleted. Neither should raise a banner.
      if (!quiet && !/unknown thread|unknown session/i.test(message)) {
        setError(/ENOENT/i.test(message) ? `文件不存在或已被移动：${path}` : message);
      }
    }
  };

  const openThreadInner = async (threadId: string): Promise<boolean> => {
    try {
      const opened = await call('thread/open', { threadId });
      setActiveId(threadId);
      setThread(opened.thread);
      setItems(opened.items);
      // Turn ids appear in order, and `turns` is the same order by number: zip
      // them so the badge on a user message can name its context level.
      {
        const order: string[] = [];
        for (const item of opened.items) {
          if (item.kind === 'message' && item.role === 'user' && !order.includes(item.turnId)) order.push(item.turnId);
        }
        const levels: Record<string, 0 | 1 | 2 | 3> = {};
        opened.turns.forEach((entry, index) => {
          const id = order[index];
          if (id) levels[id] = entry.level;
        });
        setTurnLevels(levels);
      }
      stickToBottom.current = true;
      setShowJump(false);
      setTurn(opened.turn ?? null);
      setApproval(pendingApprovals.current[threadId] ?? null);
      setError(null);
      setRuntime(null);
      setContract(opened.contract);
      setPlan(opened.plan);
      setDoc(null);
      setDiff(null);
      setMenuOpen(false);
      setRenaming(null);
      setConfirmDelete(false);
      const [memoryFacts, snapshotList, fileList, gaugeValue] = await Promise.all([
        call('memory/list', { threadId }),
        call('snapshot/list', { threadId }),
        call('fs/list', { threadId, path: '.' }),
        call('context/get', { threadId }),
      ]);
      setMemory(memoryFacts);
      setSnapshots(snapshotList);
      setFiles(fileList);
      setDir('.');
      setGauge(gaugeValue);
      if (opened.items.length > 0) {
        const lastFile = [...opened.items]
          .reverse()
          .find((item) => item.kind === 'tool_result' && item.files && item.files.length > 0);
        if (lastFile && lastFile.kind === 'tool_result' && lastFile.files?.[0]) {
          void openFile(lastFile.files[0], threadId, 'source', undefined, true);
        }
      }
      return true;
    } catch (reason) {
      const message = (reason as Error).message;
      // A thread can disappear between listing it and opening it (deletion
      // racing a click). Prune the stale row instead of showing an error.
      if (/unknown thread|unknown session/i.test(message)) {
        setThreads((current) => current.filter((entry) => entry.id !== threadId));
        return false;
      }
      setError(message);
      return false;
    }
  };

  const openThread = async (threadId: string): Promise<boolean> => {
    const run = openThreadInner(threadId);
    openingThread.current = run;
    try {
      return await run;
    } finally {
      if (openingThread.current === run) openingThread.current = null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [info, state] = await Promise.all([call('app/info', { demo: false }), call('ui/state', {})]);
      if (cancelled) return;
      setWorkspace(info.workspace);
      setDemo(info.demo);
      setUser(info.user);
      setVersion(info.version);
      setPlatform(info.platform);
      setSettings(state.settings);
      setThreads(state.threads);
      void call('activity/get', { weeks: 52 })
        .then((value) => {
          if (!cancelled) setActivity(value);
        })
        .catch(() => undefined);
      void call('workspace/info', { threadId: activeId ?? undefined })
        .then((value) => {
          if (!cancelled) setWorkspaceInfo(value);
        })
        .catch(() => undefined);
      if (state.threads.length > 0) void openThread(state.threads[0].id);
    })().catch((reason: Error) => setError(reason.message));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => subscribe(handleEvent), [handleEvent]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    // Never fight the reader: once they scroll up, new deltas keep arriving
    // below the viewport until they return to the bottom (or press 回到最新).
    // Layout effect so the scroll lands before the new frame is painted; a
    // post-paint scroll makes every delta flash the previous position.
    if (stickToBottom.current) node.scrollTop = node.scrollHeight;
    // `turn` rides along because the close of a turn rewrites the block (the
    // status row settles, narration folds) without touching `items`.
  }, [items, turn]);

  // The dock can grow mid-turn (task list, queued messages, a question card).
  // It floats over the transcript, so the scroller cannot reserve room by being
  // shorter: publish the dock's height as `--dock-h`, and the transcript pads its
  // tail by that much, the minimap and the jump pill lift themselves above it.
  // Written straight to the node — a React state hop would re-render the whole
  // session every time a task row lands mid-turn.
  useEffect(() => {
    const dock = dockRef.current;
    const session = dock?.parentElement;
    if (!dock || !session) return;
    const sync = (): void => {
      const height = Math.round(dock.getBoundingClientRect().height);
      session.style.setProperty('--dock-h', `${height}px`);
      // The dock changed, not the scroller's box: re-anchor the tail here.
      const node = scroller.current;
      if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(dock);
    return () => {
      observer.disconnect();
      session.style.removeProperty('--dock-h');
    };
  }, []);

  // A reflow makes the content taller without touching `items`: the window
  // resizes, the docs panel takes width away, a font swaps in.
  // Watch the scroller's own box — its width/height changes exactly when the
  // viewport can move the tail — and keep the bottom anchored when the reader
  // has not taken over.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const stick = (): void => {
      if (stickToBottom.current) node.scrollTop = node.scrollHeight;
    };
    const observer = new ResizeObserver(stick);
    observer.observe(node);
    window.addEventListener('resize', stick);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', stick);
    };
  }, []);

  // The reply is revealed between deltas now, so the answer grows on frames where
  // `items` did not change. Pinning only on data events would let the caret drift
  // below the fold and snap back on every delta; while the reader is following,
  // follow at frame rate instead. A press on 回到最新 glides, so stand down then.
  useEffect(() => {
    if (!running) return;
    let frame = 0;
    const follow = (): void => {
      frame = requestAnimationFrame(follow);
      const node = scroller.current;
      // Never fight a gesture: while a wheel/touch is in flight, the reader owns
      // the scrollbar even if following was still on a moment ago.
      if (!node || !stickToBottom.current) return;
      if (Date.now() < smoothUntil.current || Date.now() < userScrollUntil.current) return;
      if (node.scrollHeight - node.scrollTop - node.clientHeight > 1) node.scrollTop = node.scrollHeight;
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [running]);

  const navigate = async (path: string): Promise<void> => {
    if (!activeId) return;
    const list = await call('fs/list', { threadId: activeId, path });
    setDir(path);
    setFiles(list);
    setTab('files');
  };

  // The docs column is an IDE (tree + editor): give it room whenever it opens.
  useEffect(() => {
    if (docsOpen && docsWidth < 620) applyDocsWidth(620, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docsOpen]);

  // Switching or binding a workspace changes the file root; refresh the docs list.
  useEffect(() => {
    if (!docsOpen) return;
    const timer = window.setTimeout(() => void refreshSide(), 60);
    return () => window.clearTimeout(timer);
  }, [thread?.cwd, docsOpen, refreshSide]);

  const newSession = async (): Promise<void> => {
    // New sessions start without a folder; sending asks for one first.
    const created = await call('thread/create', { workspace: null });
    // The server also broadcasts the new list while this await is in flight;
    // prepend only when it has not landed yet.
    setThreads((current) => (current.some((entry) => entry.id === created.id) ? current : [created, ...current]));
    await openThread(created.id);
  };

  const send = async (text: string): Promise<boolean> => {
    if (!text.trim()) return false;
    if (thread && !thread.cwd) {
      setWorkspacePrompt(true);
      return false;
    }
    try {
      // Sending is an explicit "follow the conversation again": re-anchor even
      // if the reader had scrolled up, and drop the jump hint.
      stickToBottom.current = true;
      setShowJump(false);
      const node = scroller.current;
      if (node) node.scrollTop = node.scrollHeight;
      // The first screen has no session yet; send creates one so the composer
      // is usable from the very first keystroke.
      let threadId = activeId;
      if (!threadId) {
        const created = await call('thread/create', {});
        setThreads((current) => (current.some((entry) => entry.id === created.id) ? current : [created, ...current]));
        await openThread(created.id);
        threadId = created.id;
      }
      const attachments = [...text.matchAll(/@([^\s@]+)/g)].map((match) => match[1]);
      if (reverting.current) await reverting.current;
      if (openingThread.current) await openingThread.current;
      const started = await call('turn/start', { threadId, prompt: text, ...(attachments.length > 0 ? { attachments } : {}) });
      stopping.current.delete(threadId);
      setTurn(started);
      return true;
    } catch (reason) {
      setError((reason as Error).message);
      return false;
    }
  };

  const activeQueue = activeId ? queues[activeId] ?? [] : [];

  /**
   * Stop the running turn. When the turn belongs to a process that no longer
   * exists (the app was closed mid-run), cancelling cannot answer, so re-read
   * the session instead of leaving a stop button that never clears.
   */
  const stopTurn = async (): Promise<void> => {
    if (!activeId) return;
    const threadId = activeId;
    stopping.current.add(threadId);
    delete pendingApprovals.current[threadId];
    setApproval(null);
    window.setTimeout(() => stopping.current.delete(threadId), 8000);
    try {
      const result = await call('turn/cancel', { threadId });
      if (!result.ok) {
        stopping.current.delete(threadId);
        await openThread(threadId);
      }
    } catch (reason) {
      stopping.current.delete(threadId);
      setError((reason as Error).message);
    }
  };

  const enqueue = async (text: string): Promise<boolean> => {
    if (!text.trim() || !activeId) return false;
    if (queueMode === 'insert' && running) {
      return await steerNow(text);
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setQueues((current) => ({ ...current, [activeId]: [...(current[activeId] ?? []), { id, text }] }));
    return true;
  };

  const steerNow = async (text: string): Promise<boolean> => {
    if (!activeId) return false;
    if (running) {
      await call('turn/cancel', { threadId: activeId });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 200));
        const list = await call('thread/list', {});
        const current = list.find((entry) => entry.id === activeId);
        if (current && current.status !== 'running') break;
      }
      return send(text);
    }
    return send(text);
  };

  const editQueued = (id: string, text: string): void => {
    if (!activeId) return;
    setQueues((current) => ({
      ...current,
      [activeId]: (current[activeId] ?? []).map((item) => (item.id === id ? { ...item, text } : item)),
    }));
  };

  const deleteQueued = (id: string): void => {
    if (!activeId) return;
    setQueues((current) => ({ ...current, [activeId]: (current[activeId] ?? []).filter((item) => item.id !== id) }));
  };

  const sendQueuedNow = (id: string): void => {
    if (!activeId) return;
    const item = (queues[activeId] ?? []).find((entry) => entry.id === id);
    if (!item) return;
    // Keep the row until the turn starts, so a refused start cannot lose it.
    void steerNow(item.text).then((ok) => {
      if (ok) deleteQueued(id);
    });
  };

  const approve = async (approvalId: string, decision: 'allow_once' | 'allow_always' | 'deny'): Promise<void> => {
    if (approval) delete pendingApprovals.current[approval.threadId];
    setApproval(null);
    await call('approval/respond', { approvalId, decision });
  };

  const answerQuestion = async (questionId: string, answer: string): Promise<void> => {
    try {
      const result = await call('question/respond', { questionId, answer });
      if (!result.ok) setToast('这个问题已经结束，不需要再回答了');
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const pinThread = async (threadId: string, pinned: boolean): Promise<void> => {
    try {
      const updated = await call('thread/pin', { threadId, pinned });
      setThreads((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
      if (thread?.id === updated.id) setThread(updated);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  /** Open a workspace that is already in history: its latest session, or a new one. */
  const openWorkspace = async (path: string): Promise<void> => {
    try {
      // A session created with "不指定工作区" adopts the first folder picked.
      if (thread && !thread.cwd) {
        const updated = await call('thread/set-workspace', { threadId: thread.id, workspace: path });
        setThreads((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
        setThread(updated);
        setWorkspacePrompt(false);
        setToast(`已选择工作区：${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`);
        return;
      }
      const existing = threads
        .filter((entry) => entry.cwd === path)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0];
      if (existing) {
        await openThread(existing.id);
        setToast(`已切换到：${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`);
        return;
      }
      const created = await call('thread/create', { title: 'New session', workspace: path });
      setThreads((current) => (current.some((entry) => entry.id === created.id) ? current : [created, ...current]));
      await openThread(created.id);
      setToast(`已打开工作区：${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  /**
   * "新建工作区" means a new entry in the workspace history. Picking a folder
   * opens a fresh session there instead of reusing the session the old
   * workspace happened to be showing, so the rail gains a row rather than just
   * swapping its label.
   */
  const createWorkspace = async (path: string): Promise<void> => {
    try {
      if (thread && !thread.cwd) {
        // The current session is still waiting for a folder; bind it instead of
        // leaving an empty session behind.
        await openWorkspace(path);
        return;
      }
      const created = await call('thread/create', { title: 'New session', workspace: path });
      setThreads((current) => (current.some((entry) => entry.id === created.id) ? current : [created, ...current]));
      await openThread(created.id);
      setToast(`已新建工作区：${path.split(/[\\/]/).filter(Boolean).pop() ?? path}`);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const pickNewWorkspace = async (): Promise<void> => {
    try {
      const picked = await call('workspace/pick', {});
      if (picked.path) await createWorkspace(picked.path);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  /** A session that waits for its folder. */
  const openNoWorkspace = async (): Promise<void> => {
    try {
      const created = await call('thread/create', { title: 'New session', workspace: null });
      setThreads((current) => (current.some((entry) => entry.id === created.id) ? current : [created, ...current]));
      await openThread(created.id);
      setWorkspacePrompt(false);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const newSessionInWorkspace = async (path: string): Promise<void> => {
    try {
      if (!path) {
        await newSession();
        return;
      }
      const created = await call('thread/create', { title: 'New session', workspace: path });
      setThreads((current) => (current.some((entry) => entry.id === created.id) ? current : [created, ...current]));
      await openThread(created.id);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const renameWorkspace = async (path: string, name: string): Promise<void> => {
    try {
      await call('workspace/rename', { path, name });
      setSettings(await call('settings/get', {}));
      if (thread?.cwd === path) await openThread(thread.id);
      setToast(`工作区已重命名为：${name.trim()}`);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const revealWorkspace = async (path: string): Promise<void> => {
    try {
      await call('workspace/reveal', { path });
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const deleteWorkspace = async (path: string): Promise<void> => {
    try {
      const activeHere = Boolean(thread && thread.cwd === path);
      const result = await call('workspace/delete', { path });
      const remaining = threads.filter((entry) => entry.cwd !== path);
      if (activeHere) {
        setThreads(remaining);
        if (remaining[0]) {
          await openThread(remaining[0].id);
        } else {
          setActiveId(null);
          setThread(null);
          setItems([]);
          setTurn(null);
          setPlan([]);
          setDoc(null);
          setDiff(null);
          setRuntime(null);
          setWorkspacePrompt(false);
        }
      }
      setToast(result.deleted > 0 ? `已删除工作区及 ${result.deleted} 个会话` : '已删除工作区');
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const updateModel = async (id: string, patch: Partial<ModelProfile>): Promise<void> => {
    try {
      const current = settings ?? (await call('settings/get', {}));
      const saved = await call('settings/set', {
        ...current,
        models: current.models.map((model) => (model.id === id ? { ...model, ...patch } : model)),
      });
      setSettings(saved);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const openDefaultWorkspace = async (): Promise<void> => {
    if (!defaultWorkspace) return;
    await openWorkspace(defaultWorkspace);
  };

  const pickWorkspace = async (): Promise<void> => {
    try {
      const picked = await call('workspace/pick', {});
      if (picked.path) await openWorkspace(picked.path);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  /** Persist one command so the same call never asks again. */
  const allowAlways = async (request: ApprovalRequest): Promise<void> => {
    if (!settings) return;
    const signature = `${request.name}:${request.command}`;
    const saved = await call('settings/set', {
      ...settings,
      allowedCommands: [...new Set([...(settings.allowedCommands ?? []), signature])],
    });
    setSettings(saved);
    await approve(request.id, 'allow_once');
    setToast(`已总是允许：${request.command}`);
  };

  const copyTranscript = async (): Promise<void> => {
    if (!activeId) return;
    setMenuOpen(false);
    try {
      const result = await call('thread/markdown', { threadId: activeId });
      await navigator.clipboard.writeText(result.markdown);
      setToast('已复制为 Markdown');
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const exportTranscript = async (): Promise<void> => {
    if (!activeId) return;
    setMenuOpen(false);
    try {
      const result = await call('thread/export', { threadId: activeId });
      setToast(`已导出到 ${result.path}`);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const retryTurn = async (): Promise<void> => {
    if (!thread?.lastPrompt) return;
    await send(thread.lastPrompt);
  };

  const revertInner = async (snapshotId: string): Promise<void> => {
    if (!activeId) return;
    const result = await call('snapshot/revert', { threadId: activeId, snapshotId });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    if (result.undoSnapshotId) setUndoRevert({ snapshotId: result.undoSnapshotId, message: result.message });
    await openThread(activeId);
    stickToBottom.current = true;
    setShowJump(false);
    requestAnimationFrame(() => {
      if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    });
  };

  const revert = async (snapshotId: string): Promise<void> => {
    const run = revertInner(snapshotId);
    reverting.current = run;
    try {
      await run;
    } finally {
      if (reverting.current === run) reverting.current = null;
    }
  };

  const deleteMemory = async (slot: string): Promise<void> => {
    if (!activeId) return;
    setMemory(await call('memory/delete', { threadId: activeId, slot }));
  };

  const saveMemoryFact = async (slot: string, value: string): Promise<void> => {
    if (!activeId || !value.trim()) return;
    try {
      setMemory(await call('memory/set', { threadId: activeId, slot, value }));
      setToast('已记下');
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const changePolicy = async (approval: ApprovalPolicy): Promise<void> => {
    if (!settings) return;
    const saved = await call('settings/set', { ...settings, approval });
    setSettings(saved);
  };

  /** Switching models is only a selection; editing them stays in Settings. */
  const selectModel = async (id: string): Promise<void> => {
    if (!settings || settings.activeModelId === id) return;
    const saved = await call('settings/set', { ...settings, activeModelId: id });
    setSettings(saved);
  };

  /**
   * There is no account system: the only credential this app stores is the model
   * API key. Signing out removes it and keeps the local sessions and snapshots.
   */
  const signOut = async (): Promise<void> => {
    if (!settings) return;
    const saved = await call('settings/set', {
      ...settings,
      models: settings.models.map((profile) => ({ ...profile, apiKey: '' })),
    });
    setSettings(saved);
    setToast('已退出登录：本机保存的 API Key 已清除，会话与检查点保留');
  };

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const commitRename = async (): Promise<void> => {
    if (!activeId || renaming === null) return;
    const title = renaming.trim();
    setRenaming(null);
    setMenuOpen(false);
    if (!title || title === thread?.title) return;
    const renamed = await call('thread/rename', { threadId: activeId, title });
    setThread(renamed);
    setThreads((current) => current.map((entry) => (entry.id === renamed.id ? renamed : entry)));
  };

  const removeThread = async (threadId: string | null = activeId): Promise<void> => {
    if (!threadId) return;
    try {
      await call('thread/delete', { threadId });
    } catch (reason) {
      setError((reason as Error).message);
      return;
    }
    setConfirmDelete(false);
    setMenuOpen(false);
    let remaining: Thread[];
    try {
      remaining = (await call('thread/list', {})).filter((entry) => entry.id !== threadId);
    } catch {
      remaining = threads.filter((entry) => entry.id !== threadId);
    }
    setThreads(remaining);
    if (threadId !== activeId) return;
    // Open the first survivor that still exists; a stale row is pruned by
    // openThread and the loop moves on.
    for (const entry of remaining) {
      if (await openThread(entry.id)) return;
    }
    setActiveId(null);
    setThread(null);
    setItems([]);
    setTurn(null);
    setPlan([]);
    setDoc(null);
    setDiff(null);
    setRuntime(null);
  };

  /** Rename from the rail: bring the thread into view, then edit its title. */
  const startRename = async (threadId: string): Promise<void> => {
    const target = threads.find((entry) => entry.id === threadId);
    if (!target) return;
    if (threadId !== activeId) await openThread(threadId);
    setMenuOpen(false);
    setRenaming(target.title);
  };

  useEffect(() => {
    window.__xiaoheyShot = {
      openThread: () => undefined,
      switchTab: (next) => {
        setTab(next);
        setDocsOpen(true);
      },
      openSettings: () => setSettingsOpen(true),
      closeSettings: () => setSettingsOpen(false),
      expandTools: () => undefined,
      setTheme: (next) => setTheme(next),
    };
    return () => {
      delete window.__xiaoheyShot;
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && running && activeId) {
        void call('turn/cancel', { threadId: activeId });
        return;
      }
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'n') {
        event.preventDefault();
        void newSession();
      } else if (key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (key === 'b') {
        event.preventDefault();
        if (event.shiftKey) setDocsOpen((value) => !value);
        else setRailOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, running]);

  useEffect(() => {
    const status = thread?.status;
    const previous = lastStatus.current;
    lastStatus.current = status;
    if (previous !== 'running' || !status || status === 'running') return;
    if (document.visibilityState !== 'hidden') return;
    void call('app/notify', {
      title: status === 'failed' ? 'xiaohey · 本轮失败' : 'xiaohey · 完成',
      body: thread?.title ?? '会话',
    }).catch(() => undefined);
  }, [thread?.status, thread?.title]);

  // The docked task list reflects the thread's latest plan and stays until the
  // user opens another conversation; only the spinner depends on the live turn.
  // A pending clarification is docked above the composer; once answered it
  // settles into the transcript.
  const pendingQuestion = useMemo(() => {
    if (!running || !turn) return null;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === 'question' && item.status === 'running' && item.turnId === turn.id) return item;
    }
    return null;
  }, [items, running, turn]);

  // A plan belongs to the turn that produced it. A new turn hides the previous
  // list until this turn's todo_write arrives.
  const taskSteps = useMemo(() => {
    if (!turn) return [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item.kind === 'plan' && item.turnId === turn.id) return item.steps;
    }
    return [];
  }, [items, turn]);

  const minimapTurns = useMemo(() => {
    const plain = (text: string): string =>
      text
        .replace(/```[\s\S]*?```/g, ' [代码] ')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/~~([^~]+)~~/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^[-*+]\s+/gm, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\s+/g, ' ')
        .trim();
    const map = new Map<string, { title: string; excerpt: string }>();
    const order: string[] = [];
    for (const item of items) {
      if (item.kind === 'message' && item.role === 'user') {
        map.set(item.turnId, { title: plain(item.text), excerpt: map.get(item.turnId)?.excerpt ?? '' });
        order.push(item.turnId);
      } else if (item.kind === 'message' && item.role === 'assistant' && item.text.trim()) {
        const entry = map.get(item.turnId);
        if (entry) entry.excerpt = plain(item.text);
      }
    }
    return order.map((id) => ({ id, ...(map.get(id) ?? { title: '', excerpt: '' }) }));
  }, [items]);

  const contextPercent = useMemo(() => {
    if (!gauge || gauge.tokensBudget === 0) return 0;
    return Math.min(100, Math.round((gauge.tokensUsed / gauge.tokensBudget) * 100));
  }, [gauge]);

  // Inline file paths in a reply open the document panel through this slot, so a
  // memoized Markdown block never has to re-render just to pick up a new thread.
  useEffect(() => {
    setFileOpener((path) => void openFile(path));
    return () => setFileOpener(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  /** Fresh breakdown when the context panel opens: the gauge on screen may be stale. */
  const refreshContext = async (): Promise<void> => {
    if (!activeId) return;
    const value = await call('context/get', { threadId: activeId }).catch(() => null);
    if (value) setGauge(value);
  };

  // Cache hits are a session total in the usage ledger, not a live counter: read
  // them when the thread changes and after a turn adds to its token spend.
  useEffect(() => {
    if (!activeId) {
      setCacheHit(null);
      return;
    }
    let cancelled = false;
    void call('usage/thread', { threadId: activeId })
      .then((value) => {
        if (!cancelled) setCacheHit(value);
      })
      .catch(() => {
        if (!cancelled) setCacheHit(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, thread?.totalTokens]);

  const activeModel = settings?.models.find((profile) => profile.id === settings.activeModelId) ?? settings?.models[0];

  return (
    <div className="app">
      <header className="titlebar">
        <button
          type="button"
          className="ghost icon titlebar-button"
          onClick={() => setRailOpen((value) => !value)}
          aria-label="切换侧栏"
          title="切换侧栏"
        >
          <PanelLeft size={16} strokeWidth={1.5} />
        </button>
        <span className="titlebar-brand">
          <BrandMark size={18} className="brand-mark" />
          xiaohey
        </span>
        <div className="window-controls">
          <button
            type="button"
            aria-label="最小化"
            title="最小化"
            onClick={() => void window.xiaohey.windowControl('minimize')}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M2 6h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            aria-label={maximized ? '还原' : '最大化'}
            title={maximized ? '还原' : '最大化'}
            onClick={() => {
              void window.xiaohey.windowControl('toggle-maximize').then((result) => setMaximized(result.maximized));
            }}
          >
            {maximized ? (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2.2" y="3.4" width="6.4" height="6.4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4.4 3.4V2.6a1.2 1.2 0 0 1 1.2-1.2h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6a1.2 1.2 0 0 1-1.2 1.2h-.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <rect x="2.6" y="2.6" width="6.8" height="6.8" rx="1.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="window-close"
            aria-label="关闭"
            title="关闭"
            onClick={() => void window.xiaohey.windowControl('close')}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>
      {settingsOpen && settings ? (
        <SettingsView
          settings={settings}
          theme={theme}
          activity={activity}
          workspace={workspaceInfo}
          user={user || '本机用户'}
          version={version}
          platform={platform}
          onClose={() => setSettingsOpen(false)}
          onSave={async (next) => {
            const saved = await call('settings/set', next);
            setSettings(saved);
          }}
          onTest={(model) => call('settings/test', { model })}
          onListModels={(baseUrl, apiKey) => call('provider/models', { baseUrl, apiKey })}
          onOpenExternal={(url) => void call('app/open-external', { url })}
          onTheme={setTheme}
        />
      ) : (
      <div className="body">
        {railOpen ? (
          <HistoryRail
          width={railWidth}
          threads={threads}
          activeId={activeId}
          workspacePath={thread ? thread.cwd : ''}
          workspaces={settings?.recentWorkspaces ?? []}
          defaultWorkspace={defaultWorkspace}
          onOpenDefault={() => void openNoWorkspace()}
          pickerRequest={workspaceMenuRequest}
          onNewInWorkspace={(path) => void newSessionInWorkspace(path)}
          onRenameWorkspace={(path, name) => void renameWorkspace(path, name)}
          onRevealWorkspace={(path) => void revealWorkspace(path)}
          onDeleteWorkspace={(path) => void deleteWorkspace(path)}
          onNewWorkspace={() => void pickNewWorkspace()}
          onOpenWorkspace={(path) => void openWorkspace(path)}
          user={user || '本机用户'}
          theme={theme}
          onSelect={(id) => void openThread(id)}
          onRename={(id) => void startRename(id)}
          onPin={(id, pinned) => void pinThread(id, pinned)}
          onDelete={(id) => void removeThread(id)}
          onNew={() => void newSession()}
          onOpenSettings={() => setSettingsOpen(true)}
          onToggleTheme={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          onSignOut={() => void signOut()}
          onOpenTab={(next) => {
            setTab(next);
            setDocsOpen(true);
          }}
        />
        ) : null}

        {railOpen ? (
          <div
            className="rail-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整工作区宽度"
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              railDrag.current = { startX: event.clientX, startWidth: railWidth };
              document.body.classList.add('resizing-rail');
            }}
            onPointerMove={(event) => {
              if (!railDrag.current) return;
              const delta = event.clientX - railDrag.current.startX;
              applyRailWidth(railDrag.current.startWidth + delta, false);
            }}
            onPointerUp={(event) => {
              if (!railDrag.current) return;
              railDrag.current = null;
              document.body.classList.remove('resizing-rail');
              event.currentTarget.releasePointerCapture(event.pointerId);
              applyRailWidth(railWidthRef.current, true);
            }}
            onPointerCancel={() => {
              railDrag.current = null;
              document.body.classList.remove('resizing-rail');
            }}
            onDoubleClick={() => applyRailWidth(RAIL_DEFAULT, true)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                applyRailWidth(railWidth - 24, true);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                applyRailWidth(railWidth + 24, true);
              }
            }}
            title="拖动调整工作区宽度，双击恢复默认"
          />
        ) : null}

        <section className="panel">
          <div className="panel-row">
          <div className="work-column">
          <main className="session">
        <header className="session-head">
          <div className="session-head-left">
            {renaming !== null ? (
              <input
                className="title-input"
                autoFocus
                value={renaming}
                onChange={(event) => setRenaming(event.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void commitRename();
                  if (event.key === 'Escape') {
                    setRenaming(null);
                    setMenuOpen(false);
                  }
                }}
              />
            ) : (
              <h1 onDoubleClick={() => setRenaming(thread?.title ?? '')}>{thread?.title ?? '新会话'}</h1>
            )}
            {runtime && runtime.phase !== 'idle' ? (
              <span className={`phase ${runtime.phase === 'error' ? 'phase-error' : ''}`}>
                {runtime.phase === 'error' ? (
                  <TriangleAlert size={12} strokeWidth={1.8} />
                ) : (
                  <Loader2 size={12} strokeWidth={2} className="spin" />
                )}
                {PHASE_LABEL[runtime.phase]}
              </span>
            ) : null}
          </div>
          <div className="session-head-right">
            {thread?.status === 'failed' && thread.lastPrompt ? (
              <button type="button" className="mini" onClick={() => void retryTurn()} title="用同样的提示再发一次">
                重试上一轮
              </button>
            ) : null}
            <button
              type="button"
              className={`ghost icon ${terminalOpen ? 'active' : ''}`}
              onClick={() => {
                setTerminalMounted(true);
                setTerminalOpen((value) => !value);
              }}
              aria-label="切换终端面板"
              aria-pressed={terminalOpen}
              title="切换终端面板"
            >
              <SquareTerminal size={16} strokeWidth={1.5} />
            </button>
            <button
              type="button"
              className="ghost icon"
              onClick={() => {
                setDocsOpen((value) => !value);
                // The panel is an IDE now: a narrow column would squeeze the tree.
                if (!docsOpen) applyDocsWidth(Math.max(docsWidth, 560), true);
              }}
              aria-label="切换文档区"
              title="切换文档区"
            >
              <PanelRight size={16} strokeWidth={1.5} />
            </button>
          </div>
        </header>

        {undoRevert ? (
          <div className="banner banner-undo">
            <RotateCcw size={15} strokeWidth={1.6} />
            <span>{undoRevert.message}</span>
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                const target = undoRevert.snapshotId;
                setUndoRevert(null);
                void revert(target);
              }}
            >
              撤销这次回退
            </button>
            <button type="button" className="ghost small" onClick={() => setUndoRevert(null)}>
              知道了
            </button>
          </div>
        ) : null}

        {error ? (
          <div className="banner">
            <TriangleAlert size={15} strokeWidth={1.6} />
            <span>{error}</span>
            <button type="button" className="ghost small" onClick={() => setError(null)}>
              知道了
            </button>
          </div>
        ) : null}

        <div className="transcript-holder">
          <div
            aria-live="polite"
            aria-label="对话"
            className={`transcript ${items.length === 0 ? 'transcript-empty' : ''}`}
            ref={scroller}
            onScroll={(event) => {
              const node = event.currentTarget;
              const distance = distanceToBottom(node);
              // Back at the tail — by wheel, drag or the jump button — means
              // "follow again", whoever moved the view there.
              if (distance <= 8) {
                stickToBottom.current = true;
                setShowJump(false);
              }
              const byUser = scrollbarDrag.current || Date.now() <= userScrollUntil.current;
              if (!byUser) {
                // A layout-induced scroll (font swap, fold, dock growth) is not
                // the reader leaving: put the tail back if we follow it.
                if (stickToBottom.current && distance > 24) node.scrollTop = node.scrollHeight;
                return;
              }
              stickToBottom.current = distance < 32;
              setShowJump(distance > 240);
            }}
            onWheel={(event) => {
              noteUserScroll();
              // Any upward wheel means "stop following", even at the very bottom:
              // otherwise the next streamed delta yanks the page back down and the
              // two fight over the scrollbar. Following resumes when the reader
              // scrolls back to the tail, or sends a new message.
              if (event.deltaY < 0) {
                stickToBottom.current = false;
                setShowJump(true);
              }
            }}
            onTouchStart={noteUserScroll}
            onTouchMove={noteUserScroll}
            onPointerDown={(event) => {
              // A press on the scroller itself (not on a row) is a scrollbar drag.
              if (event.target === event.currentTarget) {
                scrollbarDrag.current = true;
                noteUserScroll();
              }
            }}
            onPointerUp={() => {
              if (!scrollbarDrag.current) return;
              scrollbarDrag.current = false;
              const node = scroller.current;
              if (!node) return;
              const distance = distanceToBottom(node);
              stickToBottom.current = distance < 32;
              setShowJump(distance > 240);
            }}
            onPointerCancel={() => {
              scrollbarDrag.current = false;
            }}
            onPointerLeave={() => {
              scrollbarDrag.current = false;
            }}
          >
            {items.length === 0 ? (
              <div className="empty">
                <div className="empty-mark">
                  <BrandMark size={26} className="brand-mark" />
                  xiaohey
                </div>

                <ActivityCard activity={activity} />

                {settings && settings.models.length === 0 ? (
                  <button type="button" className="empty-cta" onClick={() => setSettingsOpen(true)}>
                    还没有配置模型 · 点这里添加一个
                  </button>
                ) : (
                  <p className="empty-hint">输入第一句话开始 · Enter 发送，Shift+Enter 换行</p>
                )}
                {demo ? <p className="empty-demo mono">演示数据</p> : null}
              </div>
            ) : (
              <Timeline
                items={items}
                levels={turnLevels}
                turn={turn}
                running={Boolean(running)}
                now={now}
                onRevert={(id) => void revert(id)}
                onOpenPath={(path) => void openFile(path)}
                onReview={(path, snapshotId) => void openFile(path, activeId, 'diff', snapshotId)}
                onAnswerQuestion={answerQuestion}
                onLoadHandle={async (handle) => {
                  if (!activeId) return null;
                  const payload = await call('session/handle', { threadId: activeId, handle }).catch(() => null);
                  return payload?.text ?? null;
                }}
              />
            )}
          </div>

          <TurnMinimap scroller={scroller} version={items.length} turns={minimapTurns} />

          {/* Anchored to the transcript viewport, so it always floats just
              above the dock — whatever cards the dock is showing. */}
          {showJump ? (
            <button
              type="button"
              className="jump-bottom"
              onClick={() => {
                stickToBottom.current = true;
                setShowJump(false);
                const node = scroller.current;
                if (!node) return;
                smoothUntil.current = Date.now() + 520;
                node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
              }}
            >
              回到最新
            </button>
          ) : null}
        </div>

        <div className="composer-dock" ref={dockRef}>
        {workspacePrompt ? (
          <div className="workspace-prompt">
            <span>请选择工作区后再发送</span>
            <button
              type="button"
              className="mini"
              onClick={() => {
                setWorkspacePrompt(false);
                void pickWorkspace();
              }}
            >
              选择工作区
            </button>
          </div>
        ) : null}

        <QueuedMessages
          items={activeQueue}
          onEdit={editQueued}
          onDelete={deleteQueued}
          onSendNow={sendQueuedNow}
        />

        <TaskList
          key={`${activeId ?? 'none'}:${turn?.id ?? 'none'}`}
          steps={taskSteps}
          live={Boolean(running)}
        />

        {pendingQuestion ? <QuestionCard item={pendingQuestion} onAnswer={answerQuestion} /> : null}


        <Composer
          blocked={(settings?.models.length ?? 0) === 0}
          needsWorkspace={Boolean(thread && !thread.cwd)}
          running={Boolean(running)}
          models={settings?.models ?? []}
          activeModelId={settings?.activeModelId ?? ''}
          approval={approval}
          policy={settings?.approval ?? 'ask'}
          meta={{
            turns: thread?.turnCount ?? 0,
            steps: thread?.steps ?? 0,
            tokens: thread?.totalTokens ?? 0,
            percent: contextPercent,
            workspace: thread
              ? thread.cwd
                ? thread.cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
                : '未指定工作区'
              : workspaceInfo?.path
                ? workspaceInfo.name
                : '不指定工作区',
            branch: workspaceInfo?.branch ?? null,
            cache: cacheHit,
          }}
          onSend={(text) => send(text)}
          onQueue={(text) => enqueue(text)}
          onWorkspaceClick={(rect) =>
            setWorkspaceMenuRequest({
              id: Date.now(),
              rect: { left: rect.left, top: rect.top, bottom: rect.bottom },
            })
          }
          onStop={() => void stopTurn()}
          onApprove={(id, decision) => void approve(id, decision)}
          onAllowAlways={(request) => void allowAlways(request)}
          threadId={activeId}
          onPolicy={(policy) => void changePolicy(policy)}
          context={gauge}
          onContextOpen={() => void refreshContext()}
          onSelectModel={(id) => void selectModel(id)}
          onUpdateModel={(id, patch) => void updateModel(id, patch)}
          onOpenFiles={() => {
            setTab('files');
            setDocsOpen(true);
          }}
        />
        </div>
      </main>
      </div>

      {docsOpen ? (
        <>
          <div
            className="panel-splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="调整文档区宽度"
            tabIndex={0}
            onPointerDown={(event) => {
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              splitDrag.current = { startX: event.clientX, startWidth: docsWidth };
              document.body.classList.add('resizing-docs');
            }}
            onPointerMove={(event) => {
              if (!splitDrag.current) return;
              const delta = splitDrag.current.startX - event.clientX;
              applyDocsWidth(splitDrag.current.startWidth + delta, false);
            }}
            onPointerUp={(event) => {
              if (!splitDrag.current) return;
              splitDrag.current = null;
              document.body.classList.remove('resizing-docs');
              event.currentTarget.releasePointerCapture(event.pointerId);
              applyDocsWidth(docsWidth, true);
            }}
            onPointerCancel={() => {
              splitDrag.current = null;
              document.body.classList.remove('resizing-docs');
            }}
            onDoubleClick={() => applyDocsWidth(DOCS_DEFAULT, true)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                applyDocsWidth(docsWidth + 24, true);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                applyDocsWidth(docsWidth - 24, true);
              }
            }}
            title="拖动调整文档区宽度，双击恢复默认"
          />
          <DocumentPanel
            width={docsWidth}
            tab={tab}
            onTab={(next) => {
              setTab(next);
              // The files tab is a two-column editor: 372px would squeeze the code.
              if (next === 'files') applyDocsWidth(Math.max(docsWidth, 640), true);
            }}
            dir={dir}
            files={files}
            doc={doc}
            diff={diff}
            memory={memory}
            snapshots={snapshots}
            contract={contract}
            plan={plan}
            view={view}
            onView={setView}
            onNavigate={(path) => void navigate(path)}
            onOpenFile={(path) => void openFile(path)}
            onOpenFileHere={(path) => void openFile(path, activeId, 'source', undefined, false, true)}
            onError={(message) => setError(message)}
            onDeleteMemory={(slot) => void deleteMemory(slot)}
            onRevert={(id) => void revert(id)}
            onMemorySet={(slot, value) => void saveMemoryFact(slot, value)}
            onRefreshFiles={() => void refreshSide()}
            approvals={approvals}
            threadId={activeId ?? ''}
            onOpenExternal={(url) => void call('app/open-external', { url })}
          />
        </>
      ) : null}
      </div>

      {terminalMounted ? (
        <div className={`term-slot${terminalOpen ? '' : ' hidden'}`}>
          <TerminalDock
            cwd={thread?.cwd || workspaceInfo?.path || ''}
            theme={theme}
            onClose={() => setTerminalOpen(false)}
          />
        </div>
      ) : null}

        </section>
      </div>
      )}

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  );
}
