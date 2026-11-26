/**
 * Minimal ambient types for node-pty (the package ships JavaScript, not a .d.ts).
 * Only the surface this app uses is declared.
 */
declare module 'node-pty' {
  export interface IPty {
    readonly pid: number;
    readonly cols: number;
    readonly rows: number;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
  }

  export interface SpawnOptions {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string>;
    encoding?: string | null;
    useConpty?: boolean;
  }

  export function spawn(file: string, args: string[], options?: SpawnOptions): IPty;

  const pty: { spawn: typeof spawn };
  export default pty;
}
