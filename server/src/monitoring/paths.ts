import type { MonitoringPath, ResourceEdge, ResourceGraph } from '@orrery/shared';
import { graphResources } from './resources.ts';
const EXECUTION = new Set(['targets', 'origin', 'invokes', 'publishes']);
export type PathOptions = { depth: number; group: 'execution' | 'context'; offset?: number; revision?: string };
export function pathOptions(input: Record<string, string>): PathOptions {
  const depth = Number(input.depth ?? 1), offset = Number(input.offset ?? 0);
  if (!Number.isInteger(depth) || depth < 1 || depth > 3 || !Number.isInteger(offset) || offset < 0 || offset > 10000 || (offset > 0 && !input.revision) || (input.revision !== undefined && (typeof input.revision !== 'string' || input.revision.length > 256)) || (input.group && !['execution', 'context'].includes(input.group))) throw Object.assign(new Error('구성 탐색은 1~3단계와 지원하는 관계 그룹만 허용합니다.'), { statusCode: 400 });
  return { depth, offset, group: input.group === 'context' ? 'context' : 'execution', revision: input.revision };
}
export function buildMonitoringPath(graph: ResourceGraph, root: string, options: PathOptions): MonitoringPath {
  const revision = graph.revision ?? graph.collectedAt;
  if (options.revision && options.revision !== revision) throw Object.assign(new Error('구성이 갱신됐습니다. 경로를 다시 확인하세요.'), { statusCode: 409 });
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  const incoming = new Map<string, ResourceEdge[]>(), outgoing = new Map<string, ResourceEdge[]>();
  for (const edge of graph.edges) {
    if (edge.observation?.state !== 'current' || !edge.evidence?.some(e => e.method === 'configuration' || (options.group === 'context' && e.method === 'identifier'))) continue;
    if (options.group === 'execution' && edge.props?.weight === 0) continue;
    if (options.group === 'execution' && !EXECUTION.has(edge.kind) && edge.props?.role !== 'execution-host') continue;
    for (const [index, key] of [[incoming, edge.target], [outgoing, edge.source]] as const) { const list = index.get(key); if (list) list.push(edge); else index.set(key,[edge]); }
  }
  for (const list of [...incoming.values(), ...outgoing.values()]) list.sort((a,b) => a.id.localeCompare(b.id));
  const candidates = new Map<string, ResourceEdge>();
  const queue: Array<{id:string; depth:number; direction:'in'|'out'}> = [{ id:root, depth:0, direction:'in' }, { id:root, depth:0, direction:'out' }];
  const seen = new Set<string>(); let truncated = false;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i], key = `${item.direction}:${item.id}`;
    if (seen.has(key) || item.depth >= options.depth) continue;
    seen.add(key);
    if (byId.get(item.id)?.type === 'configuration-target' || byId.get(item.id)?.type === 'ip-target') continue;
    // Context exploration exposes one owner's neighbors, never fans out through policy/VPC hubs.
    if (options.group === 'context' && item.depth > 0) continue;
    for (const e of (item.direction === 'in' ? incoming : outgoing).get(item.id) ?? []) {
      const next = item.direction === 'in' ? e.source : e.target;
      if (!byId.has(next)) continue;
      if (candidates.size >= 10000) { truncated = true; continue; }
      candidates.set(e.id,e);
      if (e.props?.role !== 'execution-host') queue.push({id:next,depth:item.depth+1,direction:item.direction});
    }
  }
  const ids = new Set([root]), chosen: ResourceEdge[] = [];
  const all = [...candidates.values()]; let cursor = options.offset ?? 0;
  for (; cursor < all.length; cursor++) {
    const edge = all[cursor];
    const extra = [edge.source,edge.target].filter(id => !ids.has(id));
    if (ids.size + extra.length > 60 || chosen.length >= 120) break;
    ids.add(edge.source); ids.add(edge.target); chosen.push(edge);
  }
  const nextOffset = cursor < all.length ? cursor : undefined;
  return { offset:options.offset ?? 0, nextOffset, revision, depth:options.depth, nodes:graphResources(graph).filter(n => ids.has(n.nodeId)), edges:chosen, truncated:truncated || nextOffset !== undefined };
}
