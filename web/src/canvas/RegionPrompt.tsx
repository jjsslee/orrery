import { uiText, useLanguage } from '../i18n';
import { useStore } from '../model/store';
import { Dropdown } from '../components/Dropdown';

/** Neither the profile nor a saved choice names a region: nothing is collected until one is picked. */
export function RegionPrompt() {
  useLanguage();
  const profile = useStore((s) => s.profile);
  const regions = useStore((s) => s.regions);
  const setRegion = useStore((s) => s.setRegion);

  return (
    <div className="empty">
      <div className="empty-card">
        <div className="empty-title">{uiText("리전을 고르세요")}</div>
        <div className="empty-sub">
          {uiText("프로필 ")}<span className="mono">{profile}</span>{uiText("에 기본 리전이 없습니다. 고른 리전은 다음에 열 때도 기억합니다.")}</div>
        <div className="empty-action">
          <Dropdown
            label={uiText("리전")}
            value=""
            placeholder={regions.length ? uiText('리전 선택') : uiText('리전 목록 확인 중')}
            onChange={(v) => void setRegion(v)}
            mono
            width={200}
            options={regions.map((r) => ({ value: r, label: r }))}
          />
        </div>
      </div>
    </div>
  );
}
