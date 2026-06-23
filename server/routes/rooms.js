const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyToken } = require('../auth');
const bcrypt = require('bcrypt');

// Middleware to authenticate
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token' });
  const token = authHeader.split(' ')[1];
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid token' });
  req.user = decoded;
  next();
}

// Get list of public rooms
router.get('/', auth, (req, res) => {
  const stmt = db.prepare('SELECT id, name, is_public, created_by FROM rooms WHERE is_public = 1 ORDER BY created_at DESC');
  const rooms = stmt.all();
  res.json(rooms);
});

// Create a room (public or private with password)
router.post('/', auth, async (req, res) => {
  const { name, is_public = true, password } = req.body;
  if (!name) return res.status(400).json({ error: 'Room name required' });
  let password_hash = null;
  if (!is_public && password) {
    password_hash = await bcrypt.hash(password, 10);
  } else if (!is_public && !password) {
    return res.status(400).json({ error: 'Private room requires password' });
  }
  const stmt = db.prepare('INSERT INTO rooms (name, is_public, password_hash, created_by) VALUES (?, ?, ?, ?)');
  const info = stmt.run(name, is_public ? 1 : 0, password_hash, req.user.userId);
  res.status(201).json({ id: info.lastInsertRowid, name, is_public });
});

// Join a room (verify password if private)
router.post('/join/:roomId', auth, async (req, res) => {
  const { roomId } = req.params;
  const { password } = req.body;
  const stmt = db.prepare('SELECT * FROM rooms WHERE id = ?');
  const room = stmt.get(roomId);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.is_public) {
    if (!password) return res.status(403).json({ error: 'Password required' });
    const match = await bcrypt.compare(password, room.password_hash);
    if (!match) return res.status(403).json({ error: 'Incorrect password' });
  }
  // Just return room info; actual joining is handled via WebSocket
  res.json({ roomId: room.id, name: room.name });
});

module.exports = router;
