# AWS 설정 기반 URL 요청 경로 재구성

조사 기준일: 2026-10-26. 공식 AWS 문서만 사용했다. 실계정 호출·서비스 요청·설정 변경은 하지 않았다. 아래 구현 제안은 문서에 근거한 설계 추론이며 실환경 검증 결과가 아니다.

## 1. URL만으로 어디까지 정확하게 재구성할 수 있는가

### Takeaway

AWS 설정으로 호스트→배포→경로 규칙→통합 대상의 **조건부 경로**는 재구성할 수 있다. URL 하나로 특정 사용자의 실제 요청 전체를 확정하거나 응답 결과·지연을 예측할 수는 없다. FE 문서 다운로드와 FE가 실행 후 시작하는 API 요청은 별도 요청으로 모델링해야 한다.

### Cited Findings

- DNS는 단일 답만 갖지 않는다. Route 53은 weighted, latency, geolocation, failover, multivalue 등의 정책을 지원한다. 지리·네트워크 위치·health에 따라 결과가 달라질 수 있다. [Route 53 routing policy](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html), [복합 health/routing](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-complex-configs.html)
- CloudFront는 cache hit이면 오리진 호출 없이 응답한다. origin group은 miss일 때 primary로 보내고 지정 오류일 때 secondary로 재시도한다. failover는 GET·HEAD·OPTIONS에 한정된다. [Origin failover](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/high_availability_origin_failover.html)
- API Gateway HTTP route는 method와 path 조합이며, 구체적 일치→greedy path→`$default` 우선순위다. stage 선택도 별도다. [HTTP API routes](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-routes.html)
- ALB 규칙은 host, method, path, source IP, header, query 등의 조건을 포함한다. URL만으로 header/source-IP 조건을 결정할 수 없다. [ALB conditions](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/rule-condition-types.html)
- Lambda alias는 두 version으로 확률적 traffic split을 할 수 있다. alias만 보고 특정 호출 version을 단정할 수 없다. [Weighted alias](https://docs.aws.amazon.com/us_en/lambda/latest/dg/configuring-alias-routing.html)
- 비동기 Lambda 호출은 queue 적재 후 응답하고 함수 결과는 원래 요청에 돌아오지 않는다. SQS 같은 event-source mapping과 비동기 invoke는 서로 다른 호출 방식이다. [Async invoke](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html), [서비스 호출 방식](https://docs.aws.amazon.com/en_gb/lambda/latest/dg/lambda-services.html)

### Inferences

- 입력 기본값은 `GET`, URL, 현재 수집 스냅샷으로 두되 UI에 가정을 노출한다. 선택 입력은 method, 알려진 비민감 header, source region, cache hit/miss 가정. token/cookie/body를 기본 수집하지 않는다.
- 단일 선형 경로 대신 request별 DAG가 필요하다. FE document, JS/CSS/assets, API, CORS preflight, redirect, 비동기 후속 작업을 구분한다. DNS는 사전 이름 해석, WAF/auth는 통과 조건, SG/IAM/KMS는 접근 조건이며 모든 HTTP 요청이 순서대로 거치는 서버 노드처럼 그리지 않는다.
- URL fragment는 서버 경로와 분리하고 FE client routing 단서로 보존한다. origin/path normalization과 decoding은 서비스마다 규칙을 적용한다.
- route와 permission은 구분한다. 설정상 target까지 연결된다는 것은 요청 성공 증명이 아니다. 캐시·WAF 판정·인증·대상 상태·실행 코드·외부 dependency에 의해 중간 종료될 수 있다.
- UI에는 `설정상 경로`, `관측된 호출`, `조건부 분기`, `추정`, `알 수 없음`을 별도 표시한다. 특정 자원에 대해 확실한 근거가 없어도 외부 endpoint 노드로 경계를 남긴다.
- 인위적인 animation은 구조 설명용이어야 한다. CloudWatch 집계 평균을 개별 request latency로 표시하거나 추정 time을 실제 측정처럼 보여주지 않는다.

### Gaps

- 현재 사용자의 DNS·로그·trace·FE artifacts·권한과 실제 route 설정을 읽지 않았으므로 자동 연결 coverage를 수치로 주장할 수 없다.
- 외부 DNS/CDN/WAF, 다른 계정의 origin, Kubernetes ingress/application routing, 동적 origin/code 경로는 별도 데이터 없이는 확정할 수 없다.

## 2. 서비스별 필수 수집과 라우팅 해석은 무엇인가

### Takeaway

현재 토폴로지 수집을 단순 확장하는 것만으로 충분하지 않고, 원본 규칙과 배포 version을 보존하는 routing snapshot이 필요하다. 특히 API custom domain의 RoutingRules, CloudFront 동적 origin, ALB rewrite는 놓치면 잘못된 확정 경로를 만들 수 있다.

### Cited Findings

| 구간 | 필요한 데이터·읽기 API | 해석 시 주의점·출처 |
|---|---|---|
| DNS | `ListHostedZones`, `ListResourceRecordSets`; record name/type, alias target, routing policy, weight, identifier, health 조건 보존 | hosted zone 전체를 하나의 연결 노드로 요약하면 URL별 record를 잃는다. weighted/latency 등을 후보 분기로 남긴다. [Route 53](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html) |
| CloudFront | `ListDistributions`, `GetDistribution`/`GetDistributionConfig`; aliases, default root, ordered cache behaviors, origins/origin groups, origin path, custom errors, associations, WAF ARN, logging | behavior는 가장 구체적인 패턴이 아니라 **설정 순서상 첫 일치**. 대소문자 구분, URI 정규화 후 매칭, query/cookie는 path match에 사용하지 않는다. [Cache behavior](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesCacheBehavior.html), [GetDistribution](https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_GetDistribution.html) |
| CloudFront policies | `GetCachePolicy`, `GetOriginRequestPolicy`, `GetResponseHeadersPolicy` 또는 각 `*Config` API | cache key와 origin으로 전달되는 header/query/cookie가 다르므로 별도 보존. API 목록·권한 확인됨. [API operations](https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_Operations_Amazon_CloudFront.html), [권한](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudfront.html) |
| Edge function | associations, `GetFunction`의 LIVE code, Lambda@Edge version ARN 및 해당 configuration | 단순 `uri` 변경은 behavior/origin을 다시 선택하지 않는다. 그러나 최신 CloudFront Functions는 `updateRequestOrigin`, `selectRequestOriginById`, `createRequestOriginGroup`을 통해 origin 자체를 바꿀 수 있다. Lambda@Edge origin-request 변경은 cache miss 때 실행된다. [Event structure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html), [Origin helpers](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/helper-functions-origin-modification.html) |
| S3/SPA | CloudFront origin path·custom errors·default root와 S3 website config (`GetBucketWebsite`)를 구분; 필요한 경우 제한된 `HeadObject`/`GetObject`로 entry 확인 | S3 website endpoint는 custom origin이고 OAC/OAI 지원 안 됨. S3 REST origin은 OAC와 bucket policy가 관련된다. `/orders`가 `/index.html`로 바뀌는 경우 원 요청과 object key를 모두 보존. [S3 origin](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html), [Origin path](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesOrigin.html) |
| REST custom domain | `GetDomainNames`, `GetDomainName`, `GetBasePathMappings`; SDK v2 `ListRoutingRules`도 필요 | custom domain의 routing mode에 따라 header/base-path rule이 API mapping보다 먼저 적용. `StripBasePath`도 반영. [Routing rules](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-routing-rules.html), [ListRoutingRules](https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/domainnames-domainname-routingrules.html) |
| HTTP/custom mapping | `GetDomainNames`, `GetApiMappings`, `GetApis`, `GetStages` | longest matching mapping prefix로 API/stage 선택. REST·HTTP가 동일 domain에 매핑 가능. 이후 API route 매칭. [Mappings](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-mappings.html) |
| REST deployed route | `GetStage(s)`, `GetExport` integration extensions 포함; 필요시 `GetResources`, `GetMethod`, `GetIntegration`, `GetIntegrationResponse`, `GetAuthorizers`, `GetVpcLinks` 보완 | 편집 중 최신 resources와 실제 배포 stage를 구분. stage export는 배포 API를 가져온다. export 실패·제약은 부분 결과로 표시하고 최신 설정을 배포본으로 위장하지 않는다. [REST export](https://docs.aws.amazon.com/en_en/apigateway/latest/developerguide/api-gateway-export-api.html), [읽기 API 목록](https://docs.aws.amazon.com/service-authorization/latest/reference/list_apigateway.html) |
| HTTP deployed route | `ExportApi(StageName, IncludeExtensions)`, `GetRoutes`, `GetIntegrations`, `GetAuthorizers`, `GetVpcLinks` | StageName 생략하면 최신 구성 export라 실제 배포와 다를 수 있다. route method/path, target integration, auth, CORS, request mapping, connectionId를 보존. [ExportApi](https://docs.aws.amazon.com/cli/latest/reference/apigatewayv2/export-api.html), [Routes](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-routes.html) |
| Function URL | `ListFunctionUrlConfigs`/`GetFunctionUrlConfig`, `GetAlias`, `GetFunctionConfiguration`, 필요시 `GetPolicy` | URL은 `$LATEST` 또는 alias에 연결. `AuthType`, CORS, invoke mode를 보존. Function URL은 API Gateway 없는 경로. [Function URL](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html), [CORS](https://docs.aws.amazon.com/lambda/latest/api/API_Cors.html) |
| ALB | `DescribeLoadBalancers`, `DescribeListeners`, `DescribeRules`, `DescribeTargetGroups`, `DescribeTargetHealth`, target-group attributes | 작은 priority부터 평가. terminal action은 forward/redirect/fixed-response. auth action, weighted targets, stickiness, health 때문에 특정 target은 후보. 최신 host/URL rewrite transform도 반영. [Rules](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/listener-rules.html), [DescribeRules pagination](https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_DescribeRules.html) |
| WAF | `GetWebACL`, association/list APIs, referenced rules/IP sets 필요시 | CloudFront scope는 `us-east-1`. 구성에서 검사 지점은 표시 가능하나 managed/bot/rate/captcha 및 request context 없이 allow/block 완전 재현 불가. [GetWebACL](https://docs.aws.amazon.com/waf/latest/APIReference/API_GetWebACL.html) |
| Lambda downstream | configuration/alias/event-source mapping/async destination 정보; 실행 경로는 기존 X-Ray/OTel trace | SDK·HTTP·SQL outgoing calls를 확인하려면 instrumentation이 필요. IAM 권한이나 환경 변수는 실제 호출 증거가 아니다. [X-Ray Lambda](https://docs.aws.amazon.com/xray/latest/devguide/xray-services-lambda.html) |

- Lambda asynchronous retries/destinations는 synchronous HTTP 응답 경로와 분리해야 한다. async 오류 retry는 기본 두 번이지만 설정 및 오류 종류별로 다르고, SQS mapping retry를 동일 규칙으로 일반화하면 안 된다. [Async retries](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-error-handling.html), [Async configuration](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async-configuring.html)
- 응답은 항상 모든 downstream 자원을 거꾸로 통과하지 않는다. Lambda asynchronous enqueue는 먼저 ACK하고, streaming은 부분 응답을 먼저 보낼 수 있다. [Async invoke](https://docs.aws.amazon.com/lambda/latest/dg/invocation-async.html), [Streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)

### Inferences

- origin 하나 찾았다고 모든 CF origin을 활성 경로로 연결하지 않는다. 선택 behavior, 조건, originPath, rewrites, cache 결과별 분기를 보존해야 한다.
- API route를 함수명으로만 축약하면 alias/version/account/region 및 stage variable 정보가 사라진다. ARN 전체와 resolved/unresolved stage expression을 별도 보존해야 한다.
- API resource와 custom domain은 계정·리전·partition을 키에 포함해야 한다. Lambda 이름이나 API ID만으로 다른 계정·리전을 섞어 연결하면 안 된다.
- ALB IP target을 ECS task ENI와 연결할 때 해당 시점의 ECS task/ENI inventory가 필요하다. 동일 IP가 재사용될 수 있어 timestamp가 중요하다. 직접 EC2/외부 IP도 후보로 남겨야 한다.
- S3/DB/KMS/IAM/SG는 역할이 다르다. 요청 fanout, 저장, 암호화, 권한, 네트워크 조건을 한 가지 `invokes` 선으로 합치지 않는다.
- WAF 또는 auth가 있다는 이유로 실패를 예측하지 않는다. 설정과 입력만으로 확정 가능한 부분만 평가하고 나머지는 `판정 불가`로 표시한다.
- FE 초기 URL 하나는 이후 사용자의 버튼·로그인·화면 전환을 정의하지 않는다. 해당 FE에서 관측된/정적으로 참조한 API 목록과 현재 시나리오에서 실제 호출된 API를 구분해야 한다.

### Gaps

- 이 조사에서는 모든 서비스 API response schema 및 각 IAM resource ARN 세부 조합까지 실행 검증하지 않았다. 위 API matrix는 구현 조사 출발점이며, 실제 최소권한 정책은 선택한 MVP 범위에 대해 통합 검증해야 한다.
- CloudFront multi-tenant distribution/connection groups, VPC origins, origin mTLS, third-party CDN, API private custom domain, cross-account private integration, service mesh는 초기 일반 경로 외 별도 지원 범위로 정의해야 한다.
- HTTP/REST stage canary·stage variable 조합과 custom-domain routing rules 최신 SDK 지원은 구현 시 설치 SDK의 types와 대조 필요.
- CloudFront helper의 mTLS 지원은 최신 HTML 문서와 오래된 PDF가 충돌했다. 최신 HTML에 origin switching 지원이 명시되어 있으므로 PDF에 의존하지 않았다. [최신 HTML](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/origin-mtls-cloudfront-functions.html)

## 3. 권한 비용 수집 운영과 검증 원칙

### Takeaway

시뮬레이션은 AWS 관리 설정의 읽기만으로 실행하는 기본 모드와 실제 관측을 분리해야 한다. 전계정 전수 호출보다 URL에서 발견한 후보의 상세 구성만 읽는 방식이 합리적이며, 수집 실패·pagination 중단·배포 중 상태를 결과 정확도에 반영해야 한다.

### Cited Findings

- API Gateway 일반 관리 읽기 IAM action은 SDK 메서드명이 아니라 `apigateway:GET`이다. `TestInvokeMethod`와 `TestInvokeAuthorizer`는 `apigateway:POST`의 write로 분류되며 단순 읽기 수집용 API가 아니다. [Management authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_apigateway.html)
- 새 routing rule 읽기는 `apigateway:ListRoutingRules`를 별도 요구한다. `GetApiMappings` 같은 일반 V2 리소스와 혼동하지 않아야 한다. [V2 authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_apigatewayv2.html)
- `ListRoutingRules`는 `nextToken`/`maxResults`, ALB `DescribeRules`는 `NextMarker`/`Marker` pagination을 사용한다. [RoutingRules API](https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/domainnames-domainname-routingrules.html), [DescribeRules](https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_DescribeRules.html)
- CloudFront read API IAM은 `cloudfront:GetDistributionConfig`, `GetCachePolicy`, `GetOriginRequestPolicy` 등 action별이다. [CloudFront authorization](https://docs.aws.amazon.com/service-authorization/latest/reference/list_cloudfront.html)
- CloudFront-associated WAF 조회는 `CLOUDFRONT` scope와 `us-east-1` endpoint를 사용한다. [WAF GetWebACL](https://docs.aws.amazon.com/waf/latest/APIReference/API_GetWebACL.html)
- X-Ray SDK/daemon은 2026-02-25 maintenance mode로 진입하며 AWS는 OpenTelemetry migration을 권고한다. 기존 X-Ray 데이터 읽기는 활용할 수 있지만 새 instrumentation 설계는 OTel을 우선 검토해야 한다. [AWS X-Ray Lambda 안내](https://docs.aws.amazon.com/xray/latest/devguide/xray-services-lambda.html)

### Inferences

- 권한 최소화: 최초 inventory는 기존 credential scope 재사용. 상세 routing read action은 기능별로 목록을 만들고 부분 거부를 정상적인 `unknown` 상태로 처리한다. 모든 서비스 `ReadOnlyAccess`가 객체 본문·로그·코드를 안전하게 모두 읽게 한다고 가정하지 않는다.
- `ExportApi`는 HTTP GET 기반의 read이지만 이름이 `Export`라 Orrery의 prefix allowlist에서 차단될 수 있다. 보안 가드를 통째로 완화하지 말고 실제 HTTP/read semantics를 검증한 정확한 command만 추가하는 방식 검토가 필요하다.
- route snapshot key: credential source/account/partition/region/resource ARN/deploymentId or ETag/collectedAt. 세션 전환·권한 실패 시 이전 계정의 자료를 결합하지 않는다. CF 배포 중·API pending deployment는 현재 설정과 실제 edge 적용 시점의 차이를 표시한다.
- 기본 모드에서는 앱 URL로 HTTP 요청도 하지 않는다. 별도 관측 모드는 GET조차 로그인·tracking·비표준 side effect를 일으킬 수 있으며 UI 자동 클릭/POST/PUT/DELETE는 수집으로 간주하지 않는다. 사용자 범위와 실행 대상 확인이 필요하다.
- 관리 API throttling에 대비해 URL 후보 우선 상세조회, 서비스별 concurrency, retry/backoff, TTL/ETag 캐시, pagination cap와 부분 수집 표시를 둔다. 요청 cap은 비용 cap과 같지 않다.
- 기존 logs/traces 조회, S3 object read, URL 요청과 browser asset load는 과금·전송량을 발생시킬 수 있다. 이 연구에서는 최신 리전별 가격을 계산하지 않았으므로 무료라고 표현하지 않는다.
- VPC reachability는 별도 네트워크 분석 과제다. 요청 trace를 위해 Reachability Analyzer 리소스 생성/analysis 실행을 자동 추가하지 않는다. URL route 분석은 HTTP/L7이며 SG/NACL/route reachability 전체 판정은 초기 제외 또는 별도 제한적 설명으로 둔다.
- 권장 단위 테스트: CF first-match 및 normalize/case/query 구분; custom mapping longest-prefix와 strip path; routing rule header missing=unknown; API deployed/current 차이; HTTP ANY/greedy/default; alias traffic split; CF cache hit/miss/failover method; ALB priority/redirect/fixed/rewrite; missing permissions/pagination truncation; cross-account name collision; redirect/cycle depth limit; CORS preflight/actual request 분리; async ACK/후속 worker 분리.
- 실환경 검증은 담당자가 이미 아는 FE+API 사례에 대해 설정 export·로그/trace와 결과 경로를 대조해야 한다. 성공 기준은 확정 가능한 경로의 correctness, 추정 오탐률, unknown의 정확한 표기, 조회 예산, 계정 격리이며 100% coverage를 요구하지 않는다.

### Gaps

- 실제 IAM 정책·요청 수·가격·계정 자원 개수·trace retention은 아직 미검증이다. 날짜별 숫자를 임의 추정하지 않았다.
- 공식 문서에서 하나의 관리 API로 브라우저→FE→API→Lambda→DB를 전부 확정해 주는 기능은 확인하지 못했다. 각 evidence를 결합하고 미지원 구간을 표시하는 것이 설계 결론이다.
