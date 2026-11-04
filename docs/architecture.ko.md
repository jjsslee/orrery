# 구조와 보안 경계

[문서 목록](README.md) · [English overview](../README.md) · [한국어 소개](../README.ko.md)

현재 소스 기준 개발 참고 문서입니다. 앱 사용과 설치는 루트 README, 업데이트 거래와 복구는 [자체 업데이트 운영 가이드](self-update.md)를 참고하세요.

## 읽기 전용 보장

자원 조회용 AWS SDK 클라이언트에는 `server/src/aws/readonly-guard.ts`의 미들웨어가 붙습니다. `readonly-policy.ts`에 명시된 **서비스와 명령의 조합**만 서명·전송 전에 허용합니다. 현재 수집기·모니터링·계정 확인에 필요한 명령을 포함하며, `GetSecretValue`, `GetSessionToken`, `GetObject` 등 사용하지 않는 조회 명령도 차단합니다. `npm test`는 실제 SDK middleware 문맥에서 기존 명령과 paginator의 허용 여부를 대조합니다. 명령 추가 시 정책과 테스트를 함께 검토해야 합니다.

자격증명 획득용 SDK provider(SSO·AssumeRole 등)와 AWS CLI SSO 로그인은 이 자원 조회 가드와 별도입니다. 이 가드는 IAM 권한을 바꾸거나 임의 코드 실행을 막는 샌드박스가 아닙니다. 전용 프로필/역할에 실제 필요한 조회 권한만 부여하세요. 이번 보완으로 실계정의 IAM 정책은 변경하지 않았습니다.

## 로컬 전용 요청

서버는 `127.0.0.1`에만 바인딩해 다른 PC의 접속을 막습니다. 같은 브라우저에 열린 다른 사이트도 루프백에 요청할 수 있으므로 `server/src/http/local-only.ts`가 두 가지를 더 거릅니다. Host 헤더가 `127.0.0.1`·`localhost`·`[::1]`이 아니면 DNS 리바인딩으로 보고 거부합니다. `/api/` 요청의 `Sec-Fetch-Site`가 `same-origin`·`none`이 아니면(다른 사이트의 fetch·이미지·폼·링크) 수집을 시작하지 못하게 거부합니다. 화면 자체는 다른 사이트의 링크로도 열 수 있습니다. CORS 헤더는 보내지 않으므로 다른 출처는 응답을 읽을 수 없습니다. 웹은 같은 출처(프로덕션) 또는 Vite 프록시(개발)로만 API를 부릅니다.

`/api/health`를 제외한 모든 API(SSO·진행 스트리밍·앱 종료 포함)는 실행마다 생성하는 256비트 토큰을 `Authorization` 헤더로 요구합니다. 외부 Origin도 거부합니다. 데스크톱은 부모 프로세스에 전달한 시작 주소의 fragment로 토큰을 전달하고, 브라우저는 본인만 읽을 수 있는 로컬 안내 파일로 접속합니다. 화면은 fragment를 즉시 지우고 토큰을 탭의 sessionStorage에 보관합니다. API 쿼리·쿠키·서버 로그에는 토큰을 넣지 않으며 HTTP로 토큰을 발급하는 공개 endpoint도 없습니다. 스트리밍은 인증 헤더가 가능한 fetch 기반 SSE입니다. 다른 OS 사용자와 무인증 로컬 클라이언트를 차단하지만, 같은 OS 사용자 권한을 이미 가진 악성 프로그램이나 관리자까지 방어하지는 않습니다.

캐시·토큰 폴더는 macOS/Linux에서 `0700`, 파일은 `0600`으로 보호하며 기존 캐시도 시작 시 보정합니다. Windows는 PowerShell로 현재 사용자만 허용하는 보호된 DACL을 적용하며, 적용 실패 시 서버 시작을 중단합니다. 파일은 임시 파일 생성 후 교체하고 캐시 읽기는 심볼릭 링크를 거부합니다. 캐시는 평문이며 TTL 만료가 디스크 삭제를 뜻하지 않습니다.

화면에는 CSP·프레임 삽입 차단·Referrer 차단·MIME sniffing 차단 헤더를 적용합니다. 지도 배치 Worker와 로컬 리소스만 허용하고, React Flow의 위치 계산에 필요한 inline style은 유지합니다. 개발 모드는 Vite HMR용 WebSocket과 nonce가 있는 스크립트를 추가 허용합니다. Vite는 인증 파일·캐시를 `/@fs/`로도 제공하지 않습니다. Pretendard v1.3.9와 JetBrains Mono v2.304는 `web/public/fonts/`에 OFL 라이선스와 함께 포함하여 외부 CSS/폰트 요청을 없앴습니다.

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
- OpenSearch Serverless: 컬렉션 유형·상태·엔드포인트·태그·KMS 참조를 수집합니다. 네트워크·데이터 접근 정책과 VPC Endpoint 구성을 조회해 관계를 표시합니다. 정책 구성을 실제 통신 성공·종합 권한 판정으로 해석하지 않으며 인덱스 데이터는 조회하지 않습니다.
- Transit Gateway: 게이트웨이와 `available` 상태의 VPC attachment를 연결합니다. 라우트 테이블 전파·경로 또는 다른 계정의 VPC를 추론하지 않습니다.
- Cloud Map: namespace·service를 별도 노드로 표시하고 namespace–service, Route 53 hosted zone, ECS service registry/Service Connect의 ARN 참조를 연결합니다. 등록 인스턴스의 EC2·IP·CNAME 참조를 조회합니다. 이것만으로 대상의 실제 건강 상태를 판정하지 않습니다.
- WAF: 선택 리전의 Web ACL과 CloudFront용 글로벌 Web ACL을 별도로 수집합니다. ALB·REST API stage·AppSync의 연결 및 CloudFront의 Web ACL 참조를 연결합니다. 규칙 본문은 저장하지 않습니다.
- ACM: 선택 리전과 CloudFront 인증서 리전(`us-east-1`, 중복 조회 제외)의 인증서를 수집합니다. 만료/폐기/실패는 위험, 만료 30일 이내는 주의로 표시합니다. CloudFront와 ELB listener의 기본 인증서 연결을 표시하며 추가 SNI 인증서는 조회하지 않습니다.

WAF 글로벌 조회는 `us-east-1`을 사용합니다. 다른 파티션의 글로벌 서비스 리전은 지원하지 않습니다. 새 유형은 지도·검색·상세 및 관련 자원에서 사용할 수 있지만 CloudWatch 지표는 아직 지원하지 않습니다. Cloud Map·WAF는 구성 조회 성공만으로 건강 상태를 단정하지 않습니다. 상세 조회가 실패한 자원은 목록에서 확인한 정보를 유지하고 `상세 미수집`으로 표시합니다. 태그·관계 조회 오류는 서버 로그에 남기며 확인하지 못한 연결은 추가하지 않습니다.

추가 권한은 `scheduler:ListSchedules/GetSchedule`, `aoss:ListCollections/BatchGetCollection/ListTagsForResource/ListVpcEndpoints/BatchGetVpcEndpoint/ListSecurityPolicies/GetSecurityPolicy/ListAccessPolicies/GetAccessPolicy`, `ec2:DescribeTransitGateways/DescribeTransitGatewayAttachments`, `servicediscovery:ListNamespaces/GetNamespace/ListServices/GetService/ListTagsForResource/ListInstances`, `wafv2:ListWebACLs/GetWebACL/ListTagsForResource/ListResourcesForWebACL`, `acm:ListCertificates/DescribeCertificate/ListTagsForCertificate`입니다. 모두 기존 읽기 전용 SDK guard를 통과하며 비밀 값·로그 본문·인증서 개인 키는 조회하지 않습니다.