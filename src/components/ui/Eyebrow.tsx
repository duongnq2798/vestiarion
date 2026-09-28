import type { ReactNode } from "react";
import { cn } from "./cn";

/** The small monospaced caption above a figure or a heading. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3", className)}>{children}</span>;
}
