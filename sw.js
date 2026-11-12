/* Eleven×11 Service Worker —— 点开即最新 + 有缓存可秒开/离线 */
var CACHE = 'e11-shell-v3';
var SHELL = './index.html';
var META = './__shell_meta';

self.addEventListener('install', function (e) {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.add(new Request(SHELL, { cache: 'reload' })).catch(function () {});
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

function buildOf(txt) {
  var m = /app-build"\s+content="([^"]+)"/.exec(txt || '');
  return m ? m[1] : '';
}

/* 把首页和它的校验信息（版本号 / ETag / Last-Modified / 长度）一起存起来 */
function storeShell(res) {
  return caches.open(CACHE).then(function (c) {
    var meta = {
      etag: res.headers.get('etag') || '',
      lastmod: res.headers.get('last-modified') || '',
      len: res.headers.get('content-length') || ''
    };
    return res.clone().text().then(function (txt) {
      meta.ver = buildOf(txt);
      return c.put(SHELL, res.clone()).then(function () {
        return c.put(META, new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
      });
    });
  });
}

function readMeta() {
  return caches.open(CACHE).then(function (c) {
    return c.match(META).then(function (r) {
      return r ? r.json().catch(function () { return null; }) : null;
    });
  });
}

/* 只取首页开头一小段，读出里面的 app-build 版本号：
   比 HEAD 靠 ETag 判断更可靠——服务器头不稳、或 CDN 头看不出版本时也能判准 */
function remoteVersion() {
  return fetch(new Request(SHELL, {
    cache: 'no-store',
    headers: { 'Range': 'bytes=0-2047' }
  })).then(function (r) {
    if (!r || !r.ok) return null;
    var len = Number(r.headers.get('content-length') || 0);
    /* 服务器不认 Range、想整份塞给我们就放弃，别为了判版本白下载 1MB */
    if (r.status !== 206 && len > 4096) return null;
    return r.text().then(function (txt) {
      var v = buildOf(txt);
      return v || null;
    }).catch(function () { return null; });
  }).catch(function () { return null; });
}

/* 拿不到版本号时退回保守办法：HEAD 的 ETag / Last-Modified / 长度 */
function headChanged() {
  return fetch(new Request(SHELL, { method: 'HEAD', cache: 'no-store' }))
    .then(function (r) {
      if (!r || !r.ok) return null;
      var now = {
        etag: r.headers.get('etag') || '',
        lastmod: r.headers.get('last-modified') || '',
        len: r.headers.get('content-length') || ''
      };
      return readMeta().then(function (old) {
        if (!old) return true;
        if (now.etag && old.etag) return now.etag !== old.etag;
        if (now.lastmod && old.lastmod) return now.lastmod !== old.lastmod;
        if (now.len && old.len) return now.len !== old.len;
        return null;
      });
    })
    .catch(function () { return null; });
}

/* 判断服务器上是不是已经换了新版本 */
function shellChanged() {
  return readMeta().then(function (old) {
    return remoteVersion().then(function (rv) {
      if (rv) {
        if (!old || !old.ver) return true;
        return rv !== old.ver;
      }
      return headChanged();
    });
  }).catch(function () { return headChanged(); });
}

function fetchFresh() {
  return fetch(new Request(SHELL, { cache: 'reload' })).then(function (r) {
    if (r && r.ok) storeShell(r.clone()).catch(function () {});
    return r;
  });
}

/* 后台补一次最新，并通知页面版本号 */
function refreshShell() {
  return fetchFresh().then(function (r) {
    if (!r || !r.ok) return;
    return r.clone().text().then(function (txt) {
      var ver = buildOf(txt);
      if (!ver) return;
      return self.clients.matchAll({ includeUncontrolled: true }).then(function (list) {
        list.forEach(function (cl) { try { cl.postMessage({ type: 'build', ver: ver }); } catch (e) {} });
      });
    });
  }).catch(function () {});
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (err) { return; }
  if (url.origin !== self.location.origin) return;

  var isPage = req.mode === 'navigate' ||
    /\/$/.test(url.pathname) ||
    /\.html?$/i.test(url.pathname);
  if (!isPage) return; /* 其它资源照常走网络 */

  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req).then(function (hit) {
      if (!hit) {
        return fetchFresh().catch(function () { return fetch(req); });
      }
      /* 有缓存：先核对服务器上的版本号（只读开头 2KB）；
         换版就直接给新版，没变 / 超时 / 判不了就先给缓存（秒开），后台再补 */
      var probe = Promise.race([
        shellChanged(),
        new Promise(function (res) { setTimeout(function () { res(null); }, 1200); })
      ]);
      return probe.then(function (changed) {
        if (changed === true) {
          return fetchFresh().then(function (r) { return r || hit; }).catch(function () { return hit; });
        }
        e.waitUntil(refreshShell());
        return hit;
      });
    });
  }));
});

/* 通知点击：聚焦或新开窗口 */
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(SHELL);
    })
  );
});
