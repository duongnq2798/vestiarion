import { ListChecks, UserPlus } from "lucide-react";
import type { ReactNode } from "react";
import { AgentBudgetPanel } from "@/components/AgentBudgetPanel";
import { AllocationLines } from "@/components/AllocationLines";
import { ApplyPayments } from "@/components/ApplyPayments";
import ApprovalCard from "@/components/ApprovalCard";
import { CounterpartyRow as CounterpartyRowView } from "@/components/CounterpartyRow";
import EmailInboxPanel from "@/components/EmailInboxPanel";
import GoLivePanel from "@/components/GoLivePanel";
import InboxEmails from "@/components/InboxEmails";
import NotificationsPanel from "@/components/NotificationsPanel";
import { HeldMilestoneActions } from "@/components/HeldMilestoneActions";
import { StatementMatches, StatementReadPanel } from "@/components/BankStatementImport";
import { PayLinkControl } from "@/components/PayLinkControl";
import SlackPanel from "@/components/SlackPanel";
import { UsycReservePanel } from "@/components/UsycReservePanel";
import CreateWorkspaceForm from "@/components/CreateWorkspaceForm";
import VerdictControl from "@/components/VerdictControl";
import VerifyLedgerBadge from "@/components/VerifyLedgerBadge";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { DecisionTrail } from "@/components/vx/DecisionTrail";
import { PaymentsInFlight } from "@/components/vx/PaymentsInFlight";
import { SettlementTrack } from "@/components/vx/SettlementTrack";
import { WaitingPayableAction } from "@/components/WaitingPayableAction";
import CounterpartyAddress from "@/components/intake/CounterpartyAddressEdit";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import { BillImportShot } from "./BillImportShot";
import { fromCustomersShot, PORTAL_TOKEN, statementShot } from "./portal-fixture";
import { FromCustomers } from "@/components/portal/FromCustomers";
import { StatementView } from "@/components/portal/StatementView";
import { BillRows } from "@/components/bills/BillsList";
import { billRowItem, listRowOf } from "@/components/bills/build";
import { NEW_ITEMS } from "@/components/bills/new-items";
import type { NewKind } from "@/lib/bills-view";
import type { Decision } from "@/components/vx/types";
import { DocumentDraft } from "@/components/intake/InvoiceDocumentIntake";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import PayFreelancerForm, { PaymentLinkReady } from "@/components/intake/PayFreelancerForm";
import { PayeeJourney } from "@/components/payee/PayeeJourney";
import { PhoneHandoffUrl } from "@/components/treasury/PhoneHandoff";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { AuditLedger, pad } from "@/components/vx/AuditLedger";
import { DecisionRows, RowGroupHeading } from "@/components/vx/DecisionRows";
import { IntakeFold } from "@/components/vx/IntakeFold";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { invoiceDecision, milestoneDecision } from "@/components/vx/map";
import type { NavKey } from "@/components/vx/nav";
import { Hash } from "@/components/vx/Primitives";
import { ReportLists, ReportReadiness, ReportSummary } from "@/components/vx/WorkspaceReport";
import ReportBaselineControl from "@/components/ReportBaselineControl";
import { ReportShareButton, ReportShareLinks, type LiveLink } from "@/components/ReportShareControl";
import { ReportValue } from "@/components/vx/ReportValue";
import { SharedDecisions, SharedReportFigures, SharedReportHead } from "@/components/vx/SharedReport";
import { StatusChipRow, StatusPanel } from "@/components/vx/WorkspaceHeader";
import { statusChips, statusRows, type PageStatus, type PlatformStatus } from "@/components/vx/workspace-status";
import { ActualsBills, ActualsSummary } from "@/components/vx/ActualsComparison";
import { CashScenarios, CoverageList, ScenarioCases, ScenarioFindings } from "@/components/vx/CashScenarios";
import { cashScenario, DEFAULT_LEVERS, type ScenarioBasis } from "@/lib/cash-scenarios";
import { EvidenceAccess, EvidenceStepCard, evidenceSub } from "@/components/vx/EvidenceChain";
import { PageHead } from "@/components/vx/Shell";
import { evidenceLinkLabel, evidencePath } from "@/lib/evidence-paths";
import { orgHref } from "@/lib/auth/org-paths";
import type { EvidenceStep } from "@/lib/evidence-chain";
import { compareActuals, type ActualRecord, type ActualsFacts } from "@/lib/actual-payments-compare";
import { readStatement, type StatementChoices } from "@/lib/bank-statement/lines";
import { matchStatement, type StatementBill } from "@/lib/bank-statement/match";
import type { WaitingPayable } from "@/lib/agent/approvals";
import { heldReason } from "@/lib/agent/milestone-decisions";
import type { LedgerEntry } from "@/lib/ledger";
import { reduceSettlement, type SettlementBooks, type SettlementFact } from "@/lib/settlement";
import type { FlightRow } from "@/lib/settlement-facts";
import type { PayeeLinkStatus } from "@/lib/payee-journey";
import type { GoLiveStatus } from "@/lib/platform/go-live";
import { gettingStarted } from "@/lib/getting-started";
import type { CounterpartyRow, InvoiceRow, MilestoneRow } from "@/lib/queries";
import type { SharedReportShown } from "@/lib/platform/shared-report";
import { paidOutside, reportValue, type BaselineState } from "@/lib/report-value";
import { buildSharedReport } from "@/lib/shared-report";
import { buildReport, type ReportBill, type ReportDecision, type ReportFacts } from "@/lib/workspace-report";
import { DESIGN_SLUG, LEDGER } from "../design/fixtures";
import { evidenceShot } from "./evidence-fixture";
import AccountingPanel from "@/components/AccountingPanel";
import { AccountingBillsReview } from "@/components/AccountingBillsReview";
import HubSpotPanel from "@/components/HubSpotPanel";
import { HubSpotDeals } from "@/components/HubSpotDeals";
import { CrmDealChanges } from "@/components/CrmDealChanges";
import { AccountingBookings } from "@/components/AccountingBookings";
import { APPLY_PAYMENTS, PART_PAID, PART_PAID_VIEW, PART_PAID_VIEWS } from "./allocations-fixture";
import { designRuleReplay } from "../design/replay-fixture";
import { RuleTrialPanel } from "@/components/RuleTrial";
import { PaymentPlanSection, PlanCashEffect, PlanOutcomesStrip } from "@/components/vx/PaymentPlan";
import { PAYMENT_PLAN_OUTCOMES, PAYMENT_PLAN_VIEWER, paymentPlanShot, planPart } from "./payment-plan-fixture";
import { DealChangeForm } from "@/components/deals/DealChangeForm";
import { DealForm } from "@/components/deals/DealForm";
import { DealSchedule, DealVersions } from "@/components/deals/DealSchedule";
import { DEALS_SHOT_TODAY, dealShot } from "./deals-fixture";
import { RULE_TRIAL_COPY } from "@/lib/rule-trial-copy";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/Input";

/**
 * The screenshots in the user guides, one state each, rendered by the app's
 * own components with made-up data (workspace-delete-footer-screenshots
 * design S1). `/docs-shots/<name>` renders one, and
 * `scripts/docs-screenshots.mjs` photographs it into
 * `public/docs/guides/<name>.png`, doing what the shot needs first: opening
 * a disclosure, filling a form, clicking a button.
 *
 * Nothing here is real: the workspace is /design's, whose slug names no
 * workspace, and the server actions refuse it without a signed-in member.
 * Addresses are well-formed and obviously made up.
 */

export interface DocsShot {
  /** The guide the picture belongs to. */
  guide:
    | "try-it"
    | "go-live"
    | "first-payment"
    | "where-a-payment-is"
    | "import-bills"
    | "try-a-rule"
    | "pay-a-contractor"
    | "get-paid"
    | "telegram"
    | "slack"
    | "email-invoices"
    | "xero"
    | "quickbooks"
    | "hubspot"
    | "payment-plan"
    | "report"
    | "workspace"
    | "cash-scenarios"
    | "evidence"
    | "apply-payments"
    | "deals"
    | "customer-portal";
  /** The workspace page it is on: its title heads the frame. None for a public page, such as a payee's link. */
  page?: NavKey;
  /** The page's line under its title, where the real page has one. */
  sub?: string;
  /** What `/api/ledger/verify` answers in this shot; the script serves it to the page, so Verify reaches a verdict without a ledger. */
  verification?: { valid: boolean; checkedEntries: number };
  render: () => ReactNode;
}

const SLUG = DESIGN_SLUG;

/** Settings' line under its title, as the page has it. */
const SETTINGS_SUB =
  "Your own notifications, and how this workspace goes live, connects to other tools, approves payments and signs its ledger. An owner takes it live, sets two approvals, rotates the ledger signing key or deletes it; an owner or admin manages API keys, webhooks and integrations.";

// ---------------------------------------------------------------------------
// Go live

const OPERATING_ADDRESS = `0x${"5eed".repeat(10)}`;
const RESERVE_ADDRESS = `0x${"feed".repeat(10)}`;

/** Where a new workspace's two accounts stand once their wallets exist: " (simulated)" is dropped from their names. */
const WALLETS: GoLiveStatus["wallets"] = [
  { accountName: "Operating", kind: "operating", address: OPERATING_ADDRESS },
  { accountName: "Reserve", kind: "reserve", address: RESERVE_ADDRESS },
];

/** A sandbox on a deployment with hosted wallets, before anything is chosen. */
const CHOOSING: GoLiveStatus = {
  step: "connect",
  connected: false,
  host: null,
  hostedAvailable: true,
  wallets: [],
  liveSince: null,
  credentialsUnreadable: false,
};

/** Circle's faucet sends 20 testnet USDC a request. */
const FAUCET_BALANCE = 20;

const OWNER_WALLET = `0x${"0a1e".repeat(10)}`;
const AGENT_WALLET = `0x${"a9e7".repeat(10)}`;
const CONTRACT_ADDRESS = `0x${"c0de".repeat(10)}`;

/** An Arc mainnet sandbox on a deployment with Vestiarion's agent account, before anything is chosen (wallet treasury W1). */
const OWN_WALLET_CHOOSING: GoLiveStatus = { ...CHOOSING, hostedAvailable: false, network: "arc-mainnet", walletTreasuryAvailable: true };

/** The owner's wallet, proven, with the agent's wallet created: the contract is next (W5, W6). */
const OWN_WALLET_DEPLOY: GoLiveStatus = {
  ...OWN_WALLET_CHOOSING,
  step: "wallets",
  host: "external",
  walletTreasury: {
    step: "deploy",
    wallet: OWNER_WALLET,
    agent: AGENT_WALLET,
    contract: null,
    dailyUsdc: null,
    weeklyUsdc: null,
    walletUsdc: 250,
    spendableUsdc: null,
    agentGasUsdc: 0,
    agentGasMinimumUsdc: 0.1,
    signer: "wallet",
    recovery: null,
    setupNeedsUsdc: 0,
    limitDailyUsdc: 50,
    limitWeeklyUsdc: 150,
    approval: null,
    figuresRead: false,
  },
};

/** Deployed, approved without a cap, and the agent holds its gas: going live is all that is left (W10). */
const OWN_WALLET_READY: GoLiveStatus = {
  ...OWN_WALLET_DEPLOY,
  step: "go_live",
  walletTreasury: {
    ...OWN_WALLET_DEPLOY.walletTreasury!,
    step: "ready",
    contract: CONTRACT_ADDRESS,
    dailyUsdc: 50,
    weeklyUsdc: 200,
    spendableUsdc: 250,
    agentGasUsdc: 0.5,
    approval: "unlimited",
    figuresRead: true,
  },
};

/** A passkey wallet chosen, with the agent's wallet made with it, before any USDC (passkey treasury K5). */
const PASSKEY_FUND: GoLiveStatus = {
  ...OWN_WALLET_DEPLOY,
  walletTreasury: { ...OWN_WALLET_DEPLOY.walletTreasury!, signer: "passkey", setupNeedsUsdc: 0.75, walletUsdc: 0 },
};

/** The passkey wallet holds its USDC: one confirmation sets it up (K6). */
const PASSKEY_SETUP: GoLiveStatus = {
  ...PASSKEY_FUND,
  walletTreasury: { ...PASSKEY_FUND.walletTreasury!, walletUsdc: 250 },
};

/** Set up in one confirmation: the recovery is decided next (K8). */
const PASSKEY_RECOVERY: GoLiveStatus = {
  ...PASSKEY_FUND,
  walletTreasury: {
    ...OWN_WALLET_READY.walletTreasury!,
    step: "recovery",
    signer: "passkey",
    setupNeedsUsdc: 0.75,
    walletUsdc: 249.45,
    spendableUsdc: 249.45,
  },
};

/** Live on Arc mainnet from a passkey wallet: its controls (treasury wallet controls C1). */
const PASSKEY_LIVE: GoLiveStatus = {
  ...PASSKEY_RECOVERY,
  step: "live",
  liveSince: "2026-10-07T08:30:37Z",
  walletTreasury: { ...PASSKEY_RECOVERY.walletTreasury!, step: "ready", recovery: "registered", approval: "unlimited", figuresRead: true },
};

/** Set up, with the agent's gas run short before going live: the passkey sends it more (the guide's "only when needed"). */
const PASSKEY_GAS: GoLiveStatus = {
  ...PASSKEY_RECOVERY,
  walletTreasury: { ...PASSKEY_RECOVERY.walletTreasury!, step: "gas", agentGasUsdc: 0.04 },
};

function goLive(status: GoLiveStatus, sampleBalance?: number): () => ReactNode {
  return function GoLiveShot() {
    // The phone handoff's code shows the workspace's own Settings, not the screenshot's address.
    return (
      <PhoneHandoffUrl url={`https://www.vestiarion.xyz/o/${SLUG}/settings`}>
        <GoLivePanel orgSlug={SLUG} status={status} canAdminister sampleBalance={sampleBalance} />
      </PhoneHandoffUrl>
    );
  };
}

// ---------------------------------------------------------------------------
// First payment

const COUNTERPARTY: CounterpartyRow = {
  id: "00000000-0000-4000-8000-0000000000d1",
  name: "Northstar Studio",
  role: "vendor",
  address: `0x${"c0ffee00".repeat(5)}`,
  chain: "ARC-TESTNET",
  jurisdiction: "US",
  risk_level: "clear",
  risk_notes: null,
  payment_limit: 50,
  baseline_payment_limit: 50,
  last_screened_at: "2026-09-30T11:52:00Z",
  performance_score: null,
  performance_inputs: null,
  address_changed_at: null,
  address_confirmed_at: null,
  sample: false,
};

const INVOICE: InvoiceRow = {
  id: "00000000-0000-4000-8000-0000000000e1",
  direction: "payable",
  counterparty_id: COUNTERPARTY.id,
  counterparty_name: COUNTERPARTY.name,
  amount: 12.5,
  memo: "October design retainer",
  po_reference: "PO-2207",
  goods_received: true,
  due_date: "2026-10-15",
  status: "paid",
  agent_reasoning:
    "Paid 12.50 USDC to Northstar Studio: PO-2207 matches and the work was received, Northstar Studio screened clear with a 50.00 USDC limit, and the operating wallet holds 20.00 USDC.",
  tx_ref: `0x${"7a".repeat(32)}`,
  scheduled_for: null,
  early_pay_discount_pct: null,
  discount_due_date: null,
  paid_amount: 12.5,
};

/**
 * The first four of /design's linked entries, then the payment above as the
 * fifth: signed, and linked to the fourth. Four are enough to show the chain,
 * and keep the picture short. A live workspace runs on the real clock, so the
 * entries carry no simulated day, and the ledger groups them by date.
 */
const EARLIER: LedgerEntry[] = LEDGER.slice(0, 4).map((entry) => {
  const detail = { ...entry.detail };
  delete detail.day;
  return { ...entry, detail };
});

const PAYMENT_ENTRY: LedgerEntry = {
  ...EARLIER[EARLIER.length - 1],
  seq: EARLIER.length + 1,
  id: "docs-payment",
  ts: "2026-09-30T12:04:00Z",
  domain: "ap",
  action: "ap_pay",
  summary: "Paid 12.50 USDC to Northstar Studio",
  detail: { invoiceId: INVOICE.id, decisionMode: "llm", observed: { riskLevel: "clear", paymentLimit: 50 }, execution: { txRef: INVOICE.tx_ref } },
  prevHash: EARLIER[EARLIER.length - 1].hash,
  hash: "3e".repeat(32),
  bodyHash: "9d".repeat(32),
};

const ENTRIES: LedgerEntry[] = [...EARLIER, PAYMENT_ENTRY];

/** A receivable whose reminders are on, with the two the agent sent (collections R1–R8). */
const OWED: InvoiceRow = {
  ...INVOICE,
  id: "00000000-0000-4000-8000-0000000000e9",
  direction: "receivable",
  counterparty_id: "00000000-0000-4000-8000-0000000000ea",
  counterparty_name: "Acme Retail",
  memo: "October retainer, INV-1042",
  po_reference: null,
  due_date: "2026-10-10",
  status: "pending",
  agent_reasoning: null,
  tx_ref: null,
  paid_amount: null,
};
const reminderEntry = (seq: number, ts: string, action: string, actor: LedgerEntry["actor"], detail: Record<string, unknown>): LedgerEntry => ({
  ...PAYMENT_ENTRY,
  seq,
  id: `docs-reminder-${seq}`,
  ts,
  actor,
  domain: "ar",
  action,
  summary: "",
  detail: { invoiceId: OWED.id, ...detail },
});
const REMINDER_ENTRIES: LedgerEntry[] = [
  reminderEntry(1201, "2026-10-10T09:00:04Z", "ar_reminder_sent", "agent", { decisionMode: "deepseek", agreedWithReference: true, tone: "friendly", daysFromDue: 0, number: 2, to: "ap***@acme.example" }),
  reminderEntry(1200, "2026-10-07T09:00:05Z", "ar_reminder_sent", "agent", { decisionMode: "deepseek", agreedWithReference: true, tone: "friendly", daysFromDue: -3, number: 1, to: "ap***@acme.example" }),
  reminderEntry(1199, "2026-10-06T08:00:00Z", "ar_reminders_on", "human", { by: "docs-owner", linkId: "docs-link" }),
];

/** A payment code refused over its counterparty's limit, as the console's Stopped section shows it (agent activity R5). */
const STOPPED_INVOICE: InvoiceRow = {
  ...INVOICE,
  id: "00000000-0000-4000-8000-0000000000e5",
  amount: 75,
  memo: "Q4 brand refresh",
  po_reference: "PO-2214",
  goods_received: true,
  status: "held",
  agent_reasoning:
    "Northstar Studio is screened clear, PO-2214 matches and the work was received, and the operating wallet holds 120.00 USDC, so I would pay the 75.00 USDC invoice now.",
  tx_ref: null,
  paid_amount: null,
};

const STOP_ENTRY: LedgerEntry = {
  ...PAYMENT_ENTRY,
  seq: PAYMENT_ENTRY.seq + 2,
  id: "docs-stop",
  ts: "2026-10-03T09:30:00Z",
  action: "ap_pay",
  summary: "PAY invoice from Northstar Studio for 75 USDC",
  detail: {
    invoiceId: STOPPED_INVOICE.id,
    decisionMode: "llm",
    decision: { action: "pay" },
    guardrailBlocked: true,
    guardrailRule: "counterparty.payment_limit",
    observed: { riskLevel: "clear", paymentLimit: 50, poReference: "PO-2214", goodsReceived: true },
  },
};

/** A payable completed by a person and paid by the agent, as its trail tells it (decision trail R2). */
const TRAIL_INVOICE: InvoiceRow = {
  ...INVOICE,
  id: "00000000-0000-4000-8000-0000000000e7",
  memo: "November design retainer",
  po_reference: "PO-2215",
  agent_reasoning: "The three-way match is now complete with PO-2215, and 12.50 USDC is well within Northstar Studio's limit, so I pay it today.",
  tx_ref: `0x${"5c".repeat(32)}`,
};

const trailEntry = (seq: number, ts: string, actor: LedgerEntry["actor"], action: string, detail: Record<string, unknown>): LedgerEntry => ({
  ...PAYMENT_ENTRY,
  seq,
  id: `docs-trail-${seq}`,
  ts,
  actor,
  domain: "ap",
  action,
  summary: action,
  detail: { invoiceId: TRAIL_INVOICE.id, ...detail },
});

/** Newest first, as the ledger reads them. */
const TRAIL_ENTRIES: LedgerEntry[] = [
  trailEntry(15, "2026-10-03T09:14:31Z", "agent", "ap_pay", {
    decisionMode: "deepseek",
    agreedWithReference: true,
    decision: { action: "pay" },
    observed: { riskLevel: "clear", paymentLimit: 50, poReference: "PO-2215", goodsReceived: true, amount: 12.5 },
    onChainLimit: { verdict: { state: "allowed" } },
    execution: { txRef: TRAIL_INVOICE.tx_ref, resultingStatus: "paid" },
  }),
  trailEntry(14, "2026-10-03T09:14:19Z", "agent", "invoice_reopened", {
    followUp: { changes: ["purchase order PO-2215 has since been supplied", "goods have since been confirmed received"] },
  }),
  trailEntry(13, "2026-10-03T09:14:05Z", "human", "invoice_details_added", { added: { poReference: "PO-2215", goodsReceived: true } }),
  trailEntry(12, "2026-10-03T09:00:31Z", "agent", "ap_request_info", {
    decisionMode: "deepseek",
    agreedWithReference: true,
    decision: { action: "request_info" },
    observed: { riskLevel: "clear", paymentLimit: 50, poReference: null, goodsReceived: false, amount: 12.5 },
  }),
  trailEntry(11, "2026-10-03T09:00:12Z", "human", "create_invoice", {}),
];

/** A payable the agent asked about, waiting on Invoices: nothing of its three-way match is on file (complete held invoice). */
const ASKED_INVOICE: InvoiceRow = {
  ...INVOICE,
  id: "00000000-0000-4000-8000-0000000000e4",
  memo: "November design retainer",
  po_reference: null,
  goods_received: false,
  status: "awaiting_info",
  agent_reasoning:
    "Northstar Studio is screened clear and 12.50 USDC is within its 50.00 USDC limit, but no purchase order is on file and the work is not marked received, so the three-way match is incomplete. Please add the purchase order and confirm the work was received before I pay.",
  tx_ref: null,
  paid_amount: null,
};

const ASK_ENTRY: LedgerEntry = {
  ...PAYMENT_ENTRY,
  seq: PAYMENT_ENTRY.seq + 1,
  id: "docs-ask",
  ts: "2026-10-03T09:12:00Z",
  action: "ap_request_info",
  summary: "Asked for information before paying 12.50 USDC to Northstar Studio",
  detail: {
    invoiceId: ASKED_INVOICE.id,
    decisionMode: "llm",
    decision: { action: "request_info" },
    observed: { riskLevel: "clear", paymentLimit: 50, poReference: null, goodsReceived: false },
  },
};

// A milestone whose batch Circle failed, held, as Contractors shows it (held milestone actions R1).
const HELD_MILESTONE: MilestoneRow = {
  id: "00000000-0000-4000-8000-0000000000f1",
  contractor_id: "00000000-0000-4000-8000-0000000000f2",
  contractor_name: "Puka Hotel",
  title: "Clean service",
  amount: 0.3,
  verification_source: null,
  verification_method: "manual",
  verification_status: "verified",
  verification_checked_at: "2026-10-02T06:58:00Z",
  verified_at: "2026-10-02T06:58:00Z",
  verification_detail: { note: "Rooms checked after the clean" },
  verified: true,
  status: "held",
  agent_reasoning:
    "Puka Hotel's cleaning was verified by hand, the contractor is screened clear, and 0.30 USDC is within its 5 USDC limit, so I release it today rather than on Net-30. [transfer failed: provider reported failure]",
  tx_ref: null,
};

const HELD_ENTRY: LedgerEntry = {
  ...PAYMENT_ENTRY,
  seq: PAYMENT_ENTRY.seq + 1,
  id: "docs-held-milestone",
  ts: "2026-10-02T07:00:00Z",
  domain: "contractor",
  action: "milestone_release",
  summary: 'RELEASE milestone "Clean service" for Puka Hotel (0.3 USDC)',
  detail: { milestoneId: HELD_MILESTONE.id, decisionMode: "llm", guardrailBlocked: false, observed: { riskLevel: "clear", paymentLimit: 5 }, execution: { txRef: null, resultingStatus: "held" } },
};

const HELD_REASON = heldReason({
  amount: HELD_MILESTONE.amount,
  agentReasoning: HELD_MILESTONE.agent_reasoning,
  contractor: {
    name: HELD_MILESTONE.contractor_name,
    riskLevel: "clear",
    riskNotes: null,
    paymentLimit: 5,
    baselinePaymentLimit: 5,
    address: `0x${"7ab1e".repeat(8)}`,
    addressChangedAt: null,
    addressConfirmedAt: null,
  },
  intent: { status: "failed", provider_tx_id: "circle-batch", last_error: null, provider_state: "FAILED", failure_reason: "ESTIMATION_ERROR" },
  lastEntry: { action: HELD_ENTRY.action, detail: HELD_ENTRY.detail },
  live: true,
});

const HELD: WaitingPayable = {
  id: "00000000-0000-4000-8000-0000000000e2",
  counterpartyId: "00000000-0000-4000-8000-0000000000d2",
  counterpartyName: "Bluebird Logistics",
  riskLevel: "clear",
  amount: 8,
  dueDate: "2026-10-09",
  status: "held",
  reasoning: "Held 8.00 USDC for Bluebird Logistics: no receipt is recorded for PO-2213, so the three-way match is incomplete.",
  explanation: "Held 8.00 USDC for Bluebird Logistics: no receipt is recorded for PO-2213, so the three-way match is incomplete.",
  decidedAt: "2026-09-30T12:04:00Z",
  createdBy: "docs-sample-admin",
  reviewedAt: null,
  reclaimable: false,
  paymentSent: false,
  address: "0x7a3c9e2b41d05f8a6c1e3b9d2f4a8c6e0b5d1f93",
  lastAttempt: null,
  discount: null,
  currency: "USDC",
  payeeChain: "ARC-TESTNET",
  bridgeFeeUsdc: null,
  poReference: "PO-2213",
  goodsReceived: false,
  addedSinceDecision: null,
  guardrailRule: null,
};

/** A payable the agent asked about because nothing of its three-way match is on file (complete held invoice). */
const AWAITING: WaitingPayable = {
  ...HELD,
  id: "00000000-0000-4000-8000-0000000000e3",
  status: "awaiting_info",
  reasoning: "Asked for more information before paying 8.00 USDC to Bluebird Logistics: no purchase order is on file and no receipt is recorded, so the three-way match is incomplete.",
  explanation: "Asked for more information before paying 8.00 USDC to Bluebird Logistics: no purchase order is on file and no receipt is recorded, so the three-way match is incomplete.",
  poReference: null,
};

function HashChain({ entries }: { entries: LedgerEntry[] }) {
  const head = entries.at(-1)!;
  return (
    <Card asChild className="mb-6 p-4 sm:p-6">
      <section aria-label="Hash chain">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <div>
            <dt>
              <Eyebrow>Entries</Eyebrow>
            </dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums text-ink">{entries.length}</dd>
          </div>
          <div>
            <dt>
              <Eyebrow>Head</Eyebrow>
            </dt>
            <dd className="mt-1.5 font-mono text-[0.8125rem] text-ink">#{pad(head.seq)}</dd>
          </div>
          <div className="col-span-2 min-w-0">
            <dt>
              <Eyebrow>Head hash</Eyebrow>
            </dt>
            <dd className="mt-1 flex items-center gap-1">
              <Hash value={head.hash} className="text-ink-2" />
              <CopyButton value={head.hash} label="Copy the head hash" />
            </dd>
          </div>
        </dl>
        <div className="mt-4 border-t border-line pt-4">
          <VerifyLedgerBadge orgSlug={SLUG} />
        </div>
      </section>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Get paid as a freelancer: a payee's link, at each step

const PAYEE_ADDRESS = `0x${"5a1e".repeat(10)}`;
const PAYEE_WORK = { kind: "milestone", title: "10 social posts for October", amount: 25, currency: "USDC", txRef: null, settledAt: null, scheduledFor: null } as const;
const PAYEE_OPEN: PayeeLinkStatus = {
  orgName: "Northstar Studio",
  payeeName: "Linh Tran",
  chain: "ARC-TESTNET",
  linkState: "open",
  expiresAt: "2026-10-09T09:00:00Z",
  usedAt: null,
  statusUntil: "2026-10-09T09:00:00Z",
  address: null,
  addressConfirmed: false,
  payments: [{ ...PAYEE_WORK, status: "verified" }],
};
const PAYEE_CONFIRMING: PayeeLinkStatus = { ...PAYEE_OPEN, linkState: "used", usedAt: "2026-10-02T09:00:00Z", statusUntil: "2026-11-01T09:00:00Z", address: PAYEE_ADDRESS };
const PAYEE_PAID: PayeeLinkStatus = {
  ...PAYEE_CONFIRMING,
  addressConfirmed: true,
  payments: [{ ...PAYEE_WORK, status: "paid", txRef: `0x${"7e57ab1e".repeat(8)}`, settledAt: "2026-10-02T09:14:00Z" }],
};

/** The payee's page as the link shows it: the card alone, at the page's width, without the site's header. */
function PayeeShot({ status }: { status: PayeeLinkStatus }) {
  return (
    <div className="mx-auto max-w-md">
      <PayeeJourney token={`vxp_${"d0c5".repeat(10)}abc`} status={status} refresh={false} />
    </div>
  );
}


/** A shadow workspace's month of cloud bills, for the report (workspace report design): made up, like the rest. */
const REPORT_OPENED = "2026-10-08T09:00:00Z";
const reportBill = (id: string, name: string, amount: number, over: Partial<ReportBill> = {}): ReportBill => ({
  id: `00000000-0000-4000-8000-0000000003${id}`,
  createdAt: "2026-10-08T09:30:00Z",
  dueDate: "2026-10-20T00:00:00Z",
  amount,
  currency: "USDC",
  status: "paid",
  reviewedBy: null,
  paidAmount: null,
  discount: null,
  bill: { amount, currency: "USD" },
  payee: { id: `cp-${id}`, name, mirror: false, sample: false },
  ...over,
});
const reportDecision = (seq: number, id: string, over: Partial<ReportDecision> = {}): ReportDecision => ({
  seq,
  ts: "2026-10-08T09:31:00Z",
  action: "ap_pay",
  invoiceId: `00000000-0000-4000-8000-0000000003${id}`,
  guardrailBlocked: false,
  guardrailRule: null,
  heldBecause: "shadow_verdict",
  resultingStatus: "held",
  shadow: true,
  reasoning: "The bill matches last month's plan.",
  ...over,
});
const reportPayment = (id: string, amount: number, minute: number) => ({
  invoiceId: `00000000-0000-4000-8000-0000000003${id}`,
  amount,
  token: "USDC",
  txHash: `0x${id.repeat(32)}`,
  at: `2026-10-08T10:${String(minute).padStart(2, "0")}:00Z`,
  simulated: false,
});
const REPORT_FACTS: ReportFacts = {
  network: "arc-testnet",
  sandbox: false,
  now: "2026-10-13T10:00:00Z",
  openedAt: REPORT_OPENED,
  shadow: { currency: "USD", startedAt: REPORT_OPENED },
  bills: [
    reportBill("11", "Northwind Cloud", 46.41),
    reportBill("22", "Harbor VPS", 24, { discount: { pct: 2, deadline: "2026-10-10T00:00:00Z" }, paidAmount: 23.52 }),
    reportBill("33", "Lumen Hosting", 13.5, { payee: { id: "cp-33", name: "Lumen Hosting", mirror: true, sample: false } }),
    reportBill("44", "Atlas Compute", 61.87, { status: "held", bill: null }),
    // Northwind Cloud's second bill: the same supplier as its first, so a shared copy gives both one label.
    reportBill("55", "Northwind Cloud", 46.41, { status: "rejected", bill: null, payee: { id: "cp-11", name: "Northwind Cloud", mirror: false, sample: false } }),
  ],
  decisions: [
    reportDecision(1, "11"),
    reportDecision(2, "22"),
    reportDecision(3, "33"),
    reportDecision(4, "44", { action: "ap_hold", heldBecause: null, guardrailBlocked: true, guardrailRule: "invoice.match_incomplete", ts: "2026-10-08T09:32:00Z" }),
    reportDecision(5, "55", { action: "ap_flag_fraud", heldBecause: null, resultingStatus: "flagged", reasoning: "It repeats Northwind Cloud's bill from two days ago, to the cent.", ts: "2026-10-09T08:02:00Z" }),
  ],
  personActions: [
    { seq: 6, ts: "2026-10-08T10:00:00Z", action: "approval_paid", invoiceId: "00000000-0000-4000-8000-000000000311" },
    { seq: 7, ts: "2026-10-08T10:05:00Z", action: "approval_paid", invoiceId: "00000000-0000-4000-8000-000000000322" },
    { seq: 8, ts: "2026-10-08T10:10:00Z", action: "approval_paid", invoiceId: "00000000-0000-4000-8000-000000000333" },
    { seq: 9, ts: "2026-10-09T08:30:00Z", action: "approval_rejected", invoiceId: "00000000-0000-4000-8000-000000000355" },
  ],
  verdicts: [
    { entrySeq: 1, verdict: "agree" },
    { entrySeq: 2, verdict: "agree" },
    { entrySeq: 3, verdict: "agree" },
    { entrySeq: 5, verdict: "agree" },
  ],
  payments: [reportPayment("11", 46.41, 1), reportPayment("22", 23.52, 6), reportPayment("33", 13.5, 11)],
};
const REPORT = buildReport(REPORT_FACTS);

/** What the same business recorded paying from its bank, for the comparison (actual payments design): made up too. */
const ACTUALS_RECORDER = "00000000-0000-4000-8000-0000000004aa";
const actualRecord = (id: string, over: Partial<ActualRecord>): ActualRecord => ({
  id: `00000000-0000-4000-8000-0000000004${id}`,
  invoiceId: `00000000-0000-4000-8000-0000000003${id}`,
  outcome: "paid",
  paidOn: "2026-10-09",
  amount: null,
  currency: "USD",
  method: "bank_transfer",
  reference: null,
  note: null,
  reason: null,
  replaces: null,
  source: "form",
  recordedBy: ACTUALS_RECORDER,
  recordedAt: "2026-10-12T08:15:00Z",
  ...over,
});
const ACTUALS_FACTS: ActualsFacts = {
  records: [
    actualRecord("11", { amount: 46.41, reference: "SEPA-1108" }),
    actualRecord("22", { paidOn: "2026-10-12", amount: 24, method: "card" }),
    actualRecord("33", { outcome: "not_paid", paidOn: null, amount: null, currency: null, method: null, reason: "Moved to annual billing: this month's bill was cancelled" }),
    actualRecord("44", { paidOn: "2026-10-10", amount: 61.87, reference: "SEPA-1110" }),
  ],
  entries: new Map([
    ["00000000-0000-4000-8000-000000000411", 21],
    ["00000000-0000-4000-8000-000000000422", 22],
    ["00000000-0000-4000-8000-000000000433", 23],
    ["00000000-0000-4000-8000-000000000444", 24],
  ]),
  verdictEntries: new Map([
    [1, 12],
    [2, 13],
    [3, 14],
    [5, 15],
  ]),
};
const ACTUALS = compareActuals(REPORT_FACTS, ACTUALS_FACTS);

/** The owner's answer about how long a bill took before, and the value it gives (shared report design S8, S9). */
const REPORT_OWNER = "owner@harbor-books.example";
const REPORT_BASELINE: BaselineState = {
  available: true,
  answer: { id: "00000000-0000-4000-8000-0000000005b1", minutesPerBill: 25, peoplePerBill: 2, answeredBy: ACTUALS_RECORDER, answeredAt: "2026-10-12T08:30:00Z" },
};

/**
 * The same business's report as its link shows it (shared report design S4, S6): suppliers as labels, amounts shown,
 * its name as the title. The signed links are made up, so a signature check here would not verify: no shot runs one.
 */
const SHARED_KEY_ID = "0123456789abcdef";
const SHARED_VIEW: SharedReportShown = (() => {
  const view = buildSharedReport({
    facts: REPORT_FACTS,
    actuals: { available: true, facts: ACTUALS_FACTS },
    baseline: REPORT_BASELINE,
    options: { names: "labels", amounts: "shown", title: "workspace" },
    name: "Harbor Books",
    sharedAt: "2026-10-12T09:00:00Z",
    knownNames: ["Northwind Cloud", "Harbor VPS", "Lumen Hosting", "Atlas Compute"],
    billTexts: [],
    now: "2026-10-13T10:00:00Z",
  });
  return {
    ...view,
    decisions: view.decisions.map((decision) => ({
      ...decision,
      link: { body_hash: "1".repeat(64), signature: "2".repeat(128), prev_hash: "3".repeat(64), hash: "4".repeat(64), signing_key_id: SHARED_KEY_ID },
    })),
    publicKeys: { [SHARED_KEY_ID]: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n" },
  };
})();

/** The report's live links: one for the accountant with names, one for an outside reviewer with labels and no amounts. */
const REPORT_LINKS: LiveLink[] = [
  { id: "00000000-0000-4000-8000-0000000005e2", shows: "Supplier labels, amounts hidden, a neutral title", by: REPORT_OWNER, createdAt: "2026-10-12T09:20:00Z" },
  { id: "00000000-0000-4000-8000-0000000005e1", shows: "Supplier names, amounts shown, the workspace's name as its title", by: REPORT_OWNER, createdAt: "2026-10-12T09:00:00Z" },
];

/**
 * The same business's bank statement, read and matched (bank statement design B1-B8): a CSV export with the bank's own
 * lines above its header, money out and money in in two columns and a running balance; the bills it is matched against.
 * Every match is `matchStatement`'s own, as the server makes it.
 */
const STATEMENT_TEXT = [
  "Operating account ****4821",
  "Statement period,2026-10-01 to 2026-10-10",
  "Date,Description,Reference,Money out,Money in,Balance",
  '2026-10-01,Opening balance,,,,"2,000.00"',
  '2026-10-02,ACH NORTHWIND CLOUD INV-1101,,46.41,,"1,953.59"',
  '2026-10-05,CUSTOMER PAYMENT HB-204,,,450.00,"2,403.59"',
  '2026-10-08,TRANSFER TO SAVINGS,,500.00,,"1,903.59"',
  '2026-10-09,ACH NORTHWIND CLOUD INV-1108,,46.41,,"1,857.18"',
  '2026-10-09,CARD HARBOR VPS,,24.00,,"1,833.18"',
  '2026-10-09,LUMEN HOSTING,ACH-88215,13.50,,"1,819.68"',
  '2026-10-10,ATLAS COMPUTE AC-5531,ACH-88240,61.25,,"1,758.43"',
  '2026-10-10,CARD PAYMENT,,15.00,,"1,743.43"',
].join("\n");
const STATEMENT_CHOICES: StatementChoices = { currency: "USD" };
const statementBill = (id: string, payee: string, amount: number, over: Partial<StatementBill> = {}): StatementBill => ({
  id: `00000000-0000-4000-8000-0000000005${id}`,
  payee,
  memo: null,
  amount,
  currency: "USD",
  createdAt: "2026-10-08T09:30:00Z",
  dueDate: "2026-10-20",
  current: null,
  ...over,
});
const STATEMENT_BILLS: StatementBill[] = [
  statementBill("11", "Northwind Cloud", 46.41, { memo: "Invoice INV-1108" }),
  statementBill("22", "Harbor VPS", 24),
  statementBill("33", "Lumen Hosting", 13.5, { current: { id: "00000000-0000-4000-8000-000000000633", outcome: "not_paid", paidOn: null, amount: null, currency: null, source: "form" } }),
  statementBill("44", "Atlas Compute", 61.87, { memo: "AC-5531" }),
  statementBill("55", "Kestrel Mail", 15),
  statementBill("66", "Pine Analytics", 15),
];
const STATEMENT_READ = readStatement(STATEMENT_TEXT, STATEMENT_CHOICES, "2026-10-11");
const STATEMENT_LINES = STATEMENT_READ.lines;
// The first line of money out recorded Northwind Cloud's September bill at an earlier import.
const STATEMENT_FOUND = {
  lines: STATEMENT_LINES,
  matches: matchStatement(
    STATEMENT_LINES,
    STATEMENT_BILLS,
    STATEMENT_LINES.map((line) => (line.description.endsWith("INV-1101") ? { invoiceId: "00000000-0000-4000-8000-000000000500", payee: "Northwind Cloud" } : null))
  ),
};

/**
 * A studio's next 60 days for the What if section (cash scenarios guide): a retainer not billed yet, four bills, a
 * verified milestone, and two receivables, the first from a client that has paid before. Northwind Cloud is scheduled
 * for day 5 and due on day 25, after Acme Studio's late receivable arrives, so paying it on its due day shrinks the gap.
 */
const SCENARIO_BASIS: ScenarioBasis = {
  today: "2026-10-12",
  cash: 1840.5,
  reserve: 3200,
  outflows: [
    { id: "m-landing", kind: "milestone", label: "Minh Pham: Landing page", amount: 600, day: 0, note: "verified", foreign: false },
    { id: "rec-linh:2026-10-15", kind: "recurring", label: "Linh Design", amount: 1500, day: 3, note: "recurring, not billed yet", foreign: false },
    { id: "inv-northwind", kind: "bill", label: "Northwind Cloud", amount: 860, day: 5, note: "scheduled", foreign: false, dueDay: 25 },
    { id: "inv-atlas", kind: "bill", label: "Atlas Compute", amount: 1240, day: 8, note: "due", foreign: false },
    { id: "inv-harbor", kind: "bill", label: "Harbor Print", amount: 2150, day: 18, note: "due", foreign: false },
    { id: "inv-kestrel", kind: "bill", label: "Kestrel Legal", amount: 950, day: 27, note: "due", foreign: true },
    { id: "rec-linh:2026-11-15", kind: "recurring", label: "Linh Design", amount: 1500, day: 34, note: "recurring, not billed yet", foreign: false },
  ],
  receivables: [
    { id: "ar-acme", label: "Acme Studio", amount: 3400, day: 9, overdue: false, client: "client-acme" },
    { id: "ar-beacon", label: "Beacon Labs", amount: 1800, day: 16, overdue: false, client: "client-beacon" },
  ],
  clients: { "client-acme": { paidOnTime: 3, paidLate: 2, averageDaysLate: 11 } },
  eurc: [],
  recurringRead: true,
};
/** That studio's scenario as the section opens on it: 60 days, every client 14 days late. */
const SCENARIO = cashScenario(SCENARIO_BASIS, DEFAULT_LEVERS);
/** The open section's card, for a part of its outcome shown alone. */
const SCENARIO_CARD = "rounded-2xl border border-line bg-surface p-5 shadow-surface";

/** One of New ▾'s forms as its sheet opens on Bills & receivables (Bills & receivables tabs B13): its title, its line, the form. */
function NewSheet({ kind, children }: { kind: NewKind; children: ReactNode }) {
  const item = NEW_ITEMS.find((entry) => entry.kind === kind) as (typeof NEW_ITEMS)[number];
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="space-y-1 border-b border-line px-5 py-4">
        <p className="text-base font-semibold tracking-tight text-ink">{item.title}</p>
        <p className="text-sm text-ink-2">{item.description}</p>
      </div>
      <div className="px-5 py-5">{children}</div>
    </div>
  );
}

/** New ▾, Bill to pay: one bill typed in. */
function NewInvoice({ counterparty }: { counterparty: CounterpartyRow }) {
  return (
    <NewSheet kind="bill">
      <InvoiceIntake orgSlug={SLUG} counterparties={[{ id: counterparty.id, name: counterparty.name, role: counterparty.role }]} initialDirection="payable" />
    </NewSheet>
  );
}

/**
 * A bill's row as Bills & receivables lists it (Bills & receivables tabs B6), built as the page builds it, and under it
 * the card its detail panel opens on.
 */
function BillRowShot({
  invoice,
  decision,
  today,
  footer,
  waiting,
  rule = null,
  owedNote = null,
}: {
  invoice: InvoiceRow;
  decision: Decision;
  today: string;
  footer?: ReactNode;
  waiting?: { onFile: { poReference: string | null; goodsReceived: boolean }; added: null };
  rule?: string | null;
  owedNote?: string | null;
}) {
  const inAWeek = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const item = billRowItem({
    invoice,
    decision,
    row: listRowOf(invoice, decision),
    today,
    inAWeek,
    waiting,
    rule,
    canWrite: true,
    canDecide: true,
    owedNote,
    href: orgHref(SLUG, `/invoices?open=${invoice.id}`),
  });
  return (
    <div className="space-y-4">
      <BillRows label={invoice.direction === "payable" ? "Bills" : "Receivables"} rows={[item]} slugHref={(path) => orgHref(SLUG, path)} />
      <div className="rounded-2xl border border-line bg-surface p-3 sm:p-4">
        <DecisionCard decision={decision} orgSlug={SLUG} footerAction={footer} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Quickstart (docs clarity Q2): a new workspace in shadow mode, its first supplier and bill, and the decision

/** The quickstart's example supplier: no address yet, which a sandbox does not need, and no purchase orders. */
const NORTHWIND: CounterpartyRow = {
  ...COUNTERPARTY,
  id: "00000000-0000-4000-8000-0000000000d9",
  name: "Northwind Hosting",
  address: null,
  jurisdiction: null,
  payment_limit: 500,
  baseline_payment_limit: 500,
  purchase_order_required: false,
};

/** Its first bill, decided: the agent would pay it, and in shadow mode it waits for a person's verdict. */
const FIRST_BILL: InvoiceRow = {
  ...INVOICE,
  id: "00000000-0000-4000-8000-0000000000e7",
  counterparty_id: NORTHWIND.id,
  counterparty_name: NORTHWIND.name,
  amount: 120,
  memo: "Servers, October",
  po_reference: null,
  due_date: "2026-10-15",
  status: "held",
  agent_reasoning:
    "Pay 120.00 USDC to Northwind Hosting: the October servers were received, Northwind Hosting sends no purchase orders and screened clear with a 500.00 USDC limit, and the bill is due on Oct 15. In shadow mode it waits for your verdict.",
  tx_ref: null,
  paid_amount: null,
};

const FIRST_DECISION: LedgerEntry = {
  ...PAYMENT_ENTRY,
  id: "docs-first-decision",
  actor: "agent",
  action: "ap_pay",
  summary: "Decided to pay 120.00 USDC to Northwind Hosting",
  detail: { invoiceId: FIRST_BILL.id, decisionMode: "llm", observed: { riskLevel: "clear", paymentLimit: 500 }, execution: { heldBecause: "shadow_verdict" } },
};

/** A sandbox in shadow mode since before the decision, seen by an owner who may give a verdict. */
const SHADOW_SANDBOX = { shadow: { startedAt: "2026-09-30T11:00:00Z", currency: "USDC" }, given: new Map(), canGive: true, simulated: true };

// ---------------------------------------------------------------------------
// Where a payment is

/** When the settlement shots are read: their ages count to it. */
const SHOT_NOW = Date.parse("2026-10-11T10:40:00.000Z");
const SHOT_TX = `0x${"5e771e".repeat(10)}abcd`;
const shotAt = (minute: number) => `2026-10-11T10:${String(minute).padStart(2, "0")}:00.000Z`;

/**
 * A payment the agent made: sent, pending, confirmed on Arc testnet, and marked paid with its transaction. Its ap_pay
 * entry is signed as it really is, once Circle's first answer is back, after the send: the track shows it by the send.
 */
const SHOT_SETTLEMENT = reduceSettlement({
  facts: [
    { kind: "proposed", at: "2026-10-11T10:01:30.000Z", by: "agent", seq: 1182 },
    { kind: "authorized", at: "2026-10-11T10:01:30.000Z", by: "code", seq: 1182 },
    { kind: "submitted", at: shotAt(1), attempt: 1 },
    { kind: "pending", at: shotAt(1), attempt: 1, state: "SENT", by: "circle" },
    { kind: "confirmed", at: shotAt(2), attempt: 1, refs: [SHOT_TX], txHash: SHOT_TX },
    { kind: "recorded", at: shotAt(3), seq: 1190, txRef: SHOT_TX },
  ],
  books: { paid: true, txRef: SHOT_TX, at: shotAt(3) },
  crossChain: false,
  simulated: false,
});

/** Each a payable the agent paid and its cycle comes back to (`matched`): it checks an unknown send and marks a confirmed one paid. */
const flight = (id: string, name: string, amount: number, facts: SettlementFact[], books: SettlementBooks = { paid: false, txRef: null, at: null, followUp: "cycle" }): FlightRow => ({
  source: { type: "invoice", id },
  name,
  amount,
  currency: "USDC",
  settlement: reduceSettlement({ facts, books, crossChain: false, simulated: false }),
});

/** Treasury's payments in flight: one Circle shows stuck past the wait, one whose send Circle never answered, one just sent, and one confirmed the books have not caught up with. */
const SHOT_FLIGHT: FlightRow[] = [
  flight("docs-flight-1", "Northwind Hosting", 120, [
    { kind: "submitted", at: shotAt(2), attempt: 1 },
    { kind: "pending", at: shotAt(20), attempt: 1, state: "STUCK", by: "watch" },
  ]),
  flight("docs-flight-2", "Harbor Office Supply", 480, [
    { kind: "submitted", at: shotAt(28), attempt: 1 },
    { kind: "unanswered", at: shotAt(28), attempt: 1 },
  ]),
  flight("docs-flight-3", "Lumen Design Co.", 75.5, [
    { kind: "submitted", at: shotAt(37), attempt: 1 },
    { kind: "pending", at: shotAt(37), attempt: 1, state: "QUEUED", by: "circle" },
  ]),
  flight("docs-flight-4", "Atlas Cloud", 42, [
    { kind: "submitted", at: shotAt(30), attempt: 1 },
    { kind: "confirmed", at: shotAt(33), attempt: 1, refs: [SHOT_TX], txHash: SHOT_TX },
  ]),
];

export const DOCS_SHOTS = {
  "try-it-workspace": {
    guide: "try-it",
    render: function WorkspaceShot() {
      // As the workspaces page shows it to someone with none yet, coming from the landing page's call to action.
      return (
        <div className="mx-auto max-w-[34rem]">
          <h1 className="text-[1.75rem] font-semibold tracking-[-0.025em] text-ink">Welcome to Vestiarion</h1>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-2">
            Create your first workspace, then add one of your bills and see what the agent decides. A teammate can also invite you to theirs.
          </p>
          <div className="mt-6">
            <CreateWorkspaceForm mainnetOffered shadowChosen />
          </div>
        </div>
      );
    },
  },
  "try-it-checklist": {
    guide: "try-it",
    page: "treasury",
    render: function ShadowChecklistShot() {
      const checklist = gettingStarted({
        mode: "sandbox",
        accounts: [],
        counterparties: [],
        payableCount: 0,
        onchainPayments: 0,
        waitingCount: 0,
        network: "arc-testnet",
        shadow: { currency: "USDC", verdictsGiven: 0, billCount: 0 },
      });
      return <GettingStarted slug={SLUG} checklist={checklist} isOwner />;
    },
  },
  "try-it-supplier": {
    guide: "try-it",
    page: "counterparties",
    render: function SupplierShot() {
      return (
        <IntakeFold label="Add counterparty" meta="human-entered · screened on submission" defaultOpen className="">
          <CounterpartyIntake orgSlug={SLUG} framed={false} network="arc-testnet" askPurchaseOrders />
        </IntakeFold>
      );
    },
  },
  "try-it-bill": {
    guide: "try-it",
    page: "invoices",
    render: function BillShot() {
      return <NewInvoice counterparty={NORTHWIND} />;
    },
  },
  "try-it-verdict": {
    guide: "try-it",
    page: "invoices",
    render: function VerdictShot() {
      const decision = invoiceDecision(FIRST_BILL, NORTHWIND, [...EARLIER, FIRST_DECISION], { network: "arc-testnet", verdicts: SHADOW_SANDBOX });
      return <BillRowShot invoice={FIRST_BILL} decision={decision} today="2026-10-12" footer={decision.verdict ? <VerdictControl orgSlug={SLUG} view={decision.verdict} /> : null} />;
    },
  },
  "go-live-checklist": {
    guide: "go-live",
    page: "treasury",
    render: function ChecklistShot() {
      const checklist = gettingStarted({
        mode: "sandbox",
        accounts: [{ kind: "operating", circle_wallet_id: "docs-sample-wallet", balance: 0 }],
        counterparties: [],
        payableCount: 0,
        onchainPayments: 0,
        waitingCount: 0,
        network: "arc-testnet",
      });
      return <GettingStarted slug={SLUG} checklist={checklist} isOwner />;
    },
  },
  "go-live-choose": { guide: "go-live", page: "settings", render: goLive(CHOOSING) },
  "go-live-own-account": { guide: "go-live", page: "settings", render: goLive(CHOOSING) },
  "go-live-create-wallets": { guide: "go-live", page: "settings", render: goLive({ ...CHOOSING, step: "wallets", host: "hosted" }) },
  "go-live-fund": { guide: "go-live", page: "settings", render: goLive({ ...CHOOSING, step: "go_live", host: "hosted", wallets: WALLETS }, FAUCET_BALANCE) },
  "go-live-confirm": { guide: "go-live", page: "settings", render: goLive({ ...CHOOSING, step: "go_live", host: "hosted", wallets: WALLETS }, FAUCET_BALANCE) },
  "go-live-own-wallet": { guide: "go-live", page: "settings", render: goLive(OWN_WALLET_CHOOSING) },
  "go-live-wallet-deploy": { guide: "go-live", page: "settings", render: goLive(OWN_WALLET_DEPLOY) },
  "go-live-wallet-ready": { guide: "go-live", page: "settings", render: goLive(OWN_WALLET_READY) },
  "go-live-passkey-choice": { guide: "go-live", page: "settings", render: goLive(OWN_WALLET_CHOOSING) },
  "go-live-passkey-fund": { guide: "go-live", page: "settings", render: goLive(PASSKEY_FUND) },
  // The same step with Add USDC from another chain opened by the script, the chain and the amount filled.
  "go-live-add-usdc": { guide: "go-live", page: "settings", render: goLive(PASSKEY_FUND) },
  "go-live-passkey-setup": { guide: "go-live", page: "settings", render: goLive(PASSKEY_SETUP) },
  "go-live-passkey-recovery": { guide: "go-live", page: "settings", render: goLive(PASSKEY_RECOVERY) },
  // A computer with no passkey of its own: the script tells the page so, and the phone handoff opens by itself.
  "go-live-passkey-phone": { guide: "go-live", page: "settings", render: goLive(PASSKEY_GAS) },
  "go-live-wallet-controls": { guide: "go-live", page: "settings", render: goLive(PASSKEY_LIVE) },
  "go-live-live": {
    guide: "go-live",
    page: "settings",
    render: goLive({ ...CHOOSING, step: "live", host: "hosted", wallets: WALLETS, liveSince: "2026-09-30T09:12:00Z" }),
  },
  "go-live-usyc": {
    guide: "go-live",
    page: "settings",
    render: () => (
      <UsycReservePanel
        orgSlug={SLUG}
        status={{ liveAt: "2026-10-02T14:05:00Z", mode: "live", operatingAddress: OPERATING_ADDRESS, reserveAddress: RESERVE_ADDRESS, reserveBalance: 60.69 }}
        canManage
      />
    ),
  },
  "first-payment-counterparty": {
    guide: "first-payment",
    page: "counterparties",
    render: function CounterpartyShot() {
      return (
        <IntakeFold label="Add counterparty" meta="human-entered · screened on submission" defaultOpen className="">
          <CounterpartyIntake orgSlug={SLUG} framed={false} network="arc-testnet" />
        </IntakeFold>
      );
    },
  },
  "first-payment-address": {
    guide: "first-payment",
    page: "counterparties",
    render: function AddressShot() {
      return (
        <section>
          <SectionHeader title="Counterparty book" meta="1 record · what needs someone first · open one for the rest" />
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              <li>
                <CounterpartyRowView network="arc-testnet" counterparty={{ ...COUNTERPARTY, address_changed_at: "2026-09-30T12:20:00Z", address_confirmed_at: null }} defaultOpen>
                  {/* As the page shows it above the address: the limits, where it is, when it was screened. */}
                  <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-3 text-xs sm:grid-cols-4">
                    <div><dt className="text-ink-3">Configured limit</dt><dd className="mt-0.5 text-ink">50.00 USDC</dd></div>
                    <div><dt className="text-ink-3">Allowed now</dt><dd className="mt-0.5 text-ink">50.00 USDC</dd></div>
                    <div><dt className="text-ink-3">Jurisdiction</dt><dd className="mt-0.5 text-ink">US</dd></div>
                    <div><dt className="text-ink-3">Last screened</dt><dd className="mt-0.5 text-ink">9/30/2026, 12:00:00 PM</dd></div>
                  </dl>
                  <CounterpartyAddress
                    orgSlug={SLUG}
                    counterparty={{ id: COUNTERPARTY.id, name: COUNTERPARTY.name, address: COUNTERPARTY.address }}
                    unconfirmedSince="2026-09-30T12:20:00Z"
                    canWrite
                    canConfirm
                  />
                </CounterpartyRowView>
              </li>
            </ul>
          </Card>
        </section>
      );
    },
  },
  "first-payment-invoice": {
    guide: "first-payment",
    page: "invoices",
    render: function InvoiceShot() {
      return <NewInvoice counterparty={COUNTERPARTY} />;
    },
  },
  "first-payment-document": {
    guide: "first-payment",
    page: "invoices",
    render: function DocumentShot() {
      const asked = `0x${"5af3107a".repeat(5)}`;
      return (
        <NewSheet kind="document">
            <DocumentDraft
              orgSlug={SLUG}
              counterparties={[{ id: COUNTERPARTY.id, name: COUNTERPARTY.name, role: COUNTERPARTY.role }]}
              result={{
                ok: true,
                message: `Read the invoice from ${COUNTERPARTY.name}. Check every field before adding it.`,
                draft: {
                  vendorName: COUNTERPARTY.name,
                  invoiceNumber: "NS-2207",
                  amount: "12.50",
                  currency: "USDC",
                  dueDate: "2026-10-15",
                  poReference: "PO-2207",
                  earlyPayDiscountPct: null,
                  discountDeadline: null,
                  payToAddress: asked,
                  memo: "October design retainer",
                  counterpartyId: COUNTERPARTY.id,
                },
                warnings: [
                  `This invoice asks to be paid to ${asked}. The address on file for ${COUNTERPARTY.name} is ${COUNTERPARTY.address}. The agent pays the address on file; confirm a change with the vendor before making it.`,
                ],
                notFound: [],
                modelNote: null,
                reader: "deepseek",
                document: { kind: "pdf", sha256: "0".repeat(64), truncated: false },
                nonce: 1,
              }}
            />
        </NewSheet>
      );
    },
  },
  "first-payment-decision": {
    guide: "first-payment",
    page: "invoices",
    render: function DecisionShot() {
      return <BillRowShot invoice={INVOICE} decision={invoiceDecision(INVOICE, COUNTERPARTY, ENTRIES, { network: "arc-testnet" })} today="2026-10-12" />;
    },
  },
  "first-payment-trail": {
    guide: "first-payment",
    page: "invoices",
    render: function TrailShot() {
      // How the agent decided, opened, as a payable's card shows it: the trail alone, each check on its own line.
      const decision = invoiceDecision(TRAIL_INVOICE, COUNTERPARTY, TRAIL_ENTRIES, { network: "arc-testnet" });
      return (
        <Card className="overflow-hidden">
          <DecisionTrail id={decision.id} steps={decision.trail ?? []} orgSlug={SLUG} network="arc-testnet" defaultOpen chainHref={orgHref(SLUG, evidencePath("invoice", decision.id))} />
        </Card>
      );
    },
  },
  "first-payment-reminders": {
    guide: "first-payment",
    page: "invoices",
    render: () => (
      <BillRowShot
        invoice={OWED}
        decision={invoiceDecision(OWED, undefined, REMINDER_ENTRIES, { network: "arc-testnet" })}
        today="2026-10-10"
        footer={
          <PayLinkControl
            network="arc-testnet"
            orgSlug={SLUG}
            invoiceId={OWED.id}
            dueDate={OWED.due_date}
            client={{ id: OWED.counterparty_id, name: OWED.counterparty_name, hasEmail: true }}
            view={{
              url: `https://www.vestiarion.xyz/pay/vxr_${"d0c5".repeat(10)}abc`,
              legacy: false,
              remindersOnAt: "2026-10-06T08:00:00Z",
              deferredUntil: null,
              sent: [
                { number: 1, tone: "friendly", sentAt: "2026-10-07T09:00:05Z" },
                { number: 2, tone: "friendly", sentAt: "2026-10-10T09:00:04Z" },
              ],
            }}
          />
        }
      />
    ),
  },
  "first-payment-needs-you": {
    guide: "first-payment",
    page: "invoices",
    render: function NeedsYouShot() {
      const onFile = { poReference: null, goodsReceived: false };
      const decision = invoiceDecision(ASKED_INVOICE, COUNTERPARTY, [ASK_ENTRY], { network: "arc-testnet" });
      return (
        <BillRowShot
          invoice={ASKED_INVOICE}
          decision={decision}
          today="2026-10-03"
          waiting={{ onFile, added: null }}
          footer={
            <WaitingPayableAction
              orgSlug={SLUG}
              invoice={{ id: ASKED_INVOICE.id, counterpartyName: ASKED_INVOICE.counterparty_name, ...onFile }}
              added={null}
              canAddDetails
              canDecide
            />
          }
        />
      );
    },
  },
  "first-payment-stopped": {
    guide: "first-payment",
    page: "treasury",
    render: function StoppedShot() {
      return (
        <section>
          <SectionHeader title="Stopped" meta="refused by code, or waiting for you" />
          <DecisionCard
            decision={invoiceDecision(STOPPED_INVOICE, COUNTERPARTY, [STOP_ENTRY], { network: "arc-testnet" })}
            orgSlug={SLUG}
            footerAction={
              <WaitingPayableAction
                orgSlug={SLUG}
                invoice={{ id: STOPPED_INVOICE.id, counterpartyName: STOPPED_INVOICE.counterparty_name, counterpartyId: COUNTERPARTY.id, poReference: "PO-2214", goodsReceived: true }}
                added={null}
                canAddDetails
                canDecide
                rule="counterparty.payment_limit"
                canFix
              />
            }
          />
        </section>
      );
    },
  },
  "first-payment-approval": {
    guide: "first-payment",
    page: "approvals",
    sub: "Payables the agent would not pay on its own, oldest due date first. Pay one now, reject it, or return it to the agent's next cycle.",
    render: function ApprovalShot() {
      return <ApprovalCard orgSlug={SLUG} payable={HELD} canDecide viewerId="docs-sample-owner" sandbox={false} />;
    },
  },
  "first-payment-approval-own": {
    guide: "first-payment",
    page: "approvals",
    sub: "Payables the agent would not pay on its own, oldest due date first. Pay one now, reject it, or return it to the agent's next cycle.",
    render: function OwnApprovalShot() {
      // The workspace's only approver, looking at a payable they entered themselves (sole approver R5).
      return (
        <ApprovalCard orgSlug={SLUG} payable={{ ...HELD, createdBy: "docs-sample-owner" }} canDecide canEdit viewerId="docs-sample-owner" sandbox={false} soleApprover />
      );
    },
  },
  "first-payment-approval-yours": {
    guide: "first-payment",
    page: "approvals",
    sub: "Payables the agent would not pay on its own, oldest due date first. Pay one now, reject it, or return it to the agent's next cycle.",
    render: function YoursShot() {
      // The person who entered it, in a workspace with other approvers, on a payable the spending limit held (approval guidance).
      const payable: WaitingPayable = {
        ...HELD,
        id: "00000000-0000-4000-8000-0000000000e6",
        createdBy: "docs-sample-owner",
        amount: 3,
        poReference: "PO-2213",
        goodsReceived: true,
        reasoning: "Held for a person to approve: paying 3.00 USDC would take the agent past its 5.00 USDC daily spending limit; 3.60 USDC already paid today, 1.40 USDC left.",
        explanation: "Held for a person to approve: paying 3.00 USDC would take the agent past its 5.00 USDC daily spending limit; 3.60 USDC already paid today, 1.40 USDC left.",
        guardrailRule: "workspace.outflow_budget",
      };
      return <ApprovalCard orgSlug={SLUG} payable={payable} canDecide canEdit viewerId="docs-sample-owner" sandbox={false} />;
    },
  },
  "first-payment-add-details": {
    guide: "first-payment",
    page: "approvals",
    sub: "Payables the agent would not pay on its own, oldest due date first. Pay one now, reject it, or return it to the agent's next cycle.",
    render: function AddDetailsShot() {
      // An owner adding what the agent asked for (complete held invoice R1, R2): the script opens the dialog and fills it.
      return <ApprovalCard orgSlug={SLUG} payable={AWAITING} canDecide canEdit viewerId="docs-sample-owner" sandbox={false} />;
    },
  },
  "first-payment-onchain-limit": {
    guide: "first-payment",
    page: "treasury",
    render: function OnChainLimitShot() {
      // The spending limit enforced on Arc (onchain spending limit §4): sample addresses, the contract's own count.
      return (
        <div className="mx-auto max-w-sm">
          <AgentBudgetPanel network="arc-testnet"
            orgSlug={SLUG}
            canEdit
            live
            view={{ dailyUsdc: 5, weeklyUsdc: 20, spentToday: 1.2, spentThisWeek: 3.7, remaining: 3.8 }}
            onChain={{
              state: "enforced",
              contract: "0x5e11a1700d0c5000000000000000000000001111",
              agent: "0xa9e700d0c5000000000000000000000000000a9e",
              reading: { dailyUsdc: 5, weeklyUsdc: 20, spentToday: 1.2, spentThisWeek: 3.7 },
            }}
          />
        </div>
      );
    },
  },
  "first-payment-audit": {
    guide: "first-payment",
    page: "audit",
    sub: "Every decision is appended here, hash-linked to the one before it and signed with Ed25519. The summary stays readable; raw detail and cryptographic material remain inspectable.",
    verification: { valid: true, checkedEntries: ENTRIES.length },
    render: function AuditShot() {
      return (
        <>
          <HashChain entries={ENTRIES} />
          <AuditLedger entries={ENTRIES} />
        </>
      );
    },
  },
  "pay-freelancer": {
    guide: "pay-a-contractor",
    page: "contractors",
    render: function PayFreelancerShot() {
      return (
        <section>
          <IntakeFold label="New payment" meta="pay a freelancer in one step, or add a milestone for a contractor on file" defaultOpen className="">
            <Tabs defaultValue="freelancer">
              <TabsList aria-label="New payment">
                <TabsTrigger value="freelancer">
                  <UserPlus aria-hidden />
                  Pay a freelancer
                </TabsTrigger>
                <TabsTrigger value="milestone">
                  <ListChecks aria-hidden />
                  Milestone intake
                </TabsTrigger>
              </TabsList>
              <TabsContent value="freelancer">
                <p className="mb-4 text-[0.8125rem] text-ink-3">One form: they get a link, you confirm their address, the agent pays.</p>
                <PayFreelancerForm orgSlug={SLUG} live />
              </TabsContent>
            </Tabs>
          </IntakeFold>
          <div className="mt-4">
            <PaymentLinkReady
              message="Emailed Linh Tran a link to add the address to be paid at. When they add their address you get an email; confirm it on Counterparties and the agent pays within a minute."
              url={`https://www.vestiarion.xyz/payee/vxp_${"d0c5".repeat(10)}abc`}
              expiresAt="2026-10-08T15:00:00Z"
            />
          </div>
        </section>
      );
    },
  },
  "held-milestone": {
    guide: "pay-a-contractor",
    page: "contractors",
    render: () => (
      <section>
        <SectionHeader title="Milestones" meta="1 · open one for the agent's reasoning, its verification and its escrow" />
        <RowGroupHeading title="Needs you" count={1} />
        <DecisionRows
          orgSlug={SLUG}
          items={[
            {
              decision: milestoneDecision(HELD_MILESTONE, [HELD_ENTRY], { network: "arc-testnet" }),
              date: { label: "Held Oct 2, 2026", tone: "held" },
              hint: HELD_REASON.hint,
              before: (
                <HeldMilestoneActions
                  orgSlug={SLUG}
                  milestone={{ id: HELD_MILESTONE.id, title: HELD_MILESTONE.title, amount: HELD_MILESTONE.amount, contractorName: HELD_MILESTONE.contractor_name }}
                  reason={HELD_REASON}
                  canDecide
                  selfAdded={false}
                  sandbox={false}
                />
              ),
              open: true,
            },
          ]}
        />
      </section>
    ),
  },
  "get-paid-address": { guide: "get-paid", render: () => <PayeeShot status={PAYEE_OPEN} /> },
  "get-paid-check": { guide: "get-paid", render: () => <PayeeShot status={PAYEE_OPEN} /> },
  "get-paid-confirming": { guide: "get-paid", render: () => <PayeeShot status={PAYEE_CONFIRMING} /> },
  "get-paid-paid": { guide: "get-paid", render: () => <PayeeShot status={PAYEE_PAID} /> },
  "telegram-connect": {
    guide: "telegram",
    page: "settings",
    sub: SETTINGS_SUB,
    render: () => <NotificationsPanel orgSlug={SLUG} canDecide notifyEmail telegram={{ link: null }} />,
  },
  "slack-settings": {
    guide: "slack",
    page: "settings",
    sub: SETTINGS_SUB,
    render: () => (
      <SlackPanel
        orgSlug={SLUG}
        view={{ installed: true, teamName: "Acme HQ", channelName: "#finance", installedAt: "2026-10-03T09:00:00Z", decisionsLimitUsdc: 5, youConnected: true, canReadFiles: true }}
        canManage
        canAdminister
        notice={null}
      />
    ),
  },
  "email-inbox-settings": {
    guide: "email-invoices",
    page: "settings",
    sub: SETTINGS_SUB,
    render: () => <EmailInboxPanel orgSlug={SLUG} view={{ on: true, address: "invoices-k3mq2x7abdef@inbound.vestiarion.xyz" }} canManage />,
  },
  "email-inbox-ap": {
    guide: "email-invoices",
    page: "invoices",
    sub: "Your bills, what the agent decided on each, and why.",
    render: () => (
      <InboxEmails
        orgSlug={SLUG}
        canAdd
        counterparties={[{ id: COUNTERPARTY.id, name: COUNTERPARTY.name, role: COUNTERPARTY.role }]}
        emails={[
          {
            id: "00000000-0000-4000-8000-0000000000e1",
            from: "Northwind Billing <billing@northwind.example>",
            subject: "Invoice INV-2207",
            receivedAt: "2026-10-03T16:00:00Z",
            status: "ready",
            reasons: [],
            authentication: { spf: "pass", dkim: "pass", dmarc: "pass" },
            read: {
              counterpartyName: "Northwind Hosting", vendorName: "Northwind Hosting", amount: "200.00", currency: "USDC", dueDate: "2026-10-31",
              poReference: "PO-1042", invoiceNumber: "INV-2207", memo: null, warnings: [], modelNote: null, reader: "deepseek", knownSender: true,
            },
          },
        ]}
      />
    ),
  },
  "report-shadow": {
    guide: "report",
    page: "report",
    sub: "What the agent did with this workspace's bills since it opened: what it paid and with what proof, what it stopped and why, and how often a person stepped in.",
    render: () => <ReportSummary report={REPORT} />,
  },
  "report-readiness": { guide: "report", render: () => <ReportReadiness steps={REPORT.readiness ?? []} /> },
  "report-lists": { guide: "report", render: () => <ReportLists slug={SLUG} report={REPORT} /> },
  "try-a-rule-result": {
    guide: "try-a-rule",
    page: "counterparties",
    render: function TryARuleShot() {
      // Edit limit's dialog once Try it on past decisions answered, laid flat: the sample data's Harbor Office Supply,
      // its 500 USDC limit tried at 1,500 USDC over the last 30 days (src/app/design/replay-fixture.ts).
      return (
        <Card className="mx-auto grid max-w-lg gap-5 p-6">
          <div>
            <h2 className="text-lg font-semibold tracking-[-0.01em] text-ink">Harbor Office Supply&apos;s payment limit</h2>
            <p className="mt-1 text-sm text-ink-2">
              The most the agent pays this counterparty in one payment on its own. Anything above it waits for a person to approve. Screening can lower it for risk.
            </p>
          </div>
          <Field id="shot-limit" label="Payment limit (USDC)" description="A vendor or contractor always has a limit.">
            <Input name="paymentLimit" inputMode="decimal" defaultValue="1500" readOnly />
          </Field>
          <RuleTrialPanel orgSlug={SLUG} days={30} view={designRuleReplay("1500")} />
          <div className="flex justify-end gap-3">
            <Button variant="secondary">Cancel</Button>
            <Button>{RULE_TRIAL_COPY.apply}</Button>
          </div>
        </Card>
      );
    },
  },
  "report-actuals": {
    guide: "report",
    render: () => (
      <>
        <SectionHeader title="Agent vs what really happened" />
        <ActualsSummary comparison={ACTUALS} />
      </>
    ),
  },
  "report-actuals-bills": {
    guide: "report",
    render: () => (
      <ActualsBills
        slug={SLUG}
        comparison={ACTUALS}
        // A bill held but paid by the business, and one nobody has recorded yet.
        rows={ACTUALS.rows.filter((row) => row.flags.includes("held_but_paid") || row.actual === null)}
        canRecord
        members={{ [ACTUALS_RECORDER]: "ops@harbor-books.example" }}
      />
    ),
  },
  "report-value": {
    guide: "report",
    render: () => (
      <ReportValue
        value={reportValue(REPORT, REPORT_BASELINE, paidOutside({ available: true, facts: ACTUALS_FACTS }))}
        audience="member"
        answeredBy={REPORT_OWNER}
        answer={<ReportBaselineControl orgSlug={SLUG} current={{ minutesPerBill: 25, peoplePerBill: 2 }} />}
      />
    ),
  },
  // The report with Share this report opened by the script, as an owner or admin sees it.
  "report-share": {
    guide: "report",
    page: "report",
    sub: "What the agent did with this workspace's bills since it opened: what it paid and with what proof, what it stopped and why, and how often a person stepped in.",
    render: () => (
      // Room under the button for the dialog, which opens over the frame: the page behind it is dimmed anyway.
      <div className="flex min-h-176 items-start justify-end">
        <ReportShareButton orgSlug={SLUG} available />
      </div>
    ),
  },
  "report-links": { guide: "report", render: () => <ReportShareLinks orgSlug={SLUG} live={REPORT_LINKS} stopped={1} canStop /> },
  // Where the link opens, with no session: the title, the period, live, and the figures.
  "report-shared": {
    guide: "report",
    render: () => (
      <div className="space-y-10">
        <SharedReportHead view={SHARED_VIEW} />
        <SharedReportFigures view={SHARED_VIEW} />
      </div>
    ),
  },
  "report-shared-decisions": { guide: "report", render: () => <SharedDecisions view={SHARED_VIEW} /> },
  "report-bank-statement": {
    guide: "report",
    render: () => <StatementReadPanel name="statement-october.csv" read={STATEMENT_READ} choices={STATEMENT_CHOICES} />,
  },
  "report-bank-statement-matches": { guide: "report", render: () => <StatementMatches found={STATEMENT_FOUND} /> },
  "cash-scenarios": {
    guide: "cash-scenarios",
    page: "treasury",
    render: () => <CashScenarios basis={SCENARIO_BASIS} defaultOpen outcome={false} />,
  },
  "cash-scenarios-cases": {
    guide: "cash-scenarios",
    page: "treasury",
    render: () => (
      <div className={SCENARIO_CARD}>
        <ScenarioCases result={SCENARIO} />
      </div>
    ),
  },
  "cash-scenarios-findings": {
    guide: "cash-scenarios",
    page: "treasury",
    render: () => (
      <div className={SCENARIO_CARD}>
        <ScenarioFindings result={SCENARIO} />
      </div>
    ),
  },
  "cash-scenarios-coverage": {
    guide: "cash-scenarios",
    page: "treasury",
    render: () => (
      <div className={SCENARIO_CARD}>
        <CoverageList result={SCENARIO} />
      </div>
    ),
  },
  "import-bills-columns": { guide: "import-bills", page: "invoices", render: () => <BillImportShot step="columns" /> },
  "import-bills-check": { guide: "import-bills", page: "invoices", render: () => <BillImportShot step="check" /> },
  "payment-plan": {
    guide: "payment-plan",
    page: "invoices",
    render: function PaymentPlanShot() {
      // The top of the section that heads Bills & receivables, as an approver who entered none of its bills sees it,
      // down to the two days the plan would move.
      const plan = planPart(paymentPlanShot(), ["Harbor Office Supply", "Northwind Hosting"]);
      return <PaymentPlanSection plan={plan} outcomes={null} orgSlug={SLUG} canDecide viewerId={PAYMENT_PLAN_VIEWER} />;
    },
  },
  "payment-plan-cash": {
    guide: "payment-plan",
    render: () => (
      // The foot of the same section: the cash effect day by day, and the last 30 days.
      <Card className="overflow-hidden">
        <PlanCashEffect plan={paymentPlanShot()} />
        <PlanOutcomesStrip outcomes={PAYMENT_PLAN_OUTCOMES} />
      </Card>
    ),
  },
  "payment-plan-stale": {
    guide: "payment-plan",
    page: "invoices",
    render: function PaymentPlanStaleShot() {
      // The same plan with the balance read 40 minutes before: on screen, with approving off until it is read again.
      const plan = planPart(paymentPlanShot({ stale: true }), ["Harbor Office Supply"]);
      return <PaymentPlanSection plan={plan} outcomes={null} orgSlug={SLUG} canDecide viewerId={PAYMENT_PLAN_VIEWER} />;
    },
  },
  "workspace-status": {
    guide: "workspace",
    render: function WorkspaceStatusShot() {
      // A live workspace on Arc testnet in shadow mode, as its header says it and the panel its chips open.
      const platform: PlatformStatus = { network: "arc-testnet", mode: "live", mainnetEnabled: true, paymentsOff: null, pause: null };
      const page: PageStatus = { chain: { mode: "live", earnMode: "simulate", held: false }, shadow: true, screening: { live: true, source: "OpenSanctions" }, clock: { mode: "real", day: 1 } };
      return (
        <div className="flex flex-col items-start gap-2">
          <div className="flex flex-wrap gap-1.5">
            <StatusChipRow chips={statusChips(platform, page)} />
          </div>
          <Card className="w-[22rem] overflow-hidden">
            <StatusPanel rows={statusRows(platform, page)} />
          </Card>
        </div>
      );
    },
  },
  "evidence-chain": { guide: "evidence", render: () => <EvidenceShot head ids={["decision", "payment"]} /> },
  "evidence-signatures": { guide: "evidence", render: () => <EvidenceShot ids={["signatures"]} /> },
  "evidence-access": { guide: "evidence", render: () => <EvidenceAccess kind="invoice" receipt="shared" role="owner" canShare /> },
  "where-a-payment-is-track": {
    guide: "where-a-payment-is",
    page: "invoices",
    render: function SettlementTrackShot() {
      // Where the payment is, opened, as a payable's card shows it: a payment the agent made, confirmed on Arc testnet and
      // marked paid with its transaction (settlement lifecycle L7).
      return (
        <Card className="overflow-hidden">
          <SettlementTrack id="docs-settlement" settlement={SHOT_SETTLEMENT} orgSlug={SLUG} network="arc-testnet" now={SHOT_NOW} defaultOpen />
        </Card>
      );
    },
  },
  "where-a-payment-is-in-flight": {
    guide: "where-a-payment-is",
    page: "treasury",
    render: () => <PaymentsInFlight payments={SHOT_FLIGHT} now={SHOT_NOW} stuckAfterMinutes={15} orgSlug={SLUG} network="arc-testnet" />,
  },
  "xero-settings": {
    guide: "xero",
    page: "settings",
    sub: SETTINGS_SUB,
    render: () => (
      <AccountingPanel
        provider="xero"
        orgSlug={SLUG}
        view={{
          state: "connection",
          connectionId: "00000000-0000-4000-8000-0000000000a1",
          status: { tone: "ok", title: "Connected to Demo Company (Global)", detail: ["Last synced 5 minutes ago."], reconnect: false },
          connected: true,
          revoked: false,
          organisation: "Demo Company (Global)",
          waiting: 3,
          closedAfterAdded: 0,
          paymentAccount: { id: "6f7594f2-f059-4d56-9e67-47ac9733bfe9", code: "091", name: "Arc USDC wallet", currency: "USD" },
          sample: { supplier: "PowerDirect", number: "PD-4471", amount: "1250", currency: "USD" },
        }}
        canManage
        notice={null}
      />
    ),
  },
  "xero-review": {
    guide: "xero",
    page: "invoices",
    sub: "Your bills, what the agent decided on each, and why.",
    render: () => (
      <AccountingBillsReview
        provider="xero"
        orgSlug={SLUG}
        connectionId="00000000-0000-4000-8000-0000000000a2"
        organisation="Demo Company (Global)"
        canAdd
        closed={[]}
        items={[
          { id: "00000000-0000-4000-8000-0000000000b1", supplier: "PowerDirect Ltd", supplierNew: false, number: "PD-4471", amount: "1250", currency: "USD", usdc: "1250", dueOn: "2026-10-28", status: "add", reason: null },
          { id: "00000000-0000-4000-8000-0000000000b2", supplier: "Akiba Parts K.K.", supplierNew: true, number: "AK-77", amount: "300", currency: "USD", usdc: "300", dueOn: "2026-10-24", status: "add", reason: null },
          {
            id: "00000000-0000-4000-8000-0000000000b3",
            supplier: "SMART Agency",
            supplierNew: false,
            number: "SMC-0902",
            amount: "820.5",
            currency: "USD",
            usdc: "820.5",
            dueOn: "2026-09-20",
            status: "duplicate",
            reason: "Already in Vestiarion: same counterparty, amount, due date and reference.",
          },
        ]}
      />
    ),
  },
  "quickbooks-settings": {
    guide: "quickbooks",
    page: "settings",
    sub: SETTINGS_SUB,
    render: () => (
      <AccountingPanel
        provider="quickbooks"
        orgSlug={SLUG}
        view={{
          state: "connection",
          connectionId: "00000000-0000-4000-8000-0000000000c1",
          status: { tone: "ok", title: "Connected to Sandbox Company_US_1", detail: ["Last synced 5 minutes ago."], reconnect: false },
          connected: true,
          revoked: false,
          organisation: "Sandbox Company_US_1",
          waiting: 3,
          closedAfterAdded: 0,
          paymentAccount: { id: "92", code: "1090", name: "Arc USDC wallet", currency: "USD" },
          sample: { supplier: "PowerDirect", number: "PD-4471", amount: "1250", currency: "USD" },
        }}
        canManage
        notice={null}
      />
    ),
  },
  "quickbooks-review": {
    guide: "quickbooks",
    page: "invoices",
    sub: "Your bills, what the agent decided on each, and why.",
    render: () => (
      <AccountingBillsReview
        provider="quickbooks"
        orgSlug={SLUG}
        connectionId="00000000-0000-4000-8000-0000000000c2"
        organisation="Sandbox Company_US_1"
        canAdd
        closed={[{ id: "00000000-0000-4000-8000-0000000000d4", supplier: "Hicks Hardware", number: "HH-301", sourceStatus: "deleted" }]}
        items={[
          { id: "00000000-0000-4000-8000-0000000000d1", supplier: "PowerDirect Ltd", supplierNew: false, number: "PD-4471", amount: "1250", total: "1250", currency: "USD", usdc: "1250", dueOn: "2026-10-28", status: "add", reason: null },
          { id: "00000000-0000-4000-8000-0000000000d2", supplier: "Norton Lumber and Building Materials", supplierNew: true, number: "NL-2210", amount: "400", total: "1000", currency: "USD", usdc: "400", dueOn: "2026-10-20", status: "add", reason: null },
          {
            id: "00000000-0000-4000-8000-0000000000d3",
            supplier: "Akiba Parts K.K.",
            supplierNew: true,
            number: "AK-77",
            amount: "98000",
            total: "98000",
            currency: "JPY",
            usdc: null,
            dueOn: "2026-10-31",
            status: "error",
            reason: "This workspace's shadow mode takes bills in USD. Convert the amount to USD or USDC.",
          },
        ]}
      />
    ),
  },
  "xero-bookings": {
    guide: "xero",
    page: "invoices",
    sub: "Your bills, what the agent decided on each, and why.",
    // A payment made on Arc testnet in shadow mode, to book into the Xero Demo Company; below, one booked and one Xero
    // already showed paid (accounting write-back W6, W10).
    render: () => (
      <AccountingBookings
        provider="xero"
        orgSlug={SLUG}
        connectionId="00000000-0000-4000-8000-0000000000a3"
        organisation="Demo Company (Global)"
        scopeMissing={false}
        accountChosen
        canBook
        toReview={[
          {
            id: "00000000-0000-4000-8000-0000000000c1",
            state: "draft",
            supplier: "PowerDirect Ltd",
            billNumber: "PD-4471",
            amount: "1250",
            currency: "USD",
            paidOn: "2026-10-12",
            reference: `0x${"7a".repeat(32)}`,
            account: "Arc USDC wallet (091)",
            billNow: { amountDue: "1250", status: "open" },
            billAfter: { amountDue: "0.00", status: "paid" },
            network: "arc-testnet",
            shadow: true,
            paidAmount: "1250",
            paidToken: "USDC",
            networkFee: "0.0021",
            fingerprint: "0".repeat(64),
            blocked: null,
            words: "Waiting for review",
            paymentId: null,
          },
        ]}
        done={[
          {
            id: "00000000-0000-4000-8000-0000000000c2",
            state: "confirmed",
            supplier: "Akiba Parts K.K.",
            billNumber: "AK-77",
            amount: "300",
            currency: "USD",
            paidOn: "2026-10-11",
            reference: `0x${"5b".repeat(32)}`,
            account: "Arc USDC wallet (091)",
            billNow: null,
            billAfter: null,
            network: "arc-testnet",
            shadow: true,
            paidAmount: "300",
            paidToken: "USDC",
            networkFee: "0.0019",
            fingerprint: null,
            blocked: null,
            words: "Booked in Xero",
            paymentId: "b26fd49a-cbae-470a-a8f8-bcbc119e0379",
          },
          {
            id: "00000000-0000-4000-8000-0000000000c3",
            state: "refused",
            supplier: "SMART Agency",
            billNumber: "SMC-0902",
            amount: "820.50",
            currency: "USD",
            paidOn: "2026-10-11",
            reference: `0x${"3d".repeat(32)}`,
            account: null,
            billNow: null,
            billAfter: null,
            network: "arc-testnet",
            shadow: true,
            paidAmount: "820.5",
            paidToken: "USDC",
            networkFee: null,
            fingerprint: null,
            blocked: null,
            words: "Already paid in Xero.",
            paymentId: null,
          },
        ]}
      />
    ),
  },
  "apply-payments-list": {
    guide: "apply-payments",
    page: "invoices",
    // Money received on Arc testnet: one transfer for three invoices, one a few cents short, and one with no suggestion.
    render: () => <ApplyPayments orgSlug={SLUG} network="arc-testnet" payments={APPLY_PAYMENTS} canWrite />,
  },
  "apply-payments-part-paid": {
    guide: "apply-payments",
    page: "invoices",
    // A receivable half paid: what arrived, what is still owed, and Reverse and Record a fee, above its pay link.
    render: () => (
      <BillRowShot
        invoice={PART_PAID}
        decision={invoiceDecision(PART_PAID, undefined, [], { network: "arc-testnet", allocations: PART_PAID_VIEWS })}
        today="2026-10-12"
        owedNote="Part paid · 1,200.00 USDC still owed"
        footer={<AllocationLines orgSlug={SLUG} network="arc-testnet" view={PART_PAID_VIEW} label="INV-1051 Website build" canWrite />}
      />
    ),
  },
  "deals-new": {
    guide: "deals",
    page: "invoices",
    render: () => (
      // New deal, opened under Deals, as an owner fills it in: a 30% deposit and the balance on delivery, with the
      // rounding the balance carries (the script types the deal, the total and the delivery date).
      <Card className="p-5">
        <DealForm
          orgSlug={SLUG}
          customers={[{ id: "c1c1c1c1-0000-4000-8000-0000000000c1", name: "Acme Studio" }]}
          currencies={["USDC", "EURC"]}
          idempotencyKey="docs-shot-key-0001"
          today="2026-10-12"
          initialCustomerId="c1c1c1c1-0000-4000-8000-0000000000c1"
        />
      </Card>
    ),
  },
  "deals-schedule": {
    guide: "deals",
    // A deal's page below its figures: the deposit paid, the balance and a price change planned, released by the agent.
    render: () => <DealSchedule orgSlug={SLUG} deal={dealShot()} today={DEALS_SHOT_TODAY} canWrite />,
  },
  "deals-change": {
    guide: "deals",
    render: () => (
      // Change deal, after the deposit was paid: the script types a new total and asks for a correction.
      <Card className="p-5">
        <DealChangeForm
          orgSlug={SLUG}
          facts={{ ...dealShot().facts, version: 1, totalMinor: 1_000_001, lines: dealShot().facts.lines.slice(0, 2) }}
          digits={2}
          today={DEALS_SHOT_TODAY}
          idempotencyKey="docs-shot-key-0002"
          mode="revised"
        />
      </Card>
    ),
  },
  "deals-versions": {
    guide: "deals",
    render: () => <DealVersions deal={dealShot()} />,
  },
  "hubspot-settings": {
    guide: "hubspot",
    page: "settings",
    sub: SETTINGS_SUB,
    render: () => (
      <HubSpotPanel
        orgSlug={SLUG}
        view={{
          state: "connection",
          connectionId: "00000000-0000-4000-8000-0000000000d1",
          status: { tone: "ok", title: "Connected to northstar-studio.example", detail: ["Last synced 5 minutes ago."], reconnect: false },
          connected: true,
          revoked: false,
          organisation: "northstar-studio.example",
          toPlan: 2,
          changed: 1,
        }}
        canManage
        notice={null}
      />
    ),
  },
  "hubspot-deals": {
    guide: "hubspot",
    page: "invoices",
    // Under Deals: two won deals to plan, one without an amount, one planned that HubSpot changed since.
    render: () => (
      <HubSpotDeals
        orgSlug={SLUG}
        organisation="northstar-studio.example"
        canWrite
        won={[
          {
            id: "00000000-0000-4000-8000-0000000000d2",
            name: "Website rebuild",
            company: "Northwind Labs",
            amount: "12,500 USD",
            closeOn: "2026-10-01",
            stage: "Closed Won",
            plan: { ok: true },
            linkedDeal: null,
            changes: [],
          },
          {
            id: "00000000-0000-4000-8000-0000000000d3",
            name: "Brand refresh",
            company: "Contoso Design",
            amount: "4,800.50 USD",
            closeOn: "2026-10-08",
            stage: "Closed Won",
            plan: { ok: true },
            linkedDeal: null,
            changes: [],
          },
          {
            id: "00000000-0000-4000-8000-0000000000d4",
            name: "Discovery sprint",
            company: "Fabrikam",
            amount: null,
            closeOn: "2026-10-05",
            stage: "Closed Won",
            plan: { ok: false, reason: "No amount in HubSpot" },
            linkedDeal: null,
            changes: [],
          },
          {
            id: "00000000-0000-4000-8000-0000000000d5",
            name: "Monthly retainer, Q4",
            company: "Acme Studio",
            amount: "15,000 USD",
            closeOn: "2026-09-20",
            stage: "Closed Won",
            plan: { ok: false, reason: "Planned already" },
            linkedDeal: { id: "00000000-0000-4000-8000-0000000000d6", title: "Monthly retainer, Q4", status: "active" },
            changes: ["Amount: 12,000 USD to 15,000 USD."],
          },
        ]}
        open={[
          {
            id: "00000000-0000-4000-8000-0000000000d7",
            name: "Mobile app",
            company: "Northwind Labs",
            amount: "30,000 USD",
            closeOn: "2026-11-15",
            stage: "Contract Sent",
            plan: { ok: false, reason: "Not won yet" },
            linkedDeal: null,
            changes: [],
          },
        ]}
        emails={[{ counterpartyId: "00000000-0000-4000-8000-0000000000d8", name: "Acme Studio", email: "ap@acme-studio.example" }]}
      />
    ),
  },
  "hubspot-plan": {
    guide: "hubspot",
    page: "invoices",
    render: () => (
      // Plan collections on the won deal: the New deal form filled in from it, for the person to pick how it is billed.
      <Card className="p-5">
        <DealForm
          orgSlug={SLUG}
          customers={[{ id: "c1c1c1c1-0000-4000-8000-0000000000c2", name: "Northwind Labs" }]}
          currencies={["USDC", "EURC"]}
          idempotencyKey="docs-shot-key-0003"
          today="2026-10-12"
          prefill={{
            crmRowId: "00000000-0000-4000-8000-0000000000d2",
            label: "HubSpot",
            customerId: "c1c1c1c1-0000-4000-8000-0000000000c2",
            customerName: "",
            title: "Website rebuild",
            total: "12500.00",
            currency: "USDC",
            startsOn: "2026-10-01",
            externalRef: "30117482911",
            notes: ["HubSpot says 12,500 USD: planned as 12,500.00 USDC, one for one."],
          }}
        />
      </Card>
    ),
  },
  "hubspot-changed": {
    guide: "hubspot",
    // A planned deal's page: what HubSpot changed since, and what a person can do about it.
    render: () => (
      <CrmDealChanges
        orgSlug={SLUG}
        dealId="00000000-0000-4000-8000-0000000000d6"
        label="HubSpot"
        words={["Amount: 12,000 USD to 15,000 USD.", "Close date: Sep 20, 2026 to Sep 30, 2026."]}
        seen={"0".repeat(64)}
        canWrite
        active
      />
    ),
  },
  "customer-portal-statement": {
    guide: "customer-portal",
    // A public page, as the customer reads it: its own invoices, what it still owes in each currency, and its actions.
    render: () => <StatementView view={statementShot({ short: true })} token={PORTAL_TOKEN} />,
  },
  "customer-portal-from-customers": {
    guide: "customer-portal",
    page: "invoices",
    // The Receivables tab's list: a claim of payment, and a dispute with a member's reply.
    render: () => <FromCustomers orgSlug={SLUG} items={fromCustomersShot((id) => orgHref(SLUG, `/invoices?tab=receivables&open=${id}`), { kinds: ["paid", "dispute"] })} canWrite />,
  },
} satisfies Record<string, DocsShot>;

/**
 * Some links of the evidence guide's chain, numbered as the page numbers them, with the page's head above the first
 * picture. The page is long: each picture shows a part of it.
 */
function EvidenceShot({ ids, head = false }: { ids: EvidenceStep["id"][]; head?: boolean }) {
  const { chain, publicKeys } = evidenceShot();
  return (
    <>
      {head && <PageHead title={evidenceLinkLabel(chain.subject.paid)} sub={evidenceSub(chain.subject)} />}
      <ol className="space-y-4">
        {chain.steps.map((step, index) =>
          ids.includes(step.id) ? (
            <li key={step.id}>
              <EvidenceStepCard step={step} number={index + 1} chain={chain} orgSlug={SLUG} publicKeys={publicKeys} />
            </li>
          ) : null
        )}
      </ol>
    </>
  );
}

export type DocsShotName = keyof typeof DOCS_SHOTS;

export const DOCS_SHOT_NAMES = Object.keys(DOCS_SHOTS) as DocsShotName[];
