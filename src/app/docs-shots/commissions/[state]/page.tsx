import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { COMMISSIONS_SUB, CommissionsScreen } from "@/components/commissions/CommissionsScreen";
import { Callout } from "@/components/ui/Callout";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { PageHead } from "@/components/vx/Shell";
import { DESIGN_SLUG } from "../../../design/fixtures";
import { COMMISSION_MEMBERS, COMMISSIONS, COMMISSIONS_NOW } from "../../commissions-fixture";

/**
 * Commissions with sample data (docs/superpowers/specs/2026-10-14-commissions-design.md C10, C11): the page as an owner
 * sees it, as the member a plan names as the partner sees it, and before migration 0118 runs. Like /docs-shots, it
 * answers only where `DOCS_SCREENSHOTS=1` is set, read per request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Commission states", robots: { index: false, follow: false } };

const STATES = ["owner", "partner", "not-set-up"] as const;
type State = (typeof STATES)[number];

type Props = { params: Promise<{ state: string }> };

export default async function CommissionsStatePage({ params }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const shown = state as State;
  return (
    <MotionProvider>
      <main id="main" data-commissions-state={shown} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "pb-10 pt-6")}>
          <PageHead title="Commissions" sub={COMMISSIONS_SUB} />
          {shown === "not-set-up" ? (
            <Callout>Commissions are not set up on this deployment yet.</Callout>
          ) : (
            <CommissionsScreen
              orgSlug={DESIGN_SLUG}
              read={COMMISSIONS}
              canWrite
              viewerId={shown === "partner" ? "docs-sample-admin" : "docs-sample-owner"}
              members={COMMISSION_MEMBERS}
              now={COMMISSIONS_NOW}
              invoiceHref={(invoiceId) => `/docs-shots/bills/receivables?open=${invoiceId}`}
            />
          )}
        </div>
      </main>
    </MotionProvider>
  );
}
