import * as React from "react";

type Variant = "default" | "secondary" | "destructive" | "outline" | "success" | "warn";

const styles: Record<Variant, string> = {
  default: "bg-primary text-primary-foreground",
  secondary: "bg-muted text-muted-foreground",
  destructive: "bg-red-600 text-white",
  outline: "border text-foreground",
  success: "bg-emerald-600 text-white",
  warn: "bg-amber-500 text-black"
};

export function Badge({
  variant = "default",
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: Variant }) {
  return (
    <div
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold transition-colors ${styles[variant]} ${className ?? ""}`}
      {...props}
    />
  );
}
