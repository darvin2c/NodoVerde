import { useQuery } from "@tanstack/react-query";
import { trpc } from "../trpc.ts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { formatPEN, formatShort } from "@/lib/format.ts";

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
  const { data: summary, isLoading } = useQuery({
    queryKey: ["finance.monthSummary"],
    queryFn: () => trpc.finance.monthSummary.query({ tenant: "demo" }),
    refetchInterval: 30000
  });
  const { data: byCategory } = useQuery({
    queryKey: ["finance.byCategory"],
    queryFn: () => trpc.finance.byCategory.query({ tenant: "demo" }),
    refetchInterval: 30000
  });
  const { data: movements } = useQuery({
    queryKey: ["finance.recentMovements"],
    queryFn: () => trpc.finance.recentMovements.query({ tenant: "demo", limit: 30 }),
    refetchInterval: 30000
  });

  if (isLoading) return <div className="grid gap-4 md:grid-cols-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>;

  const maxCat = Math.max(...(byCategory ?? []).map((c) => c.total), 1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Finanzas</h1>
        <p className="text-sm text-muted-foreground">
          ledger inmutable (ADR-0011): nada se borra — corrección = anulación + nuevo movimiento
        </p>
      </div>

      {/* Resumen del mes */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2"><CardDescription>Ingresos · {summary?.month}</CardDescription></CardHeader>
          <CardContent><p className="text-2xl font-bold font-mono text-success">{formatPEN(summary?.ingresos ?? 0)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Gastos · {summary?.month}</CardDescription></CardHeader>
          <CardContent><p className="text-2xl font-bold font-mono text-destructive">{formatPEN(summary?.gastos ?? 0)}</p></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardDescription>Balance · {summary?.count ?? 0} movimientos</CardDescription></CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold font-mono ${(summary?.balance ?? 0) >= 0 ? "text-success" : "text-destructive"}`}>
              {formatPEN(summary?.balance ?? 0)}
            </p>
          </CardContent>
        </Card>
      </div>

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
              <div key={c.category} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span>{CATEGORY_LABELS[c.category] ?? c.category}</span>
                  <span className="font-mono">{formatPEN(c.total)}</span>
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
                        <TableCell>
                          <Badge variant="secondary">{CATEGORY_LABELS[mv.category] ?? mv.category}</Badge>
                          {voided && <Badge variant="outline" className="ml-1 text-[10px]">anulado</Badge>}
                        </TableCell>
                        <TableCell className={`text-xs max-w-48 truncate ${voided ? "line-through" : ""}`}>
                          {mv.note ?? "—"}
                        </TableCell>
                        <TableCell className={`text-right font-mono text-sm ${voided ? "line-through" : mv.kind === "ingreso" ? "text-success" : "text-destructive"}`}>
                          {mv.kind === "ingreso" ? "+" : "−"}{formatPEN(Number(mv.amount))}
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
