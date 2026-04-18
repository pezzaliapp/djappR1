/**
 * djappR1 Service Worker
 *
 * Strategia:
 * - Precache solo shell minima
 * - HTML: Network First
 * - JS/CSS/immagini/font: Cache First
 * - Audio / blob / range requests: SEMPRE bypass (Safari iOS fix)
 */

const APP_VERSION = 'djappr1-v1.0.3'
const CACHE_NAME = APP_VERSION

const PRECACHE_URLS = [
  './',
  './index.html',
]

self.addEventListener('install', (event) => {
  console.log('[SW] Installing', CACHE_NAME)
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating', CACHE_NAME)
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => {
              console.log('[SW] Deleting old cache:', key)
              return caches.delete(key)
            })
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request

  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // 1) NON intercettare richieste non-http
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return

  // 2) NON intercettare audio, media, blob, range requests
  const isAudio =
    request.destination === 'audio' ||
    request.destination === 'video' ||
    url.pathname.endsWith('.mp3') ||
    url.pathname.endsWith('.wav') ||
    url.pathname.endsWith('.ogg') ||
    url.pathname.endsWith('.m4a') ||
    url.pathname.endsWith('.aac') ||
    request.headers.has('range')

  if (isAudio) {
    return
  }

  // 3) HTML / navigazione: Network First
  if (request.mode === 'navigate' || request.destination === 'document') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', clone))
          }
          return response
        })
        .catch(() => caches.match('./index.html'))
    )
    return
  }

  // 4) Cache solo asset statici veri
  const isStaticAsset =
    request.destination === 'script' ||
    request.destination === 'style' ||
    request.destination === 'image' ||
    request.destination === 'font' ||
    url.pathname.includes('/assets/')

  if (!isStaticAsset) {
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached

      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response
        }

        const clone = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone))
        return response
      })
    })
  )
})

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})
