import { PDFDocument, PDFFont, PDFPage, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { join } from "node:path";
import {
  AppDatabase, Currency, CurrencyTotals, DocumentItem, emptyTotals, roundMoney, toDisplayDate,
} from "./db.ts";

const SYMBOL: Record<Currency, string> = { TRY: "₺", USD: "$", EUR: "€" };
const CURRENCIES: Currency[] = ["TRY", "USD", "EUR"];
const PAGE_W = 842; // A4 yatay
const PAGE_H = 595;
const MARGIN = 36;
const INK = rgb(0.06, 0.09, 0.16);
const MUTED = rgb(0.4, 0.45, 0.52);
const LINE = rgb(0.85, 0.88, 0.92);
const HEAD_BG = rgb(0.945, 0.96, 0.976);

export const MAX_ATTACHMENTS = 40;
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

interface Col {
  title: string;
  w: number;
  right?: boolean;
}

export interface Range {
  start_date?: string;
  end_date?: string;
}

export type PdfType = "ship-cost" | "company-ships" | "payments" | "financial";

export interface BuildOptions extends Range {
  type: PdfType;
  company_id: number;
  ship_id?: number;
  title?: string;
  description?: string;
  document_ids?: number[];
}

export interface BuildResult {
  bytes: Uint8Array;
  skipped: { id: number; title: string; reason: string }[];
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
  ownPages = 0; // eklerden önceki (bizim yazdığımız) sayfa sayısı

  static async create(publicDir: string, title: string, subtitle: string, description = ""): Promise<Doc> {
    const d = new Doc();
    d.pdf = await PDFDocument.create();
    d.pdf.registerFontkit(fontkit);
    d.reg = await d.pdf.embedFont(await Deno.readFile(join(publicDir, "fonts", "NotoSans-Regular.ttf")), { subset: true });
    d.bold = await d.pdf.embedFont(await Deno.readFile(join(publicDir, "fonts", "NotoSans-Bold.ttf")), { subset: true });
    d.title = title;
    d.subtitle = subtitle;
    d.pdf.setTitle(title);
    d.newPage();
    if (description.trim()) {
      // Açıklama yalnızca ilk sayfada, başlığın altında görünür.
      for (const para of description.trim().split(/\r?\n/)) {
        for (const ln of d.wrap(para, d.reg, 10, PAGE_W - 2 * MARGIN)) {
          d.page.drawText(ln, { x: MARGIN, y: d.y - 10, size: 10, font: d.reg, color: INK });
          d.y -= 14;
        }
      }
      d.y -= 4;
    }
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

  table(cols: Col[], rows: string[][]) {
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
    for (const row of rows) {
      const font = this.reg;
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
    }
    this.y -= 6;
  }

  kv(label: string, value: string) {
    this.ensure(18);
    this.page.drawText(label, { x: MARGIN, y: this.y - 11, size: 10, font: this.reg, color: MUTED });
    this.page.drawText(value, { x: MARGIN + 170, y: this.y - 11, size: 10.5, font: this.bold, color: INK });
    this.y -= 18;
  }

  // Ekler: önce "Ekler" dizini, sonra belgeler olduğu gibi sona eklenir.
  async appendAttachments(items: Attachment[]): Promise<BuildResult["skipped"]> {
    if (!items.length) return [];
    const skipped: BuildResult["skipped"] = [];
    type Ready = { item: Attachment; src?: PDFDocument; image?: Awaited<ReturnType<PDFDocument["embedPng"]>>; pages: number };
    const ready: Ready[] = [];
    for (const item of items) {
      const name = item.title || item.filename;
      try {
        if (item.mime === "application/pdf") {
          const src = await PDFDocument.load(item.data); // şifreliyse hata verir
          ready.push({ item, src, pages: src.getPageCount() });
        } else {
          const image = item.mime === "image/png" ? await this.pdf.embedPng(item.data) : await this.pdf.embedJpg(item.data);
          ready.push({ item, image, pages: 1 });
        }
      } catch (err) {
        const reason = item.mime === "application/pdf" ? "şifreli veya bozuk PDF" : "resim okunamadı";
        skipped.push({ id: item.id, title: name, reason });
        ready.push({ item, pages: 0 });
        console.log(`Ek eklenemedi (${name}): ${err instanceof Error ? err.message : err}`);
      }
    }

    this.newPage();
    this.heading("Ekler");
    this.table(
      [
        { title: "Ek", w: 36 }, { title: "Başlık", w: 200 }, { title: "Tür", w: 56 },
        { title: "Bağlı olduğu yer", w: 214 }, { title: "Açıklama", w: 184 }, { title: "Durum", w: 80 },
      ],
      ready.map((r, i) => [
        String(i + 1),
        r.item.title && r.item.title !== r.item.filename ? `${r.item.title} (${r.item.filename})` : r.item.filename,
        KIND_LABEL[r.item.kind] ?? "Belge",
        r.item.ref_label,
        r.item.description || "–",
        r.pages ? `${r.pages} sayfa` : "Eklenemedi",
      ]),
    );

    this.ownPages = this.pdf.getPageCount();
    for (const r of ready) {
      if (r.src) {
        const copied = await this.pdf.copyPages(r.src, r.src.getPageIndices());
        copied.forEach((p) => this.pdf.addPage(p));
      } else if (r.image) {
        const landscape = r.image.width > r.image.height;
        const [pw, ph] = landscape ? [PAGE_W, PAGE_H] : [PAGE_H, PAGE_W];
        const page = this.pdf.addPage([pw, ph]);
        const scale = Math.min((pw - 48) / r.image.width, (ph - 48) / r.image.height, 1);
        const w = r.image.width * scale;
        const h = r.image.height * scale;
        page.drawImage(r.image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      }
    }
    return skipped;
  }

  // Sayfa numarası yalnızca kendi sayfalarımıza yazılır; eklenen belgelere dokunulmaz.
  async finish(ownPages: number): Promise<Uint8Array> {
    const pages = this.pdf.getPages();
    for (let i = 0; i < Math.min(ownPages, pages.length); i++) {
      const t = `${i + 1} / ${pages.length}`;
      pages[i].drawText(t, { x: PAGE_W - MARGIN - this.reg.widthOfTextAtSize(t, 8), y: 18, size: 8, font: this.reg, color: MUTED });
    }
    return await this.pdf.save();
  }
}

const KIND_LABEL: Record<string, string> = { dekont: "Dekont", fatura: "Fatura", diger: "Belge" };

interface Attachment extends DocumentItem {
  data: Uint8Array;
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
      dash(x.igafi_fee, x.currency), dash(x.vize_fee, x.currency), dash(x.extra_fee, x.currency),
      fmtMoney(x.total_fee, x.currency), x.description,
    ];
  });
  return { rows, totals };
}

// Tek PDF üretir: seçilen türün içeriği + sonda seçilen ekler.
export async function buildPdf(db: AppDatabase, publicDir: string, o: BuildOptions): Promise<BuildResult> {
  const company = db.listCompanies().find((c) => c.id === o.company_id);
  if (!company) throw new Error("Firma bulunamadı.");
  const range: Range = { start_date: o.start_date || undefined, end_date: o.end_date || undefined };
  const ship = o.ship_id ? db.getShip(o.ship_id) : undefined;
  if (o.ship_id && (!ship || ship.company_id !== company.id)) throw new Error("Gemi bu firmaya ait değil.");
  if (o.type === "ship-cost" && !ship) throw new Error("Gemi maliyet tablosu için gemi seçilmelidir.");

  // Ekler: yalnızca bu firmaya ait belgeler, istenen sırayla.
  const ids = o.document_ids ?? [];
  if (ids.length > MAX_ATTACHMENTS) throw new Error(`En fazla ${MAX_ATTACHMENTS} ek eklenebilir.`);
  const companyDocs = new Map(db.listDocuments({ company_id: company.id }).map((d) => [d.id, d]));
  const attachments: Attachment[] = [];
  let totalBytes = 0;
  for (const id of ids) {
    const meta = companyDocs.get(id);
    if (!meta) throw new Error("Seçilen belge bu firmaya ait değil veya bulunamadı.");
    totalBytes += meta.size;
    if (totalBytes > MAX_ATTACHMENT_BYTES) throw new Error("Eklerin toplam boyutu 100 MB'ı aşıyor.");
    const blob = db.getDocumentData(id);
    if (blob) attachments.push({ ...meta, data: blob.data });
  }

  const defaults: Record<PdfType, string> = {
    "ship-cost": `${ship?.name ?? ""} – Maliyet Tablosu`,
    "company-ships": `${company.name} – Tüm Gemiler`,
    "payments": `${company.name}${ship ? ` / ${ship.name}` : ""} – Ödeme Dökümü`,
    "financial": `${company.name} – Mali Durum`,
  };
  const title = (o.title ?? "").trim() || defaults[o.type];
  const sub = o.type === "ship-cost" ? company.name : o.type === "payments" && ship ? `${company.name}  |  yalnızca ${ship.name} gemisine bağlı ödemeler` : `${company.name}`;
  const d = await Doc.create(publicDir, title, stamp(sub, range), o.description ?? "");

  if (o.type === "ship-cost") {
    const { rows, totals } = recordRows(db, ship!.id, range);
    if (rows.length) d.table(RECORD_COLS, rows);
    else d.heading("Bu aralıkta kayıt yok.");
    d.heading("Toplam");
    d.kv("Gemi toplamı", fmtTotals(totals));
  } else if (o.type === "company-ships") {
    const grand = emptyTotals();
    for (const s of db.listShips(company.id)) {
      const { rows, totals } = recordRows(db, s.id, range);
      if (!rows.length) continue;
      d.heading(s.name);
      d.table(RECORD_COLS, rows);
      d.kv(`${s.name} toplamı`, fmtTotals(totals));
      for (const c of CURRENCIES) addTotals(grand, c, totals[c]);
    }
    d.heading("Firma Genel Toplamı");
    d.kv("Toplam", fmtTotals(grand));
  } else if (o.type === "payments") {
    const pays = db.listPayments({ company_id: company.id, ship_id: ship?.id, ...range });
    const totals = emptyTotals();
    pays.forEach((p) => addTotals(totals, p.currency, p.amount));
    if (pays.length) {
      const docs = db.listDocuments({ company_id: company.id });
      d.table(
        [{ title: "Tarih", w: 70 }, { title: "Gemi", w: 130 }, { title: "Tutar", w: 100, right: true }, { title: "Not", w: 240 }, { title: "Belge", w: 230 }],
        pays.map((p) => [
          toDisplayDate(p.payment_date), p.ship_name ?? "Firma geneli", fmtMoney(p.amount, p.currency), p.note,
          docs.filter((x) => x.payment_id === p.id).map((x) => x.title || x.filename).join(", ") || "–",
        ]),
      );
    } else d.heading("Bu aralıkta ödeme yok.");
    d.heading("Toplam");
    d.kv("Alınan ödeme", fmtTotals(totals));
  } else {
    const s = db.getSummary(range).companies.find((c) => c.company_id === company.id);
    d.heading("Özet");
    d.kv("Yapılan iş", fmtTotals(s?.billed ?? emptyTotals()));
    d.kv("Alınan ödeme", fmtTotals(s?.paid ?? emptyTotals()));
    d.kv("Kalan", fmtTotals(s?.remaining ?? emptyTotals()));
    d.heading("Gemi Bazında Yapılan İş");
    d.table(
      [{ title: "Gemi", w: 290 }, { title: "Kayıt", w: 80, right: true }, { title: "Tutar", w: 400, right: true }],
      (s?.ships ?? []).map((x) => [x.ship_name, String(x.record_count), fmtTotals(x.totals)]),
    );
    const docs = db.listDocuments({ company_id: company.id });
    d.heading("Alınan Ödemeler");
    const pays = db.listPayments({ company_id: company.id, ...range });
    if (pays.length) {
      d.table(
        [{ title: "Tarih", w: 70 }, { title: "Gemi", w: 120 }, { title: "Tutar", w: 100, right: true }, { title: "Not", w: 230 }, { title: "Belge", w: 250 }],
        pays.map((p) => [
          toDisplayDate(p.payment_date), p.ship_name ?? "–", fmtMoney(p.amount, p.currency), p.note,
          docs.filter((x) => x.payment_id === p.id).map((x) => x.title || x.filename).join(", ") || "–",
        ]),
      );
    } else d.kv("Kayıt", "Bu aralıkta ödeme yok.");
  }

  const skipped = await d.appendAttachments(attachments);
  const own = attachments.length ? d.ownPages : d.pdf.getPageCount();
  return { bytes: await d.finish(own), skipped };
}
