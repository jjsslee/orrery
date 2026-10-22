import { Eye, Moon, Radio, RotateCw, Sun } from 'lucide-react';
import { useStore } from '../model/store';
import { Dropdown } from '../components/Dropdown';
import { BrandMark } from '../components/Brand';
import { fmtRelative, maskAccount } from '../components/format';

const METHOD_LABEL: Record<string, string> = { static: '액세스 키', 'static (session)': '세션 키', sso: 'SSO', 'assume-role': '역할 전환', process: '외부 프로세스', 'web-identity': '웹 자격', unknown: '설정 없음' };

export function TopBar() {
  const profiles = useStore((s) => s.profiles);
  const profile = useStore((s) => s.profile);
  const region = useStore((s) => s.region);
  const regions = useStore((s) => s.regions);
  const identity = useStore((s) => s.identity);
  const graph = useStore((s) => s.graph);
  const loading = useStore((s) => s.loading);
  const view = useStore((s) => s.view);
  const theme = useStore((s) => s.theme);
  const live = useStore((s) => s.live);
  const liveBusy = useStore((s) => s.liveBusy);
  const liveStatusAt = useStore((s) => s.liveStatusAt);
  const { setProfile, setRegion, load, setView, setTheme, setLive } = useStore.getState();

  return (
    <header className="topbar">
      <div className="brand">
        <BrandMark size={22} spinning={loading.active} />
        <span className="brand-name">Orrery</span>
        <span className="brand-tag">AWS 자원 관계 지도</span>
      </div>

      <div className="topbar-center" role="tablist" aria-label="보기">
        <button type="button" role="tab" aria-selected={view === 'topology'} className={`seg ${view === 'topology' ? 'on' : ''}`} onClick={() => setView('topology')}>토폴로지</button>
        <button type="button" role="tab" aria-selected={view === 'types'} className={`seg ${view === 'types' ? 'on' : ''}`} onClick={() => setView('types')}>유형별</button>
      </div>

      <div className="topbar-right">
        <Dropdown
          label="AWS 프로필"
          value={profile}
          placeholder={profiles.length ? '프로필 선택' : '프로필 없음'}
          onChange={(v) => void setProfile(v)}
          mono
          width={210}
          options={profiles.map((p) => ({ value: p.name, label: p.name, hint: METHOD_LABEL[p.method] ?? p.method, disabled: p.method === 'unknown' }))}
        />
        <Dropdown
          label="리전"
          value={region}
          placeholder="리전 선택"
          onChange={(v) => void setRegion(v)}
          mono
          width={168}
          options={(regions.length ? regions : region ? [region] : []).map((r) => ({ value: r, label: r }))}
        />
        <div className="identity" title={identity?.arn ?? ''}>
          {identity ? <span className="mono">{maskAccount(identity.account)}</span> : <span className="muted">계정 확인 중</span>}
        </div>
        <button
          type="button"
          className={`live-toggle ${live ? 'on' : ''}`}
          role="switch"
          aria-checked={live}
          onClick={() => setLive(!live)}
          disabled={!graph}
          title="무료 호출만 사용합니다: 상태는 2분, 구성은 10분마다 갱신하고 지표는 손으로 다시 수집할 때만 읽습니다. 탭이 보이지 않으면 멈춥니다."
        >
          <Radio size={13} className={liveBusy ? 'spin' : ''} />
          <span>라이브</span>
          {live && <span className="live-dot" aria-hidden />}
          {live && liveStatusAt && <span className="live-when tnum">{fmtRelative(liveStatusAt)}</span>}
        </button>
        <button type="button" className="btn" onClick={() => void load(true)} disabled={loading.active} title="캐시를 무시하고 다시 수집합니다 (지표도 새로 읽습니다)">
          <RotateCw size={14} className={loading.active ? 'spin' : ''} />
          <span>{graph ? `다시 수집 · ${fmtRelative(graph.collectedAt)}` : '수집'}</span>
        </button>
        <span className="readonly" title="서버의 모든 AWS 호출은 Describe/List/Get 계열만 허용하는 가드를 거칩니다">
          <Eye size={13} /> 읽기 전용
        </span>
        <button type="button" className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? '라이트 테마로' : '다크 테마로'}>
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );
}
