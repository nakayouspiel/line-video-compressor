const CACHE_NAME = "line-video-compressor-v4";
const ASSETS = [
  "./",
  "./index.html",
  "./index.css",
  "./app.js",
  "./manifest.json",
  "./icon.png"
];

// インストール時に静的アセットをキャッシュ
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS).catch(err => {
        console.warn("Pre-caching assets failed, might be missing icon.png. Continuing...", err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// 通常のキャッシュ優先戦略（セキュアヘッダーの変更などは行わない）
self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // chrome-extensionなどのリクエストを除外
  if (!url.startsWith(self.location.origin) && !url.startsWith("https://fonts.googleapis.com") && !url.startsWith("https://fonts.gstatic.com")) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((response) => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }

        const responseToCache = response.clone();
        const shouldCache = ASSETS.some(asset => url.endsWith(asset.replace("./", "")));
        if (shouldCache) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }

        return response;
      }).catch((err) => {
        console.warn("Fetch failed, returning cached response if available:", err);
        return cachedResponse;
      });
    })
  );
});
