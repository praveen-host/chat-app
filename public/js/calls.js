/* One-to-one voice and video calling using WebRTC; Socket.IO carries signaling only. */
let activeCall = null;
let callPeerConnection = null;
let callLocalStream = null;
let callTimeout = null;
let pendingIceCandidates = [];
let ringtoneContext = null;
let ringtoneTimer = null;
let speakerMuted = false;
let microphoneMuted = false;
let cameraOff = false;
let pendingNotificationAction = null;

// The server can supply TURN credentials through /api/call-config. STUN alone
// cannot establish media paths on every NAT/firewall; TURN is the fallback.
let callIceConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  iceCandidatePoolSize: 10
};
let callIceConfigLoaded = false;
let callConnectionTimer = null;
async function loadCallIceConfig() {
  if (callIceConfigLoaded) return;
  callIceConfigLoaded = true;
  try {
    const response = await fetch('/api/call-config', { cache: 'no-store' });
    if (!response.ok) return;
    const config = await response.json();
    if (Array.isArray(config.iceServers) && config.iceServers.length) {
      callIceConfig = { ...callIceConfig, iceServers: [...callIceConfig.iceServers, ...config.iceServers] };
    }
  } catch (error) {
    console.warn('Could not load optional TURN configuration:', error);
  }
}

function callPeerName(id) {
  return users.find(u => u.id === Number(id))?.displayName || 'Contact';
}
function setCallStatus(text) {
  const el = $('callStatus');
  if (el) el.textContent = text;
}
function showCallUi({ incoming = false } = {}) {
  $('callOverlay').style.display = 'flex';
  $('callOverlay').classList.add('call-active');
  $('callAccept').style.display = incoming ? '' : 'none';
  $('callReject').style.display = incoming ? '' : 'none';
  $('callMute').style.display = incoming ? 'none' : '';
  $('callEnd').style.display = incoming ? 'none' : '';
  $('callTitle').textContent = activeCall ? callPeerName(activeCall.peerId) : 'Voice call';
  // Video elements only appear for video calls, and only once our own camera is live.
  const isVideo = !!activeCall?.video;
  const showVideo = isVideo && !incoming;
  $('callVideo').style.display = showVideo ? '' : 'none';
  $('callCamera').style.display = showVideo ? '' : 'none';
  $('callOverlay').classList.toggle('call-video', showVideo);
}
function stopRingtone() {
  if (ringtoneTimer) clearInterval(ringtoneTimer);
  ringtoneTimer = null;
  // Keep the audio context unlocked for the next incoming call.
}
function playRingtoneTone() {
  if (!ringtoneContext || ringtoneContext.state !== 'running') return;
  try {
    const osc = ringtoneContext.createOscillator();
    const gain = ringtoneContext.createGain();
    osc.type = 'sine'; osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ringtoneContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ringtoneContext.currentTime + 0.03);
    gain.gain.setValueAtTime(0.12, ringtoneContext.currentTime + 0.22);
    gain.gain.exponentialRampToValueAtTime(0.0001, ringtoneContext.currentTime + 0.28);
    osc.connect(gain); gain.connect(ringtoneContext.destination);
    osc.start(); osc.stop(ringtoneContext.currentTime + 0.3);
  } catch (_) {}
}
async function unlockCallAudio() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!ringtoneContext || ringtoneContext.state === 'closed') ringtoneContext = new AudioCtx();
    if (ringtoneContext.state === 'suspended') await ringtoneContext.resume();
  } catch (_) {}
}
async function startRingtone() {
  stopRingtone();
  await unlockCallAudio();
  playRingtoneTone();
  ringtoneTimer = setInterval(playRingtoneTone, 900);
}
// Unlock Web Audio during an ordinary user gesture so later incoming calls can ring.
document.addEventListener('pointerdown', () => { unlockCallAudio(); }, { once: true });
document.addEventListener('keydown', () => { unlockCallAudio(); }, { once: true });
function clearCallTimer() {
  if (callTimeout) clearTimeout(callTimeout);
  callTimeout = null;
}
function cleanupVoiceCall() {
  clearCallTimer();
  if (callConnectionTimer) clearTimeout(callConnectionTimer);
  callConnectionTimer = null;
  stopRingtone();
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
  for (const id of ['remoteCallVideo', 'localCallVideo']) {
    const v = $(id);
    if (v) { v.pause(); v.srcObject = null; }
  }
  $('callVideo').style.display = 'none';
  $('callCamera').style.display = 'none';
  $('callCamera').textContent = 'Camera off';
  cameraOff = false;
  $('callOverlay').classList.remove('call-video');
  $('callOverlay').style.display = 'none';
  $('callOverlay').classList.remove('call-active');
  $('callMute').textContent = 'Mute mic';
  $('callSpeaker').textContent = 'Mute speaker';
  speakerMuted = false; microphoneMuted = false;
}
function friendlyMediaError(error, wantVideo) {
  const what = wantVideo ? 'camera and microphone' : 'microphone';
  const map = {
    NotAllowedError: `Permission to use the ${what} was denied. Allow it in your browser's site settings, then try again.`,
    NotFoundError: `No ${what} was found on this device.`,
    NotReadableError: `The ${what} is being used by another app. Close it and try again.`,
    SecurityError: 'Calls need HTTPS. Open this app using its https:// address.'
  };
  return new Error(map[error?.name] || `Could not start the ${what} (${error?.name || 'unknown error'}).`);
}
async function ensureCallMedia() {
  if (callLocalStream) return callLocalStream;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Calls need HTTPS. Open this app using its https:// address (not http:// or a plain IP) and try again.');
  }
  const wantVideo = !!activeCall?.video;
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    callLocalStream = await navigator.mediaDevices.getUserMedia({
      audio,
      // Modest size keeps phones and mobile networks happy.
      video: wantVideo ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } : false
    });
  } catch (error) {
    // Some phones reject specific constraints; retry with the simplest request.
    if (wantVideo && ['OverconstrainedError', 'NotFoundError'].includes(error.name)) {
      try { callLocalStream = await navigator.mediaDevices.getUserMedia({ audio, video: true }); }
      catch (retryError) { throw friendlyMediaError(retryError, wantVideo); }
    } else throw friendlyMediaError(error, wantVideo);
  }
  if (wantVideo) {
    const local = $('localCallVideo');
    if (local) { local.srcObject = callLocalStream; local.play().catch(() => {}); }
  }
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
    // Sound always plays through the existing audio element (so speaker-mute keeps working);
    // the remote <video> is muted and only shows the picture.
    if (activeCall?.video) {
      const remote = $('remoteCallVideo');
      if (remote) { remote.srcObject = event.streams[0]; remote.play().catch(() => setCallStatus('Tap the video to start playback')); }
    }
  };
  callPeerConnection.onconnectionstatechange = () => {
    if (!callPeerConnection || !activeCall) return;
    const state = callPeerConnection.connectionState;
    if (state === 'connected') {
      if (callConnectionTimer) clearTimeout(callConnectionTimer);
      callConnectionTimer = null;
      setCallStatus('Connected');
    } else if (state === 'connecting') setCallStatus('Connecting…');
    else if (state === 'failed') setCallStatus('Connection failed. Configure TURN or try another network.');
    else if (state === 'disconnected') setCallStatus('Connection interrupted…');
  };
  callPeerConnection.oniceconnectionstatechange = () => {
    if (!callPeerConnection || !activeCall) return;
    const state = callPeerConnection.iceConnectionState;
    if (state === 'checking') setCallStatus('Finding audio connection…');
    if (state === 'failed') setCallStatus('Network path failed. A TURN server may be required.');
  };
  return callPeerConnection;
}

function startVoiceCall() { return startCall(false); }
function startVideoCall() { return startCall(true); }

async function startCall(video) {
  await unlockCallAudio();
  await loadCallIceConfig();
  if (!peer || !socket?.connected) return alert('Open a chat and connect to the server first.');
  if (activeCall) return;
  if (!online.has(peer)) return alert('This user is offline. Try again when they are active.');
  activeCall = { peerId: peer, role: 'caller', status: 'outgoing', callId: null, video: !!video };
  showCallUi();
  setCallStatus('Calling…');
  socket.emit('call:initiate', { to: peer, video: !!video });
  callTimeout = setTimeout(() => {
    if (activeCall?.role === 'caller' && activeCall.status === 'outgoing') {
      socket.emit('call:end', { callId: activeCall.callId, reason: 'no-answer' });
      cleanupVoiceCall();
    }
  }, 30000);
}

async function acceptVoiceCall() {
  stopRingtone();
  await unlockCallAudio();
  await loadCallIceConfig();
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
  microphoneMuted = !shouldEnable;
  $('callMute').textContent = shouldEnable ? 'Mute mic' : 'Unmute mic';
  setCallStatus(shouldEnable ? (speakerMuted ? 'Connected — speaker muted' : 'Connected') : 'Microphone muted');
}

function toggleCallCamera() {
  if (!callLocalStream) return;
  const tracks = callLocalStream.getVideoTracks();
  if (!tracks.length) return;
  const shouldEnable = tracks.some(track => !track.enabled);
  tracks.forEach(track => { track.enabled = shouldEnable; });
  cameraOff = !shouldEnable;
  $('callCamera').textContent = shouldEnable ? 'Camera off' : 'Camera on';
}

function toggleSpeakerMute() {
  const audio = $('remoteCallAudio');
  if (!audio) return;
  speakerMuted = !speakerMuted;
  audio.muted = speakerMuted;
  $('callSpeaker').textContent = speakerMuted ? 'Unmute speaker' : 'Mute speaker';
  setCallStatus(speakerMuted ? 'Speaker muted' : (microphoneMuted ? 'Microphone muted' : 'Connected'));
}
function handleCallNotificationAction(action, callId) {
  if (!['accept', 'reject'].includes(action)) return;
  if (!activeCall || activeCall.callId !== callId) {
    pendingNotificationAction = { action, callId };
    return;
  }
  if (action === 'accept') acceptVoiceCall(); else rejectVoiceCall();
}
function processPendingCallAction() {
  const action = pendingNotificationAction || window.__pendingCallNotificationAction;
  if (!action || !activeCall || activeCall.callId !== action.callId) return;
  pendingNotificationAction = null;
  window.__pendingCallNotificationAction = null;
  setTimeout(() => handleCallNotificationAction(action.action, action.callId), 100);
}

function initCallEvents() {
  loadCallIceConfig(); // preload TURN config so tapping Accept goes straight to the camera prompt
  socket.on('call:incoming', ({ callId, from, video }) => {
    if (activeCall) {
      socket.emit('call:reject', { callId });
      return;
    }
    activeCall = { callId, peerId: Number(from), role: 'callee', status: 'incoming', video: video === true };
    showCallUi({ incoming: true });
    setCallStatus(activeCall.video ? 'Incoming video call…' : 'Incoming voice call…');
    startRingtone();
    processPendingCallAction();
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
      alert(error.message || 'Could not start the call.');
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
  socket.on('call:unavailable', () => { pendingNotificationAction = null; window.__pendingCallNotificationAction = null; cleanupVoiceCall(); alert('This call has expired or is no longer available.'); });
  socket.on('call:busy', () => { alert('You or the other user is already in a call.'); cleanupVoiceCall(); });
  socket.on('call:offline', () => { alert('This user is offline.'); cleanupVoiceCall(); });
  socket.on('call:error', ({ message }) => { alert(message || 'Call could not be started.'); cleanupVoiceCall(); });
  socket.on('call:ended', ({ reason }) => {
    if (reason === 'no-answer') setCallStatus('No answer');
    cleanupVoiceCall();
  });
  socket.on('disconnect', () => { if (activeCall) cleanupVoiceCall(); });
}
