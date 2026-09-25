/* Only the public student app is cached. Admin and API responses are never cached. */
const BUILD = '__BUILD__';
const CACHE = 'semester-shell-' + BUILD;
const ASSETS = ['/', '/static/app.js?v='+BUILD, '/static/app.css?v='+BUILD, '/manifest.webmanifest', '/static/icon.svg', '/static/icon-192.png', '/static/icon-512.png', '/static/apple-touch-icon.png'];
self.addEventListener('install', event => {
 event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS.map(url => new Request(url, {cache:'reload'})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
 event.waitUntil((async () => {
  // Keep one older shell as a fallback for a tab in the middle of an update.
  const keys = (await caches.keys()).filter(key => key.startsWith('semester-shell-'));
  const old = keys.filter(key => key !== CACHE);
  await Promise.all(old.slice(0,-1).map(key => caches.delete(key)));
  await self.clients.claim();
 })());
});
self.addEventListener('fetch', event => {
 const url = new URL(event.request.url);
 if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/admin') || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
 if (event.request.mode === 'navigate' && ['/', '/semester-one.html'].includes(url.pathname)) {
  event.respondWith((async () => {
   try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    let response;
    try { response = await fetch(event.request, {cache:'no-store',signal:controller.signal}); } finally { clearTimeout(timer); }
    if (response.ok) return response;
   } catch(e) {}
   return (await (await caches.open(CACHE)).match('/')) || new Response('Open this app online once before using it offline.', {status:503,headers:{'Content-Type':'text/plain'}});
  })());
 } else if (ASSETS.some(asset => new URL(asset,self.location.origin).href === url.href)) {
  event.respondWith((async () => (await caches.open(CACHE)).match(event.request).then(found => found || fetch(event.request)))());
 }
});
