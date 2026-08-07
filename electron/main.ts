/**
 * electron/main.ts — desktop wrapper for the myAIE Lecture Downloader.
 *
 * Starts the dashboard server (gui-server.ts) in this process and shows it
 * in a native Electron window. The bot engine, live log, and settings all
 * live in the same process — no IPC needed.
 *
 *   npm run desktop          launch the app
 *   npm run desktop:smoke    headless self-check (starts server, hits /api/status, exits)
 */
import { app, BrowserWindow, dialog, shell } from 'electron';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater as { autoUpdater: import('electron-updater').AppUpdater };
import { startServer } from '../gui-server.ts';

type ServerHandle = Awaited<ReturnType<typeof startServer>>;

let serverHandle: ServerHandle | null = null;
let mainWindow: BrowserWindow | null = null;

async function startEmbeddedServer(): Promise<ServerHandle> {
  if (serverHandle) return serverHandle;
  serverHandle = await startServer({ autoOpenBrowser: false });
  return serverHandle;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 920,
    minWidth: 960,
    minHeight: 620,
    title: 'myAIE Lecture Downloader',
    autoHideMenuBar: true,
    backgroundColor: '#0b1120',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadURL((serverHandle as ServerHandle).url);
  // Open external links (e.g. the GitHub profile in the footer) in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------------------------------------------------------------------
// Auto-updates (packaged app only): silently checks GitHub Releases on startup,
// asks before downloading, and offers to restart once the new build is ready.
// ---------------------------------------------------------------------------
function setupAutoUpdates(): void {
  if (!app.isPackaged) return; // dev mode: updates only make sense in the installed app

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (!win) return;
    void dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update available',
      message: 'A new version of myAIE Lecture Downloader is available.',
      detail: 'Download it now? You can keep using the app while it downloads.',
      buttons: ['Download update', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.downloadUpdate();
    });
  });

  autoUpdater.on('update-downloaded', () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (!win) return;
    void dialog.showMessageBox(win, {
      type: 'info',
      title: 'Update ready',
      message: 'The new version is downloaded and ready to install.',
      detail: 'Restart now to finish the update.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    // Network / no-release-yet failures are non-fatal — keep the app usable.
    console.warn('Update check failed:', err.message);
  });

  autoUpdater.checkForUpdates().catch(() => { /* offline or no release yet — fine */ });
}

// Single instance: two windows would fight over the same settings/dashboard port.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      if (process.argv.includes('--smoke')) {
        // Headless self-check for CI / local validation.
        const h = await startEmbeddedServer();
        const res = await fetch(h.url + 'api/status');
        const body = (await res.json()) as { state: string };
        console.log('SMOKE OK', res.status, JSON.stringify({ state: body.state, url: h.url }));
        await h.close();
        serverHandle = null;
        app.exit(0);
        return;
      }
      await startEmbeddedServer();
      createWindow();
      setupAutoUpdates();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('Failed to start:', msg);
      dialog.showErrorBox('myAIE Lecture Downloader', 'Could not start the dashboard server:\n' + msg);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  app.on('before-quit', () => {
    if (serverHandle) { void serverHandle.close(); serverHandle = null; }
  });
}
