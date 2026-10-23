// Who is online + delivery of messages queued while the user was offline.
const { pool } = require('../db');
const rt = require('../realtime');

function register(socket) {
  const me = socket.user;
  const wasOnline = rt.isOnline(me.id);
  socket.join(rt.room(me.id));

  socket.emit('presence:list', rt.onlineIds());
  if (!wasOnline) socket.broadcast.emit('presence', { id: me.id, online: true });
  socket.on('disconnect', () => {
    if (!rt.isOnline(me.id)) rt.emitToAll('presence', { id: me.id, online: false });
  });
}

// Sends queued messages, then deletes them once the client acknowledges receipt.
async function flushOffline(socket) {
  const [rows] = await pool.query(
    `SELECT m.id, m.sender_id AS \`from\`, COALESCE(u.display_name, u.username) AS fromName,
            m.body, m.image, m.reply_json, m.client_id AS cid, m.created_at AS ts
     FROM offline_messages m JOIN users u ON u.id = m.sender_id
     WHERE m.recipient_id = ? ORDER BY m.id`, [socket.user.id]);
  if (!rows.length) return;
  const pending = rows.map(({ reply_json, ...r }) => ({ ...r, reply: reply_json ? JSON.parse(reply_json) : null }));
  socket.emit('offline:messages', pending, async () => {
    await pool.query('DELETE FROM offline_messages WHERE id IN (?)', [pending.map(p => p.id)]);
  });
}

module.exports = { register, flushOffline };
