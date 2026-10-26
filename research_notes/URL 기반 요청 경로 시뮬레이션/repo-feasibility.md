# Orrery 코드 기반 URL 요청 경로 시뮬레이션 구현 적합성

조사일: 2026-10-26. 로컬 코드만 읽었다. 실계정 조회, 실제 URL 호출, 구현 수정, 테스트 실행은 하지 않았다. 본 문서의 제안은 설계 추론이며 현재 구현 기능이 아니다. 외부 AWS 기능의 세부 지원 조건은 동료 연구의 `aws-paths.md`, `frontend-evidence.md`와 함께 대조해야 한다.

## 현재 데이터로 무엇을 할 수 있으며 어떤 정보가 유실되는가

### Takeaway
현재 자원 수집과 관계 지도는 좋은 재사용 기반이지만, 이 그래프를 그대로 따라가면 실제 요청 경로처럼 보이는 거짓 경로를 만들 수 있다. URL 라우팅 원본 정보와 관계 근거를 별도 보존하는 작은 경로 엔진이 먼저 필요하다.

### Cited Findings

| 영역 | 현재 조회·보존 | 조회하지만 버리는 정보 / 미수집 | 코드 근거 |
|---|---|---|---|
| CloudFront | `ListDistributions`, 태그, 기본 도메인, aliases 문자열, 기본 오리진 도메인, 모든 오리진을 refs로 전달 | cache behavior 순서·path pattern·target origin 연결, origin path, origin groups, edge function associations 등을 경로 데이터로 보존하지 않음. 세부 배포 설정은 대상 한정 `GetDistributionConfig` 등으로 보강 가능 | [edge.ts:73](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:73) |
| Route 53 | hosted zone과 record set 조회, alias·CNAME 대상 참조 | record 이름과 대상의 1:1 대응을 aggregate refs로 바꿈. 이름 목록은 30개까지, 가중치·failover·TTL·health routing을 보존하지 않음. 최대 2,000개 기준 루프이므로 truncation 표현 필요 | [edge.ts:53](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:53), [edge.ts:276](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:276) |
| REST API Gateway | APIs, stages, resources와 methods, integrations, API→Lambda 연결 | 여러 method/path가 같은 Lambda로 가면 `N개 라우트` 라벨로 축약. stage의 deployment ID·variables·canary/log 설정, auth·response mapping 등을 경로 모델에 보존하지 않음. 커스텀 도메인/mapping 및 실제 stage 배포본 export 미수집 | [edge.ts:119](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:119), [edge.ts:185](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:185) |
| HTTP/WebSocket API Gateway | APIs, stages, integrations | `GetRoutes` 호출이 없어 path/method→integration 대응 없음. CORS 등 API 응답 필드도 노드에 보존하지 않음. stages는 MaxResults=100 한 번이며 paginator 없음. 도메인/API mapping, deployment export 없음 | [edge.ts:192](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:192) |
| Lambda | ListFunctions, event source mappings, tags, env 값 refs, VPC·SG·IAM·KMS·DLQ | env key를 `Object.values`에서 소실. alias/version을 함수 이름으로 축약. Function URL, alias routing 설정·qualified config 없음 | [lambda.ts:27](/Users/jin/Repos/orrery/server/src/collectors/lambda.ts:27), [lambda.ts:49](/Users/jin/Repos/orrery/server/src/collectors/lambda.ts:49), [util.ts:45](/Users/jin/Repos/orrery/server/src/collectors/util.ts:45) |
| ALB/NLB | LB·target group·health·listeners 조회. TG→instance/Lambda/ALB 및 TG→ECS service 연결 | listener를 Protocol:Port 문자열로 축약하므로 default actions 소실. listener rules를 조회하지 않음. host/path/header/query 조건, 우선순위, auth/redirect/fixed response/weighted forward/URL transform 없음 | [elb.ts:53](/Users/jin/Repos/orrery/server/src/collectors/elb.ts:53), [elb.ts:69](/Users/jin/Repos/orrery/server/src/collectors/elb.ts:69), [elb.ts:114](/Users/jin/Repos/orrery/server/src/collectors/elb.ts:114) |
| ECS | service task definition, container env 값, secrets 참조 ARN, LB target group·container port | env key 소실, individual running task/IP 매칭 없음. TG→service는 서비스 배치 관계이지 이번 요청의 task 선택 증거가 아님 | [ecs.ts:118](/Users/jin/Repos/orrery/server/src/collectors/ecs.ts:118), [ecs.ts:140](/Users/jin/Repos/orrery/server/src/collectors/ecs.ts:140), [ecs.ts:179](/Users/jin/Repos/orrery/server/src/collectors/ecs.ts:179) |
| S3 | bucket region·tags·versioning·public access block | HTML/JS/config 본문은 읽지 않음. website/redirect rules도 없음 | [s3.ts:1](/Users/jin/Repos/orrery/server/src/collectors/s3.ts:1) |
| 관계 근거 | source/target/kind/label 및 scalar props | 명시된 설정·추정·실제 관측의 구별 없음. refs는 assemble 후 제거. monitoring도 evidence를 `unknown`으로 표시 | [shared/src/index.ts:158](/Users/jin/Repos/orrery/shared/src/index.ts:158), [assemble.ts:57](/Users/jin/Repos/orrery/server/src/graph/assemble.ts:57), [related.ts:25](/Users/jin/Repos/orrery/server/src/monitoring/related.ts:25) |

- CloudFront aliases는 `대체 도메인` 문자열에 있지만 관계 인덱스는 `DNS`, `dnsName`, `도메인`, `엔드포인트`, `호스트`, `_hosts`만 읽는다. alias 일치를 추가하면 기존 API 조회만으로 개선할 수 있다. [assemble.ts:85](/Users/jin/Repos/orrery/server/src/graph/assemble.ts:85)
- env URL이 대상 자원과 맞으면 source/target 유형으로 `reads`·`invokes` 등 관계를 결정한다. `ALLOWED_ORIGINS=https://app.example.com`처럼 Lambda가 FE 주소를 허용하는 설정이 발견되어도 이것은 Lambda→FE 호출 근거가 아니다. key의 의미를 보존하지 않은 채 역방향 호출로 바꾸면 안 된다. [assemble.ts:108](/Users/jin/Repos/orrery/server/src/graph/assemble.ts:108), [lambda.ts:49](/Users/jin/Repos/orrery/server/src/collectors/lambda.ts:49)
- 같은 태그는 현재 모니터링 후보에서만 표시하며, 어떤 key/value든 하나 같으면 후보가 된다. `Environment=prod` 등 범용 태그를 실제 호출선으로 승격하면 대량 오탐이 난다. [related.ts:30](/Users/jin/Repos/orrery/server/src/monitoring/related.ts:30)
- `nid(type,nativeId)`는 account/region을 포함하지 않는다. 그래프 자체는 source/account/region을 갖지만 여러 범위를 합치는 순간 같은 이름의 Lambda 등이 충돌할 수 있다. 시뮬레이터는 ARN 또는 scope+native key를 사용해야 한다. [ids.ts:3](/Users/jin/Repos/orrery/server/src/collectors/ids.ts:3), [shared/src/index.ts:179](/Users/jin/Repos/orrery/shared/src/index.ts:179)
- ARN fallback은 service와 이름으로 매칭하며 API host fallback도 API ID 중심이다. 현재 단일 계정·리전 설계를 넘어선 경로 확장에서 ARN account/region을 검증하지 않고 연결하면 잘못된 자원과 이어질 수 있다. [assemble.ts:158](/Users/jin/Repos/orrery/server/src/graph/assemble.ts:158)
- 수집되지 않은 대상의 edge는 drop되고 refs도 삭제된다. 따라서 기존 그래프의 '선 없음'은 '호출 없음'이 아니라 범위 밖/권한 없음/미지원이 사라진 결과일 수 있다. [assemble.ts:41](/Users/jin/Repos/orrery/server/src/graph/assemble.ts:41)
- `attempt`는 per-resource 오류를 로그로 남긴 뒤 undefined로 반환한다. 상위 수집기는 결과를 반환하면 `ok:true`이고 edge collector도 일부 하위 실패를 로그만 남긴다. 경로 엔진에는 필드/단계별 coverage가 필요하다. [util.ts:23](/Users/jin/Repos/orrery/server/src/collectors/util.ts:23), [collectors/index.ts:29](/Users/jin/Repos/orrery/server/src/collectors/index.ts:29), [edge.ts:320](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:320)
- REST integration 개별 보완은 계정 단위 200회까지만 실행하고 이후는 조용히 return한다. URL 분석 결과에서는 이런 quota cap으로 인한 미수집을 별도 표시해야 한다. [edge.ts:29](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:29), [edge.ts:150](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:150)

### Inferences

#### CORS를 이용한 자동 FE 후보 연결 보충

- **HTTP API는 추가 AWS 호출 없이 개선 가능한 부분이다.** 현재 `GetApis` 응답의 `Api`에는 `CorsConfiguration`이 들어올 수 있지만 `apiGatewayV2`는 API endpoint·name·tags 등만 보존하고 이를 사용하지 않는다. `CorsConfiguration.AllowOrigins`의 구체적인 origin을 CF alias와 맞추면 '이 API가 허용하는 FE 후보'를 자동 생성할 수 있다. 이 응답은 수집 중 메모리에는 있지만 최종 graph/cache에는 남지 않으므로 이미 저장된 graph만으로는 복원 불가하고 재수집 필요. [edge.ts:197](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:197), [edge.ts:233](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:233), [설치 SDK Api 타입](/Users/jin/Repos/orrery/node_modules/@aws-sdk/client-apigatewayv2/dist-types/models/models_0.d.ts:67)
- **REST API는 OPTIONS/mock 및 non-proxy integration response에서 가능한 범위가 있다.** 현재 `GetResources(embed:['methods'])`의 `methodIntegration` 또는 보완 `GetIntegration` 응답을 `consume(path,method,integration)`에 전달한다. 이 함수는 integration type·URI만 처리하고 `integrationResponses[status].responseParameters['method.response.header.Access-Control-Allow-Origin']` 같은 값을 버린다. `OPTIONS`도 method loop에 포함되므로 정적 문자열로 지정된 origin이면 기존 조회에서 추출할 수 있다. responseParameters가 mapping 표현식/동적 값이면 확정 origin으로 해석하면 안 된다. [edge.ts:128](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:128), [edge.ts:136](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:136), [edge.ts:144](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:144), [SDK integrationResponses 타입](/Users/jin/Repos/orrery/node_modules/@aws-sdk/client-api-gateway/dist-types/models/models_0.d.ts:1347), [SDK responseParameters 타입](/Users/jin/Repos/orrery/node_modules/@aws-sdk/client-api-gateway/dist-types/models/models_0.d.ts:1208)
- **REST Lambda proxy가 응답에서 정하는 CORS는 위 integration 설정만으로 알 수 없다.** 함수 env에 origin이 있는 경우는 별도 설정 근거이고, 코드·로그·실제 응답을 읽지 않는 현재 수집으로 동적 CORS 결과를 복원할 수 없다. 또한 현재 REST resources는 stage deployed export가 아니므로 '편집 구성 기준 CORS'라는 한계가 동일하게 적용된다. [edge.ts:130](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:130), [lambda.ts:49](/Users/jin/Repos/orrery/server/src/collectors/lambda.ts:49)
- **Lambda Function URL은 추가 호출 필요.** 현재 Lambda collector는 `ListFunctions`, `ListEventSourceMappings`, `ListTags`만 사용한다. Function URL·CORS를 얻으려면 대상 함수의 `ListFunctionUrlConfigs`/`GetFunctionUrlConfig` 등 별도 읽기가 필요하며 qualifier/alias도 유지해야 한다. [lambda.ts:8](/Users/jin/Repos/orrery/server/src/collectors/lambda.ts:8), [SDK GetFunctionUrlConfigResponse 타입](/Users/jin/Repos/orrery/node_modules/@aws-sdk/client-lambda/dist-types/models/models_0.d.ts:4053)
- **의미:** 구체 origin 일치는 강한 '허용 대상' 근거이지 실제 사용·요청 성공 증거가 아니다. wildcard `*`, 광범위 `https://*`, localhost/dev 주소는 운영 FE 호출 확정에 쓰지 않는다. 같은 origin의 상대 `/api` 호출은 CORS 설정이 없어도 가능하므로 CORS 부재를 FE-BE 관계 부재로 판단하지 않는다. 서비스/환경 태그와 함께 후보를 좁힐 수 있으나 '관측됨' 배지는 로그·trace 근거가 있을 때만 붙인다. AWS 세부 CORS 동작은 frontend-evidence 연구 공식 출처와 함께 최종 보고서에 반영한다.

1. 기존 API 응답에서 구조화해 보존하는 작업이 첫 번째 가치다. CloudFront aliases·behaviors, Route 53 record별 매핑, REST method/path·stage 정보, Lambda/ECS env의 분류된 의미, ALB listener actions는 현재 수집 경로를 크게 바꾸지 않고 정보를 살릴 수 있다.
2. 별도 추가 읽기 수집은 대상 URL 경로에 한정해야 한다. API 도메인/mapping/routing rules, REST stage 배포본, HTTP routes, Function URLs/aliases, ALB rules, CF full config를 온 계정 대상으로 매번 다 조회하지 않는다.
3. FE/BE를 하나의 요청으로 그리면 안 된다. HTML/JS를 받는 navigation 요청과 브라우저 실행 중 발생하는 API 요청은 별개의 요청이다. `frontend-app`과 `browser`를 simulation 전용 논리 노드로 만들고 기존 AWS resource ID와 연결하면 ResourceType 전체를 확장하지 않아도 된다.
4. 재생 animation은 기존 traffic pulse와 시각적으로 분리한다. 기존 metric traffic는 자원 단위 수치 정규화 결과이므로 특정 요청이 지나갔다는 증거가 아니다. [metrics/cloudwatch.ts:216](/Users/jin/Repos/orrery/server/src/metrics/cloudwatch.ts:216)

### Gaps

- 실제 사용자 AWS 계정에 FE env, 의미 있는 tags, 로그, 외부 도메인 연결이 얼마나 존재하는지 확인하지 않았다. 자동 연결 성공률 수치나 '거의 전부 찾는다'는 보장은 불가하다.
- repo에는 이 기능의 엔진·스키마가 아직 없다. 현재 범용 관계 그래프만으로 header/path-aware 시뮬레이션을 실행할 수 없다.

## 최소 아키텍처와 사용자 경험은 어떻게 구성하는가

### Takeaway
기본 동작은 실제 URL을 호출하지 않는 설정 기반 '예상 경로'여야 한다. 자동화는 강하게 하되, 근거가 부족한 구간을 물음표와 조건부 분기로 남겨 정확도를 유지한다.

### Cited Findings

- 현재 shared 모델의 `props`는 표시용 scalar이고 edge에는 provenance가 없다. 원본 AWS 설정 전체를 props JSON 문자열로 넣는 대신 별도 typed routing snapshot을 도입해야 한다는 근거다. [shared/src/index.ts:121](/Users/jin/Repos/orrery/shared/src/index.ts:121), [shared/src/index.ts:158](/Users/jin/Repos/orrery/shared/src/index.ts:158)
- collector output은 nodes/edges/alarms만, UI view는 topology/types/monitoring만 제공한다. 따라서 별도 simulation service + view를 추가하면 현재 화면·모니터링 계약을 크게 흔들지 않는다. [collectors/types.ts:4](/Users/jin/Repos/orrery/server/src/collectors/types.ts:4), [store.ts:7](/Users/jin/Repos/orrery/web/src/model/store.ts:7)
- 세션·cache 분리는 이미 source/account/region 단위이며 credential snapshot과 client factory를 재사용할 수 있다. [sessions.ts:18](/Users/jin/Repos/orrery/server/src/aws/sessions.ts:18), [clients.ts:18](/Users/jin/Repos/orrery/server/src/aws/clients.ts:18)
- 기존 cache는 JSON 파일에 일반 텍스트로 저장하며 파일 이름만 hash한다. 새 URL query, env, 로그/trace 원문을 여기에 통째로 저장해서는 안 된다. [cache.ts:29](/Users/jin/Repos/orrery/server/src/cache.ts:29)

### Inferences

권장 구조(신규 설계):

```text
URL 입력
  → RequestContext 정규화
  → hostname index 조회 / 필요한 routing config만 보강
  → deterministic route resolver
  → FE API 후보 discovery
  → optional existing-log/trace evidence enrichment
  → EvidencePathResult
  → 단계별 경로와 응답/분기/미확인 표시
```

입력 기본은 URL + 기본 GET. 고급 입력에는 method, 최소한의 비밀 없는 route-relevant headers, 요청을 보는 위치(public/private), cache 가정(unknown/hit/miss), 선택 계정/리전 범위가 들어간다. 인증 값·Cookie를 넣어야 하는 실제 호출 모드는 별도 기능으로 격리한다. URL fragment는 서버 전송 경로에서 제외하되 SPA client route 후보로 보존한다. host는 lower/IDNA 정규화, path는 서비스별 인코딩·normalization 규칙을 지켜야 하며 임의 전체 decode하지 않는다.

핵심 신규 타입 제안:

- `RoutingSnapshot`: schemaVersion, source/account/region, resourceArn, configRevision/deploymentId, fetchedAt, per-section coverage, normalized routing rules. secrets 없는 최소 필드만 보존.
- `Evidence`: kind=`configuration | observed-log | observed-trace | static-code | heuristic`, source API/log reference, timestamp/time window, exact match facts, caveats, request association. '확신 95%' 같은 검증하지 않은 점수 대신 근거 유형과 match 범위를 표시.
- `RequestContext`: URL의 안전한 표현, method, known route inputs, unknown inputs, scope, assumptions.
- `PathStep`: logical/resource node, action(route/cache/authorize/invoke/respond/async-publish), evidence IDs, config certainty, runtime verification, condition, unknown reason.
- `PathBranch`: alternatives와 선택 조건. weighted/random failover, unknown headers, cache hit/miss 등은 단일 선으로 확정하지 않는다.
- `SimulationResult`: navigation path, discovered API calls와 각각의 경로, response path, async descendants, unresolved segments, coverage matrix, freshness, API request budget/actual usage. 전체 `complete=true` 하나보다 범위별 coverage가 필요.

구성 판정과 실제 관측을 하나의 confidence 축에 섞지 않는다. 예: 'AWS 설정상 확정, 이번 실행은 미관측', '이전 24시간 호출 관측, 현재 구성은 10분 전 수집'. 설정에 명시된 CF origin도 cache hit이면 이번 요청에서 방문하지 않는다.

경로 해석 원칙:

1. DNS 조회는 사전 이름 해석 단계이지 HTTP 응답이 DNS를 통해 역순으로 돌아오는 hop이 아니다. VPC/subnet/IAM/KMS/SG도 모두 HTTP hop에 넣지 않고 보호·권한·배치 관계로 표시한다.
2. CloudFront behavior 선택 후 cache hit은 edge response에서 끝난다. miss는 origin을 따라간다. function rewrite/origin 변경을 정적으로 판정하지 못하면 그 지점에서 조건부로 표시한다.
3. API method/path/host뿐 아니라 custom-domain routing rules, stage deployment와 variables, auth, canary, alias version 등 해당 조건을 평가한다. 신규 RoutingRules/CloudFront origin-changing functions/ALB host·URL transforms도 legacy mapping만으로 처리했다고 주장하면 안 된다.
4. REST stage 최신 미배포 resource 설정을 운영 route로 단정하지 않는다. deployed export가 없으면 '현재 편집 구성, 실제 stage와 다를 수 있음'을 명시한다.
5. Lambda env가 DB endpoint를 가리키더라도 이번 route가 DB를 사용했는지 모른다. 이를 '구성상 의존 후보'로 별도 표시한다. 특정 호출의 downstream은 trace/log가 필요하다.
6. 응답 역방향은 선택된 동기 호출 chain에서만 생성한다. redirect는 브라우저의 새 요청을 만들고, SQS/EventBridge/Lambda async는 응답 이후 분리된 작업 가지로 보여준다. 실제 status/body/latency는 static 분석으로 만들어내지 않는다.
7. frontend app가 여러 API를 사용하면 '발견된 API 요청 N개'로 나눠 개별 선택. 이미 GET URL만으로 식별할 수 있는 경우는 추가 질문 없이 실행하며 method/header가 미상일 때 가능한 후보와 필요한 조건을 보여준다.

FE-BE 무입력 연결 순서:

1. 기존 구성에서 `/api/*` CF behavior의 target origin을 판정한다. 이것은 proxy route 존재 근거이며 FE 코드가 실제 호출한다는 증거와 구분한다.
2. 보존된 env key 의미·exact hostname match를 사용한다. `API_BASE_URL` 후보와 `ALLOWED_ORIGINS` 후보를 다른 relation으로 취급한다. wildcard CORS와 공통 prod 태그는 호출선 근거로 사용하지 않는다.
3. 이미 활성화된 API-side logs/trace를 URL host와 매칭. log 원문을 UI에 가져오지 않고 정규화된 origin host·method·path pattern·기간·횟수만 전달한다. request 단위와 집계 단위를 명확히 구분한다.
4. 부족하면 대상 static config/HTML/JS를 제한된 byte/file/depth budget으로 읽어 API literal 후보를 발견한다. 무제한 bucket crawl, JS 실행, source map 전체 추출은 기본에서 제외한다.
5. 여전히 모르면 미확인으로 남긴다. 매번 사용자 수동 관계 설정을 요구하지 않는다. browser 관측은 보완 모드이고 필수 절차가 아니다.

### Gaps

- DNS resolution 정책, exact fetch budget, 실제 AWS permission inventory, frontend asset URL 추출 heuristics는 구현 단계에서 fixture와 제한 실계정 확인으로 확정해야 한다.
- API endpoint와 headers가 dynamic runtime configuration으로 결정되거나 third-party account에 있으면 현재 자격증명으로 끝까지 확인할 수 없다. 외부/미확인 노드를 유지해야 한다.

## 보안 경계와 검증 및 구현 순서

### Takeaway
설정 읽기 기반 MVP는 기존 읽기 전용 모델을 유지하며 가능하다. 로그 조회와 외부 URL 요청은 별도의 비용·권한·보안 경계여서 후속 단계로 분리하고, 기능 성공률보다 거짓 경로를 그리지 않는 검증이 우선이다.

### Cited Findings

- SDK guard는 `Describe|List|Get|Head|Lookup|BatchGet` prefix만 허용한다. `FilterLogEvents`, `StartQuery`, `StopQuery`는 현재 차단된다. CloudWatch Logs를 붙일 때 guard를 제거하거나 `Start*`를 범용 허용하면 안 된다. `GetLogEvents`는 현 패턴에 맞지만 scan 방식·요금·limit은 별도 검토 대상이다. [readonly-guard.ts:9](/Users/jin/Repos/orrery/server/src/aws/readonly-guard.ts:9)
- HTTP API의 `ExportApi`도 현재 prefix guard에 막힌다. deployed 구성 확인용으로 채택할 때 REST `GetExport`와 달리 정확한 command 예외가 필요하다. AWS 동작 근거는 `aws-paths.md`의 공식 API 출처를 따른다. [readonly-guard.ts:9](/Users/jin/Repos/orrery/server/src/aws/readonly-guard.ts:9)
- 모든 factory client에는 guard가 붙고 retries maxAttempts=8이 설정된다. query budget은 SDK command 수와 재시도 HTTP attempt를 구분해야 한다. [clients.ts:45](/Users/jin/Repos/orrery/server/src/aws/clients.ts:45)
- 현재 로컬 API 보호는 Host·Sec-Fetch-Site 검증이다. 이것은 새 서버측 URL fetch의 SSRF 방어를 대신하지 않는다. [local-only.ts:15](/Users/jin/Repos/orrery/server/src/http/local-only.ts:15)
- 현재 Electron 창은 로컬 서버를 여는 구조이며, webPreferences는 spellcheck만 지정한다. 대상 사이트를 현재 privileged/local 앱 창에 직접 load하는 형태로 바꾸지 않는 것이 적절하다. [desktop/main.ts:54](/Users/jin/Repos/orrery/desktop/src/main.ts:54)
- 기본 graph TTL은 10분이고 cache key는 graph-v2/source/account/region이다. 새 routing snapshot은 schema 버전을 별도로 가지며 같은 범위 원칙을 유지해야 한다. [server/index.ts:60](/Users/jin/Repos/orrery/server/src/index.ts:60), [server/index.ts:118](/Users/jin/Repos/orrery/server/src/index.ts:118)

### Inferences

필수 보안 설계:

- 설정 모드는 외부 URL에 요청하지 않는다. 정적 asset 읽기·브라우저 관측·실제 API 재현은 화면에서 구별한다. read-only AWS credentials는 임의 웹 사이트 요청의 부작용을 막아주지 않는다.
- 외부 fetch는 http/https만, credential 포함 URL 거절, private/loopback/link-local/metadata IP 차단, DNS rebind와 각 redirect 재검사, timeout/bytes/files/depth/cross-host 상한, response decompression 한도. 사내 private endpoint는 명시적인 별도 허용 설계가 필요하다.
- AWS access key를 사이트에 전달하지 않는다. Origin/Referer의 path/query·Cookie·Authorization·body·signed URL은 지속 저장에서 제외한다. FE bundle/env에서 발견한 문자열을 그대로 logging하지 않는다.
- query 기반 로그 조회가 필요하면 서비스+정확한 command 이름 allowlist 예외를 검토한다. 단순히 `Start` prefix를 추가하지 않는다. 지역/기간/로그그룹/결과수/bytes scanned 상한, cancellation, paging, partial/error/freshness를 구현한다.
- 로그가 미설정/권한 거부/보존 기간 만료/샘플 미발견인지 분리한다. API 403·404 예상도 route lookup 근거 없는 추정으로 표시하지 않는다.

권장 backlog와 상대 난도(예상치이며 일정 약속 아님):

| 단계 | 작업 | 난도 | 종료 기준 |
|---|---|---|---|
| P0 | typed routing/evidence contract, scopes와 coverage, 기존 조회 응답 정보 보존 | 중 | 기존 topology 유지, sanitized fixtures serialize/deserialize, unknown 표현 |
| P1 | URL normalize + hostname/DNS/CF behavior + S3/API Gateway/Function URL/ALB routing adapters | 높음 | 지원 fixture 경로·우선순위·분기 정확, 미지원에서 정직하게 중단 |
| P1 | FE 논리 노드·정적 문서 요청/API 요청 분리·응답 replay UI | 중 | cache hit/miss·redirect·unknown이 다른 결과로 표현 |
| P2 | FE-BE env/domain/CORS 근거 분류와 targeted config/asset discovery | 중~높음 | false-link fixture 통과, 원문 secrets 저장 없음 |
| P2 | 기존 로그의 Origin/Referer + request-ID evidence adapter | 높음 | 조회 한도·권한 실패·redaction·관측 기간 표시 |
| P3 | existing X-Ray/OTel trace adapter와 optional browser/HAR import | 높음 | 실제 sampled trace와 reconstruction 대조, gap와 async 구분 |

첫 MVP를 한 계정/선택 리전+global CloudFront·Route53, CF→S3 및 API Gateway→Lambda/Function URL로 제한하면 결과를 빨리 검증할 수 있다. ALB/ECS와 다계정·다리전은 별도 adapter로 확장하되 UI에 지원 범위를 명확히 표시한다. 다만 URL이 다른 리전 API를 가리킬 때 현재 리전의 동명 자원으로 대체하지 말고 '범위 밖'으로 남긴다.

필수 acceptance fixture:

1. CF→S3 FE와 별도 API Gateway→Lambda: 단서 없으면 두 path 사이를 확정 연결하지 않음.
2. CF `/api/*`와 default S3: path rule 우선순위, query/fragment, percent encoding, cache hit/miss 분리.
3. 같은 API의 `GET /items`와 `POST /items`가 다른 Lambda: method별 route 정확.
4. REST stage 배포본과 편집 최신 config 다름: deployed 기준 또는 미확인 경고.
5. custom-domain mapping/routing rules, longest mapping, header 조건 미상, CF origin-changing function 및 ALB URL transform 미지원: 단일 경로 확정 금지.
6. Lambda alias/canary·weighted origin/target: 가능한 분기 표시, 특정 version/target 선택 단정 금지.
7. `ALLOWED_ORIGINS`와 `API_URL` 의미 구분; CORS wildcard, 공통 prod 태그·이름 유사만으로 호출선 생성 금지.
8. Referer 없는 로그, forged headers, 중복 요청 ID, 시간만 비슷한 요청: 부재를 부정으로/집계를 trace로 오인 금지.
9. Lambda env DB endpoint는 구성 의존 후보; 실제 실행 trace가 없으면 DB 방문을 필수 hop으로 그리지 않음.
10. 302 redirect는 새 요청, async queue는 별도 작업, cache hit 응답은 S3를 통과하지 않음.
11. denied API, pagination cap, out-of-region/out-of-account, stale cache, missing collector target을 `unknown/partial`로 보존.
12. 동일 Lambda 이름의 두 account/region, alias ARN, external target가 잘못 합쳐지지 않음.
13. URL/JS/log의 token·Cookie·PII가 cache/console/UI artifact에 남지 않음. SSRF redirect/rebind fixture.
14. 취소·profile 변경·연결 세대 변경 시 이전 결과가 새 scope에 표시되지 않음.

실행 검증 계획: 의미 있는 버그 fixture는 기존 코드 RED 확인 후 구현 GREEN, `npm run typecheck`, `npm test`, `npm run build`, UI fixture 시각 검증을 수행한다. 그 후 읽기 권한의 제한 실계정으로 알려진 CF/S3/API/Lambda 구성과 console 설정을 대조한다. 실제 요청 관측은 별도 허용된 테스트 사이트/환경에서만 수행한다. Windows/Intel Mac 실행까지 하지 않았다면 결과에 남긴다. 문서 변경은 새 request/evidence semantics와 지원 범위를 README에 반영하고, guard 예외를 추가하면 보안·회귀 테스트 및 설명도 갱신한다.

### Gaps

- 이 조사는 구현하지 않았으므로 컴파일·unit/UI 검증은 실행하지 않았다.
- 비용 수치·작업 일수·FE-BE 발견률은 제공하지 않는다. 계정 크기, 로그 상태, 데이터량, 대응 AWS 기능에 따라 달라서 제한 PoC 측정이 필요하다.
- 외부 API의 최신 정확한 동작·요금·IAM action은 다른 연구의 공식 문서 출처로 확인해야 한다. 본 노트의 API 목록은 코드 gap과 구현 설계 목적이다.
