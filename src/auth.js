// JWT helpers, request authentication, async-route wrapper and the error handler.
const jwt = require('jsonwebtoken');
const config = require('./config');

const sign = u => jwt.sign({ id: u.id, username: u.username }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES });
const verifyToken = token => jwt.verify(token, config.JWT_SECRET);

function auth(req, res, next) {
  try {
    req.user = verifyToken((req.headers.authorization || '').replace('Bearer ', ''));
    next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
}

// Lets async route handlers throw: errors go to errorHandler instead of crashing/hanging
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function errorHandler(err, req, res, next) {
  const code = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (code === 500) console.error(err);
  res.status(code).json({ error: code === 413 ? 'Image is too large' : code === 500 ? 'Server error' : 'Bad request' });
}

module.exports = { sign, verifyToken, auth, wrap, errorHandler };
