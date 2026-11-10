/* Eleven×11 Service Worker —— 不做页面缓存：永远联网拿最新；仅保留 PWA/通知能力 */
self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys()
      .then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); })
      .then(function () { return self.clients.claim(); })
  );
  /* 通知点击：聚焦或新开窗口 */
  self.addEventListener('notificationclick', function (e) {
    e.notification.close();
    e.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
        for (var i = 0; i < list.length; i++) { if ('focus' in list[i]) return list[i].focus(); }
        if (self.clients.openWindow) return self.clients.openWindow('./index.html');
      })
    );
  });
});

/* 不拦截任何请求：直接走网络，页面永远是最新的 */
