import { app, BrowserWindow, ipcMain, Menu, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AppServer } from './server.js';
import { DEFAULT_PROFILE } from './store.js';
import { buildDemoDoc, applyDemoEdits, captureDemoSnapshot, seedDemoWorkspace } from './demo.js';
import type { RuntimeEvent } from '../shared/types.js';

const DEMO = process.env.XIAOHEY_DEMO === '1';
const DEV_URL = process.env.XIAOHEY_DEV_SERVER_URL;

let server: AppServer | null = null;
let win: BrowserWindow | null = null;

function send(event: RuntimeEvent): void {
  if (win && !win.isDestroyed()) win.webContents.send('xiaohey:event', event);
}

/**
 * The folder the agent works in. An installed app must not default to its own
 * install directory (the cwd of a Start-menu launch is unpredictable), so the
 * default is a dedicated folder under Documents; `--workspace=<path>` overrides.
 */
function resolveWorkspace(home: string): string {
  const flag = process.argv.find((arg) => arg.startsWith('--workspace='));
  if (flag) return flag.slice('--workspace='.length).replace(/^"|"$/g, '');
  if (process.env.XIAOHEY_WORKSPACE) return process.env.XIAOHEY_WORKSPACE;
  if (DEMO) return join(home, 'demo-workspace');
  return '';
}

async function bootstrap(): Promise<void> {
  const home = process.env.XIAOHEY_HOME ?? join(app.getPath('userData'), 'xiaohey');
  // A custom home (tests, portable profiles) also gets its own Electron profile so
  // two profiles cannot fight over cache/locks or the single-instance guard.
  if (process.env.XIAOHEY_HOME) {
    const profile = join(process.env.XIAOHEY_HOME, 'electron');
    await mkdir(profile, { recursive: true });
    app.setPath('userData', profile);
  }
  const workspace = resolveWorkspace(home);
  if (workspace) await mkdir(workspace, { recursive: true });

  server = new AppServer(home, workspace, send, DEMO);
  await server.init();

  if (DEMO) {
    // Demo mode is a showcase, not a fresh install: give it a profile so the
    // composer is usable even though the key is empty.
    const current = server.store.getSettings();
    if (current.models.length === 0) {
      await server.store.setSettings({ ...current, models: [{ ...DEFAULT_PROFILE }], activeModelId: DEFAULT_PROFILE.id });
    }
    await seedDemoWorkspace(workspace);
    const existing = await server.store.listThreads();
    if (!existing.some((thread) => thread.id === 'thr_demo_northwind')) {
      const doc = await buildDemoDoc(home, workspace);
      await captureDemoSnapshot(home, doc);
      await applyDemoEdits(workspace);
      await server.store.seedDemo(doc);
      // The demo transcript carries two legacy facts; promote them into the
      // long-term store so the memory panel has real content in the showcase.
      await server.agent.migrateLegacyMemory().catch(() => undefined);
      void server.agent.memory.ensureVectors().catch(() => undefined);
    }
  }

  win = new BrowserWindow({
    ...(app.isPackaged ? {} : { icon: join(app.getAppPath(), 'build', 'icon.png') }),
    width: 1460,
    height: 940,
    minWidth: 1120,
    minHeight: 700,
    show: false,
    backgroundColor: '#fdfefd',
    autoHideMenuBar: true,
    title: 'xiaohey',
    frame: false,
    // The canvas has to reach the window edge: a frameless window with our own
    // caption buttons, so the strip follows the app palette instead of the OS.
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV_URL) {
    await win.loadURL(DEV_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    await win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function currentWindow(): BrowserWindow | null {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
}

ipcMain.handle('xiaohey:window', async (_event, action: 'minimize' | 'toggle-maximize' | 'close' | 'state') => {
  const win = currentWindow();
  if (!win) return { maximized: false };
  if (action === 'minimize') win.minimize();
  else if (action === 'close') win.close();
  else if (action === 'toggle-maximize') {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
  return { maximized: win.isMaximized() };
});

ipcMain.handle('xiaohey:request', async (_event, method: string, params: unknown) => {
  if (!server) return { ok: false, error: 'app server is not ready' };
  try {
    const value = await server.request(method as never, (params ?? {}) as never);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

/** Keep the caption-button strip in the same tone as the canvas. */
ipcMain.handle('xiaohey:theme', (_event, theme: 'light' | 'dark') => {
  if (!win || win.isDestroyed()) return { ok: false };
  win.setBackgroundColor(theme === 'dark' ? '#141210' : '#fdfefd');
  return { ok: true };
});

// A custom home also gets its own Electron profile; this must happen before the
// single-instance guard so two QA profiles never block each other.
if (process.env.XIAOHEY_HOME) {
  const profile = join(process.env.XIAOHEY_HOME, 'electron');
  try {
    mkdirSync(profile, { recursive: true });
    app.setPath('userData', profile);
  } catch {
    // fall back to the default profile if the path cannot be created
  }
}

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
}

app.setAppUserModelId('com.xiaohey.app');

app.whenReady().then(async () => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'editMenu', label: 'Edit' },
      {
        label: 'View',
        submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
      },
    ]),
  );
  await bootstrap();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void bootstrap();
  });
});

let shuttingDown = false;

/** Run the exit pass (interrupted rounds + consolidation + flush) once, then quit. */
async function quitAfterShutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await server?.shutdown();
  } catch {
    // Exiting must not be blocked by a memory/flush failure.
  }
  app.quit();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') void quitAfterShutdown();
});

app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  void quitAfterShutdown();
});
