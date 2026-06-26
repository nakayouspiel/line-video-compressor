const CACHE_NAME = "line-video-compressor-v3"; // バージョンを更新して強制リフレッシュ
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

// 外からのメッセージで即座にskipWaitingを実行できるようにする
self.addEventListener("message", (event) => {
  if (event.data && event.data.action === "skipWaiting") {
    self.skipWaiting();
  }
});

// fetchイベントをインターセプトしてCOOP/COEPヘッダーを注入し、SharedArrayBufferを有効化する
self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // chrome-extensionや外部リクエストなどを除外
  if (!url.startsWith(self.location.origin) && !url.startsWith("https://unpkg.com") && !url.startsWith("https://fonts.googleapis.com") && !url.startsWith("https://fonts.gstatic.com")) {
    return;
  }

  // 読み込み済みのキャッシュがあればそれを返し、無ければネットワークから取得
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // キャッシュされたレスポンスにCOOP/COEPヘッダーを設定してそのまま返す（クローン不要）
        return addCoopCoepHeaders(cachedResponse);
      }

      return fetch(event.request)
        .then((response) => {
          if (!response || response.status === 0 || response.type === 'opaque') {
            return response;
          }

          // 返却用にはヘッダーを付与し、キャッシュ用には元のレスポンスのクローンをそのまま使用する
          // これにより、すでに消費されたResponse Bodyをクローンしようとするエラーを防ぎます
          const responseToCache = response.clone();
          const responseToReturn = addCoopCoepHeaders(response);

          const shouldCache = ASSETS.some(asset => url.endsWith(asset.replace("./", ""))) || url.startsWith("https://unpkg.com");
          if (shouldCache) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }

          return responseToReturn;
        })
        .catch((err) => {
          console.error("Fetch failed:", err, url);
          return cachedResponse; // ネットワークエラー時のフォールバック
        });
    })
  );
});

// レスポンスにCOOP/COEPヘッダーを追加する補助関数
function addCoopCoepHeaders(response) {
  if (!response || response.type === 'opaque') {
    return response;
  }

  const newHeaders = new Headers(response.headers);
  newHeaders.set("Cross-Origin-Opener-Policy", "same-origin");
  newHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");

  // 元のレスポンスのクローンのボディを使用して新しいレスポンスを作成する
  const responseClone = response.clone();
  return new Response(responseClone.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
