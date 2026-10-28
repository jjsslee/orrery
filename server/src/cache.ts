import { readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { privateDirectory, protectPrivateFile, readPrivateFile, writePrivateFile } from './private-files.ts';

interface Entry<T> { value: T; storedAt: number }

/**
 * Small two-tier cache: memory first, then a JSON file so `npm run dev`
 * restarts do not hit AWS again. Keys are hashed into collision-resistant file names.
 */
export class Cache {
  private readonly mem = new Map<string, Entry<unknown>>();
  private ready?: Promise<void>;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private readonly dir: string) {}

  initialize(): Promise<void> {
    return this.ready ??= (async () => {
      await privateDirectory(this.dir);
      // Repair legacy cache files before reusing any of them (including expired files).
      for (const name of await readdir(this.dir)) {
        if (/^[a-f0-9]{64}\.json$/.test(name)) await protectPrivateFile(join(this.dir, name));
      }
    })();
  }

  async get<T>(key: string, ttlMs: number): Promise<T | undefined> {
    const m = this.mem.get(key) as Entry<T> | undefined;
    if (m && Date.now() - m.storedAt < ttlMs) return m.value;
    try {
      await this.initialize();
      const raw = await readPrivateFile(this.file(key));
      const e = JSON.parse(raw) as Entry<T>;
      if (Date.now() - e.storedAt < ttlMs) {
        this.mem.set(key, e);
        return e.value;
      }
    } catch { /* miss */ }
    return undefined;
  }

  async set<T>(key: string, value: T, persist = true): Promise<boolean> {
    const e: Entry<T> = { value, storedAt: Date.now() };
    this.mem.set(key, e);
    if (!persist) return true;
    const write = this.writes.then(async () => {
      try {
        await this.initialize();
        await writePrivateFile(this.file(key), JSON.stringify(e));
        if (key.includes('graph-v9')) await this.trimHistories();
        return true;
      } catch { return false; }
    });
    this.writes = write;
    return write;
  }

  /** Aggregate history budget; current topology and other cache payloads are not evicted. */
  private async trimHistories(): Promise<void> {
    const records: Array<{path:string;entry:Entry<Record<string,unknown>>;bytes:number}> = [];
    for (const name of await readdir(this.dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path=join(this.dir,name);
      let entry: Entry<Record<string,unknown>>;
      try { entry=JSON.parse(await readPrivateFile(path)); } catch { continue; }
      const value=entry?.value;
      if (!value || typeof value !== 'object' || !('relationshipHistory' in value)) continue;
      const bytes=Buffer.byteLength(JSON.stringify([value.relationshipHistory,value.relationshipChanges,value.historicalNodes]));
      records.push({path,entry,bytes});
    }
    let bytes=records.reduce((sum,r)=>sum+r.bytes,0);
    for (const record of records.sort((a,b)=>a.entry.storedAt-b.entry.storedAt)) {
      if (bytes <= 50*1024*1024) break;
      const fields={relationshipHistory:[],relationshipChanges:[],historicalNodes:[]};
      Object.assign(record.entry.value,fields);
      await writePrivateFile(record.path,JSON.stringify(record.entry));
      for(const [key,entry] of this.mem) if(this.file(key)===record.path && entry.value && typeof entry.value==='object') Object.assign(entry.value,fields);
      bytes-=record.bytes;
    }
  }

  async update<T>(key: string, value: T, expected?: T): Promise<void> {
    const task = this.writes.then(async () => {
      const entry = this.mem.get(key);
      if (!entry || (expected !== undefined && entry.value !== expected)) return;
      const next = { ...entry, value };
      this.mem.set(key, next);
      try { await writePrivateFile(this.file(key), JSON.stringify(next)); } catch { /* best effort */ }
    });
    this.writes = task;
    await task;
  }

  private file(key: string): string {
    return join(this.dir, `${createHash('sha256').update(key).digest('hex')}.json`);
  }
}
