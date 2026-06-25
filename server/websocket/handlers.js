const db = require('../db');
const { moderate } = require('../gemini');
const { encryptForNode, saveNodeData } = require('../node');

const clients = new Map();
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

  clients.set(userId, ws);
  ws.isNode = false;

  const roomStmt = db.prepare('SELECT id, name, is_public FROM rooms WHERE is_public = 1');
  const publicRooms = roomStmt.all();
  ws.send(JSON.stringify({ type: 'rooms', data: publicRooms }));

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw);
      const { type } = msg;

      switch (type) {
        case 'join_room': {
          const { roomId, password } = msg;
          const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
          if (!room) {
            ws.send(JSON.stringify({ type: 'error', message: 'Phòng không tồn tại' }));
            return;
          }
          if (!room.is_public) {
            if (!password) {
              ws.send(JSON.stringify({ type: 'error', message: 'Yêu cầu mật khẩu' }));
              return;
            }
            const bcrypt = require('bcrypt');
            const match = await bcrypt.compare(password, room.password_hash);
            if (!match) {
              ws.send(JSON.stringify({ type: 'error', message: 'Sai mật khẩu' }));
              return;
            }
          }
          if (!rooms.has(roomId)) rooms.set(roomId, new Set());
          rooms.get(roomId).add(userId);

          const pastStmt = db.prepare(`
            SELECT m.id, m.content, m.timestamp, u.username 
            FROM messages m JOIN users u ON m.user_id = u.id 
            WHERE m.room_id = ? AND m.is_private = 0 
            ORDER BY m.timestamp DESC LIMIT 50
          `);
          const past = pastStmt.all(roomId).map(m => ({
            ...m,
            timestamp: new Date(m.timestamp).toISOString()
          })).reverse();

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

          const userRow = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(userId);
          if (userRow.is_banned) {
            ws.send(JSON.stringify({ type: 'error', message: 'Bạn đã bị cấm' }));
            return;
          }

          const isNegative = await moderate(content);
          if (isNegative) {
            db.prepare('UPDATE users SET ban_count = ban_count + 1 WHERE id = ?').run(userId);
            const banInfo = db.prepare('SELECT ban_count FROM users WHERE id = ?').get(userId);
            if (banInfo.ban_count >= 3) {
              db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(userId);
              ws.send(JSON.stringify({ type: 'error', message: 'Bạn đã bị cấm vì nội dung độc hại' }));
              return;
            } else {
              ws.send(JSON.stringify({ type: 'warning', message: 'Tin nhắn bị gắn cờ tiêu cực. Số lần: ' + banInfo.ban_count }));
              return;
            }
          }

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

          if (isPrivate) {
            const targetIds = [userId, recipientId];
            for (const id of targetIds) {
              const targetWs = clients.get(id);
              if (targetWs && targetWs.readyState === 1) {
                targetWs.send(JSON.stringify({ type: 'private_message', data: messageData }));
              }
            }
          } else {
            // ✅ KHÔNG loại trừ userId để người gửi cũng nhận được tin nhắn
            broadcastToRoom(roomId, { type: 'message', data: messageData });
          }

          const encrypted = encryptForNode(JSON.stringify(messageData));
          broadcastToNodeClients({ type: 'node_sync', data: encrypted });
          break;
        }

        case 'node_mode': {
          const { enabled } = msg;
          ws.isNode = !!enabled;
          break;
        }

        case 'node_sync': {
          const { encryptedData } = msg;
          if (encryptedData) {
            saveNodeData(userId, encryptedData);
            ws.send(JSON.stringify({ type: 'node_sync_ack' }));
          }
          break;
        }

        case 'node_restore_request': {
          ws.send(JSON.stringify({ type: 'node_restore_request' }));
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('WebSocket error:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Tin nhắn không hợp lệ' }));
    }
  });

  ws.on('close', () => {
    clients.delete(userId);
    for (const [roomId, set] of rooms) {
      set.delete(userId);
    }
  });
}

module.exports = { handleConnection };
