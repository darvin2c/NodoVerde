// Curva ET0 fija (mm/h) para modo offline/sintético.
// La serie horaria real la provee weather.ts (Open-Meteo); este módulo solo
// define la campana diaria de respaldo: pico 1.0 mm/h a las 13h, 0 nocturno.
const FIXED_CURVE: number[] = (() => {
  const arr = new Array(24).fill(0);
  for (let h = 0; h < 24; h++) {
    if (h >= 6 && h <= 19) {
      const dist = Math.abs(h - 13);
      arr[h] = Math.max(0, Math.cos((dist / 7) * (Math.PI / 2)));
    }
  }
  arr[13] = 1.0;
  return arr;
})();

export function fixedEt0Curve(): number[] {
  return [...FIXED_CURVE];
}

// ET0 de la hora simulada (usado por tests que integran con la curva fija).
export function et0ForHour(hourly: number[], simMs: number): number {
  const h = Math.floor((simMs / 3_600_000) % 24);
  return hourly[((h % 24) + 24) % 24] ?? 0;
}
