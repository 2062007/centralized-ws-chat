const API_BASE = '/api';
let ws;
let token;
let currentRoomId = null;
let username;

// Login / Register
document.getElementById('loginBtn').addEventListener('click', async () => {
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const res = await fetch(API_BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (res.ok) {
    token = data.token;
    username = data.username;
    document.getElementById('login').style.display = 'none';
    document.getElementById('chat').style.display = 'flex';
    connectWebSocket();
    loadRooms();
  } else {
    alert(data.error || 'Login failed');
  }
});

document.getElementById('registerLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;
  const res = await fetch(API_BASE + '/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (res.ok) {
    alert('Registered! Please login.');
  } else {
    alert(data.error || 'Registration failed');
  }
});

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws?token=${token}`);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleWsMessage(msg);
  };
  ws.onclose = () => console.log('WebSocket closed');
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'rooms':
      renderRooms(msg.data);
      break;
    case 'message':
    case 'private_message':
      appendMessage(msg.data);
      break;
    case 'history':
      msg.data.forEach(m => appendMessage(m));
      break;
    case 'error':
      alert(msg.message);
      break;
    case 'warning':
      alert(msg.message);
      break;
    default:
      console.log('Unknown message type:', msg);
  }
}

function renderRooms(rooms) {
  const list = document.getElementById('roomList');
  list.innerHTML = '';
  rooms.forEach(room => {
    const li = document.createElement('li');
    li.textContent = room.name + (room.is_public ? '' : ' (private)');
    li.style.cursor = 'pointer';
    li.onclick = () => joinRoom(room.id);
    list.appendChild(li);
  });
}

function joinRoom(roomId, password = null) {
  ws.send(JSON.stringify({ type: 'join_room', roomId, password }));
  currentRoomId = roomId;
  document.getElementById('messageArea').innerHTML = '';
}

document.getElementById('joinRoom').addEventListener('click', () => {
  const roomId = parseInt(document.getElementById('joinRoomId').value);
  const password = document.getElementById('joinRoomPass').value;
  if (!roomId) return;
  joinRoom(roomId, password || undefined);
});

document.getElementById('createRoom').addEventListener('click', async () => {
  const name = document.getElementById('newRoomName').value;
  const isPublic = confirm('Public room?');
  const password = isPublic ? null : prompt('Enter password for private room:');
  const res = await fetch(API_BASE + '/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ name, is_public: isPublic, password })
  });
  const data = await res.json();
  if (res.ok) {
    alert('Room created!');
    loadRooms();
  } else {
    alert(data.error);
  }
});

function loadRooms() {
  fetch(API_BASE + '/rooms', {
    headers: { 'Authorization': 'Bearer ' + token }
  })
  .then(res => res.json())
  .then(rooms => renderRooms(rooms))
  .catch(err => console.error(err));
}

function appendMessage(msg) {
  const area = document.getElementById('messageArea');
  const div = document.createElement('div');
  div.className = 'message' + (msg.isPrivate ? ' private' : '');
  div.textContent = `${msg.username}: ${msg.content} (${new Date(msg.timestamp).toLocaleTimeString()})`;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

document.getElementById('sendBtn').addEventListener('click', () => {
  const content = document.getElementById('messageInput').value;
  if (!content || !currentRoomId) return;
  ws.send(JSON.stringify({ type: 'send_message', roomId: currentRoomId, content }));
  document.getElementById('messageInput').value = '';
});

document.getElementById('sendPrivate').addEventListener('click', () => {
  const content = document.getElementById('messageInput').value;
  const recipientId = parseInt(document.getElementById('privateUser').value);
  if (!content || !recipientId) return;
  ws.send(JSON.stringify({ type: 'send_message', content, isPrivate: true, recipientId }));
  document.getElementById('messageInput').value = '';
});

// Auto-join default room (lobby) on login? We'll let user choose.
// For simplicity, we can auto-join room 1 if exists.
