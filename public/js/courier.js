const socket = io();
let me = null;
let openChatOrderId = null;

async function init() {
  try {
    const res = await fetch('/api/courier/me');
    if (res.ok) {
      me = await res.json();
      enterDashboard();
    }
  } catch (e) { /* değil giriş yapılmamış */ }
}
init();

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const phone = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  const msgEl = document.getElementById('loginMsg');
  msgEl.innerHTML = '';
  try {
    const res = await fetch('/api/courier/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    me = data.courier;
    enterDashboard();
  } catch (err) {
    msgEl.innerHTML = `<div class="msg err">${err.message}</div>`;
  }
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    name: document.getElementById('regName').value.trim(),
    phone: document.getElementById('regPhone').value.trim(),
    password: document.getElementById('regPassword').value
  };
  const msgEl = document.getElementById('registerMsg');
  msgEl.innerHTML = '';
  try {
    const res = await fetch('/api/courier/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    msgEl.innerHTML = `<div class="msg ok">${data.message}</div>`;
    document.getElementById('registerForm').reset();
  } catch (err) {
    msgEl.innerHTML = `<div class="msg err">${err.message}</div>`;
  }
});

document.getElementById('logoutLink').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/courier/logout', { method: 'POST' });
  location.reload();
});

function enterDashboard() {
  document.getElementById('authArea').style.display = 'none';
  document.getElementById('dashArea').style.display = 'block';
  document.getElementById('logoutLink').style.display = 'inline';
  document.getElementById('welcomeMsg').textContent = `Hoş geldin, ${me.name} 👋`;
  socket.emit('join:couriers');
  loadOrders();
}

function showDashTab(tab) {
  document.getElementById('panelAvail').style.display = tab === 'avail' ? 'block' : 'none';
  document.getElementById('panelMine').style.display = tab === 'mine' ? 'block' : 'none';
  document.getElementById('tabAvail').classList.toggle('active', tab === 'avail');
  document.getElementById('tabMine').classList.toggle('active', tab === 'mine');
}

function statusLabel(status) {
  const map = {
    'beklemede': 'Bekliyor', 'kabul edildi': 'Kabul Edildi', 'yolda': 'Yolda',
    'teslim edildi': 'Teslim Edildi', 'iptal': 'İptal'
  };
  return map[status] || status;
}

async function loadOrders() {
  const res = await fetch('/api/courier/orders');
  const data = await res.json();
  renderAvailable(data.available);
  renderMine(data.mine);
}

function renderAvailable(list) {
  const el = document.getElementById('availList');
  if (!list.length) { el.innerHTML = '<div class="empty-state">Şu anda müsait sipariş yok.</div>'; return; }
  el.innerHTML = list.map(o => `
    <div class="order-item">
      <div class="row">
        <strong>${o.trackingCode}</strong>
        <span class="badge beklemede">${statusLabel(o.status)}</span>
      </div>
      <p><strong>Nereden:</strong> ${escapeHtml(o.pickupAddress)}</p>
      <p><strong>Nereye:</strong> ${escapeHtml(o.dropoffAddress)}</p>
      <p class="meta">${o.packageInfo ? 'Paket: ' + escapeHtml(o.packageInfo) : ''}</p>
      <button onclick="acceptOrder('${o.id}')">Siparişi Kabul Et</button>
    </div>
  `).join('');
}

function renderMine(list) {
  const el = document.getElementById('mineList');
  if (!list.length) { el.innerHTML = '<div class="empty-state">Henüz üzerinize aldığınız sipariş yok.</div>'; return; }
  el.innerHTML = list.map(o => `
    <div class="order-item">
      <div class="row">
        <strong>${o.trackingCode}</strong>
        <span class="badge ${o.status.replace(/\s+/g,'-')}">${statusLabel(o.status)}</span>
      </div>
      <p><strong>Nereden:</strong> ${escapeHtml(o.pickupAddress)}</p>
      <p><strong>Nereye:</strong> ${escapeHtml(o.dropoffAddress)}</p>
      <p class="meta">Müşteri: ${escapeHtml(o.customerName)} — ${escapeHtml(o.customerPhone)}</p>
      <div class="row" style="margin-top:10px; gap:8px;">
        ${o.status === 'kabul edildi' ? `<button onclick="updateStatus('${o.id}','yolda')">Yola Çıktım</button>` : ''}
        ${o.status === 'yolda' ? `<button onclick="updateStatus('${o.id}','teslim edildi')">Teslim Ettim</button>` : ''}
        ${['kabul edildi','yolda'].includes(o.status) ? `<button class="secondary" onclick="openChat('${o.id}','${o.trackingCode}')">💬 Sohbet</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function acceptOrder(id) {
  const res = await fetch(`/api/courier/orders/${id}/accept`, { method: 'POST' });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  loadOrders();
  showDashTab('mine');
}

async function updateStatus(id, status) {
  const res = await fetch(`/api/courier/orders/${id}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  loadOrders();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ------- CHAT -------
async function openChat(orderId, trackingCode) {
  openChatOrderId = orderId;
  document.getElementById('chatOrderCode').textContent = trackingCode;
  document.getElementById('chatPanel').style.display = 'block';
  document.getElementById('chatMessages').innerHTML = '';
  socket.emit('join:order', orderId);
  // Not: mesaj geçmişi admin API'siyle sınırlı; kurye sohbeti anlık olarak görür.
  document.getElementById('chatPanel').scrollIntoView({ behavior: 'smooth' });
}

function closeChat() {
  document.getElementById('chatPanel').style.display = 'none';
  openChatOrderId = null;
}

function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !openChatOrderId || !me) return;
  socket.emit('chat:message', {
    orderId: openChatOrderId,
    sender: 'courier',
    senderName: me.name,
    text
  });
  input.value = '';
}

document.getElementById('chatInput')?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChat();
});

socket.on('chat:message', (m) => {
  if (m.orderId === openChatOrderId) {
    const box = document.getElementById('chatMessages');
    const div = document.createElement('div');
    const mine = m.sender === 'courier';
    div.className = 'chat-bubble ' + (mine ? 'me' : 'other');
    const label = m.sender === 'admin' ? 'Destek' : (m.sender === 'customer' ? 'Müşteri' : 'Siz');
    div.innerHTML = `<span class="sender">${label}</span>${escapeHtml(m.text)}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
  }
});

socket.on('order:new', () => loadOrders());
socket.on('order:taken', () => loadOrders());
socket.on('order:update', () => loadOrders());
