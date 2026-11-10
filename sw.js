/* Eleven×11 PWA Service Worker —— 网络优先（带超时），失败回退缓存，离线可用 */
const CACHE = 'eleven11-v3';
const CORE = ['./', './index.html', './manifest.json', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(CORE).catch(function () {}); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (ks) {
      return Promise.all(ks.map(function (k) { return k === CACHE ? null : caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* 带超时的网络请求：4 秒拿不到就用缓存，避免一直白屏 */
function netWithTimeout(req, ms) {
  return new Promise(function (resolve, reject) {
    var done = false;
    var timer = setTimeout(function () { if (!done) { done = true; reject(new Error('timeout')); } }, ms || 4000);
    fetch(req).then(function (r) { if (!done) { done = true; clearTimeout(timer); resolve(r); } })
      .catch(function (er) { if (!done) { done = true; clearTimeout(timer); reject(er); } });
  });
}

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;   /* 跨域（后端接口、歌曲、二维码）不插手 */

  e.respondWith(
    netWithTimeout(e.request, 4000).then(function (r) {
      var cp = r.clone();
      caches.open(CACHE).then(function (c) { c.put(e.request, cp); }).catch(function () {});
      return r;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) {
        if (hit) return hit;
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return caches.match('./index.html');
      });
    })
  );
});
