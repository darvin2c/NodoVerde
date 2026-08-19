import { useRouterState, Link } from "@tanstack/react-router";
import { Bell, Moon, Sun, Search } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../trpc.ts";
import { useTheme } from "@/components/theme-provider.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Separator } from "@/components/ui/separator.tsx";
import { SidebarTrigger } from "@/components/ui/sidebar.tsx";
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator
} from "@/components/ui/breadcrumb.tsx";

const PATH_LABELS: Record<string, string> = {
  "/": "Overview",
  "/modulos": "Módulos",
  "/alertas": "Alertas",
  "/finanzas": "Finanzas",
  "/aprobaciones": "Aprobaciones",
  "/camaras": "Cámaras",
  "/sistema": "Sistema"
};

export function Header({ onOpenCommand }: { onOpenCommand: () => void }) {
  const { theme, toggle } = useTheme();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const { data: kpis } = useQuery({
    queryKey: ["overview.kpis"],
    queryFn: () => trpc.overview.kpis.query({ tenant: "demo" }),
    refetchInterval: 15000
  });
  const openAlerts = (kpis?.openAlerts.warn ?? 0) + (kpis?.openAlerts.critical ?? 0);

  // Breadcrumb: /modulos/mod-1 → [Módulos, mod-1]
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Array<{ label: string; to?: string }> = [];
  if (segments.length === 0) {
    crumbs.push({ label: "Overview" });
  } else {
    const base = `/${segments[0]}`;
    crumbs.push({ label: PATH_LABELS[base] ?? segments[0], to: segments.length > 1 ? base : undefined });
    if (segments.length > 1) crumbs.push({ label: decodeURIComponent(segments.slice(1).join("/")) });
  }

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/80 backdrop-blur px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 h-4" />

      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink render={<Link to="/" />}>terraOS</BreadcrumbLink>
          </BreadcrumbItem>
          {crumbs.map((c, i) => (
            <span key={i} className="contents">
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                {c.to ? (
                  <BreadcrumbLink render={<Link to={c.to} />}>{c.label}</BreadcrumbLink>
                ) : (
                  <BreadcrumbPage>{c.label}</BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </span>
          ))}
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-1">
        <Button variant="outline" size="sm" className="hidden sm:flex text-muted-foreground gap-2" onClick={onOpenCommand}>
          <Search className="size-3.5" />
          <span className="text-xs">Buscar…</span>
          <kbd className="pointer-events-none rounded border bg-muted px-1.5 text-[10px] font-medium">⌘K</kbd>
        </Button>

        <Button variant="ghost" size="icon" className="relative" render={<Link to="/alertas" />}
          aria-label={`Alertas abiertas: ${openAlerts}`}
        >
          <Bell className="size-4" />
          {openAlerts > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {openAlerts}
            </span>
          )}
        </Button>

        <Button variant="ghost" size="icon" onClick={toggle} aria-label="Cambiar tema">
          {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </div>
    </header>
  );
}
