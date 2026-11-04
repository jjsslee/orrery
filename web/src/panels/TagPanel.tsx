import { locale, uiText, useLanguage } from '../i18n';
import { useMemo, useState } from 'react';
import { ChevronRight, Tag, X } from 'lucide-react';
import { useStore } from '../model/store';
import { buildTagIndex, tagFilterLabel, type TagFilter, type TagKeyEntry } from '../model/tags';

const VALUE_PAGE = 24;

/** Tag browser: keys → values, each click narrows the map to resources carrying that tag. */
export function TagPanel() {
  useLanguage();
  const graph = useStore((s) => s.graph);
  const tagFilters = useStore((s) => s.tagFilters);
  const tagNeighbors = useStore((s) => s.tagNeighbors);
  const { toggleTagFilter, removeTagFilter, clearTagFilters, setTagNeighbors } = useStore.getState();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [more, setMore] = useState<Record<string, number>>({});

  const index = useMemo(() => buildTagIndex(graph), [graph]);
  const f = filter.trim().toLowerCase();
  const keys = useMemo(() => index.keys.filter((k) => (showSystem || !k.system) && (!f || k.key.toLowerCase().includes(f) || k.values.some((v) => v.value.toLowerCase().includes(f)))), [index, showSystem, f]);
  const systemCount = index.keys.filter((k) => k.system).length;

  const isActive = (t: TagFilter) => tagFilters.some((x) => x.key === t.key && x.value === t.value);
  const toggleOpen = (key: string) => setOpen((s) => { const n = new Set(s); n.has(key) ? n.delete(key) : n.add(key); return n; });

  if (!graph) return null;

  return (
    <div className="tagpanel">
      {tagFilters.length > 0 && (
        <div className="tag-active">
          <div className="tag-chips">
            {tagFilters.map((t) => (
              <button key={`${t.key}=${t.value ?? ''}`} type="button" className="chip" onClick={() => removeTagFilter(t)} title={uiText("필터 제거")}>
                <Tag size={11} /> {tagFilterLabel(t)} <X size={11} />
              </button>
            ))}
          </div>
          <div className="tag-hint">{uiText("같은 키의 값은 하나만 맞아도 되고, 다른 키는 모두 맞아야 합니다.")}</div>
          <label className="tag-opt">
            <input type="checkbox" checked={tagNeighbors} onChange={(e) => setTagNeighbors(e.target.checked)} />
            {uiText("연결된 자원도 함께 표시")}</label>
          <button type="button" className="link-btn" onClick={clearTagFilters}>{uiText("모두 해제")}</button>
        </div>
      )}

      <label className="search small">
        <input type="search" placeholder={uiText("태그 키·값 찾기")} value={filter} onChange={(e) => setFilter(e.target.value)} aria-label={uiText("태그 검색")} />
      </label>

      <div className="tag-summary">{index.tagged.toLocaleString(locale())}{uiText("개 자원에 태그 · 키 ")}{index.keys.length}{uiText("개")}</div>

      <ul className="tag-keys">
        {keys.map((k) => (
          <TagKeyRow
            key={k.key}
            entry={k}
            open={open.has(k.key) || Boolean(f)}
            onToggle={() => toggleOpen(k.key)}
            isActive={isActive}
            onPick={toggleTagFilter}
            filter={f}
            limit={(more[k.key] ?? 1) * VALUE_PAGE}
            onMore={() => setMore((m) => ({ ...m, [k.key]: (m[k.key] ?? 1) + 1 }))}
          />
        ))}
      </ul>

      {systemCount > 0 && (
        <button type="button" className="link-btn tag-system" onClick={() => setShowSystem((v) => !v)} aria-pressed={showSystem}>
          {showSystem ? uiText('시스템 태그 숨기기') : uiText`시스템·이름 태그 ${systemCount}개 보기`}
        </button>
      )}
    </div>
  );
}

function TagKeyRow({ entry, open, onToggle, isActive, onPick, filter, limit, onMore }: {
  entry: TagKeyEntry; open: boolean; onToggle: () => void; isActive: (t: TagFilter) => boolean; onPick: (t: TagFilter) => void; filter: string; limit: number; onMore: () => void;
}) {
  useLanguage();
  const keyActive = isActive({ key: entry.key });
  const values = filter && !entry.key.toLowerCase().includes(filter) ? entry.values.filter((v) => v.value.toLowerCase().includes(filter)) : entry.values;
  return (
    <li className={`tag-key ${open ? 'open' : ''}`}>
      <div className="tag-key-row">
        <button type="button" className="tag-key-toggle" onClick={onToggle} aria-expanded={open} aria-label={uiText`${entry.key} 값 ${open ? uiText('접기') : uiText('펼치기')}`}>
          <ChevronRight size={13} className="tag-chev" />
          <span className="tag-key-name" title={entry.key}>{entry.key}</span>
          <span className="rail-count tnum">{entry.count}</span>
        </button>
        <button type="button" className={`tag-all ${keyActive ? 'on' : ''}`} aria-pressed={keyActive} onClick={() => onPick({ key: entry.key })} title={uiText("이 키가 있는 모든 자원")}>{uiText("전체")}</button>
      </div>
      {open && (
        <ul className="tag-values">
          {values.slice(0, limit).map((v) => {
            const t = { key: entry.key, value: v.value };
            return (
              <li key={v.value}>
                <button type="button" className={`tag-value ${isActive(t) ? 'on' : ''}`} aria-pressed={isActive(t)} onClick={() => onPick(t)} title={v.value}>
                  <span className="tag-value-name">{v.value || uiText('(빈 값)')}</span>
                  <span className="rail-count tnum">{v.count}</span>
                </button>
              </li>
            );
          })}
          {values.length > limit && <li><button type="button" className="tag-more" onClick={onMore}>{values.length - limit}{uiText("개 더 보기")}</button></li>}
        </ul>
      )}
    </li>
  );
}
