// Service worker: keeps the app shell available offline. API calls (to script.google.com) are never cached.
// It only touches its own cache and its own folder, so other apps on the same web address are never affected.
const CACHE = 'sandbfabrics-staff-v1.5.1';
const PREFIX = CACHE.replace(/v[\d.]+$/, '');
const SCOPE = self.registration.scope;
const NAME = CACHE + '@' + SCOPE;
const SHELL = ['./', 'index.html', 'styles.css', 'config.js', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', (e) => {
  // First install: start at once. An update waits until the user taps "Update now" (never mid-sale).
  e.waitUntil(caches.open(NAME).then((c) => c.addAll(SHELL)).then(() => { if (!self.registration.active) return self.skipWaiting(); }));
});

self.addEventListener('message', (e) => { if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('activate', (e) => {
  // Remove only this app's older versions (same folder), or its own pre-1.7 cache names.
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== NAME && k.indexOf(PREFIX) === 0 &&
    (k.slice(-('@' + SCOPE).length) === '@' + SCOPE || (k.indexOf('@') < 0 && /^.*-v[\d.]+$/.test(k)))).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || url.href.indexOf(SCOPE) !== 0) return;
  // network first for the app files (so updates arrive), fall back to this app's cache when offline
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(NAME).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.open(NAME).then((c) => c.match(e.request, { ignoreSearch: e.request.mode === 'navigate' })
      .then((r) => r || c.match(SCOPE + 'index.html')).then((r) => r || c.match(SCOPE))))
  );
});
