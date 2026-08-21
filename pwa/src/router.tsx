import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/app-shell.tsx";
import { OverviewPage } from "./routes/overview.tsx";
import { ModulosPage } from "./routes/modulos.tsx";
import { ModuloDetallePage } from "./routes/modulo-detalle.tsx";
import { AlertasPage } from "./routes/alertas.tsx";
import { FinanzasPage } from "./routes/finanzas.tsx";
import { AprobacionesPage } from "./routes/aprobaciones.tsx";
import { CamarasPage } from "./routes/camaras.tsx";
import { FincasPage } from "./routes/fincas.tsx";
import { SistemaPage } from "./routes/sistema.tsx";

const rootRoute = createRootRoute({ component: AppShell });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/modulos", component: ModulosPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/modulos/$moduleId", component: ModuloDetallePage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/alertas", component: AlertasPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/finanzas", component: FinanzasPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/aprobaciones", component: AprobacionesPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/camaras", component: CamarasPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/fincas", component: FincasPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/sistema", component: SistemaPage })
]);

export const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register { router: typeof router; }
}
