const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'chat.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

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

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id, id);
  CREATE INDEX IF NOT EXISTS idx_messages_private ON messages(is_private, user_id, recipient_id, id);
`);

// SQLite CURRENT_TIMESTAMP là UTC dạng "YYYY-MM-DD HH:MM:SS" (không có múi giờ).
// new Date() sẽ hiểu nhầm là giờ local -> chuẩn hoá về ISO 8601 UTC.
function toISO(ts) {
  if (!ts) return new Date().toISOString();
  if (/Z$|[+-]\d\d:?\d\d$/.test(ts)) return new Date(ts).toISOString();
  return new Date(ts.replace(' ', 'T') + 'Z').toISOString();
}

db.toISO = toISO;
module.exports = db;
