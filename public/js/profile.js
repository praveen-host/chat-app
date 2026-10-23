/* My profile sheet (edit details / photo) and the read-only profile of the person I'm chatting with. */
function renderMe() {
  const p = myProfile || { id: me.id, username: me.username, displayName: me.displayName || me.username };
  $('meAv').replaceChildren(avEl(p, 36, false)); $('meName').textContent = p.displayName;
}
async function loadMyProfile() {
  const r = await fetch('/api/profile', { headers: authHdr() });
  if (!r.ok) return;
  myProfile = await r.json(); me.displayName = myProfile.displayName; saveSession(); renderMe();
}

function renderProfileAv() {
  $('pAv').replaceChildren(avEl(myProfile, 96, false));
  $('avRemove').style.display = myProfile && myProfile.avatarVersion ? 'inline-block' : 'none';
}
async function openProfile() {
  if (!myProfile) await loadMyProfile();
  if (!myProfile) return;
  $('pDisplay').value = myProfile.displayName; $('pFull').value = myProfile.fullName; $('pAbout').value = myProfile.about;
  $('pEmail').value = myProfile.email; $('pPhone').value = myProfile.phone; $('pUser').value = myProfile.username;
  $('pErr').textContent = ''; renderProfileAv(); $('profile').style.display = 'flex';
}
function closeProfile() { $('profile').style.display = 'none'; }

async function saveProfile() {
  $('pErr').textContent = '';
  const r = await fetch('/api/profile', { method: 'PUT', headers: { ...authHdr(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: $('pDisplay').value, fullName: $('pFull').value, about: $('pAbout').value, email: $('pEmail').value, phone: $('pPhone').value }) });
  const d = await r.json();
  if (!r.ok) return $('pErr').textContent = d.error || 'Could not save';
  myProfile = d; me.displayName = d.displayName; saveSession(); renderMe(); closeProfile();
}

// Centre-crop to a square and shrink to 256x256 JPEG
async function squareAvatar(file) {
  const img = await loadImg(file);
  const side = Math.min(img.width, img.height), c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 256, 256);
  ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256);
  return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('Could not process the image')), 'image/jpeg', 0.85));
}
async function pickAvatar(input) {
  const file = input.files[0]; input.value = '';
  if (!file) return;
  try {
    const blob = await squareAvatar(file);
    const r = await fetch('/api/profile/avatar', { method: 'PUT', headers: { ...authHdr(), 'Content-Type': 'image/jpeg' }, body: blob });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Upload failed');
    myProfile = d; refreshProfileUI();
  } catch (e) { $('pErr').textContent = e.message; }
}
async function removeAvatar() {
  const r = await fetch('/api/profile/avatar', { method: 'DELETE', headers: authHdr() });
  if (r.ok) { myProfile = await r.json(); refreshProfileUI(); }
}

function openPeerProfile() {
  if (peer == null) return;
  $('peerProfile').style.display = 'flex'; refreshPeerProfile();
}
function closePeerProfile() { $('peerProfile').style.display = 'none'; }
function refreshPeerProfile() {
  if ($('peerProfile').style.display !== 'flex') return;
  const u = peerUser(); if (!u) return closePeerProfile();
  $('ppAv').replaceChildren(avEl(u, 120, true));
  $('ppName').textContent = u.displayName; $('ppUser').textContent = '@' + u.username;
  $('ppFull').textContent = u.fullName; $('ppFullRow').style.display = u.fullName ? 'block' : 'none';
  $('ppAbout').textContent = u.about; $('ppAboutRow').style.display = u.about ? 'block' : 'none';
}
