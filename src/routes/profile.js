// User directory, own profile, profile picture.
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { auth, wrap } = require('../auth');
const { isJpeg } = require('../validate');
const config = require('../config');
const realtime = require('../realtime');

// What other users may see. Email and phone are private and never included here.
const PROFILE_COLS = 'id, username, display_name, full_name, about, has_avatar, avatar_version';
const publicProfile = r => ({ id: r.id, username: r.username, displayName: r.display_name || r.username,
  fullName: r.full_name || '', about: r.about || '', avatarVersion: r.has_avatar ? r.avatar_version : 0 });

async function loadOwnProfile(id) {
  const [rows] = await pool.query(`SELECT ${PROFILE_COLS}, email, phone, last_login_at FROM users WHERE id = ?`, [id]);
  if (!rows.length) return null;
  return { ...publicProfile(rows[0]), email: rows[0].email || '', phone: rows[0].phone || '', lastLoginAt: rows[0].last_login_at || null };
}
// Tell everyone connected (live) that someone changed their profile
const broadcastProfile = p => realtime.emitToAll('profile', { id: p.id, username: p.username, displayName: p.displayName,
  fullName: p.fullName, about: p.about, avatarVersion: p.avatarVersion });

router.get('/users', auth, wrap(async (req, res) => {
  const [rows] = await pool.query(`SELECT ${PROFILE_COLS} FROM users WHERE id <> ? ORDER BY COALESCE(display_name, username)`, [req.user.id]);
  res.json(rows.map(publicProfile));
}));

router.get('/profile', auth, wrap(async (req, res) => {
  const p = await loadOwnProfile(req.user.id);
  p ? res.json(p) : res.status(404).json({ error: 'Not found' });
}));

router.put('/profile', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const str = v => (typeof v === 'string' ? v.trim() : '');
  const displayName = str(b.displayName), fullName = str(b.fullName), email = str(b.email), phone = str(b.phone), about = str(b.about);
  if (!displayName || displayName.length > 50) return res.status(400).json({ error: 'Display name is required (max 50 characters)' });
  if (fullName.length > 100) return res.status(400).json({ error: 'Full name is too long (max 100)' });
  if (email && (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return res.status(400).json({ error: 'Enter a valid email address' });
  if (phone && !/^[0-9+()\-\s]{3,30}$/.test(phone)) return res.status(400).json({ error: 'Phone may contain digits, spaces, + ( ) - only' });
  if (about.length > 200) return res.status(400).json({ error: 'About is too long (max 200)' });
  await pool.query('UPDATE users SET display_name = ?, full_name = ?, email = ?, phone = ?, about = ? WHERE id = ?',
    [displayName, fullName || null, email || null, phone || null, about || null, req.user.id]);
  const p = await loadOwnProfile(req.user.id);
  broadcastProfile(p); res.json(p);
}));

// Profile picture: client sends a 256x256 JPEG as the raw request body
router.put('/profile/avatar', auth, express.raw({ type: 'image/jpeg', limit: '400kb' }), wrap(async (req, res) => {
  if (!isJpeg(req.body) || req.body.length > config.MAX_AVATAR) return res.status(400).json({ error: 'Invalid image' });
  await pool.query('INSERT INTO user_avatars (user_id, image) VALUES (?, ?) ON DUPLICATE KEY UPDATE image = VALUES(image)', [req.user.id, req.body]);
  await pool.query('UPDATE users SET has_avatar = 1, avatar_version = avatar_version + 1 WHERE id = ?', [req.user.id]);
  const p = await loadOwnProfile(req.user.id);
  broadcastProfile(p); res.json(p);
}));

router.delete('/profile/avatar', auth, wrap(async (req, res) => {
  await pool.query('DELETE FROM user_avatars WHERE user_id = ?', [req.user.id]);
  await pool.query('UPDATE users SET has_avatar = 0, avatar_version = avatar_version + 1 WHERE id = ?', [req.user.id]);
  const p = await loadOwnProfile(req.user.id);
  broadcastProfile(p); res.json(p);
}));

// Signed-in users only. The page appends ?v=<avatarVersion> so a changed picture is never served stale.
router.get('/users/:id/avatar', auth, wrap(async (req, res) => {
  const [rows] = await pool.query('SELECT image FROM user_avatars WHERE user_id = ?', [Number(req.params.id) || 0]);
  if (!rows.length) return res.status(404).end();
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' }).send(rows[0].image);
}));

module.exports = router;
