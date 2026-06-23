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
  document.getElementById('login').style.display = 'none';
  document.getElementById('chat').style.display = 'flex';
  connectWebSocket();
  loadRooms();
}

// Đăng nhập
document.getElementById('loginBtn').addEventListener('click', async () => {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) {
    alert('Vui lòng nhập tên đăng nhập và mật khẩu');
    return;
  }
  try {
    console.log('[Login] Gửi POST tới', API_BASE + '/auth/login');
    const res = await fetch(API_BASE + '/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });
    console.log('[Login] Status:', res.status);
    const data = await res.json();
    console.log('[Login] Data:', data);
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
      alert(data.error || 'Đăng nhập thất bại');
    }
  } catch (err) {
    console.error('[Login] Lỗi fetch:', err);
    alert('Lỗi kết nối: ' + err.message);
  }
});

// Đăng ký
document.getElementById('registerLink').addEventListener('click', async (e) => {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!username || !password) {
    alert('Vui lòng nhập tên đăng nhập và mật khẩu');
    return;
  }
  try {
    console.log('[Register] Gửi POST tới', API_BASE + '/auth/register');
    const res = await fetch(API_BASE + '/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ username, password })
    });
    console.log('[Register] Status:', res.status);
    const data = await res.json();
    console.log('[Register] Data:', data);
    if (res.ok) {
      alert('Đăng ký thành công! Vui lòng đăng nhập.');
    } else {
      alert(data.error || 'Đăng ký thất bại');
    }
  } catch (err) {
    console.error('[Register] Lỗi fetch:', err);
    alert('Lỗi kết nối: ' + err.message);
  }
});

// Kết nối WebSocket
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}/ws?token=${token}`;
  console.log('[WS] Đang kết nối tới', wsUrl);
  ws = new WebSocket(wsUrl);
  ws.onopen = () => console.log('[WS] Đã kết nối');
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsMessage(msg);
    } catch (e) {
      console.error('[WS] Lỗi parse:', e);
    }
  };
  ws.onclose = () => {
    console.log('[WS] Đã đóng');
    setTimeout(() => {
      if (token && document.getElementById('chat').style.display !== 'none') {
        connectWebSocket();
      }
    }, 3000);
  };
  ws.onerror = (err) => console.error('[WS] Lỗi:', err);
}

// Xử lý tin nhắn WebSocket
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
      console.log('[WS] Loại không xác định:', msg);
  }
}

// Hiển thị danh sách phòng
function renderRooms(rooms) {
  const list = document.getElementById('roomList');
  list.innerHTML = '';
  rooms.forEach(room => {
    const li = document.createElement('li');
    li.textContent = room.name + (room.is_public ? '' : ' (riêng tư)');
    li.style.cursor = 'pointer';
    li.onclick = () => joinRoom(room.id);
    list.appendChild(li);
  });
}

// Tham gia phòng
function joinRoom(roomId, password = null) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('WebSocket chưa kết nối');
    return;
  }
  ws.send(JSON.stringify({ type: 'join_room', roomId, password }));
  currentRoomId = roomId;
  document.getElementById('messageArea').innerHTML = '';
}

// Sự kiện nút tham gia phòng
document.getElementById('joinRoom').addEventListener('click', () => {
  const roomId = parseInt(document.getElementById('joinRoomId').value);
  const password = document.getElementById('joinRoomPass').value;
  if (!roomId) return;
  joinRoom(roomId, password || undefined);
});

// Tạo phòng mới
document.getElementById('createRoom').addEventListener('click', async () => {
  const name = document.getElementById('newRoomName').value.trim();
  if (!name) {
    alert('Vui lòng nhập tên phòng');
    return;
  }
  const isPublic = confirm('Phòng công khai?');
  const password = isPublic ? null : prompt('Nhập mật khẩu phòng:');
  try {
    const res = await fetch(API_BASE + '/rooms', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': 'Bearer ' + token
      },
      body: JSON.stringify({ name, is_public: isPublic, password })
    });
    const data = await res.json();
    if (res.ok) {
      alert('Phòng đã được tạo!');
      loadRooms();
    } else {
      alert(data.error || 'Tạo phòng thất bại');
    }
  } catch (err) {
    alert('Lỗi kết nối: ' + err.message);
  }
});

// Tải danh sách phòng
function loadRooms() {
  fetch(API_BASE + '/rooms', {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/json'
    }
  })
  .then(res => {
    if (!res.ok) throw new Error('Không thể tải phòng');
    return res.json();
  })
  .then(rooms => renderRooms(rooms))
  .catch(err => {
    console.error('[LoadRooms]', err);
    alert('Lỗi tải phòng: ' + err.message);
  });
}

// Hiển thị tin nhắn
function appendMessage(msg) {
  const area = document.getElementById('messageArea');
  const div = document.createElement('div');
  div.className = 'message' + (msg.isPrivate ? ' private' : '');
  div.textContent = `${msg.username}: ${msg.content} (${new Date(msg.timestamp).toLocaleTimeString()})`;
  area.appendChild(div);
  area.scrollTop = area.scrollHeight;
}

// Gửi tin nhắn công khai
document.getElementById('sendBtn').addEventListener('click', () => {
  const content = document.getElementById('messageInput').value.trim();
  if (!content || !currentRoomId) {
    alert('Hãy tham gia phòng trước');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('WebSocket chưa kết nối');
    return;
  }
  ws.send(JSON.stringify({ type: 'send_message', roomId: currentRoomId, content }));
  document.getElementById('messageInput').value = '';
});

// Gửi tin nhắn riêng tư
document.getElementById('sendPrivate').addEventListener('click', () => {
  const content = document.getElementById('messageInput').value.trim();
  const recipientId = parseInt(document.getElementById('privateUser').value);
  if (!content || !recipientId) {
    alert('Nhập nội dung và ID người nhận');
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('WebSocket chưa kết nối');
    return;
  }
  ws.send(JSON.stringify({ type: 'send_message', content, isPrivate: true, recipientId }));
  document.getElementById('messageInput').value = '';
});

// Gửi tin nhắn bằng phím Enter
document.getElementById('messageInput').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') document.getElementById('sendBtn').click();
});
