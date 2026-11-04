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
import { createTranslator, detectLanguage, isLanguage, type Language } from '@orrery/shared';
import { readLanguage, saveLanguage } from './language';

let language: Language = 'ko';
const desktopText = createTranslator(() => language);

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
  const updates = new UpdateController(() => window, () => server?.pid, () => language);
  let preferenceWrite = Promise.resolve();

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

  const refreshMenu = (): void => {
    const applicationMenu = menu(() => { void updates.check(true); });
    Menu.setApplicationMenu(applicationMenu);
    updates.bindMenu(applicationMenu.getMenuItemById('check-updates') ?? undefined);
  };
  void app.whenReady().then(async () => {
    language = await readLanguage(app.getPath('userData')) ?? detectLanguage(app.getLocale());
    refreshMenu();
    server = utilityProcess.fork(join(app.getAppPath(), 'server.cjs'), [], { serviceName: 'Orrery Server', stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    server.stderr?.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-2000); });
    server.on('message', (message: { url?: string; language?: unknown }) => {
      if (isLanguage(message.language)) {
        const next = message.language;
        language = next;
        refreshMenu();
        preferenceWrite = preferenceWrite.catch(() => {}).then(() => saveLanguage(app.getPath('userData'), next));
        void preferenceWrite.catch(() => {});
      }
      if (message.url && !window) {
        window = open(message.url, () => { void updates.ready(); updates.start(); });
      }
    });
    // The server also ends when a newer Orrery takes over its port (/api/quit).
    server.on('exit', () => {
      if (quitting) return;
      if (!window) dialog.showErrorBox(desktopText('Orrery를 시작하지 못했습니다'), desktopText`${desktopText(errors.trim() || '서버가 바로 종료되었습니다.')}\n\n기록: ${LOG}`);
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
    dialog.showErrorBox(desktopText('Orrery 화면을 열지 못했습니다'), desktopText('앱을 다시 실행하세요. 업데이트 중이라면 이전 버전으로 복구합니다.'));
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
    ...(process.platform === 'darwin' ? [{ label: 'Orrery', submenu: [
      { role: 'about', label: desktopText('Orrery 정보') }, { type: 'separator' },
      { role: 'services', label: desktopText('서비스 메뉴') }, { type: 'separator' },
      { role: 'hide', label: desktopText('Orrery 숨기기') }, { role: 'hideOthers', label: desktopText('다른 앱 숨기기') }, { role: 'unhide', label: desktopText('모두 보기') }, { type: 'separator' },
      { role: 'quit', label: desktopText('Orrery 종료') },
    ] } as MenuItemConstructorOptions] : []),
    { label: desktopText('편집'), submenu: [
      { role: 'undo', label: desktopText('실행 취소') }, { role: 'redo', label: desktopText('다시 실행') }, { type: 'separator' },
      { role: 'cut', label: desktopText('잘라내기') }, { role: 'copy', label: desktopText('복사') }, { role: 'paste', label: desktopText('붙여넣기') }, ...(process.platform === 'darwin' ? [{ role: 'pasteAndMatchStyle', label: desktopText('스타일 없이 붙여넣기') } as MenuItemConstructorOptions] : []), { role: 'selectAll', label: desktopText('모두 선택') },
    ] },
    { label: desktopText('보기 메뉴'), submenu: [
      { role: 'reload', label: desktopText('새로고침') }, { role: 'forceReload', label: desktopText('강력 새로고침') }, { role: 'toggleDevTools', label: desktopText('개발자 도구') }, { type: 'separator' },
      { role: 'resetZoom', label: desktopText('실제 크기') }, { role: 'zoomIn', label: desktopText('화면 확대') }, { role: 'zoomOut', label: desktopText('화면 축소') }, { role: 'togglefullscreen', label: desktopText('전체 화면') },
    ] },
    { label: desktopText('창'), submenu: [{ role: 'minimize', label: desktopText('최소화') }, { role: 'zoom', label: desktopText('창 확대') }, { role: 'close', label: desktopText('닫기') }, ...(process.platform === 'darwin' ? [{ role: 'front', label: desktopText('앞으로 가져오기') } as MenuItemConstructorOptions] : [])] },
    { label: desktopText('업데이트'), submenu: [{ id: 'check-updates', label: desktopText('업데이트 확인…'), click: checkUpdates }] },
  ];
  return Menu.buildFromTemplate(template);
}
