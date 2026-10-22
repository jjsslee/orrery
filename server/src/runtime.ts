/**
 * Where Orrery runs: from the repo (`npm run dev` / `npm start`) or as a
 * single executable built by scripts/package.mjs (Node SEA). The executable
 * carries the web app as embedded assets, keeps its cache in the OS user data
 * folder and opens the default browser itself.
 */
import { getAsset, getAssetKeys, isSea } from 'node:sea';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

export const packaged = isSea();

/** Launched as Orrery.app (from Finder): there is no console window, so the server detaches and logs to a file. */
export const macApp = packaged && process.platform === 'darwin' && process.execPath.includes('.app/Contents/MacOS/');

declare const __ORRERY_BUILD__: string | undefined;
/** Set by the packager; lets a newly opened build replace a different one still running in the background. */
export const BUILD = typeof __ORRERY_BUILD__ === 'string' ? __ORRERY_BUILD__ : 'dev';

/**
 * Finder treats Orrery.app as running until the launched process exits and
 * ignores double-clicks meanwhile. So the launch process starts the server as
 * a detached copy of itself and exits, and every double-click reaches the
 * server's own logic (open the running one, or start).
 */
export function detachServer(): void {
  spawn(process.execPath, [], { detached: true, stdio: 'ignore', env: { ...process.env, ORRERY_DETACHED: '1' } }).unref();
}

/** ~/Library/Application Support/Orrery, %LOCALAPPDATA%\Orrery, or $XDG_DATA_HOME/orrery. */
export function userDataDir(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Orrery');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Orrery');
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'orrery');
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/** The built web app embedded by the packager (asset keys "web/<path>"), keyed by URL path. */
export function embeddedWeb(): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  for (const key of getAssetKeys()) {
    if (!key.startsWith('web/')) continue;
    files.set(key.slice('web'.length), { body: Buffer.from(getAsset(key)), type: MIME[extname(key)] ?? 'application/octet-stream' });
  }
  return files;
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
      .once('error', () => resolve(false))
      .once('listening', () => probe.close(() => resolve(true)))
      .listen(port, '127.0.0.1');
  });
}

/** The build of the Orrery answering on this port, or undefined when it is some other program. */
export async function orreryAt(port: number): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const health = (await res.json()) as { readOnly?: boolean; build?: string };
    return health.readOnly === true ? (health.build ?? 'unknown') : undefined;
  } catch {
    return undefined;
  }
}

/** Asks a packaged Orrery on this port to quit; true once the port is free. A repo server has no quit and stays. */
export async function replaceOrrery(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST', signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  for (let i = 0; i < 20; i++) {
    if (await portFree(port)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

export function openBrowser(url: string): void {
  // `start` is a cmd builtin; verbatim arguments keep the empty window title ("") intact.
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' })
    .on('error', () => console.log(`브라우저를 열지 못했습니다. 직접 여세요: ${url}`))
    .unref();
}
