import { initTRPC, TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import superjson from "superjson";
import { sql } from "drizzle-orm";
import { getDb, type TerraDb } from "./db.js";
import { mqttBus, shapeConfidence, shapeHealth } from "./mqtt.js";
import type { ConfidencePayload, HealthPayload } from "./mqtt.js";
import { fetchJson, PolicyError } from "./policy.js";
import { resolveAlert, createModule, updateModule, retireModule, claimDevice, createTenant, updateTenant, archiveTenant } from "./mcpDomain.js";

// Contexto inyectable para tests
export type TrpcContext = {
  db: TerraDb;
};

const t = initTRPC.context<TrpcContext>().create({ transformer: superjson });

// Frontera cruda a drizzle: las queries usan sql`` crudo; el pool devuelve { rows }.
// Cast centralizado aquí (una vez), no inline en cada procedure.
type RawDb = { execute: (q: unknown) => Promise<{ rows: unknown[] }> };
const rawDb = (db: unknown): RawDb => db as RawDb;

export const appRouter = t.router({
  // ── SISTEMA: broker/DB/cerebro/sim ──
  system: t.router({
    status: t.procedure.query(async ({ ctx }) => {
      const dbOk = await checkDb(ctx.db);
      const mqttOk = mqttBus.isConnected();
      // Última telemetría: max(time) de telemetry
      let lastTelemetry: string | null = null;
      try {
        const res = await rawDb(ctx.db).execute(
          sql`SELECT max(time) as t FROM telemetry`
        );
        const row = (res.rows[0] as Record<string, unknown> | undefined);
        lastTelemetry = (row?.t as string) ?? null;
      } catch {
        // si no hay tabla o error, null honesto
      }
      // health agregado: contar módulos con estado
      let healthSummary: Record<string, number> = {};
      try {
        for (const [, h] of mqttBus.getLastHealth()) {
          const s = h.state;
          healthSummary[s] = (healthSummary[s] ?? 0) + 1;
        }
      } catch { /* */ }

      // La identidad de la finca NO vive aquí: plataforma ≠ finca (ADR-0023).
      // El tenant activo lo elige el usuario en el selector del header.

      return {
        broker: mqttOk ? "connected" as const : "disconnected" as const,
        db: dbOk ? "ok" as const : "error" as const,
        lastTelemetry,
        healthSummary,
        ts: Date.now()
      };
    }),

    // Salud de servicios del stack: broker, DB, portero, MCP dominio, finance, sim (lab + ctl)
    services: t.procedure.query(async ({ ctx }) => {
      const dbOk = await checkDb(ctx.db);
      const mqttOk = mqttBus.isConnected();

      type Probe = { name: string; url: string; ok: boolean | null; status: number | null; ms: number };
      async function probe(name: string, url: string, headers?: Record<string, string>): Promise<Probe> {
        const t0 = Date.now();
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          const res = await fetch(url, { signal: controller.signal, headers });
          clearTimeout(timeout);
          // Cualquier respuesta HTTP (incluso 4xx de un endpoint MCP que exige POST) prueba que el servicio vive
          return { name, url, ok: res.status < 500, status: res.status, ms: Date.now() - t0 };
        } catch {
          return { name, url, ok: false, status: null, ms: Date.now() - t0 };
        }
      }

      const probed = await Promise.all([
        probe("policy", `${process.env.POLICY_URL ?? "http://localhost:7762"}/api/approvals?tenant=demo`, {
          authorization: `Bearer ${process.env.POLICY_ADMIN_TOKEN ?? "dev-admin-token"}`
        }),
        probe("mcp-domain", process.env.MCP_DOMAIN_URL ?? "http://localhost:7760/mcp"),
        probe("finance", process.env.MCP_FINANCE_URL ?? "http://localhost:7761/mcp"),
        probe("sim-lab", process.env.SIM_LAB_URL ?? "http://localhost:7751/api/nodes")
      ]);

      return {
        broker: { ok: mqttOk },
        db: { ok: dbOk },
        services: probed,
        ts: Date.now()
      };
    })
  }),
  // ── TENANTS (fincas): gestión gobernada vía MCP dominio (ADR-0023) ──
  // ── TENANTS (fincas): gestión gobernada vía MCP dominio (ADR-0023) ──
  // Validación espejo del dominio en la frontera: un id/moneda inválido nunca llega al MCP.
  tenants: t.router({
    list: t.procedure
      .input(z.object({ includeArchived: z.boolean().optional() }).optional())
      .query(async ({ ctx, input }) => {
        try {
          const res = await rawDb(ctx.db).execute(
            sql`SELECT id, name, location_name, lat, lon, tz, currency, archived_at, created_at
                FROM tenants ${input?.includeArchived ? sql`` : sql`WHERE archived_at IS NULL`} ORDER BY id`
          );
          return res.rows as Array<{
            id: string; name: string; location_name: string | null;
            lat: number | null; lon: number | null; tz: string | null;
            currency: string; archived_at: string | null; created_at: string;
          }>;
        } catch {
          return [];
        }
      }),

    create: t.procedure
      .input(z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,31}$/, "slug: minúsculas, dígitos y guiones, 2-32 chars"),
        name: z.string().min(1),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
        location_name: z.string().optional(),
        currency: z.enum(["PEN", "USD", "EUR"]).optional()
      }))
      .mutation(async ({ input }) => createTenant(input)),

    update: t.procedure
      .input(z.object({
        id: z.string().min(1),
        name: z.string().min(1).optional(),
        location_name: z.string().nullable().optional(),
        lat: z.number().min(-90).max(90).optional(),
        lon: z.number().min(-180).max(180).optional(),
        currency: z.enum(["PEN", "USD", "EUR"]).optional()
      }))
      .mutation(async ({ input }) => updateTenant(input)),

    archive: t.procedure
      .input(z.object({ id: z.string().min(1), archived: z.boolean() }))
      .mutation(async ({ input }) => archiveTenant(input))
  }),

  // ── FARMS: resumen agregado multi-finca para el Overview en modo "Todas" (ADR-0023) ──
  farms: t.router({
    summary: t.procedure.query(async ({ ctx }) => {
      const db = rawDb(ctx.db);
      let rows: Array<{
        id: string; name: string; location_name: string | null; currency: string;
        total_modules: number; open_warn: number; open_critical: number; today_spend: string;
      }> = [];
      try {
        const res = await db.execute(sql`
          SELECT t.id, t.name, t.location_name, t.currency,
            (SELECT count(*)::int FROM modules m WHERE m.tenant = t.id AND m.retired_at IS NULL) AS total_modules,
            (SELECT count(*)::int FROM alerts a WHERE a.tenant = t.id AND a.severity = 'warn'
               AND a.time > now() - interval '24 hours'
               AND COALESCE(a.detail::jsonb ->> 'state', 'pending') <> 'resolved'
               AND NOT EXISTS (SELECT 1 FROM alert_resolutions r WHERE r.tenant = a.tenant AND r.alert_name = a.name
                  AND (r.module IS NULL OR r.module = a.module)
                  AND (r.fingerprint IS NULL OR r.fingerprint = (a.detail::jsonb ->> 'fingerprint')))) AS open_warn,
            (SELECT count(*)::int FROM alerts a WHERE a.tenant = t.id AND a.severity = 'critical'
               AND a.time > now() - interval '24 hours'
               AND COALESCE(a.detail::jsonb ->> 'state', 'pending') <> 'resolved'
               AND NOT EXISTS (SELECT 1 FROM alert_resolutions r WHERE r.tenant = a.tenant AND r.alert_name = a.name
                  AND (r.module IS NULL OR r.module = a.module)
                  AND (r.fingerprint IS NULL OR r.fingerprint = (a.detail::jsonb ->> 'fingerprint')))) AS open_critical,
            (SELECT COALESCE(SUM(amount), 0) FROM movements mv WHERE mv.tenant = t.id AND mv.kind = 'gasto'
               AND ts::date = now()::date AND voided_by IS NULL AND anula_a IS NULL) AS today_spend
          FROM tenants t WHERE t.archived_at IS NULL ORDER BY t.id
        `);
        rows = res.rows as typeof rows;
      } catch { /* lista vacía = honesto */ }

      // Confianza media por finca (vivo vía MQTT)
      const confByTenant = new Map<string, { sum: number; n: number }>();
      for (const [key, c] of mqttBus.getLastConfidence()) {
        const tenant = key.split("/")[0];
        const acc = confByTenant.get(tenant) ?? { sum: 0, n: 0 };
        acc.sum += c.v; acc.n += 1;
        confByTenant.set(tenant, acc);
      }

      return rows.map((r) => {
        const conf = confByTenant.get(r.id);
        return {
          id: r.id,
          name: r.name,
          locationName: r.location_name,
          currency: r.currency,
          totalModules: r.total_modules,
          openAlerts: { warn: r.open_warn, critical: r.open_critical },
          todaySpend: Number(r.today_spend),
          avgConfidence: conf && conf.n > 0 ? conf.sum / conf.n : null
        };
      });
    })
  }),

  // ── MÓDULOS ──
  modules: t.router({
    list: t.procedure.query(async ({ ctx }) => {
      try {
        const res = await rawDb(ctx.db).execute(
          sql`SELECT m.tenant, m.id, m.name, m.crop, m.retired_at, c.ec_min, c.ec_max, c.ph_min, c.ph_max, c.water_temp_min, c.water_temp_max
              FROM modules m LEFT JOIN crop_profiles c ON c.name = m.crop ORDER BY m.tenant, m.id`
        );
        return res.rows as Array<{
          tenant: string; id: string; name: string | null; crop: string; retired_at: string | null;
          ec_min: number | null; ec_max: number | null;
          ph_min: number | null; ph_max: number | null;
        }>;
      } catch {
        return [];
      }
    }),

    // Catálogo de cultivos para el formulario de nuevo módulo
    crops: t.procedure.query(async ({ ctx }) => {
      try {
        const res = await rawDb(ctx.db).execute(
          sql`SELECT name FROM crop_profiles ORDER BY name`
        );
        return (res.rows as Array<{ name: string }>).map((r) => r.name);
      } catch {
        return [];
      }
    }),

    // — Escrituras gobernadas vía MCP dominio (ADR-0022) —
    create: t.procedure
      .input(z.object({
        tenant: z.string().default("demo"),
        name: z.string().min(1),
        crop: z.string().min(1)
      }))
      .mutation(async ({ input }) => {
        return createModule(input);
      }),

    update: t.procedure
      .input(z.object({
        tenant: z.string().default("demo"),
        module: z.string().min(1),
        name: z.string().min(1).optional(),
        crop: z.string().min(1).optional()
      }))
      .mutation(async ({ input }) => {
        return updateModule(input);
      }),

    retire: t.procedure
      .input(z.object({ tenant: z.string().default("demo"), module: z.string().min(1) }))
      .mutation(async ({ input }) => {
        return retireModule(input);
      }),

    claim: t.procedure
      .input(z.object({
        tenant: z.string().default("demo"),
        module: z.string().min(1),
        hw_id: z.string().regex(/^[0-9a-f]{12}$/, "12 hex minúsculas")
      }))
      .mutation(async ({ input }) => {
        return claimDevice({ ...input, claimed_by: "pwa" });
      }),

    // Detalle de un módulo: ficha + perfil de cultivo + últimas lecturas + alertas recientes del módulo
    // tenant opcional (ADR-0023): si se omite busca en todas las fincas; ambiguo (mismo id en 2 fincas) → error
    detail: t.procedure
      .input(z.object({ tenant: z.string().optional(), id: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        const db = rawDb(ctx.db);
        try {
          const modRes = await db.execute(
            sql`SELECT m.tenant, m.id, m.name, m.crop, m.retired_at, m.created_at, c.ec_min, c.ec_max, c.ph_min, c.ph_max, c.water_temp_min, c.water_temp_max, c.notes AS crop_notes
                FROM modules m LEFT JOIN crop_profiles c ON c.name = m.crop
                WHERE (${input.tenant ?? null}::text IS NULL OR m.tenant = ${input.tenant ?? null}) AND m.id = ${input.id}
                ORDER BY m.tenant LIMIT 2`
          );
          if (modRes.rows.length > 1) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: `módulo ambiguo: "${input.id}" existe en varias fincas — selecciona una finca`
            });
          }
          const module = (modRes.rows[0] as Record<string, unknown> | undefined) ?? null;
          if (!module) return null;
          const tenant = module.tenant as string;

          // Fierro vinculado (claiming ADR-0015) — null honesto si el módulo no tiene hardware
          const hwRes = await db.execute(
            sql`SELECT hw_id, claimed_by, claimed_at FROM device_identities
                WHERE tenant = ${tenant} AND module = ${input.id} LIMIT 1`
          );
          const hardware = (hwRes.rows[0] as { hw_id: string; claimed_by: string | null; claimed_at: string } | undefined) ?? null;

          const readingsRes = await db.execute(
            sql`SELECT DISTINCT ON (metric) device, metric, value, time
                FROM telemetry WHERE tenant = ${tenant} AND module = ${input.id}
                ORDER BY metric, time DESC`
          );

          const alertsRes = await db.execute(
            sql`SELECT a.time, a.name, a.severity, a.device, a.detail,
                  CASE WHEN a.severity = 'info' THEN false
                       WHEN (a.detail::jsonb ->> 'state') = 'resolved' THEN false
                       WHEN EXISTS (
                         SELECT 1 FROM alert_resolutions r
                         WHERE r.tenant = a.tenant AND r.alert_name = a.name
                           AND (r.module IS NULL OR r.module = a.module)
                           AND (r.fingerprint IS NULL OR r.fingerprint = (a.detail::jsonb ->> 'fingerprint'))
                       ) THEN false
                       ELSE true END AS open
                FROM alerts a WHERE a.tenant = ${tenant} AND a.module = ${input.id}
                ORDER BY a.time DESC LIMIT 10`
          );

          const key = `${tenant}/${input.id}`;
          const confidence = mqttBus.getLastConfidence().get(key) ?? null;
          const health = mqttBus.getLastHealth().get(key) ?? null;

          return {
            module,
            hardware,
            readings: readingsRes.rows as Array<{ device: string; metric: string; value: number | null; time: string }>,
            alerts: alertsRes.rows as Array<{ time: string; name: string; severity: string; device: string | null; detail: string | null; open: boolean }>,
            confidence,
            health
          };
        } catch {
          return null;
        }
      }),

    // Suscripción: fan-out de mqtt terra/+/+/confidence
    confidence: t.procedure.subscription(() => {
      return observable<ConfidencePayload & { tenant: string; module: string }>((emit) => {
        // Emitir último valor retenido al suscribirse
        for (const v of mqttBus.getLastConfidence().values()) emit.next(v);
        const handler = (data: ConfidencePayload & { tenant: string; module: string }) => emit.next(data);
        mqttBus.on("confidence", handler);
        return () => { mqttBus.off("confidence", handler); };
      });
    }),

    health: t.procedure.subscription(() => {
      return observable<HealthPayload & { tenant: string; module: string }>((emit) => {
        for (const v of mqttBus.getLastHealth().values()) emit.next(v);
        const handler = (data: HealthPayload & { tenant: string; module: string }) => emit.next(data);
        mqttBus.on("health", handler);
        return () => { mqttBus.off("health", handler); };
      });
    })
  }),

  // ── CAMPO: última lectura por módulo ──
  field: t.router({
    latest: t.procedure
      .input(z.object({ tenant: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant;
        try {
          const res = await rawDb(ctx.db).execute(
            sql`SELECT DISTINCT ON (tenant, module, metric) tenant, module, device, metric, value, time
                FROM telemetry
                WHERE (${tenant ?? null}::text IS NULL OR tenant = ${tenant ?? null})
                ORDER BY tenant, module, metric, time DESC`
          );
          // Agrupar por finca/módulo (la clave compuesta evita mezclar mod-1 de dos fincas — ADR-0023)
          const byModule: Record<string, Record<string, { value: number | null; time: string; device: string }>> = {};
          for (const r of res.rows as Array<{ tenant: string; module: string; device: string; metric: string; value: number | null; time: string }>) {
            const key = `${r.tenant}/${r.module}`;
            if (!byModule[key]) byModule[key] = {};
            byModule[key][r.metric] = { value: r.value, time: r.time, device: r.device };
          }
          return byModule;
        } catch {
          return {};
        }
      }),

    // Serie temporal reducida para sparklines (downsample en SQL con time_bucket)
    series: t.procedure
      .input(z.object({
        tenant: z.string().default("demo"),
        module: z.string().min(1),
        metric: z.string().min(1),
        hours: z.number().min(1).max(168).default(24)
      }))
      .query(async ({ ctx, input }) => {
        try {
          const bucket = input.hours <= 24 ? "30 minutes" : "2 hours";
          const res = await rawDb(ctx.db).execute(
            sql`SELECT time_bucket(${bucket}::interval, time) AS t, avg(value) AS v
                FROM telemetry
                WHERE tenant = ${input.tenant} AND module = ${input.module} AND metric = ${input.metric}
                  AND time > now() - (${input.hours} || ' hours')::interval
                  AND value IS NOT NULL
                GROUP BY t ORDER BY t`
          );
          return (res.rows as Array<{ t: string; v: string | number }>).map((r) => ({ t: r.t, v: Number(r.v) }));
        } catch {
          return [];
        }
      })
  }),

  // ── FINANZAS: resumen del mes desde movements (SUM en SQL) ──
  finance: t.router({
    monthSummary: t.procedure
      .input(z.object({ tenant: z.string().optional(), month: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant;
        // month = YYYY-MM, default mes actual UTC
        const month = input?.month ?? new Date().toISOString().slice(0, 7);
        try {
          // Sin tenant → una fila por finca (modo "Todas", ADR-0023). Nunca se suman monedas distintas.
          const res = await rawDb(ctx.db).execute(
            sql`SELECT m.tenant, t.currency,
                  COALESCE(SUM(CASE WHEN m.kind = 'ingreso' THEN m.amount ELSE 0 END), 0) as ingresos,
                  COALESCE(SUM(CASE WHEN m.kind = 'gasto' THEN m.amount ELSE 0 END), 0) as gastos,
                  COUNT(*)::int as count
                FROM movements m
                LEFT JOIN tenants t ON t.id = m.tenant
                WHERE (${tenant ?? null}::text IS NULL OR m.tenant = ${tenant ?? null})
                  AND to_char(m.ts, 'YYYY-MM') = ${month}
                  AND m.voided_by IS NULL AND m.anula_a IS NULL
                GROUP BY m.tenant, t.currency ORDER BY m.tenant`
          );
          const byTenant = (res.rows as Array<{ tenant: string; currency: string | null; ingresos: string; gastos: string; count: number }>).map((row) => {
            const ingresos = Number(row.ingresos);
            const gastos = Number(row.gastos);
            return { tenant: row.tenant, currency: row.currency ?? "PEN", ingresos, gastos, balance: ingresos - gastos, count: row.count };
          });
          // Compat: con tenant seleccionado devuelve también el agregado plano
          const mine = tenant ? byTenant.find((r) => r.tenant === tenant) : undefined;
          return {
            month,
            ingresos: mine?.ingresos ?? 0,
            gastos: mine?.gastos ?? 0,
            balance: mine?.balance ?? 0,
            count: mine?.count ?? 0,
            empty: tenant ? (mine?.count ?? 0) === 0 : byTenant.length === 0,
            byTenant
          };
        } catch {
          return { month, ingresos: 0, gastos: 0, balance: 0, count: 0, empty: true, byTenant: [] };
        }
      }),

    // Movimientos recientes (historia inmutable: incluye anulados, se muestran como tales)
    recentMovements: t.procedure
      .input(z.object({ tenant: z.string().optional(), limit: z.number().min(1).max(100).default(30) }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant;
        const limit = input?.limit ?? 30;
        try {
          const res = await rawDb(ctx.db).execute(
            sql`SELECT id, tenant, ts, kind, amount, currency, category, note, attribution,
                       voided_by, anula_a, source, created_by
                FROM movements
                WHERE (${tenant ?? null}::text IS NULL OR tenant = ${tenant ?? null})
                ORDER BY ts DESC LIMIT ${limit}`
          );
          return res.rows as Array<{
            id: string; tenant: string; ts: string; kind: string; amount: string; currency: string;
            category: string; note: string | null; attribution: unknown;
            voided_by: string | null; anula_a: string | null;
            source: string | null; created_by: string | null;
          }>;
        } catch {
          return [];
        }
      }),

    // Gasto por categoría del mes (SUM en SQL — ADR-0011: cero aritmética en render)
    byCategory: t.procedure
      .input(z.object({ tenant: z.string().optional(), month: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant;
        const month = input?.month ?? new Date().toISOString().slice(0, 7);
        try {
          const res = await rawDb(ctx.db).execute(
            sql`SELECT m.tenant, m.category, t.currency, COALESCE(SUM(m.amount), 0) AS total
                FROM movements m
                LEFT JOIN tenants t ON t.id = m.tenant
                WHERE (${tenant ?? null}::text IS NULL OR m.tenant = ${tenant ?? null})
                  AND m.kind = 'gasto'
                  AND to_char(m.ts, 'YYYY-MM') = ${month}
                  AND m.voided_by IS NULL AND m.anula_a IS NULL
                GROUP BY m.tenant, m.category, t.currency ORDER BY m.tenant, total DESC`
          );
          return (res.rows as Array<{ tenant: string; category: string; currency: string | null; total: string }>)
            .map((r) => ({ tenant: r.tenant, category: r.category, currency: r.currency ?? "PEN", total: Number(r.total) }));
        } catch {
          return [];
        }
      })
  }),

  // ── PENDIENTES: alertas recientes + aprobaciones y órdenes (Fase 3) ──
  pending: t.router({
    alerts: t.procedure
      .input(z.object({ tenant: z.string().optional(), limit: z.number().min(1).max(50).optional().default(10) }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant;
        const limit = input?.limit ?? 10;
        try {
          const res = await rawDb(ctx.db).execute(
            sql`SELECT time, tenant, module, name, severity, device, detail
                FROM alerts
                WHERE (${tenant ?? null}::text IS NULL OR tenant = ${tenant ?? null})
                  AND severity IN ('warn','critical')
                ORDER BY time DESC LIMIT ${limit}`
          );
          return res.rows as Array<{ time: string; tenant: string; module: string; name: string; severity: string; device: string | null; detail: unknown }>;
        } catch {
          return [];
        }
      }),

    approvals: t.procedure
      .input(z.object({ tenant: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
        // Sin tenant → todas las fincas activas (ADR-0023): el portero exige tenant por llamada
        const tenants = input?.tenant ? [input.tenant] : await activeTenantIds(ctx.db);
        const all: unknown[] = [];
        for (const tenant of tenants) {
          try {
            const data = await fetchJson<{ actions: unknown[] } | unknown[]>("/api/approvals", { params: { tenant } });
            const actions = Array.isArray(data) ? data : (data?.actions ?? []);
            for (const a of actions as Array<Record<string, unknown>>) all.push({ ...a, tenant: a.tenant ?? tenant });
          } catch (err) {
            // Con tenant explícito el error sí propaga (lo ve el usuario); en modo Todas se omite la finca caída
            if (input?.tenant) {
              const msg = err instanceof PolicyError ? err.message : err instanceof Error ? err.message : String(err);
              throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
            }
          }
        }
        return all;
      }),

    decide: t.procedure
      .input(z.object({ id: z.string().min(1), decision: z.enum(["approve", "reject"]), reason: z.string().optional() }))
      .mutation(async ({ input }) => {
        const action = input.decision === "approve" ? "approve" : "reject";
        const body: Record<string, unknown> = { by: "pwa" };
        if (input.reason) body.reason = input.reason;
        try {
          const data = await fetchJson<unknown>(`/api/approvals/${encodeURIComponent(input.id)}/${action}`, {
            method: "POST",
            body,
          });
          return data;
        } catch (err) {
          const msg = err instanceof PolicyError ? err.message : err instanceof Error ? err.message : String(err);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
        }
      }),

    workOrders: t.procedure
      .input(z.object({ tenant: z.string().optional(), status: z.enum(["pending", "done", "cancelled"]).optional() }).optional())
      .query(async ({ ctx, input }) => {
        const tenants = input?.tenant ? [input.tenant] : await activeTenantIds(ctx.db);
        const status = input?.status;
        const all: unknown[] = [];
        for (const tenant of tenants) {
          try {
            const data = await fetchJson<{ orders: unknown[] } | unknown[]>("/api/work-orders", {
              params: { tenant, status },
            });
            const orders = Array.isArray(data) ? data : (data?.orders ?? []);
            for (const o of orders as Array<Record<string, unknown>>) all.push({ ...o, tenant: o.tenant ?? tenant });
          } catch (err) {
            if (input?.tenant) {
              const msg = err instanceof PolicyError ? err.message : err instanceof Error ? err.message : String(err);
              throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
            }
          }
        }
        return all;
      }),

    completeWorkOrder: t.procedure
      .input(z.object({ id: z.string().min(1), note: z.string().optional() }))
      .mutation(async ({ input }) => {
        try {
          const data = await fetchJson<unknown>(`/api/work-orders/${encodeURIComponent(input.id)}/complete`, {
            method: "POST",
            body: { by: "pwa", note: input.note },
          });
          return data;
        } catch (err) {
          const msg = err instanceof PolicyError ? err.message : err instanceof Error ? err.message : String(err);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
        }
      }),
  }),
  // ── OVERVIEW: KPIs de portada ──
  overview: t.router({
    kpis: t.procedure
      .input(z.object({ tenant: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant; // undefined = todas las fincas (ADR-0023)

        // Módulos por estado (health vivo vía MQTT) + total registrado en DB
        const byState: Record<string, number> = {};
        for (const [key, h] of mqttBus.getLastHealth()) {
          if (tenant && !key.startsWith(`${tenant}/`)) continue;
          byState[h.state] = (byState[h.state] ?? 0) + 1;
        }
        let totalModules = 0;
        let openAlerts = { warn: 0, critical: 0 };
        let todaySpend: number | null = tenant ? 0 : null;
        let campaign: { id: string; crop: string; opened_at: string } | null = null;
        let lastTelemetry: string | null = null;
        try {
          const res = await rawDb(ctx.db).execute(sql`
            SELECT
              (SELECT count(*)::int FROM modules m WHERE (${tenant ?? null}::text IS NULL OR m.tenant = ${tenant ?? null}) AND m.retired_at IS NULL) AS total_modules,
              (SELECT count(*)::int FROM alerts a WHERE (${tenant ?? null}::text IS NULL OR a.tenant = ${tenant ?? null}) AND a.severity = 'warn'
                 AND a.time > now() - interval '24 hours'
                 AND COALESCE(a.detail::jsonb ->> 'state', 'pending') <> 'resolved'
                 AND NOT EXISTS (SELECT 1 FROM alert_resolutions r WHERE r.tenant = a.tenant AND r.alert_name = a.name
                    AND (r.module IS NULL OR r.module = a.module)
                    AND (r.fingerprint IS NULL OR r.fingerprint = (a.detail::jsonb ->> 'fingerprint')))) AS open_warn,
              (SELECT count(*)::int FROM alerts a WHERE (${tenant ?? null}::text IS NULL OR a.tenant = ${tenant ?? null}) AND a.severity = 'critical'
                 AND a.time > now() - interval '24 hours'
                 AND COALESCE(a.detail::jsonb ->> 'state', 'pending') <> 'resolved'
                 AND NOT EXISTS (SELECT 1 FROM alert_resolutions r WHERE r.tenant = a.tenant AND r.alert_name = a.name
                    AND (r.module IS NULL OR r.module = a.module)
                    AND (r.fingerprint IS NULL OR r.fingerprint = (a.detail::jsonb ->> 'fingerprint')))) AS open_critical,
              (SELECT COALESCE(SUM(amount), 0) FROM movements mv WHERE (${tenant ?? null}::text IS NULL OR mv.tenant = ${tenant ?? null}) AND mv.kind = 'gasto'
                 AND ts::date = now()::date AND voided_by IS NULL AND anula_a IS NULL) AS today_spend,
              (SELECT max(time) FROM telemetry tl WHERE (${tenant ?? null}::text IS NULL OR tl.tenant = ${tenant ?? null})) AS last_telemetry
          `);
          const row = res.rows[0] as Record<string, unknown> | undefined;
          totalModules = Number(row?.total_modules ?? 0);
          openAlerts = { warn: Number(row?.open_warn ?? 0), critical: Number(row?.open_critical ?? 0) };
          // Modo Todas: sumar gastos mezclaría monedas (PEN+USD) — null honesto, el desglose vive en farms.summary
          todaySpend = tenant ? Number(row?.today_spend ?? 0) : null;
          lastTelemetry = (row?.last_telemetry as string | null) ?? null;

          // Campaña abierta: solo tiene sentido por finca; en modo Todas se reporta la primera (informativo)
          const campRes = await rawDb(ctx.db).execute(
            sql`SELECT id, tenant, crop, opened_at FROM campaigns
                WHERE (${tenant ?? null}::text IS NULL OR tenant = ${tenant ?? null}) AND state = 'open'
                ORDER BY opened_at LIMIT 1`
          );
          campaign = (campRes.rows[0] as { id: string; crop: string; opened_at: string } | undefined) ?? null;
        } catch { /* KPIs a cero = honesto */ }

        // Confianza media de módulos con dato vivo
        let confidenceSum = 0;
        let confidenceN = 0;
        for (const [key, c] of mqttBus.getLastConfidence()) {
          if (tenant && !key.startsWith(`${tenant}/`)) continue;
          confidenceSum += c.v;
          confidenceN += 1;
        }

        let pendingApprovals = 0;
        let policyReachable = true;
        try {
          const tenants = tenant ? [tenant] : await activeTenantIds(ctx.db);
          for (const tId of tenants) {
            const data = await fetchJson<{ actions?: unknown[] } | unknown[]>("/api/approvals", { params: { tenant: tId } });
            pendingApprovals += Array.isArray(data) ? data.length : (data.actions?.length ?? 0);
          }
        } catch {
          policyReachable = false;
        }

        return {
          modules: { total: totalModules, byState },
          openAlerts,
          pendingApprovals,
          policyReachable,
          todaySpend,
          avgConfidence: confidenceN > 0 ? confidenceSum / confidenceN : null,
          campaign,
          lastTelemetry,
          ts: Date.now()
        };
      })
  }),

  // ── ALERTAS: centro con estado abierto/resuelto (ADR-0021) ──
  alerts: t.router({
    list: t.procedure
      .input(z.object({
        tenant: z.string().optional(),
        limit: z.number().min(1).max(100).default(50),
        severity: z.enum(["info", "warn", "critical"]).optional(),
        onlyOpen: z.boolean().default(false)
      }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant;
        const limit = input?.limit ?? 50;
        try {
          const res = await rawDb(ctx.db).execute(sql`
            SELECT * FROM (
              SELECT a.time, a.tenant, a.module, a.name, a.severity, a.device, a.detail,
                CASE WHEN a.severity = 'info' THEN false
                     WHEN COALESCE(a.detail::jsonb ->> 'state', 'pending') = 'resolved' THEN false
                     WHEN EXISTS (
                       SELECT 1 FROM alert_resolutions r
                       WHERE r.tenant = a.tenant AND r.alert_name = a.name
                         AND (r.module IS NULL OR r.module = a.module)
                         AND (r.fingerprint IS NULL OR r.fingerprint = (a.detail::jsonb ->> 'fingerprint'))
                     ) THEN false
                     ELSE true END AS open
              FROM alerts a
              WHERE (${tenant ?? null}::text IS NULL OR a.tenant = ${tenant ?? null})
                AND (${input?.severity ?? null}::text IS NULL OR a.severity = ${input?.severity ?? null})
              ORDER BY a.time DESC LIMIT 500
            ) q
            WHERE (${input?.onlyOpen ?? false}::boolean IS FALSE OR q.open)
            ORDER BY q.time DESC LIMIT ${limit}
          `);
          const rows = (res.rows as Array<{
            time: string; tenant: string; module: string; name: string; severity: string;
            device: string | null; detail: string | null; open: boolean;
          }>).map((r) => {
            let detail: unknown = null;
            if (typeof r.detail === "string") {
              try { detail = JSON.parse(r.detail); } catch { detail = r.detail; }
            } else detail = r.detail;
            return { ...r, detail };
          });
          return rows;
        } catch {
          return [];
        }
      }),

    // Resolver alerta: escritura gobernada vía MCP de dominio (ADR-0021)
    resolve: t.procedure
      .input(z.object({
        tenant: z.string().default("demo"),
        alertName: z.string().min(1),
        module: z.string().optional(),
        fingerprint: z.string().optional(),
        note: z.string().optional()
      }))
      .mutation(async ({ input }) => {
        try {
          const data = await resolveAlert({
            tenant: input.tenant,
            alert_name: input.alertName,
            module: input.module,
            fingerprint: input.fingerprint,
            note: input.note,
            resolved_by: "pwa"
          });
          return { ok: true as const, data };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
        }
      })
  }),

  // ── CÁMARAS: último evento photo por módulo ──
  cameras: t.router({
    lastPhoto: t.procedure
      .input(z.object({ tenant: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant;
        try {
          const res = await rawDb(ctx.db).execute(
            sql`SELECT DISTINCT ON (tenant, module) tenant, module, device, metric, value, time, raw
                FROM telemetry
                WHERE (${tenant ?? null}::text IS NULL OR tenant = ${tenant ?? null}) AND metric = 'photo'
                ORDER BY tenant, module, time DESC`
          );
          const rows = res.rows as Array<{ tenant: string; module: string; device: string; time: string; raw: unknown }>;
          // Si no hay fotos, devolver vacío honesto
          if (rows.length === 0) return [];
          return rows;
        } catch {
          return [];
        }
      })
  })
});

export type AppRouter = typeof appRouter;

// helpers exportados para tests
export { shapeConfidence, shapeHealth };

async function checkDb(db: TerraDb): Promise<boolean> {
  try {
    await rawDb(db).execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}

/** Fincas activas (no archivadas) — para fan-out multi-finca cuando el tenant se omite (ADR-0023). */
async function activeTenantIds(db: TerraDb): Promise<string[]> {
  try {
    const res = await rawDb(db).execute(sql`SELECT id FROM tenants WHERE archived_at IS NULL ORDER BY id`);
    return (res.rows as Array<{ id: string }>).map((r) => r.id);
  } catch {
    return [];
  }
}
