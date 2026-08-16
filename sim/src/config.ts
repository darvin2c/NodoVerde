import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const FincaSchema = z.object({
  tenant: z.string(),
  location: z.object({
    lat: z.number(),
    lon: z.number(),
    name: z.string(),
  }),
  tank_liters: z.number().positive(),
  modules: z.array(
    z.object({
      id: z.string(),
      crop: z.string(),
    }),
  ),
});

const CropSchema = z.object({
  name: z.string(),
  ec_target: z.tuple([z.number(), z.number()]),
  ph_target: z.tuple([z.number(), z.number()]),
  water_temp: z.tuple([z.number(), z.number()]),
  notes: z.string().optional(),
});

export type FincaConfig = z.infer<typeof FincaSchema>;
export type CropConfig = z.infer<typeof CropSchema>;

function findFile(relativeCandidates: string[]): string | null {
  // try candidates relative to cwd, then relative to repo root (one level up from sim)
  for (const rel of relativeCandidates) {
    const cand1 = resolve(process.cwd(), rel);
    if (existsSync(cand1)) return cand1;
  }
  // also try relative to this file's directory
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of relativeCandidates) {
    const cand2 = resolve(here, rel);
    if (existsSync(cand2)) return cand2;
  }
  return null;
}

export function loadFinca(yamlPath?: string): FincaConfig {
  let p = yamlPath;
  if (!p) {
    p =
      findFile([
        "fincas/demo.yaml",
        "../fincas/demo.yaml",
        "../../fincas/demo.yaml",
      ]) ?? undefined;
  }
  if (!p || !existsSync(p)) {
    throw new Error(`finca yaml not found: ${p ?? "fincas/demo.yaml"}`);
  }
  const raw = readFileSync(p, "utf-8");
  const parsed = parseYaml(raw);
  return FincaSchema.parse(parsed);
}

export function loadCrop(crop: string, baseDir?: string): CropConfig {
  const candidates = baseDir
    ? [resolve(baseDir, `${crop}.yaml`)]
    : [
        `config/crops/${crop}.yaml`,
        `../config/crops/${crop}.yaml`,
        `../../config/crops/${crop}.yaml`,
      ];
  const p = findFile(candidates);
  if (!p || !existsSync(p)) {
    throw new Error(`crop yaml not found for ${crop}: ${candidates.join(", ")}`);
  }
  const raw = readFileSync(p, "utf-8");
  const parsed = parseYaml(raw);
  return CropSchema.parse(parsed);
}

export function loadAllCrops(finca: FincaConfig): Map<string, CropConfig> {
  const map = new Map<string, CropConfig>();
  const uniqueCrops = [...new Set(finca.modules.map((m) => m.crop))];
  for (const c of uniqueCrops) {
    map.set(c, loadCrop(c));
  }
  return map;
}
