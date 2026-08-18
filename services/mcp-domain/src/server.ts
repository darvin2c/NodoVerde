// src/server.ts — herramientas MCP read-only del dominio
// Todas leen DB vía queries SELECT y delegan shaping a funciones puras (report.ts).
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
        modules: modules.map((m) => ({ id: m.id, crop: m.crop })),
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
      // Perfiles para los crops de esos módulos
      const crops = [...new Set(modules.map((m) => m.crop))];
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
        modules: modules.map((m) => ({ tenant: m.tenant, id: m.id, crop: m.crop })),
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

  return server;
}
