import { AppDatabase } from "../src/db.ts";
import { createZipArchive, importRecordsFromXlsx, parseMoneyAndCurrency } from "../src/excel.ts";
import { createAppHandler } from "../src/server.ts";
import { checkForUpdate, compareVersions, downloadVerified, sha256Hex, validateManifest } from "../src/updater.ts";

function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`Assertion failed ${msg}: expected ${b}, got ${a}`);
  }
}

// Test için küçük bir .xlsx üretir (uygulamada Excel dışa aktarma yok, yalnızca içe aktarma var).
function makeXlsx(sheetName: string, rows: string[][]): Uint8Array {
  const enc = new TextEncoder();
  const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const letter = (i: number) => String.fromCharCode(65 + i);
  const sheetData = rows
    .map((r, ri) =>
      `<row r="${ri + 1}">` +
      r.map((v, ci) => `<c r="${letter(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join("") +
      `</row>`
    )
    .join("");
  return createZipArchive([
    { name: "xl/workbook.xml", data: enc.encode(`<workbook><sheets><sheet name="${sheetName}" sheetId="1"/></sheets></workbook>`) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(`<worksheet><sheetData>${sheetData}</sheetData></worksheet>`) },
  ]);
}

// Yalnızca testler için küçük örnek veri (uygulamada hazır veri yoktur).
function seedSample(db: AppDatabase) {
  const company = db.createCompany("TEST FİRMA");
  const ship = db.createShip(company.id, "MV ATLAS");
  db.createRecord({ ship_id: ship.id, tx_date: "25.10.2026", departure: "A", arrival: "B", transfer_fee: 4000, currency: "TRY", description: "TRANSFER" });
  db.createRecord({ ship_id: ship.id, tx_date: "", extra_fee: 1982, currency: "TRY", description: "AYAKBASTI" });
  db.createRecord({ ship_id: ship.id, tx_date: "25.10.2026", departure: "B", arrival: "C", transfer_fee: 350, hotel_fee: 15540, currency: "TRY", description: "1 TWIN ROOM" });
  return { company_id: company.id, ship_id: ship.id };
}

Deno.test("1. Kayıt Toplamları ve Tarih Devralma Doğrulaması", () => {
  const db = new AppDatabase(":memory:");
  try {
    const { company_id, ship_id } = seedSample(db);
    const records = db.listRecords({ ship_id });
    assertEquals(records.length, 3, "satır sayısı");

    // 5. satır: 350 TL transfer + 15.540 TL otel = 15.890 TL (1 TWIN ROOM)
    assertEquals(records[2].transfer_fee, 350);
    assertEquals(records[2].hotel_fee, 15540);
    assertEquals(records[2].total_fee, 15890);
    assertEquals(records[2].description, "1 TWIN ROOM");

    // 2. satır: Ayakbastı (Doğrudan 1.982 TL, üst satırın tarihi 2026-10-25 ile bağlı)
    assertEquals(records[1].transfer_fee, 0);
    assertEquals(records[1].extra_fee, 1982);
    assertEquals(records[1].total_fee, 1982);
    assertEquals(records[1].effective_date, "2026-10-25");

    const summary = db.getSummary();
    const compSummary = summary.companies.find((c) => c.company_id === company_id)!;
    assertEquals(compSummary.billed.TRY, 21872);
    assertEquals(summary.overall_billed.TRY, 21872);
  } finally {
    db.close();
  }
});

Deno.test("2. Çoklu Para Birimi (TRY, USD, EUR) Dönüşümsüz Bağımsız Cari Hesaplama", () => {
  const db = new AppDatabase(":memory:");
  try {
    const comp = db.createCompany("GLOBAL SHIPPING LTD");
    const ship1 = db.createShip(comp.id, "MV ATLAS");
    const ship2 = db.createShip(comp.id, "MV POSEIDON");

    // MV ATLAS: 10.000 TRY ve 1.200 USD iş
    db.createRecord({
      ship_id: ship1.id,
      tx_date: "01.11.2026",
      departure: "IGA",
      arrival: "ZEYPORT",
      transfer_fee: 10000,
      currency: "TRY",
      description: "TRANSFER",
    });
    db.createRecord({
      ship_id: ship1.id,
      tx_date: "02.11.2026",
      departure: "ZEYPORT",
      arrival: "TASHAN",
      transfer_fee: 400,
      hotel_fee: 800,
      currency: "USD",
      description: "1 TWIN ROOM",
    });

    // MV POSEIDON: 500 USD ve 750 EUR iş
    db.createRecord({
      ship_id: ship2.id,
      tx_date: "03.11.2026",
      extra_fee: 500,
      currency: "USD",
      description: "PERSONEL DEĞİŞİMİ",
    });
    db.createRecord({
      ship_id: ship2.id,
      tx_date: "04.11.2026",
      extra_fee: 750,
      currency: "EUR",
      description: "AYAKBASTI",
    });

    // Tahsilatlar: 4.000 TRY, 1.000 USD, 250 EUR ödeme alındı
    db.createPayment({
      company_id: comp.id,
      payment_date: "2026-11-05",
      amount: 4000,
      currency: "TRY",
      note: "TL Havale",
    });
    db.createPayment({
      company_id: comp.id,
      payment_date: "2026-11-06",
      amount: 1000,
      currency: "USD",
      note: "USD Swift",
    });
    db.createPayment({
      company_id: comp.id,
      payment_date: "2026-11-06",
      amount: 250,
      currency: "EUR",
      note: "EUR Nakit",
    });

    const summary = db.getSummary();
    const cs = summary.companies[0];

    // Yapılan İş Toplamı: 10.000 TRY, 1.700 USD, 750 EUR
    assertEquals(cs.billed, { TRY: 10000, USD: 1700, EUR: 750 });
    // Alınan Ödeme: 4.000 TRY, 1.000 USD, 250 EUR
    assertEquals(cs.paid, { TRY: 4000, USD: 1000, EUR: 250 });
    // Kalan Alacak: 6.000 TRY, 700 USD, 500 EUR
    assertEquals(cs.remaining, { TRY: 6000, USD: 700, EUR: 500 });
  } finally {
    db.close();
  }
});

Deno.test("3. Excel (.xlsx) İçe Aktarım: Eski 10 Sütunlu Biçim", () => {
  const db = new AppDatabase(":memory:");
  try {
    const xlsx = makeXlsx("MV ATLAS", [
      ["TARİH", "KALKIŞ", "VARIŞ", "GEMİ ADI", "KİŞİ SAYISI", "TRANSFER ÜCRETİ", "OTEL", "YEMEK", "TOTAL", "ODA DETAYI"],
      ["25.10.2026", "A", "B", "MV ATLAS", "2 KİŞİ", "4.000 ₺", "X", "X", "4.000 ₺", "TRANSFER"],
      ["", "", "", "MV ATLAS", "2 KİŞİ", "X", "X", "X", "1.982 ₺", "AYAKBASTI"],
      ["26.10.2026", "B", "C", "MV ATLAS", "", "350 ₺", "₺15.540", "X", "15.890 ₺", "1 TWIN ROOM"],
      ["TOTAL", "", "", "", "", "₺21.872,00", "", "", "", ""],
    ]);
    const comp = db.createCompany("YENİ FİRMA");
    const res = importRecordsFromXlsx(db, comp.id, null, xlsx);
    assertEquals(res.importedCount, 3, "3 satır içe aktarılmalı (TOTAL satırı hariç)");
    assertEquals(res.shipsTouched, ["MV ATLAS"]);
    assertEquals(db.getSummary().overall_billed.TRY, 21872);
  } finally {
    db.close();
  }
});

Deno.test("4. Para Birimi Hücre Ayrıştırıcı (parseMoneyAndCurrency) ve HTTP API Testi", async () => {
  assertEquals(parseMoneyAndCurrency("4.000 ₺"), { value: 4000, currency: "TRY" });
  assertEquals(parseMoneyAndCurrency("₺15.540"), { value: 15540, currency: "TRY" });
  assertEquals(parseMoneyAndCurrency("$1,250.50"), { value: 1250.5, currency: "USD" });
  assertEquals(parseMoneyAndCurrency("850 €"), { value: 850, currency: "EUR" });
  assertEquals(parseMoneyAndCurrency("X"), { value: 0, currency: "TRY" });

  const db = new AppDatabase(":memory:");
  try {
    seedSample(db);
    const handler = createAppHandler(db, 8080);
    const res = await handler(new Request("http://localhost:8080/api/summary"));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.overall_billed.TRY, 21872);
  } finally {
    db.close();
  }
});

Deno.test("5. Belge Yükleme: Tür Doğrulama, Sınır ve Silme Zinciri", () => {
  const db = new AppDatabase(":memory:");
  try {
    const { company_id } = seedSample(db);
    const pay = db.createPayment({ company_id, payment_date: "2026-11-01", amount: 100, currency: "TRY" });
    const pdf = new TextEncoder().encode("%PDF-1.4 test");
    const doc = db.createDocument({ company_id, payment_id: pay.id, kind: "dekont", filename: "a/b.pdf", data: pdf });
    assertEquals(doc.mime, "application/pdf");
    assertEquals(doc.filename, "a_b.pdf");
    assertEquals(db.listDocuments({ payment_id: pay.id }).length, 1);

    let rejected = false;
    try {
      db.createDocument({ company_id, filename: "x.pdf", data: new TextEncoder().encode("<html>") });
    } catch (_) {
      rejected = true;
    }
    assertEquals(rejected, true, "PDF/JPG/PNG dışı reddedilmeli");

    db.deletePayment(pay.id); // ödeme silinince belgesi de silinir
    assertEquals(db.listDocuments({ company_id }).length, 0);
  } finally {
    db.close();
  }
});

Deno.test("6. PDF Çıktıları (gemi, firma detay, mali durum) Geçerli PDF Üretir", async () => {
  const db = new AppDatabase(":memory:");
  try {
    const { company_id, ship_id } = seedSample(db);
    db.createPayment({ company_id, payment_date: "2026-11-01", amount: 5000, currency: "TRY", note: "Şişli ödeme çğıöşü" });
    const handler = createAppHandler(db, 8080);
    for (const p of [`ship/${ship_id}`, `company/${company_id}/detail`, `company/${company_id}/financial`]) {
      const res = await handler(new Request(`http://localhost:8080/api/pdf/${p}`));
      assertEquals(res.status, 200, p);
      const bytes = new Uint8Array(await res.arrayBuffer());
      assertEquals(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-", p);
    }
  } finally {
    db.close();
  }
});

Deno.test("7. İGAFİ ve VİZE Toplama Dahil, Notlar Düz Metin, Excel İçe Aktarım", () => {
  const db1 = new AppDatabase(":memory:");
  const db2 = new AppDatabase(":memory:");
  try {
    const comp = db1.createCompany("F");
    const ship = db1.createShip(comp.id, "MV X");
    const rec = db1.createRecord({
      ship_id: ship.id, tx_date: "01.11.2026", transfer_fee: 100, igafi_fee: 20, vize_fee: 30,
      currency: "USD", description: "Oda: 1 twin, geç giriş",
    });
    assertEquals(rec.total_fee, 150);
    assertEquals(rec.description, "Oda: 1 twin, geç giriş"); // büyük harfe çevrilmez
    assertEquals(db1.updateRecord(rec.id, { vize_fee: 80 }).total_fee, 200);

    const xlsx = makeXlsx("MV X", [
      ["TARİH", "KALKIŞ", "VARIŞ", "GEMİ ADI", "KİŞİ SAYISI", "TRANSFER ÜCRETİ", "OTEL", "YEMEK", "İGAFİ", "VİZE", "TOTAL", "NOTLAR"],
      ["01.11.2026", "", "", "MV X", "", "100 $", "X", "X", "20 $", "80 $", "200 $", "Oda: 1 twin, geç giriş"],
    ]);
    importRecordsFromXlsx(db2, db2.createCompany("G").id, null, xlsx);
    const back = db2.listRecords({})[0];
    assertEquals([back.igafi_fee, back.vize_fee, back.total_fee, back.currency], [20, 80, 200, "USD"]);
    assertEquals(back.description, "Oda: 1 twin, geç giriş");
  } finally {
    db1.close();
    db2.close();
  }
});

Deno.test("8. Otomatik Güncelleme: Sürüm Karşılaştırma, Manifest ve Hash Doğrulama", async () => {
  assertEquals(compareVersions("0.10.0", "0.9.0"), 1);
  assertEquals(compareVersions("v0.2.0", "0.2.0"), 0);
  assertEquals(compareVersions("0.1.9", "0.2.0"), -1);
  assertEquals(compareVersions("abc", "0.2.0"), null);

  const bytes = new TextEncoder().encode("yeni-exe");
  const sha256 = await sha256Hex(bytes);
  const url = "https://github.com/caferozpinar/transfer-tracker/releases/download/v0.3.0/GemiTransferTakip.exe";
  const fakeFetch = (manifest: unknown): typeof fetch => (input) => {
    const u = String(input);
    return Promise.resolve(u.endsWith("version.json") ? Response.json(manifest) : new Response(bytes));
  };

  // Daha yeni sürüm -> manifest; aynı/eski sürüm -> null
  const m = { version: "0.3.0", url, sha256 };
  assertEquals((await checkForUpdate("0.2.0", fakeFetch(m)))?.version, "0.3.0");
  assertEquals(await checkForUpdate("0.3.0", fakeFetch(m)), null);
  assertEquals(await checkForUpdate("0.4.0", fakeFetch(m)), null);

  // Hash doğruysa indirir, yanlışsa reddeder
  assertEquals((await downloadVerified(validateManifest(m), fakeFetch(m))).byteLength, bytes.byteLength);
  let rejected = false;
  try {
    await downloadVerified(validateManifest({ ...m, sha256: "0".repeat(64) }), fakeFetch(m));
  } catch (_) {
    rejected = true;
  }
  assertEquals(rejected, true, "hash uyuşmazsa kurulmamalı");

  // Başka bir siteden indirme adresi reddedilir
  let badUrl = false;
  try {
    validateManifest({ ...m, url: "https://evil.example/app.exe" });
  } catch (_) {
    badUrl = true;
  }
  assertEquals(badUrl, true, "yalnızca bu repo'nun release adresi kabul edilmeli");
});
