import { DatabaseSync } from "node:sqlite";

export type Currency = "TRY" | "USD" | "EUR";

export interface CurrencyTotals {
  TRY: number;
  USD: number;
  EUR: number;
}

export interface Company {
  id: number;
  name: string;
  contact_info: string;
  created_at: string;
}

export interface Ship {
  id: number;
  company_id: number;
  company_name?: string;
  name: string;
  created_at: string;
}

export interface RecordItem {
  id: number;
  ship_id: number;
  ship_name?: string;
  company_id?: number;
  company_name?: string;
  tx_date: string;
  effective_date: string;
  departure: string;
  arrival: string;
  passenger_info: string;
  transfer_fee: number;
  hotel_fee: number;
  meal_fee: number;
  igafi_fee: number;
  vize_fee: number;
  extra_fee: number;
  total_fee: number;
  currency: Currency;
  description: string;
  sort_order: number;
  created_at: string;
}

export interface RecordInput {
  ship_id: number;
  tx_date?: string;
  departure?: string;
  arrival?: string;
  passenger_info?: string;
  transfer_fee?: number;
  hotel_fee?: number;
  meal_fee?: number;
  igafi_fee?: number;
  vize_fee?: number;
  extra_fee?: number;
  currency?: Currency;
  description?: string;
  sort_order?: number;
}

export interface PaymentItem {
  id: number;
  company_id: number;
  company_name?: string;
  ship_id: number | null;
  ship_name?: string | null;
  payment_date: string;
  amount: number;
  currency: Currency;
  note: string;
  created_at: string;
}

export type DocumentKind = "dekont" | "fatura" | "diger";

export interface DocumentItem {
  id: number;
  company_id: number;
  payment_id: number | null;
  record_id: number | null;
  kind: DocumentKind;
  filename: string;
  mime: string;
  size: number;
  created_at: string;
}

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

// Dosya türü, istemcinin bildirdiği mime'a değil gerçek içeriğe (magic bytes) göre belirlenir.
export function sniffDocumentMime(b: Uint8Array): string | null {
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  return null;
}

export interface PaymentInput {
  company_id: number;
  ship_id?: number | null;
  payment_date: string;
  amount: number;
  currency: Currency;
  note?: string;
}

export interface ShipSummary {
  ship_id: number;
  ship_name: string;
  company_id: number;
  record_count: number;
  totals: CurrencyTotals;
}

export interface CompanySummary {
  company_id: number;
  company_name: string;
  contact_info: string;
  ships: ShipSummary[];
  billed: CurrencyTotals;
  paid: CurrencyTotals;
  remaining: CurrencyTotals;
}

export interface OverallSummary {
  companies: CompanySummary[];
  overall_billed: CurrencyTotals;
  overall_paid: CurrencyTotals;
  overall_remaining: CurrencyTotals;
}

export function emptyTotals(): CurrencyTotals {
  return { TRY: 0, USD: 0, EUR: 0 };
}

export function roundMoney(val: number): number {
  return Math.round((Number(val) || 0) * 100) / 100;
}

/**
 * Normalizes a date string ("25.10.2026" or "2026-10-25") to ISO "YYYY-MM-DD" for filtering,
 * while keeping empty strings empty.
 */
export function toIsoDate(raw: string | undefined | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const dotMatch = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dotMatch) {
    const day = dotMatch[1].padStart(2, "0");
    const month = dotMatch[2].padStart(2, "0");
    const year = dotMatch[3];
    return `${year}-${month}-${day}`;
  }
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  }
  return s;
}

/**
 * Formats a date string to display format "DD.MM.YYYY" (matches Excel style).
 */
export function toDisplayDate(raw: string | undefined | null): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  const isoMatch = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    return `${isoMatch[3]}.${isoMatch[2]}.${isoMatch[1]}`;
  }
  const dotMatch = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dotMatch) {
    return `${dotMatch[1].padStart(2, "0")}.${dotMatch[2].padStart(2, "0")}.${dotMatch[3]}`;
  }
  return s;
}

export class AppDatabase {
  public db: DatabaseSync;

  constructor(dbPath = "veriler.db") {
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        contact_info TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS ships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
        UNIQUE(company_id, name)
      );

      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ship_id INTEGER NOT NULL,
        tx_date TEXT NOT NULL DEFAULT '',
        effective_date TEXT NOT NULL DEFAULT '',
        departure TEXT NOT NULL DEFAULT '',
        arrival TEXT NOT NULL DEFAULT '',
        passenger_info TEXT NOT NULL DEFAULT '',
        transfer_fee REAL NOT NULL DEFAULT 0,
        hotel_fee REAL NOT NULL DEFAULT 0,
        meal_fee REAL NOT NULL DEFAULT 0,
        igafi_fee REAL NOT NULL DEFAULT 0,
        vize_fee REAL NOT NULL DEFAULT 0,
        extra_fee REAL NOT NULL DEFAULT 0,
        total_fee REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'TRY',
        description TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (ship_id) REFERENCES ships(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        ship_id INTEGER,
        payment_date TEXT NOT NULL,
        amount REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'TRY',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
        FOREIGN KEY (ship_id) REFERENCES ships(id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        payment_id INTEGER,
        record_id INTEGER,
        kind TEXT NOT NULL DEFAULT 'diger',
        filename TEXT NOT NULL,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        data BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE,
        FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE,
        FOREIGN KEY (record_id) REFERENCES records(id) ON DELETE CASCADE
      );
    `);

    // Eski veritabanları için: sonradan eklenen sütunlar
    const cols = (this.db.prepare("PRAGMA table_info(records)").all() as unknown as { name: string }[]).map((c) => c.name);
    for (const col of ["igafi_fee", "vize_fee"]) {
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE records ADD COLUMN ${col} REAL NOT NULL DEFAULT 0`);
    }
  }

  close() {
    this.db.close();
  }

  // --- Companies ---
  listCompanies(): Company[] {
    const stmt = this.db.prepare(
      "SELECT id, name, contact_info, created_at FROM companies ORDER BY name COLLATE NOCASE ASC"
    );
    return stmt.all() as unknown as Company[];
  }

  createCompany(name: string, contact_info = ""): Company {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Firma adı boş olamaz.");
    const stmt = this.db.prepare(
      "INSERT INTO companies (name, contact_info) VALUES (?, ?) RETURNING id, name, contact_info, created_at"
    );
    return stmt.get(cleanName, contact_info.trim()) as unknown as Company;
  }

  updateCompany(id: number, name: string, contact_info = ""): Company {
    const cleanName = name.trim();
    if (!cleanName) throw new Error("Firma adı boş olamaz.");
    const stmt = this.db.prepare(
      "UPDATE companies SET name = ?, contact_info = ? WHERE id = ? RETURNING id, name, contact_info, created_at"
    );
    const res = stmt.get(cleanName, contact_info.trim(), id) as unknown as Company | undefined;
    if (!res) throw new Error("Firma bulunamadı.");
    return res;
  }

  deleteCompany(id: number): void {
    this.db.prepare("DELETE FROM companies WHERE id = ?").run(id);
  }

  // --- Ships ---
  listShips(companyId?: number): Ship[] {
    if (companyId) {
      const stmt = this.db.prepare(`
        SELECT s.id, s.company_id, c.name as company_name, s.name, s.created_at
        FROM ships s
        JOIN companies c ON c.id = s.company_id
        WHERE s.company_id = ?
        ORDER BY s.name COLLATE NOCASE ASC
      `);
      return stmt.all(companyId) as unknown as Ship[];
    }
    const stmt = this.db.prepare(`
      SELECT s.id, s.company_id, c.name as company_name, s.name, s.created_at
      FROM ships s
      JOIN companies c ON c.id = s.company_id
      ORDER BY c.name COLLATE NOCASE ASC, s.name COLLATE NOCASE ASC
    `);
    return stmt.all() as unknown as Ship[];
  }

  getShip(id: number): Ship | undefined {
    const stmt = this.db.prepare(`
      SELECT s.id, s.company_id, c.name as company_name, s.name, s.created_at
      FROM ships s
      JOIN companies c ON c.id = s.company_id
      WHERE s.id = ?
    `);
    return stmt.get(id) as unknown as Ship | undefined;
  }

  createShip(company_id: number, name: string): Ship {
    const cleanName = name.trim().toUpperCase();
    if (!cleanName) throw new Error("Gemi adı boş olamaz.");
    const stmt = this.db.prepare(
      "INSERT INTO ships (company_id, name) VALUES (?, ?) RETURNING id, company_id, name, created_at"
    );
    const inserted = stmt.get(company_id, cleanName) as unknown as Ship;
    return this.getShip(inserted.id)!;
  }

  updateShip(id: number, name: string): Ship {
    const cleanName = name.trim().toUpperCase();
    if (!cleanName) throw new Error("Gemi adı boş olamaz.");
    this.db.prepare("UPDATE ships SET name = ? WHERE id = ?").run(cleanName, id);
    const updated = this.getShip(id);
    if (!updated) throw new Error("Gemi bulunamadı.");
    return updated;
  }

  deleteShip(id: number): void {
    this.db.prepare("DELETE FROM ships WHERE id = ?").run(id);
  }

  // --- Records ---
  private recomputeEffectiveDates(ship_id: number) {
    const rows = this.db.prepare(
      "SELECT id, tx_date FROM records WHERE ship_id = ? ORDER BY sort_order ASC, id ASC"
    ).all(ship_id) as unknown as { id: number; tx_date: string }[];

    let lastIso = "";
    const updateStmt = this.db.prepare("UPDATE records SET effective_date = ? WHERE id = ?");
    for (const r of rows) {
      const iso = toIsoDate(r.tx_date);
      if (iso) {
        lastIso = iso;
      }
      updateStmt.run(lastIso, r.id);
    }
  }

  listRecords(filters?: {
    ship_id?: number;
    company_id?: number;
    start_date?: string;
    end_date?: string;
    currency?: Currency;
  }): RecordItem[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters?.ship_id) {
      conditions.push("r.ship_id = ?");
      params.push(filters.ship_id);
    }
    if (filters?.company_id) {
      conditions.push("s.company_id = ?");
      params.push(filters.company_id);
    }
    if (filters?.start_date) {
      conditions.push("r.effective_date >= ?");
      params.push(toIsoDate(filters.start_date));
    }
    if (filters?.end_date) {
      conditions.push("r.effective_date <= ?");
      params.push(toIsoDate(filters.end_date));
    }
    if (filters?.currency) {
      conditions.push("r.currency = ?");
      params.push(filters.currency);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const stmt = this.db.prepare(`
      SELECT
        r.id, r.ship_id, s.name as ship_name, s.company_id, c.name as company_name,
        r.tx_date, r.effective_date, r.departure, r.arrival, r.passenger_info,
        r.transfer_fee, r.hotel_fee, r.meal_fee, r.igafi_fee, r.vize_fee, r.extra_fee, r.total_fee,
        r.currency, r.description, r.sort_order, r.created_at
      FROM records r
      JOIN ships s ON s.id = r.ship_id
      JOIN companies c ON c.id = s.company_id
      ${whereClause}
      ORDER BY r.sort_order ASC, r.id ASC
    `);
    return stmt.all(...params) as unknown as RecordItem[];
  }

  createRecord(input: RecordInput): RecordItem {
    const transfer = roundMoney(input.transfer_fee ?? 0);
    const hotel = roundMoney(input.hotel_fee ?? 0);
    const meal = roundMoney(input.meal_fee ?? 0);
    const igafi = roundMoney(input.igafi_fee ?? 0);
    const vize = roundMoney(input.vize_fee ?? 0);
    const extra = roundMoney(input.extra_fee ?? 0);
    const total = roundMoney(transfer + hotel + meal + igafi + vize + extra);
    const currency: Currency = input.currency && ["TRY", "USD", "EUR"].includes(input.currency)
      ? input.currency
      : "TRY";
    const tx_date = toDisplayDate(input.tx_date);

    let sortOrder = input.sort_order;
    if (sortOrder === undefined || sortOrder === null) {
      const maxRow = this.db.prepare(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 as next_order FROM records WHERE ship_id = ?"
      ).get(input.ship_id) as { next_order: number };
      sortOrder = maxRow.next_order;
    }

    const stmt = this.db.prepare(`
      INSERT INTO records (
        ship_id, tx_date, effective_date, departure, arrival, passenger_info,
        transfer_fee, hotel_fee, meal_fee, igafi_fee, vize_fee, extra_fee, total_fee,
        currency, description, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const inserted = stmt.get(
      input.ship_id,
      tx_date,
      toIsoDate(tx_date),
      (input.departure ?? "").trim().toUpperCase(),
      (input.arrival ?? "").trim().toUpperCase(),
      (input.passenger_info ?? "").trim().toUpperCase(),
      transfer,
      hotel,
      meal,
      igafi,
      vize,
      extra,
      total,
      currency,
      (input.description ?? "").trim(),
      sortOrder
    ) as { id: number };

    this.recomputeEffectiveDates(input.ship_id);
    const rows = this.listRecords({ ship_id: input.ship_id });
    return rows.find((r) => r.id === inserted.id)!;
  }

  updateRecord(id: number, input: Partial<RecordInput>): RecordItem {
    const existing = this.db.prepare("SELECT * FROM records WHERE id = ?").get(id) as unknown as RecordItem | undefined;
    if (!existing) throw new Error("Kayıt bulunamadı.");

    const ship_id = input.ship_id ?? existing.ship_id;
    const tx_date = input.tx_date !== undefined ? toDisplayDate(input.tx_date) : existing.tx_date;
    const departure = input.departure !== undefined ? input.departure.trim().toUpperCase() : existing.departure;
    const arrival = input.arrival !== undefined ? input.arrival.trim().toUpperCase() : existing.arrival;
    const passenger_info = input.passenger_info !== undefined
      ? input.passenger_info.trim().toUpperCase()
      : existing.passenger_info;
    const transfer = roundMoney(input.transfer_fee !== undefined ? input.transfer_fee : existing.transfer_fee);
    const hotel = roundMoney(input.hotel_fee !== undefined ? input.hotel_fee : existing.hotel_fee);
    const meal = roundMoney(input.meal_fee !== undefined ? input.meal_fee : existing.meal_fee);
    const igafi = roundMoney(input.igafi_fee !== undefined ? input.igafi_fee : existing.igafi_fee);
    const vize = roundMoney(input.vize_fee !== undefined ? input.vize_fee : existing.vize_fee);
    const extra = roundMoney(input.extra_fee !== undefined ? input.extra_fee : existing.extra_fee);
    const total = roundMoney(transfer + hotel + meal + igafi + vize + extra);
    const currency: Currency = input.currency && ["TRY", "USD", "EUR"].includes(input.currency)
      ? input.currency
      : existing.currency;
    const description = input.description !== undefined
      ? input.description.trim()
      : existing.description;
    const sort_order = input.sort_order !== undefined ? input.sort_order : existing.sort_order;

    this.db.prepare(`
      UPDATE records SET
        ship_id = ?, tx_date = ?, effective_date = ?, departure = ?, arrival = ?,
        passenger_info = ?, transfer_fee = ?, hotel_fee = ?, meal_fee = ?,
        igafi_fee = ?, vize_fee = ?, extra_fee = ?, total_fee = ?, currency = ?, description = ?, sort_order = ?
      WHERE id = ?
    `).run(
      ship_id,
      tx_date,
      toIsoDate(tx_date),
      departure,
      arrival,
      passenger_info,
      transfer,
      hotel,
      meal,
      igafi,
      vize,
      extra,
      total,
      currency,
      description,
      sort_order,
      id
    );

    this.recomputeEffectiveDates(ship_id);
    const rows = this.listRecords({ ship_id });
    return rows.find((r) => r.id === id)!;
  }

  deleteRecord(id: number): void {
    const existing = this.db.prepare("SELECT ship_id FROM records WHERE id = ?").get(id) as { ship_id: number } | undefined;
    this.db.prepare("DELETE FROM records WHERE id = ?").run(id);
    if (existing) {
      this.recomputeEffectiveDates(existing.ship_id);
    }
  }

  // --- Payments (Girdi-Çıktı / Tahsilat) ---
  listPayments(filters?: { company_id?: number; ship_id?: number; start_date?: string; end_date?: string }): PaymentItem[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters?.company_id) {
      conditions.push("p.company_id = ?");
      params.push(filters.company_id);
    }
    if (filters?.ship_id) {
      conditions.push("p.ship_id = ?");
      params.push(filters.ship_id);
    }
    if (filters?.start_date) {
      conditions.push("p.payment_date >= ?");
      params.push(toIsoDate(filters.start_date));
    }
    if (filters?.end_date) {
      conditions.push("p.payment_date <= ?");
      params.push(toIsoDate(filters.end_date));
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const stmt = this.db.prepare(`
      SELECT
        p.id, p.company_id, c.name as company_name, p.ship_id, s.name as ship_name,
        p.payment_date, p.amount, p.currency, p.note, p.created_at
      FROM payments p
      JOIN companies c ON c.id = p.company_id
      LEFT JOIN ships s ON s.id = p.ship_id
      ${whereClause}
      ORDER BY p.payment_date DESC, p.id DESC
    `);
    return stmt.all(...params) as unknown as PaymentItem[];
  }

  createPayment(input: PaymentInput): PaymentItem {
    const amount = roundMoney(input.amount);
    if (amount <= 0) throw new Error("Ödeme tutarı 0'dan büyük olmalıdır.");
    const currency: Currency = input.currency && ["TRY", "USD", "EUR"].includes(input.currency)
      ? input.currency
      : "TRY";
    const payment_date = toIsoDate(input.payment_date) || new Date().toISOString().slice(0, 10);

    const stmt = this.db.prepare(`
      INSERT INTO payments (company_id, ship_id, payment_date, amount, currency, note)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const inserted = stmt.get(
      input.company_id,
      input.ship_id ?? null,
      payment_date,
      amount,
      currency,
      (input.note ?? "").trim()
    ) as { id: number };

    const all = this.listPayments({ company_id: input.company_id });
    return all.find((p) => p.id === inserted.id)!;
  }

  deletePayment(id: number): void {
    this.db.prepare("DELETE FROM payments WHERE id = ?").run(id);
  }

  // --- Documents (dekont / fatura) ---
  createDocument(input: {
    company_id: number;
    payment_id?: number | null;
    record_id?: number | null;
    kind?: string;
    filename: string;
    data: Uint8Array;
  }): DocumentItem {
    if (input.data.byteLength === 0) throw new Error("Dosya boş.");
    if (input.data.byteLength > MAX_DOCUMENT_BYTES) throw new Error("Dosya 15 MB'tan büyük olamaz.");
    const mime = sniffDocumentMime(input.data);
    if (!mime) throw new Error("Yalnızca PDF, JPG ve PNG yüklenebilir.");
    const kind: DocumentKind = input.kind === "dekont" || input.kind === "fatura" ? input.kind : "diger";
    const filename = (input.filename || "belge").replace(/[\\/\r\n"]/g, "_").slice(0, 200);
    const row = this.db.prepare(`
      INSERT INTO documents (company_id, payment_id, record_id, kind, filename, mime, size, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id, company_id, payment_id, record_id, kind, filename, mime, size, created_at
    `).get(
      input.company_id, input.payment_id ?? null, input.record_id ?? null,
      kind, filename, mime, input.data.byteLength, input.data
    );
    return row as unknown as DocumentItem;
  }

  listDocuments(filters?: { company_id?: number; payment_id?: number; record_id?: number }): DocumentItem[] {
    const cond: string[] = [];
    const params: number[] = [];
    if (filters?.company_id) { cond.push("company_id = ?"); params.push(filters.company_id); }
    if (filters?.payment_id) { cond.push("payment_id = ?"); params.push(filters.payment_id); }
    if (filters?.record_id) { cond.push("record_id = ?"); params.push(filters.record_id); }
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    return this.db.prepare(`
      SELECT id, company_id, payment_id, record_id, kind, filename, mime, size, created_at
      FROM documents ${where} ORDER BY id DESC
    `).all(...params) as unknown as DocumentItem[];
  }

  getDocumentData(id: number): { filename: string; mime: string; data: Uint8Array } | undefined {
    return this.db.prepare("SELECT filename, mime, data FROM documents WHERE id = ?").get(id) as
      | { filename: string; mime: string; data: Uint8Array }
      | undefined;
  }

  deleteDocument(id: number): void {
    this.db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  }

  // --- Summary & Aggregations (Ship, Company, Overall, Ledger) ---
  getSummary(filters?: { start_date?: string; end_date?: string }): OverallSummary {
    const companies = this.listCompanies();
    const ships = this.listShips();
    const records = this.listRecords({
      start_date: filters?.start_date,
      end_date: filters?.end_date,
    });
    const payments = this.listPayments({
      start_date: filters?.start_date,
      end_date: filters?.end_date,
    });

    const shipMap = new Map<number, ShipSummary>();
    for (const s of ships) {
      shipMap.set(s.id, {
        ship_id: s.id,
        ship_name: s.name,
        company_id: s.company_id,
        record_count: 0,
        totals: emptyTotals(),
      });
    }

    for (const r of records) {
      const sm = shipMap.get(r.ship_id);
      if (sm) {
        sm.record_count += 1;
        const curr = r.currency || "TRY";
        sm.totals[curr] = roundMoney(sm.totals[curr] + r.total_fee);
      }
    }

    const overall_billed = emptyTotals();
    const overall_paid = emptyTotals();
    const overall_remaining = emptyTotals();

    const companySummaries: CompanySummary[] = companies.map((c) => {
      const companyShips = ships
        .filter((s) => s.company_id === c.id)
        .map((s) => shipMap.get(s.id)!);

      const billed = emptyTotals();
      for (const cs of companyShips) {
        for (const curr of ["TRY", "USD", "EUR"] as Currency[]) {
          billed[curr] = roundMoney(billed[curr] + cs.totals[curr]);
        }
      }

      const paid = emptyTotals();
      for (const p of payments.filter((x) => x.company_id === c.id)) {
        const curr = p.currency || "TRY";
        paid[curr] = roundMoney(paid[curr] + p.amount);
      }

      const remaining: CurrencyTotals = {
        TRY: roundMoney(billed.TRY - paid.TRY),
        USD: roundMoney(billed.USD - paid.USD),
        EUR: roundMoney(billed.EUR - paid.EUR),
      };

      for (const curr of ["TRY", "USD", "EUR"] as Currency[]) {
        overall_billed[curr] = roundMoney(overall_billed[curr] + billed[curr]);
        overall_paid[curr] = roundMoney(overall_paid[curr] + paid[curr]);
        overall_remaining[curr] = roundMoney(overall_remaining[curr] + remaining[curr]);
      }

      return {
        company_id: c.id,
        company_name: c.name,
        contact_info: c.contact_info,
        ships: companyShips,
        billed,
        paid,
        remaining,
      };
    });

    return {
      companies: companySummaries,
      overall_billed,
      overall_paid,
      overall_remaining,
    };
  }

  // --- Autocomplete suggestions ---
  getAutocomplete(): {
    locations: string[];
    passengers: string[];
    descriptions: string[];
  } {
    const defaultLocations = ["IGA", "ZEYPORT", "SİRKECİ", "TASHAN", "FATİH", "EYLÜL - İGA", "EYLÜL BOT", "FATİH-İGA"];
    const defaultPassengers = ["2 KİŞİ TEKNİSYEN", "2 KİŞİ AYRILAN", "1 TEKNİSYEN", "1 KİŞİ", "3 KİŞİ"];
    const defaultDescriptions = ["TRANSFER", "AYAKBASTI", "GBT", "PERSONEL DEĞİŞİMİ", "1 TWIN ROOM", "1 SINGLE ROOM", "OTEL + TRANSFER"];

    const depRows = this.db.prepare("SELECT DISTINCT departure as val FROM records WHERE departure != ''").all() as { val: string }[];
    const arrRows = this.db.prepare("SELECT DISTINCT arrival as val FROM records WHERE arrival != ''").all() as { val: string }[];
    const pasRows = this.db.prepare("SELECT DISTINCT passenger_info as val FROM records WHERE passenger_info != ''").all() as { val: string }[];
    const descRows = this.db.prepare("SELECT DISTINCT description as val FROM records WHERE description != ''").all() as { val: string }[];

    const locations = Array.from(new Set([...defaultLocations, ...depRows.map((r) => r.val), ...arrRows.map((r) => r.val)]));
    const passengers = Array.from(new Set([...defaultPassengers, ...pasRows.map((r) => r.val)]));
    const descriptions = Array.from(new Set([...defaultDescriptions, ...descRows.map((r) => r.val)]));

    return { locations, passengers, descriptions };
  }
}
