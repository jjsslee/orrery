import { useMemo, useState } from 'react';
import type { ResourceNode, ResourceType, Status } from '@orrery/shared';
import { CATEGORY_LABEL, STATUS_LABEL } from '@orrery/shared';
import { useStore } from '../model/store';
import { CATEGORY_ORDER, STATUS_ORDER, TYPES_BY_CATEGORY, TYPE_META } from '../model/types';
import { TypeIcon } from '../components/TypeIcon';
import { StatusDot } from '../components/StatusDot';
import { fmtNumber, fmtProp, fmtRelative } from '../components/format';
import { ChevronDown, LocateFixed } from 'lucide-react';
import { matchesTags } from '../model/tags';

const PAGE = 24;

function MiniTrend({ points, color }: { points: number[]; color: string }) {
  if (points.length < 2) return <span className="trend-empty">–</span>;
  const w = 72, h = 18, max = Math.max(...points, 1e-9);
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i / (points.length - 1)) * w},${h - (v / max) * (h - 2) - 1}`).join(' ');
  return <svg className="trend" width={w} height={h} aria-hidden><path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" /></svg>;
}

export function TypeView() {
  const graph = useStore((s) => s.graph);
  const metrics = useStore((s) => s.metrics);
  const query = useStore((s) => s.query);
  const statusFilter = useStore((s) => s.statusFilter);
  const categories = useStore((s) => s.categories);
  const hiddenTypes = useStore((s) => s.hiddenTypes);
  const tagFilters = useStore((s) => s.tagFilters);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const locate = useStore((s) => s.locate);
  const [pages, setPages] = useState<Record<string, number>>({});
  const [sortBy, setSortBy] = useState<'name' | 'status' | 'traffic'>('status');

  const q = query.trim().toLowerCase();
  const degree = useMemo(() => {
    const d = new Map<string, number>();
    for (const e of graph?.edges ?? []) { d.set(e.source, (d.get(e.source) ?? 0) + 1); d.set(e.target, (d.get(e.target) ?? 0) + 1); }
    return d;
  }, [graph]);

  const groups = useMemo(() => {
    const byType = new Map<ResourceType, ResourceNode[]>();
    for (const n of graph?.nodes ?? []) {
      if (!categories[n.category] || hiddenTypes.has(n.type)) continue;
      if (statusFilter && n.status !== statusFilter) continue;
      if (!matchesTags(n, tagFilters)) continue;
      if (q && !(n.name.toLowerCase().includes(q) || n.nativeId.toLowerCase().includes(q) || Object.values(n.props).some((v) => typeof v === 'string' && v.toLowerCase().includes(q)))) continue;
      byType.set(n.type, [...(byType.get(n.type) ?? []), n]);
    }
    const rank: Record<Status, number> = { critical: 0, warning: 1, healthy: 2, inactive: 3, unknown: 4 };
    for (const list of byType.values()) {
      list.sort((a, b) => {
        if (sortBy === 'traffic') return (metrics?.traffic[b.id] ?? -1) - (metrics?.traffic[a.id] ?? -1) || a.name.localeCompare(b.name);
        if (sortBy === 'status') return rank[a.status] - rank[b.status] || a.name.localeCompare(b.name);
        return a.name.localeCompare(b.name);
      });
    }
    return byType;
  }, [graph, categories, hiddenTypes, tagFilters, q, sortBy, metrics, statusFilter]);

  if (!graph) return null;
  const total = [...groups.values()].reduce((a, l) => a + l.length, 0);
  const statusTotals: Record<Status, number> = { healthy: 0, warning: 0, critical: 0, inactive: 0, unknown: 0 };
  for (const l of groups.values()) for (const n of l) statusTotals[n.status] += 1;

  return (
    <div className="typeview">
      <div className="tv-summary">
        <div className="tile"><div className="tile-value">{total.toLocaleString()}</div><div className="tile-label">자원</div></div>
        <div className="tile"><div className="tile-value">{graph.edges.length.toLocaleString()}</div><div className="tile-label">관계</div></div>
        <div className="tile st-critical"><div className="tile-value">{statusTotals.critical}</div><div className="tile-label">위험</div></div>
        <div className="tile st-warning"><div className="tile-value">{statusTotals.warning}</div><div className="tile-label">주의</div></div>
        <div className="tile"><div className="tile-value">{fmtRelative(graph.collectedAt)}</div><div className="tile-label">마지막 수집</div></div>
        <div className="tv-sort" role="group" aria-label="정렬">
          {(['status', 'traffic', 'name'] as const).map((k) => (
            <button key={k} type="button" className={`seg ${sortBy === k ? 'on' : ''}`} aria-pressed={sortBy === k} onClick={() => setSortBy(k)}>
              {k === 'status' ? '상태순' : k === 'traffic' ? '활동량순' : '이름순'}
            </button>
          ))}
        </div>
      </div>

      {CATEGORY_ORDER.filter((c) => categories[c]).map((c) => {
        const types = TYPES_BY_CATEGORY[c].filter((t) => groups.get(t)?.length);
        if (!types.length) return null;
        return (
          <section key={c} className={`tv-cat cat-${c}`}>
            <h2 className="tv-cat-title"><span className="cat-swatch" />{CATEGORY_LABEL[c]}</h2>
            {types.map((t) => {
              const list = groups.get(t)!;
              const meta = TYPE_META[t];
              const counts: Partial<Record<Status, number>> = {};
              for (const n of list) counts[n.status] = (counts[n.status] ?? 0) + 1;
              const shown = (pages[t] ?? 1) * PAGE;
              return (
                <section key={t} className="tv-type">
                  <header className="tv-type-head">
                    <span className="tv-type-icon"><TypeIcon type={t} size={16} /></span>
                    <h3>{meta.label}</h3>
                    <span className="tv-type-count tnum">{list.length}</span>
                    <div className="status-bar small" role="img" aria-label={STATUS_ORDER.filter((s) => counts[s]).map((s) => `${STATUS_LABEL[s]} ${counts[s]}`).join(', ')}>
                      {STATUS_ORDER.filter((s) => counts[s]).map((s) => <span key={s} className={`status-seg st-${s}`} style={{ flex: counts[s] }} />)}
                    </div>
                    <span className="tv-type-legend">{STATUS_ORDER.filter((s) => counts[s]).map((s) => <span key={s} className={`st-${s}`}><span className="status-dot" />{STATUS_LABEL[s]} {counts[s]}</span>)}</span>
                  </header>
                  <table className="tv-table">
                    <thead>
                      <tr><th>이름</th><th>식별자</th><th>상태</th><th>{meta.keyProp ?? '속성'}</th><th>관계</th><th>최근 3시간</th></tr>
                    </thead>
                    <tbody>
                      {list.slice(0, shown).map((n) => {
                        const s = metrics?.series[n.id]?.[0];
                        const tr = metrics?.traffic[n.id];
                        const keyVal = meta.keyProp ? n.props[meta.keyProp] : undefined;
                        return (
                          <tr key={n.id} className={n.id === selectedId ? 'selected' : ''} onClick={() => select(n.id)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') select(n.id); }}>
                            <td className="tv-name">
                              <span className="tv-name-text" title={n.name}>{n.name}</span>
                              {n.alarms?.length ? <span className="rnode-alarm">{n.alarms.length}</span> : null}
                              <button type="button" className="tv-locate" title="지도에서 보기" aria-label={`${n.name} 지도에서 보기`} onClick={(e) => { e.stopPropagation(); locate(n.id); }}>
                                <LocateFixed size={13} />
                              </button>
                            </td>
                            <td className="mono tv-id" title={n.arn ?? n.nativeId}>{n.nativeId.length > 36 ? `…${n.nativeId.slice(-34)}` : n.nativeId}</td>
                            <td><StatusDot status={n.status} showLabel label={n.statusLabel ?? undefined} /></td>
                            <td className="tv-prop">{keyVal != null ? fmtProp(keyVal) : '–'}</td>
                            <td className="tnum">{degree.get(n.id) ?? 0}</td>
                            <td className="tv-trend">
                              {s ? <><MiniTrend points={s.points.map((p) => p.v)} color={`var(--cat-${n.category})`} /><span className="tnum tv-latest">{fmtNumber(s.latest, s.unit)}</span></> : tr != null ? <span className="tnum">{(tr * 100).toFixed(0)}%</span> : <span className="muted">–</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {list.length > shown && (
                    <button type="button" className="tv-more" onClick={() => setPages((p) => ({ ...p, [t]: (p[t] ?? 1) + 1 }))}>
                      <ChevronDown size={13} /> {Math.min(PAGE, list.length - shown)}개 더 보기 <span className="muted">({list.length - shown}개 남음)</span>
                    </button>
                  )}
                </section>
              );
            })}
          </section>
        );
      })}
      {total === 0 && <div className="tv-empty">조건에 맞는 자원이 없습니다. 검색어, 태그, 필터를 조정하세요.</div>}
    </div>
  );
}
