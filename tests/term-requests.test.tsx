import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DecideParams } from "@/lib/agent/decide";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { db } from "@/lib/dal";
import type { EmailMessage, SendResult } from "@/lib/email/send";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * The agent asks suppliers for more time (docs/superpowers/specs/2026-10-17-term-requests-design.md): only on a bill held
 * for want of cash, where a person turned it on and code allows it (X1, X2), for the days the model picks within bounds
 * (X3), claimed, made, emailed once with its link and withdrawn when the email never went (X6); and the supplier's
 * answer, recorded, starting a cycle (X5).
 */

const { ledgerMock, decideMock, bestEffortMock } = vi.hoisted(() => ({ ledgerMock: vi.fn(), decideMock: vi.fn(), bestEffortMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: bestEffortMock }));
vi.mock("@/lib/dal/scope", () => ({ withOrg: async (_orgId: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("@/lib/agent/decide", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/agent/decide")>()), decide: decideMock }));
vi.mock("@/app/more-time/[token]/actions", () => ({ decideTermRequestAction: vi.fn() }));
vi.mock("@/app/actions/term-requests", () => ({ setTermRequestsAction: vi.fn() }));

import { makeTermRequests } from "@/lib/agent/term-requests";
import { termRequestEmail } from "@/lib/email/term-request";
import { decideTermRequest, generateTermToken, termTokenHash } from "@/lib/terms/requests";
import { boundTermDays, referenceTermDays, termRequestAllowed, type TermFacts } from "@/lib/terms/rules";
import { termRequestLine } from "@/lib/terms/words";
import { TermDecision } from "@/components/terms/TermDecision";
import { TermRequests } from "@/components/bills/TermRequests";

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000f0f";
const INVOICE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001f1";
const SUPPLIER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000002f2";
const OWNER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000003f3";
const NOW = Date.parse("2026-10-17T09:00:00Z");
const DAY = 86_400_000;

const held = (over: Record<string, unknown> = {}) => ({
  id: INVOICE,
  counterparty_id: SUPPLIER,
  amount: "300",
  currency: "USDC",
  due_date: "2026-10-20T12:00:00+00:00",
  memo: "LP-130 brochures",
  counterparties: { name: "Lumen Print Co.", notice_email: "ap@lumen.example" },
  ...over,
});
const forCash = { seq: 900, detail: { invoiceId: INVOICE, execution: { resultingStatus: "held", heldBecause: "cash_shortfall" } } };

interface World {
  mode?: string;
  on?: boolean;
  onBy?: string | null;
  maxDays?: number;
  paused?: boolean;
  held?: Array<Record<string, unknown>>;
  decisions?: Array<Record<string, unknown>>;
  requests?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
  owed?: Array<Record<string, unknown>>;
  claim?: FakeReply;
  /** The bills of requests out, by id (F1). */
  bills?: Array<Record<string, unknown>>;
  started?: Array<Record<string, unknown>>;
  /** The requests the agent signed as sent (X6). */
  sent?: string[];
}

function world(w: World = {}) {
  return fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/orgs") {
      return {
        body: { name: "Pinecrest Studio", mode: w.mode ?? "live", term_requests_on_at: w.on === false ? null : "2026-10-17T08:00:00Z", term_requests_on_by: w.onBy === undefined ? OWNER : w.onBy, term_requests_max_days: w.maxDays ?? 14 },
      };
    }
    if (request.path === "/rest/v1/rpc/agent_paused") return { body: w.paused === true };
    if (request.path === "/rest/v1/rpc/term_requests_ready") return { body: true };
    if (request.path === "/rest/v1/rpc/org_members") return { body: [{ user_id: OWNER, email: "owner@pinecrest.example", role: "owner", joined_at: "2026-09-01T00:00:00Z" }] };
    if (request.path === "/rest/v1/payment_term_request_reviews" && request.method === "GET") return { body: w.reviews ?? [] };
    if (request.path === "/rest/v1/payment_term_request_reviews" && request.method === "POST") return w.claim ?? { body: { id: "review-1" } };
    if (request.path === "/rest/v1/invoices") {
      if (request.params.get("status") === "eq.held") return { body: w.held ?? [held()] };
      if (request.params.get("direction") === "eq.receivable") return { body: w.owed ?? [{ amount: "250", due_date: "2026-10-30T12:00:00+00:00" }] };
      if (request.params.has("id")) return { body: w.bills ?? [] };
      return { body: [] };
    }
    if (request.path === "/rest/v1/payment_intents") return { body: w.started ?? [] };
    if (request.path === "/rest/v1/ledger_entries" && request.params.get("action") === "eq.term_request_sent") {
      return { body: (w.sent ?? []).map((id) => ({ detail: { requestId: id } })) };
    }
    if (request.path === "/rest/v1/ledger_entries") return { body: w.decisions ?? [forCash] };
    if (request.path === "/rest/v1/payment_term_requests") return { body: w.requests ?? [] };
    if (request.path === "/rest/v1/rpc/create_term_request") {
      const days = (request.body as { p_days: number }).p_days;
      const newDue = new Date(Date.parse("2026-10-20T12:00:00Z") + days * DAY).toISOString();
      return { body: { id: "request-1", invoice_id: INVOICE, counterparty_id: SUPPLIER, days, amount: "300.000000", due_date: "2026-10-20T12:00:00+00:00", new_due_date: newDue, currency: "USDC", expires_at: "2026-10-22T09:00:00+00:00" } };
    }
    if (request.path === "/rest/v1/rpc/withdraw_term_request") return { body: true };
    return { body: [] };
  });
}

function model(answer?: Record<string, unknown>) {
  decideMock.mockImplementation(async (params: DecideParams<unknown>) => {
    const reference = params.fallback() as { action: string };
    const value = answer ? params.schema.parse({ ...reference, ...answer }) : reference;
    return { value, mode: "deepseek", reference, agreedWithReference: (value as { action: string }).action === reference.action };
  });
}

const sendMock = vi.fn<(message: EmailMessage) => Promise<SendResult>>(async () => ({ sent: true, id: "email-1" }));
const run = (client: ReturnType<typeof fakeSupabase>, cash = 100) =>
  runWith(orgTestContext({ config, client: client.client, orgId: ORG }), () => makeTermRequests(db(), { operatingBalance: cash }, { now: NOW, send: sendMock, origin: "https://www.vestiarion.xyz" }));

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
  bestEffortMock.mockReset().mockResolvedValue(undefined);
  decideMock.mockReset();
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "email-1" });
  model();
});

describe("what code allows (X2, X3)", () => {
  const facts = (over: Partial<TermFacts> = {}): TermFacts => ({
    heldForCash: true,
    daysToDue: 3,
    askedBefore: false,
    reviewed: false,
    noticeEmail: "ap@lumen.example",
    supplierHasOpenRequest: false,
    supplierDeclinedAt: null,
    now: NOW,
    ...over,
  });

  it("allows a bill held for cash, due within two weeks, never asked about, its supplier reachable", () => {
    expect(termRequestAllowed(facts())).toEqual({ allowed: true });
    expect(termRequestAllowed(facts({ daysToDue: -7 }))).toEqual({ allowed: true });
  });

  it("refuses each thing that would make the request wrong, and says which", () => {
    expect(termRequestAllowed(facts({ heldForCash: false }))).toEqual({ allowed: false, because: "not_held_for_cash" });
    expect(termRequestAllowed(facts({ daysToDue: 15 }))).toEqual({ allowed: false, because: "not_due_soon" });
    expect(termRequestAllowed(facts({ daysToDue: -8 }))).toEqual({ allowed: false, because: "not_due_soon" });
    expect(termRequestAllowed(facts({ askedBefore: true }))).toEqual({ allowed: false, because: "asked_before" });
    expect(termRequestAllowed(facts({ reviewed: true }))).toEqual({ allowed: false, because: "reviewed" });
    expect(termRequestAllowed(facts({ noticeEmail: null }))).toEqual({ allowed: false, because: "no_email" });
    expect(termRequestAllowed(facts({ supplierHasOpenRequest: true }))).toEqual({ allowed: false, because: "supplier_has_request" });
    expect(termRequestAllowed(facts({ supplierDeclinedAt: new Date(NOW - 10 * DAY).toISOString() }))).toEqual({ allowed: false, because: "supplier_declined" });
    expect(termRequestAllowed(facts({ supplierDeclinedAt: new Date(NOW - 31 * DAY).toISOString() }))).toEqual({ allowed: true });
  });

  it("keeps the days from 3 to the most, and asks until what customers owe covers the bill", () => {
    expect(boundTermDays(10, 14, 7)).toEqual({ days: 10, limited: false });
    expect(boundTermDays(40, 14, 7)).toEqual({ days: 14, limited: true });
    expect(boundTermDays(1, 14, 7)).toEqual({ days: 3, limited: true });
    expect(boundTermDays(undefined, 14, 9)).toEqual({ days: 9, limited: false });
    // 100 in hand, 250 owed 10 days after the due date: covered then, so 11 days, never under 7.
    expect(referenceTermDays({ amount: 300, cashNow: 100, incoming: [{ daysAfterDue: 10, amount: 250 }], maxDays: 14 })).toBe(11);
    expect(referenceTermDays({ amount: 300, cashNow: 100, incoming: [{ daysAfterDue: 2, amount: 250 }], maxDays: 14 })).toBe(7);
    expect(referenceTermDays({ amount: 300, cashNow: 0, incoming: [{ daysAfterDue: 20, amount: 500 }], maxDays: 14 })).toBe(14);
  });
});

describe("a request the agent makes", () => {
  it("asks for the days the model picks, kept to the most, claims it, makes it, emails it once and signs it (X3-X6)", async () => {
    model({ action: "ask", days: 40, reasoning: "Lumen is owed 250 USDC by Oct 30; two weeks lets it be paid in full." });
    const client = world();
    const lines = await run(client);

    const asked = JSON.parse((decideMock.mock.calls[0][0] as DecideParams<unknown>).userPrompt) as Record<string, unknown>;
    expect(asked).toMatchObject({ bill: { amount: 300, daysToDue: 3, reference: "LP-130 brochures" }, days: { fewest: 3, most: 14 }, writtenPolicy: { action: "ask", days: 11 } });
    const claim = client.requests.find((r) => r.path === "/rest/v1/payment_term_request_reviews" && r.method === "POST")!;
    expect(claim.body).toMatchObject({ org_id: ORG, invoice_id: INVOICE, action: "ask", days: 14 });
    expect(client.requests.find((r) => r.path === "/rest/v1/rpc/create_term_request")?.body).toMatchObject({ p_org_id: ORG, p_invoice_id: INVOICE, p_days: 14 });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const email = sendMock.mock.calls[0][0];
    expect(email.to).toBe("ap@lumen.example");
    expect(email.subject).toBe("Pinecrest Studio asks for 14 more days on invoice LP-130 brochures");
    expect(email.text).toContain("Pinecrest Studio asks to pay invoice LP-130 brochures on Nov 3, 2026 instead of Oct 20, 2026: 14 more days, for the full 300.00 USDC.");
    expect(email.text).toMatch(/https:\/\/www\.vestiarion\.xyz\/more-time\/vxt_[A-Za-z0-9_-]{43}/);
    expect(email.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);

    const updates = client.requests.filter((r) => r.path === "/rest/v1/payment_term_request_reviews" && r.method === "PATCH").map((r) => r.body);
    expect(updates).toEqual([{ request_id: "request-1" }, { emailed_at: expect.any(String) }]);
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({
      actor: "agent",
      action: "term_request_sent",
      detail: { via: "agent", requestId: "request-1", invoiceId: INVOICE, to: "ap***@lumen.example", days: 14, daysLimited: { chosen: 40, sent: 14 }, decisionMode: "deepseek" },
    });
    expect(ledgerMock.mock.calls[0][0].detail.decision.reasoning).toContain("code allows 3 to 14, so the request asks for 14");
    expect(JSON.stringify(ledgerMock.mock.calls)).not.toContain("vxt_");
    expect(lines).toEqual([{ domain: "ap", message: "Asked Lumen Print Co. by email for 14 more days, to Nov 3, 2026" }]);
  });

  it("is never made for a bill held for another reason, where it is off, while paused, or in a sandbox whose member left", async () => {
    for (const w of [{ decisions: [{ seq: 901, detail: { invoiceId: INVOICE, execution: { resultingStatus: "held" } } }] }, { on: false }, { paused: true }, { mode: "sandbox", onBy: "gone" }] as World[]) {
      const client = world(w);
      await run(client);
      expect(client.requests.some((r) => r.path === "/rest/v1/rpc/create_term_request"), JSON.stringify(w)).toBe(false);
    }
    expect(decideMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("is not made when the model skips: the skip is signed and the bill weighed again in a week (X3)", async () => {
    model({ action: "skip", reasoning: "Nothing comes in within two weeks; a person should decide." });
    const client = world();
    const lines = await run(client);
    expect(client.requests.find((r) => r.path === "/rest/v1/payment_term_request_reviews" && r.method === "POST")?.body).toMatchObject({ invoice_id: INVOICE, action: "skip" });
    expect(client.requests.some((r) => r.path === "/rest/v1/rpc/create_term_request")).toBe(false);
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({ action: "term_request_skipped", detail: { decision: { action: "skip" }, agreedWithReference: false } });
    expect(lines).toEqual([{ domain: "ap", message: "Lumen Print Co.: no request for more time, weighed again in 7 days" }]);
  });

  it("is withdrawn when its email never went, or when a stopped run left it unsent (X6)", async () => {
    sendMock.mockResolvedValue({ sent: false, reason: "resend 500" });
    const failed = world();
    await run(failed);
    expect(failed.requests.find((r) => r.path === "/rest/v1/rpc/withdraw_term_request")?.body).toMatchObject({ p_org_id: ORG, p_request_id: "request-1" });
    expect(failed.requests.some((r) => r.path === "/rest/v1/payment_term_request_reviews" && r.method === "DELETE")).toBe(true);
    expect(ledgerMock).not.toHaveBeenCalled();

    const stale = { id: "review-0", invoice_id: "other-bill", action: "ask", request_id: "request-0", decided_at: new Date(NOW - 20 * 60_000).toISOString(), emailed_at: null };
    const stopped = world({ reviews: [stale], held: [] });
    await run(stopped);
    expect(stopped.requests.find((r) => r.path === "/rest/v1/rpc/withdraw_term_request")?.body).toMatchObject({ p_request_id: "request-0" });
    expect(ledgerMock.mock.calls[0][0]).toMatchObject({ action: "term_request_withdrawn", detail: { requestId: "request-0", reason: "not_emailed" } });
  });

  it("goes, in a sandbox, to the member who turned the requests on, and says it is a sandbox", async () => {
    const client = world({ mode: "sandbox", held: [held({ counterparties: { name: "Kestrel Print Co", notice_email: null } })] });
    await run(client);
    const email = sendMock.mock.calls[0][0];
    expect(email.to).toBe("owner@pinecrest.example");
    expect(email.subject).toMatch(/^\[Sandbox\] /);
    expect(email.text).toContain("This is a sandbox. You get this in place of Kestrel Print Co, a sample supplier");
    expect(ledgerMock.mock.calls[0][0].detail).toMatchObject({ sandbox: true, to: "ow***@pinecrest.example" });
  });
});

describe("a request no longer needed (follow-up F1, F2)", () => {
  const out = { id: "request-0", invoice_id: INVOICE, counterparty_id: SUPPLIER, status: "open", days: 14, due_date: "2026-10-20T12:00:00+00:00", decided_at: null, expires_at: "2026-10-22T09:00:00+00:00" };
  const bill = (over: Record<string, unknown> = {}) => ({ id: INVOICE, status: "held", amount: "300", currency: "USDC", due_date: "2026-10-20T12:00:00+00:00", memo: "LP-130 brochures", counterparties: { name: "Lumen Print Co.", notice_email: "ap@lumen.example" }, ...over });
  const withdrawals = (client: ReturnType<typeof world>) => client.requests.filter((r) => r.path === "/rest/v1/rpc/withdraw_term_request");
  const signed = () => ledgerMock.mock.calls.map((call) => call[0] as { action: string; detail: Record<string, unknown> }).filter((e) => e.action === "term_request_withdrawn");

  it("is withdrawn once the bill is paid, the supplier told, and the withdrawal signed", async () => {
    const client = world({ requests: [out], bills: [bill({ status: "paid" })], held: [] });
    const lines = await run(client);
    expect(withdrawals(client)[0]?.body).toMatchObject({ p_request_id: "request-0" });
    const message = sendMock.mock.calls[0][0];
    expect(message.to).toBe("ap@lumen.example");
    expect(message.subject).toBe("Pinecrest Studio no longer needs more time on invoice LP-130 brochures");
    expect(message.text).toContain("Pinecrest Studio is paying invoice LP-130 brochures, 300.00 USDC, on time, so it no longer needs the 14 more days it asked for.");
    expect(message.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(signed()[0].detail).toMatchObject({ requestId: "request-0", reason: "paid", supplierTold: true, via: "agent" });
    expect(lines[0].message).toBe("Withdrew the request for more time to Lumen Print Co.: the bill is being paid on time, and told them");
  });

  it("is withdrawn when the bill is no longer held for want of cash, saying it stays due on its date", async () => {
    await run(world({ requests: [out], bills: [bill({ status: "scheduled" })], held: [] }));
    expect(sendMock.mock.calls[0][0].text).toContain("it stays due on Oct 20, 2026, as before.");
    expect(signed()[0].detail).toMatchObject({ reason: "not_needed" });
  });

  it("stays out while the bill is still held for want of cash, or its email is still going", async () => {
    const still = world({ requests: [out], bills: [bill()], held: [] });
    await run(still);
    expect(withdrawals(still)).toEqual([]);
    const going = world({ requests: [out], bills: [bill({ status: "paid" })], held: [], reviews: [{ id: "review-0", invoice_id: INVOICE, action: "ask", request_id: "request-0", decided_at: new Date(NOW - 60_000).toISOString(), emailed_at: null }] });
    await run(going);
    expect(withdrawals(going)).toEqual([]);
  });

  it("is followed up even after the requests are turned off", async () => {
    const client = world({ on: false, requests: [out], bills: [bill({ status: "paid" })] });
    await run(client);
    expect(withdrawals(client)).toHaveLength(1);
    expect(client.requests.some((r) => r.path === "/rest/v1/rpc/create_term_request")).toBe(false);
  });

  it("does not stop the bill being asked about again when the request was withdrawn before its email went (X6)", async () => {
    const unsent = { ...out, status: "withdrawn", decided_at: "2026-10-16T09:00:00Z" };
    const asked = world({ requests: [unsent] });
    await run(asked);
    expect(asked.requests.some((r) => r.path === "/rest/v1/rpc/create_term_request")).toBe(true);
    const seen = world({ requests: [unsent], sent: ["request-0"] });
    await run(seen);
    expect(seen.requests.some((r) => r.path === "/rest/v1/rpc/create_term_request")).toBe(false);
  });
});

describe("the supplier's answer (X5)", () => {
  const { token } = generateTermToken();
  const answered = (outcome: string) => fakeSupabase((request: RecordedRequest): FakeReply => {
    if (request.path === "/rest/v1/rpc/decide_term_request") {
      return { body: [{ outcome, request_id: "request-1", org_id: ORG, invoice_id: INVOICE, days: outcome === "accepted" ? 14 : null, new_due_date: outcome === "accepted" ? "2026-11-03T12:00:00+00:00" : null }] };
    }
    if (request.path === "/rest/v1/orgs") return { body: { mode: "live" } };
    return { body: [] };
  });
  const decideWith = (client: ReturnType<typeof fakeSupabase>, accept: boolean, raise = vi.fn()) =>
    runWith(orgTestContext({ config, client: client.client, orgId: ORG }), () => decideTermRequest(token, accept, { raise }));

  it("records an agreement and starts a cycle at once; records a decline and starts nothing", async () => {
    const raise = vi.fn();
    const client = answered("accepted");
    expect(await decideWith(client, true, raise)).toBe("accepted");
    expect(client.requests.find((r) => r.path === "/rest/v1/rpc/decide_term_request")?.body).toEqual({ p_token_hash: termTokenHash(token), p_accept: true });
    expect(bestEffortMock.mock.calls[0][1]).toMatchObject({ action: "term_request_accepted", detail: { requestId: "request-1", invoiceId: INVOICE, days: 14, via: "terms_link" } });
    expect(raise).toHaveBeenCalledWith({ orgId: ORG, sandbox: false, kind: "term_request_accepted" });

    const declined = vi.fn();
    expect(await decideWith(answered("declined"), false, declined)).toBe("declined");
    expect(bestEffortMock.mock.calls[1][1]).toMatchObject({ action: "term_request_declined" });
    expect(declined).not.toHaveBeenCalled();
  });

  it("records nothing for a changed bill, a stale link or a token that is not one", async () => {
    expect(await decideWith(answered("bill_changed"), true)).toBe("bill_changed");
    expect(await decideWith(answered("not_valid"), true)).toBe("not_valid");
    expect(termTokenHash("vxo_" + token.slice(4))).toBeNull();
    expect(bestEffortMock).not.toHaveBeenCalled();
  });
});

describe("the words (X4)", () => {
  const decode = (markup: string) => markup.replaceAll("&#x27;", "'").replaceAll("&amp;", "&").replaceAll("&quot;", '"');

  it("says who asks, for which invoice, the new date and the full amount, in the email and on the supplier's page", () => {
    const line = termRequestLine({ orgName: "Pinecrest Studio", reference: "INV-108", amount: 1000, currency: "USDC", dueDate: "2026-10-30T12:00:00Z", newDueDate: "2026-11-13T12:00:00Z", days: 14 });
    expect(line).toBe("Pinecrest Studio asks to pay invoice INV-108 on Nov 13, 2026 instead of Oct 30, 2026: 14 more days, for the full 1,000.00 USDC.");
    const email = termRequestEmail({ orgName: "Pinecrest Studio", supplierName: "Harbor", reference: null, amount: "1,000.00", token: "USDC", days: 14, dueOn: "Oct 30, 2026", newDueOn: "Nov 13, 2026", until: "Oct 22, 2026", url: "https://www.vestiarion.xyz/more-time/vxt_x", origin: "https://www.vestiarion.xyz" });
    expect(email.text).toContain("If you decline, or do nothing, the invoice stays due on Oct 30, 2026.");
    const page = decode(
      renderToStaticMarkup(
        <TermDecision token="vxt_x" request={{ orgName: "Pinecrest Studio", counterpartyName: "Harbor", reference: "INV-108", amount: 1000, currency: "USDC", dueDate: "2026-10-30T12:00:00Z", newDueDate: "2026-11-13T12:00:00Z", days: 14, expiresAt: "2026-10-22T09:00:00Z" }} />
      )
    );
    expect(page).toContain(line);
    expect(page).toContain("Agree to the new date");
    expect(page).toContain("Decline");
  });

  it("lets only an owner or admin turn the requests on, and lists the last ones on Bills (X1)", () => {
    const view = { setting: { on: false, maxDays: null, sandbox: false }, recent: [{ id: "r-1", counterpartyName: "Lumen Print Co.", days: 14, newDueDate: "2026-11-03T12:00:00Z", status: "accepted", decidedAt: "2026-10-17T10:00:00Z" }] };
    const owner = decode(renderToStaticMarkup(<TermRequests orgSlug="pinecrest" view={view} canWrite />));
    expect(owner).toContain("More time when cash is short");
    expect(owner).toContain("Let the agent ask for more time");
    expect(owner).toContain("Lumen Print Co. agreed to 14 more days, to Nov 3, 2026, Oct 17, 2026.");
    const viewer = decode(renderToStaticMarkup(<TermRequests orgSlug="pinecrest" view={view} canWrite={false} />));
    expect(viewer).not.toContain("Let the agent ask for more time");
    expect(viewer).toContain("The agent does not ask suppliers for more time. An owner or admin turns it on.");
    const on = decode(renderToStaticMarkup(<TermRequests orgSlug="pinecrest" view={{ ...view, setting: { on: true, maxDays: 14, sandbox: true } }} canWrite />));
    expect(on).toContain("Stop the agent's requests");
    expect(on).toContain("In this sandbox, the requests go to the email of whoever turned them on");
  });
});
