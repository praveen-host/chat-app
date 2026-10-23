self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// Push from the server (sent when the recipient is offline, logged out, or has the app hidden)
self.addEventListener('push', event => {
  let d = {};
  try { d = event.data.json(); } catch (e) {}
  event.waitUntil(self.registration.showNotification(d.title || 'New message', {
    body: d.body || '',
    tag: d.fromId != null ? 'chat-' + d.fromId : 'test',   // one notification per sender
    renotify: true,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    data: { fromId: d.fromId, toId: d.toId }
  }));
});

// Tap notification -> focus the app and open that chat
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const { fromId, toId } = event.notification.data || {};
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (all.length) {
      await all[0].focus();
      if (fromId != null) all[0].postMessage({ type: 'open-chat', userId: fromId, toId });
    } else {
      await clients.openWindow(fromId != null ? `/?chat=${fromId}&to=${toId}` : '/');
    }
  })());
});
