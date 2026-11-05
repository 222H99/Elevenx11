/* Eleven×11 PWA Service Worker —— 网络优先，离线回退缓存 */
const CACHE='eleven11-v1';
const CORE=['./','./index.html','./manifest.webmanifest','./icon-180.png','./icon-192.png','./icon-512.png'];

self.addEventListener('install',function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){return c.addAll(CORE);}).catch(function(){}).then(function(){return self.skipWaiting();}));
});

self.addEventListener('activate',function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.map(function(k){return k===CACHE?Promise.resolve():caches.delete(k);}));
  }).then(function(){return self.clients.claim();}));
});

self.addEventListener('fetch',function(e){
  if(e.request.method!=='GET')return;
  e.respondWith(
    fetch(e.request).then(function(r){
      const cp=r.clone();
      caches.open(CACHE).then(function(c){c.put(e.request,cp);}).catch(function(){});
      return r;
    }).catch(function(){
      return caches.match(e.request).then(function(r){
        return r || caches.match('./index.html');
      });
    })
  );
});
