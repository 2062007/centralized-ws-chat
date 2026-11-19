const bcrypt = require('bcrypt');
const db = require('../db');
const { moderate } = require('../gemini');
const { encryptForNode, decryptFromNode } = require('../node');
const { createLimiter } = require('../ratelimit');

const MAX_CONTENT = 2000;
const RESTORE_WINDOW_MS = 10 * 60 * 1000;
const CATCHUP_BATCH = 500; // số bản ghi tối đa mỗi lượt gửi cho node

// userId -> Set<ws>  (một user có thể mở nhiều tab/thiết bị)
const clients = new Map();
// roomId -> Set<ws>
const rooms = new Map();

// ---- Trạng thái khôi phục ----
let restoreUntil = 0;      // hạn "mềm" — có thể gia hạn khi node mới vào
let restoreDeadline = 0;   // hạn "cứng" — không bao giờ vượt qua khi auto-restore
let autoRestoreOnBoot = false;

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

function countNodeClients() {
  let n = 0;
  for (const set of clients.values()) for (const ws of set) if (ws.isNode) n++;
  return n;
}

// Dựng payload của 1 tin nhắn (cùng định dạng với tin broadcast trực tiếp)
function nodePayload(m) {
  return {
    id: m.id,
    user_id: m.user_id,
    username: m.username,
    content: m.content,
    timestamp: db.toISO(m.timestamp),
    isPrivate: !!m.is_private,
    roomId: m.is_private ? null : m.room_id,
    recipientId: m.is_private ? m.recipient_id : null,
    recipientUsername: m.recipient_username || null
  };
}

// Gửi 1 bản backup cho node: kèm id ở ngoài để node chống trùng mà không cần giải mã
function sendNodeBlob(ws, payload) {
  send(ws, { type: 'node_sync', id: payload.id, data: encryptForNode(JSON.stringify(payload)) });
}

// Đồng bộ bù: gửi các tin có id > afterId mà node còn thiếu (do offline / mới bật node).
// Mỗi lượt tối đa CATCHUP_BATCH; node xin lượt tiếp khi more = true.
function sendCatchup(ws, afterId) {
  const rows = db.prepare(`
    SELECT m.id, m.room_id, m.user_id, m.content, m.timestamp, m.is_private, m.recipient_id,
           u.username, r.username AS recipient_username
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN users r ON r.id = m.recipient_id
    WHERE m.id > ?
    ORDER BY m.id
    LIMIT ?
  `).all(afterId, CATCHUP_BATCH + 1);
  const more = rows.length > CATCHUP_BATCH;
  if (more) rows.pop();
  for (const m of rows) sendNodeBlob(ws, nodePayload(m));
  // Hết dữ liệu: upTo = id lớn nhất hiện có (cũng tự sửa con trỏ nếu DB server từng bị reset)
  const upTo = more ? rows[rows.length - 1].id
    : (db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM messages').get().m);
  send(ws, { type: 'node_catchup_done', upTo, more, sent: rows.length });
}

function getPublicRooms() {
  return db.prepare('SELECT id, name, is_public FROM rooms WHERE is_public = 1 ORDER BY id DESC').all();
}

function broadcastRooms() {
  const data = getPublicRooms();
  for (const set of clients.values()) for (const ws of set) send(ws, { type: 'rooms', data });
}

// ---------------------------------------------------------------
// Khôi phục dữ liệu từ node client
// ---------------------------------------------------------------

// Mở "cửa sổ khôi phục". extend=true: gia hạn (dùng khi node mới vào),
// ngược lại: reset cửa sổ mới (gọi từ admin hoặc lúc boot).
function startRestore({ extend = false, windowMs = RESTORE_WINDOW_MS } = {}) {
  const now = Date.now();

  if (extend) {
    // Chỉ gia hạn nếu vẫn trong cửa sổ auto-restore ban đầu
    if (!autoRestoreOnBoot || now > restoreDeadline) {
      return { nodes: countNodeClients(), windowMs: 0, extended: false };
    }
    restoreUntil = Math.max(restoreUntil, now + windowMs);
  } else {
    autoRestoreOnBoot = false;
    restoreUntil = now + windowMs;
    restoreDeadline = restoreUntil;
  }

  const nodes = countNodeClients();
  broadcastToNodeClients({ type: 'node_restore_request' });
  return { nodes, windowMs: Math.max(0, restoreUntil - now), extended: extend };
}

// Gọi lúc boot: nếu bảng messages rỗng thì mở cửa sổ auto-restore dài.
// Node client kết nối sau đó sẽ được yêu cầu gửi dữ liệu.
function maybeAutoRestore() {
  const empty = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 0;
  if (!empty) return { started: false, reason: 'db not empty' };

  // startRestore() (không extend) reset autoRestoreOnBoot về false, nên phải bật cờ SAU khi gọi
  startRestore({ windowMs: RESTORE_WINDOW_MS });
  autoRestoreOnBoot = true;
  console.log('🔄 DB rỗng → mở cửa sổ khôi phục, chờ node client gửi dữ liệu...');
  return { started: true, windowMs: RESTORE_WINDOW_MS };
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

// ---------------------------------------------------------------
// Kết nối WebSocket
// ---------------------------------------------------------------

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

  // Nếu đang trong cửa sổ auto-restore, nhắc node mới gửi dữ liệu ngay
  if (autoRestoreOnBoot && Date.now() <= restoreDeadline) {
    // Gửi kèm tín hiệu để client biết cần bật node_mode
    send(ws, { type: 'node_restore_hint', active: true });
  }

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

          // Chỉ kiểm duyệt tin công khai
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

          broadcastToNodeClients({ type: 'node_sync', id: messageData.id, data: encryptForNode(JSON.stringify(messageData)) });
          break;
        }

        case 'node_mode': {
          ws.isNode = !!msg.enabled;
          send(ws, { type: 'node_mode_ack', enabled: ws.isNode });
          if (ws.isNode) {
            // Vừa kết nối: server gửi toàn bộ dữ liệu mã hoá xuống node (node bỏ qua bản trùng)...
            sendCatchup(ws, 0);
            // ...và cho phép node gửi bản DB đang có lên server trong cửa sổ này (server bỏ qua bản trùng)
            ws.nodeUploadUntil = Date.now() + RESTORE_WINDOW_MS;
            // Node mới bật giữa cửa sổ auto-restore → gia hạn + yêu cầu gửi dữ liệu
            if (autoRestoreOnBoot && Date.now() <= restoreDeadline) {
              startRestore({ extend: true }); // đã broadcast node_restore_request tới mọi node (gồm node này)
            }
          }
          break;
        }

        case 'node_catchup': {
          if (!ws.isNode || !Number.isInteger(msg.afterId) || msg.afterId < 0) return;
          sendCatchup(ws, msg.afterId);
          break;
        }

        case 'node_sync': {
          // Chỉ nhận khi client đang ở chế độ node
          if (!ws.isNode) return;

          // Cho phép nếu còn trong cửa sổ mềm hoặc cửa sổ cứng auto-restore
          const now = Date.now();
          const inWindow = now <= Math.max(restoreUntil, ws.nodeUploadUntil || 0) ||
            (autoRestoreOnBoot && now <= restoreDeadline);
          if (!inWindow) return;

          if (typeof msg.encryptedData !== 'string' || msg.encryptedData.length > 20000) return;

          let restored = false;
          try {
            restored = restoreMessage(JSON.parse(decryptFromNode(msg.encryptedData)));
          } catch (e) {
            // blob giả / sai khoá / hỏng -> bỏ qua
            return;
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

module.exports = {
  handleConnection,
  startHeartbeat,
  broadcastRooms,
  startRestore,
  maybeAutoRestore
};
