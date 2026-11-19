const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { startRestore } = require('../websocket/handlers');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// POST /api/admin/restore  (Authorization: Bearer <ADMIN_TOKEN>)
// Yêu cầu mọi node client gửi lại dữ liệu đã lưu; server giải mã bằng MASTER_KEY
// và chèn lại các tin nhắn còn thiếu vào DB trong vòng 10 phút.
router.post('/restore', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(404).json({ error: 'Not found' });
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  if (scheme !== 'Bearer' || !token || !safeEqual(token, ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ ok: true, ...startRestore() });
});

module.exports = router;
