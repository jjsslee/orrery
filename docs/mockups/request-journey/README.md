# End user 요청·응답 흐름 시안

이 시안은 이전 FE–BE 후보선 탐색 시안을 대체한다. 사용자는 End user를 클릭하고 요청 점이 자원을 거쳐 이동한 뒤 응답 점이 브라우저로 돌아오는 과정을 보고 싶다고 명확히 했다. CORS는 내부 관계 분석 근거이며 기본 화면에 강조하지 않는다.

- A: 한 End user와 전체 FE/BE 경로를 고정해 보여주는 지도 (추천).
- B: 현재 진행 중인 화면 요청 또는 API 요청만 크게 보여주는 집중 화면.
- C: 같은 브라우저의 화면 파일 요청과 API 요청을 두 행에 나눠 표시.

End user 클릭/Enter로 재생한다. 일시정지, 다음 구간, 처음으로, 위치 슬라이더, 속도, CloudFront 캐시 조건, 다크/라이트를 바꿀 수 있다. 캐시 hit이면 CF↔S3 구간을 생략한다. 화면 파일 수신 후 별도 API 요청을 시작하며 S3→API 호출로 그리지 않는다.

예시 데이터와 설명용 이동 속도를 사용한다. AWS 설정 조회·실제 URL 호출·실제 traffic/latency 관측은 없다. 코드 참조/CORS만으로 실제 경로를 증명하지 않는다. production UI에 적용하지 않은 독립 시안이다.

```sh
python3 -m http.server 4832 --bind 127.0.0.1 --directory docs/mockups/request-journey
```

`index.html`은 브라우저에서 직접 열어도 동작한다. 모든 의존성은 파일 안에 있고 외부 요청이 없다.

검증: 세 안 모두 재생 완료와 최종 화면+API 응답 수신 확인, 요청 점의 위치 변화, 응답 구간 이동, 캐시 hit S3 skip, 1440/820/390px 문서 overflow 없음, 다크/라이트, page error 0. 스크린샷은 같은 폴더의 `a-response.png`, `b-response.png`, `c-response.png`, `a-light.png`다. 실제 통합·자동 배치·접근성 전체 감사는 이 시안 범위가 아니다.
