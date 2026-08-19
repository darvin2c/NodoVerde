export type Env = {
  OPENCLAW_STATE_PATH: string;
  TOKEN_PRICE_TABLE_RAW: string;
  TOKEN_BUDGET_USD_MONTHLY: number;
  SETTLE_INTERVAL_HOURS: number;
  FINANCE_MCP_URL: string;
  DATABASE_URL: string;
  MQTT_URL: string;
  TENANT: string;
};

function parseFloatEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[token-meter] env ${name} inválido "${raw}", usando default ${def}`);
    return def;
  }
  return n;
}

function parseIntEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[token-meter] env ${name} inválido "${raw}", usando default ${def}`);
    return def;
  }
  return n;
}

export function getEnv(): Env {
  const tokenBudget = parseFloatEnv("TOKEN_BUDGET_USD_MONTHLY", 50);
  const settleHours = parseFloatEnv("SETTLE_INTERVAL_HOURS", 24);
  // allow integer or float hours; floor not needed, keep float but later convert to ms
  return {
    OPENCLAW_STATE_PATH: process.env.OPENCLAW_STATE_PATH ?? "",
    TOKEN_PRICE_TABLE_RAW: process.env.TOKEN_PRICE_TABLE ?? "",
    TOKEN_BUDGET_USD_MONTHLY: tokenBudget,
    SETTLE_INTERVAL_HOURS: settleHours > 0 ? settleHours : 24,
    FINANCE_MCP_URL: process.env.FINANCE_MCP_URL ?? "http://localhost:7761/mcp",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra",
    MQTT_URL: process.env.MQTT_URL ?? "mqtt://localhost:1883",
    TENANT: process.env.TENANT ?? "",
  };
}

export function logEnv(env: Env): void {
  const pricePreview = env.TOKEN_PRICE_TABLE_RAW ? `${env.TOKEN_PRICE_TABLE_RAW.slice(0, 80)}${env.TOKEN_PRICE_TABLE_RAW.length > 80 ? "…" : ""}` : "(vacío)";
  console.log(
    `[token-meter] env OPENCLAW_STATE_PATH=${env.OPENCLAW_STATE_PATH || "(vacío)"} ` +
      `TOKEN_BUDGET_USD_MONTHLY=${env.TOKEN_BUDGET_USD_MONTHLY} SETTLE_INTERVAL_HOURS=${env.SETTLE_INTERVAL_HOURS} ` +
      `FINANCE_MCP_URL=${env.FINANCE_MCP_URL} TENANT=${env.TENANT || "(auto)"} ` +
      `TOKEN_PRICE_TABLE=${pricePreview}`,
  );
}
