var CACHE_NAME = 'snapdrop-cache-v11';
var urlsToCache = [
  'index.html',
  './',
  'styles.css',
  'scripts/network.js',
  'scripts/ui.js',
  'scripts/clipboard.js',
  'sounds/blop.mp3',
  'images/favicon-96x96.png'
];

self.addEventListener('install', function(event) {
  // Skip waiting to activate immediately
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});


self.addEventListener('fetch', function(event) {
  // Skip caching for non-GET requests (POST, etc.) and server API endpoints
  var url = new URL(event.request.url);
  var skipCache = event.request.method !== 'GET' || url.pathname.startsWith('/server');
  
  if (skipCache) {
    // Just fetch without caching
    event.respondWith(fetch(event.request));
    return;
  }
  
  // Network-first strategy: always try network, fall back to cache
  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        // Update cache with fresh response
        if (response.ok && response.status !== 206) {
          var responseClone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      })
      .catch(function() {
        return caches.match(event.request);
      })
  );
});


self.addEventListener('activate', function(event) {
  console.log('Updating Service Worker...')
  // Claim all clients immediately
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.filter(function(cacheName) {
          return cacheName !== CACHE_NAME;
        }).map(function(cacheName) {
          return caches.delete(cacheName);
        })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});
