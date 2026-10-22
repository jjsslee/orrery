import { AlertTriangle, Check, Loader2, RotateCw } from 'lucide-react';
import { useStore } from '../model/store';
import { BrandMark } from '../components/Brand';

/** The one orchestrated moment: collectors reporting in while the canvas waits. */
export function LoadOverlay() {
  const loading = useStore((s) => s.loading);
  const labels = useStore((s) => s.collectorLabels);
  const profile = useStore((s) => s.profile);
  const region = useStore((s) => s.region);
  const load = useStore((s) => s.load);
  const order = loading.order.length ? loading.order : Object.keys(labels);
  const done = order.filter((c) => loading.reports[c]).length;

  if (!loading.active && !loading.error) return null;

  return (
    <div className="load-overlay" role="status" aria-live="polite">
      <div className="load-card">
        <div className="load-head">
          <BrandMark size={28} spinning={loading.active} />
          <div>
            <div className="load-title">{loading.error ? '수집하지 못했습니다' : `${profile} · ${region} 수집 중`}</div>
            <div className="load-sub">{loading.error ? loading.error : `${done}/${order.length} 완료 · 읽기 전용 API만 호출합니다`}</div>
          </div>
        </div>
        {loading.error ? (
          <button type="button" className="btn primary" onClick={() => void load(true)}><RotateCw size={14} /> 다시 시도</button>
        ) : (
          <ul className="load-list">
            {order.map((c, i) => {
              const r = loading.reports[c];
              return (
                <li key={c} className={`load-item ${r ? (r.ok ? 'ok' : 'fail') : 'pending'}`} style={{ '--i': i } as React.CSSProperties}>
                  <span className="load-icon">{r ? (r.ok ? <Check size={13} /> : <AlertTriangle size={13} />) : <Loader2 size={13} className="spin" />}</span>
                  <span className="load-name">{labels[c] ?? c}</span>
                  <span className="load-meta tnum">{r ? (r.ok ? `${r.nodes}개 · ${(r.durationMs / 1000).toFixed(1)}s` : r.error?.slice(0, 60)) : ''}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
