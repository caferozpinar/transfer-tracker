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
