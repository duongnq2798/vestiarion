import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * The agent's weekly brief (docs/superpowers/specs/2026-10-18-weekly-brief-design.md): on a Monday, once per ISO week
 * (W1), to the members who decide payments (W2), with figures code worked out (W3); sent at once to one member from
 * Settings (W4); never in the way (W5). The book is our test workspace's on Oct 17.
 */

const { sendMock, ledgerMock, claimMock, recipientsMock } = vi.hoisted(() => ({ sendMock: vi.fn(), ledgerMock: vi.fn(), claimMock: vi.fn(), recipientsMock: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ emailSettingsFromEnv: () => ({ apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" }), sendEmail: sendMock }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: claimMock }));
vi.mock("@/lib/notifications/waiting", () => ({ decidingRecipients: recipientsMock, DIGEST_MAX_RECIPIENTS: 25, DIGEST_SEND_DEADLINE_MS: 60_000 }));
vi.mock("@/lib/auth/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth/env")>()), siteOrigin: () => "https://www.vestiarion.xyz" }));

import { briefDue, briefWorthSending, isoWeek, payeeWeek, sendWeeklyBrief, weeklyBriefFacts, WEEKLY_BRIEF_FAILED, WEEKLY_BRIEF_SENT } from "@/lib/notifications/weekly-brief";
import { briefSentences, payeeSentences, weeklyBriefEmail, type WeeklyBriefFacts } from "@/lib/email/weekly-brief";
import { db } from "@/lib/dal";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000e0e";
const MONDAY = Date.parse("2026-10-19T06:00:00Z");
const SATURDAY = Date.parse("2026-10-17T18:00:00Z");

const bill = (id: string, amount: number, status: string, due: string, scheduled: string | null = null) => ({
  id, direction: "payable", counterparty_id: "cobalt", status, amount: String(amount), currency: "USDC", due_date: `${due}T12:00:00+00:00`,
  scheduled_for: scheduled ? `${scheduled}T00:00:00+00:00` : null, created_at: "2026-10-17T08:00:00Z", memo: null, po_reference: null, counterparties: { name: "Cobalt Cloud" },
});
const BOOK = [
  bill("b-140", 140, "scheduled", "2026-10-22", "2026-10-22"),
  bill("b-150", 150, "held", "2026-10-23"),
  bill("b-45-a", 45, "held", "2026-10-24"),
  bill("b-45-b", 45, "held", "2026-10-25"),
  { ...bill("r-40", 40, "pending", "2026-10-24"), direction: "receivable", counterparty_id: "harbor", counterparties: { name: "Harbor Design Studio" } },
];

interface World {
  operating?: string;
  /** The ledger's brief entries, oldest first, with their time. */
  briefs?: Array<{ action: string; ts?: string; detail: Record<string, unknown> }>;
  shadow?: boolean;
  book?: Array<Record<string, unknown>>;
  /** The person's signed verdicts, in shadow mode. */
  verdicts?: Array<{ ts: string; verdict: string }>;
}
function world(w: World = {}) {
  return fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: { name: "Pinecrest Studio", slug: "pinecrest-studio" } };
    if (request.path === "/rest/v1/shadow_modes") return { body: w.shadow ? [{ currency: "USD", started_at: "2026-10-08T09:00:00Z", started_by: null }] : [] };
    if (request.path === "/rest/v1/accounts") return { body: [{ kind: "operating", balance: w.operating ?? "150.03" }, { kind: "reserve", balance: "0" }] };
    if (request.path === "/rest/v1/invoices") {
      const book = w.book ?? BOOK;
      const statuses = request.params.get("status")?.match(/^in\.\((.*)\)$/)?.[1].split(",") ?? [];
      const direction = request.params.get("direction")?.replace(/^eq\./, "");
      return { body: book.filter((row) => statuses.includes(row.status as string) && (!direction || row.direction === direction)) };
    }
    if (request.path === "/rest/v1/milestones") return { body: [] };
    if (request.path === "/rest/v1/receivable_allocations") return { body: [] };
    if (request.path === "/rest/v1/payment_intents") return { body: [{ amount: "140", token: "USDC" }, { amount: "1", token: "USDC" }, { amount: "5", token: "EURC" }] };
    if (request.path === "/rest/v1/ledger_entries") {
      const action = request.params.get("action");
      if (action === "eq.decision_verdict") {
        const from = request.params.get("ts")?.replace(/^gte\./, "") ?? "";
        expect(from).toBe("2026-10-08T09:00:00Z");
        return { body: (w.verdicts ?? []).map((row) => ({ ts: row.ts, detail: { verdict: row.verdict } })) };
      }
      if (action === "in.(ar_received,ar_payment_applied)") return { body: [{ detail: { amount: 29.925, currency: "USDC" } }, { detail: { amount: 5, currency: "EURC" } }] };
      const briefs = w.briefs ?? [];
      // The week's last word, previews aside, newest first.
      if (action === `in.(${WEEKLY_BRIEF_SENT},${WEEKLY_BRIEF_FAILED})`) {
        const week = request.params.get("detail->>week")?.replace(/^eq\./, "");
        expect(request.params.get("or")).toBe("(detail->>preview.is.null,detail->>preview.neq.true)");
        const rows = briefs.filter((entry) => entry.detail.week === week && entry.detail.preview !== true).reverse();
        return { body: rows.slice(0, 1).map((entry) => ({ action: entry.action })) };
      }
      // A member's own recent preview.
      if (action === `eq.${WEEKLY_BRIEF_SENT}`) {
        const by = request.params.get("detail->>by")?.replace(/^eq\./, "");
        const since = Date.parse(request.params.get("ts")?.replace(/^gte\./, "") ?? "");
        return { body: briefs.filter((entry) => entry.detail.by === by && Date.parse(entry.ts ?? "") >= since) };
      }
      if (request.params.get("actor") === "eq.agent") return { body: [{ seq: 1 }, { seq: 2 }, { seq: 3 }] };
      return { body: [] };
    }
    return { body: [] };
  });
}
const run = <T,>(client: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>): Promise<T> => runWith(orgTestContext({ config, client: client.client, orgId: ORG }), fn);

beforeEach(() => {
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "email-1" });
  ledgerMock.mockReset().mockResolvedValue(undefined);
  claimMock.mockReset().mockResolvedValue({ seq: 1 });
  recipientsMock.mockReset().mockResolvedValue([{ userId: "u1", email: "owner@pinecrest.example", role: "owner" }, { userId: "u2", email: "approver@pinecrest.example", role: "approver" }]);
});

describe("when the brief goes (W1)", () => {
  it("names the ISO week, which starts on Monday", () => {
    expect(isoWeek(new Date("2026-10-19T00:00:00Z"))).toBe("2026-W43");
    expect(isoWeek(new Date("2026-10-18T23:59:59Z"))).toBe("2026-W42");
    expect(isoWeek(new Date("2027-01-01T12:00:00Z"))).toBe("2026-W53");
  });

  it("goes on a Monday, once", () => {
    expect(briefDue(new Date(MONDAY), false)).toBe(true);
    expect(briefDue(new Date(MONDAY), true)).toBe(false);
    expect(briefDue(new Date(SATURDAY), false)).toBe(false);
  });
});

describe("what the brief says (W3)", () => {
  it("works out the 7 whole days before today from the workspace's rows", async () => {
    const client = world();
    const facts = await run(client, () => weeklyBriefFacts(db(), Date.parse("2026-10-19T06:00:00Z")));
    const paid = client.requests.find((r) => r.path === "/rest/v1/payment_intents");
    expect(paid?.params.get("status")).toBe("eq.confirmed");
    expect(paid?.params.getAll("confirmed_at")).toEqual(["gte.2026-10-12T00:00:00.000Z", "lt.2026-10-19T00:00:00.000Z"]);
    const decisions = client.requests.find((r) => r.path === "/rest/v1/ledger_entries" && r.params.get("actor") === "eq.agent");
    expect(decisions?.params.get("action")).toBe("in.(ap_pay,ap_schedule,ap_hold,ap_request_info,ap_flag_fraud,milestone_release,milestone_hold)");
    expect(facts).toMatchObject({
      week: "2026-W43",
      from: "2026-10-12",
      to: "2026-10-18",
      paid: { count: 2, usdc: 141 },
      received: { count: 1, usdc: 29.925 },
      decisions: 3,
      waiting: 3,
      next7: { count: 4, usdc: 380, expectedUsdc: 40 },
      cash: { operating: 150.03, reserve: 0, short: { shortOn: "2026-10-23", lowestOn: "2026-10-25" } },
    });
  });

  it("says each figure, what is short up to the cent, and the bills ahead", () => {
    const facts: WeeklyBriefFacts = {
      week: "2026-W43", from: "2026-10-12", to: "2026-10-18",
      paid: { count: 2, usdc: 141 }, received: { count: 1, usdc: 29.925 }, decisions: 3, waiting: 3,
      next7: { count: 6, usdc: 470, expectedUsdc: 40, lines: [{ day: "2026-10-22", label: "Cobalt Cloud", amount: 140, note: "scheduled" }, { day: "2026-10-23", label: "Cobalt Cloud", amount: 150, note: "held" }] },
      cash: { operating: 150.03, reserve: 0, short: { shortOn: "2026-10-23", shortBy: 139.97245, lowestOn: "2026-10-25", need: 229.97 } },
    };
    const said = briefSentences(facts);
    expect(said.lastWeek).toEqual(["Paid 2 payments, 141.00 USDC in all.", "Customers paid 1 invoice, 29.93 USDC.", "Made 3 decisions, each signed with its reasoning."]);
    expect(said.waiting).toBe("3 payments wait for a decision from you.");
    expect(said.ahead).toBe("6 payments leave in the next 7 days, 470.00 USDC in all, and customers owe 40.00 USDC by then.");
    expect(said.lines).toEqual(["Oct 22: Cobalt Cloud, 140.00 USDC (scheduled)", "Oct 23: Cobalt Cloud, 150.00 USDC (held for you)"]);
    expect(said.more).toBe(4);
    expect(said.cash).toBe("The cash runs short on Oct 23: 139.98 USDC short that day, and 229.97 USDC by Oct 25.");

    const email = weeklyBriefEmail({ orgName: "Pinecrest & <Co>", facts, links: { console: "https://x/console", approvals: "https://x/approvals", plan: "https://x/invoices?tab=plan" }, origin: "https://x" });
    expect(email.subject).toBe("Pinecrest & <Co>: the cash runs short on Oct 23 · your week with the agent");
    expect(email.html).toContain("Pinecrest &amp; &lt;Co&gt;");
    expect(email.html).not.toContain("<Co>");
    expect(email.html).toContain("Decide what waits");
    expect(email.text).toContain("Approvals: https://x/approvals");
  });

  it("says the cash covers it when it does, and is not sent from a quiet workspace", () => {
    const quiet: WeeklyBriefFacts = {
      week: "2026-W43", from: "2026-10-12", to: "2026-10-18", paid: { count: 0, usdc: 0 }, received: { count: 0, usdc: 0 }, decisions: 0, waiting: 0,
      next7: { count: 0, usdc: 0, expectedUsdc: 0, lines: [] }, cash: { operating: 20, reserve: 5, short: null },
    };
    expect(briefSentences(quiet).cash).toBe("The cash covers everything due in the next 30 days: 25.00 USDC in the wallet and the reserve.");
    expect(briefWorthSending(quiet)).toBe(false);
    expect(briefWorthSending({ ...quiet, decisions: 1 })).toBe(true);
  });
});

describe("payee addresses in the brief (docs/superpowers/specs/2026-10-22-weekly-brief-payee-lock-design.md WP1, WP2)", () => {
  const none = { lockOn: true, changed: 0, confirmed: 0, held: 0, asked: 0, notMe: 0, frozen: 0 };
  const quiet: WeeklyBriefFacts = {
    week: "2026-W43", from: "2026-10-12", to: "2026-10-18", paid: { count: 0, usdc: 0 }, received: { count: 0, usdc: 0 }, decisions: 0, waiting: 0,
    next7: { count: 0, usdc: 0, expectedUsdc: 0, lines: [] }, cash: { operating: 20, reserve: 0, short: null },
  };

  it("says a frozen payee first, then the changes, the holds and the questions, and nothing in a quiet week", () => {
    expect(payeeSentences({ ...none, changed: 2, confirmed: 1, held: 1, asked: 2, notMe: 1, frozen: 1 })).toEqual([
      "1 payee is frozen: their contact said they did not make a change to their address. An owner or admin unfreezes one on Counterparties after checking with them.",
      "2 payee addresses changed, and 1 address was confirmed.",
      "The agent held 1 payment for an address no one had confirmed, or one an invoice asked for instead.",
      "2 payees' contacts were asked whether they made a change, and 1 said they did not.",
    ]);
    expect(payeeSentences({ ...none, confirmed: 3 })).toEqual(["3 payee addresses were confirmed."]);
    expect(payeeSentences(none)).toEqual([]);
    expect(payeeSentences(null)).toEqual([]);
  });

  it("suggests the payee lock where it is off and something happened", () => {
    expect(payeeSentences({ ...none, lockOn: false, changed: 1 })).toEqual([
      "1 payee address changed.",
      "The payee lock is off: turn it on in Settings to have a second person record how each changed address was checked.",
    ]);
    expect(payeeSentences({ ...none, lockOn: false })).toEqual([]);
  });

  it("is reason enough to send the brief, and has its own section", () => {
    expect(briefWorthSending({ ...quiet, payees: none })).toBe(false);
    const facts = { ...quiet, payees: { ...none, frozen: 1 } };
    expect(briefWorthSending(facts)).toBe(true);
    const email = weeklyBriefEmail({ orgName: "Pinecrest", facts, links: { console: "https://x/console", approvals: "https://x/approvals", plan: "https://x/plan" }, origin: "https://x" });
    expect(email.text).toContain("Payee addresses\n- 1 payee is frozen");
    expect(email.html).toContain("Payee addresses");
    expect(weeklyBriefEmail({ orgName: "Pinecrest", facts: quiet, links: { console: "c", approvals: "a", plan: "p" }, origin: "https://x" }).text).not.toContain("Payee addresses");
  });

  it("reads the week's entries, the agent's holds for an address, the lock and the frozen payees", async () => {
    const client = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") return { body: { name: "Pinecrest Studio", slug: "pinecrest-studio" } };
      if (request.path === "/rest/v1/approval_policies") return { body: [{ payee_lock: true, payee_lock_cooling_hours: 0 }] };
      if (request.path === "/rest/v1/counterparties") return { body: [{ id: "c1" }] };
      if (request.path === "/rest/v1/ledger_entries" && request.params.get("actor") === "eq.agent") return { body: [{ seq: 9 }, { seq: 10 }] };
      if (request.path === "/rest/v1/ledger_entries") {
        return {
          body: [
            { action: "counterparty_address_changed", detail: { to: "0x1" } },
            { action: "counterparty_address_changed", detail: { to: null } },
            { action: "counterparty_address_confirmed", detail: {} },
            { action: "address_change_check_sent", detail: {} },
            { action: "address_change_answered", detail: { answer: "not_me" } },
            { action: "address_change_answered", detail: { answer: "me" } },
          ],
        };
      }
      return { body: [] };
    });
    const week = await run(client, () => payeeWeek(db(), "2026-10-12T00:00:00.000Z", "2026-10-19T00:00:00.000Z"));
    expect(week).toEqual({ lockOn: true, changed: 1, confirmed: 1, held: 2, asked: 1, notMe: 1, frozen: 1 });
    const holds = client.requests.find((request) => request.path === "/rest/v1/ledger_entries" && request.params.get("actor") === "eq.agent");
    expect(holds?.params.get("detail->>guardrailRule")).toBe("in.(counterparty.address_unconfirmed,counterparty.cooling_off,invoice.pay_to_differs)");
    const frozen = client.requests.find((request) => request.path === "/rest/v1/counterparties");
    expect(frozen?.params.get("frozen_at")).toBe("not.is.null");
  });

  it("leaves them out when they cannot be read, and counts no frozen payee before migration 0137", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const down = fakeSupabase((request) => (request.path === "/rest/v1/ledger_entries" ? { status: 500, body: { code: "XX000", message: "down" } } : { body: [] }));
    expect(await run(down, () => payeeWeek(db(), "a", "b"))).toBeNull();
    const before = fakeSupabase((request) =>
      request.path === "/rest/v1/counterparties" ? { status: 400, body: { code: "42703", message: "column counterparties.frozen_at does not exist" } } : { body: [] }
    );
    expect((await run(before, () => payeeWeek(db(), "a", "b")))?.frozen).toBe(0);
  });
});

describe("sending it (W1, W2, W4, W5)", () => {
  it("claims the week, then sends it on a Monday to each member who decides", async () => {
    const outcome = await run(world(), () => sendWeeklyBrief({ now: MONDAY }));
    expect(outcome).toEqual({ sent: 2, failed: 0 });
    expect(sendMock.mock.calls.map((call) => (call[0] as { to: string }).to)).toEqual(["owner@pinecrest.example", "approver@pinecrest.example"]);
    expect((sendMock.mock.calls[0][0] as { subject: string; meter: string }).subject).toBe("Pinecrest Studio: the cash runs short on Oct 23 · your week with the agent");
    expect((sendMock.mock.calls[0][0] as { meter: string }).meter).toBe("weekly_brief");
    expect((sendMock.mock.calls[0][0] as { html: string }).html).toContain("https://www.vestiarion.xyz/o/pinecrest-studio/invoices?tab=plan");
    // Signed before the first send, so a cycle that starts while these go finds the week claimed.
    expect(claimMock).toHaveBeenCalledTimes(1);
    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(sendMock.mock.invocationCallOrder[0]);
    expect(claimMock.mock.calls[0][0]).toMatchObject({ action: WEEKLY_BRIEF_SENT, actor: "system", detail: { week: "2026-W43", recipients: 2 } });
    expect((claimMock.mock.calls[0][0] as { detail: Record<string, unknown> }).detail.preview).toBeUndefined();
    // The payee figures it told of (WP1), signed with the rest.
    expect((claimMock.mock.calls[0][0] as { detail: { payees: unknown } }).detail.payees).toMatchObject({ changed: 0, held: 3, frozen: 0 });
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("sends nothing on another day, or once the week is claimed", async () => {
    expect(await run(world(), () => sendWeeklyBrief({ now: SATURDAY }))).toMatchObject({ sent: 0, skipped: "not_monday" });
    expect(await run(world({ briefs: [{ action: WEEKLY_BRIEF_SENT, detail: { week: "2026-W43" } }] }), () => sendWeeklyBrief({ now: MONDAY }))).toMatchObject({ sent: 0, skipped: "sent_this_week" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends it after last week's brief, a member's own preview, or a claim that reached nobody", async () => {
    const briefs = [
      { action: WEEKLY_BRIEF_SENT, detail: { week: "2026-W42" } },
      { action: WEEKLY_BRIEF_SENT, detail: { week: "2026-W43", preview: true, by: "u1" } },
      { action: WEEKLY_BRIEF_SENT, detail: { week: "2026-W43" } },
      { action: WEEKLY_BRIEF_FAILED, detail: { week: "2026-W43" } },
    ];
    expect((await run(world({ briefs }), () => sendWeeklyBrief({ now: MONDAY }))).sent).toBe(2);
  });

  it("sends nothing when the claim cannot be signed", async () => {
    claimMock.mockRejectedValue(new Error("ledger down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await run(world(), () => sendWeeklyBrief({ now: MONDAY }))).toMatchObject({ sent: 0, skipped: "failed" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("lets the claim go when every send failed, so the next Monday cycle tries again", async () => {
    sendMock.mockResolvedValue({ sent: false, reason: "resend_error" });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await run(world(), () => sendWeeklyBrief({ now: MONDAY }))).toMatchObject({ sent: 0, failed: 2, skipped: "failed" });
    expect(ledgerMock.mock.calls[0][1]).toMatchObject({ action: WEEKLY_BRIEF_FAILED, detail: { week: "2026-W43", failed: 2 } });
  });

  it("sends it at once to the one member who asked, any day, and marks it a preview (W4)", async () => {
    const outcome = await run(world(), () => sendWeeklyBrief({ now: SATURDAY, only: { userId: "u1", email: "owner@pinecrest.example" } }));
    expect(outcome).toEqual({ sent: 1, failed: 0 });
    expect(recipientsMock).not.toHaveBeenCalled();
    expect(claimMock.mock.calls[0][0]).toMatchObject({ detail: { week: "2026-W42", preview: true, by: "u1", recipients: 1 } });
  });

  it("refuses a second one to the same member within a few minutes", async () => {
    const recent = { action: WEEKLY_BRIEF_SENT, ts: "2026-10-17T17:58:00Z", detail: { week: "2026-W42", preview: true, by: "u1" } };
    expect(await run(world({ briefs: [recent] }), () => sendWeeklyBrief({ now: SATURDAY, only: { userId: "u1", email: "owner@pinecrest.example" } }))).toMatchObject({ sent: 0, skipped: "too_soon" });
    const older = { ...recent, ts: "2026-10-17T17:50:00Z" };
    expect((await run(world({ briefs: [older] }), () => sendWeeklyBrief({ now: SATURDAY, only: { userId: "u1", email: "owner@pinecrest.example" } }))).sent).toBe(1);
  });
});

describe("the brief in shadow mode (W6)", () => {
  const VERDICTS = [
    { ts: "2026-10-09T10:00:00Z", verdict: "agree" },
    { ts: "2026-10-10T10:00:00Z", verdict: "agree" },
    { ts: "2026-10-14T10:00:00Z", verdict: "agree" },
    { ts: "2026-10-15T10:00:00Z", verdict: "disagree" },
  ];

  it("counts the verdicts in the week and since shadow mode began, and leaves the mirror wallet's cash out", async () => {
    const facts = await run(world({ shadow: true, verdicts: VERDICTS }), () => weeklyBriefFacts(db(), MONDAY, { currency: "USD", startedAt: "2026-10-08T09:00:00Z", startedBy: null }));
    expect(facts.shadow).toEqual({ verdicts: { given: 2, agreed: 1 }, sinceStart: { given: 4, agreed: 3, since: "2026-10-08" } });
    expect(facts.cash.short).toBeNull();
  });

  it("speaks of verdicts and says the business's own money did not move", () => {
    const facts: WeeklyBriefFacts = {
      week: "2026-W43", from: "2026-10-12", to: "2026-10-18", paid: { count: 1, usdc: 45 }, received: { count: 0, usdc: 0 }, decisions: 3, waiting: 1,
      next7: { count: 2, usdc: 90, expectedUsdc: 0, lines: [] }, cash: { operating: 150, reserve: 0, short: null },
      shadow: { verdicts: { given: 2, agreed: 1 }, sinceStart: { given: 8, agreed: 8, since: "2026-10-08" } },
    };
    const said = briefSentences(facts);
    expect(said.lastWeek).toEqual([
      "Made 3 decisions on your bills; in shadow mode each waits for your verdict.",
      "You gave 2 verdicts and agreed with 1.",
      "Paid 1 bill you agreed with on Arc testnet, 45.00 USDC in all.",
    ]);
    expect(said.waiting).toBe("1 payment waits for your verdict or a decision from you.");
    expect(said.cash).toBe("Since shadow mode began on Oct 8, you agreed with the agent on 8 of 8 decisions. Your own money did not move: you keep paying your bills as before.");
    const email = weeklyBriefEmail({ orgName: "Northwind Ops", facts, links: { console: "https://x/console", approvals: "https://x/approvals", plan: "https://x/plan" }, origin: "https://x" });
    expect(email.subject).toBe("Northwind Ops: you agreed with the agent on 8 of 8 · your week in shadow mode");
    expect(email.html).toContain("Your week with the agent · shadow mode");
  });

  it("goes to a shadow-mode workspace on a Monday, and from Settings, with the verdicts signed", async () => {
    const outcome = await run(world({ shadow: true, verdicts: VERDICTS }), () => sendWeeklyBrief({ now: MONDAY }));
    expect(outcome.sent).toBe(2);
    expect((sendMock.mock.calls[0][0] as { subject: string }).subject).toBe("Pinecrest Studio: you agreed with the agent on 3 of 4 · your week in shadow mode");
    expect(claimMock.mock.calls[0][0]).toMatchObject({ detail: { short: null, shadow: { verdicts: { given: 2, agreed: 1 }, sinceStart: { given: 4, agreed: 3 } } } });
    sendMock.mockClear();
    expect((await run(world({ shadow: true }), () => sendWeeklyBrief({ now: SATURDAY, only: { userId: "u1", email: "owner@pinecrest.example" } }))).sent).toBe(1);
  });
});
