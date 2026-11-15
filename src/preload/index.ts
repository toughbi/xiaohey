import { contextBridge, ipcRenderer } from 'electron';

/**
 * The renderer's only door to the app server. One request channel, one event
 * channel, no Node in the renderer.
 */
contextBridge.exposeInMainWorld('xiaohey', {
  request: (method: string, params: unknown) => ipcRenderer.invoke('xiaohey:request', method, params),
  onEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown): void => listener(payload);
    ipcRenderer.on('xiaohey:event', handler);
    return () => ipcRenderer.removeListener('xiaohey:event', handler);
  },
  setTheme: (theme: 'light' | 'dark') => ipcRenderer.invoke('xiaohey:theme', theme),
  windowControl: (action: 'minimize' | 'toggle-maximize' | 'close' | 'state') =>
    ipcRenderer.invoke('xiaohey:window', action),
  platform: process.platform,
});
