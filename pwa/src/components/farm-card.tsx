import * as React from "react";
import { MapPinned, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Sparkline } from "@/components/sparkline.tsx";
import { Bars7d } from "@/components/bars7d.tsx";
import { remediationFor } from "@/lib/remediation.ts";
import { formatMoney, timeAgo } from "@/lib/format.ts";
import { cn } from "@/lib/utils.ts";

// Forma pública de farms.summary (server/trpc.ts). Duplicada aquí porque el cliente
// no importa tipos del servidor (contrato JSON por HTTP).
export type FarmPulse = {
  id: string;
  name: string;
  locationName: string | null;
  currency: string;
  totalModules: number;
  openAlerts: { warn: number; critical: number };
  todaySpend: number;
  avgConfidence: number | null;
  worstAlert: { name: string; severity: string; module: string; time: string } | null;
  readings: {
    ec: { value: number; status: "ok" | "warn"; module: string } | null;
    ph: { value: number; status: "ok" | "warn"; module: string } | null;
    level: { value: number; status: "ok" | "warn"; module: string } | null;
  };
  climate: { airTemp: number | null; humidity: number | null; time: string } | null;
  confidenceSeries: Array<{ t: string; v: number }>;
  spend7d: Array<{ d: string; v: number }>;
};

// Puntuación de triage: más alto = necesita atención antes (críticas » warnings » lecturas fuera de rango » baja confianza)
export function farmRankScore(f: FarmPulse): number {
  let s = f.openAlerts.critical * 100 + f.openAlerts.warn * 10;
  if (f.readings.ec?.status === "warn") s += 5;
  if (f.readings.ph?.status === "warn") s += 5;
  if (f.readings.level?.status === "warn") s += 3;
  s += f.avgConfidence != null ? (100 - f.avgConfidence) / 20 : 2;
  return s;
}

function MetricDot({ label, m, unit }: {
  label: string;
  m: { value: number; status: "ok" | "warn"; module: string } | null;
  unit: string;
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className={cn(
        "size-2 rounded-full shrink-0",
        m == null ? "bg-muted-foreground/30" : m.status === "warn" ? "bg-warning" : "bg-success"
      )} />
      <span className="text-xs text-muted-foreground shrink-0">{label}</span>
      <span className={cn("text-xs font-medium truncate", m?.status === "warn" && "text-warning")}>
        {m != null ? `${m.value}${unit}` : "—"}
      </span>
      {m?.status === "warn" && <span className="text-[10px] text-muted-foreground truncate">({m.module})</span>}
    </div>
  );
}

export function FarmCard({ farm, rank, onSelect }: { farm: FarmPulse; rank: number; onSelect: () => void }) {
  const openN = farm.openAlerts.warn + farm.openAlerts.critical;
  const worst = farm.worstAlert;
  const needsAttention = farmRankScore(farm) >= 10;
  return (
    <Card
      className={cn(
        "cursor-pointer hover:bg-accent/40 transition-colors",
        farm.openAlerts.critical > 0 && "border-destructive/50",
        needsAttention && farm.openAlerts.critical === 0 && "border-warning/50"
      )}
      onClick={onSelect}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-1.5 min-w-0">
            <span className={cn(
              "text-[10px] font-bold rounded-full size-5 grid place-items-center shrink-0",
              needsAttention ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"
            )}>
              {rank}
            </span>
            <MapPinned className="size-4 shrink-0" />
            <span className="truncate">{farm.name}</span>
          </CardTitle>
          <Badge variant={farm.openAlerts.critical > 0 ? "destructive" : openN > 0 ? "secondary" : "outline"} className="shrink-0">
            {openN > 0 ? `${openN} alertas` : "ok"}
          </Badge>
        </div>
        <CardDescription className="truncate">
          {farm.id}{farm.locationName ? ` · ${farm.locationName}` : ""} · {farm.currency} · {farm.totalModules} módulos
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Confianza: sparkline 24h + valor actual */}
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <Sparkline points={farm.confidenceSeries} width={220} height={32} className="w-full" />
          </div>
          <div className="text-right shrink-0">
            <p className="text-lg font-semibold leading-none">
              {farm.avgConfidence != null ? `${Math.round(farm.avgConfidence)}%` : "—"}
            </p>
            <p className="text-[10px] text-muted-foreground uppercase">confianza</p>
          </div>
        </div>

        {/* Lecturas vs rango + clima */}
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          <MetricDot label="EC" m={farm.readings.ec} unit="" />
          <MetricDot label="pH" m={farm.readings.ph} unit="" />
          <MetricDot label="Nivel" m={farm.readings.level} unit="%" />
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0">
            <span className="shrink-0">Clima</span>
            <span className="font-medium text-foreground truncate">
              {farm.climate?.airTemp != null ? `${farm.climate.airTemp.toFixed(1)}°` : "—"}
              {" · HR "}
              {farm.climate?.humidity != null ? `${Math.round(farm.climate.humidity)}%` : "—"}
            </span>
          </div>
        </div>

        {/* Gasto: barras 7d + hoy (en la moneda de la finca) */}
        <div className="flex items-end justify-between gap-3 rounded-md border p-2">
          <Bars7d points={farm.spend7d} />
          <div className="text-right shrink-0">
            <p className="text-sm font-semibold leading-none">{formatMoney(farm.todaySpend, farm.currency)}</p>
            <p className="text-[10px] text-muted-foreground uppercase">hoy</p>
          </div>
        </div>

        {/* Peor alerta en texto — la razón de ir a esta finca */}
        {worst ? (
          <div className={cn(
            "flex items-start gap-1.5 text-xs rounded-md p-2",
            worst.severity === "critical" ? "bg-destructive/10 text-destructive" : "bg-warning/10 text-warning"
          )}>
            <TriangleAlert className="size-3.5 shrink-0 mt-0.5" />
            <span className="min-w-0 truncate">
              {remediationFor(worst.name).title} · {worst.module} · {timeAgo(worst.time)}
            </span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Sin alertas abiertas — finca sana.</p>
        )}
      </CardContent>
    </Card>
  );
}
