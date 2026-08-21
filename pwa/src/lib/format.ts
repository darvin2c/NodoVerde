// Formatos compartidos de la UI (es-PE). Contrato durable: todas las páginas usan estos.

const dt = new Intl.DateTimeFormat("es-PE", { dateStyle: "medium", timeStyle: "short" });
const dtShort = new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const dtDay = new Intl.DateTimeFormat("es-PE", { day: "2-digit", month: "short" });

// Moneda por finca (ADR-0023): cache de formateadores, fallback a PEN
const moneyCache = new Map<string, Intl.NumberFormat>();
export function formatMoney(amount: number, currency = "PEN"): string {
  let f = moneyCache.get(currency);
  if (!f) {
    f = new Intl.NumberFormat("es-PE", { style: "currency", currency });
    moneyCache.set(currency, f);
  }
  return f.format(amount);
}

export function formatDateTime(iso: string | number | Date): string {
  return dt.format(new Date(iso));
}

export function formatShort(iso: string | number | Date): string {
  return dtShort.format(new Date(iso));
}

/** Solo día+mes ("25 set") — para fechas de ciclo biológico donde la hora es ruido. */
export function formatDay(iso: string | number | Date): string {
  return dtDay.format(new Date(iso));
}

export function timeAgo(iso: string | number | Date, nowMs = Date.now()): string {
  const ms = nowMs - new Date(iso).getTime();
  if (ms < 0) return "en el futuro";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "ahora";
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} d`;
}

// Métricas de sensores: 2 decimales máximo, sin ruido de punto flotante (23.1875 → "23.19", 35 → "35")
export function formatMetric(v: number): string {
  return String(Math.round(v * 100) / 100);
}
