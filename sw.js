/* Eleven×11 Service Worker —— 在线永远取最新版，缓存只做断网兜底
 *
 * 关键点：
 * 1) 打开页面（navigate）走网络，并加 __sw 时间戳绕过 CDN/浏览器旧缓存；
 * 2) 只有网络失败（断网）才返回上一次成功缓存的 index.html；
 * 3) 其它同源静态文件也是网络优先，失败才用缓存；
 * 4) 新 sw 立刻 skipWaiting + clients.claim，并清掉旧 eleven11 缓存。
 *
 * 换版本不需要改这个文件；但如果你改了这个文件本身，浏览器会重新安装。
 */
const CACHE = "eleven11-runtime-v2";
const INDEX_URL = new URL("./index.html", self.location.href).href;
const SHELL = [
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
].map((p) => new URL(p, self.location.href).href);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.indexOf("eleven11") === 0 && k !== CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

function freshUrl(raw) {
  const u = new URL(raw);
  u.searchParams.set("__sw", Date.now().toString(36));
  return u.href;
}

async function networkFirstIndex(request) {
  try {
    const res = await fetch(freshUrl(request.url), {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "follow",
    });
    if (res && res.ok && res.status === 200 && !res.redirected) {
      const copy = res.clone();
      caches
        .open(CACHE)
        .then((cache) => cache.put(INDEX_URL, copy))
        .catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(INDEX_URL, { ignoreSearch: true });
    if (hit) return hit;
    return new Response("当前离线，请联网后重新打开。", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

async function networkFirstAsset(request) {
  try {
    const res = await fetch(request, { cache: "no-store", credentials: "same-origin" });
    if (res && res.ok && res.status === 200) {
      const copy = res.clone();
      caches
        .open(CACHE)
        .then((cache) => cache.put(request, copy))
        .catch(() => {});
    }
    return res;
  } catch (err) {
    const hit = await caches.match(request, { ignoreSearch: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 音乐、外链图片不拦
  if (url.pathname.endsWith("/sw.js")) return; // sw 自己不要被 sw 接管

  if (req.mode === "navigate") {
    event.respondWith(networkFirstIndex(req));
    return;
  }

  event.respondWith(networkFirstAsset(req));
});

/* 点系统通知 → 回到 App 的聊天页 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = (event.notification && event.notification.data) || {};
  if (!data.elevenChat) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const c of list) {
          if ("focus" in c) {
            try {
              c.postMessage({ type: "eleven-open-chat" });
            } catch (err) {}
            return c.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow("./index.html#chat");
      })
  );
});
