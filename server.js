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
app.use(errorHandler);

const server = http.createServer(app);
attachSockets(server);

initDb().then(push.init).then(() => server.listen(config.PORT, () => console.log(`Chat running on :${config.PORT}`)));
