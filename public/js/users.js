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
        : `<span class="sub">${on ? 'Active' : 'Inactive'}</span>`;
    d.appendChild(right);
    d.onclick = () => openChat(u.id);
    $('list').appendChild(d);
  });
}



function renderHeader() {
  const u = peerUser();
  const callButton = $('voiceCallBtn');

  if (!u) {
    $('peerName').textContent = 'Chat';
    $('peerStatus').textContent = '';
    $('peerAv').replaceChildren();

    if (callButton) {
      callButton.style.display = 'none';
      callButton.disabled = true;
    }
    return;
  }

  const on = online.has(Number(u.id));

  if (callButton) {
    callButton.style.display = '';
    callButton.disabled = !on;
  }

  $('peerAv').replaceChildren(avEl(u, 38, false));
  $('peerName').textContent = u.displayName;

  $('peerStatus').innerHTML = typingNow.has(Number(u.id))
    ? '<span class="typing">typing…</span>'
    : `<span class="dot ${on ? 'on' : ''}"></span>${on ? 'Active' : 'Inactive'}`;
}



function openChat(id) {
  stopTyping(); clearPending(); replyingTo = null; openCid = null;
  peer = id; unread[id] = 0;
  $('app').classList.add('chat-open');
  renderUsers(); renderHeader(); renderChat(true); loadChatHistory(id); markRead();
  if (matchMedia('(min-width:701px)').matches) $('text').focus();
}
function closeChat() { stopTyping(); clearPending(); replyingTo = null; openCid = null; peer = null; $('app').classList.remove('chat-open'); renderUsers(); renderHeader(); renderChat(); }
