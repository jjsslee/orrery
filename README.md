# Orrery — AWS 자원 관계 지도

로컬 AWS 프로필의 자격증명으로 한 계정·리전의 자원과 자원 사이의 관계를 수집해, 포함 관계(VPC → 서브넷 → 인스턴스)와 연결 관계(로드 밸런서 → 타깃, 이벤트 → Lambda, CloudFront → 오리진 …)를 한 장의 토폴로지로 보여주는 읽기 전용 뷰어입니다. CloudWatch 지표를 읽어 관계선 위에 트래픽 펄스를 흘리고, 상태·경보를 노드에 표시합니다.

## 실행

```bash
npm install
npm run dev
```

- 웹: http://localhost:5173 (Vite, `/api`는 4820으로 프록시)
- API 서버: http://127.0.0.1:4820 (Fastify, 로컬 전용 바인딩)
- 기본 프로필은 `ORRERY_DEFAULT_PROFILE`(없으면 `AWS_PROFILE`, 그다음 `default`)이고, 리전은 프로필의 `region` 설정값입니다. 상단바에서 프로필·리전을 바꿀 수 있고 선택은 브라우저에 저장됩니다.

프로덕션 빌드는 `npm run build`(웹 번들) 후 `npm start`로 4820 포트에서 웹과 API를 함께 서빙합니다. 서버는 빌드 단계 없이 `tsx`로 TypeScript를 바로 실행합니다.

환경 변수:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ORRERY_PORT` | `4820` | API 서버 포트 (`PORT`는 쓰지 않음: 개발 서버 런처가 웹 앱용으로 설정함) |
| `ORRERY_GRAPH_TTL_MS` | `600000` | 수집 결과 캐시 수명 (10분) |
| `ORRERY_METRICS_TTL_MS` | `60000` | 지표 캐시 수명 |
| `ORRERY_DEFAULT_PROFILE` | – | 처음 열 때 선택할 프로필 (없으면 `AWS_PROFILE`, 그다음 `default`) |
| `AWS_PROFILE` | – | `?profile=` 생략 시 사용할 프로필 |

수집 결과는 `.orrery-cache/`에 JSON으로 저장되어 개발 서버 재시작 후에도 재사용됩니다. 상단바의 **다시 수집**은 캐시를 무시합니다.

## 읽기 전용 보장

서버가 만드는 모든 AWS SDK 클라이언트에는 `server/src/aws/readonly-guard.ts`의 미들웨어가 붙습니다. 명령 이름이 `Describe*`, `List*`, `Get*`, `Head*`, `Lookup*`, `BatchGet*`이 아니면 요청을 서명하거나 보내기 전에 예외를 던집니다. `npm test`의 단위 테스트가 `TerminateInstances` 같은 호출이 차단되는지 확인합니다. 그래도 사용하는 자격증명에는 `ReadOnlyAccess` 정책 수준의 권한만 주는 것을 권장합니다.

## 구조

```
shared/   그래프 모델 타입 (ResourceNode / ResourceEdge / MetricsBundle …)
server/   Fastify API
  src/aws/          자격증명 소스 추상화, 클라이언트 팩토리, 읽기 전용 가드
  src/collectors/   서비스별 수집기 (network, ec2, elb, rds, lambda, ecs, appsync, …)
  src/graph/        수집 결과 병합, refs → 관계 해석, 경보 부착
  src/metrics/      CloudWatch GetMetricData 카탈로그와 트래픽 정규화
web/      React 19 + Vite
  src/layout/       필터·집계·포커스를 적용한 장면(scene) 구성, ELK 레이아웃(워커)
  src/canvas/       React Flow 토폴로지 (플레이트·자원·집계 노드, 애니메이션 엣지)
  src/views/        유형별 보기
  src/panels/       상단바, 필터 레일, 인스펙터
```

### 자격증명 확장

`CredentialSourceSpec`(shared)과 `resolveCredentials()`(server/src/aws/credentials.ts)가 유일한 진입점입니다. 지금은 `profile`만 UI에 노출하지만 `assume-role`, `environment`가 같은 경로로 이미 처리되며, 새 방식(SSO 디바이스 플로우, 외부 토큰 서비스 등)은 유니온 타입에 항목을 더하고 `resolveCredentials`에 분기를 추가하면 수집기 변경 없이 동작합니다. API는 `?source=assume-role&roleArn=…&profile=<base>` 형태를 이미 받습니다.

### 수집기 추가

`server/src/collectors/<name>.ts`에 `Collector`를 구현하고 `registry.ts`에 등록합니다. 노드 id는 반드시 `nid(type, nativeId)`로 만들고, 다른 자원을 가리킬 수 있는 문자열(환경 변수 값, ARN, 이미지 URI, 도메인)은 `refs`에 넣으면 `graph/assemble.ts`가 관계로 해석합니다. 새 자원 유형은 `shared/src/index.ts`의 `ResourceType`과 `web/src/model/types.ts`의 `TYPE_META`에 함께 추가합니다.

## 토폴로지 읽는 법

- 플레이트: VPC(보라 테두리) 안에 서브넷(파랑 테두리)이 들어가고, VPC 밖 리전 서비스는 분류별 점선 레인에 놓입니다.
- 집계 노드(점선 카드): 같은 자리에 같은 유형이 많거나 관계가 없는 자원을 접어 둔 것입니다. 클릭하면 펼쳐집니다. 검색어에 맞거나 선택한 노드의 이웃은 항상 개별 노드로 나옵니다.
- 레이어(하단 툴바): 트래픽 펄스, 타깃 그룹, 보안 그룹, IAM 역할, KMS 키, 관계 없는 자원을 켜고 끕니다. 기본은 꺼져 있어 핵심 관계만 보입니다.
- 선택: 노드를 클릭하면 1-hop 이웃만 밝게 남고 오른쪽 인스펙터에 속성·관계·최근 3시간 지표가 나옵니다. `Esc`로 해제, `/`로 검색 포커스.
- 유형 선택: 왼쪽 레일의 체크박스로 지도에 남길 유형을 고릅니다. 분류 체크박스는 그 안의 유형을 한꺼번에 켜고 끄며(일부만 켜지면 중간 상태), 맨 위 **전체**를 끄고 몇 가지만 체크하면 그것들만 봅니다. 3종 이하로 좁히면 해당 자원은 접지 않고 전부 펼치며, VPC·서브넷 플레이트는 위치 맥락을 위해 남기되 비는 플레이트는 숨깁니다. Option/Alt+클릭은 그 하나만 고르고, **초기화**는 체크·검색·태그를 모두 되돌립니다.
- 태그: 왼쪽 레일의 **태그** 탭에서 키 → 값 순으로 고르면 그 태그를 가진 자원만 (상위 컨테이너와 함께) 남습니다. 같은 키의 여러 값은 그중 하나만 맞아도 되고(OR), 서로 다른 키는 모두 만족해야 하며(AND), "연결된 자원도 함께 표시"를 켜면 1-hop 이웃까지 보입니다. 인스펙터의 태그를 클릭해도 같은 필터가 걸립니다. `Name`과 `aws:*` 같은 시스템 태그는 접혀 있습니다.

## 권한

자격증명에 `ReadOnlyAccess` 수준의 권한이 있으면 모든 수집기가 동작합니다. 일부 API가 거부되면 해당 수집기는 가져온 범위까지만 그래프에 넣고 거부 사실을 서버 로그와 레일 하단의 "수집 실패" 목록에 남깁니다. 예를 들어 `ecs:DescribeClusters`가 거부되면 ECS 클러스터는 이름만 있는 '접근 거부' 노드로 표시되고, 서비스는 `ListServices`/`DescribeServices`로 가져온 만큼만 연결됩니다. CloudWatch 지표는 `cloudwatch:GetMetricData` 하나로 읽으며, CloudFront 지표만 `us-east-1`에서 조회합니다. 태그는 목록 API에 포함된 경우 그대로 쓰고, 그렇지 않은 서비스(Lambda, S3, DynamoDB, ECR, SQS, SNS, CloudFront, KMS, IAM 역할 등)는 자원별 `ListTags*` 계열 호출로 가져오므로 해당 권한이 거부된 자원은 태그 없이 표시됩니다.

## 검증

```bash
npm run typecheck   # shared / server / web
npm test            # 읽기 전용 가드 등 서버 단위 테스트
```
