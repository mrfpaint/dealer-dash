// Dealer Dash service worker: keeps the app shell available offline.
// API calls are never cached — offline visits are queued in IndexedDB by app.js.
// Paths are relative so the app works from a sub-folder (mrfpaint.github.io/dealer-dash/).
// Bump VERSION whenever any file in SHELL changes.
const VERSION = 'dd-v7';
const SHELL = ['./', './index.html', './app.js', './styles.css', './icon.svg', './icon-192.png', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so reps get updates as soon as they have signal), cache as fallback.
// cache: 'no-cache' revalidates with the server; otherwise the browser keeps serving
// GitHub Pages' copy (max-age=600) and an update can take 10 minutes to show.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match(new URL('./index.html', location).href)))
  );
});
