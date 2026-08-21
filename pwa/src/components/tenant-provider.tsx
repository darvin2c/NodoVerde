import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { trpc } from "../trpc.ts";

// Tenant activo (ADR-0023): null = "Todas las fincas" (vista agregada del dueño).
// Sin auth no hay usuarios: la selección es por navegador (localStorage).
// Con auth futuro esto migra a preferencia de usuario.

const STORAGE_KEY = "terra-tenant";
export const ALL_FARMS = null;

export type ActiveTenant = string | null;

type TenantInfo = {
  id: string;
  name: string;
  location_name: string | null;
  lat: number | null;
  lon: number | null;
  tz: string | null;
  currency: string;
  archived_at: string | null;
  created_at: string;
};

type TenantContextValue = {
  active: ActiveTenant;
  setActive: (t: ActiveTenant) => void;
  tenants: TenantInfo[];
  /** Nombre display de una finca por id (fallback: el id) */
  farmName: (id: string) => string;
  /** Moneda de una finca por id (fallback: PEN) */
  farmCurrency: (id: string) => string;
  isLoading: boolean;
};

const TenantContext = React.createContext<TenantContextValue>({
  active: ALL_FARMS,
  setActive: () => {},
  tenants: [],
  farmName: (id) => id,
  farmCurrency: () => "PEN",
  isLoading: true
});

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [active, setActiveState] = React.useState<ActiveTenant>(() => {
    if (typeof window === "undefined") return ALL_FARMS;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === null || stored === "all" ? ALL_FARMS : stored;
  });

  const { data: tenants, isLoading } = useQuery({
    queryKey: ["tenants.list"],
    queryFn: () => trpc.tenants.list.query(),
    refetchInterval: 30000
  });

  // Si el tenant almacenado ya no existe (archivado), volver a "Todas"
  React.useEffect(() => {
    if (!tenants || active === ALL_FARMS) return;
    if (!tenants.some((t) => t.id === active)) setActiveState(ALL_FARMS);
  }, [tenants, active]);

  const setActive = React.useCallback((t: ActiveTenant) => {
    setActiveState(t);
    window.localStorage.setItem(STORAGE_KEY, t ?? "all");
  }, []);

  const farmName = React.useCallback(
    (id: string) => tenants?.find((t) => t.id === id)?.name ?? id,
    [tenants]
  );
  const farmCurrency = React.useCallback(
    (id: string) => tenants?.find((t) => t.id === id)?.currency ?? "PEN",
    [tenants]
  );

  const value = React.useMemo(
    () => ({ active, setActive, tenants: tenants ?? [], farmName, farmCurrency, isLoading }),
    [active, setActive, tenants, farmName, farmCurrency, isLoading]
  );
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant() {
  return React.useContext(TenantContext);
}
