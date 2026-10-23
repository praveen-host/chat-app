// Web Push subscription endpoints.
const router = require('express').Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { auth, wrap } = require('../auth');
const push = require('../push');

const hashOf = endpoint => crypto.createHash('sha256').update(endpoint).digest('hex');

router.get('/push/key', auth, (req, res) => res.json({ key: push.getPublicKey() }));

router.post('/push/subscribe', auth, wrap(async (req, res) => {
  const { endpoint, keys } = req.body || {};
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://') || !keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string')
    return res.status(400).json({ error: 'Invalid subscription' });
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE p256dh = VALUES(p256dh), auth = VALUES(auth)`,
    [req.user.id, endpoint, hashOf(endpoint), keys.p256dh, keys.auth]);
  console.log(`push subscribe: user ${req.user.id} via ${endpoint.split('/')[2]}`);
  res.json({ ok: true });
}));

router.post('/push/unsubscribe', auth, wrap(async (req, res) => {
  const { endpoint } = req.body || {};
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Invalid request' });
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?', [hashOf(endpoint), req.user.id]);
  res.json({ ok: true });
}));

// Sends a test notification to all of the signed-in user's registered devices
router.post('/push/test', auth, wrap(async (req, res) => {
  const results = await push.sendPush(req.user.id, { title: 'Test notification', body: 'Push notifications are working on this device.', fromId: null, toId: req.user.id });
  res.json({ devices: results.length, sent: results.filter(r => r.ok).length, failures: results.filter(r => !r.ok) });
}));

module.exports = router;
