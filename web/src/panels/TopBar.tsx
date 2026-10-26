import { Activity, Eye, Moon, Radio, RotateCw, Sun } from 'lucide-react';
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
  const statusError = useStore((s) => s.statusError);
  const metricsLoading = useStore((s) => s.metricsLoading);
  const liveStatusAt = useStore((s) => s.liveStatusAt);
  const { setProfile, setRegion, load, setView, setTheme, setLive, loadMetrics, reconnect } = useStore.getState();

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
        <button type="button" role="tab" aria-selected={view === 'monitoring'} className={`seg ${view === 'monitoring' ? 'on' : ''}`} onClick={() => setView('monitoring')}>모니터링</button>
      </div>

      <div className="topbar-spacer" />

      <div className="topbar-right">
        <div className="conn" role="group" aria-label="AWS 연결">
          <Dropdown
            label="AWS 프로필"
            value={profile}
            placeholder={profiles.length ? '프로필 선택' : '프로필 없음'}
            onChange={(v) => void setProfile(v)}
            mono
            width={184}
            options={profiles.map((p) => ({ value: p.name, label: p.name, hint: METHOD_LABEL[p.method] ?? p.method, disabled: p.method === 'unknown' }))}
          />
          <Dropdown
            label="리전"
            value={region}
            placeholder="리전 선택"
            onChange={(v) => void setRegion(v)}
            mono
            width={156}
            options={(regions.length ? regions : region ? [region] : []).map((r) => ({ value: r, label: r }))}
          />
          <div className="identity" title={identity?.arn ?? ''}>
            {identity ? <span className="mono identity-account">{maskAccount(identity.account)}</span> : <span className="muted identity-account">계정 확인 중</span>}
            <button type="button" className="link-btn" onClick={() => void reconnect()} disabled={!profile || loading.active} title="AWS 자격증명과 계정을 다시 확인하고 캐시를 분리합니다">다시 연결</button>
          </div>
        </div>
        {view !== 'monitoring' && <>
        <span className="topbar-sep" aria-hidden />
        <button
          type="button"
          className={`live-toggle ${live ? 'on' : ''}`}
          role="switch"
          aria-checked={live}
          onClick={() => setLive(!live)}
          disabled={!graph}
          title="상태는 2분, 구성은 10분마다 갱신합니다. CloudWatch 지표는 전체 지표 조회 버튼으로만 읽으며 비용이 발생할 수 있습니다. 탭이 보이지 않으면 멈춥니다."
        >
          <Radio size={13} className={liveBusy ? 'spin' : ''} />
          <span className="live-label">라이브</span>
          {live && <span className="live-dot" aria-hidden />}
          {live && liveStatusAt && <span className="live-when tnum">{fmtRelative(liveStatusAt)}</span>}
        </button>
        {statusError && <span role="status" className="muted" title={statusError}>조회 문제 · 이전 상태 포함</span>}
        <button type="button" className="btn" onClick={() => void loadMetrics(true)} disabled={!graph || metricsLoading} aria-label={metricsLoading ? '지표 조회 중' : '전체 지표 조회'} title="현재 구성의 전체 자원 CloudWatch 지표를 조회합니다. 비용이 발생할 수 있습니다."><Activity size={14} className={metricsLoading ? 'spin' : ''} aria-hidden /><span>{metricsLoading ? '지표 조회 중' : '전체 지표 조회'}</span></button>
        <button type="button" className="btn" onClick={() => void load(true)} disabled={loading.active} aria-label={graph ? `다시 수집 · ${fmtRelative(graph.collectedAt)}` : '수집'} title="캐시를 무시하고 구성을 다시 수집합니다">
          <RotateCw size={14} className={loading.active ? 'spin' : ''} />
          <span>{graph ? `다시 수집 · ${fmtRelative(graph.collectedAt)}` : '수집'}</span>
        </button>
        </>}
        <span className="topbar-sep" aria-hidden />
        <span className="readonly" title="서버의 모든 AWS 호출은 Describe/List/Get 계열만 허용하는 가드를 거칩니다">
          <Eye size={13} aria-hidden /><span className="readonly-text">읽기 전용</span>
        </span>
        <button type="button" className="icon-btn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? '라이트 테마로' : '다크 테마로'}>
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );
}
