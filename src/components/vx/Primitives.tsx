import type { ReactNode } from "react";
import type { Outcome } from "./types";
import { OutcomeGlyph } from "./Glyphs";

export function fmt(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

export function Money({
  value,
  token = "USDC",
  sign,
  simulated,
  struck,
  className = "",
}: {
  value: number;
  token?: string;
  sign?: "+" | "−";
  simulated?: boolean;
  struck?: boolean;
  className?: string;
}) {
  return (
    <span className={`whitespace-nowrap tabular-nums ${className}`}>
      <span
        className={`${simulated ? "underline decoration-dashed decoration-ink-3 underline-offset-4" : ""} ${struck ? "line-through decoration-refused decoration-2" : ""}`}
      >
        {sign && <span className="mr-0.5 text-ink-3">{sign}</span>}
        {fmt(Math.abs(value))}
      </span>
      <span className="ml-1 text-[0.72em] font-medium tracking-wide text-ink-3">{token}</span>
    </span>
  );
}

export function Label({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span className={`font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.11em] text-ink-3 ${className}`}>
      {children}
    </span>
  );
}

const OUTCOMES: Record<Outcome, { word: string; className: string }> = {
  settled: { word: "Settled on Arc", className: "border-proof-line bg-proof-soft text-proof" },
  scheduled: { word: "Scheduled", className: "border-line-strong text-ink-2" },
  recorded: { word: "Recorded", className: "border-line-strong text-ink-2" },
  held: { word: "Held for you", className: "border-held-line bg-held-soft text-held" },
  refused: { word: "Refused by guardrail", className: "border-refused-line bg-refused-soft text-refused" },
  simulated: { word: "Simulated", className: "hatch border-dashed border-line-strong text-ink-2" },
};

export function OutcomeBadge({ outcome, label }: { outcome: Outcome; label?: string }) {
  const item = OUTCOMES[outcome];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${item.className}`}>
      <OutcomeGlyph outcome={outcome} className="size-3" />
      {label ?? item.word}
    </span>
  );
}

export function ModeBadge({ mode }: { mode?: string }) {
  if (!mode) return null;
  return (
    <span className="rounded-full border border-agent-line bg-agent-soft px-2 py-0.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-wide text-agent">
      {mode}
    </span>
  );
}

export function Hash({ value, href, className = "" }: { value: string; href?: string; className?: string }) {
  const short = value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
  const body = <span>{short}</span>;
  const common = `inline-flex items-center gap-1 font-mono text-xs tabular-nums ${className}`;
  return href ? (
    <a href={href} title={value} target="_blank" rel="noreferrer" className={`${common} text-proof hover:underline`}>
      {body}
      <span aria-hidden>↗</span>
    </a>
  ) : (
    <span title={value} className={`${common} text-ink-3`}>{body}</span>
  );
}

export const explorerTx = (hash: string) => `https://testnet.arcscan.app/tx/${hash}`;

const FACT = /(\b[a-z]+-pr#\d+\b|\b\d[\d,]*(?:\.\d+)?\s?(?:USDC|USYC)\b|\bPO[-#]?[A-Z0-9-]+\b|\bINV[-#]?[A-Z0-9-]+\b|\b0x[0-9a-fA-F]{6,}\b|\b\d+(?:\.\d+)?%|\bday \d+\b|#\d+\b)/gi;

export function Reasoning({ text, className = "" }: { text: string; className?: string }) {
  const parts = text.split(FACT);
  return (
    <p className={`max-w-[70ch] text-pretty font-serif text-reasoning text-ink ${className}`}>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={`${part}-${index}`} className="rounded-sm bg-raised px-1 font-mono text-[0.84em] text-ink">
            {part}
          </span>
        ) : part
      )}
    </p>
  );
}

export function Card({
  children,
  className = "",
  tone = "default",
}: {
  children: ReactNode;
  className?: string;
  tone?: "default" | "refused" | "held" | "simulated";
}) {
  const toneClass = {
    default: "border-line bg-surface",
    refused: "border-refused-line bg-surface",
    held: "border-held-line bg-surface",
    simulated: "border-dashed border-line-strong bg-surface",
  }[tone];
  return <section className={`surface-shadow rounded-xl border ${toneClass} ${className}`}>{children}</section>;
}

export function SectionHead({ title, meta, action }: { title: string; meta?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold tracking-tight text-ink">{title}</h2>
        {meta && <span className="text-[0.8125rem] text-ink-3">{meta}</span>}
      </div>
      {action}
    </div>
  );
}
