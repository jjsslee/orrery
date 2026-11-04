import { uiText, useLanguage } from './i18n';
import './styles/topology-guide.css';
import './styles/cleanup.css';
import { useEffect, useState } from 'react';
import { LIVE_GRAPH_MS, LIVE_STATUS_MS } from './model/live';
import { useStore } from './model/store';
import { TopBar } from './panels/TopBar';
import { Rail } from './panels/Rail';
import { Inspector } from './panels/Inspector';
import { Topology } from './canvas/Topology';
import { LoadOverlay } from './canvas/LoadOverlay';
import { RegionPrompt } from './canvas/RegionPrompt';
import { SetupGuide } from './canvas/SetupGuide';
import { Monitoring } from './views/Monitoring';
import { Cleanup } from './views/Cleanup';
import { TypeView } from './views/TypeView';
import { api } from './api/client';

export default function App() {
  const language = useLanguage();
  useEffect(() => { void api.setLanguage(language).catch(() => {}); }, [language]);
  const bootstrap = useStore((s) => s.bootstrap);
  const view = useStore((s) => s.view);
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const region = useStore((s) => s.region);
  const setup = useStore((s) => s.setup);
  const idle = useStore((s) => !s.loading.active && !s.loading.error);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const closeFilters = () => {
    setFiltersOpen(false);
    document.querySelector<HTMLButtonElement>('.filter-toggle')?.focus();
  };

  useEffect(() => { setFiltersOpen(false); }, [view]);
  useEffect(() => {
    if (filtersOpen) document.querySelector<HTMLInputElement>('.search input')?.focus();
  }, [filtersOpen]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 820px)');
    const onChange = () => setFiltersOpen(false);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  // Live mode: free status passes every LIVE_STATUS_MS and a silent full re-collect every LIVE_GRAPH_MS,
  // only while the tab is visible. CloudWatch metrics (metered) are never refreshed here.
  const live = useStore((s) => s.live);
  useEffect(() => {
    if (!live || view === 'monitoring' || view === 'cleanup') return;
    let statusTimer: ReturnType<typeof setInterval> | undefined;
    let graphTimer: ReturnType<typeof setInterval> | undefined;
    const start = () => {
      if (statusTimer) return;
      void useStore.getState().refreshStatus();
      statusTimer = setInterval(() => void useStore.getState().refreshStatus(), LIVE_STATUS_MS);
      graphTimer = setInterval(() => void useStore.getState().load(true, { silent: true }), LIVE_GRAPH_MS);
    };
    const stop = () => { if (statusTimer) clearInterval(statusTimer); if (graphTimer) clearInterval(graphTimer); statusTimer = graphTimer = undefined; };
    const onVisibility = () => (document.visibilityState === 'visible' ? start() : stop());
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [live, view]);

  // Fade the "changed" highlight after a few seconds
  const changed = useStore((s) => s.changed);
  useEffect(() => {
    const ids = Object.keys(changed);
    if (!ids.length) return;
    const t = setTimeout(() => useStore.setState({ changed: {} }), 6000);
    return () => clearTimeout(t);
  }, [changed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (filtersOpen) { e.preventDefault(); closeFilters(); }
        else select(undefined);
      }
      if (filtersOpen && e.key === 'Tab') {
        const items = [...document.querySelectorAll<HTMLElement>('.rail button, .rail input, .rail summary')].filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
      const editing = e.target instanceof HTMLElement && (e.target.matches('input, textarea, select') || e.target.isContentEditable);
      if (e.key === '/' && !editing && view !== 'monitoring' && view !== 'cleanup') {
        e.preventDefault();
        if (window.matchMedia('(max-width: 820px)').matches && !filtersOpen) setFiltersOpen(true);
        else document.querySelector<HTMLInputElement>('.search input')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select, filtersOpen, view]);

  return (
    <div className={`app ${view === 'cleanup' ? 'cleanup-app' : view === 'monitoring' ? 'monitoring-app' : selectedId ? 'has-inspector' : ''} ${filtersOpen ? 'filters-open' : ''}`}>
      <TopBar filtersOpen={filtersOpen} onToggleFilters={() => filtersOpen ? closeFilters() : setFiltersOpen(true)} />
      {view !== 'monitoring' && view !== 'cleanup' && <>
        {filtersOpen && <button type="button" className="rail-backdrop" aria-label={uiText("필터 닫기")} tabIndex={-1} onClick={closeFilters} />}
        <Rail onClose={closeFilters} />
      </>}
      <main className="stage" aria-label={view === 'cleanup' ? uiText('정리 후보') : view === 'monitoring' ? uiText('모니터링') : view === 'topology' ? uiText('토폴로지') : uiText('유형별 보기')}>
        {view === 'monitoring' ? <Monitoring /> : <>
        {view === 'cleanup' ? <Cleanup /> : view === 'topology' ? (graph ? <Topology /> : null) : <TypeView />}
        <LoadOverlay />
        {setup === 'needed' && <SetupGuide />}
        {setup === 'done' && !graph && idle && (region ? <div className="empty">{uiText("프로필을 선택하면 수집을 시작합니다.")}</div> : <RegionPrompt />)}
        </>}
      </main>
      {view !== 'monitoring' && view !== 'cleanup' && selectedId && <Inspector />}
    </div>
  );
}
