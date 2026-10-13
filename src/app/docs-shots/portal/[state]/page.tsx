import type { Metadata } from "next";
import { CalendarX2 } from "lucide-react";
import { notFound } from "next/navigation";
import { PayInvoice } from "@/components/PayInvoice";
import { StatementView } from "@/components/portal/StatementView";
import { EmptyState } from "@/components/ui/EmptyState";
import { SiteFooter, SiteHeader } from "@/components/vx/SiteChrome";
import { utcDay } from "@/lib/copy";
import { networkProfile } from "@/lib/network";
import { PAY_PREVIEW, PORTAL_FORMS, PORTAL_TOKEN, statementShot } from "../../portal-fixture";

/**
 * A customer's statement in a given state, with sample data, for the customer portal's pictures
 * (docs/superpowers/specs/2026-10-13-customer-portal-design.md, `docs/superpowers/specs/customer-portal-shots/`): the
 * statement, each form open (I paid, promise to pay, dispute), the statement once the customer said it paid, an
 * expired link, and the pay link's page that Pay on Arc opens, part paid. Built by the page's own components; a form sent from here reaches no workspace, as the token is none's.
 * Like /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is set, read per request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Customer statement states", robots: { index: false, follow: false } };

const STATES = ["statement", "paid", "promise", "dispute", "claimed", "expired", "pay"] as const;
type State = (typeof STATES)[number];

export default async function PortalStatePage({ params }: { params: Promise<{ state: string }> }) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const shown = state as State;
  const form = shown === "paid" || shown === "promise" || shown === "dispute" ? { invoiceId: PORTAL_FORMS[shown], form: shown } : null;

  return (
    <div className="flex min-h-dvh flex-col" data-portal-state={shown}>
      <SiteHeader />
      <main id="main" className={shown === "pay" ? "flex flex-1 items-center justify-center px-4 py-12 sm:py-16" : "flex flex-1 justify-center px-4 py-8 sm:py-14"}>
        <div className={shown === "pay" ? "w-full max-w-md" : "w-full max-w-2xl"}>
          {shown === "pay" ? (
            <PayInvoice preview={PAY_PREVIEW} balance={{ owed: 800, received: 1000 }} token={`vxr_${"P".repeat(43)}`} />
          ) : shown === "expired" ? (
            <EmptyState
              icon={<CalendarX2 />}
              titleAs="h1"
              title="This link has expired."
              body={`It worked until ${utcDay("2026-10-11T09:00:00Z")}. Ask the business that sent it for a new one.`}
            />
          ) : (
            <StatementView view={statementShot({ claimed: shown === "claimed" })} token={PORTAL_TOKEN} openForm={form} />
          )}
        </div>
      </main>
      <SiteFooter compact networkLabel={shown === "expired" ? undefined : networkProfile("arc-testnet").label} />
    </div>
  );
}
