/* Avatar pictures: fetched with auth, cached as blob URLs, initials as fallback. */
const avCache = new Map();                       // "id:version" -> blob URL | 'none' | 'loading'
const AV_COLORS = ['#5b8def', '#e07a5f', '#3d9970', '#b565a7', '#e0a030', '#4aa3b5', '#7c6fd6'];
const initials = n => (n || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('');

function avUrl(u) {                              // returns a ready blob URL or null (and starts loading it)
  if (!u || !u.avatarVersion) return null;
  const k = u.id + ':' + u.avatarVersion, c = avCache.get(k);
  if (c && c !== 'loading' && c !== 'none') return c;
  if (!c) {
    avCache.set(k, 'loading');
    fetch(`/api/users/${u.id}/avatar?v=${u.avatarVersion}`, { headers: authHdr() })
      .then(r => r.ok ? r.blob() : null)
      .then(b => { avCache.set(k, b ? URL.createObjectURL(b) : 'none'); refreshProfileUI(); })
      .catch(() => avCache.set(k, 'none'));
  }
  return null;
}
function avEl(u, size, withDot) {
  const d = document.createElement('div'); d.className = 'av';
  d.style.width = d.style.height = size + 'px'; d.style.fontSize = Math.round(size * 0.4) + 'px';
  const url = avUrl(u);
  if (url) d.style.backgroundImage = `url("${url}")`;
  else { d.style.background = AV_COLORS[u.id % AV_COLORS.length]; d.textContent = initials(u.displayName || u.username); }
  if (withDot) { const dot = document.createElement('span'); dot.className = 'dot' + (online.has(u.id) ? ' on' : ''); d.appendChild(dot); }
  return d;
}
function refreshProfileUI() { renderUsers(); renderHeader(); renderMe(); refreshPeerProfile(); if ($('profile').style.display === 'flex') renderProfileAv(); }
