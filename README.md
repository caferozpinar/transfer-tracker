# ⚓ Gemi Transfer ve Cari Takip Sistemi

Gemi acenteleri ve operasyon firmaları için **Firma -> Gemi -> Operasyon Tablosu** hiyerarşisinde çalışan, çoklu para birimi (`₺ TRY`, `$ USD`, `€ EUR`) destekli, cari hesap (girdi-çıktı / tahsilat ve kalan alacak) takibi yapan, Excel (`.xlsx`) içe/dışa aktarım özellikli yerel web uygulaması.

Uygulama **Windows** üzerinde hiçbir ek kuruluma ihtiyaç duymayan **tek bir `.exe` dosyası (`GemiTransferTakip.exe`)** olarak çalışır ve **Tailscale** üzerinden cep telefonundan (mobil uyumlu arayüzle) her yerden erişilebilir.

---

## ✨ Temel Özellikler

1. **Firma ve Gemi Bazlı Tablolar:**
   - Her firmanın altında gemiler (`MV ATLAS` vb.) sekme olarak yer alır.
   - Her geminin altında standart Excel görünümünde (`TARİH | KALKIŞ | VARIŞ | GEMİ ADI | KİŞİ SAYISI | TRANSFER ÜCRETİ | OTEL | YEMEK | TOTAL | ODA DETAYI`) operasyon tablosu bulunur.
   - Boş bırakılan ücret kalemleri tabloda otomatik olarak **`X`** şeklinde gösterilir.
   - `AYAKBASTI`, `GBT`, `PERSONEL DEĞİŞİMİ` gibi alt kalem olmayan işlemler için **Doğrudan / Ek Tutar** alanı ile doğrudan `TOTAL` sütununa ücret yazılabilir.
2. **Üç Kademeli Otomatik Toplam:**
   - **Seçili Gemi Toplamı**, **Seçili Firma Toplamı** ve **Genel Toplam (Tüm Firmalar)** anlık olarak hesaplanır.
3. **Bağımsız Çoklu Para Birimi (`₺`, `$`, `€`):**
   - Para birimleri birbirine kur ile dönüştürülmez; Dolar (`$`) girilen işin alacağı ve ödemesi Dolar bakiyesinden, Euro (`€`) girilen Euro'dan, TL (`₺`) girilen TL'den takip edilir.
4. **Girdi-Çıktı (Cari Hesap & Ödeme Takip) Ekranı:**
   - Firma bazında **Toplam Yapılan İş (Alacak)**, **Alınan Ödemeler (Tahsilat)** ve **Kalan Alacak (Bakiye)** canlı olarak görünür.
5. **Masaüstü + Telefon (Mobil) Uyumlu Pratik Tasarım:**
   - Bilgisayarda klavye ile hızlı satır ekleme (`Enter` ile seri kayıt) ve Excel görünümü.
   - Telefonda tek elle kullanıma uygun **Alt Menü**, okunaklı **Operasyon Kartları** (veya tek dokunuşla Excel Tablo görünümü) ve hızlı işlem çipleri (`[TRANSFER]`, `[AYAKBASTI]`, `[GBT]`, `[PERSONEL DEĞİŞİMİ]`, `[1 TWIN ROOM]`).
6. **Sıfır Bağımlılıklı Excel (`.xlsx`) İndirme ve Yükleme:**
   - Seçili gemiyi veya firmanın tüm gemilerini (her gemi ayrı bir Excel sayfası/sheet olacak şekilde) renkli ve biçimli `.xlsx` olarak indirir, mevcut `.xlsx` dosyalarını içeri aktarır.

---

## 🚀 1. Windows Bilgisayara Kurulum (Kullanıcı Rehberi)

Windows bilgisayara Python, Node.js veya SQLite gibi **hiçbir ek program kurmanıza gerek yoktur.**

### Adım 1: `.exe` Dosyasını İndirin
1. Bu GitHub sayfasının üst menüsündeki **[Actions](../../actions)** sekmesine (veya sağ taraftaki **Releases** bölümüne) tıklayın.
2. En üstteki yeşil onaylı (`✔`) çalışmaya tıklayın ve alt kısımdaki **Artifacts** başlığı altından **`GemiTransferTakip-Windows-x64`** dosyasını indirip klasöre çıkarın.
3. Bilgisayarınızda masaüstünde (veya `C:\GemiTakip` gibi bir yerde) yeni bir klasör açıp `GemiTransferTakip.exe` dosyasını içine koyun.

### Adım 2: Uygulamayı Çalıştırın
1. `GemiTransferTakip.exe` dosyasına çift tıklayın.
2. Windows Defender SmartScreen *"Windows kişisel bilgisayarınızı korudu"* uyarısı verirse **"Ek bilgi (More info)"** -> **"Yine de çalıştır (Run anyway)"** butonuna tıklayın.
3. Windows Güvenlik Duvarı (Firewall) ağ erişimi izni sorarsa **"Özel ağlar"** ve **"Ortak ağlar"** kutucuklarını işaretleyip **"Erişime izin ver"** deyin (telefondan bağlanabilmek için gereklidir).
4. Siyah bilgi penceresi açılacak ve internet tarayıcınızda otomatik olarak `http://localhost:8080` adresi açılacaktır.

> **💾 Veriler Nerede Saklanır? (Yedekleme)**
> Uygulama çalıştığı klasörün içinde **`veriler.db`** adında tek bir veritabanı dosyası oluşturur. Tüm firmalarınız, gemileriniz, tablolarınız ve ödemeleriniz bu dosyadadır. Yedek almak için `veriler.db` dosyasını kopyalamanız yeterlidir.

---

## 📱 2. Tailscale ile Telefondan Erişim Kurulumu

Uygulama bilgisayarda açık olduğu sürece, telefonunuzla ister evde Wi-Fi'da ister dışarıda mobil veride (4.5G/5G) olun, **Tailscale** üzerinden güvenle bağlanabilirsiniz.

### Adım 1: Bilgisayara ve Telefona Tailscale Kurun
1. **Windows Bilgisayara:** [https://tailscale.com/download/windows](https://tailscale.com/download/windows) adresinden Tailscale'i indirip kurun.
2. **Telefona (iPhone / Android):** App Store veya Google Play Store'dan **Tailscale** uygulamasını indirin.
3. Hem bilgisayarda hem de telefonda **aynı Google veya Microsoft hesabınızla** giriş yapın ve bağlantıyı **Connected (Açık)** konumuna getirin.

### Adım 2: Telefondan Uygulamaya Girin
1. Bilgisayarda `GemiTransferTakip.exe` açıkken siyah konsol ekranında (veya web arayüzünün sağ üstündeki **"📱 Telefondan Bağlan"** butonunda) yazan Tailscale adresine bakın:
   - Örnek: `http://100.85.42.19:8080`
2. Telefonunuzda **Safari** veya **Chrome** tarayıcısını açıp bu adresi yazın.
3. **Pratik İpucu (Uygulama Gibi Kullanma):**
   - Telefonda sayfa açıldığında tarayıcı menüsünden **"Ana Ekrana Ekle" (Add to Home Screen)** seçeneğine dokunun. Artık telefonunuzun ana ekranında normal bir mobil uygulama ikonu gibi yer alır ve tek dokunuşla tam ekran açılır.

---

## 🛠️ 3. Geliştirici Rehberi (Linux / Windows Kaynak Koddan Çalıştırma ve Derleme)

Proje **Deno 2** ve yerleşik `node:sqlite` ile sıfır harici paket bağımlılığıyla geliştirilmiştir.

### Gereksinimler
- [Deno 2.x](https://deno.com/) (`curl -fsSL https://deno.land/install.sh | sh`)

### Komutlar

```bash
# 1. Geliştirme modunda çalıştırma (http://localhost:8080)
deno task dev

# 2. Otomatik birim ve entegrasyon testlerini çalıştırma
deno task test

# 3. Linux veya Windows üzerinden Windows (.exe) derleme
deno task build:win
# Çıktı: dist/GemiTransferTakip.exe

# 4. Linux için tek dosya binary derleme
deno task build:linux
# Çıktı: dist/gemi-transfer-takip
```

### Ortam Değişkenleri (Opsiyonel)
- `PORT`: Varsayılan `8080` portunu değiştirmek için kullanılır (Örn: `PORT=9090`).
- `DB_PATH`: Varsayılan `veriler.db` dosya yolunu değiştirmek için kullanılır.
