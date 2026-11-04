import { uiText, useLanguage } from '../i18n';
import { AlertTriangle, Check, Loader2, RotateCw } from 'lucide-react';
import { useStore } from '../model/store';
import { BrandMark } from '../components/Brand';

/** The one orchestrated moment: collectors reporting in while the canvas waits. */
export function LoadOverlay() {
  useLanguage();
  const loading = useStore((s) => s.loading);
  const labels = useStore((s) => s.collectorLabels);
  const profile = useStore((s) => s.profile);
  const region = useStore((s) => s.region);
  const load = useStore((s) => s.load);
  const setProfile = useStore((s) => s.setProfile);
  const order = loading.order.length ? loading.order : Object.keys(labels);
  const done = order.filter((c) => loading.reports[c]).length;

  if (!loading.active && !loading.error) return null;

  return (
    <div className="load-overlay" role="status" aria-live="polite">
      <div className="load-card">
        <div className="load-head">
          <BrandMark size={28} spinning={loading.active} />
          <div>
            <div className="load-title">{uiText(loading.error ?? '') ? (region ? uiText('수집하지 못했습니다') : uiText('계정에 연결하지 못했습니다')) : uiText`${profile} · ${region} 수집 중`}</div>
            <div className="load-sub">{uiText(loading.error ?? '') ? uiText(loading.error ?? '') : uiText`${done}/${order.length} 완료 · 읽기 전용 API만 호출합니다`}</div>
          </div>
        </div>
        {uiText(loading.error ?? '') ? (
          <div className="load-actions">
            {/* Without a region the failure came from listing regions, so retry that (setProfile re-lists). */}
            <button type="button" className="btn primary" onClick={() => void (region ? load(true) : setProfile(profile))}><RotateCw size={14} /> {uiText(" 다시 시도")}</button>
            <span className="load-hint">{uiText("상단바에서 프로필이나 리전을 바꾸면 바로 다시 수집합니다.")}</span>
          </div>
        ) : (
          <ul className="load-list">
            {order.map((c, i) => {
              const r = loading.reports[c];
              return (
                <li key={c} className={`load-item ${r ? (r.ok ? 'ok' : 'fail') : 'pending'}`} style={{ '--i': i } as React.CSSProperties}>
                  <span className="load-icon">{r ? (r.ok ? <Check size={13} /> : <AlertTriangle size={13} />) : <Loader2 size={13} className="spin" />}</span>
                  <span className="load-name">{uiText(labels[c] ?? c)}</span>
                  <span className="load-meta tnum">{r ? (r.ok ? uiText`${r.nodes}개 · ${(r.durationMs / 1000).toFixed(1)}s` : uiText(r.error ?? '')?.slice(0, 60)) : ''}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
