import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  LayoutDashboard, Boxes, TriangleAlert, Wallet, CheckSquare, Camera, Activity
} from "lucide-react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList
} from "@/components/ui/command.tsx";

const DESTINATIONS = [
  { to: "/", label: "Overview", icon: LayoutDashboard, keywords: "inicio resumen" },
  { to: "/modulos", label: "Módulos", icon: Boxes, keywords: "modulos cultivo confianza" },
  { to: "/alertas", label: "Alertas", icon: TriangleAlert, keywords: "errores warnings problemas" },
  { to: "/aprobaciones", label: "Aprobaciones", icon: CheckSquare, keywords: "portero pendientes aprobar" },
  { to: "/finanzas", label: "Finanzas", icon: Wallet, keywords: "dinero gastos movimientos" },
  { to: "/camaras", label: "Cámaras", icon: Camera, keywords: "fotos camaras" },
  { to: "/sistema", label: "Sistema", icon: Activity, keywords: "servicios salud broker" }
] as const;

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const navigate = useNavigate();

  React.useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Ir a…" />
      <CommandList>
        <CommandEmpty>Sin resultados.</CommandEmpty>
        <CommandGroup heading="Navegación">
          {DESTINATIONS.map((d) => (
            <CommandItem
              key={d.to}
              value={`${d.label} ${d.keywords}`}
              onSelect={() => { onOpenChange(false); navigate({ to: d.to }); }}
            >
              <d.icon className="size-4" />
              <span>{d.label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
