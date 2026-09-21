require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'kuriyeistanbul-gizli-anahtar-degistir';
const BASE_DELIVERY_FEE = Number(process.env.BASE_DELIVERY_FEE || 150);

// Kuryelerin anlık konumu — kalıcı değil, sadece bellekte (RAM) tutulur
const liveLocations = {}; // orderId -> { lat, lng, updatedAt }

app.use(express.json());
app.use(cookieSession({
  name: 'kuriye_session',
  keys: [SESSION_SECRET],
  maxAge: 7 * 24 * 60 * 60 * 1000 // 7 gün
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Yardımcı Fonksiyonlar ----------
function genTrackingCode() {
  return 'KI-' + Math.random().toString(36).substring(2, 8).toUpperCase();
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  return res.status(401).json({ error: 'Yetkisiz erişim. Lütfen admin girişi yapın.' });
}

function requireCourier(req, res, next) {
  if (req.session && req.session.role === 'courier' && req.session.courierId) return next();
  return res.status(401).json({ error: 'Yetkisiz erişim. Lütfen kurye girişi yapın.' });
}

function publicOrder(order) {
  // Müşteriye gösterilecek alanlar
  return {
    id: order.id,
    trackingCode: order.trackingCode,
    status: order.status,
    pickupAddress: order.pickupAddress,
    dropoffAddress: order.dropoffAddress,
    pickupLat: order.pickupLat ?? null,
    pickupLng: order.pickupLng ?? null,
    dropoffLat: order.dropoffLat ?? null,
    dropoffLng: order.dropoffLng ?? null,
    packageInfo: order.packageInfo,
    courierName: order.courierName || null,
    price: order.price ?? null,
    rating: order.rating ?? null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

function haversineKm(lat1, lng1, lat2, lng2) {
  if ([lat1, lng1, lat2, lng2].some(v => v === null || v === undefined || isNaN(v))) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Bir kuryenin tüm siparişlerinden ortalama puanını hesaplar
function courierRatingStats(courierId) {
  const rated = db.get('orders').filter(o => o.courierId === courierId && typeof o.rating === 'number').value();
  if (!rated.length) return { avg: null, count: 0 };
  const sum = rated.reduce((s, o) => s + o.rating, 0);
  return { avg: Math.round((sum / rated.length) * 10) / 10, count: rated.length };
}

// ================= MÜŞTERİ (CUSTOMER) API =================

// Yeni sipariş oluştur
app.post('/api/orders', (req, res) => {
  const {
    customerName, customerPhone, pickupAddress, dropoffAddress, packageInfo, notes,
    pickupLat, pickupLng, dropoffLat, dropoffLng
  } = req.body;
  if (!customerName || !customerPhone || !pickupAddress || !dropoffAddress) {
    return res.status(400).json({ error: 'Lütfen tüm zorunlu alanları doldurun.' });
  }
  const order = {
    id: uuidv4(),
    trackingCode: genTrackingCode(),
    customerName,
    customerPhone,
    pickupAddress,
    dropoffAddress,
    pickupLat: (typeof pickupLat === 'number') ? pickupLat : null,
    pickupLng: (typeof pickupLng === 'number') ? pickupLng : null,
    dropoffLat: (typeof dropoffLat === 'number') ? dropoffLat : null,
    dropoffLng: (typeof dropoffLng === 'number') ? dropoffLng : null,
    packageInfo: packageInfo || '',
    notes: notes || '',
    status: 'beklemede',
    courierId: null,
    courierName: null,
    price: BASE_DELIVERY_FEE,
    rating: null,
    ratingComment: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.get('orders').push(order).write();
  io.to('admins').emit('order:new', order);
  io.to('couriers').emit('order:new', publicOrder(order));
  res.json({ success: true, trackingCode: order.trackingCode, orderId: order.id });
});

// Takip kodu ile sipariş sorgula
app.get('/api/orders/track/:code', (req, res) => {
  const order = db.get('orders').find({ trackingCode: req.params.code.toUpperCase() }).value();
  if (!order) return res.status(404).json({ error: 'Bu takip koduna ait sipariş bulunamadı.' });
  const messages = db.get('messages').filter({ orderId: order.id }).value();
  const courierLocation = liveLocations[order.id] || null;
  let etaKm = null;
  if (courierLocation && order.dropoffLat && order.dropoffLng) {
    etaKm = haversineKm(courierLocation.lat, courierLocation.lng, order.dropoffLat, order.dropoffLng);
  }
  res.json({ order: publicOrder(order), messages, courierLocation, etaKm });
});

// Müşteri teslimattan sonra kuryeyi puanlar
app.post('/api/orders/track/:code/rate', (req, res) => {
  const { rating, comment } = req.body;
  const stars = Number(rating);
  if (!stars || stars < 1 || stars > 5) return res.status(400).json({ error: 'Geçerli bir puan (1-5) girin.' });
  const order = db.get('orders').find({ trackingCode: req.params.code.toUpperCase() }).value();
  if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (order.status !== 'teslim edildi') return res.status(400).json({ error: 'Sadece teslim edilen siparişler puanlanabilir.' });
  if (typeof order.rating === 'number') return res.status(400).json({ error: 'Bu sipariş zaten puanlanmış.' });
  db.get('orders').find({ id: order.id }).assign({
    rating: stars,
    ratingComment: (comment || '').trim(),
    updatedAt: new Date().toISOString()
  }).write();
  if (order.courierId) io.to('admins').emit('courier:rated', { courierId: order.courierId });
  res.json({ success: true });
});

// ================= KURYE (COURIER) API =================

app.post('/api/courier/register', (req, res) => {
  const { name, phone, password } = req.body;
  if (!name || !phone || !password) return res.status(400).json({ error: 'Tüm alanları doldurun.' });
  const existing = db.get('couriers').find({ phone }).value();
  if (existing) return res.status(400).json({ error: 'Bu telefon numarasıyla kayıtlı bir kurye zaten var.' });
  const courier = {
    id: uuidv4(),
    name,
    phone,
    passwordHash: bcrypt.hashSync(password, 10),
    active: false, // admin onayı bekliyor
    createdAt: new Date().toISOString()
  };
  db.get('couriers').push(courier).write();
  io.to('admins').emit('courier:new', { id: courier.id, name: courier.name, phone: courier.phone });
  res.json({ success: true, message: 'Kayıt alındı. Hesabınız admin onayından sonra aktif olacaktır.' });
});

app.post('/api/courier/login', (req, res) => {
  const { phone, password } = req.body;
  const courier = db.get('couriers').find({ phone }).value();
  if (!courier || !bcrypt.compareSync(password, courier.passwordHash)) {
    return res.status(401).json({ error: 'Telefon numarası veya şifre hatalı.' });
  }
  if (!courier.active) return res.status(403).json({ error: 'Hesabınız henüz admin tarafından onaylanmadı.' });
  req.session.role = 'courier';
  req.session.courierId = courier.id;
  res.json({ success: true, courier: { id: courier.id, name: courier.name, phone: courier.phone } });
});

app.post('/api/courier/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/api/courier/me', requireCourier, (req, res) => {
  const courier = db.get('couriers').find({ id: req.session.courierId }).value();
  if (!courier) return res.status(404).json({ error: 'Kurye bulunamadı.' });
  res.json({ id: courier.id, name: courier.name, phone: courier.phone, ...courierRatingStats(courier.id) });
});

// Kuryenin kazanç özeti: toplam teslimat, toplam kazanç, bugünkü kazanç
app.get('/api/courier/earnings', requireCourier, (req, res) => {
  const delivered = db.get('orders')
    .filter(o => o.courierId === req.session.courierId && o.status === 'teslim edildi')
    .value();
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayOrders = delivered.filter(o => (o.updatedAt || '').slice(0, 10) === todayStr);
  res.json({
    totalDeliveries: delivered.length,
    totalEarnings: delivered.reduce((s, o) => s + (o.price || 0), 0),
    todayDeliveries: todayOrders.length,
    todayEarnings: todayOrders.reduce((s, o) => s + (o.price || 0), 0),
    ...courierRatingStats(req.session.courierId),
    recent: delivered.slice(-10).reverse().map(o => ({
      trackingCode: o.trackingCode, price: o.price, updatedAt: o.updatedAt, rating: o.rating
    }))
  });
});

// Bekleyen (atanmamış) siparişler + kendi siparişleri
// ?lat= & ?lng= verilirse müsait siparişler kuryenin konumuna göre yakınlıkla sıralanır
app.get('/api/courier/orders', requireCourier, (req, res) => {
  const all = db.get('orders').value();
  let available = all.filter(o => o.status === 'beklemede');
  const myLat = Number(req.query.lat), myLng = Number(req.query.lng);
  if (!isNaN(myLat) && !isNaN(myLng)) {
    available = available
      .map(o => ({ ...o, distanceKm: haversineKm(myLat, myLng, o.pickupLat, o.pickupLng) }))
      .sort((a, b) => {
        if (a.distanceKm === null) return 1;
        if (b.distanceKm === null) return -1;
        return a.distanceKm - b.distanceKm;
      });
  }
  const mine = all.filter(o => o.courierId === req.session.courierId);
  res.json({ available, mine });
});

app.post('/api/courier/orders/:id/accept', requireCourier, (req, res) => {
  const order = db.get('orders').find({ id: req.params.id }).value();
  if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı.' });
  if (order.status !== 'beklemede') return res.status(400).json({ error: 'Bu sipariş zaten alınmış.' });
  const courier = db.get('couriers').find({ id: req.session.courierId }).value();
  db.get('orders').find({ id: order.id }).assign({
    status: 'kabul edildi',
    courierId: courier.id,
    courierName: courier.name,
    updatedAt: new Date().toISOString()
  }).write();
  const updated = db.get('orders').find({ id: order.id }).value();
  io.to('admins').emit('order:update', updated);
  io.to('order:' + order.id).emit('order:update', publicOrder(updated));
  io.to('couriers').emit('order:taken', order.id);
  res.json({ success: true, order: updated });
});

app.patch('/api/courier/orders/:id/status', requireCourier, (req, res) => {
  const { status } = req.body;
  const allowed = ['yolda', 'teslim edildi', 'iptal'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Geçersiz durum.' });
  const order = db.get('orders').find({ id: req.params.id, courierId: req.session.courierId }).value();
  if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı veya size ait değil.' });
  db.get('orders').find({ id: order.id }).assign({ status, updatedAt: new Date().toISOString() }).write();
  const updated = db.get('orders').find({ id: order.id }).value();
  if (['teslim edildi', 'iptal'].includes(status)) delete liveLocations[order.id];
  io.to('admins').emit('order:update', updated);
  io.to('order:' + order.id).emit('order:update', publicOrder(updated));
  res.json({ success: true, order: updated });
});

// ================= ADMIN API =================

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const admin = db.get('admins').find({ username }).value();
  if (!admin || !bcrypt.compareSync(password, admin.passwordHash)) {
    return res.status(401).json({ error: 'Kullanıcı adı veya şifre hatalı.' });
  }
  req.session.role = 'admin';
  req.session.adminId = admin.id;
  res.json({ success: true });
});

app.post('/api/admin/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/api/admin/check', (req, res) => {
  res.json({ isAdmin: !!(req.session && req.session.role === 'admin') });
});

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json(db.get('orders').orderBy(['createdAt'], ['desc']).value());
});

app.get('/api/admin/couriers', requireAdmin, (req, res) => {
  const couriers = db.get('couriers').value().map(c => ({
    id: c.id, name: c.name, phone: c.phone, active: c.active, createdAt: c.createdAt,
    ...courierRatingStats(c.id)
  }));
  res.json(couriers);
});

// Admin bir siparişin ücretini değiştirir
app.patch('/api/admin/orders/:id/price', requireAdmin, (req, res) => {
  const price = Number(req.body.price);
  if (isNaN(price) || price < 0) return res.status(400).json({ error: 'Geçersiz ücret.' });
  db.get('orders').find({ id: req.params.id }).assign({ price, updatedAt: new Date().toISOString() }).write();
  res.json({ success: true });
});

app.post('/api/admin/couriers/:id/approve', requireAdmin, (req, res) => {
  db.get('couriers').find({ id: req.params.id }).assign({ active: true }).write();
  res.json({ success: true });
});

app.post('/api/admin/couriers/:id/deactivate', requireAdmin, (req, res) => {
  db.get('couriers').find({ id: req.params.id }).assign({ active: false }).write();
  res.json({ success: true });
});

// Admin siparişi manuel olarak bir kuryeye atar
app.patch('/api/admin/orders/:id/assign', requireAdmin, (req, res) => {
  const { courierId } = req.body;
  const courier = db.get('couriers').find({ id: courierId }).value();
  if (!courier) return res.status(404).json({ error: 'Kurye bulunamadı.' });
  db.get('orders').find({ id: req.params.id }).assign({
    status: 'kabul edildi',
    courierId: courier.id,
    courierName: courier.name,
    updatedAt: new Date().toISOString()
  }).write();
  const updated = db.get('orders').find({ id: req.params.id }).value();
  io.to('order:' + updated.id).emit('order:update', publicOrder(updated));
  io.to('couriers').emit('order:taken', updated.id);
  res.json({ success: true, order: updated });
});

app.patch('/api/admin/orders/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  db.get('orders').find({ id: req.params.id }).assign({ status, updatedAt: new Date().toISOString() }).write();
  const updated = db.get('orders').find({ id: req.params.id }).value();
  if (['teslim edildi', 'iptal'].includes(status)) delete liveLocations[updated.id];
  io.to('order:' + updated.id).emit('order:update', publicOrder(updated));
  res.json({ success: true, order: updated });
});

app.get('/api/admin/messages/:orderId', requireAdmin, (req, res) => {
  res.json(db.get('messages').filter({ orderId: req.params.orderId }).value());
});

app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const orders = db.get('orders').value();
  const couriers = db.get('couriers').value();
  res.json({
    totalOrders: orders.length,
    pending: orders.filter(o => o.status === 'beklemede').length,
    inProgress: orders.filter(o => ['kabul edildi', 'yolda'].includes(o.status)).length,
    delivered: orders.filter(o => o.status === 'teslim edildi').length,
    totalCouriers: couriers.length,
    activeCouriers: couriers.filter(c => c.active).length
  });
});

// ================= SOCKET.IO — CANLI CHAT =================
io.on('connection', (socket) => {
  socket.on('join:order', (orderId) => {
    socket.join('order:' + orderId);
  });
  socket.on('join:admins', () => {
    socket.join('admins');
  });
  socket.on('join:couriers', () => {
    socket.join('couriers');
  });

  socket.on('chat:message', (payload) => {
    const { orderId, sender, senderName, text } = payload;
    if (!orderId || !text || !text.trim()) return;
    const order = db.get('orders').find({ id: orderId }).value();
    if (!order) return;
    const message = {
      id: uuidv4(),
      orderId,
      sender, // 'customer' | 'courier' | 'admin'
      senderName: senderName || sender,
      text: text.trim(),
      createdAt: new Date().toISOString()
    };
    db.get('messages').push(message).write();
    io.to('order:' + orderId).emit('chat:message', message);
    io.to('admins').emit('chat:message', message);
  });

  // Kurye konumunu paylaşır (sadece bellekte tutulur, kalıcı değil)
  socket.on('courier:location', (payload) => {
    const { orderId, lat, lng } = payload || {};
    if (!orderId || typeof lat !== 'number' || typeof lng !== 'number') return;
    const order = db.get('orders').find({ id: orderId }).value();
    if (!order || !['kabul edildi', 'yolda'].includes(order.status)) return;
    const loc = { lat, lng, updatedAt: new Date().toISOString() };
    liveLocations[orderId] = loc;
    const etaKm = order.dropoffLat && order.dropoffLng
      ? haversineKm(lat, lng, order.dropoffLat, order.dropoffLng) : null;
    io.to('order:' + orderId).emit('courier:location', { orderId, ...loc, etaKm });
    io.to('admins').emit('courier:location', { orderId, ...loc, etaKm });
  });
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`KuriyeIstanbul sunucusu http://localhost:${PORT} adresinde çalışıyor`);
});
