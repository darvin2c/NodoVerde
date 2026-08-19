#!/usr/bin/env node
import mqtt from "mqtt";
import pg from "pg";
import { getEnv, logEnv } from "./env.js";
import { parseSessions, getTargetDate } from "./parser.js";
import { parsePriceTable, computeCost, formatNote } from "./pricing.js";
import { buildAttribution, fetchTenantModules, fetchAllTenants } from "./attribution.js";
import { registerMovementViaMcp } from "./financeClient.js";
import { monthStrFromDate, queryMonthSoftwareCost, decideBudgetState, shouldPublishBudgetAlert } from "./budget.js";
import { buildUnknownModelAlert, buildBudgetAlert, publishAlert } from "./alert.js";

const { Pool } = pg;

const env = getEnv();
logEnv(env);

const pool = new Pool({ connectionString: env.DATABASE_URL });
pool.on("error", (err) => console.error("[token-meter] pg pool error", err));

const mqttClient = mqtt.connect(env.MQTT_URL, {
  clientId: `terra-token-meter-${process.pid}-${Date.now()}`,
  clean: true,
});

mqttClient.on("connect", () => console.log("[token-meter] mqtt conectado", env.MQTT_URL));
mqttClient.on("reconnect", () => console.log("[token-meter] mqtt reconectando..."));
mqttClient.on("error", (err) => console.error("[token-meter] mqtt error", err));
mqttClient.on("offline", () => console.log("[token-meter] mqtt offline"));
mqttClient.on("close", () => console.log("[token-meter] mqtt cerrado"));

// Estado de budget por tenant:month -> over?
const budgetState = new Map<string, boolean>();

async function resolveTenants(): Promise<string[]> {
  if (env.TENANT) return [env.TENANT];
  const tenants = await fetchAllTenants(pool);
  if (tenants.length > 0) return tenants;
  // fallback to demo if DB empty
  return ["demo"];
}

async function settleOnce(runAt: Date): Promise<void> {
  const targetDate = getTargetDate(runAt);
  const targetMonth = targetDate.slice(0, 7); // yyyy-mm
  console.log(`[token-meter] liquidación día=${targetDate} mes=${targetMonth}`);

  let parseResult;
  try {
    parseResult = await parseSessions(env.OPENCLAW_STATE_PATH, targetDate);
  } catch (err) {
    console.error("[token-meter] error parseSessions", err);
    return;
  }
  console.log(
    `[token-meter] parse files=${parseResult.filesRead} lines=${parseResult.totalLines} broken=${parseResult.brokenLines} modelos=${parseResult.counts.size}`,
  );

  const priceTable = parsePriceTable(env.TOKEN_PRICE_TABLE_RAW);
  const { costPerModel, totalCost, unknownModels, knownCounts } = computeCost(parseResult.counts, priceTable);

  const tenants = await resolveTenants();
  console.log(`[token-meter] tenants=${tenants.join(",")} costo_total=${totalCost} unknown=${unknownModels.join(",") || "(ninguno)"}`);

  // 1) unknown_model alerts (por cada modelo sin precio)
  for (const tenant of tenants) {
    for (const model of unknownModels) {
      const alert = buildUnknownModelAlert(model);
      try {
        await publishAlert(mqttClient as unknown as Parameters<typeof publishAlert>[0], tenant, alert);
        console.log(`[token-meter] alerta unknown_model tenant=${tenant} model=${model}`);
      } catch (err) {
        console.warn(`[token-meter] error publicando unknown_model tenant=${tenant}`, err);
      }
      // También intentar publish directo por si publishAlert falla por tipado
      // (ya hecho arriba)
    }
  }

  // 2) si costo >0, registrar movimiento por cada tenant
  if (totalCost > 0 && knownCounts.size > 0) {
    for (const tenant of tenants) {
      let modules: string[] = [];
      try {
        modules = await fetchTenantModules(pool, tenant);
      } catch (err) {
        console.warn(`[token-meter] fetchTenantModules fallo tenant=${tenant}`, err);
        continue;
      }
      if (modules.length === 0) {
        console.warn(`[token-meter] sin módulos para tenant=${tenant}, skip register_movement`);
        continue;
      }
      const attribution = buildAttribution(modules);
      const source_event = `auto:tokens:${tenant}:${targetDate}`;
      const note = formatNote(knownCounts, costPerModel);
      const amount = Math.round(totalCost * 1_000_000) / 1_000_000;
      // amount must be positive number; finance validates >0
      if (amount <= 0) continue;
      const movementArgs = {
        tenant,
        kind: "gasto" as const,
        category: "software" as const,
        currency: "USD" as const,
        amount,
        attribution,
        source_event,
        created_by: "token-meter" as const,
        note,
      };
      try {
        const res = await registerMovementViaMcp(env.FINANCE_MCP_URL, movementArgs);
        if (res.status === "possible_duplicate") {
          console.log(`[token-meter] dedup tenant=${tenant} source_event=${source_event} skip`);
        } else if (res.status === "registered") {
          console.log(`[token-meter] movimiento registrado tenant=${tenant} amount=${amount} id=${res.id ?? "?"}`);
        } else {
          console.warn(`[token-meter] register_movement error tenant=${tenant}`, res.raw);
        }
      } catch (err) {
        console.error(`[token-meter] register_movement fallo tenant=${tenant}`, err);
      }
    }
  } else {
    console.log(`[token-meter] sin costo registrable (totalCost=${totalCost} knownCounts=${knownCounts.size})`);
  }

  // 3) budget check por tenant para el mes del targetDate
  for (const tenant of tenants) {
    let monthCost = 0;
    try {
      monthCost = await queryMonthSoftwareCost(pool, tenant, targetMonth);
    } catch (err) {
      console.warn(`[token-meter] queryMonthSoftwareCost fallo tenant=${tenant}`, err);
      continue;
    }
    const over = decideBudgetState(monthCost, env.TOKEN_BUDGET_USD_MONTHLY);
    const key = `${tenant}:${targetMonth}`;
    const prev = budgetState.get(key);
    const action = shouldPublishBudgetAlert(over, prev);
    // actualizar estado siempre (para próxima comparación)
    budgetState.set(key, over);
    if (!action) {
      console.log(`[token-meter] budget tenant=${tenant} month=${targetMonth} cost=${monthCost} cap=${env.TOKEN_BUDGET_USD_MONTHLY} over=${over} (sin alerta)`);
      continue;
    }
    const alert = buildBudgetAlert({
      tenant,
      month: targetMonth,
      costUsd: monthCost,
      capUsd: env.TOKEN_BUDGET_USD_MONTHLY,
      state: action,
    });
    try {
      await publishAlert(mqttClient as unknown as Parameters<typeof publishAlert>[0], tenant, alert);
      console.log(`[token-meter] budget alerta ${action} tenant=${tenant} month=${targetMonth} cost=${monthCost} cap=${env.TOKEN_BUDGET_USD_MONTHLY}`);
    } catch (err) {
      console.warn(`[token-meter] error publicando budget alerta tenant=${tenant}`, err);
    }
  }
}

// Loop: primera corrida a los 60s, luego cada SETTLE_INTERVAL_HOURS
const FIRST_DELAY_MS = 60_000;
const intervalMs = env.SETTLE_INTERVAL_HOURS * 3600_000;

let firstTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

firstTimer = setTimeout(() => {
  void (async () => {
    try {
      await settleOnce(new Date());
    } catch (err) {
      console.error("[token-meter] settleOnce error (first)", err);
    }
    intervalTimer = setInterval(() => {
      void settleOnce(new Date()).catch((err) => console.error("[token-meter] settleOnce error (interval)", err));
    }, intervalMs);
    // node no retiene si solo timer de intervalo? necesitamos unref opcional
  })();
}, FIRST_DELAY_MS);

console.log(`[token-meter] primera liquidación en ${FIRST_DELAY_MS / 1000}s, intervalo ${env.SETTLE_INTERVAL_HOURS}h (${intervalMs} ms)`);

// Shutdown
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[token-meter] ${signal} — cerrando`);
  clearTimeout(firstTimer as unknown as NodeJS.Timeout);
  clearInterval(intervalTimer as unknown as NodeJS.Timeout);
  try {
    mqttClient.end(true);
  } catch {}
  try {
    await pool.end();
  } catch {}
  console.log("[token-meter] cerrado");
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => console.error("[token-meter] unhandledRejection", reason));
process.on("uncaughtException", (err) => {
  console.error("[token-meter] uncaughtException", err);
});

export { settleOnce, budgetState };
