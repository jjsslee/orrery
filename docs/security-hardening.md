# 로컬 보안 보완 — 2026-10-27

> 과거 설계·검증 기록입니다. 현재 사용자 안내는 [문서 목록](README.md)에서 확인하세요. 당시 승인·예상 비용은 새 실행 권한이 아니며, 실환경 식별자는 공개 문서용 예시로 대체했습니다.

소스 변경 및 로컬 실행 파일 생성 기록이다. 설치된 앱 교체·외부 배포·GitHub Release 게시는 하지 않았다.

## 보완 범위

- 모든 데이터·제어 API에 실행별 256비트 Bearer 인증을 적용했다. 공개 health 응답은 유지한다.
- 데스크톱은 기존 실행 흐름에서 토큰을 자동 전달한다. 저장소/브라우저 실행은 `.orrery-cache/private/open-<port>.html`을 열어 접속한다. 토큰은 URL fragment에서 sessionStorage로 옮긴 뒤 주소에서 제거하며, 요청 URL·쿠키·서버 로그에 넣지 않는다.
- 진행 상황은 기존 SSE 형식을 유지하되 fetch로 받아 Authorization 헤더를 보낸다. 오류 코드·ping·타임아웃·취소 처리를 유지한다.
- 캐시는 디렉터리 0700/파일 0600으로 생성하고 기존 파일도 시작 시 보정한다. Windows는 현재 사용자만 허용하는 보호 DACL을 설정한다. 권한 설정 실패는 서버 시작 실패로 처리한다. 심볼릭 링크 읽기를 거부하고 임시 파일을 교체해 저장한다.
- CSP와 frame/referrer/MIME 보호 헤더를 적용한다. 로컬 폰트와 Worker를 허용하며 React Flow의 inline style은 유지한다. 개발 HMR은 nonce와 localhost WebSocket만 추가 허용한다.
- AWS 자원 API는 서비스별 명시 허용 목록으로 제한한다. 현재 명령/paginator 전부를 실제 SDK middleware로 대조한다. 자격증명 provider와 SSO 인증은 별도이며 AWS IAM 정책은 바꾸지 않았다.

## 검증

- 변경 전 캐시 권한·민감한 Get 명령 허용 테스트 실패를 확인한 뒤 수정했다. 추가로 bootstrap 인증 실패가 화면에 표시되지 않는 문제도 실패 테스트 후 수정했다.
- 전체 테스트, shared/server/web/desktop typecheck, 웹 build, Electron main/server CJS 번들 생성 및 diff 검사를 수행했다. 테스트 수는 [과거 검증 기록](verification-history.ko.md)을 참고한다.
- 실제 로컬 HTTP 서버와 Vite 프록시에서 무인증 401, 정상 인증 200, 공개 화면의 토큰 미포함, CSP, `/@fs/`를 통한 토큰·안내 파일 접근 차단을 확인했다.
- 새 브라우저 context의 모의 API로 개발/빌드 화면 각각에서 토폴로지 Worker, SSE 진행/완료, SSO 시작·완료 후 재연결, 모니터링 자원 선택·지표 요청, 로컬 폰트를 확인했다. 콘솔 오류와 외부 리소스 요청은 0건이었다.
- 임시 홈·빈 AWS 설정으로 격리한 패키지 서버 번들에서 인증 없는 종료 거부, 인증 성공, 기존 서버 교체, 토큰 교체, 0600 권한과 인증된 종료를 확인했다. Electron utility process 자체는 모의 parentPort로 대체했다.

## 경계와 미검증

- 같은 OS 사용자 권한을 가진 악성 프로그램, 관리자, 이미 탈취된 AWS 자격증명은 방어 범위 밖이다.
- 캐시는 암호화하지 않으며 TTL 만료만으로 디스크에서 지우지 않는다.
- 실제 AWS 조회·실제 회사 SSO 완료·Windows DACL 실행·Windows/Intel Mac 앱 실행은 이번 작업에서 수행하지 않았다. Windows PowerShell/파일 시스템 정책이 DACL 적용을 거부하면 앱은 안전하게 시작을 중단한다.
- Windows ACL 구현은 [Microsoft FileSystemAccessRule](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.filesystemaccessrule.-ctor?view=netframework-4.8.1)과 [Set-Acl](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/set-acl?view=powershell-5.1)의 API를 사용한다. 문서 대조는 Windows 실환경 검증을 대체하지 않는다.
- 브라우저는 서버를 재시작한 뒤 접속 안내 파일을 다시 열어야 한다. 원래 URL만 직접 입력하는 방식과 무인증 API 자동화는 더 이상 허용하지 않는다.

## 실행 파일 생성

2026-10-27 빌드 `0.7.0+20261027T052114Z`를 `release/`에 생성했다. 버전 표시는 0.7.0을 유지한다.

- macOS ARM64/Intel, Windows x64 ZIP 3개와 로컬 ARM64 `Orrery.app`, `SHA256SUMS.txt`를 갱신했다.
- 세 ZIP 무결성, ASAR의 서버/메인 번들과 로컬 폰트 일치, Mac 두 아키텍처 ad-hoc 서명, Windows PE 형식을 확인했다.
- 생성된 ARM64 ASAR 서버를 실제 Electron utility process로 실행하고 sandbox renderer에서 인증된 초기 화면을 확인했다. 사용자 홈과 AWS 설정은 임시 폴더/빈 설정으로 격리했다. 공개 health의 빌드 식별자, 무인증 API 401, fragment 제거, 토큰 보관, 설정 안내 화면을 확인했다.
- Windows/Intel Mac 실기동, 실제 회사 SSO 완료, Developer ID 서명·Apple 공증·Windows 코드 서명은 미검증/미적용이다.
