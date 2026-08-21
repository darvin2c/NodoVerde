import { Link, useRouterState } from "@tanstack/react-router";
import {
  LayoutDashboard, Boxes, TriangleAlert, Wallet, CheckSquare, Camera, Activity, Sprout, MapPinned
} from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge, SidebarMenuButton,
  SidebarMenuItem, SidebarRail
} from "@/components/ui/sidebar.tsx";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../../trpc.ts";
import { useTenant } from "@/components/tenant-provider.tsx";

const NAV_MAIN = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/modulos", label: "Módulos", icon: Boxes },
  { to: "/alertas", label: "Alertas", icon: TriangleAlert },
] as const;

const NAV_OPS = [
  { to: "/aprobaciones", label: "Aprobaciones", icon: CheckSquare },
  { to: "/finanzas", label: "Finanzas", icon: Wallet },
  { to: "/camaras", label: "Cámaras", icon: Camera },
] as const;

const NAV_SYS = [
  { to: "/fincas", label: "Fincas", icon: MapPinned },
  { to: "/sistema", label: "Sistema", icon: Activity },
] as const;

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { active } = useTenant();

  const { data: kpis } = useQuery({
    queryKey: ["overview.kpis", active],
    queryFn: () => trpc.overview.kpis.query(active ? { tenant: active } : undefined),
    refetchInterval: 15000
  });
  const openAlerts = (kpis?.openAlerts.warn ?? 0) + (kpis?.openAlerts.critical ?? 0);
  const pending = kpis?.pendingApprovals ?? 0;

  function isActive(to: string) {
    return to === "/" ? pathname === "/" : pathname.startsWith(to);
  }

  function renderItems(items: readonly { to: string; label: string; icon: typeof LayoutDashboard }[]) {
    return items.map((item) => (
      <SidebarMenuItem key={item.to}>
        <SidebarMenuButton
          isActive={isActive(item.to)}
          render={<Link to={item.to} />}
        >
          <item.icon />
          <span>{item.label}</span>
        </SidebarMenuButton>
        {item.to === "/alertas" && openAlerts > 0 && (
          <SidebarMenuBadge className="bg-destructive/15 text-destructive">{openAlerts}</SidebarMenuBadge>
        )}
        {item.to === "/aprobaciones" && pending > 0 && (
          <SidebarMenuBadge className="bg-warning/15 text-warning">{pending}</SidebarMenuBadge>
        )}
      </SidebarMenuItem>
    ));
  }

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link to="/" />}>
              <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Sprout className="size-4" />
              </div>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">terraOS</span>
                <span className="truncate text-xs text-muted-foreground">{kpis?.campaign ? `campaña ${kpis.campaign.crop}` : "panel de control"}</span>
              </div>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Monitoreo</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(NAV_MAIN)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Operación</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(NAV_OPS)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Plataforma</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(NAV_SYS)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href="http://localhost:8124" target="_blank" rel="noreferrer" />}>
              <span className="text-xs text-muted-foreground">Home Assistant ↗</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton render={<a href="http://localhost:3001" target="_blank" rel="noreferrer" />}>
              <span className="text-xs text-muted-foreground">Grafana ↗</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
