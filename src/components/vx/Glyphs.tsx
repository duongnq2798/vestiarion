import type { Domain, Outcome } from "./types";

type GlyphProps = { className?: string };

export const DOMAINS: Domain[] = ["ap", "ar", "contractor", "treasury", "compliance", "system"];

export const DOMAIN_CODE: Record<Domain, string> = {
  ap: "AP",
  ar: "AR",
  contractor: "CTR",
  treasury: "TRS",
  compliance: "CMP",
  system: "SYS",
};

export const DOMAIN_NAME: Record<Domain, string> = {
  ap: "Payables",
  ar: "Receivables",
  contractor: "Contractors",
  treasury: "Treasury",
  compliance: "Compliance",
  system: "System",
};

export function DomainGlyph({
  domain,
  className = "size-3",
  filled = false,
}: GlyphProps & { domain: Domain; filled?: boolean }) {
  const fill = filled ? "currentColor" : "none";
  const common = { fill, stroke: "currentColor", strokeWidth: 1.5 } as const;

  return (
    <svg viewBox="0 0 12 12" className={`shrink-0 ${className}`} aria-hidden>
      {(domain === "ap" || domain === "ar") && (
        <rect x="2" y="1.75" width="8" height="8.5" rx="1" {...common} />
      )}
      {domain === "contractor" && (
        <path d="M6 1.75 10.5 10H1.5Z" strokeLinejoin="round" {...common} />
      )}
      {domain === "treasury" && <circle cx="6" cy="6" r="4.25" {...common} />}
      {domain === "compliance" && (
        <path d="M6 1.25 10.75 6 6 10.75 1.25 6Z" strokeLinejoin="round" {...common} />
      )}
      {domain === "system" && (
        <path d="M1.75 4.5h8.5M1.75 7.5h8.5" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      )}
    </svg>
  );
}

export function OutcomeGlyph({ outcome, className = "size-3.5" }: GlyphProps & { outcome: Outcome }) {
  return (
    <svg viewBox="0 0 14 14" className={`shrink-0 ${className}`} aria-hidden>
      {outcome === "settled" && (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="m4.2 7.2 1.9 1.9 3.8-4" fill="none" stroke="var(--color-ground)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      {(outcome === "scheduled" || outcome === "recorded") && (
        <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth={1.5} />
      )}
      {outcome === "held" && (
        <>
          <circle cx="7" cy="7" r="6" fill="currentColor" />
          <path d="M5.5 4.5v5M8.5 4.5v5" stroke="var(--color-ground)" strokeWidth={1.6} strokeLinecap="round" />
        </>
      )}
      {outcome === "refused" && (
        <>
          <path d="M4.5 1h5L13 4.5v5L9.5 13h-5L1 9.5v-5Z" fill="currentColor" />
          <path d="M4.3 7h5.4" stroke="var(--color-ground)" strokeWidth={1.8} strokeLinecap="round" />
        </>
      )}
      {outcome === "simulated" && (
        <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray="2.2 2" />
      )}
    </svg>
  );
}

export function ShieldGlyph({ className = "size-5" }: GlyphProps) {
  return (
    <svg viewBox="0 0 20 20" className={`shrink-0 ${className}`} aria-hidden>
      <path d="M10 1.8 3.2 4.4v5.1c0 4.1 2.9 7.3 6.8 8.7 3.9-1.4 6.8-4.6 6.8-8.7V4.4Z" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" />
      <path d="M6.8 10h6.4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" />
    </svg>
  );
}

export function ArrowGlyph({ className = "size-3" }: GlyphProps) {
  return (
    <svg viewBox="0 0 12 12" className={`shrink-0 ${className}`} aria-hidden>
      <path d="M2 6h7.5M6.5 3 9.5 6l-3 3" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ChevronGlyph({ className = "size-3" }: GlyphProps) {
  return (
    <svg viewBox="0 0 12 12" className={`shrink-0 ${className}`} aria-hidden>
      <path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CheckGlyph({ className = "size-3" }: GlyphProps) {
  return (
    <svg viewBox="0 0 12 12" className={`shrink-0 ${className}`} aria-hidden>
      <path d="m2.5 6.3 2.3 2.2 4.7-5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CrossGlyph({ className = "size-3" }: GlyphProps) {
  return (
    <svg viewBox="0 0 12 12" className={`shrink-0 ${className}`} aria-hidden>
      <path d="m3 3 6 6M9 3 3 9" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}
