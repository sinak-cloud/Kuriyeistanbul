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
    packageInfo: order.packageInfo,
    courierName: order.courierName || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt
  };
}

// ================= MÜŞTERİ (CUSTOMER) API =================

// Yeni sipariş oluştur
app.post('/api/orders', (req, res) => {
  const { customerName, customerPhone, pickupAddress, dropoffAddress, packageInfo, notes } = req.body;
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
    packageInfo: packageInfo || '',
    notes: notes || '',
    status: 'beklemede',
    courierId: null,
    courierName: null,
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
  res.json({ order: publicOrder(order), messages });
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
  res.json({ id: courier.id, name: courier.name, phone: courier.phone });
});

// Bekleyen (atanmamış) siparişler + kendi siparişleri
app.get('/api/courier/orders', requireCourier, (req, res) => {
  const all = db.get('orders').value();
  const available = all.filter(o => o.status === 'beklemede');
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
    id: c.id, name: c.name, phone: c.phone, active: c.active, createdAt: c.createdAt
  }));
  res.json(couriers);
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
});

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

server.listen(PORT, () => {
  console.log(`KuriyeIstanbul sunucusu http://localhost:${PORT} adresinde çalışıyor`);
});
