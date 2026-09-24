import type { Decision, Evidence, Guardrail } from "./types";
import { CheckGlyph, CrossGlyph, DOMAIN_NAME, DomainGlyph, ShieldGlyph } from "./Glyphs";
import { Card, explorerTx, fmt, Hash, Label, ModeBadge, Money, OutcomeBadge, Reasoning } from "./Primitives";

export function DecisionCard({ decision, compact = false }: { decision: Decision; compact?: boolean }) {
  const refused = decision.outcome === "refused";
  const tone = refused
    ? "refused"
    : decision.outcome === "held"
      ? "held"
      : decision.outcome === "simulated"
        ? "simulated"
        : "default";
  const time = new Date(decision.at).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

  return (
    <Card tone={tone} className="overflow-hidden">
      <header className="flex flex-col gap-3 px-4 pt-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-ink-3">
            <DomainGlyph domain={decision.domain} className="size-3" />
            <Label>{DOMAIN_NAME[decision.domain]} · {time} UTC</Label>
            <ModeBadge mode={decision.decisionMode} />
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
              className={`text-xl font-semibold ${refused ? "text-ink-3" : "text-ink"}`}
            />
          )}
          <OutcomeBadge outcome={decision.outcome} label={decision.outcomeLabel} />
        </div>
      </header>

      {refused && decision.guardrail && (
        <GuardrailBand guardrail={decision.guardrail} token={decision.token} action={decision.action.toLowerCase()} />
      )}

      <div className={compact ? "px-4 pb-3 pt-3 sm:px-5" : "px-4 pb-4 pt-4 sm:px-5"}>
        <Label className="text-agent">{refused ? "What the agent argued" : "Agent’s reasoning"}</Label>
        <Reasoning text={decision.reasoning} className="mt-1.5" />
      </div>

      {(decision.evidence.length > 0 || decision.txHash || decision.auditSeq != null) && (
        <footer className="flex flex-col gap-3 border-t border-line bg-ground/40 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <EvidenceRow items={decision.evidence} />
          <div className="flex shrink-0 flex-wrap items-center gap-4">
            {decision.auditSeq != null && (
              <a href={`/audit#seq-${decision.auditSeq}`} className="font-mono text-xs text-ink-3 hover:text-ink hover:underline">
                audit #{String(decision.auditSeq).padStart(4, "0")}
              </a>
            )}
            {decision.txHash ? (
              <Hash value={decision.txHash} href={explorerTx(decision.txHash)} />
            ) : refused ? (
              <span className="font-mono text-xs text-refused">no transaction sent</span>
            ) : null}
          </div>
        </footer>
      )}
    </Card>
  );
}

function GuardrailBand({ guardrail, token = "USDC", action }: { guardrail: Guardrail; token?: string; action: string }) {
  return (
    <div role="alert" className="mx-4 mt-4 rounded-md border border-refused-line bg-refused-soft px-4 py-3 sm:mx-5">
      <div className="flex items-start gap-3">
        <ShieldGlyph className="mt-0.5 size-5 text-refused" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-refused">Blocked by code, not by the model</p>
          <p className="mt-0.5 text-sm text-ink">
            The agent decided to {action}. The guardrail refused it before anything was signed or sent.
          </p>
          <dl className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[0.8125rem]">
            <dt className="text-ink-3">Rule</dt>
            <dd className="font-mono text-ink [overflow-wrap:anywhere]">{guardrail.rule}</dd>
            <dt className="text-ink-3">Attempted</dt>
            <dd className="font-mono tabular-nums text-ink">{fmt(guardrail.attempted)} {token}</dd>
            <dt className="text-ink-3">Allowed</dt>
            <dd className="font-mono tabular-nums text-ink">
              {fmt(guardrail.limit)} {token}
              {guardrail.note && <span className="ml-2 font-sans text-ink-2">({guardrail.note})</span>}
            </dd>
          </dl>
        </div>
      </div>
    </div>
  );
}

function EvidenceRow({ items }: { items: Evidence[] }) {
  if (items.length === 0) return <span />;
  return (
    <ul aria-label="Evidence cited by this decision" className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <li
          key={`${item.label}-${item.value}`}
          className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs ${item.state === "missing" ? "border-held-line text-held" : "border-line text-ink-2"}`}
        >
          {item.state === "ok" && <CheckGlyph className="size-3 text-ink-2" />}
          {item.state === "missing" && <CrossGlyph className="size-3" />}
          <span className="text-ink-3">{item.label}</span>
          {item.href ? (
            <a href={item.href} target="_blank" rel="noreferrer" className="font-mono text-agent hover:underline">{item.value} ↗</a>
          ) : (
            <span className="font-mono text-ink">{item.value}</span>
          )}
        </li>
      ))}
    </ul>
  );
}
