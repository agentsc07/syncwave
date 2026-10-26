/* SyncWave service worker.
 * - Precaches the app shell (list + build id are stamped into this file at build time by vite.config.ts).
 * - Cache-first for hashed /assets/*; network-first for navigations with an offline fallback page.
 * - NEVER touches /api, /media, /ws, non-GET requests, Range requests or cross-origin requests,
 *   so uploads, audio downloads and WebSockets always go straight to the network.
 * - Update flow: a new worker calls skipWaiting(); the page sees `controllerchange` and shows a
 *   "new version, refresh" toast (it does not reload by itself, that would cut a live session).
 * Needs HTTPS or localhost to register. */
const BUILD_ID = '__BUILD_ID__';
const CACHE = 'syncwave-shell-' + BUILD_ID;
const PRECACHE = /*__PRECACHE__*/ ['/', '/offline.html', '/manifest.webmanifest'];
const NEVER = /^\/(api|media|ws)(\/|$)/;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(PRECACHE.map((u) => c.add(new Request(u, { cache: 'reload' })).catch(() => {}))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('syncwave-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || req.headers.has('range')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return; // network, untouched

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
          return res;
        })
        .catch(() => caches.match('/').then((r) => r || caches.match('/offline.html'))),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) { // content-hashed: safe to cache forever
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })),
    );
    return;
  }

  if (PRECACHE.includes(url.pathname)) { // icons, manifest, offline page: cache, refresh in background
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
          return res;
        });
        return hit || net;
      }),
    );
  }
});
