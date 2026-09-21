const socket = io();
let currentChatOrder = null;
let allOrders = [];

async function init() {
  const res = await fetch('/api/admin/check');
  const data = await res.json();
  if (data.isAdmin) enterDashboard();
}
init();

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  const msgEl = document.getElementById('loginMsg');
  msgEl.innerHTML = '';
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    enterDashboard();
  } catch (err) {
    msgEl.innerHTML = `<div class="msg err">${err.message}</div>`;
  }
});

document.getElementById('logoutLink').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/api/admin/logout', { method: 'POST' });
  location.reload();
});

function enterDashboard() {
  document.getElementById('authArea').style.display = 'none';
  document.getElementById('dashArea').style.display = 'block';
  document.getElementById('logoutLink').style.display = 'inline';
  socket.emit('join:admins');
  loadStats();
  loadOrders();
  loadCouriers();
}

function showAdminTab(tab) {
  document.getElementById('panelOrders').style.display = tab === 'orders' ? 'block' : 'none';
  document.getElementById('panelCouriers').style.display = tab === 'couriers' ? 'block' : 'none';
  document.getElementById('panelChat').style.display = tab === 'chat' ? 'grid' : 'none';
  document.getElementById('panelBusiness').style.display = tab === 'business' ? 'grid' : 'none';
  document.getElementById('panelAnalytics').style.display = tab === 'analytics' ? 'block' : 'none';
  document.getElementById('tabOrders').classList.toggle('active', tab === 'orders');
  document.getElementById('tabCouriers').classList.toggle('active', tab === 'couriers');
  document.getElementById('tabChat').classList.toggle('active', tab === 'chat');
  document.getElementById('tabBusiness').classList.toggle('active', tab === 'business');
  document.getElementById('tabAnalytics').classList.toggle('active', tab === 'analytics');
  if (tab === 'chat') renderChatPicker();
  if (tab === 'business') loadBusinesses();
  if (tab === 'analytics') loadAnalytics();
}

// ---- İşletmeler (B2B) ----
async function loadBusinesses() {
  const res = await fetch('/api/admin/businesses');
  const list = await res.json();
  const el = document.getElementById('businessList');
  if (!list.length) { el.innerHTML = '<div class="empty-state">Henüz işletme eklenmedi.</div>'; return; }
  el.innerHTML = list.map(b => `
    <div class="order-item">
      <div class="row">
        <strong>${escapeHtml(b.name)}</strong>
        <span class="badge ${b.active ? 'teslim-edildi' : 'iptal'}">${b.active ? 'Aktif' : 'Pasif'}</span>
      </div>
      <p class="meta">${escapeHtml(b.contactPhone || '')}</p>
      <div class="apikey-box">${b.apiKey}</div>
      <button class="ghost" style="margin-top:8px" onclick="toggleBusiness('${b.id}')">${b.active ? 'Pasifleştir' : 'Aktifleştir'}</button>
    </div>
  `).join('');
}

async function createBusiness() {
  const name = document.getElementById('bizName').value.trim();
  const contactPhone = document.getElementById('bizPhone').value.trim();
  const msgEl = document.getElementById('bizMsg');
  msgEl.innerHTML = '';
  if (!name) { msgEl.innerHTML = '<div class="msg err">İşletme adı girin.</div>'; return; }
  try {
    const res = await fetch('/api/admin/businesses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, contactPhone })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    msgEl.innerHTML = `<div class="msg ok">İşletme oluşturuldu! API anahtarı aşağıdaki listede.</div>`;
    document.getElementById('bizName').value = '';
    document.getElementById('bizPhone').value = '';
    loadBusinesses();
  } catch (err) {
    msgEl.innerHTML = `<div class="msg err">${err.message}</div>`;
  }
}

async function toggleBusiness(id) {
  await fetch(`/api/admin/businesses/${id}/toggle`, { method: 'POST' });
  loadBusinesses();
}

// ---- Analitik ----
async function loadAnalytics() {
  const res = await fetch('/api/admin/analytics');
  const d = await res.json();
  document.getElementById('analyticsStats').innerHTML = `
    <div class="stat-card"><div class="num">${d.totalOrders30d}</div><div class="label">Son 30 Gün Sipariş</div></div>
    <div class="stat-card"><div class="num">${d.totalRevenue} ₺</div><div class="label">Toplam Gelir (teslim edilen)</div></div>
    <div class="stat-card"><div class="num">${d.avgDistanceKm ?? '-'} km</div><div class="label">Ortalama Mesafe</div></div>
  `;
  const maxHour = Math.max(1, ...d.byHour);
  document.getElementById('hourChart').innerHTML = d.byHour.map((v, h) => `
    <div class="bar-row">
      <span class="bar-label">${String(h).padStart(2, '0')}:00</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(v / maxHour) * 100}%"></div></div>
      <span class="bar-value">${v}</span>
    </div>
  `).join('');
  const maxDay = Math.max(1, ...Object.values(d.byDay));
  document.getElementById('dayChart').innerHTML = Object.entries(d.byDay).map(([day, v]) => `
    <div class="bar-row">
      <span class="bar-label">${day}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(v / maxDay) * 100}%"></div></div>
      <span class="bar-value">${v}</span>
    </div>
  `).join('');
}

function statusLabel(status) {
  const map = {
    'beklemede': 'Bekliyor', 'kabul edildi': 'Kabul Edildi', 'yolda': 'Yolda',
    'teslim edildi': 'Teslim Edildi', 'iptal': 'İptal'
  };
  return map[status] || status;
}

async function loadStats() {
  const res = await fetch('/api/admin/stats');
  const s = await res.json();
  document.getElementById('statsRow').innerHTML = `
    <div class="stat-card"><div class="num">${s.totalOrders}</div><div class="label">Toplam Sipariş</div></div>
    <div class="stat-card"><div class="num">${s.pending}</div><div class="label">Bekleyen</div></div>
    <div class="stat-card"><div class="num">${s.inProgress}</div><div class="label">Devam Eden</div></div>
    <div class="stat-card"><div class="num">${s.delivered}</div><div class="label">Teslim Edilen</div></div>
    <div class="stat-card"><div class="num">${s.activeCouriers}/${s.totalCouriers}</div><div class="label">Aktif Kurye</div></div>
  `;
}

async function loadOrders() {
  const res = await fetch('/api/admin/orders');
  allOrders = await res.json();
  renderOrders();
}

async function loadCouriers() {
  const res = await fetch('/api/admin/couriers');
  const couriers = await res.json();
  renderCouriers(couriers);
  window._couriers = couriers;
}

function renderOrders() {
  const el = document.getElementById('ordersList');
  if (!allOrders.length) { el.innerHTML = '<div class="empty-state">Henüz sipariş yok.</div>'; return; }
  el.innerHTML = allOrders.map(o => `
    <div class="order-item">
      <div class="row">
        <strong>${o.trackingCode}</strong>
        <span class="badge ${o.status.replace(/\s+/g,'-')}">${statusLabel(o.status)}</span>
      </div>
      <p><strong>Müşteri:</strong> ${escapeHtml(o.customerName)} — ${escapeHtml(o.customerPhone)}</p>
      <p><strong>Nereden:</strong> ${escapeHtml(o.pickupAddress)}</p>
      <p><strong>Nereye:</strong> ${escapeHtml(o.dropoffAddress)}</p>
      <p class="meta">${o.courierName ? 'Kurye: ' + escapeHtml(o.courierName) : 'Kurye atanmadı'} ${o.rating ? '— ' + o.rating + ' ⭐' : ''}</p>
      <div class="row" style="margin-top:10px; gap:8px; flex-wrap:wrap;">
        <select onchange="assignCourier('${o.id}', this.value)" style="width:auto;">
          <option value="">Kurye ata...</option>
          ${(window._couriers || []).filter(c => c.active).map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('')}
        </select>
        <select onchange="changeStatus('${o.id}', this.value)" style="width:auto;">
          <option value="">Durum değiştir...</option>
          <option value="beklemede">Bekliyor</option>
          <option value="kabul edildi">Kabul Edildi</option>
          <option value="yolda">Yolda</option>
          <option value="teslim edildi">Teslim Edildi</option>
          <option value="iptal">İptal</option>
        </select>
        <input type="number" min="0" value="${o.price ?? ''}" placeholder="Ücret (₺)" style="width:110px" onchange="changePrice('${o.id}', this.value)">
      </div>
    </div>
  `).join('');
}

async function changePrice(orderId, price) {
  if (price === '' || isNaN(Number(price))) return;
  await fetch(`/api/admin/orders/${orderId}/price`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ price: Number(price) })
  });
  loadOrders();
}

function renderCouriers(list) {
  const el = document.getElementById('couriersList');
  if (!list.length) { el.innerHTML = '<div class="empty-state">Henüz kurye kaydı yok.</div>'; return; }
  el.innerHTML = list.map(c => `
    <div class="order-item">
      <div class="row">
        <strong>${escapeHtml(c.name)} ${c.badge && c.badge.emoji ? c.badge.emoji : ''}</strong>
        <span class="badge ${c.active ? 'teslim-edildi' : 'beklemede'}">${c.active ? 'Aktif' : 'Onay Bekliyor'}</span>
      </div>
      <p class="meta">${escapeHtml(c.phone)} — ${c.deliveredCount} teslimat ${c.avg ? '— ' + c.avg + ' ⭐ (' + c.count + ' değerlendirme)' : ''}</p>
      ${c.hasIdPhoto ? `<a class="courier-photo-link" href="/api/admin/couriers/${c.id}/id-photo" target="_blank">🪪 Kimlik fotoğrafını görüntüle</a>` : '<p class="meta" style="color:var(--danger)">Kimlik fotoğrafı yok</p>'}
      <div class="row" style="margin-top:8px;">
        ${!c.active ? `<button onclick="approveCourier('${c.id}')">Onayla</button>` : `<button class="ghost" onclick="deactivateCourier('${c.id}')">Devre Dışı Bırak</button>`}
      </div>
    </div>
  `).join('');
}

async function assignCourier(orderId, courierId) {
  if (!courierId) return;
  await fetch(`/api/admin/orders/${orderId}/assign`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courierId })
  });
  loadOrders(); loadStats();
}

async function changeStatus(orderId, status) {
  if (!status) return;
  await fetch(`/api/admin/orders/${orderId}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  loadOrders(); loadStats();
}

async function approveCourier(id) {
  await fetch(`/api/admin/couriers/${id}/approve`, { method: 'POST' });
  loadCouriers();
}
async function deactivateCourier(id) {
  await fetch(`/api/admin/couriers/${id}/deactivate`, { method: 'POST' });
  loadCouriers();
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

// ------- SOHBET İZLEME -------
function renderChatPicker() {
  const el = document.getElementById('chatOrderPicker');
  const active = allOrders.filter(o => ['kabul edildi', 'yolda'].includes(o.status));
  if (!active.length) { el.innerHTML = '<div class="empty-state">Aktif sohbet yok.</div>'; return; }
  el.innerHTML = active.map(o => `
    <div class="order-item" style="cursor:pointer" onclick="openAdminChat('${o.id}','${o.trackingCode}')">
      <strong>${o.trackingCode}</strong> — ${escapeHtml(o.customerName)} / ${escapeHtml(o.courierName || 'Kurye yok')}
    </div>
  `).join('');
}

async function openAdminChat(orderId, code) {
  currentChatOrder = orderId;
  document.getElementById('adminChatCard').style.display = 'block';
  document.getElementById('adminChatCode').textContent = code;
  socket.emit('join:order', orderId);
  const res = await fetch(`/api/admin/messages/${orderId}`);
  const messages = await res.json();
  const box = document.getElementById('adminChatMessages');
  box.innerHTML = '';
  messages.forEach(addAdminMsg);
}

function addAdminMsg(m) {
  const box = document.getElementById('adminChatMessages');
  const div = document.createElement('div');
  const mine = m.sender === 'admin';
  div.className = 'chat-bubble ' + (mine ? 'me' : 'other');
  const label = m.sender === 'customer' ? 'Müşteri' : (m.sender === 'courier' ? (m.senderName || 'Kurye') : 'Siz (Destek)');
  div.innerHTML = `<span class="sender">${label}</span>${escapeHtml(m.text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function sendAdminChat() {
  const input = document.getElementById('adminChatInput');
  const text = input.value.trim();
  if (!text || !currentChatOrder) return;
  socket.emit('chat:message', {
    orderId: currentChatOrder,
    sender: 'admin',
    senderName: 'Destek',
    text
  });
  input.value = '';
}

document.getElementById('adminChatInput')?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendAdminChat();
});

socket.on('chat:message', (m) => {
  if (m.orderId === currentChatOrder) addAdminMsg(m);
});
socket.on('order:new', () => { loadOrders(); loadStats(); });
socket.on('order:update', () => { loadOrders(); loadStats(); });
socket.on('courier:new', () => loadCouriers());
