require('dotenv').config();
const express = require('express');
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

// Redirect HTTP to HTTPS (if needed)
// For simplicity, we serve HTTPS directly

const PORT = process.env.PORT || 443;

// SSL options (self-signed or real certs)
const options = {
  key: fs.readFileSync(path.join(__dirname, 'certs', 'server.key')),
  cert: fs.readFileSync(path.join(__dirname, 'certs', 'server.crt'))
};

const server = https.createServer(options, app);

// WebSocket server
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
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
  console.log(`Server running on https://localhost:${PORT}`);
});
