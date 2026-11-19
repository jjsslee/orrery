import type { PipelineAction } from '@orrery/shared';
export function pipelineConsoleUrl(name: string, region: string): string {
  const domain = region.startsWith('cn-') ? 'console.amazonaws.cn' : 'console.aws.amazon.com';
  return `https://${domain}/codesuite/codepipeline/pipelines/${encodeURIComponent(name)}/view?region=${encodeURIComponent(region)}`;
}
export function approvalConsoleUrl(actions: PipelineAction[], name: string, region: string): string | undefined {
  return latestActions(actions).some(a => a.category === 'Approval' && a.status === 'InProgress') ? pipelineConsoleUrl(name, region) : undefined;
}
export function pipelineRunning(status?: string): boolean {
  return status === 'InProgress' || status === 'Stopping';
}
/** Do not collapse retries or parallel actions into a misleading stage success. */
export function stageStatuses(actions: PipelineAction[]): string {
  return [...new Set(actions.map(a => a.status))].join(' / ');
}

export type PipelineTone = 'success' | 'running' | 'failed' | 'waiting' | 'idle';
export function latestActions(actions: PipelineAction[]): PipelineAction[] {
  const latest = new Map<string, PipelineAction>();
  for (const action of actions) {
    const key = JSON.stringify([action.stage, action.name]);
    const prior = latest.get(key);
    if (!prior || Date.parse(action.startedAt ?? action.updatedAt ?? '') > Date.parse(prior.startedAt ?? prior.updatedAt ?? '') || !prior.startedAt) latest.set(key, action);
  }
  return [...latest.values()];
}
export function actionTone(status?: string, approval = false): PipelineTone {
  if (status === 'Failed') return 'failed';
  if (pipelineRunning(status)) return approval ? 'waiting' : 'running';
  return status === 'Succeeded' ? 'success' : 'idle';
}
export function stageTone(actions: PipelineAction[], expected?: number): PipelineTone {
  const current = latestActions(actions);
  if (current.some(a => a.status === 'Failed')) return 'failed';
  if (current.some(a => pipelineRunning(a.status) && a.category === 'Approval')) return 'waiting';
  if (current.some(a => pipelineRunning(a.status))) return 'running';
  if (current.length && (expected === undefined || current.length === expected) && current.every(a => a.status === 'Succeeded')) return 'success';
  return 'idle';
}
export function selectionKey(profile: string, account: string, region: string): string {
  return `orrery.pipelines.v1:${JSON.stringify([profile, account, region])}`;
}
export function readPipelineSelection(storage: Pick<Storage, 'getItem'>, key: string): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((name): name is string => typeof name === 'string' && /^[A-Za-z0-9.@_-]{1,100}$/.test(name)))] : [];
  } catch { return []; }
}
export function savePipelineSelection(storage: Pick<Storage, 'setItem'>, key: string, names: string[]): boolean {
  try { storage.setItem(key, JSON.stringify(names)); return true; } catch { return false; }
}
export async function pipelinePool<T>(items: T[], signal: AbortSignal, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
    while (!signal.aborted && next < items.length) await work(items[next++]);
  }));
}

export function pipelineMatches(name: string, tags: { key: string; value: string }[] | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || name.toLowerCase().includes(needle) || (tags ?? []).some(({ key, value }) =>
    [key, value, `${key}=${value}`].some(text => text.toLowerCase().includes(needle)));
}
export function selectPipelineResults(selected: string[], results: string[], checked: boolean): string[] {
  const matching = new Set(results);
  return checked ? [...new Set([...selected, ...results])] : selected.filter(name => !matching.has(name));
}
