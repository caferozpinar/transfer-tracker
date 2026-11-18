# ⚓ Gemi Transfer Takip

Gemi acenteleri ve operasyon firmaları için **Firma → Gemi → İşlem Tablosu** düzeninde çalışan, çoklu para birimi (`₺`, `$`, `€`) destekli, mali durum (yapılan iş, alınan ödeme, kalan) takibi yapan yerel web uygulaması. Windows'ta tek bir `.exe` olarak çalışır, **Tailscale** ile telefondan erişilir ve yeni sürümleri açılışta kendi kendine yükler.

---

## ✨ Özellikler

1. **Firma ve gemi bazlı tablolar:** `Tarih | Kalkış | Varış | Kişi | Transfer | Otel | Yemek | İGAFİ | Vize | Ek | Toplam | Notlar`. Boş tutarlar soluk `–` olarak görünür. `Ek`, Ayakbastı/GBT gibi doğrudan toplama yazılan tutarlar içindir. Notlar serbest metindir.
2. **Mali durum:** Firma bazında **Yapılan iş**, **Alınan ödeme**, **Kalan**. Para birimleri birbirine çevrilmez, ayrı ayrı izlenir.
3. **Belgeler ekranı:** Yüklenen belgelerin listesi ve **PDF oluşturma**. Dört tür: gemi maliyet tablosu, firma tüm gemiler, ödeme dökümü, mali durum. İsteğe bağlı başlık, açıklama ve tarih aralığı. Seçilen belgeler (PDF'ler ve resimler) PDF'in sonunda bir "Ekler" dizini ile birlikte birleştirilir; eklenemeyen belge olursa bildirilir.
4. **Belge yükleme:** Firmaya, gemiye, işlem satırına veya ödemeye bağlanır (PDF, JPG, PNG; en fazla 15 MB). Her belgeye başlık ve açıklama eklenebilir. Belgeler `veriler.db` içinde saklanır.
5. **Excel'den aktarma:** Mevcut `.xlsx` dosyaları içeri aktarılabilir. Excel çıktısı yoktur.
6. **Masaüstü + telefon:** Geniş ekranda tablo, dar ekranda kartlar ve alt menü.
7. **Otomatik güncelleme:** Açılışta GitHub release'indeki `version.json` kontrol edilir; yeni sürüm varsa indirilir, doğrulanır ve uygulama yeniden başlar (yalnızca Windows `.exe`; `NO_UPDATE=1` ile kapatılır).

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
1. Bilgisayarda `GemiTransferTakip.exe` açıkken siyah konsol ekranında (veya web arayüzünün sağ üstündeki **Menü → Telefondan Bağlan** bölümünde) yazan Tailscale adresine bakın:
   - Örnek: `http://100.85.42.19:8080`
2. Telefonunuzda **Safari** veya **Chrome** tarayıcısını açıp bu adresi yazın.
3. **Pratik İpucu (Uygulama Gibi Kullanma):**
   - Telefonda sayfa açıldığında tarayıcı menüsünden **"Ana Ekrana Ekle" (Add to Home Screen)** seçeneğine dokunun. Artık telefonunuzun ana ekranında normal bir mobil uygulama ikonu gibi yer alır ve tek dokunuşla tam ekran açılır.

---

## 🛠️ 3. Geliştirici Rehberi (Linux / Windows Kaynak Koddan Çalıştırma ve Derleme)

Proje **Deno 2** ve yerleşik `node:sqlite` ile geliştirilmiştir. Tek harici bağımlılık PDF üretimi için `pdf-lib`'dir.

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
- `NO_UPDATE`: Otomatik güncelleme kontrolünü kapatır.
- `NO_BROWSER`: Açılışta tarayıcıyı otomatik açmaz.

## Üçüncü Taraf Lisanslar

- [pdf-lib](https://github.com/Hopding/pdf-lib) — MIT
- [@pdf-lib/fontkit](https://github.com/Hopding/fontkit) — MIT
- Noto Sans (`public/fonts/`) — SIL Open Font License 1.1 (`public/fonts/OFL.txt`)
