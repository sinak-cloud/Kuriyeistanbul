const socket = io();
let me = null;
let openChatOrderId = null;
let myLastCoords = null;
let locationWatchId = null;
let activeSharingOrderIds = new Set();

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
  const formData = new FormData();
  formData.append('name', document.getElementById('regName').value.trim());
  formData.append('phone', document.getElementById('regPhone').value.trim());
  formData.append('password', document.getElementById('regPassword').value);
  const fileInput = document.getElementById('regIdPhoto');
  if (fileInput.files[0]) formData.append('idPhoto', fileInput.files[0]);

  const msgEl = document.getElementById('registerMsg');
  msgEl.innerHTML = '';
  try {
    const res = await fetch('/api/courier/register', { method: 'POST', body: formData });
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
  const badgeTxt = me.badge && me.badge.emoji ? ` ${me.badge.emoji} ${me.badge.level} Kurye` : '';
  document.getElementById('welcomeMsg').textContent = `Hoş geldin, ${me.name}${badgeTxt} 👋`;
  socket.emit('join:couriers');
  loadOrders();
}

let demandMapInstance = null;

function showDashTab(tab) {
  document.getElementById('panelAvail').style.display = tab === 'avail' ? 'block' : 'none';
  document.getElementById('panelMine').style.display = tab === 'mine' ? 'block' : 'none';
  document.getElementById('panelEarn').style.display = tab === 'earn' ? 'block' : 'none';
  document.getElementById('panelDemand').style.display = tab === 'demand' ? 'block' : 'none';
  document.getElementById('tabAvail').classList.toggle('active', tab === 'avail');
  document.getElementById('tabMine').classList.toggle('active', tab === 'mine');
  document.getElementById('tabEarn').classList.toggle('active', tab === 'earn');
  document.getElementById('tabDemand').classList.toggle('active', tab === 'demand');
  if (tab === 'earn') loadEarnings();
  if (tab === 'demand') loadDemandMap();
}

async function loadDemandMap() {
  if (!demandMapInstance) {
    demandMapInstance = L.map('demandMap').setView([41.0082, 28.9784], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(demandMapInstance);
  }
  setTimeout(() => demandMapInstance.invalidateSize(), 150);
  if (window._demandMarkers) window._demandMarkers.forEach(m => demandMapInstance.removeLayer(m));
  window._demandMarkers = [];
  const res = await fetch('/api/courier/demand-map');
  const points = await res.json();
  points.forEach(p => {
    const marker = L.circleMarker([p.lat, p.lng], { radius: 9, color: '#ff6a00', fillColor: '#ff6a00', fillOpacity: 0.7 })
      .addTo(demandMapInstance).bindPopup(`${p.price} ₺`);
    window._demandMarkers.push(marker);
  });
  if (myLastCoords) L.marker([myLastCoords.lat, myLastCoords.lng]).addTo(demandMapInstance).bindPopup('Siz').openPopup();
}

// ---- Konum paylaşımı: aktif siparişi olan kurye otomatik konum gönderir ----
function ensureLocationSharing() {
  if (locationWatchId !== null || !navigator.geolocation) return;
  locationWatchId = navigator.geolocation.watchPosition((pos) => {
    myLastCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    activeSharingOrderIds.forEach(orderId => {
      socket.emit('courier:location', { orderId, lat: myLastCoords.lat, lng: myLastCoords.lng });
    });
  }, () => { /* konum reddedildi, sessizce geç */ }, { enableHighAccuracy: true, maximumAge: 5000 });
}

function sortByMyLocation() {
  if (!navigator.geolocation) { alert('Tarayıcınız konum özelliğini desteklemiyor.'); return; }
  navigator.geolocation.getCurrentPosition((pos) => {
    myLastCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    loadOrders();
  }, () => alert('Konumunuza erişilemedi. Lütfen konum iznini kontrol edin.'));
}

async function loadEarnings() {
  const res = await fetch('/api/courier/earnings');
  const d = await res.json();
  document.getElementById('earnTotal').textContent = d.totalEarnings + ' ₺';
  document.getElementById('earnCount').textContent = d.totalDeliveries;
  document.getElementById('earnToday').textContent = d.todayEarnings + ' ₺';
  document.getElementById('earnWeek').textContent = d.weekEarnings + ' ₺ (' + d.weekDeliveries + ' teslimat)';
  document.getElementById('earnRating').textContent = d.avg ? `${d.avg} ⭐ (${d.count})` : 'Henüz yok';
  document.getElementById('earnBadge').textContent = d.badge && d.badge.emoji ? `${d.badge.emoji} ${d.badge.level}` : 'Henüz yok';
  document.getElementById('earnBadgeLabel').textContent = d.nextBadgeIn > 0 ? `Sonraki rozete ${d.nextBadgeIn} teslimat kaldı` : 'En üst rozet!';
  const el = document.getElementById('earnRecent');
  if (!d.recent.length) { el.innerHTML = '<div class="empty-state">Henüz teslimat yok.</div>'; return; }
  el.innerHTML = d.recent.map(o => `
    <div class="order-item">
      <div class="row">
        <strong>${o.trackingCode}</strong>
        <span>${o.price} ₺</span>
      </div>
      <p class="meta">${new Date(o.updatedAt).toLocaleString('tr-TR')} ${o.rating ? '— ' + o.rating + ' ⭐' : ''}</p>
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

async function loadOrders() {
  let url = '/api/courier/orders';
  if (myLastCoords) url += `?lat=${myLastCoords.lat}&lng=${myLastCoords.lng}`;
  const res = await fetch(url);
  const data = await res.json();
  renderAvailable(data.available);
  renderMine(data.mine);

  // Aktif (kabul edildi / yolda) siparişler için otomatik konum paylaşımını başlat
  const active = data.mine.filter(o => ['kabul edildi', 'yolda'].includes(o.status));
  activeSharingOrderIds = new Set(active.map(o => o.id));
  if (active.length) ensureLocationSharing();
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
      <p class="meta">${o.packageInfo ? 'Paket: ' + escapeHtml(o.packageInfo) : ''} ${o.price ? '— ' + o.price + ' ₺' : ''} ${(typeof o.distanceKm === 'number') ? '— 📍 ' + o.distanceKm.toFixed(1) + ' km' : ''}</p>
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
  let deliveryCode;
  if (status === 'teslim edildi') {
    deliveryCode = prompt('Müşteriden aldığınız 4 haneli teslimat kodunu girin:');
    if (!deliveryCode) return;
  }
  const res = await fetch(`/api/courier/orders/${id}/status`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, deliveryCode })
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  loadOrders();
  if (status === 'teslim edildi') loadEarnings();
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
