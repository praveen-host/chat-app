// Entry point: builds the HTTP app, attaches sockets, starts listening.
//   src/config.js        settings            src/routes/auth.js     sign up / sign in
//   src/db.js            MySQL + schema      src/routes/profile.js  profiles & pictures
//   src/auth.js          JWT + middleware    src/routes/push.js     push subscriptions
//   src/push.js          web push sender     src/socket/*.js        real-time features
//   src/realtime.js      socket.io instance  src/validate.js        input checks
const path = require('path');
const http = require('http');
const express = require('express');
const config = require('./src/config');
const { initDb } = require('./src/db');
const push = require('./src/push');
const { errorHandler } = require('./src/auth');
const attachSockets = require('./src/socket');

process.on('unhandledRejection', e => console.error('Unhandled rejection:', e));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, p) => { if (p.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); },
}));
app.use('/api', require('./src/routes/auth'));
app.use('/api', require('./src/routes/profile'));
app.use('/api', require('./src/routes/push'));

// Optional WebRTC TURN relay configuration. Set CALL_TURN_URLS,
// CALL_TURN_USERNAME and CALL_TURN_CREDENTIAL in the server environment.
// For production, prefer time-limited TURN credentials from your provider.
app.get('/api/call-config_backup', (req, res) => {
  const urls = (process.env.CALL_TURN_URLS || '').split(',').map(v => v.trim()).filter(Boolean);
  const iceServers = [];
  if (urls.length && process.env.CALL_TURN_USERNAME && process.env.CALL_TURN_CREDENTIAL) {
    iceServers.push({
      urls,
      username: process.env.CALL_TURN_USERNAME,
      credential: process.env.CALL_TURN_CREDENTIAL
    });
  }
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers });
});


/**
 * Cloudflare TURN configuration for WebRTC calls.
 * Keep the long-lived Cloudflare API token on the server only.
 */

/**
 * Cloudflare TURN configuration for WebRTC voice calls.
 * Keep the long-lived Cloudflare API token on the server.
 */
app.get('/api/call-config', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
    const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;

    if (!keyId || !apiToken) {
      console.error('Cloudflare TURN environment variables are missing');

      return res.status(503).json({
        error: 'TURN service is not configured',
        iceServers: []
      });
    }

    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ttl: 86400
        }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      const details = await response.text();

      console.error(
        'Cloudflare TURN credential generation failed:',
        response.status,
        details.slice(0, 500)
      );

      return res.status(502).json({
        error: 'Could not generate TURN credentials',
        iceServers: []
      });
    }

    const data = await response.json();

    if (!Array.isArray(data.iceServers) || data.iceServers.length === 0) {
      console.error('Cloudflare returned no ICE servers');

      return res.status(502).json({
        error: 'No ICE servers returned',
        iceServers: []
      });
    }

    return res.json({
      iceServers: data.iceServers
    });
  } catch (error) {
    console.error('TURN configuration error:', error.message);

    return res.status(502).json({
      error: 'TURN service temporarily unavailable',
      iceServers: []
    });
  }
});


app.use(errorHandler);

const server = http.createServer(app);
attachSockets(server);

initDb().then(push.init).then(() => server.listen(config.PORT, () => console.log(`Chat running on :${config.PORT}`)));
