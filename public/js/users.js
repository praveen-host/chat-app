function formatLastActive(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
  if (seconds < 7 * 86400) return Math.floor(seconds / 86400) + 'd ago';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* The user list, the chat header, and opening/closing a conversation. */
async function loadUsers() {
  const r = await fetch('/api/users', { headers: authHdr() });
  if (r.status === 401) return expireSession();
  users = await r.json();
  renderUsers(); renderHeader();
}

function clearTyping(id) {
  clearTimeout(typingTimers[id]); typingNow.delete(id);
  renderUsers(); renderHeader();
}

function renderUsers() {
  $('list').innerHTML = '';
  [...users].sort((a, b) => (online.has(b.id) - online.has(a.id)) || a.displayName.localeCompare(b.displayName)).forEach(u => {
    const on = online.has(Number(u.id)), typing = typingNow.has(u.id);
    const d = document.createElement('div');
    d.className = 'user' + (peer === u.id ? ' active' : '');
    d.appendChild(avEl(u, 42, true));
    const info = document.createElement('div'); info.className = 'info';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = u.displayName;
    const about = document.createElement('div'); about.className = 'about'; about.textContent = u.about || '@' + u.username;
    info.append(name, about); d.appendChild(info);
    const right = document.createElement('div');
    right.innerHTML = unread[u.id] ? `<span class="badge">${unread[u.id]}</span>`
      : typing ? `<span class="sub typing">typing…</span>`
        : `<span class="sub presence-label ${on ? 'is-online' : 'is-offline'}">${on ? 'Active now' : escapeHtml(formatLastActive(u.lastActiveAt))}</span>`;
    d.appendChild(right);
    d.onclick = () => openChat(u.id);
    $('list').appendChild(d);
  });
}



function renderHeader() {
  const u = peerUser();
  const callButton = $('voiceCallBtn');
  const videoButton = $('videoCallBtn');

  if (!u) {
    $('peerName').textContent = 'Chat';
    $('peerStatus').textContent = '';
    $('peerAv').replaceChildren();

    if (callButton) {
      callButton.style.display = 'none';
      callButton.disabled = true;
    }
    if (videoButton) {
      videoButton.style.display = 'none';
      videoButton.disabled = true;
    }
    return;
  }

  const on = online.has(Number(u.id));

  if (callButton) {
    callButton.style.display = '';
    callButton.disabled = !on;
  }
  if (videoButton) {
    videoButton.style.display = '';
    videoButton.disabled = !on;
  }

  $('peerAv').replaceChildren(avEl(u, 38, false));
  $('peerName').textContent = u.displayName;

  $('peerStatus').innerHTML = typingNow.has(Number(u.id))
    ? '<span class="typing">typing…</span>'
    : on
      ? '<span class="dot on"></span><span class="is-online">Active now</span>'
      : `<span class="dot"></span><span class="is-offline">${escapeHtml(formatLastActive(u.lastActiveAt))}</span>`;
}



function openChat(id) {
  stopTyping(); clearPending(); replyingTo = null; openCid = null;
  peer = id; unread[id] = 0;
  $('app').classList.add('chat-open');
  renderUsers(); renderHeader(); renderChat(true); loadChatHistory(id); markRead();
  if (matchMedia('(min-width:701px)').matches) $('text').focus();
}
function closeChat() { stopTyping(); clearPending(); replyingTo = null; openCid = null; peer = null; $('app').classList.remove('chat-open'); renderUsers(); renderHeader(); renderChat(); }
