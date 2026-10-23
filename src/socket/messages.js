// Sending messages (text / photo / reply) and deleting a single message.
const { pool } = require('../db');
const config = require('../config');
const rt = require('../realtime');
const { sendPush } = require('../push');
const { isJpeg, cleanReply } = require('../validate');

function register(socket) {
  const me = socket.user;

  socket.on('message:send', async ({ to, body, cid, image, reply } = {}, cb = () => {}) => {
    try {
      body = (body || '').toString().trim();
      const hasImage = image !== undefined && image !== null;
      // Only JPEG bytes are accepted (the client always re-encodes to JPEG), so nothing else can be uploaded.
      if (hasImage && !(isJpeg(image) && image.length <= config.MAX_IMG)) return cb({ error: 'Invalid image' });
      if (!Number.isInteger(to) || to === me.id || (!body && !hasImage) || body.length > config.MAX_LEN || typeof cid !== 'string' || cid.length > 64)
        return cb({ error: 'Invalid message' });
      const quoted = cleanReply(reply, me.id, to);
      if (quoted === false) return cb({ error: 'Invalid reply' });

      const [u] = await pool.query('SELECT id, display_name FROM users WHERE id IN (?, ?)', [to, me.id]);
      if (!u.some(x => x.id === to)) return cb({ error: 'User not found' });
      const senderName = (u.find(x => x.id === me.id) || {}).display_name || me.username;

      const msg = { cid, from: me.id, fromName: senderName, body, image: hasImage ? image : null, reply: quoted, ts: new Date().toISOString() };
      const sockets = await rt.userSockets(to);
      if (sockets.length) {
        rt.emitToUser(to, 'message', msg);              // connected: delivered live, NOT stored
      } else {
        await pool.query('INSERT INTO offline_messages (sender_id, recipient_id, body, client_id, image, reply_json) VALUES (?, ?, ?, ?, ?, ?)',
          [me.id, to, body, cid, hasImage ? image : null, quoted ? JSON.stringify(quoted) : null]);
      }
      // Push whenever the recipient is not actively looking at the app:
      // no open connection (offline / logged out / tab closed) OR every open tab is hidden.
      if (!sockets.some(s => s.data.visible !== false)) {
        const preview = hasImage ? '📷 ' + (body || 'Photo') : body;
        sendPush(to, { title: senderName, body: preview.length > 100 ? preview.slice(0, 97) + '…' : preview, fromId: me.id, toId: to })
          .catch(e => console.error('push error:', e.message));     // fire-and-forget
      }
      cb({ status: 'sent' });
    } catch (e) { console.error(e); cb({ error: 'Server error' }); }
  });

  // Delete for everyone: only the sender can do this. If the message is still queued (recipient offline)
  // it is removed so it is never delivered; if the recipient is online their screen is updated live.
  socket.on('message:delete', async ({ to, cid } = {}, cb = () => {}) => {
    try {
      if (!Number.isInteger(to) || typeof cid !== 'string' || !cid || cid.length > 64) return cb({ error: 'Invalid request' });
      await pool.query('DELETE FROM offline_messages WHERE sender_id = ? AND recipient_id = ? AND client_id = ?', [me.id, to, cid]);
      rt.emitToUser(to, 'message:deleted', { by: me.id, cid });
      cb({ ok: true });
    } catch (e) { console.error(e); cb({ error: 'Server error' }); }
  });
}

module.exports = { register };
