import { useEffect, useRef, useState } from 'react';
import { Activity, ArrowUpRight, Clock, LineChart, RefreshCw, Table } from 'lucide-react';
import { useMonitoring, type TimeRange } from '../model/monitoring';
import { Sparkline } from '../components/Sparkline';
import { fmtDateTime, fmtNumber } from '../components/format';
import { TYPE_META } from '../model/types';
import { TypeIcon } from '../components/TypeIcon';
import { MonitoringResourceAlarms } from './MonitoringAlarmDetail';

export function MonitoringMetrics() {
  const m = useMonitoring();
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [tableView, setTableView] = useState(false);
  const chartHost = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => { const host = chartHost.current; if (!host) return; const observer = new ResizeObserver(([entry]) => setWidth(Math.max(180, Math.floor(entry.contentRect.width)))); observer.observe(host); return () => observer.disconnect(); }, []);
  const selectRange = (start: number, end: number) => {
    const local = (time: number) => { const date = new Date(time); return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
    useMonitoring.setState({ customStart: local(start), customEnd: local(end) }); m.setRange('custom');
  };
  const domain = m.metrics ? { start: Date.parse(m.metrics.range.startTime), end: Date.parse(m.metrics.range.endTime) } : undefined;
  const valueDomains = new Map<string, { min: number; max: number }>();
  for (const list of Object.values(m.metrics?.series ?? {})) for (const series of list) {
    const key = `${series.id}:${series.unit}:${series.stat}`;
    const valueDomain = valueDomains.get(key) ?? { min: 0, max: 0 };
    for (const point of series.points) if (point.v != null && Number.isFinite(point.v)) { valueDomain.min = Math.min(valueDomain.min, point.v); valueDomain.max = Math.max(valueDomain.max, point.v); }
    valueDomains.set(key, valueDomain);
  }
  const columns = width >= 700 ? 2 : 1;
  const chartWidth = Math.max(150, Math.floor((width - 34 - (columns - 1) * 14) / columns) - 26);
  const selected = m.selectedResources.map((key) => ({ key, resource: m.resources?.resources.find((resource) => resource.key === key) }));
  const hasSupportedSelection = selected.some(({ resource }) => resource && resource.metricsSupported !== false);
  return <section className="mw-observations" aria-label="선택 자원의 CloudWatch">
    <header className="mw-observation-heading"><div><span className="mw-eyebrow">OBSERVE TOGETHER</span><h2>CloudWatch <span>{selected.length}개 자원</span></h2></div><button type="button" className="icon-btn" aria-label={tableView ? '차트 보기' : '값 표 보기'} onClick={() => setTableView(!tableView)}>{tableView ? <LineChart size={16} /> : <Table size={16} />}</button></header>
    <div className="mw-time-toolbar">
      <label><Clock size={13} /><span className="sr-only">관측 기간</span><select aria-label="관측 기간" value={m.range} onChange={(e) => m.setRange(e.target.value as TimeRange)}><option value="1h">최근 1시간</option><option value="3h">최근 3시간</option><option value="24h">최근 24시간</option><option value="7d">최근 7일</option><option value="custom">직접 선택</option></select></label>
      <label className="mw-auto-refresh"><input type="checkbox" checked={m.autoRefresh !== 0} disabled={!m.autoRefresh && (m.range === 'custom' || !hasSupportedSelection)} onChange={(e) => useMonitoring.setState({ autoRefresh: e.target.checked ? 300000 : 0 })} />자동 갱신</label>
      {m.autoRefresh !== 0 && <select aria-label="자동 갱신 간격" value={m.autoRefresh} onChange={(e) => useMonitoring.setState({ autoRefresh: Number(e.target.value) as 60000 | 300000 })}><option value={300000}>5분</option><option value={60000}>1분</option></select>}
      <button type="button" className="btn" disabled={!hasSupportedSelection || m.metricsLoading} onClick={() => { void m.loadMetrics(true); void m.loadAlarms(true); }}><RefreshCw size={13} className={m.metricsLoading ? 'spin' : ''} />다시 조회</button>
    </div>
    {m.range === 'custom' && <div className="mw-custom-time"><label>시작<input type="datetime-local" value={m.customStart} onChange={(e) => m.setCustomTime('customStart', e.target.value)} /></label><label>종료<input type="datetime-local" value={m.customEnd} onChange={(e) => m.setCustomTime('customEnd', e.target.value)} /></label></div>}
    <p className="mw-query-note">선택·기간 변경 시 지표를 자동 조회하며 비용이 발생할 수 있습니다. 최대 4개 자원·100개 지표 쿼리, SDK 명령 10회 이내(재시도 별도).</p>
    {m.autoRefresh !== 0 && <p className="mw-subtle">화면이 보일 때만 갱신합니다. 일시 오류는 최대 20분 간격으로 늦추며, 인증·권한 오류는 중지합니다.</p>}
    {m.range === 'custom' && <p className="mw-subtle">고정된 과거 기간은 자동 갱신하지 않습니다.</p>}
    {m.metricsError && <p role="alert" className="monitor-notice">지표 조회 문제 · 이전 값이 포함될 수 있습니다: {m.metricsError}</p>}
    {m.metrics && <p className="mw-last-fetch">조회 {fmtDateTime(m.metrics.collectedAt)} · {m.metrics.queryCount}개 쿼리 · {m.metrics.requestCount}회 SDK 명령</p>}
    <div ref={chartHost} className="mw-resource-observations">
      {!selected.length && <div className="mw-observe-empty"><div><Activity size={30} /></div><h3>관측할 자원을 추가하세요</h3><p>왼쪽에서 이름이나 태그로 자원을 찾으면<br />지표와 관련 경보를 바로 확인할 수 있습니다.</p><small>관련 자원 후보는 오른쪽에 나타나며 직접 고른 자원만 추가됩니다.</small></div>}
      {selected.map(({ key, resource }) => <article key={key} className={`mw-observed-resource ${m.referenceResource === key ? 'is-reference' : ''}`} aria-label={`${resource?.name ?? '찾을 수 없음'} CloudWatch`}>
        <header className="mw-observed-resource-head"><div>{resource && <TypeIcon type={resource.type} size={20} />}<div><h3>{resource?.name ?? '찾을 수 없음'}</h3><small>{resource ? `${TYPE_META[resource.type].label} · ${resource.region}` : '선택한 자원을 현재 목록에서 확인할 수 없습니다.'}</small></div></div>{resource && <button type="button" className="mw-reference-action" aria-label={`${resource.name} 관련 자원 보기`} aria-pressed={m.referenceResource === key} onClick={() => m.setReferenceResource(key)}>{m.referenceResource === key ? '기준 자원' : '관련 자원'}<ArrowUpRight size={13} /></button>}</header>
        <MonitoringResourceAlarms resourceKey={key} />
        {resource?.metricsSupported === false ? <p className="mw-subtle mw-unsupported">{resource.metricsUnsupportedReason ?? '이 자원 유형의 추천 지표는 제공되지 않습니다.'} 관련 경보와 연결은 확인할 수 있습니다.</p> : <>
          {m.metricsLoading && !m.metrics?.series[key]?.length && <p className="mw-loading" role="status"><RefreshCw size={14} className="spin" />지표를 불러오는 중</p>}
          {m.metrics && !m.metricsLoading && !m.metrics.series[key]?.length && <p className="mw-subtle">지원 지표가 없거나 결과가 반환되지 않았습니다. 조회 범위와 권한을 확인하세요.</p>}
          <div className="mw-metric-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{m.metrics?.series[key]?.map((series) => <section className={`mw-metric quality-${series.status ?? 'complete'}`} key={series.id} aria-label={`${resource?.name ?? key} ${series.label}`}>
            <div className="mw-metric-heading"><h4>{series.label}</h4><strong>{fmtNumber(series.latest, series.unit)}</strong></div><p className="mw-metric-meta">{series.stat} · {series.unit} · {series.period ? `${series.period >= 86400 ? `${series.period / 86400}일` : `${series.period / 60}분`} 집계` : '주기 미제공'} · {series.region ?? m.region}</p>
            <p className="mw-metric-quality">{series.status === 'error' ? '조회 실패' : series.status === 'partial' ? '부분 결과' : series.status === 'empty' ? '데이터 없음' : '조회 완료'} · 최신 데이터 {fmtDateTime(series.lastDataAt) || '없음'}{series.lastDataAt && series.endTime && series.period && Date.parse(series.endTime) - Date.parse(series.lastDataAt) > series.period * 2000 ? ' · 값 지연' : ''}</p>
            {!!series.messages?.length && <p role="status" className="monitor-notice">{series.messages.join(' / ')}</p>}
            {tableView ? <div className="monitor-table-scroll"><table className="metric-table"><thead><tr><th>시각</th><th>{series.label} ({series.unit})</th></tr></thead><tbody>{series.points.map((point) => <tr key={point.t}><td>{fmtDateTime(point.t)}</td><td>{fmtNumber(point.v, series.unit)}</td></tr>)}</tbody></table></div> : <><Sparkline series={series} width={chartWidth} height={88} timeDomain={domain} valueDomain={valueDomains.get(`${series.id}:${series.unit}:${series.stat}`)} hoverTime={hoverTime} onHoverTime={setHoverTime} onSelectRange={selectRange} /><div className="mw-value-scale">{fmtNumber(valueDomains.get(`${series.id}:${series.unit}:${series.stat}`)?.min, series.unit)} ~ {fmtNumber(valueDomains.get(`${series.id}:${series.unit}:${series.stat}`)?.max, series.unit)}</div><div className="monitor-time-axis"><span>{fmtDateTime(domain?.start)}</span><span>{fmtDateTime(domain?.end)}</span></div></>}
            <details className="mw-effective-range"><summary>실제 조회 기간</summary>{fmtDateTime(series.startTime)} ~ {fmtDateTime(series.endTime)}</details>
          </section>)}</div>
        </>}
      </article>)}
    </div>
  </section>;
}
