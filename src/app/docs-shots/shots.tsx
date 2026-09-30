import { FileSpreadsheet, PenLine } from "lucide-react";
import type { ReactNode } from "react";
import ApprovalCard from "@/components/ApprovalCard";
import GoLivePanel from "@/components/GoLivePanel";
import VerifyLedgerBadge from "@/components/VerifyLedgerBadge";
import CounterpartyAddress from "@/components/intake/CounterpartyAddressEdit";
import CounterpartyIntake from "@/components/intake/CounterpartyIntake";
import InvoiceCsvImport from "@/components/intake/InvoiceCsvImport";
import InvoiceIntake from "@/components/intake/InvoiceIntake";
import { Card } from "@/components/ui/Card";
import { CopyButton } from "@/components/ui/CopyButton";
import { Eyebrow } from "@/components/ui/Eyebrow";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/Tabs";
import { AuditLedger, pad } from "@/components/vx/AuditLedger";
import { DecisionCard } from "@/components/vx/DecisionCard";
import { GettingStarted } from "@/components/vx/GettingStarted";
import { invoiceDecision } from "@/components/vx/map";
import type { NavKey } from "@/components/vx/nav";
import { Hash } from "@/components/vx/Primitives";
import type { WaitingPayable } from "@/lib/agent/approvals";
import type { LedgerEntry } from "@/lib/ledger";
import type { GoLiveStatus } from "@/lib/platform/go-live";
import { gettingStarted } from "@/lib/getting-started";
import type { CounterpartyRow, InvoiceRow } from "@/lib/queries";
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
  guide: "go-live" | "first-payment";
  /** The workspace page it is on: its title heads the frame. */
  page: NavKey;
  /** The page's line under its title, where the real page has one. */
  sub?: string;
  /** What `/api/ledger/verify` answers in this shot; the script serves it to the page, so Verify reaches a verdict without a ledger. */
  verification?: { valid: boolean; checkedEntries: number };
  render: () => ReactNode;
}

const SLUG = DESIGN_SLUG;

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

const HELD: WaitingPayable = {
  id: "00000000-0000-4000-8000-0000000000e2",
  counterpartyId: "00000000-0000-4000-8000-0000000000d2",
  counterpartyName: "Bluebird Logistics",
  riskLevel: "clear",
  amount: 8,
  dueDate: "2026-10-09",
  status: "held",
  reasoning: "Held 8.00 USDC for Bluebird Logistics: no receipt is recorded for PO-2213, so the three-way match is incomplete.",
  decidedAt: "2026-09-30T12:04:00Z",
  createdBy: "docs-sample-admin",
  reviewedAt: null,
  reclaimable: false,
  paymentSent: false,
  address: "0x7a3c9e2b41d05f8a6c1e3b9d2f4a8c6e0b5d1f93",
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

export const DOCS_SHOTS = {
  "go-live-checklist": {
    guide: "go-live",
    page: "treasury",
    render: function ChecklistShot() {
      const checklist = gettingStarted({
        mode: "sandbox",
        accounts: [{ kind: "operating", circle_wallet_id: "docs-sample-wallet", balance: 0 }],
        counterparties: [],
        invoiceCount: 0,
      });
      return <GettingStarted slug={SLUG} checklist={checklist} isOwner />;
    },
  },
  "go-live-choose": { guide: "go-live", page: "settings", render: goLive(CHOOSING) },
  "go-live-own-account": { guide: "go-live", page: "settings", render: goLive(CHOOSING) },
  "go-live-create-wallets": { guide: "go-live", page: "settings", render: goLive({ ...CHOOSING, step: "wallets", host: "hosted" }) },
  "go-live-fund": { guide: "go-live", page: "settings", render: goLive({ ...CHOOSING, step: "go_live", host: "hosted", wallets: WALLETS }, FAUCET_BALANCE) },
  "go-live-confirm": { guide: "go-live", page: "settings", render: goLive({ ...CHOOSING, step: "go_live", host: "hosted", wallets: WALLETS }, FAUCET_BALANCE) },
  "go-live-live": {
    guide: "go-live",
    page: "settings",
    render: goLive({ ...CHOOSING, step: "live", host: "hosted", wallets: WALLETS, liveSince: "2026-09-30T09:12:00Z" }),
  },
  "first-payment-counterparty": {
    guide: "first-payment",
    page: "counterparties",
    render: function CounterpartyShot() {
      return (
        <section>
          <SectionHeader title="Add counterparty" meta="human-entered · screened on submission" />
          <CounterpartyIntake orgSlug={SLUG} />
        </section>
      );
    },
  },
  "first-payment-address": {
    guide: "first-payment",
    page: "counterparties",
    render: function AddressShot() {
      return (
        <section className="max-w-md">
          <Card className="min-w-0 p-4">
            <h3 className="truncate text-sm font-semibold text-ink">{COUNTERPARTY.name}</h3>
            <p className="mt-0.5 text-xs capitalize text-ink-3">
              {COUNTERPARTY.role} · {COUNTERPARTY.chain}
            </p>
            <CounterpartyAddress
              orgSlug={SLUG}
              counterparty={{ id: COUNTERPARTY.id, name: COUNTERPARTY.name, address: COUNTERPARTY.address }}
              unconfirmedSince="2026-09-30T12:20:00Z"
              canWrite
              canConfirm
            />
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
        <section>
          <SectionHeader title="Invoice intake" meta="manual entry or CSV preview and confirm" />
          <Card className="p-4 sm:p-6">
            <Tabs defaultValue="manual">
              <TabsList aria-label="Invoice intake">
                <TabsTrigger value="manual">
                  <PenLine aria-hidden />
                  Enter one invoice
                </TabsTrigger>
                <TabsTrigger value="csv">
                  <FileSpreadsheet aria-hidden />
                  Import CSV
                </TabsTrigger>
              </TabsList>
              <TabsContent value="manual" forceMount className="data-[state=inactive]:hidden">
                <InvoiceIntake orgSlug={SLUG} counterparties={[{ id: COUNTERPARTY.id, name: COUNTERPARTY.name, role: COUNTERPARTY.role }]} />
              </TabsContent>
              <TabsContent value="csv" forceMount className="data-[state=inactive]:hidden">
                <InvoiceCsvImport orgSlug={SLUG} />
              </TabsContent>
            </Tabs>
          </Card>
        </section>
      );
    },
  },
  "first-payment-decision": {
    guide: "first-payment",
    page: "invoices",
    render: function DecisionShot() {
      return (
        <section>
          <SectionHeader title="Payables" />
          <DecisionCard decision={invoiceDecision(INVOICE, COUNTERPARTY, ENTRIES)} orgSlug={SLUG} />
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
} satisfies Record<string, DocsShot>;

export type DocsShotName = keyof typeof DOCS_SHOTS;

export const DOCS_SHOT_NAMES = Object.keys(DOCS_SHOTS) as DocsShotName[];
