const STATIC_CACHE = 'static-v1';
const DATA_CACHE = 'data-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((c) => c.addAll([
      '/',
      '/index.html',
      '/main.js',
      '/service-worker.js'
    ]))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map((k) => {
        if (![STATIC_CACHE, DATA_CACHE].includes(k)) return caches.delete(k);
      })
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(event.request);
          const clone = res.clone();
          const cc = await caches.open(DATA_CACHE);
          cc.put(event.request.url, clone);
          return res;
        } catch (_) {
          const cached = await caches.match(event.request.url);
          if (cached) return cached;
          return new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
        }
      })()
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      return cached || fetch(event.request).then((res) => {
        const clone = res.clone();
        caches.open(STATIC_CACHE).then((c) => c.put(event.request, clone));
        return res;
      }).catch(() => cached || new Response('', { status: 504 }));
    })
  );
});

