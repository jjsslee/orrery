import { useMemo } from 'react';
import { Search, X } from 'lucide-react';
import type { Category, ResourceType, Status } from '@orrery/shared';
import { CATEGORY_LABEL, STATUS_LABEL } from '@orrery/shared';
import { useStore } from '../model/store';
import { CATEGORY_ORDER, STATUS_ORDER, TYPES_BY_CATEGORY, TYPE_META } from '../model/types';
import { TypeIcon } from '../components/TypeIcon';
import { TagPanel } from './TagPanel';
import { tagFilterLabel } from '../model/tags';
import { Checkbox } from '../components/Checkbox';

export function Rail({ onClose }: { onClose?: () => void }) {
  const graph = useStore((s) => s.graph);
  const query = useStore((s) => s.query);
  const statusFilter = useStore((s) => s.statusFilter);
  const hiddenTypes = useStore((s) => s.hiddenTypes);
  const railTab = useStore((s) => s.railTab);
  const tagFilters = useStore((s) => s.tagFilters);
  const { setQuery, toggleCategory, toggleType, setRailTab, removeTagFilter, setAllTypes, onlyType, resetFilters, setStatusFilter } = useStore.getState();
  const filtered = hiddenTypes.size > 0;

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
    <aside id="resource-filters" className="rail" aria-label="자원 필터">
      <div className="rail-mobile-head"><strong>검색·필터</strong><button type="button" className="icon-btn" onClick={onClose} aria-label="필터 닫기"><X size={18} /></button></div>
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
        <div className="rail-tabs" role="tablist" aria-label="필터 종류">
          <button type="button" role="tab" aria-selected={railTab === 'types'} className={`seg ${railTab === 'types' ? 'on' : ''}`} onClick={() => setRailTab('types')}>유형</button>
          <button type="button" role="tab" aria-selected={railTab === 'tags'} className={`seg ${railTab === 'tags' ? 'on' : ''}`} onClick={() => setRailTab('tags')}>
            태그{tagFilters.length > 0 && <span className="seg-badge tnum">{tagFilters.length}</span>}
          </button>
        </div>
      )}

      {graph && railTab === 'types' && tagFilters.length > 0 && (
        <div className="tag-chips compact">
          {tagFilters.map((t) => (
            <button key={`${t.key}=${t.value ?? ''}`} type="button" className="chip" onClick={() => removeTagFilter(t)} title="태그 필터 제거">
              {tagFilterLabel(t)} <X size={11} />
            </button>
          ))}
        </div>
      )}

      {graph && railTab === 'tags' && <TagPanel />}

      {graph && (
        <section className="rail-status" aria-label="상태 필터">
          <div className="rail-section-head"><span>상태</span>{statusFilter && <button type="button" className="link-btn" onClick={() => setStatusFilter(undefined)}>상태 전체 보기</button>}</div>
          <div className="status-bar" role="img" aria-label={STATUS_ORDER.map((s) => `${STATUS_LABEL[s]} ${counts.byStatus[s]}`).join(', ')}>
            {STATUS_ORDER.filter((s) => counts.byStatus[s] > 0).map((s) => (
              <span key={s} className={`status-seg st-${s}`} style={{ flex: counts.byStatus[s] }} />
            ))}
          </div>
          <ul className="status-legend">
            {STATUS_ORDER.filter((s) => counts.byStatus[s] > 0 || statusFilter === s).map((s) => (
              <li key={s} className={`st-${s}`}><button type="button" aria-pressed={statusFilter === s} onClick={() => setStatusFilter(statusFilter === s ? undefined : s)}><span className="status-dot" aria-hidden />{STATUS_LABEL[s]} <b className="tnum">{counts.byStatus[s]}</b></button></li>
            ))}
          </ul>
          {statusFilter && <p className="rail-filter-note" role="status">{STATUS_LABEL[statusFilter]} 자원만 표시 · 지도에는 소속 영역도 남습니다.</p>}
        </section>
      )}

      {graph && railTab === 'types' && (() => {
        // The master checkbox counts resource types; VPC/subnet plates are structure and stay out of it.
        const presentTypes = (Object.keys(TYPE_META) as ResourceType[]).filter((t) => (counts.byType.get(t) ?? 0) > 0 && !TYPE_META[t].plate);
        const visibleCount = presentTypes.filter((t) => !hiddenTypes.has(t)).length;
        const allOn = visibleCount === presentTypes.length;
        const noneOn = visibleCount === 0;
        return (
          <nav className="rail-tree" aria-label="표시할 자원 유형">
            <div className="rail-row rail-all">
              <label className="rail-cat-head">
                <Checkbox checked={allOn} indeterminate={!allOn && !noneOn} label="모든 유형" onChange={(next) => setAllTypes(next)} />
                <span className="rail-cat-name">전체</span>
                <span className="rail-count tnum">{visibleCount}/{presentTypes.length}</span>
              </label>
              {(filtered || query || tagFilters.length > 0 || statusFilter) && <button type="button" className="link-btn" onClick={resetFilters}>초기화</button>}
            </div>
            <div className="rail-hint">
              <p>체크한 유형만 지도에 남고, 3종 이하로 좁히면 모두 펼칩니다. <kbd>{/Mac/i.test(navigator.platform) ? '⌥' : 'Alt'}</kbd>+클릭은 그 유형만 봅니다.</p>
            </div>
            {CATEGORY_ORDER.map((c) => {
              const types = TYPES_BY_CATEGORY[c].filter((t) => (counts.byType.get(t) ?? 0) > 0);
              if (!types.length) return null;
              const shown = types.filter((t) => !hiddenTypes.has(t)).length;
              const catAll = shown === types.length;
              return (
                <section key={c} className={`rail-cat cat-${c} ${shown === 0 ? 'off' : ''}`}>
                  <label className="rail-cat-head">
                    <Checkbox checked={catAll} indeterminate={shown > 0 && !catAll} label={`${CATEGORY_LABEL[c]} 분류`} onChange={() => toggleCategory(c)} />
                    <span className="cat-swatch" />
                    <span className="rail-cat-name">{CATEGORY_LABEL[c]}</span>
                    <span className="rail-count tnum">{counts.byCat[c]}</span>
                  </label>
                  <ul className="rail-types">
                    {types.map((t) => {
                      const hidden = hiddenTypes.has(t);
                      const meta = TYPE_META[t];
                      return (
                        <li key={t}>
                          <label className={`rail-type ${hidden ? 'off' : ''}`} >
                            <Checkbox checked={!hidden} label={meta.label} onChange={(_next, alt) => (alt ? onlyType(t) : toggleType(t))} />
                            <TypeIcon type={t} size={14} />
                            <span className="rail-type-name">{meta.label}</span>
                            <span className="rail-count tnum">{counts.byType.get(t)}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </nav>
        );
      })()}

      {graph && (
        <footer className="rail-foot">
          <div>수집 전체 {counts.total.toLocaleString()}개 자원 · {graph.edges.length.toLocaleString()}개 관계</div>
          {graph.reports.filter((r) => !r.ok || r.error).length > 0 && (
            <details className="rail-warn">
              <summary>수집 누락·주의 {graph.reports.filter((r) => !r.ok || r.error).length}건</summary>
              <ul>{graph.reports.filter((r) => !r.ok || r.error).map((r) => <li key={r.collector}><b>{r.collector}</b> {r.error}</li>)}</ul>
            </details>
          )}
        </footer>
      )}
    </aside>
  );
}
