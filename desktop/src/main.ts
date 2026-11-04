import { allowClipboardWrite } from './permissions';
/**
 * The Orrery desktop app. Starts the bundled server (server.cjs, see
 * server/src/runtime.ts) as a utility process and shows the page it serves in
 * Orrery's own window. Closing the window quits the app and the server; a
 * second launch brings the open window forward instead.
 */
import { app, BrowserWindow, dialog, Menu, screen, shell, utilityProcess, type MenuItemConstructorOptions, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { UpdateController } from './update-controller';
import { updateInProgress } from './update-install';

/** --canvas of the dark theme, shown until the page paints. */
const CANVAS = '#0b1222';
/** Where the server writes warnings and errors (server/src/runtime.ts userDataDir). */
const LOG = process.platform === 'win32' ? '%LOCALAPPDATA%\\Orrery\\orrery.log' : '~/Library/Application Support/Orrery/orrery.log';

// The server keeps its "cache" in the same data folder; Chromium's "Cache" would be the same folder on case-insensitive disks.
app.setPath('sessionData', join(app.getPath('userData'), 'Session'));

void start();

async function start(): Promise<void> {
  if (app.isPackaged && await updateInProgress(app.getPath('userData'), process.argv)) { app.quit(); return; }
  if (!app.requestSingleInstanceLock()) app.quit();
  else run();
}

function run(): void {
  let server: UtilityProcess | undefined;
  let window: BrowserWindow | undefined;
  let quitting = false;
  const updates = new UpdateController(() => window, () => server?.pid);

  // The update helper asks an unhealthy new build to quit before restoring its backup.
  process.once('SIGTERM', () => app.quit());

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
    const applicationMenu = menu(() => { void updates.check(true); });
    Menu.setApplicationMenu(applicationMenu);
    updates.bindMenu(applicationMenu.getMenuItemById('check-updates') ?? undefined);
    server = utilityProcess.fork(join(app.getAppPath(), 'server.cjs'), [], { serviceName: 'Orrery Server', stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    server.stderr?.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2000); });
    server.on('message', (message: { url?: string }) => {
      if (message.url && !window) {
        window = open(message.url, () => { void updates.ready(); updates.start(); });
      }
    });
    // The server also ends when a newer Orrery takes over its port (/api/quit).
    server.on('exit', () => {
      if (quitting) return;
      if (!window) dialog.showErrorBox('Orrery를 시작하지 못했습니다', `${errors.trim() || '서버가 바로 종료되었습니다.'}\n\n기록: ${LOG}`);
      app.quit();
    });
  });
}

function open(url: string, ready: () => void): BrowserWindow {
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
  let painted = false;
  let loaded = false;
  const showReady = (): void => {
    if (!painted || !loaded) return;
    window.show();
    ready();
  };
  window.once('ready-to-show', () => { painted = true; showReady(); });

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
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(contents === window.webContents && allowClipboardWrite(permission, origin, contents.getURL(), details.requestingUrl, details.isMainFrame));
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission, _requestingOrigin, details) =>
    contents === window.webContents && allowClipboardWrite(permission, origin, contents.getURL(), details.requestingUrl, details.isMainFrame));

  void window.loadURL(url).then(() => { loaded = true; showReady(); }).catch(() => {
    dialog.showErrorBox('Orrery 화면을 열지 못했습니다', '앱을 다시 실행하세요. 업데이트 중이라면 이전 버전으로 복구합니다.');
    app.quit();
  });
  return window;
}

function openOutside(url: string): void {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

/** The standard menus (copy and paste need the Edit menu on macOS) without Electron's Help links. */
function menu(checkUpdates: () => void): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as const] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: '업데이트', submenu: [{ id: 'check-updates', label: '업데이트 확인…', click: checkUpdates }] },
  ];
  return Menu.buildFromTemplate(template);
}
