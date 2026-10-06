/**
 * EdgeLead service worker (phase 30).
 *
 * Exists so the client surface can be installed on a phone's home screen and
 * open when the network is slow or absent. It is deliberately small:
 *
 *   - Network first, always. Nothing here is fingerprinted, so a cached page
 *     must never win over a fresh one: a deploy has to reach the phone on its
 *     next open, exactly as the must-revalidate caching rule says.
 *   - Only this origin. The API (Render) and the CDNs go straight through and
 *     are never cached — a cached /api/me would be a stale account state.
 *   - Offline fallback: the last good copy of the page, else the dashboard
 *     (or, inside the Edge Meta AI app, the chat).
 */
const VERSION = 'el-shell-v7';   // v7: phase 54 (a slow network shows the cached copy; entries by path, capped)
const SHELL = ['client.html', 'client-assistant.html', 'client-leads.html', 'client-community.html',
    'app.css', 'header.js', 'report-view.js', 'manifest.webmanifest', 'icons/icon-192.png?v=2',
    'ai/', 'ai/manifest.webmanifest', 'meta-ai.js', 'meta-ai.css', 'icons/ai-192.png?v=1', 'icons/logo-mark-lg.png?v=1', 'owner-hub.js'];

self.addEventListener('install', event => {
    self.skipWaiting();
    event.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => { /* the shell fills on first use */ }));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Phase 54. A slow network (one bar, a café's Wi-Fi) used to leave the app on a blank
// screen until the browser gave up, because only a failed fetch fell back to the cache.
// Now the cached copy shows after a few seconds and the fresh one fills the cache
// behind it. Entries are kept by path, not by query (?client=…, ?meta=ok made a new
// copy every time), and the cache is held to a size.
const NET_WAIT_MS = 4000;
const MAX_ENTRIES = 80;

function cacheKey(url) { const u = new URL(url); u.search = ''; u.hash = ''; return u.href; }
async function trim(cache) {
    const keys = await cache.keys();
    const shell = new Set(SHELL.map(p => new URL(p, self.location.href).href));
    const extra = keys.filter(k => !shell.has(k.url));
    for (const k of extra.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(k);
}
async function fallback(req, url) {
    // Offline, each app opens on its own last good screen: the chat for ai/, else the dashboard.
    const hit = await caches.match(cacheKey(req.url), { ignoreSearch: true }) || await caches.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') return caches.match(url.pathname.startsWith('/ai/') ? 'ai/' : 'client.html');
    return undefined;
}

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;          // the API and CDNs are never cached

    const network = fetch(req).then(res => {
        if (res && res.ok && res.type === 'basic') {
            const copy = res.clone();
            event.waitUntil(caches.open(VERSION).then(c => c.put(cacheKey(req.url), copy).then(() => trim(c))).catch(() => {}));
        }
        return res;
    });
    network.catch(() => {});                                  // answered from the cache already; nothing to report
    event.respondWith((async () => {
        let timer;
        const slow = new Promise(r => { timer = setTimeout(() => r('slow'), NET_WAIT_MS); });
        try {
            const first = await Promise.race([network, slow]);
            if (first !== 'slow') return first;
            // Slow: the cached copy if there is one, else keep waiting for the network.
            return (await fallback(req, url)) || await network;
        } catch {
            return (await fallback(req, url)) || Response.error();
        } finally { clearTimeout(timer); }
    })());
});
