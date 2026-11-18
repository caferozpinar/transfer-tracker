// Gemi Transfer & Cari Takip — Frontend Logic (Desktop + Mobile Adaptive)

const CURRENCY_SYM = {
  TRY: "₺",
  USD: "$",
  EUR: "€",
};

const state = {
  companies: [],
  ships: [],
  records: [],
  payments: [],
  summary: null,
  activeCompanyId: null,
  activeShipId: null,
  activeView: "operations", // 'operations' | 'ledger'
  displayMode: "auto",      // 'auto' | 'table' | 'cards'
  startDate: "",
  endDate: "",
};

// --- Formatting Helpers ---
function fmtNumber(val, decimals = 2) {
  return new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(Number(val) || 0);
}

function fmtCellMoney(val, currency = "TRY") {
  const num = Number(val) || 0;
  if (num === 0) return "X";
  const sym = CURRENCY_SYM[currency] || "₺";
  const hasDec = num % 1 !== 0;
  return `${fmtNumber(num, hasDec ? 2 : 0)} ${sym}`;
}

function fmtExactMoney(val, currency = "TRY") {
  const num = Number(val) || 0;
  const sym = CURRENCY_SYM[currency] || "₺";
  return `${sym}${fmtNumber(num, 2)}`;
}

function renderCurrencyTotalsHtml(totals, showZeroTry = true) {
  if (!totals) return `<span class="currency-pill curr-TRY">₺0,00</span>`;
  const pills = [];
  for (const curr of ["TRY", "USD", "EUR"]) {
    const val = Number(totals[curr] || 0);
    if (val !== 0) {
      pills.push(
        `<span class="currency-pill curr-${curr}">${fmtExactMoney(val, curr)}</span>`
      );
    }
  }
  if (pills.length === 0 && showZeroTry) {
    return `<span class="currency-pill curr-TRY">₺0,00</span>`;
  }
  return pills.join(" ");
}

function toIsoInputDate(displayDate) {
  const s = (displayDate || "").trim();
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return "";
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- API Wrapper ---
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || "İşlem sırasında hata oluştu.");
  }
  return data;
}

// --- Data Loading ---
async function refreshAll() {
  const params = new URLSearchParams();
  if (state.startDate) params.set("start_date", state.startDate);
  if (state.endDate) params.set("end_date", state.endDate);

  const [companies, ships, summary, autocomplete] = await Promise.all([
    api("/api/companies"),
    api("/api/ships"),
    api(`/api/summary?${params.toString()}`),
    api("/api/autocomplete"),
  ]);

  state.companies = companies;
  state.ships = ships;
  state.summary = summary;

  // Ensure valid activeCompanyId
  if (!state.activeCompanyId || !companies.some((c) => c.id === state.activeCompanyId)) {
    state.activeCompanyId = companies.length > 0 ? companies[0].id : null;
  }

  // Ensure valid activeShipId for the activeCompanyId
  const companyShips = ships.filter((s) => s.company_id === state.activeCompanyId);
  if (!state.activeShipId || !companyShips.some((s) => s.id === state.activeShipId)) {
    state.activeShipId = companyShips.length > 0 ? companyShips[0].id : null;
  }

  // Load records for activeShipId
  if (state.activeShipId) {
    const recParams = new URLSearchParams(params);
    recParams.set("ship_id", String(state.activeShipId));
    state.records = await api(`/api/records?${recParams.toString()}`);
  } else {
    state.records = [];
  }

  // Load payments for ledger
  const payParams = new URLSearchParams(params);
  const filterComp = document.getElementById("ledgerFilterCompany")?.value;
  if (filterComp) payParams.set("company_id", filterComp);
  state.payments = await api(`/api/payments?${payParams.toString()}`);

  populateAutocomplete(autocomplete);
  renderAll();
}

function populateAutocomplete(ac) {
  const fill = (id, list) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = (list || []).map((v) => `<option value="${escapeHtml(v)}"></option>`).join("");
  };
  fill("dlLocations", ac.locations);
  fill("dlPassengers", ac.passengers);
  fill("dlDescriptions", ac.descriptions);
}

// --- Rendering ---
function renderAll() {
  renderCompanyAndShipSelectors();
  renderSummaryStrip();
  renderOperationsTableAndCards();
  renderLedgerView();
}

function renderCompanyAndShipSelectors() {
  const selectCompany = document.getElementById("selectCompany");
  selectCompany.innerHTML = state.companies
    .map(
      (c) =>
        `<option value="${c.id}" ${c.id === state.activeCompanyId ? "selected" : ""}>${escapeHtml(c.name)}</option>`
    )
    .join("");

  const companyShips = state.ships.filter((s) => s.company_id === state.activeCompanyId);
  const shipTabsList = document.getElementById("shipTabsList");

  if (companyShips.length === 0) {
    shipTabsList.innerHTML = `<span class="muted-text">Bu firmaya ait gemi yok. "+ Gemi Ekle" butonunu kullanın.</span>`;
  } else {
    shipTabsList.innerHTML = companyShips
      .map(
        (s) =>
          `<button type="button" role="tab" class="ship-tab ${s.id === state.activeShipId ? "active" : ""}" data-ship-id="${s.id}">
            🚢 ${escapeHtml(s.name)}
          </button>`
      )
      .join("");
  }

  const activeShip = companyShips.find((s) => s.id === state.activeShipId);
  document.getElementById("activeShipHeading").textContent = activeShip ? activeShip.name : "GEMİ SEÇİLMEDİ";
  document.getElementById("activeRecordCount").textContent = `${state.records.length} Kayıt`;
}

function renderSummaryStrip() {
  if (!state.summary) return;
  const compSum = state.summary.companies.find((c) => c.company_id === state.activeCompanyId);
  const shipSum = compSum?.ships.find((s) => s.ship_id === state.activeShipId);

  document.getElementById("shipSummaryTitle").textContent = shipSum
    ? `GEMİ TOPLAMI (${shipSum.ship_name})`
    : "SEÇİLİ GEMİ TOPLAMI";
  document.getElementById("shipSummaryValues").innerHTML = renderCurrencyTotalsHtml(shipSum?.totals);

  document.getElementById("companySummaryTitle").textContent = compSum
    ? `FİRMA TOPLAMI (${compSum.company_name})`
    : "SEÇİLİ FİRMA TOPLAMI";
  document.getElementById("companySummaryValues").innerHTML = renderCurrencyTotalsHtml(compSum?.billed);

  document.getElementById("overallSummaryValues").innerHTML = renderCurrencyTotalsHtml(
    state.summary.overall_billed
  );
}

function renderOperationsTableAndCards() {
  const tbody = document.getElementById("recordsTableBody");
  const cardsContainer = document.getElementById("mobileCardsContainer");
  const activeShip = state.ships.find((s) => s.id === state.activeShipId);
  const shipName = activeShip ? activeShip.name : "-";

  if (state.records.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="11" style="padding: 1.5rem; background:#fff; color:#475569;">
          Bu gemide henüz kayıt bulunmuyor. Aşağıdaki satırdan veya <strong>+ Yeni İşlem Ekle</strong> butonundan ekleyebilirsiniz.
        </td>
      </tr>
    `;
    cardsContainer.innerHTML = `
      <div class="op-card">
        <p class="muted-text">Bu gemide henüz işlem kaydı yok. Alt menüdeki <strong>+ İşlem Ekle</strong> butonuna dokunarak pratik şekilde ekleyebilirsiniz.</p>
      </div>
    `;
    document.getElementById("tableFooterTotal").textContent = "₺0,00";
    return;
  }

  tbody.innerHTML = state.records
    .map((r) => {
      return `
        <tr data-record-id="${r.id}">
          <td>${escapeHtml(r.tx_date)}</td>
          <td>${escapeHtml(r.departure)}</td>
          <td>${escapeHtml(r.arrival)}</td>
          <td class="cell-ship">${escapeHtml(r.ship_name || shipName)}</td>
          <td>${escapeHtml(r.passenger_info)}</td>
          <td>${fmtCellMoney(r.transfer_fee, r.currency)}</td>
          <td>${fmtCellMoney(r.hotel_fee, r.currency)}</td>
          <td>${fmtCellMoney(r.meal_fee, r.currency)}</td>
          <td class="cell-total">${fmtCellMoney(r.total_fee, r.currency)}</td>
          <td>${escapeHtml(r.description)}</td>
          <td>
            <div class="row-action-btns">
              <button type="button" class="btn btn-secondary btn-sm" data-edit-record="${r.id}" title="Düzenle">✏️</button>
              <button type="button" class="btn btn-danger btn-sm" data-delete-record="${r.id}" title="Sil">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  // Calculate footer totals by currency
  const recTotals = { TRY: 0, USD: 0, EUR: 0 };
  for (const r of state.records) {
    const c = r.currency || "TRY";
    recTotals[c] = (recTotals[c] || 0) + Number(r.total_fee || 0);
  }
  const totalParts = [];
  for (const c of ["TRY", "USD", "EUR"]) {
    if (recTotals[c] > 0) {
      totalParts.push(fmtExactMoney(recTotals[c], c));
    }
  }
  document.getElementById("tableFooterTotal").textContent =
    totalParts.length > 0 ? totalParts.join("  |  ") : "₺0,00";

  // Render Mobile Cards
  cardsContainer.innerHTML = state.records
    .map((r) => {
      const routeText =
        r.departure || r.arrival
          ? `${escapeHtml(r.departure || "-")} ➔ ${escapeHtml(r.arrival || "-")}`
          : escapeHtml(r.passenger_info || r.ship_name || shipName);

      const feeChips = [];
      if (r.transfer_fee > 0) feeChips.push(`Transfer: ${fmtCellMoney(r.transfer_fee, r.currency)}`);
      if (r.hotel_fee > 0) feeChips.push(`Otel: ${fmtCellMoney(r.hotel_fee, r.currency)}`);
      if (r.meal_fee > 0) feeChips.push(`Yemek: ${fmtCellMoney(r.meal_fee, r.currency)}`);
      if (r.extra_fee > 0) feeChips.push(`Doğrudan: ${fmtCellMoney(r.extra_fee, r.currency)}`);

      return `
        <div class="op-card">
          <div class="op-card-header">
            <div class="op-card-meta">
              <span class="op-date-badge">${escapeHtml(r.tx_date || r.effective_date || "Bağlı Satır")}</span>
              <span class="op-desc-badge">${escapeHtml(r.description || "İŞLEM")}</span>
            </div>
            <div class="op-card-total">${fmtCellMoney(r.total_fee, r.currency)}</div>
          </div>
          <div class="op-card-route">${routeText}</div>
          <div class="muted-text">${escapeHtml(r.passenger_info)} — <strong style="color:#d91b1b">${escapeHtml(r.ship_name || shipName)}</strong></div>
          <div class="op-card-Breakdown">
            <span>${feeChips.join(" • ")}</span>
            <div class="row-action-btns">
              <button type="button" class="btn btn-secondary btn-sm" data-edit-record="${r.id}">Düzenle</button>
              <button type="button" class="btn btn-danger btn-sm" data-delete-record="${r.id}">Sil</button>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderLedgerView() {
  if (!state.summary) return;

  document.getElementById("ledgerOverallBilled").innerHTML = renderCurrencyTotalsHtml(
    state.summary.overall_billed
  );
  document.getElementById("ledgerOverallPaid").innerHTML = renderCurrencyTotalsHtml(
    state.summary.overall_paid
  );
  document.getElementById("ledgerOverallRemaining").innerHTML = renderCurrencyTotalsHtml(
    state.summary.overall_remaining
  );

  // Filter company dropdown in ledger
  const filterSelect = document.getElementById("ledgerFilterCompany");
  const currentFilterVal = filterSelect.value;
  filterSelect.innerHTML =
    `<option value="">Tüm Firmalar</option>` +
    state.companies
      .map(
        (c) =>
          `<option value="${c.id}" ${String(c.id) === String(currentFilterVal) ? "selected" : ""}>${escapeHtml(c.name)}</option>`
      )
      .join("");

  const container = document.getElementById("ledgerCompaniesContainer");
  container.innerHTML = state.summary.companies
    .map((comp) => {
      const shipsHtml =
        comp.ships.length === 0
          ? `<span class="muted-text">Gemi yok</span>`
          : comp.ships
              .map(
                (s) => `
                <button type="button" class="ship-mini-pill" data-jump-company="${comp.company_id}" data-jump-ship="${s.ship_id}">
                  🚢 <strong>${escapeHtml(s.ship_name)}</strong> (${s.record_count} işlem): ${renderCurrencyTotalsHtml(s.totals)}
                </button>
              `
              )
              .join("");

      return `
        <div class="company-ledger-card">
          <div class="company-ledger-top">
            <div>
              <h3>🏢 ${escapeHtml(comp.company_name)}</h3>
              ${comp.contact_info ? `<p class="muted-text">${escapeHtml(comp.contact_info)}</p>` : ""}
            </div>
            <div class="row-action-btns">
              <button type="button" class="btn btn-primary btn-sm" data-quick-pay-company="${comp.company_id}">
                + Bu Firmadan Ödeme Al
              </button>
            </div>
          </div>

          <div class="company-ledger-metrics">
            <div class="metric-box">
              <div class="metric-title">TOPLAM YAPILAN İŞ (FİRMA ÖZELİ)</div>
              <div class="metric-val">${renderCurrencyTotalsHtml(comp.billed)}</div>
            </div>
            <div class="metric-box">
              <div class="metric-title">ALINAN ÖDEMELER (TAHSİLAT)</div>
              <div class="metric-val">${renderCurrencyTotalsHtml(comp.paid)}</div>
            </div>
            <div class="metric-box metric-remaining">
              <div class="metric-title">KALAN ALACAK (BAKİYE)</div>
              <div class="metric-val">${renderCurrencyTotalsHtml(comp.remaining)}</div>
            </div>
          </div>

          <div class="company-ships-mini">
            ${shipsHtml}
          </div>
        </div>
      `;
    })
    .join("");

  // Render Payment History Table
  const payTbody = document.getElementById("paymentsTableBody");
  if (state.payments.length === 0) {
    payTbody.innerHTML = `<tr><td colspan="6" class="muted-text">Henüz kayıtlı ödeme (tahsilat) bulunmuyor.</td></tr>`;
  } else {
    payTbody.innerHTML = state.payments
      .map(
        (p) => `
        <tr>
          <td><strong>${escapeHtml(p.payment_date)}</strong></td>
          <td>${escapeHtml(p.company_name)}</td>
          <td>${escapeHtml(p.ship_name || "Firma Geneli")}</td>
          <td>${escapeHtml(p.note || "-")}</td>
          <td><span class="currency-pill curr-${p.currency}">${fmtExactMoney(p.amount, p.currency)}</span></td>
          <td>
            <button type="button" class="btn btn-danger btn-sm" data-delete-payment="${p.id}">Sil</button>
          </td>
        </tr>
      `
      )
      .join("");
  }
}

// --- View & Display Mode Switching ---
function switchMainView(viewName) {
  state.activeView = viewName;
  document.getElementById("viewOperations").classList.toggle("active", viewName === "operations");
  document.getElementById("viewLedger").classList.toggle("active", viewName === "ledger");

  document.getElementById("tabOperations").classList.toggle("active", viewName === "operations");
  document.getElementById("tabLedger").classList.toggle("active", viewName === "ledger");

  document.getElementById("mNavOperations").classList.toggle("active", viewName === "operations");
  document.getElementById("mNavLedger").classList.toggle("active", viewName === "ledger");
}

function setDisplayMode(mode) {
  state.displayMode = mode;
  document.body.setAttribute("data-display-mode", mode);
  for (const btn of document.querySelectorAll(".mode-btn")) {
    btn.classList.toggle("active", btn.getAttribute("data-mode") === mode);
  }
}

// --- Modal Record Form Helpers ---
function updateLiveModalTotal() {
  const t = Number(document.getElementById("recTransfer").value || 0);
  const h = Number(document.getElementById("recHotel").value || 0);
  const m = Number(document.getElementById("recMeal").value || 0);
  const e = Number(document.getElementById("recExtra").value || 0);
  const curr = document.getElementById("recCurrency").value || "TRY";
  document.getElementById("recLiveTotal").textContent = fmtExactMoney(t + h + m + e, curr);
}

function openRecordModal(record = null) {
  if (!state.activeShipId) {
    alert("Lütfen önce bir gemi seçin veya ekleyin.");
    return;
  }
  const modal = document.getElementById("modalRecord");
  document.getElementById("recId").value = record ? record.id : "";
  document.getElementById("modalRecordTitle").textContent = record
    ? `Kaydı Düzenle (#${record.id})`
    : "Yeni Operasyon / İşlem Kaydı";

  document.getElementById("recDatePicker").value = record ? toIsoInputDate(record.tx_date) : "";
  document.getElementById("recCurrency").value = record ? record.currency : "TRY";
  document.getElementById("recDeparture").value = record ? record.departure : "";
  document.getElementById("recArrival").value = record ? record.arrival : "";
  document.getElementById("recPassenger").value = record ? record.passenger_info : "";
  document.getElementById("recTransfer").value = record && record.transfer_fee ? record.transfer_fee : "";
  document.getElementById("recHotel").value = record && record.hotel_fee ? record.hotel_fee : "";
  document.getElementById("recMeal").value = record && record.meal_fee ? record.meal_fee : "";
  document.getElementById("recExtra").value = record && record.extra_fee ? record.extra_fee : "";
  document.getElementById("recDescription").value = record ? record.description : "";

  updateLiveModalTotal();
  modal.showModal();
}

function openPaymentModal(preselectedCompanyId = null) {
  if (state.companies.length === 0) {
    alert("Önce bir firma eklemelisiniz.");
    return;
  }
  const targetCompId = preselectedCompanyId || state.activeCompanyId || state.companies[0].id;
  const payCompany = document.getElementById("payCompany");
  payCompany.innerHTML = state.companies
    .map((c) => `<option value="${c.id}" ${c.id === Number(targetCompId) ? "selected" : ""}>${escapeHtml(c.name)}</option>`)
    .join("");

  updatePaymentModalShips(Number(targetCompId));
  document.getElementById("payDate").value = new Date().toISOString().slice(0, 10);
  document.getElementById("payCurrency").value = "TRY";
  document.getElementById("payAmount").value = "";
  document.getElementById("payNote").value = "";

  document.getElementById("modalPayment").showModal();
}

function updatePaymentModalShips(companyId) {
  const payShip = document.getElementById("payShip");
  const compShips = state.ships.filter((s) => s.company_id === Number(companyId));
  payShip.innerHTML =
    `<option value="">-- Firma Geneli Ödeme --</option>` +
    compShips.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join("");
}

// --- Event Listeners Setup ---
document.addEventListener("DOMContentLoaded", () => {
  setDisplayMode("auto");
  refreshAll();

  // Main View Tabs
  document.getElementById("tabOperations").addEventListener("click", () => switchMainView("operations"));
  document.getElementById("tabLedger").addEventListener("click", () => switchMainView("ledger"));
  document.getElementById("mNavOperations").addEventListener("click", () => switchMainView("operations"));
  document.getElementById("mNavLedger").addEventListener("click", () => switchMainView("ledger"));
  document.getElementById("mNavQuickAdd").addEventListener("click", () => openRecordModal(null));

  // Display mode switcher
  for (const btn of document.querySelectorAll(".mode-btn")) {
    btn.addEventListener("click", () => setDisplayMode(btn.getAttribute("data-mode")));
  }

  // Date filters
  document.getElementById("filterStartDate").addEventListener("change", (e) => {
    state.startDate = e.target.value;
    refreshAll();
  });
  document.getElementById("filterEndDate").addEventListener("change", (e) => {
    state.endDate = e.target.value;
    refreshAll();
  });
  document.getElementById("btnClearFilter").addEventListener("click", () => {
    state.startDate = "";
    state.endDate = "";
    document.getElementById("filterStartDate").value = "";
    document.getElementById("filterEndDate").value = "";
    refreshAll();
  });

  // Company Selector & CRUD
  document.getElementById("selectCompany").addEventListener("change", (e) => {
    state.activeCompanyId = Number(e.target.value);
    state.activeShipId = null;
    refreshAll();
  });

  document.getElementById("btnAddCompany").addEventListener("click", async () => {
    const name = prompt("Yeni Firma Adı:");
    if (!name || !name.trim()) return;
    const contact = prompt("Firma İletişim / Not (Opsiyonel):") || "";
    try {
      const created = await api("/api/companies", {
        method: "POST",
        body: JSON.stringify({ name, contact_info: contact }),
      });
      state.activeCompanyId = created.id;
      state.activeShipId = null;
      await refreshAll();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("btnEditCompany").addEventListener("click", async () => {
    const comp = state.companies.find((c) => c.id === state.activeCompanyId);
    if (!comp) return;
    const action = prompt(
      `"${comp.name}" firması için:\n- Yeni isim vermek için yeni adı yazın\n- Silmek için SİL yazın:`,
      comp.name
    );
    if (!action) return;
    try {
      if (action.trim().toUpperCase() === "SİL" || action.trim().toUpperCase() === "SIL") {
        if (!confirm(`"${comp.name}" firması ve altındaki tüm gemiler silinecek. Onaylıyor musunuz?`)) return;
        await api(`/api/companies/${comp.id}`, { method: "DELETE" });
        state.activeCompanyId = null;
        state.activeShipId = null;
      } else {
        await api(`/api/companies/${comp.id}`, {
          method: "PUT",
          body: JSON.stringify({ name: action, contact_info: comp.contact_info }),
        });
      }
      await refreshAll();
    } catch (err) {
      alert(err.message);
    }
  });

  // Ship Selection & CRUD
  document.getElementById("shipTabsList").addEventListener("click", (e) => {
    const tab = e.target.closest("[data-ship-id]");
    if (!tab) return;
    state.activeShipId = Number(tab.getAttribute("data-ship-id"));
    refreshAll();
  });

  document.getElementById("btnAddShip").addEventListener("click", async () => {
    if (!state.activeCompanyId) {
      alert("Lütfen önce bir firma ekleyin.");
      return;
    }
    const name = prompt("Yeni Gemi Adı (Örn: MV ATLAS):");
    if (!name || !name.trim()) return;
    try {
      const created = await api("/api/ships", {
        method: "POST",
        body: JSON.stringify({ company_id: state.activeCompanyId, name }),
      });
      state.activeShipId = created.id;
      await refreshAll();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("btnEditShip").addEventListener("click", async () => {
    const ship = state.ships.find((s) => s.id === state.activeShipId);
    if (!ship) return;
    const action = prompt(
      `"${ship.name}" gemisi için:\n- Yeni isim vermek için yeni adı yazın\n- Silmek için SİL yazın:`,
      ship.name
    );
    if (!action) return;
    try {
      if (action.trim().toUpperCase() === "SİL" || action.trim().toUpperCase() === "SIL") {
        if (!confirm(`"${ship.name}" gemisi ve içindeki kayıtlar silinecek. Onaylıyor musunuz?`)) return;
        await api(`/api/ships/${ship.id}`, { method: "DELETE" });
        state.activeShipId = null;
      } else {
        await api(`/api/ships/${ship.id}`, {
          method: "PUT",
          body: JSON.stringify({ name: action }),
        });
      }
      await refreshAll();
    } catch (err) {
      alert(err.message);
    }
  });

  // Desktop Quick Add Row
  const submitQuickAdd = async () => {
    if (!state.activeShipId) {
      alert("Lütfen önce bir gemi seçin.");
      return;
    }
    const payload = {
      ship_id: state.activeShipId,
      tx_date: document.getElementById("qaDate").value,
      departure: document.getElementById("qaDeparture").value,
      arrival: document.getElementById("qaArrival").value,
      currency: document.getElementById("qaCurrency").value,
      passenger_info: document.getElementById("qaPassenger").value,
      transfer_fee: Number(document.getElementById("qaTransfer").value || 0),
      hotel_fee: Number(document.getElementById("qaHotel").value || 0),
      meal_fee: Number(document.getElementById("qaMeal").value || 0),
      extra_fee: Number(document.getElementById("qaExtra").value || 0),
      description: document.getElementById("qaDescription").value,
    };

    try {
      await api("/api/records", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      // Reset numeric and route inputs while keeping date/passenger handy
      document.getElementById("qaTransfer").value = "";
      document.getElementById("qaHotel").value = "";
      document.getElementById("qaMeal").value = "";
      document.getElementById("qaExtra").value = "";
      document.getElementById("qaDescription").value = "";
      await refreshAll();
    } catch (err) {
      alert(err.message);
    }
  };

  document.getElementById("btnQuickAddSubmit").addEventListener("click", submitQuickAdd);
  document.getElementById("desktopQuickAddRow").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      submitQuickAdd();
    }
  });

  // Open Record Modal & Preset Chips
  document.getElementById("btnOpenRecordModal").addEventListener("click", () => openRecordModal(null));

  document.getElementById("presetTypeChips").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-preset]");
    if (!chip) return;
    const preset = chip.getAttribute("data-preset");
    document.getElementById("recDescription").value = preset;

    if (preset === "AYAKBASTI" || preset === "GBT" || preset === "PERSONEL DEĞİŞİMİ") {
      // Clear route for sub-row items and focus extra fee directly
      document.getElementById("recTransfer").value = "";
      document.getElementById("recHotel").value = "";
      document.getElementById("recMeal").value = "";
      document.getElementById("recExtra").focus();
    } else if (preset === "TRANSFER") {
      document.getElementById("recTransfer").focus();
    } else if (preset.includes("ROOM")) {
      document.getElementById("recHotel").focus();
    }
    updateLiveModalTotal();
  });

  // Mini location/passenger chips inside modal
  document.querySelectorAll(".mini-chips").forEach((group) => {
    group.addEventListener("click", (e) => {
      const btn = e.target.closest(".mini-chip");
      if (!btn) return;
      const targetId = group.getAttribute("data-target-input");
      const input = document.getElementById(targetId);
      if (input) input.value = btn.textContent.trim();
    });
  });

  ["recTransfer", "recHotel", "recMeal", "recExtra", "recCurrency"].forEach((id) => {
    document.getElementById(id).addEventListener("input", updateLiveModalTotal);
  });

  // Record Form Submit
  document.getElementById("formRecord").addEventListener("submit", async (e) => {
    e.preventDefault();
    const recId = document.getElementById("recId").value;
    const payload = {
      ship_id: state.activeShipId,
      tx_date: document.getElementById("recDatePicker").value,
      currency: document.getElementById("recCurrency").value,
      departure: document.getElementById("recDeparture").value,
      arrival: document.getElementById("recArrival").value,
      passenger_info: document.getElementById("recPassenger").value,
      transfer_fee: Number(document.getElementById("recTransfer").value || 0),
      hotel_fee: Number(document.getElementById("recHotel").value || 0),
      meal_fee: Number(document.getElementById("recMeal").value || 0),
      extra_fee: Number(document.getElementById("recExtra").value || 0),
      description: document.getElementById("recDescription").value,
    };

    try {
      if (recId) {
        await api(`/api/records/${recId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
      } else {
        await api("/api/records", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      document.getElementById("modalRecord").close();
      await refreshAll();
    } catch (err) {
      alert(err.message);
    }
  });

  // Edit / Delete Record Delegation
  document.addEventListener("click", async (e) => {
    const editBtn = e.target.closest("[data-edit-record]");
    if (editBtn) {
      const id = Number(editBtn.getAttribute("data-edit-record"));
      const rec = state.records.find((r) => r.id === id);
      if (rec) openRecordModal(rec);
      return;
    }

    const delBtn = e.target.closest("[data-delete-record]");
    if (delBtn) {
      const id = Number(delBtn.getAttribute("data-delete-record"));
      if (!confirm("Bu işlem satırını silmek istediğinize emin misiniz?")) return;
      try {
        await api(`/api/records/${id}`, { method: "DELETE" });
        await refreshAll();
      } catch (err) {
        alert(err.message);
      }
      return;
    }

    const quickPayBtn = e.target.closest("[data-quick-pay-company]");
    if (quickPayBtn) {
      openPaymentModal(Number(quickPayBtn.getAttribute("data-quick-pay-company")));
      return;
    }

    const jumpShipBtn = e.target.closest("[data-jump-ship]");
    if (jumpShipBtn) {
      state.activeCompanyId = Number(jumpShipBtn.getAttribute("data-jump-company"));
      state.activeShipId = Number(jumpShipBtn.getAttribute("data-jump-ship"));
      switchMainView("operations");
      await refreshAll();
      return;
    }

    const delPayBtn = e.target.closest("[data-delete-payment]");
    if (delPayBtn) {
      const id = Number(delPayBtn.getAttribute("data-delete-payment"));
      if (!confirm("Bu ödeme kaydını silmek istediğinize emin misiniz?")) return;
      try {
        await api(`/api/payments/${id}`, { method: "DELETE" });
        await refreshAll();
      } catch (err) {
        alert(err.message);
      }
      return;
    }

    const closeModalBtn = e.target.closest("[data-close-modal]");
    if (closeModalBtn) {
      const modalId = closeModalBtn.getAttribute("data-close-modal");
      document.getElementById(modalId)?.close();
    }
  });

  // Payment Modal
  document.getElementById("btnOpenPaymentModal").addEventListener("click", () => openPaymentModal(null));
  document.getElementById("payCompany").addEventListener("change", (e) => {
    updatePaymentModalShips(Number(e.target.value));
  });

  document.getElementById("formPayment").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      company_id: Number(document.getElementById("payCompany").value),
      ship_id: document.getElementById("payShip").value ? Number(document.getElementById("payShip").value) : null,
      payment_date: document.getElementById("payDate").value,
      currency: document.getElementById("payCurrency").value,
      amount: Number(document.getElementById("payAmount").value || 0),
      note: document.getElementById("payNote").value,
    };

    try {
      await api("/api/payments", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      document.getElementById("modalPayment").close();
      await refreshAll();
    } catch (err) {
      alert(err.message);
    }
  });

  document.getElementById("ledgerFilterCompany").addEventListener("change", () => refreshAll());

  // Excel Modal & Export/Import
  document.getElementById("btnExcelModal").addEventListener("click", () => {
    document.getElementById("modalExcel").showModal();
  });

  document.getElementById("btnExportActiveShip").addEventListener("click", () => {
    if (!state.activeShipId) return alert("Önce bir gemi seçin.");
    const params = new URLSearchParams({ ship_id: String(state.activeShipId) });
    if (state.startDate) params.set("start_date", state.startDate);
    if (state.endDate) params.set("end_date", state.endDate);
    window.location.href = `/api/excel/export?${params.toString()}`;
  });

  document.getElementById("btnExportActiveCompany").addEventListener("click", () => {
    if (!state.activeCompanyId) return alert("Önce bir firma seçin.");
    const params = new URLSearchParams({ company_id: String(state.activeCompanyId) });
    if (state.startDate) params.set("start_date", state.startDate);
    if (state.endDate) params.set("end_date", state.endDate);
    window.location.href = `/api/excel/export?${params.toString()}`;
  });

  document.getElementById("formExcelImport").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!state.activeCompanyId) return alert("Lütfen önce bir firma seçin.");
    const fileInput = document.getElementById("excelFileInput");
    if (!fileInput.files || fileInput.files.length === 0) return;

    const formData = new FormData();
    formData.append("company_id", String(state.activeCompanyId));
    if (state.activeShipId) formData.append("ship_id", String(state.activeShipId));
    formData.append("file", fileInput.files[0]);

    try {
      const res = await fetch("/api/excel/import", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Excel yüklenemedi.");
      alert(`${data.importedCount} satır başarıyla aktarıldı (${data.shipsTouched.join(", ")}).`);
      fileInput.value = "";
      document.getElementById("modalExcel").close();
      await refreshAll();
    } catch (err) {
      alert(err.message);
    }
  });

  // Network / Tailscale Info Modal
  document.getElementById("btnNetworkModal").addEventListener("click", async () => {
    document.getElementById("modalNetwork").showModal();
    try {
      const info = await api("/api/network-info");
      document.getElementById("netTailscaleUrl").textContent =
        info.tailscaleUrl || "Tailscale açık değil veya IP bulunamadı";
      document.getElementById("netLanUrl").textContent =
        info.lanUrls && info.lanUrls.length > 0 ? info.lanUrls.join(" , ") : "Bulunamadı";
      document.getElementById("netLocalUrl").textContent = info.localUrl;
    } catch {
      document.getElementById("netTailscaleUrl").textContent = "Bağlantı bilgisi alınamadı";
    }
  });
});
