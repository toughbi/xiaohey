import pty, { type IPty } from 'node-pty';
import type { RuntimeEvent } from '../../shared/types.js';

/**
 * One terminal pane, backed by a real pseudoconsole (ConPTY through node-pty).
 *
 * Unlike a pipe, a PTY makes the shell believe it is talking to a console: PSReadLine
 * does line editing and history, colors work, Ctrl+C is a real interrupt, and
 * full-screen programs (vim, a REPL) can run. The renderer paints the VT stream with
 * xterm.js, so the panel is the same terminal the shell thinks it has.
 */

/** Shells a pane can run. cmd first: it is the console people mean by "terminal". */
export type ShellKind = 'cmd' | 'powershell';

const SHELLS: Record<ShellKind, { file: string; args: string[]; label: string }> = {
  cmd: { file: 'cmd.exe', args: [], label: '命令提示符' },
  powershell: { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile'], label: 'Windows PowerShell' },
};

export function shellLabel(kind: ShellKind): string {
  return SHELLS[kind].label;
}

function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.TERM = 'xterm-256color';
  return env;
}

export class TerminalShell {
  readonly id: string;
  readonly shell: string;
  readonly kind: ShellKind;
  cwd: string;
  private term: IPty;

  constructor(
    id: string,
    cwd: string,
    cols: number,
    rows: number,
    kind: ShellKind,
    private readonly emit: (event: RuntimeEvent) => void,
  ) {
    this.id = id;
    this.cwd = cwd;
    this.kind = kind;
    this.shell = SHELLS[kind].label;
    const spec = SHELLS[kind];
    this.term = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(2, rows),
      cwd,
      env: shellEnv(),
      // ConPTY is the Windows backend; node-pty picks the native pty elsewhere.
      useConpty: true,
    });
    this.term.onData((data) => {
      this.emit({ type: 'terminal/data', id, data: Buffer.from(data, 'utf8').toString('base64') });
    });
    this.term.onExit(({ exitCode }) => {
      this.emit({ type: 'terminal/exit', id, code: exitCode });
    });
  }

  /** Raw keystrokes from the renderer (already UTF-8 encoded). */
  write(bytes: Buffer): void {
    this.term.write(bytes.toString('utf8'));
  }

  resize(cols: number, rows: number): void {
    try {
      this.term.resize(Math.max(2, Math.min(500, cols)), Math.max(2, Math.min(200, rows)));
    } catch {
      // The pty can disappear between a resize and the write; the exit event tells the UI.
    }
  }

  close(): void {
    try {
      this.term.kill();
    } catch {
      // already gone
    }
  }
}

export class Terminals {
  private shells = new Map<string, TerminalShell>();

  constructor(private readonly emit: (event: RuntimeEvent) => void) {}

  create(cwd: string, cols: number, rows: number, kind: ShellKind = 'cmd'): TerminalShell {
    const id = `term_${Math.random().toString(36).slice(2, 10)}`;
    const shell = new TerminalShell(id, cwd, cols, rows, kind, this.emit);
    this.shells.set(id, shell);
    return shell;
  }

  get(id: string): TerminalShell | undefined {
    return this.shells.get(id);
  }

  close(id: string): void {
    this.shells.get(id)?.close();
    this.shells.delete(id);
  }

  disposeAll(): void {
    for (const shell of this.shells.values()) shell.close();
    this.shells.clear();
  }
}
