import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { chipVariants } from "@/components/ui/chip";
import { cn } from "@/components/ui/cn";
import { CopyButton } from "@/components/ui/CopyButton";
import { Disclosure } from "@/components/ui/Disclosure";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { orgHref } from "@/lib/auth/org-paths";
import type { LedgerEntry } from "@/lib/ledger";
import { DOMAIN_CODE, DOMAIN_NAME, DOMAINS, DomainGlyph } from "./Glyphs";
import { Hash, ModeBadge, OutcomeBadge } from "./Primitives";
import type { Domain, Outcome } from "./types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function entryOutcome(entry: LedgerEntry): Outcome | null {
  const execution = record(entry.detail.execution);
  const txRef = typeof execution?.txRef === "string" ? execution.txRef : undefined;
  if (entry.detail.guardrailBlocked === true) return "refused";
  if (txRef?.startsWith("0x")) return "settled";
  if (entry.action === "hold" || /\b(hold|held|awaiting|flagged)\b/i.test(entry.summary)) return "held";
  if (entry.detail.earnMode === "simulate" || txRef?.startsWith("sim_")) return "simulated";
  return null;
}

/**
 * The group an entry is listed under: its simulated day for a cycle run on the simulated clock, else its UTC date.
 * A cycle on the real clock records `day` too, always 0 (the simulated day never moves), with `clockMode: "real"`:
 * grouped by it, every cycle cut the day's entries into a "Day 0" of its own. An entry from before `clockMode` was
 * recorded counts as simulated only when its day had moved.
 */
function entryDay(entry: LedgerEntry) {
  const day = typeof entry.detail.day === "number" ? entry.detail.day : undefined;
  const clock = entry.detail.clockMode;
  const simulated = clock === "simulate" || (clock === undefined && day !== undefined && day > 0);
  return simulated && day !== undefined ? `Day ${day}` : entry.ts.slice(0, 10);
}

export const pad = (value: number) => String(value).padStart(4, "0");

export function AuditLedger({ entries, since }: { entries: LedgerEntry[]; since?: number }) {
  const sorted = [...entries].sort((a, b) => b.seq - a.seq);
  const bySeq = new Map(entries.map((entry) => [entry.seq, entry]));
  const groups: Array<{ day: string; rows: LedgerEntry[] }> = [];
  for (const entry of sorted) {
    const day = entryDay(entry);
    const group = groups.at(-1);
    if (group?.day === day) group.rows.push(entry);
    else groups.push({ day, rows: [entry] });
  }

  // `overflow-clip`, not `-hidden`: a hidden overflow makes the card a scroll
  // container, and the day headers would stick to it instead of the viewport.
  // They stop below the workspace's top bar where there is one (below `lg`).
  return (
    <Card className="overflow-clip">
      <div className="hidden grid-cols-[3.25rem_3rem_5.75rem_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line py-2 pl-9 pr-4 sm:grid">
        <Eyebrow>Seq</Eyebrow>
        <Eyebrow>UTC</Eyebrow>
        <Eyebrow>Domain</Eyebrow>
        <Eyebrow>Entry</Eyebrow>
        <Eyebrow>Hash</Eyebrow>
      </div>
      {groups.map((group, groupIndex) => (
        <section key={`${group.day}-${groupIndex}`} aria-label={group.day}>
          <div className="sticky top-14 z-10 flex items-baseline justify-between border-b border-line bg-raised/95 px-4 py-1.5 backdrop-blur sm:pl-9">
            <span className="text-[0.8125rem] font-semibold text-ink">{group.day}</span>
            <span className="font-mono text-[0.6875rem] text-ink-2">
              #{pad(group.rows.at(-1)!.seq)}–#{pad(group.rows[0].seq)} · {group.rows.length} entries
            </span>
          </div>
          <ol>
            {group.rows.map((entry, index) => (
              <AuditRow key={entry.seq} entry={entry} previous={bySeq.get(entry.seq - 1)} fresh={since != null && entry.seq > since} index={index} />
            ))}
          </ol>
        </section>
      ))}
    </Card>
  );
}

function AuditRow({ entry, previous, fresh, index }: { entry: LedgerEntry; previous?: LedgerEntry; fresh: boolean; index: number }) {
  const outcome = entryOutcome(entry);
  const refused = outcome === "refused";
  const time = entry.ts.slice(11, 16);
  const genesis = /^0+$/.test(entry.prevHash.replace(/^0x/, ""));
  const linked = genesis ? null : previous ? previous.hash === entry.prevHash : null;
  const domain = entry.domain as Domain;
  const decisionMode = typeof entry.detail.decisionMode === "string" ? entry.detail.decisionMode : undefined;
  const sweep = entry.action === "compliance_sweep";
  const changed = entry.action === "risk_level_changed";
  const seq = pad(entry.seq);

  return (
    <li
      id={`seq-${entry.seq}`}
      className={cn(
        "relative scroll-mt-10 border-b border-line last:border-b-0",
        fresh && "bg-agent-soft/60 motion-safe:animate-arrive",
        refused && "bg-refused-soft/70",
        changed && !refused && "bg-held-soft/35"
      )}
      style={fresh ? { animationDelay: `${index * 55}ms` } : undefined}
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
        summaryClassName="py-2.5 pl-9 pr-4 transition-colors duration-150 ease-standard hover:bg-raised/60 sm:grid sm:grid-cols-[3.25rem_3rem_5.75rem_minmax(0,1fr)_auto] sm:items-start sm:gap-x-3"
        contentClassName="space-y-3 pb-4 pl-9 pr-4 sm:pl-[calc(2.25rem+3.25rem+3rem+5.75rem+2.25rem)]"
        summary={
          <>
            <span className="font-mono text-xs tabular-nums text-ink-2">#{seq}</span>
            <span className="ml-2 font-mono text-xs tabular-nums text-ink-3 sm:ml-0">{time}</span>
            <span className="ml-2 inline-flex items-center gap-1 font-mono text-[0.6875rem] text-ink-3 sm:ml-0">
              <DomainGlyph domain={domain} className="size-2.5" />
              {DOMAIN_CODE[domain]}
            </span>
            <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:mt-0">
              <ChevronRight aria-hidden className="size-3 text-ink-3 transition-transform duration-200 ease-standard group-open/disclosure:rotate-90" />
              <span className="shrink-0 text-[0.8125rem] text-ink-3">{entry.actor}</span>
              <span className={cn("min-w-0 text-sm", refused ? "text-refused" : "text-ink")}>{entry.summary}</span>
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
              <ModeBadge mode={decisionMode} />
            </span>
            <span className="mt-1 hidden justify-end sm:flex">
              <Hash value={entry.hash} />
            </span>
          </>
        }
      >
        {outcome && <OutcomeBadge outcome={outcome} />}
        <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
          <dt className="text-ink-3">domain</dt>
          <dd className="text-ink-2">{DOMAIN_NAME[domain]}</dd>
          <dt className="text-ink-3">action</dt>
          <dd className="font-mono text-ink-2">{entry.action}</dd>
          <dt className="text-ink-3">hash</dt>
          <dd className="min-w-0">
            <CopyValue value={entry.hash} label={`Copy the hash of #${seq}`} />
          </dd>
          <dt className="text-ink-3">prev</dt>
          <dd className="min-w-0">
            <CopyValue value={entry.prevHash} label={`Copy the previous hash of #${seq}`} />
            <span className="mt-0.5 block font-sans text-ink-2">
              {genesis ? (
                <span className="text-ink-3">genesis — first link in the chain</span>
              ) : linked === true ? (
                <span>matches hash of #{pad(entry.seq - 1)}</span>
              ) : linked === false ? (
                <span className="text-refused">does not match hash of #{pad(entry.seq - 1)}</span>
              ) : null}
            </span>
          </dd>
          <dt className="text-ink-3">body hash</dt>
          <dd className="min-w-0">
            <CopyValue value={entry.bodyHash} label={`Copy the body hash of #${seq}`} />
          </dd>
          <dt className="text-ink-3">signature</dt>
          <dd className="min-w-0">
            <CopyValue value={entry.signature} label={`Copy the signature of #${seq}`} />
          </dd>
        </dl>
        <pre className="max-h-80 overflow-auto rounded-xl border border-line bg-ground p-3 font-mono text-xs leading-relaxed text-ink-2">{JSON.stringify(entry.detail, null, 2)}</pre>
      </Disclosure>
    </li>
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

export function DomainFilter({ active, orgSlug }: { active?: Domain; orgSlug: string }) {
  return (
    <nav aria-label="Filter audit log by domain" className="flex flex-wrap gap-1.5">
      <Link href={orgHref(orgSlug, "/audit")} aria-current={active ? undefined : "page"} className={chipVariants({ selected: !active })}>
        All
      </Link>
      {DOMAINS.map((domain) => (
        <Link
          key={domain}
          href={orgHref(orgSlug, `/audit?domain=${domain}`)}
          aria-current={active === domain ? "page" : undefined}
          className={chipVariants({ selected: active === domain })}
        >
          <DomainGlyph domain={domain} />
          {DOMAIN_NAME[domain]}
        </Link>
      ))}
    </nav>
  );
}
