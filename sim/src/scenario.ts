import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const ScenarioSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  ec_consumption_mul: z.number().optional(),
  disable_auto_dose: z.boolean().optional(),
  sensor_dead: z
    .object({
      module: z.string(),
      device: z.string(),
      after_sim_sec: z.number(),
    })
    .optional(),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

export function loadScenario(name: string): Scenario {
  const candidates = [
    resolve(process.cwd(), `scenarios/${name}.yaml`),
    resolve(process.cwd(), `sim/scenarios/${name}.yaml`),
    resolve(dirname(new URL(import.meta.url).pathname), `../scenarios/${name}.yaml`),
  ];
  let p: string | undefined;
  for (const c of candidates) {
    if (existsSync(c)) {
      p = c;
      break;
    }
  }
  if (!p) throw new Error(`scenario not found: ${name}`);
  const raw = readFileSync(p, "utf-8");
  const parsed = parseYaml(raw);
  return ScenarioSchema.parse(parsed);
}
