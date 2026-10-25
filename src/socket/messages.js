// Durable message sending, history, and deletion.
const { pool } = require('../db');
const config = require('../config');
const rt = require('../realtime');
const { sendPush } = require('../push');
const { isJpeg, cleanReply } = require('../validate');

function mapMessage(row, meId) {
  const deleted = !!row.deleted_at;
  return {
    cid: row.client_id,
    from: row.sender_id,
    fromName: row.from_name || row.sender_username || 'User',
    to: row.recipient_id,
    body: deleted ? '' : row.body,
    image: deleted ? null : row.image,
    reply: deleted || !row.reply_json ? null : JSON.parse(row.reply_json),
    ts: row.created_at,
    status: row.sender_id !== meId ? undefined : (row.read_at ? 'read' : row.delivered_at ? 'delivered' : 'sent'),
    deleted
  };
}

function register(socket) {
  const me = socket.user;

  socket.on('message:send', async ({ to, body, cid, image, reply } = {}, cb = () => {}) => {
    try {
      body = (body || '').toString().trim();
      const hasImage = image !== undefined && image !== null;
      if (hasImage && !(isJpeg(image) && image.length <= config.MAX_IMG)) return cb({ error: 'Invalid image' });
      if (!Number.isInteger(to) || to === me.id || (!body && !hasImage) || body.length > config.MAX_LEN ||
          typeof cid !== 'string' || !cid || cid.length > 64)
        return cb({ error: 'Invalid message' });

      const quoted = cleanReply(reply, me.id, to);
      if (quoted === false) return cb({ error: 'Invalid reply' });

      const [u] = await pool.query('SELECT id, username, display_name FROM users WHERE id IN (?, ?)', [to, me.id]);
      const recipient = u.find(x => Number(x.id) === Number(to));
      if (!recipient) return cb({ error: 'User not found' });
      const sender = u.find(x => Number(x.id) === Number(me.id));
      const senderName = (sender && sender.display_name) || me.username;

      // Persist first. A retry with the same cid is idempotent and cannot create a duplicate.
      await pool.query(
        `INSERT INTO messages (sender_id, recipient_id, client_id, body, image, reply_json)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
        [me.id, to, cid, body, hasImage ? image : null, quoted ? JSON.stringify(quoted) : null]);

      const [rows] = await pool.query(
        `SELECT m.*, u.username AS sender_username, u.display_name AS from_name
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.sender_id = ? AND m.client_id = ? LIMIT 1`, [me.id, cid]);
      const msg = mapMessage(rows[0], me.id);
      msg.fromName = senderName;

      const sockets = await rt.userSockets(to);
      if (sockets.length) rt.emitToUser(to, 'message', msg);

      if (!sockets.some(s => s.data.visible !== false)) {
        const preview = hasImage ? '📷 ' + (body || 'Photo') : body;
        sendPush(to, { title: senderName, body: preview.length > 100 ? preview.slice(0, 97) + '…' : preview, fromId: me.id, toId: to })
          .catch(e => console.error('push error:', e.message));
      }

      // "sent" means durably stored; delivered/read are separate receipts.
      cb({ status: 'sent', cid });
    } catch (e) { console.error('message:send failed', e); cb({ error: 'Server error' }); }
  });

  // Fetch recent history for a conversation. Access is restricted to the authenticated user and peer.
  socket.on('chat:history', async ({ peerId, limit } = {}, cb = () => {}) => {
    try {
      if (!Number.isInteger(peerId) || peerId === me.id) return cb({ error: 'Invalid peer' });
      const pageSize = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 100, 200));
      const [rows] = await pool.query(
        `SELECT m.*, u.username AS sender_username, u.display_name AS from_name
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE (m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)
         ORDER BY m.id DESC LIMIT ?`,
        [me.id, peerId, peerId, me.id, pageSize]);
      const result = rows.reverse().map(row => ({ ...mapMessage(row, me.id), mine: Number(row.sender_id) === Number(me.id) }));
      cb({ ok: true, messages: result });
    } catch (e) { console.error('chat:history failed', e); cb({ error: 'Server error' }); }
  });

  socket.on('message:delete', async ({ to, cid } = {}, cb = () => {}) => {
    try {
      if (!Number.isInteger(to) || typeof cid !== 'string' || !cid || cid.length > 64)
        return cb({ error: 'Invalid request' });
      const [result] = await pool.query(
        'UPDATE messages SET deleted_at = CURRENT_TIMESTAMP, body = \'\', image = NULL, reply_json = NULL WHERE sender_id = ? AND recipient_id = ? AND client_id = ? AND deleted_at IS NULL',
        [me.id, to, cid]);
      // Support messages queued by older versions before durable storage was introduced.
      await pool.query('DELETE FROM offline_messages WHERE sender_id = ? AND recipient_id = ? AND client_id = ?', [me.id, to, cid]);
      if (result.affectedRows) rt.emitToUser(to, 'message:deleted', { by: me.id, cid });
      cb({ ok: true });
    } catch (e) { console.error('message:delete failed', e); cb({ error: 'Server error' }); }
  });
}

module.exports = { register };
