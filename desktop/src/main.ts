/**
 * The Orrery desktop app. Starts the bundled server (server.cjs, see
 * server/src/runtime.ts) as a utility process and shows the page it serves in
 * Orrery's own window. Closing the window quits the app and the server; a
 * second launch brings the open window forward instead.
 */
import { app, BrowserWindow, dialog, Menu, screen, shell, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess } from 'electron';
import { join } from 'node:path';

/** --canvas of the dark theme, shown until the page paints. */
const CANVAS = '#0b1222';
/** Where the server writes warnings and errors (server/src/runtime.ts userDataDir). */
const LOG = process.platform === 'win32' ? '%LOCALAPPDATA%\\Orrery\\orrery.log' : '~/Library/Application Support/Orrery/orrery.log';

// The server keeps its "cache" in the same data folder; Chromium's "Cache" would be the same folder on case-insensitive disks.
app.setPath('sessionData', join(app.getPath('userData'), 'Session'));

if (!app.requestSingleInstanceLock()) app.quit();
else run();

function run(): void {
  let server: UtilityProcess | undefined;
  let window: BrowserWindow | undefined;
  let quitting = false;

  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    quitting = true;
    server?.kill();
  });

  void app.whenReady().then(() => {
    Menu.setApplicationMenu(menu());
    server = utilityProcess.fork(join(app.getAppPath(), 'server.cjs'), [], { serviceName: 'Orrery Server', stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    server.stderr?.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2000); });
    server.on('message', (message: { url?: string }) => {
      if (message.url && !window) window = open(message.url);
    });
    // The server also ends when a newer Orrery takes over its port (/api/quit).
    server.on('exit', () => {
      if (quitting) return;
      if (!window) dialog.showErrorBox('Orrery를 시작하지 못했습니다', `${errors.trim() || '서버가 바로 종료되었습니다.'}\n\n기록: ${LOG}`);
      app.quit();
    });
  });
}

function open(url: string): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width: Math.min(1440, width),
    height: Math.min(920, height),
    minWidth: 760,
    minHeight: 520,
    title: 'Orrery',
    backgroundColor: CANVAS,
    show: false,
    autoHideMenuBar: true,
    // Electron's defaults already keep the page sandboxed without Node; spellcheck would fetch dictionaries from Google.
    webPreferences: { spellcheck: false, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  window.once('ready-to-show', () => window.show());

  // Links open in the default browser; the window itself stays on the local server.
  const origin = new URL(url).origin;
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openOutside(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => {
    if (new URL(event.url).origin === origin) return;
    event.preventDefault();
    openOutside(event.url);
  });
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);

  void window.loadURL(url);
  return window;
}

function openOutside(url: string): void {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

/** The standard menus (copy and paste need the Edit menu on macOS) without Electron's Help links. */
function menu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  return Menu.buildFromTemplate(template);
}
