/* Sign in / sign up, staying signed in across refresh, logout. */
async function authenticate(kind) {
  $('err').textContent = '';
  const r = await fetch('/api/' + kind, { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ username: $('u').value.trim(), password: $('p').value }) });
  const d = await r.json();
  if (!r.ok) return $('err').textContent = d.error;
  token = d.token; me = d.user; saveSession(); start();
}

function logout() { clearSession(); socket && socket.disconnect(); location.reload(); }   // push subscription is kept: logged-out users still get alerts

const SESSION_KEY = 'chat.session';
function saveSession() { try { localStorage.setItem(SESSION_KEY, JSON.stringify({ token, user: me })); } catch (e) {} }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch (e) {} }
function expireSession() { clearSession(); location.reload(); }

async function restoreSession() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch (e) {}
  if (saved && saved.token && saved.user) {
    token = saved.token; me = saved.user;
    try {
      const r = await fetch('/api/users', { headers: authHdr() });
      if (r.ok) return start();                       // still valid -> straight into the app
      if (r.status === 401) clearSession();           // expired/invalid -> sign in again
    } catch (e) { /* server unreachable: keep the session, show login */ }
    token = me = undefined;
  }
  $('auth').style.display = 'flex';
}
