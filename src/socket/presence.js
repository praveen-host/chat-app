// Who is online + delivery of messages queued while the user was offline.
const { pool } = require('../db');
const rt = require('../realtime');

function register(socket) {
  const me = socket.user;
  const wasOnline = rt.isOnline(me.id);
  socket.join(rt.room(me.id));

  socket.emit('presence:list', rt.onlineIds());
  if (!wasOnline) socket.broadcast.emit('presence', { id: me.id, online: true });
  socket.on('disconnect', async () => {
    // A user can have multiple tabs/devices. Only mark them inactive after the
    // final Socket.IO connection has left their personal room.
    if (!rt.isOnline(me.id)) {
      try {
        await pool.query(
          'UPDATE users SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?',
          [me.id]
        );
        const [rows] = await pool.query(
          'SELECT UNIX_TIMESTAMP(last_active_at) * 1000 AS lastActiveAtMs FROM users WHERE id = ?',
          [me.id]
        );
        const lastActiveAt = rows[0]?.lastActiveAtMs == null
          ? new Date().toISOString()
          : new Date(Number(rows[0].lastActiveAtMs)).toISOString();
        rt.emitToAll('presence', { id: me.id, online: false, lastActiveAt });
      } catch (e) {
        console.error('Could not update last-active timestamp:', e);
        rt.emitToAll('presence', { id: me.id, online: false, lastActiveAt: new Date().toISOString() });
      }
    }
  });
}

// Sends queued messages, then deletes them once the client acknowledges receipt.
async function flushOffline(socket) {
  const [rows] = await pool.query(
    `SELECT m.id, m.sender_id AS \`from\`, COALESCE(u.display_name, u.username) AS fromName,
            m.body, m.image, m.reply_json, m.client_id AS cid, m.created_at AS ts
     FROM offline_messages m JOIN users u ON u.id = m.sender_id
     WHERE m.recipient_id = ? ORDER BY m.id`, [socket.user.id]);
  if (rows.length) {
    const pending = rows.map(({ reply_json, ...r }) => ({ ...r, reply: reply_json ? JSON.parse(reply_json) : null }));
    socket.emit('offline:messages', pending, async () => {
      await pool.query('DELETE FROM offline_messages WHERE id IN (?)', [pending.map(p => p.id)]);
    });
  }

  // Durable messages are retained for history and re-sent until the recipient acknowledges them.
  const [stored] = await pool.query(
    `SELECT m.sender_id AS \`from\`, COALESCE(u.display_name, u.username) AS fromName,
            m.recipient_id AS \`to\`, m.body, m.image, m.reply_json, m.client_id AS cid,
            m.created_at AS ts, m.deleted_at, m.delivered_at
     FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.recipient_id = ? AND m.delivered_at IS NULL ORDER BY m.id LIMIT 500`,
    [socket.user.id]);
  if (stored.length) {
    const queued = stored.map(({ reply_json, deleted_at, delivered_at, ...r }) => ({
      ...r,
      body: deleted_at ? '' : r.body,
      image: deleted_at ? null : r.image,
      reply: deleted_at || !reply_json ? null : JSON.parse(reply_json),
      deleted: !!deleted_at
    }));
    socket.emit('offline:messages', queued, () => {});
  }
}

module.exports = { register, flushOffline };
