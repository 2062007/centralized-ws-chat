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
  // Dùng HTTPS nếu có cert
  const options = {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath)
  };
  server = https.createServer(options, app);
  console.log('🔒 HTTPS mode (cert found)');
} else {
  // Dùng HTTP nếu không có cert (trên Render)
  server = http.createServer(app);
  console.log('🌐 HTTP mode (no SSL cert)');
}

// WebSocket server
wss = new WebSocket.Server({ server });
wss.on('connection', (ws, req) => {
  // Xác định protocol thực tế (quan trọng nếu đứng sau proxy)
  const proto = req.headers['x-forwarded-proto'] || (hasCert ? 'https' : 'http');
  const host = req.headers.host;
  const url = new URL(req.url, `${proto}://${host}`);
  const token = url.searchParams.get('token');
  const user = verifyToken(token);
  if (!user) {
    ws.close(1008, 'Unauthorized');
    return;
  }
  ws.user = user;
  handleConnection(ws, wss);
});

server.listen(PORT, () => {
  if (hasCert) {
    console.log(`✅ HTTPS Server running on https://localhost:${PORT}`);
  } else {
    console.log(`✅ HTTP Server running on http://localhost:${PORT}`);
  }
  console.log(`Your app is live on port ${PORT}`);
});
