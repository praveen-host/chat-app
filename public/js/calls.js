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
let cameraFacing = 'user';
let canFlipCamera = false;
let callStartedAt = 0;
let callTimerInterval = null;
let callUiTimer = null;
let callNoticeTimer = null;
let callUiBound = false;
const CALL_FULLSCREEN_MQ = '(max-width: 700px), (pointer: coarse) and (max-height: 500px)';
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
// ---- reconnection ----
const CALL_RECONNECT_GIVE_UP_MS = 60000;
let callReconnecting = false;
let callReconnectStartedAt = 0;
let callReconnectTimer = null;
let callDisconnectTimer = null;
let callRestartingIce = false;
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
  if (el) { el.textContent = text; el.dataset.state = text === 'Connected' ? 'ok' : ''; }
}
function showCallUi({ incoming = false } = {}) {
  $('callOverlay').style.display = 'flex';
  $('callOverlay').classList.add('call-active');
  $('callAccept').style.display = incoming ? '' : 'none';
  $('callReject').style.display = incoming ? '' : 'none';
  $('callMute').style.display = incoming ? 'none' : '';
  $('callEnd').style.display = incoming ? 'none' : '';
  $('callMsg').style.display = incoming ? '' : 'none';
  if (!incoming) hideQuickReplies();
  $('callTitle').textContent = activeCall ? callPeerName(activeCall.peerId) : 'Voice call';
  // Video elements only appear for video calls, and only once our own camera is live.
  const isVideo = !!activeCall?.video;
  const showVideo = isVideo && !incoming;
  $('callVideo').style.display = showVideo ? '' : 'none';
  $('callOverlay').classList.toggle('call-video', showVideo);
  $('callOverlay').classList.toggle('call-vid', isVideo);       // phone full-screen layout hooks
  $('callOverlay').classList.toggle('call-incoming', !!incoming);
  updateVideoControls();
  paintCallAvatar();
}

function isFullscreenVideoCall() {
  return !!activeCall?.video && window.matchMedia(CALL_FULLSCREEN_MQ).matches;
}
function paintCallAvatar() {
  const box = $('callAvatar');
  if (!box || !activeCall?.video) return;
  const u = users.find(x => x.id === Number(activeCall.peerId));
  try {
    if (u && typeof avEl === 'function') {
      box.replaceChildren(avEl(u, window.matchMedia(CALL_FULLSCREEN_MQ).matches ? 112 : 56, false));
      box.classList.add('has-photo');
    }
  } catch (_) { /* keep the default glyph */ }
}
function setCallBtn(id, label, icon, off) {
  const b = $(id);
  if (!b) return;
  const tx = b.querySelector('.tx'), ic = b.querySelector('.ic');
  if (tx) tx.textContent = label;
  if (ic && icon) ic.textContent = icon;
  b.classList.toggle('is-off', !!off);
}
function updateVideoControls() {
  const hasCam = !!callLocalStream && callLocalStream.getVideoTracks().length > 0;
  const live = !!activeCall?.video && activeCall.status !== 'incoming' && hasCam;
  $('callCamera').style.display = live ? '' : 'none';
  $('callFlip').style.display = live && canFlipCamera ? '' : 'none';
}
function showCallNotice(text) {
  const el = $('callNotice');
  if (!el) return;
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(callNoticeTimer);
  callNoticeTimer = setTimeout(() => el.classList.remove('show'), 5000);
}

// ---- call timer ----
function formatCallTime(ms) {
  const t = Math.floor(ms / 1000), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  const mm = String(m).padStart(2, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function startCallTimer() {
  if (callTimerInterval) return; // a reconnect must not restart the clock
  callStartedAt = Date.now();
  const tick = () => { $('callTimer').textContent = formatCallTime(Date.now() - callStartedAt); };
  tick();
  $('callOverlay').classList.add('call-has-timer');
  callTimerInterval = setInterval(tick, 1000);
}
function stopCallTimer() {
  if (callTimerInterval) clearInterval(callTimerInterval);
  callTimerInterval = null;
  const t = $('callTimer');
  if (t) t.textContent = '';
  $('callOverlay').classList.remove('call-has-timer');
}

// ---- phone full-screen call: tap to hide/show controls, drag the self-view ----
function armCallUiHide() {
  clearTimeout(callUiTimer);
  $('callOverlay').classList.remove('call-ui-hidden');
  if (!isFullscreenVideoCall()) return;
  callUiTimer = setTimeout(() => {
    if (isFullscreenVideoCall() && callPeerConnection?.connectionState === 'connected') {
      $('callOverlay').classList.add('call-ui-hidden');
    }
  }, 5000);
}
function toggleCallUi() {
  if (!isFullscreenVideoCall()) return;
  const overlay = $('callOverlay');
  if (overlay.classList.contains('call-ui-hidden')) armCallUiHide();
  else { clearTimeout(callUiTimer); overlay.classList.add('call-ui-hidden'); }
}
function bindCallUi() {
  if (callUiBound) return;
  callUiBound = true;
  $('callVideo').addEventListener('click', toggleCallUi);
  document.querySelector('#callOverlay .call-actions').addEventListener('click', armCallUiHide);
  const pip = $('localCallVideo'), box = $('callVideo');
  let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;
  pip.addEventListener('click', e => e.stopPropagation());
  pip.addEventListener('pointerdown', e => {
    if (!isFullscreenVideoCall()) return;
    dragging = true; moved = false;
    const r = pip.getBoundingClientRect(), b = box.getBoundingClientRect();
    sx = e.clientX; sy = e.clientY; ox = r.left - b.left; oy = r.top - b.top;
    try { pip.setPointerCapture(e.pointerId); } catch (_) {}
  });
  pip.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true;
    if (!moved) return;
    const r = pip.getBoundingClientRect(), b = box.getBoundingClientRect();
    const x = Math.min(Math.max(ox + dx, 6), b.width - r.width - 6);
    const y = Math.min(Math.max(oy + dy, 6), b.height - r.height - 6);
    pip.style.left = x + 'px'; pip.style.top = y + 'px';
    pip.style.right = 'auto'; pip.style.bottom = 'auto';
  });
  const stop = () => { dragging = false; };
  pip.addEventListener('pointerup', stop);
  pip.addEventListener('pointercancel', stop);
}
function stopRingtone() {
  try { navigator.vibrate?.(0); } catch (_) {}
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
  try { navigator.vibrate?.([400, 200, 400, 200, 400]); } catch (_) {}
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
  endReconnecting();
  if (callDisconnectTimer) clearTimeout(callDisconnectTimer);
  callDisconnectTimer = null;
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
  $('callFlip').style.display = 'none';
  setCallBtn('callCamera', 'Camera off', '📹', false);
  cameraOff = false; cameraFacing = 'user'; canFlipCamera = false;
  stopCallTimer();
  clearTimeout(callUiTimer); clearTimeout(callNoticeTimer);
  $('callNotice').classList.remove('show');
  const pipEl = $('localCallVideo');
  if (pipEl) { pipEl.style.cssText = ''; pipEl.classList.remove('rear'); }
  const av = $('callAvatar');
  if (av) { av.textContent = '☎'; av.classList.remove('has-photo'); }
  hideQuickReplies();
  $('callOverlay').classList.remove('call-reconnecting', 'call-video', 'call-vid', 'call-incoming', 'call-has-remote', 'call-ui-hidden');
  $('callOverlay').style.display = 'none';
  $('callOverlay').classList.remove('call-active');
  setCallBtn('callMute', 'Mute mic', '🎤', false);
  setCallBtn('callSpeaker', 'Mute speaker', '🔊', false);
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
  const gum = c => navigator.mediaDevices.getUserMedia(c);
  const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  try {
    callLocalStream = await gum({
      audio,
      // Modest size keeps phones and mobile networks happy.
      video: wantVideo ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } } : false
    });
  } catch (error) {
    if (!wantVideo) throw friendlyMediaError(error, false);
    try {
      callLocalStream = await gum({ audio, video: true });            // simplest camera request
    } catch (_) {
      try {
        callLocalStream = await gum({ audio, video: false });         // no usable camera: join with audio only
        showCallNotice('Camera unavailable — joined with audio only');
      } catch (audioError) {
        throw friendlyMediaError(error?.name === 'NotAllowedError' ? error : audioError, true);
      }
    }
  }
  const hasVideo = callLocalStream.getVideoTracks().length > 0;
  if (wantVideo) {
    const local = $('localCallVideo');
    if (local) {
      local.style.display = hasVideo ? '' : 'none';
      if (hasVideo) { local.srcObject = callLocalStream; local.play().catch(() => {}); }
    }
    if (hasVideo) {
      navigator.mediaDevices.enumerateDevices()
        .then(list => { canFlipCamera = list.filter(d => d.kind === 'videoinput').length > 1; updateVideoControls(); })
        .catch(() => {});
    }
  }
  updateVideoControls();
  return callLocalStream;
}
// Which route is the media taking? 'relay' means it goes through the TURN server (diagnostics only).
async function reportCallPath() {
  try {
    const pc = callPeerConnection;
    const stats = await pc.getStats();
    let pair = null;
    stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
    if (!pair) stats.forEach(r => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
    const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId);
    const path = (local?.candidateType === 'relay' || remote?.candidateType === 'relay') ? 'relay' : (local?.candidateType || 'unknown');
    window.__lastCallPath = path;
    console.info('[call] media path:', path);
    if (path === 'relay') showCallNotice('Connected through the relay server');
  } catch (_) { /* never affects the call */ }
}

// ---- surviving a network drop ----
function callMediaState() { return callPeerConnection?.connectionState; }

// Caller only: ask for a fresh network path on the same peer connection (no new call, no new permissions).
async function restartIce() {
  if (!activeCall?.answered || activeCall.role !== 'caller' || !callPeerConnection || !socket?.connected || callRestartingIce) return;
  callRestartingIce = true;
  try {
    const pc = callPeerConnection;
    const offer = await pc.createOffer({ iceRestart: true });
    await pc.setLocalDescription(offer);
    socket.emit('call:offer', { callId: activeCall.callId, offer: pc.localDescription });
  } catch (error) {
    console.warn('ICE restart failed:', error);
  } finally {
    callRestartingIce = false;
  }
}
// Callee or caller: get the media path moving again.
function nudgeReconnect() {
  if (!activeCall?.answered || !socket?.connected) return;
  if (activeCall.role === 'caller') restartIce();
  else socket.emit('call:restart-request', { callId: activeCall.callId });
}
function beginReconnecting() {
  if (!activeCall?.answered || callReconnecting) return;
  callReconnecting = true;
  callReconnectStartedAt = Date.now();
  $('callOverlay').classList.add('call-reconnecting');
  setCallStatus('Reconnecting…');
  callReconnectTimer = setInterval(() => {
    if (!activeCall) return endReconnecting();
    if (Date.now() - callReconnectStartedAt > CALL_RECONNECT_GIVE_UP_MS) {
      if (socket?.connected && activeCall.callId) socket.emit('call:end', { callId: activeCall.callId, reason: 'connection-lost' });
      setCallStatus('Call ended — connection lost');
      return cleanupVoiceCall();
    }
    if (socket && !socket.connected) socket.connect();
    nudgeReconnect();
  }, 8000);
}
function endReconnecting() {
  if (callReconnectTimer) clearInterval(callReconnectTimer);
  callReconnectTimer = null;
  callReconnecting = false;
  const overlay = $('callOverlay');
  if (overlay) overlay.classList.remove('call-reconnecting');
}

function ensurePeerConnection() {
  if (callPeerConnection) return callPeerConnection;
  callPeerConnection = new RTCPeerConnection(callIceConfig);
  callLocalStream.getTracks().forEach(track => callPeerConnection.addTrack(track, callLocalStream));
  if (activeCall?.video && activeCall.role === 'caller' && !callLocalStream.getVideoTracks().length) {
    callPeerConnection.addTransceiver('video', { direction: 'recvonly' });
  }
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
      if (event.track.kind === 'video') $('callOverlay').classList.add('call-has-remote');
    }
  };
  callPeerConnection.onconnectionstatechange = () => {
    if (!callPeerConnection || !activeCall) return;
    const state = callPeerConnection.connectionState;
    if (state === 'connected') {
      if (callConnectionTimer) clearTimeout(callConnectionTimer);
      callConnectionTimer = null;
      if (callDisconnectTimer) clearTimeout(callDisconnectTimer);
      callDisconnectTimer = null;
      endReconnecting();
      setCallStatus('Connected');
      reportCallPath();
      startCallTimer();
      armCallUiHide();
    } else if (state === 'connecting') { if (!callReconnecting) setCallStatus('Connecting…'); }
    else if (state === 'failed') {
      if (activeCall.answered) { beginReconnecting(); nudgeReconnect(); }
      else setCallStatus('Connection failed. Configure TURN or try another network.');
    } else if (state === 'disconnected') {
      setCallStatus('Connection interrupted…');
      // Brief blips often heal by themselves; if not within 3s, start reconnecting.
      if (activeCall.answered && !callDisconnectTimer) {
        callDisconnectTimer = setTimeout(() => {
          callDisconnectTimer = null;
          if (activeCall && callMediaState() !== 'connected') { beginReconnecting(); nudgeReconnect(); }
        }, 3000);
      }
    }
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
    activeCall.answered = true;
    socket.emit('call:accept', { callId: activeCall.callId });
  } catch (error) {
    alert(error.message || 'Could not access your microphone. Check browser permissions.');
    socket.emit('call:reject', { callId: activeCall.callId });
    cleanupVoiceCall();
  }
}
// ---- decline with a message (quick replies) ----
const CALL_QUICK_REPLIES = ["Can't talk right now", "I'll call you back", 'Call me later', "I'm in a meeting"];
function hideQuickReplies() { const q = $('callQuick'); if (q) { q.classList.remove('show'); q.replaceChildren(); } }
function toggleQuickReplies() {
  const box = $('callQuick');
  if (!box || !activeCall || activeCall.status !== 'incoming') return;
  if (box.classList.contains('show')) return hideQuickReplies();
  const chips = [...CALL_QUICK_REPLIES, 'Write your own…'].map((text, i) => {
    const b = document.createElement('button');
    b.className = 'ghost'; b.type = 'button'; b.textContent = text;
    b.onclick = () => declineWithMessage(i < CALL_QUICK_REPLIES.length ? text : '');
    return b;
  });
  box.replaceChildren(...chips);
  box.classList.add('show');
}
function sendQuickReply(target, body) {
  const entry = { cid: newId(), to: Number(target), body, mine: true, ts: new Date().toISOString(), status: 'sending', reply: null, retryable: true };
  (history[target] ||= []).push(entry);
  if (peer === Number(target)) renderChat(true);
  transmitMessage(entry, Number(target));
}
function declineWithMessage(text) {
  if (!activeCall?.callId) return;
  const target = activeCall.peerId;
  rejectVoiceCall();
  if (text) { sendQuickReply(target, text); return; }
  openChat(Number(target));                       // "Write your own…": open the chat, call already declined
  setTimeout(() => { const t = $('text'); if (t) t.focus(); }, 150);
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
  setCallBtn('callMute', shouldEnable ? 'Mute mic' : 'Unmute mic', shouldEnable ? '🎤' : '🔇', !shouldEnable);
  setCallStatus(shouldEnable ? (speakerMuted ? 'Connected — speaker muted' : 'Connected') : 'Microphone muted');
}

function toggleCallCamera() {
  if (!callLocalStream) return;
  const tracks = callLocalStream.getVideoTracks();
  if (!tracks.length) return;
  const shouldEnable = tracks.some(track => !track.enabled);
  tracks.forEach(track => { track.enabled = shouldEnable; });
  cameraOff = !shouldEnable;
  setCallBtn('callCamera', shouldEnable ? 'Camera off' : 'Camera on', shouldEnable ? '📹' : '🚫', !shouldEnable);
}

async function switchCamera() {
  if (!callLocalStream) return;
  const old = callLocalStream.getVideoTracks()[0];
  if (!old) return;
  const next = cameraFacing === 'user' ? 'environment' : 'user';
  const open = facing => navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }
  });
  old.stop(); // many phones cannot open two cameras at once
  let track = null, facing = next;
  try {
    track = (await open(next)).getVideoTracks()[0];
  } catch (_) {
    try { facing = cameraFacing; track = (await open(cameraFacing)).getVideoTracks()[0]; }
    catch (error) { showCallNotice('Could not switch camera'); return; }
  }
  track.enabled = !cameraOff;
  const sender = callPeerConnection?.getSenders().find(x => x.track === old || x.track?.kind === 'video');
  if (sender) await sender.replaceTrack(track).catch(() => {});
  callLocalStream.removeTrack(old);
  callLocalStream.addTrack(track);
  cameraFacing = facing;
  const local = $('localCallVideo');
  local.srcObject = callLocalStream;
  local.classList.toggle('rear', facing === 'environment'); // only the front camera is mirrored
  local.play().catch(() => {});
}

function toggleSpeakerMute() {
  const audio = $('remoteCallAudio');
  if (!audio) return;
  speakerMuted = !speakerMuted;
  audio.muted = speakerMuted;
  setCallBtn('callSpeaker', speakerMuted ? 'Unmute speaker' : 'Mute speaker', speakerMuted ? '🔈' : '🔊', speakerMuted);
  setCallStatus(speakerMuted ? 'Speaker muted' : (microphoneMuted ? 'Microphone muted' : 'Connected'));
}
function handleCallNotificationAction(action, callId) {
  if (!['accept', 'reject', 'message'].includes(action)) return;
  if (!activeCall || activeCall.callId !== callId) {
    pendingNotificationAction = { action, callId };
    return;
  }
  if (action === 'accept') acceptVoiceCall();
  else if (action === 'message') declineWithMessage('');
  else rejectVoiceCall();
}
function processPendingCallAction() {
  const action = pendingNotificationAction || window.__pendingCallNotificationAction;
  if (!action || !activeCall || activeCall.callId !== action.callId) return;
  pendingNotificationAction = null;
  window.__pendingCallNotificationAction = null;
  setTimeout(() => handleCallNotificationAction(action.action, action.callId), 100);
}

function initCallEvents() {
  bindCallUi();
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
    activeCall.answered = true;
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
  // A dropped socket must not end an answered call: media keeps flowing peer-to-peer, and when the
  // socket reconnects we re-attach to the same call. Ringing/unanswered calls still end as before.
  socket.on('disconnect', () => {
    if (activeCall && !activeCall.answered) cleanupVoiceCall();
  });
  socket.on('connect', () => {
    if (activeCall?.answered && activeCall.callId) socket.emit('call:rejoin', { callId: activeCall.callId });
  });
  socket.on('call:rejoined', ({ callId, peerOnline }) => {
    if (!activeCall || activeCall.callId !== callId) return;
    if (peerOnline && callMediaState() !== 'connected') nudgeReconnect();
  });
  socket.on('call:peer-back', ({ callId }) => {
    if (!activeCall || activeCall.callId !== callId) return;
    if (callMediaState() !== 'connected') { if (activeCall.role === 'caller') restartIce(); }
  });
  socket.on('call:peer-lost', ({ callId }) => {
    if (!activeCall || activeCall.callId !== callId || callMediaState() === 'connected') return;
    setCallStatus('Waiting for the other person to reconnect…');
  });
  socket.on('call:restart-request', ({ callId }) => {
    if (!activeCall || activeCall.callId !== callId || activeCall.role !== 'caller') return;
    restartIce();
  });
  socket.on('call:rejoin-failed', ({ callId }) => {
    if (!activeCall || activeCall.callId !== callId) return;
    setCallStatus('Call ended');
    cleanupVoiceCall();
  });
  // Internet came back: reconnect signaling right away instead of waiting for the next retry.
  window.addEventListener('online', () => {
    if (!activeCall?.answered) return;
    if (socket && !socket.connected) socket.connect();
    setTimeout(() => { if (activeCall && callMediaState() !== 'connected') nudgeReconnect(); }, 1500);
  });
}
