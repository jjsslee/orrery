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

/** True when an Orrery (not some other program) already answers on this port. */
export async function orreryAt(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return ((await res.json()) as { readOnly?: boolean }).readOnly === true;
  } catch {
    return false;
  }
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
