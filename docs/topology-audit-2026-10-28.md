# 토폴로지 정확성·설명력 검토 — 2026-10-28

## 결론

현재 토폴로지는 수집된 자원을 탐색하는 데는 유용하지만, 자원의 실제 위치·소속·연결을 완전하게 설명하는 지도라고 보기 어렵다. ECS 한 서비스의 위치 오류가 아니라 **미확인 위치를 리전 자원과 합치는 모델, 부분 수집 실패를 성공으로 보고하는 방식, 근거가 다른 관계를 같은 선으로 표현하는 방식**에서 반복되는 문제다.

이번 작업은 전체 검토와 읽기 전용 검증이다. 아래 토폴로지 오류를 일괄 수정하거나 새 릴리즈를 게시하지 않았다. 검토 시작 전 진행된 ARN 복사 권한 수정·실패 안내와 도식 가이드 설명 보완은 별도 미커밋 변경이다.

## 범위와 증거

- 기준 소스: `f680383`(v0.8.0) 및 작업 폴더의 기존 ARN 복사 수정. 등록된 26개 수집기 실행 단위, 그래프 조립, 상태 병합, 지도 필터·묶음·배치·선 렌더링, hover/상세/가이드/실패 안내를 대조했다.
- 실제 화면 기준: 설치 앱의 2026-10-28 **10:37:40 KST** 캐시. 자원 **1,353개 / 40종**, 관계 **1,294개**. 이 캐시는 검토 증거이며 현재 AWS 상태와 동일하다고 가정하지 않았다.
- 실조회: 같은 계정의 `ap-northeast-2`, **10:55 KST 이후**. ECS·EC2·ASG·서브넷·라우트 테이블·SG·RDS·ElastiCache·EFS·ELB 구성과 필요한 상세 연결만 조회했다. AWS 변경, CloudWatch 지표·로그 본문·시크릿 값·환경 변수 값 조회는 하지 않았다.
- 주요 실조회 범위: ECS 클러스터 목록 9개, EC2 139개, SG 110개, 서브넷 59개, 라우트 테이블 42개, ASG 5개, RDS 인스턴스 8개·클러스터 5개, EFS 4개, LB 22개·타깃 그룹 120개. IP 타깃 그룹 41개의 등록 타깃을 대조했다.
- 기본 ECS 서비스 수집과 같은 일괄 방식에서 상세를 얻은 서비스 43개 중 22개에 awsvpc 설정이 없었다. 태스크 정의 22개에서 host 9개 / bridge 13개를 확인했다. 실행 태스크·컨테이너 인스턴스·EC2까지 추적해 **실행 서비스 20개(host 8 / bridge 12)**가 같은 VPC에 속함을 확인했다. 나머지 2개는 실행 수 0이므로 현재 호스트 위치를 확정하지 않았다.
- 기존 테스트 **186개**(server 109 / web 74 / desktop 3)는 통과했다. 별도 합성 데이터로 아래 **16개 잘못된 동작**을 재현했다. 기존 테스트 통과가 토폴로지의 의미적 정확성을 보장하지 못한다.
- 권한이 거부된 자원은 다른 프로필로 우회하지 않았다. 전체 AWS 계정·리전·미지원 서비스의 완전한 감사를 의미하지 않는다. 캐시와 실조회 사이의 구성 변경 가능성은 남는다.

## 우선 수정할 문제

### 1. ECS host/bridge 서비스의 실행 위치 누락 — P1, 실제 확인

**현상:** ECS 서비스의 `awsvpcConfiguration.subnets`만으로 VPC를 정한다. host/bridge 서비스는 이 필드가 없으므로 VPC 없이 생성된다.

- TMS-STG의 `tms-club-lounge-manager-stg-service2`뿐 아니라 실행 중인 서비스 20개가 동일한 패턴이다.
- TMS-STG의 해당 서비스는 EC2 `i-0abf6254decfd0368`, 서브넷 `subnet-03b48ab5c9de61c3f`, VPC `vpc-0badb094f4124fedc`에서 실행된다.
- 기존 캐시의 ECS 서비스 75개 중 54개에 parentId가 없다. **54개 전체가 host/bridge 오류인 것은 아니다:** 22개는 상세 수집된 비-awsvpc 서비스, 32개는 접근 거부로 대체된 노드다.
- ECS 클러스터 자체를 리전의 논리적 묶음으로 표시하는 것은 타당하다. 서비스와 클러스터를 연결하는 `member`는 실행 트래픽이 아닌 소속 관계다.

**원인:** `server/src/collectors/ecs.ts:132,159`, `web/src/layout/scene.ts:202`.

**수정 기준:** 실행 태스크 → 컨테이너 인스턴스 → EC2 → VPC/서브넷을 대조한다. 실행 수 0, 조회 거부, 여러 VPC에 걸친 배치는 각각 구분한다. 임의로 클러스터의 첫 서비스 VPC를 복사하지 않는다. awsvpc의 설정 서브넷과 실제 실행 태스크의 위치도 구분한다.

### 2. 일괄 조회 실패가 다른 ECS 서비스까지 접근 거부로 만든다 — P1, 실제 재현

**현상:** DescribeServices를 10개씩 호출하고 실패하면 묶음 전체를 `ACCESS_DENIED` 노드로 바꾼다. 원인을 권한 거부로 단정하므로 throttling/일시 장애에도 같은 표시가 가능하다.

- 캐시에서 접근 거부로 표시한 **32개 중 8개는 개별 조회 성공**, 24개는 개별 조회도 거부됐다.
- TMS-PRD의 `tms-scrap-kakao-westin-prod-family-service`는 개별 조회가 가능하다. 같은 클러스터의 거부된 서비스와 두 개를 묶으면 일괄 호출이 실패하는 것을 재현했다.
- 복구 가능한 8개 중 1개는 awsvpc 설정이 있어 VPC 배치도 회복할 수 있다. 나머지 7개의 현재 실행 위치는 이번 개별 조회 단계에서 추가 확정하지 않았다.

**원인:** `server/src/collectors/ecs.ts:108` 부근의 일괄 실패 처리. CodeBuild에는 이미 개별 재시도가 있으나 ECS에는 없다.

**수정 기준:** 자원별 거부가 일괄 요청을 실패시키는 경우 제한된 개별 재조회로 범위를 분리한다. 응답의 `failures`도 처리한다. 네트워크 오류·권한 거부·삭제됨을 같은 상태로 표현하지 않는다.

### 3. 보안 그룹의 VPC 소속을 버린다 — P1, 실제 확인

**현상:** 보안 그룹 **110개 모두** AWS 응답과 캐시 속성에 VPC가 있으나 parentId가 없다. 보안 그룹 레이어를 켜면 모두 리전 영역으로 배치된다. 기본 레이어가 꺼져 있다고 문제가 없어지는 것은 아니다.

**원인:** `server/src/collectors/security.ts:72` 부근에서 `props.VPC`만 저장하고 소속을 지정하지 않는다.

**수정 기준:** 보안 그룹은 확인된 VPC 아래에 둔다. SG → SG 허용선은 규칙의 참조 관계이며 전체 통신 가능성의 증거가 아니라는 설명을 유지한다. CIDR/Prefix List/egress/NACL/라우팅은 현재 선의 범위 밖이다.

### 4. 위치 미확인·권한 거부·리전 자원·글로벌 자원을 한 영역에 섞는다 — P1, 실제 및 합성 재현

**현상:** parentId가 없으면 무조건 `카테고리 · 리전 서비스`로 보낸다.

- EFS 4개 중 3개는 파일 시스템 응답에서 마운트 타깃 2개가 확인되지만, `DescribeMountTargets`가 거부돼 VPC·연결선이 없다. **VPC 미사용이 아니라 위치 조회 실패**다. 실제 VPC는 이번 권한 범위에서 확정하지 않았다.
- CodeBuild 5개 중 3개는 상세 미수집 상태다. VPC 연결 여부를 알 수 없는데 리전 영역에 표시한다.
- 글로벌 자원 204개도 리전 서비스로 묶인다. CloudFront·Route 53·IAM 등의 범위가 라벨과 맞지 않는다.
- 조립기는 부모 노드가 수집되지 않으면 parentId를 지운다. 어떤 VPC였는지 알고 있었어도 미확인 원인이 사라진다.
- VPC/서브넷을 필터로 숨기면 그 안의 자원이 리전 영역으로 이동한다. **표시 필터가 소속의 의미를 바꾸는 것**이다.

**원인:** `server/src/collectors/efs.ts:21,31`, `server/src/collectors/codebuild.ts:59`, `server/src/graph/assemble.ts:44`, `web/src/layout/scene.ts:202,295`.

**수정 기준:** 자원의 범위(global/regional/logical), 배치 증거(확인/설정/미확인/복수), 미확인 사유를 데이터로 보존한다. 미수집 부모는 이름/ID만 있는 경계로 남기고, 필터 적용 시 ‘부모 영역 숨김’을 표시한다. 이름만 바꾸는 것으로 해결하지 않는다.

### 5. 부분 수집 실패와 끊어진 관계가 성공으로 숨는다 — P1, 실제 및 합성 재현

**현상:** `attempt()`가 실패를 로그로만 남기고 undefined를 반환한다. 바깥 수집기는 정상 반환했으므로 `ok: true`다. 사용자는 관계가 없는 것인지 조회하지 못한 것인지 알 수 없다.

- 캐시의 수집기 보고에는 실패가 0개인데 ECS 클러스터 9개·서비스 32개는 접근 거부, EFS 3개는 마운트 조회 거부다.
- 조립 단계에서 **7개 관계를 제외했다는 메시지**를 `ok: true, error: ...`로 기록한다. Rail은 `!ok`만 표시하므로 이 경고도 보이지 않는다.
- 한 네트워크 API 실패 시 VPC/서브넷까지 포함한 network 수집 결과 전체가 없어지는 상황을 재현했다. 이후 다른 수집기의 부모가 연쇄적으로 제거된다.

**원인:** `server/src/collectors/util.ts:23`, `server/src/collectors/index.ts:36`, `server/src/collectors/network.ts:44`, `server/src/graph/assemble.ts:70`, `web/src/panels/Rail.tsx:142`.

**수정 기준:** complete/partial/failed를 구분하고 자원·관계별 누락 원인과 관측 시각을 표시한다. 부분 실패를 ‘정상 0개’로 표현하지 않는다. 복합 수집기는 성공한 결과를 보존한다.

### 6. NAT 라우트 목적지를 잘못 설명한다 — P1, 실제 확인

**현상:** 모든 NAT 관계선의 라벨을 `0.0.0.0/0`으로 고정한다. 실제 라우트 목적지와 blackhole 상태를 보존하지 않는다.

- 실제 `rtb-04419b461fc69ff2a`에는 NAT로 가는 **특정 목적지 /32 라우트 4개**가 있다.
- 이 테이블에 연결된 서브넷 2개는 지도에서 각각 `0.0.0.0/0` NAT 관계로 표시된다. 일반 인터넷 기본 경로가 있는 것으로 오해할 수 있다.
- 합성 데이터의 blackhole NAT 경로도 정상 라우팅 관계처럼 표시되는 것을 재현했다.

**원인:** `server/src/collectors/network.ts:35,102`.

**수정 기준:** 실제 DestinationCidrBlock/IPv6/Prefix List와 State를 보존한다. 정책 경로·설정 경로를 실제 도달 가능성으로 설명하지 않는다. 현재 실조회에서 TGW 목적 라우트 41개도 확인됐으나 VPC–TGW attachment만 표현하고 서브넷 경로는 보여주지 않는다. 이는 별도 지원 범위로 명시해야 한다.

### 7. 등록된 IP 타깃이 사라져 LB 연결이 끊겨 보인다 — P1, 실제 확인

**현상:** ELB 수집기는 IP 타깃을 건너뛰고 ECS 서비스 설정에서 연결이 만들어지기를 기대한다. ECS 조회 실패 또는 ECS가 아닌 IP 대상이면 표시되지 않는다.

- IP 타깃 그룹 41개 중 **11개**는 실제 정상 타깃이 각각 1개 등록돼 있으나 기준 캐시에는 타깃 그룹에서 대상 노드로 나가는 `targets` 선이 없다.
- TG 레이어를 끄면 LB → TG → 대상 중 끝이 없는 경로는 지도에서 연결선 자체가 사라진다. ‘등록된 대상이 없는 LB’처럼 읽힐 수 있다.
- TG를 접을 때 앞쪽 LB→TG의 상태를 버리고 뒤쪽 선의 상태만 사용한다. 앞쪽이 critical, 뒤쪽이 상태 미지정일 때 상태가 사라지는 것을 합성 재현했다. 해당 조합은 이번 실제 캐시에는 없었다.

**원인:** `server/src/collectors/elb.ts:133`, `server/src/collectors/ecs.ts:182`, `web/src/layout/scene.ts:117`.

**수정 기준:** 확인된 IP 타깃을 ‘대상 IP · 자원 식별 미완료’로 보존한다. ECS 매핑은 추가 증거이며 등록 여부/헬스 상태의 대체물이 아니다. 접힌 선에 경유 TG·관측 범위·상태를 유지한다.

### 8. 이름 기반 추정이 다른 계정·리전 자원을 잘못 연결한다 — P1, 합성 재현 / 실제 발생 수 미확정

**현상:** ARN 정확 일치가 실패하면 계정·리전을 확인하지 않고 이름으로 현재 지도 자원에 연결한다. SQS URL과 ECR 이미지도 이름만으로 fallback한다.

- 다른 계정·리전의 `orders` SQS ARN을 현재 계정의 동명 큐로 연결하는 것을 재현했다.
- 환경 변수의 평문 `orders`가 동명 S3와 DynamoDB를 동시에 연결하는 것을 재현했다.
- 환경 변수, 정확한 설정 ARN, 실제 구독, 보안 참조가 모두 동일한 종류의 선이 된다. source field·추정 근거·신뢰 수준이 남지 않는다.
- 대상이 큐라는 이유만으로 `publishes`를 정하는 방식은 소비용 큐 URL까지 발행 관계로 설명할 수 있다. DynamoDB는 읽기/쓰기를 구분할 근거가 없는데 `reads`로 분류한다.

**원인:** `server/src/graph/assemble.ts:112,140,148,156,163`, 각 수집기의 `refs: string[]`.

**수정 기준:** ARN·계정·리전·리소스 종류를 함께 비교한다. 외부 자원은 외부로 표시한다. 평문 이름은 문맥이 확정하지 않으면 ‘설정 참조’로 분리한다. 구독/호출 설정/소속/보안 허용/추정 참조를 서로 다른 의미로 보존한다. 실제 데이터의 환경 변수 값까지 열어 추정 오연결 건수를 세지는 않았다.

### 9. 연결을 알아낼 수 있는 식별자를 수집·해석하지 못한다 — P2, 코드 확인 및 일부 합성 재현

- API Gateway HTTP VPC Link의 IntegrationUri는 LB listener ARN 또는 Cloud Map ARN일 수 있다. 현재 수집기는 Lambda/HTTP host 중심이라 listener 연결이 누락된다. 알려진 LB가 있어도 listener ARN은 연결되지 않는 것을 재현했다.
- CloudFront/API Gateway의 사용자 정의 도메인은 bare hostname으로 refs에 들어오는데 resolver의 DNS 처리는 AWS 도메인 또는 HTTP URL 위주다. 이미 DNS 인덱스에 있는 `service.example.test`도 bare hostname일 때 연결되지 않는 것을 재현했다.
- EC2의 instance profile 이름을 IAM role 이름으로 간주한다. 실제 role을 확인하는 GetInstanceProfile 매핑이 없다. 이번 계정에서는 동명 role 노드가 모두 있었으나 그것만으로 profile-role 동일성을 확정할 수 없으며 이번에는 실제 IAM 매핑까지 읽지 않았다.
- EKS managed node group의 ASG/EC2 연결은 수집하지 않고 개수만 요약한다. Cloud Map 등록 인스턴스의 실제 대상도 수집하지 않는다.
- Lambda EFS access point ARN과 EFS 파일 시스템 ID는 다른데 access point → filesystem 매핑이 없다. 이미지 패키지 Lambda의 ECR 참조도 ListFunctions만으로는 얻지 않는다.
- VPC Endpoint는 VPC 소속·SG까지만 표시한다. 실제 연결 서비스, gateway route table 연결, private DNS 사용 경로를 완전하게 나타내지 않는다.
- Route 53 private hosted zone의 VPC 연결과 API custom-domain 매핑, ALB listener rule별 host/path/weight, CloudFront behavior별 경로, S3 호출 주체 등의 전체 연결은 현재 수집 범위 밖이다. ‘선이 없다’를 ‘사용하지 않는다’로 해석할 수 없다.

**원인:** `server/src/collectors/edge.ts`, `server/src/collectors/ec2.ts:136,168`, `server/src/collectors/eks.ts`, `server/src/collectors/discovery.ts`, `server/src/collectors/lambda.ts`, `server/src/collectors/network.ts`, `server/src/graph/assemble.ts:140`.

**수정 기준:** 지원하는 관계와 미지원 관계를 자원 유형별로 밝힌다. 조회한 원본 식별자를 보존하고, 해석할 수 없는 대상은 미해석 상태로 남긴다. 이름으로 대충 연결해 누락을 메우지 않는다.

### 10. 관계선 움직임이 실측 통신처럼 보인다 — P1, 코드·합성 재현

**현상:** 선의 traffic은 해당 연결의 지표가 아니라 양 끝 노드의 지표 중 최댓값이다. 연결 종류가 LIVE_EDGE_KINDS에 있으면 비활성 상태도 애니메이션 대상이다.

- 꺼진 SQS→Lambda 관계에 Lambda 자체 지표만 넣어도 그 선이 live/traffic=1이 되는 것을 재현했다.
- 기준 캐시에는 비활성 소스에서 나가는 invokes 관계도 4개 있다. 이번 감사에서 유료 지표를 조회하지 않았으므로 해당 선의 실제 움직임을 실계정에서 재현했다고 주장하지 않는다.
- 지표가 없을 때도 기본 트래픽 레이어가 켜져 있어 idle 점선이 움직인다. 전체 지표 값이 0이면 `hasMetrics`도 false가 될 수 있어 ‘조회 전’과 ‘관측된 0’이 섞인다.

**원인:** `web/src/layout/scene.ts:308`, `web/src/canvas/edges/FlowEdge.tsx:15`, `web/src/canvas/Topology.tsx:176`, `server/src/metrics/cloudwatch.ts:216`.

**수정 기준:** 노드 활동량은 노드에 표시한다. 관계별 통신을 관측하지 않았다면 선을 통신량처럼 움직이지 않는다. 애니메이션을 유지하려면 이름·범례를 ‘관계 방향/자원 활동’으로 제한하고 비활성 관계·미조회·관측된 0·조회 실패를 구분한다.

### 11. 일부 위치는 추정인데 확정 배치처럼 표현한다 — P2, 합성 재현 / 실제 적용 범위 구분

- ASG는 VPCZoneIdentifier가 있어도 실행 인스턴스에서만 VPC를 찾는다. 실행 수 0이면 리전으로 이동하는 것을 재현했다. 실제 ASG 5개는 모두 인스턴스가 있어 이번 실데이터에서는 미발생이다.
- RDS·ElastiCache는 같은 AZ의 서브넷을 `find()`로 하나 고른다. 같은 AZ에 후보가 여러 개인 경우 첫 번째를 실제 배치로 단정하는 것을 재현했다. 이번 RDS 8개는 각 primary AZ의 후보가 1개여서 이 모호성은 미발생이다.
- Multi-AZ RDS 1개는 단일 primary subnet 아래 한 노드로 나타나며 다중 AZ 여부는 상세 속성으로만 보인다. 개요 지도에서 복제·대기 위치가 사라지는 표현상 한계다.
- RDS 클러스터는 인스턴스에서만 VPC를 역산하므로 멤버가 없거나 멤버 조회가 빠지면 VPC를 잃을 수 있다.
- Lambda의 VPC 연결은 사용자 VPC에 실행 환경 자체가 배치된다는 의미와 다르다. EKS 제어 평면·CodeBuild VPC 연결·리전 EFS와 mount target도 동일한 ‘상자 안’의 의미를 명확히 구분해야 한다.

**원인:** `server/src/collectors/ec2.ts:177`, `server/src/collectors/rds.ts:12,79`, `server/src/collectors/elasticache.ts:20`, `server/src/collectors/lambda.ts:80`.

**수정 기준:** 실제 실행 위치, 설정된 연결 범위, 논리적 묶음을 별도 근거로 표시한다. 여러 AZ/서브넷은 하나로 축약했다는 표식을 둔다. 확인할 수 없는 단일 서브넷을 임의 선택하지 않는다.

### 12. 상태·갱신·묶음이 관계 해석을 왜곡할 수 있다 — P2, 코드 확인 및 일부 재현

- 부모만 바뀌면 Topology의 structureKey가 그대로일 수 있다. 두 VPC 사이에 같은 ID의 Lambda를 이동시키는 합성 데이터로 키가 같음을 재현했다. 재배치가 생략돼 이전 부모 기준 좌표·영역 크기를 재사용할 수 있다. 실제 사용자 화면에서 이동 후의 겹침까지 확인한 것은 아니다.
- Lambda는 ListFunctions에 State가 없으면 healthy로 가정한다. Step Functions 상세 실패 시 ACTIVE, API Gateway stage 조회 실패 시 ‘배포된 스테이지 없음’ 등 unknown을 정상/없음으로 바꾸는 사례가 있다.
- S3 PublicAccessBlock 조회 실패와 실제 설정 없음이 같은 false로 표시된다. 이것은 공개 여부를 확정하는 근거가 아니다.
- 같은 종류·양 끝 자원의 선을 합치면서 세부 label을 최대 60자로 자른다. 전체 조건은 원본 관계/상세에서 보존해야 한다.
- 기본 화면은 일부 유형과 관계 없는 노드를 숨기거나 접는다. 이는 조작 자체가 문제인 것은 아니나 ‘필터로 보이지 않음’, ‘관계 미수집’, ‘확인된 관계 없음’을 같은 빈 화면으로 읽지 않도록 해야 한다.

**원인:** `web/src/canvas/Topology.tsx:66`, `web/src/layout/scene.ts:300`, `server/src/collectors/lambda.ts:65`, `server/src/collectors/messaging.ts`, `server/src/collectors/edge.ts`, `server/src/collectors/s3.ts:79`.

## 전체 수집 범위 대조

아래의 ‘직접 확인’은 해당 API 필드의 관계를 사용한다는 의미이며, 전체 자원 조회 성공이나 실제 통신 성공을 보장하지 않는다.

| 영역 | 현재 직접 확인하는 정보 | 한계·이번 발견 |
|---|---|---|
| VPC·서브넷·NAT·IGW·Endpoint | VPC/서브넷 ID, route table, SG | NAT 목적지 오표기, 부분 실패 연쇄, TGW 등 전체 경로 미표현 |
| EC2·ASG·EBS | EC2 subnet/VPC, ASG 멤버, detached EBS | ASG 0대 위치, profile-role 혼동, attached EBS는 인스턴스 속성 요약 |
| ECS | 클러스터 소속, awsvpc, 서비스 TG | host/bridge 위치, 일괄 실패 전파, 태스크/호스트 관계 누락 |
| EKS | cluster VPC/SG/role, node group 요약 | ASG/EC2 관계·노드 그룹 단위 정보 부족 |
| Lambda | VPC 연결, SG, role, event source mapping | 상태 기본값, env 참조의 추정, EFS access point/ECR 해석 누락 |
| ELB·TG | LB VPC, TG 등록 대상·헬스 | IP 대상 누락, 접힘 상태 누락, listener rule 조건 미표현 |
| RDS·Aurora | subnet group, AZ, cluster 멤버·SG | 서브넷 임의 선택, Multi-AZ 단순화, 멤버 의존 VPC |
| ElastiCache | 그룹/클러스터, subnet group, SG | 후보 서브넷 선택, 일부 node/endpoint 요약 |
| EFS | mount target의 VPC/subnet/SG | 조회 거부를 성공처럼 처리, 접속 가능성/실제 마운트와 혼동 |
| S3 | bucket region·설정 | PublicAccessBlock unknown 문제, 호출 주체 관계 미수집 |
| DynamoDB | table 상태·KMS | 상세 거부 시 노드 누락, table 참조의 접근 방향 추정 |
| ECR | repository·KMS | 이미지 참조의 account/region 유실 |
| CloudFront·API Gateway·Route 53 | origin, integration, DNS 참조 | custom hostname/listener/외부 ARN, 요청 경로 조건·잘림/부분 결과 표시 |
| SQS·SNS·EventBridge·Step Functions | DLQ·subscription·target·정의 참조 | 비활성 관계 표시, 미확인 상태, 참조 문맥·외부 대상, EventBridge targets pagination 미처리 |
| Scheduler | target/role/DLQ/KMS 참조 | universal target 입력 내부의 실제 대상은 해석하지 않음, 참조 종류 추정 |
| SG·IAM·KMS·Secrets·Cognito | SG 참조, 역할/키 메타데이터, 일부 triggers | SG VPC 소속 누락, 일부 실패 숨김, 전체 인가·접속 가능성 아님 |
| Cloud Map | namespace/service 및 hosted zone 소속 | private DNS VPC/등록 인스턴스 대상 연결 미표현 |
| Transit Gateway | available VPC attachments | 라우트 테이블별 실제 경로·VPN/peering 등은 미표현 |
| WAF·ACM | 일부 자원 association, listener certificate | WAF 지원 대상 제한, ACM InUseBy 전체 연결·추가 listener certificate 미수집 |
| OpenSearch Serverless | collection/KMS | network policy/VPC endpoint 관계 미수집 |
| CodeBuild | VPC/SG/role 및 설정 참조 | 상세 거부 시 위치 미확인, env 참조의 불명확한 의미 |
| AppSync | data source/auth/role 참조 | 필드별 문맥 유실, 권한 실패 시 healthy/0 표시 |
| CloudWatch alarms·상태 병합 | dimension 기반 경보 매핑, 상태 관측 | 상태와 관계 존재/통신 성공을 동일시하면 안 됨; 부분 수집 보고 개선 필요 |

## 합성 재현 목록

별도 더미 계정·자원 fixture로 실제 함수를 호출했다. AWS에 쓰지 않았고 기존 테스트를 삭제·약화하지 않았다.

1. 다른 계정·리전 ARN이 로컬 동명 자원으로 오연결됨.
2. 평문 이름 하나가 서로 다른 종류의 동명 자원 두 개에 연결됨.
3. 누락된 부모가 경고 없이 삭제됨.
4. 알려진 custom DNS 이름도 bare hostname 참조는 누락됨.
5. 알려진 LB가 있어도 listener ARN은 해석되지 않음.
6. VPC 필터가 Lambda를 리전 영역으로 이동시킴.
7. 글로벌 자원이 리전 서비스 영역으로 분류됨.
8. 비활성 선이 노드 활동량으로 live/traffic=1이 됨.
9. TG 접힘 시 앞쪽 critical 상태가 유실됨.
10. 설정 서브넷이 있는 0대 ASG의 VPC가 비어 있음.
11. EFS mount 조회 거부에도 수집 성공·parent 없음·edge 없음이 반환됨.
12. 특정 목적지 blackhole NAT 라우트가 기본 경로 라벨로 생성됨.
13. network API 한 종류 실패가 전체 network 출력을 소실시킴.
14. VPC를 가진 SG가 parent 없이 생성됨.
15. 같은 AZ 후보가 둘인 RDS에서 첫 서브넷을 실제 위치로 선택함.
16. 부모만 바뀐 자원에 동일한 layout 구조 키가 생성됨.

## 권장 수정 순서와 완료 조건

1. **지도 신뢰도 보존부터:** partial/unknown/외부 대상·미해석 참조를 모델과 UI에 남긴다. 없음을 단정하는 레이블·정상 기본값·다른 account/region 이름 fallback을 먼저 막는다. 실제 부분 실패가 발생해도 지도는 해당 한계를 드러내야 한다.
2. **확인된 실제 위치·경로 오류:** ECS host/bridge와 개별 실패 분리, SG VPC, NAT destination/state, 등록 IP 타깃 보존을 수정한다. TMS-STG 서비스 6개의 위치, 실행 host/bridge 20개 이상, SG 110개, /32 라우트 4개·서브넷 2개, IP TG 11개를 실데이터 재대조한다. 수집 시점에 자원 수가 바뀌면 그 차이를 따로 기록한다.
3. **표현 의미 정리:** 글로벌/리전/논리적 묶음/실행 위치/네트워크 연결/미확인을 구분한다. 소속·구성상 연결·보안 규칙·설정 참조·실측 활동량을 각각 다른 설명으로 제공한다. 실제 관측되지 않은 선의 통신량 표현을 없앤다.
4. **넓은 관계 지원과 축약 검증:** VPC Link, Cloud Map, IAM profile, EKS/ASG, EFS access point 등의 해석을 명시적 근거로 확장한다. 필터·접기·부모 이동에서 의미·경유지·오류 상태가 보존되는 회귀 테스트를 추가한다.

완료 기준은 ‘선이 더 많아짐’이 아니다. **각 선과 위치에 대해 무엇을 근거로 그렸는지, 무엇을 확인하지 못했는지 사용자가 화면에서 답을 얻을 수 있어야 한다.**

## 참고한 AWS 공식 설명

- [ECS 클러스터는 서비스·태스크의 논리적 묶음](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/clusters.html)
- [EC2 ECS 태스크의 네트워크 모드](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking.html)
- [ECS host 모드](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/networking-networkmode-host.html)
- [RDS의 subnet group·AZ 기반 서브넷 선택](https://aws.amazon.com/rds/faqs/)
- [Lambda VPC 연결](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc.html)
