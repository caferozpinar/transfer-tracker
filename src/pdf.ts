import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { join } from "node:path";
import { AppDatabase, Currency, CurrencyTotals, emptyTotals, roundMoney, toDisplayDate } from "./db.ts";

const SYMBOL: Record<Currency, string> = { TRY: "₺", USD: "$", EUR: "€" };
const CURRENCIES: Currency[] = ["TRY", "USD", "EUR"];
const PAGE_W = 842; // A4 yatay
const PAGE_H = 595;
const MARGIN = 36;
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.4, 0.45, 0.52);
const LINE = rgb(0.85, 0.88, 0.92);
const HEAD_BG = rgb(0.945, 0.96, 0.976);

interface Col {
  title: string;
  w: number;
  right?: boolean;
}

interface Range {
  start_date?: string;
  end_date?: string;
}

export function fmtMoney(amount: number, currency: Currency): string {
  const n = amount.toLocaleString("tr-TR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return `${n} ${SYMBOL[currency]}`;
}

// Sıfır olmayan para birimlerini tek satırda verir: "50.099 ₺ · 1.200 $"
function fmtTotals(t: CurrencyTotals): string {
  const parts = CURRENCIES.filter((c) => t[c] !== 0).map((c) => fmtMoney(t[c], c));
  return parts.length ? parts.join("  ·  ") : "0 ₺";
}

function addTotals(a: CurrencyTotals, c: Currency, v: number) {
  a[c] = roundMoney(a[c] + v);
}

class Doc {
  pdf!: PDFDocument;
  reg!: PDFFont;
  bold!: PDFFont;
  page!: PDFPage;
  y = 0;
  title = "";
  subtitle = "";

  static async create(publicDir: string, title: string, subtitle: string): Promise<Doc> {
    const d = new Doc();
    d.pdf = await PDFDocument.create();
    d.pdf.registerFontkit(fontkit);
    d.reg = await d.pdf.embedFont(await Deno.readFile(join(publicDir, "fonts", "NotoSans-Regular.ttf")), { subset: true });
    d.bold = await d.pdf.embedFont(await Deno.readFile(join(publicDir, "fonts", "NotoSans-Bold.ttf")), { subset: true });
    d.title = title;
    d.subtitle = subtitle;
    d.pdf.setTitle(title);
    d.newPage();
    return d;
  }

  newPage() {
    this.page = this.pdf.addPage([PAGE_W, PAGE_H]);
    this.page.drawText(this.title, { x: MARGIN, y: PAGE_H - MARGIN - 12, size: 15, font: this.bold, color: INK });
    this.page.drawText(this.subtitle, { x: MARGIN, y: PAGE_H - MARGIN - 28, size: 9, font: this.reg, color: MUTED });
    this.y = PAGE_H - MARGIN - 44;
  }

  ensure(h: number) {
    if (this.y - h < MARGIN + 14) this.newPage();
  }

  heading(text: string) {
    this.ensure(30);
    this.y -= 10;
    this.page.drawText(text, { x: MARGIN, y: this.y - 12, size: 11.5, font: this.bold, color: INK });
    this.y -= 20;
  }

  wrap(text: string, font: PDFFont, size: number, maxW: number): string[] {
    const lines: string[] = [];
    let cur = "";
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const next = cur ? `${cur} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= maxW) {
        cur = next;
      } else {
        if (cur) lines.push(cur);
        // Tek başına sığmayan uzun kelimeyi karakter karakter böl.
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxW && chunk) {
            lines.push(chunk);
            chunk = ch;
          } else chunk += ch;
        }
        cur = chunk;
      }
    }
    if (cur) lines.push(cur);
    return lines.length ? lines : [""];
  }

  table(cols: Col[], rows: string[][], boldLast = false) {
    const size = 8.5;
    const lh = 11;
    const pad = 4;
    const drawHead = () => {
      this.ensure(22);
      this.page.drawRectangle({ x: MARGIN, y: this.y - 18, width: PAGE_W - 2 * MARGIN, height: 18, color: HEAD_BG });
      let x = MARGIN;
      for (const c of cols) {
        const tw = this.bold.widthOfTextAtSize(c.title, size);
        this.page.drawText(c.title, { x: c.right ? x + c.w - pad - tw : x + pad, y: this.y - 13, size, font: this.bold, color: MUTED });
        x += c.w;
      }
      this.y -= 18;
    };
    drawHead();
    rows.forEach((row, ri) => {
      const font = boldLast && ri === rows.length - 1 ? this.bold : this.reg;
      const cells = row.map((t, i) => this.wrap(t, font, size, cols[i].w - 2 * pad));
      const h = Math.max(...cells.map((l) => l.length)) * lh + 2 * pad;
      if (this.y - h < MARGIN + 14) {
        this.newPage();
        drawHead();
      }
      let x = MARGIN;
      cells.forEach((lines, i) => {
        lines.forEach((ln, li) => {
          const tw = font.widthOfTextAtSize(ln, size);
          this.page.drawText(ln, {
            x: cols[i].right ? x + cols[i].w - pad - tw : x + pad,
            y: this.y - pad - size - li * lh + 1,
            size, font, color: INK,
          });
        });
        x += cols[i].w;
      });
      this.y -= h;
      this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: PAGE_W - MARGIN, y: this.y }, thickness: 0.5, color: LINE });
    });
    this.y -= 6;
  }

  kv(label: string, value: string) {
    this.ensure(18);
    this.page.drawText(label, { x: MARGIN, y: this.y - 11, size: 10, font: this.reg, color: MUTED });
    this.page.drawText(value, { x: MARGIN + 170, y: this.y - 11, size: 10.5, font: this.bold, color: INK });
    this.y -= 18;
  }

  async finish(): Promise<Uint8Array> {
    const pages = this.pdf.getPages();
    pages.forEach((p, i) => {
      const t = `${i + 1} / ${pages.length}`;
      p.drawText(t, { x: PAGE_W - MARGIN - this.reg.widthOfTextAtSize(t, 8), y: 18, size: 8, font: this.reg, color: MUTED });
    });
    return await this.pdf.save();
  }
}

function rangeText(r: Range): string {
  if (!r.start_date && !r.end_date) return "Tüm tarihler";
  return `${toDisplayDate(r.start_date) || "…"} – ${toDisplayDate(r.end_date) || "…"}`;
}

function stamp(extra: string, r: Range): string {
  return `${extra}  |  ${rangeText(r)}  |  Oluşturma: ${toDisplayDate(new Date().toISOString().slice(0, 10))}`;
}

const RECORD_COLS: Col[] = [
  { title: "Tarih", w: 56 },
  { title: "Kalkış", w: 62 },
  { title: "Varış", w: 62 },
  { title: "Kişi", w: 84 },
  { title: "Transfer", w: 58, right: true },
  { title: "Otel", w: 54, right: true },
  { title: "Yemek", w: 50, right: true },
  { title: "İGAFİ", w: 50, right: true },
  { title: "Vize", w: 50, right: true },
  { title: "Ek", w: 50, right: true },
  { title: "Toplam", w: 66, right: true },
  { title: "Notlar", w: 128 },
];

function recordRows(db: AppDatabase, ship_id: number, r: Range): { rows: string[][]; totals: CurrencyTotals } {
  const totals = emptyTotals();
  const dash = (n: number, c: Currency) => (n ? fmtMoney(n, c) : "–");
  const rows = db.listRecords({ ship_id, ...r }).map((x) => {
    addTotals(totals, x.currency, x.total_fee);
    return [
      x.tx_date, x.departure, x.arrival, x.passenger_info,
      dash(x.transfer_fee, x.currency), dash(x.hotel_fee, x.currency), dash(x.meal_fee, x.currency),
      dash(x.igafi_fee, x.currency), dash(x.vize_fee, x.currency), dash(x.extra_fee, x.currency), fmtMoney(x.total_fee, x.currency), x.description,
    ];
  });
  return { rows, totals };
}

// 1) Tek geminin detayları
export async function shipDetailPdf(db: AppDatabase, publicDir: string, ship_id: number, r: Range = {}) {
  const ship = db.getShip(ship_id);
  if (!ship) throw new Error("Gemi bulunamadı.");
  const company = db.listCompanies().find((c) => c.id === ship.company_id);
  const d = await Doc.create(publicDir, `${ship.name} – Gemi Detayı`, stamp(company?.name ?? "", r));
  const { rows, totals } = recordRows(db, ship_id, r);
  if (rows.length) d.table(RECORD_COLS, rows);
  else d.heading("Bu aralıkta kayıt yok.");
  d.heading("Toplam");
  d.kv("Gemi toplamı", fmtTotals(totals));
  return await d.finish();
}

// 2) Tek firmanın tüm gemilerinin detayları
export async function companyDetailPdf(db: AppDatabase, publicDir: string, company_id: number, r: Range = {}) {
  const company = db.listCompanies().find((c) => c.id === company_id);
  if (!company) throw new Error("Firma bulunamadı.");
  const d = await Doc.create(publicDir, `${company.name} – Firma Detayı`, stamp(`${db.listShips(company_id).length} gemi`, r));
  const grand = emptyTotals();
  for (const ship of db.listShips(company_id)) {
    const { rows, totals } = recordRows(db, ship.id, r);
    if (!rows.length) continue;
    d.heading(ship.name);
    d.table(RECORD_COLS, rows);
    d.kv(`${ship.name} toplamı`, fmtTotals(totals));
    for (const c of CURRENCIES) addTotals(grand, c, totals[c]);
  }
  d.heading("Firma Genel Toplamı");
  d.kv("Toplam", fmtTotals(grand));
  return await d.finish();
}

// 3) Tek firmanın maddi durumu: yapılan iş (alınacak), alınan ödeme, kalan
export async function companyFinancialPdf(db: AppDatabase, publicDir: string, company_id: number, r: Range = {}) {
  const company = db.listCompanies().find((c) => c.id === company_id);
  if (!company) throw new Error("Firma bulunamadı.");
  const d = await Doc.create(publicDir, `${company.name} – Mali Durum`, stamp("Yapılan iş, alınan ödeme, kalan", r));
  const s = db.getSummary(r).companies.find((c) => c.company_id === company_id);
  const billed = s?.billed ?? emptyTotals();
  const paid = s?.paid ?? emptyTotals();
  const remaining = s?.remaining ?? emptyTotals();

  d.heading("Özet");
  d.kv("Yapılan iş (alınacak)", fmtTotals(billed));
  d.kv("Alınan ödeme", fmtTotals(paid));
  d.kv("Kalan alacak", fmtTotals(remaining));

  d.heading("Gemi Bazında Yapılan İş");
  d.table(
    [{ title: "Gemi", w: 290 }, { title: "Kayıt", w: 80, right: true }, { title: "Tutar", w: 400, right: true }],
    (s?.ships ?? []).map((x) => [x.ship_name, String(x.record_count), fmtTotals(x.totals)]),
  );

  const docs = db.listDocuments({ company_id });
  d.heading("Alınan Ödemeler");
  const pays = db.listPayments({ company_id, ...r });
  if (pays.length) {
    d.table(
      [{ title: "Tarih", w: 70 }, { title: "Gemi", w: 120 }, { title: "Tutar", w: 100, right: true }, { title: "Not", w: 230 }, { title: "Belge", w: 250 }],
      pays.map((p) => [
        toDisplayDate(p.payment_date), p.ship_name ?? "–", fmtMoney(p.amount, p.currency), p.note,
        docs.filter((x) => x.payment_id === p.id).map((x) => x.filename).join(", ") || "–",
      ]),
    );
  } else d.kv("Kayıt", "Bu aralıkta ödeme yok.");
  return await d.finish();
}
