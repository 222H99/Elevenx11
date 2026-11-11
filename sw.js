/* Eleven×11 Service Worker —— 点开即最新 + 有缓存可秒开/离线 */
var CACHE = 'e11-shell-v2';
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

/* 把首页和它的校验信息（ETag / Last-Modified / 长度）一起存起来 */
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

/* 只发一个 HEAD：拿到服务器当前首页的 ETag/Last-Modified，判断有没有换版本 */
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
      /* 有缓存：用一个很快的 HEAD 确认服务器上有没有新版；
         有新版就直接给新版（点开即最新），没变 / 超时 / 判断不了就先给缓存（秒开），后台再补 */
      var probe = Promise.race([
        headChanged(),
        new Promise(function (res) { setTimeout(function () { res(null); }, 600); })
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
