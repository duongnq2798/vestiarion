import { describe, expect, it } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { todayMessage, waitingMessage } from "@/lib/telegram/messages";
import { todayFacts, waitingFacts, type TodayFacts } from "@/lib/telegram/today";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * /today and /waiting (Telegram bot design R9): read in the workspace's scope, worked out by code the way the console
 * works them out, and written by code. No model writes a figure.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const NOW = Date.parse("2026-10-03T08:00:00Z");
const ORIGIN = "https://www.vestiarion.xyz";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });

const payable = (id: string, name: string, amount: number, status: string, due: string, extra: Record<string, unknown> = {}) => ({
  id, direction: "payable", amount, currency: "USDC", status, due_date: `${due}T12:00:00+00:00`, scheduled_for: null,
  agent_reasoning: null, counterparties: { name }, ...extra,
});

const INVOICES = [
  payable("p1", "Centronex", 30, "pending", "2026-10-04"),
  payable("p2", "Jiren", 10, "held", "2026-10-20", { agent_reasoning: "Over the 5 USDC limit for Jiren. A person should decide. [guardrail: counterparty.payment_limit]" }),
  payable("p3", "Puka Hotel", 5, "scheduled", "2026-10-09", { scheduled_for: "2026-10-05" }),
  payable("p4", "Trading Handrock", 8, "pending", "2026-10-06", { currency: "EURC" }),
  payable("p5", "Loto", 1.2, "paid", "2026-10-01"),
];

const MILESTONES = [
  { id: "m1", title: "Landing page", amount: 2, status: "held", agent_reasoning: "Its evidence link is not a merged pull request.", escrow_state: null, counterparties: { name: "Mr Pop" } },
  { id: "m2", title: "Thumbnails", amount: 4, status: "verified", agent_reasoning: null, escrow_state: null, counterparties: { name: "Designer B" } },
];

function workspace(invoices = INVOICES, milestones = MILESTONES) {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    switch (sent.path) {
      case "/rest/v1/accounts":
        return { body: [{ id: "a1", name: "Operating", kind: "operating", token: "USDC", balance: "100" }, { id: "a2", name: "Reserve", kind: "reserve", token: "USDC", balance: "50" }] };
      case "/rest/v1/invoices": {
        const statuses = sent.params.get("status");
        const waiting = statuses?.startsWith("in.") ? statuses.slice(4, -1).split(",") : null;
        return { body: waiting ? invoices.filter((row) => row.direction === "payable" && waiting.includes(row.status)) : invoices };
      }
      case "/rest/v1/milestones": {
        const status = sent.params.get("status");
        return { body: status ? milestones.filter((row) => `eq.${row.status}` === status) : milestones };
      }
      case "/rest/v1/ledger_entries":
        return { body: [{ ts: "2026-10-03T07:55:00Z" }] };
      default:
        return { body: [] };
    }
  });
  return <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
}

describe("todayFacts", () => {
  it("works out safe to spend today as the console does, and what waits and what is paid next", async () => {
    const facts = await workspace()(() => todayFacts(NOW));

    // 100 in the operating wallet and 50 in the USYC reserve, less 45 USDC due within 30 days (30 + 10 held + 5
    // scheduled), less the 4 USDC verified milestone, less a 15% cushion on the 39 USDC leaving within 7 days
    // (30 + 5 + 4): 150 - 45 - 4 - 5.85.
    expect(facts.safeToSpend).toBe(95.15);
    expect(facts.cash).toBe(100);
    expect(facts.reserve).toBe(50);
    expect(facts.dueIn30d).toBe(45);
    expect(facts.eurcLeftOut).toBe(8);
    // Jiren's held payable, and Mr Pop's held milestone.
    expect(facts.waiting).toBe(2);
    expect(facts.scheduled).toEqual([{ name: "Puka Hotel", amount: 5, currency: "USDC", on: "2026-10-05" }]);
    expect(facts.lastCycleAt).toBe("2026-10-03T07:55:00Z");
  });
});

describe("todayMessage", () => {
  it("names the USYC reserve it counts, and only when there is one", () => {
    const base = { safeToSpend: 154.38, cash: 0.23, reserve: 154.381758, dueIn30d: 0.2, eurcLeftOut: 0, shortOn: null, waiting: 0, scheduled: [], lastCycleAt: null };
    expect(todayMessage("testnet-2", base, "https://www.vestiarion.xyz/o/testnet-2/console")).toContain(
      "The operating wallet holds 0.23 USDC and the USYC reserve 154.381758 USDC, back in seconds; 0.20 USDC is due in the next 30 days."
    );
    expect(todayMessage("testnet-2", { ...base, reserve: 0 }, "https://www.vestiarion.xyz/o/testnet-2/console")).not.toContain("USYC reserve");
  });

  const facts: TodayFacts = {
    safeToSpend: 45.15, cash: 100, reserve: 0, dueIn30d: 45, eurcLeftOut: 8, shortOn: null, waiting: 2,
    scheduled: [{ name: "Puka & Co", amount: 5, currency: "USDC", on: "2026-10-05" }], lastCycleAt: "2026-10-03T07:55:00Z",
  };

  it("says the figures, what waits, and what the agent pays next", () => {
    const message = todayMessage("Acme", facts, `${ORIGIN}/o/acme/console`);
    expect(message).toContain("Safe to spend today: 45.15 USDC");
    expect(message).toContain("8.00 EURC");
    expect(message).toContain("2 payments wait for a person");
    expect(message).toContain("Oct 5: Puka &amp; Co 5.00 USDC");
    expect(message).toContain('<a href="https://www.vestiarion.xyz/o/acme/console">');
  });

  it("says when nothing waits, and when the wallet runs short", () => {
    const message = todayMessage("Acme", { ...facts, waiting: 0, shortOn: "2026-10-10", scheduled: [] }, `${ORIGIN}/o/acme/console`);
    expect(message).toContain("Nothing waits for a person");
    expect(message).toContain("runs short on Oct 10");
  });
});

describe("waitingFacts and waitingMessage", () => {
  it("lists the held payables and milestones, each with the first sentence of why, and where to decide it", async () => {
    const facts = await workspace()(() => waitingFacts());
    expect(facts).toEqual([
      { kind: "payable", id: "p2", name: "Jiren", amount: 10, currency: "USDC", status: "held", reason: "Over the 5 USDC limit for Jiren." },
      { kind: "milestone", id: "m1", name: "Mr Pop: Landing page", amount: 2, currency: "USDC", status: "held", reason: "Its evidence link is not a merged pull request." },
    ]);

    const message = waitingMessage("Acme", facts, ORIGIN, "acme");
    expect(message).toContain("Jiren 10.00 USDC");
    expect(message).toContain('<a href="https://www.vestiarion.xyz/o/acme/approvals#payable-p2">');
    expect(message).toContain('<a href="https://www.vestiarion.xyz/o/acme/contractors">');
    expect(message).not.toContain("guardrail");
  });

  it("says a payment held in shadow mode waits for a verdict, and links to give it (review minor 7)", async () => {
    const fake = fakeSupabase((sent: RecordedRequest) => {
      switch (sent.path) {
        case "/rest/v1/shadow_modes":
          return { body: [{ currency: "USDC", started_at: "2026-10-03T00:00:00Z", started_by: null }] };
        case "/rest/v1/invoices":
          return { body: [payable("p2", "Jiren", 10, "held", "2026-10-20", { agent_reasoning: "Matched and within the limit. [shadow mode: held for a person to agree; nothing is paid until they do]" })] };
        case "/rest/v1/ledger_entries":
          return sent.params.has("detail->>invoiceId")
            ? { body: [{ seq: 41, ts: "2026-10-03T07:00:00Z", detail: { invoiceId: "p2", execution: { resultingStatus: "held", heldBecause: "shadow_verdict" } } }] }
            : { body: [] };
        default:
          return { body: [] };
      }
    });
    const facts = await runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => waitingFacts());
    expect(facts).toEqual([{ kind: "payable", id: "p2", name: "Jiren", amount: 10, currency: "USDC", status: "held", reason: "Matched and within the limit.", forVerdict: true }]);

    const message = waitingMessage("Acme", facts, ORIGIN, "acme");
    expect(message).toContain("Jiren 10.00 USDC · waits for your verdict");
    expect(message).toContain('<a href="https://www.vestiarion.xyz/o/acme/approvals#payable-p2">Give your verdict</a>');
  });

  it("says so when nothing waits", async () => {
    const facts = await workspace([], [])(() => waitingFacts());
    expect(facts).toEqual([]);
    expect(waitingMessage("Acme", facts, ORIGIN, "acme")).toContain("Nothing waits for a person");
  });
});
