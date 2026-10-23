// Delete a whole chat.
const { pool } = require('../db');
const rt = require('../realtime');

function register(socket) {
  const me = socket.user;
  // Purge any queued messages between the two users and tell the peer.
  socket.on('chat:delete', async ({ peerId } = {}, cb = () => {}) => {
    try {
      await pool.query(
        `DELETE FROM offline_messages
         WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)`,
        [me.id, peerId, peerId, me.id]);
      rt.emitToUser(peerId, 'chat:deleted', { by: me.id });
      cb({ ok: true });
    } catch (e) { console.error(e); cb({ error: 'Server error' }); }
  });
}

module.exports = { register };
