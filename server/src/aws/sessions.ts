/** Sessions expire independently of configuration/metric caches. Refresh validates STS again. */
export class SessionRegistry<T> {
  private readonly entries = new Map<string, { expiresAt: number; pending: Promise<T> }>();
  constructor(private readonly ttlMs = 5 * 60_000, private readonly credentialExpiry?: (value: T) => number | undefined) {}
  get(key: string, create: () => Promise<T>, reconnect = false): Promise<T> {
    const old = this.entries.get(key);
    if (!reconnect && old && old.expiresAt > Date.now()) return old.pending;
    const entry = { expiresAt: Date.now() + this.ttlMs, pending: Promise.resolve().then(create) };
    this.entries.set(key, entry);
    void entry.pending.then((value) => {
      const expiresAt = this.credentialExpiry?.(value);
      if (expiresAt !== undefined) entry.expiresAt = Math.min(entry.expiresAt, expiresAt - 60_000);
    }).catch(() => { if (this.entries.get(key) === entry) this.entries.delete(key); });
    // Do not destroy replaced clients: an older in-flight request may still use them.
    return entry.pending;
  }
}
export function scopeKey(kind: string, source: string, account: string, region: string): string {
  return JSON.stringify([kind, source, account, region]);
}
