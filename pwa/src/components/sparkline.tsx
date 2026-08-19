import * as React from "react";

// Sparkline SVG sin dependencias: serie temporal mínima para las tarjetas de módulo.
export function Sparkline({
  points,
  width = 160,
  height = 36,
  className
}: {
  points: Array<{ t: string; v: number }>;
  width?: number;
  height?: number;
  className?: string;
}) {
  if (points.length < 2) {
    return <div className={className} style={{ width, height }} aria-label="sin datos suficientes" />;
  }
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const stepX = width / (points.length - 1);
  const d = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * stepX).toFixed(1)},${(height - 3 - ((p.v - min) / span) * (height - 6)).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} className={className} role="img" aria-label="tendencia">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-primary" />
    </svg>
  );
}
