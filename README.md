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
- 🌐 **Web UI** – a static web client (HTML/CSS/JS) with the same chat capabilities.
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
│   ├── gemini.js                # Gemini moderation integration
│   ├── node.js                  # node encryption/decryption (MASTER_KEY)
│   ├── package.json
│   ├── .env.example
│   ├── routes/
│   │   ├── auth.js              # /api/auth/register & /login
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
PORT=443
```

MASTER_KEY must be exactly 32 bytes (e.g., 01234567890123456789012345678901).
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

The server will listen on https://localhost:443 (or the port you set).

3. Client setup

```bash
cd client
pip install aiohttp colorama pyaes
```

Run the client:

```bash
python client.py
```

When prompted, enter the server URL (e.g., https://localhost or https://your-app.onrender.com).
You can also set the environment variable CHAT_SERVER_URL to skip the prompt.

---

🔧 Configuration

Server environment variables

Variable Description
JWT_SECRET Secret key used to sign JWTs.
MASTER_KEY 32‑byte key for encrypting node‑sync data (AES‑256‑GCM).
GEMINI_API_KEY Google Gemini API key (optional; moderation will be skipped if missing).
PORT Port on which the HTTPS server listens (default 443).

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

Open your browser at https://localhost (accept the self‑signed certificate warning).
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
GET /api/messages/room/:roomId Get recent messages of a room.
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
node_mode { enabled } Enable/disable node mode.
node_sync { encryptedData } Send stored encrypted data to server.
node_restore_request (no payload) Server requests node data.

Server → Client

Event Payload Description
rooms { data: [ {id, name, is_public} ] } List of public rooms.
history { roomId, data: [messages] } Past messages of the room.
message { data: { id, user_id, username, content, timestamp } } New public message.
private_message { data: { ... } } New private message.
node_sync { data: encrypted_blob } Encrypted message for node clients.
node_restore_request (no payload) Server asks client to send its data.
error / warning { message } Error or warning from server.

---

🧠 Node Sync – How It Works

1. The server holds a MASTER_KEY (32‑byte AES key).
2. When a message is broadcast, the server encrypts it using MASTER_KEY and sends it as a node_sync event to all clients that have node mode enabled.
3. Node clients store these encrypted blobs locally (in SQLite).
4. If the server ever needs to restore lost data, it sends a node_restore_request to all nodes.
5. Each node responds with its stored encrypted blobs via node_sync.
6. The server decrypts the blobs with MASTER_KEY and inserts them back into the main database.

⚠️ Node clients cannot decrypt the blobs without the MASTER_KEY, ensuring that even if a node is compromised, the chat history remains confidential.

---

🤖 AI Moderation (Gemini)

· The server calls the Gemini API for every public message.
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

· Ensure ports 443 (or your PORT) are not in use.
· Check that certs/server.key and certs/server.crt exist.
· Verify that .env contains all required variables.

Client connection fails

· Confirm the server URL is correct.
· If using self‑signed certificates, the client uses ssl=False – if you use real SSL, change it to True.
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

Note: Since Render provides SSL, you don't need the certs folder – remove the SSL options from index.js or use http with Render's built‑in TLS.

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
