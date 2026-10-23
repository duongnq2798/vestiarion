import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

vi.mock("server-only", () => ({}));

import { buildHandoff, handoffCsvChunks, handoffPeriod } from "@/lib/accountant/handoff";

/**
 * What the hand-off reads (docs/superpowers/specs/2026-10-13-accountant-console-design.md A7), as the requests PostgREST
 * would receive in the workspace's scope: the month's decisions from the ledger, the payments created or confirmed in
 * it, the bookings paid in it, each filtered by the workspace, and each row kept in its own currency.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f21";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const NOW = new Date("2026-10-13T09:00:00.000Z");
const MEMBERSHIP = { orgId: ORG, slug: "harbor-bakery", name: "Harbor Bakery", mode: "live" as const, role: "accountant" as const, network: "arc-testnet" as const };

function world() {
  const fake = fakeSupabase((sent: RecordedRequest): FakeReply => {
    if (sent.method === "HEAD") return { body: [], headers: { "content-range": "*/0" } };
    if (sent.path === "/rest/v1/ledger_entries" && sent.params.get("action")?.startsWith("in.")) {
      return { body: [{ seq: 790, ts: "2026-09-12T10:00:00Z", actor: "agent", action: "ap_hold", summary: "Held Coastal Flour Mill", invoice_id: "inv-1", hash: "h1" }] };
    }
    if (sent.path === "/rest/v1/ledger_entries" && sent.params.get("order") === "seq.desc") return { body: [{ seq: 812, hash: "a".repeat(64) }] };
    if (sent.path === "/rest/v1/payment_intents") {
      return {
        body: [
          { id: "pi-1", source_type: "invoice", source_id: "inv-2", status: "confirmed", amount: "1250", token: "USDC", destination: "0xabc", provider: "circle", provider_mode: "live", tx_hash: "0xtx", submitted_at: "2026-09-14T10:00:00Z", created_at: "2026-09-14T09:59:00Z", confirmed_at: "2026-09-14T10:01:00Z" },
          { id: "pi-2", source_type: "milestone", source_id: "ms-1", status: "confirmed", amount: "800", token: "EURC", destination: "0xdef", provider: "simulate", provider_mode: "simulate", tx_hash: null, submitted_at: null, created_at: "2026-09-20T09:00:00Z", confirmed_at: "2026-09-20T09:00:05Z" },
        ],
      };
    }
    if (sent.path === "/rest/v1/accounting_postings" && sent.params.get("paid_on")) {
      return { body: [{ id: "bk-1", provider: "xero", invoice_id: "inv-2", amount: "1250", currency: "USD", paid_on: "2026-09-14", state: "confirmed", reference: "Arc 0xtx", account: { code: "090", name: "Business Bank" }, confirmed_at: "2026-09-15T08:00:00Z" }] };
    }
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

describe("buildHandoff", () => {
  it("reads the month's decisions, payments and bookings in the workspace's scope, each row in its own currency", async () => {
    const { fake, run } = world();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const period = handoffPeriod("2026-09", NOW)!;
    const doc = await run(() => buildHandoff(MEMBERSHIP, period, { now: NOW, origin: "https://www.vestiarion.xyz" }));

    expect(doc).toMatchObject({ format: "vestiarion-handoff/1", workspace: { slug: "harbor-bakery" }, period: { key: "2026-09" }, ledgerHead: { seq: 812 }, cut: false });
    expect(doc.decisions).toEqual([{ seq: 790, at: "2026-09-12T10:00:00Z", actor: "agent", action: "ap_hold", summary: "Held Coastal Flour Mill", invoiceId: "inv-1", hash: "h1" }]);
    expect(doc.payments.map((payment) => [payment.id, payment.amount, payment.token, payment.simulated])).toEqual([
      ["pi-1", "1250", "USDC", false],
      ["pi-2", "800", "EURC", true],
    ]);
    expect(doc.bookings).toEqual([expect.objectContaining({ id: "bk-1", amount: "1250", currency: "USD", account: "090 Business Bank" })]);

    const decisions = fake.requests.find((sent) => sent.path === "/rest/v1/ledger_entries" && sent.params.get("action")?.startsWith("in."))!;
    expect(decisions.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(decisions.params.getAll("ts")).toEqual(["gte.2026-09-01T00:00:00.000Z", "lt.2026-10-01T00:00:00.000Z"]);
    expect(decisions.params.get("action")).toContain("approval_paid");
    const payments = fake.requests.find((sent) => sent.path === "/rest/v1/payment_intents")!;
    expect(payments.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(payments.params.get("or")).toBe(
      "(and(created_at.gte.2026-09-01T00:00:00.000Z,created_at.lt.2026-10-01T00:00:00.000Z),and(confirmed_at.gte.2026-09-01T00:00:00.000Z,confirmed_at.lt.2026-10-01T00:00:00.000Z))"
    );
    const bookings = fake.requests.find((sent) => sent.path === "/rest/v1/accounting_postings" && sent.params.get("paid_on"))!;
    expect(bookings.params.getAll("paid_on")).toEqual(["gte.2026-09-01", "lt.2026-10-01"]);
    // Nothing outside the workspace: every read names it.
    for (const sent of fake.requests.filter((request) => request.method === "GET" && request.path !== "/rest/v1/invitations")) {
      expect(sent.params.get("org_id"), sent.path).toBe(`eq.${ORG}`);
    }
  });
});

/**
 * An accountant's co-signs and what waits for them (docs/superpowers/specs/2026-10-22-accountant-queue-design.md AQ6): a
 * co-sign is listed among a person's decisions, labelled as one, while a first approval that paid nothing yet is not;
 * the console's new kinds are carried into the open items under their titles. Nothing new is signed.
 */
describe("buildHandoff: co-signs and what waits for the accountant", () => {
  const ACCOUNTANT = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";

  function cosignWorld() {
    const fake = fakeSupabase((sent: RecordedRequest): FakeReply => {
      if (sent.method === "HEAD") return { body: [], headers: { "content-range": "*/0" } };
      if (sent.path === "/rest/v1/ledger_entries" && sent.params.get("action")?.startsWith("in.")) {
        return {
          body: [
            { seq: 801, ts: "2026-09-12T10:00:00Z", actor: "human", action: "approval_given", summary: "Approved 900 USDC to Pixel Print; one more approval pays it (payments above 500 USDC need two)", invoice_id: "inv-7", cosign: null, hash: "h801" },
            { seq: 802, ts: "2026-09-12T11:00:00Z", actor: "human", action: "approval_given", summary: "Co-signed 1250 USDC to Cobalt Cloud; an owner, admin or approver's approval pays it (payments above 500 USDC need two)", invoice_id: "inv-8", cosign: "true", hash: "h802" },
            { seq: 803, ts: "2026-09-12T12:00:00Z", actor: "human", action: "approval_paid", summary: "Paid 1250 USDC to Cobalt Cloud (the second of two approvals)", invoice_id: "inv-8", cosign: null, hash: "h803" },
          ],
        };
      }
      if (sent.path === "/rest/v1/ledger_entries" && sent.params.get("order") === "seq.desc") return { body: [{ seq: 812, hash: "a".repeat(64) }] };
      if (sent.path === "/rest/v1/approval_policies") return { body: [{ two_approvals_above: "500", accountant_cosigns: true, payee_lock: false, payee_lock_cooling_hours: 0 }] };
      if (sent.path === "/rest/v1/invoices" && sent.params.get("direction") === "eq.payable") {
        return {
          body: [
            { id: "inv-9", amount: "1250", currency: "USDC", due_date: "2026-10-20", status: "held", decided_at: "2026-10-10T08:00:00Z", created_at: "2026-10-09T08:00:00Z", early_pay_discount_pct: null, discount_due_date: null, counterparty_id: "cp-9", counterparties: { name: "Brightline Ovens", risk_level: "low", address: "0xabc" } },
          ],
        };
      }
      if (sent.path === "/rest/v1/counterparties" && sent.params.get("address_changed_at")) {
        return { body: [{ id: "cp-4", name: "Northwind Packaging", address_changed_at: "2026-10-12T08:00:00Z", address_confirmed_at: null }] };
      }
      if (sent.path === "/rest/v1/rpc/approvers_besides" || sent.path === "/rest/v1/rpc/cosigners_besides") return { body: 1 };
      return { body: [] };
    });
    const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: ACCOUNTANT }), fn);
    return { fake, run };
  }

  it("lists a co-sign under Decisions as a co-sign, and leaves out a first approval that paid nothing", async () => {
    const { fake, run } = cosignWorld();
    const doc = await run(() => buildHandoff(MEMBERSHIP, handoffPeriod("2026-09", NOW)!, { now: NOW, origin: "https://www.vestiarion.xyz" }));
    expect(doc.decisions.map((decision) => [decision.seq, decision.action, decision.cosign ?? false])).toEqual([
      [802, "approval_given", true],
      [803, "approval_paid", false],
    ]);
    const asked = fake.requests.find((sent) => sent.path === "/rest/v1/ledger_entries" && sent.params.get("action")?.startsWith("in."))!;
    expect(asked.params.get("action")).toContain("approval_given");
    expect(asked.params.get("select")).toContain("cosign:detail->>cosign");
    // Only a co-sign's approval_given is read, so the export's most counts decisions alone.
    expect(asked.params.get("or")).toBe("(action.neq.approval_given,detail->>cosign.eq.true)");
    // The CSV says which decision was a co-sign.
    const lines = [...handoffCsvChunks(doc)].join("").split("\r\n");
    expect(lines.find((line) => line.startsWith("decision,802,"))).toContain(",inv-8,co-sign,h802");
    expect(lines.find((line) => line.startsWith("decision,803,"))).toContain(",inv-8,,h803");
    // Reading signs nothing.
    expect(fake.requests.some((sent) => sent.path === "/rest/v1/rpc/append_ledger_entry")).toBe(false);
  });

  it("carries the bills waiting for the accountant's co-sign and the addresses to confirm into the open items, by their titles", async () => {
    const { run } = cosignWorld();
    const doc = await run(() => buildHandoff(MEMBERSHIP, handoffPeriod("2026-09", NOW)!, { now: NOW, origin: "https://www.vestiarion.xyz" }));
    expect(doc.openItems.map((item) => [item.kind, item.title, item.link])).toEqual([
      ["Waiting for your co-sign", "Brightline Ovens", "https://www.vestiarion.xyz/o/harbor-bakery/approvals#payable-inv-9"],
      ["Address to confirm", "Northwind Packaging", "https://www.vestiarion.xyz/o/harbor-bakery/counterparties#counterparty-cp-4"],
    ]);
    expect(doc.unread).toEqual([]);
  });
});
