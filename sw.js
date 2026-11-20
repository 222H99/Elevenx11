/* Eleven×11 Service Worker —— 打开先用完整缓存秒进；网络在后台更新
 *
 * 修复“打开一直白屏 / 有时打不开”：
 * 1) 安装时主动缓存一份完整 index.html，换 SW 后不会出现缓存空窗；
 * 2) 页面导航直接返回缓存整页，不再等慢网把 HTML 正文传完；
 * 3) 网络在后台更新缓存，下一次打开自然换成新版本；
 * 4) 连缓存都没有时，返回一个可重试的提示页，而不是空白 503。
 */
const CACHE = "eleven11-runtime-v43-10";
const INDEX_URL = new URL("./index.html", self.location.href).href;

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

/* 打开页面先给已经缓存好的整页；网络只在后台悄悄更新。
   以前是“网络优先等 1.5 秒”，GitHub Pages 慢的时候响应头回来了、正文却
   传不完，浏览器就会一直白着。整页缓存优先可以保证已安装用户秒开。 */
async function cacheFirstIndex(request) {
  const hit = await caches.match(INDEX_URL, { ignoreSearch: true });
  if (hit) {
    fetch(freshUrl(request.url), {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "follow",
    })
      .then((res) => {
        if (res && res.ok && res.status === 200) cacheIndexResponse(res);
      })
      .catch(() => {});
    return hit;
  }

  // 第一次打开、还没有缓存：只能走网络；失败时给可重试提示页，不返回空白
  try {
    const res = await fetch(freshUrl(request.url), {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "follow",
    });
    if (res && res.ok && res.status === 200) {
      cacheIndexResponse(res.clone());
      return res;
    }
    return offlinePage();
  } catch (_) {
    return offlinePage();
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

/* 新版本安装时先把上一版的完整 index.html 接过来。
   这样即使新页面在慢网下还没下载完，新 SW 也能立刻接管并用旧整页先开，
   不会出现「旧 SW 被停、新 SW 没缓存」的空窗。 */
async function adoptExistingIndex() {
  try {
    const keys = await caches.keys();
    const cache = await caches.open(CACHE);
    const has = await cache.match(INDEX_URL, { ignoreSearch: true });
    if (has) return true;
    for (const k of keys) {
      if (k.indexOf("eleven11-runtime-") !== 0 || k === CACHE) continue;
      const old = await caches.open(k);
      const hit = await old.match(INDEX_URL, { ignoreSearch: true });
      if (hit) {
        await cache.put(INDEX_URL, hit.clone());
        return true;
      }
    }
  } catch (_) {}
  return false;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        await Promise.race([
          cache.addAll(SHELL).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
      } catch (_) {}
      await adoptExistingIndex();
      /* 首次安装没有旧页可接：最多等 2.5 秒抓新页，抓不完就先接管，
         页面导航时会再用 cacheFirstIndex 的首次网络逻辑补上。 */
      if (!(await caches.match(INDEX_URL, { ignoreSearch: true }))) {
        await Promise.race([
          preCacheIndex(),
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
      }
      await self.skipWaiting();
    })().catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            /* 只清运行时页面缓存；表情图镜像 eleven11-media-v1 必须保留 */
            .filter((k) => k.indexOf("eleven11-runtime-") === 0 && k !== CACHE)
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
    event.respondWith(cacheFirstIndex(req));
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
