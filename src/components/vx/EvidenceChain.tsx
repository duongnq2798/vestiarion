import {
  ArrowUpRight,
  BadgeCheck,
  Check,
  CircleDashed,
  CodeXml,
  CornerDownRight,
  Lightbulb,
  Minus,
  OctagonX,
  TriangleAlert,
  Unlink,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { EvidenceBrowserCheck } from "@/components/EvidenceBrowserCheck";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Disclosure } from "@/components/ui/Disclosure";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { orgHref } from "@/lib/auth/org-paths";
import { utcMinute } from "@/lib/copy";
import {
  EVIDENCE_MEANINGS,
  EVIDENCE_ORDER,
  EVIDENCE_WORDS,
  type EvidenceChain as Chain,
  type EvidenceFact,
  type EvidenceKind,
  type EvidenceLink,
  type EvidenceStep,
} from "@/lib/evidence-chain";
import type { EntryCheck } from "@/lib/receipts/verify";
import { entryHref, pad } from "./AuditLedger";
import { trailAnchor } from "./DecisionTrail";
import { fmt, Money } from "./Primitives";

/**
 * One payment's evidence, link by link (docs/superpowers/specs/2026-10-10-evidence-chain-design.md E2, E3, E10): what
 * it is about, the seven labels explained once with how many facts each holds, the chain's steps with each fact's
 * label in words beside an icon, and who may see, download and share it. Presentational: the page reads the evidence
 * (`readEvidence`) and the guide's screenshot builds it from made-up records.
 */

const LABEL: Record<EvidenceKind, { icon: LucideIcon; tone: "neutral" | "agent" | "proof" | "held" | "refused" }> = {
  verified: { icon: BadgeCheck, tone: "proof" },
  checked: { icon: CodeXml, tone: "agent" },
  stated: { icon: UserRound, tone: "neutral" },
  inferred: { icon: Lightbulb, tone: "neutral" },
  missing: { icon: CircleDashed, tone: "held" },
  unreachable: { icon: Unlink, tone: "held" },
  contradicted: { icon: OctagonX, tone: "refused" },
};

/** How Vestiarion stands to a link a fact points to (E4). */
export const LINK_STATE: Record<EvidenceLink["state"], string> = {
  checked: "Checked by Vestiarion",
  not_opened: "Not opened by Vestiarion",
  unreachable: "Could not open",
  contradicted: "Does not match",
};

/** A label in words with its icon: never by colour alone (E3). */
export function EvidenceLabel({ kind, prefix, className }: { kind: EvidenceKind; prefix?: string; className?: string }) {
  const { icon: Icon, tone } = LABEL[kind];
  return (
    <Badge size="sm" tone={tone} icon={<Icon aria-hidden />} className={className}>
      {prefix && <span className="sr-only">{prefix} </span>}
      {EVIDENCE_WORDS[kind]}
    </Badge>
  );
}

/** The page's line under its title: what was paid, or is to be, and to whom. */
export function evidenceSub(subject: Chain["subject"]): string {
  return `${subject.title}: ${fmt(subject.amount)} ${subject.currency} to ${subject.payee}. Each link says how it is known, and where it came from.`;
}

/** Where the record stands: paid, not paid yet, or not to be paid. */
export function evidenceStatus(subject: Chain["subject"]): string {
  if (subject.paid) return "Paid";
  if (subject.closed) return subject.kind === "invoice" ? "Rejected, not paid" : "Closed without paying";
  return "Not paid yet";
}

/**
 * The whole chain: what it is about and the labels beside the steps where the page is wide, above them where it is
 * not. Sized by its own width (a container query), so a folded sidebar or a narrow window lays it out alike.
 */
export function EvidenceChainView({ chain, orgSlug, publicKeys }: { chain: Chain; orgSlug: string; publicKeys: Record<string, string> }) {
  return (
    <div className="@container">
      <div className="grid gap-6 @5xl:grid-cols-[minmax(0,1fr)_19rem] @5xl:items-start @5xl:gap-8">
        <aside aria-label="About this evidence" className="grid gap-4 @2xl:grid-cols-2 @5xl:sticky @5xl:top-20 @5xl:order-last @5xl:grid-cols-1">
          <EvidenceSubject chain={chain} orgSlug={orgSlug} />
          <EvidenceKey tally={chain.tally} />
        </aside>
        <ol aria-label="The chain, link by link" className="min-w-0 space-y-4">
          {chain.steps.map((step, index) => (
            <li key={step.id}>
              <EvidenceStepCard step={step} number={index + 1} chain={chain} orgSlug={orgSlug} publicKeys={publicKeys} />
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function EvidenceSubject({ chain, orgSlug }: { chain: Chain; orgSlug: string }) {
  const { subject } = chain;
  const section = subject.kind === "invoice" ? { path: "/invoices", label: "Bills & receivables", record: "A bill" } : { path: "/contractors", label: "Contractors", record: "A milestone" };
  return (
    <Card className="p-4 sm:p-5">
      <h2 className="text-sm font-semibold text-ink">{subject.title}</h2>
      <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[0.8125rem]">
        <dt className="text-ink-3">Payee</dt>
        <dd className="min-w-0 text-ink [overflow-wrap:anywhere]">{subject.payee}</dd>
        <dt className="text-ink-3">Amount</dt>
        <dd>
          <Money value={subject.amount} token={subject.currency} className="text-ink" />
        </dd>
        <dt className="text-ink-3">Status</dt>
        <dd className="text-ink">{evidenceStatus(subject)}</dd>
        <dt className="text-ink-3">Record</dt>
        <dd className="text-ink">
          {section.record} on{" "}
          <Link href={orgHref(orgSlug, section.path)} className="text-agent hover:underline">
            {section.label}
          </Link>
        </dd>
      </dl>
    </Card>
  );
}

/** The seven labels, explained once (E3), strongest first, with how many of the chain's facts each holds. */
export function EvidenceKey({ tally }: { tally: Chain["tally"] }) {
  // Strongest first, as a reader asks "how well is this known?"; a step still reads as its weakest fact.
  const kinds = [...EVIDENCE_ORDER].reverse();
  return (
    <Card asChild className="p-4 sm:p-5">
      <section aria-labelledby="evidence-key">
        <h2 id="evidence-key" className="text-sm font-semibold text-ink">
          How each fact is known
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-ink-2">Each link reads as its weakest fact, so it is never labelled above what its least-supported fact is.</p>
        <dl className="mt-3 space-y-3">
          {kinds.map((kind) => (
            <div key={kind}>
              <dt className="flex items-center justify-between gap-2">
                <EvidenceLabel kind={kind} />
                <span className="font-mono text-xs tabular-nums text-ink-3">
                  {tally[kind]} {tally[kind] === 1 ? "fact" : "facts"}
                </span>
              </dt>
              <dd className="mt-1 text-xs leading-relaxed text-ink-2">{EVIDENCE_MEANINGS[kind]}</dd>
            </div>
          ))}
        </dl>
      </section>
    </Card>
  );
}

/** One link of the chain: its title, how it reads (its weakest fact), and each fact with its label. */
export function EvidenceStepCard({ step, number, chain, orgSlug, publicKeys }: { step: EvidenceStep; number: number; chain: Chain; orgSlug: string; publicKeys: Record<string, string> }) {
  const headingId = `evidence-step-${step.id}`;
  return (
    <Card asChild className="@container overflow-hidden">
      <section aria-labelledby={headingId}>
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
          <h2 id={headingId} className="flex items-center gap-2.5 text-base font-semibold text-ink">
            <span aria-hidden className="inline-flex size-6 items-center justify-center rounded-full border border-line-strong font-mono text-xs tabular-nums text-ink-2">
              {number}
            </span>
            {step.title}
          </h2>
          <EvidenceLabel kind={step.kind} prefix="Reads as" />
        </header>
        <ul className="divide-y divide-line">
          {step.facts.map((fact, index) => (
            <li key={`${step.id}-${index}`} className="px-4 py-3 sm:px-5">
              {/* The signatures step lists every entry below it: a fact resting on many links none of them again. */}
              <Fact fact={step.id === "signatures" && fact.seqs.length > 3 ? { ...fact, seqs: [] } : fact} orgSlug={orgSlug} />
            </li>
          ))}
        </ul>
        {step.trail && (
          <p className="border-t border-line px-4 py-3 text-xs sm:px-5">
            <Link href={orgHref(orgSlug, `/invoices?history=all#${trailAnchor(step.trail.invoiceId)}`)} className="font-medium text-agent hover:underline">
              How the agent decided, step by step
            </Link>
          </p>
        )}
        {step.id === "signatures" && <Signatures caveat={step.caveat} entries={chain.entries} orgSlug={orgSlug} publicKeys={publicKeys} />}
      </section>
    </Card>
  );
}

function Fact({ fact, orgSlug }: { fact: EvidenceFact; orgSlug: string }) {
  const by = [fact.who ? `By ${fact.who}` : null, fact.at ? utcMinute(fact.at) : null].filter(Boolean).join(" · ");
  return (
    <div className="grid gap-x-4 gap-y-1.5 @lg:grid-cols-[10.5rem_minmax(0,1fr)]">
      <div>
        <EvidenceLabel kind={fact.kind} />
      </div>
      <div className="min-w-0">
        <p className="text-sm text-ink [overflow-wrap:anywhere]">
          {fact.warn && (
            <span className="mr-1.5 inline-flex align-[-0.125em] text-held">
              <TriangleAlert aria-hidden className="size-3.5" />
              <span className="sr-only">Needs attention: </span>
            </span>
          )}
          {fact.text}
        </p>
        {by && <p className="mt-0.5 text-xs text-ink-3 [overflow-wrap:anywhere]">{by}</p>}
        {fact.notes && fact.notes.length > 0 && (
          <ul className="mt-1.5 space-y-0.5 text-xs text-ink-2">
            {fact.notes.map((note, index) => (
              <li key={`${index}-${note}`} className="[overflow-wrap:anywhere]">
                {note}
              </li>
            ))}
          </ul>
        )}
        {fact.fill && (
          <p className="mt-1.5 flex gap-1.5 text-xs text-ink-2">
            <CornerDownRight aria-hidden className="mt-px size-3.5 shrink-0 text-ink-3" />
            {fact.fill}
          </p>
        )}
        {(fact.link || fact.seqs.length > 0) && (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {fact.link && <FactLink link={fact.link} />}
            {fact.seqs.map((seq) => (
              <Link key={seq} href={entryHref(orgSlug, seq)} className="font-mono text-ink-3 hover:text-ink hover:underline">
                Entry #{pad(seq)}
              </Link>
            ))}
          </p>
        )}
      </div>
    </div>
  );
}

/** A link outside, and how Vestiarion stands to it (E4): a typed one is shown, never fetched. */
function FactLink({ link }: { link: EvidenceLink }) {
  const typed = link.state === "not_opened";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5">
      <a
        href={link.href}
        target="_blank"
        rel={typed ? "noreferrer nofollow ugc" : "noreferrer"}
        className="inline-flex items-center gap-0.5 font-medium text-agent hover:underline"
      >
        {link.label}
        <ArrowUpRight aria-hidden className="size-3" />
        <span className="sr-only">(opens in a new tab)</span>
      </a>
      <span className={cn(link.state === "contradicted" ? "text-refused" : link.state === "unreachable" ? "text-held" : "text-ink-3")}>· {LINK_STATE[link.state]}</span>
    </span>
  );
}

const CHECK: Record<"ok" | "bad" | "none", { icon: LucideIcon; className: string }> = {
  ok: { icon: Check, className: "text-proof" },
  bad: { icon: X, className: "text-refused" },
  none: { icon: Minus, className: "text-ink-3" },
};

function checkWords(check: EntryCheck): { key: keyof typeof CHECK; words: string } {
  if (check.ok === true) return { key: "ok", words: "Verifies" };
  if (check.ok === false) return { key: "bad", words: `Does not verify: ${check.reason}` };
  return { key: "none", words: `Not checked here: ${check.reason}` };
}

/** The signatures step's own part: what a signature proves, the browser's check, and every entry with the server's. */
function Signatures({ caveat, entries, orgSlug, publicKeys }: { caveat?: string; entries: Chain["entries"]; orgSlug: string; publicKeys: Record<string, string> }) {
  const rows = entries.map((entry) => ({
    seq: entry.seq,
    actor: entry.actor,
    domain: entry.domain,
    action: entry.action,
    summary: entry.summary,
    detail: entry.detail,
    body_hash: entry.body_hash,
    signature: entry.signature,
    prev_hash: entry.prev_hash,
    hash: entry.hash,
    signing_key_id: entry.signing_key_id,
  }));
  return (
    <div className="space-y-3 border-t border-line px-4 py-3 sm:px-5">
      {caveat && <p className="text-sm font-medium text-ink">{caveat}</p>}
      <EvidenceBrowserCheck entries={rows} publicKeys={publicKeys} />
      {entries.length > 0 && (
        <Disclosure summary={`Every entry, checked here one by one (${entries.length})`} className="shadow-none">
          <ul className="space-y-2">
            {entries.map((entry) => {
              const { key, words } = checkWords(entry.check);
              const { icon: Icon, className } = CHECK[key];
              return (
                <li key={entry.seq} className="grid gap-x-3 gap-y-0.5 text-xs @lg:grid-cols-[4.5rem_minmax(0,1fr)]">
                  <Link href={entryHref(orgSlug, entry.seq)} className="font-mono text-ink-3 hover:text-ink hover:underline">
                    #{pad(entry.seq)}
                  </Link>
                  <div className="min-w-0">
                    <p className="text-ink [overflow-wrap:anywhere]">{entry.summary}</p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-ink-3">
                      <span className="font-mono">{entry.action}</span>
                      <span>{utcMinute(entry.ts)}</span>
                      <span className={cn("inline-flex items-center gap-1", className)}>
                        <Icon aria-hidden className="size-3" />
                        {words}
                      </span>
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

/** Whether the receipt's link opens now, was stopped, or was never made; null for a milestone (E10). */
export type ReceiptSharing = "shared" | "stopped" | "none" | null;

/**
 * Who may see, download and share this evidence (E10, roadmap I28), said where the evidence is shown: the existing
 * permissions, in words. Nothing here shares, unshares or exports anything.
 */
export function EvidenceAccess({ kind, receipt, role, canShare }: { kind: Chain["subject"]["kind"]; receipt: ReceiptSharing; role: string; canShare: boolean }) {
  return (
    <Card asChild className="mt-8 p-4 sm:p-6">
      <section aria-labelledby="evidence-access">
        <h2 id="evidence-access" className="text-base font-semibold text-ink">
          Who can see this
        </h2>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[11rem_minmax(0,1fr)]">
          <dt>
            <Eyebrow>This page</Eyebrow>
          </dt>
          <dd className="text-ink-2">{"Every member of this workspace, viewers included. Nobody outside it: the page needs a member's sign-in."}</dd>
          <dt>
            <Eyebrow>Download evidence</Eyebrow>
          </dt>
          <dd className="text-ink-2">Every member, as the audit export. The file names people by email, as this page does.</dd>
          <dt>
            <Eyebrow>Outside the workspace</Eyebrow>
          </dt>
          <dd className="space-y-1.5 text-ink-2">
            {kind === "milestone" ? (
              <p>Nothing: a milestone has no receipt, so none of this leaves the workspace.</p>
            ) : (
              <>
                <p>{RECEIPT_WORDS[receipt ?? "none"]}</p>
                <p>{"A receipt's public page shows the amount, the payee's address and the transactions, and no names."}</p>
                <p>
                  {canShare
                    ? "As an owner or admin, you can share it or stop sharing it with Share receipt on Bills & receivables."
                    : `Your role, ${role}, cannot share it: an owner or admin shares it with Share receipt on Bills & receivables.`}
                </p>
              </>
            )}
          </dd>
        </dl>
        <p className="mt-4 border-t border-line pt-3 text-xs text-ink-3">Nothing on this page shares or changes anything: Download evidence is its only action.</p>
      </section>
    </Card>
  );
}

const RECEIPT_WORDS: Record<"shared" | "stopped" | "none", string> = {
  shared: "Only the receipt, which is shared now: anyone with its link can open it.",
  stopped: "Nothing now: the receipt was shared, then its link was stopped, so it no longer opens.",
  none: "Nothing: the receipt is not shared. Only a receipt for a payment on chain can be shared.",
};
