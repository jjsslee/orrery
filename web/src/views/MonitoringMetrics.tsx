import type { MonitoringMetricSeries } from '@orrery/shared';
import { useEffect, useRef, useState } from 'react';
import { useMonitoring } from '../model/monitoring';
import { Sparkline } from '../components/Sparkline';
import { fmtDateTime, fmtNumber } from '../components/format';
import { metricNeedsAttention } from '../model/monitoring-resources';
import { Activity, Filter, Search } from 'lucide-react';

export function MonitoringMetrics() {
  const m = useMonitoring();
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const [tableView, setTableView] = useState(false);
  const [problemOnly, setProblemOnly] = useState(false);
  const [metricQuery, setMetricQuery] = useState('');
  const chartHost = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(500);
  useEffect(() => { const host = chartHost.current; if (!host) return; const observer = new ResizeObserver(([entry]) => setWidth(Math.max(180, Math.floor(entry.contentRect.width)))); observer.observe(host); return () => observer.disconnect(); }, []);
  const selectRange = (start: number, end: number) => {
    const local = (time: number) => { const date = new Date(time); return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
    useMonitoring.setState({ customStart: local(start), customEnd: local(end) }); m.setRange('custom');
  };
  const domain = m.metrics ? { start: Date.parse(m.metrics.range.startTime), end: Date.parse(m.metrics.range.endTime) } : undefined;
  const valueDomains = new Map<string, { min: number; max: number }>();
  for (const list of Object.values(m.metrics?.series ?? {})) for (const series of list) {
    const key = `${series.id}:${series.unit}:${series.stat}`;
    const domain = valueDomains.get(key) ?? { min: 0, max: 0 };
    for (const point of series.points) if (point.v != null && Number.isFinite(point.v)) { domain.min = Math.min(domain.min, point.v); domain.max = Math.max(domain.max, point.v); }
    valueDomains.set(key, domain);
  }
  const matchesSeries = (series: MonitoringMetricSeries) => (!problemOnly || metricNeedsAttention(series)) && `${series.label} ${series.name}`.toLocaleLowerCase().includes(metricQuery.trim().toLocaleLowerCase());
  const columns = width >= 900 ? 2 : 1;
  const chartWidth = Math.max(160, Math.floor((width - (columns - 1) * 16) / columns) - 30);
  const selected = m.selectedResources.map((key) => ({ key, resource: m.resources?.resources.find((r) => r.key === key) }));
  return <section className="monitor-card monitor-metrics">
    <h2><Activity size={18} /> 지표 비교</h2><p className="muted">자원 찾기에서 최대 4개를 선택하세요. 지표별 Y축과 단위를 따로 표시하고 같은 시간축·커서를 사용합니다.</p>
    <div className="monitor-selected">{selected.map(({ key, resource }) => <button type="button" className="btn" key={key} onClick={() => m.toggleResource(key)}>{resource?.name ?? '찾을 수 없음'} · 제거</button>)}</div>
    <p className="muted">유료 조회 가능 · 선택 자원 {selected.length}개 · 현재 선택 기간 · 한 조회 최대 100개 지표 쿼리 / SDK 명령 최대 10회(재시도 별도). 자동 갱신은 기본 꺼짐입니다.</p>
    <div className="monitor-controls">
      <label><input type="checkbox" checked={m.autoRefresh !== 0} disabled={!m.autoRefresh && (m.range === 'custom' || !selected.length)} onChange={(e) => useMonitoring.setState({ autoRefresh: e.target.checked ? 300000 : 0 })} /> 자동 갱신</label>
      <label>간격 <select value={m.autoRefresh || 300000} disabled={!m.autoRefresh} onChange={(e) => useMonitoring.setState({ autoRefresh: Number(e.target.value) as 60000 | 300000 })}><option value={300000}>5분</option><option value={60000}>1분</option></select></label>
      <span className="muted">이 지표 화면·보이는 탭에서만 조회합니다. 오류 시 최대 20분 간격으로 늦춥니다. 고정된 과거 기간은 자동 갱신하지 않습니다.</span>
    </div>
    <div className="monitor-controls"><button type="button" className="btn primary" disabled={m.metricsLoading || !selected.length} onClick={() => void m.loadMetrics(true)}>{m.metricsLoading ? '지표 조회 중' : '선택 지표 조회'}</button><button type="button" className="btn" aria-pressed={tableView} onClick={() => setTableView(!tableView)}>{tableView ? '차트 보기' : '값 표 보기'}</button></div>
    {m.metricsError && <p role="alert" className="monitor-notice">지표 조회 실패 · 이전 조회값이 포함될 수 있습니다: {m.metricsError}</p>}
    {m.metrics && <p className="muted">조회 {fmtDateTime(m.metrics.collectedAt)} · {fmtDateTime(m.metrics.range.startTime)} ~ {fmtDateTime(m.metrics.range.endTime)} · {m.metrics.queryCount}개 쿼리 · {m.metrics.requestCount}회 요청 · 조회 리전은 지표별로 표시</p>}
    {!tableView && m.metrics && <p className="muted">차트를 드래그하면 기간을 좁힙니다. 기간 변경 후 선택 지표 조회로 다시 확인하세요.</p>}
    <div className="monitor-metric-filters monitor-controls"><label><Search size={14} /><span className="sr-only">표시 지표 검색</span><input type="search" placeholder="표시할 지표 검색" value={metricQuery} onChange={(e) => setMetricQuery(e.target.value)} /></label><label><input type="checkbox" checked={problemOnly} onChange={(e) => setProblemOnly(e.target.checked)} /><Filter size={14} /> 조회 문제만 보기</label><span className="muted">표시만 변경하며 추가 AWS 조회는 하지 않습니다.</span></div>
    <div ref={chartHost}>
      {selected.map(({ key, resource }) => <section key={key} className="monitor-resource-metrics"><h3>{resource?.name ?? '찾을 수 없음'}</h3>
        {m.metrics && !(m.metrics.series[key]?.length) && <p className="muted">지원 지표가 없거나 결과가 반환되지 않았습니다.</p>}
        <div className="monitor-metric-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {m.metrics?.series[key]?.filter(matchesSeries).map((series) => <div className={`monitor-metric quality-${series.status ?? 'complete'}`} key={series.id}>
          <div className="metric-head"><strong>{series.label}</strong><span className="tnum">{fmtNumber(series.latest, series.unit)}</span></div>
          <p className="muted">{series.stat} · {series.unit} · {series.period ? `${series.period >= 86400 ? `${series.period / 86400}일` : `${series.period / 60}분`} 집계` : '주기 미제공'} · {series.region ?? m.region} · {series.status === 'error' ? '조회 실패' : series.status === 'partial' ? '부분 결과' : series.status === 'empty' ? '데이터 없음' : '조회 완료'}</p>
          <p className="muted">지표 기간 {fmtDateTime(series.startTime)} ~ {fmtDateTime(series.endTime)} · 최신 데이터 {fmtDateTime(series.lastDataAt) || '없음'}{series.lastDataAt && series.endTime && series.period && Date.parse(series.endTime) - Date.parse(series.lastDataAt) > series.period * 2000 ? ' · 최신 값 지연' : ''}</p>
          {!!series.messages?.length && <p role="status" className="monitor-notice">{series.messages.join(' / ')}</p>}
          {tableView ? <div className="monitor-table-scroll"><table className="metric-table"><thead><tr><th>시각</th><th>{series.label} ({series.unit})</th></tr></thead><tbody>{series.points.map((point) => <tr key={point.t}><td>{fmtDateTime(point.t)}</td><td>{fmtNumber(point.v, series.unit)}</td></tr>)}</tbody></table></div> : <><Sparkline series={series} width={chartWidth} height={100} timeDomain={domain} valueDomain={valueDomains.get(`${series.id}:${series.unit}:${series.stat}`)} hoverTime={hoverTime} onHoverTime={setHoverTime} onSelectRange={selectRange} /><div className="muted">값 범위 {fmtNumber(valueDomains.get(`${series.id}:${series.unit}:${series.stat}`)?.min, series.unit)} ~ {fmtNumber(valueDomains.get(`${series.id}:${series.unit}:${series.stat}`)?.max, series.unit)}</div><div className="monitor-time-axis"><span>{fmtDateTime(domain?.start)}</span><span>{fmtDateTime(domain?.end)}</span></div></>}
        </div>)}
        </div>
        {Boolean(m.metrics?.series[key]?.length) && !m.metrics!.series[key].some(matchesSeries) ? <p className="monitor-empty muted">표시 조건에 해당하는 지표가 없습니다.</p> : null}
      </section>)}
    </div>
  </section>;
}
