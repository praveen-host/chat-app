// Socket.IO server instance + small helpers other modules use to reach connected users.
const { Server } = require('socket.io');
const config = require('./config');
const { verifyToken } = require('./auth');

let io = null;
const room = id => `user:${id}`;

function init(httpServer) {
  io = new Server(httpServer, { maxHttpBufferSize: config.MAX_IMG + 100 * 1024 });
  io.use((socket, next) => {
    try { socket.user = verifyToken(socket.handshake.auth.token); next(); }
    catch { next(new Error('Unauthorized')); }
  });
  return io;
}

const isOnline = id => (io.sockets.adapter.rooms.get(room(id))?.size || 0) > 0;
const onlineIds = () => [...io.sockets.adapter.rooms.keys()].filter(k => k.startsWith('user:')).map(k => Number(k.slice(5)));
const userSockets = id => io.in(room(id)).fetchSockets();
const emitToUser = (id, event, payload) => io.to(room(id)).emit(event, payload);
const emitToAll = (event, payload) => io.emit(event, payload);

module.exports = { init, room, isOnline, onlineIds, userSockets, emitToUser, emitToAll };
