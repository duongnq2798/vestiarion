import { cn } from "./cn";

/** A hairline between groups. Decorative: headings and lists carry the structure. */
export function Separator({ orientation = "horizontal", className }: { orientation?: "horizontal" | "vertical"; className?: string }) {
  return <div aria-hidden className={cn("shrink-0 bg-line", orientation === "horizontal" ? "h-px w-full" : "w-px self-stretch", className)} />;
}
