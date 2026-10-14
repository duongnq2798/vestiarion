import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CrmDealChanges } from "@/components/CrmDealChanges";
import { CrmDeals } from "@/components/CrmDeals";
import { CrmReceiptCard } from "@/components/CrmReceiptCard";
import { DealCashReadiness } from "@/components/deals/DealCashReadiness";
import { DealFigures } from "@/components/deals/DealFigures";
import { DealForm } from "@/components/deals/DealForm";
import { DealHeadSub } from "@/components/deals/DealHead";
import { DealSchedule } from "@/components/deals/DealSchedule";
import PipedrivePanel from "@/components/PipedrivePanel";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { PageHead } from "@/components/vx/Shell";
import { sectionTitle } from "@/components/vx/nav";
import { crmChangeWords } from "@/lib/connectors/crm";
import { dealPrefill } from "@/lib/connectors/crm-prefill";
import { receiptView } from "@/lib/connectors/crm-receipts-view";
import { DESIGN_SLUG } from "../../../design/fixtures";
import {
  PIPEDRIVE_CONNECTED,
  PIPEDRIVE_OPEN,
  PIPEDRIVE_PANELS,
  PIPEDRIVE_ROWS,
  PIPEDRIVE_TODAY,
  PIPEDRIVE_WON,
  SPRING_COSTS,
  springCampaign,
  springCollected,
} from "../../pipedrive-fixture";

/**
 * Pipedrive's connector in each state, with sample data, for the feature's pictures
 * (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md, `docs/superpowers/specs/pipedrive-shots/`): the
 * Settings card on Arc mainnet and on Arc testnet; the won deals to plan; Plan collections' form filled in; the planned
 * deal with its cash readiness; its receipts written back; a conflict; and a deal changed in Pipedrive. Every view is
 * built by the page's own functions. Like /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is set, read per
 * request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Pipedrive states", robots: { index: false, follow: false } };

const STATES = ["settings", "settings-testnet", "deals", "plan", "deal", "receipts", "conflict", "changed"] as const;
type State = (typeof STATES)[number];
type Props = { params: Promise<{ state: string }> };

function Settings({ testnet }: { testnet: boolean }) {
  return (
    <>
      <PageHead title={sectionTitle("settings")} sub="How this workspace connects to other tools." />
      <PipedrivePanel orgSlug={DESIGN_SLUG} view={PIPEDRIVE_CONNECTED} canManage notice={testnet ? null : "connected"} receipts={testnet ? PIPEDRIVE_PANELS.testnet : PIPEDRIVE_PANELS.on} />
    </>
  );
}

function Deals({ plan }: { plan: boolean }) {
  const prefill = dealPrefill({
    deal: { externalId: "42", reference: "pipedrive-42", name: "Spring campaign", amount: "200", currency: "USD", closeOn: "2026-10-14", company: { externalId: "501", name: "Cedar & Co" } },
    linkedCustomerId: null,
    customers: [{ id: "c1c1c1c1-0000-4000-8000-0000000d0c09", name: "Larkspur Bakery" }],
    workspace: { shadowOn: false },
    today: PIPEDRIVE_TODAY,
    label: "Pipedrive",
  });
  return (
    <>
      <PageHead title={sectionTitle("invoices")} sub="Your bills, what the agent decided on each, and why." />
      <SectionHeader title="Deals" meta="each signed deal and its collection schedule" />
      {plan && (
        <div id="plan-from-pipedrive" className="scroll-mt-6">
          <IntakeFold label="Plan collections: Spring campaign" meta="from Pipedrive: pick how it is billed, check the rest, and confirm" defaultOpen>
            <DealForm
              orgSlug={DESIGN_SLUG}
              customers={[{ id: "c1c1c1c1-0000-4000-8000-0000000d0c09", name: "Larkspur Bakery" }]}
              currencies={["USDC", "EURC"]}
              idempotencyKey="pipedrive-shot"
              today={PIPEDRIVE_TODAY}
              prefill={{ crmRowId: "row-42", label: "Pipedrive", ...prefill }}
            />
          </IntakeFold>
        </div>
      )}
      <CrmDeals
        provider="pipedrive"
        orgSlug={DESIGN_SLUG}
        organisation="Cedar & Co"
        won={PIPEDRIVE_WON}
        open={PIPEDRIVE_OPEN}
        emails={[{ counterpartyId: "c1c1c1c1-0000-4000-8000-0000000d0c09", name: "Larkspur Bakery", email: "hello@larkspur.example" }]}
        canWrite
      />
    </>
  );
}

function Deal({ state }: { state: "deal" | "receipts" | "conflict" | "changed" }) {
  const deal = springCampaign(state === "conflict");
  const collected = springCollected(deal);
  const receipt =
    state === "conflict"
      ? receiptView({ label: "Pipedrive", gate: { ok: true }, latest: PIPEDRIVE_ROWS.conflict, lastWritten: PIPEDRIVE_ROWS.written })
      : receiptView({ label: "Pipedrive", gate: { ok: true }, latest: PIPEDRIVE_ROWS.written, lastWritten: PIPEDRIVE_ROWS.written });
  const changes = [
    crmChangeWords({ what: "amount", from: { amount: "200", currency: "USD" }, to: { amount: "260", currency: "USD" } }, "Pipedrive"),
    crmChangeWords({ what: "close", from: "2026-10-14", to: "2026-10-16" }, "Pipedrive"),
  ];
  return (
    <>
      <PageHead title={deal.title} sub={<DealHeadSub deal={deal} today={PIPEDRIVE_TODAY} />} />
      <DealFigures deal={deal} today={PIPEDRIVE_TODAY} collected={collected} />
      <div className="space-y-8">
        {state === "changed" && <CrmDealChanges orgSlug={DESIGN_SLUG} dealId={deal.facts.id} label="Pipedrive" words={changes} seen="shot" canWrite active from="pipedrive" />}
        {state !== "deal" && <CrmReceiptCard orgSlug={DESIGN_SLUG} dealId={deal.facts.id} view={{ ...receipt, provider: "pipedrive" }} canManage />}
        {(state === "deal" || state === "changed") && (
          <DealCashReadiness facts={deal.facts} digits={deal.digits} template={deal.template} costs={SPRING_COSTS} collected={collected.byReceivable} today={PIPEDRIVE_TODAY} changeHref="#change" />
        )}
        {state === "deal" && <CrmReceiptCard orgSlug={DESIGN_SLUG} dealId={deal.facts.id} view={{ ...receipt, provider: "pipedrive" }} canManage />}
        <DealSchedule orgSlug={DESIGN_SLUG} deal={deal} today={PIPEDRIVE_TODAY} canWrite={false} />
      </div>
    </>
  );
}

export default async function PipedriveStatePage({ params }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const shown = state as State;
  return (
    <MotionProvider>
      <main id="main" data-pipedrive-state={shown} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, shown.startsWith("settings") ? "max-w-3xl pb-10 pt-6" : "pb-10 pt-6")}>
          {shown === "settings" || shown === "settings-testnet" ? (
            <Settings testnet={shown === "settings-testnet"} />
          ) : shown === "deals" || shown === "plan" ? (
            <Deals plan={shown === "plan"} />
          ) : (
            <Deal state={shown} />
          )}
        </div>
      </main>
    </MotionProvider>
  );
}
