"use client";

import { ChevronRight } from "lucide-react";
import { startTransition, useEffect, useState } from "react";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { CopyButton } from "@/components/ui/CopyButton";
import { Disclosure } from "@/components/ui/Disclosure";
import { DOMAIN_CODE, DOMAIN_NAME, DomainShape } from "./Glyphs";
import { Hash, ModeBadge, OutcomeBadge, pad } from "./Primitives";
import type { Domain, Outcome } from "./types";

/**
 * What one row of the audit log shows, and nothing more: the entry's id, key label and the rest of its timestamp stay
 * on the server. The page sends this for each row instead of the row's markup, which React would otherwise send twice,
 * once as HTML and once to hydrate it.
 */
export interface AuditRowFacts {
  seq: number;
  /** The entry's UTC time, `HH:MM`. */
  time: string;
  domain: Domain;
  actor: string;
  summary: string;
  action: string;
  decisionMode?: string;
  outcome: Outcome | null;
  hash: string;
  prevHash: string;
  bodyHash: string;
  signature: string;
  /** How `prevHash` reads against the entry before it: the chain's first link, a match, a mismatch, or that entry not on this page. */
  link: "genesis" | "matches" | "differs" | null;
  detail: Record<string, unknown>;
  /** A row the cycle just run added (`since`): its place in its day, which staggers its arrival. */
  arrival?: number;
}

const ROW_ICON = "audit-row-open";
const domainIcon = (domain: Domain) => `audit-domain-${domain}`;

/**
 * The icons every row repeats, drawn once for the ledger: the chevron a row opens by and the glyph of each domain
 * listed. A row points at them (`use`) instead of drawing its own, the same two drawings a hundred times on a page. A
 * `use` draws nothing where its icon is not on the page, so whatever lists rows draws this with them. Hidden: the
 * code beside each glyph says it.
 */
export function AuditRowIcons({ domains }: { domains: Domain[] }) {
  return (
    <svg aria-hidden className="hidden">
      <defs>
        <symbol id={ROW_ICON} viewBox="0 0 24 24">
          <ChevronRight />
        </symbol>
        {domains.map((domain) => (
          <symbol key={domain} id={domainIcon(domain)} viewBox="0 0 12 12">
            <DomainShape domain={domain} />
          </symbol>
        ))}
      </defs>
    </svg>
  );
}

export function AuditRow({ row }: { row: AuditRowFacts }) {
  // An entry's facts and detail are drawn here, from the data sent for the row, not sent as markup: at once when the
  // row is first opened, and for every row as soon as the page is ready, behind anything a person does, so the
  // browser's find-in-page still finds them. Drawn, they stay.
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    startTransition(() => setDrawn(true));
  }, []);

  const outcome = row.outcome;
  const refused = outcome === "refused";
  const sweep = row.action === "compliance_sweep";
  const changed = row.action === "risk_level_changed";
  const fresh = row.arrival != null;

  return (
    <li
      id={`seq-${row.seq}`}
      className={cn(
        "relative scroll-mt-10 border-b border-line last:border-b-0",
        fresh && "bg-agent-soft/60 motion-safe:animate-arrive",
        refused && "bg-refused-soft/70",
        changed && !refused && "bg-held-soft/35"
      )}
      style={fresh ? { animationDelay: `${row.arrival! * 55}ms` } : undefined}
    >
      <span aria-hidden className="absolute bottom-0 left-4 top-0 w-px bg-line-strong sm:left-[1.1rem]" />
      <span
        aria-hidden
        className={cn(
          "absolute left-[0.8rem] top-[1.05rem] size-[7px] rounded-full ring-2 ring-surface sm:left-[0.93rem]",
          refused ? "bg-refused" : outcome === "settled" ? "bg-proof" : changed ? "bg-held" : "bg-line-strong"
        )}
      />
      <Disclosure
        variant="bare"
        onToggle={(event) => {
          if (event.currentTarget.open) setDrawn(true);
        }}
        summaryClassName="py-2.5 pl-9 pr-4 transition-colors duration-150 ease-standard hover:bg-raised/60 sm:grid sm:grid-cols-[3.25rem_3rem_5.75rem_minmax(0,1fr)_auto] sm:items-start sm:gap-x-3"
        contentClassName="space-y-3 pb-4 pl-9 pr-4 sm:pl-[calc(2.25rem+3.25rem+3rem+5.75rem+2.25rem)]"
        summary={
          <>
            <span className="font-mono text-xs tabular-nums text-ink-2">#{pad(row.seq)}</span>
            <span className="ml-2 font-mono text-xs tabular-nums text-ink-3 sm:ml-0">{row.time}</span>
            <span className="ml-2 inline-flex items-center gap-1 font-mono text-[0.6875rem] text-ink-3 sm:ml-0">
              <svg viewBox="0 0 12 12" className="shrink-0 size-2.5" aria-hidden>
                <use href={`#${domainIcon(row.domain)}`} />
              </svg>
              {DOMAIN_CODE[row.domain]}
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:mt-0">
              <svg aria-hidden viewBox="0 0 24 24" className="size-3 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90">
                <use href={`#${ROW_ICON}`} />
              </svg>
              <span className="shrink-0 text-[0.8125rem] text-ink-3">{row.actor}</span>
              <span className={cn("min-w-0 text-sm", refused ? "text-refused" : "text-ink")}>{row.summary}</span>
              {sweep && (
                <Badge size="sm" shape="tag" className="font-mono uppercase tracking-wider">
                  continuous sweep
                </Badge>
              )}
              {changed && (
                <Badge size="sm" shape="tag" tone="held" className="font-mono uppercase tracking-wider">
                  risk changed
                </Badge>
              )}
              <ModeBadge mode={row.decisionMode} />
            </span>
            <span className="mt-1 hidden justify-end sm:flex">
              <Hash value={row.hash} />
            </span>
          </>
        }
      >
        {drawn && <AuditEntryFacts row={row} />}
      </Disclosure>
    </li>
  );
}

/** What an opened row shows: its outcome, the entry's hashes and signature to copy, and its whole detail. */
export function AuditEntryFacts({ row }: { row: AuditRowFacts }) {
  const seq = pad(row.seq);
  return (
    <>
      {row.outcome && <OutcomeBadge outcome={row.outcome} />}
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-3">domain</dt>
        <dd className="text-ink-2">{DOMAIN_NAME[row.domain]}</dd>
        <dt className="text-ink-3">action</dt>
        <dd className="font-mono text-ink-2">{row.action}</dd>
        <dt className="text-ink-3">hash</dt>
        <dd className="min-w-0">
          <CopyValue value={row.hash} label={`Copy the hash of #${seq}`} />
        </dd>
        <dt className="text-ink-3">prev</dt>
        <dd className="min-w-0">
          <CopyValue value={row.prevHash} label={`Copy the previous hash of #${seq}`} />
          <span className="mt-0.5 block font-sans text-ink-2">
            {row.link === "genesis" ? (
              <span className="text-ink-3">genesis — first link in the chain</span>
            ) : row.link === "matches" ? (
              <span>matches hash of #{pad(row.seq - 1)}</span>
            ) : row.link === "differs" ? (
              <span className="text-refused">does not match hash of #{pad(row.seq - 1)}</span>
            ) : null}
          </span>
        </dd>
        <dt className="text-ink-3">body hash</dt>
        <dd className="min-w-0">
          <CopyValue value={row.bodyHash} label={`Copy the body hash of #${seq}`} />
        </dd>
        <dt className="text-ink-3">signature</dt>
        <dd className="min-w-0">
          <CopyValue value={row.signature} label={`Copy the signature of #${seq}`} />
        </dd>
      </dl>
      <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-ground p-3 font-mono text-xs leading-relaxed text-ink-2">{JSON.stringify(row.detail, null, 2)}</pre>
    </>
  );
}

/** A long value that wraps inside its row, and a button that copies all of it. */
function CopyValue({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex min-w-0 items-start gap-1">
      <span className="min-w-0 break-all font-mono text-ink-2">{value}</span>
      <CopyButton value={value} label={label} className="-my-1.5 shrink-0" />
    </span>
  );
}
