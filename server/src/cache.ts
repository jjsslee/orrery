import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

interface Entry<T> { value: T; storedAt: number }

/**
 * Small two-tier cache: memory first, then a JSON file so `npm run dev`
 * restarts do not hit AWS again. Keys are hashed into collision-resistant file names.
 */
export class Cache {
  private readonly mem = new Map<string, Entry<unknown>>();
  constructor(private readonly dir: string) {}

  async get<T>(key: string, ttlMs: number): Promise<T | undefined> {
    const m = this.mem.get(key) as Entry<T> | undefined;
    if (m && Date.now() - m.storedAt < ttlMs) return m.value;
    try {
      const raw = await readFile(this.file(key), 'utf8');
      const e = JSON.parse(raw) as Entry<T>;
      if (Date.now() - e.storedAt < ttlMs) {
        this.mem.set(key, e);
        return e.value;
      }
    } catch { /* miss */ }
    return undefined;
  }

  async set<T>(key: string, value: T, persist = true): Promise<void> {
    const e: Entry<T> = { value, storedAt: Date.now() };
    this.mem.set(key, e);
    if (!persist) return;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(this.file(key), JSON.stringify(e));
    } catch { /* best effort */ }
  }

  async update<T>(key: string, value: T, expected?: T): Promise<void> {
    const entry = this.mem.get(key);
    if (!entry || (expected !== undefined && entry.value !== expected)) return;
    const next = { ...entry, value };
    this.mem.set(key, next);
    try { await writeFile(this.file(key), JSON.stringify(next)); } catch { /* best effort */ }
  }

  private file(key: string): string {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  }
}
