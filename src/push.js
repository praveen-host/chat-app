// Web Push: VAPID keys and sending notifications.
const webpush = require('web-push');
const { pool } = require('./db');
const config = require('./config');

let vapidPublic = '';
const getPublicKey = () => vapidPublic;

async function init() {
  let pub = config.VAPID.publicKey, priv = config.VAPID.privateKey;
  if (!pub || !priv) {
    // No keys in env: generate once and keep them in MySQL so subscriptions survive restarts.
    const read = async () => Object.fromEntries((await pool.query(
      "SELECT k, v FROM app_settings WHERE k IN ('vapid_public','vapid_private')"))[0].map(r => [r.k, r.v]));
    let m = await read();
    if (!m.vapid_public || !m.vapid_private) {
      const keys = webpush.generateVAPIDKeys();
      await pool.query("INSERT IGNORE INTO app_settings (k, v) VALUES ('vapid_public', ?), ('vapid_private', ?)",
        [keys.publicKey, keys.privateKey]);
      m = await read();
    }
    pub = m.vapid_public; priv = m.vapid_private;
  }
  vapidPublic = pub;
  webpush.setVapidDetails(config.VAPID.subject, pub, priv);
}

async function sendPush(userId, payload) {
  const [subs] = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
  const data = JSON.stringify(payload);
  const results = await Promise.all(subs.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        data, { TTL: 86400, urgency: 'high' });
      return { ok: true };
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410)      // subscription expired / revoked
        await pool.query('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
      return { ok: false, status: e.statusCode, error: String(e.body || e.message).slice(0, 200) };
    }
  }));
  const failed = results.filter(r => !r.ok);
  console.log(`push -> user ${userId}: ${results.length - failed.length}/${results.length} sent`
    + failed.map(f => ` [${f.status || 'ERR'} ${f.error}]`).join(''));
  return results;
}

module.exports = { init, getPublicKey, sendPush };
