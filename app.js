import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// ─────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────
const SUPABASE_URL = 'https://kvxprsqdqiazxpcdhfiu.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt2eHByc3FkcWlhenhwY2RoZml1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3NzA2MzQsImV4cCI6MjA5NzM0NjYzNH0.1FYKu070t22fYIzJa_nx3oFrSugGiOu_VEWSOpvWpFY';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─────────────────────────────────────────────
// 태그 시스템
// ─────────────────────────────────────────────
const TAGS = [
  { id: 'waiting',  label: '⏳ 웨이팅 있음' },
  { id: 'solo',     label: '🙋 혼밥 가능'   },
  { id: 'cheap',    label: '💸 가성비'       },
  { id: 'spicy',    label: '🌶 매운맛'       },
  { id: 'takeout',  label: '🥡 포장 가능'   },
  { id: 'open24',   label: '🕛 24시 영업'   },
];
const TAG_LABEL = Object.fromEntries(TAGS.map(t => [t.id, t.label]));

// ─────────────────────────────────────────────
// 기본 데이터 (Supabase 로드 실패 시 폴백)
// ─────────────────────────────────────────────
const DEFAULT_PLACES = [
  { id:'d1', cat:'noodle', name:'후암 쌀국수 (아시안)', menu:'소고기 쌀국수 9,500원', comment:'후암동 / 완자도 넣어줌 맛있음 / 매운 쌀국수 9,500원', lat:37.5484953, lng:126.9759131, tags:[], added_by:'기본데이터' },
];

// ─────────────────────────────────────────────
// 상태
// ─────────────────────────────────────────────
let places = [];
let summaries = {};     // place_id → { average, count }
let myRatings = {};     // place_id → score
let currentUserId = null;
let nickname = localStorage.getItem('matzip_nickname') || '';
let readOnly = false;

let activeFilter = 'all';
let activeTagFilter = null;
let openIW = null;
let openPlaceId = null;
let activeListItem = null;
const markerMap = {};    // id → { marker, iw }
const listItemMap = {};  // id → element

let myLoc = null;          // { lat, lng }
let sortMode = 'default';  // default | dist | rating | name
let favs = new Set((() => { try { return JSON.parse(localStorage.getItem('matzip_favs') || '[]'); } catch { return []; } })());
let favOnly = false;
let recent = (() => { try { return JSON.parse(localStorage.getItem('matzip_recent')) || []; } catch { return []; } })();
let lastRecCat = 'all';

// ─────────────────────────────────────────────
// 공용 헬퍼
// ─────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}
function avgStars(avg) {
  const n = Math.round(avg || 0);
  return '★'.repeat(n) + '☆'.repeat(5 - n);
}
function catEmoji(cat) { return cat === 'noodle' ? '🍜' : cat === 'rice' ? '🍚' : '🎪'; }
function catColor(cat) { return cat === 'noodle' ? '#e85d26' : cat === 'rice' ? '#2c7a4b' : '#7b5ea7'; }
function catLabel(cat) { return cat === 'noodle' ? '면류' : cat === 'rice' ? '밥류+a' : '기타'; }

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, toR = x => x * Math.PI / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toR(lat1))*Math.cos(toR(lat2))*Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function fmtDist(m) { return m >= 1000 ? (m/1000).toFixed(1) + 'km' : Math.round(m) + 'm'; }
function computeDistances() {
  if (!myLoc) return;
  places.forEach(p => { p._dist = haversine(myLoc.lat, myLoc.lng, p.lat, p.lng); });
}

function sortedPlaces() {
  const arr = [...places];
  if (sortMode === 'dist' && myLoc) arr.sort((a, b) => (a._dist ?? 1e12) - (b._dist ?? 1e12));
  else if (sortMode === 'rating') arr.sort((a, b) => {
    const sa = summaries[a.id], sb = summaries[b.id];
    return ((sb?.average) || 0) - ((sa?.average) || 0) || ((sb?.count) || 0) - ((sa?.count) || 0);
  });
  else if (sortMode === 'new') arr.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  else if (sortMode === 'name') arr.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return arr;
}

// 목록 아이템 내용만 갱신 (마커는 건드리지 않음 — 정렬/뱃지 변경용)
function refreshListItems() {
  places.forEach(p => { const it = listItemMap[p.id]; if (it) it.innerHTML = listItemInner(p); });
}

// 증분 추가/수정 후 현재 정렬 기준대로 목록 DOM 재배치
function resortList() {
  const listEl = document.getElementById('list');
  sortedPlaces().forEach(p => { const it = listItemMap[p.id]; if (it) listEl.appendChild(it); });
}

// ─────────────────────────────────────────────
// 지도 초기화
// ─────────────────────────────────────────────
const map = new naver.maps.Map('map', {
  center: new naver.maps.LatLng(37.5545, 126.9730),
  zoom: 15,
  mapTypeId: naver.maps.MapTypeId.NORMAL
});

// 모바일에서 시트가 접히는 순간 발생하는 고스트 클릭이 인포윈도우를 닫지 않도록 잠시 무시
let suppressMapClickUntil = 0;

naver.maps.Event.addListener(map, 'click', () => {
  if (Date.now() < suppressMapClickUntil) return;
  if (fixedPickMode) return;
  if (!movingId && !isDraggingNew) {
    if (openIW) { openIW.close(); openIW = null; openPlaceId = null; }
    if (activeListItem) { activeListItem.classList.remove('active'); activeListItem = null; }
    clearActiveMarker();
  }
});

// ─────────────────────────────────────────────
// 토스트
// ─────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ─────────────────────────────────────────────
// 인포윈도우 컨텐츠
// ─────────────────────────────────────────────
function buildIwContent(p) {
  const naverSearchUrl = `https://map.naver.com/v5/search/${encodeURIComponent(p.name)}`;
  const sum = summaries[p.id];
  const avg = sum ? sum.average : 0;
  const cnt = sum ? sum.count : 0;
  const mine = myRatings[p.id] || 0;

  // id도 속성에 들어가므로 반드시 이스케이프 (onclick 문자열 주입 방지 → 이벤트 위임 사용)
  const pid = esc(p.id);
  const myStars = [1,2,3,4,5].map(n =>
    `<span class="star ${n<=mine?'on':''}" data-id="${pid}" data-n="${n}" role="button" tabindex="0" aria-label="${n}점 주기">★</span>`
  ).join('');

  const tagBadges = (p.tags && p.tags.length)
    ? `<div class="iw-tags">${p.tags.map(t => `<span class="iw-tag">${esc(TAG_LABEL[t] || t)}</span>`).join('')}</div>`
    : '';

  return `
    <div class="iw">
      <div class="iw-title-row">
        <a class="iw-name" href="${naverSearchUrl}" target="_blank" rel="noopener">${esc(p.name)}</a>
        <a href="${naverSearchUrl}" target="_blank" rel="noopener" class="iw-naver-badge">네이버지도</a>
      </div>
      <div class="iw-avg">
        <span class="iw-avg-stars">${avgStars(avg)}</span>
        <span class="iw-avg-label">${cnt > 0 ? `${avg}점 (${cnt}명)` : '평가 없음'}</span>
      </div>
      <div class="iw-myrate">
        <span class="iw-myrate-label">내 평가:</span>
        <div class="star-row" id="stars-${pid}">${myStars}</div>
      </div>
      <div class="iw-menu">${esc(p.menu || '')}</div>
      ${tagBadges}
      ${p.comment ? `<div class="iw-comment">💬 ${esc(p.comment)}</div>` : ''}
      <div class="iw-author">추가한 사람: ${esc(p.added_by || '익명')}</div>
      <div class="iw-actions">
        <button class="iw-sub-btn" data-action="nav" data-id="${pid}">🧭 길찾기</button>
        <button class="iw-sub-btn" data-action="share" data-id="${pid}">🔗 공유</button>
        <button class="iw-sub-btn ${favs.has(p.id)?'fav-on':''}" data-action="fav" data-id="${pid}" aria-label="찜 토글" style="flex:0 0 40px;">${favs.has(p.id)?'❤️':'🤍'}</button>
        <button class="iw-sub-btn" data-action="more" data-id="${pid}" aria-label="더보기" style="flex:0 0 34px;">⋯</button>
      </div>
      <div class="iw-actions iw-more" style="display:none;border-top:none;padding-top:0;">
        <button class="iw-move-btn" data-action="move" data-id="${pid}">📍 위치 수정</button>
        <button class="iw-del-btn" data-action="del" data-id="${pid}">🗑 삭제</button>
      </div>
    </div>`;
}

function markerIcon(p) {
  return {
    content: `<div style="width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.25);cursor:pointer;background:${catColor(p.cat)}">${catEmoji(p.cat)}</div>`,
    anchor: new naver.maps.Point(15, 30)
  };
}

function listItemInner(p) {
  const sum = summaries[p.id];
  const tagBadgesHtml = (p.tags || []).slice(0,3)
    .map(t => `<span class="item-tagbadge">${esc(TAG_LABEL[t] || t)}</span>`).join('');
  const distHtml = (myLoc && p._dist != null) ? `<span class="item-dist">${fmtDist(p._dist)}</span>` : '';
  return `
    <div class="dot ${p.cat}"></div>
    <div class="item-info">
      <div class="item-name">${esc(p.name)}</div>
      <div class="item-menu">${esc(p.menu || '')}</div>
      <div class="item-meta">
        <span class="item-tag ${p.cat}">${catLabel(p.cat)}</span>
        ${favs.has(p.id) ? '<span class="item-fav">❤️</span>' : ''}
        ${sum && sum.count>0 ? `<span class="item-stars">${avgStars(sum.average)}</span><span class="item-tagbadge">${sum.average}</span>` : ''}
        ${distHtml}
        ${tagBadgesHtml}
      </div>
    </div>`;
}

// ─────────────────────────────────────────────
// 마커/리스트 — 증분 단위 조작
// ─────────────────────────────────────────────
function addPlaceToUI(p) {
  const marker = new naver.maps.Marker({
    position: new naver.maps.LatLng(p.lat, p.lng),
    map, icon: markerIcon(p), title: p.name
  });
  const iw = new naver.maps.InfoWindow({
    content: buildIwElement(p),
    borderWidth: 0, backgroundColor: 'transparent',
    anchorSize: new naver.maps.Size(0,0),
    pixelOffset: new naver.maps.Point(0, -36)
  });
  naver.maps.Event.addListener(marker, 'click', () => openInfo(p.id));
  markerMap[p.id] = { marker, iw };

  const item = document.createElement('div');
  item.className = 'list-item';
  item.dataset.id = p.id;
  item.innerHTML = listItemInner(p);
  item.onclick = () => openInfo(p.id);
  document.getElementById('list').appendChild(item);
  listItemMap[p.id] = item;
}

function updatePlaceUI(p) {
  const entry = markerMap[p.id];
  if (!entry) { addPlaceToUI(p); return; }
  entry.marker.setPosition(new naver.maps.LatLng(p.lat, p.lng));
  entry.marker.setIcon(markerIcon(p));
  entry.marker.setTitle(p.name);
  entry.iw.setContent(buildIwElement(p));
  if (openPlaceId === p.id) entry.iw.open(map, entry.marker);
  const item = listItemMap[p.id];
  if (item) item.innerHTML = listItemInner(p);
}

function removePlaceFromUI(id) {
  const entry = markerMap[id];
  if (entry) { entry.iw.close(); entry.marker.setMap(null); delete markerMap[id]; }
  const item = listItemMap[id];
  if (item) { item.remove(); delete listItemMap[id]; }
  if (openPlaceId === id) { openIW = null; openPlaceId = null; }
  if (activeMarkerId === id) activeMarkerId = null;
}

function renderAll() {
  Object.values(markerMap).forEach(({ marker, iw }) => { iw.close(); marker.setMap(null); });
  for (const k in markerMap) delete markerMap[k];
  activeMarkerId = null;   // 마커 재생성 → openInfo 재호출 시 다시 강조
  for (const k in listItemMap) delete listItemMap[k];
  document.getElementById('list').innerHTML = '';

  if (myLoc) computeDistances();
  sortedPlaces().forEach(addPlaceToUI);

  applyFilter();
  renderRecent();
  if (openPlaceId && markerMap[openPlaceId]) openInfo(openPlaceId);
}

function updateCountLabel(visible) {
  if (visible == null) {   // applyFilter가 넘겨주면 재계산 생략
    visible = 0;
    const query = document.getElementById('search-input').value.trim().toLowerCase();
    places.forEach(p => { if (matchesFilter(p, query)) visible++; });
  }
  document.getElementById('count-label').textContent =
    `서울 맛집 지도 · ${visible}곳`;
}

// ─────────────────────────────────────────────
// 인포윈도우 열기
// ─────────────────────────────────────────────
// 선택된 마커 강조
let activeMarkerId = null;
function setMarkerActive(id, on) {
  const entry = markerMap[id];
  if (!entry) return;
  const el = entry.marker.getElement();
  if (el) {
    el.style.transition = 'transform .15s';
    el.style.transform = on ? 'scale(1.25)' : '';
    el.style.filter = on ? 'drop-shadow(0 3px 8px rgba(0,0,0,.45))' : '';
  }
  if (entry.marker.setZIndex) entry.marker.setZIndex(on ? 300 : 100);
}
function clearActiveMarker() {
  if (activeMarkerId) { setMarkerActive(activeMarkerId, false); activeMarkerId = null; }
}

// 모바일에선 시트에 가리지 않도록 마커를 화면 중앙보다 약간 위로 팬
function panToPlace(pos) {
  const mobile = window.matchMedia('(max-width: 640px)').matches;
  try {
    const proj = map.getProjection();
    if (mobile && proj && proj.fromCoordToOffset && proj.fromOffsetToCoord) {
      const off = proj.fromCoordToOffset(pos);
      off.y += 48;
      map.panTo(proj.fromOffsetToCoord(off));
      return;
    }
  } catch (e) {}
  map.panTo(pos);
}

function openInfo(id) {
  if (openIW) openIW.close();
  if (activeListItem) activeListItem.classList.remove('active');
  clearActiveMarker();

  const entry = markerMap[id];
  if (!entry) return;
  const { marker, iw } = entry;
  iw.open(map, marker);
  openIW = iw;
  openPlaceId = id;
  setMarkerActive(id, true);
  activeMarkerId = id;
  panToPlace(marker.getPosition());

  const mobile = window.matchMedia('(max-width: 640px)').matches;
  const item = listItemMap[id];
  if (item) {
    item.classList.add('active');
    if (!mobile) item.scrollIntoView({ block:'nearest' });   // 모바일에선 시트가 접히므로 스크롤 불필요(버벅임 방지)
    activeListItem = item;
  }

  // 모바일 한정: 시트가 접히며 새는 고스트 클릭 차단 (데스크톱은 즉시 닫기 가능해야 함)
  if (mobile) {
    suppressMapClickUntil = Date.now() + 700;
    // 탭 이벤트가 완전히 끝난 뒤 시트를 접어야 클릭이 지도로 새지 않음
    setTimeout(() => document.getElementById('sidebar').classList.remove('expanded', 'half'), 250);
  }

  pushRecent(id);
}

// ─────────────────────────────────────────────
// 별점 (멀티유저 평균)
// ─────────────────────────────────────────────
async function setRating(id, n) {
  if (readOnly) { toast('별점은 로그인(익명) 활성화 후 가능해요'); return; }
  myRatings[id] = n;
  const starsEl = document.getElementById(`stars-${id}`);
  if (starsEl) starsEl.querySelectorAll('.star').forEach(s => s.classList.toggle('on', parseInt(s.dataset.n) <= n));

  const { error } = await supabase.from('ratings').upsert(
    { place_id: id, user_id: currentUserId, score: n },
    { onConflict: 'place_id,user_id' }
  );
  if (error) { toast('별점 저장 실패'); console.error(error); return; }

  const { data } = await supabase.from('rating_summary')
    .select('average, count').eq('place_id', id).maybeSingle();
  summaries[id] = data ? { average: Number(data.average), count: data.count } : { average: n, count: 1 };
  refreshRatingUI(id);
  toast('별점 저장됨 ⭐');
}

function refreshRatingUI(id) {
  const entry = markerMap[id];
  const p = places.find(x => x.id === id);
  if (entry && p) {
    entry.iw.setContent(buildIwElement(p));
    if (openPlaceId === id) entry.iw.open(map, entry.marker);
  }
  const item = listItemMap[id];
  const meta = item && item.querySelector('.item-meta');
  const sum = summaries[id];
  if (meta) {
    const existing = meta.querySelector('.item-stars');
    if (sum && sum.count > 0) {
      const html = `<span class="item-stars">${avgStars(sum.average)}</span>`;
      if (existing) existing.outerHTML = html;
      else meta.insertAdjacentHTML('afterbegin', html);
    } else if (existing) existing.remove();
  }
}

// ─────────────────────────────────────────────
// 삭제
// ─────────────────────────────────────────────
let pendingDeleteId = null;

function deletePlace(id) {
  if (readOnly) { toast('삭제는 로그인(익명) 활성화 후 가능해요'); return; }
  const p = places.find(x => x.id === id);
  if (!p) return;
  pendingDeleteId = id;
  document.getElementById('del-name').textContent = p.name;
  const input = document.getElementById('del-input');
  input.value = '';
  onDelInput();
  document.getElementById('del-overlay').classList.add('open');
  setTimeout(() => input.focus(), 100);
}

function onDelInput() {
  const p = places.find(x => x.id === pendingDeleteId);
  const match = !!p && document.getElementById('del-input').value.trim() === p.name;
  const b = document.getElementById('del-confirm');
  b.disabled = !match;
  b.style.opacity = match ? '1' : '.4';
}

function cancelDelete() {
  pendingDeleteId = null;
  document.getElementById('del-overlay').classList.remove('open');
}

async function confirmDelete() {
  const id = pendingDeleteId;
  if (!id) return;
  cancelDelete();
  const { error } = await supabase.from('places').delete().eq('id', id);
  if (error) { toast('삭제 실패'); console.error(error); return; }
  places = places.filter(p => p.id !== id);
  removePlaceFromUI(id);
  applyFilter();
  toast('삭제됨');
}

// ─────────────────────────────────────────────
// 위치 수정 (드래그)
// ─────────────────────────────────────────────
let movingId = null;

function startMovePlace(id) {
  if (readOnly) { toast('위치 수정은 로그인(익명) 활성화 후 가능해요'); return; }
  if (openIW) { openIW.close(); openIW = null; openPlaceId = null; }
  clearActiveMarker();
  movingId = id;
  const place = places.find(p => p.id === id);
  if (!place) return;
  const { marker } = markerMap[id];

  marker.setDraggable(true);
  marker.setCursor('grab');
  const el = marker.getElement();
  if (el) { el.style.filter = 'drop-shadow(0 0 8px #2563eb)'; el.style.transform = 'scale(1.3)'; el.style.transition = 'transform .15s'; }

  document.getElementById('pick-banner-text').textContent =
    `📍 [${place.name}] 핀을 드래그해서 새 위치로 이동하세요`;
  document.getElementById('pick-confirm-btn').textContent = '✅ 저장';
  document.getElementById('pick-banner').classList.add('show');
}

async function confirmDrag() {
  if (movingId) {
    const { marker } = markerMap[movingId];
    const pos = marker.getPosition();
    const place = places.find(p => p.id === movingId);
    const savedId = movingId;
    if (place) {
      place.lat = pos.lat();
      place.lng = pos.lng();
      const { error } = await supabase.from('places')
        .update({ lat: place.lat, lng: place.lng }).eq('id', savedId);
      if (error) { toast('위치 저장 실패'); console.error(error); }
      else toast('위치 저장됨 📍');
    }
    stopMove();
    if (place) updatePlaceUI(place);
    applyFilter();
    setTimeout(() => { if (savedId) openInfo(savedId); }, 200);
  } else if (isDraggingNew) {
    const pos = tempDragMarker.getPosition();
    pickedLat = pos.lat();
    pickedLng = pos.lng();
    stopAddDrag();
    document.getElementById('modal-overlay').classList.add('open');
    document.getElementById('pick-hint').textContent = `📍 ${pickedLat.toFixed(6)}, ${pickedLng.toFixed(6)}`;
    document.getElementById('pick-btn').textContent = '✅ 위치 재조정';
    document.getElementById('pick-btn').classList.remove('picking');
  }
}

function cancelDrag() {
  if (movingId) {
    const place = places.find(p => p.id === movingId);
    if (place) markerMap[movingId].marker.setPosition(new naver.maps.LatLng(place.lat, place.lng));
    stopMove();
    applyFilter();
  } else if (isDraggingNew) {
    stopAddDrag();
    document.getElementById('modal-overlay').classList.add('open');
  }
}

function stopMove() {
  if (movingId && markerMap[movingId]) {
    const { marker } = markerMap[movingId];
    marker.setDraggable(false);
    marker.setCursor('pointer');
    const el = marker.getElement();
    if (el) { el.style.filter = ''; el.style.transform = ''; }
  }
  movingId = null;
  document.getElementById('pick-banner').classList.remove('show');
}

// ─────────────────────────────────────────────
// 필터 + 검색 + 태그
// ─────────────────────────────────────────────
function matchesFilter(p, query) {
  const matchCat  = activeFilter === 'all' || p.cat === activeFilter;
  const matchTag  = !activeTagFilter || (p.tags || []).includes(activeTagFilter);
  const matchFav  = !favOnly || favs.has(p.id);
  const matchName = !query
    || p.name.toLowerCase().includes(query)
    || (p.menu || '').toLowerCase().includes(query)
    || (p.comment || '').toLowerCase().includes(query)
    || (p.tags || []).some(t => (TAG_LABEL[t] || t).toLowerCase().includes(query));
  return matchCat && matchTag && matchFav && matchName;
}

function filterMarkers(cat) {
  activeFilter = cat;
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.classList.contains(cat) || (cat==='all' && b.classList.contains('all')));
  });
  applyFilter();
}

function filterByTag(tagId) {
  activeTagFilter = (activeTagFilter === tagId) ? null : tagId;
  renderTagFilters();
  applyFilter();
}

let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilter, 150);
  // 모바일: 검색하면 결과 목록이 보이도록 시트를 반쯤 열기
  if (window.matchMedia('(max-width: 640px)').matches) {
    const sb = document.getElementById('sidebar');
    const q = document.getElementById('search-input').value.trim();
    if (q && !sb.classList.contains('expanded') && !sb.classList.contains('half')) sb.classList.add('half');
  }
}

function applyFilter() {
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  let visibleCount = 0;
  places.forEach(p => {
    const show = matchesFilter(p, query);
    if (show) visibleCount++;
    markerMap[p.id]?.marker.setVisible(show);
    const item = listItemMap[p.id];
    if (item) item.style.display = show ? '' : 'none';
  });
  // 결과 없음 안내
  document.getElementById('empty-state').style.display =
    (visibleCount === 0 && places.length > 0) ? '' : 'none';
  // 열린 인포윈도우는 필터 결과에서 빠졌을 때만 닫음 (실시간 갱신 등으로 닫히지 않게)
  if (openPlaceId) {
    const op = places.find(x => x.id === openPlaceId);
    if (!op || !matchesFilter(op, query)) {
      if (openIW) openIW.close();
      openIW = null; openPlaceId = null;
      clearActiveMarker();
    }
  }
  updateCountLabel(visibleCount);
}

function resetFilters() {
  activeTagFilter = null;
  favOnly = false;
  document.getElementById('search-input').value = '';
  renderTagFilters();
  filterMarkers('all');   // applyFilter 포함
}

function renderTagFilters() {
  const wrap = document.getElementById('tag-filters');
  wrap.innerHTML =
    `<button class="tag-chip fav ${favOnly?'active':''}" onclick="toggleFavFilter()" aria-label="찜한 곳만 보기">❤️ 찜</button>` +
    TAGS.map(t =>
      `<button class="tag-chip ${activeTagFilter===t.id?'active':''}" onclick="filterByTag('${t.id}')">${t.label}</button>`
    ).join('');
}

// ─────────────────────────────────────────────
// 내 위치 / 정렬
// ─────────────────────────────────────────────
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('no-geo'));
    navigator.geolocation.getCurrentPosition(
      pos => { myLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude }; computeDistances(); resolve(myLoc); },
      err => reject(err),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  });
}
function ensureMyLocation() { return myLoc ? Promise.resolve(myLoc) : getLocation(); }

async function onSortChange(mode) {
  if (mode === 'dist') {
    toast('위치 확인 중…');
    try { await getLocation(); }   // 토글할 때마다 최신 위치로 갱신
    catch { toast('위치 권한이 필요해요'); document.getElementById('sort-select').value = sortMode; return; }
  }
  sortMode = mode;
  // 정렬은 목록 순서만 바꾸면 됨 — 마커 61개 재생성은 낭비
  refreshListItems();
  resortList();
  if (mode === 'dist') toast('가까운 순으로 정렬됨 📍');
}

// ─────────────────────────────────────────────
// 추가 모달
// ─────────────────────────────────────────────
let isDraggingNew = false;
let tempDragMarker = null;
let pickedLat = null, pickedLng = null;
let selectedTags = [];

function renderTagToggles() {
  const wrap = document.getElementById('f-tags');
  wrap.innerHTML = TAGS.map(t =>
    `<button type="button" class="tag-toggle ${selectedTags.includes(t.id)?'on':''}" data-tag="${t.id}" onclick="toggleTag('${t.id}')">${t.label}</button>`
  ).join('');
}

function toggleTag(tagId) {
  if (selectedTags.includes(tagId)) selectedTags = selectedTags.filter(t => t !== tagId);
  else selectedTags.push(tagId);
  renderTagToggles();
}

function setAddStep(step) {
  document.getElementById('add-step1').style.display = step === 1 ? '' : 'none';
  document.getElementById('add-step2').style.display = step === 2 ? '' : 'none';
  document.getElementById('add-step-badge').textContent = step + '/2';
}

function nextAddStep() {
  if (!document.getElementById('f-name').value.trim()) { alert('매장명을 입력해주세요.'); return; }
  setAddStep(2);
}

function prevAddStep() { setAddStep(1); }

function openAddModal() {
  selectedTags = [];
  renderTagToggles();
  setAddStep(1);
  document.getElementById('modal-overlay').classList.add('open');
}

function closeAddModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  stopAddDrag();
  document.getElementById('f-name').value = '';
  document.getElementById('f-menu').value = '';
  document.getElementById('f-comment').value = '';
  selectedTags = [];
  pickedLat = null; pickedLng = null;
  document.getElementById('pick-hint').textContent = '버튼을 누르면 지도에 드래그 핀이 생깁니다';
  document.getElementById('pick-btn').textContent = '🗺 핀 드래그로 위치 선택';
  document.getElementById('pick-btn').classList.remove('picking');
  setAddStep(1);
}

function startPicking() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.getElementById('pick-btn').classList.add('picking');
  isDraggingNew = true;
  const center = map.getCenter();
  if (tempDragMarker) tempDragMarker.setMap(null);

  tempDragMarker = new naver.maps.Marker({
    position: center, map, draggable: true, cursor: 'grab',
    icon: {
      content: `<div style="width:36px;height:36px;border-radius:50%;background:#2563eb;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:0 0 0 4px rgba(37,99,235,.3),0 4px 12px rgba(0,0,0,.3);cursor:grab;transition:transform .1s;">📍</div>`,
      anchor: new naver.maps.Point(18, 18)
    }
  });

  naver.maps.Event.addListener(tempDragMarker, 'dragstart', () => { tempDragMarker.getElement().style.transform = 'scale(1.15)'; });
  naver.maps.Event.addListener(tempDragMarker, 'dragend', () => {
    tempDragMarker.getElement().style.transform = '';
    const pos = tempDragMarker.getPosition();
    document.getElementById('pick-hint').textContent = `📍 ${pos.lat().toFixed(6)}, ${pos.lng().toFixed(6)}`;
  });

  document.getElementById('pick-banner-text').textContent = '📍 파란 핀을 드래그해서 위치를 조정하세요';
  document.getElementById('pick-confirm-btn').textContent = '✅ 확인';
  document.getElementById('pick-banner').classList.add('show');
}

function stopAddDrag() {
  isDraggingNew = false;
  if (tempDragMarker) { tempDragMarker.setMap(null); tempDragMarker = null; }
  document.getElementById('pick-banner').classList.remove('show');
}

async function submitAdd() {
  const name    = document.getElementById('f-name').value.trim();
  const cat     = document.getElementById('f-cat').value;
  const menu    = document.getElementById('f-menu').value.trim();
  const comment = document.getElementById('f-comment').value.trim();

  if (!name) { alert('매장명을 입력해주세요.'); return; }
  if (!pickedLat || !pickedLng) { alert('위치를 먼저 선택해주세요.'); return; }
  if (readOnly) { toast('추가는 로그인(익명) 활성화 후 가능해요'); return; }

  const newPlace = {
    id: 'u' + Date.now(),
    name, cat, lat: pickedLat, lng: pickedLng, menu, comment,
    tags: selectedTags.slice(), added_by: nickname || '익명',
    created_at: new Date().toISOString()   // 최신순 정렬용 (DB에도 동일 기본값)
  };

  const { error } = await supabase.from('places').insert(newPlace);
  if (error) { alert('추가 실패: ' + error.message); return; }

  upsertLocalPlace(newPlace);
  if (myLoc) computeDistances();
  addPlaceToUI(newPlace);
  resortList();
  applyFilter();
  closeAddModal();
  setTimeout(() => openInfo(newPlace.id), 300);
  toast('맛집 추가됨 🍽');
}

// ─────────────────────────────────────────────
// 닉네임
// ─────────────────────────────────────────────
function updateNickBtn() {
  document.getElementById('nick-btn').textContent = '👤 ' + (nickname || '익명');
}

function openNicknameModal() {
  document.getElementById('f-nick').value = nickname || '';
  document.getElementById('nick-cancel').style.display = nickname ? '' : 'none';
  document.getElementById('nick-skip').style.display = nickname ? 'none' : '';
  document.getElementById('nick-overlay').classList.add('open');
  setTimeout(() => document.getElementById('f-nick').focus(), 100);
}

function closeNicknameModal() {
  if (!nickname) return;
  document.getElementById('nick-overlay').classList.remove('open');
}

function skipNickname() {
  localStorage.setItem('matzip_nick_skip', '1');
  document.getElementById('nick-overlay').classList.remove('open');
  toast('익명으로 시작해요 (⚙️ 메뉴에서 언제든 설정 가능)');
}

function saveNickname() {
  const val = document.getElementById('f-nick').value.trim();
  if (!val) { alert('닉네임을 입력해주세요.'); return; }
  nickname = val;
  localStorage.setItem('matzip_nickname', nickname);
  updateNickBtn();
  document.getElementById('nick-overlay').classList.remove('open');
  toast('닉네임: ' + nickname);
}

// ─────────────────────────────────────────────
// 맛집 추천 (룰렛)
// ─────────────────────────────────────────────
let recommendedId = null;
let spinToken = 0;
let isSpinning = false;

function setGotoEnabled(on) {
  const goto = document.getElementById('rec-goto-btn');
  goto.disabled = !on; goto.style.opacity = on ? '1' : '.4';
}

function openRecommendModal() {
  spinToken++;
  isSpinning = false;
  lastRecCat = 'all';
  document.getElementById('rec-result').innerHTML =
    '<div class="rec-empty">위 카테고리를 선택하면<br>룰렛이 주르르륵 돌아갑니다 🎰</div>';
  recommendedId = null;
  setGotoEnabled(false);
  document.querySelectorAll('.rec-cat').forEach(b => b.classList.toggle('active', b.dataset.cat === 'all'));
  document.getElementById('rec-overlay').classList.add('open');
}

function closeRecommendModal() {
  spinToken++;
  isSpinning = false;
  document.getElementById('rec-overlay').classList.remove('open');
}

async function recommendByCat(cat) {
  if (isSpinning) return;
  lastRecCat = cat;
  document.querySelectorAll('.rec-cat').forEach(b => b.classList.toggle('active', b.dataset.cat === cat));

  let pool = places.filter(p => cat === 'all' || p.cat === cat);

  // 태그 조건
  const tagSel = document.getElementById('rec-tag').value;
  if (tagSel) pool = pool.filter(p => (p.tags || []).includes(tagSel));

  // 내 주변만
  if (document.getElementById('rec-near').checked) {
    try { await ensureMyLocation(); } catch { toast('위치 권한이 필요해요'); }
    if (myLoc) {
      computeDistances();
      const near = pool.filter(p => p._dist != null && p._dist <= 1500);
      if (near.length) pool = near;
      else toast('주변 1.5km 내 맛집이 없어 전체에서 추천해요');
    }
  }

  if (!pool.length) {
    document.getElementById('rec-result').innerHTML =
      '<div class="rec-empty">해당 조건에 맞는 맛집이 없어요 😢</div>';
    recommendedId = null;
    setGotoEnabled(false);
    return;
  }

  // 별점 평균 가중치 랜덤 (평가 없으면 기본 3점, 직전 추천 제외)
  let candidates = pool.length > 1 && recommendedId ? pool.filter(p => p.id !== recommendedId) : pool;
  if (!candidates.length) candidates = pool;
  const weights = candidates.map(p => {
    const s = summaries[p.id];
    return s && s.count > 0 ? Math.max(0.5, s.average) : 3;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total, picked = candidates[0];
  for (let i = 0; i < candidates.length; i++) { r -= weights[i]; if (r <= 0) { picked = candidates[i]; break; } }

  spinRoulette(pool, picked);
}

function spinRoulette(pool, picked) {
  const token = ++spinToken;
  isSpinning = true;
  setGotoEnabled(false);
  const resultEl = document.getElementById('rec-result');

  const totalDuration = pool.length > 1 ? 2200 : 600;
  let elapsed = 0;
  let delay = 55;

  function frame(p) {
    resultEl.innerHTML =
      `<div class="rec-spin"><div class="rec-spin-name">${catEmoji(p.cat)} ${esc(p.name)}</div></div>` +
      `<div class="rec-spin-cap">두구두구두구…</div>`;
  }

  function tick() {
    if (token !== spinToken) return;
    frame(pool[Math.floor(Math.random() * pool.length)]);
    elapsed += delay;
    if (elapsed >= totalDuration) {
      frame(picked);
      setTimeout(() => {
        if (token !== spinToken) return;
        recommendedId = picked.id;
        renderRecResult(picked);
        celebrate(resultEl);
        setGotoEnabled(true);
        isSpinning = false;
      }, 240);
      return;
    }
    delay = 55 + Math.pow(elapsed / totalDuration, 2) * 260;
    setTimeout(tick, delay);
  }
  tick();
}

function renderRecResult(p) {
  const s = summaries[p.id];
  const ratingHtml = s && s.count > 0
    ? `<div class="rec-rating">${avgStars(s.average)} ${s.average}점<span class="cnt">(${s.count}명)</span></div>`
    : `<div class="rec-rating" style="color:var(--muted)">평가 없음</div>`;
  const distHtml = (myLoc && p._dist != null) ? `<div class="rec-dist">📍 내 위치에서 ${fmtDist(p._dist)}</div>` : '';
  const tagsHtml = (p.tags && p.tags.length)
    ? `<div class="rec-tags">${p.tags.map(t => `<span class="rec-tag">${esc(TAG_LABEL[t] || t)}</span>`).join('')}</div>`
    : '';
  document.getElementById('rec-result').innerHTML = `
    <div class="rec-card-reveal">
      <div class="rec-card-head">
        <span class="rec-emoji">${catEmoji(p.cat)}</span>
        <span class="rec-name">${esc(p.name)}</span>
        <span class="rec-cat-tag ${p.cat}">${catLabel(p.cat)}</span>
      </div>
      ${ratingHtml}
      ${distHtml}
      <div class="rec-menu">${esc(p.menu || '')}</div>
      ${tagsHtml}
      ${p.comment ? `<div class="rec-comment">💬 ${esc(p.comment)}</div>` : ''}
      <button class="btn-cancel" style="width:100%;margin-top:10px;" onclick="respinRoulette()">🔁 다시 돌리기</button>
    </div>`;
}

function respinRoulette() {
  if (!isSpinning) recommendByCat(lastRecCat);
}

// 당첨 컨페티 + 햅틱
function celebrate(container) {
  if (navigator.vibrate) { try { navigator.vibrate(60); } catch (e) {} }
  const colors = ['#e85d26', '#f6a623', '#2c7a4b', '#7b5ea7', '#2563eb'];
  for (let i = 0; i < 18; i++) {
    const s = document.createElement('span');
    s.className = 'confetti';
    s.style.left = (8 + Math.random() * 84) + '%';
    s.style.background = colors[i % colors.length];
    s.style.animationDelay = (Math.random() * .25) + 's';
    container.appendChild(s);
    setTimeout(() => s.remove(), 1600);
  }
}

function gotoRecommend() {
  if (!recommendedId) return;
  const id = recommendedId;
  if (activeFilter !== 'all') {
    const p = places.find(x => x.id === id);
    if (p && p.cat !== activeFilter) filterMarkers('all');
  }
  activeTagFilter = null; renderTagFilters();
  document.getElementById('search-input').value = '';
  applyFilter();
  closeRecommendModal();
  setTimeout(() => openInfo(id), 250);
}

// ─────────────────────────────────────────────
// 길찾기 / 공유 / 찜
// ─────────────────────────────────────────────
function openDirections(id) {
  const p = places.find(x => x.id === id);
  if (!p) return;
  const url = `https://map.naver.com/p/directions/-/${p.lng},${p.lat},${encodeURIComponent(p.name)}/-/walk`;
  window.open(url, '_blank', 'noopener');
}

async function copyShareLink(id) {
  const url = `${location.origin}${location.pathname}?place=${encodeURIComponent(id)}`;
  try { await navigator.clipboard.writeText(url); toast('공유 링크 복사됨 🔗'); }
  catch { prompt('아래 링크를 복사하세요', url); }
}

function toggleFav(id) {
  if (favs.has(id)) favs.delete(id); else favs.add(id);
  localStorage.setItem('matzip_favs', JSON.stringify([...favs]));
  const p = places.find(x => x.id === id);
  if (p) updatePlaceUI(p);
  if (favOnly) applyFilter();
  toast(favs.has(id) ? '찜 추가 ❤️' : '찜 해제');
}

function toggleFavFilter() {
  favOnly = !favOnly;
  renderTagFilters();
  applyFilter();
}

// ─────────────────────────────────────────────
// 최근 본 맛집
// ─────────────────────────────────────────────
function pushRecent(id) {
  recent = [id, ...recent.filter(x => x !== id)].slice(0, 3);
  localStorage.setItem('matzip_recent', JSON.stringify(recent));
  renderRecent();
}

function renderRecent() {
  const strip = document.getElementById('recent-strip');
  const items = recent.map(id => places.find(p => p.id === id)).filter(Boolean);
  if (!items.length) { strip.style.display = 'none'; return; }
  strip.style.display = '';
  document.getElementById('recent-chips').innerHTML = items.map(p =>
    `<button class="recent-chip" data-rid="${esc(p.id)}">${catEmoji(p.cat)} ${esc(p.name)}</button>`
  ).join('');
}

document.getElementById('recent-chips').addEventListener('click', e => {
  const b = e.target.closest('[data-rid]');
  if (b) openInfo(b.dataset.rid);
});

// 인포윈도우 버튼 공용 핸들러 (id를 onclick 문자열에 넣지 않음)
// 처리한 이벤트는 stopPropagation으로 중복 실행 방지
function handleActionClick(e) {
  const star = e.target.closest('.star[data-id]');
  if (star) { e.stopPropagation(); setRating(star.dataset.id, parseInt(star.dataset.n)); return; }
  const btn = e.target.closest('[data-action][data-id]');
  if (!btn) return;
  e.stopPropagation();
  const { action, id } = btn.dataset;
  if (action === 'move') startMovePlace(id);
  else if (action === 'del') deletePlace(id);
  else if (action === 'nav') openDirections(id);
  else if (action === 'share') copyShareLink(id);
  else if (action === 'fav') toggleFav(id);
  else if (action === 'more') {
    const more = btn.closest('.iw')?.querySelector('.iw-more');
    if (more) more.style.display = more.style.display === 'none' ? 'flex' : 'none';
  }
}
function handleStarKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const star = e.target && e.target.closest && e.target.closest('.star[data-id]');
  if (star) { e.preventDefault(); e.stopPropagation(); setRating(star.dataset.id, parseInt(star.dataset.n)); }
}

// 네이버 지도는 인포윈도우 내부 클릭의 전파를 차단하므로,
// document 위임만으로는 버튼이 동작하지 않음 → 콘텐츠 요소에 직접 바인딩
function buildIwElement(p) {
  const el = document.createElement('div');
  el.innerHTML = buildIwContent(p);
  el.addEventListener('click', handleActionClick);
  el.addEventListener('keydown', handleStarKeydown);
  return el;
}

// 인포윈도우 밖(다른 동적 영역) 대비 폴백
document.addEventListener('click', handleActionClick);
document.addEventListener('keydown', handleStarKeydown);

// ─────────────────────────────────────────────
// 고정 위치 (빠른 이동 북마크)
// ─────────────────────────────────────────────
const DEFAULT_FIXED = [
  { id: 'f-oyc', name: 'OYC (용산)',     lat: 37.5501, lng: 126.9712 },  // 한강대로 372, 동자동
  { id: 'f-wst', name: 'WST 본사 (강남)', lat: 37.5060, lng: 127.0265 },  // 강남대로112길 29, 논현동
];

function loadFixed() {
  let arr = null;
  try { arr = JSON.parse(localStorage.getItem('matzip_fixed')); } catch { arr = null; }
  if (!Array.isArray(arr)) {              // 최초 1회 기본값 시드
    arr = DEFAULT_FIXED.map(f => ({ ...f }));
    localStorage.setItem('matzip_fixed', JSON.stringify(arr));
  }
  return arr;
}
let fixedList = loadFixed();
function saveFixedList() { localStorage.setItem('matzip_fixed', JSON.stringify(fixedList)); }

let fixedHighlight = null;
let fixedPickMode = null;   // { mode:'add', name } | { mode:'reset', id }

function renderFixed() {
  const el = document.getElementById('fixed-list');
  el.innerHTML = fixedList.length
    ? fixedList.map(f => `
        <div class="fixed-item">
          <button class="fixed-jump" data-fx="jump" data-fid="${esc(f.id)}">📍 ${esc(f.name)}</button>
          <button class="fixed-reset" data-fx="reset" data-fid="${esc(f.id)}" title="현재 지도 중심으로 위치 변경" aria-label="위치 변경">🎯</button>
          <button class="fixed-del" data-fx="del" data-fid="${esc(f.id)}" title="삭제" aria-label="삭제">🗑</button>
        </div>`).join('')
    : '<div class="fixed-empty">저장된 위치가 없어요</div>';
  // 기본 위치가 하나라도 빠졌으면 복원 버튼 노출
  const missDefault = DEFAULT_FIXED.some(d => !fixedList.find(f => f.id === d.id));
  document.getElementById('fixed-restore').style.display = missDefault ? '' : 'none';
}

function toggleFixedPanel(force) {
  const p = document.getElementById('fixed-panel');
  const open = typeof force === 'boolean' ? force : !p.classList.contains('open');
  p.classList.toggle('open', open);
  if (open) { renderFixed(); cancelAddFixed(); }
}

function jumpToFixed(id) {
  const f = fixedList.find(x => x.id === id);
  if (!f) return;
  const pos = new naver.maps.LatLng(f.lat, f.lng);
  map.setZoom(17);
  map.panTo(pos);
  if (fixedHighlight) fixedHighlight.setMap(null);
  fixedHighlight = new naver.maps.Marker({
    position: pos, map,
    icon: { content: `<div style="font-size:30px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.4));animation:bowlBounce .6s ease-in-out 2;">📌</div>`, anchor: new naver.maps.Point(15, 30) }
  });
  const hl = fixedHighlight;
  setTimeout(() => { if (hl) hl.setMap(null); if (fixedHighlight === hl) fixedHighlight = null; }, 3000);
  toast(`📍 ${f.name}(으)로 이동`);
  if (window.matchMedia('(max-width: 640px)').matches) toggleFixedPanel(false);
}

function showAddFixed() {
  document.getElementById('fixed-add-form').style.display = 'flex';
  document.getElementById('fixed-add-btn').style.display = 'none';
  document.getElementById('fixed-name').value = '';
  setTimeout(() => document.getElementById('fixed-name').focus(), 50);
}
function cancelAddFixed() {
  document.getElementById('fixed-add-form').style.display = 'none';
  document.getElementById('fixed-add-btn').style.display = '';
}

function startFixedPick() {
  const name = document.getElementById('fixed-name').value.trim();
  if (!name) { alert('이름을 입력해주세요.'); return; }
  beginFixedPickMode({ mode: 'add', name });
}
function resetFixedPos(id) {
  const f = fixedList.find(x => x.id === id);
  if (!f) return;
  map.panTo(new naver.maps.LatLng(f.lat, f.lng));
  beginFixedPickMode({ mode: 'reset', id });
}

function beginFixedPickMode(m) {
  fixedPickMode = m;
  toggleFixedPanel(false);
  document.getElementById('center-cross').classList.add('show');
  const label = m.mode === 'add'
    ? `📌 지도를 옮겨 "${m.name}" 위치를 맞추세요`
    : `🎯 지도를 옮겨 위치를 다시 맞추세요`;
  document.getElementById('fixed-banner-text').textContent = label;
  document.getElementById('fixed-banner').classList.add('show');
}

function endFixedPickMode() {
  fixedPickMode = null;
  document.getElementById('center-cross').classList.remove('show');
  document.getElementById('fixed-banner').classList.remove('show');
}

function confirmFixedPick() {
  if (!fixedPickMode) return;
  const c = map.getCenter();
  const lat = c.lat(), lng = c.lng();
  if (fixedPickMode.mode === 'add') {
    fixedList.push({ id: 'u' + Date.now(), name: fixedPickMode.name, lat, lng });
    toast('고정 위치 추가됨 📌');
  } else {
    const f = fixedList.find(x => x.id === fixedPickMode.id);
    if (f) { f.lat = lat; f.lng = lng; }
    toast('위치 변경됨 🎯');
  }
  saveFixedList();
  endFixedPickMode();
  toggleFixedPanel(true);
}
function cancelFixedPick() { endFixedPickMode(); toggleFixedPanel(true); }

function deleteFixedNow(id) {
  fixedList = fixedList.filter(x => x.id !== id);
  saveFixedList();
  renderFixed();
  toast('고정 위치 삭제됨');
}

function restoreDefaultFixed() {
  DEFAULT_FIXED.forEach(d => { if (!fixedList.find(f => f.id === d.id)) fixedList.push({ ...d }); });
  saveFixedList();
  renderFixed();
  toast('기본 위치 복원됨');
}

// 고정 패널 버튼 위임
document.getElementById('fixed-list').addEventListener('click', e => {
  const b = e.target.closest('[data-fx][data-fid]');
  if (!b) return;
  const { fx, fid } = b.dataset;
  if (fx === 'jump') jumpToFixed(fid);
  else if (fx === 'reset') resetFixedPos(fid);
  else if (fx === 'del') {
    // 2탭 확인: 첫 탭에 "확인?"으로 바뀌고, 2.5초 내 다시 탭하면 삭제
    if (b.dataset.armed) { deleteFixedNow(fid); return; }
    b.dataset.armed = '1';
    b.textContent = '확인?';
    b.style.borderColor = 'var(--danger)'; b.style.color = 'var(--danger)'; b.style.fontSize = '10px';
    setTimeout(() => {
      if (!b.isConnected) return;
      delete b.dataset.armed;
      b.textContent = '🗑'; b.style.borderColor = ''; b.style.color = ''; b.style.fontSize = '';
    }, 2500);
  }
});
// 패널 바깥 클릭 시 닫기
document.addEventListener('click', e => {
  const p = document.getElementById('fixed-panel');
  if (p.classList.contains('open') && !e.target.closest('#fixed-ctrl')) toggleFixedPanel(false);
});

// ─────────────────────────────────────────────
// 데이터 내보내기 / 가져오기 (백업)
// ─────────────────────────────────────────────
function exportData() {
  const data = {
    exportedAt: new Date().toISOString(),
    places, summaries,
    favs: [...favs], fixed: fixedList, nickname
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  a.download = `matzip-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('백업 파일 다운로드 📦');
}

async function importData(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    // 개인 데이터만 복원 (맛집 데이터는 DB가 원본)
    if (Array.isArray(j.favs)) { favs = new Set(j.favs); localStorage.setItem('matzip_favs', JSON.stringify([...favs])); }
    if (Array.isArray(j.fixed)) { fixedList = j.fixed; saveFixedList(); renderFixed(); }
    renderAll();
    toast('가져오기 완료 (찜·가봤어요·고정위치)');
  } catch { toast('가져오기 실패: 파일 형식 오류'); }
  input.value = '';
  toggleMenu(false);
}

// ─────────────────────────────────────────────
// 지도 유형 (일반/위성)
// ─────────────────────────────────────────────
function applyMapType(t) {
  localStorage.setItem('matzip_maptype', t);
  try {
    if (map.setMapTypeId && naver.maps.MapTypeId)
      map.setMapTypeId(t === 'sat' ? (naver.maps.MapTypeId.HYBRID || naver.maps.MapTypeId.NORMAL) : naver.maps.MapTypeId.NORMAL);
  } catch (e) {}
  const b = document.getElementById('maptype-btn');
  if (b) b.textContent = t === 'sat' ? '🗺 일반 지도' : '🛰 위성 지도';
}
function toggleMapType() {
  const cur = localStorage.getItem('matzip_maptype') === 'sat' ? 'sat' : 'normal';
  applyMapType(cur === 'sat' ? 'normal' : 'sat');
}

// ─────────────────────────────────────────────
// 키보드 단축키 (데스크톱): / 검색, R 룰렛, Esc 닫기
// ─────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('rec-overlay').classList.contains('open')) { closeRecommendModal(); return; }
    if (document.getElementById('modal-overlay').classList.contains('open')) { closeAddModal(); return; }
    if (document.getElementById('del-overlay').classList.contains('open')) { cancelDelete(); return; }
    if (nickname && document.getElementById('nick-overlay').classList.contains('open')) { closeNicknameModal(); return; }
    if (document.getElementById('menu-pop').classList.contains('open')) { toggleMenu(false); return; }
    if (document.getElementById('fixed-panel').classList.contains('open')) { toggleFixedPanel(false); return; }
    if (openIW) { openIW.close(); openIW = null; openPlaceId = null; clearActiveMarker(); }
    return;
  }
  if (e.target && e.target.matches && e.target.matches('input, textarea, select')) return;
  if (e.key === '/') { e.preventDefault(); document.getElementById('search-input').focus(); }
  else if (e.key === 'r' || e.key === 'R') openRecommendModal();
});

// ─────────────────────────────────────────────
// 로컬 캐시 (재방문 즉시 렌더 + 오프라인 폴백)
// ─────────────────────────────────────────────
function saveCache() {
  try { localStorage.setItem('matzip_cache', JSON.stringify({ t: Date.now(), places, summaries })); } catch (e) {}
}
function loadCacheData() {
  try {
    const c = JSON.parse(localStorage.getItem('matzip_cache'));
    if (c && Array.isArray(c.places) && c.places.length) return c;
  } catch (e) {}
  return null;
}

// ─────────────────────────────────────────────
// 다크모드 / 모바일 시트
// ─────────────────────────────────────────────
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('matzip_theme', t);
  const b = document.getElementById('theme-btn');
  if (b) b.textContent = t === 'dark' ? '☀️ 라이트 모드' : '🌙 다크 모드';
}

// 설정(⚙️) 메뉴
function toggleMenu(force) {
  const m = document.getElementById('menu-pop');
  const open = typeof force === 'boolean' ? force : !m.classList.contains('open');
  m.classList.toggle('open', open);
}
document.addEventListener('click', e => {
  const m = document.getElementById('menu-pop');
  if (m.classList.contains('open') && !e.target.closest('#menu-pop, #settings-btn')) m.classList.remove('open');
});
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}
let suppressSheetClickUntil = 0;   // 드래그 직후 탭 토글 방지

function toggleSheet() {
  if (Date.now() < suppressSheetClickUntil) return;
  const sb = document.getElementById('sidebar');
  if (sb.classList.contains('expanded') || sb.classList.contains('half')) sb.classList.remove('expanded', 'half');
  else sb.classList.add('expanded');
}
function onSidebarHeaderClick(e) {
  // 모바일에서 헤더(정렬버튼 제외) 클릭 시 시트 토글
  if (window.matchMedia('(max-width: 640px)').matches) toggleSheet();
}

// 시트 드래그 제스처: 손잡이/헤더를 끌어서 접힘·반열림·전체열림 스냅
(function initSheetDrag() {
  const sb = document.getElementById('sidebar');
  let startY = null, startPos = 0, curY = 0, moved = false, collapsedY = 0, halfY = 0;
  function positions() {
    const h = sb.offsetHeight;
    collapsedY = h - 96;
    halfY = Math.round(h * 0.5);
  }
  function currentY() {
    if (sb.classList.contains('expanded')) return 0;
    if (sb.classList.contains('half')) return halfY;
    return collapsedY;
  }
  function onStart(e) {
    if (!window.matchMedia('(max-width: 640px)').matches) return;
    positions();
    startY = e.touches[0].clientY;
    startPos = curY = currentY();
    moved = false;
    sb.style.transition = 'none';
  }
  function onMove(e) {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dy) > 8) moved = true;
    curY = Math.min(collapsedY, Math.max(0, startPos + dy));
    sb.style.transform = `translateY(${curY}px)`;
  }
  function onEnd() {
    if (startY === null) return;
    sb.style.transition = '';
    sb.style.transform = '';
    sb.classList.remove('expanded', 'half');
    const dFull = Math.abs(curY), dHalf = Math.abs(curY - halfY), dCol = Math.abs(curY - collapsedY);
    if (dFull <= dHalf && dFull <= dCol) sb.classList.add('expanded');
    else if (dHalf <= dCol) sb.classList.add('half');
    startY = null;
    if (moved) suppressSheetClickUntil = Date.now() + 400;
  }
  [document.querySelector('.sheet-handle'), document.querySelector('.sidebar-header')].forEach(g => {
    if (!g) return;
    g.addEventListener('touchstart', onStart, { passive: true });
    g.addEventListener('touchmove', onMove, { passive: true });
    g.addEventListener('touchend', onEnd);
  });
})();

// ─────────────────────────────────────────────
// 데이터 로드
// ─────────────────────────────────────────────
function upsertLocalPlace(p) {
  const i = places.findIndex(x => x.id === p.id);
  if (i >= 0) places[i] = { ...places[i], ...p };
  else places.push(p);
}

async function loadPlaces() {
  const { data, error } = await supabase.from('places').select('*').order('created_at', { ascending: true });
  if (error || !data) { console.error('places load error', error); if (!places.length) places = JSON.parse(JSON.stringify(DEFAULT_PLACES)); return; }
  places = data;
}

async function loadSummaries() {
  const { data } = await supabase.from('rating_summary').select('place_id, average, count');
  summaries = {};
  (data || []).forEach(s => { summaries[s.place_id] = { average: Number(s.average), count: s.count }; });
}

async function loadMyRatings() {
  if (!currentUserId) { myRatings = {}; return; }
  const { data } = await supabase.from('ratings').select('place_id, score').eq('user_id', currentUserId);
  myRatings = {};
  (data || []).forEach(r => { myRatings[r.place_id] = r.score; });
}

// ─────────────────────────────────────────────
// 실시간 — 증분 반영
// ─────────────────────────────────────────────
function onPlacesChange(payload) {
  const ev = payload.eventType || payload.type;
  if (ev === 'INSERT' || ev === 'UPDATE') {
    const p = payload.new;
    if (!p) return;
    upsertLocalPlace(p);
    if (myLoc) p._dist = haversine(myLoc.lat, myLoc.lng, p.lat, p.lng);
    if (markerMap[p.id]) updatePlaceUI(p); else addPlaceToUI(p);
    resortList();
    applyFilter();
  } else if (ev === 'DELETE') {
    const id = payload.old && payload.old.id;
    if (!id) return;
    places = places.filter(x => x.id !== id);
    removePlaceFromUI(id);
    updateCountLabel();
  }
}

// 같은 맛집에 별점이 연달아 들어와도 summary 조회는 place당 1회로 디바운스
const ratingRefreshTimers = {};
function onRatingsChange(payload) {
  const row = payload.new || payload.old;
  const placeId = row && row.place_id;
  if (!placeId) return;
  if (payload.new && payload.new.user_id === currentUserId) myRatings[placeId] = payload.new.score;
  clearTimeout(ratingRefreshTimers[placeId]);
  ratingRefreshTimers[placeId] = setTimeout(async () => {
    delete ratingRefreshTimers[placeId];
    const { data } = await supabase.from('rating_summary')
      .select('average, count').eq('place_id', placeId).maybeSingle();
    if (data) summaries[placeId] = { average: Number(data.average), count: data.count };
    else delete summaries[placeId];
    refreshRatingUI(placeId);
  }, 300);
}

function subscribeRealtime() {
  supabase.channel('matzip-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'places' }, onPlacesChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ratings' }, onRatingsChange)
    .subscribe();
}

// ─────────────────────────────────────────────
// 익명 로그인
// ─────────────────────────────────────────────
async function signIn() {
  const { data: { user } } = await supabase.auth.getUser();
  if (user) { currentUserId = user.id; return; }
  const { error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  const { data: { user: u2 } } = await supabase.auth.getUser();
  currentUserId = u2?.id || null;
  if (!currentUserId) readOnly = true;
}

// ─────────────────────────────────────────────
// 초기화
// ─────────────────────────────────────────────
async function init() {
  renderTagFilters();
  renderFixed();
  renderRecent();
  updateNickBtn();
  applyMapType(localStorage.getItem('matzip_maptype') === 'sat' ? 'sat' : 'normal');
  document.getElementById('rec-tag').innerHTML =
    '<option value="">🏷 태그 무관 (전체)</option>' + TAGS.map(t => `<option value="${t.id}">${t.label}</option>`).join('');
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

  if (!nickname && !localStorage.getItem('matzip_nick_skip')) openNicknameModal();

  // 1) 캐시가 있으면 즉시 렌더 (재방문 체감 속도 + 오프라인 폴백)
  const cached = loadCacheData();
  if (cached) {
    places = cached.places;
    summaries = cached.summaries || {};
    renderAll();
    document.getElementById('loading').style.display = 'none';
  }

  // 2) 데이터 로드는 인증과 병렬 시작 (places 읽기는 로그인 불필요)
  const dataPromise = Promise.all([loadPlaces(), loadSummaries()]).then(() => {
    saveCache();
    renderAll();
    document.getElementById('loading').style.display = 'none';
  }).catch(e => {
    console.warn('데이터 로드 실패', e);
    document.getElementById('loading').style.display = 'none';
  });

  // 3) 익명 로그인 (실패해도 읽기는 가능)
  try { await signIn(); }
  catch (e) { console.warn('익명 로그인 실패 — 읽기 전용 모드', e); readOnly = true; toast('읽기 전용 모드 (익명 로그인 비활성)'); }

  // 4) 내 별점은 로그인 후 별도 로드 (열려 있는 팝업만 갱신)
  loadMyRatings().then(() => { if (openPlaceId) refreshRatingUI(openPlaceId); });

  await dataPromise;
  subscribeRealtime();

  // 공유 딥링크 (?place=id)
  const deepId = new URLSearchParams(location.search).get('place');
  if (deepId && markerMap[deepId]) setTimeout(() => openInfo(deepId), 300);

  // PWA 서비스워커 + 업데이트 감지
  if ('serviceWorker' in navigator) {
    try { await registerSW(); }
    catch (e) { console.warn('SW 등록 실패', e); }
  }
}

// ─────────────────────────────────────────────
// 업데이트 알림 (새 배포 감지 → 팝업)
// ─────────────────────────────────────────────
let waitingSW = null;
let updateAccepted = false;   // '업데이트' 승인 시에만 리로드 (최초 설치 controllerchange 오작동 방지)

function showUpdateBanner(worker) {
  waitingSW = worker;
  document.getElementById('update-banner').classList.add('show');
}

function applyUpdate() {
  document.getElementById('update-banner').classList.remove('show');
  updateAccepted = true;
  if (waitingSW) waitingSW.postMessage({ type: 'SKIP_WAITING' });
}

function dismissUpdate() {
  document.getElementById('update-banner').classList.remove('show');
}

async function registerSW() {
  const reg = await navigator.serviceWorker.register('sw.js');

  // 이미 대기 중인 새 버전이 있으면 즉시 알림
  if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);

  // 새 버전이 설치되는 순간 감지
  reg.addEventListener('updatefound', () => {
    const nw = reg.installing;
    if (!nw) return;
    nw.addEventListener('statechange', () => {
      if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(nw);
    });
  });

  // 업데이트 승인 → 새 워커 활성화 → 자동 새로고침
  // (최초 설치 시 clients.claim()으로도 controllerchange가 발생하므로 승인 여부 확인)
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateAccepted || reloading) return;
    reloading = true;
    location.reload();
  });

  // 탭을 오래 열어둔 사용자도 감지: 탭 복귀 시 + 30분마다 체크
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reg.update().catch(() => {});
  });
  setInterval(() => reg.update().catch(() => {}), 30 * 60 * 1000);
}

// ─────────────────────────────────────────────
// 전역 핸들러 등록 (onclick용)
// ─────────────────────────────────────────────
Object.assign(window, {
  filterMarkers, filterByTag, onSearchInput, openInfo, setRating, deletePlace,
  startMovePlace, confirmDrag, cancelDrag, applyFilter, resetFilters,
  openAddModal, closeAddModal, nextAddStep, prevAddStep, startPicking, submitAdd, toggleTag,
  openNicknameModal, closeNicknameModal, saveNickname, skipNickname,
  openRecommendModal, closeRecommendModal, recommendByCat, gotoRecommend, respinRoulette,
  toggleTheme, toggleMenu, toggleSheet, onSidebarHeaderClick, onSortChange, toggleFavFilter,
  toggleMapType, exportData, importData,
  onDelInput, cancelDelete, confirmDelete,
  toggleFixedPanel, showAddFixed, cancelAddFixed, startFixedPick,
  confirmFixedPick, cancelFixedPick, restoreDefaultFixed,
  applyUpdate, dismissUpdate
});

// 테스트 훅 (헤드리스 검증용)
window.__matzip = {
  get places(){ return places; },
  get summaries(){ return summaries; },
  get openPlaceId(){ return openPlaceId; },
  get activeMarkerId(){ return activeMarkerId; },
  get favs(){ return [...favs]; },
  get fixedList(){ return fixedList; },
  get markerMap(){ return markerMap; },
  jumpToFixed, deleteFixedNow,
  buildIwContent, buildIwElement, onPlacesChange, onRatingsChange, esc, showUpdateBanner
};

init();
