import type {CollectorReport, ResourceGraph, StatusBundle} from '@orrery/shared';
import type {CollectorOutput} from '../collectors/types.ts';
import {assembleGraph, applyAlarms} from './assemble.ts';
const STATUS_PROPS = ['상태 검사', '희망/실행 작업', '실행 작업', '정상/전체', '현재 인스턴스', '배포 상태'];
export function mergeStatus(graph: ResourceGraph, outputs: CollectorOutput[], reports: CollectorReport[]): StatusBundle {
  const fresh = assembleGraph(outputs.map((out) => ({ ...out, alarms: [] })), reports, { account: graph.account, region: graph.region, source: graph.source });
  const bundle: StatusBundle = { scope: { source: graph.source, account: graph.account, region: graph.region }, collectedAt: fresh.collectedAt, checked: 0, nodes: {}, edges: {}, durationMs: 0, reports };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const n of fresh.nodes) {
    const old = byId.get(n.id);
    if (!old) continue;
    bundle.checked++;
    const props: Record<string, string | number | boolean | null> = {};
    for (const k of STATUS_PROPS) if (k in n.props) props[k] = n.props[k];
    bundle.nodes[n.id] = { status: n.status, statusLabel: n.statusLabel, alarms: n.alarms, props };
    old.baseStatus = n.baseStatus ?? n.status;
    old.baseStatusLabel = n.baseStatusLabel;
    Object.assign(old.props, props);
  }
  const attemptedAt = bundle.collectedAt;
  const alarmReport = reports.find((r) => r.collector === 'alarms');
  if (alarmReport?.ok) {
    applyAlarms(byId, outputs.flatMap((out) => out.alarms ?? []));
    graph.alarmObservation = { attemptedAt, succeededAt: attemptedAt };
  } else {
    // Recompute only runtime status while preserving the last successful alarm snapshot.
    for (const n of graph.nodes) {
      if (n.alarms?.length) { n.status = 'critical'; n.statusLabel = `알람 ${n.alarms.length}건`; }
      else { n.status = n.baseStatus ?? n.status; n.statusLabel = n.baseStatusLabel ?? n.statusLabel; }
    }
    graph.alarmObservation = { attemptedAt, succeededAt: graph.alarmObservation?.succeededAt, error: alarmReport?.error ?? '경보 조회 결과 없음' };
  }
  const failures = reports.filter((r) => r.collector !== 'alarms' && !r.ok);
  graph.statusObservation = { attemptedAt, succeededAt: failures.length ? graph.statusObservation?.succeededAt : attemptedAt, error: failures.length ? failures.map((r) => `${r.collector}: ${r.error ?? '조회 실패'}`).join('; ') : undefined };
  bundle.statusObservation = graph.statusObservation;
  bundle.alarmObservation = graph.alarmObservation;
  for (const n of graph.nodes) {
    bundle.nodes[n.id] = { status: n.status, statusLabel: n.statusLabel, alarms: n.alarms ?? [], props: { ...(bundle.nodes[n.id]?.props ?? {}), 경보: n.props['경보'] ?? 0 } };
  }
  const oldEdges = new Map(graph.edges.map((e) => [e.id, e]));
  for (const e of fresh.edges) {
    const old = oldEdges.get(e.id);
    if (!old || !e.status) continue;
    bundle.edges[e.id] = e.status;
    old.status = e.status;
  }
  return bundle;
}

/** A failed full topology collection must not turn last-known ALARM into recovery. */
export function preserveAlarmSnapshot(graph: ResourceGraph, previous?: ResourceGraph): void {
  if (!previous || graph.account !== previous.account || graph.source !== previous.source || graph.region !== previous.region) return;
  const oldById = new Map(previous.nodes.map((n) => [n.id, n]));
  for (const node of graph.nodes) {
    const old = oldById.get(node.id);
    if (!old) continue;
    node.alarms = old.alarms ? [...old.alarms] : undefined;
    if (old.props['경보'] !== undefined) node.props['경보'] = old.props['경보'];
    if (node.alarms?.length) { node.status = 'critical'; node.statusLabel = `알람 ${node.alarms.length}건`; }
  }
  if (graph.alarmObservation) graph.alarmObservation.succeededAt = previous.alarmObservation?.succeededAt;
}
