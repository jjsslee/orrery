# 정리 후보 탭 구현 계획 및 현재 범위

갱신: 2026-10-27. v0.6.0 구현 및 배포 패키지 검증 완료. 릴리즈 게시 상태는 GitHub Release를 기준으로 확인한다.

## 확정한 사용자 요구

- 현재 상태만으로 정리 후보를 확정하지 않고 최근 30일 이력을 함께 본다.
- 상태가 얼마나 지속되었는지 근거와 함께 표시한다. 시작 시점을 모르면 확인 불가로 표시한다.
- 왼쪽 목록에서 자원을 선택하면 오른쪽 상세가 바뀐다. 카드 그리드는 사용하지 않는다.
- 대상 제외·보관 제외·복원·사유 저장 기능은 제공하지 않는다.
- 프로필·실제 계정·리전마다 격리하며 특정 계정의 이름·구성에 의존하지 않는다.
- AWS 접근은 읽기 전용이며 삭제·중지·태그 변경을 하지 않는다.

## 수집 및 판단

기존 구성 수집에서 아래 조건을 확인한 자원을 먼저 ‘이력 분석 전’으로 표시한다.

| 유형 | 현재 구성 조건 | 기간 판단의 한계 |
|---|---|---|
| EBS | available이며 attachment 0개 | 성공한 분리/생성 요청 기록 기준 추정. Multi-Attach가 false임을 확인하지 못하면 후보 확정 불가 |
| Target Group | DescribeTargetHealth 성공 및 원본 등록 대상 0개 | 개별 등록 해제로 전체가 비게 된 시점을 알 수 없어 기간 확인 불가 |
| EC2 | stopped | StopInstances 요청 시각은 실제 중지 완료 시각과 다름 |
| CloudFront | Enabled=false 명시 | 비활성 설정이 확인되는 변경 요청 시각 기준 추정 |

조회 실패·누락된 상태를 빈 목록/false로 바꾸지 않는다. unhealthy 또는 draining 대상도 등록 대상으로 센다. 현재 구성의 하위 API별 성공/실패를 별도 기록한다.

사용자가 분석 버튼을 누르면 CloudTrail LookupEvents를 조회한다. 판정은 최근 30일이며 시작 시점을 찾기 위해 최대 90일을 탐색한다. 애플리케이션 접근 로그·CloudWatch 사용량 지표는 조회하지 않는다. CloudFront 관리 이력은 us-east-1에서 조회한다.

- 현재 상태와 30일 이전 상태 변경 기록이 일치하고 이후 조회된 이력에 재사용 기록이 없을 때만 ‘정리 검토 후보’로 표시한다.
- 최근 기동·연결·등록·활성화 또는 최근 상태 전환이 확인되면 ‘최근 활동·변경’으로 표시한다.
- 조회 실패·일부 이력·기록 부재·해석 불가·시점 불명은 ‘근거 부족’이다. 로그 부재는 미사용 증거가 아니다.
- 기간은 ‘상태 변경 요청 기록 후 경과 (추정)’다. 연속 유지 기간을 측정한 값으로 표현하지 않는다. 실제 연속 상태 보장이 필요한 경우 장기 관측 기능은 별도 설계해야 한다.
- 현재 Target Group은 이력만으로 30일간 비어 있었음을 확정하지 않는다.
- 데이터 보존·예비/복구 용도·예약 기동·전체 의존성은 확인하지 않으므로 삭제 안전성을 보장하지 않는다.

## 화면

상단에 계정·리전·구성 시각과 판정별 개수를 표시한다. 이름/ID 검색, 유형 및 판정 필터를 제공한다.

목록에는 자원 이름/ID, 현재 상태, 경과 기간과 추정 여부, 30일 판정을 표시한다. 선택한 행만 강조하고 상세에는 해당 자원의 수집된 태그·조건·기간 근거·최근 30일 이벤트·조회 기간·확인 한계·수집 구성과 관련 자원을 표시한다. 상세에서 개별 이력 분석, 지도 이동, AWS 콘솔 이동을 제공한다. 좁은 화면에서는 상세를 목록 아래에 배치한다.

시안: `docs/mockups/cleanup-candidates/index.html`. 가상 데이터이며 행 선택 및 상세 펼치기만 동작한다. 실제 AWS 조회·지도 이동은 시안에서 비활성화한다.

## 구현 경계 및 저장

- `server/src/cleanup/observe.ts`, `evaluate.ts`: 기존 collector의 typed 사실 및 하위 API coverage를 보존하고 현재 상태를 평가한다.
- `history.ts`: 안전한 이벤트 이름·시각·효과만 추출한다. 원본 CloudTrail payload, 사용자 신원, IP를 브라우저나 캐시에 전달하지 않는다.
- `routes.ts`: 현재 계정의 캐시된 구성과 finding을 검증한 뒤 분석한다. 구성 시각이 다르거나 10분 이상 지났으면 재수집을 요청한다.
- `ResourceGraph.cleanup`를 추가하고 구성 캐시를 graph-v6로 분리한다. 구성 사실은 기존 `.orrery-cache/` 저장 정책을 따른다.
- 이력은 서버 메모리에만 최대 100개/5분 보관한다. complete 결과만 재사용한다. 동일 요청을 합치며 동시 분석은 최대 2개다.
- 자원당 최대 10페이지/500개 이벤트, 목록 버튼 한 번당 최대 20개 순차 분석이다. 초과 페이지가 있으면 근거 부족으로 남긴다.
- 계정/조회 리전별 큐로 요청을 직렬화하고 호출 사이 600ms를 둔다. 기존 SDK 재시도 정책을 사용한다.
- 클라이언트는 scope·구성 시각·연결 세대가 다른 응답을 무시한다. 화면을 나가면 진행 중인 목록 요청을 취소하지만 이미 시작한 서버 조회는 완료될 수 있다.
- 제외 설정용 localStorage나 DB는 만들지 않는다. 탭 자동 polling도 없다.
- 추가 권한은 `cloudtrail:LookupEvents`다. 권한 실패를 후보 0개로 해석하지 않는다.

## 검증 및 남은 범위

2026-10-27 로컬 typecheck와 서버 90개/웹 63개 테스트 통과. 현재 상태 판정, 등록 대상 원본 개수, 하위 조회 오류, 기간/해석 실패, scope 불일치, 요청 중복, 목록과 단일 상세 렌더링을 검증했다. 가상 데이터 브라우저에서 네 자원 이력 분석과 행 선택에 따른 상세 변경, 1440px 좌우 배치 및 390px 가로 넘침 없음을 확인했다.

실계정 CloudTrail 이벤트 인덱싱·권한·실제 자원별 판정 대조, Windows·Intel Mac 실제 실행은 미검증이다. macOS ARM 내장 서버 health 및 웹 자산, 세 ZIP 무결성·버전, macOS ad-hoc 서명, Windows PE 형식은 확인했다.

## 공식 참고

- [CloudTrail LookupEvents](https://docs.aws.amazon.com/awscloudtrail/latest/APIReference/API_LookupEvents.html)
- [CloudFront CloudTrail 기록](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/logging_using_cloudtrail.html)
- [EC2 StopInstances](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_StopInstances.html)
- [DescribeTargetHealth](https://docs.aws.amazon.com/elasticloadbalancing/latest/APIReference/API_DescribeTargetHealth.html)
