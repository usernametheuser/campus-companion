/* Service worker: caches the app shell so the app opens with no connection.
   Browsers only allow service workers on HTTPS or localhost - see README
   ("Offline app shell") for how this applies to the ESP32's plain-HTTP hub. */
const CACHE = 'cc-shell-v1';
const SHELL = ['./', 'index.html', 'style.css', 'db.js', 'app.js', 'manifest.json', 'icon.svg', 'campus.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Stale-while-revalidate for the shell; the sync API always goes to the network.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  const key = e.request.mode === 'navigate' ? 'index.html' : e.request;
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(key);
    const fresh = fetch(e.request).then(res => {
      if (res.ok) cache.put(key, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
