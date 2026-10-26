# FE BE 자동 연결과 요청 관측 근거

조사일: 2026-10-26 (Asia/Seoul). 조사 범위는 공식 AWS·브라우저·프레임워크·표준 문서 및 현재 Orrery 코드다. 실계정 로그·배포 파일·사용자 사이트를 읽거나 호출하지 않았고, 인프라와 구현 코드는 변경하지 않았다. 아래 제안은 설계 판단이며 실제 계정의 자동 연결 성공률은 아직 측정하지 않았다.

## 1. 사용자 입력 없이 FE와 BE를 어디까지 연결할 수 있는가

### Takeaway

가능하다. 권장 기본 동작은 URL 하나에서 AWS 설정과 배포된 FE 파일을 읽어 후보 경로를 만들고, 이미 존재하는 API 측 로그와 trace로 관측 근거를 보강하는 것이다. 관계를 사용자가 일일이 지정하는 방식은 필수가 아니다. 다만 사이트 전체 호출을 하나의 직렬 요청으로 그리면 틀리므로 HTML 요청, 정적 자산 요청, 브라우저 API 요청을 별도 요청 묶음으로 표현해야 한다.

### Cited Findings

- 현재 Lambda 수집은 `Object.values(f.Environment?.Variables ?? {})`로 변수 이름을 버리고 값만 `refs`에 넣는다. FE 주소와 CORS 허용 주소의 의미가 사라지고, 일반 URL 참조는 출발 자원·대상 유형만 보고 `reads`/`invokes`로 분류된다. CloudFront `대체 도메인`은 props에는 있으나 `buildIndex`가 읽는 DNS 키 목록에는 없다. 이는 자동 연결 개선 지점이지만 실제 호출 증거는 아니다. — [Lambda 수집기](/Users/jin/Repos/orrery/server/src/collectors/lambda.ts:49), [관계 인덱스와 종류 결정](/Users/jin/Repos/orrery/server/src/graph/assemble.ts:84)
- Vite의 `import.meta.env` 값은 빌드 때 치환되고, `VITE_*`는 클라이언트 번들에 포함될 수 있다. 따라서 런타임 Lambda 환경 변수만 보는 것보다 배포된 번들에서 API 주소를 찾는 방법이 직접적이다. — [Vite env](https://vite.dev/guide/env-and-mode)
- Next.js의 `NEXT_PUBLIC_*`도 브라우저 JS에 빌드 시 inline되며 이후 서버 환경 변수를 바꿔도 이미 빌드된 값이 바뀌지 않는다. 서버 전용 변수는 브라우저 번들에 나타나지 않는다. — [Next.js env](https://nextjs.org/docs/pages/guides/environment-variables)
- HTTP API CORS의 `allowOrigins`는 호출을 허용할 출처 설정이다. API Gateway가 preflight OPTIONS에 자동 응답할 수 있고, 설정된 CORS가 있으면 backend의 CORS 헤더는 무시된다. 허용 목록은 사용 실적이 아니다. — [HTTP API CORS](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html)
- Chrome CDP `Network.requestWillBeSent`에는 documentURL, request, initiator, frame/loader 식별자가 있고, initiator에는 script/parser/preflight 종류와 일부 stack 정보가 있다. 즉 문서와 후속 호출의 관계를 관측할 수 있으나 이것은 브라우저를 실제로 실행했을 때의 데이터다. — [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/)

### Inferences

- 무입력 기본 알고리즘 제안: 입력 URL 정규화 → 현재 CloudFront 별칭·API custom domain과 매칭 → 배포 HTML·그 HTML이 참조하는 JS/config를 제한적으로 읽음 → URL 문자열과 `fetch`/axios baseURL 등 호출 문맥을 파싱 → 상대 URL을 문서 base와 결합 → API domain/stage/route/Lambda 통합으로 연결 → 기존 로그/trace가 있으면 근거 추가.
- 단순 문자열 정규식은 후보 탐색에만 사용한다. URL이 주석·라이브러리 문서·분석 SDK·미사용 분기일 수 있다. AST의 명확한 literal 호출 또는 설정 연결을 우선하며 추정 결과를 실선 확정으로 승격하지 않는다.
- 공개 페이지를 fetch하는 방법과 S3 SDK `GetObject`로 현재 배포 파일을 읽는 방법을 분리한다. S3 직접 파일은 CloudFront 캐시에 남아 있는 실제 제공 버전과 다를 수 있어 object version/ETag/수집 시각을 보관해야 한다.
- `.env` 파일을 공개 URL에서 탐색하거나 Secrets Manager 값을 읽을 필요는 없다. FE 주소 분석은 브라우저에 배포되는 HTML/JS 및 명시된 runtime config로 제한한다.
- JS를 실행하지 않고 읽는 기본 분석에서 동적 문자열 조합, 암호화/난독화 값, 로그인 후 config API, tenant별 endpoint, lazy import, feature flag 전체 조합을 완전 복원할 수 없다. SSR/BFF 호출은 브라우저 번들에 없는 서버 내부 호출이므로 trace/서버 설정으로 이어야 한다.
- CORS exact origin + CloudFront alias 일치는 `configured-origin` 관계다. `Environment=prod` 또는 이름 접두어 일치는 `same-service-candidate`이며 호출 선으로 사용하지 않는다. env 이름은 서버 메모리에서 의미 분류한 뒤 허용된 hostname·근거 종류만 저장하고 원문을 전달하지 않는다.

### Gaps

- 현재 계정에서 FE 도메인이 Lambda 환경 변수에 존재하는지, 배포 번들에서 주소가 노출되는지, CORS·태그가 얼마나 정비되어 있는지는 미확인이다. 실제 자동 연결률 수치나 100% 보장을 제시할 근거는 없다.
- 일반 JavaScript 전체 프로그램을 정적 분석해서 모든 가능한 runtime 호출을 결정하는 범용 해법을 이 기능의 범위로 약속하면 안 된다.

## 1A. CORS는 가장 먼저 활용할 수 있는가

### Takeaway

그렇다. **HTTP API의 CORS 허용 origin은 이미 호출 중인 GetApis 응답에 들어 있지만 Orrery가 버리는 데이터**다. 추가 로그나 브라우저 조작 없이 FE–BE의 구성상 연결을 찾는 최우선 단서로 올리는 것이 맞다. 기본 추천 순서를 **CORS·도메인 설정 → 배포 JS → 기존 API 측 로그 → 기존 trace**로 구체화한다.

### Cited Findings

- `GetApis` GET 응답의 각 API에는 `corsConfiguration.allowOrigins`, allowMethods, allowHeaders, allowCredentials, exposeHeaders, maxAge가 있다. HTTP API 전용 설정이며 JS SDK의 대응 필드는 `CorsConfiguration.AllowOrigins`다. 현재 `apiGatewayV2`는 `GetApisCommand` 결과를 읽지만 CORS를 graph에 넣지 않는다. — [GetApis API schema](https://docs.aws.amazon.com/apigatewayv2/latest/api-reference/apis.html), [현재 수집기](/Users/jin/Repos/orrery/server/src/collectors/edge.ts:191)
- Lambda Function URL은 API Gateway와 별개로 `GetFunctionUrlConfig` 응답에 `Cors.AllowOrigins`와 FunctionUrl/FunctionArn/AuthType/InvokeMode를 제공한다. 현재 Orrery는 이 조회를 하지 않으므로 HTTP API와 달리 신규 구성 읽기가 필요하다. alias별 URL도 구분해야 한다. — [Function URL config](https://docs.aws.amazon.com/lambda/latest/api/API_GetFunctionUrlConfig.html), [Function URL 구성](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html)
- HTTP API는 exact origin 외에 `*`, `https://*`, `http://*` 같은 허용 패턴도 지원한다. 이런 값은 특정 FE를 가리키지 않는다. — [CORS properties](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-cors.html)
- REST API의 non-proxy CORS는 OPTIONS MOCK integration과 method/integration response의 `Access-Control-Allow-Origin` 등으로 구현된다. Lambda proxy/HTTP proxy에서는 backend가 CORS 헤더를 반환해야 한다. 따라서 REST API에 HTTP API와 동일한 중앙 CORS 목록이 항상 존재한다고 하면 틀리다. — [REST CORS](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-cors.html)

### Inferences

- HTTP API: exact origin을 URL origin으로 정규화하고 CloudFront aliases + distribution domain과 host를 매칭한다. scheme/port는 CORS 비교에서 보존한다. `configured-cors` 근거를 붙여 FE 논리 노드→API에 자동 관계를 생성한다. Lambda는 API integration으로 연결한다.
- REST API: 이미 가져오는 embedded integration 또는 `GetIntegration`의 integrationResponses.responseParameters에서 static allow-origin을 추출한다. `GetMethod`는 header 선언의 유무이지 실제 값이 아닐 수 있다. Gateway responses의 CORS는 인증 실패 등 오류 응답용일 수 있어 정상 route 허용과 구분한다. proxy의 dynamic origin reflection은 env/code/배포 파일/로그 근거로 보강하고 동작을 추정 확정하지 않는다.
- same-origin `/api` 경로는 CORS 없이 동작하므로 CORS가 없는 FE–API 연결도 구성상 가능하다. CORS 허용 origin은 외부 파트너·미사용 이전 FE·localhost일 수 있고 다중 origin이 가능하다. '*'와 null, 넓은 pattern을 계정 내 모든 FE로 펼치지 않는다.
- CORS를 네트워크 방화벽처럼 그리지 않는다. preflight에서 막히면 본 요청이 전송되지 않을 수 있지만, preflight 없는 simple request는 서버에서 처리된 뒤 브라우저가 응답을 JavaScript에 공개하지 않을 수 있다. 따라서 `CORS 실패=Lambda 실행 없음` 또는 `서버 부작용 없음`은 틀리다. 요청 진행과 응답 공개 여부를 별도 상태로 표현한다. — [브라우저 CORS 설명](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS), [REST CORS simple/non-simple](https://docs.aws.amazon.com/apigateway/latest/developerguide/how-to-cors.html)
- Origin exact match는 '설정상 허용'의 확정일 수 있지만 '실제 호출'의 확정은 아니다. UI 근거 종류를 나누면 별도 수동 승인 없이 유용한 연결을 표시하면서 과장도 피할 수 있다.

### Gaps

- 사용자 실계정의 API 유형과 CORS 값, REST proxy에서 backend가 생성하는 CORS 정책은 확인하지 않았다. 이 부분은 configuration-only read로 먼저 검증할 수 있다.

## 2. Referer Origin 로그로 FE BE를 자동 발견할 수 있는가

### Takeaway

가능하되 API를 실제로 통과한 위치의 로그여야 한다. API Gateway Access Log는 임의의 원본 요청 헤더를 기본 변수로 직접 꺼내는 기능이 없고, REST Execution Log 또는 기존 애플리케이션·WAF·API 앞 CloudFront 로그가 더 유용할 수 있다. 로그가 없거나 헤더가 비어 있는 것은 연결 부재가 아니다.

### Cited Findings

- REST Access Log의 전체 지원 `$context` 목록에는 `identity.userAgent`, `identity.sourceIp`, API 호출 `domainName`, 각종 request/integration ID가 있으나 원본 임의 헤더를 직접 읽는 `Referer`/`Origin` 변수는 없다. `requestOverride.header.*`는 integration request override이며 원본 헤더 일반 accessor가 아니다. Lambda authorizer가 context로 이미 넘긴 값은 `$context.authorizer.property`로 기록 가능하다. — [REST Access Log 변수](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-variables-for-access-logging.html)
- HTTP API Access Log 전체 목록도 `Referer`/`Origin` 원본 임의 헤더 accessor를 제공하지 않는다. `domainName`은 API 호출 대상 Host이고 FE의 출처가 아니다. authorizer context 지원은 있으나 이를 새로 반환하도록 만드는 것은 instrumentation 변경이다. — [HTTP Access Log 변수](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-logging-variables.html)
- REST Execution Log는 요청/응답 파라미터·payload 등을 기록할 수 있다. logging level은 OFF/ERROR/INFO이며 Data tracing은 full request/response 기록 옵션이고 AWS는 운영 API에서 사용하지 않을 것을 권한다. 표준 경로는 `API-Gateway-Execution-Logs_{rest-api-id}/{stage_name}`이며 이벤트가 1 KB로 잘릴 수 있다. 현재 문서는 별도의 CloudWatch Logs delivery 경로도 설명하며 최대 1 MB, 자체 log group/S3/Firehose를 지원하고 이 경로를 구성하면 기존 auto-managed group 기록을 대체한다. — [REST execution logging](https://docs.aws.amazon.com/apigateway/latest/developerguide/rest-api-execution-logging.html)
- HTTP API는 REST API와 달리 Execution Log, API Gateway 자체 X-Ray, 직접 WAF integration을 지원하지 않는 것으로 공식 비교표가 명시한다. 앞단 CloudFront/WAF나 backend trace를 별도로 볼 수는 있다. — [REST와 HTTP API 비교](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html)
- Lambda proxy event에는 요청 헤더가 전달되지만, Lambda 기본 실행 로그는 START/END/REPORT 계열이며 헤더가 자동 저장되는 것은 아니다. 애플리케이션이 헤더를 기록했거나 별도 middleware가 있어야 한다. — [Proxy event](https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html), [Lambda 기본 로그](https://docs.aws.amazon.com/lambda/latest/dg/monitoring-cloudwatchlogs-view.html)
- CloudFront standard logs에는 `cs(Referer)`, host/path/method/status, cache hit/miss 계열과 edge request ID가 있다. 전달은 대개 1시간 이내지만 일부는 최대 24시간 지연될 수 있다. — [Standard log reference](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logs-reference.html)
- CloudFront real-time logs는 `cs-referer`와 선택 필드를 제공하고, behavior별 설정·sampling이 있으며 Kinesis로 전달된다. best-effort이므로 모든 요청의 완전한 장부가 아니고 추가 비용이 있다. standard v2도 출력 필드를 선택할 수 있으므로 실제 format 확인이 필요하다. — [Real-time logs](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/real-time-logs.html), [Standard v2](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/standard-logging.html)
- WAF 로그 `httpRequest.headers`에는 헤더 목록이 있고 `httpSourceId`/`httpSourceName`으로 보호 대상 CloudFront·ALB·REST API 등을 연결한다. redaction/data protection과 log filter로 헤더나 요청이 제외될 수 있다. — [WAF fields](https://docs.aws.amazon.com/waf/latest/developerguide/logging-fields.html), [WAF logging configuration](https://docs.aws.amazon.com/waf/latest/developerguide/logging-management-configure.html)
- ALB access log 표준 schema는 URL, user-agent, target group, rule priority, trace ID, redirect/rewrite 결과 등에 유용하지만 `Referer`/`Origin` 일반 필드는 없다. 최신 문서는 S3 legacy뿐 아니라 CloudWatch Logs delivery도 설명한다. — [ALB access logs](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-access-logs.html), [ALB CloudWatch delivery](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-logs.html)
- Referrer Policy에 따라 Referer는 생략되거나 origin만 남을 수 있다. Origin도 항상 존재하지 않고 null일 수 있다. — [W3C Referrer Policy, 진행 중 표준 초안](https://w3c.github.io/webappsec-referrer-policy/), [Origin 표준 RFC6454](https://www.rfc-editor.org/rfc/rfc6454.html)

### Inferences

- FE 전용 CloudFront가 S3 파일을 제공하고 브라우저가 다른 API domain을 직접 호출한다면 FE CloudFront는 해당 API 요청을 받지 않는다. 따라서 FE CloudFront의 Referer는 FE 파일의 유입/자산 요청 근거이지 FE→외부 API 근거가 아니다. API 요청이 지나가는 CloudFront 또는 WAF 로그를 찾아야 한다.
- API 측 로그에서 `Origin=https://app.example.com`, 또는 Referer host가 app.example.com이면 CF alias와 결합해 `observed-origin` FE→API 관계를 만들 수 있다. 이 관계의 최소 키는 FE origin + API resource/stage + host/path template + method + observation window다.
- Header는 클라이언트 입력이다. 공격자·봇·비브라우저는 위조 가능하므로 인증 증거나 100% 호출 주체 확인으로 쓰지 않는다. 성공 요청인지 차단/OPTIONS만 관측됐는지 분리한다. preflight 성공만으로 실제 API 호출/응답 성공을 추정하지 않는다.
- API Gateway에서 INFO만 켜면 모든 원본 헤더가 반드시 기록된다고 단정하지 않는다. 기존 stage logging/data trace 설정, delivery destination, 실제 작은 표본에서 `Method request headers`/equivalent 내용을 확인해야 한다. 운영에서 헤더 수집 목적으로 full data tracing을 자동 활성화하지 않는다.
- `sourceIp`가 FE 서버 IP일 것으로 매칭하면 틀린다. 브라우저 직접 호출은 사용자 또는 중간 proxy의 IP이며, 동일 IP+시각만으로 FE와 API 요청을 한 건으로 묶을 수 없다.

### Gaps

- 공식 execution logging 문서는 모든 level/옵션 조합에서 Referer를 보장하지 않는다. 현재 계정 로그 표본을 확인해야 header coverage를 알 수 있다.
- 로그 보존 기간, redaction, sampling, delivery 지연 및 권한 실패로 관측이 빠질 수 있다. `로그 없음`, `권한 없음`, `표본 없음`, `헤더 없음`, `범위 잘림`을 별도 상태로 유지해야 한다.

## 3. 실제 호출부터 응답까지 하나의 흐름을 확인하려면 무엇이 필요한가

### Takeaway

설정 기반 경로와 과거에 관측한 관계는 URL의 가능한 여정을 설명한다. 특정 한 번의 요청과 응답에 대한 정확한 순서·시간·하위 호출은 trace/request ID로 연결된 관측이 필요하다. 브라우저는 선택적 보강이며 무입력 MVP의 필수 단계로 두지 않는다.

### Cited Findings

- API Gateway REST X-Ray는 active mode에서 sampling하며 passive는 upstream trace가 있는 경우에 기록된다. 한 trace는 보통 한 HTTP 요청을 나타낸다. — [API Gateway X-Ray](https://docs.aws.amazon.com/apigateway/latest/developerguide/apigateway-enabling-xray.html)
- X-Ray `GetTraceSummaries`로 기간/filter에 맞는 trace ID를 조회하고 `BatchGetTraces`로 상세를 읽는다. 일부 서비스는 직접 segment를 보내지 않고 instrumented caller subsegment를 바탕으로 inferred segment가 생긴다. 따라서 trace map도 전부 서비스 내부 직접 관측이라는 뜻은 아니다. — [Trace API](https://docs.aws.amazon.com/xray/latest/api/API_GetTraceSummaries.html), [X-Ray data retrieval](https://docs.aws.amazon.com/xray/latest/devguide/xray-api-gettingdata.html)
- CloudWatch RUM의 FE trace는 기본적으로 server trace와 연결되지 않는다. 허용 HTTP 요청에 X-Ray trace header를 추가하도록 구성해야 연결되고, cross-origin에서는 `X-Amzn-Trace-Id` CORS 허용이 필요하다. RUM sampling은 X-Ray sampling rule과 별개이고 비용도 추가될 수 있다. — [RUM and X-Ray](https://docs.aws.amazon.com/xray/latest/devguide/xray-services-RUM.html)
- OpenTelemetry의 context propagation은 trace/span context를 HTTP header 등으로 downstream에 전달해야 span을 연결한다. 브라우저 instrumentation은 공식 저장소에서 experimental로 안내하며 일부 패키지는 이동/deprecation 상태다. 새로 도입할 때 해당 버전·패키지 지원을 검증해야 한다. — [OTel propagation](https://github.com/open-telemetry/opentelemetry-js/blob/main/doc/propagation.md), [OTel browser](https://github.com/open-telemetry/opentelemetry-browser)
- AWS X-Ray SDK/daemon은 2026-02-25부터 maintenance mode이며 공식 현재 timeline은 종료일 N/A로 표시한다. 새 instrumentation은 OpenTelemetry 권장이다. 오래된 PDF의 2027 지원종료 문구와 최신 HTML이 다르므로 보고서에 고정 종료일을 단정하지 않는다. X-Ray 서비스 자체 종료를 뜻하지 않는다. — [현재 공식 timeline](https://docs.aws.amazon.com/xray/latest/devguide/xray-sdk-daemon-timeline.html)
- ALB는 target 전달 전에 `X-Amzn-Trace-Id`를 추가/갱신하며 access log에 기록할 수 있다. 이것만으로 backend의 DB 호출 span이 자동 생성되지는 않는다. — [ALB tracing](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-request-tracing.html)
- Chrome HAR sanitized export는 Cookie/Set-Cookie/Authorization 같은 민감 헤더를 제외한다. 하지만 자체 수집기에서는 URL query, path 개인정보, request/response body까지 별도 최소화가 필요하다. — [Chrome HAR](https://developer.chrome.com/docs/devtools/network/reference/)

### Inferences

- UI에 `설정상 경로`, `기간 내 관측 관계`, `특정 요청 trace`를 구분한다. 여러 날의 다른 요청을 이어 붙여 단일 실제 trace처럼 재생하지 않는다. provenance와 timestamp가 없는 애니메이션 시간은 설명용이며 실제 latency가 아니다.
- CDP 선택 모드는 request/response/loadingFinished/loadingFailed, initiator, redirect chain, cache/service-worker 결과, OPTIONS preflight, CORS 차단을 수집한다. frame/worker를 놓치지 않게 수집 범위를 명시하고 요청 ID·loader ID·단조시각과 wall-time를 구분한다. 네트워크 요청 실패와 HTTP 오류 응답, 응답 후 JS 파싱 실패도 서로 다르다.
- 브라우저를 URL만으로 자동 실행해도 analytics·POST·세션 갱신 등 실제 요청이 일어난다. GET 페이지 자체도 애플리케이션 동작을 촉발할 수 있다. 기본 정적 분석과 실제 관측 실행을 구분하고 후자는 사용자가 선택해야 한다. 자동 클릭·로그인·폼 제출을 기본으로 하지 않는다.
- Service worker/cache에서 응답하면 AWS 자원에 요청이 가지 않을 수 있다. cache disable 또는 service worker bypass는 측정 조건을 바꾸므로 기본 상태를 보존하고 조건 변경을 표시한다.
- 로그인·권한·메뉴·feature flag·tenant별 분기 때문에 첫 페이지 한 번으로 전체 API를 알 수 없다. 단순 네트워크 관측 성공률 대신 관측한 URL/시나리오·기간과 미확인 구간을 표시한다.
- Browser trace ID와 API Gateway request ID, Lambda request ID는 같은 ID라고 가정하지 않는다. 동일 서비스의 정식 integration ID 대응 또는 trace parent 관계가 있을 때만 exact correlation; 시간+경로+IP는 후보로 유지한다.

### Gaps

- 현재 계정에 RUM/X-Ray/OTel instrumentation, trace sampling 또는 API 로그 request ID 필드가 있는지는 미확인이다.
- URL 하나만으로 인증 정보·HTTP method·body·header·cookie·사용자 위치·cache 상태·동적 앱 조건을 결정할 수 없으므로 전체 경로와 실제 결과를 유일하게 예측할 수 없다.

## 4. 무입력 MVP와 점진적 보강은 어떻게 구성할 것인가

### Takeaway

URL 하나만 받는 기본 기능은 '관계 자동 발견과 조건부 경로 설명'으로 완성하고, 이미 있는 관측 데이터를 자연스럽게 덧붙이는 방식이 적절하다. 동적 브라우저나 instrumentation을 필수 온보딩으로 만들지 않는다.

### Cited Findings

- 현재 `readonly-guard.ts`의 허용 regex는 Describe/List/Get/Head/Lookup/BatchGet 접두어만 허용한다. `FilterLogEvents`, `StartQuery`, `StopQuery`는 현재 차단된다. — [읽기 전용 가드](/Users/jin/Repos/orrery/server/src/aws/readonly-guard.ts:10)
- `FilterLogEvents`는 그룹/기간/filter로 로그를 읽으며 빈 페이지도 nextToken이 있으면 완료가 아니다. `unmask` 기본 false이고 true에는 별도 권한이 필요하다. — [FilterLogEvents](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_FilterLogEvents.html)
- `StartQuery`는 query job을 만들고 결과가 CloudWatch에 저장되며 GetQueryResults로 가져온다. 단순 자원 조회와 운영 데이터 쿼리 실행은 비용·수명 관점에서 구분해야 한다. — [StartQuery](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_StartQuery.html)
- AWS는 Logs Insights에서 필요한 그룹만, 좁은 기간만 선택하고 불필요한 쿼리를 취소하도록 권한다. 최신 QL에는 `limit any` 조기 scan 중단이 있으나 일반 `limit` 결과 상한을 비용 상한과 동일시하면 안 된다. — [Logs Insights QL](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/CWL_QuerySyntax.html)

### Inferences

| 단계 | 사용자 작업 | 신규 읽기/처리 | 만들어지는 근거 | 주의점 |
|---|---|---|---|---|
| 현재 데이터 재활용 | URL만 입력 | 기존 graph/env 의미 처리·alias index | 구성 참조·서비스 후보 | tag/name를 호출로 승격 금지 |
| 상세 구성 읽기 | 추가 관계 지정 없음 | CloudFront behavior, API domain/routes/CORS | 조건부 라우팅 | control plane config와 실제 배포 구분 |
| FE 배포 파일 분석 | URL만 입력, 기능의 범위 안내 | HTML/참조 JS/config의 제한된 읽기·AST | code-reference | 코드 실행·전체 버킷 크롤링 없음 |
| 기존 로그 자동 검색 | 기간 기본값·비용 범위 안내 | 연결된 API 측 CF/WAF/REST/Lambda 로그 | observed-origin + lastSeen | 로그가 켜져 있을 때만, 샘플·redaction 표시 |
| 기존 trace 연결 | 선택한 과거 요청 | X-Ray/OTel export read | correlated-request | 이미 계측되고 sampling된 부분 |
| 선택적 브라우저 관측 | 실행 선택, 필요 시 직접 로그인 | CDP/HAR | browser-observed | 실제 트래픽·세션·민감정보 |
| 계측 보강 | 별도 개발/배포 | RUM/OTel 또는 선별 header logging | 반복 가능한 end-to-end trace | MVP 필수 아님, 운영 변경 별도 |

- MVP 추천 순서: (1) 구조화된 증거 모델과 domain/route resolver, (2) 배포 파일 정적 분석, (3) 기존 API 측 로그 provider, (4) 기존 trace 연결, (5) 선택적 browser capture. 관계 수동 승인 화면 없이 근거에 따라 자동 표시한다. 모호한 후보는 접힌 영역으로 두고 사용자에게 하나를 강제로 고르라고 요구하지 않는다.
- 최소 저장 정보: `sourceKind`, account/region, resource ID, FE origin, API host/method/path template, evidence timestamp/window, build ETag/hash, configured/observed/inferred, lookup status, sampling/truncation/permission 한계. 민감한 env 값·로그 본문·헤더 전체는 캐시하지 않는다.
- 로그 provider 자동 발견은 Stage accessLogSettings, REST execution destination/CloudWatch delivery, Lambda LoggingConfig, CF standard/realtime delivery, WAF LoggingConfiguration을 확인해야 한다. 고정 그룹명이나 S3 legacy 가정만으로 찾지 않는다.
- 기본 조회 한도는 서비스 보장이 아니라 제품 정책으로 설계한다: 좁은 최근 기간·알려진 대상 그룹만·최대 API 횟수·응답/압축해제 byte·파일 개수·동시성·취소·TTL. 시간 범위를 넓히는 동작을 명시하고 background 무한 polling 금지.
- Filter/Query를 쓰려면 AWS 서비스+정확한 command를 명시 허용하고 회귀 테스트를 추가한다. `Start*`/`Filter*` 전체 regex 허용으로 보안 경계를 넓히지 않는다. 읽기 전용 설명도 '인프라를 변경하지 않지만 유료 쿼리를 실행할 수 있음'으로 정확히 갱신한다.

### Gaps

- 비용은 로그 목적지·클래스·지역·스캔량·샘플링에 따라 달라 실계정 측정 없이 고정 금액을 제시할 수 없다. 호출 수 제한은 전체 비용의 엄격한 상한이 아니다.
- 수집된 실제 fixture가 없어 parser의 성공률, 민감정보 제거율, 응답시간 목표는 이후 검증이 필요하다.

## 5. 구현에서 반드시 검증할 안전성과 정확성

### Takeaway

자동 분석은 새로운 네트워크 경계와 민감정보 처리 경로를 만든다. 이를 기능 범위에 포함해 설계하되 사용자가 관계를 수동 입력하게 만드는 이유로 사용하지 않는다.

### Cited Findings

- URL 입력을 server fetch에 연결하면 SSRF가 발생할 수 있다. OWASP는 scheme·주소 정책, redirect 재검증, DNS rebinding 방지 및 검증된 IP에 실제 연결하는 방식을 권한다. Domain allowlist만으로는 충분하지 않다. — [OWASP SSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
- HAR sanitized도 민감 헤더 제외가 핵심이므로 수집 제품에서 URL/query/body 전체가 안전하다고 가정할 근거가 없다. — [Chrome export](https://developer.chrome.com/docs/devtools/network/reference/)

### Inferences

- URL 파서는 http/https만; userinfo 차단, localhost/loopback/link-local/metadata/private destination 기본 차단. 내부 서비스 지원은 별도 명시 범위로 설계한다. redirects·script/config URL·재시도·IPv4/IPv6 모든 연결에 동일 정책을 적용한다. TLS/SNI 인증을 유지하며 인증 헤더를 다른 origin으로 전달하지 않는다.
- remote JS는 분석 데이터로만 취급하고 eval/Node 실행 금지. Electron 메인 Node 권한과 격리된 프로세스/worker에서 파싱하고 크기·CPU·시간 제한. HTML·소스맵·압축 파일은 내용과 확장자가 다를 수 있어 검증 필요. 원격 HTML을 privileged webview에 그대로 삽입하지 않는다.
- 로그에서 origin hostname만 추출해 나머지는 폐기. signed URL query, auth token, cookie, body, 고객 식별 경로는 persist/export 제외. API route template를 우선 보관. source map과 번들에 비밀이 실수로 들어있어도 UI·외부 AI 서비스로 전송하지 않는다.
- 필수 fixture: CF/S3 FE+별도 API; 동일 CF `/api/*`; API custom domain mapping; Function URL; 동적 주소 unknown; 다중 FE/공용 API; OPTIONS만 있음; 위조/빈/null Origin; referer origin-only; log disabled/access denied/redacted/truncated/late; 배포 파일과 cache 버전 불일치; alias 변경·cross-account; SSR BFF; iframe/worker; cache hit; 요청 실패와 CORS 응답 차단; retry·parallel API; trace ID 누락/중복·시계 차이; private redirect·DNS rebinding·gzip bomb.
- 제품 성과는 '실제 graph coverage 중 근거가 있는 연결 비율', '오탐률', 'unknown 구간을 올바르게 남긴 비율', '분석 latency/읽은 byte/API 요청 수'로 측정하고 출처가 없는 90%/100% 완전성 점수를 만들지 않는다.

### Gaps

- 이 조사는 설계 검토다. SSRF 방어, parser, IAM, 로그 요금, Electron 격리 또는 실제 요청 흐름에 대한 구현/실행 검증은 하지 않았다.
