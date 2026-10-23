/* App start-up and every real-time (Socket.IO) event coming from the server. */
const reportVisibility = () => socket && socket.connected && socket.emit('visibility', { visible: document.visibilityState === 'visible' });
document.addEventListener('visibilitychange', reportVisibility);
window.addEventListener('focus', reportVisibility);

async function start() {
  $('auth').style.display = 'none';
  $('app').style.display = 'flex'; $('app').classList.add('ready');
  renderMe();
  await loadUsers();
  loadMyProfile();
  renderChat();

  socket = io({ auth: { token } });
  initPush();
  socket.on('connect', reportVisibility);                // tell the server whether this tab is in front
  socket.on('connect_error', err => { if (err.message === 'Unauthorized') expireSession(); });
  const qs = new URLSearchParams(location.search);       // opened from a notification
  const openId = Number(qs.get('chat')), forId = Number(qs.get('to'));
  if (openId && (!forId || forId === me.id) && users.some(u => u.id === openId)) { openChat(openId); window.history.replaceState(null, '', '/'); }

  /* presence & profiles */
  socket.on('presence:list', ids => { online.clear(); ids.forEach(i => online.add(i)); renderUsers(); renderHeader(); });
  socket.on('presence', ({ id, online: on }) => {
    on ? online.add(id) : (online.delete(id), clearTyping(id));
    if (!users.some(u => u.id === id)) return loadUsers();
    renderUsers(); renderHeader();
  });
  socket.on('profile', p => {
    if (p.id === me.id) { myProfile = { ...(myProfile || {}), ...p }; me.displayName = p.displayName; saveSession(); renderMe(); return; }
    const i = users.findIndex(u => u.id === p.id);
    if (i < 0) return loadUsers();
    users[i] = p; renderUsers(); renderHeader(); refreshPeerProfile();
  });

  /* messages */
  // Live message -> confirm "delivered" to the sender
  socket.on('message', m => {
    socket.emit('message:delivered', { to: m.from, cids: [m.cid] });
    receive(m);
  });
  // Messages queued while I was offline -> ack (server deletes them) and confirm "delivered"
  socket.on('offline:messages', (list, ack) => {
    const bySender = {};
    list.forEach(m => (bySender[m.from] ||= []).push(m.cid));
    Object.entries(bySender).forEach(([from, cids]) => socket.emit('message:delivered', { to: Number(from), cids: cids.filter(Boolean) }));
    list.forEach(receive);
    ack();
  });
  // Receipts for messages I sent
  socket.on('message:status', ({ by, cids, status }) => {
    const set = new Set(cids);
    (history[by] || []).forEach(m => { if (m.mine && set.has(m.cid)) setStatus(m, status); });
    if (peer === by) renderChat();
  });
  // The other person deleted one of their messages for everyone
  socket.on('message:deleted', ({ by, cid }) => {
    const m = (history[by] || []).find(x => x.cid === cid && !x.mine);
    if (!m) return;
    if (!m.read && unread[by] > 0) unread[by]--;
    markDeleted(m); renderUsers();
    if (peer === by) renderChat();
  });
  // Typing indicator from others
  socket.on('typing', ({ from, typing }) => {
    clearTimeout(typingTimers[from]);
    if (typing) { typingNow.add(from); typingTimers[from] = setTimeout(() => clearTyping(from), 4000); }
    else typingNow.delete(from);
    renderUsers(); renderHeader();
  });
  socket.on('chat:deleted', ({ by }) => { dropChat(by); clearTyping(by); renderUsers(); if (peer === by) renderChat(); });
}
