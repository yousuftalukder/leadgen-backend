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
 *   - Offline fallback: the last good copy of the page, else the dashboard.
 */
const VERSION = 'el-shell-v1';
const SHELL = ['client.html', 'client-assistant.html', 'client-leads.html', 'client-community.html',
    'app.css', 'header.js', 'manifest.webmanifest', 'icons/icon-192.png'];

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

self.addEventListener('fetch', event => {
    const req = event.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;          // the API and CDNs are never cached

    event.respondWith(
        fetch(req).then(res => {
            if (res && res.ok) {
                const copy = res.clone();
                caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
            }
            return res;
        }).catch(() =>
            caches.match(req, { ignoreSearch: true }).then(hit =>
                hit || (req.mode === 'navigate' ? caches.match('client.html') : undefined)
            ).then(hit => hit || Response.error())
        )
    );
});
