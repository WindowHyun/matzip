#!/usr/bin/env node
// 프론트(app.js/index.html)에 노출되는 데이터·설정과 Supabase DB 데이터의 정합성 검사
// - 시크릿 불필요: anon key는 클라이언트 공개용이라 app.js에서 그대로 추출해 사용
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const results = [];
function check(name, ok, detail = '') {
  results.push([!!ok, name, detail]);
}
function warn(msg) { console.log(`::warning::${msg}`); }
const cap = arr => arr.slice(0, 5).join(', ') + (arr.length > 5 ? ` 외 ${arr.length - 5}건` : '');

// ── 1. 프론트 상수 추출 ─────────────────────────
const SUPABASE_URL = app.match(/const SUPABASE_URL = '([^']+)'/)?.[1];
const ANON_KEY = app.match(/const SUPABASE_ANON_KEY = '([^']+)'/)?.[1];
check('app.js에서 Supabase URL/키 추출', SUPABASE_URL && ANON_KEY, SUPABASE_URL || '');

const tagsSrc = app.match(/const TAGS = \[([\s\S]*?)\];/)?.[1] ?? '';
const TAG_IDS = new Set([...tagsSrc.matchAll(/id: '([a-z0-9]+)'/g)].map(m => m[1]));
check('프론트 태그 정의 추출', TAG_IDS.size > 0, [...TAG_IDS].join(', '));

const FRONT_CATS = new Set(['noodle', 'rice', 'etc']);
const htmlCats = new Set([...html.matchAll(/<option value="(noodle|rice|etc)">/g)].map(m => m[1]));
check('index.html 카테고리 옵션(면/밥/기타) 완비', htmlCats.size === FRONT_CATS.size);

let DEFAULT_PLACES = [];
try {
  DEFAULT_PLACES = new Function('return ' + app.match(/const DEFAULT_PLACES = (\[[\s\S]*?\]);/)[1])();
} catch (e) { /* check에서 처리 */ }
check('오프라인 폴백(DEFAULT_PLACES) 파싱', DEFAULT_PLACES.length > 0, `${DEFAULT_PLACES.length}곳`);

// ── 2. DB 조회 (RLS 공개 읽기 = 프론트가 보는 것과 동일한 경로) ──
let rows = [];
let dbOk = false;
try {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/places?select=id,name,cat,lat,lng,menu,comment,tags&order=id`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }, signal: AbortSignal.timeout(15000) }
  );
  dbOk = res.ok;
  check('DB places 조회 (anon 읽기)', res.ok, `HTTP ${res.status}`);
  if (res.ok) rows = await res.json();
} catch (e) {
  check('DB places 조회 (anon 읽기)', false, String(e.message || e));
}
check('DB에 맛집 데이터 존재', rows.length > 0, `${rows.length}곳`);

// rating_summary 뷰 (프론트 별점 표시 경로)
try {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/rating_summary?select=place_id&limit=1`,
    { headers: { apikey: ANON_KEY, Authorization: `Bearer ${ANON_KEY}` }, signal: AbortSignal.timeout(15000) }
  );
  check('DB rating_summary 뷰 조회', res.ok, `HTTP ${res.status}`);
} catch (e) {
  check('DB rating_summary 뷰 조회', false, String(e.message || e));
}

// ── 3. DB 데이터가 프론트에서 온전히 렌더 가능한지 ──
if (dbOk && rows.length) {
  const missingField = rows.filter(r => !r.id || !r.name || !r.cat || r.lat == null || r.lng == null);
  check('필수 필드(id/name/cat/lat/lng) 누락 없음', missingField.length === 0, cap(missingField.map(r => r.id || '(id없음)')));

  const badCat = rows.filter(r => !FRONT_CATS.has(r.cat));
  check('모든 cat 값이 프론트 카테고리에 존재', badCat.length === 0, cap(badCat.map(r => `${r.id}:${r.cat}`)));

  const badTag = rows.filter(r => (r.tags || []).some(t => !TAG_IDS.has(t)));
  check('모든 태그가 프론트 TAGS에 정의됨(라벨 렌더 가능)', badTag.length === 0,
    cap(badTag.map(r => `${r.id}:[${(r.tags || []).filter(t => !TAG_IDS.has(t))}]`)));

  const badCoord = rows.filter(r => !(r.lat > 33 && r.lat < 39 && r.lng > 124 && r.lng < 132));
  check('좌표가 한국 범위(사우스코리아) 내', badCoord.length === 0, cap(badCoord.map(r => `${r.id}(${r.lat},${r.lng})`)));

  // ── 4. 프론트 하드코딩(폴백) ↔ DB 드리프트 검사 ──
  for (const f of DEFAULT_PLACES) {
    const db = rows.find(r => r.id === f.id);
    check(`폴백 ${f.id}: DB에 존재`, !!db);
    if (!db) continue;
    check(`폴백 ${f.id}: 이름 일치`, f.name === db.name, `front='${f.name}' db='${db.name}'`);
    check(`폴백 ${f.id}: 카테고리 일치`, f.cat === db.cat, `front='${f.cat}' db='${db.cat}'`);
    check(`폴백 ${f.id}: 메뉴 일치`, (f.menu || '') === (db.menu || ''), `front='${f.menu}' db='${db.menu}'`);
    const close = Math.abs(f.lat - db.lat) < 0.001 && Math.abs(f.lng - db.lng) < 0.001;
    check(`폴백 ${f.id}: 좌표 일치(±0.001)`, close, `front=(${f.lat},${f.lng}) db=(${db.lat},${db.lng})`);
    if ((f.comment || '') !== (db.comment || ''))
      warn(`폴백 ${f.id} 코멘트가 DB와 다릅니다 (경고만): front='${f.comment}' db='${db.comment}'`);
  }
}

// ── 5. 배포된 사이트의 설정 일치 (경고만 — 배포 지연 가능) ──
try {
  const live = await fetch('https://windowhyun.github.io/matzip/app.js', { signal: AbortSignal.timeout(15000) });
  if (live.ok) {
    const t = await live.text();
    const liveUrl = t.match(/const SUPABASE_URL = '([^']+)'/)?.[1];
    if (liveUrl === SUPABASE_URL) console.log('ℹ️  배포 사이트의 Supabase 설정 일치 확인');
    else warn(`배포된 app.js의 SUPABASE_URL(${liveUrl})이 저장소와 다릅니다 — 배포 지연이거나 미배포`);
  } else warn(`배포 사이트 확인 불가 (HTTP ${live.status})`);
} catch (e) { warn(`배포 사이트 확인 실패: ${e.message}`); }

// ── 결과 출력 ───────────────────────────────────
console.log('\n==== 프론트 ↔ DB 정합성 검사 ====');
let pass = 0;
for (const [ok, name, detail] of results) {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (ok) pass++;
}
console.log(`\n${pass}/${results.length} 통과`);
process.exit(pass === results.length ? 0 : 1);
