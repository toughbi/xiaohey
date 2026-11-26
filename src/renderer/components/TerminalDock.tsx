import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Plus, X } from 'lucide-react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { call, subscribe } from '../lib/client';

/**
 * The workspace terminal.
 *
 * Each pane is a real shell: the main process spawns it on a PTY (node-pty →
 * ConPTY), so PSReadLine editing, history, colors, Ctrl+C and full-screen
 * programs behave exactly as in a console window. xterm.js paints the VT stream
 * and sends keystrokes back, so the panel *is* the terminal, not a facsimile.
 */

type ShellKind = 'cmd' | 'powershell';

interface TermState {
  id: string;
  cwd: string;
  shell: string;
  kind: ShellKind;
}

type Split = 'none' | 'row' | 'column';

const MIN_HEIGHT = 140;
const MAX_HEIGHT = 640;

/**
 * The terminal wears the app's theme: the surface and text come from the same CSS
 * variables the rest of the UI uses, while the sixteen ANSI colours come from a
 * palette that reads well on that surface (Campbell for dark, Light+ for light).
 */
function terminalTheme(theme: 'light' | 'dark') {
  const style = getComputedStyle(document.documentElement);
  const surface = style.getPropertyValue('--panel').trim() || (theme === 'light' ? '#ffffff' : '#1b1815');
  const ink = style.getPropertyValue('--ink').trim() || (theme === 'light' ? '#1f2023' : '#e6e1d8');
  const dim = style.getPropertyValue('--ink-3').trim() || '#80868b';
  const accent = style.getPropertyValue('--accent-soft').trim() || '#eaf1fd';
  const palette =
    theme === 'light'
      ? {
          black: '#000000', red: '#cd3131', green: '#00bc00', yellow: '#949800',
          blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
          brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00',
          brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5',
        }
      : {
          black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00',
          blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
          brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5',
          brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
        };
  return {
    ...palette,
    background: surface,
    foreground: ink,
    cursor: ink,
    cursorAccent: surface,
    selectionBackground: accent,
    selectionForeground: ink,
    scrollbarSliderBackground: `color-mix(in srgb, ${dim} 30%, transparent)`,
  };
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function bytesOf(data: string): Uint8Array {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function TerminalDock({
  cwd,
  theme,
  onClose,
}: {
  cwd: string;
  theme: 'light' | 'dark';
  onClose: () => void;
}) {
  const [terms, setTerms] = useState<TermState[]>([]);
  const [panes, setPanes] = useState<Array<string | null>>([null, null]);
  const [split, setSplit] = useState<Split>('none');
  const [activePane, setActivePane] = useState<0 | 1>(0);
  const [shellKind, setShellKind] = useState<ShellKind>('cmd');
  const [shellMenu, setShellMenu] = useState(false);
  const [height, setHeight] = useState(() => {
    const stored = Number(window.localStorage.getItem('xiaohey-terminal-height'));
    return Number.isFinite(stored) && stored >= MIN_HEIGHT ? stored : 260;
  });
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const xterms = useRef<Record<string, Terminal>>({});
  const fits = useRef<Record<string, FitAddon>>({});
  const containers = useRef<Record<string, HTMLDivElement | null>>({});

  // Shell output → the terminal that owns it.
  useEffect(
    () =>
      subscribe((event) => {
        if (event.type === 'terminal/data') {
          xterms.current[event.id]?.write(bytesOf(event.data));
          return;
        }
        if (event.type === 'terminal/exit') {
          xterms.current[event.id]?.writeln(`\r\n\x1b[90m[shell exited with ${event.code}]\x1b[0m`);
        }
      }),
    [],
  );

  /** Attach an xterm to a pane container and wire it to its pty. */
  const mountTerminal = useCallback((id: string, node: HTMLDivElement) => {
    if (xterms.current[id]) {
      fits.current[id]?.fit();
      return;
    }
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Consolas", "Courier New", monospace',
      fontSize: 12.5,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 1,
      // Unfocused panes keep the thin bar instead of xterm's outline box.
      cursorInactiveStyle: 'bar',
      scrollback: 3000,
      theme: terminalTheme(theme),
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(node);
    xterms.current[id] = term;
    fits.current[id] = fit;
    fit.fit();
    term.onData((data) => {
      void call('terminal/input', { id, data: window.btoa(unescape(encodeURIComponent(data))) }).catch(() => undefined);
    });
    const sync = (): void => {
      fit.fit();
      void call('terminal/resize', { id, cols: term.cols, rows: term.rows }).catch(() => undefined);
    };
    const observer = new ResizeObserver(() => sync());
    observer.observe(node);
    sync();
    term.focus();
  }, []);

  const create = useCallback(
    async (pane: 0 | 1, kind: ShellKind = shellKind) => {
      // Size first, so the shell is born at the pane's real geometry.
      const host = document.querySelector<HTMLDivElement>(`.term-pane[data-pane="${pane}"] .term-xterm`);
      const probe = new Terminal({ cols: 80, rows: 24 });
      const cols = host ? Math.max(20, Math.floor((host.clientWidth - 16) / 7.2)) : 80;
      const rows = host ? Math.max(6, Math.floor((host.clientHeight - 12) / 15)) : 24;
      probe.dispose();
      const created = await call('terminal/create', { cwd: cwd || '.', cols, rows, shell: kind }).catch(() => null);
      if (!created) return;
      setTerms((list) => [...list, { id: created.id, cwd: created.cwd, shell: created.shell, kind: created.kind }]);
      setPanes((prev) => {
        const next = [...prev];
        next[pane] = created.id;
        return next;
      });
      setActivePane(pane);
    },
    [cwd, shellKind],
  );

  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void create(0);
  }, [create]);

  // Theme switch: repaint every live terminal with the palette for the new surface.
  // xterm keeps the old background until it is asked to redraw the viewport.
  useEffect(() => {
    const palette = terminalTheme(theme);
    for (const term of Object.values(xterms.current)) {
      term.options.theme = palette;
      term.refresh(0, Math.max(0, term.rows - 1));
    }
  }, [theme]);

  const termOf = (pane: 0 | 1): TermState | null => {
    const id = panes[pane];
    return id ? terms.find((term) => term.id === id) ?? null : null;
  };

  const closeTerm = (id: string): void => {
    void call('terminal/close', { id }).catch(() => undefined);
    xterms.current[id]?.dispose();
    delete xterms.current[id];
    delete fits.current[id];
    setTerms((list) => list.filter((term) => term.id !== id));
    setPanes((prev) => {
      const next: Array<string | null> = prev.map((entry) => (entry === id ? null : entry));
      if (next[0] === null && next[1] !== null) {
        next[0] = next[1];
        next[1] = null;
      }
      return next;
    });
  };

  const cycleSplit = (): void => {
    if (split === 'none') {
      setSplit('row');
      if (!panes[1]) void create(1);
      return;
    }
    if (split === 'row') {
      setSplit('column');
      return;
    }
    setSplit('none');
    setActivePane(0);
  };

  const SplitIcon = split === 'row' ? RowsIcon : ColumnsIcon;
  const splitTitle = split === 'none' ? '左右分屏' : split === 'row' ? '改为上下分屏' : '取消分屏';
  const panesToShow: Array<0 | 1> = split === 'none' ? [0] : [0, 1];

  return (
    <section className="term-dock" style={{ height }} aria-label="终端">
      <div
        className="term-resize"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整终端高度"
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { startY: event.clientY, startHeight: height };
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          const next = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, drag.current.startHeight + (drag.current.startY - event.clientY)));
          setHeight(next);
        }}
        onPointerUp={() => {
          drag.current = null;
          window.localStorage.setItem('xiaohey-terminal-height', String(height));
        }}
        onDoubleClick={() => setHeight(260)}
      />

      <header className="term-head">
        <div className="term-tabs">
          {terms.map((term) => (
            <button
              key={term.id}
              type="button"
              className={`term-tab ${panes.includes(term.id) ? 'open' : ''} ${
                panes[activePane] === term.id ? 'active' : ''
              }`}
              title={`${term.shell} · ${term.cwd}`}
              onClick={() => {
                setPanes((prev) => {
                  const next = [...prev];
                  const other: 0 | 1 = activePane === 0 ? 1 : 0;
                  if (next[other] === term.id) next[other] = null;
                  next[activePane] = term.id;
                  return next;
                });
                window.setTimeout(() => xterms.current[term.id]?.focus(), 0);
              }}
            >
              <TermIcon />
              {baseName(term.cwd) || '终端'}
              <span
                className="term-tab-close"
                role="button"
                aria-label="关闭这个终端"
                tabIndex={0}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTerm(term.id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.stopPropagation();
                  closeTerm(term.id);
                }}
              >
                <X size={11} strokeWidth={2} />
              </span>
            </button>
          ))}
        </div>
        <div className="term-actions">
          <button type="button" className="ghost icon" onClick={cycleSplit} aria-label={splitTitle} title={splitTitle}>
            <SplitIcon />
          </button>
          <div className="term-shell-wrap">
            <button
              type="button"
              className={`ghost icon${shellMenu ? ' active' : ''}`}
              onClick={() => setShellMenu((value) => !value)}
              aria-label="新建终端"
              title="新建终端"
            >
              <Plus size={15} strokeWidth={1.9} />
            </button>
            {shellMenu ? (
              <div className="term-shell-menu" role="menu">
                {(['cmd', 'powershell'] as const).map((kind) => (
                  <button
                    key={kind}
                    type="button"
                    className={shellKind === kind ? 'active' : ''}
                    onClick={() => {
                      setShellKind(kind);
                      setShellMenu(false);
                      void create(activePane, kind);
                    }}
                  >
                    {kind === 'cmd' ? '命令提示符' : 'Windows PowerShell'}
                    {shellKind === kind ? <Check size={12} strokeWidth={2.2} /> : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" className="ghost icon" onClick={onClose} aria-label="收起终端" title="收起终端">
            <X size={15} strokeWidth={1.7} />
          </button>
        </div>
      </header>

      <div className={`term-body ${split === 'none' ? '' : split === 'row' ? 'split-row' : 'split-column'}`}>
        {panesToShow.map((pane) => {
          const term = termOf(pane);
          return (
            <div
              key={pane}
              data-pane={pane}
              className={`term-pane ${activePane === pane ? 'active' : ''}`}
              onMouseDown={() => setActivePane(pane)}
            >
              {term ? (
                <div
                  className="term-xterm"
                  ref={(node) => {
                    containers.current[term.id] = node;
                    if (node) mountTerminal(term.id, node);
                  }}
                />
              ) : (
                <p className="term-empty">
                  这一栏还没有终端。
                  <button type="button" className="mini" onClick={() => void create(pane)}>
                    新建一个
                  </button>
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function TermIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9 12h4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ColumnsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 3v10" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

function RowsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M2 8h12" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}
