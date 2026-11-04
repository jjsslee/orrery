import { uiText, useLanguage } from '../i18n';
import type { Scene, SceneNode } from '../layout/scene';
import { EDGE_KIND_LABEL, TYPE_META } from '../model/types';
import { STATUS_LABEL } from '@orrery/shared';
import { fmtProp } from '../components/format';

export interface HoverAnchor { id: string; x: number; y: number; w: number; h: number }

const MAX_RELATIONS = 6;
const CARD_W = 320;
const EDGE = 14;
// Above the canvas toolbar (bottom 14 + 40 high) and the minimap (bottom margin 20 + 120 high).
const TOOLBAR_CLEAR = 64, MINIMAP_CLEAR = 150;
const NON_DIRECTIONAL = new Set(['attached', 'member']);

function nameOf(n: SceneNode | undefined): string {
  return n?.node?.name ?? n?.aggregate?.label ?? n?.lane?.label ?? uiText('알 수 없음');
}

/**
 * Hovering a node: one readable card (full name, type, status and its
 * relations) instead of labels scattered along the highlighted lines.
 */
export function HoverCard({ anchor, scene, bounds }: { anchor: HoverAnchor; scene: Scene; bounds: { width: number; height: number } }) {
  useLanguage();
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));
  const target = byId.get(anchor.id);
  if (!target || target.kind === 'plate') return null;

  const relations = scene.edges
    .filter((e) => e.source === anchor.id || e.target === anchor.id)
    .map((e) => {
      const out = e.source === anchor.id;
      return { e, out, other: nameOf(byId.get(out ? e.target : e.source)) };
    })
    .sort((a, b) => Number(b.out) - Number(a.out));

  const node = target.node;
  const meta = node ? TYPE_META[node.type] : target.aggregate ? TYPE_META[target.aggregate.type] : undefined;
  const keyProp = node && meta?.keyProp ? node.props[meta.keyProp] : undefined;
  const status = node?.status ?? target.aggregate?.worst;

  // In a lower corner of the map, on the side away from the node, so the card never covers
  // the node, its highlighted lines or its neighbours. The minimap is hidden at 1180px and below.
  const onRight = anchor.x + anchor.w / 2 < bounds.width / 2;
  const bottom = onRight && window.innerWidth > 1180 ? MINIMAP_CLEAR : TOOLBAR_CLEAR;

  return (
    <div className="hover-card" style={{ [onRight ? 'right' : 'left']: EDGE, bottom, width: CARD_W, maxHeight: bounds.height - bottom - EDGE, overflow: 'hidden' }} role="tooltip">
      <div className="hc-name">{nameOf(target)}</div>
      <div className="hc-meta">
        {meta && <span className="hc-type" style={{ color: `var(--cat-${meta.category})` }}>{uiText(meta.label ?? '')}</span>}
        {keyProp != null && keyProp !== '' && <span className="mono">{String(fmtProp(keyProp,meta?.keyProp))}</span>}
        {status && <span className={`hc-status st-${status}`}><span className="status-dot" />{uiText(node?.statusLabel ?? STATUS_LABEL[status] ?? '')}</span>}
      </div>
      {(node?.alarms?.length ?? 0) > 0 && <div className="hc-alarm">{uiText("경보 ")}{node!.alarms!.length}{uiText("건")}</div>}
      {target.ghost && <div className="hc-note">{uiText("필터에 가려진 유형이지만 선택한 자원과 연결되어 있어 표시합니다.")}</div>}
      {relations.length > 0 && (
        <ul className="hc-rels">
          {relations.slice(0, MAX_RELATIONS).map(({ e, out, other }) => (
            <li key={e.id} className={e.status ? `st-${e.status}` : undefined}>
              <div className="hc-rel">
                <span className="hc-kind">{uiText(EDGE_KIND_LABEL[e.kind] ?? e.kind)}</span>
                <span className="hc-dir" aria-hidden>{NON_DIRECTIONAL.has(e.kind) ? '—' : out ? '→' : '←'}</span>
                <span className="hc-other">{other}</span>
              </div>
              {(e.label || e.count > 1) && <div className="hc-detail">{[e.label, e.count > 1 ? `×${e.count}` : ''].filter(Boolean).join(' · ')}</div>}
            </li>
          ))}
        </ul>
      )}
      <div className="hc-foot">
        {relations.length > MAX_RELATIONS ? uiText`관계 ${relations.length - MAX_RELATIONS}개 더 · ` : ''}
        {target.kind === 'aggregate' ? uiText('클릭하면 펼칩니다') : uiText('클릭하면 자세히 봅니다')}
      </div>
    </div>
  );
}
