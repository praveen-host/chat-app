// Delivery/read receipts, typing, and tab-visibility reporting.
const { pool } = require('../db');
const rt = require('../realtime');
const { cleanIds } = require('../validate');

function register(socket) {
  const me = socket.user;

  socket.on('visibility', ({ visible } = {}) => { socket.data.visible = !!visible; });

  socket.on('message:delivered', async ({ to, cids } = {}) => {
    cids = cleanIds(cids);
    if (!Number.isInteger(to) || !cids.length) return;
    try {
      await pool.query(
        `UPDATE messages SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP)
         WHERE sender_id = ? AND recipient_id = ? AND client_id IN (?)`,
        [to, me.id, cids]);
      // Remove only legacy offline queue entries. Durable messages remain for history.
      await pool.query('DELETE FROM offline_messages WHERE sender_id = ? AND recipient_id = ? AND client_id IN (?)', [to, me.id, cids]);
      rt.emitToUser(to, 'message:status', { by: me.id, cids, status: 'delivered' });
    } catch (e) { console.error('delivery receipt failed', e); }
  });

  socket.on('message:read', async ({ to, cids } = {}) => {
    cids = cleanIds(cids);
    if (!Number.isInteger(to) || !cids.length) return;
    try {
      await pool.query(
        `UPDATE messages SET delivered_at = COALESCE(delivered_at, CURRENT_TIMESTAMP),
          read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
         WHERE sender_id = ? AND recipient_id = ? AND client_id IN (?)`,
        [to, me.id, cids]);
      rt.emitToUser(to, 'message:status', { by: me.id, cids, status: 'read' });
    } catch (e) { console.error('read receipt failed', e); }
  });

  socket.on('typing', ({ to, typing } = {}) => {
    if (Number.isInteger(to) && to !== me.id) rt.emitToUser(to, 'typing', { from: me.id, typing: !!typing });
  });
}

module.exports = { register };
