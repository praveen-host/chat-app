self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let d = {};
    try { d = event.data.json(); } catch (_) {}

    // The live Socket.IO call UI handles foreground calls. Push is for hidden/closed apps.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visibleClient = windows.some(c => c.visibilityState === 'visible' && c.focused);
    if (d.type === 'incoming-call' && visibleClient) return;

    const isCall = d.type === 'incoming-call';
    await self.registration.showNotification(d.title || 'New message', {
      body: d.body || '',
      tag: isCall ? 'call-' + d.callId : (d.fromId != null ? 'chat-' + d.fromId : 'test'),
      renotify: true,
      requireInteraction: isCall,
      vibrate: isCall ? [250, 150, 250, 150, 500] : undefined,
      actions: isCall ? [{ action: 'accept', title: 'Accept' }, { action: 'reject', title: 'Reject' }] : [],
      icon: '/icon-192.png', badge: '/icon-192.png',
      data: { type: d.type || 'message', callId: d.callId, fromId: d.fromId, toId: d.toId }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = event.action === 'accept' || event.action === 'reject' ? event.action : 'open';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const url = data.type === 'incoming-call'
      ? `/?callId=${encodeURIComponent(data.callId || '')}&callAction=${action}`
      : (data.fromId != null ? `/?chat=${encodeURIComponent(data.fromId)}&to=${encodeURIComponent(data.toId || '')}` : '/');
    if (windows.length) {
      const client = windows[0];
      await client.focus();
      client.postMessage(data.type === 'incoming-call'
        ? { type: 'call-notification-action', action, callId: data.callId, fromId: data.fromId }
        : { type: 'open-chat', userId: data.fromId, toId: data.toId });
    } else {
      await self.clients.openWindow(url);
    }
  })());
});
