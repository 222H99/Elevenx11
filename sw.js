/* Eleven×11 Service Worker —— 在线取最新版；断网/慢网先给缓存，绝不停在黑屏
 *
 * 修复“退出网站再进入黑屏”：
 * 1) 安装时主动缓存一份最新 index.html，换 SW 后不会出现缓存空窗；
 * 2) 打开页面网络优先，但最多等 1.5 秒；1.5 秒没回来立刻用缓存，不再一直黑着；
 * 3) 网络请求继续在后台完成，成功后更新缓存；
 * 4) 连缓存都没有时，返回一个可重试的提示页，而不是空白 503。
 */
const CACHE = "eleven11-runtime-v43-6w";
const INDEX_URL = new URL("./index.html", self.location.href).href;
const NETWORK_WAIT_MS = 1500;

const SHELL = [
  "./manifest.json",
  "./icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
].map((p) => new URL(p, self.location.href).href);

function freshUrl(raw) {
  const u = new URL(raw);
  u.searchParams.set("__sw", Date.now().toString(36));
  return u.href;
}

function cacheIndexResponse(res) {
  if (!res || !res.ok || res.status !== 200 || res.redirected) return;
  const copy = res.clone();
  caches
    .open(CACHE)
    .then((cache) => cache.put(INDEX_URL, copy))
    .catch(() => {});
}

async function preCacheIndex() {
  try {
    const res = await fetch(freshUrl(INDEX_URL), {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "follow",
    });
    cacheIndexResponse(res);
  } catch (_) {}
}

function offlinePage() {
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Eleven×11</title><style>' +
      'html,body{margin:0;height:100%;background:#fafafa;color:#111}' +
      '@media(prefers-color-scheme:dark){html,body{background:#000;color:#f2f2f7}}' +
      'body{display:flex;align-items:center;justify-content:center;font:600 15px -apple-system,BlinkMacSystemFont,sans-serif}' +
      '.b{text-align:center;opacity:.72}.a{display:inline-block;margin-top:14px;padding:8px 18px;border-radius:999px;background:#111;color:#fff;text-decoration:none;font-size:13px}' +
      '@media(prefers-color-scheme:dark){.a{background:#f2f2f7;color:#111}}' +
      '</style></head><body><div class="b">正在连接 Eleven×11…<br><a class="a" href="./index.html">重新进入</a></div>' +
      '<script>setTimeout(function(){location.replace("./index.html?r="+Date.now())},2500)</script></body></html>',
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );
}

async function networkFirstIndex(request) {
  const net = fetch(freshUrl(request.url), {
    cache: "no-store",
    credentials: "same-origin",
    redirect: "follow",
  });

  let fresh = null;
  try {
    fresh = await Promise.race([
      net,
      new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_WAIT_MS)),
    ]);
  } catch (_) {
    fresh = null;
  }

  if (fresh && fresh.ok && fresh.status === 200) {
    cacheIndexResponse(fresh);
    return fresh;
  }

  // 网络超过 1.5 秒或失败：先让用户看到上一次的页面，绝不停在黑屏
  const hit = await caches.match(INDEX_URL, { ignoreSearch: true });
  if (hit) {
    // 网络还在后台跑，成功后顺手更新缓存
    net.then(cacheIndexResponse).catch(() => {});
    return hit;
  }

  // 连缓存都没有：给一个可重试的提示页；网络若随后回来，后台也会写入缓存
  net.then(cacheIndexResponse).catch(() => {});
  return offlinePage();
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

self.addEventListener("install", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .open(CACHE)
        .then((cache) => cache.addAll(SHELL).catch(() => {}))
        .catch(() => {}),
      preCacheIndex(),
    ])
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
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

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 音乐、外链图片不拦
  if (url.pathname.endsWith("/sw.js")) return; // sw 自己不要被 sw 接管
  /* 检查更新用 __bust 拉 HTML 里的 app-build；这类请求必须绕过缓存直接取网络，
     否则 Service Worker 会把旧页面返回给检查逻辑，永远显示“已是最新”。 */
  if (url.searchParams.has("__bust")) {
    event.respondWith(fetch(req, { cache: "no-store", credentials: "same-origin" }));
    return;
  }

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
