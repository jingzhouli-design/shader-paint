const CACHE_NAME = "shader-paint-offline-v2";
const CACHE_PREFIX = "shader-paint-offline-";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(["./", "./index.html"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then(async (names) => {
        const current = await caches.open(CACHE_NAME);
        const previousNames = names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME);
        for (const name of previousNames) {
          const previous = await caches.open(name);
          for (const request of await previous.keys()) {
            if (await current.match(request)) continue;
            const response = await previous.match(request);
            if (response) await current.put(request, response);
          }
        }
        await Promise.all(previousNames.map((name) => caches.delete(name)));
      })
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "cache-assets" || !Array.isArray(event.data.urls)) return;
  const urls = event.data.urls.filter((url) => new URL(url, self.location.href).origin === self.location.origin);
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(urls)));
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(
      Promise.race([
        fetch(event.request)
        .then((response) => {
          if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
          return response;
        })
          .catch(() => null),
        new Promise((resolve) => {
          setTimeout(() => resolve(null), 2500);
        }),
      ]).then((response) => (
        response || caches.match(event.request).then((cached) => cached || caches.match("./index.html"))
      )),
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) void caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
          return response;
        })
        .catch(() => null);
      return cached || network.then((response) => response || caches.match("./index.html"));
    }),
  );
});
