import Link from "next/link";
import { UntrustedText } from "@/components/vx/UntrustedText";
import { orgHref } from "@/lib/auth/org-paths";
import { billsHref } from "@/lib/bills-view";
import { utcDay } from "@/lib/copy";
import type { SentDraft } from "@/lib/invoice-drafts/store";

/** Where each draft came from, in a few words. */
const SOURCE: Record<SentDraft["source"], string> = {
  selection: "Text selected on a page, with the browser extension",
  file: "A file, with the browser extension",
  payee_link: "Sent through their payee link",
};

/** "1,250.50 USDC": a draft's amount as it was read, which 0121 keeps to digits and a point. */
const AMOUNT = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/**
 * The drafts sent for review that name this counterparty, newest first, under Documents on its page
 * (docs/superpowers/specs/2026-11-09-counterparty-page-design.md CL10), whether the browser extension captured them or
 * the payee sent them through their payee link: what was captured and when, each opening the captured drafts on Bills &
 * receivables, where it is reviewed and added. Never the captured text. The invoice number is the document's, so it is
 * shown as text from outside (CL12). Nothing when there are none.
 */
export function SentDrafts({ orgSlug, drafts }: { orgSlug: string; drafts: readonly SentDraft[] }) {
  if (drafts.length === 0) return null;
  const review = orgHref(orgSlug, billsHref({ tab: "bills", review: "captured" }));
  return (
    <ul className="divide-y divide-line rounded-lg border border-line bg-raised text-sm" aria-label="Invoices sent for review">
      {drafts.map((draft) => (
        <li key={draft.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-3 py-2">
          <span className="min-w-0">
            <span className="block text-ink">
              <UntrustedText text={draft.invoice_number} max={100} empty="No invoice number read" />
              {draft.amount && (
                <span className="text-ink-2">
                  {" "}
                  · {`${AMOUNT.format(Number(draft.amount))} ${draft.currency ?? ""}`.trim()}
                </span>
              )}
            </span>
            <span className="block text-xs text-ink-3">
              {SOURCE[draft.source] ?? "Captured"}
              {draft.sent_at ? ` · sent ${utcDay(draft.sent_at)}` : ""}
            </span>
          </span>
          <Link href={review} className="shrink-0 text-xs font-medium text-agent underline-offset-4 hover:underline">
            Open in Bills &amp; receivables
          </Link>
        </li>
      ))}
    </ul>
  );
}
