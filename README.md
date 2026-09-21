# KuriyeIstanbul.com

İstanbul içi kurye/paket teslimatı için tam işlevsel koordinasyon platformu.

**Neler var:**
- 🧑‍💼 **Müşteri sayfası** (`/`): sipariş oluşturma, takip kodu ile sorgulama, kurye ile canlı sohbet
- 🛵 **Kurye paneli** (`/courier.html`): kayıt/giriş, müsait siparişleri görme ve kabul etme, durum güncelleme (yolda / teslim edildi), müşteri ile canlı sohbet
- 🛠️ **Admin paneli** (`/admin.html`): tüm siparişleri görme, kurye onaylama/devre dışı bırakma, sipariş atama, durum değiştirme, tüm sohbetleri izleme ve mesaj yazma (destek olarak)
- 💬 Gerçek zamanlı sohbet (Socket.io) — müşteri ↔ kurye ↔ admin
- Basit JSON dosya tabanlı veritabanı (lowdb) — native derleme gerektirmez, Railway/Render gibi platformlarda sorunsuz çalışır

---

## 1) Yerelde çalıştırma

```bash
npm install
cp .env.example .env
# .env dosyasını açıp SESSION_SECRET ve ADMIN_PASSWORD değerlerini değiştirin
npm start
```

Tarayıcıda `http://localhost:3000` adresine gidin. Admin girişi için `.env`'de belirlediğiniz `ADMIN_PASSWORD` kullanılır (kullanıcı adı: `admin`).

---

## 2) Railway'e deploy etme (senin mevcut iş akışına uygun)

1. Bu klasörü bir GitHub reposuna push'la (`git init`, `git add .`, `git commit`, GitHub'da yeni repo oluştur, `git push`).
2. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → reponu seç.
3. Railway otomatik olarak `npm install` ve `npm start` çalıştıracaktır (Node.js algılanır).
4. **Variables** sekmesinden şu ortam değişkenlerini ekle:
   - `SESSION_SECRET` → uzun, rastgele bir metin
   - `ADMIN_PASSWORD` → admin panel şifren
   - `PORT` → Railway bunu otomatik atar, dokunmana gerek yok
5. **Önemli:** lowdb verisi `data/db.json` dosyasında tutulur. Railway'in dosya sistemi her deploy'da sıfırlanabilir. Kalıcılık için Railway projene bir **Volume** ekleyip `data/` klasörünü o volume'e bağla (Railway → Settings → Volumes → Mount path: `/app/data`). Bu adımı atlarsan her yeni deploy'da siparişler/kuryeler silinir.
6. Deploy tamamlanınca Railway sana `xxxx.up.railway.app` gibi bir adres verir — bu adreste site canlı olur.

### Domain bağlama (kuriyeistanbul.com)
1. Railway → proje → **Settings** → **Networking** → **Custom Domain** → `kuriyeistanbul.com` (ve istersen `www.kuriyeistanbul.com`) ekle.
2. Railway sana bir **CNAME** kaydı verir (örn. `xxxx.up.railway.app`).
3. Domain'i aldığın yerin (GoDaddy, Namecheap, vs.) DNS ayarlarına gidip:
   - `kuriyeistanbul.com` için Railway'in verdiği CNAME/A kaydını ekle
   - `www` için ayrı bir CNAME kaydı ekle
4. DNS yayılması birkaç dakika ile birkaç saat sürebilir. Railway paneli doğrulanınca yeşil onay verir ve SSL sertifikasını otomatik kurar (ücretsiz, Let's Encrypt).

---

## 3) Önemli notlar / geliştirme fikirleri

- **Veritabanı:** Şu an basit JSON dosyası (lowdb) kullanıyor — küçük/orta hacim için yeterli. Sipariş hacmi artarsa PostgreSQL'e (Railway'de 1 tıkla eklenir) geçmen önerilir; `db.js` dosyasındaki fonksiyonları değiştirmek yeterli olur, geri kalan kod aynı kalabilir.
- **Bildirimler:** Şu an tarayıcı açıkken Socket.io ile anlık güncelleme geliyor. Müşteri/kurye siteyi kapattığında SMS/push bildirim yok — istersen Twilio (SMS) veya web push entegre edebilirim.
- **Ödeme:** Şu an ödeme akışı yok, sadece koordinasyon var. İstersen iyzico (Türkiye için en uygun) entegrasyonu ekleyebilirim.
- **Güvenlik:** Admin şifresini mutlaka `.env`'de güçlü bir değerle değiştir; varsayılan şifreyle asla canlıya çıkma.
- **Kurye onayı:** Her yeni kurye kaydı admin onayı bekliyor (sahte/istenmeyen kayıtları engellemek için) — Admin panelinden onaylanmadan giriş yapamaz.

Sorularının veya eklemek istediğin özelliklerin varsa (SMS bildirimi, harita/konum entegrasyonu, ödeme, çoklu şehir desteği vb.) söyle, birlikte genişletebiliriz.
