// util simple para combinar clases (sin clsx externo para mantener deps mínimas)
export function cn(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}
