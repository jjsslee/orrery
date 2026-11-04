# 자체 업데이트 운영 가이드

[문서 목록](README.md) · [제품 소개](../README.ko.md) · [English](../README.md)

## v0.11.0 이하에서 처음 올릴 때

기존 updater는 Electron의 ASAR 가상 파일 API로 `app.asar`를 쓰다가 `Invalid package …/app.asar`로 실패합니다. 패키지 손상이나 권한 문제로 단정할 오류가 아닙니다. v0.11.1 이상의 ZIP을 받아 앱을 종료한 뒤 macOS는 `/Applications/Orrery.app`, Windows는 Orrery 폴더 전체를 교체합니다. 사용자 데이터와 AWS 설정은 앱 외부에 있으므로 그대로 둡니다. 기존 버전에서 새 updater를 자동으로 적용할 수 없으며 첫 교체는 수동으로 해야 합니다.

## 릴리즈 게시

`jjsslee/orrery`는 공개 저장소이며 사용자 PC는 로그인 없이 릴리즈를 조회합니다. 비공개로 전환하면 GitHub가 404를 반환하므로 이 배포 방식이 중단됩니다. 앱에 토큰을 넣거나 저장소 공개 범위를 바꾸는 코드는 없습니다.

1. 루트 `package.json`의 버전을 정식 버전 `X.Y.Z`로 올립니다. Release 태그는 같은 버전의 `vX.Y.Z` 또는 `X.Y.Z`를 사용합니다. 현재 updater는 prerelease·draft·버전 내림을 적용하지 않습니다.
2. macOS에서 `npm ci`, `npm run typecheck`, `npm test`, `npm run test:electron -w desktop`, `npm run package`를 실행합니다. 패키징은 ZIP 안의 Resources(`resources` on Windows)에 `orrery-update.json`을 추가합니다. 이 파일은 format 1, 루트 버전, OS, CPU를 기록합니다. macOS는 파일을 넣은 뒤 ad-hoc 서명합니다.
3. GitHub Release를 draft로 만들고 `release/Orrery-macos-arm64.zip`, `Orrery-macos-x64.zip`, `Orrery-windows-x64.zip` 세 파일을 올립니다. 파일명은 고정입니다. Source code ZIP은 앱 업데이트가 아닙니다.
4. 세 업로드가 끝나고 GitHub API의 각 asset에 `state: uploaded`, `digest: sha256:…`, 올바른 `size`가 생긴 것을 확인한 후 정식 Release로 게시합니다. 최신 정식 Release여야 `/releases/latest`에서 조회됩니다. ZIP 자체에 들어 있는 버전·OS·CPU가 태그와 일치해야 합니다. 기존 ZIP에 메타데이터가 없으면 업데이트를 거부하므로 새 패키징 스크립트로 다시 빌드합니다.
5. 자동 업데이트를 포함한 이전 버전에서 새 버전으로 실제 교체·재실행을 확인합니다. Mac ARM/Intel, Windows x64를 각각 검증합니다. 단위 테스트와 ZIP 검증만으로 실제 PC에서의 설치 성공을 단정하지 않습니다.

현재 구현은 Release를 읽고 적용합니다. Git commit·push·Release 작성이나 GitHub Actions 게시를 자동으로 실행하지 않습니다. 이미 게시한 버전의 ZIP을 바꾸기보다 버전 번호를 올린 새 릴리즈를 게시합니다.

## 사용자 흐름

첫 화면이 로드된 뒤 10초 후, 앱이 켜져 있는 동안 6시간마다 확인합니다. 메뉴의 **업데이트 → 업데이트 확인…**은 즉시 확인합니다. Windows는 `Alt`로 메뉴를 표시합니다. 새 버전 안내에서 **업데이트**를 누르면 다운로드·검증 후 앱이 종료·교체·재실행됩니다. 다운로드 중에는 메뉴 문구와 OS 작업표시줄·Dock의 진행 표시가 바뀝니다. **나중에**는 현재 실행 중 같은 버전의 자동 안내를 억제하고, 수동 확인은 계속 허용합니다.

자동 확인의 네트워크·API 제한 오류는 앱 사용을 방해하지 않습니다. 수동 확인 및 사용자가 시작한 설치의 오류는 대화상자로 표시합니다. 관리자 권한 상승을 요청하지 않으며, 앱 상위 폴더에 쓰기 권한이 없으면 설치 전에 중단합니다. 통신은 Electron에 포함된 Node의 fetch를 사용합니다. OS의 프록시 설정을 자동으로 가져오는 기능은 없으므로 프록시가 필수인 사내망에서는 별도 연결 검증이 필요합니다.

## 검증과 교체 구조

- `desktop/src/updates.ts`: 고정된 공개 GitHub API에서 최신 Release 조회, OS·CPU별 ZIP 선택, HTTPS GitHub 호스트로만 제한한 다운로드 이동, 10분 다운로드 제한, 600 MiB ZIP 상한, 바이트 수·SHA-256 검증. GitHub 토큰이나 AWS 자격증명은 보내지 않습니다.
- `desktop/src/update-fs.ts`: Electron에서는 공식 `original-fs`, 일반 Node에서는 `node:fs`를 선택합니다. 업데이트 파일을 실제 디스크 파일로 다루며 `process.noAsar`를 전역 변경하지 않습니다.
- `desktop/src/update-archive.ts`: 순수 JavaScript ZIP reader `yauzl`로 경로·중복 파일·파일 유형·총 압축 해제 크기(2 GiB)·항목 수(40,000)를 제한합니다. 일반 파일을 먼저 기록하고 macOS framework의 내부 심볼릭 링크를 마지막에 생성합니다. 링크를 따라 외부 파일을 덮어쓰지 않으며, Windows ZIP의 심볼릭 링크는 거부합니다.
- `desktop/src/update-install.ts`: 설치 폴더와 같은 파일시스템의 비공개 `.orrery-update-*`를 만들고 ZIP을 내려받아 해제·검증합니다. 버전·OS·CPU 메타데이터, 필수 파일, macOS `codesign --verify --deep --strict` 또는 Windows EXE 헤더를 확인합니다. updater 기록은 Electron `userData/updates/pending.json`에 저장합니다.
- `desktop/src/update-helper.ts`: macOS Bash·Windows PowerShell 프로그램입니다. 실행 준비 신호와 commit 파일을 주고받은 다음 이전 앱·서버 PID의 종료를 기다리고 폴더를 rename합니다. Windows는 파일 잠금을 고려해 rename을 최대 30회 재시도합니다. 기존 앱은 `previous`, 실패한 새 앱은 `failed-app`에 보관합니다. 60초 안에 새 앱의 준비 신호가 없으면 새 앱을 종료하고 이전 앱을 복원·실행합니다. macOS에서는 새로 시작한 PID에 TERM을 보낸 뒤에도 종료되지 않으면 KILL을 시도합니다. 기존 앱 PID는 강제 종료하지 않습니다. 새 앱을 종료할 수 없으면 파일을 강제로 삭제하지 않고 실패 기록을 남깁니다. 재실행한 Mac 앱의 작업 디렉터리는 설치 위치로 지정합니다.
- `desktop/src/update-controller.ts`, `desktop/src/main.ts`: 안내·메뉴·재시작 연동입니다. 새 앱은 거래 token·설치 경로·버전을 확인하고, 로컬 화면 로드 및 표시 준비가 끝난 뒤에만 ready 신호를 기록합니다. 교체 중 별도로 실행한 앱이 단일 인스턴스 잠금을 선점하지 않도록 실행 중인 helper를 확인합니다. 웹 renderer에 파일 쓰기·업데이트 IPC를 추가하지 않습니다. AWS 읽기 전용 정책은 변경하지 않습니다.

각 시도는 별도 작업 폴더를 사용합니다. 다운로드·검증에 실패하면 그 시도에서 만든 폴더만 제거하고 현재 앱은 교체하지 않습니다. 준비 중 일반 종료 요청은 다운로드·해제·서명 검사를 취소하고 정리가 끝날 때까지 잠시 종료를 미룹니다. 교체 후의 백업·로그는 다음 업데이트 때까지 남깁니다. 프로세스 강제 종료·전원 손실 시에는 임시 파일이나 미완료 기록이 남을 수 있습니다.

이 방식은 유료 OS 서명 서비스를 사용하지 않습니다. SHA-256은 다운로드 무결성을 검사하지만 GitHub 게시 계정 침해를 막는 독립적인 게시자 서명은 아닙니다. GitHub 권한·2FA와 릴리즈 파일 관리가 필요합니다. Gatekeeper·SmartScreen·기업 정책을 우회하거나 quarantine 속성을 제거하지 않습니다. 실행 차단 때문에 준비 신호가 없으면 복구를 시도하지만, 보안 프로그램·권한·전원 손실로 복구까지 실패할 가능성은 남습니다. 앱 준비 확인 이후 발생하는 모든 런타임 오류를 자동으로 롤백하는 기능은 아닙니다.

## 실패 시 복구

1. 실행 중인 Orrery와 관련 업데이트 프로그램이 끝났는지 확인합니다. 자동 교체 중에는 앱 폴더를 수동으로 옮기지 않습니다.
2. 설치 폴더 옆 `.orrery-update-*/result`, `install.log`를 확인합니다. `success`는 새 앱 준비 완료, `rolled-back`은 이전 앱 복원 완료, `unchanged`는 교체 전 실패(기존 앱 그대로이며 재시도 가능), `failed`는 수동 확인 필요, `cancelled`는 앱 교체 전 취소입니다. result가 없으면 미완료 상태입니다. 실패·복구 경고는 거래별 한 번만 표시하고 `notice-shown` 파일로 기록합니다. Windows에서 복원 후 재실행만 실패해도 파일 복원 상태는 `rolled-back`으로 유지합니다.
3. 설치 위치의 앱이 없거나 실행되지 않고 `previous`가 있으면, 실패한 앱 폴더를 별도로 보존하고 `previous`를 원래 위치·이름으로 옮깁니다(macOS `Orrery.app`, Windows `Orrery`). 사용자 데이터·AWS 설정 폴더는 건드리지 않습니다. `previous`가 없으면 GitHub의 알려진 정상 ZIP을 직접 내려받아 설치합니다.
4. 정상 앱 실행을 확인한 뒤에만 해당 작업 폴더와 Electron 사용자 데이터의 `updates/pending.json`을 정리합니다. 미완료·복구 실패 기록이 있으면 새 자동 설치를 막아 복구 파일 덮어쓰기를 방지합니다. 성공·복구 완료·교체 전 실패·취소 기록은 다음 업데이트 준비 때 자동 정리합니다.

## 검증 범위

`npm test`는 버전 선택·다운로드·해시 실패·ZIP 경로/링크·패키지 메타데이터·거래 준비 신호와 macOS helper의 교체·롤백을 임시 앱으로 검증합니다. macOS native helper 테스트는 macOS에서만 실행하며 Windows helper는 Windows 실기동 검증이 별도로 필요합니다. 실제 정식 Release 간 업데이트, Gatekeeper·SmartScreen, 읽기 전용 설치 위치, 회사 보안 정책 아래 동작은 실제 배포 환경에서 확인해야 합니다.

2026-11-04 구현 검증: 최종 전체 테스트 287개(server 148/web 100/desktop 39), 전체 typecheck/build, 세 플랫폼 패키징과 실제 `prepareUpdate` 경로의 ZIP 해제·버전/OS/CPU 메타데이터 검사·macOS 두 CPU의 서명 검증을 통과했습니다. Electron main process는 임시 사용자 데이터와 가짜 로컬 서버로 기동해 화면 로드·업데이트 메뉴·sandbox/contextIsolation 유지와 nodeIntegration 비활성화를 확인했습니다. 공개 GitHub API 조회·다운로드 302 처리는 Electron의 Node fetch로 확인했습니다. Windows 실기동, 실제 정식 Release 간 교체, OS 보안 정책에 따른 실행 허용은 미검증입니다. 이 문단은 릴리즈 게시 전 구현 검증 기록이며, 실제 배포 버전·자산은 [GitHub Releases](https://github.com/jjsslee/orrery/releases)에서 확인합니다.

재검증 중 기존 `server/src/monitoring/paths.test.ts`의 대규모 그래프 페이지 테스트가 전체 실행 1회와 단독 실행 1회에서 `nextOffset` assertion으로 실패했습니다. 해당 코드·테스트 변경 없이 이후 단독 및 전체 실행은 통과했으며 원인은 미확정입니다. 이 간헐 실패를 없애려고 테스트나 페이지 제한을 약화하지 않았습니다.

사용자 승인 후 Claude Code를 읽기 전용으로 호출한 교차 리뷰에서 ① 교체 전 실패의 재시도 차단·경고 반복 ② 준비 중 종료 시 임시 파일 잔존 ③ Mac의 TERM 무시 시 복구 중단을 지적했습니다. 실제 코드와 재현 테스트로 확인하여 위 상태 구분·경고 1회·취소 정리·KILL 후 종료 확인을 반영했고, 재리뷰에서 세 항목 해결과 중요한 추가 문제 없음이 확인됐습니다. 추가 낮은 관찰인 ‘종료 취소 정리를 기다리는 동안 기존 서버는 먼저 종료되어 창이 잠시 남을 수 있음’은 사용자가 이미 종료를 요청한 경로이고 설치·데이터 정합성에는 영향이 없어 유지했습니다. Windows 실제 실행과 OS 모달의 signal 처리 자체를 검증했다는 뜻은 아닙니다.

### v0.11.1 ASAR 회귀 검증

일반 Node에서의 ZIP 검증만으로 Electron 앱에서의 설치 준비를 검증했다고 볼 수 없습니다. `npm run test:electron -w desktop`는 실제 Electron main process에서 작은 ZIP의 ASAR 바이트 쓰기·메타데이터 불일치와 심볼릭 링크 거부·취소 정리·기존 설치 앱 보존·전역 ASAR 읽기 유지를 확인합니다. Electron 실행 파일은 설치되어 있어야 하며, 없으면 공식 `node node_modules/electron/install.js`로 먼저 준비합니다. 테스트는 실제 설치 폴더나 AWS를 사용하지 않습니다. macOS 환경에서 Windows 형식 ZIP을 검증하는 것은 Windows 네이티브 교체 검증을 대체하지 않습니다.

2026-11-04: 실제 Electron 44.9.3에서 v0.11.0 Mac ARM ZIP 준비가 동일한 `Invalid package …/app.asar`로 실패하는 것을 재현했습니다. 수정 뒤 같은 ZIP의 해제·메타데이터·codesign 검증과 정리가 통과했습니다. 기존 Node 테스트 결과는 ASAR 처리 차이를 놓쳤다는 한계가 있으며, 이 실제 Electron 검증으로 보완합니다.
