# 개발 및 패키징

[문서 목록](README.md) · [English overview](../README.md) · [한국어 소개](../README.ko.md)

이 문서는 소스에서 실행·빌드하는 개발자용 안내입니다. 앱 사용자용 설치 안내는 [한국어 README](../README.ko.md)를 참고하세요.

권장 환경: Node.js 24 이상과 npm. 현재 데스크톱 패키징 의존성의 최소 Node.js 요구사항은 22.12입니다.

## 실행

```bash
npm ci
npm run dev
```

- 웹: 시작 후 터미널에 표시되는 `.orrery-cache/private/open-<API포트>.html`을 브라우저로 열고 **개발 화면 열기**를 누릅니다(macOS 기본 포트: `open .orrery-cache/private/open-4820.html`). 주소만 직접 입력하면 API 인증이 거부됩니다. Vite는 http://localhost:5173 에서 `/api`를 `ORRERY_PORT`(기본 4820)로 프록시합니다. 설치한 Orrery가 4820을 쓰고 있으면 `ORRERY_PORT=4821 npm run dev`로 나란히 띄웁니다. 웹 포트 5173이 사용 중이면 자동으로 다른 포트를 택하지 않고 종료합니다.
- API 서버: http://127.0.0.1:4820 (Fastify, 로컬 전용 바인딩)
- 기본 프로필은 `ORRERY_DEFAULT_PROFILE`(없으면 `AWS_PROFILE`, 그다음 `default`)이고, 리전은 프로필의 `region` 설정값입니다. 프로필에 리전이 없고 저장된 선택도 없으면 리전을 고를 때까지 수집하지 않고, 계정에서 켜진 리전 목록(`DescribeRegions`)을 보여줍니다. 상단바에서 프로필·리전을 바꿀 수 있고 선택은 브라우저에 저장됩니다.

프로덕션 빌드는 `npm run build`(웹 번들) 후 `npm start`로 4820 포트에서 웹과 API를 함께 서빙합니다. 같은 로컬 접속 안내 파일에서 **빌드된 화면 열기**를 누릅니다. 서버를 다시 시작하면 토큰도 바뀌므로 안내 파일을 다시 여세요. 파일에는 접속 토큰이 들어 있으므로 공유하거나 버전 관리에 넣지 않습니다. 서버는 빌드 단계 없이 `tsx`로 TypeScript를 바로 실행합니다.

환경 변수는 셸에서 주거나 저장소 루트의 `.env`(gitignored, `.env.example` 참고)에 적습니다. 처음 열 때 `default` 프로필의 키가 만료되어 있으면 "액세스 키가 유효하지 않습니다"가 뜨므로, 쓰려는 프로필을 `ORRERY_DEFAULT_PROFILE`로 지정해 두는 것을 권합니다.

환경 변수:

| 변수 | 기본값 | 설명 |
|---|---|---|
| `ORRERY_PORT` | `4820` | API 서버 포트 (`PORT`는 쓰지 않음: 개발 서버 런처가 웹 앱용으로 설정함) |
| `ORRERY_GRAPH_TTL_MS` | `600000` | 수집 결과 캐시 수명 (10분) |
| `ORRERY_METRICS_TTL_MS` | `60000` | 지표 캐시 수명 |
| `ORRERY_DEFAULT_PROFILE` | – | 처음 열 때 선택할 프로필 (없으면 `AWS_PROFILE`, 그다음 `default`) |
| `AWS_PROFILE` | – | `?profile=` 생략 시 사용할 프로필 |

수집 결과는 `.orrery-cache/`에 JSON으로 저장되어 개발 서버 재시작 후에도 재사용됩니다. 인증 소스·실제 계정·리전별로 분리하며 파일 이름에는 키의 SHA-256 해시를 사용합니다. 현재 그래프 캐시 형식은 `graph-v9`이며 이전 형식은 재사용하지 않고 다시 수집합니다. 상단바의 **다시 수집**은 구성 캐시를 무시합니다. 상태·경보 갱신은 구성 캐시의 10분 만료 시간을 연장하지 않습니다. 세션 안에서는 STS 계정 확인과 실제 SDK 호출에 같은 자격증명 스냅샷을 사용합니다. 최대 5분 또는 임시 자격증명 만료 1분 전 중 먼저 도달한 시점에 STS로 다시 확인합니다. 키/SSO 설정을 갱신했거나 같은 프로필의 계정이 달라졌으면 **다시 연결**로 세션·계정을 즉시 다시 확인할 수 있습니다. 연결 실패 중에는 이전 계정의 화면 데이터를 비웁니다.

## 데스크톱 앱 (Windows·macOS)

배포 앱을 실행하는 사용자에게 Node.js 설치는 필요하지 않습니다. 더블클릭하면 브라우저 없이 Orrery 창이 뜨고, 그 PC의 `~/.aws`(Windows는 `%USERPROFILE%\.aws`) 프로필을 읽습니다. 자격증명은 로컬에서 읽어 AWS에 직접 인증하며 Orrery 전용 서버에 업로드하지 않습니다.

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
- Apple Developer ID 서명·공증과 Windows 코드 서명은 하지 않습니다. 그래서 받은 Mac에서 처음 열 때 Gatekeeper가 막으며, **시스템 설정 → 개인정보 보호 및 보안 → 그래도 열기**를 한 번 거쳐야 합니다([Apple의 앱 열기 안내](https://support.apple.com/ko-kr/102445) 참고). 앱은 응용 프로그램 폴더로 옮긴 뒤 여는 것을 권합니다. Windows에서 SmartScreen이 막으면 **추가 정보 → 실행**을 누릅니다.
- 앱 아이콘은 `scripts/icon/orrery-app.svg`를 `rsvg-convert -w 1024 -h 1024`로 그린 `orrery-app-1024.png`에서 만듭니다(macOS `.icns`, Windows `.ico`).



## 검증과 릴리즈

```bash
npm run typecheck
npm test
npm run test:electron -w desktop
npm run package
```

독립 lint 스크립트는 없습니다. `npm test`는 server/web/desktop을 모두 검사합니다. 실제 AWS 조회는 포함하지 않습니다. 공개 릴리즈 게시·SHA-256·복구 절차는 [자체 업데이트 운영 가이드](self-update.md)를 따릅니다. 과거 테스트와 실환경 검증은 [검증 기록](verification-history.ko.md)에서 날짜별로 구분합니다.

CloudWatch 비교 harness `scripts/verify-cloudwatch-monitoring.ts`는 기본 dry-run입니다. 예시 프로필·함수 이름을 사용하며 실제 조회는 이 문서로 승인되지 않습니다. 실제 비교가 필요하면 먼저 소스의 대상·계정·기간·호출 상한을 검토하고 별도로 승인받아야 합니다.
