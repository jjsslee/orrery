import { uiText, useLanguage } from '../i18n';
import { useEffect, useRef, useState } from 'react';
import { Activity, LineChart, RefreshCw, Table, X } from 'lucide-react';
import type { MonitoringMetricSeries } from '@orrery/shared';
import { MAX_OBSERVED, useMonitoring, type TimeRange } from '../model/monitoring';
import { metricNeedsAttention } from '../model/monitoring-resources';
import { Sparkline } from '../components/Sparkline';
import { fmtDateTime, fmtNumber } from '../components/format';
import { TYPE_META } from '../model/types';
import { TypeBadge } from '../components/TypeIcon';
import { MonitoringResourceAlarms } from './MonitoringAlarmDetail';

const RANGES: Array<[TimeRange, string]> = [['1h', '1시간'], ['3h', '3시간'], ['24h', '24시간'], ['7d', '7일'], ['custom', '직접 선택']];
const QUALITY_LABEL: Record<string, string> = { error: '조회 실패', partial: '부분 결과', empty: '데이터 없음' };
const periodLabel = (period?: number) => !period ? uiText('주기 미제공') : period >= 86400 ? uiText`${period / 86400}일 집계` : period >= 3600 ? uiText`${period / 3600}시간 집계` : uiText`${period / 60}분 집계`;
const delayed = (series: MonitoringMetricSeries) => Boolean(series.lastDataAt && series.endTime && series.period && Date.parse(series.endTime) - Date.parse(series.lastDataAt) > series.period * 2000);

export function MonitoringMetrics() {
  useLanguage();
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
    const key = `${series.name}:${series.unit}:${series.stat}`;
    const valueDomain = valueDomains.get(key) ?? { min: 0, max: 0 };
    for (const point of series.points) if (point.v != null && Number.isFinite(point.v)) { valueDomain.min = Math.min(valueDomain.min, point.v); valueDomain.max = Math.max(valueDomain.max, point.v); }
    valueDomains.set(key, valueDomain);
  }
  // Card: 1px borders + 16px padding; grid: 16px padding, 12px gaps; tile: 1px borders + 14px padding.
  const columns = width >= 680 ? 2 : 1;
  const chartWidth = Math.max(150, Math.floor((width - 34 - (columns - 1) * 12) / columns) - 30);
  const selected = m.selectedResources.map((key) => ({ key, resource: m.resources?.resources.find((resource) => resource.key === key) }));
  const hasSupportedSelection = selected.some(({ resource }) => resource && resource.metricsSupported !== false);
  return <section className="mw-observations" aria-label={uiText("선택 자원의 CloudWatch")}>
    <div className="mw-toolbar">
      <div className="mw-range" role="group" aria-label={uiText("관측 기간")}>
        {RANGES.map(([value, label]) => <button key={value} type="button" className={`seg ${m.range === value ? 'on' : ''}`} aria-pressed={m.range === value} onClick={() => m.setRange(value)}>{uiText(label)}</button>)}
      </div>
      <label className="mw-switch" title={m.range === 'custom' ? uiText('지정한 과거 기간은 자동 갱신하지 않습니다') : uiText('화면이 보일 때만 갱신합니다')}>
        <input type="checkbox" checked={m.autoRefresh !== 0} disabled={!m.autoRefresh && (m.range === 'custom' || !hasSupportedSelection)} onChange={(e) => useMonitoring.setState({ autoRefresh: e.target.checked ? 300000 : 0 })} />
        {uiText("자동 갱신")}</label>
      {m.autoRefresh !== 0 && <select className="mw-inline-select" aria-label={uiText("자동 갱신 간격")} value={m.autoRefresh} onChange={(e) => useMonitoring.setState({ autoRefresh: Number(e.target.value) as 60000 | 300000 })}><option value={300000}>{uiText("5분마다")}</option><option value={60000}>{uiText("1분마다")}</option></select>}
      <span className="mw-toolbar-spacer" />
      <button type="button" className="icon-btn" aria-label={tableView ? uiText('차트 보기') : uiText('값 표 보기')} title={tableView ? uiText('차트로 보기') : uiText('값을 표로 보기')} onClick={() => setTableView(!tableView)}>{tableView ? <LineChart size={16} /> : <Table size={16} />}</button>
      <button type="button" className="btn small" disabled={!hasSupportedSelection || m.metricsLoading} onClick={() => { void m.loadMetrics(true); void m.loadAlarms(true); }}><RefreshCw size={13} className={m.metricsLoading ? 'spin' : ''} aria-hidden />{uiText("다시 조회")}</button>
    </div>
    {m.range === 'custom' && <div className="mw-custom-time">
      <label><span>{uiText("시작")}</span><input type="datetime-local" value={m.customStart} onChange={(e) => m.setCustomTime('customStart', e.target.value)} /></label>
      <label><span>{uiText("종료")}</span><input type="datetime-local" value={m.customEnd} onChange={(e) => m.setCustomTime('customEnd', e.target.value)} /></label>
      <p className="mw-hint">{uiText("과거 455일 이내, 최대 7일까지 볼 수 있습니다. 차트에서 끌어 선택해도 기간이 바뀝니다.")}</p>
    </div>}
    <p className="mw-query-note">
      {uiText("자원이나 기간을 바꾸면 CloudWatch 지표를 자동으로 조회하며, 조회량에 따라 비용이 발생할 수 있습니다. 한 번에 최대 ")}{MAX_OBSERVED}{uiText("개 자원·100개 지표, SDK 명령 10회까지 조회합니다.")}{m.autoRefresh !== 0 && uiText(' 자동 갱신은 화면이 보일 때만 돌고, 복귀 시 갱신 예정 시각이 지났으면 즉시 조회합니다. 일시 오류는 최대 20분 간격으로 늦추며 인증·권한 오류에는 멈춥니다.')}
      {m.metrics && <span className="mw-last-fetch"> {uiText(" 마지막 조회 ")}{fmtDateTime(m.metrics.collectedAt)} {uiText(" · 지표 ")}{m.metrics.queryCount}{uiText("개 · SDK ")}{m.metrics.requestCount}{uiText("회")}</span>}
    </p>
    {uiText(m.metricsError ?? '') && <p role="alert" className="monitor-notice">{uiText("지표 조회 문제 · 이전 값이 포함될 수 있습니다: ")}{uiText(m.metricsError ?? '')}</p>}

    {domain && !!m.related?.changes?.length && <section className="mw-change-timeline" aria-label={uiText("구성 변화 관측 구간")}>
      <h3>{uiText("기준 자원 주변의 구성 변화")}</h3>
      <p className="mw-hint">{uiText("음영은 마지막 확인부터 이번 확인까지의 구간입니다. 실제 변경 시각·장애 원인을 뜻하지 않습니다.")}</p>
      <svg viewBox="0 0 600 48" role="img" aria-label={uiText("선택 기간과 같은 시간축의 구성 변화 관측 구간")}>
        <line x1="4" x2="596" y1="40" y2="40" stroke="var(--ink-4)" />
        {m.related.changes.filter(c => c.from && Date.parse(c.to) >= domain.start && Date.parse(c.from) <= domain.end).map(c => {
          const x = (t:number) => 4 + Math.max(0,Math.min(1,(t-domain.start)/(domain.end-domain.start)))*592;
          const left=x(Date.parse(c.from!)),right=x(Date.parse(c.to));
          return <rect key={c.id} x={left} y="4" width={Math.max(2,right-left)} height="32" fill="var(--cat-network)" opacity="0.25"><title>{c.kind} · {fmtDateTime(c.from)} ~ {fmtDateTime(c.to)} · {uiText(c.label ?? '')}</title></rect>;
        })}
      </svg><div className="mw-axis"><span>{fmtDateTime(domain.start)}</span><span>{fmtDateTime(domain.end)}</span></div>
    </section>}
    <div ref={chartHost} className="mw-cards">
      {!selected.length && <div className="mw-observe-empty">
        <span className="mw-observe-empty-icon"><Activity size={26} aria-hidden /></span>
        <h3>{uiText("함께 볼 자원을 추가하세요")}</h3>
        <ol>
          <li>{uiText("왼쪽에서 이름이나 태그로 자원을 찾아 ")}<b>{uiText("추가")}</b>{uiText("합니다. 최대 ")}{MAX_OBSERVED}{uiText("개까지 함께 볼 수 있습니다.")}</li>
          <li>{uiText("추가한 자원의 경보와 CloudWatch 지표가 이곳에 같은 시간대로 나타납니다.")}</li>
          <li>{uiText("오른쪽 ")}<b>{uiText("관련 자원")}</b>{uiText("에서 연결되거나 태그가 같은 자원을 더할 수 있습니다.")}</li>
        </ol>
      </div>}
      {selected.map(({ key, resource }) => {
        const name = resource?.name ?? uiText('찾을 수 없는 자원');
        const reference = m.referenceResource === key;
        const color = resource ? `var(--cat-${TYPE_META[resource.type].category})` : undefined;
        return <article key={key} className={`mw-card ${reference ? 'is-reference' : ''}`} data-resource-key={key} aria-label={`${name} CloudWatch`}>
          <header className="mw-card-head">
            {resource && <TypeBadge type={resource.type} />}
            <div className="mw-card-title">
              <h3>{name}</h3>
              <p>{resource ? `${uiText(TYPE_META[resource.type].label ?? '')} · ${resource.region}` : uiText('선택한 자원을 현재 목록에서 확인할 수 없습니다.')}</p>
            </div>
            <div className="mw-card-actions">
              {resource && <button type="button" className={`btn ghost small ${reference ? 'is-on' : ''}`} aria-label={uiText`${name} 관련 자원 보기`} aria-pressed={reference} title={reference ? uiText('오른쪽 관련 자원이 이 자원 기준입니다') : uiText('이 자원 기준으로 관련 자원을 찾습니다')} onClick={() => m.setReferenceResource(key)}>{reference ? uiText('관련 자원 기준') : uiText('관련 자원 보기')}</button>}
              <button type="button" className="icon-btn" aria-label={uiText`${name} 빼기`} title={uiText("함께 보기에서 빼기")} onClick={() => m.toggleResource(key)}><X size={15} /></button>
            </div>
          </header>
          {resource?.type === 'target-group' && <p className="mw-card-note">{uiText("연결 ALB: ")}{resource.metricContexts?.find(c => c.id === m.metricContexts[key])?.label ?? uiText('재선택 필요')} {uiText(" · Target Group 전체 지표이며 특정 listener 조건 전용 값은 아닙니다.")}</p>}
          {resource?.type === 'load-balancer' && <p className="mw-card-note">{uiText("로드밸런서 전체 지표입니다. 선택한 경로·조건만의 값이 아닙니다.")}</p>}
          {resource?.type === 'ec2-instance' && <p className="mw-card-note">{uiText("호스트 전체 지표입니다. 특정 ECS 서비스의 사용량을 뜻하지 않습니다.")}</p>}
          <MonitoringResourceAlarms resourceKey={key} />
          {resource?.metricsSupported === false ? <p className="mw-card-note">{uiText(resource?.metricsUnsupportedReason ?? '이 자원 유형의 추천 지표는 제공되지 않습니다.')} {uiText(" 관련 경보와 연결은 확인할 수 있습니다.")}</p> : <>
            {m.metricsLoading && !m.metrics?.series[key]?.length && <p className="mw-card-note mw-progress" role="status"><RefreshCw size={14} className="spin" aria-hidden />{uiText("지표를 불러오는 중")}</p>}
            {m.metrics && !m.metricsLoading && !m.metrics.series[key]?.length && <p className="mw-card-note">{uiText("지원 지표가 없거나 결과가 반환되지 않았습니다. 조회 범위와 권한을 확인하세요.")}</p>}
            {!!m.metrics?.series[key]?.length && <div className="mw-metric-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>{m.metrics.series[key].map((series) => {
              const scale = valueDomains.get(`${series.name}:${series.unit}:${series.stat}`);
              const hasPoints = series.points.some((point) => point.v != null && Number.isFinite(point.v));
              const quality = QUALITY_LABEL[series.status ?? ''];
              return <section className={`mw-metric quality-${series.status ?? 'complete'} ${metricNeedsAttention(series) ? 'needs-attention' : ''}`} key={series.id} aria-label={`${name} ${uiText(series.label ?? '')}`}>
                <div className="mw-metric-head">
                  <h4>{uiText(series.label ?? '')}</h4>
                  <strong className="tnum" title={uiText("기간 중 마지막 값")}>{fmtNumber(series.latest, series.unit)}</strong>
                </div>
                <p className="mw-metric-meta" title={uiText`실제 조회 기간 ${fmtDateTime(series.startTime)} ~ ${fmtDateTime(series.endTime)}`}>
                  {series.stat} · {periodLabel(series.period)}
                  {series.lastDataAt && uiText` · 최신 ${fmtDateTime(series.lastDataAt)}`}
                  {series.region && series.region !== m.region && ` · ${series.region}`}
                </p>
                {/* An empty chart already says 데이터 없음; the chip carries it only where the table hides that. */}
                {((quality && (series.status !== 'empty' || tableView)) || delayed(series)) && <p className="mw-quality">
                  {quality && (series.status !== 'empty' || tableView) && <span className={`mw-quality-chip q-${series.status}`}>{uiText(quality)}</span>}
                  {delayed(series) && <span className="mw-quality-chip q-lag" title={uiText("마지막 값이 집계 주기의 두 배보다 오래되었습니다. 호출이나 요청이 없으면 CloudWatch가 값을 남기지 않을 수 있습니다.")}>{uiText("값 지연")}</span>}
                </p>}
                {!!series.messages?.length && <p role="status" className="monitor-notice">{series.messages.map(message=>uiText(message)).join(' / ')}</p>}
                {tableView ? <div className="monitor-table-scroll"><table className="metric-table"><thead><tr><th>{uiText("시각")}</th><th>{uiText(series.label ?? '')} ({series.unit})</th></tr></thead><tbody>{series.points.map((point) => <tr key={point.t}><td>{fmtDateTime(point.t)}</td><td className="tnum">{fmtNumber(point.v, series.unit)}</td></tr>)}</tbody></table></div> : <>
                  <Sparkline series={series} width={chartWidth} height={84} color={color} timeDomain={domain} valueDomain={scale} hoverTime={hoverTime} onHoverTime={setHoverTime} onSelectRange={selectRange} />
                  {hasPoints && <div className="mw-axis tnum"><span>{fmtDateTime(domain?.start)}</span><span title={uiText("같은 지표는 함께 보는 자원 모두가 같은 세로축을 씁니다")}>{uiText("공통 축 ")}{fmtNumber(scale?.min, series.unit)} ~ {fmtNumber(scale?.max, series.unit)}</span><span>{fmtDateTime(domain?.end)}</span></div>}
                </>}
              </section>;
            })}</div>}
          </>}
        </article>;
      })}
    </div>
  </section>;
}
