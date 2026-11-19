const bcrypt = require('bcrypt');
const db = require('../db');
const { moderate } = require('../gemini');
const { encryptForNode, decryptFromNode } = require('../node');
const { createLimiter } = require('../ratelimit');

const MAX_CONTENT = 2000;
const RESTORE_WINDOW_MS = 10 * 60 * 1000;

// userId -> Set<ws>  (một user có thể mở nhiều tab/thiết bị)
const clients = new Map();
// roomId -> Set<ws>
const rooms = new Map();

let restoreUntil = 0;

const sendLimiter = createLimiter(20, 10 * 1000); // 20 tin / 10 giây / user

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sendToUser(userId, obj) {
  for (const ws of clients.get(userId) || []) send(ws, obj);
}

function broadcastToRoom(roomId, obj) {
  for (const ws of rooms.get(roomId) || []) send(ws, obj);
}

function broadcastToNodeClients(obj) {
  for (const set of clients.values()) {
    for (const ws of set) if (ws.isNode) send(ws, obj);
  }
}

function getPublicRooms() {
  return db.prepare('SELECT id, name, is_public FROM rooms WHERE is_public = 1 ORDER BY id DESC').all();
}

function broadcastRooms() {
  const data = getPublicRooms();
  for (const set of clients.values()) for (const ws of set) send(ws, { type: 'rooms', data });
}

// Mở "cửa sổ khôi phục": yêu cầu mọi node gửi lại dữ liệu đã lưu
function startRestore() {
  restoreUntil = Date.now() + RESTORE_WINDOW_MS;
  let nodes = 0;
  for (const set of clients.values()) for (const ws of set) if (ws.isNode) nodes++;
  broadcastToNodeClients({ type: 'node_restore_request' });
  return { nodes, windowMs: RESTORE_WINDOW_MS };
}

function leaveRoom(ws, roomId) {
  const set = rooms.get(roomId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) rooms.delete(roomId);
  }
  ws.rooms.delete(roomId);
}

function disconnectBanned(userId) {
  for (const ws of clients.get(userId) || []) ws.close(1008, 'Banned');
}

// Khôi phục 1 tin nhắn từ blob của node (đã xác thực bằng GCM)
function restoreMessage(m) {
  if (!m || !Number.isInteger(m.id) || typeof m.content !== 'string') return false;
  if (!Number.isInteger(m.user_id)) return false;
  const author = db.prepare('SELECT 1 FROM users WHERE id = ?').get(m.user_id);
  if (!author) return false;
  const isPrivate = m.isPrivate ? 1 : 0;
  let roomId = null;
  let recipientId = null;
  if (isPrivate) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(m.recipientId)) return false;
    recipientId = m.recipientId;
  } else {
    if (!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(m.roomId)) return false;
    roomId = m.roomId;
  }
  const ts = new Date(m.timestamp);
  const tsSql = isNaN(ts) ? null : ts.toISOString().replace('T', ' ').slice(0, 19);
  const info = db.prepare(`
    INSERT OR IGNORE INTO messages (id, room_id, user_id, content, timestamp, is_private, recipient_id)
    VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?)
  `).run(m.id, roomId, m.user_id, m.content.slice(0, MAX_CONTENT), tsSql, isPrivate, recipientId);
  return info.changes > 0;
}

function handleConnection(ws) {
  const { userId, username } = ws.user;

  // Token còn hạn nhưng tài khoản có thể đã bị cấm / bị xoá
  const u = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(userId);
  if (!u || u.is_banned) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  ws.isNode = false;
  ws.isAlive = true;
  ws.rooms = new Set();
  ws.on('pong', () => { ws.isAlive = true; });

  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);

  send(ws, { type: 'welcome', userId, username });
  send(ws, { type: 'rooms', data: getPublicRooms() });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return send(ws, { type: 'error', message: 'Tin nhắn không hợp lệ' });
    }
    if (!msg || typeof msg !== 'object') return;

    try {
      switch (msg.type) {
        case 'join_room': {
          const roomId = Number(msg.roomId);
          if (!Number.isInteger(roomId)) return send(ws, { type: 'error', message: 'ID phòng không hợp lệ' });
          const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
          if (!room) return send(ws, { type: 'error', message: 'Phòng không tồn tại' });

          if (!room.is_public && !ws.rooms.has(roomId)) {
            if (!msg.password) return send(ws, { type: 'error', message: 'Yêu cầu mật khẩu' });
            const match = await bcrypt.compare(String(msg.password), room.password_hash);
            if (!match) return send(ws, { type: 'error', message: 'Sai mật khẩu' });
          }

          // Mỗi kết nối chỉ ở 1 phòng tại một thời điểm
          for (const r of [...ws.rooms]) if (r !== roomId) leaveRoom(ws, r);
          if (!rooms.has(roomId)) rooms.set(roomId, new Set());
          rooms.get(roomId).add(ws);
          ws.rooms.add(roomId);

          const past = db.prepare(`
            SELECT m.id, m.user_id, m.content, m.timestamp, u.username
            FROM messages m JOIN users u ON m.user_id = u.id
            WHERE m.room_id = ? AND m.is_private = 0
            ORDER BY m.id DESC LIMIT 50
          `).all(roomId).map(m => ({ ...m, roomId, timestamp: db.toISO(m.timestamp) })).reverse();

          send(ws, { type: 'joined', roomId, name: room.name });
          send(ws, { type: 'history', roomId, data: past });
          break;
        }

        case 'leave_room': {
          leaveRoom(ws, Number(msg.roomId));
          break;
        }

        case 'send_message': {
          const content = typeof msg.content === 'string' ? msg.content.trim() : '';
          if (!content) return;
          if (content.length > MAX_CONTENT) {
            return send(ws, { type: 'error', message: `Tin nhắn quá dài (tối đa ${MAX_CONTENT} ký tự)` });
          }
          if (!sendLimiter(userId)) {
            return send(ws, { type: 'error', message: 'Bạn gửi quá nhanh, hãy chậm lại' });
          }

          const isPrivate = !!msg.isPrivate;
          const roomId = Number(msg.roomId);
          const recipientId = Number(msg.recipientId);
          let recipientUsername = null;

          if (isPrivate) {
            if (!Number.isInteger(recipientId) || recipientId === userId) {
              return send(ws, { type: 'error', message: 'Người nhận không hợp lệ' });
            }
            const target = db.prepare('SELECT username FROM users WHERE id = ?').get(recipientId);
            if (!target) return send(ws, { type: 'error', message: 'Người nhận không tồn tại' });
            recipientUsername = target.username;
          } else if (!ws.rooms.has(roomId)) {
            // Chặn gửi vào phòng chưa tham gia (kể cả phòng riêng tư chưa nhập mật khẩu)
            return send(ws, { type: 'error', message: 'Bạn chưa tham gia phòng này' });
          }

          const userRow = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(userId);
          if (!userRow || userRow.is_banned) {
            send(ws, { type: 'error', message: 'Bạn đã bị cấm' });
            return disconnectBanned(userId);
          }

          // README: chỉ kiểm duyệt tin công khai
          if (!isPrivate && await moderate(content)) {
            db.prepare('UPDATE users SET ban_count = ban_count + 1 WHERE id = ?').run(userId);
            const { ban_count } = db.prepare('SELECT ban_count FROM users WHERE id = ?').get(userId);
            if (ban_count >= 3) {
              db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(userId);
              send(ws, { type: 'error', message: 'Bạn đã bị cấm vì nội dung độc hại' });
              return disconnectBanned(userId);
            }
            return send(ws, { type: 'warning', message: `Tin nhắn bị gắn cờ tiêu cực. Số lần: ${ban_count}/3` });
          }

          const info = db.prepare(`
            INSERT INTO messages (room_id, user_id, content, is_private, recipient_id)
            VALUES (?, ?, ?, ?, ?)
          `).run(isPrivate ? null : roomId, userId, content, isPrivate ? 1 : 0, isPrivate ? recipientId : null);

          const messageData = {
            id: Number(info.lastInsertRowid),
            user_id: userId,
            username,
            content,
            timestamp: new Date().toISOString(),
            isPrivate,
            roomId: isPrivate ? null : roomId,
            recipientId: isPrivate ? recipientId : null,
            recipientUsername
          };

          if (isPrivate) {
            const ev = { type: 'private_message', data: messageData };
            sendToUser(userId, ev);
            sendToUser(recipientId, ev);
          } else {
            broadcastToRoom(roomId, { type: 'message', data: messageData });
          }

          broadcastToNodeClients({ type: 'node_sync', data: encryptForNode(JSON.stringify(messageData)) });
          break;
        }

        case 'node_mode': {
          ws.isNode = !!msg.enabled;
          break;
        }

        case 'node_sync': {
          // Chỉ nhận khi admin đã mở cửa sổ khôi phục và client đang ở chế độ node
          if (!ws.isNode || Date.now() > restoreUntil) return;
          if (typeof msg.encryptedData !== 'string' || msg.encryptedData.length > 20000) return;
          let restored = false;
          try {
            restored = restoreMessage(JSON.parse(decryptFromNode(msg.encryptedData)));
          } catch (e) {
            return; // blob giả / sai khoá / hỏng -> bỏ qua
          }
          send(ws, { type: 'node_sync_ack', restored });
          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error('[WS] Handler error:', err);
      send(ws, { type: 'error', message: 'Lỗi máy chủ' });
    }
  });

  ws.on('close', () => {
    for (const r of [...ws.rooms]) leaveRoom(ws, r);
    const set = clients.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) clients.delete(userId);
    }
  });

  ws.on('error', (err) => console.error('[WS] Socket error:', err.message));
}

// Heartbeat: dọn kết nối chết
function startHeartbeat(wss) {
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(timer));
}

module.exports = { handleConnection, startHeartbeat, broadcastRooms, startRestore };
