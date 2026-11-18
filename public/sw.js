const CACHE_NAME = "platelog-shell-v0.4.3";
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/adapter.js",
  "/analytics.js",
  "/config.js",
  "/manifest.webmanifest",
  "/vendor/supabase.mjs",
  "/vendor/barcode.mjs",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Never intercept Supabase APIs, Edge Functions, Open Food Facts, or cross-origin requests except Google Fonts.
  if (url.origin !== self.location.origin) {
    if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
      event.respondWith(staleWhileRevalidate(req));
    }
    return;
  }

  // Network-first for HTML, adapter.js, analytics.js, and config.js so UI and backend bindings never drift across deploys.
  if (
    url.pathname === "/" ||
    url.pathname === "/index.html" ||
    url.pathname === "/adapter.js" ||
    url.pathname === "/analytics.js" ||
    url.pathname === "/config.js"
  ) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Cache-first for static app assets.
  event.respondWith(cacheFirst(req));
});

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res && res.ok) {
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, res.clone());
  }
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw new Error("Offline and not cached");
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  const fetchPromise = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await fetchPromise);
}
