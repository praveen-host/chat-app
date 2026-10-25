// WebRTC relay (TURN) settings for calls.
// 1) Cloudflare Realtime TURN (recommended behind a Cloudflare Tunnel): set CF_TURN_KEY_ID and
//    CF_TURN_API_TOKEN. Short-lived credentials are minted here; the long-term key never reaches browsers.
// 2) Any other TURN server: set CALL_TURN_URLS, CALL_TURN_USERNAME and CALL_TURN_CREDENTIAL.
const CREDENTIAL_TTL_SECONDS = 86400;
let cached = { servers: [], expiresAt: 0 };

function staticServers() {
  const urls = (process.env.CALL_TURN_URLS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (urls.length && process.env.CALL_TURN_USERNAME && process.env.CALL_TURN_CREDENTIAL) {
    return [{ urls, username: process.env.CALL_TURN_USERNAME, credential: process.env.CALL_TURN_CREDENTIAL }];
  }
  return [];
}

async function cloudflareServers() {
  const keyId = process.env.CF_TURN_KEY_ID, apiToken = process.env.CF_TURN_API_TOKEN;
  if (!keyId || !apiToken) return null;
  if (cached.servers.length && Date.now() < cached.expiresAt) return cached.servers;

  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
    signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) throw new Error(`Cloudflare TURN credential request failed (HTTP ${res.status})`);
  const data = await res.json();
  const list = Array.isArray(data.iceServers) ? data.iceServers : (data.iceServers ? [data.iceServers] : []);
  // Browsers block port 53, so drop those URLs; keep STUN and the other TURN transports.
  const servers = list.map(s => ({
    ...s, urls: [].concat(s.urls || []).filter(u => !/:53(\?|$)/.test(u))
  })).filter(s => s.urls.length);
  // Hand out credentials that still have at least half their lifetime left.
  cached = { servers, expiresAt: Date.now() + (CREDENTIAL_TTL_SECONDS / 2) * 1000 };
  return servers;
}

async function getIceServers() {
  try {
    const cf = await cloudflareServers();
    if (cf) return cf;
  } catch (err) {
    console.error('TURN config:', err.message);
    if (cached.servers.length) return cached.servers; // stale-but-valid beats nothing
  }
  return staticServers();
}

module.exports = { getIceServers };
