import { useRef } from 'react';
import { BookOpen, X } from 'lucide-react';
import { CATEGORY_LABEL } from '@orrery/shared';
import { CATEGORY_ORDER } from '../model/types';
import { StatusDot } from './StatusDot';

export function TopologyGuide() {
  const dialog = useRef<HTMLDialogElement>(null);
  return <>
    <button type="button" className="btn" onClick={() => dialog.current?.showModal()} aria-haspopup="dialog"><BookOpen size={14} aria-hidden /><span>도식 가이드</span></button>
    <dialog ref={dialog} className="topology-guide" aria-labelledby="topology-guide-title" onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="guide-content">
        <header className="guide-header"><div><h2 id="topology-guide-title">도식 가이드</h2><p>자원과 연결 관계를 읽는 방법</p></div><button type="button" className="icon-btn" autoFocus aria-label="도식 가이드 닫기" onClick={() => dialog.current?.close()}><X size={18} /></button></header>
        <section><h3>선은 자원 사이의 관계입니다</h3>
          <dl className="guide-lines">
            <div><dt><svg aria-hidden viewBox="0 0 64 16"><path className="fedge" d="M2 8H62" /></svg>실선</dt><dd>연결·라우팅·호출·접근 등 구성에서 확인한 관계입니다. 실제 통신 성공을 보장하지 않습니다.</dd></div>
            <div><dt><svg aria-hidden viewBox="0 0 64 16"><path className="fedge k-allows" d="M2 8H62" /></svg>빨간 점선 · 허용</dt><dd>A → B는 B의 인바운드 규칙에서 A 보안 그룹을 허용한다는 뜻입니다. 빨간색 자체는 장애 표시가 아닙니다.</dd></div>
            <div><dt><svg aria-hidden viewBox="0 0 64 16"><path className="fedge k-assumes" d="M2 8H62" /></svg>회색 점선 · 역할·암호화</dt><dd>컴퓨트 → IAM 역할, KMS 키 → 암호화 대상 자원의 관계를 나타냅니다.</dd></div>
            <div><dt><svg aria-hidden viewBox="0 0 64 16"><path className="fedge k-member" d="M2 8H62" /></svg>짧은 점선 · 구성원</dt><dd>클러스터와 서비스, 오토스케일링 그룹과 인스턴스 등의 소속 관계입니다.</dd></div>
          </dl>
          <p>선의 방향은 관계의 출발점과 대상을 나타냅니다. 자원에 마우스를 올리면 연결 관계와 상세 내용을 확인할 수 있습니다. 상태가 지정된 선은 경고·위험 색상으로 바뀔 수 있습니다.</p>
        </section>
        <section><h3>아이콘과 색상은 자원 종류를 구분합니다</h3><div className="guide-categories">{CATEGORY_ORDER.map((category) => <span key={category} className={`cat-${category}`}><i aria-hidden />{CATEGORY_LABEL[category]}</span>)}</div><p>현재 아이콘은 Lucide, 색상은 Orrery의 카테고리 팔레트입니다. AWS 공식 아키텍처 아이콘·색상 세트를 사용하지 않습니다.</p></section>
        <section><h3>상태 점과 경보 숫자</h3><div className="guide-statuses">{(['healthy', 'warning', 'critical', 'inactive', 'unknown'] as const).map((status) => <StatusDot key={status} status={status} showLabel />)}</div><p>노드의 점은 수집된 자원 상태, 숫자 배지는 연결된 경보 수입니다. 상태 미확인은 정상 판정이 아닙니다.</p></section>
        <section><h3>움직임·영역·숨김 표시</h3><ul><li>트래픽을 켜면 CloudWatch 지표에 비례해 선 위의 입자가 움직입니다. 개별 연결의 실제 패킷을 추적하는 표시는 아닙니다.</li><li>지표 조회 전 흐르는 점선은 관계 방향을 보여주는 대기 효과입니다. 트래픽이 측정되었다는 뜻이 아닙니다.</li><li>큰 영역은 리전·VPC·서브넷 등의 포함 범위입니다. 묶음 노드는 여러 자원을 요약합니다.</li><li>흐린 점선 테두리와 ‘숨김’ 표시는 선택한 자원과 연결되어 잠시 드러난 숨겨진 자원입니다. 장애 표시가 아닙니다.</li><li>하단 도구에서 보안 그룹·IAM 역할·KMS 키 등의 표시를 켜고 끌 수 있습니다.</li></ul></section>
        <footer>닫기 버튼 또는 Esc로 돌아갈 수 있습니다.</footer>
      </div>
    </dialog>
  </>;
}
