import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ComponentProps } from "react";
import ReportingCurrencyPanel from "@/components/ReportingCurrencyPanel";
import { cn } from "@/components/ui/cn";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { CashScenarios } from "@/components/vx/CashScenarios";
import { CurrencyReport } from "@/components/vx/CurrencyReport";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { CONTENT_FRAME } from "@/components/vx/frame";
import { invoiceDecision } from "@/components/vx/map";
import { sectionTitle } from "@/components/vx/nav";
import { PageHead } from "@/components/vx/Shell";
import { DESIGN_SLUG } from "../../../design/fixtures";
import {
  CURRENCY_REPORT,
  CURRENCY_TODAY,
  HARBOR_ENTRY,
  HARBOR_INVOICE,
  HARBOR_PARTY,
  HARBOR_VARIANCE,
  SAVED_SCENARIOS,
  SCENARIO_HINTS,
  TODAY_RATES,
} from "../../currency-fixture";

/**
 * Currencies with sample data, for the partner's review of docs/superpowers/specs/2026-10-13-currency-provenance-
 * design.md (`docs/superpowers/specs/currency-provenance-shots/`): the reporting currency in Settings, the report's
 * Currencies and rates with mixed currencies and one unknown rate, a paid shadow-mode bill with its FX variance, and a
 * cash scenario with a rate typed and its saved versions. Every figure is worked out by the pages' own functions from the
 * fixture. Like /docs-shots, it answers only where `DOCS_SCREENSHOTS=1` is set, read per request: everywhere else, a 404.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Currency states", robots: { index: false, follow: false } };

const STATES = ["setting", "report", "variance", "scenario"] as const;
type State = (typeof STATES)[number];

/** What Treasury's What if starts from: bills written in SGD and JPY among the rest, two receivables, cash on hand. */
const BASIS: ComponentProps<typeof CashScenarios>["basis"] = {
  today: CURRENCY_TODAY,
  cash: 3200,
  reserve: 2000,
  outflows: [
    { id: "marina", kind: "bill", label: "Marina Cleaning", amount: 503.76, day: 4, note: "due", foreign: true, original: { currency: "SGD", amount: "680", perUsd: "1.3498" } },
    { id: "tokyo", kind: "bill", label: "Tokyo Print Co", amount: 1005.15, day: 7, note: "due", foreign: true, original: { currency: "JPY", amount: "150000", perUsd: "149.23" } },
    { id: "harbor", kind: "bill", label: "Harbor Freight Pte", amount: 2000, day: 12, note: "due", foreign: true, original: { currency: "SGD", amount: "2700", perUsd: "1.35" } },
    { id: "northwind", kind: "bill", label: "Northwind Hosting", amount: 1200, day: 18, note: "due", foreign: false },
    { id: "lina", kind: "milestone", label: "Lina Park: Launch QA", payee: "Lina Park", amount: 900, day: 0, note: "payable once verified", foreign: false },
  ],
  receivables: [
    { id: "acme", label: "Acme Retail", amount: 2500, day: 10, overdue: false, client: "acme" },
    { id: "lumen", label: "Lumen Cafe", amount: 1800, day: 26, overdue: false, client: "lumen" },
  ],
  clients: { acme: { paidOnTime: 3, paidLate: 1, averageDaysLate: 6 } },
  eurc: [],
  recurringRead: true,
};

function SettingShot() {
  return (
    <>
      <PageHead
        title={sectionTitle("settings")}
        sub="Your own notifications, and how this workspace goes live, connects to other tools, approves payments and signs its ledger. An owner takes it live, sets two approvals, rotates the ledger signing key or deletes it; an owner or admin manages API keys, webhooks and integrations."
      />
      <div className="space-y-10">
        <ReportingCurrencyPanel orgSlug={DESIGN_SLUG} available setting={{ currency: "SGD", setAt: "2026-10-12T09:30:00.000Z", setBy: null }} canChange />
        <section>
          <SectionHeader title="As a member who cannot change it sees it" />
          <ReportingCurrencyPanel orgSlug={DESIGN_SLUG} available setting={{ currency: "SGD", setAt: "2026-10-12T09:30:00.000Z", setBy: null }} canChange={false} />
        </section>
      </div>
    </>
  );
}

function ReportShot() {
  return (
    <>
      <PageHead
        title={sectionTitle("report")}
        sub="What the agent did with this workspace's bills since it opened: what it paid and with what proof, what it stopped and why, and how often a person stepped in."
      />
      <CurrencyReport report={CURRENCY_REPORT} settingsHref="#" />
    </>
  );
}

function VarianceShot() {
  const decision = invoiceDecision(HARBOR_INVOICE, HARBOR_PARTY, [HARBOR_ENTRY], {
    network: "arc-testnet",
    asOf: Date.parse(`${CURRENCY_TODAY}T09:00:00Z`),
    variances: { recorded: new Map([[HARBOR_VARIANCE.invoiceId, HARBOR_VARIANCE]]), unknown: new Map() },
  });
  return (
    <>
      <PageHead title={sectionTitle("invoices")} sub="Your bills, what the agent decided on each, and why." />
      <DecisionCard decision={decision} orgSlug={DESIGN_SLUG} />
    </>
  );
}

function ScenarioShot() {
  const reporting = { currency: "SGD", rates: TODAY_RATES, missing: {} };
  return (
    <>
      <PageHead title={sectionTitle("treasury")} sub="What the agent holds, what it decided, and why." />
      <CashScenarios
        basis={BASIS}
        defaultOpen
        rateHints={SCENARIO_HINTS}
        reporting={reporting}
        saving={{ orgSlug: DESIGN_SLUG, available: true, canSave: true, versions: SAVED_SCENARIOS }}
        initial={SAVED_SCENARIOS[0]}
      />
    </>
  );
}

type Props = { params: Promise<{ state: string }> };

export default async function CurrencyStatePage({ params }: Props) {
  if (process.env.DOCS_SCREENSHOTS !== "1") notFound();
  const { state } = await params;
  if (!(STATES as readonly string[]).includes(state)) notFound();
  const shown = state as State;
  return (
    <MotionProvider>
      <main id="main" data-currency-state={shown} className="min-h-dvh bg-ground">
        <div className={cn(CONTENT_FRAME, "pb-10 pt-6")}>
          {shown === "setting" ? <SettingShot /> : shown === "report" ? <ReportShot /> : shown === "variance" ? <VarianceShot /> : <ScenarioShot />}
        </div>
      </main>
    </MotionProvider>
  );
}
