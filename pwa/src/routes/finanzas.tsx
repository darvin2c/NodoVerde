import { useQuery } from "@tanstack/react-query";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { formatMoney, formatShort } from "@/lib/format.ts";
import { useTenant } from "@/components/tenant-provider.tsx";

const CATEGORY_LABELS: Record<string, string> = {
  nutrientes: "Nutrientes",
  energia: "Energía",
  agua: "Agua",
  plantulas: "Plántulas",
  mano_obra: "Mano de obra",
  empaque: "Empaque",
  transporte: "Transporte",
  venta_cosecha: "Venta cosecha",
  software: "Software (agente)",
  otro: "Otro"
};

export function FinanzasPage() {
  const { active, farmName, farmCurrency } = useTenant();
  const cur = active ? farmCurrency(active) : "PEN";
  const { data: summary, isLoading } = useQuery({
    queryKey: ["finance.monthSummary", active],
    queryFn: () => trpc.finance.monthSummary.query({ tenant: active ?? undefined }),
    refetchInterval: 30000,
    enabled: active !== null
  });
  const { data: byCategory } = useQuery({
    queryKey: ["finance.byCategory", active],
    queryFn: () => trpc.finance.byCategory.query({ tenant: active ?? undefined }),
    refetchInterval: 30000
  });
  const { data: movements } = useQuery({
    queryKey: ["finance.recentMovements", active],
    queryFn: () => trpc.finance.recentMovements.query({ tenant: active ?? undefined, limit: 30 }),
    refetchInterval: 30000
  });
  // Modo "Todas": el resumen global NO se suma (monedas distintas por finca) — tabla por finca
  const { data: summaryAll } = useQuery({
    queryKey: ["finance.monthSummary", "all"],
    queryFn: () => trpc.finance.monthSummary.query({}),
    refetchInterval: 30000,
    enabled: active === null
  });

  if (active !== null && isLoading) return <div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>;

  const maxCat = Math.max(...(byCategory ?? []).map((c) => c.total), 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Finanzas</h1>
        <p className="text-sm text-muted-foreground">
          ledger inmutable (ADR-0011): nada se borra — corrección = anulación + nuevo movimiento
          {active === null && " · vista de todas las fincas (cada moneda se muestra por finca, sin mezclar)"}
        </p>
      </div>

      {active === null ? (
        <Card>
          <CardHeader>
            <CardTitle>Resumen del mes por finca</CardTitle>
            <CardDescription>{summaryAll?.month ?? ""} · sumas en SQL · cada finca en su moneda</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {!summaryAll?.byTenant || summaryAll.byTenant.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">Sin movimientos este mes en ninguna finca.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Finca</TableHead>
                    <TableHead className="text-right">Ingresos</TableHead>
                    <TableHead className="text-right">Gastos</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="text-right">Movimientos</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {summaryAll.byTenant.map((t) => (
                    <TableRow key={t.tenant}>
                      <TableCell className="font-medium">{farmName(t.tenant)}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-success">+{formatMoney(t.ingresos, t.currency)}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-destructive">−{formatMoney(t.gastos, t.currency)}</TableCell>
                      <TableCell className={`text-right font-mono text-sm ${t.balance >= 0 ? "text-success" : "text-destructive"}`}>
                        {formatMoney(t.balance, t.currency)}
                      </TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">{t.count}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : (
      /* Resumen del mes */
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardDescription>Ingresos · {summary?.month}</CardDescription></CardHeader>
          <CardContent><p className="text-2xl font-bold font-mono text-success">{formatMoney(summary?.ingresos ?? 0, cur)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Gastos · {summary?.month}</CardDescription></CardHeader>
          <CardContent><p className="text-2xl font-bold font-mono text-destructive">{formatMoney(summary?.gastos ?? 0, cur)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Balance · {summary?.count ?? 0} movimientos</CardDescription></CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold font-mono ${(summary?.balance ?? 0) >= 0 ? "text-success" : "text-destructive"}`}>
              {formatMoney(summary?.balance ?? 0, cur)}
            </p>
          </CardContent>
        </Card>
      </div>
      )}

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Gasto por categoría */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Gasto por categoría</CardTitle>
            <CardDescription>mes actual · sumas en SQL</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {(!byCategory || byCategory.length === 0) && (
              <p className="text-sm text-muted-foreground">Sin gastos este mes.</p>
            )}
            {byCategory?.map((c) => (
              <div key={`${"tenant" in c ? (c as { tenant: string }).tenant : ""}/${c.category}`} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span>{CATEGORY_LABELS[c.category] ?? c.category}{"tenant" in c && active === null ? <span className="text-muted-foreground"> · {farmName((c as { tenant: string }).tenant)}</span> : null}</span>
                  <span className="font-mono">{formatMoney(c.total, "currency" in c ? (c as { currency: string }).currency : cur)}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div className="h-full bg-primary" style={{ width: `${(c.total / maxCat) * 100}%` }} />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Movimientos recientes */}
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Movimientos recientes</CardTitle>
            <CardDescription>los anulados se muestran tachados — la historia no se edita</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {!movements || movements.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground">Sin movimientos — registra por chat (texto, foto o voz).</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Fecha</TableHead>
                    {active === null && <TableHead>Finca</TableHead>}
                    <TableHead>Categoría</TableHead>
                    <TableHead>Nota</TableHead>
                    <TableHead className="text-right">Monto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {movements.map((mv) => {
                    const voided = mv.voided_by !== null || mv.anula_a !== null;
                    return (
                      <TableRow key={mv.id} className={voided ? "opacity-50" : ""}>
                        <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{formatShort(mv.ts)}</TableCell>
                        {active === null && <TableCell className="text-xs">{farmName(mv.tenant)}</TableCell>}
                        <TableCell>
                          <Badge variant="secondary">{CATEGORY_LABELS[mv.category] ?? mv.category}</Badge>
                          {voided && <Badge variant="outline" className="ml-1 text-[10px]">anulado</Badge>}
                        </TableCell>
                        <TableCell className={`text-xs max-w-48 truncate ${voided ? "line-through" : ""}`}>
                          {mv.note ?? "—"}
                        </TableCell>
                        <TableCell className={`text-right font-mono text-sm ${voided ? "line-through" : mv.kind === "ingreso" ? "text-success" : "text-destructive"}`}>
                          {mv.kind === "ingreso" ? "+" : "−"}{formatMoney(Number(mv.amount), mv.currency)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
