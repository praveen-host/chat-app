// One-to-one voice/video call signaling. Audio never passes through this server.
const crypto = require('crypto');
const rt = require('../realtime');
const push = require('../push');
const { pool } = require('../db');

const calls = new Map();             // callId -> call
const activeByUser = new Map();      // userId -> callId
// An answered call survives a dropped connection this long while the person reconnects.
const RECONNECT_GRACE_MS = Number(process.env.CALL_RECONNECT_GRACE_MS) || 45000;

function clearCall(call) {
  if (call.graceTimer) clearTimeout(call.graceTimer);
  call.graceTimer = null;
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

// An answered call lost one side's connection: keep it alive for a while instead of ending it.
function startGrace(call, role) {
  call.offline = call.offline || { caller: false, callee: false };
  call.offline[role] = true;
  const otherCaller = role === 'callee';
  emitToSocket(otherCaller ? call.callerId : call.calleeId, otherCaller ? call.callerSocketId : call.calleeSocketId, 'call:peer-lost', { callId: call.id });
  if (call.graceTimer) return;
  call.graceTimer = setTimeout(async () => {
    if (!calls.has(call.id)) return;
    const offline = call.offline || {};
    clearCall(call);
    const payload = { callId: call.id, reason: 'connection-lost' };
    if (!offline.caller) await emitToSocket(call.callerId, call.callerSocketId, 'call:ended', payload);
    if (!offline.callee) await emitToSocket(call.calleeId, call.calleeSocketId, 'call:ended', payload);
  }, RECONNECT_GRACE_MS);
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

  // After a network drop the client reconnects with a new socket id: re-attach it to its live call.
  socket.on('call:rejoin', async ({ callId } = {}) => {
    const call = calls.get(callId);
    const isCaller = !!call && call.callerId === userId;
    const isCallee = !!call && call.calleeId === userId;
    if (!call || !call.calleeSocketId || (!isCaller && !isCallee)) return socket.emit('call:rejoin-failed', { callId });
    const role = isCaller ? 'caller' : 'callee';
    if (isCaller) call.callerSocketId = socket.id; else call.calleeSocketId = socket.id;
    if (call.offline) call.offline[role] = false;
    if (!call.offline || (!call.offline.caller && !call.offline.callee)) {
      if (call.graceTimer) clearTimeout(call.graceTimer);
      call.graceTimer = null;
    }
    const peerOnline = !(call.offline && call.offline[isCaller ? 'callee' : 'caller']);
    socket.emit('call:rejoined', { callId: call.id, role, peerOnline });
    if (peerOnline) {
      await emitToSocket(isCaller ? call.calleeId : call.callerId, isCaller ? call.calleeSocketId : call.callerSocketId, 'call:peer-back', { callId: call.id });
    }
  });

  // The callee noticed the media path died; only the caller (offerer) can restart ICE.
  socket.on('call:restart-request', ({ callId } = {}) => { relay(callId, 'call:restart-request', {}, 'callee'); });

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
    if (call.calleeSocketId) { startGrace(call, socket.id === call.callerSocketId ? 'caller' : 'callee'); return; }
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
