/* 复位 iPhone: only the application shell is cached; records remain in browser storage. */
(function workerRuntime(config) {
  "use strict";
  const { version, precache } = config;
  const scope = new URL(self.registration.scope);
  const prefix = `reset-iphone:${encodeURIComponent(scope.href)}:`;
  const cacheName = `${prefix}${version}`;
  const urls = precache.map(path => new URL(path, scope).href);
  const allowed = new Set(urls);
  const indexURL = new URL("index.html", scope).href;
  // A distinct CDN key prevents a fresh worker from receiving an old HTML
  // document during Pages propagation. Store it under the canonical cache key.
  function shellRequestURL(url) {
    if (url !== indexURL) return url;
    const fresh = new URL(url);
    fresh.searchParams.set("__reset_build", version);
    return fresh.href;
  }

  function recoveryClient(scopeURL) {
    const button = document.getElementById("repair");
    const message = document.getElementById("message");
    let reloadRequested = false;
    const reload = () => {
      if (reloadRequested) return;
      reloadRequested = true;
      location.reload();
    };
    function request(worker, type) {
      return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timeout = setTimeout(() => { channel.port1.close(); reject(new Error("连接较慢，请稍后重试。")); }, 20000);
        channel.port1.onmessage = event => { clearTimeout(timeout); channel.port1.close(); resolve(event.data); };
        worker.postMessage({ type }, [channel.port2]);
      });
    }
    function waitForInstall(worker) {
      if (!worker || ["installed", "activated", "redundant"].includes(worker.state)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { worker.removeEventListener("statechange", changed); reject(new Error("下载尚未完成，请稍后再试。")); }, 20000);
        const changed = () => {
          if (!["installed", "activated", "redundant"].includes(worker.state)) return;
          clearTimeout(timeout); worker.removeEventListener("statechange", changed); setTimeout(resolve, 0);
        };
        worker.addEventListener("statechange", changed);
        changed();
      });
    }
    button.onclick = async () => {
      button.disabled = true;
      message.textContent = "正在联网检查并修复应用文件…";
      try {
        const registration = await navigator.serviceWorker.getRegistration(scopeURL);
        if (!registration || registration.scope !== scopeURL) throw new Error("请关闭此窗口，再用 Safari 打开原网址。");
        try { await registration.update(); } catch { /* A fully cached waiting update can still be activated offline. */ }
        await waitForInstall(registration.installing);
        if (registration.waiting) {
          const waiting = registration.waiting;
          const status = await request(waiting, "GET_VERSION");
          if (!status.offlineReady) throw new Error("新版文件尚未下载完整，请联网后重试。");
          navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
          waiting.postMessage({ type: "SKIP_WAITING" });
          message.textContent = "正在打开已准备好的新版本…";
          setTimeout(() => {
            if (!reloadRequested) { message.textContent = "请关闭复位后重新打开，或点按钮再试一次。"; button.disabled = false; }
          }, 15000);
          return;
        }
        if (!registration.active) throw new Error("应用尚未准备好，请稍后再试。");
        const status = await request(registration.active, "REPAIR_CACHE");
        if (!status.offlineReady) throw new Error(status.error || "修复尚未完成，请连接网络后重试。");
        reload();
      } catch (error) {
        message.textContent = error instanceof Error ? error.message : "修复尚未完成，请连接网络后重试。";
        button.disabled = false;
      }
    };
  }

  function recoveryPage() {
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>复位</title><body style="font:17px system-ui;padding:calc(24px + env(safe-area-inset-top)) 24px;line-height:1.7"><h1>需要重新联网打开</h1><p id="message">应用缓存暂时不可用。连接网络后可修复应用文件，个人记录会保留。</p><button id="repair" type="button" style="font:inherit;min-height:48px;padding:10px 16px">联网修复并重新打开</button><script>(${recoveryClient.toString()})(${JSON.stringify(scope.href)});<\/script></body></html>`;
  }

  async function offlineReady() {
    if (!(await caches.keys()).includes(cacheName)) return false;
    const cache = await caches.open(cacheName);
    const matches = await Promise.all(urls.map(url => cache.match(url)));
    return matches.every(response => response && response.ok);
  }

  async function fetchShell() {
    // Fetch and validate every response before writing any shell entries.
    return Promise.all(urls.map(async url => {
      const requestURL = shellRequestURL(url);
      const response = await fetch(new Request(requestURL, { cache: "no-store", credentials: "same-origin", redirect: "error" }));
      if (!response.ok || response.type === "opaque" || (response.url && response.url !== requestURL)) throw new Error(`App asset unavailable: ${url}`);
      if (url === indexURL && !(await response.clone().text()).includes(`<meta name="app-build" content="${version}">`)) throw new Error("App deployment changed during installation.");
      return response;
    }));
  }

  async function repairShell() {
    if (await offlineReady()) return;
    const responses = await fetchShell();
    const cache = await caches.open(cacheName);
    // All fetched resources belong to this same build. Keep every valid old entry,
    // including when quota exhaustion interrupts the repair; retries fill gaps.
    for (let index = 0; index < urls.length; index++) {
      const existing = await cache.match(urls[index]);
      if (!existing?.ok) await cache.put(urls[index], responses[index]);
    }
    if (!(await offlineReady())) throw new Error("Incomplete app cache.");
  }

  async function replyVersion(event, error) {
    let ready = false;
    try { ready = await offlineReady(); } catch { /* Storage may have been evicted. */ }
    const reply = { type: "PWA_VERSION", version, offlineReady: ready, ...(error ? { error } : {}) };
    if (event.ports?.[0]) event.ports[0].postMessage(reply);
    else event.source?.postMessage(reply);
  }

  self.addEventListener("install", event => {
    event.waitUntil((async () => {
      if (await offlineReady()) return;
      try {
        const responses = await fetchShell();
        const cache = await caches.open(cacheName);
        await Promise.all(urls.map((url, index) => cache.put(url, responses[index])));
        if (!(await offlineReady())) throw new Error("Incomplete app cache.");
      } catch (error) {
        await caches.delete(cacheName);
        throw error;
      }
      // A waiting update is activated only after an explicit user action.
    })());
  });

  self.addEventListener("activate", event => {
    event.waitUntil((async () => {
      if (!(await offlineReady())) throw new Error("Cannot activate an incomplete app cache.");
      const owned = (await caches.keys()).filter(name => name.startsWith(prefix) && name !== cacheName);
      // CacheStorage order is creation order. Keep the previous version for open pages.
      const previous = owned[owned.length - 1];
      await Promise.all(owned.filter(name => name !== previous).map(name => caches.delete(name)));
      await self.clients.claim();
    })());
  });

  self.addEventListener("message", event => {
    if (event.data?.type === "GET_VERSION") {
      event.waitUntil(replyVersion(event));
    } else if (event.data?.type === "REPAIR_CACHE") {
      event.waitUntil((async () => {
        let error;
        try { await repairShell(); } catch { error = "离线缓存尚未恢复，请联网后重试或安装可用的新版本。"; }
        await replyVersion(event, error);
      })());
    } else if (event.data?.type === "SKIP_WAITING") {
      event.waitUntil((async () => {
        if (await offlineReady()) await self.skipWaiting();
      })());
    }
  });

  self.addEventListener("fetch", event => {
    const request = event.request;
    if (request.method !== "GET") return;
    const url = new URL(request.url);
    if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
    const isHome = url.pathname === scope.pathname || url.pathname === new URL(indexURL).pathname;
    if (request.mode === "navigate" && isHome) {
      event.respondWith((async () => {
        const cache = await caches.open(cacheName);
        const cached = await cache.match(indexURL);
        if (cached) return cached;
        // A controlled client must never combine another version's HTML and assets.
        // If the OS evicted the shell, accept a network recovery only for this build.
        try {
          const response = await fetch(new Request(shellRequestURL(indexURL), { cache: "no-store", credentials: "same-origin", redirect: "error" }));
          if (response.ok && (await response.clone().text()).includes(`<meta name="app-build" content="${version}">`)) {
            await cache.put(indexURL, response.clone());
            return response;
          }
        } catch { /* Show a small recovery document, never a partial new application. */ }
        return new Response(recoveryPage(), {
          status: 503, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      })());
      return;
    }
    // Only exact build assets are cached. Queries, videos, API responses and backups pass through.
    if (!allowed.has(url.href)) return;
    event.respondWith((async () => {
      const cache = await caches.open(cacheName);
      const cached = await cache.match(url.href);
      if (cached) return cached;
      const response = await fetch(request);
      // Immutable hashed assets can be restored after individual cache eviction.
      if (/\/assets\/app\.[a-f0-9]{12}\.(?:js|css)$/.test(url.pathname) && response.ok && response.type !== "opaque") {
        await cache.put(url.href, response.clone());
      }
      return response;
    })());
  });
})({"version":"iphone-3679a15f9aff","precache":["index.html","assets/app.5f701a4dc61d.js","assets/app.52f356652ac8.css","manifest.webmanifest","icons/icon.svg","icons/icon-192.png","icons/icon-512.png","icons/apple-touch-icon.png","startup-iphone-13-pro-max-v410.png"]});
