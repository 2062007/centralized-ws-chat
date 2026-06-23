const express = require('express');
const router = express.Router();
const db = require('../db');
const { hashPassword, comparePassword, generateToken } = require('../auth');

// Middleware log cho mọi request đến route này
router.use((req, res, next) => {
  console.log(`[AUTH] ${req.method} ${req.path} - Body:`, req.body);
  next();
});

router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  console.log('[REGISTER] Received request for username:', username);

  if (!username || !password) {
    console.log('[REGISTER] Missing credentials');
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    console.log('[REGISTER] Hashing password...');
    const hashed = await hashPassword(password);
    console.log('[REGISTER] Password hashed');

    console.log('[REGISTER] Inserting user into DB...');
    const stmt = db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)');
    const info = stmt.run(username, hashed);
    console.log('[REGISTER] User created with id:', info.lastInsertRowid);

    res.status(201).json({ id: info.lastInsertRowid, username });
  } catch (err) {
    console.error('[REGISTER] Error:', err.message);
    console.error('[REGISTER] Stack:', err.stack);
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  console.log('[LOGIN] Attempt for username:', username);

  if (!username || !password) {
    console.log('[LOGIN] Missing credentials');
    return res.status(400).json({ error: 'Username and password required' });
  }

  try {
    console.log('[LOGIN] Querying user...');
    const stmt = db.prepare('SELECT * FROM users WHERE username = ?');
    const user = stmt.get(username);

    if (!user) {
      console.log('[LOGIN] User not found');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    console.log('[LOGIN] User found, id:', user.id);

    console.log('[LOGIN] Comparing passwords...');
    const match = await comparePassword(password, user.password_hash);
    if (!match) {
      console.log('[LOGIN] Password mismatch');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    console.log('[LOGIN] Password matched');

    if (user.is_banned) {
      console.log('[LOGIN] User is banned');
      return res.status(403).json({ error: 'User is banned' });
    }

    console.log('[LOGIN] Generating token...');
    const token = generateToken(user.id, user.username);
    console.log('[LOGIN] Login successful');

    res.json({ token, username: user.username, userId: user.id });
  } catch (err) {
    console.error('[LOGIN] Error:', err.message);
    console.error('[LOGIN] Stack:', err.stack);
    res.status(500).json({ error: 'Login failed: ' + err.message });
  }
});

module.exports = router;
