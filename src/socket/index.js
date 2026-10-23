// Wires Socket.IO to the feature handlers. Each handler file owns one area.
const realtime = require('../realtime');

module.exports = function attachSockets(httpServer) {
  const io = realtime.init(httpServer);
  io.on('connection', socket => {
    socket.data.visible = true;
    // Register every listener first (synchronously) so no early client event is missed...
    require('./presence').register(socket);
    require('./receipts').register(socket);
    require('./messages').register(socket);
    require('./chat').register(socket);
    // ...then deliver anything that was queued while this user was offline.
    require('./presence').flushOffline(socket).catch(e => console.error('flush error:', e));
  });
  return io;
};
