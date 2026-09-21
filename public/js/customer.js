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
    notes: document.getElementById('notes').value.trim(),
    pickupLat: pickupCoords?.lat ?? null,
    pickupLng: pickupCoords?.lng ?? null,
    dropoffLat: dropoffCoords?.lat ?? null,
    dropoffLng: dropoffCoords?.lng ?? null
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
