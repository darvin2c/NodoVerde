/**
 * E2E Fase 3 — escenario "EC baja" de punta a punta (criterio de salida del ROADMAP).
 *
 *   agente detecta → propone dosificar → humano aprueba → dosificadora actúa → EC sube → costo en ledger
 *
 * El "agente" y el "humano" los juega este script de forma determinística:
 *   - detección: EC del módulo cae bajo el piso del perfil lechuga (escenario ec_baja, auto-dosis off)
 *   - propuesta: MCP terra-policy propose_action (el camino real del cerebro)
 *   - aprobación: HTTP POST /api/approvals/{id}/approve con POLICY_ADMIN_TOKEN (el camino del botón PWA)
 *
 * Precondiciones: `docker compose up -d` (con policy, watchdog, finance, router por host) y
 * sim corriendo (`cd sim && pnpm dev -- --offline --speed 240`). Speed alto recomendado (≥240):
 * a 1× la caída de EC hasta el piso tarda horas reales. El script conmuta el escenario
 * a ec_baja vía ctl y lo restaura a normal al final.
 *
 * Uso: pnpm --dir e2e ec-baja
 */
import mqtt from "mqtt";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MQTT_URL = process.env.MQTT_URL ?? "mqtt://localhost:1883";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://terra:changeme@localhost:5432/terra";
const POLICY_URL = process.env.POLICY_URL ?? "http://localhost:7762";
const DOMAIN_URL = process.env.DOMAIN_URL ?? "http://localhost:7760";
const POLICY_ADMIN_TOKEN = process.env.POLICY_ADMIN_TOKEN ?? "dev-admin-token";
const CTL_URL = process.env.CTL_URL ?? "http://127.0.0.1:7750";
const TENANT = "demo";
const EC_PISO_LECHUGA = 1.2;
const DOSE_DURATION_MS = 2000;
const RATE_LIMIT_MS = 10 * 60_000; // rateLimitMs de dose_nutrient en services/policy

const { Pool } = pg;
const db = new Pool({ connectionString: DATABASE_URL });

// Watermark para tablas con reloj real (movements.created_at, alerts.ts del watchdog).
// La telemetría NO se consulta por DB: el sim puede reiniciarse con reloj distinto y la
// DB guarda filas con ts futuro de corridas anteriores. EC se lee del stream MQTT vivo
// (el mismo camino que usa el portero para decidir).
const START_WALL = new Date(Date.now() - 60_000);

let step = 0;
function ok(msg: string): void {
  step += 1;
  console.log(`  ✅ [${String(step).padStart(2)}] ${msg}`);
}
function info(msg: string): void {
  console.log(`  … ${msg}`);
}
function fail(msg: string): never {
  console.error(`  ❌ ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}
async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// Último EC por módulo, del bus interno en vivo (terra/{tenant}/{module}/ec-01/ec/reading)
const lastEcByModule = new Map<string, number>();
function latestEc(module: string): Promise<number | null> {
  return Promise.resolve(lastEcByModule.get(module) ?? null);
}

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs: number, everyMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) fail(`timeout esperando ${what}`);
    await sleep(everyMs);
  }
}

async function setScenario(name: string): Promise<void> {
  const res = await fetch(`${CTL_URL}/ctl/scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) fail(`ctl scenario ${name} → HTTP ${res.status}`);
}

async function policyHttp(path: string, body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${POLICY_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${POLICY_ADMIN_TOKEN}` },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) fail(`policy ${path} → HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

type McpResult = { status?: string; action_id?: string; policy_id?: string; needs?: string[]; reason?: string };

async function main(): Promise<void> {
  console.log("E2E Fase 3 — escenario EC baja (lazo cerrado con actuadores)\n");

  // ── 0. Precondiciones ────────────────────────────────────────────────────
  const health = await fetch(`${POLICY_URL}/healthz`).then((r) => r.ok).catch(() => false);
  if (!health) fail(`portero no responde en ${POLICY_URL}/healthz (¿docker compose up -d policy?)`);
  await db.query("SELECT 1");
  ok(`portero :7762 y DB alcanzables`);

  // MQTT: suscripciones ANTES de actuar para no perder mensajes
  const bus = mqtt.connect(MQTT_URL);
  {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    bus.once("connect", () => resolve());
    bus.once("error", reject);
    await promise;
  }
  const cmdSeen: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const deviceCmdSeen: string[] = [];
  const doseEvents: Array<{ topic: string; name: string; detail: Record<string, unknown> }> = [];
  bus.subscribe(["terra/+/+/+/cmd", "terra/+/+/+/+/+/cmd", "terra/+/+/+/+/event", "terra/+/+/ec-01/ec/reading"], { qos: 1 });
  bus.on("message", (topic, raw) => {
    try {
      const parts = topic.split("/");
      if (parts.length === 5 && parts[4] === "cmd" && parts[0] === "terra") {
        // interno terra/{tenant}/{module}/{device}/cmd o dispositivo terra/{hw}/{device}/cmd
        if (/^[0-9a-f]{12}$/.test(parts[1])) deviceCmdSeen.push(topic);
        else cmdSeen.push({ topic, payload: JSON.parse(raw.toString()) as Record<string, unknown> });
      } else if (parts[parts.length - 1] === "event") {
        const p = JSON.parse(raw.toString()) as { name?: string; detail?: Record<string, unknown> };
        if (p.name?.startsWith("dose_")) doseEvents.push({ topic, name: p.name, detail: p.detail ?? {} });
      } else if (parts.length === 6 && parts[5] === "reading" && parts[4] === "ec" && parts[1] === TENANT) {
        const p = JSON.parse(raw.toString()) as { v?: number };
        if (typeof p.v === "number") lastEcByModule.set(parts[2], p.v);
      }
    } catch { /* tolerante */ }
  });

  // ── 0.5. ADR-0025: sin lote abierto no hay plantas ni consumo — abrir uno ──
  // El cultivo ya NO vive en el yaml ni en los seeds: lo pone el lote (camino
  // real del humano en la PWA). Si ya hay lote abierto con lechuga, se reusa.
  const domain = new Client({ name: "terra-e2e-domain", version: "0.1.0" });
  await domain.connect(new StreamableHTTPClientTransport(new URL(`${DOMAIN_URL}/mcp`)));
  let openedByUs: string | null = null;
  {
    const existing = await db.query(
      `SELECT l.id FROM lotes l WHERE l.tenant=$1 AND l.state='open' AND l.crop='lechuga' LIMIT 1`,
      [TENANT],
    );
    if (existing.rows.length === 0) {
      const allMods = await db.query(`SELECT id FROM modules WHERE tenant=$1 AND retired_at IS NULL ORDER BY id`, [TENANT]);
      const moduleIds = allMods.rows.map((r) => r.id as string);
      if (moduleIds.length === 0) fail("sin módulos en DB — el supervisor debió clamarlos al arrancar");
      const out = await domain.callTool({
        name: "open_batch",
        arguments: { tenant: TENANT, crop: "lechuga", modules: moduleIds, campaign: "e2e", note: "lote E2E ec-baja" },
      });
      const sc = (out as { structuredContent?: { batch?: { id?: string }; error?: string } }).structuredContent;
      if (sc?.error || !sc?.batch?.id) fail(`open_batch falló: ${JSON.stringify(sc)}`);
      openedByUs = sc.batch.id;
      ok(`lote abierto (${moduleIds.join("/")} ← lechuga) — las mesas tienen plantas`);
      // el supervisor sincroniza cultivo → física cada 5s; esperar a que el mundo tenga plantas
      await sleep(7_000);
    } else {
      info(`lote lechuga ya abierto (${existing.rows[0].id}) — se reusa, no se cierra al final`);
    }
  }

  // ── 1. Escenario ec_baja (auto-dosis del firmware OFF → el agente debe cerrar el lazo) ──
  await setScenario("ec_baja");
  ok(`escenario ec_baja activo (consumo ×2, sin auto-dosis)`);

  // ── 2. Detección: EC bajo el piso del perfil + módulo no rate-limited ────
  const modsRes = await db.query(
    `SELECT id FROM modules WHERE tenant=$1 AND crop='lechuga' ORDER BY id`,
    [TENANT],
  );
  const candidates = modsRes.rows.map((r) => r.id as string);
  if (candidates.length === 0) fail("sin módulos lechuga en DB");

  info(`esperando EC < ${EC_PISO_LECHUGA} en algún módulo lechuga ${candidates.join("/")} …`);
  const target = await waitFor(
    async () => {
      for (const m of candidates) {
        const ec = await latestEc(m);
        if (ec === null || ec >= EC_PISO_LECHUGA) continue;
        const rate = await db.query(
          `SELECT 1 FROM action_requests
           WHERE tenant=$1 AND module=$2 AND action_class='dose_nutrient' AND status='executed'
             AND executed_at > now() - ($3 || ' milliseconds')::interval LIMIT 1`,
          [TENANT, m, String(RATE_LIMIT_MS)],
        );
        if (rate.rows.length > 0) {
          info(`${m}: EC=${ec} pero rate-limited, probando siguiente`);
          continue;
        }
        return { module: m, ec };
      }
      return null;
    },
    15 * 60_000,
    5_000,
    "EC bajo piso en módulo elegible",
  );
  const MODULE = target.module;
  const baseline = target.ec;
  ok(`detección: ${MODULE} EC=${baseline} < ${EC_PISO_LECHUGA} (piso perfil lechuga)`);

  // ── 3. Propuesta del agente vía MCP terra-policy ─────────────────────────
  const mcp = new Client({ name: "terra-e2e", version: "0.1.0" });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${POLICY_URL}/mcp`)));

  let proposal: McpResult | null = null;
  for (let attempt = 0; attempt < 3 && !proposal; attempt += 1) {
    const out = await mcp.callTool({
      name: "propose_action",
      arguments: {
        tenant: TENANT,
        module: MODULE,
        device: "doser-a-01",
        action: "start",
        params: { duration_ms: DOSE_DURATION_MS },
        requested_by: "e2e-bot",
        reason: "EC baja detectada (e2e)",
      },
    });
    const txt = (out.content as Array<{ text?: string }>)[0]?.text ?? "{}";
    const parsed = JSON.parse(txt) as McpResult;
    if (parsed.status === "pending") {
      proposal = parsed;
    } else if (parsed.status === "needs_data") {
      info(`needs_data (${parsed.needs?.join(",")}) — confianza subiendo, reintento en 10s`);
      await sleep(10_000);
    } else {
      fail(`propuesta inesperada: ${txt}`);
    }
  }
  if (!proposal) fail("propuesta siguió en needs_data tras reintentos");
  ok(`propuesta aceptada como PENDIENTE (supervisada): action_id=${proposal.action_id} policy_id=${proposal.policy_id}`);

  // ── 4. Sin aprobación NO hay cmd ─────────────────────────────────────────
  await sleep(6_000);
  if (cmdSeen.length > 0) fail(`se publicó cmd antes de aprobación humana: ${JSON.stringify(cmdSeen[0])}`);
  ok(`portero NO publicó cmd antes de la aprobación humana`);

  // ── 5. Aprobación humana (botón PWA → HTTP, cero LLM) ────────────────────
  await policyHttp(`/api/approvals/${proposal.action_id}/approve`, { by: "e2e-humano" });
  ok(`aprobación humana vía HTTP (Bearer POLICY_ADMIN_TOKEN)`);

  // ── 6. cmd con policy_id llega al bus interno ────────────────────────────
  const cmd = await waitFor(
    async () => cmdSeen.find((c) => c.payload.policy_id === proposal!.policy_id) ?? null,
    20_000,
    500,
    "cmd interno con policy_id",
  );
  if (cmd.topic !== `terra/${TENANT}/${MODULE}/doser-a-01/cmd`) fail(`topic cmd inesperado: ${cmd.topic}`);
  if (cmd.payload.action !== "start") fail(`cmd.action inesperado: ${cmd.payload.action}`);
  const cmdParams = cmd.payload.params as Record<string, unknown> | undefined;
  if (Number(cmdParams?.duration_ms) !== DOSE_DURATION_MS) fail(`cmd.params.duration_ms inesperado: ${JSON.stringify(cmd.payload)}`);
  ok(`cmd ${cmd.topic} action=start duration_ms=${DOSE_DURATION_MS} policy_id=${proposal.policy_id}`);

  // ── 7. La dosificadora actúa (evento dose_a_end con ml reales) ───────────
  const dose = await waitFor(
    async () => doseEvents.find((e) => e.name === "dose_a_end" && e.topic.includes(`/${MODULE}/`)) ?? null,
    60_000,
    500,
    "evento dose_a_end del módulo",
  );
  const ml = Number(dose.detail.ml ?? 0);
  if (!(ml > 0)) fail(`dose_a_end sin ml positivo: ${JSON.stringify(dose.detail)}`);
  ok(`dosificadora actuó: ${dose.name} ml=${ml} (vía ${dose.topic})`);

  // ── 8. EC sube (efecto físico verificado en telemetría) ──────────────────
  // La caída por consumo continúa durante la dosificación: la señal de la dosis
  // es la subida desde el valle post-dosis (mixTau 600s sim → incorporación rápida).
  let trough = baseline;
  const rose = await waitFor(
    async () => {
      const ec = await latestEc(MODULE);
      if (ec === null) return null;
      if (ec < trough) trough = ec;
      return ec >= trough + 0.05 ? { ec, trough } : null;
    },
    240_000,
    1_500,
    "subida de EC post-dosis",
  );
  ok(`EC subió: baseline=${baseline} valle=${rose.trough.toFixed(3)} actual=${rose.ec} (dosis incorporada)`);

  // ── 9. Auditoría del portero: fila executed ──────────────────────────────
  const audit = await waitFor(
    async () => {
      const res = await db.query(
        `SELECT status, decided_by, executed_at FROM action_requests WHERE policy_id=$1`,
        [proposal!.policy_id],
      );
      return res.rows.length && res.rows[0].status === "executed" ? res.rows[0] : null;
    },
    15_000,
    1_000,
    "fila action_requests executed",
  );
  ok(`audit: action_requests status=executed decided_by=${audit.decided_by} executed_at=${audit.executed_at}`);

  // ── 10. Costo en ledger (auto-registro desde actuador, ADR-0011) ─────────
  const movement = await waitFor(
    async () => {
      const res = await db.query(
        `SELECT id, amount, currency, category, source_event FROM movements
         WHERE tenant=$1 AND category='nutrientes' AND source_event LIKE $2
           AND created_at > $3
           AND voided_by IS NULL AND anula_a IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [TENANT, `${TENANT}/${MODULE}/doser-a-01/%`, START_WALL],
      );
      return res.rows.length ? res.rows[0] : null;
    },
    60_000,
    2_000,
    "movimiento de gasto por dosificación",
  );
  ok(`ledger: gasto ${movement.amount} ${movement.currency} nutrientes (source_event=${movement.source_event})`);

  // ── 11. Watchdog: sin verification_failed para esta dosis (EC sí subió) ──
  await sleep(15_000); // margen para que el verificador evalúe
  const falseAlerts = await db.query(
    `SELECT count(*)::int AS n FROM alerts WHERE name='verification_failed' AND detail LIKE $1 AND time > $2`,
    [`%${proposal.policy_id}%`, START_WALL],
  );
  if (falseAlerts.rows[0].n > 0) fail(`watchdog publicó verification_failed pese a que EC subió`);
  ok(`verificación cruzada: watchdog satisfecho, cero alertas verification_failed`);

  // ── 12. Negativo: cmd SIN policy_id jamás llega al actuador ──────────────
  bus.publish(`terra/${TENANT}/${MODULE}/doser-b-01/cmd`, JSON.stringify({ action: "start", params: { duration_ms: 1000 } }), { qos: 1 });
  await sleep(8_000);
  const leaked = deviceCmdSeen.filter((t) => t.includes("doser-b-01"));
  if (leaked.length > 0) fail(`cmd sin policy_id llegó al fierro: ${leaked[0]}`);
  ok(`comando sin policy_id descartado por el router (nunca llegó al actuador)`);

  // ── Cierre ───────────────────────────────────────────────────────────────
  await setScenario("normal");
  if (openedByUs) {
    // ADR-0025: cerrar el lote que abrimos — las mesas vuelven a estar libres
    await domain.callTool({
      name: "close_batch",
      arguments: { id: openedByUs, reason: "otro", note: "cierre E2E ec-baja" },
    }).catch(() => {});
    ok(`lote E2E cerrado — mesas libres de nuevo`);
  }
  await domain.close().catch(() => {});
  await mcp.close().catch(() => {});
  bus.end();
  await db.end();
  console.log(`\n✅ E2E EC BAJA PASA — ${step} eslabones verificados de punta a punta`);
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await setScenario("normal").catch(() => {});
  await db.end().catch(() => {});
  process.exit(1);
});
