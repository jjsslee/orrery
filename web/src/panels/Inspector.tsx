import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Bell, Copy, Check, Table as TableIcon, LineChart, X } from 'lucide-react';
import type { EdgeKind, ResourceNode, ResourceEdge } from '@orrery/shared';
import { STATUS_LABEL } from '@orrery/shared';
import { useStore } from '../model/store';
import { EDGE_KIND_LABEL, TYPE_META } from '../model/types';
import { TypeIcon } from '../components/TypeIcon';
import { StatusDot } from '../components/StatusDot';
import { Sparkline } from '../components/Sparkline';
import { fmtDateTime, fmtNumber, fmtProp } from '../components/format';

export function Inspector() {
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedId);
  const metrics = useStore((s) => s.metrics);
  const metricsLoading = useStore((s) => s.metricsLoading);
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);
  const [copied, setCopied] = useState(false);
  const [tableView, setTableView] = useState(false);

  const node = useMemo(() => graph?.nodes.find((n) => n.id === selectedId), [graph, selectedId]);
  const byId = useMemo(() => new Map(graph?.nodes.map((n) => [n.id, n])), [graph]);
  const relations = useMemo(() => {
    if (!graph || !node) return [];
    const out: Array<{ edge: ResourceEdge; other: ResourceNode; outgoing: boolean }> = [];
    for (const e of graph.edges) {
      if (e.source === node.id) { const o = byId.get(e.target); if (o) out.push({ edge: e, other: o, outgoing: true }); }
      else if (e.target === node.id) { const o = byId.get(e.source); if (o) out.push({ edge: e, other: o, outgoing: false }); }
    }
    return out;
  }, [graph, node, byId]);
  const parent = node?.parentId ? byId.get(node.parentId) : undefined;
  const children = useMemo(() => (node ? (graph?.nodes.filter((n) => n.parentId === node.id) ?? []) : []), [graph, node]);

  if (!node) return null;
  const meta = TYPE_META[node.type];
  const series = metrics?.series[node.id] ?? [];
  const traffic = metrics?.traffic[node.id];
  const props = Object.entries(node.props).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== '');
  const grouped = new Map<EdgeKind, typeof relations>();
  for (const r of relations) grouped.set(r.edge.kind, [...(grouped.get(r.edge.kind) ?? []), r]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(node.arn ?? node.nativeId); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { /* ignore */ }
  };

  return (
    <aside className="inspector" aria-label="자원 상세">
      <header className={`insp-head cat-${node.category}`}>
        <div className="insp-icon"><TypeIcon type={node.type} size={18} /></div>
        <div className="insp-title">
          <div className="insp-name" title={node.name}>{node.name}</div>
          <div className="insp-type">{meta.label}{node.az ? ` · ${node.az}` : ''}</div>
        </div>
        <button type="button" className="icon-btn" onClick={() => select(undefined)} aria-label="닫기"><X size={15} /></button>
      </header>

      <div className="insp-body">
        <div className="insp-status">
          <StatusDot status={node.status} showLabel label={node.statusLabel ? `${STATUS_LABEL[node.status]} · ${node.statusLabel}` : undefined} size={9} />
          {traffic != null && <span className="insp-traffic" title="같은 유형 자원 대비 상대 처리량"><span className="insp-traffic-bar"><span style={{ width: `${traffic * 100}%` }} /></span>트래픽 {(traffic * 100).toFixed(0)}%</span>}
        </div>

        <button type="button" className="insp-id mono" onClick={copy} title="클릭해서 복사">
          <span>{node.arn ?? node.nativeId}</span>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>

        {node.alarms && node.alarms.length > 0 && (
          <section className="insp-section insp-alarms">
            <h3><Bell size={13} /> 경보 중</h3>
            <ul>{node.alarms.map((a) => <li key={a}>{a}</li>)}</ul>
          </section>
        )}

        {(series.length > 0 || metricsLoading) && (
          <section className="insp-section">
            <div className="insp-section-head">
              <h3>최근 3시간</h3>
              {series.length > 0 && (
                <button type="button" className="link-btn" onClick={() => setTableView((v) => !v)} aria-pressed={tableView}>
                  {tableView ? <><LineChart size={12} /> 차트</> : <><TableIcon size={12} /> 표</>}
                </button>
              )}
            </div>
            {series.length === 0 && metricsLoading && <div className="muted">지표를 불러오는 중</div>}
            {tableView ? (
              <table className="metric-table">
                <thead><tr><th>시각</th>{series.map((s) => <th key={s.name}>{s.label}</th>)}</tr></thead>
                <tbody>
                  {[...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b).slice(-12).map((t) => (
                    <tr key={t}><td>{fmtDateTime(t)}</td>{series.map((s) => <td key={s.name} className="tnum">{fmtNumber(s.points.find((p) => p.t === t)?.v, s.unit)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            ) : (
              series.map((s) => (
                <div className="metric" key={s.name}>
                  <div className="metric-head"><span className="metric-label">{s.label}</span><span className="metric-value tnum">{fmtNumber(s.latest, s.unit)}</span></div>
                  <Sparkline series={s} width={312} height={48} color={`var(--cat-${node.category})`} />
                </div>
              ))
            )}
          </section>
        )}

        <section className="insp-section">
          <h3>속성</h3>
          <dl className="props">
            {parent && <><dt>위치</dt><dd><button type="button" className="link-node" onClick={() => select(parent.id, { reveal: true })}><TypeIcon type={parent.type} size={12} />{parent.name}</button></dd></>}
            {props.map(([k, v]) => <div key={k} className="prop"><dt>{k}</dt><dd className={typeof v === 'string' && /^[\w./:-]+$/.test(v) && v.length > 12 ? 'mono' : ''}>{fmtProp(v)}</dd></div>)}
          </dl>
        </section>

        {relations.length > 0 && (
          <section className="insp-section">
            <h3>관계 <span className="tnum muted">{relations.length}</span></h3>
            {[...grouped.entries()].map(([kind, list]) => (
              <div className="rel-group" key={kind}>
                <div className="rel-kind">{EDGE_KIND_LABEL[kind] ?? kind}</div>
                <ul className="rel-list">
                  {list.slice(0, 40).map(({ edge, other, outgoing }) => (
                    <li key={edge.id}>
                      <button type="button" className="rel-item" onClick={() => select(other.id, { reveal: true })}>
                        {outgoing ? <ArrowRight size={12} className="rel-dir" /> : <ArrowLeft size={12} className="rel-dir" />}
                        <span className={`rel-icon cat-${other.category}`}><TypeIcon type={other.type} size={12} /></span>
                        <span className="rel-name" title={other.name}>{other.name}</span>
                        {edge.label && <span className="rel-label">{edge.label}</span>}
                        {edge.status && edge.status !== 'healthy' && <StatusDot status={edge.status} size={6} />}
                      </button>
                    </li>
                  ))}
                  {list.length > 40 && <li className="muted">외 {list.length - 40}개</li>}
                </ul>
              </div>
            ))}
          </section>
        )}

        {children.length > 0 && (
          <section className="insp-section">
            <h3>포함 자원 <span className="tnum muted">{children.length}</span></h3>
            <ul className="rel-list">
              {children.slice(0, 60).map((c) => (
                <li key={c.id}>
                  <button type="button" className="rel-item" onClick={() => select(c.id, { reveal: true })}>
                    <span className={`rel-icon cat-${c.category}`}><TypeIcon type={c.type} size={12} /></span>
                    <span className="rel-name" title={c.name}>{c.name}</span>
                    <StatusDot status={c.status} size={6} />
                  </button>
                </li>
              ))}
              {children.length > 60 && <li className="muted">외 {children.length - 60}개</li>}
            </ul>
          </section>
        )}

        {node.tags && Object.keys(node.tags).length > 0 && (
          <section className="insp-section">
            <h3>태그</h3>
            <dl className="props">{Object.entries(node.tags).map(([k, v]) => <div key={k} className="prop"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
          </section>
        )}

        <div className="insp-actions">
          <button type="button" className="btn" onClick={() => { setView('topology'); select(node.id, { reveal: true }); }}>토폴로지에서 보기</button>
        </div>
      </div>
    </aside>
  );
}
