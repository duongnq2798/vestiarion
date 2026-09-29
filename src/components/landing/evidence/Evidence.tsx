import { useId, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/**
 * The landing page's evidence-chain motif: what a signed decision looks like
 * when it is drawn rather than listed. A receipt slip, the seal pressed into
 * it, the hash that names it and the link to the receipt before it.
 *
 * Tone follows the product's colour roles: `proof` for what was signed and
 * carried out, `refused` for what code stopped, `held` for what waits on a
 * person, `agent` for the model's own voice.
 */
export type EvidenceTone = "proof" | "refused" | "held" | "agent";

const toneText: Record<EvidenceTone, string> = {
  proof: "text-proof",
  refused: "text-refused",
  held: "text-held",
  agent: "text-agent",
};

/** A sha256 in hex, shortened the way the ledger view shortens it: head…tail. */
export function HashText({ value, className, head = 4, tail = 4 }: { value: string; className?: string; head?: number; tail?: number }) {
  const short = value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
  return (
    <span className={cn("font-mono tabular-nums", className)} title={value}>
      {short}
    </span>
  );
}

/**
 * The stamp pressed into a signed receipt: the brand mark ringed by what the
 * signature attests. Decorative — the words around it are repeated as text
 * wherever the seal carries meaning.
 */
export function Seal({ tone = "proof", words = "Signed · Ed25519 · Hash-linked ·", className, style }: { tone?: EvidenceTone; words?: string; className?: string; style?: CSSProperties }) {
  const path = useId();
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true" focusable="false" className={cn("size-20", toneText[tone], className)} style={style}>
      <defs>
        <path id={path} d="M60 60 m-47 0 a47 47 0 1 1 94 0 a47 47 0 1 1 -94 0" />
      </defs>
      <circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="60" cy="60" r="37" fill="none" stroke="currentColor" strokeWidth="1.25" strokeDasharray="2 3" />
      <text fill="currentColor" fontSize="10.5" fontWeight="600" letterSpacing="2.1" className="font-mono uppercase">
        <textPath href={`#${path}`} startOffset="0">{words}</textPath>
      </text>
      <g transform="translate(40 40)">
        <path
          fill="currentColor"
          d="M20 2.25c1.39 0 2.61.33 3.82 1.03l9.04 5.22a7.64 7.64 0 0 1 3.82 6.62v9.76a7.64 7.64 0 0 1-3.82 6.62l-9.04 5.22a7.64 7.64 0 0 1-7.64 0L7.14 31.5a7.64 7.64 0 0 1-3.82-6.62v-9.76A7.64 7.64 0 0 1 7.14 8.5l9.04-5.22A7.64 7.64 0 0 1 20 2.25Z"
        />
        {tone === "refused" ? (
          <path d="m13.5 13.5 13 13m0-13-13 13" fill="none" stroke="var(--color-surface)" strokeWidth="3.35" strokeLinecap="round" />
        ) : (
          <path d="m10.6 12.25 6.8 15.05c.68 1.5 2.77 1.67 3.68.29l8.32-12.58" fill="none" stroke="var(--color-surface)" strokeWidth="3.35" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </g>
    </svg>
  );
}

/**
 * A receipt slip: perforated top and bottom edges, paper surface. Its shadow
 * is a drop-shadow on the wrapper, since the perforation is a mask and a mask
 * clips box-shadow.
 */
export function Receipt({ children, className, slipClassName }: { children: ReactNode; className?: string; slipClassName?: string }) {
  return (
    <div className={cn("receipt-shadow", className)}>
      <div className={cn("receipt-perforated bg-surface px-5 py-6", slipClassName)}>{children}</div>
    </div>
  );
}

/**
 * The link between two receipts: each entry carries the hash of the one
 * before it. Vertical by default; `horizontal` for a chain drawn in a row.
 */
export function ChainLink({ hash, horizontal = false, className }: { hash?: string; horizontal?: boolean; className?: string }) {
  return (
    <div aria-hidden className={cn("flex items-center gap-2 text-ink-3", horizontal ? "flex-row" : "flex-col", className)}>
      <span className={cn(horizontal ? "chain-link-line-x h-px w-8" : "chain-link-line h-6 w-px")} />
      {hash && <span className="font-mono text-[0.6875rem] tracking-wide">prev <HashText value={hash} /></span>}
      <span className={cn(horizontal ? "chain-link-line-x h-px w-8" : "chain-link-line h-6 w-px")} />
    </div>
  );
}

/** The one-word outcome a receipt records, set like a rubber stamp. */
export function Verdict({ tone, children, className }: { tone: EvidenceTone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border-2 px-2 py-0.5 font-mono text-xs font-bold uppercase tracking-[0.16em]",
        tone === "proof" && "border-proof text-proof",
        tone === "refused" && "border-refused text-refused",
        tone === "held" && "border-held text-held",
        tone === "agent" && "border-agent text-agent",
        className
      )}
    >
      {children}
    </span>
  );
}
