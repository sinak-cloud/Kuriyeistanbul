require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const db = require('./db');

// Kurye kimlik fotoğrafları — kalıcı volume altında, herkese açık değil (sadece admin görebilir)
const ID_PHOTOS_DIR = path.join(__dirname, 'data', 'id-photos');
fs.mkdirSync(ID_PHOTOS_DIR, { recursive: true });
const idPhotoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ID_PHOTOS_DIR),
    filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname || '.jpg'))
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, /^image\//.test(file.mimetype))
});

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

function genDeliveryCode() {
  return String(Math.floor(1000 + Math.random() * 9000)); // 4 haneli teslimat kodu
}

function genReferralCode(phone) {
  const clean = (phone || '').replace(/\D/g, '');
  return 'KI' + clean.slice(-5);
}

function genApiKey() {
  return 'biz_' + crypto.randomBytes(24).toString('hex');
}

// Kuryenin teslimat sayısına göre rozet seviyesi
function courierBadge(deliveryCount) {
  if (deliveryCount >= 100) return { level: 'Altın', emoji: '🥇' };
  if (deliveryCount >= 50) return { level: 'Gümüş', emoji: '🥈' };
  if (deliveryCount >= 10) return { level: 'Bronz', emoji: '🥉' };
  return { level: null, emoji: null };
}

// ISO hafta anahtarı (yıl-hafta), haftalık kazanç gruplaması için
function isoWeekKey(dateStr) {
  const d = new Date(dateStr);
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${target.getUTCFullYear()}-H${String(week).padStart(2, '0')}`;
}

function requireBusinessApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'X-Api-Key başlığı gerekli.' });
  const business = db.get('businesses').find({ apiKey: key, active: true }).value();
  if (!business) return res.status(401).json({ error: 'Geçersiz veya pasif API anahtarı.' });
  req.business = business;
  next();
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
  // Müşteriye gösterilecek alanlar (teslimat kodu HARİÇ — o sadece track endpoint'inde, sahibine gösterilir)
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
    scheduledFor: order.scheduledFor || null,
    stops: order.stops || [],
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

const PRICE_PER_KM = Number(process.env.PRICE_PER_KM || 8); // mesafeye göre ek ücret (₺/km)
const REFERRAL_DISCOUNT = Number(process.env.REFERRAL_DISCOUNT || 20); // ₺

// Sipariş oluşturma mantığı — hem web formu hem işletme API'si burayı kullanır
function createOrder(data, source) {
  const {
    customerName, customerPhone, pickupAddress, dropoffAddress, packageInfo, notes,
    pickupLat, pickupLng, dropoffLat, dropoffLng, scheduledFor, stops, referralCode
  } = data;
  if (!customerName || !customerPhone || !pickupAddress || !dropoffAddress) {
    return { error: 'Lütfen tüm zorunlu alanları doldurun.' };
  }
  const distKm = haversineKm(pickupLat, pickupLng, dropoffLat, dropoffLng);
  let price = BASE_DELIVERY_FEE + (distKm ? Math.round(distKm * PRICE_PER_KM) : 0);

  let appliedReferral = null;
  if (referralCode && referralCode.trim()) {
    const code = referralCode.trim().toUpperCase();
    const ownCode = genReferralCode(customerPhone);
    if (code !== ownCode) { // kendi kodunu kullanamaz
      price = Math.max(0, price - REFERRAL_DISCOUNT);
      appliedReferral = code;
      let ref = db.get('referrals').find({ code }).value();
      if (ref) db.get('referrals').find({ code }).assign({ uses: (ref.uses || 0) + 1 }).write();
      else db.get('referrals').push({ code, uses: 1, createdAt: new Date().toISOString() }).write();
    }
  }

  const order = {
    id: uuidv4(),
    trackingCode: genTrackingCode(),
    deliveryCode: genDeliveryCode(),
    referralCodeOfOwner: genReferralCode(customerPhone),
    appliedReferral,
    customerName,
    customerPhone,
    pickupAddress,
    dropoffAddress,
    pickupLat: (typeof pickupLat === 'number') ? pickupLat : null,
    pickupLng: (typeof pickupLng === 'number') ? pickupLng : null,
    dropoffLat: (typeof dropoffLat === 'number') ? dropoffLat : null,
    dropoffLng: (typeof dropoffLng === 'number') ? dropoffLng : null,
    distanceKm: distKm,
    packageInfo: packageInfo || '',
    notes: notes || '',
    stops: Array.isArray(stops) ? stops.filter(s => s && s.trim()).slice(0, 5) : [],
    scheduledFor: scheduledFor || null, // null = şimdi; ISO string = planlı
    status: 'beklemede',
    courierId: null,
    courierName: null,
    price,
    rating: null,
    ratingComment: '',
    source: source || 'web', // 'web' | 'business:<businessId>'
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.get('orders').push(order).write();
  io.to('admins').emit('order:new', order);
  io.to('couriers').emit('order:new', publicOrder(order));
  return { order };
}

// Yeni sipariş oluştur (web formu)
app.post('/api/orders', (req, res) => {
  const result = createOrder(req.body, 'web');
  if (result.error) return res.status(400).json({ error: result.error });
  const { order } = result;
  res.json({ success: true, trackingCode: order.trackingCode, orderId: order.id, price: order.price, deliveryCode: order.deliveryCode });
});

// ---- İşletme (B2B) API — X-Api-Key başlığı ile sipariş oluşturma ----
app.post('/api/business/orders', requireBusinessApiKey, (req, res) => {
  const result = createOrder(req.body, 'business:' + req.business.id);
  if (result.error) return res.status(400).json({ error: result.error });
  const { order } = result;
  res.json({ success: true, trackingCode: order.trackingCode, orderId: order.id, price: order.price, deliveryCode: order.deliveryCode });
});

// Bir telefon numarasına ait geçmiş siparişler (basit hesap — şifresiz, telefonla arama)
app.get('/api/customers/:phone/orders', (req, res) => {
  const phone = req.params.phone.trim();
  if (!phone) return res.status(400).json({ error: 'Telefon numarası gerekli.' });
  const orders = db.get('orders').filter({ customerPhone: phone }).orderBy(['createdAt'], ['desc']).value();
  res.json({
    referralCode: genReferralCode(phone),
    orders: orders.map(publicOrder)
  });
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
  res.json({
    order: publicOrder(order),
    messages, courierLocation, etaKm,
    deliveryCode: order.deliveryCode, // sadece sipariş sahibi, kod bilerek buraya ulaşan kişi görür
    referralCode: order.referralCodeOfOwner
  });
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

app.post('/api/courier/register', idPhotoUpload.single('idPhoto'), (req, res) => {
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
    idPhotoFile: req.file ? req.file.filename : null,
    createdAt: new Date().toISOString()
  };
  db.get('couriers').push(courier).write();
  io.to('admins').emit('courier:new', { id: courier.id, name: courier.name, phone: courier.phone, hasIdPhoto: !!courier.idPhotoFile });
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
  const deliveredCount = db.get('orders').filter({ courierId: courier.id, status: 'teslim edildi' }).value().length;
  res.json({
    id: courier.id, name: courier.name, phone: courier.phone,
    badge: courierBadge(deliveredCount), deliveredCount,
    ...courierRatingStats(courier.id)
  });
});

// Talep haritası: bekleyen tüm siparişlerin alım noktaları (kurye için yoğunluk haritası)
app.get('/api/courier/demand-map', requireCourier, (req, res) => {
  const pending = db.get('orders').filter({ status: 'beklemede' }).value();
  res.json(pending
    .filter(o => o.pickupLat && o.pickupLng)
    .map(o => ({ id: o.id, lat: o.pickupLat, lng: o.pickupLng, price: o.price })));
});

// Kuryenin kazanç özeti: toplam teslimat, toplam kazanç, bugünkü + haftalık kazanç
app.get('/api/courier/earnings', requireCourier, (req, res) => {
  const delivered = db.get('orders')
    .filter(o => o.courierId === req.session.courierId && o.status === 'teslim edildi')
    .value();
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayOrders = delivered.filter(o => (o.updatedAt || '').slice(0, 10) === todayStr);
  const thisWeekKey = isoWeekKey(new Date().toISOString());
  const weekOrders = delivered.filter(o => isoWeekKey(o.updatedAt) === thisWeekKey);
  const deliveredCount = delivered.length;
  res.json({
    totalDeliveries: deliveredCount,
    totalEarnings: delivered.reduce((s, o) => s + (o.price || 0), 0),
    todayDeliveries: todayOrders.length,
    todayEarnings: todayOrders.reduce((s, o) => s + (o.price || 0), 0),
    weekDeliveries: weekOrders.length,
    weekEarnings: weekOrders.reduce((s, o) => s + (o.price || 0), 0),
    badge: courierBadge(deliveredCount),
    nextBadgeIn: deliveredCount >= 100 ? 0 : deliveredCount >= 50 ? 100 - deliveredCount : deliveredCount >= 10 ? 50 - deliveredCount : 10 - deliveredCount,
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
  const { status, deliveryCode } = req.body;
  const allowed = ['yolda', 'teslim edildi', 'iptal'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Geçersiz durum.' });
  const order = db.get('orders').find({ id: req.params.id, courierId: req.session.courierId }).value();
  if (!order) return res.status(404).json({ error: 'Sipariş bulunamadı veya size ait değil.' });
  if (status === 'teslim edildi') {
    if (!deliveryCode || String(deliveryCode).trim() !== String(order.deliveryCode)) {
      return res.status(400).json({ error: 'Teslimat kodu hatalı. Lütfen müşteriden kodu tekrar isteyin.' });
    }
  }
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
  const couriers = db.get('couriers').value().map(c => {
    const deliveredCount = db.get('orders').filter({ courierId: c.id, status: 'teslim edildi' }).value().length;
    return {
      id: c.id, name: c.name, phone: c.phone, active: c.active, createdAt: c.createdAt,
      hasIdPhoto: !!c.idPhotoFile, deliveredCount, badge: courierBadge(deliveredCount),
      ...courierRatingStats(c.id)
    };
  });
  res.json(couriers);
});

// Kurye kimlik fotoğrafı — sadece admin oturumu ile görülebilir
app.get('/api/admin/couriers/:id/id-photo', requireAdmin, (req, res) => {
  const courier = db.get('couriers').find({ id: req.params.id }).value();
  if (!courier || !courier.idPhotoFile) return res.status(404).json({ error: 'Fotoğraf bulunamadı.' });
  res.sendFile(path.join(ID_PHOTOS_DIR, courier.idPhotoFile));
});

// ---- İşletme (B2B) API anahtarı yönetimi ----
app.get('/api/admin/businesses', requireAdmin, (req, res) => {
  res.json(db.get('businesses').value());
});

app.post('/api/admin/businesses', requireAdmin, (req, res) => {
  const { name, contactPhone } = req.body;
  if (!name) return res.status(400).json({ error: 'İşletme adı gerekli.' });
  const business = {
    id: uuidv4(), name, contactPhone: contactPhone || '',
    apiKey: genApiKey(), active: true, createdAt: new Date().toISOString()
  };
  db.get('businesses').push(business).write();
  res.json({ success: true, business });
});

app.post('/api/admin/businesses/:id/toggle', requireAdmin, (req, res) => {
  const biz = db.get('businesses').find({ id: req.params.id }).value();
  if (!biz) return res.status(404).json({ error: 'İşletme bulunamadı.' });
  db.get('businesses').find({ id: req.params.id }).assign({ active: !biz.active }).write();
  res.json({ success: true });
});

// ---- Basit analitik: saat/gün dağılımı, toplam mesafe, son 30 gün ----
app.get('/api/admin/analytics', requireAdmin, (req, res) => {
  const orders = db.get('orders').value();
  const byHour = Array(24).fill(0);
  const byDay = {}; // 'Pzt'..'Paz'
  const dayNames = ['Paz', 'Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt'];
  dayNames.forEach(d => byDay[d] = 0);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  let totalRevenue = 0, totalDistance = 0, distCount = 0;
  orders.forEach(o => {
    const t = new Date(o.createdAt);
    if (t.getTime() >= thirtyDaysAgo) {
      byHour[t.getHours()]++;
      byDay[dayNames[t.getDay()]]++;
    }
    if (o.status === 'teslim edildi') totalRevenue += (o.price || 0);
    if (typeof o.distanceKm === 'number') { totalDistance += o.distanceKm; distCount++; }
  });
  res.json({
    byHour, byDay,
    totalRevenue,
    avgDistanceKm: distCount ? Math.round((totalDistance / distCount) * 10) / 10 : null,
    totalOrders30d: orders.filter(o => new Date(o.createdAt).getTime() >= thirtyDaysAgo).length
  });
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
