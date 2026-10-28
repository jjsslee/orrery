/**
 * Small helpers shared by the collectors: paginator draining, tolerant
 * fan-out under the shared concurrency limiter, ARN parsing.
 */
import type { CollectorContext } from './types.ts';

export class PartialCollectionError extends Error {
  constructor(readonly items: unknown[], cause: unknown) { super(errMsg(cause), {cause}); this.name = cause instanceof Error ? cause.name : 'UnknownError'; }
}

/** Drain an SDK paginator into one array. */
export async function collect<P, T>(pages: AsyncIterable<P>, pick: (page: P) => T[] | undefined): Promise<T[]> {
  const out: T[] = [];
  try { for await (const page of pages) out.push(...(pick(page) ?? [])); }
  catch (error) { throw new PartialCollectionError(out,error); }
  return out;
}

export function errMsg(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * Run a per-resource call under the shared limiter. Failures are logged and
 * swallowed (returns undefined) so one broken resource does not fail the
 * whole collector.
 */
export async function attempt<T>(ctx: CollectorContext, what: string, fn: () => Promise<T>): Promise<T | undefined> {
  const attemptedAt = new Date().toISOString();
  try {
    const result = await ctx.limit(fn);
    ctx.observe?.({ key: what, operation: what, state: 'complete', attemptedAt, succeededAt: new Date().toISOString() });
    return result;
  } catch (err) {
    ctx.observe?.({ key: what, operation: what, state: err instanceof PartialCollectionError && err.items.length ? 'partial' : 'failed', attemptedAt, errorCode: err instanceof Error ? err.name : 'UnknownError' });
    ctx.log(`[${what}] ${errMsg(err)}`);
    return err instanceof PartialCollectionError && err.items.length ? err.items as T : undefined;
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Host part of a URL or bare host, lower-cased; undefined when not parseable. */
export function hostOf(value?: string | null): string | undefined {
  if (!value) return undefined;
  const m = value.match(/^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/:?#]+)/i);
  return m?.[1]?.toLowerCase();
}

/** arn:aws:lambda:r:a:function:NAME[:alias] → NAME */
export function lambdaNameFromArn(arn?: string | null): string | undefined {
  if (!arn) return undefined;
  const m = arn.match(/:function:([^:/]+)/);
  return m?.[1];
}

/** arn:aws:iam::a:role/path/NAME → NAME (instance-profile ARNs work the same way) */
export function roleNameFromArn(arn?: string | null): string | undefined {
  if (!arn) return undefined;
  const m = arn.match(/:(?:role|instance-profile)\/(?:.*\/)?([^/]+)$/);
  return m?.[1];
}

export function lowerTags(tags?: Array<{ key?: string; value?: string }>): Record<string, string> | undefined {
  if (!tags?.length) return undefined;
  const out: Record<string, string> = {};
  for (const t of tags) if (t.key) out[t.key] = t.value ?? '';
  return Object.keys(out).length ? out : undefined;
}

/** KMS-style {TagKey, TagValue} pairs → record (undefined when empty) */
export function keyValueTags(tags?: Array<{ TagKey?: string; TagValue?: string }>): Record<string, string> | undefined {
  if (!tags?.length) return undefined;
  const out: Record<string, string> = {};
  for (const t of tags) if (t.TagKey) out[t.TagKey] = t.TagValue ?? '';
  return Object.keys(out).length ? out : undefined;
}

export function truncate(s: string | undefined | null, n: number): string | null {
  if (!s) return null;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** "a 2, b 1" style summary of a count map, largest first. */
export function countSummary(counts: Record<string, number>): string | null {
  const entries = Object.entries(counts).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  return entries.length ? entries.map(([k, n]) => `${k} ${n}`).join(', ') : null;
}
