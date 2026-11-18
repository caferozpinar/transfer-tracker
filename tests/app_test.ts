import { AppDatabase } from "../src/db.ts";
import { createZipArchive, importRecordsFromXlsx, parseMoneyAndCurrency } from "../src/excel.ts";
import { createAppHandler } from "../src/server.ts";
import { buildPdf } from "../src/pdf.ts";
import { PDFDocument } from "pdf-lib";
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

Deno.test("5. Belge Yükleme: Kapsam Türetme (firma/gemi/işlem/ödeme), Başlık/Açıklama, Doğrulama", () => {
  const db = new AppDatabase(":memory:");
  try {
    const { company_id, ship_id } = seedSample(db);
    const rec = db.listRecords({ ship_id })[0];
    const pay = db.createPayment({ company_id, ship_id, payment_date: "2026-11-01", amount: 100, currency: "TRY" });
    const pdf = new TextEncoder().encode("%PDF-1.4 test");

    const fDoc = db.createDocument({ company_id, kind: "fatura", filename: "f.pdf", data: pdf });
    assertEquals([fDoc.ship_id, fDoc.ref_label], [null, "Firma geneli"]);

    const sDoc = db.createDocument({ ship_id, kind: "diger", filename: "g.pdf", data: pdf, title: "Gemi evrakı", description: "not" });
    assertEquals([sDoc.company_id, sDoc.title, sDoc.description, sDoc.ref_label], [company_id, "Gemi evrakı", "not", "Gemi: MV ATLAS"]);

    const rDoc = db.createDocument({ record_id: rec.id, filename: "r.pdf", data: pdf });
    assertEquals([rDoc.ship_id, rDoc.company_id], [ship_id, company_id]); // işlemden türetilir
    assertEquals(rDoc.ref_label.startsWith("İşlem 25.10.2026"), true);

    const pDoc = db.createDocument({ payment_id: pay.id, kind: "dekont", filename: "a/b.pdf", data: pdf });
    assertEquals([pDoc.filename, pDoc.ship_id, pDoc.kind], ["a_b.pdf", ship_id, "dekont"]);

    assertEquals(db.listDocuments({ ship_id }).length, 3, "gemi, işlem ve gemiye bağlı ödeme belgeleri");
    assertEquals(db.updateDocument(fDoc.id, { title: "Yeni", description: "" }).title, "Yeni");

    let rejected = 0;
    for (const bad of [{ company_id, filename: "x", data: new TextEncoder().encode("<html>") }, { filename: "x", data: pdf }]) {
      try { db.createDocument(bad); } catch (_) { rejected++; }
    }
    assertEquals(rejected, 2, "PDF/JPG/PNG dışı ve bağlanacak yeri olmayan belge reddedilmeli");

    db.deletePayment(pay.id); // ödeme silinince belgesi de silinir
    db.deleteRecord(rec.id);
    assertEquals(db.listDocuments({ company_id }).length, 2);
  } finally {
    db.close();
  }
});

const PNG_1X1 = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));

Deno.test("6. PDF Oluşturma: 4 tür, varsayılan başlık, sonda ekler (PDF + resim), eklenemeyen belge raporu", async () => {
  const db = new AppDatabase(":memory:");
  try {
    const { company_id, ship_id } = seedSample(db);
    db.createPayment({ company_id, payment_date: "2026-11-01", amount: 5000, currency: "TRY", note: "Şişli ödeme çğıöşü" });
    const pub = new URL("../public", import.meta.url).pathname;

    // 4 tür geçerli PDF üretir; başlık boşsa varsayılan metin kullanılır
    const titles: Record<string, string> = {
      "ship-cost": "MV ATLAS – Maliyet Tablosu", "company-ships": "TEST FİRMA – Tüm Gemiler",
      "payments": "TEST FİRMA / MV ATLAS – Ödeme Dökümü", "financial": "TEST FİRMA – Mali Durum",
    };
    let basePages = 0;
    for (const [type, title] of Object.entries(titles)) {
      const r = await buildPdf(db, pub, { type: type as never, company_id, ship_id });
      assertEquals(new TextDecoder().decode(r.bytes.slice(0, 5)), "%PDF-", type);
      assertEquals((await PDFDocument.load(r.bytes)).getTitle(), title, type);
      if (type === "financial") basePages = (await PDFDocument.load(r.bytes)).getPageCount();
    }
    assertEquals((await PDFDocument.load((await buildPdf(db, pub, { type: "financial", company_id, title: "Özel Başlık", description: "Açıklama\nikinci satır" })).bytes)).getTitle(), "Özel Başlık");

    // Ekler: gerçek bir PDF (basePages sayfa) + PNG + bozuk PDF
    const base = (await buildPdf(db, pub, { type: "financial", company_id })).bytes;
    const dPdf = db.createDocument({ company_id, kind: "dekont", filename: "dekont.pdf", data: base, title: "Dekont 1" });
    const dPng = db.createDocument({ company_id, kind: "fatura", filename: "fatura.png", data: PNG_1X1 });
    const dBad = db.createDocument({ company_id, filename: "bozuk.pdf", data: new TextEncoder().encode("%PDF-1.4 bozuk") });
    const withDocs = await buildPdf(db, pub, { type: "financial", company_id, document_ids: [dPdf.id, dPng.id, dBad.id] });
    // kendi sayfalar + 1 dizin + ek PDF sayfaları + 1 resim sayfası; bozuk olan sayfa eklemez
    assertEquals((await PDFDocument.load(withDocs.bytes)).getPageCount(), basePages + 1 + basePages + 1);
    assertEquals(withDocs.skipped.map((s) => s.id), [dBad.id]);

    // Başka firmanın belgesi eklenemez
    const other = db.createCompany("DİĞER");
    const foreign = db.createDocument({ company_id: other.id, filename: "x.png", data: PNG_1X1 });
    let rejected = false;
    try { await buildPdf(db, pub, { type: "financial", company_id, document_ids: [foreign.id] }); } catch (_) { rejected = true; }
    assertEquals(rejected, true, "başka firmanın belgesi reddedilmeli");

    // HTTP uç noktası
    const res = await createAppHandler(db, 8080)(new Request("http://localhost/api/pdf/build", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "ship-cost", company_id, ship_id, document_ids: [dBad.id] }),
    }));
    assertEquals(res.status, 200);
    assertEquals(JSON.parse(decodeURIComponent(res.headers.get("x-skipped-attachments")!)).length, 1);
  } finally {
    db.close();
  }
});

Deno.test("7. Airport ve VİZE Toplama Dahil, Notlar Düz Metin, Excel İçe Aktarım", () => {
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
      ["TARİH", "KALKIŞ", "VARIŞ", "GEMİ ADI", "KİŞİ SAYISI", "TRANSFER ÜCRETİ", "OTEL", "YEMEK", "AIRPORT", "VİZE", "TOTAL", "NOTLAR"],
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
