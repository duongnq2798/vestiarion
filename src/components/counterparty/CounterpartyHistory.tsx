import Link from "next/link";
import { Disclosure } from "@/components/ui/Disclosure";
import { entryHref } from "@/components/vx/AuditLedger";
import { pad } from "@/components/vx/Primitives";
import { UntrustedText } from "@/components/vx/UntrustedText";
import { orgHref } from "@/lib/auth/org-paths";
import { PART_NOT_READ } from "@/lib/counterparties/page-view";
import { utcMinute } from "@/lib/copy";
import type { CounterpartyEntry } from "@/lib/ledger";

/** The Audit log's compliance entries, where every one of a counterparty's is (CL11). */
const AUDIT_COMPLIANCE = "/audit?domain=compliance";

/**
 * History on a counterparty's page (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL11): its latest
 * compliance entries, newest first, each linking to its place in the Audit log, where its signature is checked; folded,
 * and the page's one `history` id. Only what was done, by whom and when, never an entry's detail. A summary can name the
 * counterparty, so it is shown as text from outside (CL12). `entries` is null when they could not be read (CL13).
 */
export function CounterpartyHistory({ orgSlug, entries }: { orgSlug: string; entries: readonly CounterpartyEntry[] | null }) {
  return (
    <Disclosure
      id="history"
      summary={
        <span className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-base font-semibold tracking-tight text-ink">History</h2>
          {entries && entries.length > 0 && <span className="text-[0.8125rem] font-normal text-ink-3">The latest {entries.length}</span>}
        </span>
      }
    >
      {entries === null ? (
        <p className="text-sm text-ink-3">{PART_NOT_READ}</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-ink-3">No changes recorded yet.</p>
      ) : (
        <ol className="divide-y divide-line">
          {entries.map((entry) => (
            <li key={entry.seq} className="py-2 first:pt-0">
              <Link href={entryHref(orgSlug, entry.seq)} className="text-sm text-ink underline-offset-4 hover:text-agent hover:underline">
                <span className="font-mono text-xs text-ink-3">#{pad(entry.seq)}</span> <UntrustedText text={entry.summary} max={300} />
              </Link>
              <p className="mt-0.5 text-xs text-ink-3">
                {utcMinute(entry.ts)} · {entry.actor}
              </p>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-xs">
        <Link href={orgHref(orgSlug, AUDIT_COMPLIANCE)} className="font-medium text-agent underline-offset-4 hover:underline">
          All of it in the Audit log
        </Link>
      </p>
    </Disclosure>
  );
}
