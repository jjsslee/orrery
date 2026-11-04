import { useRef } from 'react';
import { BookOpen, X } from 'lucide-react';
import { CATEGORY_LABEL } from '@orrery/shared';
import { CATEGORY_ORDER } from '../model/types';
import { StatusDot } from './StatusDot';

export function TopologyGuide() {
  const dialog = useRef<HTMLDialogElement>(null);
  return <>
    <button type="button" className="btn" aria-label="도식 가이드" onClick={() => dialog.current?.showModal()} aria-haspopup="dialog"><BookOpen size={14} aria-hidden /><span>도식 가이드</span></button>
    <dialog ref={dialog} className="topology-guide" aria-labelledby="topology-guide-title" onKeyDown={(event) => event.stopPropagation()} onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="guide-content">
        <header className="guide-header"><div><h2 id="topology-guide-title">도식 가이드</h2><p>자원과 연결 관계를 읽는 방법</p></div><button type="button" className="icon-btn" autoFocus aria-label="도식 가이드 닫기" onClick={() => dialog.current?.close()}><X size={18} /></button></header>
        <section><h3>선은 자원 사이의 관계입니다</h3>
          <dl className="guide-lines">
            <div><dt><svg aria-hidden viewBox="0 0 64 16"><path className="fedge" d="M2 8H62" /></svg>실선</dt><dd>연결·라우팅·호출 등 구성에서 확인한 관계입니다. 실제 통신 성공을 보장하지 않습니다.</dd></div>
            <div><dt><svg aria-hidden viewBox="0 0 64 16"><path className="fedge k-allows" d="M2 8H62" /></svg>빨간 점선 · 허용</dt><dd>A → B는 B의 인바운드 규칙에서 A 보안 그룹을 허용한다는 뜻입니다. 빨간색 자체는 장애 표시가 아닙니다.</dd></div>
            <div><dt><svg aria-hidden viewBox="0 0 64 16"><path className="fedge k-assumes" d="M2 8H62" /></svg>회색 점선 · 역할·암호화</dt><dd>컴퓨트 → IAM 역할, KMS 키 → 암호화 대상 자원의 관계를 나타냅니다.</dd></div>
            <div><dt><svg aria-hidden viewBox="0 0 64 16"><path className="fedge k-member" d="M2 8H62" /></svg>짧은 점선 · 구성원</dt><dd>클러스터와 서비스, 오토스케일링 그룹과 인스턴스 등의 소속 관계입니다.</dd></div>
            <div><dt>점선 · 설정 참조</dt><dd>설정에 대상 식별자가 있다는 뜻입니다. 읽기·쓰기·호출 여부나 실제 사용을 단정하지 않습니다.</dd></div>
          </dl>
          <p>선의 방향은 관계의 출발점과 대상을 나타냅니다. 자원에 마우스를 올리면 연결 관계와 상세 내용을 확인할 수 있습니다. 상태가 지정된 선은 경고·위험 색상으로 바뀔 수 있습니다.</p>
        </section>
        <section><h3>아이콘과 색상은 자원 종류를 구분합니다</h3><div className="guide-categories">{CATEGORY_ORDER.map((category) => <span key={category} className={`cat-${category}`}><i aria-hidden />{CATEGORY_LABEL[category]}</span>)}</div><p>현재 아이콘은 Lucide, 색상은 Orrery의 카테고리 팔레트입니다. AWS 공식 아키텍처 아이콘·색상 세트를 사용하지 않습니다.</p></section>
        <section><h3>상태 점과 경보 숫자</h3><div className="guide-statuses">{(['healthy', 'warning', 'critical', 'inactive', 'unknown'] as const).map((status) => <StatusDot key={status} status={status} showLabel />)}</div><p>노드의 점은 수집된 자원 상태, 숫자 배지는 연결된 경보 수입니다. 상태 미확인은 정상 판정이 아닙니다.</p></section>
        <section><h3>영역·활동·미확인 정보</h3><ul><li>VPC·서브넷 영역은 확인된 소속 또는 연결 설정을 나타냅니다. Lambda·EKS 제어 평면 등의 물리적 실행 위치를 뜻하지 않습니다. 상세 패널의 ‘배치 근거’를 함께 확인하세요.</li><li>글로벌 자원, 리전·논리 자원, 위치 미확인·복수 범위를 구분합니다. ECS 클러스터는 논리적 묶음이며 서비스의 실행 위치는 별도로 확인합니다.</li><li>필터로 VPC를 숨겨도 표시 중인 자원의 소속 영역은 유지합니다. 묶음은 여러 자원의 요약입니다.</li><li>‘자원 활동’은 CloudWatch에서 얻은 자원별 상대 지표입니다. 양 끝 자원의 활동량으로 관계선의 통신량을 추정하거나 조회 전 점선을 움직이지 않습니다.</li><li>등록 IP 타깃은 등록 주소·포트·헬스를 확인한 대상입니다. 실제 EC2/ECS 자원이나 VPC가 확인됐다는 뜻은 아닙니다.</li><li>조회 실패·미수집 정보는 왼쪽 하단 ‘수집 누락·주의’에서 확인합니다. 선이 없다는 사실은 연결·사용이 없다는 증거가 아닙니다.</li><li>흐린 점선 테두리와 ‘숨김’은 선택 자원의 숨겨진 이웃입니다. 장애 표시가 아닙니다.</li></ul></section>
        <section><h3>이 지도가 설명하는 범위</h3><p>AWS 구성에서 수집한 소속·등록 대상·라우팅·참조 관계를 표시합니다. 실제 요청 추적이나 통신 가능성 검증은 아닙니다. 보안 그룹 허용선만으로 NACL·라우팅·애플리케이션 권한까지 허용됐다고 판단할 수 없습니다.</p><p>ALB listener rule의 조건·우선순위·가중치, CloudFront 경로별 오리진, private zone VPC, Cloud Map 등록 대상, Lambda EFS·ECR, VPC Endpoint와 OpenSearch Serverless 정책 관계를 수집합니다. 긴 조건은 상세 패널에서 확인하세요. 구성 연결 대상은 설정에 나온 식별자이며, 해당 자원의 상세가 수집됐다는 뜻은 아닙니다. 정책 관계만으로 실제 접근 성공이나 IAM·NACL의 종합 허용 여부를 판정하지 않습니다.</p></section>
        <section><h3>모니터링에서 관계를 함께 볼 때</h3><p>현재 확인·시간 경과·재확인 실패·부재 확인을 구분하고, 과거 관계는 별도 목록으로 표시합니다. ‘조회 근거’에서 원본 조회와 마지막 확인 시각을 볼 수 있습니다. 구성 경로는 최대 3단계이며 실제 요청 흐름이 아닙니다.</p><p>Target Group은 연결 ALB를 직접 선택한 뒤 지표 비교에 추가합니다. ALB·Target Group·EC2 지표는 각각 자원 전체의 값으로, 특정 경로나 ECS 서비스에 모두 귀속되지 않습니다. 구성 변화의 음영은 두 관측 사이의 구간이며 실제 배포 시각이나 장애 원인을 뜻하지 않습니다.</p></section>
        <footer>닫기 버튼 또는 Esc로 돌아갈 수 있습니다.</footer>
      </div>
    </dialog>
  </>;
}
