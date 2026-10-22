import { useMemo } from 'react';
import { Search, X } from 'lucide-react';
import type { Category, ResourceType, Status } from '@orrery/shared';
import { CATEGORY_LABEL, STATUS_LABEL } from '@orrery/shared';
import { useStore } from '../model/store';
import { CATEGORY_ORDER, STATUS_ORDER, TYPES_BY_CATEGORY, TYPE_META } from '../model/types';
import { TypeIcon } from '../components/TypeIcon';

export function Rail() {
  const graph = useStore((s) => s.graph);
  const query = useStore((s) => s.query);
  const categories = useStore((s) => s.categories);
  const hiddenTypes = useStore((s) => s.hiddenTypes);
  const { setQuery, toggleCategory, toggleType } = useStore.getState();

  const counts = useMemo(() => {
    const byType = new Map<ResourceType, number>();
    const byStatus: Record<Status, number> = { healthy: 0, warning: 0, critical: 0, inactive: 0, unknown: 0 };
    const byCat: Record<Category, number> = { compute: 0, network: 0, database: 0, storage: 0, security: 0, integration: 0 };
    for (const n of graph?.nodes ?? []) {
      byType.set(n.type, (byType.get(n.type) ?? 0) + 1);
      byStatus[n.status] += 1;
      byCat[n.category] += 1;
    }
    return { byType, byStatus, byCat, total: graph?.nodes.length ?? 0 };
  }, [graph]);

  return (
    <aside className="rail" aria-label="자원 필터">
      <label className="search">
        <Search size={14} aria-hidden />
        <input
          type="search"
          placeholder="이름, ID, IP, 태그로 찾기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="자원 검색"
        />
        {query && <button type="button" className="search-clear" onClick={() => setQuery('')} aria-label="검색 지우기"><X size={13} /></button>}
      </label>

      {graph && (
        <section className="rail-status" aria-label="상태 요약">
          <div className="status-bar" role="img" aria-label={STATUS_ORDER.map((s) => `${STATUS_LABEL[s]} ${counts.byStatus[s]}`).join(', ')}>
            {STATUS_ORDER.filter((s) => counts.byStatus[s] > 0).map((s) => (
              <span key={s} className={`status-seg st-${s}`} style={{ flex: counts.byStatus[s] }} />
            ))}
          </div>
          <ul className="status-legend">
            {STATUS_ORDER.filter((s) => counts.byStatus[s] > 0).map((s) => (
              <li key={s} className={`st-${s}`}><span className="status-dot" />{STATUS_LABEL[s]} <b className="tnum">{counts.byStatus[s]}</b></li>
            ))}
          </ul>
        </section>
      )}

      <nav className="rail-tree">
        {CATEGORY_ORDER.map((c) => {
          const on = categories[c];
          const types = TYPES_BY_CATEGORY[c].filter((t) => (counts.byType.get(t) ?? 0) > 0);
          return (
            <section key={c} className={`rail-cat cat-${c} ${on ? '' : 'off'}`}>
              <button type="button" className="rail-cat-head" aria-pressed={on} aria-label={`${CATEGORY_LABEL[c]} ${on ? '숨기기' : '표시'}`} onClick={() => toggleCategory(c)} title={on ? '이 분류를 숨깁니다' : '이 분류를 표시합니다'}>
                <span className="cat-swatch" />
                <span className="rail-cat-name">{CATEGORY_LABEL[c]}</span>
                <span className="rail-count tnum">{counts.byCat[c]}</span>
              </button>
              {on && types.length > 0 && (
                <ul className="rail-types">
                  {types.map((t) => {
                    const hidden = hiddenTypes.has(t);
                    const meta = TYPE_META[t];
                    return (
                      <li key={t}>
                        <button type="button" className={`rail-type ${hidden ? 'off' : ''}`} aria-pressed={!hidden} aria-label={`${meta.label} ${hidden ? '표시' : '숨기기'}`} onClick={() => toggleType(t)} title={meta.overlay ? '토폴로지에서는 레이어를 켜야 보입니다' : undefined}>
                          <TypeIcon type={t} size={14} />
                          <span className="rail-type-name">{meta.label}</span>
                          {meta.overlay && <span className="rail-layer">레이어</span>}
                          <span className="rail-count tnum">{counts.byType.get(t)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          );
        })}
      </nav>

      {graph && (
        <footer className="rail-foot">
          <div>총 {counts.total.toLocaleString()}개 자원 · {graph.edges.length.toLocaleString()}개 관계</div>
          {graph.reports.filter((r) => !r.ok).length > 0 && (
            <details className="rail-warn">
              <summary>수집 실패 {graph.reports.filter((r) => !r.ok).length}건</summary>
              <ul>{graph.reports.filter((r) => !r.ok).map((r) => <li key={r.collector}><b>{r.collector}</b> {r.error}</li>)}</ul>
            </details>
          )}
        </footer>
      )}
    </aside>
  );
}
