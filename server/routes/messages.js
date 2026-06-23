const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');

function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  req.user = decoded;
  next();
}

// Get recent messages for a room (limited to 100)
router.get('/room/:roomId', auth, (req, res) => {
  const { roomId } = req.params;
  const limit = parseInt(req.query.limit) || 100;
  const stmt = db.prepare(`
    SELECT m.id, m.content, m.timestamp, u.username 
    FROM messages m 
    JOIN users u ON m.user_id = u.id 
    WHERE m.room_id = ? AND m.is_private = 0 
    ORDER BY m.timestamp DESC LIMIT ?
  `);
  const messages = stmt.all(roomId, limit);
  res.json(messages.reverse());
});

// Get private messages between two users
router.get('/private/:otherUserId', auth, (req, res) => {
  const { otherUserId } = req.params;
  const userId = req.user.userId;
  const limit = parseInt(req.query.limit) || 100;
  const stmt = db.prepare(`
    SELECT m.id, m.content, m.timestamp, u.username, m.user_id 
    FROM messages m 
    JOIN users u ON m.user_id = u.id 
    WHERE m.is_private = 1 
      AND ((m.user_id = ? AND m.recipient_id = ?) OR (m.user_id = ? AND m.recipient_id = ?))
    ORDER BY m.timestamp DESC LIMIT ?
  `);
  const messages = stmt.all(userId, otherUserId, otherUserId, userId, limit);
  res.json(messages.reverse());
});

module.exports = router;
