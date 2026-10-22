import { useId, useMemo, useState } from 'react';
import { area as d3area, line as d3line, curveMonotoneX } from 'd3-shape';
import type { MetricSeries } from '@orrery/shared';
import { fmtDateTime, fmtNumber } from './format';

interface Props {
  series: MetricSeries;
  width?: number;
  height?: number;
  color?: string;
}

/** A single-series sparkline with a crosshair tooltip (values also live in the table view). */
export function Sparkline({ series, width = 296, height = 56, color = 'var(--ink-2)' }: Props) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const pts = series.points.filter((p) => p.v != null);
  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const pad = 4;
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const max = Math.max(...pts.map((p) => p.v), 0);
    const min = Math.min(...pts.map((p) => p.v), 0);
    const range = max - min || 1;
    const x = (t: number) => pad + ((t - t0) / (t1 - t0 || 1)) * (width - pad * 2);
    const y = (v: number) => height - pad - ((v - min) / range) * (height - pad * 2);
    const ln = d3line<{ t: number; v: number }>().x((p) => x(p.t)).y((p) => y(p.v)).curve(curveMonotoneX);
    const ar = d3area<{ t: number; v: number }>().x((p) => x(p.t)).y0(height - pad).y1((p) => y(p.v)).curve(curveMonotoneX);
    return { x, y, line: ln(pts) ?? '', area: ar(pts) ?? '', max, min };
  }, [pts, width, height]);

  if (!geo) return <div className="spark-empty">데이터 없음</div>;
  const hp = hover != null ? pts[hover] : null;

  return (
    <div className="spark" style={{ width }}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`${series.label} 최근 추이`}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = e.clientX - rect.left;
          let best = 0, bd = Infinity;
          pts.forEach((p, i) => { const d = Math.abs(geo.x(p.t) - px); if (d < bd) { bd = d; best = i; } });
          setHover(best);
        }}
        onMouseLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id={`g${id}`} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={geo.area} fill={`url(#g${id})`} />
        <path d={geo.line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hp && (
          <g>
            <line x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={2} y2={height - 2} stroke="var(--ink-4)" strokeWidth={1} />
            <circle cx={geo.x(hp.t)} cy={geo.y(hp.v)} r={4} fill={color} stroke="var(--panel)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div className="spark-tip" style={{ left: Math.min(Math.max(geo.x(hp.t), 60), width - 60) }}>
          <span className="tnum">{fmtNumber(hp.v, series.unit)}</span>
          <span className="spark-tip-time">{fmtDateTime(hp.t)}</span>
        </div>
      )}
    </div>
  );
}
