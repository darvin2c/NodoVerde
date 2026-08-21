import * as React from "react";

// Mini gráfico de barras de 7 días, sin dependencias.
// Días sin movimientos = barra en cero (no gasto registrado es un hecho, no ausencia de dato).
export function Bars7d({
  points,
  width = 140,
  height = 40,
  className
}: {
  points: Array<{ d: string; v: number }>;
  width?: number;
  height?: number;
  className?: string;
}) {
  const byDate = new Map(points.map((p) => [String(p.d).slice(0, 10), p.v]));
  const days: Array<{ label: string; v: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const dt = new Date(Date.now() - i * 86400000);
    const key = dt.toISOString().slice(0, 10);
    days.push({ label: String(dt.getDate()), v: byDate.get(key) ?? 0 });
  }
  const max = Math.max(...days.map((d) => d.v), 1);
  const slot = width / days.length;
  const barW = Math.max(4, slot - 6);
  const baseline = height - 12; // espacio para la etiqueta del día
  return (
    <svg width={width} height={height} className={className} role="img" aria-label="gasto de los últimos 7 días">
      {days.map((d, i) => {
        const h = Math.max(d.v > 0 ? 2 : 0, (d.v / max) * (baseline - 4));
        const x = i * slot + (slot - barW) / 2;
        const isToday = i === days.length - 1;
        return (
          <g key={i}>
            <rect
              x={x} y={baseline - h} width={barW} height={h} rx={2}
              className={isToday ? "fill-primary" : "fill-primary/40"}
            />
            <text
              x={x + barW / 2} y={height - 2} textAnchor="middle"
              className={`fill-muted-foreground ${isToday ? "font-semibold" : ""}`}
              style={{ fontSize: 8 }}
            >
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
