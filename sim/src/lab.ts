// Lógica pura del laboratorio — asignación de identidades (testeable sin DB ni procesos).

// siguiente módulo libre: rellena huecos antes de extender (mod-1..3 con mod-2 libre → mod-2)
export function nextModuleId(taken: number[]): string {
  let n = 1;
  const set = new Set(taken);
  while (set.has(n)) n++;
  return `mod-${n}`;
}

// siguiente hw_id: max+1 en hex, base 020000000000
export function nextHwId(existing: string[]): string {
  const nums = existing.map((h) => parseInt(h, 16)).filter((n) => !isNaN(n));
  const next = (nums.length ? Math.max(...nums) : 0x020000000000) + 1;
  return next.toString(16).padStart(12, "0");
}
