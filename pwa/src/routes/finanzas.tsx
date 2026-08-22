import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Wallet, AlertCircle, Search, Download } from "lucide-react";
import { trpc } from "../trpc.ts";
import { finanzasRoute } from "../router.tsx";
import { useTenant } from "@/components/tenant-provider.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { FinanceSummary } from "@/components/finanzas/finance-summary.tsx";
import { MovementsTable } from "@/components/finanzas/movements-table.tsx";
import { MovementDetailDrawer } from "@/components/finanzas/movement-detail-drawer.tsx";
import { MovementFormDialog } from "@/components/finanzas/movement-form-dialog.tsx";
import { VoidDialog } from "@/components/finanzas/void-dialog.tsx";
import { FiltersBar, type FinanceFilterState } from "@/components/finanzas/filters-bar.tsx";
import { formatMoney } from "@/lib/format.ts";
import type { MovementItem } from "@/components/finanzas/types.ts";
import type { SortBy, SortDir } from "@/components/finanzas/movements-table.tsx";

// URL sort param ↔ (sortBy, sortDir) del servidor
const SORT_MAP = {
  fecha_asc: { by: "occurred_at", dir: "asc" },
  monto_desc: { by: "amount", dir: "desc" },
  monto_asc: { by: "amount", dir: "asc" },
  op_desc: { by: "op_number", dir: "desc" },
  op_asc: { by: "op_number", dir: "asc" },
  cat_desc: { by: "category", dir: "desc" },
  cat_asc: { by: "category", dir: "asc" },
} as const;
const SORT_URL: Record<string, string | undefined> = {
  "occurred_at:desc": undefined, // default — no ensuciar la URL
  "occurred_at:asc": "fecha_asc",
  "amount:desc": "monto_desc",
  "amount:asc": "monto_asc",
  "op_number:desc": "op_desc",
  "op_number:asc": "op_asc",
  "category:desc": "cat_desc",
  "category:asc": "cat_asc",
};

export function FinanzasPage() {
  const { active } = useTenant();
  const search = finanzasRoute.useSearch();
  const navigate = useNavigate();

  const [selectedMovementId, setSelectedMovementId] = useState<string | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingMovement, setEditingMovement] = useState<MovementItem | null>(null);
  const [voidingMovement, setVoidingMovement] = useState<MovementItem | null>(null);
  const [searchDraft, setSearchDraft] = useState(search.q ?? "");

  // Filtros activos (URL = fuente de verdad: links compartibles)
  const filters: FinanceFilterState = useMemo(
    () => ({ desde: search.desde, hasta: search.hasta, tipo: search.tipo, cat: search.cat, camp: search.camp, lote: search.lote, mod: search.mod }),
    [search.desde, search.hasta, search.tipo, search.cat, search.camp, search.lote, search.mod]
  );
  const includeVoided = search.anul !== 0;
  const page = search.page ?? 1;
  const pageSize = search.size ?? 25;
  const groupBy = search.agrup;
  const sortState = search.sort ? SORT_MAP[search.sort as keyof typeof SORT_MAP] : undefined;
  const sortBy = sortState?.by as SortBy | undefined;
  const sortDir = sortState?.dir as SortDir | undefined;
  const hasFilters = !!(filters.desde || filters.hasta || filters.tipo || filters.cat || filters.camp || filters.lote || filters.mod || search.q);

  const setSearch = (patch: Record<string, unknown>) =>
    navigate({ to: "/finanzas", search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }), replace: true });

  // El filtrado cambia de conjunto → volver a página 1 (salvo cambio de página/tamaño)
  const patchFilters = (patch: Record<string, unknown>) => setSearch({ ...patch, page: undefined });

  // Query params hacia tRPC (mismo shape que financeFilters)
  const queryInput = useMemo(
    () => ({
      tenant: active ?? undefined,
      kind: filters.tipo,
      category: filters.cat,
      campaign: filters.camp,
      batch: filters.lote,
      module: filters.mod,
      from: filters.desde,
      to: filters.hasta,
      search: search.q,
      includeVoided
    }),
    [active, filters, search.q, includeVoided]
  );

  // Consultas tRPC — todo reactivo a los filtros
  const { data: summary, isLoading: isLoadingSummary } = useQuery({
    queryKey: ["finance.filteredSummary", queryInput],
    queryFn: () => trpc.finance.filteredSummary.query(queryInput),
    refetchInterval: 30000
  });

  const { data: movementsPage, isLoading: isLoadingMovements } = useQuery({
    queryKey: ["finance.movements", queryInput, page, pageSize, search.sort],
    queryFn: () =>
      trpc.finance.movements.query({
        ...queryInput,
        page,
        pageSize,
        sortBy,
        sortDir
      }),
    refetchInterval: 30000,
    enabled: !groupBy // vista agrupada: las filas las cargan los grupos expandidos
  });

  const { data: grouped, isLoading: isLoadingGrouped } = useQuery({
    queryKey: ["finance.groupedTotals", queryInput, groupBy],
    queryFn: () => trpc.finance.groupedTotals.query({ ...queryInput, groupBy: groupBy ?? "batch" }),
    enabled: !!groupBy
  });

  const { data: filterOptions } = useQuery({
    queryKey: ["finance.filterOptions", active],
    queryFn: () => trpc.finance.filterOptions.query({ tenant: active ?? undefined }),
    staleTime: 30000
  });

  const handleExport = async () => {
    const res = await trpc.finance.exportCsv.query(queryInput);
    const blob = new Blob([res.csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `movimientos-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const submitSearch = () => {
    const q = searchDraft.trim();
    if ((q || undefined) !== search.q) patchFilters({ q: q || undefined });
  };

  const handleOpenCreateForm = () => {
    setEditingMovement(null);
    setIsFormOpen(true);
  };

  const handleOpenEditForm = (mov: MovementItem) => {
    setEditingMovement(mov);
    setIsFormOpen(true);
  };

  return (
    <div className="space-y-6">
      {/* Header Principal */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Wallet className="h-6 w-6 text-primary" /> Finanzas
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Resumen contable, registro omnicanal y control de ingresos, gastos y evidencias por finca.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleExport} title="Exporta los movimientos con los filtros activos (CSV)">
            <Download className="h-4 w-4" /> Exportar
          </Button>
          <Button
            onClick={handleOpenCreateForm}
            disabled={active === null}
            size="sm"
            className="gap-1.5 font-medium shadow-xs"
          >
            <Plus className="h-4 w-4" /> Registrar
          </Button>
        </div>
      </div>
      {active === null && (
        <p className="text-[10px] text-muted-foreground -mt-4 flex items-center gap-1">
          <AlertCircle className="h-3 w-3 text-amber-500" /> Selecciona una finca para registrar
        </p>
      )}

      {/* Barra de filtros (cascada campaña → lote → módulo) + búsqueda */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <FiltersBar
          value={filters}
          options={filterOptions}
          includeVoided={includeVoided}
          onChange={(patch) => {
            const { includeVoided: iv, ...rest } = patch;
            patchFilters({ ...rest, ...(iv !== undefined ? { anul: iv ? undefined : 0 } : {}) });
          }}
          onClear={() => setSearch({ desde: undefined, hasta: undefined, tipo: undefined, cat: undefined, camp: undefined, lote: undefined, mod: undefined, page: undefined })}
        />
        <div className="relative lg:ml-auto w-full lg:w-64">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitSearch()}
            onBlur={submitSearch}
            placeholder="MOV-0001, nota, Yape…"
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>

      {/* KPIs reactivos + overhead declarado (nunca prorrateado) */}
      <FinanceSummary summary={summary} isLoading={isLoadingSummary} filtered={hasFilters} />

      {summary?.overhead != null && (
        <p className="text-xs text-muted-foreground -mt-3">
          Además hay <span className="font-medium text-foreground">{formatMoney(summary.overhead, summary.currency)}</span> de
          gastos generales de finca en el período, no imputados a {filters.lote ?? filters.camp ?? filters.mod} — no se prorratean para no inventar precisión.
        </p>
      )}
      {summary?.costo_por_kg != null && (
        <p className="text-xs -mt-3">
          <span className="font-medium">Costo por kg: {formatMoney(summary.costo_por_kg, summary.currency)}/kg</span>
          <span className="text-muted-foreground"> sobre {summary.yield_kg} kg declarados al cierre.</span>
        </p>
      )}

      {/* Tabla única: plana o árbol de grupos expandibles (subtotales SQL) */}
      <MovementsTable
        movements={movementsPage?.rows as MovementItem[] | undefined}
        isLoading={!groupBy && isLoadingMovements}
        total={movementsPage?.total ?? 0}
        page={page}
        pageCount={movementsPage?.pageCount ?? 1}
        pageSize={pageSize}
        sortBy={sortBy}
        sortDir={sortDir}
        onSortChange={(by, dir) => setSearch({ sort: by ? SORT_URL[`${by}:${dir ?? "desc"}`] : undefined, page: undefined })}
        onPageChange={(p) => setSearch({ page: p <= 1 ? undefined : p })}
        onPageSizeChange={(s) => setSearch({ size: s === 25 ? undefined : s, page: undefined })}
        groupBy={groupBy}
        groups={(grouped ?? []) as { group: string; gasto: number; ingreso: number; neto: number; count: number }[]}
        isLoadingGroups={!!groupBy && isLoadingGrouped}
        lotes={filterOptions?.lotes}
        baseQuery={queryInput}
        onGroupByChange={(g) => setSearch({ agrup: g, page: undefined })}
        onDrillGroup={(groupValue) => {
          // Los sentinelas (sin_lote/sin_campana) son filtros válidos desde el addendum UX
          if (groupBy === "batch") patchFilters({ lote: groupValue, agrup: undefined });
          else if (groupBy === "campaign") patchFilters({ camp: groupValue, agrup: undefined });
          else patchFilters({ cat: groupValue, agrup: undefined });
        }}
        filtered={hasFilters}
        onSelectMovement={(id) => setSelectedMovementId(id)}
      />

      {/* Detalle en Drawer (derecha en desktop, bottom-sheet con swipe en móvil) */}
      <MovementDetailDrawer
        movementId={selectedMovementId}
        onClose={() => setSelectedMovementId(null)}
        onEdit={(mov) => handleOpenEditForm(mov)}
        onVoid={(mov) => setVoidingMovement(mov)}
      />

      {/* Formulario Dialog (Creación / Edición) */}
      <MovementFormDialog
        open={isFormOpen}
        mode={editingMovement ? "edit" : "create"}
        initialData={editingMovement}
        onClose={() => {
          setIsFormOpen(false);
          setEditingMovement(null);
        }}
        onSuccess={() => {
          setSelectedMovementId(null);
        }}
      />

      {/* Dialog de Anulación */}
      <VoidDialog
        movement={voidingMovement}
        onClose={() => setVoidingMovement(null)}
        onSuccess={() => {
          setSelectedMovementId(null);
        }}
      />
    </div>
  );
}
