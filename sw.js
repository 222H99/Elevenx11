/* Eleven×11 Service Worker —— 打开先用完整缓存秒进；网络在后台更新
 *
 * 修复“打开一直白屏 / 有时打不开”：
 * 1) 安装时主动缓存一份完整 index.html，换 SW 后不会出现缓存空窗；
 * 2) 页面导航直接返回缓存整页，不再等慢网把 HTML 正文传完；
 * 3) 网络在后台更新缓存，下一次打开自然换成新版本；
 * 4) 连缓存都没有时，返回一个可重试的提示页，而不是空白 503。
 */
const CACHE = "eleven11-runtime-v43-77";
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

/* 只接受完整页面：GitHub Pages 会用 200 返回半截正文，
   这种响应一旦写进缓存，之后每次打开都是残页。 */
function validIndexHTML(text) {
  return (
    typeof text === "string" &&
    text.length > 500000 &&
    /<\/html\s*>/i.test(text) &&
    /name=["']app-build["']/i.test(text)
  );
}

async function putIndexText(text) {
  const cache = await caches.open(CACHE);
  await cache.put(
    INDEX_URL,
    new Response(text, { headers: { "Content-Type": "text/html; charset=utf-8" } })
  );
  return true;
}

async function cacheIndexResponse(res) {
  if (!res || !res.ok || res.status !== 200) return false;
  try {
    const text = await res.text();
    if (!validIndexHTML(text)) return false;
    await putIndexText(text);
    return true;
  } catch (_) {
    return false;
  }
}

async function preCacheIndex() {
  try {
    const res = await fetch(freshUrl(INDEX_URL), {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "follow",
    });
    return await cacheIndexResponse(res);
  } catch (_) {
    return false;
  }
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
      .then(async (res) => {
        if (await cacheIndexResponse(res)) await notifyBuild();
      })
      .catch(() => {});
    return hit;
  }

  // 第一次打开、还没有缓存：只能走网络；失败/半截页时给可重试提示页，不返回空白
  try {
    const res = await fetch(freshUrl(request.url), {
      cache: "no-store",
      credentials: "same-origin",
      redirect: "follow",
    });
    if (!res || !res.ok || res.status !== 200) return offlinePage();
    const text = await res.text();
    if (!validIndexHTML(text)) return offlinePage();
    await putIndexText(text);
    return new Response(text, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
    if (has) {
      const text = await has.text();
      if (validIndexHTML(text)) return true;
      await cache.delete(INDEX_URL);
    }
    for (const k of keys) {
      if (k.indexOf("eleven11-runtime-") !== 0 || k === CACHE) continue;
      const old = await caches.open(k);
      const hit = await old.match(INDEX_URL, { ignoreSearch: true });
      if (hit) {
        const text = await hit.text();
        if (validIndexHTML(text)) {
          await putIndexText(text);
          return true;
        }
      }
    }
  } catch (_) {}
  return false;
}

/* 新版本安装时优先抓「新」整页，抓到完整页面才写缓存；抓不到才退回接旧页。
   以前是反过来：先接旧页，导致新 SW 立刻接管、页面刷新后仍是旧版。 */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        await Promise.race([
          cache.addAll(SHELL).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 700)),
        ]);
      } catch (_) {}
      const gotFresh = await Promise.race([
        preCacheIndex(),
        new Promise((resolve) => setTimeout(() => resolve(false), 1200)),
      ]);
      if (!gotFresh) await adoptExistingIndex();
      await self.skipWaiting();
    })().catch(() => self.skipWaiting())
  );
});

async function cachedBuild() {
  try {
    const hit = await caches.match(INDEX_URL, { ignoreSearch: true });
    if (!hit) return "";
    const text = await hit.text();
    const m = /<meta[^>]+name=["']app-build["'][^>]+content=["']([^"']+)["']/i.exec(text);
    return (m && m[1]) || "";
  } catch (_) {
    return "";
  }
}

async function notifyBuild() {
  const ver = await cachedBuild();
  if (!ver) return;
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of list) {
    try {
      c.postMessage({ type: "build", ver });
    } catch (_) {}
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const oldRuntime = keys.filter((k) => k.indexOf("eleven11-runtime-") === 0 && k !== CACHE);
      /* 只清运行时页面缓存；表情图镜像 eleven11-media-v1 必须保留 */
      await Promise.all(oldRuntime.map((k) => caches.delete(k)));
      await self.clients.claim();
      /* 接管后把新缓存里的 app-build 告诉页面：
         只有真的换了版本，页面才会在安全时机重载；接的是旧页时不会误刷新。 */
      await notifyBuild();
      /* 关键补丁：旧页面可能正停在登录页且输入框已有内容，页面自己的
         safeGate 会判定“在输入，不重载”，于是一直用旧版、继续白屏。
         这里在“确实存在旧运行时缓存”的升级场景，直接让根页面/登录页
         （URL 没有 hash）重新导航到新缓存；聊天 #chat、写信等带 hash 的
         页面不动，避免打断。首次安装没有旧缓存，不会强制刷新。 */
      if (oldRuntime.length) {
        try {
          await new Promise((r) => setTimeout(r, 900));
          const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
          for (const c of list) {
            try {
              const u = new URL(c.url);
              if (u.hash) continue;
              if (!u.pathname.endsWith("/") && !u.pathname.endsWith("/index.html")) continue;
              const bust = new URL(c.url); bust.searchParams.set("__bust", Date.now().toString(36)); c.navigate(bust.href).catch(() => {});
            } catch (_) {}
          }
        } catch (_) {}
      }
    })()
  );
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data && event.data.type === "query-build") {
    event.waitUntil(notifyBuild());
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 音乐、外链图片不拦
  if (url.pathname.endsWith("/sw.js")) return; // sw 自己不要被 sw 接管
  /* 版本探针必须直接走网络：不能被 SW 缓存，也不能被旧缓存骗成“已是最新”。 */
  if (url.pathname.endsWith("/version.json")) {
    event.respondWith(fetch(req, { cache: "no-store", credentials: "same-origin" }));
    return;
  }
  /* 检查更新用 __bust 拉 HTML 里的 app-build；这类请求必须绕过缓存直接取网络，
     否则 Service Worker 会把旧页面返回给检查逻辑，永远显示“已是最新”。 */
  if (url.searchParams.has("__bust") || url.searchParams.has("__u")) {
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
