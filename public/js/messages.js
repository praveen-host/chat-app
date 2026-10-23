/* Conversation: receiving, rendering, sending, replying, deleting messages, read receipts, typing. */
const userName = id => id === me.id ? 'You' : ((users.find(u => u.id === id) || {}).displayName || 'User');

/* ---------- receiving / read receipts ---------- */
function receive(m) {
  const entry = { ...m, mine: false, read: false };
  if (m.image) entry.imgUrl = URL.createObjectURL(new Blob([m.image], { type: 'image/jpeg' }));   // memory only, no URL on the server
  delete entry.image;
  (history[m.from] ||= []).push(entry);
  clearTyping(m.from);
  if (peer !== m.from) unread[m.from] = (unread[m.from] || 0) + 1;
  renderUsers();
  if (peer === m.from) { renderChat(); markRead(); }
}

// Mark messages from the open chat as read (only while the tab is visible)
function markRead() {
  if (peer == null || document.visibilityState !== 'visible') return;
  const fresh = (history[peer] || []).filter(m => !m.mine && !m.read);
  if (!fresh.length) return;
  fresh.forEach(m => m.read = true);
  unread[peer] = 0;
  socket.emit('message:read', { to: peer, cids: fresh.map(m => m.cid).filter(Boolean) });
  renderUsers();
}
document.addEventListener('visibilitychange', markRead);
window.addEventListener('focus', markRead);

/* ---------- rendering ---------- */
function tickHtml(status) {
  if (status === 'failed') return '<span class="tick failed" title="Failed">!</span>';
  if (status === 'read') return '<span class="tick read" title="Read">✓✓</span>';
  if (status === 'delivered') return '<span class="tick" title="Delivered">✓✓</span>';
  if (status === 'sent') return '<span class="tick" title="Sent">✓</span>';
  return '<span class="tick" title="Sending">🕓</span>';
}

function renderChat(stick) {
  const selected = peer != null;
  $('form').style.display = selected ? 'flex' : 'none';
  $('preview').style.display = selected && pending ? 'flex' : 'none';
  $('replyBar').style.display = selected && replyingTo ? 'flex' : 'none';
  $('delBtn').style.display = selected ? 'inline-block' : 'none';
  if (replyingTo) {
    $('replyWho').textContent = 'Replying to ' + userName(replyingTo.authorId);
    $('replyText').textContent = (replyingTo.hasImage ? '📷 ' : '') + (replyingTo.text || (replyingTo.hasImage ? 'Photo' : ''));
  }
  const box = $('msgs');
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80, prevTop = box.scrollTop;
  box.innerHTML = '';
  if (!selected) { box.innerHTML = '<div class="empty">Select a user from the list to start chatting</div>'; return; }
  const list = history[peer] || [];
  if (!list.length) box.innerHTML = '<div class="empty">No messages yet. Say hi!</div>';
  list.forEach(m => box.appendChild(messageEl(m)));
  box.scrollTop = (stick || wasNearBottom) ? box.scrollHeight : prevTop;     // don't yank the view while reading older messages
}

function messageEl(m) {
  const d = document.createElement('div');
  d.className = 'm ' + (m.mine ? 'me' : 'them') + (m.cid === openCid ? ' open' : '');
  d.dataset.cid = m.cid || '';
  const meta = document.createElement('div'); meta.className = 'meta';

  if (m.deleted) {                                        // placeholder, like WhatsApp
    const t = document.createElement('div'); t.className = 'deleted';
    t.textContent = m.mine ? '🚫 You deleted this message' : '🚫 This message was deleted';
    d.appendChild(t);
    meta.innerHTML = `<span>${fmtTime(m.ts)}</span>`; d.appendChild(meta);
    return d;
  }

  if (m.reply) {                                          // quoted message
    const q = document.createElement('div'); q.className = 'quote';
    const who = document.createElement('b'); who.textContent = userName(m.reply.authorId);
    const t = document.createElement('div'); t.textContent = (m.reply.hasImage ? '📷 ' : '') + (m.reply.text || (m.reply.hasImage ? 'Photo' : ''));
    q.append(who, t);
    q.onclick = e => { e.stopPropagation(); jumpTo(m.reply.cid); };
    d.appendChild(q);
  }
  if (m.imgUrl) {
    const im = document.createElement('div'); im.className = 'img';
    im.style.backgroundImage = `url("${m.imgUrl}")`;            // background (not <img>) so there is no "save image" menu
    im.onclick = e => { e.stopPropagation(); openViewer(m.imgUrl); };
    im.oncontextmenu = e => e.preventDefault();
    d.appendChild(im);
  }
  if (m.body) { const text = document.createElement('div'); text.textContent = m.body; d.appendChild(text); }
  meta.innerHTML = `<span>${fmtTime(m.ts)}</span>${m.mine ? tickHtml(m.status) : ''}`;
  d.appendChild(meta);

  // Reply / Delete buttons: hover on desktop, tap the bubble on phones
  const actions = document.createElement('div'); actions.className = 'actions';
  const mk = (label, title, fn) => { const b = document.createElement('button'); b.textContent = label; b.title = title; b.onclick = e => { e.stopPropagation(); fn(); }; return b; };
  actions.append(mk('↩', 'Reply', () => startReply(m)), mk('🗑', 'Delete', () => askDelete(m)));
  d.appendChild(actions);
  d.onclick = () => {
    const was = d.classList.contains('open');
    document.querySelectorAll('#msgs .m.open').forEach(x => x.classList.remove('open'));
    if (!was) d.classList.add('open');
    openCid = was ? null : m.cid;
  };
  return d;
}

// Scroll to the quoted message (if it is still on screen) and flash it
function jumpTo(cid) {
  const el = [...$('msgs').children].find(x => x.dataset && x.dataset.cid === cid);
  if (!el) return;
  if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1500);
}

/* ---------- reply ---------- */
function startReply(m) {
  replyingTo = { cid: m.cid, authorId: m.mine ? me.id : m.from, text: (m.body || '').slice(0, 150), hasImage: !!m.imgUrl };
  openCid = null; renderChat(); $('text').focus();
}
function cancelReply() { replyingTo = null; renderChat(); }

/* ---------- delete one message ---------- */
function askDelete(m) {
  deleteTarget = m;
  // "for everyone" only for my own messages the server already has
  $('delEveryone').style.display = m.mine && ['sent', 'delivered', 'read'].includes(m.status) ? 'block' : 'none';
  $('delDialog').style.display = 'flex';
}
function closeDelete() { $('delDialog').style.display = 'none'; deleteTarget = null; }

function confirmDelete(forEveryone) {
  const m = deleteTarget, target = peer; closeDelete();
  if (!m || target == null) return;
  if (forEveryone) {
    socket.emit('message:delete', { to: target, cid: m.cid }, r => {
      if (r && r.ok) { markDeleted(m); if (peer === target) renderChat(); }
      else alert('Could not delete the message. Please try again.');
    });
  } else {                                                // only removes it from my screen (no history is kept anywhere else)
    const list = history[target] || [], i = list.indexOf(m);
    if (i >= 0) list.splice(i, 1);
    if (m.imgUrl) URL.revokeObjectURL(m.imgUrl);
    if (replyingTo && replyingTo.cid === m.cid) replyingTo = null;
    renderChat();
  }
}

// Turn a message into the "deleted" placeholder and free its photo
function markDeleted(m) {
  if (m.imgUrl) URL.revokeObjectURL(m.imgUrl);
  m.imgUrl = null; m.body = ''; m.reply = null; m.deleted = true;
  if (replyingTo && replyingTo.cid === m.cid) replyingTo = null;
}

/* ---------- send / delete chat ---------- */
async function send() {
  const body = $('text').value.trim();
  if ((!body && !pending) || peer == null) return;
  stopTyping();
  const target = peer, att = pending, reply = replyingTo; pending = null; replyingTo = null;
  const entry = { cid: newId(), body, mine: true, ts: new Date().toISOString(), status: 'sending', reply };
  if (att) entry.imgUrl = att.url;
  (history[target] ||= []).push(entry);
  $('text').value = ''; renderChat(true);
  const payload = { to: target, body, cid: entry.cid };
  if (reply) payload.reply = reply;
  if (att) payload.image = await att.blob.arrayBuffer();
  socket.emit('message:send', payload, r => {
    setStatus(entry, r && !r.error ? 'sent' : 'failed');
    if (peer === target) renderChat();
  });
}

function dropChat(id) { (history[id] || []).forEach(m => m.imgUrl && URL.revokeObjectURL(m.imgUrl)); history[id] = []; unread[id] = 0; }

function deleteChat() {
  if (peer == null || !confirm('Delete this chat?')) return;
  const target = peer;
  socket.emit('chat:delete', { peerId: target }, () => { dropChat(target); if (peer === target) renderChat(); });
}

/* ---------- typing (outgoing) ---------- */
let typingTarget = null, lastTypingSent = 0, typingStopTimer;
function stopTyping() {
  clearTimeout(typingStopTimer);
  if (typingTarget != null && socket) socket.emit('typing', { to: typingTarget, typing: false });
  typingTarget = null; lastTypingSent = 0;
}
$('text').addEventListener('input', () => {
  if (peer == null || !socket) return;
  if (typingTarget !== peer || Date.now() - lastTypingSent > 2000) {
    socket.emit('typing', { to: peer, typing: true });
    typingTarget = peer; lastTypingSent = Date.now();
  }
  clearTimeout(typingStopTimer);
  typingStopTimer = setTimeout(stopTyping, 2000);
});
