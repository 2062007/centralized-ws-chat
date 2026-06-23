const db = require('../db');
const { moderate } = require('../gemini');
const { encryptForNode, saveNodeData } = require('../node');

// Store active connections: userId -> WebSocket
const clients = new Map();
// Store room participants: roomId -> Set of userIds
const rooms = new Map();

function broadcastToRoom(roomId, message, excludeUserId = null) {
  const userIds = rooms.get(roomId) || new Set();
  for (const userId of userIds) {
    if (userId === excludeUserId) continue;
    const ws = clients.get(userId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(message));
    }
  }
}

function broadcastToNodeClients(message) {
  // Send to all clients that have node mode enabled (we track separately)
  // For simplicity, we assume all clients may be nodes; we'll send a special event.
  for (const [userId, ws] of clients) {
    if (ws.readyState === 1 && ws.isNode) {
      ws.send(JSON.stringify(message));
    }
  }
}

function handleConnection(ws, wss) {
  const user = ws.user;
  const userId = user.userId;
  const username = user.username;

  // Store client
  clients.set(userId, ws);
  ws.isNode = false; // default

  // Send initial room list
  const roomStmt = db.prepare('SELECT id, name, is_public FROM rooms WHERE is_public = 1');
  const publicRooms = roomStmt.all();
  ws.send(JSON.stringify({ type: 'rooms', data: publicRooms }));

  // Handle incoming messages
  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      const { type } = msg;

      switch (type) {
        case 'join_room': {
          const { roomId, password } = msg;
          const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }));
            return;
          }
          if (!room.is_public) {
            // verify password (simplified, we already checked in REST, but do again)
            if (!password) {
              ws.send(JSON.stringify({ type: 'error', message: 'Password required' }));
              return;
            }
            const bcrypt = require('bcrypt');
            const match = await bcrypt.compare(password, room.password_hash);
            if (!match) {
              ws.send(JSON.stringify({ type: 'error', message: 'Incorrect password' }));
              return;
            }
          }
          // Add to room
          if (!rooms.has(roomId)) rooms.set(roomId, new Set());
          rooms.get(roomId).add(userId);
          // Send past messages (last 50)
          const pastStmt = db.prepare(`
            SELECT m.id, m.content, m.timestamp, u.username 
            FROM messages m JOIN users u ON m.user_id = u.id 
            WHERE m.room_id = ? AND m.is_private = 0 
            ORDER BY m.timestamp DESC LIMIT 50
          `);
          const past = pastStmt.all(roomId).reverse();
          ws.send(JSON.stringify({ type: 'history', roomId, data: past }));
          break;
        }

        case 'leave_room': {
          const { roomId } = msg;
          if (rooms.has(roomId)) {
            rooms.get(roomId).delete(userId);
          }
          break;
        }

        case 'send_message': {
          const { roomId, content, isPrivate = false, recipientId = null } = msg;
          if (!content) return;
          // Check if user is banned
          const userRow = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(userId);
          if (userRow.is_banned) {
            ws.send(JSON.stringify({ type: 'error', message: 'You are banned' }));
            return;
          }

          // Moderation with Gemini
          const isNegative = await moderate(content);
          if (isNegative) {
            // Increment ban_count
            db.prepare('UPDATE users SET ban_count = ban_count + 1 WHERE id = ?').run(userId);
            const banInfo = db.prepare('SELECT ban_count FROM users WHERE id = ?').get(userId);
            if (banInfo.ban_count >= 3) {
              db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(userId);
              ws.send(JSON.stringify({ type: 'error', message: 'You have been banned for toxic behavior' }));
              return;
            } else {
              ws.send(JSON.stringify({ type: 'warning', message: 'Message flagged as negative. Ban count: ' + banInfo.ban_count }));
              // Still allow message? According to requirement, auto ban after 3, but messages are still sent? We'll block this one.
              return; // drop message
            }
          }

          // Insert message
          const insertStmt = db.prepare(`
            INSERT INTO messages (room_id, user_id, content, is_private, recipient_id)
            VALUES (?, ?, ?, ?, ?)
          `);
          const info = insertStmt.run(
            isPrivate ? null : roomId,
            userId,
            content,
            isPrivate ? 1 : 0,
            isPrivate ? recipientId : null
          );

          const messageData = {
            id: info.lastInsertRowid,
            user_id: userId,
            username: username,
            content,
            timestamp: new Date().toISOString(),
            isPrivate,
            recipientId
          };

          // Broadcast to room (or private)
          if (isPrivate) {
            // Send to both sender and recipient
            const targetIds = [userId, recipientId];
            for (const id of targetIds) {
              const targetWs = clients.get(id);
              if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({ type: 'private_message', data: messageData }));
              }
            }
          } else {
            broadcastToRoom(roomId, { type: 'message', data: messageData }, userId);
          }

          // If we have node clients, encrypt and broadcast to them
          const encrypted = encryptForNode(JSON.stringify(messageData));
          broadcastToNodeClients({ type: 'node_sync', data: encrypted });
          break;
        }

        case 'node_mode': {
          const { enabled } = msg;
          ws.isNode = !!enabled;
          if (enabled) {
            // Send initial sync? Optionally.
          }
          break;
        }

        case 'node_sync': {
          // Node client sends encrypted data (which it stored from previous broadcasts)
          // We save it to database for restore
          const { encryptedData } = msg;
          if (encryptedData) {
            saveNodeData(userId, encryptedData);
            ws.send(JSON.stringify({ type: 'node_sync_ack' }));
          }
          break;
        }

        case 'node_restore_request': {
          // Server requests node client to send its stored data
          // The client should respond with node_sync containing its data
          // We will send a request message
          ws.send(JSON.stringify({ type: 'node_restore_request' }));
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('WebSocket error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
    }
  });

  ws.on('close', () => {
    clients.delete(userId);
    // Remove from all rooms
    for (const [roomId, set] of rooms) {
      set.delete(userId);
    }
  });
}

module.exports = { handleConnection };
