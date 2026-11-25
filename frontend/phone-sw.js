/**
 * EdgeLead Phone service worker (phase 88). It exists so the Phone installs as an app.
 * Network first, always: a deploy reaches the app on its next open. Only the Phone's own files are kept,
 * as a fallback when the network is down; the API and the calling software are never cached.
 */
const VERSION = 'el-phone-v4';
const SHELL = ['phone.html', 'app/app.css', 'app/app.js', 'app/phone.js', 'vendor/supabase-js-2.116.0.js', 'icons/icon-192.png'];
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('el-phone-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
    const req = e.request, url = new URL(req.url);
    if (req.method !== 'GET' || url.origin !== self.location.origin) return;
    if (!SHELL.some(p => url.pathname.endsWith('/' + p)) && req.mode !== 'navigate') return;
    e.respondWith(fetch(req).then(r => { if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(req, copy)); } return r; })
        .catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('phone.html'))));
});
