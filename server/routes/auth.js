const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, comparePassword, generateToken } = require('../auth');
const { expressLimiter } = require('../ratelimit');
const { backupUser } = require('../websocket/handlers');

// Chống dò mật khẩu / spam đăng ký
router.use(expressLimiter(20, 15 * 60 * 1000, 'Quá nhiều yêu cầu, thử lại sau'));

const USERNAME_RE = /^[\p{L}\p{N}_.-]{3,32}$/u;

// Hash giả (hợp lệ) để thời gian phản hồi không lộ username có tồn tại hay không
const DUMMY_HASH = require('bcrypt').hashSync('dummy-password-for-timing', 10);

router.post('/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const name = username.trim();
  if (!USERNAME_RE.test(name)) {
    return res.status(400).json({ error: 'Username must be 3-32 chars (letters, digits, _ . -)' });
  }
  if (password.length < 8 || password.length > 72) {
    return res.status(400).json({ error: 'Password must be 8-72 characters' });
  }

  try {
    const hashed = await hashPassword(password);
    const info = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(name, hashed);
    backupUser(Number(info.lastInsertRowid)); // gửi backup user mới cho các node
    res.status(201).json({ id: Number(info.lastInsertRowid), username: name });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    console.error('[REGISTER] Error:', err.message);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
    const match = await comparePassword(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !match) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.is_banned) return res.status(403).json({ error: 'User is banned' });

    res.json({ token: generateToken(user.id, user.username), username: user.username, userId: user.id });
  } catch (err) {
    console.error('[LOGIN] Error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

module.exports = router;
