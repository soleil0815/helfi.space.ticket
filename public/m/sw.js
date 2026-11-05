// Service worker of the mobile UI (scope /m/). Served by the server as /m/sw.js with the
// shell list and the cache version filled in (src/pwa.js) – this file is the template.
//
// What it does:
//  - precaches only the app shell (own HTML/CSS/JS/icons) in a cache named after the version
//  - HTML pages: network first; without a connection the offline page
//  - shell files: from the cache (they change only together with the version)
//  - /brand.css and /brand/logo: network first, cached copy only as a fallback
//  - never touches /api/, /auth/ or anything else: ticket data, attachments and sign-in
//    responses are never stored on the device
//  - new version: installs at once (skipWaiting), takes over open pages (clients.claim),
//    deletes old caches; the page then offers "New version – reload"
/* eslint-env serviceworker */
const VERSION = '__HELFI_VERSION__';
const SHELL = ['__HELFI_SHELL__'];
const PREFIX = 'helfi-m-';
const CACHE = `${PREFIX}${VERSION}`;
const OFFLINE = '/m/offline.html';
const NETWORK_FIRST = new Set(['/brand.css', '/brand/logo']);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache: 'reload' – fresh from the server, not from the HTTP cache
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload', credentials: 'same-origin' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source?.postMessage({ type: 'version', version: VERSION });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Data and sign-in: always the network, never stored
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) return;

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => offlinePage()));
    return;
  }
  if (NETWORK_FIRST.has(url.pathname)) {
    event.respondWith(networkFirst(req));
    return;
  }
  if (SHELL.includes(url.pathname) && !url.search) {
    event.respondWith(caches.match(url.pathname, { cacheName: CACHE }).then((hit) => hit || fetch(req)));
  }
  // Everything else: the browser's normal handling
});

async function offlinePage() {
  const hit = await caches.match(OFFLINE, { cacheName: CACHE });
  return hit || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) await cache.put(req, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(req);
    if (hit) return hit;
    throw e;
  }
}
