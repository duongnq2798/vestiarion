import { FileSpreadsheet, FileText, ListChecks, PenLine, Repeat, UserPlus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AgentBudgetPanel } from "@/components/AgentBudgetPanel";
import ApprovalCard from "@/components/ApprovalCard";
import { CounterpartyRow as CounterpartyRowView } from "@/components/CounterpartyRow";
import EmailInboxPanel from "@/components/EmailInboxPanel";
import GoLivePanel from "@/components/GoLivePanel";
import InboxEmails from "@/components/InboxEmails";
import NotificationsPanel from "@/components/NotificationsPanel";
import { HeldMilestoneActions } from "@/components/HeldMilestoneActions";
import { PayLinkControl } from "@/components/PayLinkControl";
import SlackPanel from "@/components/SlackPanel";
import { UsycReservePanel } from "@/components/UsycReservePanel";
import VerifyLedgerBadge from "@/components/VerifyLedgerBadge";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { DecisionTrail } from "@/components/vx/DecisionTrail";
import { WaitingPayableAction } from "@/components/WaitingPayableAction";
import CounterpartyAddress from "@/components/intake/CounterpartyAddressEdit";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import InvoiceCsvImport from "@/components/intake/InvoiceCsvImport";
import InvoiceDocumentIntake, { DocumentDraft } from "@/components/intake/InvoiceDocumentIntake";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import PayFreelancerForm, { PaymentLinkReady } from "@/components/intake/PayFreelancerForm";
import { PayeeJourney } from "@/components/payee/PayeeJourney";
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
import type { WaitingPayable } from "@/lib/agent/approvals";
import { waitingHint } from "@/lib/added-details";
import { heldReason } from "@/lib/agent/milestone-decisions";
import type { LedgerEntry } from "@/lib/ledger";
import type { PayeeLinkStatus } from "@/lib/payee-journey";
import type { GoLiveStatus } from "@/lib/platform/go-live";
import { gettingStarted } from "@/lib/getting-started";
import type { CounterpartyRow, InvoiceRow, MilestoneRow } from "@/lib/queries";
import { DESIGN_SLUG, LEDGER } from "../design/fixtures";

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
  guide: "go-live" | "first-payment" | "pay-a-contractor" | "get-paid" | "telegram" | "slack" | "email-invoices";
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
  },
};

function goLive(status: GoLiveStatus, sampleBalance?: number): () => ReactNode {
  return function GoLiveShot() {
    return <GoLivePanel orgSlug={SLUG} status={status} canAdminister sampleBalance={sampleBalance} />;
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

export const DOCS_SHOTS = {
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
      return (
        <IntakeFold label="New invoice" meta="typed in, read from a document, imported from a CSV, or recurring" defaultOpen className="">
            <Tabs defaultValue="manual">
              <TabsList aria-label="New invoice">
                <TabsTrigger value="manual">
                  <PenLine aria-hidden />
                  Enter one invoice
                </TabsTrigger>
                <TabsTrigger value="document">
                  <FileText aria-hidden />
                  From a document
                </TabsTrigger>
                <TabsTrigger value="csv">
                  <FileSpreadsheet aria-hidden />
                  Import CSV
                </TabsTrigger>
                <TabsTrigger value="recurring">
                  <Repeat aria-hidden />
                  Recurring
                </TabsTrigger>
              </TabsList>
              <TabsContent value="manual" forceMount className="data-[state=inactive]:hidden">
                <InvoiceIntake orgSlug={SLUG} counterparties={[{ id: COUNTERPARTY.id, name: COUNTERPARTY.name, role: COUNTERPARTY.role }]} />
              </TabsContent>
              <TabsContent value="document" forceMount className="data-[state=inactive]:hidden">
                <InvoiceDocumentIntake orgSlug={SLUG} counterparties={[{ id: COUNTERPARTY.id, name: COUNTERPARTY.name, role: COUNTERPARTY.role }]} />
              </TabsContent>
              <TabsContent value="csv" forceMount className="data-[state=inactive]:hidden">
                <InvoiceCsvImport orgSlug={SLUG} />
              </TabsContent>
            </Tabs>
        </IntakeFold>
      );
    },
  },
  "first-payment-document": {
    guide: "first-payment",
    page: "invoices",
    render: function DocumentShot() {
      const asked = `0x${"5af3107a".repeat(5)}`;
      return (
        <IntakeFold label="New invoice" meta="typed in, read from a document, imported from a CSV, or recurring" defaultOpen className="">
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
        </IntakeFold>
      );
    },
  },
  "first-payment-decision": {
    guide: "first-payment",
    page: "invoices",
    render: function DecisionShot() {
      return (
        <section>
          <SectionHeader title="Payables" meta="1 invoice · open one for the agent's reasoning" />
          <RowGroupHeading title="Paid and closed" count={1} />
          <DecisionRows orgSlug={SLUG} items={[{ decision: invoiceDecision(INVOICE, COUNTERPARTY, ENTRIES, { network: "arc-testnet" }), date: { label: "Due Oct 15, 2026" }, open: true }]} />
        </section>
      );
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
          <DecisionTrail id={decision.id} steps={decision.trail ?? []} orgSlug={SLUG} network="arc-testnet" defaultOpen />
        </Card>
      );
    },
  },
  "first-payment-reminders": {
    guide: "first-payment",
    page: "invoices",
    render: () => (
      <section>
        <SectionHeader title="Receivables" meta="1 invoice" />
        <RowGroupHeading title="Open" count={1} />
        <DecisionRows
          orgSlug={SLUG}
          items={[
            {
              decision: invoiceDecision(OWED, undefined, REMINDER_ENTRIES, { network: "arc-testnet" }),
              date: { label: "Due Oct 10, 2026" },
              footerAction: (
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
              ),
              open: true,
            },
          ]}
        />
      </section>
    ),
  },
  "first-payment-needs-you": {
    guide: "first-payment",
    page: "invoices",
    render: function NeedsYouShot() {
      const onFile = { poReference: null, goodsReceived: false };
      return (
        <section>
          <SectionHeader title="Payables" meta="1 invoice · open one for the agent's reasoning" />
          <RowGroupHeading
            title="Needs you"
            count={1}
            action={
              <Button asChild variant="link" className="text-[0.8125rem]">
                <Link href={`/o/${SLUG}/approvals`}>Decide in Approvals</Link>
              </Button>
            }
          />
          <DecisionRows
            orgSlug={SLUG}
            items={[
              {
                decision: invoiceDecision(ASKED_INVOICE, COUNTERPARTY, [ASK_ENTRY], { network: "arc-testnet" }),
                date: { label: "Due Oct 15, 2026" },
                hint: waitingHint(onFile, null),
                footerAction: (
                  <WaitingPayableAction
                    orgSlug={SLUG}
                    invoice={{ id: ASKED_INVOICE.id, counterpartyName: ASKED_INVOICE.counterparty_name, ...onFile }}
                    added={null}
                    canAddDetails
                    canDecide
                  />
                ),
                open: true,
              },
            ]}
          />
        </section>
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
    sub: "Three-way match, counterparty risk, and payment authority — with the agent’s complete reasoning on every line.",
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
} satisfies Record<string, DocsShot>;

export type DocsShotName = keyof typeof DOCS_SHOTS;

export const DOCS_SHOT_NAMES = Object.keys(DOCS_SHOTS) as DocsShotName[];
