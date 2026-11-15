import type { RequestMap, RequestName, RuntimeEvent } from '../shared/types';

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: string };

declare global {
  interface Window {
    xiaohey: {
      request: (method: string, params: unknown) => Promise<Envelope<unknown>>;
      onEvent: (listener: (event: RuntimeEvent) => void) => () => void;
      setTheme: (theme: 'light' | 'dark') => Promise<unknown>;
      windowControl: (action: 'minimize' | 'toggle-maximize' | 'close' | 'state') => Promise<{ maximized: boolean }>;
      platform: string;
    };
    __xiaoheyShot?: {
      openThread: () => void;
      switchTab: (tab: 'files' | 'preview' | 'memory' | 'checkpoints') => void;
      openSettings: () => void;
      closeSettings: () => void;
      expandTools: () => void;
      setTheme: (theme: 'dark' | 'light') => void;
    };
  }
}

export type { RequestMap, RequestName };
