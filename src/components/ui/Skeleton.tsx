import { cn } from "./cn";

/** A placeholder in the shape of what is loading. Decorative: the region around it says it is busy. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("skeleton rounded-lg", className)} />;
}
