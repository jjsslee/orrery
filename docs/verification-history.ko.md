# 과거 검증 기록

[문서 목록](README.md) · [English overview](../README.md) · [한국어 소개](../README.ko.md)

이 문서는 각 날짜·버전에서 수행한 검증을 보존합니다. 과거 승인·비용 범위는 새 AWS 조회 권한이 아니며, 과거 통과가 현재 릴리즈나 모든 환경의 성공을 보장하지 않습니다. 실환경 식별자는 공개 문서용 예시로 대체했습니다. 현재 업데이트 검증은 [자체 업데이트 운영 가이드](self-update.md)를 참고하세요.

2026-10-27 보안 보완(미배포): 서버 109개 + 웹 74개, typecheck/build, Electron main/server CJS 번들, 로컬 API 인증·Vite 파일 차단·브라우저 모의 API 회귀를 확인했습니다. [상세 검증과 미검증 범위](security-hardening.md)를 참고하세요.

```bash
npm run typecheck   # shared / server / web
npm test            # server + web: 읽기 전용 가드, 로컬 요청, 경보/지표 오류, 캐시, 요청 경합, 차트 회귀
```

2026-11-02 v0.9.2 검증: 상세 패널 모니터링 바로가기와 토폴로지 연결선 개선을 포함합니다. 서버 148개 + 웹 93개 + desktop 3개(총 244개), 전체 typecheck/build, 세 플랫폼 ZIP 무결성·패키지 버전·웹 번들 일치, macOS ad-hoc 서명과 Windows PE 형식을 확인했습니다. 기존 대규모 그래프 페이지 테스트는 최초 전체 실행에서 한 번 실패한 뒤 코드·테스트 변경 없이 단독 및 전체 재실행에서 통과했으며 최초 실패 원인은 미확정입니다. 실제 AWS 조회·설치 앱 UI·Windows/Intel Mac 실기동은 미검증이며 Apple 공증·Windows 코드 서명은 적용하지 않았습니다.

2026-10-28 v0.9.1 검증: 모니터링 직접 목록을 기존 지표 카탈로그 전체 21유형으로 확장하고 NLB·AppSync GraphQL/Events 구분, API Gateway WebSocket 지표 수정, 관련 자원 안내·근거 기본 접힘을 반영했습니다. 서버 148개 + 웹 86개 + desktop 3개(총 237개), 전체 typecheck/build와 diff 검사를 통과했습니다. 실제 AWS 조회·브라우저 시각 검증·앱 실기동은 미검증이며 Apple 공증·Windows 코드 서명은 적용하지 않았습니다.

2026-10-28 v0.8.0 검증: 로컬 API·캐시·AWS 허용 목록 보안 보완과 도식 가이드·종류 중심 노드를 포함합니다. 서버 109개 + 웹 74개(총 183개), 전체 typecheck/build, 팝업·노드 브라우저 표시와 diff 검사를 통과했습니다. macOS ARM/Intel·Windows x64 패키지 버전·번들 일치, ZIP 무결성, Mac ad-hoc 서명과 Windows PE 형식을 확인했습니다. 이번 릴리즈에서 실제 AWS·회사 SSO·설치 앱 실기동·Windows DACL은 미검증이며 Apple 공증·Windows 코드 서명은 적용하지 않았습니다.

2026-10-27 v0.7.0 검증: 서버 102개 + 웹 69개(총 171개), 전체 typecheck/build와 diff 검사 통과. SSO 로그인 안내·완료 후 재연결은 브라우저 모의 API로 확인했습니다. 추가 자원 43개와 주요 연결을 demo-profile에서 읽기 전용으로 검증했습니다. 세 플랫폼 ZIP 무결성·버전, macOS ad-hoc 서명, Windows PE 형식과 SSO 서버 번들 포함을 확인했습니다. 실제 회사 SSO 인증 완료, Windows/Intel Mac 앱 실행과 Apple 공증은 미검증입니다.

2026-10-27 v0.6.1 검증: 태그 표시 회귀를 포함해 서버 90개 + 웹 64개(총 154개), 전체 typecheck/build와 diff 검사 통과. 세 플랫폼 ZIP 무결성·버전, macOS ad-hoc 서명, Windows PE 형식을 확인했습니다. ARM 내장 서버 health(`0.6.1+20261027T013844Z`) 및 태그 UI 자산을 확인했습니다. Windows/Intel Mac 실제 실행·Apple 공증·실계정 조회는 미검증입니다.

2026-10-27 v0.6.0 검증: 서버 90개 + 웹 63개(총 153개), 전체 typecheck/build와 diff 검사 통과. macOS ARM/Intel·Windows x64 ZIP 무결성·버전, macOS ad-hoc 서명, Windows PE 형식을 확인했습니다. ARM 내장 서버 health(`0.6.0+20261027T005622Z`)와 정리 후보 웹 자산을 확인했습니다. 실계정 CloudTrail 대조, Windows/Intel Mac 실제 실행과 Apple 공증은 미검증입니다.

2026-10-26 v0.5.1 검증: 서버 74개 + 웹 58개(총 132개), 전체 typecheck/build와 diff 검사를 통과했습니다. macOS ARM/Intel·Windows x64 ZIP 무결성, Mac ad-hoc 서명, Windows PE 형식과 패키지 버전을 확인했습니다. ARM 내장 서버는 Electron utility process에서 health(`0.5.1+20261026T072120Z`)·내장 웹을 확인했습니다. Windows/Intel Mac 실제 실행과 Apple 공증은 미검증입니다.

2026-10-26 v0.4.0 검증: `npm test` 서버 73개 + 웹 56개(총 129개), shared/server/web 전체 typecheck, build, `git diff --check`를 통과했습니다. 함께 보는 자원 8개 상한·어디서나 빼기 테스트는 이전 코드에서 실패하는 것을 먼저 확인했습니다. 실계정에서 Lambda 8개를 담아 지표 쿼리 32개를 SDK 1회로 조회했고, 1440/1280/1024/820/390px와 다크/라이트에서 상단바 잘림·가로 넘침이 없음을 확인했습니다. macOS/Windows 실행파일 생성, zip 정합성, Windows PE 형식, macOS 서명(arm64·x86_64) 검사와 macOS ARM 실행파일의 health(`0.4.0+20261026T013509Z`)·내장 웹 자산을 확인했습니다. Windows/Intel Mac 실제 실행과 Apple 공증은 미검증입니다.

2026-10-23 v0.3.0 검증: `npm test` 서버 73개 + 웹 53개(총 126개), shared/server/web 전체 typecheck, 최종 build, `git diff --check`를 통과했습니다. 자원 검색·후보 추가·저장 복원·경보 이력·기간 변경·숨김 중단과 1440px 다크/640·360px 라이트 화면을 fixture 브라우저에서 확인했으며 최종 console/page error는 0개였습니다. 제한 실계정 조회에서 목록·관계와 Lambda 두 개의 6개 지표 쿼리를 확인했지만 결과는 모두 empty였으므로 값이 있는 차트는 fixture 검증으로 구분합니다.

최종 macOS/Windows 실행파일 생성·zip 정합성·Windows PE 형식·macOS 서명 검사를 통과했습니다. macOS ARM 실행파일의 읽기 전용 health와 빌드 `0.3.0+20261023T074320Z`, 내장 JS의 새 화면 반영을 확인했습니다. Windows/Intel Mac 실제 실행과 Apple 공증은 미검증입니다. A/B/C 구현·검증 범위와 남은 한계는 [자원 중심 화면 검증 기록](monitoring-resource-workspace-plan.md)에 있습니다. 커밋·푸시·GitHub Release는 root 작업에서 진행하며 이 검증 기록은 게시 완료를 뜻하지 않습니다. 로그 조회는 후속 범위입니다.
