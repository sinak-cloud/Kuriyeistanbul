const socket = io();
let currentOrderId = null;
let currentTrackingCode = null;

function showTab(tab) {
  document.getElementById('panelNew').style.display = tab === 'new' ? 'grid' : 'none';
  document.getElementById('panelTrack').style.display = tab === 'track' ? 'grid' : 'none';
  document.getElementById('tabNew').classList.toggle('active', tab === 'new');
  document.getElementById('tabTrack').classList.toggle('active', tab === 'track');
}

document.getElementById('orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {
    customerName: document.getElementById('customerName').value.trim(),
    customerPhone: document.getElementById('customerPhone').value.trim(),
    pickupAddress: document.getElementById('pickupAddress').value.trim(),
    dropoffAddress: document.getElementById('dropoffAddress').value.trim(),
    packageInfo: document.getElementById('packageInfo').value.trim(),
    notes: document.getElementById('notes').value.trim()
  };
  const msgEl = document.getElementById('orderMsg');
  msgEl.innerHTML = '';
  try {
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Bir hata oluştu.');
    document.getElementById('newTrackingCode').textContent = data.trackingCode;
    document.getElementById('trackingResult').style.display = 'block';
    document.getElementById('orderForm').reset();
  } catch (err) {
    msgEl.innerHTML = `<div class="msg err">${err.message}</div>`;
  }
});

function statusLabel(status) {
  const map = {
    'beklemede': 'Kurye Bekleniyor',
    'kabul edildi': 'Kurye Kabul Etti',
    'yolda': 'Yolda',
    'teslim edildi': 'Teslim Edildi',
    'iptal': 'İptal Edildi'
  };
  return map[status] || status;
}

async function trackOrder() {
  const code = document.getElementById('trackCode').value.trim().toUpperCase();
  const msgEl = document.getElementById('trackMsg');
  msgEl.innerHTML = '';
  if (!code) return;
  try {
    const res = await fetch('/api/orders/track/' + encodeURIComponent(code));
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Sipariş bulunamadı.');
    currentOrderId = data.order.id;
    currentTrackingCode = data.order.trackingCode;

    document.getElementById('orderDetail').style.display = 'block';
    const badge = document.getElementById('statusBadge');
    badge.textContent = statusLabel(data.order.status);
    badge.className = 'badge ' + data.order.status.replace(/\s+/g, '-');
    document.getElementById('detPickup').textContent = data.order.pickupAddress;
    document.getElementById('detDropoff').textContent = data.order.dropoffAddress;
    document.getElementById('detPackage').textContent = data.order.packageInfo || '-';
    if (data.order.courierName) {
      document.getElementById('detCourierRow').style.display = 'block';
      document.getElementById('detCourier').textContent = data.order.courierName;
    } else {
      document.getElementById('detCourierRow').style.display = 'none';
    }

    document.getElementById('chatCard').style.display = 'block';
    renderMessages(data.messages);
    socket.emit('join:order', currentOrderId);
  } catch (err) {
    msgEl.innerHTML = `<div class="msg err">${err.message}</div>`;
    document.getElementById('orderDetail').style.display = 'none';
    document.getElementById('chatCard').style.display = 'none';
  }
}

function renderMessages(messages) {
  const box = document.getElementById('chatMessages');
  box.innerHTML = '';
  messages.forEach(addMessageToUI);
  box.scrollTop = box.scrollHeight;
}

function addMessageToUI(m) {
  const box = document.getElementById('chatMessages');
  const div = document.createElement('div');
  const mine = m.sender === 'customer';
  div.className = 'chat-bubble ' + (mine ? 'me' : 'other');
  const label = m.sender === 'admin' ? 'Destek' : (m.sender === 'courier' ? (m.senderName || 'Kurye') : 'Siz');
  div.innerHTML = `<span class="sender">${label}</span>${escapeHtml(m.text)}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text || !currentOrderId) return;
  socket.emit('chat:message', {
    orderId: currentOrderId,
    sender: 'customer',
    senderName: 'Müşteri',
    text
  });
  input.value = '';
}

document.getElementById('chatInput')?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendChat();
});

socket.on('chat:message', (m) => {
  if (m.orderId === currentOrderId) addMessageToUI(m);
});

socket.on('order:update', (o) => {
  if (o.id === currentOrderId) {
    const badge = document.getElementById('statusBadge');
    badge.textContent = statusLabel(o.status);
    badge.className = 'badge ' + o.status.replace(/\s+/g, '-');
    if (o.courierName) {
      document.getElementById('detCourierRow').style.display = 'block';
      document.getElementById('detCourier').textContent = o.courierName;
    }
  }
});
