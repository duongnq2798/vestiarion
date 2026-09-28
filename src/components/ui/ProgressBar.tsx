import { cn } from "./cn";

/** Progress towards a known end (`value`, 0–100), or indeterminate work when there is no value. */
export function ProgressBar({ value, label, className }: { value?: number; label: string; className?: string }) {
  const percent = value == null ? null : Math.round(Math.min(100, Math.max(0, value)));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent ?? undefined}
      className={cn("relative h-1 w-full overflow-hidden rounded-full bg-agent-soft", className)}
    >
      {percent == null ? (
        <span className="absolute inset-y-0 left-0 w-2/5 rounded-full bg-agent animate-sweep" />
      ) : (
        <span className="absolute inset-y-0 left-0 rounded-full bg-agent transition-[width] duration-300 ease-standard" style={{ width: `${percent}%` }} />
      )}
    </div>
  );
}
