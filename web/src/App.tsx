import { useEffect } from 'react';
import { useStore } from './model/store';
import { TopBar } from './panels/TopBar';
import { Rail } from './panels/Rail';
import { Inspector } from './panels/Inspector';
import { Topology } from './canvas/Topology';
import { LoadOverlay } from './canvas/LoadOverlay';
import { TypeView } from './views/TypeView';

export default function App() {
  const bootstrap = useStore((s) => s.bootstrap);
  const view = useStore((s) => s.view);
  const graph = useStore((s) => s.graph);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);

  useEffect(() => { void bootstrap(); }, [bootstrap]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') select(undefined);
      if (e.key === '/' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); (document.querySelector('.search input') as HTMLInputElement | null)?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [select]);

  return (
    <div className={`app ${selectedId ? 'has-inspector' : ''}`}>
      <TopBar />
      <Rail />
      <main className="stage" aria-label={view === 'topology' ? '토폴로지' : '유형별 보기'}>
        {view === 'topology' ? (graph ? <Topology /> : null) : <TypeView />}
        <LoadOverlay />
        {!graph && !useStore.getState().loading.active && !useStore.getState().loading.error && (
          <div className="empty">프로필을 선택하면 수집을 시작합니다.</div>
        )}
      </main>
      {selectedId && <Inspector />}
    </div>
  );
}
