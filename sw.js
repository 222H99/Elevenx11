/* Eleven×11 Service Worker
   作用一：缓存主页面，第二次打开时不再重新下载 2MB HTML，直接出首屏（黑屏时间大幅缩短）。
   作用二：提供通知点击回到 App 的最小能力。
   策略：有缓存立即返回，同时在后台抓取新版并写回缓存；首次无缓存才等网络。 */
const E11_VERSION = "2026-11-27v44-236b149-r501";
const E11_CACHE = "e11-shell-" + E11_VERSION;
const E11_INDEX = "./index.html";
const E11_TIMEOUT = 150;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    try {
      const c = await caches.open(E11_CACHE);
      await c.add(new Request(E11_INDEX, { cache: "reload" }));
    } catch (_) {}
    try { await self.skipWaiting(); } catch (_) {}
  })());
});

let __e11NavDone = false;
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    let hadOld = false;
    try {
      const keys = await caches.keys();
      hadOld = keys.some((k) => k.indexOf("e11-shell-") === 0 && k !== E11_CACHE);
      await Promise.all(keys.map((k) => (k === E11_CACHE ? null : caches.delete(k))));
    } catch (_) {}
    try { await self.clients.claim(); } catch (_) {}
    let wins = [];
    try {
      wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of wins) {
        try { c.postMessage({ type: "build", ver: E11_VERSION }); } catch (_) {}
        try { c.postMessage({ type: "e11-build", build: E11_VERSION }); } catch (_) {}
        try { c.postMessage({ type: "e11-sw-activated", build: E11_VERSION }); } catch (_) {}
      }
    } catch (_) {}
    /* v44-236b71：旧版 PWA 自己身上没有升级逻辑（清缓存、注销 SW 都是后来才加的），
       装了旧版的人打开就一直停在旧页面。这里是唯一不依赖页面代码的杠杆：
       只要这一版 SW 接管（旧缓存存在就说明是「换版」而不是首次安装），
       就把还在旧页面的窗口直接导航到线上最新页。首次安装不动，页面自己刚更新过（带 __e11up=）也不动。 */
    if (hadOld && !__e11NavDone) {
      __e11NavDone = true;
      /* 注意：这里绝对不能 await navigate。
         navigate 触发的这次加载还要走本 SW 的 fetch 事件，而 fetch 事件要等 activate 完成才派发，
         在 activate 里 await 就是自己等自己，页面会一直转圈。所以 activate 立即收尾，
         过 1 秒再在事件外面发起导航。 */
      setTimeout(() => {
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((ws) => {
          for (const c of ws) {
            try {
              if (!c.url || c.url.indexOf("http") !== 0) continue;
              if (c.url.indexOf("__e11up=") !== -1) continue;
              const u = new URL(c.url);
              u.searchParams.set("__e11sw", E11_VERSION);
              c.navigate(u.href).catch(() => {});
            } catch (_) {}
          }
        }).catch(() => {});
      }, 1000);
    }
  })());
});

function e11Timeout(ms) {
  return new Promise((res) => setTimeout(() => res(null), ms));
}

async function e11Navigate(request, event) {
  const cache = await caches.open(E11_CACHE);
  const cached = await cache.match(E11_INDEX);
  let netUrl = request.url;
  try {
    const u = new URL(request.url);
    u.searchParams.set("__e11entry", Date.now().toString(36));
    netUrl = u.href;
  } catch (_) {}

  /* v44-236b59：先花 1 秒问一下线上最新构建号（version.json 只有几百字节）。
     缓存里的构建号和线上一致 → 立刻用缓存，进站不受影响；
     不一致（刚更新过）→ 就把新 HTML 抓下来再返回，这一次打开就是最新版。
     这样既不会每次都等 2MB HTML，也不会「要开两次才更新」。 */
  const fetchBuild = async () => {
    const readBuild = async (u) => {
      try {
        const r = await Promise.race([fetch(u, { cache: "no-store" }), e11Timeout(900)]);
        if (!r || !r.ok) return "";
        const t = await r.text();
        try { const j = JSON.parse(t); if (j && j.build) return String(j.build); } catch (_) {}
        const m = t.match(/"build"\s*:\s*"([^"]+)"/);
        return m ? m[1] : "";
      } catch (_) { return ""; }
    };
    /* 同源 version.json 在豆包入口会被 302 到飞书静态站（返回 HTML），解析失败就换 GitHub 那份
       （带 access-control-allow-origin:*，跨域可读）。两者都失败就交给后面的兜底逻辑。 */
    let b = await readBuild(new URL("./version.json", self.registration.scope).href + "?t=" + Date.now().toString(36));
    if (!b) b = await readBuild("https://222h99.github.io/Elevenx11/version.json?t=" + Date.now().toString(36));
    return b;
  };
  const cachedBuild = async () => {
    try {
      if (!cached) return "";
      const t = await cached.clone().text();
      const m = t.match(/name="app-build"\s+content="([^"]+)"/);
      return m ? m[1] : "";
    } catch (_) { return ""; }
  };

  const network = fetch(netUrl, { cache: "no-store" }).then(async (r) => {
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

  try {
    const remote = await fetchBuild();
    if (remote) {
      const local = await cachedBuild();
      if (local && remote === local) {
        /* 已经是最新：缓存立刻给，网络请求放后台跑（顺手把缓存刷新） */
        try { event.waitUntil(network.catch(() => null)); } catch (_) {}
        return cached;
      }
      /* 有新版：等新 HTML（最多 8 秒）；拿到就用它，拿不到才退回旧缓存 */
      try { event.waitUntil((async () => { try { await network; } catch (_) {} })()); } catch (_) {}
      const fresh = await Promise.race([network, e11Timeout(8000)]);
      if (fresh && fresh.ok) return fresh;
      return cached;
    }
  } catch (_) {}

  try { event.waitUntil(network.catch(() => null)); } catch (_) {}
  if (cached) {
    const fresh = await Promise.race([network, e11Timeout(1200)]);
    if (fresh && fresh.ok) return fresh;
    return cached;
  }
  const quick = await Promise.race([network, e11Timeout(E11_TIMEOUT)]);
  if (quick && quick.ok) return quick;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate" || (req.destination === "document" && url.pathname.endsWith("/"))) {
    e.respondWith(e11Navigate(req, e));
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
    /* 手动「检查更新」：把线上最新 HTML 抓一次写进缓存，页面随后 reload 就是新版 */
    if (d.type === "e11-refresh-shell") {
      e.waitUntil((async () => {
        let ok = false;
        try {
          const r = await fetch(new URL(E11_INDEX, self.registration.scope).href + "?__e11f=" + Date.now().toString(36), { cache: "reload" });
          if (r && r.ok) {
            const c = await caches.open(E11_CACHE);
            await c.put(E11_INDEX, r.clone());
            ok = true;
          }
        } catch (_) {}
        try { if (e.source) e.source.postMessage({ type: "e11-refresh-done", ok }); } catch (_) {}
      })());
    }
  } catch (_) {}
});

self.addEventListener("notificationclick", (e) => {
  try { e.notification.close(); } catch (_) {}
  const data = (e.notification && e.notification.data) || {};
  const view = data.view || "view-chat";
  const momentId = data.momentId || "";
  const commentId = data.commentId || "";
  const hash = view === "view-moments" ? "#moments" : view === "view-letters" ? "#letters" : view === "view-guestbook" ? "#guestbook" : "#chat";
  /* 冷启动（App 已关掉）时 hash 带不回具体动态/评论，改成查询参数带过去，
     index.html 启动后按 mid/cid 定位；否则点“对方评论了你的动态”只会落在最新一条。 */
  let qs = "";
  try {
    const q = new URLSearchParams();
    if (view === "view-moments" && momentId) { q.set("e11mid", momentId); if (commentId) q.set("e11cid", commentId); }
    qs = q.toString() ? ("?" + q.toString()) : "";
  } catch (_) {}
  e.waitUntil((async () => {
    try {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of list) {
        if (c.url && c.focus) {
          await c.focus();
          try { c.postMessage({ e11Open: view, momentId: momentId, commentId: commentId }); } catch (_) {}
          return;
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow("./index.html" + qs + hash);
    } catch (_) {}
  })());
});
