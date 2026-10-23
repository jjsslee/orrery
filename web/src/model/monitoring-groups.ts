import type { MonitoringResource, MonitoringScope, SavedResourceGroup } from '@orrery/shared';
import { matchesTags } from './tags';

export const groupStorageKey = (scope: MonitoringScope) => `orrery.monitoring.groups.v1:${JSON.stringify([scope.source, scope.account, scope.region])}`;
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void }
export function readGroups(scope: MonitoringScope, storage?: StorageLike): SavedResourceGroup[] {
  try {
    const value: unknown = JSON.parse((storage ?? localStorage).getItem(groupStorageKey(scope)) ?? 'null');
    if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('groups' in value) || !Array.isArray(value.groups)) return [];
    return value.groups.filter((group): group is SavedResourceGroup => Boolean(group && typeof group.id === 'string' && typeof group.name === 'string' && Array.isArray(group.resourceKeys) && group.resourceKeys.every((key: unknown) => typeof key === 'string') && Array.isArray(group.tagFilters) && group.tagFilters.every((filter: { key?: unknown; value?: unknown }) => filter && typeof filter.key === 'string' && (filter.value === undefined || typeof filter.value === 'string'))));
  } catch { return []; }
}
export function writeGroups(scope: MonitoringScope, groups: SavedResourceGroup[], storage?: StorageLike): void {
  // Persist configuration only, never AWS snapshots or metric points.
  (storage ?? localStorage).setItem(groupStorageKey(scope), JSON.stringify({ version: 1, groups: groups.map(({ id, name, tagFilters, resourceKeys }) => ({ id, name, tagFilters, resourceKeys })) }));
}
export function groupResources(group: SavedResourceGroup, resources: MonitoringResource[]) {
  const manual = new Set(group.resourceKeys);
  return resources.filter((resource) => manual.has(resource.key) || (group.tagFilters.length > 0 && resource.tagsStatus === 'complete' && matchesTags({ tags: resource.tags } as Parameters<typeof matchesTags>[0], group.tagFilters)));
}

export function groupHasIncompleteCoverage(group: SavedResourceGroup, resources: MonitoringResource[], coverage: Partial<Record<string, { complete: boolean }>>): boolean {
  const known = new Set(resources.map((resource) => resource.key));
  if (group.resourceKeys.some((key) => !known.has(key))) return true;
  if (group.resourceKeys.some((key) => { try { return !coverage[JSON.parse(key)[2]]?.complete; } catch { return true; } })) return true;
  if (group.tagFilters.length) {
    const types = ['lambda', 'sqs-queue', 'load-balancer', 'ecs-service', 'ec2-instance', 'rds-instance'];
    return types.some((type) => !coverage[type]?.complete) || resources.some((resource) => resource.tagsStatus !== 'complete');
  }
  return false;
}
