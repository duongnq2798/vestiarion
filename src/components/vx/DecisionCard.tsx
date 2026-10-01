import { ArrowUpRight, Check, ShieldX, X } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Callout } from "@/components/ui/Callout";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { orgHref } from "@/lib/auth/org-paths";
import { DOMAIN_NAME, DomainGlyph } from "./Glyphs";
import { explorerTx, fmt, Hash, Money, OutcomeBadge, Reasoning } from "./Primitives";
import type { Decision, Evidence, Guardrail, Outcome } from "./types";

const CARD_TONE: Partial<Record<Outcome, "refused" | "held" | "simulated">> = {
  refused: "refused",
  held: "held",
  simulated: "simulated",
};

/** One decision the agent made: what, how much, why, and the evidence and receipts behind it. */
export function DecisionCard({ decision, compact = false, orgSlug }: { decision: Decision; compact?: boolean; orgSlug: string }) {
  const refused = decision.outcome === "refused";
  const time = new Date(decision.at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  const hasFooter = decision.evidence.length > 0 || Boolean(decision.txHash) || decision.auditSeq != null;

  return (
    <Card asChild tone={CARD_TONE[decision.outcome] ?? "default"} className="overflow-hidden">
      <article>
        <header className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-ink-3">
              <DomainGlyph domain={decision.domain} className="size-3" />
              <Eyebrow>
                {DOMAIN_NAME[decision.domain]} · {time} UTC
              </Eyebrow>
              {/* A model's decision needs no tag: its reasoning is the agent's, and the audit log names the model.
                  A fallback does, so the written policy's reasoning is never read as the model's judgement. */}
              {decision.decisionMode === "heuristic" && (
                <Badge size="sm" title="No model answered, so the written policy decided." className="font-mono uppercase tracking-wide">
                  Written policy
                </Badge>
              )}
            </div>
            <h3 className="mt-1.5 text-base font-semibold leading-snug text-ink">
              {refused && <span className="font-normal text-ink-3">Tried to </span>}
              {refused ? decision.action.toLowerCase() : decision.action} {decision.subject}
            </h3>
            {decision.memo && <p className="mt-0.5 text-sm text-ink-2">{decision.memo}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3 sm:flex-col sm:items-end sm:gap-2">
            {decision.amount != null && (
              <Money
                value={decision.amount}
                token={decision.token}
                struck={refused}
                simulated={decision.outcome === "simulated"}
                className={cn("text-xl font-semibold", refused ? "text-ink-3" : "text-ink")}
              />
            )}
            <OutcomeBadge outcome={decision.outcome} label={decision.outcomeLabel} />
          </div>
        </header>

        {refused && decision.guardrail && <GuardrailBand guardrail={decision.guardrail} token={decision.token} action={decision.action.toLowerCase()} />}

        <div className={compact ? "px-4 pb-3 pt-3 sm:px-5" : "px-4 pb-4 pt-4 sm:px-5"}>
          <Eyebrow className="text-agent">{refused ? "What the agent argued" : "Agent’s reasoning"}</Eyebrow>
          <Reasoning text={decision.reasoning} className="mt-1.5" />
        </div>

        {hasFooter && (
          <footer className="flex flex-col gap-3 border-t border-line bg-ground/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
            <EvidenceRow items={decision.evidence} />
            <div className="flex shrink-0 flex-wrap items-center gap-4">
              {decision.auditSeq != null && (
                <Link
                  href={orgHref(orgSlug, `/audit#seq-${decision.auditSeq}`)}
                  className="font-mono text-xs text-ink-3 transition-colors duration-150 ease-standard hover:text-ink hover:underline"
                >
                  audit #{String(decision.auditSeq).padStart(4, "0")}
                </Link>
              )}
              {decision.txHash ? (
                <Hash value={decision.txHash} href={explorerTx(decision.txHash)} />
              ) : refused ? (
                <span className="font-mono text-xs text-refused">no transaction sent</span>
              ) : null}
            </div>
          </footer>
        )}
      </article>
    </Card>
  );
}

function GuardrailBand({ guardrail, token = "USDC", action }: { guardrail: Guardrail; token?: string; action: string }) {
  return (
    <Callout tone="refused" icon={<ShieldX />} title="Blocked by code, not by the model" className="mx-4 mt-4 sm:mx-5">
      <p>The agent decided to {action}. The guardrail refused it before anything was signed or sent.</p>
      <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.8125rem]">
        <dt className="text-ink-3">Rule</dt>
        <dd className="font-mono text-ink [overflow-wrap:anywhere]">{guardrail.rule}</dd>
        <dt className="text-ink-3">Attempted</dt>
        <dd className="font-mono tabular-nums text-ink">
          {fmt(guardrail.attempted)} {token}
        </dd>
        <dt className="text-ink-3">Allowed</dt>
        <dd className="font-mono tabular-nums text-ink">
          {fmt(guardrail.limit)} {token}
          {guardrail.note && <span className="ml-2 font-sans text-ink-2">({guardrail.note})</span>}
        </dd>
      </dl>
    </Callout>
  );
}

function EvidenceRow({ items }: { items: Evidence[] }) {
  if (items.length === 0) return <span />;
  return (
    <ul aria-label="Evidence cited by this decision" className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li key={`${item.label}-${item.value}`}>
          <Badge
            shape="tag"
            tone={item.state === "missing" ? "held" : "neutral"}
            icon={item.state === "ok" ? <Check aria-hidden /> : item.state === "missing" ? <X aria-hidden /> : undefined}
            className="font-normal"
          >
            <span className={item.state === "missing" ? undefined : "text-ink-3"}>{item.label}</span>
            {item.href ? (
              <a
                href={item.href}
                target="_blank"
                rel="noreferrer"
                aria-label={`${item.label} ${item.value} (opens in a new tab)`}
                className="inline-flex items-center gap-0.5 font-mono text-agent transition-colors duration-150 ease-standard hover:underline"
              >
                {item.value}
                <ArrowUpRight aria-hidden />
              </a>
            ) : (
              <span className="font-mono text-ink">{item.value}</span>
            )}
          </Badge>
        </li>
      ))}
    </ul>
  );
}
