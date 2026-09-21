const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const path = require('path');
const bcrypt = require('bcryptjs');

const adapter = new FileSync(path.join(__dirname, 'data', 'db.json'));
const db = low(adapter);

// Varsayılan yapı
db.defaults({
  orders: [],
  couriers: [],
  messages: [],
  admins: [],
  businesses: [],
  referrals: []
}).write();

// İlk kurulumda varsayılan admin oluştur (kullanıcı adı: admin, şifre: .env'den veya "degistir123")
function ensureDefaultAdmin() {
  const admins = db.get('admins').value();
  if (!admins || admins.length === 0) {
    const defaultPassword = process.env.ADMIN_PASSWORD || 'degistir123';
    db.get('admins').push({
      id: 'admin',
      username: 'admin',
      passwordHash: bcrypt.hashSync(defaultPassword, 10),
      createdAt: new Date().toISOString()
    }).write();
    console.log('==============================================');
    console.log('Varsayılan admin oluşturuldu.');
    console.log('Kullanıcı adı: admin');
    console.log('Şifre:', defaultPassword, '(lütfen .env dosyasında ADMIN_PASSWORD ile değiştirin)');
    console.log('==============================================');
  }
}

ensureDefaultAdmin();

module.exports = db;
