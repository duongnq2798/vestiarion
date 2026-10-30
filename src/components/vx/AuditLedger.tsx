import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { chipVariants } from "@/components/ui/chip";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { orgHref } from "@/lib/auth/org-paths";
import type { LedgerEntry } from "@/lib/ledger";
import { AuditRow, AuditRowIcons, type AuditRowFacts } from "./AuditRow";
import { DOMAIN_NAME, DOMAINS, DomainGlyph } from "./Glyphs";
import { pad } from "./Primitives";
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

// The pages that name entries by number import it from here; it lives with the primitives so a row can use it too.
export { pad };

/** An entry in the audit log, on the page that starts with it. */
export function entryHref(slug: string, seq: number): string {
  return orgHref(slug, `/audit?before=${seq + 1}#seq-${seq}`);
}

/**
 * What a row shows of its entry, and nothing more (`AuditRowFacts`). `previous` is the entry before it, when on the
 * page, to say whether the two link; `arrival`, a row the cycle just run added, its place in its day.
 */
export function auditRowFacts(entry: LedgerEntry, previous?: LedgerEntry, arrival?: number): AuditRowFacts {
  const genesis = /^0+$/.test(entry.prevHash.replace(/^0x/, ""));
  const decisionMode = typeof entry.detail.decisionMode === "string" ? entry.detail.decisionMode : undefined;
  return {
    seq: entry.seq,
    time: entry.ts.slice(11, 16),
    domain: entry.domain as Domain,
    actor: entry.actor,
    summary: entry.summary,
    action: entry.action,
    // Left out when absent: an absent field sent to the browser costs its name and a marker.
    ...(decisionMode ? { decisionMode } : {}),
    outcome: entryOutcome(entry),
    hash: entry.hash,
    prevHash: entry.prevHash,
    bodyHash: entry.bodyHash,
    signature: entry.signature,
    link: genesis ? "genesis" : previous ? (previous.hash === entry.prevHash ? "matches" : "differs") : null,
    detail: entry.detail,
    ...(arrival != null ? { arrival } : {}),
  };
}

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
  const domains = DOMAINS.filter((domain) => entries.some((entry) => entry.domain === domain));

  // `overflow-clip`, not `-hidden`: a hidden overflow makes the card a scroll
  // container, and the day headers would stick to it instead of the viewport.
  // They stop below the workspace's top bar where there is one (below `lg`).
  // Each row is a client component given its facts (`AuditRow`): the page sends a row's data, not its markup a second
  // time for React to hydrate, and an entry's hashes and detail as data only, drawn in the browser.
  return (
    <Card className="overflow-clip">
      <AuditRowIcons domains={domains} />
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
              <AuditRow key={entry.seq} row={auditRowFacts(entry, bySeq.get(entry.seq - 1), since != null && entry.seq > since ? index : undefined)} />
            ))}
          </ol>
        </section>
      ))}
    </Card>
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
