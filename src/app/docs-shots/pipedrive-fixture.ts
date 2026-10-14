import { receiptLink, type ReceiptFields } from "@/lib/connectors/crm-receipts";
import type { ReceiptWriteRow } from "@/lib/connectors/crm-receipts-run";
import { noTestAccountRule, type CrmReceiptsPanel } from "@/lib/connectors/crm-receipts-view";
import type { CrmPanelView, CrmRowView } from "@/lib/connectors/crm-review";
import { dealCollection, type Collection } from "@/lib/deals/collection";
import type { DealCost } from "@/lib/deals/costs";
import type { DealRecord } from "@/lib/deals/read";
import { NETWORKS } from "@/lib/network";

/**
 * The pictures of Pipedrive's connector (docs/superpowers/specs/2026-10-14-pipedrive-connector-design.md,
 * `docs/superpowers/specs/pipedrive-shots/`), on Oct 20, 2026: Cedar & Co's won deal "Spring campaign", 200 USD in
 * Pipedrive, planned as 200.00 USDC with a 10% deposit paid on Arc mainnet and the balance due Nov 11; its ad spend on
 * Oct 22 leaves it short until then. Nothing here is real: the slug names no workspace, the company and the transaction
 * are made up.
 */

export const PIPEDRIVE_TODAY = "2026-10-20";
export const PIPEDRIVE_DEAL_ID = "dddddddd-0000-4000-8000-0000000d0042";
const HASH = `0x${"5e".repeat(32)}`;
const DEPOSIT = "eeeeeeee-0000-4000-8000-0000000d0001";
const BALANCE = "eeeeeeee-0000-4000-8000-0000000d0002";

type Line = DealRecord["facts"]["lines"][number];
const line = (n: number, over: Partial<Line>): Line => ({
  id: `11111111-0000-4000-8000-0000000d000${n}`,
  position: n,
  kind: "charge",
  label: "",
  invoiceOn: "2026-10-14",
  dueOn: "2026-10-28",
  amountMinor: 0,
  roundingMinor: 0,
  status: "planned",
  addedIn: 1,
  endedIn: null,
  replaces: null,
  releasedAt: null,
  releasedVia: null,
  receivable: null,
  ...over,
});

/** The deal planned from Pipedrive: the deposit released and paid, the balance planned (or, for the conflict, released). */
export function springCampaign(balanceReleased = false): DealRecord {
  return {
    facts: {
      id: PIPEDRIVE_DEAL_ID,
      status: "active",
      version: 1,
      totalMinor: 20_000,
      currency: "USDC",
      startsOn: "2026-10-14",
      termsDays: 14,
      autoRelease: false,
      lines: [
        line(1, {
          label: "Deposit (10%)",
          amountMinor: 2_000,
          status: "released",
          releasedAt: "2026-10-14T09:10:00Z",
          releasedVia: "person",
          receivable: { id: DEPOSIT, status: "received", dueDate: "2026-10-28T12:00:00Z" },
        }),
        line(
          2,
          balanceReleased
            ? {
                label: "Balance",
                invoiceOn: "2026-10-20",
                dueOn: "2026-11-11",
                amountMinor: 18_000,
                status: "released",
                releasedAt: "2026-10-20T08:00:00Z",
                releasedVia: "person",
                receivable: { id: BALANCE, status: "pending", dueDate: "2026-11-11T12:00:00Z" },
              }
            : { label: "Balance", invoiceOn: "2026-10-28", dueOn: "2026-11-11", amountMinor: 18_000 }
        ),
      ],
    },
    title: "Spring campaign",
    customer: { id: "c1c1c1c1-0000-4000-8000-0000000d0c01", name: "Cedar & Co" },
    digits: 2,
    externalRef: "pipedrive-42",
    template: "deposit",
    createdBy: null,
    createdAt: "2026-10-14T09:00:00Z",
    autoReleaseBy: null,
    autoReleaseAt: null,
    versions: [{ version: 1, kind: "signed", totalMinor: 20_000, reason: null, changes: [], createdBy: null, createdAt: "2026-10-14T09:00:00Z" }],
  };
}

/** What the deal collected, as its page reads it: the deposit, paid whole on Arc mainnet on Oct 15. */
export function springCollected(record: DealRecord): Collection {
  const released = record.facts.lines.flatMap((each) => (each.receivable ? [{ line: each, receivable: each.receivable }] : []));
  return dealCollection({
    deal: { currency: record.facts.currency, digits: record.digits, status: record.facts.status },
    receivables: released.map(({ line: each, receivable }) => ({
      id: receivable.id,
      amount: each.amountMinor / 10 ** record.digits,
      currency: record.facts.currency,
      status: receivable.status,
      dueOn: receivable.dueDate.slice(0, 10),
      originalCurrency: null,
      originalAmount: null,
    })),
    payments: released
      .filter(({ receivable }) => receivable.status === "received")
      .map(({ line: each, receivable }) => ({
        transferId: `transfer-${receivable.id}`,
        invoiceId: receivable.id,
        amount: each.amountMinor / 10 ** record.digits,
        receivedAt: "2026-10-15T10:42:00Z",
        txHash: HASH,
        chain: NETWORKS["arc-mainnet"].circleBlockchain,
      })),
    fees: [],
    notInvoicedMinor: record.facts.lines.filter((each) => each.status === "planned" && each.kind === "charge").reduce((sum, each) => sum + each.amountMinor, 0),
    today: PIPEDRIVE_TODAY,
  });
}

const cost = (n: number, over: Partial<DealCost>): DealCost => ({
  id: `22222222-0000-4000-8000-0000000d00c${n}`,
  label: "",
  counterparty: null,
  amountMinor: 0,
  expectedOn: PIPEDRIVE_TODAY,
  noDocument: false,
  createdAt: "2026-10-14T09:30:00Z",
  createdBy: null,
  removedAt: null,
  link: null,
  ...over,
});

/** The ad spend before the balance arrives, and the photographer after it. */
export const SPRING_COSTS: DealCost[] = [
  cost(1, { label: "Ad spend", counterparty: { id: "c1c1c1c1-0000-4000-8000-0000000d0c02", name: "Brightline Media" }, amountMinor: 15_000, expectedOn: "2026-10-22" }),
  cost(2, { label: "Photographer", amountMinor: 4_000, expectedOn: "2026-11-14" }),
];

const fields = (over: Partial<ReceiptFields> = {}): ReceiptFields => ({
  vestiarion_collected: "20.00",
  vestiarion_still_owed: "0.00",
  vestiarion_currency: "USDC",
  vestiarion_collection_status: "paid_to_date",
  vestiarion_last_receipt_date: "2026-10-15",
  vestiarion_last_receipt_amount: "20.00",
  vestiarion_last_receipt_link: receiptLink({ txHash: HASH, network: "arc-mainnet" }),
  vestiarion_reconciliation: "reconciled",
  vestiarion_evidence_link: `https://www.vestiarion.xyz/o/cedar/invoices/deals/${PIPEDRIVE_DEAL_ID}`,
  ...over,
});

const row = (over: Partial<ReceiptWriteRow>): ReceiptWriteRow => ({
  id: "77777777-0000-4000-8000-0000000d0001",
  connectionId: "00000000-0000-4000-8000-0000000d00d1",
  crmDealId: "88888888-0000-4000-8000-0000000d0001",
  dealId: PIPEDRIVE_DEAL_ID,
  externalDealId: "42",
  fields: fields(),
  network: "arc-mainnet",
  shadow: false,
  accountType: "COMPANY",
  accountTest: false,
  state: "queued",
  reason: null,
  message: null,
  attempts: 0,
  nextAttemptAt: null,
  sendingUntil: null,
  conflicts: [],
  overwrite: null,
  overwriteBy: null,
  overwriteAt: null,
  readBack: null,
  sentAt: null,
  writtenAt: null,
  createdAt: "2026-10-15T10:50:00.000Z",
  ...over,
});

export const PIPEDRIVE_ROWS = {
  written: row({ state: "written", readBack: fields(), sentAt: "2026-10-15T10:50:12.000Z", writtenAt: "2026-10-15T10:50:13.000Z", attempts: 1 }),
  /** The balance invoiced; someone in Pipedrive marked the deal paid in full by hand. */
  conflict: row({
    id: "77777777-0000-4000-8000-0000000d0002",
    state: "conflict",
    reason: "changed_in_crm",
    attempts: 1,
    fields: fields({ vestiarion_still_owed: "180.00", vestiarion_collection_status: "partly_paid" }),
    conflicts: [
      { field: "vestiarion_collected", ours: "20", theirs: "200", next: "20" },
      { field: "vestiarion_collection_status", ours: "paid_to_date", theirs: "paid_in_full", next: "partly_paid" },
    ],
    createdAt: "2026-10-20T08:15:00.000Z",
  }),
} satisfies Record<string, ReceiptWriteRow>;

export const PIPEDRIVE_CONNECTED: Extract<CrmPanelView, { state: "connection" }> = {
  state: "connection",
  connectionId: "00000000-0000-4000-8000-0000000d00d1",
  status: { tone: "ok", title: "Connected to Cedar & Co", detail: ["Last synced 2 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  organisation: "Cedar & Co",
  toPlan: 1,
  changed: 1,
};

export const PIPEDRIVE_PANELS = {
  /** A workspace on Arc mainnet outside shadow mode, writing. */
  on: { on: true, allowed: true, counts: { written: 3, waiting: 0, failed: 0, conflicts: 1, refused: 0 }, lastWrittenAt: "2026-10-15T10:50:13.000Z", account: null, rule: null },
  /** A workspace on Arc testnet: Pipedrive names no test company, so it never writes. */
  testnet: {
    on: false,
    allowed: true,
    counts: { written: 0, waiting: 0, failed: 0, conflicts: 0, refused: 0 },
    lastWrittenAt: null,
    account: null,
    rule: noTestAccountRule("Pipedrive", { network: "arc-testnet", shadow: false }),
    blocked: true,
  },
} satisfies Record<string, CrmReceiptsPanel>;

const view = (over: Partial<CrmRowView> & Pick<CrmRowView, "id" | "name">): CrmRowView => ({
  company: "Cedar & Co",
  amount: "200 USD",
  closeOn: "2026-10-14",
  stage: "Negotiation",
  plan: { ok: true },
  linkedDeal: null,
  changes: [],
  ...over,
});

export const PIPEDRIVE_WON: CrmRowView[] = [
  view({ id: "row-42", name: "Spring campaign" }),
  view({
    id: "row-37",
    name: "Brand video",
    company: "Larkspur Bakery",
    amount: "1,500 USD",
    closeOn: "2026-10-02",
    stage: "Proposal made",
    plan: { ok: false, reason: "Planned already" },
    linkedDeal: { id: "dddddddd-0000-4000-8000-0000000d0037", title: "Brand video", status: "active" },
    changes: ["Amount: 1,200 USD to 1,500 USD."],
  }),
  view({ id: "row-45", name: "Pop-up stall", company: null, amount: "350 USD", closeOn: "2026-10-18", stage: "Negotiation", plan: { ok: false, reason: "No organization in Pipedrive" } }),
];

export const PIPEDRIVE_OPEN: CrmRowView[] = [
  view({ id: "row-43", name: "Summer launch", amount: "900 USD", closeOn: "2026-11-30", stage: "Qualified", plan: { ok: false, reason: "Not won yet" } }),
];
