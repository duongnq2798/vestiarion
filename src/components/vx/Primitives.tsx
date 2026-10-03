import { ArrowUpRight } from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { OutcomeGlyph } from "./Glyphs";
import type { Outcome } from "./types";

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
  className,
}: {
  value: number;
  token?: string;
  sign?: "+" | "−";
  simulated?: boolean;
  struck?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("whitespace-nowrap tabular-nums", className)}>
      <span className={cn(simulated && "underline decoration-dashed decoration-ink-3 underline-offset-4", struck && "line-through decoration-refused decoration-2")}>
        {sign && <span className="mr-0.5 text-ink-3">{sign}</span>}
        {fmt(Math.abs(value))}
      </span>
      <span className="ml-1 text-[0.72em] font-medium tracking-wide text-ink-3">{token}</span>
    </span>
  );
}

const OUTCOMES: Record<Outcome, { word: string; tone: NonNullable<BadgeProps["tone"]> }> = {
  settled: { word: "Settled on Arc", tone: "proof" },
  scheduled: { word: "Scheduled", tone: "neutral" },
  recorded: { word: "Recorded", tone: "neutral" },
  held: { word: "Held for you", tone: "held" },
  refused: { word: "Refused by guardrail", tone: "refused" },
  simulated: { word: "Simulated", tone: "simulated" },
  deciding: { word: "Deciding now", tone: "agent" },
};

/** What happened to a decision, in words and in its tone, with the outcome's own glyph. */
export function OutcomeBadge({ outcome, label }: { outcome: Outcome; label?: string }) {
  const item = OUTCOMES[outcome];
  return (
    <Badge tone={item.tone} icon={<OutcomeGlyph outcome={outcome} />}>
      {label ?? item.word}
    </Badge>
  );
}

/** Which engine decided: the model, or the rule-based fallback. */
export function ModeBadge({ mode }: { mode?: string }) {
  if (!mode) return null;
  return (
    <Badge tone="agent" size="sm" className="font-mono uppercase tracking-wide">
      {mode}
    </Badge>
  );
}

export function shortHash(value: string): string {
  return value.length > 14 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** A hash, shortened for reading; the full value is in the title, and a link opens the explorer in a new tab. */
export function Hash({ value, href, className }: { value: string; href?: string; className?: string }) {
  const short = shortHash(value);
  return href ? (
    <a
      href={href}
      title={value}
      target="_blank"
      rel="noreferrer"
      className={cn("inline-flex items-center gap-1 font-mono text-xs tabular-nums text-proof transition-colors duration-150 ease-standard hover:underline", className)}
    >
      <span>{short}</span>
      <ArrowUpRight aria-hidden className="size-3" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  ) : (
    <span title={value} className={cn("inline-flex items-center gap-1 font-mono text-xs tabular-nums text-ink-3", className)}>
      {short}
    </span>
  );
}

export const explorerTx = (hash: string) => `https://testnet.arcscan.app/tx/${hash}`;

const FACT = /(\b[a-z]+-pr#\d+\b|\b\d[\d,]*(?:\.\d+)?\s?(?:USDC|USYC)\b|\bPO[-#]?[A-Z0-9-]+\b|\bINV[-#]?[A-Z0-9-]+\b|\b0x[0-9a-fA-F]{6,}\b|\b\d+(?:\.\d+)?%|\bday \d+\b|#\d+\b)/gi;

/** The agent's reasoning in the serif face, with the facts a reader checks set in mono. */
export function Reasoning({ text, className }: { text: string; className?: string }) {
  const parts = text.split(FACT);
  return (
    <p className={cn("max-w-[70ch] text-pretty font-serif text-reasoning text-ink", className)}>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={`${part}-${index}`} className="rounded-md bg-raised px-1 font-mono text-[0.84em] text-ink">
            {part}
          </span>
        ) : (
          part
        )
      )}
    </p>
  );
}
