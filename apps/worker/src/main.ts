// Electron entry: system tray + settings window around the worker core.

import { app, Tray, Menu, BrowserWindow, powerMonitor, nativeImage, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerCore } from './core/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let core: WorkerCore | null = null;

function trayIcon(): Electron.NativeImage {
  // 16x16 green dot PNG generated in-process — no bundled asset needed.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAmklEQVR4nKWTwQ3DIAxFn9k/pM5QhWi' +
      'dITN0hZAZukJH6AxdIVKGSDNDpFxyQKJUJPWvGPP8bcAmIv9IEVEA1Zr2AXgDL2CO+z0AvAD6P6Z6AL/' +
      'gnjsKYG7YBjvgCZzjnssCGJk2wQp4A1/gDqzjngeAjakWYIc3sAZuQD3veQCogUdgnns+AKrgDezjnks' +
      'BmLQK2OANrIH3vecmYJJfA27QH5ZgC2yAnPz/AXzRH4n9AAAAAElFTkSuQmCC',
    'base64',
  );
  return nativeImage.createFromBuffer(png);
}

function createWindow(): void {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 520,
    height: 660,
    resizable: false,
    autoHideMenuBar: true,
    title: 'MassCompute — donate GPU time',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'tray.html'));
  win.on('closed', () => {
    win = null;
  });
}

function updateTray(stateText: string): void {
  tray?.setToolTip(`MassCompute — ${stateText}`);
}

async function main(): Promise<void> {
  await app.whenReady();

  core = new WorkerCore({
    onStatus: (line) => {
      win?.webContents.send('status', line);
    },
    onState: (s) => {
      win?.webContents.send('state', s);
      updateTray(`${s.donorState} · ${s.model ?? 'no model'}`);
    },
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    onBattery: () => powerMonitor.isOnBatteryPower(),
  });

  tray = new Tray(trayIcon());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Settings…', click: () => createWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => createWindow());

  ipcMain.handle('worker:describe', () => core!.describe());
  ipcMain.handle('worker:updateSettings', (_e, patch) => {
    core!.updateSettings(patch);
    return core!.describe();
  });

  await core.start();
  createWindow();
}

app.on('window-all-closed', () => {
  // Tray app: stay alive with no windows.
});

app.on('before-quit', () => {
  core?.stop();
});

void main();
