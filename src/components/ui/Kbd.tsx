import type { ReactNode } from "react";
import { cn } from "./cn";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line-strong bg-surface px-1.5 font-mono text-[0.6875rem] font-medium text-ink-3 shadow-control", className)}>
      {children}
    </kbd>
  );
}
