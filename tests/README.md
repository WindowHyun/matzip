# 테스트

Playwright 헤드리스 브라우저로 전체 기능을 검증합니다 (네이버 지도·Supabase는 모킹).

## 실행 방법

```bash
# playwright가 없다면 (1회)
npm i playwright && npx playwright install chromium

# 실행 (저장소 어디서든)
node tests/run.mjs
```

- 전역 설치된 playwright를 쓰려면 `tests/node_modules/playwright`로 심볼릭 링크를 걸어도 됩니다.
- 실제 네트워크/DB 없이 동작합니다 — Supabase와 네이버 지도 SDK는 테스트 내에서 모킹됩니다.
- 마지막 줄에 `NN/NN 통과`가 출력되고, 실패 시 exit code 1로 종료됩니다.

## 검증 범위 (60개)

렌더링·XSS 방어 / 검색·필터·정렬 / 룰렛(태그·컨페티) / 실시간 증분 업데이트 /
찜·가봤어요·최근 본 / 고정 위치 / 삭제 가드 / 다크모드·설정 메뉴 /
PWA(manifest·SW·업데이트 배너) / 모바일 바텀시트 / 딥링크 / 단축키 /
로컬 캐시(SWR)·마커 재사용 등 성능 회귀 방지
