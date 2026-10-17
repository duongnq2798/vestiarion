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

import { briefDue, briefWorthSending, isoWeek, sendWeeklyBrief, weeklyBriefFacts, WEEKLY_BRIEF_FAILED, WEEKLY_BRIEF_SENT } from "@/lib/notifications/weekly-brief";
import { briefSentences, weeklyBriefEmail, type WeeklyBriefFacts } from "@/lib/email/weekly-brief";
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
}
function world(w: World = {}) {
  return fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") return { body: { name: "Pinecrest Studio", slug: "pinecrest-studio" } };
    if (request.path === "/rest/v1/shadow_modes") return { body: w.shadow ? [{ currency: "VND", started_at: "2026-10-01T00:00:00Z", started_by: null }] : [] };
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
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("sends nothing on another day, once the week is claimed, or in shadow mode", async () => {
    expect(await run(world(), () => sendWeeklyBrief({ now: SATURDAY }))).toMatchObject({ sent: 0, skipped: "not_monday" });
    expect(await run(world({ briefs: [{ action: WEEKLY_BRIEF_SENT, detail: { week: "2026-W43" } }] }), () => sendWeeklyBrief({ now: MONDAY }))).toMatchObject({ sent: 0, skipped: "sent_this_week" });
    expect(await run(world({ shadow: true }), () => sendWeeklyBrief({ now: MONDAY }))).toMatchObject({ sent: 0, skipped: "shadow_mode" });
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

  it("refuses a second one to the same member within a few minutes, and any in shadow mode", async () => {
    const recent = { action: WEEKLY_BRIEF_SENT, ts: "2026-10-17T17:58:00Z", detail: { week: "2026-W42", preview: true, by: "u1" } };
    expect(await run(world({ briefs: [recent] }), () => sendWeeklyBrief({ now: SATURDAY, only: { userId: "u1", email: "owner@pinecrest.example" } }))).toMatchObject({ sent: 0, skipped: "too_soon" });
    const older = { ...recent, ts: "2026-10-17T17:50:00Z" };
    expect((await run(world({ briefs: [older] }), () => sendWeeklyBrief({ now: SATURDAY, only: { userId: "u1", email: "owner@pinecrest.example" } }))).sent).toBe(1);
    expect(await run(world({ shadow: true }), () => sendWeeklyBrief({ now: SATURDAY, only: { userId: "u1", email: "owner@pinecrest.example" } }))).toMatchObject({ skipped: "shadow_mode" });
  });
});
