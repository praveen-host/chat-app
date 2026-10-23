# Simple Chat (Node.js + Socket.IO + MySQL + Docker)

    docker compose up --build
    open http://localhost:3000   (use two browsers/profiles to chat)

Local without Docker: set DB_HOST / DB_USER / DB_PASSWORD / DB_NAME, then `npm install && npm start`.

## Features
Sign up / sign in (stays signed in across refresh) · 1:1 messaging · sent/delivered/read ticks · typing indicator ·
reply to a message · delete a message (for me / for everyone) · delete chat · photos viewed in-app only ·
profiles (display name, details, picture) · Active/Inactive status · web push notifications.
Messages are stored in MySQL only while the recipient is offline and are deleted once delivered.

## Project layout
    server.js                 entry point: builds the app and starts listening
    src/
      config.js               all settings (environment variables)
      db.js                   MySQL pool + schema (auto-created / upgraded)
      auth.js                 JWT, auth middleware, error handler
      validate.js             input checks (JPEG, reply, ids)
      push.js                 web push (VAPID keys, sending)
      realtime.js             Socket.IO instance + helpers
      routes/auth.js          POST /api/signup, /api/signin
      routes/profile.js       users, own profile, profile picture
      routes/push.js          push subscribe / unsubscribe / test
      socket/index.js         attaches the handlers below
      socket/presence.js      online status + delivering queued messages
      socket/messages.js      send message (text/photo/reply), delete one message
      socket/receipts.js      delivered/read ticks, typing, tab visibility
      socket/chat.js          delete whole chat
    public/
      index.html              page markup only
      css/styles.css          all styles
      js/core.js              shared state + helpers (loaded first)
      js/auth.js              sign in/up, session, logout
      js/avatars.js           avatar pictures
      js/users.js             user list, chat header, open/close chat
      js/profile.js           my profile sheet, peer profile
      js/messages.js          render/send/reply/delete messages, read receipts, typing
      js/attachments.js       photo attach, compress, viewer
      js/push.js              notifications button + subscription
      js/socket.js            start-up and all real-time events
      js/main.js              boot (loaded last)
      sw.js, manifest.json    service worker (push) + installable app
