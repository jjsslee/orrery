import { uiText, useLanguage } from '../i18n';
import { useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, Bell, Copy, Check, Table as TableIcon, LineChart, LocateFixed, X } from 'lucide-react';
import type { EdgeKind, ResourceNode, ResourceEdge } from '@orrery/shared';
import { MONITORING_RESOURCE_TYPES, STATUS_LABEL } from '@orrery/shared';
import { useStore } from '../model/store';
import { useMonitoring } from '../model/monitoring';
import { EDGE_KIND_LABEL, TYPE_META } from '../model/types';
import { TypeIcon } from '../components/TypeIcon';
import { StatusDot } from '../components/StatusDot';
import { Sparkline } from '../components/Sparkline';
import { fmtDateTime, fmtNumber, fmtProp } from '../components/format';

export function Inspector() {
  useLanguage();
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedId);
  const metrics = useStore((s) => s.metrics);
  const metricsError = useStore((s) => s.metricsError);
  const metricsLoading = useStore((s) => s.metricsLoading);
  const select = useStore((s) => s.select);
  const addTagFilter = useStore((s) => s.addTagFilter);
  const locate = useStore((s) => s.locate);
  const [copyResult, setCopyResult] = useState<{ id: string; state: 'copied' | 'failed' }>();
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
  const monitoringType = MONITORING_RESOURCE_TYPES.find(([type]) => type === node.type)?.[0];
  const openMonitoring = () => {
    if (!monitoringType || !graph) return;
    const { profile, region, setView } = useStore.getState();
    useMonitoring.setState({ pendingResource: { profile, region, account: graph.account, type: monitoringType, nativeId: node.nativeId } });
    setView('monitoring');
  };
  const series = metrics?.series[node.id] ?? [];
  const traffic = metrics?.traffic[node.id];
  const props = Object.entries(node.props).filter(([k, v]) => !k.startsWith('_') && v !== null && v !== '');
  const grouped = new Map<EdgeKind, typeof relations>();
  for (const r of relations) grouped.set(r.edge.kind, [...(grouped.get(r.edge.kind) ?? []), r]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(node.arn ?? node.nativeId);
      const result = { id: node.id, state: 'copied' as const };
      setCopyResult(result);
      setTimeout(() => setCopyResult((current) => current === result ? undefined : current), 1200);
    } catch { setCopyResult({ id: node.id, state: 'failed' }); }
  };

  return (
    <aside className="inspector" aria-label={uiText("자원 상세")}>
      <header className={`insp-head cat-${node.category}`}>
        <div className="insp-icon"><TypeIcon type={node.type} size={18} /></div>
        <div className="insp-title">
          <div className="insp-name" title={node.name}>{node.name}</div>
          <div className="insp-type">{uiText(meta.label ?? '')}{node.az ? ` · ${node.az}` : ''}</div>
        </div>
        <button type="button" className="icon-btn" onClick={() => select(undefined)} aria-label={uiText("닫기")}><X size={15} /></button>
      </header>

      <div className="insp-body">
        <div className="insp-status">
          <StatusDot status={node.status} showLabel label={node.statusLabel ? `${uiText(STATUS_LABEL[node.status] ?? '')} · ${node.statusLabel}` : undefined} size={9} />
          {traffic != null && <span className="insp-traffic" title={uiText("같은 유형 자원 대비 상대 처리량")}><span className="insp-traffic-bar"><span style={{ width: `${traffic * 100}%` }} /></span>{uiText("자원 활동 ")}{(traffic * 100).toFixed(0)}%</span>}
        </div>

        <button type="button" className="insp-id mono" onClick={copy} title={uiText("클릭해서 복사")} aria-label={uiText("ARN 또는 자원 ID 복사")}>
          <span>{node.arn ?? node.nativeId}</span>
          {copyResult?.id === node.id && copyResult.state === 'copied' ? <Check size={13} /> : <Copy size={13} />}
        </button>

        {copyResult?.id === node.id && <div role="status" className="muted">{copyResult.state === 'copied' ? uiText('복사했습니다.') : uiText('복사하지 못했습니다. 클립보드 권한을 확인하거나 다시 시도해 주세요.')}</div>}

        <section className="insp-section">
          <button type="button" className="btn" disabled={!monitoringType} onClick={openMonitoring}><LineChart size={14} /> {uiText(" 모니터링")}</button>
          <p className="muted">{monitoringType ? uiText('이 자원의 CloudWatch 지표를 조회합니다. 조회 비용이 발생할 수 있습니다.') : uiText('이 자원 유형은 CloudWatch 지표를 아직 지원하지 않습니다.')}</p>
        </section>

        {node.alarms && node.alarms.length > 0 && (
          <section className="insp-section insp-alarms">
            <h3><Bell size={13} /> {uiText(" 경보 중")}</h3>
            <ul>{node.alarms.map((a) => <li key={a}>{a}</li>)}</ul>
          </section>
        )}

        {(series.length > 0 || metricsLoading || uiText(metricsError ?? '')) && (
          <section className="insp-section">
            <div className="insp-section-head">
              <h3>{uiText("CloudWatch 지표")}</h3>
              {series.length > 0 && (
                <button type="button" className="link-btn" onClick={() => setTableView((v) => !v)} aria-pressed={tableView}>
                  {tableView ? <><LineChart size={12} /> {uiText(" 차트")}</> : <><TableIcon size={12} /> {uiText(" 표")}</>}
                </button>
              )}
            </div>
            {uiText(metricsError ?? '') && <div role="status" className="muted">{uiText(metricsError ?? '')}</div>}
            {metrics?.collectedAt && <div className="muted">{uiText("조회 ")}{fmtDateTime(metrics.collectedAt)}</div>}
            {series.length === 0 && metricsLoading && <div className="muted">{uiText("지표를 불러오는 중")}</div>}
            {tableView ? (
              <table className="metric-table">
                <thead><tr><th>{uiText("시각")}</th>{series.map((s) => <th key={s.name}>{uiText(s.label ?? '')}</th>)}</tr></thead>
                <tbody>
                  {[...new Set(series.flatMap((s) => s.points.map((p) => p.t)))].sort((a, b) => a - b).slice(-12).map((t) => (
                    <tr key={t}><td>{fmtDateTime(t)}</td>{series.map((s) => <td key={s.name} className="tnum">{fmtNumber(s.points.find((p) => p.t === t)?.v, s.unit)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            ) : (
              series.map((s) => (
                <div className="metric" key={s.name}>
                  <div className="metric-head"><span className="metric-label">{uiText(s.label ?? '')}</span><span className="metric-value tnum">{fmtNumber(s.latest, s.unit)}</span></div>
                  <div className="muted">
                    {s.startTime && s.endTime && <span>{fmtDateTime(s.startTime)} ~ {fmtDateTime(s.endTime)} · </span>}
                    {s.period && <span>{s.period >= 86400 ? uiText`${s.period / 86400}일` : uiText`${s.period / 60}분`} {uiText(" 집계 · ")}</span>}
                    {s.status === 'error' ? uiText('조회 실패') : s.status === 'partial' ? uiText('부분 결과') : s.status === 'empty' ? uiText('데이터 없음') : uiText('조회 완료')}
                    {s.lastDataAt && <span> {uiText(" · 최신 값 ")}{fmtDateTime(s.lastDataAt)}</span>}
                    {s.messages?.length ? <span role="status"> · {s.messages.map(message=>uiText(message)).join(' / ')}</span> : null}
                  </div>
                  <Sparkline series={s} width={312} height={48} color={`var(--cat-${node.category})`} />
                </div>
              ))
            )}
          </section>
        )}

        <section className="insp-section">
          <h3>{uiText("속성")}</h3>
          <dl className="props">
            {parent && <><dt>{uiText("위치")}</dt><dd><button type="button" className="link-node" onClick={() => select(parent.id, { reveal: true })}><TypeIcon type={parent.type} size={12} />{parent.name}</button></dd></>}
            {props.map(([k, v]) => <div key={k} className="prop"><dt>{uiText(k)}</dt><dd className={typeof v === 'string' && /^[\w./:-]+$/.test(v) && v.length > 12 ? 'mono' : ''}>{fmtProp(v,k)}</dd></div>)}
          </dl>
        </section>

        {relations.length > 0 && (
          <section className="insp-section">
            <h3>{uiText("관계 ")}<span className="tnum muted">{relations.length}</span></h3>
            {[...grouped.entries()].map(([kind, list]) => (
              <div className="rel-group" key={kind}>
                <div className="rel-kind">{uiText(EDGE_KIND_LABEL[kind] ?? kind)}</div>
                <ul className="rel-list">
                  {list.slice(0, 40).map(({ edge, other, outgoing }) => (
                    <li key={edge.id}>
                      <div className="rel-row">
                        <button type="button" className="rel-item" onClick={() => select(other.id, { reveal: true })}>
                          {outgoing ? <ArrowRight size={12} className="rel-dir" /> : <ArrowLeft size={12} className="rel-dir" />}
                          <span className={`rel-icon cat-${other.category}`}><TypeIcon type={other.type} size={12} /></span>
                          <span className="rel-name" title={other.name}>{other.name}</span>
                          {edge.label && <span className="rel-label" title={edge.label}>{edge.label}</span>}
                          {edge.status && edge.status !== 'healthy' && <StatusDot status={edge.status} size={6} />}
                        </button>
                        <button type="button" className="rel-locate" title={uiText("지도에서 보기")} aria-label={uiText`${other.name} 지도에서 보기`} onClick={() => locate(other.id)}><LocateFixed size={12} /></button>
                      </div>
                    </li>
                  ))}
                  {list.length > 40 && <li className="muted">{uiText("외 ")}{list.length - 40}{uiText("개")}</li>}
                </ul>
              </div>
            ))}
          </section>
        )}

        {children.length > 0 && (
          <section className="insp-section">
            <h3>{uiText("포함 자원 ")}<span className="tnum muted">{children.length}</span></h3>
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
              {children.length > 60 && <li className="muted">{uiText("외 ")}{children.length - 60}{uiText("개")}</li>}
            </ul>
          </section>
        )}

        {node.tags && Object.keys(node.tags).length > 0 && (
          <section className="insp-section">
            <h3>{uiText("태그 ")}<span className="muted">{uiText("클릭하면 같은 태그의 자원만 봅니다")}</span></h3>
            <ul className="tag-list">
              {Object.entries(node.tags).map(([k, v]) => (
                <li key={k}>
                  <button type="button" className="tag-pill" onClick={() => addTagFilter({ key: k, value: v })} title={uiText`${k} = ${v} 태그로 필터`}>
                    <span className="tag-pill-key">{k}</span><span className="tag-pill-val">{v || uiText('(빈 값)')}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="insp-actions">
          <button type="button" className="btn" onClick={() => locate(node.id)}><LocateFixed size={14} /> {uiText(" 지도에서 보기")}</button>
        </div>
      </div>
    </aside>
  );
}
