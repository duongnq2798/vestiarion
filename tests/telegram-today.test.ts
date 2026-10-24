import { describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { MESSAGE_MAX, todayMessage, waitingMessage } from "@/lib/telegram/messages";
import { todayFacts, waitingFacts, type TodayFacts, type WaitingFact } from "@/lib/telegram/today";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * /today and /waiting (Telegram bot design R9): read in the workspace's scope, worked out by code the way the console
 * works them out, and written by code. No model writes a figure.
 */

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const NOW = Date.parse("2026-10-03T08:00:00Z");
const ORIGIN = "https://www.vestiarion.xyz";
/** Fullwidth "/" and "@", built from their code points: they read as the characters, and Telegram links neither. */
const SLASH = String.fromCodePoint(0xff0f);
const AT = String.fromCodePoint(0xff20);
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
    // A payable's card on Approvals is reviewed, as Discord's notice and the decisions message link it; a milestone keeps
    // its own page (docs/superpowers/specs/2026-10-23-telegram-review-links-design.md TG3).
    expect(message.split("\n")).toEqual([
      "<b>Acme</b> · 2 payments wait for a person",
      "",
      "⏸ Jiren 10.00 USDC · held: Over the 5 USDC limit for Jiren.",
      '<a href="https://www.vestiarion.xyz/o/acme/approvals#payable-p2">Review</a>',
      "",
      "⏸ Mr Pop: Landing page 2.00 USDC · held: Its evidence link is not a merged pull request.",
      '<a href="https://www.vestiarion.xyz/o/acme/contractors">Contractors</a>',
      "",
      "Opening a link never approves anything.",
    ]);
    expect(message).not.toContain("guardrail");
  });

  const fact = (id: string, fields: Partial<WaitingFact> = {}): WaitingFact => ({
    kind: "payable", id, name: "Jiren", amount: 10, currency: "USDC", status: "held", reason: "Over the 5 USDC limit for Jiren.", ...fields,
  });

  it("says a payable asked for details waits for details, as Discord and the decisions message say it", () => {
    const message = waitingMessage("Acme", [fact("p3", { status: "awaiting_info", reason: "It needs a purchase order." })], ORIGIN, "acme");
    expect(message).toContain("⏸ Jiren 10.00 USDC · waiting for details: It needs a purchase order.");
    expect(message).not.toContain("waiting for information");
    expect(message).toContain('<a href="https://www.vestiarion.xyz/o/acme/approvals#payable-p3">Review</a>');
  });

  it("shows names and reasons as plain text: escaped, without hidden direction or zero-width characters", () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const message = waitingMessage("A&B", [fact("p2", { name: `Puka ${rlo}& Co`, reason: `Over the <b>limit</b> for Ji${zwsp}ren.` })], ORIGIN, "acme");
    expect(message).toContain("<b>A&amp;B</b> · 1 payment waits for a person");
    // The closing tag's slash, which follows no letter, reads in its fullwidth form, as any such slash does.
    expect(message).toContain(`⏸ Puka &amp; Co 10.00 USDC · held: Over the &lt;b&gt;limit&lt;${SLASH}b&gt; for Jiren.`);
    expect(message).not.toContain(rlo);
    expect(message).not.toContain(zwsp);
  });

  it("gives Telegram no link, @name or /command to make of a name or a reason", () => {
    const message = waitingMessage(
      "Acme",
      [fact("p2", { name: "Acme /disconnect", reason: "Pay it at https://pay.acme-billing.com today, or ask @acme_billing." })],
      ORIGIN,
      "acme"
    );
    expect(message).toContain(`⏸ Acme ${SLASH}disconnect 10.00 USDC · held: Pay it at https:${SLASH}${SLASH}pay[.]acme-billing[.]com today, or ask ${AT}acme_billing.`);
    expect(message).not.toContain("/disconnect");
    expect(message).not.toContain("@acme");
    expect(message).not.toContain("acme-billing.com");
  });

  it("stays under Telegram's limit with long reasons, cutting no link: what does not fit is counted, and the last line stays", () => {
    const facts = Array.from({ length: 10 }, (_, index) => fact(`p${index}`, { name: `Vendor ${index} ${"y".repeat(150)}`, reason: `${"z".repeat(400)}.` }));
    const message = waitingMessage("Acme", facts, ORIGIN, "acme");
    expect(message.length).toBeLessThanOrEqual(MESSAGE_MAX);
    const shown = message.split("\n").filter((line) => line.startsWith("⏸ ")).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(10);
    expect(message.match(/<a href="[^"]*">Review<\/a>/g)).toHaveLength(shown);
    expect(message).toContain(`…and ${10 - shown} more in <a href="https://www.vestiarion.xyz/o/acme/console">the console</a>.`);
    expect(message.endsWith("\n\nOpening a link never approves anything.")).toBe(true);
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

  describe("a payable code stopped (docs/superpowers/specs/2026-10-24-chat-code-stop-reason-design.md CS4)", () => {
    const PAYING = "The invoice is due today, so I am paying now.";
    const invoices = [
      payable("p2", "Jiren", 10, "held", "2026-10-20", { agent_reasoning: PAYING }),
      payable("p6", "Northwind", 12, "held", "2026-10-21", { agent_reasoning: PAYING }),
      payable("p7", "Orbit", 14, "held", "2026-10-22", { agent_reasoning: "No purchase order is on file. Ask for it." }),
    ];
    const observed = { riskLevel: "clear", poReference: null, goodsReceived: true };
    /** The payables' ledger entries, newest first, as `ledger_entries_for_targets` returns them. */
    const ENTRIES = [
      { seq: 72, action: "ap_hold", detail: { invoiceId: "p2", observed, guardrailBlocked: true, guardrailRule: "counterparty.cooling_off" } },
      { seq: 71, action: "ap_hold", detail: { invoiceId: "p6", observed, guardrailBlocked: false, execution: { resultingStatus: "held", heldBecause: "cash_shortfall" } } },
      { seq: 70, action: "ap_hold", detail: { invoiceId: "p7", observed, guardrailBlocked: false, decision: { action: "hold" }, execution: { resultingStatus: "held" } } },
    ];

    function waitingWith(ledger: { status?: number; body: unknown }) {
      const fake = fakeSupabase((sent: RecordedRequest) => {
        switch (sent.path) {
          case "/rest/v1/invoices":
            return { body: invoices };
          case "/rest/v1/milestones":
            return { body: MILESTONES.filter((row) => row.status === "held") };
          case "/rest/v1/rpc/ledger_entries_for_targets":
            return ledger;
          default:
            return { body: [] };
        }
      });
      const facts = () => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), () => waitingFacts());
      return { fake, facts };
    }

    it("says why code stopped it, as its row on Bills does, in place of the model's sentence; a milestone keeps its own", async () => {
      const { fake, facts } = waitingWith({ body: ENTRIES });
      const read = await facts();
      expect(read.map((fact) => [fact.id, fact.reason])).toEqual([
        ["p2", "Code stopped it: the payment address changed recently, and the payee lock makes it wait."],
        ["p6", "Code stopped it: the operating wallet did not hold the cash it needs."],
        // The model held it: its own sentence says why.
        ["p7", "No purchase order is on file."],
        ["m1", "Its evidence link is not a merged pull request."],
      ]);
      const targets = fake.requests.filter((sent) => sent.path === "/rest/v1/rpc/ledger_entries_for_targets");
      expect(targets).toHaveLength(1);
      expect(targets[0].body).toMatchObject({ p_invoice_ids: ["p2", "p6", "p7"], p_milestone_ids: [] });

      const message = waitingMessage("Acme", read, ORIGIN, "acme");
      expect(message).toContain("⏸ Jiren 10.00 USDC · held: Code stopped it: the payment address changed recently, and the payee lock makes it wait.");
      expect(message).not.toContain("paying now");
    });

    it("still lists them with the model's sentence when the entries cannot be read", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { facts } = waitingWith({ status: 500, body: { message: "upstream timed out" } });
        const read = await facts();
        expect(read.map((fact) => [fact.id, fact.reason])).toEqual([
          ["p2", PAYING],
          ["p6", PAYING],
          ["p7", "No purchase order is on file."],
          ["m1", "Its evidence link is not a merged pull request."],
        ]);
        expect(logged).toHaveBeenCalledWith("waiting: why code stopped them was not read", "upstream timed out");
      } finally {
        logged.mockRestore();
      }
    });
  });

  it("says so when nothing waits", async () => {
    const facts = await workspace([], [])(() => waitingFacts());
    expect(facts).toEqual([]);
    expect(waitingMessage("Acme", facts, ORIGIN, "acme")).toContain("Nothing waits for a person");
  });
});
