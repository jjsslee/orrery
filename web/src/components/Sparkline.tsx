import { useId, useMemo, useRef, useState } from 'react';
import { area as d3area, line as d3line, curveMonotoneX } from 'd3-shape';
import type { MetricSeries } from '@orrery/shared';
import { fmtDateTime, fmtNumber } from './format';

interface Props {
  series: MetricSeries;
  width?: number;
  height?: number;
  color?: string;
  valueDomain?: { min: number; max: number };
  timeDomain?: { start: number; end: number };
  hoverTime?: number | null;
  onHoverTime?: (time: number | null) => void;
  onSelectRange?: (start: number, end: number) => void;
}

/** A single-series sparkline with a crosshair tooltip (values also live in the table view). */
export function Sparkline({ series, width = 296, height = 56, color = 'var(--ink-2)', timeDomain, valueDomain, hoverTime, onHoverTime, onSelectRange }: Props) {
  const id = useId();
  const [localHover, setLocalHover] = useState<number | null>(null);
  const dragStart = useRef<number | null>(null);
  const hover = hoverTime === undefined ? localHover : hoverTime;
  const pts = useMemo(() => series.points.filter((p) => p.v != null && Number.isFinite(p.v)).sort((a, b) => a.t - b.t), [series.points]);
  const geo = useMemo(() => {
    if (!pts.length) return null;
    const pad = 4;
    const t0 = timeDomain?.start ?? (series.startTime ? Date.parse(series.startTime) : pts[0].t);
    const t1 = timeDomain?.end ?? (series.endTime ? Date.parse(series.endTime) : pts[pts.length - 1].t);
    const max = valueDomain?.max ?? Math.max(...pts.map((p) => p.v), 0);
    const min = valueDomain?.min ?? Math.min(...pts.map((p) => p.v), 0);
    const range = max - min || 1;
    const x = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (width - pad * 2);
    const y = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);
    const ln = d3line<{ t: number; v: number }>().x((p) => x(p.t)).y((p) => y(p.v)).curve(curveMonotoneX);
    const ar = d3area<{ t: number; v: number }>().x((p) => x(p.t)).y0(height - pad).y1((p) => y(p.v)).curve(curveMonotoneX);
    // CloudWatch omits missing buckets: split runs instead of implying continuity.
    const runs: typeof pts[] = [];
    for (const p of pts) {
      const run = runs.at(-1);
      if (!run || (series.period && p.t - run[run.length - 1].t > series.period * 1500) || series.points.some((missing) => missing.v == null && missing.t > run[run.length - 1].t && missing.t < p.t)) runs.push([p]);
      else run.push(p);
    }
    return { x, y, t0, t1, line: runs.map((run) => ln(run) ?? '').join(''), area: runs.map((run) => ar(run) ?? '').join(''), singletons: runs.filter((run) => run.length === 1).map((run) => run[0]), max, min };
  }, [pts, series.startTime, series.endTime, series.period, series.points, timeDomain?.start, timeDomain?.end, valueDomain?.min, valueDomain?.max, width, height]);

  if (!geo) return <div className="spark-empty">{series.status === 'error' ? '조회 실패' : series.status === 'partial' ? '부분 결과 · 데이터 없음' : '데이터 없음'}</div>;
  const nearest = hover == null ? null : pts.reduce((best, p) => Math.abs(p.t - hover) < Math.abs(best.t - hover) ? p : best, pts[0]);
  const hp = nearest && (series.period == null || Math.abs(nearest.t - hover!) <= series.period * 500) ? nearest : null;
  const pointerTime = (clientX: number, element: SVGSVGElement) => {
    const rect = element.getBoundingClientRect();
    return geo.t0 + Math.max(0, Math.min(1, (clientX - rect.left - 4) / (rect.width - 8))) * (geo.t1 - geo.t0);
  };

  return (
    <div className="spark" style={{ width }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${series.label} 최근 추이`}
        onMouseMove={(e) => {
          const time = pointerTime(e.clientX, e.currentTarget);
          setLocalHover(time); onHoverTime?.(time);
        }}
        onMouseLeave={() => { setLocalHover(null); onHoverTime?.(null); }}
        onPointerDown={(e) => { if (!onSelectRange) return; dragStart.current = pointerTime(e.clientX, e.currentTarget); e.currentTarget.setPointerCapture(e.pointerId); }}
        onPointerUp={(e) => { if (dragStart.current == null) return; const end = pointerTime(e.clientX, e.currentTarget); const start = dragStart.current; dragStart.current = null; if (Math.abs(end - start) > Math.max(60000, (geo.t1 - geo.t0) * 0.02)) onSelectRange?.(Math.min(start, end), Math.max(start, end)); }}
        style={onSelectRange ? { touchAction: 'pan-y', cursor: 'crosshair' } : undefined}
      >
        <defs>
          <linearGradient id={`g${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geo.area} fill={`url(#g${id})`} />
        <path d={geo.line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {geo.singletons.map((p) => <circle key={p.t} cx={geo.x(p.t)} cy={geo.y(p.v)} r={3} fill={color} />)}
        {hover != null && <line x1={geo.x(hover)} x2={geo.x(hover)} y1={2} y2={height - 2} stroke="var(--ink-4)" />}
        {hp && (
          <g>
            <line x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={2} y2={height - 2} stroke="var(--ink-4)" strokeWidth={1} />
            <circle cx={geo.x(hp.t)} cy={geo.y(hp.v)} r={4} fill={color} stroke="var(--panel)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover != null && (
        <div className="spark-tip" style={{ left: Math.min(Math.max(geo.x(hover), 60), width - 60) }}>
          <span className="tnum">{hp ? fmtNumber(hp.v, series.unit) : '결측'}</span>
          <span className="spark-tip-time">{fmtDateTime(hover)}</span>
        </div>
      )}
    </div>
  );
}
