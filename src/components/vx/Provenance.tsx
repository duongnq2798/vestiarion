export interface ProvenanceLeg {
  label: string;
  detail: string;
  live: boolean;
}

/**
 * `compact` is for the status strip above every workspace page: tighter
 * chips, and each leg's detail only where there is room for it, so on a
 * phone the three legs share two lines instead of taking three.
 */
export function ProvenanceBar({ legs, compact = false }: { legs: ProvenanceLeg[]; compact?: boolean }) {
  const pad = compact ? "px-2.5 py-1" : "px-3 py-1.5";
  return (
    <ul aria-label="Live and simulated product capabilities" className={`flex flex-wrap ${compact ? "gap-1.5" : "gap-2"}`}>
      {legs.map((leg) => (
        <li
          key={leg.label}
          className={
            leg.live
              ? `surface-shadow flex items-center gap-2 rounded-full border border-proof-line bg-proof-soft ${pad}`
              : `hatch flex items-center gap-2 rounded-full border border-dashed border-line-strong bg-surface/70 ${pad}`
          }
        >
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${leg.live ? "bg-proof shadow-[0_0_0_3px_var(--color-proof-soft)]" : "border border-dashed border-ink-3"}`} />
          <span className={`${compact ? "text-xs" : "text-[0.8125rem]"} font-medium text-ink`}>
            {leg.label}{" "}
            <span className={`font-normal text-ink-2 ${compact ? "hidden md:inline" : ""}`}>· {leg.detail}</span>
          </span>
          <span className={`font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] ${leg.live ? "text-proof" : "text-ink-2"}`}>
            {leg.live ? "Live" : "Simulated"}
          </span>
        </li>
      ))}
    </ul>
  );
}
