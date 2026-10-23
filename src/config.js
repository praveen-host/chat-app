// All settings in one place. Everything can be overridden with environment variables.
module.exports = {
  PORT: process.env.PORT || 3000,
  JWT_SECRET: process.env.JWT_SECRET || 'change-me',
  JWT_EXPIRES: process.env.JWT_EXPIRES || '7d',
  DB: {
    host: process.env.DB_HOST || 'localhost',
	port: process.env.DB_PORT,
    user: process.env.DB_USER || 'chat',
    password: process.env.DB_PASSWORD || 'chatpass',
    database: process.env.DB_NAME || 'chatdb',
  },
  VAPID: {
    publicKey: process.env.VAPID_PUBLIC_KEY,
    privateKey: process.env.VAPID_PRIVATE_KEY,
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  },
  MAX_LEN: 2000,                   // characters per message
  MAX_IMG: 4 * 1024 * 1024,        // chat photo, bytes (client compresses to ~200-500 KB)
  MAX_AVATAR: 300 * 1024,          // profile picture, bytes
  MAX_REPLY_TEXT: 150,             // quoted snippet length
};
