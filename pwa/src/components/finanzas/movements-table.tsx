import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card.tsx";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.tsx";
import { Pagination, PaginationContent, PaginationItem, PaginationNext, PaginationPrevious } from "@/components/ui/pagination.tsx";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  Paperclip, ArrowUpRight, ArrowDownLeft, Ban, Inbox,
  ChevronRight, ChevronDown, ArrowUp, ArrowDown, ArrowUpDown,
} from "lucide-react";
import { formatMoney, formatDay, formatShort } from "@/lib/format.ts";
import { useTenant } from "@/components/tenant-provider.tsx";
import { trpc } from "../../trpc.ts";
import { CATEGORY_LABELS, parseAttribution, type MovementItem } from "./types.ts";
import type { FilterOptions } from "./filters-bar.tsx";

export type GroupBy = "batch" | "campaign" | "category";
export type SortBy = "occurred_at" | "amount" | "op_number" | "category";
export type SortDir = "asc" | "desc";

export type GroupTotal = { group: string; gasto: number; ingreso: number; neto: number; count: number };

type Props = {
  movements?: MovementItem[];
  isLoading?: boolean;
  total: number;
  page: number;
  pageCount: number;
  pageSize: number;
  sortBy?: SortBy;
  sortDir?: SortDir;
  filtered: boolean;
  groupBy?: GroupBy;
  groups?: GroupTotal[];
  isLoadingGroups?: boolean;
  lotes?: FilterOptions["lotes"];
  /** filtros base (queryInput de la página) para las queries hijas de grupos expandidos */
  baseQuery: Record<string, unknown>;
  onSortChange: (by: SortBy | undefined, dir: SortDir | undefined) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onGroupByChange: (g: GroupBy | undefined) => void;
  onDrillGroup: (groupValue: string) => void;
  onSelectMovement: (id: string) => void;
};

// Columna visual ↔ columna ordenable en SQL (whitelist del servidor)
const SORTABLE: Record<string, SortBy> = {
  op: "op_number",
  fecha: "occurred_at",
  categoria: "category",
  monto: "amount",
};
const SORT_TO_COL: Record<SortBy, string> = {
  op_number: "op",
  occurred_at: "fecha",
  category: "categoria",
  amount: "monto",
};

const columnHelper = createColumnHelper<MovementItem>();

/** Celdas de una fila de movimiento — compartidas entre vista plana y filas hijas de grupo. */
function MovementCells({ mov, showTenant }: { mov: MovementItem; showTenant: boolean }) {
  const { farmName } = useTenant();
  const isVoided = Boolean(mov.voided_by || mov.anula_a);
  const isIngreso = mov.kind === "ingreso";
  const amountNum = typeof mov.amount === "string" ? parseFloat(mov.amount) : Number(mov.amount);
  const dateStr = mov.occurred_at ? formatDay(mov.occurred_at) : formatShort(mov.ts);
  const categoryLabel = CATEGORY_LABELS[mov.category] ?? mov.category;
  const attributions = parseAttribution(mov.attribution);

  return (
    <>
      <TableCell className="font-mono text-xs font-medium">
        <div className="flex items-center gap-1.5">
          {isVoided ? (
            <Ban className="h-3 w-3 text-destructive shrink-0" />
          ) : isIngreso ? (
            <ArrowUpRight className="h-3 w-3 text-emerald-600 dark:text-emerald-400 shrink-0" />
          ) : (
            <ArrowDownLeft className="h-3 w-3 text-red-600 dark:text-red-400 shrink-0" />
          )}
          <span className={isVoided ? "line-through text-muted-foreground" : ""}>
            {mov.op_number ?? mov.id.slice(0, 8)}
          </span>
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground whitespace-nowrap font-mono">{dateStr}</TableCell>
      {showTenant && (
        <TableCell className="text-xs font-medium whitespace-nowrap">{farmName(mov.tenant)}</TableCell>
      )}
      <TableCell className="whitespace-nowrap">
        <Badge variant="outline" className="text-xs font-normal">{categoryLabel}</Badge>
      </TableCell>
      <TableCell className="text-xs">
        {mov.scope === "finca" || attributions.length === 0 ? (
          <span className="text-muted-foreground italic">General</span>
        ) : (
          <div className="flex flex-wrap gap-1">
            {attributions.map((attr, idx) => (
              <Badge key={idx} variant="secondary" className="text-[10px] py-0 px-1.5 font-normal flex items-center gap-1">
                <span>{attr.module}</span>
                {attr.batch && <span className="font-mono text-muted-foreground">({attr.batch})</span>}
              </Badge>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell className="text-xs max-w-[200px] truncate text-muted-foreground">{mov.note || "—"}</TableCell>
      <TableCell className="text-center">
        {mov.evidence_count > 0 ? (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-mono inline-flex items-center gap-0.5">
            <Paperclip className="h-3 w-3" />
            {mov.evidence_count}
          </Badge>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell className="text-right font-mono text-xs whitespace-nowrap">
        <div className="flex flex-col items-end">
          <span
            className={`font-semibold ${
              isVoided
                ? "line-through text-muted-foreground"
                : isIngreso
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-red-600 dark:text-red-400"
            }`}
          >
            {isIngreso ? "+" : "-"}
            {formatMoney(amountNum, mov.currency)}
          </span>
          {isVoided && (
            <Badge variant="destructive" className="text-[9px] py-0 px-1 h-3.5 mt-0.5 font-sans">Anulado</Badge>
          )}
        </div>
      </TableCell>
    </>
  );
}

/** Filas hijas de un grupo expandido: query filtrada a ese grupo (máx 50; "ver todos" aplica drill). */
function GroupRows({
  groupValue,
  groupBy,
  baseQuery,
  sortBy,
  sortDir,
  showTenant,
  onSelectMovement,
  onDrillGroup,
}: {
  groupValue: string;
  groupBy: GroupBy;
  baseQuery: Record<string, unknown>;
  sortBy?: SortBy;
  sortDir?: SortDir;
  showTenant: boolean;
  onSelectMovement: (id: string) => void;
  onDrillGroup: (g: string) => void;
}) {
  const groupFilter =
    groupBy === "batch" ? { batch: groupValue } : groupBy === "campaign" ? { campaign: groupValue } : { category: groupValue };
  const { data, isLoading } = useQuery({
    queryKey: ["finance.movements", "group-rows", groupBy, groupValue, baseQuery, sortBy, sortDir],
    queryFn: () =>
      trpc.finance.movements.query({
        ...baseQuery,
        ...groupFilter,
        page: 1,
        pageSize: 50,
        sortBy,
        sortDir,
      } as never),
  });
  const colSpan = showTenant ? 9 : 8;

  if (isLoading) {
    return (
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={colSpan} className="py-2 pl-10">
          <div className="space-y-1.5">
            <Skeleton className="h-7 w-full" />
            <Skeleton className="h-7 w-11/12" />
          </div>
        </TableCell>
      </TableRow>
    );
  }
  const rows = (data?.rows ?? []) as MovementItem[];
  const total = data?.total ?? 0;
  return (
    <>
      {rows.map((mov) => {
        const isVoided = Boolean(mov.voided_by || mov.anula_a);
        return (
          <TableRow
            key={mov.id}
            onClick={() => onSelectMovement(mov.id)}
            className={`cursor-pointer transition-colors hover:bg-muted/60 bg-muted/10 ${isVoided ? "opacity-60" : ""}`}
          >
            <MovementCells mov={mov} showTenant={showTenant} />
          </TableRow>
        );
      })}
      {total > rows.length && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={colSpan} className="py-1.5 pl-10">
            <Button variant="link" size="sm" className="h-6 px-1 text-xs" onClick={() => onDrillGroup(groupValue)}>
              Ver los {total} movimientos del grupo →
            </Button>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

function groupLabel(groupBy: GroupBy, groupValue: string, lotes?: FilterOptions["lotes"]): { title: string; sub?: string } {
  if (groupBy === "category") return { title: CATEGORY_LABELS[groupValue] ?? groupValue };
  if (groupBy === "campaign") return { title: groupValue === "sin_campana" ? "Sin campaña" : groupValue };
  const lote = lotes?.find((l) => l.code === groupValue);
  if (groupValue === "sin_lote") return { title: "Sin lote (general de finca)" };
  return {
    title: groupValue,
    sub: lote ? `${lote.crop}${lote.state === "closed" ? " · cerrado" : ""}` : undefined,
  };
}

export function MovementsTable({
  movements, isLoading, total, page, pageCount, pageSize,
  sortBy, sortDir, filtered, groupBy, groups, isLoadingGroups, lotes, baseQuery,
  onSortChange, onPageChange, onPageSizeChange, onGroupByChange, onDrillGroup, onSelectMovement,
}: Props) {
  const { active } = useTenant();
  const showTenant = active === null;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // TanStack Table v8: estructura + estado de sort (manual — el orden ocurre en SQL)
  const columns = useMemo(
    () => [
      columnHelper.accessor((m) => m.op_number ?? m.id, { id: "op", enableSorting: true }),
      columnHelper.accessor((m) => m.occurred_at ?? m.ts, { id: "fecha", enableSorting: true }),
      ...(showTenant ? [columnHelper.accessor((m) => m.tenant, { id: "finca", enableSorting: false })] : []),
      columnHelper.accessor((m) => m.category, { id: "categoria", enableSorting: true }),
      columnHelper.display({ id: "imputacion" }),
      columnHelper.display({ id: "nota" }),
      columnHelper.display({ id: "evid" }),
      columnHelper.accessor((m) => Number(m.amount), { id: "monto", enableSorting: true }),
    ],
    [showTenant]
  );

  const sorting: SortingState = useMemo(
    () => (sortBy ? [{ id: SORT_TO_COL[sortBy], desc: sortDir !== "asc" }] : []),
    [sortBy, sortDir]
  );

  const table = useReactTable({
    data: (movements ?? []) as MovementItem[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    state: { sorting },
    onSortingChange: (updater) => {
      const next = typeof updater === "function" ? updater(sorting) : updater;
      const s = next[0];
      if (!s) onSortChange(undefined, undefined);
      else onSortChange(SORTABLE[s.id], s.desc ? "desc" : "asc");
    },
  });

  const HEADERS: Record<string, { label: string; className?: string }> = {
    op: { label: "Operación", className: "w-[100px]" },
    fecha: { label: "Fecha", className: "w-[110px]" },
    finca: { label: "Finca" },
    categoria: { label: "Categoría" },
    imputacion: { label: "Imputación" },
    nota: { label: "Nota", className: "max-w-[200px]" },
    evid: { label: "Evid.", className: "text-center w-[60px]" },
    monto: { label: "Monto", className: "text-right w-[140px]" },
  };

  const headerRow = (
    <TableRow className="hover:bg-transparent">
      {table.getHeaderGroups()[0]?.headers.map((header) => {
        const meta = HEADERS[header.column.id] ?? { label: header.column.id };
        const sortable = SORTABLE[header.column.id] !== undefined;
        const sorted = header.column.getIsSorted(); // false | "asc" | "desc"
        return (
          <TableHead key={header.id} className={meta.className}>
            {sortable ? (
              <button
                type="button"
                onClick={header.column.getToggleSortingHandler()}
                className={`inline-flex items-center gap-1 font-medium hover:text-foreground transition-colors ${
                  sorted ? "text-foreground" : "text-muted-foreground"
                } ${meta.className?.includes("text-right") ? "flex-row-reverse w-full" : ""}`}
              >
                {flexRender(meta.label, header.getContext())}
                {sorted === "asc" ? (
                  <ArrowUp className="size-3" />
                ) : sorted === "desc" ? (
                  <ArrowDown className="size-3" />
                ) : (
                  <ArrowUpDown className="size-3 opacity-40" />
                )}
              </button>
            ) : (
              meta.label
            )}
          </TableHead>
        );
      })}
    </TableRow>
  );

  const groupToggle = (
    <ToggleGroup
      variant="outline"
      size="sm"
      spacing={2}
      value={[groupBy ?? "none"]}
      onValueChange={(v) => {
        const val = (v as string[])[0];
        onGroupByChange(val === "none" || val === undefined ? undefined : (val as GroupBy));
      }}
      aria-label="Agrupar movimientos"
    >
      <ToggleGroupItem value="none" className="text-xs h-7 px-2">Sin agrupar</ToggleGroupItem>
      <ToggleGroupItem value="batch" className="text-xs h-7 px-2">Lote</ToggleGroupItem>
      <ToggleGroupItem value="campaign" className="text-xs h-7 px-2">Campaña</ToggleGroupItem>
      <ToggleGroupItem value="category" className="text-xs h-7 px-2">Categoría</ToggleGroupItem>
    </ToggleGroup>
  );

  if (isLoading || (groupBy && isLoadingGroups)) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="text-base font-semibold">Movimientos</CardTitle>
            {groupToggle}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const flatEmpty = !groupBy && (!movements || movements.length === 0);
  const groupEmpty = !!groupBy && (!groups || groups.length === 0);
  if (flatEmpty || groupEmpty) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <CardTitle className="text-base font-semibold">Movimientos</CardTitle>
            {groupToggle}
          </div>
        </CardHeader>
        <CardContent>
          <Empty className="border border-dashed py-10">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
              <EmptyTitle>{filtered ? "Sin resultados para los filtros" : "Sin movimientos financieros"}</EmptyTitle>
              <EmptyDescription className="max-w-sm">
                {filtered
                  ? "Ningún movimiento coincide con la búsqueda o los filtros activos. Ajusta o limpia los filtros."
                  : "No se han registrado operaciones en este período. Registra el primer gasto o ingreso con el botón \"Registrar\" o por chat."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold">Movimientos</CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Historia inmutable de ingresos, gastos y correcciones. Haz clic en una fila para ver el detalle.
            </CardDescription>
          </div>
          <div className="flex items-center gap-3">
            {groupToggle}
            <Badge variant="secondary" className="font-mono text-xs">
              {groupBy ? `${groups!.length} grupo${groups!.length !== 1 ? "s" : ""}` : `${total} registro${total !== 1 ? "s" : ""}`}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>{headerRow}</TableHeader>
            <TableBody>
              {groupBy
                ? groups!.map((g) => {
                    const isOpen = !!expanded[g.group];
                    const label = groupLabel(groupBy, g.group, lotes);
                    return (
                      <Fragment key={g.group}>
                        <TableRow
                          onClick={() => setExpanded((p) => ({ ...p, [g.group]: !p[g.group] }))}
                          className="cursor-pointer bg-muted/40 hover:bg-muted/60 font-medium"
                        >
                          <TableCell colSpan={showTenant ? 4 : 3} className="text-xs">
                            <div className="flex items-center gap-1.5">
                              {isOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                              <span className="font-semibold">{label.title}</span>
                              {label.sub && <span className="text-muted-foreground font-normal">· {label.sub}</span>}
                            </div>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            <Badge variant="secondary" className="text-[10px] font-mono">{g.count} mov.</Badge>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[200px]">
                            <span className="text-emerald-600 dark:text-emerald-400 font-mono">+{formatMoney(g.ingreso)}</span>
                            {" / "}
                            <span className="text-red-600 dark:text-red-400 font-mono">-{formatMoney(g.gasto)}</span>
                          </TableCell>
                          <TableCell />
                          <TableCell className="text-right font-mono text-xs font-bold whitespace-nowrap">
                            {g.neto >= 0 ? "+" : ""}
                            {formatMoney(g.neto)}
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <GroupRows
                            groupValue={g.group}
                            groupBy={groupBy}
                            baseQuery={baseQuery}
                            sortBy={sortBy}
                            sortDir={sortDir}
                            showTenant={showTenant}
                            onSelectMovement={onSelectMovement}
                            onDrillGroup={onDrillGroup}
                          />
                        )}
                      </Fragment>
                    );
                  })
                : table.getRowModel().rows.map((row) => {
                    const mov = row.original;
                    const isVoided = Boolean(mov.voided_by || mov.anula_a);
                    return (
                      <TableRow
                        key={row.id}
                        onClick={() => onSelectMovement(mov.id)}
                        className={`cursor-pointer transition-colors hover:bg-muted/60 ${isVoided ? "opacity-60 bg-muted/20" : ""}`}
                      >
                        <MovementCells mov={mov} showTenant={showTenant} />
                      </TableRow>
                    );
                  })}
            </TableBody>
          </Table>
        </div>

        {/* Paginación server-side (solo vista plana — agrupado muestra todos los grupos) */}
        {!groupBy && (
          <div className="flex flex-col sm:flex-row items-center justify-between gap-2 px-4 py-2.5 border-t">
            <p className="text-xs text-muted-foreground font-mono">
              Página {page} de {pageCount} · {total} movimiento{total !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-3">
              <Select
                items={[25, 50, 100].map((n) => ({ label: `${n} / página`, value: n }))}
                value={pageSize}
                onValueChange={(v) => onPageSizeChange(Number(v))}
              >
                <SelectTrigger className="h-7 w-[110px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[25, 50, 100].map((n) => (
                    <SelectItem key={n} value={n} className="text-xs">{n} / página</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Pagination className="mx-0 w-auto">
                <PaginationContent>
                  <PaginationItem>
                    <PaginationPrevious
                      href="#"
                      aria-disabled={page <= 1}
                      className={page <= 1 ? "pointer-events-none opacity-50" : ""}
                      onClick={(e) => { e.preventDefault(); if (page > 1) onPageChange(page - 1); }}
                    />
                  </PaginationItem>
                  <PaginationItem>
                    <PaginationNext
                      href="#"
                      aria-disabled={page >= pageCount}
                      className={page >= pageCount ? "pointer-events-none opacity-50" : ""}
                      onClick={(e) => { e.preventDefault(); if (page < pageCount) onPageChange(page + 1); }}
                    />
                  </PaginationItem>
                </PaginationContent>
              </Pagination>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
