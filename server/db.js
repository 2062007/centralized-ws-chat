const Database = require('better-sqlite3');
const db = new Database('chat.db');

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Create tables if not exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    is_banned BOOLEAN DEFAULT 0,
    ban_count INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    is_public BOOLEAN DEFAULT 1,
    password_hash TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER REFERENCES rooms(id),
    user_id INTEGER REFERENCES users(id),
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    is_private BOOLEAN DEFAULT 0,
    recipient_id INTEGER REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS node_sync (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) NOT NULL,
    encrypted_data BLOB NOT NULL,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;
