export interface ProvenanceLeg {
  label: string;
  detail: string;
  live: boolean;
}

export function ProvenanceBar({ legs }: { legs: ProvenanceLeg[] }) {
  return (
    <ul aria-label="Live and simulated product capabilities" className="flex flex-wrap gap-2">
      {legs.map((leg) => (
        <li
          key={leg.label}
          className={
            leg.live
              ? "surface-shadow flex items-center gap-2 rounded-full border border-proof-line bg-proof-soft px-3 py-1.5"
              : "hatch flex items-center gap-2 rounded-full border border-dashed border-line-strong bg-surface/70 px-3 py-1.5"
          }
        >
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${leg.live ? "bg-proof shadow-[0_0_0_3px_var(--color-proof-soft)]" : "border border-dashed border-ink-3"}`} />
          <span className="text-[0.8125rem] font-medium text-ink">
            {leg.label} <span className="font-normal text-ink-2">· {leg.detail}</span>
          </span>
          <span className={`font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.1em] ${leg.live ? "text-proof" : "text-ink-2"}`}>
            {leg.live ? "Live" : "Simulated"}
          </span>
        </li>
      ))}
    </ul>
  );
}
