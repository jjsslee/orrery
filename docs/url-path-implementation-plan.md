# FE–BE 관계 탐색과 URL 경로 시뮬레이션 구현 계획

상태: **1단계 구현·fixture 검증 완료 / 2단계 UI 시안 선택 대기**. 기준일: 2026-10-26.

조사 근거: [전체 조사 보고서](../reports/URL%20기반%20요청%20경로%20시뮬레이션.md).
이 문서는 실행 순서와 단계별 완료 기준이다. 사용자 확인 후 **1단계만 먼저 구현·검증·보고**한다. 다음 단계는 그 결과와 사용자 지시에 따라 진행한다. 커밋·푸시·배포·운영 설정 변경은 포함하지 않는다.

## 1. 목표와 고정 원칙

첫 사용자 경험은 `CX FE 선택 → 자동 발견한 API 후보 선 확인 → 선 클릭 → API Gateway/Function URL과 Lambda 펼치기`다. URL 입력 시뮬레이터는 같은 데이터와 근거 모델을 활용하는 후속 기능이다.

- 관계 수동 등록, 브라우저 조작, 운영 로그 활성화를 기본 사용 조건으로 요구하지 않는다.
- FE 문서/정적 파일 요청과 브라우저의 API 요청은 서로 다른 요청이다. S3→API 호출선을 만들지 않는다.
- AWS 설정상 연결, CORS 허용, 코드 참조, 호출 관측을 구분한다. 허용을 호출 성공으로 표시하지 않는다.
- 조회 실패·미지원·권한 부족·범위 밖·오래된 데이터는 미확인 상태다. 미수집을 관계 없음으로 처리하지 않는다.
- 초기 범위는 현재 계정·선택 리전과 CloudFront 등 global 자원이다. 다른 계정·리전 자동 순회는 하지 않는다.
- 설정 조회와 지도 탐색은 실제 서비스 API 호출을 발생시키지 않는다. 로그 조회·객체 읽기는 비용과 권한을 별도 관리한다.

## 2. 단계별 실행 계획

### 1단계 — 기존 수집 데이터로 CORS 관계 근거 만들기

**목표:** 화면 변경 전에 FE–API 허용 관계를 정확하고 검증 가능한 데이터로 만든다. 추가 AWS 호출은 도입하지 않는다.

작업:
1. 공통 타입에 관계 근거와 수집 coverage를 추가한다. 기존 `ResourceEdge`는 호환 유지하며 새 FE 관계는 별도 데이터로 둔다.
2. HTTP API의 기존 `GetApis` 응답에서 `CorsConfiguration`을 보존한다.
3. REST API의 기존 integration 응답에서 고정 문자열 `Access-Control-Allow-Origin` 및 관련 method/header 정보를 추출한다. OPTIONS와 실제 응답의 범위를 구분한다. template·origin reflection·proxy의 동적 응답은 해석하지 않는다.
4. CloudFront 배포 도메인·aliases를 구조화하고 CORS origin의 host와 매칭한다. origin 자체는 scheme/host/effective port를 보존한다. host 일치는 호스팅 후보이고 실제 배포 도달/HTTPS 성공 보장은 아니다.
5. `*`, `https://*`, `http://*`, `null`, localhost 및 미매칭 외부 origin을 운영 FE 호출선으로 만들지 않는다. wildcard·외부·미확인 이유는 남긴다. 같은 태그/이름만으로 선을 만들지 않는다.
6. 현재 REST 편집 설정에서 얻은 근거는 `editable-config`로 표시한다. 배포본 확인 전 `deployed-config`로 승격하지 않는다.
7. 기존 graph cache 버전을 구분한다. 구버전에는 `근거 미수집`으로 표시하고 정상 재수집 때 갱신하며 무관한 사용자 설정을 지우지 않는다.
8. 환경 변수 원문·새 로그 수집 없이 origin과 최소 근거만 저장한다. 기존 추정 edge의 의미는 이번 단계에서 임의로 바꾸지 않는다.

변경 파일:
- `shared/src/index.ts`: 선택적 `relationshipEvidence`/`frontendRelations` 계약 및 coverage 타입.
- `server/src/collectors/edge.ts`, `server/src/collectors/types.ts`: 원형 CORS·호스트 정보 전달.
- 신규 `server/src/graph/frontend-relations.ts`: 순수 origin 정규화·후보 매칭·근거 dedup.
- `server/src/graph/assemble.ts`, `server/src/cache.ts`: 새 데이터 결합·버전 호환(실제 cache 소유 코드 확인 후 최소 변경).
- 신규 매칭/수집 fixture 테스트, `README.md`.

완료 기준:
- exact CORS + alias fixture에서 예상 FE/API 쌍만 생성된다.
- method/path/status 범위, REST 편집본 여부, 여러 origin 및 여러 API 후보가 손실되지 않는다.
- wildcard·태그 유사·다른 port/scheme·외부 도메인·오래된 cache가 거짓 확정 연결을 만들지 않는다.
- 기존 graph·monitoring contract가 유지되고 표준 검사 통과. **이 단계만으로 화면에 새 선이 나타나지는 않는다.**

### 2단계 — 토폴로지에서 FE 선택과 BE 펼치기

**착수 조건:** 사용자 요청에 따라 UI 코드 구현 전에 비교 가능한 샘플 시안을 여러 개 제시하고 사용자가 선택한 뒤 진행한다.

**목표:** 사용자가 제안한 탐색 흐름을 실제 화면에서 완성한다.

작업:
- 기존 CloudFront 선택을 FE 호스팅 선택으로 이어 주고, 명시적 FE 앱/그룹 표시를 추가한다. 원본 AWS 자원 노드는 유지한다.
- 선택된 FE의 CORS 관계만 우선 표시한다. API 후보는 접힌 끝점으로 표시하여 숨겨진 BE에도 선을 클릭할 수 있게 한다.
- 긴 점선과 `CORS 허용` 라벨을 사용한다. 실선은 명시 설정 근거인 관계에만 부여한다. 기존 refs 추정선은 provenance를 분류하거나 `근거 미분류`로 유지한다.
- 선/끝점 클릭 시 수집된 API와 그 API의 Lambda를 펼친다. 기존 선택·필터를 영구 변경하지 않고 탐색용 reveal 집합을 적용한다. FE/BE에 한정하여 화면을 맞추고 닫으면 원래 상태로 복원한다.
- 후보가 여러 개면 임의로 하나를 택하지 않는다. 미수집 target은 `미수집/범위 밖` 표시로 남기며 이 단계에서는 다른 scope를 자동 조회하지 않는다.
- 근거 상세에 origin, method/path 범위, source, 수집 시각, 편집/배포 상태, 한계를 표시한다.
- 범례·관계 레이어 toggle·키보드 접근을 제공한다. 기존 분류색/상태색을 유지하고 색만으로 의미를 전달하지 않는다.

변경 파일: `web/src/layout/scene.ts`, `web/src/canvas/Topology.tsx`, `web/src/canvas/edges/FlowEdge.tsx`, `web/src/model/store.ts`, `web/src/canvas/CanvasToolbar.tsx`, 관련 panel 및 신규 FE view-model/근거 상세 component. collector의 기존 edge provenance는 `server/src/collectors/ids.ts`, `server/src/graph/assemble.ts`를 중심으로 확인한다.

완료 기준: CX형 fixture에서 FE 선택→점선/후보 표시→클릭→API/Lambda 확장→근거 확인→복원이 동작한다. 다크/라이트·좁은 화면·필터·집계·재수집·프로필 전환에서 기존 탐색이 깨지지 않고 서비스 API 요청은 0회다.

### 3단계 — 배포 기준 연결과 Function URL 보강

**목표:** 첫 연결의 범위를 넓히고 실제 배포 설정과 편집 설정을 구분한다.

작업:
- REST stage `GetExport` 및 HTTP `ExportApi(StageName)`와 필요한 개별 조회로 배포 route/integration을 구성한다. HTTP auto-deploy 등 배포 상태도 보존한다.
- API Gateway custom domain/mapping·RoutingRules, HTTP routes를 조회하여 API host/path를 매칭한다.
- Lambda Function URL의 URL/CORS/auth/qualifier, aliases/version을 조회한다. 일반 Lambda의 코드 CORS를 중앙 설정처럼 취급하지 않는다.
- CF 동일 origin `/api/*` behavior도 FE–API 설정 관계로 제공한다. 여기에는 CORS가 필요 없다.
- 현재 범위에서 필요한 대상만 lazy 상세 조회한다. 권한 부족·pagination·오래된 snapshot을 coverage로 반환한다.
- `ExportApi` 등 현재 read-only guard와 충돌하는 command는 서비스+정확한 command 단위로 검토한다. prefix 전체 허용은 금지한다.

변경 파일: `server/src/collectors/edge.ts`, `lambda.ts`, 신규 `server/src/routing/` 수집/정규화 module, `server/src/aws/readonly-guard.ts`와 테스트, shared snapshot 계약.

완료 기준: API Gateway 없는 Function URL, custom domain, 같은 CF의 `/api/*`, alias와 편집/배포 divergence fixture를 정확하게 처리한다. 계정/리전/ARN이 다른 동명 자원으로 연결하지 않는다.

### 4단계 — URL 기반 요청·응답 시뮬레이터

**목표:** URL을 입력하면 설정상 가능한 경로와 응답 분기를 단계적으로 설명한다.

작업:
- 기본 GET 가정을 명시하고 method·필요한 비민감 routing 조건을 추가 입력으로 제공한다.
- URL→DNS/CloudFront→선택 behavior/origin→S3 또는 API→Lambda 경로를 구성한다. FE에서 발견한 API 요청은 별도 가지로 제공한다.
- `RoutingSnapshot`을 평가하는 순수 engine을 만든다. 기존 resource graph의 DFS 결과를 실행 경로로 사용하지 않는다.
- cache hit/miss/unknown, redirect, OPTIONS/preflight, 인증/WAF 미확인, weighted alias, async enqueue와 동기 응답을 분리한다.
- edge code·미지원 dynamic routing은 unknown에서 멈춘다. 평균 지표로 실제 요청 latency를 만들어내지 않는다.
- UI에서는 단계 재생·조건 선택·근거 확인·토폴로지 이동을 지원한다. 실제 HTTP probe는 하지 않는다.

변경 파일: 신규 `server/src/simulation/{routes,engine,normalize}.ts`, `shared/src` 계약, `web/src/views/Simulation.tsx`, API client와 view 전환. 파일 구성은 구현 시 기존 스타일에 맞춰 최소 분할한다.

완료 기준: method별 다른 Lambda, behavior 순서, mapping prefix, cache 응답, CORS simple/preflight 차이, 동적 규칙 unknown이 fixture와 일치한다. 실제 요청 실행 없이 전체 동작한다.

### 5단계 — 배포 파일·기존 로그로 자동 발견 보강

**목표:** CORS wildcard/부재 환경에서도 수동 관계 등록 대신 추가 근거를 찾는다.

작업:
- 제한된 배포 HTML/JS/runtime config에서 API 참조를 추출한다. JS 실행·버킷 전체 탐색·비밀 값 조회는 하지 않는다.
- 기존 API 측 REST execution/Lambda 앱/CloudFront/WAF 로그에서 Origin/Referer를 추출한다. 로그 목적지와 실제 기록 필드를 먼저 확인한다.
- access log에 임의 원본 header가 항상 있다는 가정을 금지한다. FE 호스팅 CF 로그를 별도 API 호출 증거로 사용하지 않는다.
- 짧은 점선 `코드 참조`, 기존 관계의 `호출 관측` 배지·기간·마지막 시각을 추가한다. 여러 근거는 같은 관계에 병합한다.
- 대상·기간·file/byte/query budget, 가격 안내, 민감정보 제거, SSRF/redirect/DNS 경계, 정확한 Logs command 예외를 검증한다.

완료 기준: 정적 참조·동적 미확인·로그 부재·표본·preflight·실패 요청을 구분한다. query token/쿠키/본문 등이 cache/log/UI에 노출되지 않는다. 비용·스캔 한계를 설명하며 로그 설정을 자동 변경하지 않는다.

### 6단계 — 추가 실행 경로와 기존 trace 연계

**목표:** ALB/ECS 등 지원 범위를 넓히고 특정 관측 요청과 설정 시뮬레이션을 대조한다.

작업: ALB priority/conditions/rewrite/targets, ECS task/ENI, 다계정·다리전 scoped identity, 기존 X-Ray/OTel parent/span 연결을 순차 추가한다. 시간/IP만으로 요청을 합치지 않는다. 새 instrumentation은 기본 요구하지 않는다.

선택적 후속: HAR import 또는 격리된 browser 관측. 이는 실제 요청·POST·로그인 부작용 가능성이 있어 본 계획의 기본 실행 범위에서 제외하며 별도 사용 선택과 설계가 필요하다.

완료 기준: 지원 adapter별 고정 fixture 및 승인된 환경의 실제 trace 대조. 미계측·미샘플링 구간은 unknown. 다계정은 연결된 범위만 조회하고 scope 오염이 없다.

## 3. 데이터와 API 계약

아래 이름은 구현 기준이며 기존 계약과 충돌하면 호환을 유지하는 최소 조정을 한다.

| 계약 | 필수 내용 |
|---|---|
| `RelationEvidence` | id, kind(`routing_config`, `allowed_origin`, `static_reference`, `observed`, `heuristic`, `unknown`), source resource/API field, scope, collectedAt, deployment state, request constraints, limitation |
| `FrontendRelation` | scoped relation ID, FE origin, hosting resource IDs, target API/resource ID 또는 unresolved endpoint, evidence IDs, coverage. S3→API 호출 edge가 아님 |
| `RoutingSnapshot` | schemaVersion, account/partition/region, resource ARN, source/deployment identifier, normalized rules, per-section coverage, fetchedAt |
| `RequestContext` | normalized URL, method 및 default 여부, 비민감 조건, scope, known/unknown inputs |
| `SimulationResult` | document request, discovered API requests, conditional steps/branches, response/async branches, evidence, missing coverage, freshness, collection budget result |

1단계는 기존 graph 응답에 선택적 field를 추가하며 새 endpoint를 만들지 않는다. 3단계의 상세 조회는 기존 session/client factory를 사용하는 scope-bound read endpoint로 분리한다. 4단계는 `POST /api/simulation`에 분석 조건을 보내되 서버는 관리 설정 조회/계산만 수행한다. body가 있다는 이유로 실제 대상 API 요청을 재전송하지 않는다. 구체 payload와 response fixture는 해당 단계 착수 전 확정한다. 비밀 header/token/body를 계약에 포함하지 않는다.

## 4. 검증·진행 방식

- 단계별 fixture를 먼저 정의하고 정상/오탐/부분실패를 검증한다. 기존 버그 수정에는 RED→GREEN을 확인한다.
- 각 코드 변경 단계에서 `npm run typecheck`, `npm test`, `npm run build`, `git diff --check`를 실행한다. UI 단계는 브라우저 fixture로 선 클릭·범례·viewport·필터·접근성을 확인한다.
- 최초 실환경 대조는 대표 서비스의 읽기 전용 구성 표본으로 제한한다. 별도 운영 변경·로그 활성화·실제 서비스 호출 없이 CORS 존재/값·API 종류·scope를 확인한다. 접근이 안 되면 fixture 통과와 실계정 미검증을 구분해 보고한다.
- 관련 README를 변경과 함께 갱신한다. AGENTS/스킬 문서는 동작과 모순되는 내용이 생길 때만 수정한다.
- 완료 보고는 변경 내용, 실제 검사 결과, 남은 한계와 다음 단계로 구성한다. 표준 검사 후에도 고위험 변경의 중요한 불확실성이 남는 경우에만 사용자 지침에 따라 교차 리뷰 실행 여부를 묻는다. 자동 교차 리뷰는 하지 않는다.
- 별도 요청 없는 commit/push/배포 및 AWS 쓰기는 하지 않는다.

## 5. 이번 확인 범위

사용자는 전체 방향과 **1단계 착수**를 승인했다. 1단계 구현·검증을 마치고 보고하며, 2단계는 여러 UI 시안을 제시하고 선택받은 뒤 구현한다. 이후 단계를 자동으로 모두 구현하지 않는다. 1단계는 데이터 기반 구축이며 사용자에게 보이는 탐색 기능은 2단계에서 완성된다.


## 6. 1단계 실행 결과 (2026-10-26)

- `CorsRule`, `FrontendDiscovery`, `FrontendRelations`를 도입했다. 기존 graph에 선택적 `frontendRelations`를 추가하며 기존 자원 edge와 UI 동작은 유지했다.
- HTTP CORS와 REST 정적 integration response, CloudFront hosts를 기존 API 응답에서 수집한다. 동적 template/proxy, 조회 실패/상한, wildcard 및 invalid origin을 구분한다.
- 관계와 근거는 source/account/region scope에 묶고 구버전 그래프는 `graph-v3` namespace로 구분한다. 기존 사용자 저장 구성은 변경하지 않았다.
- 기존 profile A→B→A 경합 테스트에 관계 데이터를 포함하고, 늦은 성공 응답이 이전 계정 관계를 복원하지 않는 테스트를 추가했다. 별도 계정/리전/인증 소스 cache 격리와 동명 자원 ID 분리도 검증했다.
- 검증: 서버 85개 + 웹 57개, 총 **142개 테스트 통과**. shared/server/web/desktop typecheck, web build, `git diff --check` 통과. 별도 lint script는 없다.
- 실계정 조회·실제 URL 호출·프로덕션 배포·실행파일 재패키징은 수행하지 않았다. CORS로 연결되는 실제 계정의 비율은 미검증이다.
- UI 코드는 구현하지 않았다. 사용자 요청대로 **여러 시안을 먼저 비교·선택한 뒤** 2단계 UI를 구현한다.


## 7. UI 시안 준비 (2026-10-26)

사용자 요청에 따라 production UI 구현 전에 [독립 시안](mockups/fe-be-discovery/index.html)을 준비했다. A 지도 내 확장, B 후보 패널, C 서비스 집중 탐색을 같은 예시 데이터로 비교한다. FE 선택·선 클릭·BE 확장·연결 근거와 다크/라이트를 직접 확인할 수 있다. **선택 전까지 2단계 production UI 적용은 대기한다.**

최신 Git 지시: **전체 구현이 끝난 뒤 한 번에 커밋**한다. 중간 단계 commit/push는 실행하지 않는다.


## 8. 최신 UI 방향 수정 (2026-10-26)

사용자는 정적인 관계 탐색보다 **End user 클릭 → 요청 점이 자원을 따라 이동 → 응답 점이 사용자에게 귀환 → 응답 수신 표시**를 원한다. 기본 화면에서 CORS를 강조하지 않는다. CORS는 FE–BE 연결을 특정하는 내부 근거로 유지하고 상세에서만 볼 수 있다.

[요청·응답 흐름 시안](mockups/request-journey/index.html)을 새로 작성했다. A 전체 지도 고정, B 현재 요청 집중, C 화면/API 두 행으로 비교한다. 앞선 [관계 탐색 시안](mockups/fe-be-discovery/index.html)은 이 최신 방향으로 대체됐다. 사용자 선택 전 production UI 구현은 계속 대기한다.

시뮬레이션 화면은 FE 문서 요청/응답과 브라우저의 API 요청/응답을 시간 순서로 구분한다. 캐시 조건과 요청·응답 방향을 보여준다. 1단계 CORS 관계 데이터만으로 모든 이동 경로를 확정하지 않는다. 실제 기능의 경로 계산은 계획 3·4단계의 배포/route/조건 모델에 의존하며, 예시 애니메이션을 실제 관측으로 표현하지 않는다. UI 선택 후 이 사용자 여정을 기준으로 2~4단계 구현 순서를 구체화한다.


## 9. A안 production 구현 (2026-10-26)

사용자가 A안을 선택하고 구현을 승인했다. 5~8절의 UI 대기는 종료됐으며, 2단계 UI와 3~4단계의 기본 경로 해석을 함께 적용했다. 별도 simulation endpoint 대신 수집 graph의 `requestRouting`을 순수 함수로 계산한다. 특정 계정·도메인에 의존하지 않는다.

- End user 클릭, 요청/응답 점 이동, 단계·속도·scrub·일시정지, URL/시작 자원 선택, 후속 API 후보·route 선택, cache hit/miss 가정을 제공한다.
- CF 순서별 behavior/origin과 REST/HTTP API route의 명시적 Lambda ARN을 사용한다. CloudFront·REST는 기존 응답에서 추출하고 V2는 `GetRoutes` 페이지 조회를 추가했다. cache namespace는 `graph-v4`다.
- 문서 왕복 후 별도 브라우저 API 왕복을 보여준다. 실제 응답 상태·내용·지연·호출 여부를 주장하지 않는다. CORS는 접힌 근거에서만 설명한다.
- 모든 기존 유형의 인접 자원은 관련 맥락으로 표시하지만 실행 경로로 순회하지 않는다. AppSync는 데이터 소스까지 관계를 표시하며 query/resolver별 실행은 미구현이다. ALB listener, custom-domain mapping, stage export, Function URL, 실제 로그/trace 및 FE 파일 분석은 후속 범위다. 전체 3~6단계 완료를 뜻하지 않는다.
- 부분 수집·Edge 함수·비동기·교차 계정/리전 대상·미수집 오리진은 미확인으로 중단한다. 계정/스냅샷 교체 시 재생 초기화, 숨김 시 일시정지, reduced-motion 시 단계 이동을 적용한다.
- 브라우저 fixture 검증: 8구간 왕복, AppSync 미확인 중단과 데이터 소스 표시, scope 변경 초기화, reduced-motion 정지, 1440/1024/820/390px 화면을 확인했다. 검증 중 API 경로는 모두 mock 처리했다. 초기 mock 패턴이 Vite 소스 URL까지 가로채던 검증 설정 오류는 API endpoint로 좁혀 수정했다.
- 실계정 조회·실제 서비스 호출·배포·실행파일 재패키징·commit/push는 수행하지 않았다.

최종 검증: 서버 88개 + 웹 66개 = **154개 테스트 통과**, shared/server/web/desktop typecheck, production web build, `git diff --check` 통과. 별도 lint script는 없다. 추가 브라우저 검증에서 cache hit의 6구간 경로, 숨김 시 일시정지, 토폴로지 복귀, 모바일 입력 겹침 수정 후 각 입력 경계를 확인했다. 수정 후 UI 실행에서 page error는 없었다. [데스크톱 화면](mockups/request-journey/implementation-desktop.png) · [모바일 화면](mockups/request-journey/implementation-mobile.png).

## 10. v0.5.0 릴리즈 준비

사용자가 커밋·푸시·릴리즈를 승인했다. 루트 버전을 0.5.0으로 올리고 154개 테스트·전체 typecheck·build를 재검증했다. macOS ARM/Intel·Windows x64 ZIP, Mac ad-hoc 서명, ZIP 무결성, Windows PE 형식과 모든 패키지의 버전·UI 포함을 확인했다. macOS ARM 내장 서버를 Electron utility process에서 실행해 health(`0.5.0+20261026T065510Z`)와 내장 웹 자산을 확인했다. 실계정 호출·Windows/Intel 실제 실행·Apple 공증은 수행하지 않았다. 배포 내용은 [v0.5.0 릴리즈 기록](releases/v0.5.0.md)에 정리했다.
