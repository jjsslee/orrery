import type { MonitoringMetricSeries, MonitoringResource, MonitoringResourceType } from '@orrery/shared';
import { matchesTags, sameTagFilter, type TagFilter } from './tags';

export const MONITORING_RESOURCE_TYPES: Array<[MonitoringResourceType, string]> = [['lambda', 'Lambda'], ['sqs-queue', 'SQS'], ['load-balancer', 'ALB'], ['ecs-service', 'ECS'], ['ec2-instance', 'EC2'], ['rds-instance', 'RDS']];
export interface ResourceFilters { query: string; tags: TagFilter[]; tagStatus: 'all' | 'untagged' | 'unavailable' }
export const emptyResourceFilters = (): ResourceFilters => ({ query: '', tags: [], tagStatus: 'all' });

export function filterMonitoringResources(resources: MonitoringResource[], filters: ResourceFilters): MonitoringResource[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return resources.filter((resource) => {
    if (query && !`${resource.name} ${resource.nativeId} ${resource.type} ${Object.entries(resource.tags ?? {}).flat().join(' ')}`.toLocaleLowerCase().includes(query)) return false;
    if (filters.tagStatus === 'unavailable' && resource.tagsStatus !== 'unavailable') return false;
    if (filters.tagStatus === 'untagged' && (resource.tagsStatus !== 'complete' || Object.keys(resource.tags ?? {}).length > 0)) return false;
    // These modes find extra manual candidates without discarding the saved tag conditions.
    if (filters.tagStatus !== 'all') return true;
    return !filters.tags.length || (resource.tagsStatus === 'complete' && matchesTags({ tags: resource.tags } as Parameters<typeof matchesTags>[0], filters.tags));
  });
}
export function appendResourceTag(filters: TagFilter[], filter: TagFilter): TagFilter[] {
  return filters.some((existing) => sameTagFilter(existing, filter)) ? filters : [...filters, filter];
}
export function metricNeedsAttention(series: MonitoringMetricSeries): boolean {
  return ['error', 'partial', 'empty'].includes(series.status ?? '') || Boolean(series.lastDataAt && series.endTime && series.period && Date.parse(series.endTime) - Date.parse(series.lastDataAt) > series.period * 2000);
}
