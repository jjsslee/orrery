# Orrery — AWS 자원 관계 지도

로컬 AWS 프로필의 자격증명으로 한 계정·리전의 자원과 자원 사이의 관계를 수집해, 포함 관계(VPC → 서브넷 → 인스턴스)와 연결 관계(로드 밸런서 → 타깃, 이벤트 → Lambda, CloudFront → 오리진 …)를 한 장의 토폴로지로 보여주는 읽기 전용 뷰어입니다. CloudWatch 지표를 읽어 관계선 위에 트래픽 펄스를 흘리고, 상태·경보를 노드에 표시합니다.

## 실행

```bash
npm install
npm run dev
```

- 웹: http://localhost:5173 (Vite, `/api`는 4820으로 프록시)
- API 서버: http://127.0.0.1:4820 (Fastify, 로컬 전용 바인딩)
- 기본 프로필은 `ORRERY_DEFAULT_PROFILE`(없으면 `AWS_PROFILE`, 그다음 `default`)이고, 리전은 프로필의 `region` 설정값입니다. 프로필에 리전이 없고 저장된 선택도 없으면 리전을 고를 때까지 수집하지 않고, 계정에서 켜진 리전 목록(`DescribeRegions`)을 보여줍니다. 상단바에서 프로필·리전을 바꿀 수 있고 선택은 브라우저에 저장됩니다.

프로덕션 빌드는 `npm run build`(웹 번들) 후 `npm start`로 4820 포트에서 웹과 API를 함께 서빙합니다. 서버는 빌드 단계 없이 `tsx`로 TypeScript를 바로 실행합니다.

환경 변수는 셸에서 주거나 저장소 루트의 `.env`(gitignored, `.env.example` 참고)에 적습니다. 처음 열 때 `default` 프로필의 키가 만료되어 있으면 "액세스 키가 유효하지 않습니다"가 뜨므로, 쓰려는 프로필을 `ORRERY_DEFAULT_PROFILE`로 지정해 두는 것을 권합니다.

환경 변수:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ORRERY_PORT` | `4820` | API 서버 포트 (`PORT`는 쓰지 않음: 개발 서버 런처가 웹 앱용으로 설정함) |
| `ORRERY_GRAPH_TTL_MS` | `600000` | 수집 결과 캐시 수명 (10분) |
| `ORRERY_METRICS_TTL_MS` | `60000` | 지표 캐시 수명 |
| `ORRERY_DEFAULT_PROFILE` | – | 처음 열 때 선택할 프로필 (없으면 `AWS_PROFILE`, 그다음 `default`) |
| `AWS_PROFILE` | – | `?profile=` 생략 시 사용할 프로필 |
| `ORRERY_NO_OPEN` | – | `1`이면 실행파일이 브라우저를 열지 않음 |

수집 결과는 `.orrery-cache/`에 JSON으로 저장되어 개발 서버 재시작 후에도 재사용됩니다. 상단바의 **다시 수집**은 캐시를 무시합니다.

## 실행파일 (Windows·macOS)

Node 없이 실행하는 단일 실행파일을 만듭니다. 각 PC에서 실행하면 그 사람의 `~/.aws`(Windows는 `%USERPROFILE%\.aws`) 프로필을 읽고, 자격증명은 그 PC 밖으로 나가지 않습니다.

```bash
npm run package                     # 전체 대상
npm run package -- macos-arm64      # 대상 하나만 (macos-arm64 | macos-x64 | windows-x64)
```

- macOS에서 실행합니다(macOS 실행파일은 `codesign`으로 ad-hoc 서명해야 Apple Silicon에서 실행됨).
- `release/`에는 네 개만 남습니다. 크기는 대부분 Node 런타임입니다.

  | 파일 | 용도 |
  |---|---|
  | `Orrery.app` | 이 Mac에서 바로 실행·테스트 (Apple Silicon·Intel 공용) |
  | `Orrery-macos.zip` | Mac 사용자에게 보내는 파일 |
  | `orrery-windows-x64.exe` | Windows용 실행파일 (그대로 보내도 됨) |
  | `orrery-windows-x64.zip` | 위 exe를 압축한 것. 더 작고 `.exe` 첨부를 막는 메일도 통과 |

- Mac은 꼭 zip으로 보냅니다. `.app`은 폴더라 그대로 보낼 수 없고, 압축 없이 옮기면 실행 권한과 서명이 깨집니다.
- 아키텍처별 macOS 실행파일(`orrery-macos-arm64`·`orrery-macos-x64`)과 번들·blob 같은 중간 결과는 숨김 폴더 `release/.work/`에, 받아 둔 Node 런타임은 `release/.node/`에 둡니다.
- Apple Developer ID 서명·공증은 하지 않습니다. 그래서 받은 Mac에서 처음 열 때 Gatekeeper가 막으며, **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**를 한 번 거쳐야 합니다(또는 `xattr -dr com.apple.quarantine Orrery.app`). 앱은 응용 프로그램 폴더로 옮긴 뒤 여는 것을 권합니다.
- 앱 아이콘은 `scripts/icon/orrery-app.svg`를 `rsvg-convert -w 1024 -h 1024`로 그린 `orrery-app-1024.png`에서 만듭니다.
- `scripts/package.mjs`가 서버를 CommonJS 한 파일로 묶고, `web/dist`를 SEA 자산으로 넣은 blob을 공식 Node 런타임(`NODE_VERSION`, 현재 24 LTS)에 `postject`로 주입합니다. 런타임은 nodejs.org에서 한 번 받아 `release/.node/`에 두며 `SHASUMS256.txt`로 검증합니다. Node 버전을 올릴 때는 이 상수만 바꿉니다.
- Windows `node.exe`의 Authenticode 서명은 주입하면 깨지므로 제거합니다. 배포용 서명은 별도로 해야 합니다.

실행파일의 동작:

- 더블클릭하면 기본 브라우저를 엽니다. Windows는 콘솔 창에 주소를 출력하며 창을 닫거나 `Ctrl+C`로 종료합니다. macOS `Orrery.app`은 창과 Dock 아이콘 없이 백그라운드 서버로 돌고, 로그(경고 이상)는 데이터 폴더의 `orrery.log`에 씁니다.
- 상단바의 전원 버튼으로 종료합니다(실행파일에서만 보임).
- Finder는 앱 프로세스가 끝나기 전에는 다시 더블클릭해도 무시하므로, `Orrery.app`은 서버를 분리된 자식 프로세스로 띄우고 바로 끝납니다. 다시 열면 실행 중인 서버를 찾아 브라우저만 엽니다.
- 포트는 4820을 우선 씁니다(브라우저가 프로필·리전 선택을 주소별로 기억하므로). 같은 빌드의 Orrery가 떠 있으면 그 창만 열고 끝납니다. 다른 빌드(업데이트 전 버전)면 그쪽을 종료시키고 이어받으며, 다른 프로그램이 쓰고 있으면 빈 포트를 고릅니다.
- 캐시는 `~/Library/Application Support/Orrery/cache`(macOS) 또는 `%LOCALAPPDATA%\Orrery\cache`(Windows)에 둡니다. `.env`는 읽지 않으며 설정은 환경 변수로만 줍니다.
- 프로필을 만들거나 SSO 로그인을 하려면 AWS CLI(`aws configure`, `aws sso login`)가 필요합니다. 프로필이 하나도 없으면 첫 화면에서 OS별 AWS CLI 설치와 `aws configure` / `aws configure sso` / `aws sso login`을 안내하고, 설정 후 **다시 확인**을 누르면 재시작 없이 새 프로필을 읽습니다.

## 읽기 전용 보장

서버가 만드는 모든 AWS SDK 클라이언트에는 `server/src/aws/readonly-guard.ts`의 미들웨어가 붙습니다. 명령 이름이 `Describe*`, `List*`, `Get*`, `Head*`, `Lookup*`, `BatchGet*`이 아니면 요청을 서명하거나 보내기 전에 예외를 던집니다. `npm test`의 단위 테스트가 `TerminateInstances` 같은 호출이 차단되는지 확인합니다. 그래도 사용하는 자격증명에는 `ReadOnlyAccess` 정책 수준의 권한만 주는 것을 권장합니다.

## 로컬 전용 요청

서버는 `127.0.0.1`에만 바인딩해 다른 PC의 접속을 막습니다. 같은 브라우저에 열린 다른 사이트도 루프백에 요청할 수 있으므로 `server/src/http/local-only.ts`가 두 가지를 더 거릅니다. Host 헤더가 `127.0.0.1`·`localhost`·`[::1]`이 아니면 DNS 리바인딩으로 보고 거부합니다. `/api/` 요청의 `Sec-Fetch-Site`가 `same-origin`·`none`이 아니면(다른 사이트의 fetch·이미지·폼·링크) 수집을 시작하지 못하게 거부합니다. 화면 자체는 다른 사이트의 링크로도 열 수 있습니다. CORS 헤더는 보내지 않으므로 다른 출처는 응답을 읽을 수 없습니다. 웹은 같은 출처(프로덕션) 또는 Vite 프록시(개발)로만 API를 부릅니다.

## 구조

```
shared/   그래프 모델 타입 (ResourceNode / ResourceEdge / MetricsBundle …)
server/   Fastify API
  src/aws/          자격증명 소스 추상화, 클라이언트 팩토리, 읽기 전용 가드
  src/http/         로컬 전용 요청 필터 (Host·Sec-Fetch-Site)
  src/runtime.ts    저장소 실행과 실행파일 실행의 차이 (내장 웹 자산, 데이터 폴더, 포트, 브라우저 열기)
  src/collectors/   서비스별 수집기 (network, ec2, elb, rds, lambda, ecs, appsync, …)
  src/graph/        수집 결과 병합, refs → 관계 해석, 경보 부착
  src/metrics/      CloudWatch GetMetricData 카탈로그와 트래픽 정규화
web/      React 19 + Vite
  src/layout/       필터·집계·포커스를 적용한 장면(scene) 구성, ELK 레이아웃(워커)
  src/canvas/       React Flow 토폴로지 (플레이트·자원·집계 노드, 애니메이션 엣지)
  src/views/        유형별 보기
  src/panels/       상단바, 필터 레일, 인스펙터
scripts/  package.mjs: Windows·macOS 단일 실행파일 빌드
```

### 자격증명 확장

`CredentialSourceSpec`(shared)과 `resolveCredentials()`(server/src/aws/credentials.ts)가 유일한 진입점입니다. 지금은 `profile`만 UI에 노출하지만 `assume-role`, `environment`가 같은 경로로 이미 처리되며, 새 방식(SSO 디바이스 플로우, 외부 토큰 서비스 등)은 유니온 타입에 항목을 더하고 `resolveCredentials`에 분기를 추가하면 수집기 변경 없이 동작합니다. API는 `?source=assume-role&roleArn=…&profile=<base>` 형태를 이미 받습니다.

### 수집기 추가

`server/src/collectors/<name>.ts`에 `Collector`를 구현하고 `registry.ts`에 등록합니다. 노드 id는 반드시 `nid(type, nativeId)`로 만들고, 다른 자원을 가리킬 수 있는 문자열(환경 변수 값, ARN, 이미지 URI, 도메인)은 `refs`에 넣으면 `graph/assemble.ts`가 관계로 해석합니다. 새 자원 유형은 `shared/src/index.ts`의 `ResourceType`과 `web/src/model/types.ts`의 `TYPE_META`에 함께 추가합니다.

## 토폴로지 읽는 법

- 플레이트: VPC(보라 테두리) 안에 서브넷(파랑 테두리)이 들어가고, VPC 밖 리전 서비스는 분류별 점선 레인에 놓입니다.
- 집계 노드(점선 카드): 같은 자리에 같은 유형이 많거나 관계가 없는 자원을 접어 둔 것입니다. 클릭하면 펼쳐집니다. 검색어에 맞거나 선택한 노드의 이웃은 항상 개별 노드로 나옵니다.
- 레이어(하단 툴바): 트래픽 펄스, 타깃 그룹, 보안 그룹, IAM 역할, KMS 키, 관계 없는 자원을 켜고 끕니다. 기본은 꺼져 있어 핵심 관계만 보입니다.
- 이름: 노드 이름은 구분자(`-` `_` `.` `/` `:`) 뒤에서 줄을 바꿔 두 줄까지 보이고, 더 길면 첫 줄은 앞부분, 둘째 줄은 `…`와 끝부분을 보여줍니다(`web/src/components/fitName.ts`).
- 호버: 노드에 마우스를 잠시 올리면 연결선이 강조되고, 옆에 카드로 전체 이름·유형·상태와 연결 관계(관계 종류 → 상대, 아래 줄에 포트·타깃 그룹 같은 세부)가 나옵니다.
- 선택: 노드를 클릭하면 1-hop 이웃만 밝게 남고 오른쪽 인스펙터에 속성·관계·최근 3시간 지표가 나옵니다. 선 가운데 라벨(관계 종류와 짧은 세부)은 선택한 노드의 선에만 표시합니다. 선택한 자원은 필터와 무관하게 항상 보이고, 이웃이 체크 해제·검색·태그로 가려져 있으면 점선 테두리의 희미한 노드("숨김" 표시)와 점선 관계선으로 함께 나타납니다. `Esc`로 해제, `/`로 검색 포커스.
- 지도에서 보기: 유형별 표의 행 끝과 인스펙터(관계 목록 포함)의 조준 아이콘을 누르면 토폴로지로 전환해 그 노드로 확대·이동합니다.
- 유형 선택: 왼쪽 레일의 체크박스로 지도에 남길 유형을 고릅니다. 분류 체크박스는 그 안의 유형을 한꺼번에 켜고 끄며(일부만 켜지면 중간 상태), 맨 위 **전체**를 끄고 몇 가지만 체크하면 그것들만 봅니다. 3종 이하로 좁히면 해당 자원은 접지 않고 전부 펼치며, VPC·서브넷 플레이트는 위치 맥락을 위해 남기되 비는 플레이트는 숨깁니다. Option/Alt+클릭은 그 하나만 고르고, **초기화**는 체크·검색·태그를 모두 되돌립니다.
- 태그: 왼쪽 레일의 **태그** 탭에서 키 → 값 순으로 고르면 그 태그를 가진 자원만 (상위 컨테이너와 함께) 남습니다. 같은 키의 여러 값은 그중 하나만 맞아도 되고(OR), 서로 다른 키는 모두 만족해야 하며(AND), "연결된 자원도 함께 표시"를 켜면 1-hop 이웃까지 보입니다. 인스펙터의 태그를 클릭해도 같은 필터가 걸립니다. `Name`과 `aws:*` 같은 시스템 태그는 접혀 있습니다.

## 라이브 모드

상단바의 **라이브**를 켜면 탭이 보이는 동안 무료 호출만으로 화면을 갱신합니다.

| 주기 | 갱신 내용 | 호출 |
|---|---|---|
| 2분 | 인스턴스 상태·상태 검사, 타깃 헬스, ECS 실행/희망 작업, RDS·ElastiCache·NAT 상태, CloudWatch 경보 | `Describe*`/`List*` (무료) |
| 10분 | 자원 구성·관계 전체 재수집 (조용히 교체, 화면 맞춤 없음) | `Describe*`/`List*` (무료) |
| 수동 | CloudWatch 지표·트래픽 펄스 | **다시 수집** 버튼일 때만 `GetMetricData` (지표 1,000개당 $0.01) |

상태가 바뀐 노드는 잠시 금빛 링으로 표시됩니다. 주기는 `web/src/model/live.ts`에 있습니다. 모든 호출은 CloudTrail 관리 이벤트로 남고 계정의 API 호출 한도를 함께 쓰므로, 더 짧은 주기는 권하지 않습니다.

## 권한

자격증명에 `ReadOnlyAccess` 수준의 권한이 있으면 모든 수집기가 동작합니다. 일부 API가 거부되면 해당 수집기는 가져온 범위까지만 그래프에 넣고 거부 사실을 서버 로그와 레일 하단의 "수집 실패" 목록에 남깁니다. 예를 들어 `ecs:DescribeClusters`가 거부되면 ECS 클러스터는 이름만 있는 '접근 거부' 노드로 표시되고, 서비스는 `ListServices`/`DescribeServices`로 가져온 만큼만 연결됩니다. CloudWatch 지표는 `cloudwatch:GetMetricData` 하나로 읽으며, CloudFront 지표만 `us-east-1`에서 조회합니다. 태그는 목록 API에 포함된 경우 그대로 쓰고, 그렇지 않은 서비스(Lambda, S3, DynamoDB, ECR, SQS, SNS, CloudFront, KMS, IAM 역할 등)는 자원별 `ListTags*` 계열 호출로 가져오므로 해당 권한이 거부된 자원은 태그 없이 표시됩니다.

## 검증

```bash
npm run typecheck   # shared / server / web
npm test            # 읽기 전용 가드, 로컬 전용 요청 필터 등 서버 단위 테스트
```
