import { receiptLink, type ReceiptFields } from "@/lib/connectors/crm-receipts";
import type { ReceiptWriteRow } from "@/lib/connectors/crm-receipts-run";
import type { CrmReceiptsPanel } from "@/lib/connectors/crm-receipts-view";
import type { CrmPanelView } from "@/lib/connectors/crm-review";
import type { DealRecord } from "@/lib/deals/read";

/**
 * The deal the receipts pictures show (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R8): Website rebuild for
 * Northwind Labs, planned from HubSpot for 12,000.00 USDC. The deposit was paid in full; the design milestone was paid
 * in part, 2,000.00 of 4,200.00 USDC; the launch is planned. Nothing here is real: the slug names no workspace and the
 * transaction is made up.
 */

export const RECEIPTS_DEAL_ID = "dddddddd-0000-4000-8000-0000000000e7";
const HASH = `0x${"7c".repeat(32)}`;

type Line = DealRecord["facts"]["lines"][number];
const line = (id: string, over: Partial<Line>): Line => ({
  id: `11111111-0000-4000-8000-00000000001${id}`,
  position: 1,
  kind: "charge",
  label: "",
  invoiceOn: "2026-10-01",
  dueOn: "2026-10-15",
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

export function receiptsDeal(): DealRecord {
  return {
    facts: {
      id: RECEIPTS_DEAL_ID,
      status: "active",
      version: 1,
      totalMinor: 1_200_000,
      currency: "USDC",
      startsOn: "2026-10-01",
      termsDays: 14,
      autoRelease: false,
      lines: [
        line("1", {
          label: "Deposit (30%)",
          amountMinor: 360_000,
          status: "released",
          releasedAt: "2026-10-01T09:00:00Z",
          releasedVia: "person",
          receivable: { id: "eeeeeeee-0000-4000-8000-0000000000f1", status: "received", dueDate: "2026-10-15T12:00:00Z" },
        }),
        line("2", {
          position: 2,
          label: "Design sign-off",
          invoiceOn: "2026-10-08",
          dueOn: "2026-10-22",
          amountMinor: 420_000,
          status: "released",
          releasedAt: "2026-10-08T09:00:00Z",
          releasedVia: "person",
          receivable: { id: "eeeeeeee-0000-4000-8000-0000000000f2", status: "pending", dueDate: "2026-10-22T12:00:00Z" },
        }),
        line("3", { position: 3, label: "Launch", invoiceOn: "2026-11-15", dueOn: "2026-11-29", amountMinor: 420_000 }),
      ],
    },
    title: "Website rebuild",
    customer: { id: "c1c1c1c1-0000-4000-8000-0000000000c7", name: "Northwind Labs" },
    digits: 2,
    externalRef: "30117482911",
    template: "milestones",
    createdBy: null,
    createdAt: "2026-10-01T09:00:00Z",
    autoReleaseBy: null,
    autoReleaseAt: null,
    versions: [{ version: 1, kind: "signed", totalMinor: 1_200_000, reason: null, changes: [], createdBy: null, createdAt: "2026-10-01T09:00:00Z" }],
  };
}

export const RECEIPTS_TODAY = "2026-10-13";

const fields = (over: Partial<ReceiptFields> = {}): ReceiptFields => ({
  vestiarion_collected: "5600.00",
  vestiarion_still_owed: "2200.00",
  vestiarion_currency: "USDC",
  vestiarion_collection_status: "partly_paid",
  vestiarion_last_receipt_date: "2026-10-12",
  vestiarion_last_receipt_amount: "2000.00",
  vestiarion_last_receipt_link: receiptLink({ txHash: HASH, network: "arc-testnet" }),
  vestiarion_reconciliation: "reconciled",
  vestiarion_evidence_link: `https://www.vestiarion.xyz/o/northstar/invoices/deals/${RECEIPTS_DEAL_ID}`,
  ...over,
});

const row = (over: Partial<ReceiptWriteRow>): ReceiptWriteRow => ({
  id: "77777777-0000-4000-8000-000000000001",
  connectionId: "00000000-0000-4000-8000-0000000000d1",
  crmDealId: "88888888-0000-4000-8000-000000000001",
  dealId: RECEIPTS_DEAL_ID,
  externalDealId: "30117482911",
  fields: fields(),
  network: "arc-testnet",
  shadow: false,
  accountType: "DEVELOPER_TEST",
  accountTest: true,
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
  createdAt: "2026-10-13T08:15:00.000Z",
  ...over,
});

/** The write before the last receipt: the deposit alone. */
const EARLIER = fields({
  vestiarion_collected: "3600.00",
  vestiarion_still_owed: "4200.00",
  vestiarion_collection_status: "awaiting_payment",
  vestiarion_last_receipt_date: "2026-10-03",
  vestiarion_last_receipt_amount: "3600.00",
});

export const RECEIPT_ROWS = {
  written: row({ state: "written", readBack: fields(), sentAt: "2026-10-13T08:15:31.000Z", writtenAt: "2026-10-13T08:15:32.000Z", attempts: 1 }),
  earlier: row({ id: "77777777-0000-4000-8000-000000000000", state: "written", fields: EARLIER, readBack: EARLIER, writtenAt: "2026-10-03T14:02:10.000Z", createdAt: "2026-10-03T14:02:00.000Z" }),
  waiting: row({}),
  failed: row({
    state: "failed",
    reason: "no_answer",
    message: "HubSpot did not answer. Vestiarion tries again on its own.",
    attempts: 2,
    nextAttemptAt: "2026-10-13T08:19:00.000Z",
  }),
  conflict: row({
    state: "conflict",
    reason: "changed_in_crm",
    attempts: 1,
    conflicts: [
      { field: "vestiarion_still_owed", ours: "4200", theirs: "0", next: "2200" },
      { field: "vestiarion_collection_status", ours: "awaiting_payment", theirs: "paid_in_full", next: "partly_paid" },
    ],
  }),
  refused: row({
    state: "refused",
    reason: "reality",
    accountType: "STANDARD",
    accountTest: false,
    message: "Not written: payments on Arc testnet and in shadow mode are written only to a HubSpot developer test account or sandbox, never to a real HubSpot account.",
  }),
} satisfies Record<string, ReceiptWriteRow>;

export const RECEIPTS_CONNECTED: Extract<CrmPanelView, { state: "connection" }> = {
  state: "connection",
  connectionId: "00000000-0000-4000-8000-0000000000d1",
  status: { tone: "ok", title: "Connected to northstar-studio.example", detail: ["Last synced 5 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  organisation: "northstar-studio.example",
  toPlan: 1,
  changed: 0,
};

const RULE = "This workspace pays on Arc testnet: its receipts are written only to a HubSpot developer test account or sandbox, never to a real HubSpot account.";

export const RECEIPTS_PANELS = {
  on: {
    on: true,
    allowed: true,
    counts: { written: 6, waiting: 1, failed: 0, conflicts: 1, refused: 0 },
    lastWrittenAt: "2026-10-13T08:15:32.000Z",
    account: "HubSpot says this is a developer test account.",
    rule: RULE,
  },
  allow: { on: false, allowed: false, counts: { written: 0, waiting: 0, failed: 0, conflicts: 0, refused: 0 }, lastWrittenAt: null, account: null, rule: RULE },
} satisfies Record<string, CrmReceiptsPanel>;
