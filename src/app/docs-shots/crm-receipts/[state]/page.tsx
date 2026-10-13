import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CrmReceiptCard } from "@/components/CrmReceiptCard";
import HubSpotPanel from "@/components/HubSpotPanel";
import { DealSchedule } from "@/components/deals/DealSchedule";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { PageHead } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { receiptView } from "@/lib/connectors/crm-receipts-view";
import { DESIGN_SLUG } from "../../../design/fixtures";
import { RECEIPT_ROWS, RECEIPTS_CONNECTED, RECEIPTS_PANELS, RECEIPTS_TODAY, receiptsDeal } from "../../crm-receipts-fixture";

/**
 * Receipts written to HubSpot in each state, with sample data, for the feature's pictures
 * (docs/superpowers/specs/2026-10-13-crm-receipts-design.md, `docs/superpowers/specs/crm-receipts-shots/`): a deal's page
 * with its receipts written, waiting, failed, in conflict, not allowed yet and not written by the reality rule; and the
 * HubSpot card in Settings with writing on, and before HubSpot allowed it. Every view is built by the page's own
 * function (`receiptView`). Like /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is set, read per request:
 * everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Receipts in HubSpot states", robots: { index: false, follow: false } };

const DEAL_STATES = ["written", "waiting", "failed", "conflict", "not-allowed", "refused"] as const;
const SETTINGS_STATES = ["settings", "settings-allow"] as const;

type Props = { params: Promise<{ state: string }> };

function dealView(state: (typeof DEAL_STATES)[number]) {
  const { written, earlier, waiting, failed, conflict, refused } = RECEIPT_ROWS;
  switch (state) {
    case "written":
      return receiptView({ label: "HubSpot", gate: { ok: true }, latest: written, lastWritten: written });
    case "waiting":
      return receiptView({ label: "HubSpot", gate: { ok: true }, latest: waiting, lastWritten: earlier });
    case "failed":
      return receiptView({ label: "HubSpot", gate: { ok: true }, latest: failed, lastWritten: earlier });
    case "conflict":
      return receiptView({ label: "HubSpot", gate: { ok: true }, latest: conflict, lastWritten: earlier });
    case "not-allowed":
      return receiptView({ label: "HubSpot", gate: { ok: false, reason: "scope" }, latest: null, lastWritten: null });
    case "refused":
      return receiptView({ label: "HubSpot", gate: { ok: true }, latest: refused, lastWritten: null });
  }
}

export default async function CrmReceiptsStatePage({ params }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  const slug = DESIGN_SLUG;
  if ((SETTINGS_STATES as readonly string[]).includes(state)) {
    return (
      <MotionProvider>
        <main id="main" data-receipts-state={state} className="min-h-dvh bg-ground">
          <div className={cn(CONTENT_FRAME, "max-w-3xl pb-10 pt-6")}>
            <PageHead title={sectionTitle("settings")} sub="How this workspace connects to other tools." />
            <HubSpotPanel
              orgSlug={slug}
              view={RECEIPTS_CONNECTED}
              canManage
              notice={state === "settings" ? "writing" : null}
              receipts={state === "settings" ? RECEIPTS_PANELS.on : RECEIPTS_PANELS.allow}
            />
          </div>
        </main>
      </MotionProvider>
    );
  }
  if (!(DEAL_STATES as readonly string[]).includes(state)) notFound();
  const deal = receiptsDeal();
  return (
    <MotionProvider>
      <main id="main" data-receipts-state={state} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "pb-10 pt-6")}>
          <PageHead
            title={deal.title}
            sub={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span>{deal.customer.name}</span>
                <Badge size="sm" tone="agent" dot>
                  Collecting
                </Badge>
                <span className="text-ink-3">Version 1 · signed Oct 1, 2026 · payment terms 14 days · reference {deal.externalRef}</span>
              </span>
            }
          />
          <div className="space-y-8">
            <CrmReceiptCard orgSlug={slug} dealId={deal.facts.id} view={dealView(state as (typeof DEAL_STATES)[number])} canManage />
            <DealSchedule orgSlug={slug} deal={deal} today={RECEIPTS_TODAY} canWrite={false} />
          </div>
        </div>
      </main>
    </MotionProvider>
  );
}
