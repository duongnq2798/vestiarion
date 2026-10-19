import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { fakeSupabase, orgTestContext } from "./support/fake-supabase";

/**
 * Setup reminders for workspaces that stopped (docs/superpowers/specs/2026-10-19-activation-nudge-design.md): which
 * moment is due (A1, A2), who is told (A3), what it says (A4), the tick's pass (A5), claimed before it goes (A6), and
 * the growth tile (A7).
 */

const { sendMock, ledgerMock, claimMock, recipientsMock, summaryMock, workspacesMock, settingsMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
  ledgerMock: vi.fn(),
  claimMock: vi.fn(),
  recipientsMock: vi.fn(),
  summaryMock: vi.fn(),
  workspacesMock: vi.fn(),
  settingsMock: vi.fn(),
}));
vi.mock("@/lib/email/send", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/send")>()),
  emailSettingsFromEnv: settingsMock,
  sendEmail: sendMock,
}));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: claimMock }));
vi.mock("@/lib/notifications/waiting", () => ({ decidingRecipients: recipientsMock, DIGEST_SEND_DEADLINE_MS: 60_000 }));
vi.mock("@/lib/verdicts", () => ({ readShadowSummary: summaryMock }));
vi.mock("@/lib/growth/read", () => ({ readWorkspaces: workspacesMock }));
vi.mock("@/lib/auth/env", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth/env")>()), siteOrigin: () => "https://www.vestiarion.xyz" }));
vi.mock("@/lib/dal/scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dal/scope")>()),
  // The pass enters each workspace; here every one is the test workspace's scope the test already runs in.
  withOrg: (_orgId: string, fn: () => Promise<unknown>) => fn(),
}));

import {
  ACTIVATION_NUDGE_FAILED,
  ACTIVATION_NUDGE_SENT,
  dueNudge,
  dueNudges,
  NUDGES_PER_TICK,
  nudgeOpen,
  nudgeWent,
  wholeDays,
  type NudgeWorkspace,
} from "@/lib/activation-nudge";
import { firstBillNudgeEmail, firstVerdictNudgeEmail } from "@/lib/email/activation-nudge";
import { IDEMPOTENCY_KEY_USED } from "@/lib/email/send";
import { growthMetrics, type WorkspaceRow } from "@/lib/growth/metrics";
import { nudgeKey, readSentNudges, runActivationNudges, sendActivationNudge } from "@/lib/notifications/activation-nudge";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const NOW = Date.parse("2026-10-19T12:00:00Z");
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW - hours * HOUR).toISOString();

const workspace = (overrides: Partial<NudgeWorkspace> = {}): NudgeWorkspace => ({
  orgId: ORG,
  slug: "harbor-books",
  side: "customers",
  createdAt: ago(30),
  shadow: false,
  realBills: 0,
  firstDecisionAt: null,
  verdictsGiven: 0,
  ...overrides,
});

describe("which moment is due (A1, A2)", () => {
  it("reminds a customer workspace with no real bill a day after it was opened", () => {
    expect(dueNudge(workspace({ createdAt: ago(24) }), NOW)).toBe("first_bill");
    expect(dueNudge(workspace({ createdAt: ago(23) }), NOW)).toBeNull();
  });

  it("never reminds a team workspace, or one opened more than 30 days ago", () => {
    expect(dueNudge(workspace({ side: "ours" }), NOW)).toBeNull();
    expect(dueNudge(workspace({ createdAt: ago(30 * 24 + 1) }), NOW)).toBeNull();
    expect(dueNudge(workspace({ createdAt: "not a date" }), NOW)).toBeNull();
  });

  it("asks a shadow workspace for a verdict three days after the agent's first decision, while none is given", () => {
    const decided = workspace({ shadow: true, realBills: 4, firstDecisionAt: ago(72) });
    expect(dueNudge(decided, NOW)).toBe("first_verdict");
    expect(dueNudge({ ...decided, firstDecisionAt: ago(71) }, NOW)).toBeNull();
    expect(dueNudge({ ...decided, verdictsGiven: 1 }, NOW)).toBeNull();
    expect(dueNudge({ ...decided, shadow: false }, NOW)).toBeNull();
    expect(dueNudge({ ...decided, firstDecisionAt: null }, NOW)).toBeNull();
  });

  it("takes the longest-waiting workspaces first", () => {
    const due = dueNudges(
      [workspace({ orgId: "b", slug: "b", createdAt: ago(40) }), workspace({ orgId: "c", slug: "c", side: "ours" }), workspace({ orgId: "a", slug: "a", createdAt: ago(100) })],
      NOW
    );
    expect(due.map((nudge) => nudge.slug)).toEqual(["a", "b"]);
  });

  it("goes once: a standing claim closes it, a failure lets it go, three failures end it (A6)", () => {
    expect(nudgeOpen([])).toBe(true);
    expect(nudgeOpen([ACTIVATION_NUDGE_SENT])).toBe(false);
    expect(nudgeOpen([ACTIVATION_NUDGE_SENT, ACTIVATION_NUDGE_FAILED])).toBe(true);
    expect(nudgeOpen([ACTIVATION_NUDGE_SENT, ACTIVATION_NUDGE_FAILED, ACTIVATION_NUDGE_SENT])).toBe(false);
    expect(nudgeOpen(Array.from({ length: 3 }, () => [ACTIVATION_NUDGE_SENT, ACTIVATION_NUDGE_FAILED]).flat())).toBe(false);
    expect(nudgeWent(Array.from({ length: 3 }, () => [ACTIVATION_NUDGE_SENT, ACTIVATION_NUDGE_FAILED]).flat())).toBe(false);
  });

  it("counts whole days, never fewer than one", () => {
    expect(wholeDays(NOW - 30 * HOUR, NOW)).toBe(1);
    expect(wholeDays(NOW - 2 * HOUR, NOW)).toBe(1);
    expect(wholeDays(NOW - 20 * 24 * HOUR, NOW)).toBe(20);
  });
});

describe("what it says (A4)", () => {
  const firstBill = (overrides: Partial<Parameters<typeof firstBillNudgeEmail>[0]> = {}) =>
    firstBillNudgeEmail({
      orgName: "Harbor <Books>",
      days: 2,
      shadow: false,
      offerSample: true,
      links: { addBill: "https://www.vestiarion.xyz/o/harbor-books/invoices?new=bill", console: "https://www.vestiarion.xyz/o/harbor-books/console" },
      origin: "https://www.vestiarion.xyz",
      ...overrides,
    });

  it("gives the agent its first bill, the three ways in, and the sample data in a sandbox that can load it", () => {
    const email = firstBill();
    expect(email.subject).toBe("Give your agent its first bill in Harbor <Books>");
    expect(email.text).toContain("You opened Harbor <Books> on Vestiarion 2 days ago.");
    expect(email.text).toContain("on Bills, choose New, then Bill to pay");
    expect(email.text).toContain("(Settings, under Invoices by email)");
    expect(email.text).toContain("Load sample data");
    expect(email.html).toContain("Harbor &lt;Books&gt;");
    expect(email.html).not.toContain("Harbor <Books>");
    expect(email.html).toContain('href="https://www.vestiarion.xyz/o/harbor-books/invoices?new=bill"');
    expect(email.html).toContain("Add your first bill");
    expect(email.html).toContain("The AI agent for bills and payments, settled in USDC on Arc.");
    // A member's email: no counterparty loop link.
    expect(email.html).not.toContain("utm_campaign=counterparty_loop");
    expect(email.text).toContain("It is sent once.");
  });

  it("offers no sample data where it cannot load, and speaks of shadow mode in shadow mode", () => {
    const email = firstBill({ offerSample: false, shadow: true, days: 1 });
    expect(email.text).not.toContain("sample data");
    expect(email.html).not.toContain("sample data");
    expect(email.text).toContain("1 day ago");
    expect(email.text).toContain("In shadow mode you keep paying your bills as you do now.");
  });

  it("asks for verdicts on the decisions that wait, and says since when", () => {
    const one = firstVerdictNudgeEmail({ orgName: "Boba Labs", waiting: 1, since: "2026-10-14T03:00:00Z", links: { bills: "https://www.vestiarion.xyz/o/boba/invoices" }, origin: "https://www.vestiarion.xyz" });
    expect(one.subject).toBe("1 decision of the agent's waits for your verdict in Boba Labs");
    expect(one.text).toContain("Since Oct 14, 2026 it has decided bills in Boba Labs, and 1 decision still waits");
    expect(one.html).toContain("Give your verdicts");
    const many = firstVerdictNudgeEmail({ orgName: "Boba Labs", waiting: 6, since: "2026-10-14T03:00:00Z", links: { bills: "https://www.vestiarion.xyz/o/boba/invoices" }, origin: "https://www.vestiarion.xyz" });
    expect(many.subject).toBe("6 decisions of the agent's wait for your verdict in Boba Labs");
  });

  it("names no network, amount or address", () => {
    for (const email of [firstBill(), firstVerdictNudgeEmail({ orgName: "Boba Labs", waiting: 2, since: "2026-10-14T03:00:00Z", links: { bills: "https://x.example/b" }, origin: "https://x.example" })]) {
      expect(email.text).not.toMatch(/testnet|mainnet|0x[0-9a-f]{6}|USDC/i);
    }
  });
});

interface World {
  /** The ledger's reminder entries for the stage asked, oldest first. */
  entries?: string[];
  org?: Record<string, unknown>;
  invoices?: Array<{ counterparty_id: string }>;
  samples?: string[];
  shadow?: boolean;
}
function world(w: World = {}) {
  return fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") {
      return { body: { name: "Harbor Books", slug: "harbor-books", mode: "sandbox", network: "arc-testnet", wallet_host: null, api_key_iv: null, ...w.org } };
    }
    if (request.path === "/rest/v1/shadow_modes") return { body: w.shadow ? [{ currency: "USD", started_at: "2026-10-08T09:00:00Z", started_by: null }] : [] };
    if (request.path === "/rest/v1/invoices") {
      expect(request.params.get("counterparties.sample")).toBe("eq.false");
      const samples = new Set(w.samples ?? []);
      return { body: (w.invoices ?? []).filter((row) => !samples.has(row.counterparty_id)).map((row) => ({ id: "i", counterparties: { sample: false }, ...row })) };
    }
    if (request.path === "/rest/v1/counterparties") return { body: (w.samples ?? []).map((id) => ({ id })) };
    if (request.path === "/rest/v1/ledger_entries") {
      if (request.params.get("action") === `in.(${ACTIVATION_NUDGE_SENT},${ACTIVATION_NUDGE_FAILED})`) return { body: (w.entries ?? []).map((action) => ({ action })) };
      return { body: [] };
    }
    return { body: [] };
  });
}
const run = <T,>(client: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>): Promise<T> => runWith(orgTestContext({ config, client: client.client, orgId: ORG }), fn);
const firstBillDue = { orgId: ORG, slug: "harbor-books", stage: "first_bill" as const, createdAt: ago(50), firstDecisionAt: null };
const verdictDue = { orgId: ORG, slug: "harbor-books", stage: "first_verdict" as const, createdAt: ago(200), firstDecisionAt: ago(80) };

beforeEach(() => {
  settingsMock.mockReset().mockReturnValue({ apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" });
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "email-1" });
  ledgerMock.mockReset().mockResolvedValue(undefined);
  claimMock.mockReset().mockResolvedValue({ seq: 1 });
  recipientsMock.mockReset().mockResolvedValue([{ userId: "u1", email: "owner@harbor.example", role: "owner" }]);
  summaryMock.mockReset().mockResolvedValue({ agreed: 0, disagreed: 0, waiting: 3 });
  workspacesMock.mockReset().mockResolvedValue([]);
});

describe("one workspace's reminder (A3, A6)", () => {
  it("signs the claim before the email goes, with the moment and its figures", async () => {
    const outcome = await run(world(), () => sendActivationNudge(firstBillDue, { now: NOW }));
    expect(outcome).toEqual({ sent: 1, failed: 0 });
    expect(claimMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "system", domain: "system", action: ACTIVATION_NUDGE_SENT, detail: { stage: "first_bill", recipients: 1, days: 2, shadow: false } })
    );
    expect(claimMock.mock.invocationCallOrder[0]).toBeLessThan(sendMock.mock.invocationCallOrder[0]);
    const message = sendMock.mock.calls[0][0];
    expect(message).toMatchObject({ to: "owner@harbor.example", meter: "activation_nudge", idempotencyKey: nudgeKey(ORG, "first_bill", "u1") });
    expect(message.idempotencyKey).not.toContain("owner@");
    // A simulated sandbox with no sample data is offered it.
    expect(message.text).toContain("Load sample data");
  });

  it("asks at most 5 of the members who decide payments", async () => {
    recipientsMock.mockResolvedValue(Array.from({ length: 8 }, (_, i) => ({ userId: `u${i}`, email: `m${i}@harbor.example`, role: "approver" })));
    const outcome = await run(world(), () => sendActivationNudge(firstBillDue, { now: NOW }));
    expect(outcome.sent).toBe(5);
    expect(sendMock).toHaveBeenCalledTimes(5);
  });

  it("does not offer sample data once loaded, or in a connected or live workspace", async () => {
    await run(world({ samples: ["s1"] }), () => sendActivationNudge(firstBillDue, { now: NOW }));
    await run(world({ org: { wallet_host: "hosted" } }), () => sendActivationNudge(firstBillDue, { now: NOW }));
    await run(world({ org: { mode: "live" } }), () => sendActivationNudge(firstBillDue, { now: NOW }));
    await run(world({ org: { network: "arc-mainnet" } }), () => sendActivationNudge(firstBillDue, { now: NOW }));
    for (const [message] of sendMock.mock.calls) expect(message.text).not.toContain("sample data");
  });

  it("is skipped once it went, after three failures, and when a real bill came in since", async () => {
    expect(await run(world({ entries: [ACTIVATION_NUDGE_SENT] }), () => sendActivationNudge(firstBillDue, { now: NOW }))).toMatchObject({ skipped: "sent_before" });
    const thrice = Array.from({ length: 3 }, () => [ACTIVATION_NUDGE_SENT, ACTIVATION_NUDGE_FAILED]).flat();
    expect(await run(world({ entries: thrice }), () => sendActivationNudge(firstBillDue, { now: NOW }))).toMatchObject({ skipped: "gave_up" });
    expect(await run(world({ invoices: [{ counterparty_id: "real" }] }), () => sendActivationNudge(firstBillDue, { now: NOW }))).toMatchObject({ skipped: "not_due" });
    expect(sendMock).not.toHaveBeenCalled();
    expect(claimMock).not.toHaveBeenCalled();
  });

  it("still reminds a workspace whose only bills are sample bills", async () => {
    const outcome = await run(world({ invoices: [{ counterparty_id: "s1" }], samples: ["s1"] }), () => sendActivationNudge(firstBillDue, { now: NOW }));
    expect(outcome.sent).toBe(1);
  });

  it("tries again after a failure that let the claim go", async () => {
    const outcome = await run(world({ entries: [ACTIVATION_NUDGE_SENT, ACTIVATION_NUDGE_FAILED] }), () => sendActivationNudge(firstBillDue, { now: NOW }));
    expect(outcome.sent).toBe(1);
  });

  it("asks for the verdicts that wait in shadow mode, and stops once one is given or none waits", async () => {
    const outcome = await run(world({ shadow: true }), () => sendActivationNudge(verdictDue, { now: NOW }));
    expect(outcome.sent).toBe(1);
    expect(claimMock).toHaveBeenCalledWith(expect.objectContaining({ detail: { stage: "first_verdict", recipients: 1, waiting: 3 } }));
    expect(sendMock.mock.calls[0][0].text).toContain("https://www.vestiarion.xyz/o/harbor-books/invoices");
    summaryMock.mockResolvedValue({ agreed: 1, disagreed: 0, waiting: 2 });
    expect(await run(world({ shadow: true }), () => sendActivationNudge(verdictDue, { now: NOW }))).toMatchObject({ skipped: "not_due" });
    summaryMock.mockResolvedValue({ agreed: 0, disagreed: 0, waiting: 0 });
    expect(await run(world({ shadow: true }), () => sendActivationNudge(verdictDue, { now: NOW }))).toMatchObject({ skipped: "not_due" });
    expect(await run(world({ shadow: false }), () => sendActivationNudge(verdictDue, { now: NOW }))).toMatchObject({ skipped: "not_due" });
  });

  it("sends nothing without email, without anyone to tell, or when the claim cannot be signed", async () => {
    settingsMock.mockReturnValue(null);
    expect(await run(world(), () => sendActivationNudge(firstBillDue, { now: NOW }))).toMatchObject({ skipped: "no_email" });
    settingsMock.mockReturnValue({ apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" });
    recipientsMock.mockResolvedValue([]);
    expect(await run(world(), () => sendActivationNudge(firstBillDue, { now: NOW }))).toMatchObject({ skipped: "nobody" });
    recipientsMock.mockResolvedValue([{ userId: "u1", email: "owner@harbor.example", role: "owner" }]);
    claimMock.mockRejectedValue(new Error("signing failed"));
    expect(await run(world(), () => sendActivationNudge(firstBillDue, { now: NOW }))).toMatchObject({ skipped: "failed" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("lets the claim go when no email went, and counts one taken under its key as sent", async () => {
    sendMock.mockResolvedValue({ sent: false, reason: "resend 500" });
    expect(await run(world(), () => sendActivationNudge(firstBillDue, { now: NOW }))).toEqual({ sent: 0, failed: 1, skipped: "failed" });
    expect(ledgerMock).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: ACTIVATION_NUDGE_FAILED, detail: { stage: "first_bill", failed: 1 } }));
    ledgerMock.mockClear();
    sendMock.mockResolvedValue({ sent: false, reason: IDEMPOTENCY_KEY_USED });
    expect(await run(world(), () => sendActivationNudge(firstBillDue, { now: NOW }))).toEqual({ sent: 1, failed: 0 });
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});

describe("the tick's pass (A5)", () => {
  it("reads the last 30 days once and reminds each workspace due, oldest first", async () => {
    workspacesMock.mockResolvedValue([workspace({ createdAt: ago(48) }), workspace({ orgId: "team", side: "ours" }), workspace({ orgId: "fresh", createdAt: ago(2) })]);
    const result = await run(world(), () => runActivationNudges({ now: NOW }));
    expect(workspacesMock).toHaveBeenCalledWith(new Date(NOW - 30 * 24 * HOUR));
    expect(result).toEqual({ due: 1, reminded: 1, attempted: 1, emails: 1, skipped: {}, left: 0 });
  });

  it("claims at most NUDGES_PER_TICK reminders a tick, and starts none after startBy", async () => {
    workspacesMock.mockResolvedValue(Array.from({ length: NUDGES_PER_TICK + 3 }, (_, i) => workspace({ orgId: `o${i}`, slug: `o${i}`, createdAt: ago(48 + i) })));
    const capped = await run(world(), () => runActivationNudges({ now: NOW }));
    expect(capped).toMatchObject({ due: NUDGES_PER_TICK + 3, reminded: NUDGES_PER_TICK, attempted: NUDGES_PER_TICK, left: 3 });
    sendMock.mockClear();
    workspacesMock.mockClear();
    const late = await run(world(), () => runActivationNudges({ now: NOW, startBy: 10, clock: () => 11 }));
    expect(late).toMatchObject({ reminded: 0, left: 0 });
    // Past startBy before the list is read: growth_workspaces is not read at all.
    expect(workspacesMock).not.toHaveBeenCalled();
    let calls = 0;
    const midway = await run(world(), () => runActivationNudges({ now: NOW, startBy: 10, clock: () => (calls++ < 3 ? 0 : 11) }));
    expect(midway).toMatchObject({ reminded: 2, left: NUDGES_PER_TICK + 1 });
  });

  it("never lets workspaces reminded before crowd out a new one (review of the pass)", async () => {
    // 25 old workspaces that got theirs already, then one opened yesterday.
    const old = Array.from({ length: 25 }, (_, i) => workspace({ orgId: `old${i}`, slug: `old${i}`, createdAt: ago(200 + i) }));
    workspacesMock.mockResolvedValue([...old, workspace({ orgId: "new", slug: "new", createdAt: ago(26) })]);
    // The pass visits them oldest first: the first 25 reminder reads find a standing claim, the 26th none.
    let reads = 0;
    const client = fakeSupabase((request) => {
      if (request.path === "/rest/v1/ledger_entries") return { body: reads++ < 25 ? [{ action: ACTIVATION_NUDGE_SENT }] : [] };
      if (request.path === "/rest/v1/orgs") return { body: { name: "New Co", slug: "new", mode: "sandbox", network: "arc-testnet", wallet_host: null, api_key_iv: null } };
      return { body: [] };
    });
    const result = await run(client, () => runActivationNudges({ now: NOW }));
    expect(result).toMatchObject({ due: 26, reminded: 1, attempted: 1, skipped: { sent_before: 25 }, left: 0 });
    expect(sendMock.mock.calls[0][0].subject).toBe("Give your agent its first bill in New Co");
  });

  it("claims nothing when not even one email could go before sendBy", async () => {
    workspacesMock.mockResolvedValue([workspace({ createdAt: ago(48) })]);
    const result = await run(world(), () => runActivationNudges({ now: NOW, sendBy: Date.now() + 5_000 }));
    expect(result).toMatchObject({ due: 1, attempted: 0, skipped: { out_of_time: 1 } });
    expect(claimMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("does nothing without email or when the workspaces cannot be read, and never throws", async () => {
    settingsMock.mockReturnValue(null);
    expect(await run(world(), () => runActivationNudges({ now: NOW }))).toMatchObject({ due: 0 });
    expect(workspacesMock).not.toHaveBeenCalled();
    settingsMock.mockReturnValue({ apiKey: "re_test", from: "Vestiarion <no-reply@vestiarion.xyz>" });
    workspacesMock.mockResolvedValue(null);
    expect(await run(world(), () => runActivationNudges({ now: NOW }))).toMatchObject({ due: 0 });
    workspacesMock.mockRejectedValue(new Error("down"));
    expect(await run(world(), () => runActivationNudges({ now: NOW }))).toMatchObject({ due: 0 });
  });

  it("counts the reasons nothing went", async () => {
    workspacesMock.mockResolvedValue([workspace({ createdAt: ago(48) })]);
    const result = await run(world({ entries: [ACTIVATION_NUDGE_SENT] }), () => runActivationNudges({ now: NOW }));
    expect(result).toEqual({ due: 1, reminded: 0, attempted: 0, emails: 0, skipped: { sent_before: 1 }, left: 0 });
  });
});

describe("the growth tile (A7)", () => {
  it("reads the reminders whose claims still stand, and whether a verdict followed", async () => {
    const client = fakeSupabase((request) => {
      if (request.path !== "/rest/v1/ledger_entries") return { body: [] };
      if (request.params.get("action") === "eq.decision_verdict") return { body: [{ seq: 9 }] };
      return {
        body: [
          { action: ACTIVATION_NUDGE_SENT, ts: "2026-10-10T00:00:00Z", detail: { stage: "first_bill" } },
          { action: ACTIVATION_NUDGE_FAILED, ts: "2026-10-10T00:01:00Z", detail: { stage: "first_bill" } },
          { action: ACTIVATION_NUDGE_SENT, ts: "2026-10-12T00:00:00Z", detail: { stage: "first_verdict" } },
        ],
      };
    });
    const sent = await run(client, () => readSentNudges([ORG]));
    expect(sent).toEqual([{ orgId: ORG, stage: "first_verdict", at: "2026-10-12T00:00:00Z", verdictAfter: true }]);
    const verdictRead = client.requests.find((r) => r.params.get("action") === "eq.decision_verdict");
    expect(verdictRead?.params.get("ts")).toBe("gt.2026-10-12T00:00:00Z");
  });

  it("counts customer workspaces reminded, and those that came back after the email", () => {
    const row = (orgId: string, firstRealBillAt: string | null): WorkspaceRow =>
      ({ orgId, side: "customers", network: "arc-testnet", createdAt: "2026-10-01T00:00:00Z", firstRealBillAt, firstDecisionAt: null, attribution: null, realBillsWithin7dOfFirst: 0 }) as unknown as WorkspaceRow;
    const metrics = growthMetrics({
      leads: [],
      events: [],
      spend: [],
      revenue: [],
      now: new Date(NOW),
      workspaces: [row("a", "2026-10-11T00:00:00Z"), row("b", "2026-10-09T00:00:00Z"), row("c", null), row("d", null), { ...row("team", null), side: "ours" } as WorkspaceRow],
      nudges: [
        { orgId: "a", stage: "first_bill", at: "2026-10-10T00:00:00Z", verdictAfter: false },
        { orgId: "b", stage: "first_bill", at: "2026-10-10T00:00:00Z", verdictAfter: false },
        { orgId: "c", stage: "first_verdict", at: "2026-10-10T00:00:00Z", verdictAfter: true },
        { orgId: "team", stage: "first_bill", at: "2026-10-10T00:00:00Z", verdictAfter: false },
      ],
    });
    expect(metrics.nudged).toEqual({ workspaces: 3, cameBack: 2 });
  });
});
