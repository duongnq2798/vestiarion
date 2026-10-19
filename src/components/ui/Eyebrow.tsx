import type { ReactNode } from "react";
import { cn } from "./cn";

/** The small monospaced caption above a figure or a heading. */
export function Eyebrow({ children, className, inverse = false }: { children: ReactNode; className?: string; inverse?: boolean }) {
  return <span className={cn("font-mono text-eyebrow font-semibold uppercase tracking-[0.11em]", inverse ? "text-on-agent-muted" : "text-ink-3", className)}>{children}</span>;
}
