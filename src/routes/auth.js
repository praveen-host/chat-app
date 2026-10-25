// POST /api/signup, POST /api/signin
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { sign, wrap } = require('../auth');

router.post('/signup', async (req, res) => {
  const { username, password } = req.body || {};
  if (!/^[a-zA-Z0-9_]{3,50}$/.test(username || '') || (password || '').length < 6)
    return res.status(400).json({ error: 'Username 3-50 chars (letters, digits, _), password min 6 chars' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const [r] = await pool.query('INSERT INTO users (username, password_hash, last_login_at) VALUES (?, ?, CURRENT_TIMESTAMP)', [username, hash]);
    const user = { id: r.insertId, username, displayName: username, lastLoginAt: new Date().toISOString() };
    res.status(201).json({ token: sign(user), user });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Username already taken' });
    console.error(e); res.status(500).json({ error: 'Server error' });
  }
});

router.post('/signin', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const [rows] = await pool.query('SELECT id, username, password_hash, display_name FROM users WHERE username = ?', [username || '']);
  if (!rows.length || !(await bcrypt.compare(password || '', rows[0].password_hash)))
    return res.status(401).json({ error: 'Invalid credentials' });
  await pool.query('UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?', [rows[0].id]);
  const [loginRows] = await pool.query('SELECT last_login_at FROM users WHERE id = ?', [rows[0].id]);
  const user = { id: rows[0].id, username: rows[0].username, displayName: rows[0].display_name || rows[0].username, lastLoginAt: loginRows[0].last_login_at };
  res.json({ token: sign(user), user });
}));

module.exports = router;
