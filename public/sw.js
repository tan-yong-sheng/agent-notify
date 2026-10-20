// The service worker exists so Chrome offers to install the dashboard: a
// browser will not offer installation to a page with no worker, even though the
// worker is not what makes the app useful. This dashboard shows live agent
// state, so it is deliberately not cached: a cached table would show agents
// that have already exited, which is worse than the browser's own offline page.
//
// What it does cache is the shell it needs to start: the icon and the manifest,
// which never change without a new deploy.

const SHELL = ['/icon-192.png', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  // Take over as soon as the new worker is ready, so a redeploy is not stuck
  // behind a tab the operator left open.
  self.skipWaiting()
  event.waitUntil(caches.open('agent-monitor-shell-v1').then((cache) => cache.addAll(SHELL)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== 'agent-monitor-shell-v1').map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  // Live state is never served from a cache. The dashboard polls it, and a
  // stale answer would be indistinguishable from a fresh one.
  if (url.pathname.startsWith('/api/')) return

  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)))
  }
})
