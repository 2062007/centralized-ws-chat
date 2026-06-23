const API_BASE = '/api';
let ws;
let token;
let currentRoomId = null;
let username;

// Kiểm tra token trong localStorage
const savedToken = localStorage.getItem('token');
if (savedToken) {
  token = savedToken;
  username = localStorage.getItem('username') || '';
  // Hiện chat, ẩn login
  document.getElementById('login').style.display = 'none';
  document.getElementById('chat').style.display = 'flex';
  connectWebSocket();
  loadRooms();
}

// Login
document.getElementById('loginBtn').addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) {
    alert('Please enter username and password');
    return;
  }
  try {
    const res = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok) {
      token = data.token;
      username = data.username;
      localStorage.setItem('token', token);
      localStorage.setItem('username', username);
      document.getElementById('login').style.display = 'none';
      document.getElementById('chat').style.display = 'flex';
      connectWebSocket();
      loadRooms();
    } else {
      alert(data.error || 'Login failed');
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  }
});

document.getElementById('registerLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) {
    alert('Please enter username and password');
    return;
  }
  try {
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
  } catch (err) {
    alert('Network error: ' + err.message);
  }
});

function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/ws?token=${token}`;
  console.log('Connecting to WebSocket:', wsUrl);
  ws = new WebSocket(wsUrl);
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch (e) {
      console.error('Invalid message:', e);
    }
  };
  ws.onclose = () => {
    console.log('WebSocket closed');
    // Tự động reconnect sau 3s
    setTimeout(() => {
      if (token && document.getElementById('chat').style.display !== 'none') {
        connectWebSocket();
      }
    }, 3000);
  };
  ws.onerror = (err) => console.error('WebSocket error:', err);
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
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('WebSocket not connected');
    return;
  }
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
  const name = document.getElementById('newRoomName').value.trim();
  if (!name) {
    alert('Please enter room name');
    return;
  }
  const isPublic = confirm('Public room?');
  const password = isPublic ? null : prompt('Enter password for private room:');
  try {
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
      alert(data.error || 'Failed to create room');
    }
  } catch (err) {
    alert('Network error: ' + err.message);
  }
});

function loadRooms() {
  fetch(API_BASE + '/rooms', {
    headers: { 'Authorization': 'Bearer ' + token }
  })
  .then(res => {
    if (!res.ok) throw new Error('Failed to load rooms');
    return res.json();
  })
  .then(rooms => renderRooms(rooms))
  .catch(err => {
    console.error(err);
    alert('Error loading rooms: ' + err.message);
  });
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
  const content = document.getElementById('messageInput').value.trim();
  if (!content || !currentRoomId) {
    alert('Join a room first');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('WebSocket not connected');
    return;
  }
  ws.send(JSON.stringify({ type: 'send_message', roomId: currentRoomId, content }));
  document.getElementById('messageInput').value = '';
});

document.getElementById('sendPrivate').addEventListener('click', () => {
  const content = document.getElementById('messageInput').value.trim();
  const recipientId = parseInt(document.getElementById('privateUser').value);
  if (!content || !recipientId) {
    alert('Enter message and recipient ID');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('WebSocket not connected');
    return;
  }
  ws.send(JSON.stringify({ type: 'send_message', content, isPrivate: true, recipientId }));
  document.getElementById('messageInput').value = '';
});

// Enter key for message input
document.getElementById('messageInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('sendBtn').click();
});

// Logout (optional) – clear localStorage
// Có thể thêm nút logout nếu muốn
