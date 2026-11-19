require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

// db/auth/node sẽ dừng tiến trình nếu thiếu JWT_SECRET / MASTER_KEY
const db = require('./db');
const { verifyToken } = require('./auth');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const msgRoutes = require('./routes/messages');
const adminRoutes = require('./routes/admin');
const { handleConnection, startHeartbeat, maybeAutoRestore } = require('./websocket/handlers');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // sau proxy của Render để req.ip đúng

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

app.use((req, res, next) => {
  if (!req.url.startsWith('/healthz')) console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${req.ip}`);
  next();
});

// CORS (token nằm trong header, không dùng cookie nên '*' an toàn)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Accept, Authorization, X-Room-Password');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'static')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/messages', msgRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Bắt lỗi (vd. JSON hỏng) để không rò stack trace
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large' });
  console.error('[HTTP] Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

const keyPath = path.join(__dirname, 'certs', 'server.key');
const certPath = path.join(__dirname, 'certs', 'server.crt');
const hasCert = fs.existsSync(keyPath) && fs.existsSync(certPath);

const server = hasCert
  ? https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
  : http.createServer(app);
console.log(hasCert ? '🔒 HTTPS mode (cert found)' : '🌐 HTTP mode (no SSL cert)');

// Chỉ nhận WebSocket ở /ws, giới hạn kích thước gói tin
const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 64 * 1024 });

wss.on('connection', (ws, req) => {
  let token = null;
  try {
    token = new URL(req.url, 'http://localhost').searchParams.get('token');
  } catch (e) { /* ignore */ }

  const user = verifyToken(token);
  if (!user) {
    console.log('[WS] Authentication failed – closing connection');
    ws.close(1008, 'Unauthorized');
    return;
  }
  ws.user = user;
  console.log(`[WS] Authenticated as ${user.username} (ID: ${user.userId})`);
  handleConnection(ws);
});

wss.on('error', (err) => console.error('[WS] Server error:', err));
startHeartbeat(wss);
// DB rỗng (vd. server vừa bị reset) → tự mở cửa sổ khôi phục từ node client
maybeAutoRestore();

server.listen(PORT, () => {
  console.log(`✅ ${hasCert ? 'HTTPS' : 'HTTP'} server running on port ${PORT}`);
});

function shutdown() {
  console.log('Shutting down...');
  wss.clients.forEach(ws => ws.close(1001, 'Server shutting down'));
  server.close(() => { try { db.close(); } catch (e) {} process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

