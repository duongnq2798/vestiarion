import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CollectionsPanel } from "@/components/collections/CollectionsPanel";
import { NextAction } from "@/components/collections/NextAction";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { PageHead } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { DESIGN_SLUG } from "../../../design/fixtures";
import { COLLECTION_SHOTS, collectionsShot } from "../../collections-fixture";

/**
 * Collections that follow the customer's context in a given state, with sample data, for the feature's pictures
 * (docs/superpowers/specs/2026-10-13-collections-context-design.md, `docs/superpowers/specs/collections-context-shots/`):
 * `panel`, the Receivables tab's Collections panel; `vip`, a receivable whose customer's rules say ask first, with the
 * reminder's preview open; `rules`, the same with its customer's rules open; `hubspot`, one sold through a HubSpot deal
 * with an owner; `promise`, one whose customer missed its promised day; `remind`, one the agent reminds on its own. Built
 * by the page's own `buildCollections` and components. Like /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is
 * set, read per request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Collections states", robots: { index: false, follow: false } };

const STATES = ["panel", "vip", "rules", "hubspot", "promise", "remind"] as const;
type State = (typeof STATES)[number];

const OPENS: Record<Exclude<State, "panel">, string> = {
  vip: COLLECTION_SHOTS.vip,
  rules: COLLECTION_SHOTS.vip,
  hubspot: COLLECTION_SHOTS.hubspot,
  promise: COLLECTION_SHOTS.promise,
  remind: COLLECTION_SHOTS.remind,
};

export default async function CollectionsStatePage({ params }: { params: Promise<{ state: string }> }) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const shown = state as State;
  const opened = shown === "panel" ? null : OPENS[shown];
  const collections = collectionsShot((invoiceId) => `/docs-shots/collections/vip?open=${invoiceId}`, opened ? [opened] : []);
  const view = opened ? collections.views.get(opened) : null;

  return (
    <MotionProvider>
      <main id="main" data-collections-state={shown} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "pb-10 pt-6")}>
          <PageHead title={sectionTitle("invoices")} sub="Your bills, what the agent decided on each, and why." />
          {shown === "panel" || !view ? (
            <CollectionsPanel panel={collections.panel} available={collections.available} />
          ) : (
            <div className="max-w-2xl">
              <Card className="space-y-4 px-4 py-5 sm:px-6">
                <div>
                  <p className="text-xs font-medium text-ink-3">Receivable</p>
                  <h2 className="text-lg font-semibold text-ink">
                    {view.customerName} · {view.invoiceLabel}
                  </h2>
                  <p className="text-sm text-ink-2">
                    {view.owed} · {view.due}
                  </p>
                </div>
                <div className="border-t border-line pt-4">
                  <NextAction
                    orgSlug={DESIGN_SLUG}
                    view={view}
                    canWrite
                    rulesAvailable={collections.available}
                    open={shown === "rules" ? ["rules"] : ["preview"]}
                  />
                </div>
              </Card>
            </div>
          )}
        </div>
      </main>
    </MotionProvider>
  );
}
