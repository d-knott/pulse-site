/* Pulse service worker — network-first with a timeout, cache fallback.
   Fresh data whenever the network answers in time; the last good copy of
   everything (shell, Chart.js, fonts, app.enc) when it is slow or offline.

   Phase 4.1 (29 Sep 26): the old worker waited on fetch() with no limit, so a
   flaky connection (one bar on the phone, captive wifi) left the app on
   "Loading your data…" indefinitely instead of opening the cached copy.
   Every request now races the network against a timeout; a cached answer is
   tagged with X-Pulse-Cache: hit so the loader can say "offline copy". */
const CACHE = 'pulse-v3';
const SHELL = ['./', './index.html', './manifest.webmanifest'];
const TIMEOUT = { shell: 4000, enc: 8000, other: 6000 };   // ms before we fall back to cache

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', e => { if (e.data === 'pulse-skip-waiting') self.skipWaiting(); });

function kindOf(req) {
  const u = new URL(req.url);
  if (req.mode === 'navigate' || /\/(index\.html)?$/.test(u.pathname)) return 'shell';
  if (/app\.enc$/.test(u.pathname)) return 'enc';
  return 'other';
}

function fromCache(req) {
  return caches.match(req, { ignoreSearch: true }).then(hit => {
    if (!hit) return null;
    if (hit.type === 'opaque') return hit;                      // cross-origin (CDN) — can't rewrite headers
    const h = new Headers(hit.headers); h.set('X-Pulse-Cache', 'hit');
    return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers: h });
  });
}

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const kind = kindOf(e.request);
  e.respondWith((async () => {
    let timer;
    const net = fetch(e.request).then(res => {
      if (res && (res.ok || res.type === 'opaque')) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone)).catch(() => {});
      }
      return res;
    });
    const late = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), TIMEOUT[kind]); });
    try {
      const res = await Promise.race([net, late]);
      clearTimeout(timer);
      return res;
    } catch (err) {
      clearTimeout(timer);
      const hit = await fromCache(e.request);
      if (hit) return hit;
      // no cached copy: give the network its full chance rather than failing at the timeout
      return net;
    }
  })());
});
