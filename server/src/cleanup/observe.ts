import type { CleanupCoverage, CleanupDiscovery, CleanupRule } from '@orrery/shared';

/** Adds only safe observation metadata; preserves the collector's existing failure behavior. */
export async function observeCleanup<T>(discovery: CleanupDiscovery, ruleId: CleanupRule, api: string, fn: () => Promise<T>, resourceId?: string): Promise<T> {
  const observation: CleanupCoverage = { ruleId, api, resourceId, state: 'complete', attemptedAt: new Date().toISOString() };
  try {
    const result = await fn();
    observation.succeededAt = new Date().toISOString();
    return result;
  } catch (error) {
    observation.state = 'error';
    const name = error instanceof Error ? error.name : '';
    observation.errorCode = /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(name) ? name : 'LookupFailed';
    throw error;
  } finally { discovery.coverage.push(observation); }
}
