import { useEffect } from 'react';
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
import { RequestJourney } from './views/RequestJourney';
import { TypeView } from './views/TypeView';

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const view = useStore((s) => s.view);
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const region = useStore((s) => s.region);
  const setup = useStore((s) => s.setup);
  const idle = useStore((s) => !s.loading.active && !s.loading.error);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  // Live mode: free status passes every LIVE_STATUS_MS and a silent full re-collect every LIVE_GRAPH_MS,
  // only while the tab is visible. CloudWatch metrics (metered) are never refreshed here.
  const live = useStore((s) => s.live);
  useEffect(() => {
    if (!live || view === 'monitoring' || view === 'journey') return;
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
      if (e.key === 'Escape') select(undefined);
      if (e.key === '/' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); (document.querySelector('.search input') as HTMLInputElement | null)?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select]);

  return (
    <div className={`app ${view === 'journey' ? 'journey-app' : view === 'monitoring' ? 'monitoring-app' : selectedId ? 'has-inspector' : ''}`}>
      <TopBar />
      {view !== 'monitoring' && view !== 'journey' && <Rail />}
      <main className="stage" aria-label={view === 'journey' ? '사용자 요청 흐름' : view === 'monitoring' ? '모니터링' : view === 'topology' ? '토폴로지' : '유형별 보기'}>
        {view === 'monitoring' ? <Monitoring /> : <>
        {view === 'journey' ? <RequestJourney /> : view === 'topology' ? (graph ? <Topology /> : null) : <TypeView />}
        <LoadOverlay />
        {setup === 'needed' && <SetupGuide />}
        {setup === 'done' && !graph && idle && (region ? <div className="empty">프로필을 선택하면 수집을 시작합니다.</div> : <RegionPrompt />)}
        </>}
      </main>
      {view !== 'monitoring' && view !== 'journey' && selectedId && <Inspector />}
    </div>
  );
}
