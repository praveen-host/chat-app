// One-to-one voice/video call signaling. Audio never passes through this server.
const crypto = require('crypto');
const rt = require('../realtime');
const push = require('../push');
const { pool } = require('../db');

const calls = new Map();             // callId -> call
const activeByUser = new Map();      // userId -> callId

function clearCall(call) {
  calls.delete(call.id);
  if (activeByUser.get(call.callerId) === call.id) activeByUser.delete(call.callerId);
  if (activeByUser.get(call.calleeId) === call.id) activeByUser.delete(call.calleeId);
}

async function displayNameOf(id) {
  try {
    const [rows] = await pool.query('SELECT display_name, username FROM users WHERE id = ? LIMIT 1', [id]);
    return (rows[0] && (rows[0].display_name || rows[0].username)) || 'Someone';
  } catch (_) { return 'Someone'; }
}

// Tell the callee's devices the ring is over: closes the incoming-call notification
// everywhere, and (for an unanswered call) leaves a "missed call" notification behind.
async function closeIncomingNotification(call, kind) {
  try {
    const callerName = kind === 'missed-call' ? await displayNameOf(call.callerId) : undefined;
    await push.sendPush(call.calleeId, {
      type: kind, callId: call.id, fromId: call.callerId, toId: call.calleeId, video: call.video, callerName
    });
  } catch (err) { console.error('Call-closed push failed:', err.message); }
}

async function emitToSocket(userId, socketId, event, payload) {
  if (!socketId) return;
  const sockets = await rt.userSockets(userId);
  const target = sockets.find(s => s.id === socketId);
  if (target) target.emit(event, payload);
}

function register(socket) {
  const userId = Number(socket.user.id);

  socket.on('call:initiate', async ({ to, video } = {}) => {
    const calleeId = Number(to);
    if (!Number.isSafeInteger(calleeId) || calleeId <= 0 || calleeId === userId) {
      return socket.emit('call:error', { message: 'Invalid recipient.' });
    }
    if (activeByUser.has(userId)) return socket.emit('call:busy', { reason: 'You are already in a call.' });
    if (activeByUser.has(calleeId)) return socket.emit('call:busy', { to: calleeId });

    const call = {
      id: crypto.randomUUID(), callerId: userId, callerSocketId: socket.id,
      calleeId, calleeSocketId: null, createdAt: Date.now(),
      video: video === true // omitted/false => plain voice call (old clients unaffected)
    };
    calls.set(call.id, call);
    activeByUser.set(userId, call.id);
    activeByUser.set(calleeId, call.id);
    // Notify hidden/closed clients through Web Push as well as live Socket.IO tabs.
    rt.emitToUser(calleeId, 'call:incoming', { callId: call.id, from: userId, video: call.video });
    socket.emit('call:ringing', { callId: call.id, to: calleeId });
    const callerName = await displayNameOf(userId);
    push.sendPush(calleeId, {
      type: 'incoming-call', title: callerName,
      body: call.video ? 'Incoming video call' : 'Incoming voice call',
      callId: call.id, fromId: userId, toId: calleeId, video: call.video, callerName
    }).catch(err => console.error('Incoming-call push failed:', err.message));
  });

  // A push notification can reopen the app after its original page was closed.
  socket.on('call:resume', ({ callId } = {}) => {
    const call = calls.get(callId);
    if (!call || call.calleeId !== userId || call.calleeSocketId || Date.now() - call.createdAt > 35000) {
      socket.emit('call:unavailable', { callId });
      return;
    }
    socket.emit('call:incoming', { callId: call.id, from: call.callerId, video: call.video });
  });

  socket.on('call:accept', async ({ callId } = {}) => {
    const call = calls.get(callId);
    if (!call || call.calleeId !== userId || call.calleeSocketId) {
      return socket.emit('call:error', { message: 'This call is no longer available.' });
    }
    call.calleeSocketId = socket.id;
    closeIncomingNotification(call, 'call-cancelled');
    await emitToSocket(call.callerId, call.callerSocketId, 'call:accepted', { callId: call.id, by: userId });
  });

  socket.on('call:reject', async ({ callId } = {}) => {
    const call = calls.get(callId);
    if (!call || call.calleeId !== userId || call.calleeSocketId) return;
    clearCall(call);
    closeIncomingNotification(call, 'call-cancelled');
    await emitToSocket(call.callerId, call.callerSocketId, 'call:rejected', { callId: call.id, by: userId });
  });

  async function relay(callId, event, payload, allowedRole) {
    const call = calls.get(callId);
    if (!call) return;
    let targetId, targetSocketId, role;
    if (socket.id === call.callerSocketId && userId === call.callerId) {
      role = 'caller'; targetId = call.calleeId; targetSocketId = call.calleeSocketId;
    } else if (call.calleeSocketId && socket.id === call.calleeSocketId && userId === call.calleeId) {
      role = 'callee'; targetId = call.callerId; targetSocketId = call.callerSocketId;
    } else return;
    if (allowedRole && role !== allowedRole) return;
    if (!targetSocketId) return;
    await emitToSocket(targetId, targetSocketId, event, { callId: call.id, ...payload });
  }

  socket.on('call:offer', ({ callId, offer } = {}) => {
    if (offer && typeof offer === 'object') relay(callId, 'call:offer', { offer }, 'caller');
  });
  socket.on('call:answer', ({ callId, answer } = {}) => {
    if (answer && typeof answer === 'object') relay(callId, 'call:answer', { answer }, 'callee');
  });
  socket.on('call:ice', ({ callId, candidate } = {}) => {
    if (candidate && typeof candidate === 'object') relay(callId, 'call:ice', { candidate });
  });

  socket.on('call:end', async ({ callId, reason } = {}) => {
    const call = calls.get(callId);
    if (!call || (socket.id !== call.callerSocketId && socket.id !== call.calleeSocketId)) return;
    clearCall(call);
    if (socket.id === call.callerSocketId && !call.calleeSocketId) closeIncomingNotification(call, 'missed-call');
    const payload = { callId: call.id, reason: typeof reason === 'string' ? reason.slice(0, 40) : 'ended' };
    if (socket.id === call.callerSocketId) {
      if (call.calleeSocketId) await emitToSocket(call.calleeId, call.calleeSocketId, 'call:ended', payload);
      else rt.emitToUser(call.calleeId, 'call:ended', payload);
    } else {
      await emitToSocket(call.callerId, call.callerSocketId, 'call:ended', payload);
    }
  });

  socket.on('disconnect', async () => {
    const callId = activeByUser.get(userId);
    const call = calls.get(callId);
    if (!call || (socket.id !== call.callerSocketId && socket.id !== call.calleeSocketId)) return;
    clearCall(call);
    if (socket.id === call.callerSocketId && !call.calleeSocketId) closeIncomingNotification(call, 'missed-call');
    const payload = { callId: call.id, reason: 'disconnect' };
    if (socket.id === call.callerSocketId) {
      if (call.calleeSocketId) await emitToSocket(call.calleeId, call.calleeSocketId, 'call:ended', payload);
      else rt.emitToUser(call.calleeId, 'call:ended', payload);
    } else {
      await emitToSocket(call.callerId, call.callerSocketId, 'call:ended', payload);
    }
  });
}

module.exports = { register };
