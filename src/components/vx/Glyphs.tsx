import type { NavKey } from "./nav";
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

const LINE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** One line icon per workspace section, drawn on the same 20-unit grid. */
export function NavGlyph({ section, className = "size-5" }: GlyphProps & { section: NavKey }) {
  return (
    <svg viewBox="0 0 20 20" className={`shrink-0 ${className}`} aria-hidden>
      {section === "treasury" && (
        <g {...LINE}>
          <path d="M2.75 7.5 10 3.25l7.25 4.25" />
          <path d="M4.5 8.25v6.5M8.17 8.25v6.5M11.83 8.25v6.5M15.5 8.25v6.5" />
          <path d="M2.75 16.75h14.5" />
        </g>
      )}
      {section === "insights" && (
        <g {...LINE}>
          <path d="M3.25 3.25v13.5h13.5" />
          <path d="m6.5 12.5 3-3.75 2.75 2.25 4-5.25" />
        </g>
      )}
      {section === "invoices" && (
        <g {...LINE}>
          <path d="M5 2.75h6.75l3.25 3.25v11.25H5Z" />
          <path d="M11.5 2.75v3.5H15" />
          <path d="M7.75 10.25h4.5M7.75 13.5h3" />
        </g>
      )}
      {section === "counterparties" && (
        <g {...LINE}>
          <circle cx="7.5" cy="6.75" r="2.75" />
          <path d="M2.75 16.5c.45-2.9 2.3-4.5 4.75-4.5s4.3 1.6 4.75 4.5" />
          <path d="M13 4.1a2.75 2.75 0 0 1 0 5.3M14.6 12.3c1.45.6 2.35 2 2.65 4.2" />
        </g>
      )}
      {section === "contractors" && (
        <g {...LINE}>
          <path d="M4.75 17.25V2.75" />
          <path d="M4.75 3.5h10.5l-2.25 3.75 2.25 3.75H4.75" />
        </g>
      )}
      {section === "compliance" && (
        <g {...LINE}>
          <path d="M10 2.5 4 4.9v4.65c0 3.7 2.55 6.45 6 7.95 3.45-1.5 6-4.25 6-7.95V4.9Z" />
          <path d="m7.35 10 1.85 1.85 3.5-3.6" />
        </g>
      )}
      {section === "audit" && (
        <g {...LINE}>
          <path d="M8.25 5h8.5M8.25 10h8.5M8.25 15h8.5" />
          <path d="M3.5 3.75h1.75v2.5H3.5ZM3.5 8.75h1.75v2.5H3.5ZM3.5 13.75h1.75v2.5H3.5Z" />
        </g>
      )}
    </svg>
  );
}

export function MenuGlyph({ className = "size-5" }: GlyphProps) {
  return (
    <svg viewBox="0 0 20 20" className={`shrink-0 ${className}`} aria-hidden>
      <path d="M3.25 5.5h13.5M3.25 10h13.5M3.25 14.5h13.5" {...LINE} />
    </svg>
  );
}

export function CloseGlyph({ className = "size-5" }: GlyphProps) {
  return (
    <svg viewBox="0 0 20 20" className={`shrink-0 ${className}`} aria-hidden>
      <path d="m5 5 10 10M15 5 5 15" {...LINE} />
    </svg>
  );
}

/** The up-and-down chevrons that mark a control opening a list of choices. */
export function SelectorGlyph({ className = "size-4" }: GlyphProps) {
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 ${className}`} aria-hidden>
      <path d="m5 6.25 3-3 3 3M5 9.75l3 3 3-3" {...LINE} />
    </svg>
  );
}

export function SignOutGlyph({ className = "size-4" }: GlyphProps) {
  return (
    <svg viewBox="0 0 20 20" className={`shrink-0 ${className}`} aria-hidden>
      <g {...LINE}>
        <path d="M8 3.25H5.25a1.5 1.5 0 0 0-1.5 1.5v10.5a1.5 1.5 0 0 0 1.5 1.5H8" />
        <path d="M12.5 6.25 16.25 10l-3.75 3.75M16 10H8" />
      </g>
    </svg>
  );
}
