const bcrypt = require('bcrypt');
const crypto = require('crypto');
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
    kind: 'message',
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

// Đóng gói 1 bản backup: kind + id để ngoài để node chống trùng mà không cần giải mã
function nodeEvent(payload) {
  return { type: 'node_sync', kind: payload.kind, id: payload.id, data: encryptForNode(JSON.stringify(payload)) };
}

function sendNodeBlob(ws, payload) {
  send(ws, nodeEvent(payload));
}

// Backup tài khoản / phòng (gồm cả password_hash — đã mã hoá bằng MASTER_KEY nên node không đọc được)
function userPayload(u) {
  return {
    kind: 'user', id: u.id, username: u.username, password_hash: u.password_hash,
    is_banned: u.is_banned ? 1 : 0, ban_count: u.ban_count || 0, created_at: u.created_at || null
  };
}

function roomPayload(r) {
  return {
    kind: 'room', id: r.id, name: r.name, is_public: r.is_public ? 1 : 0,
    password_hash: r.password_hash || null, created_by: r.created_by || null, created_at: r.created_at || null
  };
}

// Gửi tức thì cho mọi node khi có user / phòng mới hoặc đổi trạng thái (đăng ký, tạo phòng, bị cấm)
function backupUser(userId) {
  const u = db.prepare('SELECT * FROM users WHERE id = ? AND is_placeholder = 0').get(userId);
  if (u) broadcastToNodeClients(nodeEvent(userPayload(u)));
}

function backupRoom(roomId) {
  const r = db.prepare('SELECT * FROM rooms WHERE id = ? AND is_placeholder = 0').get(roomId);
  if (r) broadcastToNodeClients(nodeEvent(roomPayload(r)));
}

// Gửi TOÀN BỘ dữ liệu mã hoá xuống node: users, rooms rồi tin nhắn (theo lượt)
function sendFullSnapshot(ws) {
  for (const u of db.prepare('SELECT * FROM users WHERE is_placeholder = 0 ORDER BY id').all()) sendNodeBlob(ws, userPayload(u));
  for (const r of db.prepare('SELECT * FROM rooms WHERE is_placeholder = 0 ORDER BY id').all()) sendNodeBlob(ws, roomPayload(r));
  sendCatchup(ws, 0);
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

const isInt = Number.isInteger;
const sqlTime = (t) => {
  const d = new Date(t);
  return isNaN(d) || t == null ? null : d.toISOString().replace('T', ' ').slice(0, 19);
};

// Mã kết quả khôi phục: ok | dup | invalid | no_user | no_room
// Hash không thể đăng nhập, dùng cho tài khoản tạm (tính 1 lần)
let lockedHash = null;
function getLockedHash() {
  if (!lockedHash) lockedHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
  return lockedHash;
}

// Backup tin nhắn cũ không kèm user/phòng: dựng tài khoản/phòng "tạm" để vẫn giữ được lịch sử.
// Người dùng đăng ký lại đúng username sẽ nhận lại tài khoản tạm (xem routes/auth.js).
function ensureUser(id, name) {
  if (!isInt(id)) return false;
  if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) return true;
  let uname = typeof name === 'string' && /^[\p{L}\p{N}_.-]{3,32}$/u.test(name) ? name : `user${id}`;
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(uname)) uname = `${uname.slice(0, 26)}#${id}`;
  const info = db.prepare(
    'INSERT OR IGNORE INTO users (id, username, password_hash, is_placeholder) VALUES (?, ?, ?, 1)'
  ).run(id, uname, getLockedHash());
  return info.changes > 0 || !!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
}

function ensureRoom(id) {
  if (!isInt(id)) return false;
  if (db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(id)) return true;
  db.prepare("INSERT OR IGNORE INTO rooms (id, name, is_public, is_placeholder) VALUES (?, ?, 1, 1)").run(id, `Phòng ${id}`);
  return !!db.prepare('SELECT 1 FROM rooms WHERE id = ?').get(id);
}

// Khôi phục tài khoản. Bản ghi tạm cùng id được ghi đè bằng dữ liệu thật.
function restoreUser(u) {
  if (!isInt(u.id) || typeof u.username !== 'string' || !u.username) return 'invalid';
  if (typeof u.password_hash !== 'string' || !u.password_hash.startsWith('$2')) return 'invalid';
  const existing = db.prepare('SELECT is_placeholder FROM users WHERE id = ?').get(u.id);
  if (existing && !existing.is_placeholder) return 'dup';
  const banned = u.is_banned ? 1 : 0;
  const bans = isInt(u.ban_count) ? u.ban_count : 0;
  try {
    if (existing) {
      db.prepare('UPDATE users SET username = ?, password_hash = ?, is_banned = ?, ban_count = ?, is_placeholder = 0 WHERE id = ?')
        .run(u.username, u.password_hash, banned, bans, u.id);
      return 'ok';
    }
    const info = db.prepare(`
      INSERT OR IGNORE INTO users (id, username, password_hash, is_banned, ban_count, created_at)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
    `).run(u.id, u.username, u.password_hash, banned, bans, sqlTime(u.created_at));
    return info.changes > 0 ? 'ok' : 'dup';
  } catch (e) {
    return 'invalid'; // vd. trùng username với tài khoản khác
  }
}

// Khôi phục phòng (created_by trỏ tới user không còn thì để NULL)
function restoreRoom(r) {
  if (!isInt(r.id) || typeof r.name !== 'string' || !r.name) return 'invalid';
  const isPublic = r.is_public ? 1 : 0;
  if (!isPublic && typeof r.password_hash !== 'string') return 'invalid';
  const existing = db.prepare('SELECT is_placeholder FROM rooms WHERE id = ?').get(r.id);
  if (existing && !existing.is_placeholder) return 'dup';
  const creator = isInt(r.created_by) && db.prepare('SELECT 1 FROM users WHERE id = ?').get(r.created_by) ? r.created_by : null;
  const pw = isPublic ? null : r.password_hash;
  if (existing) {
    db.prepare('UPDATE rooms SET name = ?, is_public = ?, password_hash = ?, created_by = ?, is_placeholder = 0 WHERE id = ?')
      .run(r.name.slice(0, 64), isPublic, pw, creator, r.id);
    return 'ok';
  }
  const info = db.prepare(`
    INSERT OR IGNORE INTO rooms (id, name, is_public, password_hash, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).run(r.id, r.name.slice(0, 64), isPublic, pw, creator, sqlTime(r.created_at));
  return info.changes > 0 ? 'ok' : 'dup';
}

function restoreBlob(obj) {
  if (!obj || typeof obj !== 'object') return 'invalid';
  if (obj.kind === 'user') return restoreUser(obj);
  if (obj.kind === 'room') return restoreRoom(obj);
  return restoreMessage(obj); // kind = 'message' hoặc blob cũ chưa có kind
}

// Khôi phục 1 tin nhắn từ blob của node (đã xác thực bằng GCM)
function restoreMessage(m) {
  if (!m || !isInt(m.id) || typeof m.content !== 'string') return 'invalid';
  if (!isInt(m.user_id)) return 'invalid';
  if (db.prepare('SELECT 1 FROM messages WHERE id = ?').get(m.id)) return 'dup';

  if (!ensureUser(m.user_id, m.username)) return 'no_user';

  const isPrivate = m.isPrivate ? 1 : 0;
  let roomId = null;
  let recipientId = null;

  if (isPrivate) {
    if (!isInt(m.recipientId) || !ensureUser(m.recipientId, m.recipientUsername)) return 'no_user';
    recipientId = m.recipientId;
  } else {
    if (!isInt(m.roomId) || !ensureRoom(m.roomId)) return 'no_room';
    roomId = m.roomId;
  }

  const info = db.prepare(`
    INSERT OR IGNORE INTO messages (id, room_id, user_id, content, timestamp, is_private, recipient_id)
    VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, ?)
  `).run(m.id, roomId, m.user_id, m.content.slice(0, MAX_CONTENT), sqlTime(m.timestamp), isPrivate, recipientId);

  return info.changes > 0 ? 'ok' : 'dup';
}

// ---------------------------------------------------------------
// Kết nối WebSocket
// ---------------------------------------------------------------

function handleConnection(ws) {
  const { userId, username } = ws.user;

  // Token còn hạn nhưng tài khoản có thể đã bị cấm / bị xoá
  const u = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(userId);
  // Server vừa bị reset (không còn user nào): vẫn cho vào chế độ "chỉ khôi phục" để node gửi backup lên.
  // Token hợp lệ vì ký bằng JWT_SECRET; blob giả vẫn bị loại nhờ GCM.
  const wiped = !u && db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
  if ((!u && !wiped) || (u && u.is_banned)) {
    ws.close(1008, 'Unauthorized');
    return;
  }
  ws.restoreOnly = !u;

  ws.isNode = false;
  ws.isAlive = true;
  ws.rooms = new Set();
  ws.on('pong', () => { ws.isAlive = true; });

  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(ws);

  if (ws.restoreOnly) {
    // Phát hiện server rỗng: yêu cầu node gửi backup NGAY (không chờ admin / cửa sổ boot)
    console.log(`[WS] Server rỗng — mở phiên khôi phục cho ${username} (ID: ${userId})`);
    send(ws, { type: 'node_restore_hint', active: true });
    send(ws, { type: 'node_restore_request' });
  } else {
    send(ws, { type: 'welcome', userId, username });
    send(ws, { type: 'rooms', data: getPublicRooms() });
    if (autoRestoreOnBoot && Date.now() <= restoreDeadline) {
      send(ws, { type: 'node_restore_hint', active: true });
    }
  }

  // Khi tài khoản của chính node đã được khôi phục -> nâng phiên thành phiên chat bình thường
  const tryUpgrade = () => {
    if (!ws.restoreOnly) return;
    const row = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(userId);
    if (!row) return;
    if (row.is_banned) return ws.close(1008, 'Banned');
    ws.restoreOnly = false;
    send(ws, { type: 'welcome', userId, username });
    send(ws, { type: 'rooms', data: getPublicRooms() });
  };

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (err) {
      return send(ws, { type: 'error', message: 'Tin nhắn không hợp lệ' });
    }
    if (!msg || typeof msg !== 'object') return;

    // Phiên chỉ-khôi-phục: chỉ nhận các sự kiện node
    if (ws.restoreOnly && !['node_mode', 'node_sync', 'node_catchup'].includes(msg.type)) {
      tryUpgrade();
      if (ws.restoreOnly) return send(ws, { type: 'error', message: 'Server đang khôi phục dữ liệu, vui lòng thử lại sau' });
    }

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
              backupUser(userId);
              send(ws, { type: 'error', message: 'Bạn đã bị cấm vì nội dung độc hại' });
              return disconnectBanned(userId);
            }
            backupUser(userId);
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

          broadcastToNodeClients(nodeEvent({ kind: 'message', ...messageData }));
          break;
        }

        case 'node_mode': {
          ws.isNode = !!msg.enabled;
          send(ws, { type: 'node_mode_ack', enabled: ws.isNode });
          if (ws.isNode) {
            // Vừa kết nối: server gửi toàn bộ dữ liệu mã hoá xuống node (node bỏ qua bản trùng)...
            sendFullSnapshot(ws);
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

          let result = 'invalid';
          try {
            result = restoreBlob(JSON.parse(decryptFromNode(msg.encryptedData)));
          } catch (e) {
            // blob giả / sai khoá / hỏng -> bỏ qua
            return;
          }
          send(ws, { type: 'node_sync_ack', restored: result === 'ok', result });
          if (result === 'ok') tryUpgrade();
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
  maybeAutoRestore,
  backupUser,
  backupRoom
};
