(() => {
  'use strict';
  const API = '/api';
  const $ = (id) => document.getElementById(id);

  const ICON_LOCK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  // ---------- trạng thái ----------
  const S = {
    token: localStorage.getItem('token'),
    username: localStorage.getItem('username') || '',
    userId: Number(localStorage.getItem('userId')) || null,
    ws: null,
    reconnectDelay: 1000,
    reconnectTimer: null,
    publicRooms: [],
    privateRooms: new Map(),   // phòng riêng tư đã vào trong phiên này
    dms: new Map(),            // peerId -> { id, name, unread }
    view: null,                // { type: 'room'|'dm', id, name }
    lastRoom: null,            // { id, name, password } để vào lại nhanh
    pending: null,             // { id, password } đang chờ server xác nhận
    last: null,                // tin nhắn cuối đã vẽ (để gom nhóm)
    authMode: 'login'
  };

  // ---------- tiện ích ----------
  function toast(text, kind = '', ms = 3500) {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function initials(name) {
    return Array.from((name || '?').trim())[0] || '?';
  }
  function hue(id) { return (Number(id) * 47 + 200) % 360; }
  function setAvatar(el, name, id) {
    el.textContent = initials(name);
    el.style.setProperty('--h', hue(id));
  }

  async function copy(text, okMsg) {
    try { await navigator.clipboard.writeText(String(text)); toast(okMsg, 'ok', 2000); }
    catch (e) { toast('Không sao chép được, ID là ' + text); }
  }

  async function api(path, options = {}) {
    const res = await fetch(API + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}),
        ...(options.headers || {})
      }
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* không phải JSON */ }
    return { res, data };
  }

  // ---------- đăng nhập / đăng ký ----------
  function setAuthMode(mode) {
    S.authMode = mode;
    const login = mode === 'login';
    $('tabLogin').setAttribute('aria-selected', login);
    $('tabRegister').setAttribute('aria-selected', !login);
    $('authSubmit').textContent = login ? 'Đăng nhập' : 'Tạo tài khoản';
    $('pwHint').hidden = login;
    $('password').autocomplete = login ? 'current-password' : 'new-password';
    showAuthError('');
  }
  function showAuthError(msg) {
    const el = $('authError');
    el.textContent = msg;
    el.hidden = !msg;
  }

  async function submitAuth(e) {
    e.preventDefault();
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) return showAuthError('Nhập tên đăng nhập và mật khẩu.');
    const btn = $('authSubmit');
    btn.disabled = true;
    showAuthError('');
    try {
      if (S.authMode === 'register') {
        const r = await api('/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) });
        if (!r.res.ok) return showAuthError(viError(r.data?.error) || 'Không tạo được tài khoản.');
      }
      const { res, data } = await api('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      if (!res.ok) return showAuthError(viError(data?.error) || 'Đăng nhập thất bại.');
      S.token = data.token; S.username = data.username; S.userId = data.userId;
      localStorage.setItem('token', S.token);
      localStorage.setItem('username', S.username);
      localStorage.setItem('userId', String(S.userId));
      $('password').value = '';
      enterApp();
    } catch (err) {
      showAuthError('Không kết nối được máy chủ: ' + err.message);
    } finally {
      btn.disabled = false;
    }
  }

  const ERR_VI = {
    'Invalid credentials': 'Sai tên đăng nhập hoặc mật khẩu.',
    'Username already exists': 'Tên đăng nhập đã có người dùng.',
    'User is banned': 'Tài khoản này đã bị cấm.',
    'Too many requests': 'Quá nhiều lần thử, hãy đợi vài phút rồi thử lại.',
    'Username must be 3-32 chars (letters, digits, _ . -)': 'Tên đăng nhập gồm 3–32 ký tự: chữ, số, _ . -',
    'Password must be 8-72 characters': 'Mật khẩu cần từ 8 đến 72 ký tự.'
  };
  function viError(e) { return ERR_VI[e] || e; }

  function logout(message) {
    S.token = null; S.view = null; S.lastRoom = null; S.pending = null;
    ['token', 'username', 'userId'].forEach((k) => localStorage.removeItem(k));
    clearTimeout(S.reconnectTimer);
    if (S.ws) { S.ws.onclose = null; S.ws.close(); S.ws = null; }
    $('app').hidden = true;
    $('auth').hidden = false;
    resetThread();
    if (message) showAuthError(message);
  }

  // ---------- vào ứng dụng ----------
  function enterApp() {
    $('auth').hidden = true;
    $('app').hidden = false;
    setAvatar($('meAvatar'), S.username, S.userId);
    $('meName').textContent = S.username;
    $('meId').textContent = S.userId ?? '?';
    loadDms();
    renderSidebar();
    showView(null);
    connect();
    loadRooms();
  }

  // ---------- WebSocket ----------
  function setConn(on) {
    const el = $('conn');
    el.dataset.state = on ? 'on' : 'off';
    el.title = on ? 'Đã kết nối' : 'Đang kết nối lại...';
  }

  function connect() {
    if (!S.token) return;
    clearTimeout(S.reconnectTimer);
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(S.token)}`);
    S.ws = ws;

    ws.onopen = () => {
      S.reconnectDelay = 1000;
      setConn(true);
      // Server quên phòng sau khi mất kết nối -> vào lại phòng đang xem
      if (S.lastRoom) {
        ws.send(JSON.stringify({ type: 'join_room', roomId: S.lastRoom.id, password: S.lastRoom.password || undefined }));
      }
    };
    ws.onmessage = (ev) => {
      try { onWs(JSON.parse(ev.data)); } catch (err) { console.error('[WS]', err); }
    };
    ws.onclose = (ev) => {
      if (ws !== S.ws || !S.token) return;
      setConn(false);
      if (ev.code === 1008) return logout('Phiên đăng nhập không còn hiệu lực. Hãy đăng nhập lại.');
      S.reconnectTimer = setTimeout(connect, S.reconnectDelay);
      S.reconnectDelay = Math.min(S.reconnectDelay * 2, 15000);
    };
    ws.onerror = () => {};
  }

  function wsSend(obj) {
    if (!S.ws || S.ws.readyState !== WebSocket.OPEN) {
      toast('Đang kết nối lại, thử lại sau giây lát.', 'error');
      return false;
    }
    S.ws.send(JSON.stringify(obj));
    return true;
  }

  function onWs(msg) {
    switch (msg.type) {
      case 'welcome':
        if (msg.userId !== S.userId) {
          S.userId = msg.userId;
          localStorage.setItem('userId', String(S.userId));
          $('meId').textContent = S.userId;
          loadDms();
          renderSidebar();
        }
        break;
      case 'rooms':
        S.publicRooms = msg.data;
        renderSidebar();
        break;
      case 'joined': {
        const password = S.pending && S.pending.id === msg.roomId ? S.pending.password : (S.lastRoom?.password || null);
        S.pending = null;
        S.lastRoom = { id: msg.roomId, name: msg.name, password };
        if (!S.publicRooms.some((r) => r.id === msg.roomId)) S.privateRooms.set(msg.roomId, { id: msg.roomId, name: msg.name });
        if (S.view?.type === 'room' && S.view.id === msg.roomId) {
          // Vào lại phòng đang xem (kết nối lại): giữ khung chat, lịch sử sẽ được vẽ lại
          S.view.name = msg.name;
        } else {
          showView({ type: 'room', id: msg.roomId, name: msg.name });
        }
        break;
      }
      case 'history':
        if (S.view?.type === 'room' && S.view.id === msg.roomId) {
          resetThread();
          msg.data.forEach((m) => addMessage(m, { silent: true }));
          scrollBottom(true);
          updateEmpty();
        }
        break;
      case 'message':
        if (S.view?.type === 'room' && S.view.id === msg.data.roomId) addMessage(msg.data);
        break;
      case 'private_message':
        onPrivate(msg.data);
        break;
      case 'error':
        S.pending = null;
        toast(msg.message, 'error');
        break;
      case 'warning':
        toast(msg.message, 'error', 5000);
        break;
      default:
        break;
    }
  }

  function onPrivate(d) {
    const mine = d.user_id === S.userId;
    const peerId = mine ? d.recipientId : d.user_id;
    const peerName = mine ? d.recipientUsername : d.username;
    const dm = touchDm(peerId, peerName);
    if (S.view?.type === 'dm' && S.view.id === peerId) {
      addMessage(d);
    } else {
      if (!mine) {
        dm.unread += 1;
        toast(`Tin riêng từ ${d.username}`, '');
      }
      renderSidebar();
    }
  }

  // ---------- phòng & tin nhắn riêng: danh sách ----------
  function dmKey() { return 'dms:' + S.userId; }
  function loadDms() {
    S.dms = new Map();
    try {
      JSON.parse(localStorage.getItem(dmKey()) || '[]').forEach((d) => S.dms.set(d.id, { id: d.id, name: d.name, unread: 0 }));
    } catch (e) { /* bỏ qua */ }
  }
  function saveDms() {
    localStorage.setItem(dmKey(), JSON.stringify([...S.dms.values()].map(({ id, name }) => ({ id, name }))));
  }
  function touchDm(id, name) {
    let dm = S.dms.get(id);
    if (!dm) { dm = { id, name: name || `Người dùng #${id}`, unread: 0 }; S.dms.set(id, dm); }
    else if (name && dm.name !== name) dm.name = name;
    saveDms();
    return dm;
  }

  async function loadRooms() {
    try {
      const { res, data } = await api('/rooms');
      if (res.status === 401) return logout('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
      if (!res.ok) throw new Error(data?.error || 'HTTP ' + res.status);
      S.publicRooms = data;
      renderSidebar();
    } catch (err) {
      toast('Không tải được danh sách phòng: ' + err.message, 'error');
    }
  }

  function renderSidebar() {
    // Phòng
    const list = $('roomList');
    list.innerHTML = '';
    const rooms = [...S.publicRooms.map((r) => ({ ...r, isPublic: true })),
      ...[...S.privateRooms.values()].filter((r) => !S.publicRooms.some((p) => p.id === r.id)).map((r) => ({ ...r, isPublic: false }))];
    $('roomEmpty').hidden = rooms.length > 0;
    rooms.forEach((r) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'item';
      if (S.view?.type === 'room' && S.view.id === r.id) b.setAttribute('aria-current', 'true');
      const av = document.createElement('span');
      av.className = 'avatar sm';
      setAvatar(av, r.name, r.id);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = r.name;
      b.append(av, label);
      if (!r.isPublic) {
        const lock = document.createElement('span');
        lock.className = 'lock';
        lock.title = 'Phòng riêng tư';
        lock.innerHTML = ICON_LOCK;
        b.append(lock);
      }
      b.onclick = () => openRoom(r.id, S.lastRoom?.id === r.id ? S.lastRoom.password : null);
      li.appendChild(b);
      list.appendChild(li);
    });

    // Tin nhắn riêng
    const dl = $('dmList');
    dl.innerHTML = '';
    $('dmEmpty').hidden = S.dms.size > 0;
    [...S.dms.values()].forEach((d) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'item';
      if (S.view?.type === 'dm' && S.view.id === d.id) b.setAttribute('aria-current', 'true');
      const av = document.createElement('span');
      av.className = 'avatar sm';
      setAvatar(av, d.name, d.id);
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = d.name;
      b.append(av, label);
      if (d.unread) {
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = d.unread > 99 ? '99+' : d.unread;
        b.append(badge);
      }
      b.onclick = () => openDm(d.id, d.name);
      li.appendChild(b);
      dl.appendChild(li);
    });
  }

  // ---------- mở phòng / hội thoại ----------
  function openRoom(id, password = null, force = false) {
    closeDrawer();
    if (!force && S.view?.type === 'room' && S.view.id === id) return;
    S.pending = { id, password };
    wsSend({ type: 'join_room', roomId: id, password });
  }

  async function openDm(peerId, name) {
    closeDrawer();
    if (peerId === S.userId) return toast('Bạn không thể nhắn riêng cho chính mình.', 'error');
    const dm = touchDm(peerId, name);
    dm.unread = 0;
    showView({ type: 'dm', id: peerId, name: dm.name });
    try {
      const { res, data } = await api('/messages/private/' + peerId);
      if (res.status === 401) return logout('Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.');
      if (!res.ok || !(S.view?.type === 'dm' && S.view.id === peerId)) return;
      resetThread();
      data.forEach((m) => {
        addMessage({ ...m, isPrivate: true, recipientId: m.recipient_id }, { silent: true });
        if (m.user_id === peerId && m.username && dm.name !== m.username) { dm.name = m.username; }
        if (m.user_id !== peerId && m.recipient_username && dm.name !== m.recipient_username) { dm.name = m.recipient_username; }
      });
      saveDms();
      S.view.name = dm.name;
      renderHeader();
      scrollBottom(true);
      updateEmpty();
      renderSidebar();
    } catch (err) {
      toast('Không tải được lịch sử tin nhắn.', 'error');
    }
  }

  function showView(view) {
    S.view = view;
    resetThread();
    renderHeader();
    renderSidebar();
    updateEmpty();
    const input = $('input');
    const dm = view?.type === 'dm';
    $('main').dataset.mode = dm ? 'dm' : 'room';
    input.disabled = !view;
    input.placeholder = !view ? 'Chọn một phòng để bắt đầu'
      : dm ? `Nhắn riêng cho ${view.name}` : `Nhắn tới ${view.name}`;
    syncSend();
    if (view && matchMedia('(min-width: 801px)').matches) input.focus();
  }

  function renderHeader() {
    const v = S.view;
    $('viewTitle').textContent = v ? v.name : 'Chọn một cuộc trò chuyện';
    $('viewSub').textContent = !v ? ''
      : v.type === 'dm' ? `Tin nhắn riêng, ID ${v.id}. Chỉ hai bạn thấy cuộc trò chuyện này.`
      : `Phòng, ID ${v.id}`;
    $('copyRoom').hidden = v?.type !== 'room';
    if (v?.type === 'dm') $('input').placeholder = `Nhắn riêng cho ${v.name}`;
  }

  function updateEmpty() {
    const has = $('thread').children.length > 0;
    $('empty').hidden = has;
    const noView = !S.view;
    $('emptyOpen').hidden = !noView;
    $('emptyText').textContent = noView
      ? 'Chọn một phòng ở bên trái, hoặc tạo phòng mới để bắt đầu.'
      : S.view.type === 'dm' ? 'Chưa có tin nhắn nào. Gửi lời chào để mở đầu cuộc trò chuyện.'
      : 'Phòng đang trống. Hãy là người nhắn đầu tiên.';
  }

  // ---------- vẽ tin nhắn ----------
  function resetThread() {
    $('thread').innerHTML = '';
    S.last = null;
    $('jump').hidden = true;
  }

  function dayLabel(d) {
    const today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, today)) return 'Hôm nay';
    if (same(d, y)) return 'Hôm qua';
    return d.toLocaleDateString('vi-VN', { day: 'numeric', month: 'numeric', year: 'numeric' });
  }

  function linkify(parent, text) {
    const re = /(https?:\/\/[^\s<]+)/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      parent.append(document.createTextNode(text.slice(last, m.index)));
      const a = document.createElement('a');
      a.href = m[1]; a.textContent = m[1];
      a.target = '_blank'; a.rel = 'noopener noreferrer nofollow';
      parent.append(a);
      last = m.index + m[1].length;
    }
    parent.append(document.createTextNode(text.slice(last)));
  }

  function scrollBottom(force) {
    const t = $('thread');
    t.style.scrollBehavior = force ? 'auto' : '';
    t.scrollTop = t.scrollHeight;
    t.style.scrollBehavior = '';
    $('jump').hidden = true;
  }

  function nearBottom() {
    const t = $('thread');
    return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
  }

  function addMessage(m, { silent = false } = {}) {
    const t = $('thread');
    const stick = nearBottom();
    const date = new Date(m.timestamp);
    const valid = !isNaN(date);
    const mine = m.user_id === S.userId;

    if (valid && (!S.last || new Date(S.last.timestamp).toDateString() !== date.toDateString())) {
      const sep = document.createElement('div');
      sep.className = 'day';
      sep.textContent = dayLabel(date);
      t.appendChild(sep);
      S.last = null;
    }

    const grouped = S.last && S.last.user_id === m.user_id && valid &&
      (date - new Date(S.last.timestamp)) < 5 * 60 * 1000;

    const row = document.createElement('div');
    row.className = 'row ' + (mine ? 'mine' : 'theirs') + (grouped ? '' : ' first');

    if (!mine) {
      if (grouped) {
        const sp = document.createElement('span');
        sp.className = 'avatar-sp';
        row.appendChild(sp);
      } else {
        const av = document.createElement('button');
        av.type = 'button';
        av.className = 'avatar sm';
        av.title = `Nhắn riêng cho ${m.username}`;
        av.setAttribute('aria-label', av.title);
        setAvatar(av, m.username, m.user_id);
        av.onclick = () => openDm(m.user_id, m.username);
        row.appendChild(av);
      }
    }

    const col = document.createElement('div');
    col.className = 'col';
    if (!mine && !grouped && S.view?.type !== 'dm') {
      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'name';
      name.append(document.createTextNode(m.username + ' '));
      const small = document.createElement('small');
      small.textContent = '#' + m.user_id;
      name.append(small);
      name.title = `Nhắn riêng cho ${m.username}`;
      name.onclick = () => openDm(m.user_id, m.username);
      col.appendChild(name);
    }
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    linkify(bubble, m.content);
    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = valid ? date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : '';
    bubble.appendChild(time);
    col.appendChild(bubble);
    row.appendChild(col);
    t.appendChild(row);
    S.last = { user_id: m.user_id, timestamp: valid ? m.timestamp : new Date().toISOString() };

    if (!silent) {
      $('empty').hidden = true;
      if (mine || stick) scrollBottom();
      else $('jump').hidden = false;
    }
  }

  // ---------- soạn & gửi ----------
  function syncSend() {
    $('sendBtn').disabled = !S.view || !$('input').value.trim();
  }
  function autosize() {
    const el = $('input');
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
  }

  function sendCurrent() {
    const input = $('input');
    const content = input.value.trim();
    if (!content || !S.view) return;
    const ok = S.view.type === 'dm'
      ? wsSend({ type: 'send_message', content, isPrivate: true, recipientId: S.view.id })
      : wsSend({ type: 'send_message', roomId: S.view.id, content });
    if (ok) { input.value = ''; autosize(); syncSend(); }
  }

  // ---------- ngăn kéo (mobile) ----------
  function openDrawer() { $('app').classList.add('drawer-open'); }
  function closeDrawer() { $('app').classList.remove('drawer-open'); }

  // ---------- hộp thoại ----------
  function wireDialog(dlg) {
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
    dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
  }

  function openCreate() {
    $('formCreate').reset();
    $('createPwWrap').hidden = true;
    $('createError').hidden = true;
    syncVis();
    $('dlgCreate').showModal();
    $('createName').focus();
  }
  function syncVis() {
    const priv = $('formCreate').elements.vis.value === 'private';
    $('createPwWrap').hidden = !priv;
    $('createPw').required = priv;
    $('visHint').textContent = priv
      ? 'Phòng không hiện trong danh sách. Người khác cần ID và mật khẩu để vào.'
      : 'Ai cũng thấy phòng trong danh sách và vào được.';
  }

  async function submitCreate(e) {
    e.preventDefault();
    const name = $('createName').value.trim();
    const priv = $('formCreate').elements.vis.value === 'private';
    const password = priv ? $('createPw').value : null;
    const err = $('createError');
    err.hidden = true;
    if (!name) return;
    try {
      const { res, data } = await api('/rooms', { method: 'POST', body: JSON.stringify({ name, is_public: !priv, password }) });
      if (!res.ok) { err.textContent = data?.error || 'Không tạo được phòng.'; err.hidden = false; return; }
      $('dlgCreate').close();
      toast(`Đã tạo phòng “${name}” (ID ${data.id})`, 'ok');
      if (priv) S.privateRooms.set(data.id, { id: data.id, name });
      openRoom(data.id, password);
      if (!priv) loadRooms();
    } catch (ex) {
      err.textContent = 'Lỗi kết nối: ' + ex.message;
      err.hidden = false;
    }
  }

  function submitJoin(e) {
    e.preventDefault();
    const id = parseInt($('joinId').value, 10);
    if (!id) return;
    $('dlgJoin').close();
    openRoom(id, $('joinPw').value || null, true);
    $('formJoin').reset();
  }

  function submitDm(e) {
    e.preventDefault();
    const id = parseInt($('dmId').value, 10);
    if (!id) return;
    $('dlgDm').close();
    $('formDm').reset();
    openDm(id);
  }

  // ---------- gắn sự kiện ----------
  $('tabLogin').onclick = () => setAuthMode('login');
  $('tabRegister').onclick = () => setAuthMode('register');
  $('authForm').addEventListener('submit', submitAuth);
  $('togglePw').onclick = () => {
    const pw = $('password');
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    $('togglePw').textContent = show ? 'Ẩn' : 'Hiện';
    $('togglePw').setAttribute('aria-label', show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu');
  };

  $('logoutBtn').onclick = () => logout();
  $('copyId').onclick = () => copy(S.userId, 'Đã sao chép ID của bạn');
  $('copyRoom').onclick = () => S.view?.type === 'room' && copy(S.view.id, 'Đã sao chép ID phòng');
  $('menuBtn').onclick = openDrawer;
  $('emptyOpen').onclick = openDrawer;
  $('backdrop').onclick = closeDrawer;

  $('openCreate').onclick = openCreate;
  $('openJoin').onclick = () => { $('formJoin').reset(); $('dlgJoin').showModal(); $('joinId').focus(); };
  $('openDm').onclick = () => { $('formDm').reset(); $('dlgDm').showModal(); $('dmId').focus(); };
  ['dlgCreate', 'dlgJoin', 'dlgDm'].forEach((id) => wireDialog($(id)));
  $('formCreate').addEventListener('submit', submitCreate);
  $('formCreate').addEventListener('change', syncVis);
  $('formJoin').addEventListener('submit', submitJoin);
  $('formDm').addEventListener('submit', submitDm);

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); sendCurrent(); });
  $('input').addEventListener('input', () => { autosize(); syncSend(); });
  // Enter gửi, Shift+Enter xuống dòng; bỏ qua khi đang gõ Telex/VNI (IME)
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      sendCurrent();
    }
  });
  $('jump').onclick = () => scrollBottom();
  $('thread').addEventListener('scroll', () => { if (nearBottom()) $('jump').hidden = true; }, { passive: true });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });

  // Có mạng trở lại: kết nối ngay thay vì chờ hết thời gian backoff
  window.addEventListener('online', () => {
    if (S.token && (!S.ws || S.ws.readyState > 1)) { S.reconnectDelay = 1000; connect(); }
  });

  // ---------- khởi động ----------
  setAuthMode('login');
  if (S.token) enterApp();
})();
