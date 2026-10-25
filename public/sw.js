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

    // The ring is over (answered/declined elsewhere, or caller gave up): clear the incoming-call notification.
    if (d.type === 'call-cancelled' || d.type === 'missed-call') {
      const open = await self.registration.getNotifications({ tag: 'call-' + d.callId });
      open.forEach(n => n.close());
      if (d.type === 'missed-call' && !visibleClient) {
        await self.registration.showNotification('Missed ' + (d.video ? 'video' : 'voice') + ' call', {
          body: d.callerName || 'Someone', tag: 'missed-' + d.fromId, renotify: true,
          icon: '/icon-192.png', badge: '/icon-192.png',
          data: { type: 'missed-call', fromId: d.fromId, toId: d.toId }
        });
      }
      return;
    }

    const isCall = d.type === 'incoming-call';
    await self.registration.showNotification(d.title || 'New message', {
      body: d.body || '',
      tag: isCall ? 'call-' + d.callId : (d.fromId != null ? 'chat-' + d.fromId : 'test'),
      renotify: true,
      requireInteraction: isCall,
      vibrate: isCall ? [250, 150, 250, 150, 500] : undefined,
      // Answer / Decline first: browsers that show fewer buttons drop the last ones.
      actions: isCall ? [
        { action: 'accept', title: 'Answer' },
        { action: 'reject', title: 'Decline' },
        { action: 'message', title: 'Message' }
      ].slice(0, (self.Notification && Notification.maxActions) || 2) : [],
      icon: '/icon-192.png', badge: '/icon-192.png',
      data: { type: d.type || 'message', callId: d.callId, fromId: d.fromId, toId: d.toId, video: d.video }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const data = event.notification.data || {};
  const action = ['accept', 'reject', 'message'].includes(event.action) ? event.action : 'open';
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
