import { useEffect, useRef, useState } from 'react';
import { Check, FolderOpen, Minus, Plus, Save, Trash2, X } from 'lucide-react';
import { MAX_OBSERVED, useMonitoring } from '../model/monitoring';
import { TYPE_META } from '../model/types';
import { TypeBadge } from '../components/TypeIcon';

/** Adds a resource to the observed set or takes it back out; the same control everywhere a resource is offered. */
export function SelectToggle({ resourceKey, name }: { resourceKey: string; name: string }) {
  const m = useMonitoring();
  const selected = m.selectedResources.includes(resourceKey);
  const full = !selected && m.selectedResources.length >= MAX_OBSERVED;
  return <button
    type="button"
    className={`mw-toggle ${selected ? 'is-on' : ''}`}
    aria-label={`${name} ${selected ? '빼기' : '추가'}`}
    disabled={full}
    title={full ? `최대 ${MAX_OBSERVED}개까지 함께 봅니다. 하나를 빼면 추가할 수 있습니다.` : selected ? '함께 보기에서 뺍니다' : '함께 보기에 추가합니다'}
    onClick={() => m.toggleResource(resourceKey)}
  >{selected ? <Minus size={13} aria-hidden /> : <Plus size={13} aria-hidden />}{selected ? '빼기' : '추가'}</button>;
}

/** Brings an observed resource's card into view; with up to eight cards the chip doubles as navigation. */
function showCard(key: string) {
  const card = document.querySelector<HTMLElement>(`.mw-card[data-resource-key="${CSS.escape(key)}"]`);
  if (!card) return;
  // On wide screens the tray sticks to the top of the column; land the card just below it.
  const tray = document.querySelector<HTMLElement>('.mw-tray');
  card.style.scrollMarginTop = `${tray && getComputedStyle(tray).position === 'sticky' ? tray.offsetHeight + 12 : 4}px`;
  card.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/** Closes a popover on an outside press or Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

/** The observed set: what the CloudWatch cards below show, which one anchors the related list, and saved sets. */
export function MonitoringSelection() {
  const m = useMonitoring();
  const [saveOpen, setSaveOpen] = useState(false), [name, setName] = useState(''), [savedName, setSavedName] = useState('');
  const [groupsOpen, setGroupsOpen] = useState(false);
  const closeGroups = useRef(() => setGroupsOpen(false)).current;
  const groupsRef = useDismiss(groupsOpen, closeGroups);
  const all = m.resources?.resources ?? [];
  const selected = m.selectedResources.map((key) => ({ key, resource: all.find((resource) => resource.key === key) }));
  const save = () => {
    if (!name.trim()) return;
    m.saveSelection(name.trim());
    if (!useMonitoring.getState().groupsError) { setSavedName(name.trim()); setName(''); setSaveOpen(false); }
  };
  return <section className="mw-tray" aria-label="선택한 자원">
    <div className="mw-tray-head">
      <div className="mw-tray-title">
        <h2>함께 보는 자원 <span className="mw-count tnum">{selected.length}/{MAX_OBSERVED}</span></h2>
        <span className="mw-slots" role="img" aria-label={`${MAX_OBSERVED}개 중 ${selected.length}개 사용`}>{Array.from({ length: MAX_OBSERVED }, (_, i) => <span key={i} className={i < selected.length ? 'on' : ''} />)}</span>
      </div>
      <div className="mw-tray-actions">
        <button type="button" className="btn ghost small" disabled={!selected.length} aria-expanded={saveOpen} onClick={() => { setSaveOpen(!saveOpen); setSavedName(''); }}><Save size={13} aria-hidden />구성 저장</button>
        <div className="mw-groups" ref={groupsRef}>
          <button type="button" className="btn ghost small" aria-expanded={groupsOpen} aria-haspopup="true" onClick={() => setGroupsOpen(!groupsOpen)}><FolderOpen size={13} aria-hidden />저장한 구성{m.groups.length ? <span className="mw-count tnum">{m.groups.length}</span> : null}</button>
          {groupsOpen && <div className="mw-groups-pop" role="dialog" aria-label="저장한 구성">
            {!m.groups.length ? <p className="mw-hint">저장한 구성이 없습니다. 자원을 고른 뒤 <b>구성 저장</b>을 누르면 이 계정·리전에 기억합니다.</p> : <ul>{m.groups.map((group) => <li key={group.id}>
              <button type="button" className="mw-group-load" onClick={() => { setGroupsOpen(false); void m.restoreGroup(group.id); }}>
                <strong>{group.name}</strong>
                <small>자원 {group.resourceKeys.length}개{group.tagFilters.length ? ` · 태그 조건 ${group.tagFilters.length}개` : ''}</small>
              </button>
              <button type="button" className="icon-btn" aria-label={`${group.name} 구성 삭제`} title="구성 삭제" onClick={() => { if (window.confirm(`'${group.name}' 구성을 삭제할까요? 저장한 설정만 지워지며 AWS 자원은 바뀌지 않습니다.`)) m.deleteGroup(group.id); }}><Trash2 size={14} aria-hidden /></button>
            </li>)}</ul>}
          </div>}
        </div>
      </div>
    </div>

    {selected.length ? <ul className="mw-chips">{selected.map(({ key, resource }) => {
      const label = resource?.name ?? '찾을 수 없는 자원';
      const reference = m.referenceResource === key;
      return <li key={key} className={`mw-chip ${reference ? 'is-reference' : ''}`}>
        <button type="button" className="mw-chip-main" aria-pressed={reference} aria-label={`${label} 관련 자원 보기`} title="이 자원 기준으로 관련 자원을 찾고, 아래 카드로 이동합니다" onClick={() => { m.setReferenceResource(key); showCard(key); }}>
          {resource && <TypeBadge type={resource.type} size="s" />}
          <span className="mw-chip-name">{label}</span>
          {reference && <span className="mw-chip-ref">기준</span>}
        </button>
        <button type="button" className="mw-chip-remove" aria-label={`${label} 빼기`} title="함께 보기에서 빼기" onClick={() => m.toggleResource(key)}><X size={14} aria-hidden /></button>
      </li>;
    })}</ul> : <p className="mw-tray-empty">왼쪽 검색 결과나 오른쪽 관련 자원에서 <b>추가</b>를 누르세요. 최대 {MAX_OBSERVED}개를 같은 시간대로 비교합니다.</p>}
    {selected.length >= MAX_OBSERVED ? <p className="mw-tray-room is-full" role="status">{MAX_OBSERVED}개가 모두 찼습니다. 다른 자원을 보려면 위에서 하나를 빼세요.</p>
      : selected.length > 0 && <p className="mw-tray-room">{MAX_OBSERVED - selected.length}개 더 추가할 수 있습니다 (최대 {MAX_OBSERVED}개).</p>}

    {saveOpen && <form className="mw-save-form" onSubmit={(e) => { e.preventDefault(); save(); }}>
      <label><span>구성 이름</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="예: 위키 수집 파이프라인" /></label>
      <button type="submit" className="btn primary small" disabled={!name.trim()}>저장</button>
      <button type="button" className="btn ghost small" onClick={() => setSaveOpen(false)}>취소</button>
    </form>}
    {savedName && <p className="mw-save-success" role="status"><Check size={13} aria-hidden />'{savedName}' 구성을 저장했습니다.</p>}
    {m.groupsError && <p className="monitor-notice" role="alert">{m.groupsError}</p>}
    {m.restoreNotice && <p className="monitor-notice" role="status">{m.restoreNotice}</p>}
    {!!m.restoreCandidates.length && <div className="mw-restore-candidates" aria-label="저장 구성의 선택 후보">
      <p className="mw-hint">저장한 대상 중 최대 {MAX_OBSERVED}개를 골라 추가하세요.</p>
      <ul className="mw-list">{m.restoreCandidates.map((key) => {
        const resource = all.find((item) => item.key === key);
        return <li key={key} className={`mw-row ${m.selectedResources.includes(key) ? 'is-selected' : ''}`}>
          {resource && <TypeBadge type={resource.type} />}
          <div className="mw-row-main"><strong className="mw-row-name">{resource?.name ?? '찾을 수 없는 자원'}</strong><span className="mw-row-meta">{resource ? TYPE_META[resource.type].label : key}</span></div>
          <SelectToggle resourceKey={key} name={resource?.name ?? key} />
        </li>;
      })}</ul>
    </div>}
    {!!m.restoreMissingKeys.length && <details className="mw-missing"><summary>복원하지 못한 자원 {m.restoreMissingKeys.length}개</summary><ul>{m.restoreMissingKeys.map((key) => <li key={key} className="mono">{key}</li>)}</ul></details>}
  </section>;
}
