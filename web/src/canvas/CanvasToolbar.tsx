import { useReactFlow } from '@xyflow/react';
import { Maximize2, Minus, Plus } from 'lucide-react';
import { useStore, type Overlays } from '../model/store';
import type { Scene } from '../layout/scene';

const LAYERS: Array<{ key: keyof Overlays; label: string; hint: string }> = [
  { key: 'traffic', label: '트래픽', hint: 'CloudWatch 지표에 비례해 관계선 위로 펄스를 흘립니다' },
  { key: 'targetGroups', label: '타깃 그룹', hint: '로드 밸런서와 타깃 사이의 타깃 그룹을 노드로 펼칩니다' },
  { key: 'security', label: '보안 그룹', hint: '보안 그룹 노드와 허용 규칙을 표시합니다' },
  { key: 'iam', label: 'IAM 역할', hint: '컴퓨트 자원이 맡는 IAM 역할을 표시합니다' },
  { key: 'encryption', label: 'KMS 키', hint: '암호화에 쓰이는 KMS 키를 표시합니다' },
  { key: 'isolated', label: '관계 없는 자원', hint: '다른 자원과 연결되지 않은 리전 서비스도 개별 노드로 펼칩니다' },
];

export function CanvasToolbar({ scene, laying }: { scene?: Scene; laying: boolean }) {
  const rf = useReactFlow();
  const overlays = useStore((s) => s.overlays);
  const setOverlay = useStore((s) => s.setOverlay);
  const metricsLoading = useStore((s) => s.metricsLoading);
  const metrics = useStore((s) => s.metrics);
  const trafficNodes = metrics ? Object.keys(metrics.traffic).length : 0;
  return (
    <div className="canvas-toolbar" role="toolbar" aria-label="캔버스 도구">
      <div className="tb-group">
        <button type="button" className="tb-btn" onClick={() => rf.zoomOut({ duration: 200 })} aria-label="축소"><Minus size={14} /></button>
        <button type="button" className="tb-btn" onClick={() => rf.zoomIn({ duration: 200 })} aria-label="확대"><Plus size={14} /></button>
        <button type="button" className="tb-btn" onClick={() => rf.fitView({ padding: 0.08, duration: 500 })} aria-label="전체 보기"><Maximize2 size={14} /></button>
      </div>
      <div className="tb-sep" />
      <div className="tb-group tb-layers" aria-label="레이어">
        {LAYERS.map((l) => (
          <button
            key={l.key}
            type="button"
            className={`tb-chip ${overlays[l.key] ? 'on' : ''}`}
            aria-pressed={overlays[l.key]}
            title={l.hint}
            onClick={() => setOverlay(l.key, !overlays[l.key])}
          >
            {l.label}
            {l.key === 'traffic' && (metricsLoading ? <span className="tb-chip-note">측정 중</span> : trafficNodes > 0 ? <span className="tb-chip-note tnum">{trafficNodes}</span> : null)}
          </button>
        ))}
      </div>
      <div className="tb-sep" />
      <div className="tb-status">
        {laying ? <span className="tb-laying">배치 계산 중</span> : scene ? <span>자원 {scene.visible.toLocaleString()}개 · 관계 {scene.edges.length.toLocaleString()}개{scene.hidden ? ` · 숨김 ${scene.hidden}` : ''}{scene.hiddenMatches ? ` · 숨겨진 검색 결과 ${scene.hiddenMatches}` : ''}</span> : null}
      </div>
    </div>
  );
}
