#!/usr/bin/env node
// ctl — control del laboratorio: agregar/quitar nodos del mundo y cambiar escenario en caliente.
// Uso: pnpm ctl list | pnpm ctl add-node --crop lechuga [--hw 020000000005] | pnpm ctl remove-node --hw 020000000005 [--unclaim]
const supervisorUrl = process.env.SUPERVISOR_URL ?? "http://127.0.0.1:7750";

const args = process.argv.slice(2);
const command = args[0];
function getFlag(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith("--")) return args[idx + 1];
  return undefined;
}

async function post(path: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${supervisorUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  console.log(JSON.stringify(json, null, 2));
  if (!res.ok) process.exit(1);
}

if (command === "list") {
  const res = await fetch(`${supervisorUrl}/ctl/status`);
  console.log(JSON.stringify(await res.json(), null, 2));
} else if (command === "add-node") {
  const body: Record<string, unknown> = {};
  const hw = getFlag("--hw");
  const crop = getFlag("--crop");
  if (hw) body.hw_id = hw;
  if (crop) body.crop = crop;
  await post("/ctl/add-node", body);
} else if (command === "remove-node") {
  const hw = getFlag("--hw");
  if (!hw) {
    console.error("remove-node requiere --hw <hw_id>");
    process.exit(1);
  }
  await post("/ctl/remove-node", { hw_id: hw, unclaim: args.includes("--unclaim") });
} else if (command === "scenario") {
  const name = args[1];
  if (!name) {
    console.error("scenario requiere nombre (normal | ec_baja | sensor_muerto)");
    process.exit(1);
  }
  await post("/ctl/scenario", { name });
} else {
  console.log("Uso: pnpm ctl list | add-node [--hw X] [--crop C] | remove-node --hw X [--unclaim] | scenario <nombre>");
  process.exit(command ? 1 : 0);
}
