import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { asciiOnly, formatDigest, readDigestFacts, type DigestFacts } from "@/lib/traction-digest";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * The shadow mode digest (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S8): per workspace, each decision of
 * the agent's on a real bill, the person's verdict, the amount and the Arc testnet transaction, and how often the
 * person agreed. ASCII with no blank line, so it goes into `arc-canteen update-traction` as it is printed.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-0000000d1a51";
const TX = `0x${"ab".repeat(32)}`;

const facts = (over: Partial<DigestFacts> = {}): DigestFacts => ({
  slug: "northstar",
  network: "Arc testnet",
  explorer: "https://testnet.arcscan.app",
  shadow: { currency: "USDC", startedAt: "2026-10-07T08:00:00Z" },
  since: "2026-10-07T00:00:00Z",
  decisions: [
    {
      seq: 41,
      ts: "2026-10-07T09:15:00Z",
      action: "ap_pay",
      payee: "Điện lực Hà Nội",
      reasoning: "Matches PO-12, the goods are received and it is within Điện lực Hà Nội's limit.",
      amount: 96.39,
      currency: "USDC",
      bill: null,
      verdict: { verdict: "agree", reason: null },
      txHash: TX,
    },
    {
      seq: 44,
      ts: "2026-10-08T10:05:00Z",
      action: "ap_hold",
      payee: "Acme Supplies",
      reasoning: "The amount is twice Acme Supplies's usual bill.",
      amount: 1450.12,
      currency: "USDC",
      bill: { amount: 1250, currency: "EUR" },
      verdict: { verdict: "disagree", reason: "We agreed the new price “last week”." },
      txHash: null,
    },
    {
      seq: 47,
      ts: "2026-10-08T11:00:00Z",
      action: "ap_schedule",
      payee: "Acme Supplies",
      reasoning: null,
      amount: 20,
      currency: "USDC",
      bill: null,
      verdict: null,
      txHash: null,
    },
  ],
  ...over,
});

describe("formatDigest", () => {
  it("says the workspace, how often the person agreed, and each decision with its verdict and transaction", () => {
    expect(formatDigest(facts()).split("\n")).toEqual([
      "Vestiarion shadow mode, workspace northstar on Arc testnet: on since Oct 7, 2026, bills in USDC.",
      "3 decisions since Oct 7, 2026. Agreed with 1 of 2 verdicts (50%); 1 decision has no verdict yet.",
      "- Oct 7, 2026, 09:15 UTC: pay Dien luc Ha Noi 96.39 USDC. Agent: Matches PO-12, the goods are received and it is within Dien luc Ha Noi's limit. Verdict: agreed. Tx: https://testnet.arcscan.app/tx/" +
        TX,
      "- Oct 8, 2026, 10:05 UTC: hold Acme Supplies 1,250.00 EUR (1,450.12 USDC). Agent: The amount is twice Acme Supplies's usual bill. Verdict: disagreed: We agreed the new price \"last week\".",
      "- Oct 8, 2026, 11:00 UTC: schedule Acme Supplies 20.00 USDC. Verdict: none yet.",
    ]);
  });

  it("names each payee by a letter when asked, in the agent's reasoning too", () => {
    const lines = formatDigest(facts(), { hidePayees: true }).split("\n");
    expect(lines[2]).toContain("pay Supplier A 96.39 USDC. Agent: Matches PO-12, the goods are received and it is within Supplier A's limit.");
    expect(lines[3]).toContain("hold Supplier B 1,250.00 EUR (1,450.12 USDC). Agent: The amount is twice Supplier B's usual bill.");
    expect(lines[4]).toContain("schedule Supplier B 20.00 USDC.");
    expect(lines.join("\n")).not.toMatch(/Acme|Dien/);
  });

  it("is ASCII with no blank line, so the canteen takes it whole", () => {
    const digest = formatDigest(facts());
    expect(digest).toMatch(/^[\x20-\x7E\n]+$/);
    expect(digest.split("\n").every((line) => line.trim() !== "")).toBe(true);
  });

  it("says when shadow mode is off now, and when there is no verdict to count", () => {
    const lines = formatDigest(facts({ shadow: null, decisions: [] })).split("\n");
    expect(lines).toEqual(["Vestiarion shadow mode, workspace northstar on Arc testnet: off now.", "0 decisions since Oct 7, 2026. No verdicts yet."]);
  });
});

describe("asciiOnly", () => {
  it("keeps the letters of a Vietnamese or French name, and plain marks for typographic ones", () => {
    expect(asciiOnly("Điện lực – “Café” … ok · ₫")).toBe('Dien luc - "Cafe" ... ok - ');
  });
});

describe("readDigestFacts", () => {
  const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

  function workspace(over: { shadow?: Record<string, unknown> | null } = {}) {
    return (request: RecordedRequest) => {
      if (request.path === "/rest/v1/shadow_modes") return { body: over.shadow === null ? [] : [over.shadow ?? { currency: "USDC", started_at: "2026-10-07T08:00:00Z", started_by: null }] };
      if (request.path === "/rest/v1/ledger_entries") {
        return {
          body: [
            // Before shadow mode started and never given a verdict: not a shadow decision.
            { seq: 30, ts: "2026-10-07T07:00:00Z", action: "ap_pay", detail: { invoiceId: "inv-0", decision: { reasoning: "Early." } } },
            { seq: 41, ts: "2026-10-07T09:15:00Z", action: "ap_pay", detail: { invoiceId: "inv-1", decision: { reasoning: "Matches PO-12. More words." } } },
            { seq: 44, ts: "2026-10-08T10:05:00Z", action: "ap_hold", detail: { invoiceId: "inv-2", decision: { reasoning: "Twice the usual bill." } } },
            { seq: 45, ts: "2026-10-08T10:06:00Z", action: "ap_pay", detail: { invoiceId: "inv-1", decision: { reasoning: "Decided again." } } },
          ],
        };
      }
      if (request.path === "/rest/v1/decision_verdicts") {
        return { body: [{ entry_seq: 41, verdict: "agree", reason: null }, { entry_seq: 44, verdict: "disagree", reason: "Not ours." }] };
      }
      if (request.path === "/rest/v1/invoices") {
        return {
          body: [
            { id: "inv-1", amount: "96.39", currency: "USDC", tx_ref: TX, original_currency: null, original_amount: null, counterparties: { name: "Dien luc" } },
            { id: "inv-2", amount: "1450.12", currency: "USDC", tx_ref: null, original_currency: "EUR", original_amount: "1250", counterparties: { name: "Acme" } },
          ],
        };
      }
      return { body: [] };
    };
  }

  it("reads the agent's decisions on bills since the day, their verdicts and their bills, and puts a payment's transaction on its newest decision", async () => {
    const fake = fakeSupabase(workspace());
    const read = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => readDigestFacts({ slug: "northstar", since: "2026-10-07T00:00:00Z" }));

    expect(read.shadow).toEqual({ currency: "USDC", startedAt: "2026-10-07T08:00:00Z" });
    expect(read.decisions.map((decision) => decision.seq)).toEqual([41, 44, 45]);
    expect(read.decisions[0]).toMatchObject({ payee: "Dien luc", amount: 96.39, currency: "USDC", reasoning: "Matches PO-12.", verdict: { verdict: "agree", reason: null }, txHash: null });
    expect(read.decisions[1]).toMatchObject({ payee: "Acme", amount: 1450.12, bill: { amount: 1250, currency: "EUR" }, verdict: { verdict: "disagree", reason: "Not ours." } });
    expect(read.decisions[2]).toMatchObject({ seq: 45, verdict: null, txHash: TX });

    const entries = fake.requests.find((r) => r.path === "/rest/v1/ledger_entries");
    expect(entries?.params.get("actor")).toBe("eq.agent");
    expect(entries?.params.get("ts")).toBe("gte.2026-10-07T00:00:00Z");
    expect(entries?.params.get("order")).toBe("seq.asc");
    expect(fake.requests.find((r) => r.path === "/rest/v1/decision_verdicts")?.params.get("entry_seq")).toBe("in.(30,41,44,45)");
  });

  it("keeps only decisions given a verdict once shadow mode is off", async () => {
    const fake = fakeSupabase(workspace({ shadow: null }));
    const read = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => readDigestFacts({ slug: "northstar", since: "2026-10-07T00:00:00Z" }));
    expect(read.shadow).toBeNull();
    expect(read.decisions.map((decision) => decision.seq)).toEqual([41, 44]);
  });
});
