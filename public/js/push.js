/* Web push notifications: service worker, permission, subscribing, the 🔔 button. */
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

if (pushSupported) {
  navigator.serviceWorker.register('/sw.js').catch(console.error);
  navigator.serviceWorker.addEventListener('message', e => {       // notification tapped while app is open
    const d = e.data || {};
    if (d.type === 'open-chat' && (d.toId == null || Number(d.toId) === Number(me.id)) && users.some(u => Number(u.id) === Number(d.userId))) openChat(Number(d.userId));
    if (d.type === 'call-notification-action' && typeof handleCallNotificationAction === 'function') handleCallNotificationAction(d.action, d.callId);
  });
}

function setBell(label, handler) { const b = $('bellBtn'); b.style.display = 'inline-block'; b.textContent = label; b.onclick = handler; }

function b64ToU8(b64) {
  const raw = atob((b64 + '='.repeat((4 - b64.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
const sameKey = (buf, u8) => { const a = new Uint8Array(buf); return a.length === u8.length && a.every((v, i) => v === u8[i]); };

const withTimeout = (p, ms, msg) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

function friendlyPushError(e) {
  if (e.name === 'AbortError') return 'The browser could not reach its push service (' + e.message + '). Usual causes: a company firewall/proxy blocking fcm.googleapis.com (Chrome/Edge), a VPN, or Brave with "Use Google services for push messaging" turned off.';
  if (e.name === 'NotAllowedError') return 'Notification permission is blocked, or this is a private/incognito window.';
  return e.message;
}

async function pushSubscribe() {
  let step = '1/4 service worker';
  try {
    const reg = await withTimeout(navigator.serviceWorker.ready, 10000,
      'The service worker did not start. Hard-reload (Ctrl+Shift+R) and check DevTools > Application > Service Workers.');
    step = '2/4 server key';
    const kr = await fetch('/api/push/key', { headers: authHdr() });
    if (!kr.ok) throw new Error('Server returned ' + kr.status + ' for /api/push/key (rebuild the container?)');
    const keyBytes = b64ToU8((await kr.json()).key);
    step = '3/4 browser push service';
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options.applicationServerKey && !sameKey(sub.options.applicationServerKey, keyBytes)) {
      await sub.unsubscribe(); sub = null;                         // server keys changed -> resubscribe
    }
    if (!sub) sub = await withTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes }), 20000,
      'The browser push service did not answer within 20s (firewall/proxy/VPN blocking it?).');
    step = '4/4 saving to server';
    const r = await fetch('/api/push/subscribe', { method: 'POST', headers: { ...authHdr(), 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
    if (!r.ok) throw new Error('Server rejected the subscription (HTTP ' + r.status + ')');
  } catch (e) {
    console.error('push setup failed at step ' + step, e);
    throw new Error('Step ' + step + ' failed: ' + friendlyPushError(e));
  }
}

function explainUnsupported() {
  alert(!window.isSecureContext ? 'Notifications need HTTPS (or localhost). Open the app over HTTPS.'
    : !('serviceWorker' in navigator) ? 'This browser/window does not allow service workers (private or incognito windows usually block them).'
    : !('PushManager' in window) ? 'Push is not available here. On iPhone/iPad (iOS 16.4+), add the app to the Home Screen and open it from there.'
    : 'Notifications are not supported in this browser.');
}

async function initPush() {
  if (!pushSupported) return setBell('🔔 Alerts ✕', explainUnsupported);
  if (Notification.permission === 'granted') {
    try { await pushSubscribe(); setBell('🔔 Test', testPush); }
    catch (e) { console.error(e); setBell('🔔 Retry', () => { alert(e.message); enablePush(); }); }
  } else if (Notification.permission === 'denied') {
    setBell('🔔 Blocked', () => alert('Notifications are blocked for this site. Allow them in your browser\'s site settings, then reload.'));
  } else setBell('🔔 Alerts', enablePush);     // permission prompt needs a tap (required on iOS)
}

async function enablePush() {
  try {
    if (await Notification.requestPermission() !== 'granted') return initPush();
    await pushSubscribe(); setBell('🔔 Test', testPush); testPush();
  } catch (e) { alert('Could not enable notifications: ' + e.message); }
}

// Sends a push to this user's registered devices so you can confirm it works end to end
async function testPush() {
  const r = await fetch('/api/push/test', { method: 'POST', headers: authHdr() });
  const d = await r.json();
  if (!d.devices) return alert('No device is registered for this user yet. Tap Retry / reload and allow notifications.');
  if (!d.sent) return alert('Push failed: ' + d.failures.map(f => (f.status || 'error') + ' ' + f.error).join('; '));
  const b = $('bellBtn'); b.textContent = '✓ Sent'; setTimeout(() => b.textContent = '🔔 Test', 2000);
}
