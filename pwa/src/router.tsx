import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/app-shell.tsx";
import { OverviewPage } from "./routes/overview.tsx";
import { ModulosPage } from "./routes/modulos.tsx";
import { ModuloDetallePage } from "./routes/modulo-detalle.tsx";
import { AlertasPage } from "./routes/alertas.tsx";
import { FinanzasPage } from "./routes/finanzas.tsx";
import { AprobacionesPage } from "./routes/aprobaciones.tsx";
import { CamarasPage } from "./routes/camaras.tsx";
import { ProduccionPage } from "./routes/produccion.tsx";
import { PerfilesPage } from "./routes/perfiles.tsx";
import { FincasPage } from "./routes/fincas.tsx";
import { SistemaPage } from "./routes/sistema.tsx";

const rootRoute = createRootRoute({ component: AppShell });

// Filtros de /finanzas persisten en la URL (ADR-0027 addendum): link compartible filtrado
export const finanzasRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/finanzas",
  component: FinanzasPage,
  validateSearch: (search: Record<string, unknown>) => ({
    desde: typeof search.desde === "string" ? search.desde : undefined,
    hasta: typeof search.hasta === "string" ? search.hasta : undefined,
    tipo: search.tipo === "gasto" || search.tipo === "ingreso" ? search.tipo : undefined,
    cat: typeof search.cat === "string" ? search.cat : undefined,
    camp: typeof search.camp === "string" ? search.camp : undefined,
    lote: typeof search.lote === "string" ? search.lote : undefined,
    mod: typeof search.mod === "string" ? search.mod : undefined,
    q: typeof search.q === "string" ? search.q : undefined,
    anul: search.anul === 0 ? 0 : undefined,
    page: typeof search.page === "number" && search.page > 0 ? Math.floor(search.page) : undefined,
    size: typeof search.size === "number" && [25, 50, 100].includes(search.size) ? search.size : undefined,
    agrup: search.agrup === "batch" || search.agrup === "campaign" || search.agrup === "category" ? search.agrup : undefined,
    sort: ["fecha_asc", "monto_asc", "monto_desc", "op_asc", "op_desc", "cat_asc", "cat_desc"].includes(search.sort as string)
      ? (search.sort as "fecha_asc" | "monto_asc" | "monto_desc" | "op_asc" | "op_desc" | "cat_asc" | "cat_desc")
      : undefined
  })
});

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/modulos", component: ModulosPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/modulos/$moduleId", component: ModuloDetallePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/alertas", component: AlertasPage }),
  finanzasRoute,
  createRoute({ getParentRoute: () => rootRoute, path: "/aprobaciones", component: AprobacionesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/camaras", component: CamarasPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/produccion", component: ProduccionPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/perfiles", component: PerfilesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/fincas", component: FincasPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/sistema", component: SistemaPage })
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router; }
}
