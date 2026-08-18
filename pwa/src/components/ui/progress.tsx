import * as React from "react";

export function Progress({ value = 0, className }: { value?: number; className?: string }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={`h-2 w-full overflow-hidden rounded-full bg-muted ${className ?? ""}`}>
      <div className="h-full bg-emerald-500 transition-all" style={{ width: `${v}%` }} />
    </div>
  );
}
