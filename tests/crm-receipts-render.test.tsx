import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/app/actions/hubspot", () => ({
  syncHubSpotNowAction: vi.fn(),
  disconnectHubSpotAction: vi.fn(),
  keepCrmChangeAction: vi.fn(),
  fillCrmEmailAction: vi.fn(),
  setHubSpotReceiptsAction: vi.fn(),
  overwriteHubSpotReceiptAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { CrmReceiptCard } from "@/components/CrmReceiptCard";
import HubSpotPanel, { HUBSPOT_NOTICES } from "@/components/HubSpotPanel";
import type { ReceiptFields } from "@/lib/connectors/crm-receipts";
import type { ReceiptWriteRow } from "@/lib/connectors/crm-receipts-run";
import { receiptView, type CrmReceiptsPanel } from "@/lib/connectors/crm-receipts-view";
import type { CrmPanelView } from "@/lib/connectors/crm-review";

/**
 * Receipts in HubSpot as a person sees them (docs/superpowers/specs/2026-10-13-crm-receipts-design.md R8): on a deal's
 * page, what was written and when, read back from HubSpot, and the next write waiting, failed, in conflict, not allowed
 * yet or not written by the reality rule; on the Settings card, writing on or off and how to allow it.
 */

const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

const FIELDS: ReceiptFields = {
  vestiarion_collected: "2000.00",
  vestiarion_still_owed: "3000.00",
  vestiarion_currency: "USDC",
  vestiarion_collection_status: "partly_paid",
  vestiarion_last_receipt_date: "2026-10-12",
  vestiarion_last_receipt_amount: "2000.00",
  vestiarion_last_receipt_link: `https://explorer.testnet.arc.io/tx/0x${"ab".repeat(32)}`,
  vestiarion_reconciliation: "reconciled",
  vestiarion_evidence_link: "https://www.vestiarion.xyz/o/acme/invoices/deals/deal-1",
};

const row = (fields: Partial<ReceiptWriteRow> = {}): ReceiptWriteRow => ({
  id: "write-1",
  connectionId: "conn-1",
  crmDealId: "crm-1",
  dealId: "deal-1",
  externalDealId: "9001",
  fields: FIELDS,
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
  createdAt: "2026-10-13T07:40:00.000Z",
  ...fields,
});

const written = row({ state: "written", readBack: FIELDS, writtenAt: "2026-10-13T07:45:12.000Z", sentAt: "2026-10-13T07:45:11.000Z" });

const card = (view: ReturnType<typeof receiptView>, canManage = true) =>
  decode(renderToStaticMarkup(<CrmReceiptCard orgSlug="acme" dealId="deal-1" view={view} canManage={canManage} />));

describe("CrmReceiptCard", () => {
  it("shows what was written and when, as HubSpot read it back", () => {
    const markup = card(receiptView({ label: "HubSpot", gate: { ok: true }, latest: written, lastWritten: written }));
    expect(markup).toContain("Receipts in HubSpot");
    expect(markup).toContain("Written to HubSpot");
    expect(markup).toContain("HubSpot read it back the same at 2026-10-13 07:45 UTC");
    expect(markup).toContain("In HubSpot, read back at 2026-10-13 07:45 UTC");
    expect(markup).toContain("2,000.00 USDC");
    expect(markup).toContain("Partly paid");
    expect(markup).toContain("Reconciled");
    expect(markup).toContain("Only payments confirmed on Arc and applied to this deal's invoices are counted.");
  });

  it("shows a write waiting, with what it will write, and the last one written below", () => {
    const next = row({ fields: { ...FIELDS, vestiarion_collected: "5000.00", vestiarion_still_owed: "0.00", vestiarion_collection_status: "paid_in_full" } });
    const markup = card(receiptView({ label: "HubSpot", gate: { ok: true }, latest: next, lastWritten: written }));
    expect(markup).toContain("Waiting to be written to HubSpot");
    expect(markup).toContain("Queued at 2026-10-13 07:40 UTC");
    expect(markup).toContain("What Vestiarion will write");
    expect(markup).toContain("5,000.00 USDC");
    expect(markup).toContain("Last written to HubSpot, read back at 2026-10-13 07:45 UTC");
  });

  it("says a failed write is tried again on its own, and when", () => {
    const failed = row({ state: "failed", reason: "no_answer", message: "HubSpot did not answer. Vestiarion tries again on its own.", nextAttemptAt: "2026-10-13T07:42:00.000Z", attempts: 1 });
    const markup = card(receiptView({ label: "HubSpot", gate: { ok: true }, latest: failed, lastWritten: null }));
    expect(markup).toContain("Not written to HubSpot yet");
    expect(markup).toContain("HubSpot did not answer. Vestiarion tries again on its own.");
    expect(markup).toContain("Vestiarion tries again at 2026-10-13 07:42 UTC.");
    expect(markup).toContain("Nothing written to HubSpot yet.");
  });

  it("shows a conflict field by field, and offers Write Vestiarion's figures to an owner or admin only", () => {
    const conflict = row({ state: "conflict", conflicts: [{ field: "vestiarion_still_owed", ours: "3000", theirs: "0", next: "1000" }], reason: "changed_in_crm" });
    const view = receiptView({ label: "HubSpot", gate: { ok: true }, latest: conflict, lastWritten: written });
    const markup = card(view);
    expect(markup).toContain("Not written: someone changed it in HubSpot");
    expect(markup).toContain("Changed in HubSpot");
    expect(markup).toContain("Vestiarion last wrote");
    expect(markup).toContain("HubSpot holds now");
    expect(markup).toContain("3,000.00 USDC");
    // On a phone, each field stacked rather than a table to scroll.
    expect(markup).toContain("HubSpot holds now: 0.00 USDC");
    expect(markup).toContain("Write Vestiarion's figures to HubSpot");
    expect(markup).toContain(`name="seen" value="${view.seen}"`);
    const viewer = card(view, false);
    expect(viewer).not.toContain("Write Vestiarion's figures to HubSpot");
    expect(viewer).toContain("An owner or admin chooses what HubSpot keeps.");
  });

  it("says writing is not allowed yet, and how an owner or admin allows it", () => {
    const scope = card(receiptView({ label: "HubSpot", gate: { ok: false, reason: "scope" }, latest: null, lastWritten: null }));
    expect(scope).toContain("Not written to HubSpot yet: HubSpot has not allowed Vestiarion to write");
    expect(scope).toContain("Allow writing to HubSpot");
    expect(scope).toContain('href="/o/acme/settings#hubspot"');
    const off = card(receiptView({ label: "HubSpot", gate: { ok: false, reason: "off" }, latest: null, lastWritten: written }));
    expect(off).toContain("Not written to HubSpot: writing is off");
    expect(off).toContain("Write receipts to HubSpot");
    expect(off).toContain("Last written to HubSpot");
  });

  it("says why the reality rule kept a write out of a real HubSpot account", () => {
    const refused = row({
      state: "refused",
      reason: "reality",
      message: "Not written: payments on Arc testnet and in shadow mode are written only to a HubSpot developer test account or sandbox, never to a real HubSpot account.",
    });
    const markup = card(receiptView({ label: "HubSpot", gate: { ok: true }, latest: refused, lastWritten: null }));
    expect(markup).toContain("Not written to HubSpot");
    expect(markup).toContain("never to a real HubSpot account");
  });

  it("never claims more than a read-back: a write HubSpot took and has not read back is waiting, not written", () => {
    const sent = row({ state: "sent", sentAt: "2026-10-13T07:41:00.000Z" });
    const markup = card(receiptView({ label: "HubSpot", gate: { ok: true }, latest: sent, lastWritten: null }));
    expect(markup).toContain("Sent to HubSpot, reading it back");
    expect(markup).not.toContain("Written to HubSpot");
  });
});

const connected: Extract<CrmPanelView, { state: "connection" }> = {
  state: "connection",
  connectionId: "conn-1",
  status: { tone: "ok", title: "Connected to northstar-studio.example", detail: ["Last synced 5 minutes ago."], reconnect: false },
  connected: true,
  revoked: false,
  organisation: "northstar-studio.example",
  toPlan: 0,
  changed: 0,
};

const receipts = (fields: Partial<CrmReceiptsPanel> = {}): CrmReceiptsPanel => ({
  on: false,
  allowed: false,
  counts: { written: 0, waiting: 0, failed: 0, conflicts: 0, refused: 0 },
  lastWrittenAt: null,
  account: null,
  rule: "This workspace pays on Arc testnet: its receipts are written only to a HubSpot developer test account or sandbox, never to a real HubSpot account.",
  ...fields,
});

const panel = (r: CrmReceiptsPanel | null, canManage = true, view: CrmPanelView = connected) =>
  decode(renderToStaticMarkup(<HubSpotPanel orgSlug="acme" view={view} canManage={canManage} notice={null} receipts={r} />));

describe("HubSpotPanel receipts", () => {
  it("offers Allow writing to HubSpot, through the connect page with writing ticked, while HubSpot has not granted it", () => {
    const markup = panel(receipts());
    expect(markup).toContain("Receipts in HubSpot");
    expect(markup).toContain("Allow writing to HubSpot");
    expect(markup).toContain('href="/integrations/hubspot/connect?org=acme&write=1"');
    expect(markup).not.toContain("Stop writing to HubSpot");
    expect(markup).toContain("never to a real HubSpot account");
  });

  it("offers Write receipts to HubSpot once allowed, and Stop writing to HubSpot once on, with how the writes stand", () => {
    expect(panel(receipts({ allowed: true }))).toContain("Write receipts to HubSpot");
    const on = panel(receipts({ on: true, allowed: true, counts: { written: 3, waiting: 1, failed: 0, conflicts: 1, refused: 0 }, account: "HubSpot says this is a developer test account." }));
    expect(on).toContain("Stop writing to HubSpot");
    expect(on).toContain("3 deals written · 1 waiting · 1 changed in HubSpot, waiting on you.");
    expect(on).toContain("HubSpot says this is a developer test account.");
  });

  it("says writing waits while on without the scopes, and keeps the write scopes on a reconnect", () => {
    const markup = panel(receipts({ on: true }), true, { ...connected, status: { ...connected.status, tone: "error", reconnect: true } });
    expect(markup).toContain("HubSpot has not allowed Vestiarion to write: nothing is written until it does.");
    expect(markup).toContain('href="/integrations/hubspot/connect?org=acme&write=1"');
  });

  it("shows a member the state without the controls, and nothing before the migration", () => {
    const member = panel(receipts({ on: true, allowed: true }), false);
    expect(member).toContain("An owner or admin turns writing to HubSpot on or off.");
    expect(member).not.toContain("Stop writing to HubSpot");
    expect(panel(null)).not.toContain("Receipts in HubSpot");
  });

  it("says how allowing writing went", () => {
    expect(HUBSPOT_NOTICES.writing.text).toMatch(/writes receipts to the deals planned from it/);
    expect(HUBSPOT_NOTICES.write_not_granted.text).toMatch(/It still reads your deals/);
  });
});
