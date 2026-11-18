import { AppDatabase, Currency } from "./db.ts";
import { exportCompanyToXlsx, exportShipRecordsToXlsx, importRecordsFromXlsx } from "./excel.ts";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function detectNetworkAddresses(port: number): {
  localUrl: string;
  tailscaleIp: string | null;
  tailscaleUrl: string | null;
  lanIps: string[];
  lanUrls: string[];
} {
  let tailscaleIp: string | null = null;
  const lanIps: string[] = [];

  try {
    const interfaces = Deno.networkInterfaces();
    for (const iface of interfaces) {
      if (iface.family !== "IPv4" || iface.address === "127.0.0.1") continue;
      const addr = iface.address;
      // Tailscale uses CGNAT range 100.64.0.0/10 (100.64.x.x - 100.127.x.x)
      const parts = addr.split(".").map(Number);
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) {
        tailscaleIp = addr;
      } else {
        lanIps.push(addr);
      }
    }
  } catch {
    // Ignore permission or interface errors
  }

  return {
    localUrl: `http://localhost:${port}`,
    tailscaleIp,
    tailscaleUrl: tailscaleIp ? `http://${tailscaleIp}:${port}` : null,
    lanIps,
    lanUrls: lanIps.map((ip) => `http://${ip}:${port}`),
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function createAppHandler(db: AppDatabase, port = 8080) {
  const baseDir = dirname(fileURLToPath(import.meta.url));
  const publicDir = join(baseDir, "..", "public");

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      // --- API Routes ---
      if (path === "/api/network-info" && method === "GET") {
        return jsonResponse(detectNetworkAddresses(port));
      }

      if (path === "/api/autocomplete" && method === "GET") {
        return jsonResponse(db.getAutocomplete());
      }

      if (path === "/api/summary" && method === "GET") {
        const start_date = url.searchParams.get("start_date") || undefined;
        const end_date = url.searchParams.get("end_date") || undefined;
        return jsonResponse(db.getSummary({ start_date, end_date }));
      }

      // Companies
      if (path === "/api/companies" && method === "GET") {
        return jsonResponse(db.listCompanies());
      }
      if (path === "/api/companies" && method === "POST") {
        const body = await req.json();
        const created = db.createCompany(body.name ?? "", body.contact_info ?? "");
        return jsonResponse(created, 201);
      }
      const companyMatch = path.match(/^\/api\/companies\/(\d+)$/);
      if (companyMatch) {
        const id = Number(companyMatch[1]);
        if (method === "PUT") {
          const body = await req.json();
          return jsonResponse(db.updateCompany(id, body.name ?? "", body.contact_info ?? ""));
        }
        if (method === "DELETE") {
          db.deleteCompany(id);
          return jsonResponse({ ok: true });
        }
      }

      // Ships
      if (path === "/api/ships" && method === "GET") {
        const cid = url.searchParams.get("company_id");
        return jsonResponse(db.listShips(cid ? Number(cid) : undefined));
      }
      if (path === "/api/ships" && method === "POST") {
        const body = await req.json();
        const created = db.createShip(Number(body.company_id), body.name ?? "");
        return jsonResponse(created, 201);
      }
      const shipMatch = path.match(/^\/api\/ships\/(\d+)$/);
      if (shipMatch) {
        const id = Number(shipMatch[1]);
        if (method === "PUT") {
          const body = await req.json();
          return jsonResponse(db.updateShip(id, body.name ?? ""));
        }
        if (method === "DELETE") {
          db.deleteShip(id);
          return jsonResponse({ ok: true });
        }
      }

      // Records
      if (path === "/api/records" && method === "GET") {
        const ship_id = url.searchParams.get("ship_id");
        const company_id = url.searchParams.get("company_id");
        const start_date = url.searchParams.get("start_date") || undefined;
        const end_date = url.searchParams.get("end_date") || undefined;
        const currency = (url.searchParams.get("currency") as Currency) || undefined;
        return jsonResponse(
          db.listRecords({
            ship_id: ship_id ? Number(ship_id) : undefined,
            company_id: company_id ? Number(company_id) : undefined,
            start_date,
            end_date,
            currency,
          })
        );
      }
      if (path === "/api/records" && method === "POST") {
        const body = await req.json();
        const created = db.createRecord({
          ship_id: Number(body.ship_id),
          tx_date: body.tx_date,
          departure: body.departure,
          arrival: body.arrival,
          passenger_info: body.passenger_info,
          transfer_fee: Number(body.transfer_fee || 0),
          hotel_fee: Number(body.hotel_fee || 0),
          meal_fee: Number(body.meal_fee || 0),
          extra_fee: Number(body.extra_fee || 0),
          currency: body.currency || "TRY",
          description: body.description,
          sort_order: body.sort_order !== undefined ? Number(body.sort_order) : undefined,
        });
        return jsonResponse(created, 201);
      }
      const recordMatch = path.match(/^\/api\/records\/(\d+)$/);
      if (recordMatch) {
        const id = Number(recordMatch[1]);
        if (method === "PUT") {
          const body = await req.json();
          return jsonResponse(db.updateRecord(id, body));
        }
        if (method === "DELETE") {
          db.deleteRecord(id);
          return jsonResponse({ ok: true });
        }
      }

      // Payments
      if (path === "/api/payments" && method === "GET") {
        const company_id = url.searchParams.get("company_id");
        const ship_id = url.searchParams.get("ship_id");
        const start_date = url.searchParams.get("start_date") || undefined;
        const end_date = url.searchParams.get("end_date") || undefined;
        return jsonResponse(
          db.listPayments({
            company_id: company_id ? Number(company_id) : undefined,
            ship_id: ship_id ? Number(ship_id) : undefined,
            start_date,
            end_date,
          })
        );
      }
      if (path === "/api/payments" && method === "POST") {
        const body = await req.json();
        const created = db.createPayment({
          company_id: Number(body.company_id),
          ship_id: body.ship_id ? Number(body.ship_id) : null,
          payment_date: body.payment_date,
          amount: Number(body.amount),
          currency: body.currency || "TRY",
          note: body.note ?? "",
        });
        return jsonResponse(created, 201);
      }
      const paymentMatch = path.match(/^\/api\/payments\/(\d+)$/);
      if (paymentMatch && method === "DELETE") {
        db.deletePayment(Number(paymentMatch[1]));
        return jsonResponse({ ok: true });
      }

      // Excel Export & Import
      if (path === "/api/excel/export" && method === "GET") {
        const shipId = url.searchParams.get("ship_id");
        const companyId = url.searchParams.get("company_id");
        const start_date = url.searchParams.get("start_date") || undefined;
        const end_date = url.searchParams.get("end_date") || undefined;

        if (shipId) {
          const ship = db.getShip(Number(shipId));
          if (!ship) return jsonResponse({ error: "Gemi bulunamadı." }, 404);
          const records = db.listRecords({
            ship_id: ship.id,
            start_date,
            end_date,
          });
          const buf = exportShipRecordsToXlsx(ship.name, records);
          const fileName = encodeURIComponent(`${ship.name}_Tablo.xlsx`);
          return new Response(buf as unknown as BodyInit, {
            status: 200,
            headers: {
              "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "content-disposition": `attachment; filename="${fileName}"`,
            },
          });
        }

        if (companyId) {
          const companies = db.listCompanies();
          const comp = companies.find((c) => c.id === Number(companyId));
          if (!comp) return jsonResponse({ error: "Firma bulunamadı." }, 404);
          const buf = exportCompanyToXlsx(db, comp.id, { start_date, end_date });
          const fileName = encodeURIComponent(`${comp.name}_Tum_Gemiler.xlsx`);
          return new Response(buf as unknown as BodyInit, {
            status: 200,
            headers: {
              "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              "content-disposition": `attachment; filename="${fileName}"`,
            },
          });
        }

        return jsonResponse({ error: "ship_id veya company_id gereklidir." }, 400);
      }

      if (path === "/api/excel/import" && method === "POST") {
        const formData = await req.formData();
        const companyId = Number(formData.get("company_id"));
        const shipIdRaw = formData.get("ship_id");
        const defaultShipId = shipIdRaw ? Number(shipIdRaw) : null;
        const file = formData.get("file") as File | null;

        if (!companyId || !file) {
          return jsonResponse({ error: "Firma ve Excel dosyası seçilmelidir." }, 400);
        }

        const arrayBuffer = await file.arrayBuffer();
        const result = importRecordsFromXlsx(
          db,
          companyId,
          defaultShipId,
          new Uint8Array(arrayBuffer)
        );
        return jsonResponse({ ok: true, ...result });
      }

      // --- Static Files ---
      const assetMap: Record<string, { file: string; mime: string }> = {
        "/": { file: "index.html", mime: "text/html; charset=utf-8" },
        "/index.html": { file: "index.html", mime: "text/html; charset=utf-8" },
        "/styles.css": { file: "styles.css", mime: "text/css; charset=utf-8" },
        "/app.js": { file: "app.js", mime: "application/javascript; charset=utf-8" },
        "/manifest.json": { file: "manifest.json", mime: "application/manifest+json; charset=utf-8" },
      };

      const target = assetMap[path];
      if (target) {
        const content = await Deno.readFile(join(publicDir, target.file));
        return new Response(content, {
          status: 200,
          headers: { "content-type": target.mime },
        });
      }

      return jsonResponse({ error: "Sayfa bulunamadı" }, 404);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return jsonResponse({ error: msg }, 400);
    }
  };
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") || 8080);
  const dbPath = Deno.env.get("DB_PATH") || "veriler.db";
  const db = new AppDatabase(dbPath);

  const net = detectNetworkAddresses(port);
  console.log("==========================================================");
  console.log("  GEMİ TRANSFER VE CARİ TAKİP SİSTEMİ BAŞLATILDI");
  console.log("==========================================================");
  console.log(`  Bilgisayar (Yerel) Adresi : ${net.localUrl}`);
  if (net.tailscaleUrl) {
    console.log(`  Tailscale (Telefon) Adresi: ${net.tailscaleUrl}  <-- Telefondan bu adrese girin`);
  } else {
    console.log("  Tailscale IP              : Tespit edilemedi (Tailscale açık olduğunda otomatik görünür)");
  }
  if (net.lanUrls.length > 0) {
    console.log(`  Yerel Wi-Fi (LAN) Adresi  : ${net.lanUrls.join(", ")}`);
  }
  console.log(`  Veritabanı Dosyası        : ${dbPath}`);
  console.log("  Durdurmak için bu pencereyi kapatabilir veya Ctrl+C basabilirsiniz.");
  console.log("==========================================================");

  Deno.serve({ hostname: "0.0.0.0", port }, createAppHandler(db, port));

  // Automatically open default browser on Windows unless NO_BROWSER is set
  if (Deno.build.os === "windows" && !Deno.env.get("NO_BROWSER")) {
    try {
      new Deno.Command("cmd", {
        args: ["/c", "start", net.localUrl],
        stdout: "null",
        stderr: "null",
      }).spawn();
    } catch {
      // Ignore browser launch error
    }
  }
}
