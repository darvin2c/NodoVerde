// src/server.ts — herramientas MCP de dominio (lectura + lotes gobernados ADR-0024)
// Telemetría/perfiles siguen read-only (db.ts); lotes/alert_resolutions usan write.ts (pool separado).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  listModulesDb,
  getCropProfileDb,
  getFarmContextDb,
  latestReadingsDb,
  telemetryRangeDb,
  moduleConfidenceDb,
  recentAlertsDb,
  telemetryForDateDb,
  latestTelemetryDateDb,
  alertsForDateDb,
  confidenceForDateDb,
} from "./db.js";
import { buildDailyReportData } from "./report.js";
import {
  computeProfileHash,
  computeMemoryHash,
  getBatchDb,
  listBatchesDb,
  getOccupiedModulesDb,
  listInvariantAlertsDb,
  insertBatchDb,
  closeBatchDb,
  removeModuleFromBatchDb,
  computeExpectedEnd,
  canRemoveModuleFromBatch,
  setModulesCropDb,
  insertCropProfileDb,
  updateCropProfileDb,
  isValidCropName,
  isValidProfileRanges,
  insertResolutionDb,
  isValidHwId,
  getModuleDb,
  getOpenBatchWithModuleDb,
  insertModuleDb,
  updateModuleDb,
  retireModuleDb,
  claimDeviceDb,
  isValidTenantId,
  isValidCurrency,
  isValidLatLon,
  listTenantsDb,
  getTenantDb,
  insertTenantDb,
  updateTenantDb,
  archiveTenantDb,
} from "./write.js";
import { publishModuleMeta } from "./bus.js";
import tzLookup from "tz-lookup";

function summaryText(obj: unknown, maxLen = 4000): string {
  const s = JSON.stringify(obj, null, 2);
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "\n…(truncado)";
}

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "terra-mcp-domain", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // — list_modules -----------------------------------------------------------
  server.registerTool(
    "list_modules",
    {
      title: "Listar módulos",
      description: "Lista todos los módulos (tenant, id, crop) registrados en la DB de dominio.",
      inputSchema: {
        tenant: z.string().optional().describe("Filtra por tenant; si se omite lista todos"),
      },
    },
    async ({ tenant }) => {
      const rows = await listModulesDb(tenant);
      const summary = `Módulos: ${rows.length}` + (tenant ? ` (tenant=${tenant})` : "");
      return {
        content: [{ type: "text", text: `${summary}\n${summaryText(rows)}` }],
        structuredContent: { modules: rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — get_farm_context -------------------------------------------------------
  server.registerTool(
    "get_farm_context",
    {
      title: "Contexto de la finca",
      description:
        "Identidad de la finca desde la DB (única fuente de verdad): nombre, zona, coordenadas, timezone IANA y módulos con su cultivo. El cerebro es agnóstico al lugar — DEBE obtener este contexto antes de reportar; si falta un campo, lo declara (no lo inventa).",
      inputSchema: {
        tenant: z.string().optional().describe("Tenant; si se omite y solo hay uno, se usa ese"),
      },
    },
    async ({ tenant }) => {
      let t = tenant;
      if (!t) {
        const all = await listModulesDb();
        const tenants = [...new Set(all.map((m) => m.tenant))];
        if (tenants.length !== 1) {
          return {
            content: [{ type: "text", text: `tenant requerido — existen ${tenants.length}: ${tenants.join(", ")}` }],
            structuredContent: { found: false, tenants } as unknown as Record<string, unknown>,
          };
        }
        t = tenants[0];
      }
      const farm = await getFarmContextDb(t);
      if (!farm) {
        return {
          content: [{ type: "text", text: `Finca no encontrada: ${t}` }],
          structuredContent: { found: false, tenant: t } as unknown as Record<string, unknown>,
        };
      }
      const modules = await listModulesDb(t);
      // Honestidad (ADR-0010): campos ausentes se reportan como null, nunca inventados
      const missing = (["location_name", "lat", "lon", "tz"] as const).filter((k) => farm[k] === null);
      const context = {
        tenant: farm.tenant,
        farm_name: farm.name,
        location: { name: farm.location_name, lat: farm.lat, lon: farm.lon, tz: farm.tz },
        modules: modules.map((m) => ({ id: m.id, name: m.name, crop: m.crop, retired: m.retired_at !== null })),
        missing,
      };
      const text = `Finca ${farm.name} (${farm.tenant})` + (missing.length ? ` — campos ausentes: ${missing.join(", ")}` : "");
      return {
        content: [{ type: "text", text: `${text}\n${summaryText(context)}` }],
        structuredContent: { found: true, ...context } as unknown as Record<string, unknown>,
      };
    },
  );

  // — get_crop_profile -------------------------------------------------------
  server.registerTool(
    "get_crop_profile",
    {
      title: "Perfil de cultivo",
      description: "Obtiene el perfil de cultivo por nombre (rangos ec/ph/temp y notas).",
      inputSchema: {
        name: z.string().describe("Nombre del cultivo, ej. lechuga, tomate"),
      },
    },
    async ({ name }) => {
      const row = await getCropProfileDb(name);
      if (!row) {
        const text = `Perfil no encontrado: ${name}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { found: false, name } as unknown as Record<string, unknown>,
        };
      }
      return {
        content: [{ type: "text", text: `Perfil ${name}\n${summaryText(row)}` }],
        structuredContent: { found: true, profile: row } as unknown as Record<string, unknown>,
      };
    },
  );

  // — latest_readings --------------------------------------------------------
  server.registerTool(
    "latest_readings",
    {
      title: "Últimas lecturas por métrica",
      description: "Última lectura por métrica para un módulo (una fila por métrica). Ausencia de dato no se inventa.",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        module: z.string().describe("ID de módulo"),
      },
    },
    async ({ tenant, module }) => {
      const rows = await latestReadingsDb(tenant, module);
      const text = `Últimas lecturas ${tenant}/${module}: ${rows.length} métricas`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText(rows)}` }],
        structuredContent: { tenant, module, readings: rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — telemetry_range --------------------------------------------------------
  server.registerTool(
    "telemetry_range",
    {
      title: "Rango de telemetría",
      description: "Telemetría por métrica en ventana temporal (limit <=500).",
      inputSchema: {
        tenant: z.string(),
        module: z.string(),
        metric: z.string().describe("Métrica: ec, ph, temp, level, flow, air_temp, humidity, photo"),
        from: z.string().describe("ISO 8601 inicio"),
        to: z.string().describe("ISO 8601 fin"),
        limit: z.number().int().min(1).max(500).optional().describe("Máximo filas (default 100, max 500)"),
      },
    },
    async ({ tenant, module, metric, from, to, limit }) => {
      const lim = limit ?? 100;
      const rows = await telemetryRangeDb(tenant, module, metric, new Date(from), new Date(to), lim);
      const text = `Telemetría ${tenant}/${module} ${metric} ${from}→${to}: ${rows.length} filas`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText(rows)}` }],
        structuredContent: { tenant, module, metric, rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — module_confidence ------------------------------------------------------
  server.registerTool(
    "module_confidence",
    {
      title: "Confianza por módulo",
      description: "Última confianza (termómetro global) por módulo. Fuentes desglosadas.",
      inputSchema: {
        tenant: z.string().optional(),
        module: z.string().optional(),
      },
    },
    async ({ tenant, module }) => {
      const rows = await moduleConfidenceDb(tenant, module);
      const text = `Confianza${tenant ? ` tenant=${tenant}` : ""}${module ? ` module=${module}` : ""}: ${rows.length} módulos`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText(rows)}` }],
        structuredContent: { rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — recent_alerts ----------------------------------------------------------
  server.registerTool(
    "recent_alerts",
    {
      title: "Alertas recientes",
      description: "Alertas recientes del watchdog (silence/frozen/impossible/offline/blind). Ventana en horas.",
      inputSchema: {
        tenant: z.string().optional(),
        hours: z.number().min(1).max(720).optional().describe("Horas hacia atrás (default 24)"),
      },
    },
    async ({ tenant, hours }) => {
      const h = hours ?? 24;
      const rows = await recentAlertsDb(tenant, h);
      const text = `Alertas últimas ${h}h${tenant ? ` tenant=${tenant}` : ""}: ${rows.length}`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText(rows)}` }],
        structuredContent: { hours: h, rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — daily_report_data ------------------------------------------------------
  server.registerTool(
    "daily_report_data",
    {
      title: "Datos del reporte diario",
      description:
        "Construye DailyReportData puro para un tenant y fecha (YYYY-MM-DD). Sin fecha: usa el día del último dato disponible (reloj de los datos, no del servidor). Usa telemetry/confidence/alerts de DB y delega el shaping a buildDailyReportData (honestidad: missing sin inventar valores).",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        date: z.string().optional().describe("Fecha YYYY-MM-DD; default = día del último dato"),
      },
    },
    async ({ tenant, date }) => {
      // Sin fecha explícita: usar el día del ÚLTIMO dato disponible (max(time)),
      // no la fecha del reloj real. En campaña acelerada el reloj sim corre
      // adelantado/atrás; el reporte debe seguir el reloj de los DATOS.
      const day = date ?? (await latestTelemetryDateDb(tenant)) ?? new Date().toISOString().slice(0, 10);
      const modules = await listModulesDb(tenant);
      // Perfiles para los crops de esos módulos (null = mesa libre sin lote, ADR-0025 → sin perfil)
      const crops = [...new Set(modules.map((m) => m.crop).filter((c): c is string => c !== null && c !== undefined))];
      const profiles = new Map<string, { ec_min: number; ec_max: number; ph_min: number; ph_max: number; water_temp_min: number; water_temp_max: number; notes?: string }>();
      for (const c of crops) {
        const p = await getCropProfileDb(c);
        if (p) {
          profiles.set(c, {
            ec_min: p.ec_min as number,
            ec_max: p.ec_max as number,
            ph_min: p.ph_min as number,
            ph_max: p.ph_max as number,
            water_temp_min: p.water_temp_min as number,
            water_temp_max: p.water_temp_max as number,
            notes: p.notes as string | undefined,
          });
        }
      }
      const telemetry = await telemetryForDateDb(tenant, day);
      const alerts = await alertsForDateDb(tenant, day);
      const confidence = await confidenceForDateDb(tenant);
      const farm = await getFarmContextDb(tenant);
      const nowMs = Date.now();
      // Reloj efectivo del reporte = max(reloj servidor, último dato). En campaña
      // acelerada el reloj sim corre adelantado: sin esto ageMinutes sale negativo.
      // Sim detenido: domina el reloj servidor → las edades crecen (honesto).
      const dataMaxMs = telemetry.reduce((acc, r) => Math.max(acc, new Date(r.time).getTime()), 0);
      const effectiveNowMs = Math.max(nowMs, dataMaxMs);
      const data = buildDailyReportData({
        date: day,
        farm: farm
          ? { tenant: farm.tenant, name: farm.name, location_name: farm.location_name, lat: farm.lat, lon: farm.lon, tz: farm.tz }
          : null,
        modules: modules.map((m) => ({ tenant: m.tenant, id: m.id, name: m.name, crop: m.crop, retired: m.retired_at !== null })),
        profiles,
        telemetry: telemetry.map((r) => ({
          tenant: r.tenant,
          module: r.module,
          device: r.device,
          metric: r.metric,
          value: r.value,
          time: r.time,
        })),
        confidence,
        alerts: alerts.map((a) => ({
          time: a.time,
          tenant: a.tenant,
          module: a.module,
          name: a.name,
          severity: a.severity,
          device: a.device,
          // detail llega TEXT (JSON serializado); parse defensivo
          detail: typeof a.detail === "string" ? (() => { try { return JSON.parse(a.detail as string); } catch { return a.detail; } })() : a.detail,
        })),
        nowMs: effectiveNowMs,
      });
      const summary = `Reporte ${tenant} ${day}: ${data.modules.length} módulos, ${telemetry.length} filas telemetría, ${alerts.length} alertas`;
      return {
        content: [{ type: "text", text: `${summary}\n${summaryText(data)}` }],
        structuredContent: data as unknown as Record<string, unknown>,
      };
    },
  );

  // — open_batch (ADR-0024) --------------------------------------------------
  server.registerTool(
    "open_batch",
    {
      title: "Abrir lote de producción",
      description: "Abre un lote: cultivo + módulos EXPLÍCITOS + etiqueta de campaña opcional. Regla física: un módulo solo está en UN lote activo; los módulos son infraestructura fungible (ADR-0025) — cualquier módulo libre acepta cualquier cultivo, y al abrir el lote el cultivo queda escrito en los módulos (caché); módulos retirados no entran. Fechas gobernadas por el humano (ADR-0026): started_at elegible (pasada = registro tardío, futura = programación; default ahora) y expected_end_at con override manual (default started_at + cycle_days del perfil, null si el perfil no tiene ciclo). Un lote con inicio futuro ocupa sus mesas desde ya. Calcula profile_hash (sha256 del row crop_profiles) y memory_hash (sha256 de $WORKSPACES_PATH/experto-<crop>/MEMORY.md, null si ausente).",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        crop: z.string().describe("Cultivo/programa (crop_profiles.name)"),
        modules: z.array(z.string()).min(1).describe("Módulos que ocupa el lote (mod-N) — explícitos, uno o varios, deben estar libres"),
        campaign: z.string().optional().describe("Etiqueta lógica libre de temporada, ej 'invierno-2026' (null = sin campaña)"),
        note: z.string().optional().describe("Nota opcional de apertura"),
        started_at: z.string().optional().describe("Inicio del ciclo ISO (ADR-0026): pasada = registro tardío, futura = programación. Default: ahora"),
        expected_end_at: z.string().optional().describe("Override manual de la cosecha esperada ISO (ADR-0026). Default: started_at + cycle_days del perfil"),
      },
    },
    async ({ tenant, crop, modules, campaign, note, started_at, expected_end_at }) => {
      const profile = await getCropProfileDb(crop);
      if (!profile) {
        return {
          content: [{ type: "text", text: `crop no existe: ${crop}` }],
          structuredContent: { error: "crop_not_found", crop } as unknown as Record<string, unknown>,
        };
      }
      // Validar cada módulo: existe y no está retirado (el cultivo es fungible — ADR-0025)
      for (const moduleId of modules) {
        const mod = await getModuleDb(tenant, moduleId);
        if (!mod) {
          return {
            content: [{ type: "text", text: `módulo no existe: ${tenant}/${moduleId}` }],
            structuredContent: { error: "module_not_found", tenant, module: moduleId } as unknown as Record<string, unknown>,
          };
        }
        if (mod.retired_at) {
          return {
            content: [{ type: "text", text: `módulo retirado no entra en lotes: ${moduleId}` }],
            structuredContent: { error: "module_retired", tenant, module: moduleId } as unknown as Record<string, unknown>,
          };
        }
      }
      // Regla física: un módulo, un lote activo
      const occupied = await getOccupiedModulesDb(tenant, modules);
      if (occupied.length > 0) {
        return {
          content: [{ type: "text", text: `módulos ocupados por lotes activos: ${occupied.map((o) => o.code).join(", ")} — cierra esos lotes primero` }],
          structuredContent: { error: "modules_occupied", tenant, occupied_by: occupied.map((o) => o.code) } as unknown as Record<string, unknown>,
        };
      }
      // ADR-0026: fechas gobernadas por el humano — inicio elegible, fin con override
      const startedAt = started_at ? new Date(started_at) : new Date();
      if (Number.isNaN(+startedAt)) {
        return {
          content: [{ type: "text", text: `started_at inválido: ${started_at}` }],
          structuredContent: { error: "invalid_started_at", started_at } as unknown as Record<string, unknown>,
        };
      }
      const overrideEnd = expected_end_at ? new Date(expected_end_at) : null;
      if (overrideEnd && Number.isNaN(+overrideEnd)) {
        return {
          content: [{ type: "text", text: `expected_end_at inválido: ${expected_end_at}` }],
          structuredContent: { error: "invalid_expected_end_at", expected_end_at } as unknown as Record<string, unknown>,
        };
      }
      if (overrideEnd && +overrideEnd <= +startedAt) {
        return {
          content: [{ type: "text", text: `expected_end_at (${overrideEnd.toISOString()}) debe ser posterior a started_at (${startedAt.toISOString()})` }],
          structuredContent: { error: "end_before_start", started_at: startedAt, expected_end_at: overrideEnd } as unknown as Record<string, unknown>,
        };
      }
      const cycleDays = (profile as Record<string, unknown>).cycle_days as number | null;
      const expectedEndAt = computeExpectedEnd(startedAt, cycleDays, overrideEnd);
      const profileHash = computeProfileHash(profile as Record<string, unknown>);
      const memoryHash = await computeMemoryHash(crop);
      const { id, code } = await insertBatchDb({
        tenant, crop, campaign: campaign ?? null, modulesJson: JSON.stringify(modules),
        startedAt, expectedEndAt, profileHash, memoryHash, note: note ?? null,
      });
      // ADR-0025: el lote pone el cultivo en las mesas que ocupa (caché; única escritora)
      await setModulesCropDb(tenant, modules, crop);
      const text = `Lote abierto ${code} (${id}) tenant=${tenant} crop=${crop} modules=${modules.join(",")}${campaign ? ` campaña='${campaign}'` : ""} inicio=${startedAt.toISOString()}${expectedEndAt ? ` cosecha=${expectedEndAt.toISOString()}` : ""} profile_hash=${profileHash.slice(0, 8)}…`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText({ id, code, tenant, crop, campaign, modules, started_at: startedAt, expected_end_at: expectedEndAt, profile_hash: profileHash, memory_hash: memoryHash })}` }],
        structuredContent: { id, code, tenant, crop, campaign: campaign ?? null, modules, started_at: startedAt, expected_end_at: expectedEndAt, profile_hash: profileHash, memory_hash: memoryHash } as unknown as Record<string, unknown>,
      };
    },
  );

  // — close_batch (ADR-0024) ---------------------------------------------------
  server.registerTool(
    "close_batch",
    {
      title: "Cerrar lote de producción",
      description: "Cierra un lote activo con razón (cosecha|venta|perdida|otro) — la razón alimenta el margen y el aprendizaje entre ciclos. Calcula memory_hash_close (sha256 de MEMORY.md al cerrar). Error si no existe o ya está cerrado.",
      inputSchema: {
        id: z.string().uuid().describe("Id del lote"),
        reason: z.enum(["cosecha", "venta", "perdida", "otro"]).describe("Razón de cierre"),
        yield_kg: z.number().min(0).optional().describe("Kg cosechados (null honesto si no hay báscula) — habilita costo-por-kg"),
        note: z.string().optional().describe("Nota opcional de cierre"),
      },
    },
    async ({ id, reason, yield_kg, note }) => {
      const batch = await getBatchDb(id);
      if (!batch) {
        return {
          content: [{ type: "text", text: `lote no existe: ${id}` }],
          structuredContent: { error: "batch_not_found", id } as unknown as Record<string, unknown>,
        };
      }
      if (batch.state !== "open") {
        return {
          content: [{ type: "text", text: `lote ya cerrado: ${batch.code} (${batch.closed_at?.toISOString()})` }],
          structuredContent: { error: "batch_already_closed", id, code: batch.code } as unknown as Record<string, unknown>,
        };
      }
      const memoryHashClose = await computeMemoryHash(batch.crop);
      const row = await closeBatchDb(id, reason, memoryHashClose, note ?? null, yield_kg ?? null);
      // ADR-0025: al cerrar, las mesas vuelven a estar libres (sin cultivo)
      await setModulesCropDb(batch.tenant, (batch.modules as unknown as string[]) ?? [], null);
      const text = `Lote cerrado ${row?.code ?? id} razón=${reason}`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText({ id, code: row?.code, closed_at: row?.closed_at, close_reason: reason, yield_kg: yield_kg ?? null, memory_hash_close: memoryHashClose })}` }],
        structuredContent: { id, code: row?.code, closed_at: row?.closed_at, close_reason: reason, yield_kg: yield_kg ?? null, memory_hash_close: memoryHashClose } as unknown as Record<string, unknown>,
      };
    },
  );

  // — remove_module_from_batch (ADR-0026) --------------------------------------
  server.registerTool(
    "remove_module_from_batch",
    {
      title: "Retirar módulo de un lote",
      description: "Saca un módulo de un lote activo SIN cerrarlo — el lote sigue con las mesas restantes (ej: cambiar de cultivo en una sola mesa). La mesa retirada queda libre (crop null). Regla dura: la última mesa no se retira — un lote sin mesas no existe; usa close_batch.",
      inputSchema: {
        id: z.string().uuid().describe("Id del lote"),
        module: z.string().describe("Módulo a retirar (mod-N)"),
      },
    },
    async ({ id, module }) => {
      const batch = await getBatchDb(id);
      if (!batch) {
        return {
          content: [{ type: "text", text: `lote no existe: ${id}` }],
          structuredContent: { error: "batch_not_found", id } as unknown as Record<string, unknown>,
        };
      }
      if (batch.state !== "open") {
        return {
          content: [{ type: "text", text: `lote ya cerrado: ${batch.code}` }],
          structuredContent: { error: "batch_already_closed", id, code: batch.code } as unknown as Record<string, unknown>,
        };
      }
      const check = canRemoveModuleFromBatch(batch.modules, module);
      if (!check.ok) {
        const text = check.reason === "last_module"
          ? `${module} es la última mesa de ${batch.code} — un lote sin mesas no existe: usa close_batch`
          : `${module} no está en el lote ${batch.code}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { error: check.reason, id, code: batch.code, module } as unknown as Record<string, unknown>,
        };
      }
      const row = await removeModuleFromBatchDb(id, JSON.stringify(check.remaining));
      // La mesa retirada vuelve a estar libre (caché ADR-0025)
      await setModulesCropDb(batch.tenant, [module], null);
      const text = `Módulo ${module} retirado de ${row?.code ?? id} — quedan: ${check.remaining.join(", ")}`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText({ id, code: row?.code, removed: module, remaining: check.remaining })}` }],
        structuredContent: { id, code: row?.code, removed: module, remaining: check.remaining } as unknown as Record<string, unknown>,
      };
    },
  );

  // — list_batches (ADR-0024) --------------------------------------------------
  server.registerTool(
    "list_batches",
    {
      title: "Lotes de producción",
      description: "Lista lotes (activos primero), filtrable por tenant y estado. La campaña es etiqueta lógica — agrupa en reportes, no gobierna.",
      inputSchema: {
        tenant: z.string().optional().describe("Tenant; si se omite lista todas las fincas"),
        state: z.enum(["open", "closed"]).optional().describe("Filtrar por estado"),
      },
    },
    async ({ tenant, state }) => {
      const rows = await listBatchesDb(tenant, state);
      const text = `Lotes${tenant ? ` tenant=${tenant}` : ""}${state ? ` state=${state}` : ""}: ${rows.length}`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText(rows)}` }],
        structuredContent: { lotes: rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — resolve_alert ----------------------------------------------------------
  server.registerTool(
    "resolve_alert",
    {
      title: "Resolver alerta invariante",
      description: "Inserta una resolución manual en alert_resolutions para silenciar una alerta invariante. Matching por alert_name + module/fingerprint opcionales.",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        alert_name: z.string().describe("Nombre de la alerta (cmd_sin_policy, invariant_ledger, budget_tokens)"),
        module: z.string().optional().describe("Módulo específico; si se omite aplica a todos los módulos del tenant"),
        fingerprint: z.string().optional().describe("Fingerprint específico; si se omite aplica a todos los fingerprints"),
        note: z.string().optional().describe("Nota de resolución"),
        resolved_by: z.string().optional().describe("Quién resuelve (default human)"),
      },
    },
    async ({ tenant, alert_name, module, fingerprint, note, resolved_by }) => {
      const id = await insertResolutionDb(tenant, alert_name, module ?? null, fingerprint ?? null, note ?? null, resolved_by ?? "human");
      const text = `Resolución ${id} tenant=${tenant} alert=${alert_name}`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText({ id, tenant, alert_name, module: module ?? null, fingerprint: fingerprint ?? null })}` }],
        structuredContent: { id, tenant, alert_name, module: module ?? null, fingerprint: fingerprint ?? null } as unknown as Record<string, unknown>,
      };
    },
  );

  // — list_invariant_alerts --------------------------------------------------
  server.registerTool(
    "list_invariant_alerts",
    {
      title: "Alertas invariantes",
      description: "Lista alertas invariantes (cmd_sin_policy, invariant_ledger, budget_tokens) con estado is_open según regla de resolución (alerta posterior resolved mismo fingerprint o fila en alert_resolutions).",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        only_open: z.boolean().optional().describe("Si true, solo alertas abiertas"),
      },
    },
    async ({ tenant, only_open }) => {
      const rows = await listInvariantAlertsDb(tenant, !!only_open);
      const text = `Alertas invariantes tenant=${tenant}${only_open ? " (solo abiertas)" : ""}: ${rows.length}`;
      return {
        content: [{ type: "text", text: `${text}\n${summaryText(rows)}` }],
        structuredContent: { tenant, only_open: !!only_open, alerts: rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — create_module ----------------------------------------------------------
  server.registerTool(
    "create_module",
    {
      title: "Crear módulo",
      description:
        "Crea un módulo (mesa, infraestructura fungible — ADR-0025) con id técnico autogenerado mod-N y nombre humano libre. Nace LIBRE (sin cultivo): el cultivo lo pone el lote al abrirse (open_batch). Nace sin fierro: vincular luego con claim_device.",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        name: z.string().min(1).describe("Nombre humano del módulo (ej: 'Mesa Norte')"),
      },
    },
    async ({ tenant, name }) => {
      const row = await insertModuleDb(tenant, name);
      await publishModuleMeta(tenant, row.id, "module_created");
      return {
        content: [{ type: "text", text: `Módulo creado ${row.id} "${name}" tenant=${tenant} — libre, sin cultivo hasta que un lote lo ocupe\n${summaryText(row)}` }],
        structuredContent: { module: row } as unknown as Record<string, unknown>,
      };
    },
  );

  // — create_crop_profile (ADR-0025, regla 9: solo humano vía PWA) ------------
  const profileFields = {
    ec_min: z.number().describe("EC mínima (mS/cm)"),
    ec_max: z.number().describe("EC máxima (mS/cm)"),
    ph_min: z.number().describe("pH mínimo"),
    ph_max: z.number().describe("pH máximo"),
    water_temp_min: z.number().describe("Temperatura mínima del agua (°C)"),
    water_temp_max: z.number().describe("Temperatura máxima del agua (°C)"),
    cycle_days: z.number().int().positive().optional().describe("Duración del ciclo trasplante→cosecha en días (null = sin estimación; el lote queda sin fin esperado)"),
    notes: z.string().optional().describe("Notas del perfil (receta, observaciones)"),
  };
  server.registerTool(
    "create_crop_profile",
    {
      title: "Crear perfil de cultivo",
      description:
        "Crea un perfil de cultivo (la receta biológica: rangos EC/pH/temperatura de agua + días de ciclo). name = slug inmutable (especie o especie_variedad, ej 'lechuga'/'lechuga_romana'). Solo humano (regla 9) — el LLM jamás crea ni edita rangos biológicos.",
      inputSchema: {
        name: z.string().describe("Slug del cultivo (minúsculas, ej 'lechuga')"),
        ...profileFields,
      },
    },
    async (input) => {
      if (!isValidCropName(input.name)) {
        return {
          content: [{ type: "text", text: `name inválido: '${input.name}' — slug minúscula con guiones bajos (especie o especie_variedad)` }],
          structuredContent: { error: "invalid_name", name: input.name } as unknown as Record<string, unknown>,
        };
      }
      if (!isValidProfileRanges(input)) {
        return {
          content: [{ type: "text", text: "rangos incoherentes: min < max en EC/pH/temperatura, pH entre 0 y 14" }],
          structuredContent: { error: "invalid_ranges" } as unknown as Record<string, unknown>,
        };
      }
      const row = await insertCropProfileDb({
        name: input.name, ec_min: input.ec_min, ec_max: input.ec_max,
        ph_min: input.ph_min, ph_max: input.ph_max,
        water_temp_min: input.water_temp_min, water_temp_max: input.water_temp_max,
        cycle_days: input.cycle_days ?? null, notes: input.notes ?? null,
      });
      if (!row) {
        return {
          content: [{ type: "text", text: `perfil ya existe: ${input.name} — usa update_crop_profile` }],
          structuredContent: { error: "profile_exists", name: input.name } as unknown as Record<string, unknown>,
        };
      }
      return {
        content: [{ type: "text", text: `Perfil creado '${row.name}' EC ${row.ec_min}-${row.ec_max}, pH ${row.ph_min}-${row.ph_max}, ${row.cycle_days ?? "?"}d\n${summaryText(row)}` }],
        structuredContent: { profile: row } as unknown as Record<string, unknown>,
      };
    },
  );

  // — update_crop_profile (ADR-0025, regla 9) ---------------------------------
  server.registerTool(
    "update_crop_profile",
    {
      title: "Editar perfil de cultivo",
      description:
        "Edita rangos/ciclo/notas de un perfil existente. name es inmutable (los lotes hashean el perfil al abrir — el historial no se reescribe). Solo humano (regla 9).",
      inputSchema: {
        name: z.string().describe("Slug del cultivo a editar"),
        ec_min: z.number().optional(), ec_max: z.number().optional(),
        ph_min: z.number().optional(), ph_max: z.number().optional(),
        water_temp_min: z.number().optional(), water_temp_max: z.number().optional(),
        cycle_days: z.number().int().positive().nullable().optional(),
        notes: z.string().nullable().optional(),
      },
    },
    async ({ name, ...fields }) => {
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(clean).length === 0) {
        return {
          content: [{ type: "text", text: "nada que actualizar: pasa al menos un campo" }],
          structuredContent: { error: "no_fields", name } as unknown as Record<string, unknown>,
        };
      }
      const current = await getCropProfileDb(name);
      if (!current) {
        return {
          content: [{ type: "text", text: `perfil no existe: ${name}` }],
          structuredContent: { error: "profile_not_found", name } as unknown as Record<string, unknown>,
        };
      }
      // Validar coherencia del RESULTADO (merge actual + cambios), no solo de los campos dados
      const merged = { ...current, ...clean } as { ec_min: number; ec_max: number; ph_min: number; ph_max: number; water_temp_min: number; water_temp_max: number };
      if (!isValidProfileRanges(merged)) {
        return {
          content: [{ type: "text", text: "el resultado sería incoherente: min < max en EC/pH/temperatura, pH entre 0 y 14" }],
          structuredContent: { error: "invalid_ranges", name } as unknown as Record<string, unknown>,
        };
      }
      const row = await updateCropProfileDb(name, clean);
      return {
        content: [{ type: "text", text: `Perfil '${name}' actualizado\n${summaryText(row)}` }],
        structuredContent: { profile: row } as unknown as Record<string, unknown>,
      };
    },
  );

  // — update_module ----------------------------------------------------------
  server.registerTool(
    "update_module",
    {
      title: "Actualizar módulo",
      description:
        "Renombra un módulo. Reglas: módulo retirado no se edita. El cultivo NO se edita aquí (ADR-0025): es caché del ciclo del lote — lo escribe open_batch y lo limpia close_batch. Al renombrar, el router refresca el nombre/área en Home Assistant.",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        module: z.string().describe("Id técnico del módulo (mod-N)"),
        name: z.string().min(1).describe("Nuevo nombre humano"),
      },
    },
    async ({ tenant, module: moduleId, name }) => {
      const mod = await getModuleDb(tenant, moduleId);
      if (!mod) {
        return {
          content: [{ type: "text", text: `módulo no existe: ${tenant}/${moduleId}` }],
          structuredContent: { error: "module_not_found", tenant, module: moduleId } as unknown as Record<string, unknown>,
        };
      }
      if (mod.retired_at) {
        return {
          content: [{ type: "text", text: `módulo retirado (${mod.retired_at.toISOString()}) — no se edita` }],
          structuredContent: { error: "module_retired", tenant, module: moduleId } as unknown as Record<string, unknown>,
        };
      }
      const row = await updateModuleDb(tenant, moduleId, { name });
      await publishModuleMeta(tenant, moduleId, "module_updated");
      return {
        content: [{ type: "text", text: `Módulo ${moduleId} renombrado a "${name}"\n${summaryText(row)}` }],
        structuredContent: { module: row } as unknown as Record<string, unknown>,
      };
    },
  );

  // — retire_module ----------------------------------------------------------
  server.registerTool(
    "retire_module",
    {
      title: "Retirar módulo",
      description:
        "Retira un módulo (retired_at). NADA se borra (ADR-0011 aplicado a dominio): conserva telemetría, alertas e historia financiera. Deja de aceptar telemetría/claiming y sale de HA. Bloqueado si está en un lote activo (ADR-0024).",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        module: z.string().describe("Id técnico del módulo (mod-N)"),
      },
    },
    async ({ tenant, module: moduleId }) => {
      const mod = await getModuleDb(tenant, moduleId);
      if (!mod) {
        return {
          content: [{ type: "text", text: `módulo no existe: ${tenant}/${moduleId}` }],
          structuredContent: { error: "module_not_found", tenant, module: moduleId } as unknown as Record<string, unknown>,
        };
      }
      if (mod.retired_at) {
        return {
          content: [{ type: "text", text: `módulo ya retirado (${mod.retired_at.toISOString()})` }],
          structuredContent: { error: "module_already_retired", tenant, module: moduleId } as unknown as Record<string, unknown>,
        };
      }
      const batch = await getOpenBatchWithModuleDb(tenant, moduleId);
      if (batch) {
        const text = `retiro bloqueado: ${moduleId} está en el lote activo ${batch.code} — cierra el lote primero`;
        return {
          content: [{ type: "text", text }],
          structuredContent: { error: "module_in_open_batch", tenant, module: moduleId, batch_id: batch.id, code: batch.code } as unknown as Record<string, unknown>,
        };
      }
      const row = await retireModuleDb(tenant, moduleId);
      await publishModuleMeta(tenant, moduleId, "module_retired");
      return {
        content: [{ type: "text", text: `Módulo ${moduleId} retirado\n${summaryText(row)}` }],
        structuredContent: { module: row } as unknown as Record<string, unknown>,
      };
    },
  );

  // — claim_device -----------------------------------------------------------
  server.registerTool(
    "claim_device",
    {
      title: "Vincular fierro a módulo",
      description:
        "Claiming (ADR-0015/0022): asocia un hw_id (12 hex minúsculas, MAC sin dos puntos) a un módulo activo. Desde ahí el router traduce su telemetría al plano interno y publica su discovery en HA. Un hw_id solo puede claimearse una vez; un módulo acepta UN fierro activo.",
      inputSchema: {
        tenant: z.string().describe("Tenant"),
        module: z.string().describe("Id técnico del módulo (mod-N)"),
        hw_id: z.string().describe("Id de fábrica del ESP32: 12 hex minúsculas"),
        claimed_by: z.string().optional().describe("Quién claimea (default pwa)"),
      },
    },
    async ({ tenant, module: moduleId, hw_id, claimed_by }) => {
      if (!isValidHwId(hw_id)) {
        return {
          content: [{ type: "text", text: `hw_id inválido: "${hw_id}" — se esperan 12 hex minúsculas (ej: 020000000005)` }],
          structuredContent: { error: "invalid_hw_id", hw_id } as unknown as Record<string, unknown>,
        };
      }
      const mod = await getModuleDb(tenant, moduleId);
      if (!mod) {
        return {
          content: [{ type: "text", text: `módulo no existe: ${tenant}/${moduleId}` }],
          structuredContent: { error: "module_not_found", tenant, module: moduleId } as unknown as Record<string, unknown>,
        };
      }
      if (mod.retired_at) {
        return {
          content: [{ type: "text", text: `módulo retirado — no acepta claiming` }],
          structuredContent: { error: "module_retired", tenant, module: moduleId } as unknown as Record<string, unknown>,
        };
      }
      let claimed: boolean;
      try {
        claimed = await claimDeviceDb(hw_id, tenant, moduleId, claimed_by ?? "pwa");
      } catch (err) {
        // device_identities_one_hardware_per_module: el módulo ya tiene un fierro activo
        if ((err as { code?: string }).code === "23505") {
          return {
            content: [{ type: "text", text: `módulo ${moduleId} ya tiene un fierro vinculado — un módulo acepta UN hardware activo` }],
            structuredContent: { error: "module_already_has_hardware", tenant, module: moduleId } as unknown as Record<string, unknown>,
          };
        }
        throw err;
      }
      if (!claimed) {
        return {
          content: [{ type: "text", text: `hw_id ${hw_id} ya está claimeado — libera el anterior antes de reclaimear` }],
          structuredContent: { error: "hw_already_claimed", hw_id } as unknown as Record<string, unknown>,
        };
      }
      await publishModuleMeta(tenant, moduleId, "device_claimed");
      const text = `Fierro ${hw_id} vinculado a ${tenant}/${moduleId}`;
      return {
        content: [{ type: "text", text }],
        structuredContent: { hw_id, tenant, module: moduleId } as unknown as Record<string, unknown>,
      };
    },
  );

  // — list_tenants -----------------------------------------------------------
  server.registerTool(
    "list_tenants",
    {
      title: "Listar fincas",
      description: "Lista las fincas (tenants) registradas. Por defecto solo activas; include_archived=true incluye las archivadas.",
      inputSchema: {
        include_archived: z.boolean().optional().describe("Incluir fincas archivadas (default false)"),
      },
    },
    async ({ include_archived }) => {
      const rows = await listTenantsDb(include_archived ?? false);
      return {
        content: [{ type: "text", text: `Fincas: ${rows.length}\n${summaryText(rows)}` }],
        structuredContent: { tenants: rows } as unknown as Record<string, unknown>,
      };
    },
  );

  // — create_tenant ----------------------------------------------------------
  server.registerTool(
    "create_tenant",
    {
      title: "Crear finca",
      description:
        "Crea una finca (tenant, ADR-0023). El id es un slug elegido por el usuario (^[a-z0-9][a-z0-9-]*$), INMUTABLE: queda gravado en topics MQTT e historia. lat/lon son obligatorias (clima/ET0); la zona horaria se deriva offline de las coordenadas. La finca nace vacía: sin módulos ni telemetría.",
      inputSchema: {
        id: z.string().describe("Slug inmutable (ej: 'finca-norte') — visible en topics MQTT"),
        name: z.string().min(1).describe("Nombre humano (ej: 'Finca Norte')"),
        lat: z.number().describe("Latitud (obligatoria — clima/ET0)"),
        lon: z.number().describe("Longitud (obligatoria — clima/ET0)"),
        location_name: z.string().optional().describe("Zona humana (ej: 'Lambayeque, Perú')"),
        currency: z.string().optional().describe("Moneda ISO 4217 (default PEN)"),
      },
    },
    async ({ id, name, lat, lon, location_name, currency }) => {
      if (!isValidTenantId(id)) {
        return {
          content: [{ type: "text", text: `id inválido: "${id}" — slug minúscula ^[a-z0-9][a-z0-9-]*$ (2-48 chars), inmutable` }],
          structuredContent: { error: "invalid_tenant_id", id } as unknown as Record<string, unknown>,
        };
      }
      if (!isValidLatLon(lat, lon)) {
        return {
          content: [{ type: "text", text: `coordenadas inválidas: lat=${lat}, lon=${lon}` }],
          structuredContent: { error: "invalid_coordinates", lat, lon } as unknown as Record<string, unknown>,
        };
      }
      const cur = currency ?? "PEN";
      if (!isValidCurrency(cur)) {
        return {
          content: [{ type: "text", text: `moneda inválida: "${cur}" — ISO 4217, 3 letras mayúsculas (ej: PEN, USD)` }],
          structuredContent: { error: "invalid_currency", currency: cur } as unknown as Record<string, unknown>,
        };
      }
      let tz: string | null = null;
      try {
        tz = tzLookup(lat, lon);
      } catch {
        // coordenadas en océano o fuera de cobertura — honesto: tz null, el reporte usa UTC
        tz = null;
      }
      const row = await insertTenantDb({ id, name, location_name: location_name ?? null, lat, lon, tz, currency: cur });
      if (!row) {
        return {
          content: [{ type: "text", text: `ya existe una finca con id "${id}" — los ids no se reutilizan` }],
          structuredContent: { error: "tenant_exists", id } as unknown as Record<string, unknown>,
        };
      }
      return {
        content: [{ type: "text", text: `Finca creada: ${row.id} "${row.name}" tz=${row.tz ?? "desconocida"} currency=${row.currency}\n${summaryText(row)}` }],
        structuredContent: { tenant: row } as unknown as Record<string, unknown>,
      };
    },
  );

  // — update_tenant ----------------------------------------------------------
  server.registerTool(
    "update_tenant",
    {
      title: "Actualizar finca",
      description:
        "Actualiza campos mutables de una finca (name, location_name, lat/lon, currency). El id jamás cambia. Si cambian las coordenadas y no se pasa tz explícita, la zona horaria se re-deriva de las nuevas coordenadas.",
      inputSchema: {
        id: z.string().describe("Id de la finca (inmutable)"),
        name: z.string().min(1).optional(),
        location_name: z.string().nullable().optional(),
        lat: z.number().optional(),
        lon: z.number().optional(),
        currency: z.string().optional().describe("Moneda ISO 4217"),
      },
    },
    async ({ id, name, location_name, lat, lon, currency }) => {
      const current = await getTenantDb(id);
      if (!current) {
        return {
          content: [{ type: "text", text: `finca no existe: ${id}` }],
          structuredContent: { error: "tenant_not_found", id } as unknown as Record<string, unknown>,
        };
      }
      if (currency !== undefined && !isValidCurrency(currency)) {
        return {
          content: [{ type: "text", text: `moneda inválida: "${currency}" — ISO 4217, 3 letras mayúsculas` }],
          structuredContent: { error: "invalid_currency", currency } as unknown as Record<string, unknown>,
        };
      }
      const fields: { name?: string; location_name?: string | null; lat?: number; lon?: number; tz?: string | null; currency?: string } = {};
      if (name !== undefined) fields.name = name;
      if (location_name !== undefined) fields.location_name = location_name;
      if (currency !== undefined) fields.currency = currency;
      const coordsChanged = lat !== undefined || lon !== undefined;
      if (coordsChanged) {
        const newLat = lat ?? current.lat;
        const newLon = lon ?? current.lon;
        if (newLat === null || newLon === null || !isValidLatLon(newLat, newLon)) {
          return {
            content: [{ type: "text", text: `coordenadas inválidas: lat=${newLat}, lon=${newLon}` }],
            structuredContent: { error: "invalid_coordinates", lat: newLat, lon: newLon } as unknown as Record<string, unknown>,
          };
        }
        fields.lat = newLat;
        fields.lon = newLon;
        try {
          fields.tz = tzLookup(newLat, newLon);
        } catch {
          fields.tz = null;
        }
      }
      const row = await updateTenantDb(id, fields);
      return {
        content: [{ type: "text", text: `Finca actualizada: ${row!.id}\n${summaryText(row)}` }],
        structuredContent: { tenant: row } as unknown as Record<string, unknown>,
      };
    },
  );

  // — archive_tenant ---------------------------------------------------------
  server.registerTool(
    "archive_tenant",
    {
      title: "Archivar finca",
      description:
        "Archiva o desarchiva una finca. Archivada sale del selector de la PWA pero su historia completa queda conservada (nada se borra, ADR-0011). Sus módulos/telemetría NO se tocan.",
      inputSchema: {
        id: z.string().describe("Id de la finca"),
        archived: z.boolean().describe("true = archivar, false = desarchivar"),
      },
    },
    async ({ id, archived }) => {
      const row = await archiveTenantDb(id, archived);
      if (!row) {
        return {
          content: [{ type: "text", text: `finca no existe: ${id}` }],
          structuredContent: { error: "tenant_not_found", id } as unknown as Record<string, unknown>,
        };
      }
      return {
        content: [{ type: "text", text: `${archived ? "Finca archivada" : "Finca desarchivada"}: ${row.id} "${row.name}"` }],
        structuredContent: { tenant: row } as unknown as Record<string, unknown>,
      };
    },
  );

  return server;
}
