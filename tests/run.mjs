import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 저장소 루트 (tests/의 상위)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html':'text/html', '.css':'text/css', '.js':'application/javascript', '.mjs':'application/javascript',
  '.webmanifest':'application/manifest+json', '.svg':'image/svg+xml', '.json':'application/json', '.png':'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(ROOT, p);
  if (!fp.startsWith(ROOT) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
    res.writeHead(404); res.end('nf'); return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(fp)] || 'application/octet-stream' });
  fs.createReadStream(fp).pipe(res);
});

const PLACES = [
  { id:'d1', cat:'noodle', name:'후암 쌀국수', menu:'쌀국수 9,500원', comment:'맛있음', lat:37.5485, lng:126.9759, tags:['solo'], added_by:'기본', created_at:'2026-01-01' },
  { id:'x1', cat:'rice', name:'<img src=x onerror="window.__xss=1">', menu:'<b>menu</b>', comment:'<svg onload="window.__xss=2">', lat:37.5400, lng:126.9800, tags:[], added_by:'<i>n</i>', created_at:'2026-01-02' }
];
const SUMS = [ { place_id:'d1', average:4.5, count:2 } ];

const MOCK_SUPABASE = `
const PLACES = ${JSON.stringify(PLACES)};
const SUMS = ${JSON.stringify(SUMS)};
export function createClient() {
  function builder(table) {
    const b = {
      select(){ return b; }, order(){ return b; }, eq(){ return b; },
      insert(){ return Promise.resolve({ data:null, error:null }); },
      update(){ return b; }, delete(){ return b; },
      upsert(){ return Promise.resolve({ data:null, error:null }); },
      maybeSingle(){ return Promise.resolve({ data: table==='rating_summary' ? { average:4.5, count:2 } : null, error:null }); },
      single(){ return Promise.resolve({ data:null, error:null }); },
      then(res, rej){
        let data = null;
        if (table==='places') data = PLACES;
        else if (table==='rating_summary') data = SUMS;
        else if (table==='ratings') data = [];
        return Promise.resolve({ data, error:null }).then(res, rej);
      }
    };
    return b;
  }
  return {
    from: builder,
    auth: {
      getUser: () => Promise.resolve({ data: { user: { id:'u-test' } } }),
      signInAnonymously: () => Promise.resolve({ data: { user: { id:'u-test' } }, error:null })
    },
    channel: () => { const ch = { on: () => ch, subscribe: () => ch }; return ch; }
  };
}
`;

const NAVER_STUB = () => {
  window.naver = {
    maps: {
      Map: function(){ this.getCenter=()=>new window.naver.maps.LatLng(37.55,126.97); this.panTo=()=>{}; this.setOptions=()=>{}; this.setZoom=()=>{}; this.setCenter=()=>{}; this.setMapTypeId=()=>{}; this.getProjection=()=>null; },
      Marker: function(opts){ this._opts=opts||{}; this._pos=this._opts.position; this._el=document.createElement('div');
        this.setMap=()=>{}; this.setVisible=()=>{}; this.setPosition=p=>{this._pos=p;}; this.setIcon=()=>{}; this.setTitle=()=>{};
        this.setDraggable=()=>{}; this.setCursor=()=>{}; this.getElement=()=>this._el; this.getPosition=()=>this._pos; },
      InfoWindow: function(opts){ this._opts=opts||{}; this.open=()=>{}; this.close=()=>{}; this.setContent=c=>{this._opts.content=c;}; this.getElement=()=>null; },
      Event: { addListener: ()=>({}) },
      LatLng: function(lat,lng){ this._lat=lat; this._lng=lng; this.lat=()=>this._lat; this.lng=()=>this._lng; },
      Point: function(x,y){ this.x=x; this.y=y; },
      Size: function(w,h){ this.w=w; this.h=h; },
      MapTypeId: { NORMAL:'normal', HYBRID:'hybrid' }
    }
  };
};

const results = [];
const ok = (n, c, extra='') => { results.push([c, n + (extra?` — ${extra}`:'')]); };

await new Promise(r => server.listen(0, r));
const PORT = server.address().port;
const BASE = `http://localhost:${PORT}`;

const browser = await chromium.launch();
const ctx = await browser.newContext({
  acceptDownloads: true,
  geolocation: { latitude: 37.5500, longitude: 126.9760 },
  permissions: ['geolocation']
});
const page = await ctx.newPage();

const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String(e)));

await page.addInitScript(NAVER_STUB);
await page.addInitScript(() => { try { localStorage.setItem('matzip_nickname', 'tester'); } catch(e){} });

await page.route('**/*', route => {
  const url = route.request().url();
  const H = { 'Access-Control-Allow-Origin':'*' };
  if (url.startsWith(BASE)) return route.continue();
  if (url.includes('supabase-js'))
    return route.fulfill({ status:200, headers:{...H,'content-type':'application/javascript'}, body: MOCK_SUPABASE });
  if (url.includes('oapi.map.naver.com') || url.includes('jsdelivr') || url.includes('cloudflare'))
    return route.fulfill({ status:200, headers:{...H,'content-type':'application/javascript'}, body: '' });
  if (url.includes('fonts.googleapis.com') || url.includes('fonts.gstatic.com'))
    return route.fulfill({ status:200, headers:{...H,'content-type':'text/css'}, body: '' });
  return route.fulfill({ status:200, headers:H, body: '' });
});

await page.goto(`${BASE}/index.html`, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#list .list-item').length >= 2, { timeout: 8000 });

// A. 기본 렌더 + XSS
const count0 = await page.locator('#list .list-item').count();
ok('초기 목록 렌더(2곳)', count0 === 2, `count=${count0}`);
const xss = await page.evaluate(() => window.__xss);
ok('저장형 XSS 차단(onerror/onload 미실행)', xss === undefined, `__xss=${xss}`);
const nameHtml = await page.evaluate(() => {
  const it = [...document.querySelectorAll('.item-name')].find(e => e.textContent.includes('<img'));
  return it ? it.innerHTML : '';
});
ok('악성 매장명이 텍스트로 이스케이프됨', nameHtml.includes('&lt;img') && !nameHtml.includes('<img'), nameHtml.slice(0,40));

// B. 검색 (디바운스 + 코멘트/태그 확장)
async function visibleAfterSearch(q) {
  await page.fill('#search-input', q);
  await page.waitForTimeout(260);
  return page.evaluate(() => [...document.querySelectorAll('#list .list-item')].filter(e => e.style.display !== 'none').length);
}
ok('검색: 매장명', (await visibleAfterSearch('후암')) === 1);
ok('검색: 코멘트 포함', (await visibleAfterSearch('맛있')) === 1);
ok('검색: 태그 라벨 포함', (await visibleAfterSearch('혼밥')) === 1);
await page.fill('#search-input', '');
await page.waitForTimeout(220);

// C. 추천 룰렛 (태그 셀렉트 + 다시 돌리기)
await page.click('.rec-btn');
const tagOpts = await page.locator('#rec-tag option').count();
ok('룰렛 태그 조건 셀렉트(7개 옵션)', tagOpts === 7, `options=${tagOpts}`);
await page.click('.rec-cat[data-cat="all"]');
await page.waitForFunction(() => !document.getElementById('rec-goto-btn').disabled, null, { timeout: 7000 });
const reveal = await page.locator('#rec-result .rec-card-reveal').count();
const respin = await page.evaluate(() => [...document.querySelectorAll('#rec-result button')].some(b => b.textContent.includes('다시 돌리기')));
const confettiN = await page.locator('#rec-result .confetti').count();
ok('룰렛 결과 카드 + 다시 돌리기 버튼', reveal === 1 && respin);
ok('당첨 컨페티 연출', confettiN > 0, `confetti=${confettiN}`);
await page.click('#rec-overlay .modal-actions .btn-cancel');

// D. 설정 메뉴 + 다크모드
await page.click('#settings-btn');
const menuOpen = await page.evaluate(() => document.getElementById('menu-pop').classList.contains('open'));
ok('설정(⚙️) 메뉴 열림', menuOpen);
await page.click('#theme-btn');
const themed = await page.evaluate(() => ({
  attr: document.documentElement.getAttribute('data-theme'),
  ls: localStorage.getItem('matzip_theme')
}));
ok('다크모드 토글 + 저장', themed.attr === 'dark' && themed.ls === 'dark', JSON.stringify(themed));
await page.click('#theme-btn');
await page.evaluate(() => window.toggleMenu(false));

// D-1. 로딩 오버레이 숨김
ok('로딩 오버레이: 로드 후 숨김', await page.evaluate(() => document.getElementById('loading').style.display === 'none'));

// D-2. 빈 결과 안내 + 필터 초기화
await page.fill('#search-input', 'zzz없는검색어');
await page.waitForTimeout(260);
const emptyShown = await page.evaluate(() => document.getElementById('empty-state').style.display !== 'none');
await page.click('#empty-state button');
await page.waitForTimeout(80);
const emptyHidden = await page.evaluate(() => document.getElementById('empty-state').style.display === 'none');
const restored = await page.evaluate(() => [...document.querySelectorAll('#list .list-item')].filter(e => e.style.display !== 'none').length);
ok('빈 결과 안내 + 필터 초기화', emptyShown && emptyHidden && restored === 2, `restored=${restored}`);

// D-3. 추가 모달 2단계
await page.click('.add-btn');
const s2hidden = await page.evaluate(() => document.getElementById('add-step2').style.display === 'none');
await page.fill('#f-name', '테스트집');
await page.click('#add-step1 .btn-submit');
const s2shown = await page.evaluate(() => document.getElementById('add-step2').style.display !== 'none');
await page.click('#add-step2 .btn-cancel');
const backTo1 = await page.evaluate(() => document.getElementById('add-step1').style.display !== 'none');
await page.evaluate(() => window.closeAddModal());
ok('추가 모달 2단계 전환(다음/이전)', s2hidden && s2shown && backTo1);

// E. 실시간 증분 업데이트
const firstHandle = await page.evaluateHandle(() => document.querySelector('#list .list-item'));
await page.evaluate(() => window.__matzip.onPlacesChange({ eventType:'INSERT', new:{ id:'rt1', cat:'rice', name:'실시간추가집', menu:'테스트', comment:'', lat:37.55, lng:126.97, tags:[], added_by:'t' } }));
await page.waitForTimeout(60);
const countIns = await page.locator('#list .list-item').count();
const stillConnected = await page.evaluate(h => h.isConnected, firstHandle);
ok('INSERT 증분 추가', countIns === 3, `count=${countIns}`);
ok('증분 갱신(기존 노드 보존)', stillConnected === true);
await page.evaluate(() => window.__matzip.onPlacesChange({ eventType:'UPDATE', new:{ id:'rt1', cat:'rice', name:'이름수정됨', menu:'테스트', comment:'', lat:37.55, lng:126.97, tags:[], added_by:'t' } }));
await page.waitForTimeout(40);
const updated = await page.evaluate(() => [...document.querySelectorAll('.item-name')].some(e => e.textContent === '이름수정됨'));
ok('UPDATE 증분 반영', updated);
await page.evaluate(() => window.__matzip.onPlacesChange({ eventType:'DELETE', old:{ id:'rt1' } }));
await page.waitForTimeout(40);
ok('DELETE 증분 제거', (await page.locator('#list .list-item').count()) === 2);

// F. 열린 인포윈도우가 실시간 갱신에도 유지 (버그 수정 검증)
await page.evaluate(() => window.openInfo('d1'));
await page.evaluate(() => window.__matzip.onPlacesChange({ eventType:'INSERT', new:{ id:'rt2', cat:'etc', name:'유지테스트', menu:'', comment:'', lat:37.56, lng:126.98, tags:[], added_by:'t' } }));
await page.waitForTimeout(60);
const keptOpen = await page.evaluate(() => window.__matzip.openPlaceId);
ok('실시간 INSERT에도 열린 인포윈도우 유지', keptOpen === 'd1', `openPlaceId=${keptOpen}`);
ok('선택 마커 강조 상태', (await page.evaluate(() => window.__matzip.activeMarkerId)) === 'd1');
await page.evaluate(() => window.__matzip.onPlacesChange({ eventType:'DELETE', old:{ id:'rt2' } }));
await page.waitForTimeout(40);

// G. 악성 id 주입 방어 (onclick 문자열 제거 + id 이스케이프)
await page.evaluate(() => window.__matzip.onPlacesChange({ eventType:'INSERT', new:{ id:`ev"il'<x>`, cat:'etc', name:'아이디공격', menu:'', comment:'', lat:37.57, lng:126.99, tags:[], added_by:'t' } }));
await page.waitForTimeout(60);
const evilHtml = await page.evaluate(() => {
  const p = window.__matzip.places.find(x => x.name === '아이디공격');
  return window.__matzip.buildIwContent(p);
});
ok('악성 id가 속성에서 이스케이프됨(onclick 미사용)',
  evilHtml.includes('data-id="ev&quot;il&#39;&lt;x&gt;"') && !evilHtml.includes('onclick="setRating'),
  evilHtml.match(/data-id="[^"]*"/)?.[0]);
await page.evaluate(() => window.__matzip.onPlacesChange({ eventType:'DELETE', old:{ id:`ev"il'<x>` } }));
await page.waitForTimeout(40);

// H. 이벤트 위임 (별점) + 찜
await page.evaluate(() => {
  const p = window.__matzip.places.find(x => x.id === 'd1');
  const div = document.createElement('div'); div.id = 'iw-test';
  div.innerHTML = window.__matzip.buildIwContent(p);
  document.body.appendChild(div);
});
await page.click('#iw-test [data-action="fav"]');
await page.waitForTimeout(60);
const favState = await page.evaluate(() => ({
  favs: window.__matzip.favs,
  badge: !!document.querySelector('#list .list-item[data-id="d1"] .item-fav'),
  ls: localStorage.getItem('matzip_favs')
}));
ok('찜 토글(저장+목록 뱃지)', favState.favs.includes('d1') && favState.badge, JSON.stringify(favState));
await page.click('#iw-test .star[data-n="4"]');
await page.waitForTimeout(120);
const starsOn = await page.evaluate(() => document.querySelectorAll('#iw-test #stars-d1 .star.on').length);
ok('이벤트 위임 별점 클릭(4점)', starsOn === 4, `on=${starsOn}`);

// IW 더보기(⋯) 토글
const moreHiddenBefore = await page.evaluate(() => document.querySelector('#iw-test .iw-more').style.display === 'none');
await page.click('#iw-test [data-action="more"]');
const moreShown = await page.evaluate(() => document.querySelector('#iw-test .iw-more').style.display === 'flex');
ok('IW 더보기(⋯)로 수정/삭제 노출', moreHiddenBefore && moreShown);
await page.evaluate(() => document.getElementById('iw-test').remove());

// 찜 필터 (필터바 칩)
await page.click('.tag-chip.fav');
const favVisible = await page.evaluate(() => [...document.querySelectorAll('#list .list-item')].filter(e => e.style.display !== 'none').length);
ok('찜만 보기 필터(필터바 칩)', favVisible === 1, `visible=${favVisible}`);
await page.click('.tag-chip.fav');

// I. 정렬 셀렉트 (가까운 순 = 위치 재조회)
await page.selectOption('#sort-select', 'dist');
await page.waitForFunction(() => document.querySelectorAll('#list .item-dist').length >= 2, null, { timeout: 6000 });
const firstId = await page.evaluate(() => document.querySelector('#list .list-item')?.dataset.id);
ok('가까운 순 정렬 + 거리 표시', firstId === 'd1', `first=${firstId}`);
await page.selectOption('#sort-select', 'rating');
await page.waitForTimeout(60);
const firstByRating = await page.evaluate(() => document.querySelector('#list .list-item')?.dataset.id);
ok('별점순 정렬', firstByRating === 'd1', `first=${firstByRating}`);
await page.selectOption('#sort-select', 'default');
await page.waitForTimeout(60);

// J. 삭제 커스텀 모달 (매장명 일치해야 삭제 버튼 활성)
await page.evaluate(() => window.deletePlace('x1'));
const delOpen = await page.evaluate(() => document.getElementById('del-overlay').classList.contains('open'));
await page.fill('#del-input', '틀린이름');
await page.waitForTimeout(50);
const delDisabled = await page.evaluate(() => document.getElementById('del-confirm').disabled);
await page.click('#del-overlay .btn-cancel');
ok('삭제 모달 가드(이름 불일치 시 비활성)', delOpen && delDisabled && (await page.locator('#list .list-item').count()) === 2);

// K. PWA
const manifestOk = await page.evaluate(async () => {
  const link = document.querySelector('link[rel="manifest"]');
  if (!link) return false;
  const r = await fetch(link.href);
  const j = await r.json();
  return r.ok && j.name && j.icons.length === 2;
});
ok('PWA manifest (SVG+PNG 아이콘)', manifestOk);
const pngOk = await page.evaluate(async () => (await fetch('icon-180.png')).ok);
ok('iOS용 icon-180.png 제공', pngOk);
await page.waitForTimeout(400);
const swReg = await page.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()));
ok('서비스워커 등록', swReg);

// L. 딥링크 (?place=d1) — 새 로드
await page.goto(`${BASE}/index.html?place=d1`, { waitUntil: 'load' });
await page.waitForFunction(() => document.querySelectorAll('#list .list-item').length >= 2, { timeout: 8000 });
await page.waitForTimeout(600);
const deepOpen = await page.evaluate(() => window.__matzip.openPlaceId);
ok('공유 딥링크로 인포윈도우 자동 열림', deepOpen === 'd1', `openPlaceId=${deepOpen}`);

// M. 모바일 바텀시트 + 자동 접기
await page.setViewportSize({ width: 390, height: 800 });
await page.waitForTimeout(150);
const mobile = await page.evaluate(() => {
  const sb = document.getElementById('sidebar');
  const cs = getComputedStyle(sb);
  return { display: cs.display, pos: cs.position, handle: getComputedStyle(document.querySelector('.sheet-handle')).display };
});
ok('모바일 사이드바=바텀시트', mobile.display !== 'none' && mobile.pos === 'absolute', JSON.stringify(mobile));
await page.click('.sheet-handle');
ok('바텀시트 펼치기 토글', await page.evaluate(() => document.getElementById('sidebar').classList.contains('expanded')));
await page.evaluate(() => window.openInfo('x1'));
await page.waitForTimeout(500);   // 고스트 클릭 방지용 250ms 지연 후 접힘
const collapsed = await page.evaluate(() => !document.getElementById('sidebar').classList.contains('expanded'));
const stillOpen = await page.evaluate(() => window.__matzip.openPlaceId);
ok('인포윈도우 열면 시트 자동 접기(지연) + 팝업 유지', collapsed && stillOpen === 'x1', `open=${stillOpen}`);

// 모바일 검색 시 시트 반열림
await page.evaluate(() => document.getElementById('sidebar').classList.remove('expanded', 'half'));
await page.fill('#search-input', '후암');
const halfOpened = await page.evaluate(() => document.getElementById('sidebar').classList.contains('half'));
ok('모바일 검색 시 시트 반열림', halfOpened);
await page.fill('#search-input', '');
await page.waitForTimeout(200);

// N. 접근성 스팟체크
const a11y = await page.evaluate(() => ({
  theme: !!document.getElementById('theme-btn')?.getAttribute('aria-label'),
  search: !!document.getElementById('search-input')?.getAttribute('aria-label'),
  star: window.__matzip.buildIwContent(window.__matzip.places[0]).includes('role="button"')
}));
ok('접근성(aria-label/키보드 별점)', a11y.theme && a11y.search && a11y.star, JSON.stringify(a11y));

// O-0. 인포윈도우 요소 직접 바인딩 (네이버 지도 전파 차단 대응) — 정확히 1회만 실행돼야 함
const directBind = await page.evaluate(() => {
  const p = window.__matzip.places.find(x => x.id === 'x1');
  const el = window.__matzip.buildIwElement(p);
  // 전파가 차단된 환경 시뮬레이션: 부모에서 stopPropagation
  const wrap = document.createElement('div');
  wrap.id = 'iw-direct';
  wrap.addEventListener('click', e => e.stopPropagation());  // naver 지도처럼 document 도달 차단
  wrap.appendChild(el);
  document.body.appendChild(wrap);
  el.querySelector('[data-action="fav"]').click();
  const after = window.__matzip.favs.includes('x1');   // 2번 실행되면 토글 2회 → false
  wrap.remove();
  return after;
});
ok('IW 직접 바인딩: 전파 차단 환경에서도 동작 + 중복 실행 없음', directBind === true);

// O. 업데이트 알림 배너
const updateFlow = await page.evaluate(() => {
  let sent = null;
  window.__matzip.showUpdateBanner({ postMessage: m => { sent = m; } });
  const shown = document.getElementById('update-banner').classList.contains('show');
  window.applyUpdate();
  const hidden = !document.getElementById('update-banner').classList.contains('show');
  return { shown, hidden, sent };
});
ok('업데이트 배너 표시→승인→SKIP_WAITING 전송',
  updateFlow.shown && updateFlow.hidden && updateFlow.sent?.type === 'SKIP_WAITING',
  JSON.stringify(updateFlow.sent));
const swSrc = await page.evaluate(async () => (await (await fetch('sw.js')).text()));
ok('sw.js: 수동 승인 방식(SKIP_WAITING 리스너, 자동 skipWaiting 제거)',
  swSrc.includes("SKIP_WAITING") && swSrc.includes('registration.active'));

// P. 설명 문구 변경
const label = await page.evaluate(() => document.getElementById('count-label').textContent);
ok('설명 문구 "서울 맛집 지도"로 변경', label.startsWith('서울 맛집 지도'), label);

// Q. 고정 위치
const seeded = await page.evaluate(() => window.__matzip.fixedList.map(f => f.name));
ok('고정 위치 기본 시드(OYC·WST)', seeded.length === 2 && seeded.some(n => n.includes('OYC')) && seeded.some(n => n.includes('WST')), JSON.stringify(seeded));

await page.click('#fixed-fab');
const panelOpen = await page.evaluate(() => document.getElementById('fixed-panel').classList.contains('open'));
const rows = await page.locator('#fixed-list .fixed-item').count();
ok('고정 패널 열기 + 목록 렌더', panelOpen && rows === 2, `rows=${rows}`);

// 빠른 이동 (에러 없이 실행)
await page.click('#fixed-list .fixed-jump[data-fid="f-oyc"]');
ok('고정 위치 클릭 → 이동 실행', true);

// 추가 플로우
await page.click('#fixed-fab');   // 다시 열기(이동 시 모바일 아니면 유지되지만 안전하게)
await page.evaluate(() => window.toggleFixedPanel(true));
await page.click('#fixed-add-btn');
await page.fill('#fixed-name', '테스트장소');
await page.click('.fixed-save');
const inPickMode = await page.evaluate(() => document.getElementById('center-cross').classList.contains('show'));
await page.click('#fixed-banner button');   // 저장
const afterAdd = await page.evaluate(() => window.__matzip.fixedList.length);
ok('고정 위치 추가(십자선→저장)', inPickMode && afterAdd === 3, `len=${afterAdd}`);

// 삭제 (2탭 확인)
await page.evaluate(() => window.toggleFixedPanel(true));
const newFid = await page.evaluate(() => window.__matzip.fixedList.find(f => f.name === '테스트장소').id);
const delSel = `#fixed-list .fixed-del[data-fid="${newFid}"]`;
await page.click(delSel);
const armed = await page.$eval(delSel, b => b.dataset.armed === '1');
await page.click(delSel);
await page.waitForTimeout(50);
const afterDel = await page.evaluate(() => window.__matzip.fixedList.length);
ok('고정 위치 삭제(2탭 확인)', armed && afterDel === 2, `len=${afterDel}`);

// 영속성 (localStorage)
const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('matzip_fixed')).length);
ok('고정 위치 localStorage 저장', persisted === 2, `stored=${persisted}`);

// R. 성능/구조 검증
const struct = await page.evaluate(async () => ({
  naverDefer: !!document.querySelector('script[src*="oapi.map.naver.com"][defer]'),
  fontLink: !!document.querySelector('link[href*="fonts.googleapis.com/css2"]'),
  cssOk: (await fetch('styles.css')).ok,
  jsOk: (await fetch('app.js')).ok,
  swHasAssets: (await (await fetch('sw.js')).text()).includes("'./app.js'")
}));
ok('구조 분리(styles.css/app.js) + defer + 폰트 link', Object.values(struct).every(Boolean), JSON.stringify(struct));

const cacheSaved = await page.evaluate(() => { const c = JSON.parse(localStorage.getItem('matzip_cache')||'null'); return !!(c && c.places && c.places.length >= 2); });
ok('places 로컬 캐시(SWR) 저장', cacheSaved);

await page.evaluate(() => { window.__mk = window.__matzip.markerMap['d1'].marker; });
await page.selectOption('#sort-select', 'name');
await page.waitForTimeout(60);
const sameMarker = await page.evaluate(() => window.__matzip.markerMap['d1'].marker === window.__mk);
ok('정렬 변경 시 마커 재사용(재생성 X)', sameMarker === true);
await page.selectOption('#sort-select', 'new');
await page.waitForTimeout(60);
const newFirst = await page.evaluate(() => document.querySelector('#list .list-item')?.dataset.id);
ok('최신 등록순 정렬', newFirst === 'x1', `first=${newFirst}`);
await page.selectOption('#sort-select', 'default');
await page.waitForTimeout(60);

await page.evaluate(() => window.dismissUpdate());   // 혹시 떠 있는 배너 정리
// T. 최근 본 맛집
await page.evaluate(() => window.openInfo('d1'));
await page.waitForTimeout(80);
const recentState = await page.evaluate(() => ({
  shown: document.getElementById('recent-strip').style.display !== 'none',
  first: document.querySelector('#recent-chips .recent-chip')?.dataset.rid
}));
ok('최근 본 맛집 스트립', recentState.shown && recentState.first === 'd1', JSON.stringify(recentState));

// U. 내보내기 / 가져오기
const [download] = await Promise.all([
  page.waitForEvent('download'),
  page.evaluate(() => window.exportData())
]);
ok('데이터 내보내기(다운로드)', download.suggestedFilename().startsWith('matzip-backup-'), download.suggestedFilename());
await page.setInputFiles('#import-file', {
  name: 'backup.json', mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify({ favs: ['x1'], fixed: [] }))
});
await page.waitForTimeout(150);
const imported = await page.evaluate(() => window.__matzip.favs);
ok('개인 데이터 가져오기(찜 복원)', imported.includes('x1') && !imported.includes('d1'), JSON.stringify(imported));

// V. 위성 토글 + 단축키
await page.evaluate(() => window.toggleMapType());
ok('위성 지도 토글(설정 저장)', (await page.evaluate(() => localStorage.getItem('matzip_maptype'))) === 'sat');
await page.evaluate(() => window.toggleMapType());
await page.keyboard.press('r');
await page.waitForTimeout(100);
const recOpened = await page.evaluate(() => document.getElementById('rec-overlay').classList.contains('open'));
await page.keyboard.press('Escape');
await page.waitForTimeout(60);
const recClosed = await page.evaluate(() => !document.getElementById('rec-overlay').classList.contains('open'));
await page.keyboard.press('/');
const searchFocused = await page.evaluate(() => document.activeElement === document.getElementById('search-input'));
ok("단축키 R(룰렛)/Esc(닫기)/'/'(검색)", recOpened && recClosed && searchFocused, JSON.stringify({recOpened, recClosed, searchFocused}));
await page.evaluate(() => document.activeElement.blur());

ok('JS 런타임 에러 없음', pageErrors.length === 0, pageErrors.join(' | ').slice(0,200));

await browser.close();
server.close();

let pass = 0;
console.log('\n==== 테스트 결과 ====');
for (const [c, n] of results) { console.log(`${c ? '✅' : '❌'} ${n}`); if (c) pass++; }
console.log(`\n${pass}/${results.length} 통과`);
process.exit(pass === results.length ? 0 : 1);
