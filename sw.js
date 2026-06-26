// 서울 맛집 지도 — 서비스 워커 (앱 셸 캐시, 네트워크 우선)
const CACHE = 'matzip-v1';
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 외부(네이버·Supabase·CDN)는 항상 네트워크 — 캐시하지 않음
  if (url.origin !== self.location.origin) return;
  // 같은 오리진: 네트워크 우선, 실패 시 캐시 폴백
  e.respondWith(
    fetch(req)
      .then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
  );
});
