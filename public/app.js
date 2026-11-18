// Gemi Transfer Takip — arayüz mantığı

const CURRENCY_SYM = { TRY: "₺", USD: "$", EUR: "€" };
const CURRENCIES = ["TRY", "USD", "EUR"];
const SEL_KEY = "gtt.selection";

const state = {
  companies: [],
  ships: [],
  records: [],
  payments: [],
  documents: [],
  summary: null,
  activeCompanyId: null,
  activeShipId: null,
  activeView: "operations", // 'operations' | 'ledger'
  startDate: "",
  endDate: "",
  openCompanies: new Set(),
  pendingDoc: null,
};

const $ = (id) => document.getElementById(id);

// --- Biçimlendirme ---
function fmtNumber(val, decimals = 2) {
  return new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(val) || 0);
}

// Tablo hücresi: 0 ise soluk "–", değilse "4.000 ₺"
function fmtCell(val, currency = "TRY") {
  const num = Number(val) || 0;
  if (num === 0) return `<span class="zero">–</span>`;
  return `${fmtNumber(num, num % 1 !== 0 ? 2 : 0)} ${CURRENCY_SYM[currency] || "₺"}`;
}

function fmtExactMoney(val, currency = "TRY") {
  return `${CURRENCY_SYM[currency] || "₺"}${fmtNumber(val, 2)}`;
}

function pillsHtml(totals) {
  const pills = CURRENCIES.filter((c) => Number(totals?.[c] || 0) !== 0).map(
    (c) => `<span class="pill curr-${c}">${fmtExactMoney(totals[c], c)}</span>`,
  );
  return pills.length ? pills.join("") : `<span class="pill">₺0,00</span>`;
}

function isoToDisplay(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || "");
}

function toIsoInputDate(displayDate) {
  const s = (displayDate || "").trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Bildirim (toast) ---
let toastTimer;
function notify(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = isError ? "toast error" : "toast";
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 3000);
}

// --- API ---
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "İşlem sırasında hata oluştu.");
  return data;
}

function dateParams() {
  const p = new URLSearchParams();
  if (state.startDate) p.set("start_date", state.startDate);
  if (state.endDate) p.set("end_date", state.endDate);
  return p;
}

// Tarayıcı kendi başına indirir; dosya ve hata durumunu kullanıcıya göstermek için fetch kullanılır.
async function downloadPdf(path, fallbackName) {
  notify("PDF hazırlanıyor…");
  try {
    const q = dateParams().toString();
    const res = await fetch(`/api/pdf/${path}${q ? `?${q}` : ""}`);
    if (!res.ok) {
      let msg = "PDF oluşturulamadı.";
      try {
        msg = (await res.json()).error || msg;
      } catch { /* JSON değil */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    notify(`PDF indirildi: ${fallbackName}`);
  } catch (err) {
    notify(err.message, true);
  }
}

function pdfFor(kind, companyId = state.activeCompanyId) {
  const comp = state.companies.find((c) => c.id === companyId);
  const safe = (s) => String(s || "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  if (kind === "ship") {
    const ship = state.ships.find((s) => s.id === state.activeShipId);
    if (!ship) return notify("Önce bir gemi seçin.", true);
    return downloadPdf(`ship/${ship.id}`, `${safe(ship.name)}-detay.pdf`);
  }
  if (!comp) return notify("Önce bir firma seçin.", true);
  const suffix = kind === "company-financial" ? "mali-durum" : "detay";
  downloadPdf(`company/${comp.id}/${kind === "company-financial" ? "financial" : "detail"}`, `${safe(comp.name)}-${suffix}.pdf`);
}

// --- Seçimi hatırla ---
function saveSelection() {
  try {
    localStorage.setItem(SEL_KEY, JSON.stringify({ c: state.activeCompanyId, s: state.activeShipId }));
  } catch { /* depolama kapalı olabilir */ }
}
function loadSelection() {
  try {
    return JSON.parse(localStorage.getItem(SEL_KEY) || "{}");
  } catch {
    return {};
  }
}

// --- Veri yükleme ---
async function refreshAll() {
  const params = dateParams();
  const [companies, ships, summary, autocomplete] = await Promise.all([
    api("/api/companies"),
    api("/api/ships"),
    api(`/api/summary?${params.toString()}`),
    api("/api/autocomplete"),
  ]);
  state.companies = companies;
  state.ships = ships;
  state.summary = summary;

  const stored = loadSelection();
  const hasData = (cid) => summary.companies.find((c) => c.company_id === cid)?.ships.some((s) => s.record_count > 0);
  if (!companies.some((c) => c.id === state.activeCompanyId)) {
    state.activeCompanyId = companies.some((c) => c.id === stored.c)
      ? stored.c
      : (companies.find((c) => hasData(c.id)) ?? companies[0])?.id ?? null;
    state.activeShipId = stored.c === state.activeCompanyId ? stored.s : null;
  }

  const companyShips = ships.filter((s) => s.company_id === state.activeCompanyId);
  if (!companyShips.some((s) => s.id === state.activeShipId)) {
    const counts = summary.companies.find((c) => c.company_id === state.activeCompanyId)?.ships ?? [];
    const withRecords = companyShips.find((s) => counts.find((x) => x.ship_id === s.id)?.record_count > 0);
    state.activeShipId = (withRecords ?? companyShips[0])?.id ?? null;
  }
  saveSelection();

  if (state.activeShipId) {
    const rp = new URLSearchParams(params);
    rp.set("ship_id", String(state.activeShipId));
    state.records = await api(`/api/records?${rp.toString()}`);
  } else {
    state.records = [];
  }

  const payParams = new URLSearchParams(params);
  const filterComp = $("ledgerFilterCompany").value;
  if (filterComp) payParams.set("company_id", filterComp);
  state.payments = await api(`/api/payments?${payParams.toString()}`);
  state.documents = await api(`/api/documents${filterComp ? `?company_id=${filterComp}` : ""}`);

  for (const [id, list] of [["dlLocations", autocomplete.locations], ["dlPassengers", autocomplete.passengers]]) {
    $(id).innerHTML = (list || []).map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
  }
  renderAll();
}

// --- Çizim ---
function renderAll() {
  renderSelectors();
  renderTotals();
  renderOperations();
  renderLedger();
  $("filterSummary").textContent =
    state.startDate || state.endDate
      ? `Tarih aralığı: ${isoToDisplay(state.startDate) || "…"} – ${isoToDisplay(state.endDate) || "…"}`
      : "Tarih aralığı: tümü";
}

function renderSelectors() {
  $("selectCompany").innerHTML = state.companies
    .map((c) => `<option value="${c.id}" ${c.id === state.activeCompanyId ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
    .join("");

  const companyShips = state.ships.filter((s) => s.company_id === state.activeCompanyId);
  $("shipTabsList").innerHTML = companyShips.length
    ? companyShips
        .map((s) => `<button type="button" role="tab" class="ship-tab ${s.id === state.activeShipId ? "active" : ""}" data-ship-id="${s.id}">${escapeHtml(s.name)}</button>`)
        .join("")
    : `<span class="muted">Bu firmada gemi yok. "Gemi Ekle" ile ekleyin.</span>`;

  const ship = companyShips.find((s) => s.id === state.activeShipId);
  $("activeShipHeading").textContent = ship ? ship.name : "Gemi seçilmedi";
  $("activeRecordCount").textContent = `${state.records.length} kayıt`;
}

function renderTotals() {
  const comp = state.summary.companies.find((c) => c.company_id === state.activeCompanyId);
  const ship = comp?.ships.find((s) => s.ship_id === state.activeShipId);
  $("shipSummaryTitle").textContent = ship ? `Gemi (${ship.ship_name})` : "Gemi";
  $("shipSummaryValues").innerHTML = pillsHtml(ship?.totals);
  $("companySummaryTitle").textContent = comp ? `Firma (${comp.company_name})` : "Firma";
  $("companySummaryValues").innerHTML = pillsHtml(comp?.billed);
  $("overallSummaryValues").innerHTML = pillsHtml(state.summary.overall_billed);
}

function renderOperations() {
  const tbody = $("recordsTableBody");
  const cards = $("mobileCardsContainer");

  if (state.records.length === 0) {
    const msg = state.activeShipId
      ? "Bu gemide henüz kayıt yok. Aşağıdaki satırdan veya “Yeni İşlem” ile ekleyin."
      : "Önce bir firma ve gemi ekleyin.";
    tbody.innerHTML = `<tr class="empty-row"><td colspan="13">${msg}</td></tr>`;
    cards.innerHTML = `<div class="card muted">${msg}</div>`;
    $("tableFooterTotal").innerHTML = pillsHtml(null);
    return;
  }

  tbody.innerHTML = state.records
    .map((r) => {
      const c = r.currency;
      const date = r.tx_date || `<span class="zero">${isoToDisplay(r.effective_date)}</span>`;
      return `<tr>
        <td>${date}</td>
        <td>${escapeHtml(r.departure)}</td>
        <td>${escapeHtml(r.arrival)}</td>
        <td>${escapeHtml(r.passenger_info)}</td>
        <td class="num">${fmtCell(r.transfer_fee, c)}</td>
        <td class="num">${fmtCell(r.hotel_fee, c)}</td>
        <td class="num">${fmtCell(r.meal_fee, c)}</td>
        <td class="num">${fmtCell(r.igafi_fee, c)}</td>
        <td class="num">${fmtCell(r.vize_fee, c)}</td>
        <td class="num">${fmtCell(r.extra_fee, c)}</td>
        <td class="num total">${fmtCell(r.total_fee, c)}</td>
        <td class="notes">${escapeHtml(r.description)}</td>
        <td><div class="row-actions">
          <button type="button" class="btn btn-sm btn-quiet" data-edit-record="${r.id}">Düzenle</button>
          <button type="button" class="btn btn-sm btn-quiet btn-danger" data-delete-record="${r.id}">Sil</button>
        </div></td>
      </tr>`;
    })
    .join("");

  const totals = { TRY: 0, USD: 0, EUR: 0 };
  for (const r of state.records) totals[r.currency] = (totals[r.currency] || 0) + Number(r.total_fee || 0);
  $("tableFooterTotal").innerHTML = pillsHtml(totals);

  cards.innerHTML = state.records
    .map((r) => {
      const c = r.currency;
      const fees = [
        ["Transfer", r.transfer_fee],
        ["Otel", r.hotel_fee],
        ["Yemek", r.meal_fee],
        ["İGAFİ", r.igafi_fee],
        ["Vize", r.vize_fee],
        ["Ek", r.extra_fee],
      ]
        .filter(([, v]) => v > 0)
        .map(([k, v]) => `<span>${k}: ${fmtCell(v, c)}</span>`)
        .join("");
      const route = r.departure || r.arrival ? `${escapeHtml(r.departure || "–")} → ${escapeHtml(r.arrival || "–")}` : "";
      return `<div class="card">
        <div class="card-top">
          <span class="card-date">${escapeHtml(r.tx_date || isoToDisplay(r.effective_date) || "Önceki satıra bağlı")}</span>
          <span class="card-total">${fmtCell(r.total_fee, c)}</span>
        </div>
        ${route ? `<div class="card-route">${route}</div>` : ""}
        ${r.passenger_info ? `<div class="card-meta">${escapeHtml(r.passenger_info)}</div>` : ""}
        ${fees ? `<div class="card-fees">${fees}</div>` : ""}
        ${r.description ? `<div class="card-notes">${escapeHtml(r.description)}</div>` : ""}
        <div class="card-actions">
          <button type="button" class="btn btn-sm" data-edit-record="${r.id}">Düzenle</button>
          <button type="button" class="btn btn-sm btn-danger" data-delete-record="${r.id}">Sil</button>
        </div>
      </div>`;
    })
    .join("");
}

function docLinkHtml(d) {
  return `<span class="doc-link"><a href="/api/documents/${d.id}" target="_blank" rel="noopener">${escapeHtml(d.filename)}</a>
    <button type="button" class="btn btn-sm btn-quiet" data-delete-doc="${d.id}" aria-label="${escapeHtml(d.filename)} belgesini sil">Sil</button></span>`;
}

function renderLedger() {
  const s = state.summary;
  $("ledgerOverallBilled").innerHTML = pillsHtml(s.overall_billed);
  $("ledgerOverallPaid").innerHTML = pillsHtml(s.overall_paid);
  $("ledgerOverallRemaining").innerHTML = pillsHtml(s.overall_remaining);

  const filter = $("ledgerFilterCompany");
  const current = filter.value;
  filter.innerHTML =
    `<option value="">Tüm firmalar</option>` +
    state.companies.map((c) => `<option value="${c.id}" ${String(c.id) === current ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");

  $("ledgerCompaniesContainer").innerHTML = s.companies.length
    ? s.companies
        .map((comp) => {
          const open = state.openCompanies.has(comp.company_id) || s.companies.length === 1;
          const ships = comp.ships.length
            ? comp.ships
                .map((sh) => `<div class="ship-line">
                  <button type="button" data-jump-company="${comp.company_id}" data-jump-ship="${sh.ship_id}">${escapeHtml(sh.ship_name)}</button>
                  <span>${sh.record_count} işlem · ${pillsHtml(sh.totals)}</span></div>`)
                .join("")
            : `<p class="muted">Bu firmada gemi yok.</p>`;
          return `<details class="company" data-company="${comp.company_id}" ${open ? "open" : ""}>
            <summary>
              <span class="company-name">${escapeHtml(comp.company_name)}</span>
              <span class="company-cell"><small>Yapılan iş</small>${pillsHtml(comp.billed)}</span>
              <span class="company-cell"><small>Alınan ödeme</small>${pillsHtml(comp.paid)}</span>
              <span class="company-cell"><small>Kalan</small>${pillsHtml(comp.remaining)}</span>
            </summary>
            <div class="company-body">
              ${comp.contact_info ? `<p class="hint">${escapeHtml(comp.contact_info)}</p>` : ""}
              ${ships}
              <div class="company-actions">
                <button type="button" class="btn btn-sm btn-primary" data-quick-pay-company="${comp.company_id}">Ödeme Ekle</button>
                <button type="button" class="btn btn-sm" data-pdf-company="company-financial" data-company-id="${comp.company_id}">Mali durum PDF</button>
                <button type="button" class="btn btn-sm" data-pdf-company="company-detail" data-company-id="${comp.company_id}">Tüm detaylar PDF</button>
              </div>
            </div>
          </details>`;
        })
        .join("")
    : `<p class="muted">Henüz firma yok. İşlemler ekranından firma ekleyin.</p>`;

  $("paymentsTableBody").innerHTML = state.payments.length
    ? state.payments
        .map((p) => `<tr>
          <td>${escapeHtml(isoToDisplay(p.payment_date))}</td>
          <td>${escapeHtml(p.company_name)}</td>
          <td>${escapeHtml(p.ship_name || "Firma geneli")}</td>
          <td>${escapeHtml(p.note || "")}</td>
          <td class="num"><span class="pill curr-${p.currency}">${fmtExactMoney(p.amount, p.currency)}</span></td>
          <td>${state.documents.filter((d) => d.payment_id === p.id).map(docLinkHtml).join("")}
            <button type="button" class="btn btn-sm" data-add-doc="dekont" data-doc-company="${p.company_id}" data-doc-payment="${p.id}">Dekont ekle</button></td>
          <td><button type="button" class="btn btn-sm btn-quiet btn-danger" data-delete-payment="${p.id}">Sil</button></td>
        </tr>`)
        .join("")
    : `<tr class="empty-row"><td colspan="7">Henüz ödeme yok.</td></tr>`;

  const docs = state.documents.filter((d) => !d.payment_id);
  const names = Object.fromEntries(state.companies.map((c) => [c.id, c.name]));
  const kindName = { fatura: "Fatura", dekont: "Dekont", diger: "Belge" };
  $("documentsList").innerHTML = docs.length
    ? `<table class="data-table"><thead><tr><th>Tür</th><th>Firma</th><th>Dosya</th><th>Tarih</th></tr></thead><tbody>` +
      docs.map((d) => `<tr><td>${kindName[d.kind] || "Belge"}</td><td>${escapeHtml(names[d.company_id] || "")}</td><td>${docLinkHtml(d)}</td><td>${escapeHtml(isoToDisplay(d.created_at))}</td></tr>`).join("") +
      `</tbody></table>`
    : `<p class="hint" style="padding:0.8rem 1rem;margin:0">Henüz belge yok.</p>`;
}

async function uploadDocument(file, fields) {
  const fd = new FormData();
  fd.append("file", file);
  for (const [k, v] of Object.entries(fields)) if (v) fd.append(k, String(v));
  const res = await fetch("/api/documents", { method: "POST", body: fd });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Belge yüklenemedi.");
  return data;
}

// --- Ekran geçişi ---
function switchMainView(view) {
  state.activeView = view;
  $("viewOperations").classList.toggle("active", view === "operations");
  $("viewLedger").classList.toggle("active", view === "ledger");
  for (const [id, v] of [["tabOperations", "operations"], ["tabLedger", "ledger"], ["mNavOperations", "operations"], ["mNavLedger", "ledger"]]) {
    $(id).classList.toggle("active", view === v);
  }
  window.scrollTo({ top: 0 });
}

// --- Pencere yardımcıları ---
function updateLiveModalTotal() {
  const sum = ["recTransfer", "recHotel", "recMeal", "recIgafi", "recVize", "recExtra"].reduce(
    (a, id) => a + Number($(id).value || 0),
    0,
  );
  $("recLiveTotal").textContent = fmtExactMoney(sum, $("recCurrency").value || "TRY");
}

function openRecordModal(record = null) {
  if (!state.activeShipId) return notify("Önce bir gemi seçin veya ekleyin.", true);
  $("recId").value = record ? record.id : "";
  $("modalRecordTitle").textContent = record ? "İşlemi düzenle" : "Yeni işlem";
  $("recDatePicker").value = record ? toIsoInputDate(record.tx_date) : "";
  $("recCurrency").value = record ? record.currency : "TRY";
  $("recDeparture").value = record ? record.departure : "";
  $("recArrival").value = record ? record.arrival : "";
  $("recPassenger").value = record ? record.passenger_info : "";
  for (const [id, key] of [["recTransfer", "transfer_fee"], ["recHotel", "hotel_fee"], ["recMeal", "meal_fee"], ["recIgafi", "igafi_fee"], ["recVize", "vize_fee"], ["recExtra", "extra_fee"]]) {
    $(id).value = record && record[key] ? record[key] : "";
  }
  $("recDescription").value = record ? record.description : "";
  updateLiveModalTotal();
  $("modalRecord").showModal();
}

function updatePaymentModalShips(companyId) {
  $("payShip").innerHTML =
    `<option value="">Firma geneli</option>` +
    state.ships.filter((s) => s.company_id === Number(companyId)).map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

function openPaymentModal(preselectedCompanyId = null) {
  if (state.companies.length === 0) return notify("Önce bir firma eklemelisiniz.", true);
  const target = Number(preselectedCompanyId || state.activeCompanyId || state.companies[0].id);
  $("payCompany").innerHTML = state.companies
    .map((c) => `<option value="${c.id}" ${c.id === target ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
    .join("");
  updatePaymentModalShips(target);
  $("formPayment").reset();
  $("payDate").value = new Date().toISOString().slice(0, 10);
  $("modalPayment").showModal();
}

// --- Olaylar ---
document.addEventListener("DOMContentLoaded", () => {
  refreshAll().catch((err) => notify(err.message, true));
  api("/api/version").then((v) => ($("appVersion").textContent = `v${v.version}`)).catch(() => {});

  // Ekranlar
  for (const id of ["tabOperations", "mNavOperations"]) $(id).addEventListener("click", () => switchMainView("operations"));
  for (const id of ["tabLedger", "mNavLedger"]) $(id).addEventListener("click", () => switchMainView("ledger"));

  // Açık menüleri dışarı tıklayınca kapat
  document.addEventListener("click", (e) => {
    for (const d of document.querySelectorAll("details.menu[open]")) if (!d.contains(e.target)) d.open = false;
  });

  // Tarih aralığı
  $("filterStartDate").addEventListener("change", (e) => { state.startDate = e.target.value; refreshAll(); });
  $("filterEndDate").addEventListener("change", (e) => { state.endDate = e.target.value; refreshAll(); });
  $("btnClearFilter").addEventListener("click", () => {
    state.startDate = state.endDate = "";
    $("filterStartDate").value = $("filterEndDate").value = "";
    refreshAll();
  });

  // Firma
  $("selectCompany").addEventListener("change", (e) => {
    state.activeCompanyId = Number(e.target.value);
    state.activeShipId = null;
    refreshAll();
  });

  $("btnAddCompany").addEventListener("click", async () => {
    const name = prompt("Yeni firma adı:");
    if (!name || !name.trim()) return;
    const contact = prompt("İletişim / not (isteğe bağlı):") || "";
    try {
      const created = await api("/api/companies", { method: "POST", body: JSON.stringify({ name, contact_info: contact }) });
      state.activeCompanyId = created.id;
      state.activeShipId = null;
      await refreshAll();
    } catch (err) {
      notify(err.message, true);
    }
  });

  $("btnEditCompany").addEventListener("click", async () => {
    const comp = state.companies.find((c) => c.id === state.activeCompanyId);
    if (!comp) return;
    const action = prompt(`"${comp.name}" için:\n- Yeni adı yazın ya da\n- Silmek için SİL yazın:`, comp.name);
    if (!action) return;
    try {
      if (["SİL", "SIL"].includes(action.trim().toLocaleUpperCase("tr-TR"))) {
        if (!confirm(`"${comp.name}" ve altındaki tüm gemiler silinecek. Onaylıyor musunuz?`)) return;
        await api(`/api/companies/${comp.id}`, { method: "DELETE" });
        state.activeCompanyId = state.activeShipId = null;
      } else {
        await api(`/api/companies/${comp.id}`, { method: "PUT", body: JSON.stringify({ name: action, contact_info: comp.contact_info }) });
      }
      await refreshAll();
    } catch (err) {
      notify(err.message, true);
    }
  });

  // Gemi
  $("shipTabsList").addEventListener("click", (e) => {
    const tab = e.target.closest("[data-ship-id]");
    if (!tab) return;
    state.activeShipId = Number(tab.dataset.shipId);
    refreshAll();
  });

  $("btnAddShip").addEventListener("click", async () => {
    if (!state.activeCompanyId) return notify("Önce bir firma ekleyin.", true);
    const name = prompt("Yeni gemi adı:");
    if (!name || !name.trim()) return;
    try {
      const created = await api("/api/ships", { method: "POST", body: JSON.stringify({ company_id: state.activeCompanyId, name }) });
      state.activeShipId = created.id;
      await refreshAll();
    } catch (err) {
      notify(err.message, true);
    }
  });

  $("btnEditShip").addEventListener("click", async () => {
    const ship = state.ships.find((s) => s.id === state.activeShipId);
    if (!ship) return;
    const action = prompt(`"${ship.name}" için:\n- Yeni adı yazın ya da\n- Silmek için SİL yazın:`, ship.name);
    if (!action) return;
    try {
      if (["SİL", "SIL"].includes(action.trim().toLocaleUpperCase("tr-TR"))) {
        if (!confirm(`"${ship.name}" ve içindeki kayıtlar silinecek. Onaylıyor musunuz?`)) return;
        await api(`/api/ships/${ship.id}`, { method: "DELETE" });
        state.activeShipId = null;
      } else {
        await api(`/api/ships/${ship.id}`, { method: "PUT", body: JSON.stringify({ name: action }) });
      }
      await refreshAll();
    } catch (err) {
      notify(err.message, true);
    }
  });

  // Hızlı ekleme satırı
  const submitQuickAdd = async () => {
    if (!state.activeShipId) return notify("Önce bir gemi seçin.", true);
    const num = (id) => Number($(id).value || 0);
    try {
      await api("/api/records", {
        method: "POST",
        body: JSON.stringify({
          ship_id: state.activeShipId,
          tx_date: $("qaDate").value,
          departure: $("qaDeparture").value,
          arrival: $("qaArrival").value,
          currency: $("qaCurrency").value,
          passenger_info: $("qaPassenger").value,
          transfer_fee: num("qaTransfer"),
          hotel_fee: num("qaHotel"),
          meal_fee: num("qaMeal"),
          igafi_fee: num("qaIgafi"),
          vize_fee: num("qaVize"),
          extra_fee: num("qaExtra"),
          description: $("qaDescription").value,
        }),
      });
      for (const id of ["qaTransfer", "qaHotel", "qaMeal", "qaIgafi", "qaVize", "qaExtra", "qaDescription"]) $(id).value = "";
      await refreshAll();
    } catch (err) {
      notify(err.message, true);
    }
  };
  $("btnQuickAddSubmit").addEventListener("click", submitQuickAdd);
  $("desktopQuickAddRow").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitQuickAdd();
    }
  });

  // İşlem penceresi
  $("btnOpenRecordModal").addEventListener("click", () => openRecordModal(null));

  $("presetTypeChips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-preset]");
    if (!chip) return;
    const preset = chip.dataset.preset;
    $("recDescription").value = preset;
    if (["AYAKBASTI", "GBT", "PERSONEL DEĞİŞİMİ"].includes(preset)) {
      for (const id of ["recTransfer", "recHotel", "recMeal"]) $(id).value = "";
      $("recExtra").focus();
    } else if (preset === "TRANSFER") {
      $("recTransfer").focus();
    } else if (preset.includes("ROOM")) {
      $("recHotel").focus();
    }
    updateLiveModalTotal();
  });

  for (const id of ["recTransfer", "recHotel", "recMeal", "recIgafi", "recVize", "recExtra", "recCurrency"]) {
    $(id).addEventListener("input", updateLiveModalTotal);
  }

  $("formRecord").addEventListener("submit", async (e) => {
    e.preventDefault();
    const recId = $("recId").value;
    const num = (id) => Number($(id).value || 0);
    const payload = {
      ship_id: state.activeShipId,
      tx_date: $("recDatePicker").value,
      currency: $("recCurrency").value,
      departure: $("recDeparture").value,
      arrival: $("recArrival").value,
      passenger_info: $("recPassenger").value,
      transfer_fee: num("recTransfer"),
      hotel_fee: num("recHotel"),
      meal_fee: num("recMeal"),
      igafi_fee: num("recIgafi"),
      vize_fee: num("recVize"),
      extra_fee: num("recExtra"),
      description: $("recDescription").value,
    };
    try {
      await api(recId ? `/api/records/${recId}` : "/api/records", { method: recId ? "PUT" : "POST", body: JSON.stringify(payload) });
      $("modalRecord").close();
      await refreshAll();
    } catch (err) {
      notify(err.message, true);
    }
  });

  // Tıklama yönlendirme (düzenle/sil/belge/PDF/ödeme)
  document.addEventListener("click", async (e) => {
    const t = (sel) => e.target.closest(sel);
    try {
      let el;
      if ((el = t("[data-edit-record]"))) {
        const rec = state.records.find((r) => r.id === Number(el.dataset.editRecord));
        if (rec) openRecordModal(rec);
      } else if ((el = t("[data-delete-record]"))) {
        if (!confirm("Bu işlem satırını silmek istediğinize emin misiniz?")) return;
        await api(`/api/records/${el.dataset.deleteRecord}`, { method: "DELETE" });
        await refreshAll();
      } else if ((el = t("[data-pdf]"))) {
        el.closest("details")?.removeAttribute("open");
        pdfFor(el.dataset.pdf);
      } else if ((el = t("[data-pdf-company]"))) {
        pdfFor(el.dataset.pdfCompany, Number(el.dataset.companyId));
      } else if ((el = t("[data-quick-pay-company]"))) {
        openPaymentModal(Number(el.dataset.quickPayCompany));
      } else if ((el = t("[data-jump-ship]"))) {
        state.activeCompanyId = Number(el.dataset.jumpCompany);
        state.activeShipId = Number(el.dataset.jumpShip);
        switchMainView("operations");
        await refreshAll();
      } else if ((el = t("[data-delete-payment]"))) {
        if (!confirm("Bu ödeme kaydını silmek istediğinize emin misiniz?")) return;
        await api(`/api/payments/${el.dataset.deletePayment}`, { method: "DELETE" });
        await refreshAll();
      } else if ((el = t("[data-add-doc]"))) {
        const company_id = Number(el.dataset.docCompany) || Number($("ledgerFilterCompany").value) || state.activeCompanyId;
        if (!company_id) return notify("Önce bir firma seçin.", true);
        state.pendingDoc = { company_id, payment_id: el.dataset.docPayment, kind: el.dataset.addDoc };
        $("docFileInput").click();
      } else if ((el = t("[data-delete-doc]"))) {
        if (!confirm("Bu belgeyi silmek istediğinize emin misiniz?")) return;
        await api(`/api/documents/${el.dataset.deleteDoc}`, { method: "DELETE" });
        await refreshAll();
      } else if ((el = t("[data-close-modal]"))) {
        $(el.dataset.closeModal)?.close();
      }
    } catch (err) {
      notify(err.message, true);
    }
  });

  // Firma kartlarının açık/kapalı durumunu hatırla (toggle olayı kabarcıklanmaz)
  $("ledgerCompaniesContainer").addEventListener(
    "toggle",
    (e) => {
      const id = Number(e.target.dataset.company);
      if (!id) return;
      if (e.target.open) state.openCompanies.add(id);
      else state.openCompanies.delete(id);
    },
    true,
  );

  $("docFileInput").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !state.pendingDoc) return;
    try {
      await uploadDocument(file, state.pendingDoc);
      notify("Belge yüklendi.");
      await refreshAll();
    } catch (err) {
      notify(err.message, true);
    }
  });

  // Ödeme
  $("btnOpenPaymentModal").addEventListener("click", () => openPaymentModal(null));
  $("payCompany").addEventListener("change", (e) => updatePaymentModalShips(Number(e.target.value)));
  $("ledgerFilterCompany").addEventListener("change", () => refreshAll());

  $("formPayment").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      company_id: Number($("payCompany").value),
      ship_id: $("payShip").value ? Number($("payShip").value) : null,
      payment_date: $("payDate").value,
      currency: $("payCurrency").value,
      amount: Number($("payAmount").value || 0),
      note: $("payNote").value,
    };
    try {
      const created = await api("/api/payments", { method: "POST", body: JSON.stringify(payload) });
      const docFile = $("payDoc").files[0];
      if (docFile) {
        try {
          await uploadDocument(docFile, { company_id: payload.company_id, payment_id: created.id, kind: "dekont" });
        } catch (err) {
          notify(`Ödeme kaydedildi ama dekont yüklenemedi: ${err.message}`, true);
        }
      }
      $("modalPayment").close();
      await refreshAll();
    } catch (err) {
      notify(err.message, true);
    }
  });

  // Excel'den aktar
  $("btnExcelModal").addEventListener("click", () => {
    $("appVersion").closest("header").querySelector("details.menu")?.removeAttribute("open");
    $("modalExcel").showModal();
  });

  $("formExcelImport").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeCompanyId) return notify("Önce bir firma seçin.", true);
    const file = $("excelFileInput").files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append("company_id", String(state.activeCompanyId));
    if (state.activeShipId) fd.append("ship_id", String(state.activeShipId));
    fd.append("file", file);
    try {
      const res = await fetch("/api/excel/import", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Excel yüklenemedi.");
      notify(`${data.importedCount} satır aktarıldı (${data.shipsTouched.join(", ")}).`);
      $("excelFileInput").value = "";
      $("modalExcel").close();
      await refreshAll();
    } catch (err) {
      notify(err.message, true);
    }
  });

  // Telefondan bağlan
  $("btnNetworkModal").addEventListener("click", async () => {
    $("appVersion").closest("header").querySelector("details.menu")?.removeAttribute("open");
    $("modalNetwork").showModal();
    try {
      const info = await api("/api/network-info");
      $("netTailscaleUrl").textContent = info.tailscaleUrl || "Tailscale açık değil veya IP bulunamadı";
      $("netLanUrl").textContent = info.lanUrls?.length ? info.lanUrls.join(" , ") : "Bulunamadı";
      $("netLocalUrl").textContent = info.localUrl;
    } catch {
      $("netTailscaleUrl").textContent = "Bağlantı bilgisi alınamadı";
    }
  });
});
