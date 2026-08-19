import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { pgTable, text, doublePrecision, timestamp, uuid, numeric, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";

// Tablas existentes (solo lectura desde PWA)
export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const cropProfiles = pgTable("crop_profiles", {
  name: text("name").primaryKey(),
  ecMin: doublePrecision("ec_min").notNull(),
  ecMax: doublePrecision("ec_max").notNull(),
  phMin: doublePrecision("ph_min").notNull(),
  phMax: doublePrecision("ph_max").notNull(),
  waterTempMin: doublePrecision("water_temp_min").notNull(),
  waterTempMax: doublePrecision("water_temp_max").notNull(),
  notes: text("notes")
});

export const modules = pgTable("modules", {
  tenant: text("tenant").notNull(),
  id: text("id").notNull(),
  crop: text("crop").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const telemetry = pgTable("telemetry", {
  time: timestamp("time", { withTimezone: true }).notNull(),
  tenant: text("tenant").notNull(),
  module: text("module").notNull(),
  device: text("device").notNull(),
  metric: text("metric").notNull(),
  value: doublePrecision("value"),
  raw: jsonb("raw")
});

export const movements: unknown = pgTable("movements", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  tenant: text("tenant").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  kind: text("kind").notNull(),
  amount: numeric("amount").notNull(),
  currency: text("currency").notNull().default("PEN"),
  category: text("category"),
  attribution: jsonb("attribution"),
  evidenceUrl: text("evidence_url"),
  note: text("note"),
  anulaA: uuid("anula_a").references(() => (movements as unknown as { id: unknown }).id as never),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const alerts = pgTable("alerts", {
  time: timestamp("time", { withTimezone: true }).notNull(),
  tenant: text("tenant").notNull(),
  module: text("module").notNull(),
  name: text("name").notNull(),
  severity: text("severity").notNull(),
  device: text("device"),
  detail: jsonb("detail")
});

export const confidenceHistory = pgTable("confidence_history", {
  time: timestamp("time", { withTimezone: true }).notNull(),
  tenant: text("tenant").notNull(),
  module: text("module").notNull(),
  value: doublePrecision("value").notNull(),
  sources: jsonb("sources")
});

/** Conexión drizzle a TimescaleDB — tipo nombrado del boundary DB de la PWA */
export type TerraDb = NodePgDatabase;

let _pool: pg.Pool | null = null;
let _db: TerraDb | null = null;

export function getPool(): pg.Pool {
  if (!_pool) _pool = new pg.Pool({ connectionString: DATABASE_URL });
  return _pool;
}

export function getDb(): TerraDb {
  if (!_db) _db = drizzle(getPool());
  return _db;
}
