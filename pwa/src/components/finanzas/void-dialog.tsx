import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "../../trpc.ts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { MovementItem } from "./types.ts";

type Props = {
  movement: MovementItem | null;
  onClose: () => void;
  onSuccess: () => void;
};

export function VoidDialog({ movement, onClose, onSuccess }: Props) {
  const [reason, setReason] = useState("");
  const queryClient = useQueryClient();

  const voidMutation = useMutation({
    mutationFn: async () => {
      if (!movement) return;
      return trpc.finance.void.mutate({
        id: movement.id,
        tenant: movement.tenant,
        reason: reason.trim()
      });
    },
    onSuccess: (res) => {
      const voidOp = (res as { void_op?: string } | undefined)?.void_op;
      toast.success(
        `Movimiento ${movement?.op_number ?? movement?.id} anulado${
          voidOp ? ` (${voidOp})` : ""
        }`
      );
      void queryClient.invalidateQueries({ queryKey: ["finance"] });
      setReason("");
      onSuccess();
      onClose();
    },
    onError: (err: Error) => {
      toast.error(`Error al anular: ${err.message}`);
    }
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      toast.error("El motivo de anulación es obligatorio.");
      return;
    }
    voidMutation.mutate();
  };

  return (
    <Dialog open={Boolean(movement)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5 shrink-0" />
            Anular Movimiento {movement?.op_number ?? movement?.id}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Esta acción registrará un movimiento de anulación inmutable en el libro contable. El monto actual dejará de contabilizar en el balance.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground">
              Motivo de anulación <span className="text-destructive">*</span>
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ej: Registro duplicado por error, monto incorrecto..."
              rows={3}
              required
              className="text-xs"
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" size="sm" onClick={onClose}>
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="destructive"
              size="sm"
              disabled={!reason.trim() || voidMutation.isPending}
              className="gap-1.5"
            >
              {voidMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Anular movimiento
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
