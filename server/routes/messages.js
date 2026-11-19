const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db');
const { authMiddleware } = require('../auth');

router.use(authMiddleware);

function parseLimit(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 200) : 100;
}

// Tin nhắn phòng. Phòng riêng tư yêu cầu mật khẩu qua header X-Room-Password
// (bản cũ cho phép đọc lịch sử phòng riêng mà không cần mật khẩu).
router.get('/room/:roomId', async (req, res) => {
  const room = db.prepare('SELECT id, is_public, password_hash FROM rooms WHERE id = ?').get(Number(req.params.roomId));
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.is_public) {
    const pw = req.headers['x-room-password'];
    if (!pw || !(await bcrypt.compare(String(pw), room.password_hash))) {
      return res.status(403).json({ error: 'Password required' });
    }
  }
  const rows = db.prepare(`
    SELECT m.id, m.user_id, m.content, m.timestamp, u.username
    FROM messages m JOIN users u ON m.user_id = u.id
    WHERE m.room_id = ? AND m.is_private = 0
    ORDER BY m.id DESC LIMIT ?
  `).all(room.id, parseLimit(req.query.limit));
  res.json(rows.map(m => ({ ...m, timestamp: db.toISO(m.timestamp) })).reverse());
});

router.get('/private/:otherUserId', (req, res) => {
  const other = Number(req.params.otherUserId);
  if (!Number.isInteger(other)) return res.status(400).json({ error: 'Invalid user id' });
  const me = req.user.userId;
  const rows = db.prepare(`
    SELECT m.id, m.content, m.timestamp, u.username, m.user_id, m.recipient_id, r.username AS recipient_username
    FROM messages m JOIN users u ON m.user_id = u.id
    JOIN users r ON m.recipient_id = r.id
    WHERE m.is_private = 1
      AND ((m.user_id = ? AND m.recipient_id = ?) OR (m.user_id = ? AND m.recipient_id = ?))
    ORDER BY m.id DESC LIMIT ?
  `).all(me, other, other, me, parseLimit(req.query.limit));
  res.json(rows.map(m => ({ ...m, timestamp: db.toISO(m.timestamp) })).reverse());
});

module.exports = router;
