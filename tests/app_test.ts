import { AppDatabase } from "../src/db.ts";
import { exportShipRecordsToXlsx, importRecordsFromXlsx, parseMoneyAndCurrency } from "../src/excel.ts";
import { createAppHandler } from "../src/server.ts";

function assertEquals<T>(actual: T, expected: T, msg = "") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`Assertion failed ${msg}: expected ${b}, got ${a}`);
  }
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

Deno.test("3. Excel (.xlsx) Dışa ve İçe Aktarım (Export & Import) Doğrulaması", () => {
  const db1 = new AppDatabase(":memory:");
  const db2 = new AppDatabase(":memory:");
  try {
    const { ship_id } = seedSample(db1);
    const records = db1.listRecords({ ship_id });

    // Export to .xlsx buffer
    const xlsxBuffer = exportShipRecordsToXlsx("MV ATLAS", records);
    if (xlsxBuffer.byteLength < 1000) {
      throw new Error("Üretilen Excel dosyası beklenenden küçük.");
    }

    // Import into second clean database
    const comp2 = db2.createCompany("YENİ FİRMA");
    const importRes = importRecordsFromXlsx(db2, comp2.id, null, xlsxBuffer);
    assertEquals(importRes.importedCount, 3, "3 satır eksiksiz içe aktarılmalı");
    assertEquals(importRes.shipsTouched, ["MV ATLAS"]);

    const summary2 = db2.getSummary();
    assertEquals(summary2.overall_billed.TRY, 21872);
  } finally {
    db1.close();
    db2.close();
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

Deno.test("7. İGAFİ ve VİZE Toplama Dahil, Notlar Düz Metin, Excel Gidiş-Dönüş", () => {
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

    const xlsx = exportShipRecordsToXlsx("MV X", db1.listRecords({ ship_id: ship.id }));
    const comp2 = db2.createCompany("G");
    importRecordsFromXlsx(db2, comp2.id, null, xlsx);
    const back = db2.listRecords({})[0];
    assertEquals([back.igafi_fee, back.vize_fee, back.total_fee, back.currency], [20, 80, 200, "USD"]);
    assertEquals(back.description, "Oda: 1 twin, geç giriş");
  } finally {
    db1.close();
    db2.close();
  }
});
