/**
 * Phase 89: the old workspace pages are gone. Phones and desktops that installed the old app still run
 * the service worker it registered, and it could keep serving those pages from its cache. This version
 * replaces it, deletes every cache it made, unregisters itself and reloads open tabs onto the new site.
 * The Phone app has its own worker (phone-sw.js) and its own caches, which are left alone.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => !k.startsWith('el-phone-')).map(k => caches.delete(k)));
        await self.registration.unregister();
        const tabs = await self.clients.matchAll({ type: 'window' });
        tabs.forEach(t => t.navigate(new URL('/', t.url).href).catch(() => {}));
    })());
});
