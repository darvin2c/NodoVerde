// src/provision.ts — el sim provisiona su mundo vía APIs GOBERNADAS (ADR-0028):
// tenant, módulos+kit de devices, claims, perfiles de cultivo y costos de
// insumos entran por MCP (mcp-domain / finance), jamás por SQL directo.
// La DB solo se LEE aquí (claims actuales, módulos libres) — las escrituras
// son de los dueños de cada tabla. Idempotente: corre en cada arranque.
import { readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SENSOR_DEVICES, SWITCH_DEVICES } from "./node/behavior.js";
import { loadCrop, type FincaConfig } from "./config.js";
import { nextModuleId } from "./lab.js";

const MCP_DOMAIN_URL = process.env.MCP_DOMAIN_URL ?? "http://localhost:7760";
const FINANCE_URL = process.env.FINANCE_URL ?? "http://localhost:7761";

// Capability por dispositivo del kit estándar (ADR-0028): sensores → métrica
// que alimentan; actuadores → clase de acción; cámara → null. Los ids NO se
// duplican literales: salen de behavior.ts (fuente de verdad del firmware).
export const KIT_CAPABILITIES: Record<string, string | null> = {
  "ec-01": "ec",
  "ph-01": "ph",
  "temp-01": "temp",
  "level-01": "level",
  "flow-01": "flow",
  "climate-01": "climate",
  "pump-recirc-01": "recirculate",
  "valve-fill-01": "fill_water",
  "doser-a-01": "dose_nutrient",
  "doser-b-01": "dose_nutrient",
  "doser-ph-01": "dose_ph",
  "cam-01": null,
};

export type KitDevice = { id: string; kind: "sensor" | "switch" | "camera"; capability: string | null };

/** Kit declarativo del nodo, construido desde las listas del firmware emulado. */
export function buildKit(): KitDevice[] {
  const sensors = SENSOR_DEVICES.map((id) => ({ id, kind: "sensor" as const, capability: KIT_CAPABILITIES[id] ?? null }));
  const switches = SWITCH_DEVICES.map((id) => ({ id, kind: "switch" as const, capability: KIT_CAPABILITIES[id] ?? null }));
  return [...sensors, ...switches, { id: "cam-01", kind: "camera" as const, capability: null }];
}

// --- clientes MCP (lazy singletons — el supervisor vive todo el proceso) ---

let domainClient: Client | null = null;
let financeClient: Client | null = null;

async function connect(baseUrl: string, name: string): Promise<Client> {
  const client = new Client({ name, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)));
  return client;
}

async function getDomain(): Promise<Client> {
  if (!domainClient) domainClient = await connect(MCP_DOMAIN_URL, "terra-sim-provision-domain");
  return domainClient;
}

async function getFinance(): Promise<Client> {
  if (!financeClient) financeClient = await connect(FINANCE_URL, "terra-sim-provision-finance");
  return financeClient;
}

/** structuredContent de la respuesta (boundary del SDK — objeto plano). */
type ToolContent = Record<string, unknown>;

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolContent> {
  const out = await client.callTool({ name, arguments: args });
  // boundary del SDK: structuredContent llega como objeto plano sin tipo útil
  const sc = (out.structuredContent ?? {}) as ToolContent;
  return sc;
}

/** Espera a que el server MCP responda HTTP (cualquier status = arriba). */
export async function waitMcp(url = MCP_DOMAIN_URL, timeoutMs = 30000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${url}/mcp`, { method: "GET" });
      return;
    } catch {
      // aún no responde — reintentar
    }
    await delay(500);
  }
  throw new Error(`MCP ${url} no respondió en ${timeoutMs}ms`);
}
function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// --- mundo ---

/**
 * Claiming gobernado de UN nodo: si el hw_id ya tiene identidad → skip.
 * Si no: módulo libre (activo y sin fierro) o create_module con kit; luego
 * claim_device. Reintenta una vez ante race (hw_already_claimed /
 * module_already_has_hardware) re-leyendo el estado.
 */
export async function claimNode(pool: pg.Pool, tenant: string, hwId: string, claimedBy: string): Promise<{ tenant: string; module: string }> {
  const existing = await pool.query(`SELECT module FROM device_identities WHERE hw_id = $1`, [hwId]);
  const prev = existing.rows[0] as { module: string } | undefined;
  if (prev) return { tenant, module: prev.module };

  const domain = await getDomain();
  for (let attempt = 0; attempt < 2; attempt++) {
    // módulo libre = existe, no retirado y NINGÚN hardware lo ocupa (menor id primero)
    const { rows: free } = await pool.query(
      `SELECT m.id FROM modules m
        WHERE m.tenant = $1 AND m.retired_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM device_identities d WHERE d.tenant = m.tenant AND d.module = m.id)
        ORDER BY m.id LIMIT 1`,
      [tenant],
    );
    let moduleId = (free[0] as { id: string } | undefined)?.id ?? null;
    if (!moduleId) {
      // sin mesa libre → crear una CON su kit declarativo (misma transacción, ADR-0028)
      const { rows } = await pool.query(
        `SELECT id FROM (SELECT id FROM modules WHERE tenant = $1
                         UNION SELECT module AS id FROM device_identities WHERE tenant = $1) t`,
        [tenant],
      );
      const nums = (rows as { id: string }[]).map((r) => parseInt(r.id.replace("mod-", ""), 10)).filter((n) => !isNaN(n));
      const created = await call(domain, "create_module", { tenant, name: `Mesa ${nextModuleId(nums)}`, devices: buildKit() });
      const mod = created.module as { id: string } | undefined; // boundary MCP: module = ModuleRow del servidor
      if (created.error || !mod?.id) throw new Error(`create_module falló: ${JSON.stringify(created)}`);
      moduleId = mod.id;
      console.log(`[provision] módulo ${moduleId} creado con kit de ${buildKit().length} dispositivos`);
    }
    const r = await call(domain, "claim_device", { tenant, module: moduleId, hw_id: hwId, claimed_by: claimedBy });
    if (r.error === "hw_already_claimed") {
      // race: otro lo claimeó entre el SELECT y el claim → re-leer y seguir
      const again = await pool.query(`SELECT module FROM device_identities WHERE hw_id = $1`, [hwId]);
      const cur = again.rows[0] as { module: string } | undefined;
      if (cur) return { tenant, module: cur.module };
      continue;
    }
    if (r.error === "module_already_has_hardware") continue; // race de mesa: reintentar con módulo fresco
    if (r.error) throw new Error(`claim_device falló: ${JSON.stringify(r)}`);
    console.log(`[provision] ${hwId} claimeado → ${tenant}/${moduleId} (por ${claimedBy})`);
    return { tenant, module: moduleId };
  }
  throw new Error(`claimNode ${hwId}: no se pudo claimear tras reintentos`);
}

/** Unclaiming gobernado (función de laboratorio): vía MCP, dueño de la tabla. */
export async function unclaimNode(hwId: string): Promise<void> {
  const domain = await getDomain();
  const r = await call(domain, "unclaim_device", { hw_id: hwId });
  if (r.error) throw new Error(`unclaim_device falló: ${JSON.stringify(r)}`);
}

/** Directorio de perfiles yaml del sim (mismas rutas candidatas que config.ts). */
function cropsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["sim/config/crops", "config/crops", "../config/crops"]) {
    const p = resolve(process.cwd(), rel);
    if (existsSync(p)) return p;
    const p2 = resolve(here, rel);
    if (existsSync(p2)) return p2;
  }
  throw new Error("directorio de perfiles de cultivo no encontrado");
}

/** Crea en DB un perfil por cada yaml de sim/config/crops/ (idempotente). */
async function ensureCropProfiles(domain: Client): Promise<void> {
  const files = readdirSync(cropsDir()).filter((f) => f.endsWith(".yaml")).sort();
  for (const f of files) {
    const crop = loadCrop(f.replace(/\.yaml$/, ""));
    const r = await call(domain, "create_crop_profile", {
      name: crop.name,
      ec_min: crop.ec_target[0],
      ec_max: crop.ec_target[1],
      ph_min: crop.ph_target[0],
      ph_max: crop.ph_target[1],
      water_temp_min: crop.water_temp[0],
      water_temp_max: crop.water_temp[1],
      cycle_days: crop.cycle_days,
      notes: crop.notes,
    });
    if (r.error === "profile_exists") continue; // idempotente
    if (r.error) throw new Error(`create_crop_profile ${crop.name} falló: ${JSON.stringify(r)}`);
    console.log(`[provision] perfil ${crop.name} creado (ciclo ${crop.cycle_days ?? "?"}d)`);
  }
}

/** Costos de insumos (upsert idempotente; valores del antiguo seed de init.sql). */
async function ensureSupplyCosts(): Promise<void> {
  const finance = await getFinance();
  for (const [supply, cost] of [["nutriente_a", 0.08], ["nutriente_b", 0.08], ["ph_down", 0.12]] as const) {
    const r = await call(finance, "set_supply_cost", { supply, cost_per_unit: cost, currency: "PEN", unit: "ml" });
    if (r.error) throw new Error(`set_supply_cost ${supply} falló: ${JSON.stringify(r)}`);
  }
  console.log("[provision] supply_costs asegurados (nutriente_a/b, ph_down)");
}

/**
 * Provisiona el mundo completo del sim vía APIs gobernadas (ADR-0028):
 *   a) tenant (la tz la deriva el servidor con tz-lookup desde lat/lon, ADR-0023)
 *   b) módulos+kit y claims por cada hw_id del yaml, EN ORDEN
 *   c) perfiles de cultivo desde sim/config/crops/*.yaml
 *   d) costos de insumos vía finance MCP
 * Idempotente por diseño: corre en cada arranque del supervisor.
 */
export async function ensureWorld(finca: FincaConfig, pool: pg.Pool): Promise<void> {
  const tenant = finca.tenant ?? "demo";
  const domain = await getDomain();

  const name = `Finca ${tenant.charAt(0).toUpperCase()}${tenant.slice(1)}`;
  const t = await call(domain, "create_tenant", {
    id: tenant,
    name,
    location_name: finca.location.name,
    lat: finca.location.lat,
    lon: finca.location.lon,
  });
  if (t.error === "tenant_exists") {
    console.log(`[provision] tenant ${tenant} ya existe — ok`);
  } else if (t.error) {
    throw new Error(`create_tenant falló: ${JSON.stringify(t)}`);
  } else {
    console.log(`[provision] tenant ${tenant} creado (${finca.location.name})`);
  }

  for (const m of finca.modules) await claimNode(pool, tenant, m.hw_id, "sim-supervisor");

  await ensureCropProfiles(domain);
  await ensureSupplyCosts();
}
