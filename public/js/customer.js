const socket = io();
let currentOrderId = null;
let currentTrackingCode = null;
let pickupCoords = null;
let dropoffCoords = null;
let mapInstances = {};
let liveMap = null, liveDropMarker = null, liveCourierMarker = null;
let selectedStars = 0;

// ---- Harita seçici (sipariş formu) ----
function toggleMap(which) {
  const el = document.getElementById(which + 'Map');
  const isHidden = el.style.display === 'none' || !el.style.display;
  el.style.display = isHidden ? 'block' : 'none';
  if (isHidden && !mapInstances[which]) {
    const map = L.map(which + 'Map').setView([41.0082, 28.9784], 11); // İstanbul merkezi
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);
    let marker = null;
    map.on('click', async (e) => {
      const { lat, lng } = e.latlng;
      if (marker) marker.setLatLng(e.latlng); else marker = L.marker(e.latlng).addTo(map);
      if (which === 'pickup') pickupCoords = { lat, lng }; else dropoffCoords = { lat, lng };
      const addrField = document.getElementById(which + 'Address');
      if (!addrField.value.trim()) {
        try {
          const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}`);
          const data = await res.json();
          if (data && data.display_name) addrField.value = data.display_name;
        } catch (e) { /* sessizce geç */ }
      }
    });
    mapInstances[which] = map;
    setTimeout(() => map.invalidateSize(), 200);
  } else if (isHidden) {
    setTimeout(() => mapInstances[which].invalidateSize(), 200);
  }
}

function showTab(tab) {
  document.getElementById('panelNew').style.display = tab === 'new' ? 'grid' : 'none';
  document.getElementById('panelTrack').style.display = tab === 'track' ? 'grid' : 'none';
  document.getElementById('panelHistory').style.display = tab === 'history' ? 'grid' : 'none';
  document.getElementById('tabNew').classList.toggle('active', tab === 'new');
  document.getElementById('tabTrack').classList.toggle('active', tab === 'track');
  document.getElementById('tabHistory').classList.toggle('active', tab === 'history');
}

function toggleSchedule() {
  const scheduled = document.querySelector('input[name="whenType"]:checked').value === 'scheduled';
  document.getElementById('scheduledFor').style.display = scheduled ? 'block' : 'none';
}

document.getElementById('orderForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const whenType = document.querySelector('input[name="whenType"]:checked').value;
  const scheduledInput = document.getElementById('scheduledFor').value;
  const stops = document.getElementById('extraStops').value.split(',').map(s => s.trim()).filter(Boolean);

  const body = {
    customerName: document.getElementById('customerName').value.trim(),
    customerPhone: document.getElementById('customerPhone').value.trim(),
    pickupAddress: document.getElementById('pickupAddress').value.trim(),
    dropoffAddress: document.getElementById('dropoffAddress').value.trim(),
    packageInfo: document.getElementById('packageInfo').value.trim(),
    notes: document.getElementById('notes').value.trim(),
    pickupLat: pickupCoords?.lat ?? null,
    pickupLng: pickupCoords?.lng ?? null,
    dropoffLat: dropoffCoords?.lat ?? null,
    dropoffLng: dropoffCoords?.lng ?? null,
    stops,
    scheduledFor: whenType === 'scheduled' && scheduledInput ? new Date(scheduledInput).toISOString() : null,
    referralCode: document.getElementById('referralCode').value.trim()
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
    document.getElementById('newOrderPrice').textContent = `Ücret: ${data.price} ₺`;
    document.getElementById('newDeliveryCode').textContent = data.deliveryCode;
    document.getElementById('trackingResult').style.display = 'block';
    document.getElementById('orderForm').reset();
    toggleSchedule();
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
    document.getElementById('detPrice').textContent = data.order.price != null ? data.order.price + ' ₺' : '-';
    if (data.order.stops && data.order.stops.length) {
      document.getElementById('detStopsRow').style.display = 'block';
      document.getElementById('detStops').textContent = data.order.stops.join(', ');
    } else {
      document.getElementById('detStopsRow').style.display = 'none';
    }
    if (data.order.scheduledFor) {
      document.getElementById('detScheduleRow').style.display = 'block';
      document.getElementById('detSchedule').textContent = new Date(data.order.scheduledFor).toLocaleString('tr-TR');
    } else {
      document.getElementById('detScheduleRow').style.display = 'none';
    }
    const codeBox = document.getElementById('detCodeBox');
    if (['kabul edildi', 'yolda'].includes(data.order.status) && data.deliveryCode) {
      codeBox.style.display = 'block';
      document.getElementById('detDeliveryCode').textContent = data.deliveryCode;
    } else {
      codeBox.style.display = 'none';
    }
    if (data.order.courierName) {
      document.getElementById('detCourierRow').style.display = 'block';
      document.getElementById('detCourier').textContent = data.order.courierName;
    } else {
      document.getElementById('detCourierRow').style.display = 'none';
    }

    document.getElementById('chatCard').style.display = 'block';
    renderMessages(data.messages);
    socket.emit('join:order', currentOrderId);

    setupLiveMap(data.order, data.courierLocation, data.etaKm);
    setupRating(data.order);
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
    setupRating(o);
    if (o.status === 'teslim edildi' || o.status === 'iptal') {
      document.getElementById('liveMapCard').style.display = 'none';
    }
  }
});

// ---- Canlı harita: kurye konumu + teslimat noktası ----
function setupLiveMap(order, courierLocation, etaKm) {
  const canShow = ['kabul edildi', 'yolda'].includes(order.status);
  document.getElementById('liveMapCard').style.display = canShow ? 'block' : 'none';
  if (!canShow) return;

  if (!liveMap) {
    liveMap = L.map('liveMap').setView([41.0082, 28.9784], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(liveMap);
  }
  setTimeout(() => liveMap.invalidateSize(), 200);

  if (order.dropoffLat && order.dropoffLng) {
    if (liveDropMarker) liveDropMarker.setLatLng([order.dropoffLat, order.dropoffLng]);
    else liveDropMarker = L.marker([order.dropoffLat, order.dropoffLng], { title: 'Teslimat noktası' }).addTo(liveMap);
    liveMap.setView([order.dropoffLat, order.dropoffLng], 13);
  }
  if (courierLocation) updateCourierMarker(courierLocation.lat, courierLocation.lng, etaKm);
  else updateEtaText(null);
}

function updateCourierMarker(lat, lng, etaKm) {
  if (!liveMap) return;
  const icon = L.divIcon({ html: '🛵', className: 'courier-emoji-icon', iconSize: [30, 30] });
  if (liveCourierMarker) liveCourierMarker.setLatLng([lat, lng]);
  else liveCourierMarker = L.marker([lat, lng], { icon }).addTo(liveMap);
  updateEtaText(etaKm);
}

function updateEtaText(etaKm) {
  const el = document.getElementById('etaText');
  if (etaKm === null || etaKm === undefined) { el.textContent = 'Kurye konumu bekleniyor...'; return; }
  const mins = Math.max(1, Math.round((etaKm / 25) * 60)); // ort. 25km/s tahmini
  el.textContent = `Kurye yaklaşık ${etaKm.toFixed(1)} km uzaklıkta — tahmini ${mins} dk`;
}

socket.on('courier:location', (data) => {
  if (data.orderId === currentOrderId) updateCourierMarker(data.lat, data.lng, data.etaKm);
});

// ---- Puanlama ----
function setupRating(order) {
  const card = document.getElementById('ratingCard');
  if (order.status === 'teslim edildi' && !order.rating) {
    card.style.display = 'block';
  } else {
    card.style.display = 'none';
  }
}

document.querySelectorAll('#starPicker span').forEach(star => {
  star.addEventListener('click', () => {
    selectedStars = Number(star.dataset.star);
    document.querySelectorAll('#starPicker span').forEach(s => {
      s.textContent = Number(s.dataset.star) <= selectedStars ? '★' : '☆';
      s.classList.toggle('filled', Number(s.dataset.star) <= selectedStars);
    });
  });
});

// ---- Geçmiş Siparişler ----
async function loadHistory() {
  const phone = document.getElementById('historyPhone').value.trim();
  const msgEl = document.getElementById('historyMsg');
  msgEl.innerHTML = '';
  if (!phone) { msgEl.innerHTML = '<div class="msg err">Telefon numarası girin.</div>'; return; }
  try {
    const res = await fetch(`/api/customers/${encodeURIComponent(phone)}/orders`);
    const data = await res.json();
    document.getElementById('myReferralBox').style.display = 'block';
    document.getElementById('myReferralCode').textContent = data.referralCode;
    const el = document.getElementById('historyList');
    if (!data.orders.length) { el.innerHTML = '<div class="empty-state">Bu numarayla kayıtlı sipariş bulunamadı.</div>'; return; }
    el.innerHTML = data.orders.map(o => `
      <div class="order-item">
        <div class="row">
          <strong>${o.trackingCode}</strong>
          <span class="badge ${o.status.replace(/\s+/g, '-')}">${statusLabel(o.status)}</span>
        </div>
        <p class="meta">${new Date(o.createdAt).toLocaleString('tr-TR')} — ${escapeHtml(o.pickupAddress)} → ${escapeHtml(o.dropoffAddress)}</p>
        <p class="meta">${o.price} ₺ ${o.rating ? '— sizin puanınız: ' + o.rating + ' ⭐' : ''}</p>
      </div>
    `).join('');
  } catch (err) {
    msgEl.innerHTML = `<div class="msg err">Bir hata oluştu.</div>`;
  }
}

async function submitRating() {
  const msgEl = document.getElementById('ratingMsg');
  msgEl.innerHTML = '';
  if (!selectedStars) { msgEl.innerHTML = '<div class="msg err">Lütfen bir puan seçin.</div>'; return; }
  try {
    const res = await fetch(`/api/orders/track/${currentTrackingCode}/rate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating: selectedStars, comment: document.getElementById('ratingComment').value.trim() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    document.getElementById('ratingCard').innerHTML = '<div class="msg ok">Değerlendirmeniz için teşekkürler! 🙏</div>';
  } catch (err) {
    msgEl.innerHTML = `<div class="msg err">${err.message}</div>`;
  }
}
