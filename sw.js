/* Eleven×11 Service Worker
   作用一：缓存主页面，第二次打开时不再重新下载 2MB HTML，直接出首屏（黑屏时间大幅缩短）。
   作用二：提供通知点击回到 App 的最小能力。
   策略：有缓存时“网络 1.2 秒内到就用新版，超时先显示缓存并后台更新”，既不牺牲更新速度，也不让用户干等。 */
const E11_VERSION = "2026-11-23v43-148";
const E11_CACHE = "e11-shell-" + E11_VERSION;
const E11_INDEX = "./index.html";
const E11_TIMEOUT = 1200;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    try {
      const c = await caches.open(E11_CACHE);
      await c.add(new Request(E11_INDEX, { cache: "reload" }));
    } catch (_) {}
    try { await self.skipWaiting(); } catch (_) {}
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k === E11_CACHE ? null : caches.delete(k))));
    } catch (_) {}
    try { await self.clients.claim(); } catch (_) {}
  })());
});

function e11Timeout(ms) {
  return new Promise((res) => setTimeout(() => res(null), ms));
}

async function e11Navigate(request) {
  const cache = await caches.open(E11_CACHE);
  const cached = await cache.match(E11_INDEX);
  const network = fetch(request, { cache: "no-store" }).then(async (r) => {
    if (r && r.ok) {
      try { await cache.put(E11_INDEX, r.clone()); } catch (_) {}
    }
    return r;
  }).catch(() => null);

  if (!cached) {
    const r = await network;
    if (r) return r;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<body style="margin:0;background:#000;color:#fff;font:15px -apple-system,sans-serif;display:flex;align-items:center;justify-content:center;height:100vh">' +
      '网络不可用，请连网后重试</body>',
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
  const fresh = await Promise.race([network, e11Timeout(E11_TIMEOUT)]);
  if (fresh && fresh.ok) return fresh;
  try { self.clients && self.clients.claim(); } catch (_) {}
  return cached;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" || (req.destination === "document" && url.pathname.endsWith("/"))) {
    e.respondWith(e11Navigate(req));
    return;
  }
  /* sw.js 自身永远走网络，保证下次启动能拿到新版本 */
  if (url.pathname.endsWith("/sw.js")) return;
});

self.addEventListener("message", (e) => {
  const d = e.data || {};
  try {
    if (d.type === "query-build" || d.type === "e11-build") {
      if (e.source) e.source.postMessage({ type: "e11-build", build: E11_VERSION });
    }
    if (d.type === "skip-waiting") self.skipWaiting();
  } catch (_) {}
});

self.addEventListener("notificationclick", (e) => {
  try { e.notification.close(); } catch (_) {}
  const data = (e.notification && e.notification.data) || {};
  const view = data.view || "view-chat";
  const momentId = data.momentId || "";
  const hash = view === "view-moments" ? "#moments" : view === "view-letters" ? "#letters" : view === "view-guestbook" ? "#guestbook" : "#chat";
  e.waitUntil((async () => {
    try {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of list) {
        if (c.url && c.focus) {
          await c.focus();
          try { c.postMessage({ e11Open: view, momentId: momentId }); } catch (_) {}
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow("./index.html" + hash);
    } catch (_) {}
  })());
});
