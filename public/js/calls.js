/* One-to-one voice calling using WebRTC; Socket.IO carries signaling only. */
let activeCall = null;
let callPeerConnection = null;
let callLocalStream = null;
let callTimeout = null;
let pendingIceCandidates = [];

const callIceConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

function callPeerName(id) {
  return users.find(u => u.id === Number(id))?.displayName || 'Contact';
}
function setCallStatus(text) {
  const el = $('callStatus');
  if (el) el.textContent = text;
}
function showCallUi({ incoming = false } = {}) {
  $('callOverlay').style.display = 'flex';
  $('callAccept').style.display = incoming ? '' : 'none';
  $('callReject').style.display = incoming ? '' : 'none';
  $('callMute').style.display = incoming ? 'none' : '';
  $('callEnd').style.display = incoming ? 'none' : '';
  $('callTitle').textContent = activeCall ? callPeerName(activeCall.peerId) : 'Voice call';
}
function clearCallTimer() {
  if (callTimeout) clearTimeout(callTimeout);
  callTimeout = null;
}
function cleanupVoiceCall() {
  clearCallTimer();
  if (callPeerConnection) {
    callPeerConnection.ontrack = null;
    callPeerConnection.onicecandidate = null;
    callPeerConnection.onconnectionstatechange = null;
    callPeerConnection.close();
  }
  callPeerConnection = null;
  pendingIceCandidates = [];
  if (callLocalStream) callLocalStream.getTracks().forEach(track => track.stop());
  callLocalStream = null;
  const audio = $('remoteCallAudio');
  if (audio) { audio.pause(); audio.srcObject = null; }
  activeCall = null;
  $('callOverlay').style.display = 'none';
  $('callMute').textContent = 'Mute';
}
async function ensureCallMedia() {
  if (callLocalStream) return callLocalStream;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires a supported browser and HTTPS.');
  callLocalStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false
  });
  return callLocalStream;
}
function ensurePeerConnection() {
  if (callPeerConnection) return callPeerConnection;
  callPeerConnection = new RTCPeerConnection(callIceConfig);
  callLocalStream.getTracks().forEach(track => callPeerConnection.addTrack(track, callLocalStream));
  callPeerConnection.onicecandidate = event => {
    if (event.candidate && activeCall && socket?.connected) {
      socket.emit('call:ice', { callId: activeCall.callId, candidate: event.candidate });
    }
  };
  callPeerConnection.ontrack = event => {
    const audio = $('remoteCallAudio');
    audio.srcObject = event.streams[0];
    audio.play().catch(() => setCallStatus('Connected — tap the page if audio is blocked'));
  };
  callPeerConnection.onconnectionstatechange = () => {
    if (!callPeerConnection || !activeCall) return;
    const state = callPeerConnection.connectionState;
    if (state === 'connected') setCallStatus('Connected');
    else if (state === 'connecting') setCallStatus('Connecting…');
    else if (state === 'failed') setCallStatus('Connection failed. Check network/TURN settings.');
    else if (state === 'disconnected') setCallStatus('Connection interrupted…');
  };
  return callPeerConnection;
}

async function startVoiceCall() {
  if (!peer || !socket?.connected) return alert('Open a chat and connect to the server first.');
  if (activeCall) return;
  if (!online.has(peer)) return alert('This user is offline. Try again when they are active.');
  activeCall = { peerId: peer, role: 'caller', status: 'outgoing', callId: null };
  showCallUi();
  setCallStatus('Calling…');
  socket.emit('call:initiate', { to: peer });
  callTimeout = setTimeout(() => {
    if (activeCall?.role === 'caller' && activeCall.status === 'outgoing') {
      socket.emit('call:end', { callId: activeCall.callId, reason: 'no-answer' });
      cleanupVoiceCall();
    }
  }, 30000);
}

async function acceptVoiceCall() {
  if (!activeCall || activeCall.role !== 'callee' || activeCall.status !== 'incoming') return;
  try {
    await ensureCallMedia();
    activeCall.status = 'connecting';
    showCallUi();
    setCallStatus('Connecting…');
    socket.emit('call:accept', { callId: activeCall.callId });
  } catch (error) {
    alert(error.message || 'Could not access your microphone. Check browser permissions.');
    socket.emit('call:reject', { callId: activeCall.callId });
    cleanupVoiceCall();
  }
}
function rejectVoiceCall() {
  if (activeCall?.callId) socket.emit('call:reject', { callId: activeCall.callId });
  cleanupVoiceCall();
}
function endVoiceCall() {
  if (activeCall?.callId && socket?.connected) socket.emit('call:end', { callId: activeCall.callId, reason: 'hangup' });
  cleanupVoiceCall();
}
function toggleCallMute() {
  if (!callLocalStream) return;
  const tracks = callLocalStream.getAudioTracks();
  const shouldEnable = tracks.some(track => !track.enabled);
  tracks.forEach(track => { track.enabled = shouldEnable; });
  $('callMute').textContent = shouldEnable ? 'Mute' : 'Unmute';
  setCallStatus(shouldEnable ? 'Connected' : 'Microphone muted');
}

function initCallEvents() {
  socket.on('call:incoming', ({ callId, from }) => {
    if (activeCall) {
      socket.emit('call:reject', { callId });
      return;
    }
    activeCall = { callId, peerId: Number(from), role: 'callee', status: 'incoming' };
    showCallUi({ incoming: true });
    setCallStatus('Incoming voice call…');
  });
  socket.on('call:ringing', ({ callId, to }) => {
    if (!activeCall || activeCall.role !== 'caller') return;
    activeCall.callId = callId;
    activeCall.peerId = Number(to);
    setCallStatus('Ringing…');
  });
  socket.on('call:accepted', async ({ callId }) => {
    if (!activeCall || activeCall.role !== 'caller' || activeCall.callId !== callId) return;
    clearCallTimer();
    activeCall.status = 'connecting';
    try {
      await ensureCallMedia();
      const pc = ensurePeerConnection();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call:offer', { callId, offer: pc.localDescription });
      setCallStatus('Connecting…');
    } catch (error) {
      setCallStatus(error.message || 'Could not start microphone.');
      endVoiceCall();
    }
  });
  socket.on('call:offer', async ({ callId, offer }) => {
    if (!activeCall || activeCall.role !== 'callee' || activeCall.callId !== callId || !callLocalStream) return;
    try {
      const pc = ensurePeerConnection();
      await pc.setRemoteDescription(offer);
      for (const candidate of pendingIceCandidates.splice(0)) {
        try { await pc.addIceCandidate(candidate); } catch (error) { console.warn('Could not add queued ICE candidate:', error); }
      }
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('call:answer', { callId, answer: pc.localDescription });
    } catch (error) {
      setCallStatus('Could not establish the call.');
      endVoiceCall();
    }
  });
  socket.on('call:answer', async ({ callId, answer }) => {
    if (!activeCall || activeCall.role !== 'caller' || activeCall.callId !== callId || !callPeerConnection) return;
    try {
      await callPeerConnection.setRemoteDescription(answer);
      for (const candidate of pendingIceCandidates.splice(0)) {
        try { await callPeerConnection.addIceCandidate(candidate); } catch (error) { console.warn('Could not add queued ICE candidate:', error); }
      }
    } catch { setCallStatus('Could not establish the call.'); endVoiceCall(); }
  });

  socket.on('call:ice', async ({ callId, candidate }) => {
    if (!activeCall || activeCall.callId !== callId || !candidate) {
      return;
    }

    // ICE can arrive before the peer connection or remote
    // description is ready. Keep it until it can be applied.
    if (!callPeerConnection || !callPeerConnection.remoteDescription) {
      pendingIceCandidates.push(candidate);
      return;
    }

    try {
      await callPeerConnection.addIceCandidate(candidate);
    } catch (error) {
      console.warn('Could not add ICE candidate:', error);
    }
  });

  socket.on('call:rejected', () => { setCallStatus('Call declined'); cleanupVoiceCall(); });
  socket.on('call:busy', () => { alert('You or the other user is already in a call.'); cleanupVoiceCall(); });
  socket.on('call:offline', () => { alert('This user is offline.'); cleanupVoiceCall(); });
  socket.on('call:error', ({ message }) => { alert(message || 'Call could not be started.'); cleanupVoiceCall(); });
  socket.on('call:ended', ({ reason }) => {
    if (reason === 'no-answer') setCallStatus('No answer');
    cleanupVoiceCall();
  });
  socket.on('disconnect', () => { if (activeCall) cleanupVoiceCall(); });
}
