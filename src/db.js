// MySQL pool and schema. Tables are created/upgraded automatically on startup.
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({ ...config.DB, waitForConnections: true, connectionLimit: 10 });

const addColumn = async (sql) => {
  try { await pool.query(sql); } catch (e) { if (e.code !== 'ER_DUP_FIELDNAME') throw e; }
};

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
  // Profile fields
  await addColumn(`ALTER TABLE users
    ADD COLUMN display_name VARCHAR(50) NULL, ADD COLUMN full_name VARCHAR(100) NULL,
    ADD COLUMN email VARCHAR(255) NULL, ADD COLUMN phone VARCHAR(30) NULL,
    ADD COLUMN about VARCHAR(200) NULL,
    ADD COLUMN has_avatar TINYINT NOT NULL DEFAULT 0, ADD COLUMN avatar_version INT NOT NULL DEFAULT 0`);
  await pool.query(`CREATE TABLE IF NOT EXISTS user_avatars (
    user_id INT PRIMARY KEY, image MEDIUMBLOB NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);

  // Holds messages ONLY while the recipient is offline; rows are deleted on delivery.
  await pool.query(`CREATE TABLE IF NOT EXISTS offline_messages (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    sender_id INT NOT NULL,
    recipient_id INT NOT NULL,
    body TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_recipient (recipient_id),
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE)`);
  await addColumn('ALTER TABLE offline_messages ADD COLUMN client_id VARCHAR(64) NULL');
  await addColumn('ALTER TABLE offline_messages ADD COLUMN image LONGBLOB NULL');
  await addColumn('ALTER TABLE offline_messages ADD COLUMN reply_json TEXT NULL');

  // Browser push subscriptions (one user can have several devices)
  await pool.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    endpoint TEXT NOT NULL,
    endpoint_hash CHAR(64) NOT NULL,
    p256dh VARCHAR(255) NOT NULL,
    auth VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_user (user_id),
    UNIQUE KEY uq_user_endpoint (user_id, endpoint_hash),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE)`);
  // Existing installs: replace the old endpoint-only unique key
  try { await pool.query('ALTER TABLE push_subscriptions DROP INDEX endpoint_hash'); } catch (e) {}
  try { await pool.query('ALTER TABLE push_subscriptions ADD UNIQUE KEY uq_user_endpoint (user_id, endpoint_hash)'); }
  catch (e) { if (e.code !== 'ER_DUP_KEYNAME') throw e; }

  await pool.query(`CREATE TABLE IF NOT EXISTS app_settings (
    k VARCHAR(50) PRIMARY KEY, v TEXT NOT NULL)`);
}

// Retries while MySQL is still starting (e.g. in Docker)
async function initDb() {
  for (let i = 0; i < 30; i++) {
    try { await createSchema(); return; }
    catch (e) { console.log('Waiting for MySQL...', e.code); await new Promise(r => setTimeout(r, 2000)); }
  }
  throw new Error('MySQL not reachable');
}

module.exports = { pool, initDb };
