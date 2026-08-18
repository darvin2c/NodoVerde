import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import superjson from "superjson";
import { sql } from "drizzle-orm";
import { getDb } from "./db.js";
import { mqttBus, shapeConfidence, shapeHealth } from "./mqtt.js";
import type { ConfidencePayload, HealthPayload } from "./mqtt.js";

// Contexto inyectable para tests
export type TrpcContext = {
  db: ReturnType<typeof getDb>;
};

const t = initTRPC.context<TrpcContext>().create({ transformer: superjson });

type FarmStatus = { tenant: string; name: string; location_name: string | null; tz: string | null };

export const appRouter = t.router({
  // ── SISTEMA: broker/DB/cerebro/sim ──
  system: t.router({
    status: t.procedure.query(async ({ ctx }) => {
      const dbOk = await checkDb(ctx.db);
      const mqttOk = mqttBus.isConnected();
      // Última telemetría: max(time) de telemetry
      let lastTelemetry: string | null = null;
      try {
        const res = await (ctx.db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }).execute(
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

      // Identidad de la finca desde DB (tenants — única fuente de verdad; la PWA tampoco hardcodea lugar)
      let farm: FarmStatus | null = null;
      try {
        const res = await (ctx.db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }).execute(
          sql`SELECT id AS tenant, name, location_name, tz FROM tenants ORDER BY id LIMIT 1`
        );
        farm = (res.rows[0] as FarmStatus | undefined) ?? null;
      } catch {
        // sin tenants legible: null honesto
      }

      return {
        broker: mqttOk ? "connected" as const : "disconnected" as const,
        db: dbOk ? "ok" as const : "error" as const,
        farm,
        lastTelemetry,
        healthSummary,
        ts: Date.now()
      };
    })
  }),

  // ── MÓDULOS ──
  modules: t.router({
    list: t.procedure.query(async ({ ctx }) => {
      try {
        const res = await (ctx.db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }).execute(
          sql`SELECT m.tenant, m.id, m.crop, c.ec_min, c.ec_max, c.ph_min, c.ph_max, c.water_temp_min, c.water_temp_max
              FROM modules m LEFT JOIN crop_profiles c ON c.name = m.crop ORDER BY m.tenant, m.id`
        );
        return res.rows as Array<{
          tenant: string; id: string; crop: string;
          ec_min: number | null; ec_max: number | null;
          ph_min: number | null; ph_max: number | null;
        }>;
      } catch {
        return [];
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
      .input(z.object({ tenant: z.string().optional().default("demo") }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant ?? "demo";
        try {
          const res = await (ctx.db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }).execute(
            sql`SELECT DISTINCT ON (module, metric) module, device, metric, value, time
                FROM telemetry WHERE tenant = ${tenant}
                ORDER BY module, metric, time DESC`
          );
          // Agrupar por módulo
          const byModule: Record<string, Record<string, { value: number | null; time: string; device: string }>> = {};
          for (const r of res.rows as Array<{ module: string; device: string; metric: string; value: number | null; time: string }>) {
            if (!byModule[r.module]) byModule[r.module] = {};
            byModule[r.module][r.metric] = { value: r.value, time: r.time, device: r.device };
          }
          return byModule;
        } catch {
          return {};
        }
      })
  }),

  // ── FINANZAS: resumen del mes desde movements (SUM en SQL) ──
  finance: t.router({
    monthSummary: t.procedure
      .input(z.object({ tenant: z.string().optional().default("demo"), month: z.string().optional() }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant ?? "demo";
        // month = YYYY-MM, default mes actual UTC
        const month = input?.month ?? new Date().toISOString().slice(0, 7);
        try {
          const res = await (ctx.db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }).execute(
            sql`SELECT
                  COALESCE(SUM(CASE WHEN kind = 'ingreso' THEN amount ELSE 0 END), 0) as ingresos,
                  COALESCE(SUM(CASE WHEN kind = 'gasto' THEN amount ELSE 0 END), 0) as gastos,
                  COUNT(*)::int as count
                FROM movements
                WHERE tenant = ${tenant}
                  AND to_char(ts, 'YYYY-MM') = ${month}
                  AND voided_by IS NULL AND anula_a IS NULL`
          );
          const row = res.rows[0] as { ingresos: string; gastos: string; count: number } | undefined;
          const ingresos = Number(row?.ingresos ?? 0);
          const gastos = Number(row?.gastos ?? 0);
          const balance = ingresos - gastos;
          const empty = (row?.count ?? 0) === 0;
          return { month, ingresos, gastos, balance, count: row?.count ?? 0, empty };
        } catch {
          return { month, ingresos: 0, gastos: 0, balance: 0, count: 0, empty: true };
        }
      })
  }),

  // ── PENDIENTES: alertas recientes ──
  pending: t.router({
    alerts: t.procedure
      .input(z.object({ tenant: z.string().optional().default("demo"), limit: z.number().min(1).max(50).optional().default(10) }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant ?? "demo";
        const limit = input?.limit ?? 10;
        try {
          const res = await (ctx.db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }).execute(
            sql`SELECT time, tenant, module, name, severity, device, detail
                FROM alerts WHERE tenant = ${tenant} AND severity IN ('warn','critical')
                ORDER BY time DESC LIMIT ${limit}`
          );
          return res.rows as Array<{ time: string; tenant: string; module: string; name: string; severity: string; device: string | null; detail: unknown }>;
        } catch {
          return [];
        }
      })
  }),

  // ── CÁMARAS: último evento photo por módulo ──
  cameras: t.router({
    lastPhoto: t.procedure
      .input(z.object({ tenant: z.string().optional().default("demo") }).optional())
      .query(async ({ ctx, input }) => {
        const tenant = input?.tenant ?? "demo";
        try {
          const res = await (ctx.db as unknown as { execute: (q: unknown) => Promise<{ rows: unknown[] }> }).execute(
            sql`SELECT DISTINCT ON (module) module, device, metric, value, time, raw
                FROM telemetry WHERE tenant = ${tenant} AND metric = 'photo'
                ORDER BY module, time DESC`
          );
          const rows = res.rows as Array<{ module: string; device: string; time: string; raw: unknown }>;
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

async function checkDb(db: ReturnType<typeof getDb>): Promise<boolean> {
  try {
    await (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}
