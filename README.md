# 🚀 Chat System – Real‑Time Decentralized Chat with Node Sync

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18.x-green)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.8+-blue)](https://python.org/)

A **real‑time chat application** with a **Node.js server** and **pure‑Python clients**.  
It features **end‑to‑end encrypted node clients** that store full chat history, **AI‑powered moderation** (via Gemini), **private messaging**, **password‑protected rooms**, and **automatic ban** for toxic users.  
The server uses **SQLite with WAL mode** for high concurrency, and clients can operate in **normal** or **node** mode.

---

## ✨ Features

- 🔐 **Secure authentication** – passwords hashed with bcrypt, JWTs for sessions.
- 🧩 **Decentralized node clients** – selected clients store an encrypted copy of all messages; server can restore data from them.
- 🤖 **AI moderation** – integrates with **Google Gemini API** to detect toxic messages; auto‑ban after 3 warnings.
- 💬 **Full chat experience** – public/private rooms, password‑protected rooms, private direct messages.
- 🌐 **Web UI** – giao diện hiện đại, tự đổi sáng/tối theo hệ thống, dùng tốt trên điện thoại: bong bóng chat gom nhóm theo người gửi, hộp thoại tạo/vào phòng, danh sách tin nhắn riêng có huy hiệu chưa đọc (bấm vào tên người khác để nhắn riêng), Enter gửi / Shift+Enter xuống dòng.
- 📦 **Pure‑Python client** – uses `aiohttp`, `colorama`, and `pyaes` – no C dependencies.
- 🔄 **Node sync** – node clients store encrypted blobs and send them back when the server requests a restore.
- 🛡️ **WAL mode** – enables high concurrency and better performance.

---

## 📁 Project Structure

```

project/
├── server/
│   ├── index.js                 # main entry point (HTTPS + WebSocket)
│   ├── db.js                    # SQLite setup with WAL mode
│   ├── auth.js                  # JWT & bcrypt helpers
│   ├── ratelimit.js             # giới hạn tốc độ
│   ├── gemini.js                # Gemini moderation integration
│   ├── node.js                  # node encryption/decryption (MASTER_KEY)
│   ├── package.json
│   ├── .env.example
│   ├── routes/
│   │   ├── auth.js              # /api/auth/register & /login
│   │   ├── admin.js             # /api/admin/restore
│   │   ├── rooms.js             # /api/rooms (list, create, join)
│   │   └── messages.js          # /api/messages (history, private)
│   ├── websocket/
│   │   ├── index.js
│   │   └── handlers.js          # all WS events (join, send, node mode, restore)
│   ├── static/
│   │   ├── index.html           # web client UI
│   │   ├── style.css
│   │   └── chat.js
│   └── certs/                   # self‑signed SSL certificates (create manually)
│       ├── server.key
│       └── server.crt
├── client/
│   ├── requirements.txt
│   ├── console.py               # input/getpass không chặn event loop
│   ├── client.py                # main Python entry point
│   ├── auth.py                  # login/register & credential storage (pyaes)
│   ├── crypto.py                # AES‑CTR encryption helpers
│   ├── chat.py                  # console interface & command handler
│   ├── ws_client.py             # WebSocket client (aiohttp)
│   ├── node.py                  # node mode: local SQLite store
│   └── config.json              # auto‑generated (server URL, saved creds)
└── README.md

```

---

## ⚙️ Requirements

- **Server**:
  - Node.js 18.x or later
  - npm
- **Client**:
  - Python 3.8+
  - `pip` (for installing dependencies)

---

## 🚀 Installation & Setup

### 1. Clone the repository

```bash
git clone https://github.com/2062007/centralized-ws-chat
cd centralized-ws-chat
```

2. Server setup

```bash
cd server
npm install
```

Create a .env file from the example:

```bash
cp .env.example .env
```

Edit .env and set your own secrets:

```
JWT_SECRET=your_jwt_secret_here
MASTER_KEY=your_32_byte_master_key_for_node_encryption
GEMINI_API_KEY=your_gemini_api_key
ADMIN_TOKEN=optional_token_for_restore_endpoint
PORT=3000
```

JWT_SECRET và MASTER_KEY là **bắt buộc** (>= 16 ký tự, nên dùng chuỗi ngẫu nhiên dài); server sẽ từ chối khởi động nếu thiếu. MASTER_KEY được băm SHA-256 thành khoá AES-256 nên độ dài tuỳ ý.
If you don't have a Gemini API key, you can leave it empty – moderation will be disabled.

Generate a self‑signed SSL certificate (for local development):

```bash
mkdir certs
openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt -days 365 -nodes -subj "/CN=localhost"
```

Start the server:

```bash
npm start
```

Server mặc định lắng nghe ở cổng 3000 (đổi bằng PORT). Có `certs/` thì chạy HTTPS, không thì HTTP.

3. Client setup

```bash
cd client
pip install -r requirements.txt
```

Run the client:

```bash
python client.py
```

**Chỉ chạy node backup, không cần đăng nhập:**

```bash
python client.py --sync-only
```

Chế độ này kết nối WebSocket không token, nhận snapshot DB đã mã hoá AES-256-GCM từ server và lưu cục bộ. Kết nối này không thể vào phòng, đọc tin nhắn dạng rõ, gửi chat hoặc gọi API tài khoản. File backup được lưu tại `node_anonymous.db`. Server gửi snapshot ngay khi node kết nối và gửi lại toàn bộ snapshot định kỳ mỗi 5 phút. Client chỉ upload ngược lên server khi server mở cửa sổ khôi phục bằng `node_restore_request`. Server giới hạn số lần kết nối/IP, số kết nối ẩn danh đồng thời, tốc độ frame/kết nối, kích thước blob và số blob mỗi kết nối.

Dùng `MASTER_KEY` ngẫu nhiên tối thiểu 32 byte và giữ nguyên bí mật. AES-256-GCM xác thực ciphertext trước khi restore; mã hoá không ngăn DoS hoặc việc xoá DB, vì vậy vẫn cần persistent disk và backup vận hành độc lập.


When prompted, enter the server URL (e.g., https://localhost or https://your-app.onrender.com).
You can also set the environment variable CHAT_SERVER_URL to skip the prompt.

---

🔧 Configuration

Server environment variables

Variable Description
JWT_SECRET Secret key used to sign JWTs.
MASTER_KEY 32‑byte key for encrypting node‑sync data (AES‑256‑GCM).
GEMINI_API_KEY Google Gemini API key (optional; moderation will be skipped if missing).
PORT Cổng lắng nghe (mặc định 3000).
GEMINI_MODEL Model Gemini dùng kiểm duyệt (mặc định gemini-2.0-flash).
ADMIN_TOKEN Token cho POST /api/admin/restore (bỏ trống = tắt).
DB_PATH Đường dẫn file SQLite (mặc định server/chat.db).

Client configuration

The client stores:

· Saved credentials (username + encrypted password) in config.json
· Server URL in server_config.json (if entered manually)
· Node data in node_<username>.db (SQLite)

---

📡 Usage

Server

Once the server is running, it provides:

· REST API (port 443) for authentication, room management, and message history.
· WebSocket endpoint at wss://<host>/ws?token=<JWT> for real‑time messaging.

Web Client

Mở trình duyệt tại http://localhost:3000 (hoặc https nếu có certs) (accept the self‑signed certificate warning).
Use the web UI to:

· Register / login
· Create public or private rooms
· Join rooms (provide password if needed)
· Send public messages and private messages (by user ID)

Python Client (Console)

After login, you enter a chat interface. Available commands:

Command Description
/join <room_id> [password] Join a room (password required for private rooms).
/create <room_name> [password] Create a new room. If password is given, it's private.
/leave Leave the current room.
/msg <user_id> <message> Send a private message to a specific user.
/node on / /node off Enable or disable node mode.
/exit Quit the client.

In node mode, the client stores all encrypted messages it receives and can later send them back to the server when requested.

---

🔌 API Endpoints

Method Endpoint Description
POST /api/auth/register Register a new user.
POST /api/auth/login Login, returns JWT.
GET /api/rooms List all public rooms.
POST /api/rooms Create a room (public or private).
POST /api/rooms/join/:roomId Verify password for private room.
POST /api/admin/restore Mở cửa sổ khôi phục node (Bearer ADMIN_TOKEN).
GET /api/messages/room/:roomId Tin nhắn phòng (phòng riêng: header X-Room-Password).
GET /api/messages/private/:userId Get private messages between users.

All endpoints (except auth) require the Authorization: Bearer <JWT> header.

---

📨 WebSocket Events

The WebSocket connection uses JSON messages. Below are the main event types:

Client → Server

Event Payload Description
join_room { roomId, password? } Join a room.
leave_room { roomId } Leave a room.
send_message { roomId, content, isPrivate?, recipientId? } Send a message.
node_mode { enabled, lastId? } Bật/tắt node mode; kèm lastId (con trỏ backup) để server tự gửi bù tin còn thiếu.
node_catchup { afterId } Xin lượt đồng bộ bù tiếp theo (khi more = true).
node_sync { encryptedData } Send stored encrypted data to server.
node_restore_request (no payload) Server requests node data.

Server → Client

Event Payload Description
rooms { data: [ {id, name, is_public} ] } List of public rooms.
history { roomId, data: [messages] } Past messages of the room.
message { data: { id, user_id, username, content, timestamp } } New public message.
private_message { data: { ... } } New private message.
node_sync { kind, id, data: encrypted_blob } Bản backup mã hoá cho node (kind = user/room/message; kind+id để node chống trùng).
node_mode_ack { enabled } Xác nhận trạng thái node.
node_catchup_done { upTo, more, sent } Kết thúc 1 lượt đồng bộ bù; node lưu upTo làm con trỏ.
node_restore_request (no payload) Server asks client to send its data.
error / warning { message } Error or warning from server.

---

🧠 Node Sync – How It Works

1. The server holds a MASTER_KEY (32‑byte AES key).
2. When a message is broadcast, the server encrypts it using MASTER_KEY and sends it as a node_sync event to all clients that have node mode enabled.
3. Node clients store these encrypted blobs locally (in SQLite).
4. Khi cần khôi phục, admin gọi `POST /api/admin/restore` (Bearer ADMIN_TOKEN); server gửi node_restore_request tới các node.
5. Mỗi node gửi lại các blob qua node_sync (server chỉ nhận trong 10 phút sau yêu cầu).
6. Server giải mã bằng MASTER_KEY (AES-GCM xác thực toàn vẹn nên blob giả bị loại) và chèn lại tin nhắn còn thiếu (INSERT OR IGNORE theo id).

### Đồng bộ hai chiều khi node kết nối

Backup gồm **toàn bộ dữ liệu**: `user` (kèm password_hash), `room` và `message`, tất cả mã hoá AES-256-GCM bằng MASTER_KEY (node không đọc được). Mỗi khi client ở chế độ node kết nối (hoặc kết nối lại, hoặc `/node on`), server gửi snapshot; sau đó server tiếp tục gửi lại toàn bộ snapshot mỗi 5 phút:

1. Client gửi `node_mode { enabled: true }`.
2. **Server → node:** server gửi toàn bộ users, rooms rồi tin nhắn (`node_sync { kind, id, data }`; tin nhắn 500 bản ghi/lượt, node tự xin lượt tiếp bằng `node_catchup`). Node lưu theo khoá `(kind, id)`: tin nhắn trùng thì bỏ qua, user/room trùng thì ghi đè bản mới nhất. Khi có user/phòng mới hoặc bị cấm, server gửi tức thì cho mọi node.
3. **Node → server:** node chỉ gửi bản backup (`node_sync { encryptedData }`) sau khi server chủ động phát `node_restore_request` trong cửa sổ khôi phục. Kết nối hoặc bật node bình thường không tự cấp quyền upload. Server giải mã + xác thực GCM, bản giả bị loại, bản trùng bị bỏ qua, bản thiếu được chèn lại.

#### Backup định kỳ và khôi phục server

Cứ mỗi 5 phút, server gửi một snapshot đầy đủ xuống từng node đang online. Node lưu các blob mã hoá trong `node_anonymous.db`; server không yêu cầu node gửi backup ngược lên trong chu kỳ định kỳ. Khi DB server bị rỗng, luồng khôi phục riêng mới mở quyền cho node gửi dữ liệu đã lưu trở lại server.

#### Server mới khởi động / DB bị xoá

Khi DB hoàn toàn rỗng, server tự mở cửa sổ khôi phục có thời hạn. Client ẩn danh không cần tài khoản có thể nhận snapshot mã hoá; server chỉ chấp nhận upload sau `node_restore_request`. Client đã đăng nhập cũ vẫn có thể dùng luồng restore-only bằng token còn hạn. Mọi khoá tài khoản/phòng/tin nhắn giữ nguyên id gốc.

**Backup cũ chỉ có tin nhắn** (chưa có user/phòng): server dựng tài khoản/phòng *tạm* (`is_placeholder = 1`, không đăng nhập được) để giữ lịch sử. Ai đăng ký lại đúng username sẽ nhận lại tài khoản tạm (tắt bằng `ALLOW_CLAIM_PLACEHOLDER=0`; lưu ý người đăng ký trước sẽ chiếm được username đó). Khi node gửi user/phòng thật, bản tạm được ghi đè.

**Client sau khi server reset:** có thể chạy `python client.py --sync-only` trên bất kỳ máy nào đã giữ `node_anonymous.db`; không cần tài khoản hay JWT. Client đã đăng nhập trước đây cũng có thể dùng token còn hạn để phục hồi theo luồng tương thích cũ.

⚠️ Node clients cannot decrypt the blobs without the MASTER_KEY, ensuring that even if a node is compromised, the chat history remains confidential.

---

🤖 AI Moderation (Gemini)

· Server gọi Gemini cho mỗi tin nhắn công khai (tin riêng không bị kiểm duyệt).
· If the API returns "negative", the user's ban_count increases.
· After 3 negative flags, the user is automatically banned.
· Moderation is non‑blocking – the API call is made asynchronously; messages are still delivered (unless flagged, in which case they are dropped).

---

🔒 Security Notes

· The server uses HTTPS only; HTTP requests are not accepted (you can add redirection if needed).
· All passwords are hashed with bcrypt.
· JWTs are used for all authenticated requests and WebSocket connections.
· Node‑sync data is encrypted with AES‑256‑GCM using a server‑side MASTER_KEY.
· Client credentials (username + password) are stored locally with AES‑CTR (using a master password chosen by the user).

---

🛠️ Troubleshooting

Server won’t start

· Cổng PORT chưa bị chiếm.
· JWT_SECRET và MASTER_KEY phải được đặt trong .env.
· Verify that .env contains all required variables.

Client connection fails

· Confirm the server URL is correct.
· Với localhost client tự bỏ qua kiểm tra chứng chỉ; với server khác có chứng chỉ tự ký, đặt CHAT_INSECURE_SSL=1.
· Check that the server is reachable and the WebSocket endpoint is /ws.

Gemini moderation not working

· Either GEMINI_API_KEY is missing or the API call fails. The server logs errors; moderation will be skipped.

---

📦 Deployment

Deploy Server to Render.com

1. Push the server folder to a GitHub repository.
2. On Render, create a new Web Service and point to the repo.
3. Set the Root Directory to server.
4. Add environment variables as in .env.example.
5. Render will automatically use HTTPS and provide a public URL (e.g., https://your-app.onrender.com).

Render cung cấp TLS sẵn: không cần thư mục certs, server tự chạy HTTP phía sau proxy.

Deploy Client (Standalone)

· The client is a Python script – no deployment needed; just run it on any machine.

---

🤝 Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository.
2. Create a feature branch (git checkout -b feature/AmazingFeature).
3. Commit your changes (git commit -m 'Add some AmazingFeature').
4. Push to the branch (git push origin feature/AmazingFeature).
5. Open a Pull Request.

---

📄 License

Distributed under the MIT License. See LICENSE for more information.

---

👀 Acknowledgements

· better-sqlite3 – SQLite library for Node.js.
· aiohttp – Async HTTP client for Python.
· pyaes – Pure‑Python AES implementation.
· Google Gemini – AI moderation API.

---

Built with ❤️ by TGFN team.
Happy chatting! 🎉


Anonymous node backup upload is requested by the server every 5 minutes.
