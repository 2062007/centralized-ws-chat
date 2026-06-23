require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const db = require('./db');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/rooms');
const msgRoutes = require('./routes/messages');
const { handleConnection } = require('./websocket/handlers');
const { verifyToken } = require('./auth');

const app = express();

// Middleware: log chi tiết từng request
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - IP: ${req.ip}`);
  next();
});

// Middleware: CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'static')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rooms', roomRoutes);
app.use('/api/messages', msgRoutes);

const PORT = process.env.PORT || 443;

// Kiểm tra sự tồn tại của chứng chỉ
const certDir = path.join(__dirname, 'certs');
const keyPath = path.join(certDir, 'server.key');
const certPath = path.join(certDir, 'server.crt');
const hasCert = fs.existsSync(keyPath) && fs.existsSync(certPath);

let server;
let wss;

if (hasCert) {
  // HTTPS
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  server = https.createServer(options, app);
  console.log('🔒 HTTPS mode (cert found)');
} else {
  // HTTP
  server = http.createServer(app);
  console.log('🌐 HTTP mode (no SSL cert)');
}

// WebSocket server
wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  const proto = req.headers['x-forwarded-proto'] || (hasCert ? 'https' : 'http');
  const host = req.headers.host;
  const url = new URL(req.url, `${proto}://${host}`);
  const token = url.searchParams.get('token');

  console.log(`[WS] Connection attempt from ${host}, token: ${token ? 'present' : 'missing'}`);

  const user = verifyToken(token);
  if (!user) {
    console.log('[WS] Authentication failed – closing connection');
    ws.close(1008, 'Unauthorized');
    return;
  }

  ws.user = user;
  console.log(`[WS] Authenticated as ${user.username} (ID: ${user.userId})`);
  handleConnection(ws, wss);
});

wss.on('error', (err) => {
  console.error('[WS] Server error:', err);
});

server.listen(PORT, () => {
  if (hasCert) {
    console.log(`✅ HTTPS Server running on https://localhost:${PORT}`);
  } else {
    console.log(`✅ HTTP Server running on http://localhost:${PORT}`);
  }
  console.log(`App live on port ${PORT}`);
});
