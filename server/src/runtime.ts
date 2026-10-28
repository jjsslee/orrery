/**
 * Where Orrery runs: from the repo (`npm run dev` / `npm start`) or inside the
 * Orrery desktop app built by scripts/package.mjs. There the Electron main
 * process (desktop/src/main.ts) starts this server as a utility process next
 * to the built web app and shows it in its own window; the cache lives in the
 * OS user data folder.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import { readPrivateFile } from './private-files.ts';

/** Electron hands a utility process this port to talk back to the main process. */
const parentPort = (process as NodeJS.Process & { parentPort?: { postMessage(message: unknown): void } }).parentPort;

export const packaged = parentPort !== undefined;

declare const __ORRERY_BUILD__: string | undefined;
/** Set by the packager; lets a newly opened build replace a different one still running. */
export const BUILD = typeof __ORRERY_BUILD__ === 'string' ? __ORRERY_BUILD__ : 'dev';

/** Tells the desktop app where the server listens; it opens its window there. */
export function showWindow(url: string): void {
  parentPort?.postMessage({ url });
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

/** The built web app shipped with the packaged server, read once and keyed by URL path. */
export function webFiles(root: string): Map<string, { body: Buffer; type: string }> {
  const files = new Map<string, { body: Buffer; type: string }>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.set(`/${relative(root, path).split(sep).join('/')}`, { body: readFileSync(path), type: MIME[extname(name)] ?? 'application/octet-stream' });
    }
  };
  walk(root);
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
    let token: string | undefined;
    try { token = await readPrivateFile(join(userDataDir(), 'private', `${port}.token`)); } catch { /* Legacy builds did not use a token. */ }
    const res = await fetch(`http://127.0.0.1:${port}/api/quit`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(1500) });
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
