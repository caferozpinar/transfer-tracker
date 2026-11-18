import { basename } from "node:path";
import { VERSION } from "./version.ts";

const REPO = "caferozpinar/transfer-tracker";
export const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/version.json`;
const ALLOWED_PREFIX = `https://github.com/${REPO}/releases/download/`;

export interface Manifest {
  version: string;
  url: string;
  sha256: string;
}

type FetchFn = typeof fetch;

// "0.10.0" > "0.9.0" gibi sayısal karşılaştırma; geçersiz sürüm null döner.
export function compareVersions(a: string, b: string): number | null {
  const parse = (v: string) => {
    const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)$/);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  return 0;
}

export function validateManifest(raw: unknown): Manifest {
  const m = raw as Partial<Manifest>;
  if (
    !m || typeof m.version !== "string" || typeof m.url !== "string" ||
    typeof m.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(m.sha256) ||
    !m.url.startsWith(ALLOWED_PREFIX) || compareVersions(m.version, "0.0.0") === null
  ) {
    throw new Error("Geçersiz güncelleme bilgisi.");
  }
  return { version: m.version.replace(/^v/, ""), url: m.url, sha256: m.sha256.toLowerCase() };
}

// Yeni sürüm varsa manifest döner, yoksa null.
export async function checkForUpdate(
  current = VERSION,
  fetchFn: FetchFn = fetch,
  timeoutMs = 5000,
): Promise<Manifest | null> {
  const res = await fetchFn(MANIFEST_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`version.json okunamadı (${res.status})`);
  const manifest = validateManifest(await res.json());
  return compareVersions(manifest.version, current) === 1 ? manifest : null;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// İndirir ve hash tutmazsa hata verir; doğrulanmamış dosya asla yazılmaz.
export async function downloadVerified(manifest: Manifest, fetchFn: FetchFn = fetch): Promise<Uint8Array> {
  const res = await fetchFn(manifest.url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`İndirme başarısız (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if ((await sha256Hex(bytes)) !== manifest.sha256) throw new Error("Dosya doğrulaması (sha256) başarısız.");
  return bytes;
}

function isCompiled(): boolean {
  return !/^deno(\.exe)?$/i.test(basename(Deno.execPath()));
}

function backupDb(dbPath: string, version: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      Deno.copyFileSync(dbPath + suffix, `${dbPath}.bak-${version}${suffix}`);
    } catch { /* dosya yoksa atla */ }
  }
}

// Açılışta çağrılır. Güncelleme kurulursa yeni sürümü başlatıp bu süreci kapatır (geri dönmez).
// shortcut: yalnızca Windows .exe güncellenir, Linux/macOS için ikili yayınlanmıyor; gerekirse CI'a ekle.
export async function autoUpdate(dbPath: string): Promise<void> {
  if (!isCompiled()) return; // geliştirme modunda deno'ya dokunma
  const exe = Deno.execPath();
  try {
    Deno.removeSync(exe + ".old"); // önceki güncellemeden kalan
  } catch { /* yok */ }

  if (Deno.build.os !== "windows" || Deno.env.get("NO_UPDATE")) return;
  // Yeni sürüm kendini hemen yeniden güncellemeye çalışıp döngüye girmesin.
  if (Deno.env.get("GTT_JUST_UPDATED")) return;

  try {
    const manifest = await checkForUpdate();
    if (!manifest) return;
    console.log(`  Yeni sürüm bulundu: v${manifest.version} (mevcut v${VERSION}). İndiriliyor...`);
    const bytes = await downloadVerified(manifest);

    backupDb(dbPath, VERSION);
    const next = exe + ".new";
    Deno.writeFileSync(next, bytes);
    // Çalışan .exe silinemez ama yeniden adlandırılabilir.
    Deno.renameSync(exe, exe + ".old");
    try {
      Deno.renameSync(next, exe);
      new Deno.Command(exe, {
        args: Deno.args,
        env: { GTT_JUST_UPDATED: "1" },
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      }).spawn();
    } catch (err) {
      try {
        Deno.removeSync(exe);
      } catch { /* yok */ }
      Deno.renameSync(exe + ".old", exe); // geri al
      throw err;
    }
    console.log(`  v${manifest.version} kuruldu, uygulama yeniden başlatılıyor...`);
    Deno.exit(0);
  } catch (err) {
    // İnternet yok / hata: güncelleme atlanır, uygulama normal açılır.
    console.log(`  Güncelleme kontrolü atlandı: ${err instanceof Error ? err.message : err}`);
  }
}
