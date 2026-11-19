const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const db = require('../db');
const { authMiddleware } = require('../auth');
const { broadcastRooms, backupRoom } = require('../websocket/handlers');

router.use(authMiddleware);

router.get('/', (req, res) => {
  const rooms = db.prepare(
    'SELECT id, name, is_public, created_by FROM rooms WHERE is_public = 1 ORDER BY created_at DESC, id DESC'
  ).all();
  res.json(rooms);
});

router.post('/', async (req, res) => {
  const { name, password } = req.body || {};
  const isPublic = req.body?.is_public === undefined ? true : !!req.body.is_public;
  const roomName = typeof name === 'string' ? name.trim() : '';
  if (!roomName) return res.status(400).json({ error: 'Room name required' });
  if (roomName.length > 64) return res.status(400).json({ error: 'Room name too long (max 64)' });

  let password_hash = null;
  if (!isPublic) {
    if (typeof password !== 'string' || !password) {
      return res.status(400).json({ error: 'Private room requires password' });
    }
    password_hash = await bcrypt.hash(password, 10);
  }
  const info = db.prepare(
    'INSERT INTO rooms (name, is_public, password_hash, created_by) VALUES (?, ?, ?, ?)'
  ).run(roomName, isPublic ? 1 : 0, password_hash, req.user.userId);

  backupRoom(Number(info.lastInsertRowid)); // gửi backup phòng mới cho các node
  if (isPublic) broadcastRooms(); // cập nhật danh sách phòng realtime cho mọi người
  res.status(201).json({ id: Number(info.lastInsertRowid), name: roomName, is_public: isPublic });
});

router.post('/join/:roomId', async (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(Number(req.params.roomId));
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.is_public) {
    const { password } = req.body || {};
    if (!password) return res.status(403).json({ error: 'Password required' });
    if (!(await bcrypt.compare(String(password), room.password_hash))) {
      return res.status(403).json({ error: 'Incorrect password' });
    }
  }
  res.json({ roomId: room.id, name: room.name });
});

module.exports = router;
