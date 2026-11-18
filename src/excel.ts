import { inflateRawSync } from "node:zlib";
import { AppDatabase, Currency, RecordInput, RecordItem, roundMoney, toDisplayDate } from "./db.ts";

const CURRENCY_SYMBOLS: Record<Currency, string> = {
  TRY: "₺",
  USD: "$",
  EUR: "€",
};

export function formatMoneyCell(amount: number, currency: Currency): string {
  if (!amount || amount === 0) return "X";
  const sym = CURRENCY_SYMBOLS[currency] || "₺";
  const formatted = new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(amount);
  return `${formatted} ${sym}`;
}

export function formatTotalSummaryCell(records: RecordItem[]): string {
  const totals: Record<Currency, number> = { TRY: 0, USD: 0, EUR: 0 };
  for (const r of records) {
    const c = r.currency || "TRY";
    totals[c] = roundMoney(totals[c] + r.total_fee);
  }
  const parts: string[] = [];
  for (const c of ["TRY", "USD", "EUR"] as Currency[]) {
    if (totals[c] > 0) {
      const sym = CURRENCY_SYMBOLS[c];
      const formatted = new Intl.NumberFormat("tr-TR", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(totals[c]);
      parts.push(`${sym}${formatted}`);
    }
  }
  return parts.length > 0 ? parts.join(" | ") : "₺0,00";
}

export function parseMoneyAndCurrency(
  raw: unknown,
  fallbackCurrency: Currency = "TRY"
): { value: number; currency: Currency } {
  if (raw === null || raw === undefined) {
    return { value: 0, currency: fallbackCurrency };
  }
  if (typeof raw === "number") {
    return { value: roundMoney(raw), currency: fallbackCurrency };
  }
  const str = String(raw).trim();
  if (!str || str.toLowerCase() === "x" || str === "-") {
    return { value: 0, currency: fallbackCurrency };
  }

  let currency: Currency = fallbackCurrency;
  if (str.includes("$") || /usd/i.test(str)) currency = "USD";
  else if (str.includes("€") || /eur/i.test(str)) currency = "EUR";
  else if (str.includes("₺") || /tl|try/i.test(str)) currency = "TRY";

  const cleaned = str.replace(/[^\d.,-]/g, "");
  if (!cleaned) return { value: 0, currency };

  let normalized = cleaned;
  const lastComma = cleaned.lastIndexOf(",");
  const lastDot = cleaned.lastIndexOf(".");

  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      normalized = cleaned.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (lastComma > -1) {
    const parts = cleaned.split(",");
    if (parts[parts.length - 1].length <= 2) {
      normalized = cleaned.replace(",", ".");
    } else {
      normalized = cleaned.replace(/,/g, "");
    }
  } else if (lastDot > -1) {
    const parts = cleaned.split(".");
    if (parts.length > 2 || parts[parts.length - 1].length === 3) {
      normalized = cleaned.replace(/\./g, "");
    }
  }

  const num = Number(normalized);
  return {
    value: Number.isFinite(num) ? roundMoney(num) : 0,
    currency,
  };
}

// --- Native Zero-Dependency ZIP & XLSX Reader/Writer ---

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipArchive(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, 0x04034b50, true); // Local file header signature
    lv.setUint16(4, 20, true);         // Version needed
    lv.setUint16(6, 0x0800, true);     // UTF-8 flag
    lv.setUint16(8, 0, true);          // Compression: 0 (STORE)
    lv.setUint16(10, 0, true);         // Mod time
    lv.setUint16(12, 0, true);         // Mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, file.data);

    const centralHeader = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, 0x02014b50, true); // Central directory signature
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);         // STORE
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    centralHeader.set(nameBytes, 46);

    centralParts.push(centralHeader);
    offset += localHeader.length + size;
  }

  let centralSize = 0;
  for (const cp of centralParts) centralSize += cp.length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);

  const totalSize = offset + centralSize + 22;
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const p of localParts) {
    out.set(p, pos);
    pos += p.length;
  }
  for (const p of centralParts) {
    out.set(p, pos);
    pos += p.length;
  }
  out.set(eocd, pos);
  return out;
}

function readZipArchive(buffer: Uint8Array): Map<string, string> {
  const entries = new Map<string, string>();
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const dec = new TextDecoder("utf-8");

  // Locate End of Central Directory (EOCD)
  let eocdPos = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos === -1) return entries;

  const totalEntries = dv.getUint16(eocdPos + 10, true);
  let dirOffset = dv.getUint32(eocdPos + 16, true);

  for (let i = 0; i < totalEntries; i++) {
    if (dirOffset + 46 > buffer.length || dv.getUint32(dirOffset, true) !== 0x02014b50) break;
    const method = dv.getUint16(dirOffset + 10, true);
    const compSize = dv.getUint32(dirOffset + 20, true);
    const nameLen = dv.getUint16(dirOffset + 28, true);
    const extraLen = dv.getUint16(dirOffset + 30, true);
    const commentLen = dv.getUint16(dirOffset + 32, true);
    const localOffset = dv.getUint32(dirOffset + 42, true);

    const fileName = dec.decode(buffer.subarray(dirOffset + 46, dirOffset + 46 + nameLen));
    dirOffset += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > buffer.length) continue;
    const lNameLen = dv.getUint16(localOffset + 26, true);
    const lExtraLen = dv.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const rawSlice = buffer.subarray(dataStart, dataStart + compSize);

    if (method === 0) {
      entries.set(fileName, dec.decode(rawSlice));
    } else if (method === 8) {
      const inflated = inflateRawSync(rawSlice);
      entries.set(fileName, dec.decode(inflated));
    }
  }

  return entries;
}

function xmlEscape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlUnescape(s: string): string {
  return String(s ?? "")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function colIndexToLetter(colIdx: number): string {
  let n = colIdx + 1;
  let str = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    str = String.fromCharCode(65 + rem) + str;
    n = Math.floor((n - 1) / 26);
  }
  return str;
}

function colLettersToIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

interface SheetSpec {
  name: string;
  records: RecordItem[];
}

function buildStyledWorkbookXlsx(sheets: SheetSpec[]): Uint8Array {
  const enc = new TextEncoder();
  const safeSheets = sheets.map((s, idx) => ({
    name: (s.name || `GEMI_${idx + 1}`).replace(/[\\/?*[\]:]/g, "").slice(0, 31) || `GEMI_${idx + 1}`,
    records: s.records,
  }));

  // 1. [Content_Types].xml
  const sheetOverrides = safeSheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join("");

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheetOverrides}
</Types>`;

  // 2. _rels/.rels
  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  // 3. xl/workbook.xml
  const wbSheetsXml = safeSheets
    .map(
      (s, i) =>
        `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    )
    .join("");

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${wbSheetsXml}</sheets>
</workbook>`;

  // 4. xl/_rels/workbook.xml.rels
  const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${safeSheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join("")}
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  // 5. xl/styles.xml (Exact matching colors from screenshot: Gray header, Teal/White rows, Red ship name, Bold TOTAL)
  // Style indices (cellXfs):
  // 0 = Default
  // 1 = Header (Gray #807E7C, Bold, Border, Center)
  // 2 = Odd Row Normal (Teal #348AA2, Bold, Border, Center)
  // 3 = Even Row Normal (White #FFFFFF, Bold, Border, Center)
  // 4 = Odd Row Ship Name (Teal #348AA2, Red Text #C00000, Bold, Border, Center)
  // 5 = Even Row Ship Name (White #FFFFFF, Red Text #D91B1B, Bold, Border, Center)
  // 6 = Total Row (Teal #348AA2, 16pt Bold, Border, Center)
  const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="4">
    <font><sz val="10"/><name val="Calibri"/></font>
    <font><b/><sz val="10"/><color rgb="FF000000"/><name val="Calibri"/></font>
    <font><b/><sz val="10"/><color rgb="FFD91B1B"/><name val="Calibri"/></font>
    <font><b/><sz val="15"/><color rgb="FF091E26"/><name val="Calibri"/></font>
  </fonts>
  <fills count="5">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF807E7C"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF348AA2"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></patternFill></fill>
  </fills>
  <borders count="2">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FF1E293B"/></left>
      <right style="thin"><color rgb="FF1E293B"/></right>
      <top style="thin"><color rgb="FF1E293B"/></top>
      <bottom style="thin"><color rgb="FF1E293B"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="7">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`;

  const files: { name: string; data: Uint8Array }[] = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypesXml) },
    { name: "_rels/.rels", data: enc.encode(rootRelsXml) },
    { name: "xl/workbook.xml", data: enc.encode(workbookXml) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRelsXml) },
    { name: "xl/styles.xml", data: enc.encode(stylesXml) },
  ];

  const headers = [
    "TARİH",
    "KALKIŞ",
    "VARIŞ",
    "GEMİ ADI",
    "KİŞİ SAYISI",
    "TRANSFER ÜCRETİ",
    "OTEL",
    "YEMEK",
    "TOTAL",
    "ODA DETAYI",
  ];

  safeSheets.forEach((sheet, sIdx) => {
    const rowXmlParts: string[] = [];

    // Row 1: Headers
    const headerCells = headers
      .map((h, cIdx) => {
        const ref = `${colIndexToLetter(cIdx)}1`;
        return `<c r="${ref}" s="1" t="inlineStr"><is><t>${xmlEscape(h)}</t></is></c>`;
      })
      .join("");
    rowXmlParts.push(`<row r="1" ht="24" customHeight="1">${headerCells}</row>`);

    // Data Rows
    sheet.records.forEach((r, idx) => {
      const rowNum = idx + 2;
      const isOdd = idx % 2 === 0; // 1st data row is Teal (s=2), 2nd is White (s=3)
      const normalStyle = isOdd ? 2 : 3;
      const shipStyle = isOdd ? 4 : 5;

      const vals = [
        r.tx_date || "",
        r.departure || "",
        r.arrival || "",
        r.ship_name || sheet.name,
        r.passenger_info || "",
        formatMoneyCell(r.transfer_fee, r.currency),
        formatMoneyCell(r.hotel_fee, r.currency),
        formatMoneyCell(r.meal_fee, r.currency),
        formatMoneyCell(r.total_fee, r.currency),
        r.description || "",
      ];

      const cells = vals
        .map((v, cIdx) => {
          const ref = `${colIndexToLetter(cIdx)}${rowNum}`;
          const st = cIdx === 3 ? shipStyle : normalStyle;
          return `<c r="${ref}" s="${st}" t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`;
        })
        .join("");

      rowXmlParts.push(`<row r="${rowNum}" ht="32" customHeight="1">${cells}</row>`);
    });

    // Final TOTAL Row
    const totalRowNum = sheet.records.length + 2;
    const totalSummaryStr = formatTotalSummaryCell(sheet.records);
    const totalRowValues = ["TOTAL", "", "", "", "", totalSummaryStr, "", "", "", ""];
    const totalCells = totalRowValues
      .map((v, cIdx) => {
        const ref = `${colIndexToLetter(cIdx)}${totalRowNum}`;
        return `<c r="${ref}" s="6" t="inlineStr"><is><t>${xmlEscape(v)}</t></is></c>`;
      })
      .join("");
    rowXmlParts.push(`<row r="${totalRowNum}" ht="38" customHeight="1">${totalCells}</row>`);

    const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols>
    <col min="1" max="1" width="15" customWidth="1"/>
    <col min="2" max="3" width="18" customWidth="1"/>
    <col min="4" max="4" width="18" customWidth="1"/>
    <col min="5" max="5" width="22" customWidth="1"/>
    <col min="6" max="9" width="18" customWidth="1"/>
    <col min="10" max="10" width="24" customWidth="1"/>
  </cols>
  <sheetData>${rowXmlParts.join("")}</sheetData>
  <mergeCells count="2">
    <mergeCell ref="A${totalRowNum}:E${totalRowNum}"/>
    <mergeCell ref="F${totalRowNum}:I${totalRowNum}"/>
  </mergeCells>
</worksheet>`;

    files.push({
      name: `xl/worksheets/sheet${sIdx + 1}.xml`,
      data: enc.encode(sheetXml),
    });
  });

  return createZipArchive(files);
}

export function exportShipRecordsToXlsx(
  shipName: string,
  records: RecordItem[]
): Uint8Array {
  return buildStyledWorkbookXlsx([{ name: shipName, records }]);
}

export function exportCompanyToXlsx(
  db: AppDatabase,
  companyId: number,
  filters?: { start_date?: string; end_date?: string }
): Uint8Array {
  const ships = db.listShips(companyId);
  if (ships.length === 0) {
    return buildStyledWorkbookXlsx([{ name: "BOS", records: [] }]);
  }
  const sheetSpecs: SheetSpec[] = ships.map((ship) => ({
    name: ship.name,
    records: db.listRecords({
      ship_id: ship.id,
      start_date: filters?.start_date,
      end_date: filters?.end_date,
    }),
  }));
  return buildStyledWorkbookXlsx(sheetSpecs);
}

/**
 * Extracts 2D rows from an Excel worksheet XML string (handles sharedStrings `t="s"`, inlineStr `t="inlineStr"`, and raw `<v>`).
 */
function parseWorksheetXml(sheetXml: string, sharedStrings: string[]): string[][] {
  const rows: string[][] = [];
  const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
    const rowContent = rowMatch[1];
    const rowCells: string[] = [];
    const cellRegex = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    let nextCol = 0;

    while ((cellMatch = cellRegex.exec(rowContent)) !== null) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2] || "";

      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      const colIdx = refMatch ? colLettersToIndex(refMatch[1]) : nextCol;
      nextCol = colIdx + 1;

      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const cellType = typeMatch ? typeMatch[1] : "";

      let textVal = "";
      if (cellType === "inlineStr") {
        const tMatches = inner.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || [];
        textVal = tMatches
          .map((t) => xmlUnescape(t.replace(/<\/?t(?:\s[^>]*)?>/g, "")))
          .join("");
      } else if (cellType === "s") {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        const sIdx = vMatch ? Number(vMatch[1]) : -1;
        textVal = sIdx >= 0 && sIdx < sharedStrings.length ? sharedStrings[sIdx] : "";
      } else {
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        textVal = vMatch ? xmlUnescape(vMatch[1]) : "";
      }

      while (rowCells.length <= colIdx) rowCells.push("");
      rowCells[colIdx] = textVal;
    }

    rows.push(rowCells);
  }

  return rows;
}

export function importRecordsFromXlsx(
  db: AppDatabase,
  companyId: number,
  defaultShipId: number | null,
  buffer: Uint8Array
): { importedCount: number; shipsTouched: string[] } {
  const zipEntries = readZipArchive(buffer);
  let importedCount = 0;
  const shipsTouchedSet = new Set<string>();

  // Parse sharedStrings.xml if present
  const sharedStrings: string[] = [];
  const sstXml = zipEntries.get("xl/sharedStrings.xml");
  if (sstXml) {
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let siMatch: RegExpExecArray | null;
    while ((siMatch = siRegex.exec(sstXml)) !== null) {
      const tMatches = siMatch[1].match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || [];
      const combined = tMatches
        .map((t) => xmlUnescape(t.replace(/<\/?t(?:\s[^>]*)?>/g, "")))
        .join("");
      sharedStrings.push(combined);
    }
  }

  // Map sheet names from workbook.xml
  const sheetNames: string[] = [];
  const wbXml = zipEntries.get("xl/workbook.xml") || "";
  const sheetTagRegex = /<sheet\b[^>]*\bname="([^"]+)"[^>]*\/?>/g;
  let shMatch: RegExpExecArray | null;
  while ((shMatch = sheetTagRegex.exec(wbXml)) !== null) {
    sheetNames.push(xmlUnescape(shMatch[1]));
  }

  const worksheetKeys = Array.from(zipEntries.keys())
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort();

  worksheetKeys.forEach((wsKey, wsIdx) => {
    const sheetXml = zipEntries.get(wsKey)!;
    const sheetName = sheetNames[wsIdx] || `GEMİ ${wsIdx + 1}`;
    const rows = parseWorksheetXml(sheetXml, sharedStrings);
    if (rows.length < 2) return;

    let headerIdx = 0;
    for (let i = 0; i < Math.min(rows.length, 5); i++) {
      const joined = rows[i].map((c) => String(c).toUpperCase()).join("|");
      if (
        joined.includes("TARİH") ||
        joined.includes("TARIH") ||
        joined.includes("TRANSFER") ||
        joined.includes("TOTAL")
      ) {
        headerIdx = i;
        break;
      }
    }

    for (let rIdx = headerIdx + 1; rIdx < rows.length; rIdx++) {
      const row = rows[rIdx];
      if (!row || row.length === 0) continue;

      const col0 = String(row[0] ?? "").trim();
      if (col0.toUpperCase() === "TOTAL" || col0.toUpperCase() === "TOPLAM") {
        continue;
      }

      const tx_date = toDisplayDate(col0);
      const departure = String(row[1] ?? "").trim();
      const arrival = String(row[2] ?? "").trim();
      const rowShipName = String(row[3] ?? "").trim().toUpperCase();
      const passenger_info = String(row[4] ?? "").trim();
      const rawTransfer = row[5];
      const rawHotel = row[6];
      const rawMeal = row[7];
      const rawTotal = row[8];
      const description = String(row[9] ?? "").trim();

      const pTransfer = parseMoneyAndCurrency(rawTransfer, "TRY");
      const pHotel = parseMoneyAndCurrency(rawHotel, pTransfer.currency);
      const pMeal = parseMoneyAndCurrency(rawMeal, pHotel.currency);
      const pTotal = parseMoneyAndCurrency(rawTotal, pMeal.currency);

      const currency = pTotal.currency || pTransfer.currency || pHotel.currency || "TRY";
      const sumParts = roundMoney(pTransfer.value + pHotel.value + pMeal.value);
      let extra_fee = 0;
      if (pTotal.value > sumParts) {
        extra_fee = roundMoney(pTotal.value - sumParts);
      }

      if (
        !tx_date &&
        !departure &&
        !arrival &&
        !passenger_info &&
        !description &&
        sumParts === 0 &&
        extra_fee === 0
      ) {
        continue;
      }

      let targetShipId = defaultShipId;
      if (rowShipName) {
        const existingShips = db.listShips(companyId);
        const match = existingShips.find((s) => s.name.toUpperCase() === rowShipName);
        if (match) {
          targetShipId = match.id;
          shipsTouchedSet.add(match.name);
        } else {
          const created = db.createShip(companyId, rowShipName);
          targetShipId = created.id;
          shipsTouchedSet.add(created.name);
        }
      } else if (targetShipId) {
        const s = db.getShip(targetShipId);
        if (s) shipsTouchedSet.add(s.name);
      } else {
        const fallbackName = sheetName.trim().toUpperCase() || "GEMİ 1";
        const existingShips = db.listShips(companyId);
        const match = existingShips.find((s) => s.name.toUpperCase() === fallbackName);
        const ship = match ?? db.createShip(companyId, fallbackName);
        targetShipId = ship.id;
        shipsTouchedSet.add(ship.name);
      }

      const recInput: RecordInput = {
        ship_id: targetShipId!,
        tx_date,
        departure,
        arrival,
        passenger_info,
        transfer_fee: pTransfer.value,
        hotel_fee: pHotel.value,
        meal_fee: pMeal.value,
        extra_fee,
        currency,
        description,
      };

      db.createRecord(recInput);
      importedCount++;
    }
  });

  return {
    importedCount,
    shipsTouched: Array.from(shipsTouchedSet),
  };
}
