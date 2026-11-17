import type { PipelineAction } from '@orrery/shared';
export function pipelineRunning(status?: string): boolean {
  return status === 'InProgress' || status === 'Stopping';
}
/** Do not collapse retries or parallel actions into a misleading stage success. */
export function stageStatuses(actions: PipelineAction[]): string {
  return [...new Set(actions.map(a => a.status))].join(' / ');
}
