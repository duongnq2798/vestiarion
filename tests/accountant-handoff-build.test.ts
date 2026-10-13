import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

vi.mock("server-only", () => ({}));

import { buildHandoff, handoffPeriod } from "@/lib/accountant/handoff";

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
