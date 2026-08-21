import * as React from "react";
import { Outlet } from "@tanstack/react-router";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar.tsx";
import { TooltipProvider } from "@/components/ui/tooltip.tsx";
import { Toaster } from "@/components/ui/sonner.tsx";
import { AppSidebar } from "./app-sidebar.tsx";
import { Header } from "./header.tsx";
import { CommandPalette } from "./command-palette.tsx";

export function AppShell() {
  const [commandOpen, setCommandOpen] = React.useState(false);

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <Header onOpenCommand={() => setCommandOpen(true)} />
          <main className="flex-1 overflow-y-auto p-4 md:p-6">
            <Outlet />
          </main>
        </SidebarInset>
        <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
        <Toaster />
      </SidebarProvider>
    </TooltipProvider>
  );
}
