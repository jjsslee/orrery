# Orrery — AWS 자원 관계 지도

로컬 AWS 프로필의 자격증명으로 한 계정·리전의 자원과 자원 사이의 관계를 수집해, 포함 관계(VPC → 서브넷 → 인스턴스)와 연결 관계(로드 밸런서 → 타깃, 이벤트 → Lambda, CloudFront → 오리진 …)를 한 장의 토폴로지로 보여주는 읽기 전용 뷰어입니다. CloudWatch 지표를 읽어 관계선 위에 트래픽 펄스를 흘리고, 상태·경보를 노드에 표시합니다.

## 실행

```bash
npm install
npm run dev
```

- 웹: http://localhost:5173 (Vite, `/api`는 `ORRERY_PORT`(기본 4820)로 프록시. 설치한 Orrery가 4820을 쓰고 있으면 `ORRERY_PORT=4821 npm run dev`로 나란히 띄웁니다)
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

수집 결과는 `.orrery-cache/`에 JSON으로 저장되어 개발 서버 재시작 후에도 재사용됩니다. 인증 소스·실제 계정·리전별로 분리하며 파일 이름에는 키의 SHA-256 해시를 사용합니다. 현재 그래프 캐시 형식은 `graph-v7`이며 이전 형식은 재사용하지 않고 다시 수집합니다. 상단바의 **다시 수집**은 구성 캐시를 무시합니다. 상태·경보 갱신은 구성 캐시의 10분 만료 시간을 연장하지 않습니다. 세션 안에서는 STS 계정 확인과 실제 SDK 호출에 같은 자격증명 스냅샷을 사용합니다. 최대 5분 또는 임시 자격증명 만료 1분 전 중 먼저 도달한 시점에 STS로 다시 확인합니다. 키/SSO 설정을 갱신했거나 같은 프로필의 계정이 달라졌으면 **다시 연결**로 세션·계정을 즉시 다시 확인할 수 있습니다. 연결 실패 중에는 이전 계정의 화면 데이터를 비웁니다.

## 데스크톱 앱 (Windows·macOS)

Node 없이 실행하는 Electron 앱을 만듭니다. 더블클릭하면 브라우저 없이 Orrery 창이 뜨고, 그 PC의 `~/.aws`(Windows는 `%USERPROFILE%\.aws`) 프로필을 읽습니다. 자격증명은 그 PC 밖으로 나가지 않습니다.

```bash
npm run package                     # 전체 대상
npm run package -- macos-arm64      # 대상 하나만 (macos-arm64 | macos-x64 | windows-x64)
```

- macOS에서 실행합니다(macOS 앱은 `codesign`으로 ad-hoc 서명해야 Apple Silicon에서 실행됨).
- `release/`에는 네 개만 남습니다. 크기는 대부분 Electron(Chromium)입니다.

  | 파일 | 용도 |
  |---|---|
  | `Orrery.app` | 이 Mac에서 바로 실행·테스트 (이 Mac의 칩용) |
  | `Orrery-macos-arm64.zip` | Apple Silicon(M1 이후) Mac 사용자에게 보내는 파일 |
  | `Orrery-macos-x64.zip` | Intel Mac 사용자에게 보내는 파일 |
  | `Orrery-windows-x64.zip` | Windows 사용자에게 보내는 파일. 풀면 `Orrery\Orrery.exe` |

- Mac은 칩별로 나눠 보냅니다. 두 칩 공용 앱은 Electron을 두 벌 담아 크기가 두 배 가까이 됩니다. 칩은 Apple 메뉴 → 이 Mac에 관하여의 "칩"(Apple M…)이나 "프로세서"(Intel)로 확인합니다.
- Mac은 꼭 zip으로 보냅니다. `.app`은 폴더라 그대로 보낼 수 없고, 압축 없이 옮기면 실행 권한과 서명이 깨집니다.
- Windows는 zip을 모두 푼 뒤 `Orrery.exe`를 실행합니다. 함께 든 DLL·리소스 파일이 같은 폴더에 있어야 합니다.
- `scripts/package.mjs`가 서버(`server.cjs`)와 Electron 메인 프로세스(`main.cjs`, 원본 `desktop/src/main.ts`)를 esbuild로 묶고, 빌드된 웹(`web/`)과 함께 `@electron/packager`로 앱을 만듭니다. Electron 버전은 루트 `package.json`의 `electron`(정확한 버전)을 따르며, `@electron/get`이 한 번 받아 캐시하고 공개된 SHA-256으로 검증합니다. Electron을 올릴 때는 그 버전과 스크립트의 `NODE_TARGET`(Electron 안의 Node 메이저)을 함께 바꿉니다.
- 칩별 앱 원본과 번들·아이콘 같은 중간 결과는 숨김 폴더 `release/.work/`에 둡니다.
- Apple Developer ID 서명·공증과 Windows 코드 서명은 하지 않습니다. 그래서 받은 Mac에서 처음 열 때 Gatekeeper가 막으며, **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**를 한 번 거쳐야 합니다(또는 `xattr -dr com.apple.quarantine Orrery.app`). 앱은 응용 프로그램 폴더로 옮긴 뒤 여는 것을 권합니다. Windows에서 SmartScreen이 막으면 **추가 정보 → 실행**을 누릅니다.
- 앱 아이콘은 `scripts/icon/orrery-app.svg`를 `rsvg-convert -w 1024 -h 1024`로 그린 `orrery-app-1024.png`에서 만듭니다(macOS `.icns`, Windows `.ico`).

앱의 동작:

- Electron 메인 프로세스가 서버를 별도 Node 프로세스(utility process)로 띄우고, 서버가 준비되면 그 주소를 Orrery 창에 엽니다. 창 안의 외부 링크(AWS CLI 설치 안내 등)는 기본 브라우저로 열립니다.
- 창을 닫으면(macOS는 ⌘Q도) 앱과 서버가 함께 종료됩니다. 이미 실행 중일 때 다시 열면 새로 뜨지 않고 열린 창을 앞으로 가져옵니다.
- 포트는 4820을 우선 씁니다(창이 프로필·리전 선택을 주소별로 기억하므로). 다른 빌드의 Orrery(업데이트 전 버전)가 쓰고 있으면 그쪽을 종료시키고 이어받으며, 다른 프로그램이 쓰고 있으면 빈 포트를 고릅니다.
- 캐시는 `~/Library/Application Support/Orrery/cache`(macOS) 또는 `%LOCALAPPDATA%\Orrery\cache`(Windows)에, 로그(경고 이상)는 같은 폴더의 `orrery.log`에 씁니다. 서버가 시작하지 못하면 오류와 로그 위치를 대화상자로 보여 주고 종료합니다.
- 창의 저장값(프로필·리전 선택, 테마, 모니터링 묶음)은 Electron 데이터 폴더의 `Session`에 있습니다(macOS는 위와 같은 `Orrery` 폴더, Windows는 `%APPDATA%\Orrery`). 브라우저로 쓰던 시절의 저장값은 옮겨지지 않습니다.
- `.env`는 읽지 않으며 설정은 환경 변수로만 줍니다.
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
  src/runtime.ts    저장소 실행과 데스크톱 앱 실행의 차이 (함께 담긴 웹, 데이터 폴더, 포트, 창에 주소 알리기)
  src/collectors/   서비스별 수집기 (network, ec2, elb, rds, lambda, ecs, appsync, …)
  src/graph/        수집 결과 병합, refs → 관계 해석, 경보 부착
  src/metrics/      CloudWatch GetMetricData 카탈로그와 트래픽 정규화
web/      React 19 + Vite
  src/layout/       필터·집계·포커스를 적용한 장면(scene) 구성, ELK 레이아웃(워커)
  src/canvas/       React Flow 토폴로지 (플레이트·자원·집계 노드, 애니메이션 엣지)
  src/views/        유형별 보기
  src/panels/       상단바, 필터 레일, 인스펙터
desktop/  Electron 메인 프로세스 (서버 실행, 창, 메뉴, 외부 링크)
scripts/  package.mjs: Windows·macOS 데스크톱 앱 빌드
```

### 자격증명 확장

`CredentialSourceSpec`(shared)과 `resolveCredentials()`(server/src/aws/credentials.ts)가 유일한 진입점입니다. 지금은 `profile`만 UI에 노출하지만 `assume-role`, `environment`가 같은 경로로 이미 처리되며, 새 방식(SSO 디바이스 플로우, 외부 토큰 서비스 등)은 유니온 타입에 항목을 더하고 `resolveCredentials`에 분기를 추가하면 수집기 변경 없이 동작합니다. API는 `?source=assume-role&roleArn=…&profile=<base>` 형태를 이미 받습니다.

### 수집기 추가

`server/src/collectors/<name>.ts`에 `Collector`를 구현하고 `registry.ts`에 등록합니다. 노드 id는 반드시 `nid(type, nativeId)`로 만들고, 다른 자원을 가리킬 수 있는 문자열(환경 변수 값, ARN, 이미지 URI, 도메인)은 `refs`에 넣으면 `graph/assemble.ts`가 관계로 해석합니다. 새 자원 유형은 `shared/src/index.ts`의 `ResourceType`과 `web/src/model/types.ts`의 `TYPE_META`에 함께 추가합니다.

### 색과 글자 규칙

토큰은 `web/src/styles/tokens.css`에 있습니다. 색은 하는 일 하나씩만 맡습니다: 분류색(`--cat-*`)은 자원 유형, 상태색(`--status-*`)은 상태, 금색 펄스(`--pulse`)는 트래픽·활성 태그 필터, 선택·포커스는 중립 잉크(`--select-*`, `--focus`)입니다. 분류색을 UI 강조색으로 쓰지 않으므로 같은 유형은 지도·표·모니터링에서 같은 색 아이콘입니다. 글자는 `--fs-*` 단계를 쓰고 11.5px 아래로 내리지 않으며, 읽는 글자색 `--ink-3`은 다크 패널에서 5:1 이상, 라이트 상태색은 4.3:1 이상을 유지합니다. `--ink-4`는 비활성·구분선 전용입니다.

### 추가 서비스 수집 범위

- EventBridge Scheduler: 모든 schedule group의 일정을 수집하며 실행 대상·실행 역할·DLQ·KMS 참조를 연결합니다. 실행 입력(`Target.Input`)은 저장하거나 표시하지 않습니다. 범용 AWS SDK 대상의 입력 안에 있는 자원은 해석하지 않습니다.
- OpenSearch Serverless: 컬렉션 유형·상태·엔드포인트·태그·KMS 참조를 수집합니다. 네트워크/데이터 접근 정책과 인덱스는 수집하지 않습니다.
- Transit Gateway: 게이트웨이와 `available` 상태의 VPC attachment를 연결합니다. 라우트 테이블 전파·경로 또는 다른 계정의 VPC를 추론하지 않습니다.
- Cloud Map: namespace·service를 별도 노드로 표시하고 namespace–service, Route 53 hosted zone, ECS service registry/Service Connect의 ARN 참조를 연결합니다. 등록 인스턴스의 개별 상태는 조회하지 않습니다.
- WAF: 선택 리전의 Web ACL과 CloudFront용 글로벌 Web ACL을 별도로 수집합니다. ALB·REST API stage·AppSync의 연결 및 CloudFront의 Web ACL 참조를 연결합니다. 규칙 본문은 저장하지 않습니다.
- ACM: 선택 리전과 CloudFront 인증서 리전(`us-east-1`, 중복 조회 제외)의 인증서를 수집합니다. 만료/폐기/실패는 위험, 만료 30일 이내는 주의로 표시합니다. CloudFront와 ELB listener의 기본 인증서 연결을 표시하며 추가 SNI 인증서는 조회하지 않습니다.

WAF 글로벌 조회는 `us-east-1`을 사용합니다. 다른 파티션의 글로벌 서비스 리전은 지원하지 않습니다. 새 유형은 지도·검색·상세 및 관련 자원에서 사용할 수 있지만 CloudWatch 지표는 아직 지원하지 않습니다. Cloud Map·WAF는 구성 조회 성공만으로 건강 상태를 단정하지 않습니다. 상세 조회가 실패한 자원은 목록에서 확인한 정보를 유지하고 `상세 미수집`으로 표시합니다. 태그·관계 조회 오류는 서버 로그에 남기며 확인하지 못한 연결은 추가하지 않습니다.

추가 권한은 `scheduler:ListSchedules/GetSchedule`, `aoss:ListCollections/BatchGetCollection/ListTagsForResource`, `ec2:DescribeTransitGateways/DescribeTransitGatewayAttachments`, `servicediscovery:ListNamespaces/GetNamespace/ListServices/GetService/ListTagsForResource`, `wafv2:ListWebACLs/GetWebACL/ListTagsForResource/ListResourcesForWebACL`, `acm:ListCertificates/DescribeCertificate/ListTagsForCertificate`입니다. 모두 기존 읽기 전용 SDK guard를 통과하며 비밀 값·로그 본문·인증서 개인 키는 조회하지 않습니다.

## 토폴로지 읽는 법

- 플레이트: VPC(보라 테두리) 안에 서브넷(파랑 테두리)이 들어가고, VPC 밖 리전 서비스는 분류별 점선 레인에 놓입니다.
- 집계 노드(점선 카드): 같은 자리에 같은 유형이 많거나 관계가 없는 자원을 접어 둔 것입니다. 클릭하면 펼쳐집니다. 검색어에 맞거나 선택한 노드의 이웃은 항상 개별 노드로 나옵니다.
- EBS 볼륨: 인스턴스에 연결된 볼륨은 노드로 그리지 않고 인스턴스 속성 `볼륨`에 개수·용량·유형·암호화(`2개, 100 GiB (gp3, 암호화)`)로 요약합니다. 어디에도 연결되지 않은 볼륨만 스토리지 레인에 `EBS 볼륨` 노드(비활성, `미연결`)로 나와, 비용만 나가는 볼륨을 찾을 수 있습니다. 스냅샷은 수집하지 않습니다.
- 레이어(하단 툴바): 트래픽 펄스, 타깃 그룹, 보안 그룹, IAM 역할, KMS 키, 관계 없는 자원을 켜고 끕니다. 기본은 꺼져 있어 핵심 관계만 보입니다.
- 이름: 노드 이름은 구분자(`-` `_` `.` `/` `:`) 뒤에서 줄을 바꿔 두 줄까지 보이고, 더 길면 첫 줄은 앞부분, 둘째 줄은 `…`와 끝부분을 보여줍니다(`web/src/components/fitName.ts`).
- 호버: 노드에 마우스를 잠시 올리면 연결선이 강조되고, 옆에 카드로 전체 이름·유형·상태와 연결 관계(관계 종류 → 상대, 아래 줄에 포트·타깃 그룹 같은 세부)가 나옵니다.
- 선택: 노드를 클릭하면 1-hop 이웃만 밝게 남고 오른쪽 인스펙터에 속성·관계와 조회한 지표가 나옵니다. 일반 지표는 최근 3시간·5분 집계, S3 용량/객체 수는 최근 3일·일 집계이며 실제 기간·집계 주기를 표시합니다. 선 가운데 라벨(관계 종류와 짧은 세부)은 선택한 노드의 선에만 표시합니다. 선택한 자원은 필터와 무관하게 항상 보이고, 이웃이 체크 해제·검색·태그로 가려져 있으면 점선 테두리의 희미한 노드("숨김" 표시)와 점선 관계선으로 함께 나타납니다. `Esc`로 해제, `/`로 검색 포커스.
- 지도에서 보기: 유형별 표의 행 끝과 인스펙터(관계 목록 포함)의 조준 아이콘을 누르면 토폴로지로 전환해 그 노드로 확대·이동합니다.
- 유형 선택: 왼쪽 레일의 체크박스로 지도에 남길 유형을 고릅니다. 분류 체크박스는 그 안의 유형을 한꺼번에 켜고 끄며(일부만 켜지면 중간 상태), 맨 위 **전체**를 끄고 몇 가지만 체크하면 그것들만 봅니다. 3종 이하로 좁히면 해당 자원은 접지 않고 전부 펼치며, VPC·서브넷 플레이트는 위치 맥락을 위해 남기되 비는 플레이트는 숨깁니다. Option/Alt+클릭은 그 하나만 고르고, **초기화**는 체크·검색·태그를 모두 되돌립니다.
- 태그: 왼쪽 레일의 **태그** 탭에서 키 → 값 순으로 고르면 그 태그를 가진 자원만 (상위 컨테이너와 함께) 남습니다. 같은 키의 여러 값은 그중 하나만 맞아도 되고(OR), 서로 다른 키는 모두 만족해야 하며(AND), "연결된 자원도 함께 표시"를 켜면 1-hop 이웃까지 보입니다. 인스펙터의 태그를 클릭해도 같은 필터가 걸립니다. `Name`과 `aws:*` 같은 시스템 태그는 접혀 있습니다.

## 정리 후보

현재 구성에서 미연결 EBS, 빈 Target Group, 중지 EC2, 비활성 CloudFront를 모아 왼쪽 목록과 오른쪽 상세로 표시합니다. 상세에는 수집된 태그의 키·값을 함께 보여줍니다. 태그 정보가 없으면 태그 없음과 조회 실패를 단정하지 않으며, Owner 등의 태그를 생성자로 해석하지 않습니다. 현재 상태만으로 정리 후보를 확정하지 않습니다. 사용자가 **30일 이력 분석**을 실행하면 CloudTrail 관리 이벤트를 최대 90일까지 탐색하고 최근 30일 기록과 현재 상태를 함께 판단합니다. 추가 권한은 `cloudtrail:LookupEvents`입니다. 애플리케이션 로그나 CloudWatch 사용량 지표는 조회하지 않습니다.

기간은 상태 변경 요청 기록 이후의 **추정 경과 시간**이며 실제 연속 유지 기간을 보장하지 않습니다. 이력 누락·조회 실패·시점 불명은 근거 부족으로 표시합니다. 특히 Target Group 등록 해제 기록만으로 전체가 비게 된 시점을 확정하지 않습니다. 삭제·대상 제외 기능은 없습니다.

자원당 조회는 최대 10페이지·500건, 목록은 한 번에 최대 20개입니다. 성공한 이력은 계정·리전·구성 시각별 서버 메모리에 5분간 재사용합니다. 구성 사실은 기존 구성 캐시에 저장하지만 이력 원문·제외 설정은 저장하지 않습니다. [구현 범위와 검증 기록](docs/cleanup-candidates-plan.md)을 참고하세요. 실계정 CloudTrail 대조는 아직 수행하지 않았습니다.

## 모니터링

상단의 **모니터링**은 자원을 찾고 관련 자원을 추가해 같은 화면에서 CloudWatch를 확인하는 작업 공간입니다. 전체 토폴로지 수집을 기다리지 않고 열립니다. 로그 조회와 AWS 경보 생성·수정은 지원하지 않으며 24시간 감지·외부 알림은 기존 AWS 경보가 담당합니다.

1. 왼쪽 **자원 찾기**에서 이름·식별자·태그를 검색합니다. 화면 진입 시 Lambda / SQS / ALB / ECS service / EC2 / RDS instance 6유형의 경량 목록을 자동 조회합니다. **태그 조건**의 키·값 선택과 자원 행의 태그를 사용할 수 있으며 같은 키는 OR, 다른 키는 AND입니다. 태그 권한 실패는 **태그 미조회**로 구분합니다. 결과는 유형·이름순으로 고정되며, 검색을 바꿔도 함께 보는 자원은 유지됩니다.
2. 결과의 **추가**를 누르면 가운데 위 **함께 보는 자원**에 담기고, 그 아래에 자원별 **관련 경보와 CloudWatch 지표** 카드가 나타납니다. 연속 선택은 짧게 모아 조회하며 검색 결과와 관련 자원을 합쳐 **최대 8개**까지 함께 봅니다. 상한은 `shared`의 `MAX_OBSERVED_RESOURCES` 하나로 화면과 서버 지표 API가 함께 검사하며, 자원당 지표 쿼리는 최대 4개라 8개를 담아도 한 요청 100개 상한 안에 듭니다. 함께 보는 자원 제목 옆의 칸 표시와 "n개 더 추가할 수 있습니다" 문구로 남은 자리를 알 수 있고, 이름 칩을 누르면 해당 자원 카드로 이동합니다. 담긴 자원은 목록의 버튼이 **빼기**로 바뀌고, 함께 보는 자원의 ×, 자원 카드의 ×, 관련 자원 목록의 **빼기** 어디서든 뺄 수 있습니다. 8개가 차면 추가 버튼이 비활성화되고 하나를 빼라는 안내가 나옵니다. 선택·기간 변경은 지표를 자동 조회하므로 비용이 발생할 수 있습니다. 단순 검색·후보 탐색은 유료 지표 조회를 만들지 않습니다.
3. **함께 보는 자원**의 이름이나 자원 카드의 **관련 자원 보기**를 누르면 그 자원이 **기준**이 되고, 오른쪽 **관련 자원**에 **선으로 연결된 자원**과 **같은 태그의 자원**이 표시됩니다. 지표가 없는 유형(보안 그룹·IAM 역할 등)은 **지표 없음**으로 표시하고 목록 뒤로 보냅니다. 연결은 양방향 1-hop의 종류·방향을, 태그는 정확히 일치하는 키·값을 근거로 보여 줍니다. 기존 그래프에 직접 확인/추정 구분이 없으면 그 한계를 표시합니다. 구성은 캐시를 재사용하고 필요할 때 백그라운드로 수집하며 지표·태그 후보 조회를 막지 않습니다. 일부 실패와 이전 구성은 표시하고 관계가 없다고 단정하지 않습니다. 후보는 직접 **추가**해야 관측 대상에 포함됩니다.
4. 자원별 관련 경보를 누르면 상태 이유·조건 원문·선택 기간의 이력을 확인합니다. 공통 기간이나 직접 선택의 시작·종료 입력을 바꾸면 열린 경보 이력에도 자동 적용됩니다. 미연결 경보는 별도 안내에 남깁니다. 미지원 경보 매핑과 조회 리전의 한계를 표시하며 경보가 없다는 이유로 정상이라고 판정하지 않습니다. CloudFront 등의 지표 리전은 지표별로 표시하며 경보는 선택 리전만 조회합니다. 글로벌 경보는 `us-east-1` 범위도 확인하세요.
5. **함께 보는 자원**의 **구성 저장**으로 이름을 붙여 저장하고, **저장한 구성**에서 불러오거나 삭제합니다(삭제는 이 브라우저의 설정만 지우며 AWS 자원은 바꾸지 않습니다). 기존 v1 관심 묶음의 태그·수동 포함 설정은 보존합니다. 8개가 넘는 기존 구성은 조용히 자르지 않고 후보 중 직접 고르게 하며 확인하지 못한 자원도 표시합니다.

기간은 최근 1시간/3시간/24시간/7일 또는 직접 선택이며 길이는 최대 7일, 시작은 과거 455일 이내입니다. 서버는 서비스별 최소 집계 주기와 기간에 맞춰 해상도를 조정합니다. 자원별 지표는 같은 시간축·커서를 사용하며 같은 지표/단위/통계는 값 범위도 맞춥니다. 서로 다른 단위는 별도 차트로 표시합니다. 직접 선택의 시작·종료 입력을 바꾸거나 차트를 드래그하면 짧은 debounce 후 변경한 기간의 지표를 자동 조회합니다. **값 표 보기**로 데이터도 확인할 수 있습니다. 단일 점·0·결측·데이터 없음·부분 결과·권한 실패와 실제 조회 기간·최신 데이터 시각을 구분합니다. 그래프에서만 찾은 자원도 선택할 수 있으며 지표 미지원 유형은 관련 연결·경보만 확인하고 유료 지표 요청에서 제외합니다.

저장 구성은 같은 브라우저·origin의 localStorage에 버전 있는 설정으로 저장하며 인증 소스·계정·리전별로 분리합니다. 새 구성은 이름·선택 자원 키만 저장하고 AWS 지표나 로그 본문을 저장하지 않습니다. 다른 PC/브라우저 동기화는 없습니다. 화면을 왕복하면 현재 선택·기준 자원·기간을 이어갑니다.

주기적 **자동 갱신**은 기본 꺼짐이며 켤 때 기본 5분, 선택 가능한 간격은 1분/5분입니다. 모니터링 화면과 브라우저 탭이 보일 때만 선택 지표와 경보를 갱신합니다. 이전 요청 완료 후 다음 조회를 예약하며 429/일시 서버 오류·스로틀링·부분 결과는 2배·4배(최대 20분)로 늦춥니다. 인증/권한/만료 오류나 잘못된 조건·알 수 없는 오류는 자동 갱신을 끄고 재연결·조건 확인을 안내합니다. 직접 선택한 과거 기간에는 주기적으로 갱신하지 않습니다. 메뉴 이동·탭 숨김 시 새 예약을 멈추고 브라우저 요청을 취소하지만 이미 시작된 서버 공유 조회는 완료될 수 있습니다.

`GetMetricData`는 읽기 전용이어도 비용이 발생할 수 있습니다. 선택·기간 변경 전 비용 안내와 대상을 확인하세요. 서버는 한 요청에서 최대 100개 지표 쿼리·10개 SDK command를 허용하며 기본 SDK 재시도(maxAttempts 8)를 포함하면 HTTP 시도는 최대 80회입니다. 이 요청 상한은 비용 상한을 보장하지 않습니다. 경보 조회에는 `cloudwatch:DescribeAlarms`·`cloudwatch:DescribeAlarmHistory`, 지표에는 `cloudwatch:GetMetricData`, 자원 목록·태그·연결에는 해당 서비스의 읽기 권한이 필요합니다. 구현·검증 기록은 [자원 중심 모니터링 계획](docs/monitoring-resource-workspace-plan.md)을 참고하세요.

## 라이브 모드

상단바의 **라이브**를 켜면 탭이 보이는 동안 무료 호출만으로 화면을 갱신합니다.

| 주기 | 갱신 내용 | 호출 |
|---|---|---|
| 2분 | 인스턴스 상태·상태 검사, 타깃 헬스, ECS 실행/희망 작업, RDS·ElastiCache·NAT 상태, CloudWatch 경보 | `Describe*`/`List*` (무료) |
| 10분 | 자원 구성·관계 전체 재수집 (조용히 교체, 화면 맞춤 없음) | `Describe*`/`List*` (무료) |
| 수동 | 현재 구성의 전체 자원 지표·트래픽 펄스 | **전체 지표 조회** 버튼으로 `GetMetricData` 실행. 비용이 발생할 수 있음 |

일반 지도 진입·프로필 변경·구성 재수집은 지표를 자동 조회하지 않습니다. **전체 지표 조회**는 현재 그래프의 지원 지표 전체를 대상으로 하므로 자원이 많으면 조회량도 늘어납니다. 지도 라이브는 지표를 자동 조회하지 않습니다.

경보 갱신은 Lambda·SQS를 포함한 전체 자원에 적용합니다. 경보 조회 실패 시 마지막 성공 경보를 유지하고 조회 오류를 표시하며, 다음 조회가 성공해야 해제합니다. 지표는 값 0, 데이터 없음, 부분 결과, 조회 실패를 구별하고 조회 시각과 마지막 데이터 시각을 따로 제공합니다. 단일 점도 표시하며 누락 구간은 선으로 연결하지 않습니다.

상태가 바뀐 노드는 잠시 금빛 링으로 표시됩니다. 주기는 `web/src/model/live.ts`에 있습니다. 모든 호출은 CloudTrail 관리 이벤트로 남고 계정의 API 호출 한도를 함께 쓰므로, 더 짧은 주기는 권하지 않습니다.

## 권한

자격증명에 `ReadOnlyAccess` 수준의 권한이 있으면 모든 수집기가 동작합니다. 일부 API가 거부되면 해당 수집기는 가져온 범위까지만 그래프에 넣고 거부 사실을 서버 로그와 레일 하단의 "수집 실패" 목록에 남깁니다. 예를 들어 `ecs:DescribeClusters`가 거부되면 ECS 클러스터는 이름만 있는 '접근 거부' 노드로 표시되고, 서비스는 `ListServices`/`DescribeServices`로 가져온 만큼만 연결됩니다. CloudWatch 지표는 `cloudwatch:GetMetricData` 하나로 읽으며, CloudFront 지표만 `us-east-1`에서 조회합니다. 태그는 목록 API에 포함된 경우 그대로 쓰고, 그렇지 않은 서비스(Lambda, S3, DynamoDB, ECR, SQS, SNS, CloudFront, KMS, IAM 역할 등)는 자원별 `ListTags*` 계열 호출로 가져오므로 해당 권한이 거부된 자원은 태그 없이 표시됩니다.

## 검증

```bash
npm run typecheck   # shared / server / web
npm test            # server + web: 읽기 전용 가드, 로컬 요청, 경보/지표 오류, 캐시, 요청 경합, 차트 회귀
```

2026-10-27 v0.6.1 검증: 태그 표시 회귀를 포함해 서버 90개 + 웹 64개(총 154개), 전체 typecheck/build와 diff 검사 통과. 세 플랫폼 ZIP 무결성·버전, macOS ad-hoc 서명, Windows PE 형식을 확인했습니다. ARM 내장 서버 health(`0.6.1+20261027T013844Z`) 및 태그 UI 자산을 확인했습니다. Windows/Intel Mac 실제 실행·Apple 공증·실계정 조회는 미검증입니다.

2026-10-27 v0.6.0 검증: 서버 90개 + 웹 63개(총 153개), 전체 typecheck/build와 diff 검사 통과. macOS ARM/Intel·Windows x64 ZIP 무결성·버전, macOS ad-hoc 서명, Windows PE 형식을 확인했습니다. ARM 내장 서버 health(`0.6.0+20261027T005622Z`)와 정리 후보 웹 자산을 확인했습니다. 실계정 CloudTrail 대조, Windows/Intel Mac 실제 실행과 Apple 공증은 미검증입니다.

2026-10-26 v0.5.1 검증: 서버 74개 + 웹 58개(총 132개), 전체 typecheck/build와 diff 검사를 통과했습니다. macOS ARM/Intel·Windows x64 ZIP 무결성, Mac ad-hoc 서명, Windows PE 형식과 패키지 버전을 확인했습니다. ARM 내장 서버는 Electron utility process에서 health(`0.5.1+20261026T072120Z`)·내장 웹을 확인했습니다. Windows/Intel Mac 실제 실행과 Apple 공증은 미검증입니다.

2026-10-26 v0.4.0 검증: `npm test` 서버 73개 + 웹 56개(총 129개), shared/server/web 전체 typecheck, build, `git diff --check`를 통과했습니다. 함께 보는 자원 8개 상한·어디서나 빼기 테스트는 이전 코드에서 실패하는 것을 먼저 확인했습니다. 실계정에서 Lambda 8개를 담아 지표 쿼리 32개를 SDK 1회로 조회했고, 1440/1280/1024/820/390px와 다크/라이트에서 상단바 잘림·가로 넘침이 없음을 확인했습니다. macOS/Windows 실행파일 생성, zip 정합성, Windows PE 형식, macOS 서명(arm64·x86_64) 검사와 macOS ARM 실행파일의 health(`0.4.0+20261026T013509Z`)·내장 웹 자산을 확인했습니다. Windows/Intel Mac 실제 실행과 Apple 공증은 미검증입니다.

2026-10-23 v0.3.0 검증: `npm test` 서버 73개 + 웹 53개(총 126개), shared/server/web 전체 typecheck, 최종 build, `git diff --check`를 통과했습니다. 자원 검색·후보 추가·저장 복원·경보 이력·기간 변경·숨김 중단과 1440px 다크/640·360px 라이트 화면을 fixture 브라우저에서 확인했으며 최종 console/page error는 0개였습니다. 제한 실계정 조회에서 목록·관계와 Lambda 두 개의 6개 지표 쿼리를 확인했지만 결과는 모두 empty였으므로 값이 있는 차트는 fixture 검증으로 구분합니다.

최종 macOS/Windows 실행파일 생성·zip 정합성·Windows PE 형식·macOS 서명 검사를 통과했습니다. macOS ARM 실행파일의 읽기 전용 health와 빌드 `0.3.0+20261023T074320Z`, 내장 JS의 새 화면 반영을 확인했습니다. Windows/Intel Mac 실제 실행과 Apple 공증은 미검증입니다. A/B/C 구현·검증 범위와 남은 한계는 [자원 중심 화면 검증 기록](docs/monitoring-resource-workspace-plan.md)에 있습니다. 커밋·푸시·GitHub Release는 root 작업에서 진행하며 이 검증 기록은 게시 완료를 뜻하지 않습니다. 로그 조회는 후속 범위입니다.

### 마지막 이력 표시 (v0.6.2)

30일 후보 판정과 별도로 최근 90일 조회 범위의 마지막 관리 변경, 마지막 사용 관련 변경(기동·연결·등록·활성화), 현재 상태 변경 근거를 상세에 표시한다. 태그 변경은 관리 이력에 포함하되 상태 지속 기간 판정에는 사용하지 않는다. 조회된 전체 성공 관리 변경 이력은 최신순으로 펼쳐 볼 수 있다. 읽기 요청과 실패 요청은 표시 대상이 아니다.

실행 주체는 CloudTrail의 identity type과 ARN/사용자명/호출 서비스 중 확인되는 식별자만 표시한다. Role 세션을 실제 사람이나 자원 생성자로 단정하지 않는다. 원본 이벤트·액세스 키·IP는 전달하거나 저장하지 않는다. 일부 조회·오류는 ‘조회된 범위의 최신 기록’으로 표시하며, 기록 부재는 미사용 증거가 아니다. 90일 이전 이력을 위한 S3/Lake 연결과 생성자 전용 조회는 이번 범위에 포함하지 않는다.
