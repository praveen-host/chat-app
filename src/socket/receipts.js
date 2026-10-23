// Delivered/read ticks, typing indicator, and tab-visibility reporting.
const rt = require('../realtime');
const { cleanIds } = require('../validate');

function register(socket) {
  const me = socket.user;

  // Lets the server know whether this tab is in front of the user (used to decide on push notifications)
  socket.on('visibility', ({ visible } = {}) => { socket.data.visible = !!visible; });

  // Recipient tells us what it received/read; we relay to the original sender.
  const relayStatus = status => ({ to, cids } = {}) => {
    cids = cleanIds(cids);
    if (Number.isInteger(to) && cids.length) rt.emitToUser(to, 'message:status', { by: me.id, cids, status });
  };
  socket.on('message:delivered', relayStatus('delivered'));
  socket.on('message:read', relayStatus('read'));

  // Typing indicator (never stored)
  socket.on('typing', ({ to, typing } = {}) => {
    if (Number.isInteger(to)) rt.emitToUser(to, 'typing', { from: me.id, typing: !!typing });
  });
}

module.exports = { register };
