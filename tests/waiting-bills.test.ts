import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivityItem } from "@/lib/agent-activity";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { waitingBills } from "@/lib/notifications/waiting-bills";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The bills a chat is told wait for approval, with why code stopped each one
 * (docs/superpowers/specs/2026-10-24-chat-code-stop-reason-design.md CS3): the rule from each listed bill's latest AP
 * decision, read in one call, so Discord and Telegram say what the bill's row on Bills says rather than the model's
 * sentence. A read that fails leaves the model's sentence, and the bills are still told.
 */

vi.mock("server-only", () => ({}));

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c01";
const INVOICE = (n: number) => `1b6c1c9e-4a4f-4a7e-9b1e-${String(n).padStart(12, "0")}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const stopped = (seq: number, n: number): ActivityItem => ({
  seq, text: `Held Vendor ${n}.`, detail: null, tone: "stopped", path: `/approvals#payable-${INVOICE(n)}`, pathLabel: "Decide in Approvals",
  txHash: null, txUrl: null, network: "arc-testnet", invoiceId: INVOICE(n),
});
const invoice = (n: number, fields: Record<string, unknown> = {}) => ({
  id: INVOICE(n), amount: "120.00", currency: "USDC", status: "held", direction: "payable",
  agent_reasoning: "The invoice is due today, so I am paying now.", counterparties: { name: `Vendor ${n}` }, ...fields,
});
/** A ledger row about a payable, as `ledger_entries_for_targets` returns them, newest first. */
const entry = (seq: number, n: number, detail: Record<string, unknown>) => ({ seq, action: "ap_hold", detail: { invoiceId: INVOICE(n), ...detail } });
const OBSERVED = { observed: { riskLevel: "clear", poReference: "PO-1", goodsReceived: true } };

function workspace(invoices: Array<Record<string, unknown>>, ledger: FakeReply) {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/invoices") return { body: invoices };
    if (sent.path === "/rest/v1/rpc/ledger_entries_for_targets") return ledger;
    return { body: [] };
  });
  const read = (items: ActivityItem[]) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => waitingBills(items));
  const targets = () => fake.requests.filter((sent) => sent.path === "/rest/v1/rpc/ledger_entries_for_targets");
  return { read, targets };
}

afterEach(() => vi.restoreAllMocks());

describe("waitingBills: why code stopped each bill", () => {
  it("reads the waiting bills' ledger entries in one call, and gives each the rule its latest decision was stopped on", async () => {
    const { read, targets } = workspace(
      [invoice(1), invoice(2, { status: "flagged" }), invoice(3), invoice(4, { status: "paid" })],
      {
        body: [
          entry(90, 1, { ...OBSERVED, guardrailBlocked: true, guardrailRule: "counterparty.cooling_off" }),
          entry(89, 2, { ...OBSERVED, guardrailBlocked: false, decision: { action: "pay" }, execution: { resultingStatus: "held", heldBecause: "cash_shortfall" } }),
          entry(88, 3, { ...OBSERVED, guardrailBlocked: false, decision: { action: "hold" }, execution: { resultingStatus: "held", heldBecause: "cash_shortfall" } }),
        ],
      }
    );
    const bills = await read([stopped(51, 1), stopped(52, 2), stopped(53, 3), stopped(54, 4)]);
    expect(bills.map((bill) => [bill.payee, bill.stopRule])).toEqual([
      ["Vendor 1", "counterparty.cooling_off"],
      ["Vendor 2", "treasury.cash_shortfall"],
      // The model held it, while the cash was short too: no code stopped it.
      ["Vendor 3", null],
    ]);
    expect(bills[0].reasoning).toBe("The invoice is due today, so I am paying now.");
    // One call, for the bills still waiting: the one a person decided since is not read.
    expect(targets()).toHaveLength(1);
    expect(targets()[0].body).toMatchObject({ p_invoice_ids: [INVOICE(1), INVOICE(2), INVOICE(3)], p_milestone_ids: [] });
  });

  it("weighs only the latest decision: a refusal decided again since no longer stops it", async () => {
    const { read } = workspace([invoice(1), invoice(2)], {
      body: [
        entry(95, 1, { ...OBSERVED, guardrailBlocked: false, decision: { action: "hold" }, execution: { resultingStatus: "held" } }),
        entry(94, 2, { ...OBSERVED, guardrailBlocked: true, guardrailRule: "invoice.pay_to_differs" }),
        entry(80, 1, { ...OBSERVED, guardrailBlocked: true, guardrailRule: "counterparty.payment_limit" }),
        entry(79, 2, { ...OBSERVED, guardrailBlocked: false, decision: { action: "hold" } }),
      ],
    });
    const bills = await read([stopped(51, 1), stopped(52, 2)]);
    expect(bills.map((bill) => bill.stopRule)).toEqual([null, "invoice.pay_to_differs"]);
  });

  it("passes over an entry that recorded no facts, as the approval card does", async () => {
    const { read } = workspace([invoice(1)], {
      body: [
        // A person's note on the bill, newer than the decision: not a decision.
        entry(97, 1, { guardrailBlocked: true, guardrailRule: "counterparty.high_risk" }),
        entry(96, 1, { ...OBSERVED, guardrailBlocked: true, guardrailRule: "counterparty.payment_limit" }),
      ],
    });
    const [bill] = await read([stopped(51, 1)]);
    expect(bill.stopRule).toBe("counterparty.payment_limit");
  });

  it("still gives the bills when the entries cannot be read, with no rule, and says so once", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { read } = workspace([invoice(1), invoice(2)], { status: 500, body: { message: "upstream timed out" } });
    const bills = await read([stopped(51, 1), stopped(52, 2)]);
    expect(bills.map((bill) => [bill.payee, bill.stopRule, bill.reasoning])).toEqual([
      ["Vendor 1", null, "The invoice is due today, so I am paying now."],
      ["Vendor 2", null, "The invoice is due today, so I am paying now."],
    ]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith("waiting bills: why code stopped them was not read", ORG, "upstream timed out");
  });

  it("reads nothing when no bill waits", async () => {
    const { read, targets } = workspace([invoice(1, { status: "paid" })], { body: [] });
    expect(await read([stopped(51, 1)])).toEqual([]);
    expect(targets()).toEqual([]);
  });
});
