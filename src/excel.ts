import { inflateRawSync } from "node:zlib";
import { AppDatabase, Currency, RecordInput, roundMoney, toDisplayDate } from "./db.ts";

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

export function createZipArchive(files: { name: string; data: Uint8Array }[]): Uint8Array {
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

function xmlUnescape(s: string): string {
  return String(s ?? "")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function colLettersToIndex(letters: string): number {
  let idx = 0;
  for (let i = 0; i < letters.length; i++) {
    idx = idx * 26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
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

    // Sütunlar başlıktan bulunur (Airport, eski adıyla İGAFİ); Airport/VİZE olmayan eski dosyalar eski sıralamayla okunur.
    const norm = (c: unknown) => String(c ?? "").toLocaleUpperCase("tr-TR").replace(/İ/g, "I");
    const heads = (rows[headerIdx] ?? []).map(norm);
    const findCol = (re: RegExp, fallback: number) => {
      const i = heads.findIndex((h) => re.test(h));
      return i >= 0 ? i : fallback;
    };
    const igafiCol = findCol(/IGAFI|AIRPORT/, -1);
    const vizeCol = findCol(/VIZE/, -1);
    const totalCol = findCol(/^TOTAL/, 8);
    const notesCol = findCol(/NOTLAR|ODA DETAY/, 9);

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
      const rawIgafi = igafiCol >= 0 ? row[igafiCol] : "";
      const rawVize = vizeCol >= 0 ? row[vizeCol] : "";
      const rawTotal = row[totalCol];
      const description = String(row[notesCol] ?? "").trim();

      const pTransfer = parseMoneyAndCurrency(rawTransfer, "TRY");
      const pHotel = parseMoneyAndCurrency(rawHotel, pTransfer.currency);
      const pMeal = parseMoneyAndCurrency(rawMeal, pHotel.currency);
      const pIgafi = parseMoneyAndCurrency(rawIgafi, pMeal.currency);
      const pVize = parseMoneyAndCurrency(rawVize, pIgafi.currency);
      const pTotal = parseMoneyAndCurrency(rawTotal, pVize.currency);

      const currency = pTotal.currency || pTransfer.currency || pHotel.currency || "TRY";
      const sumParts = roundMoney(pTransfer.value + pHotel.value + pMeal.value + pIgafi.value + pVize.value);
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
        igafi_fee: pIgafi.value,
        vize_fee: pVize.value,
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
