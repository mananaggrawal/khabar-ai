// Khabar AI — main app service worker.
// Minimal on purpose: its only job right now is to receive Web Push events
// and show the resulting notification (and handle tapping it). No offline
// caching / fetch interception — that's a separate feature if ever wanted,
// and keeping this small avoids any risk of it interfering with normal
// page loads or the audio player.

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Khabar AI", body: event.data ? event.data.text() : "" };
  }

  const title = data.title || "Khabar AI";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icon-192-v2.png",
    badge: data.badge || "/icon-192-v2.png",
    data: { url: data.url || "/" },
    tag: data.tag || "khabar-briefing", // replaces any earlier un-tapped briefing notification instead of stacking
    renotify: true,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Tapping the notification focuses an already-open tab if there is one,
// otherwise opens a new one at the target URL.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl).catch(() => {});
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    }),
  );
});
