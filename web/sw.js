// Service worker: tallettaa vain sovelluksen kuoren (S-7). /api/* ei koskaan kulje välimuistin kautta.
// __TIIVISTE__ korvataan build.mjs:ssä app.js:n sha256:n 8 ensimmäisellä merkillä dist/-kopiossa.
const KUORI = 'scopes2-kuori-__TIIVISTE__';
const KUORIPOLUT = ['/web/', '/web/index.html', '/web/app.js', '/web/app.css', '/web/manifest.webmanifest', '/web/kuvakkeet/scopes-v2.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(KUORI).then((c) => c.addAll(KUORIPOLUT)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((nimet) => Promise.all(nimet.filter((n) => n.startsWith('scopes2-kuori-') && n !== KUORI).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== self.location.origin) return;
  if (u.pathname.startsWith('/api/')) return; // ei respondWith: selain hoitaa, ei välimuistia
  if (!u.pathname.startsWith('/web/')) return;
  // Verkko ensin, välimuisti varalla.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && KUORIPOLUT.includes(u.pathname)) {
          const kopio = r.clone();
          caches.open(KUORI).then((c) => c.put(e.request, kopio));
        }
        return r;
      })
      .catch(() => caches.match(e.request).then((m) => m ?? Response.error())),
  );
});
