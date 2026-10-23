import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { decisionEscalationEmail } from "@/lib/email/decision-escalation";
import { decideByOf, decideByWords, exceptionFacts, ownersWords, priorityOf, whoCanAct } from "@/lib/exceptions";
import { escalateOverdueDecisions, pastDecideBy } from "@/lib/notifications/escalations";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Held payables as exceptions someone owns (docs/superpowers/specs/2026-10-13-deal-cash-readiness-design.md E1-E5): the
 * day each must be decided by, its priority, who can act, and the one escalation email when that day passes undecided.
 * The escalation runs against a real supabase-js client whose network is a recorder, as tests/notifications.test.ts does.
 */

const { sendEmailMock, emailSettingsMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn(), emailSettingsMock: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: sendEmailMock, emailSettingsFromEnv: emailSettingsMock }));

const TODAY = "2026-10-13";
const NOW = new Date(`${TODAY}T08:00:00.000Z`);

describe("the decide-by day and the priority", () => {
  it("is the due date, or the discount's deadline while it is still ahead and earlier", () => {
    expect(decideByOf({ dueDate: "2026-10-20T00:00:00Z" }, TODAY)).toEqual({ day: "2026-10-20", reason: "due" });
    expect(decideByOf({ dueDate: "2026-10-20T00:00:00Z", discount: { pct: 2, deadline: "2026-10-15" } }, TODAY)).toEqual({ day: "2026-10-15", reason: "discount" });
    // A deadline gone by leaves the due date.
    expect(decideByOf({ dueDate: "2026-10-20T00:00:00Z", discount: { pct: 2, deadline: "2026-10-10" } }, TODAY)).toEqual({ day: "2026-10-20", reason: "due" });
    expect(decideByWords({ day: "2026-10-15", reason: "discount" })).toBe("Decide by Oct 15, 2026 to keep the early-payment discount");
  });

  it("keeps the due date for a bill past it with a late fee, and names the fee in its words (late fees LF5)", () => {
    const lateFee = { kind: "percent_month" as const, value: 1.5, startsOn: "2026-10-20" };
    // Overdue since Oct 10, with days before the fee: the due date stays its day, so it is overdue, as without the fee.
    const overdue = decideByOf({ dueDate: "2026-10-10T12:00:00Z", lateFee }, TODAY);
    expect(overdue).toEqual({ day: "2026-10-10", reason: "late_fee", lateFee: { dueOn: "2026-10-10", startsOn: "2026-10-20", rate: "1.5% a month", started: false } });
    expect(overdue.day).toBe(decideByOf({ dueDate: "2026-10-10T12:00:00Z" }, TODAY).day);
    expect(priorityOf(overdue.day, TODAY)).toBe("overdue");
    expect(decideByWords(overdue)).toBe("Decide by Oct 10, 2026; a late fee of 1.5% a month starts Oct 20, 2026");
    expect(exceptionFacts({ dueDate: "2026-10-10T12:00:00Z", lateFee, createdBy: null }, [], TODAY).priority).toBe("overdue");
    // Once the fee has started, still the due date; the words say since when it applies.
    const started = decideByOf({ dueDate: "2026-10-01T12:00:00Z", lateFee: { ...lateFee, startsOn: "2026-10-10" } }, TODAY);
    expect(started).toEqual({ day: "2026-10-01", reason: "late_fee", lateFee: { dueOn: "2026-10-01", startsOn: "2026-10-10", rate: "1.5% a month", started: true } });
    expect(decideByWords(started)).toBe("Decide by Oct 1, 2026; a late fee of 1.5% a month applies since Oct 10, 2026");
    // A fee from the day after the due date: the same day, and the fee named.
    expect(decideByWords(decideByOf({ dueDate: "2026-10-12T12:00:00Z", lateFee: { ...lateFee, startsOn: "2026-10-13" } }, TODAY))).toBe(
      "Decide by Oct 12, 2026; a late fee of 1.5% a month applies since Oct 13, 2026"
    );
    // Not yet past its due date: exactly as without the fee, the discount's deadline included.
    expect(decideByOf({ dueDate: "2026-10-15T12:00:00Z", lateFee }, TODAY)).toEqual({ day: "2026-10-15", reason: "due" });
    expect(decideByOf({ dueDate: `${TODAY}T12:00:00Z`, lateFee: { ...lateFee, startsOn: TODAY } }, TODAY)).toEqual({ day: TODAY, reason: "due" });
    expect(decideByOf({ dueDate: "2026-10-20T00:00:00Z", discount: { pct: 2, deadline: "2026-10-15" }, lateFee }, TODAY)).toEqual({ day: "2026-10-15", reason: "discount" });
    // A fixed fee in the bill's currency.
    expect(decideByOf({ dueDate: "2026-10-10T12:00:00Z", currency: "EURC", lateFee: { kind: "fixed", value: 25, startsOn: "2026-10-14" } }, TODAY)).toMatchObject({
      day: "2026-10-10",
      reason: "late_fee",
      lateFee: { rate: "25.00 EURC", started: false },
    });
  });

  it("is what it was before late fees for a bill without one (late fees LF5)", () => {
    const bills = [
      { dueDate: "2026-10-10T12:00:00Z" },
      { dueDate: `${TODAY}T00:00:00Z` },
      { dueDate: "2026-10-20T00:00:00Z", discount: { pct: 2, deadline: "2026-10-15" } },
      { dueDate: "2026-10-20T00:00:00Z", discount: { pct: 2, deadline: "2026-10-10" } },
    ];
    expect(bills.map((bill) => JSON.stringify(decideByOf({ ...bill, lateFee: null, currency: "USDC" }, TODAY)))).toEqual([
      '{"day":"2026-10-10","reason":"due"}',
      `{"day":"${TODAY}","reason":"due"}`,
      '{"day":"2026-10-15","reason":"discount"}',
      '{"day":"2026-10-20","reason":"due"}',
    ]);
    expect(decideByWords(decideByOf({ dueDate: "2026-10-10T12:00:00Z", lateFee: null }, TODAY))).toBe("Decide by Oct 10, 2026");
  });

  it("is overdue, due today, due this week, or later", () => {
    expect(priorityOf("2026-10-12", TODAY)).toBe("overdue");
    expect(priorityOf(TODAY, TODAY)).toBe("today");
    expect(priorityOf("2026-10-19", TODAY)).toBe("week");
    expect(priorityOf("2026-10-20", TODAY)).toBe("later");
  });
});

describe("who can act", () => {
  const members = [
    { userId: "u-viewer", email: "viewer@northstar.example", role: "viewer" },
    { userId: "u-approver", email: "ben@northstar.example", role: "approver" },
    { userId: "u-owner", email: "ana@northstar.example", role: "owner" },
    { userId: "u-admin", email: "cam@northstar.example", role: "admin" },
  ];

  it("is every member who may decide, owners first, less who entered it", () => {
    expect(whoCanAct(members, "u-admin").map((member) => member.email)).toEqual(["ana@northstar.example", "ben@northstar.example"]);
    expect(exceptionFacts({ dueDate: "2026-10-12", createdBy: null }, members, TODAY)).toEqual({
      decideBy: { day: "2026-10-12", reason: "due" },
      priority: "overdue",
      owners: ["ana@northstar.example", "cam@northstar.example", "ben@northstar.example"],
    });
  });

  it("keeps who entered it when nobody else may decide, and says the way forward when nobody may", () => {
    expect(whoCanAct(members.slice(0, 3).filter((member) => member.role !== "approver"), "u-owner").map((member) => member.email)).toEqual(["ana@northstar.example"]);
    expect(ownersWords(["ana@northstar.example", "cam@northstar.example", "ben@northstar.example"], "cam@northstar.example")).toBe("Who can act: ana@northstar.example, you and 1 more");
    expect(ownersWords([])).toBe("Nobody in this workspace can approve it yet: an owner invites an approver from Members.");
  });

  it("never names an accountant, who decides no payment (accountant console A1)", () => {
    const withAccountant = [...members, { userId: "u-books", email: "books@ledgerline.example", role: "accountant" }];
    expect(whoCanAct(withAccountant, null).map((member) => member.userId)).toEqual(["u-owner", "u-admin", "u-approver"]);
    expect(whoCanAct([withAccountant[0], withAccountant[4]], null)).toEqual([]);
  });

  it("leaves out whoever a first payment's address leaves out, names the only approver anyway, and no one when none is left (N4)", () => {
    // The approver confirmed an address no member answers for alone; the admin entered the bill.
    expect(whoCanAct(members, "u-admin", ["u-approver"]).map((member) => member.userId)).toEqual(["u-owner"]);
    expect(exceptionFacts({ dueDate: "2026-10-12", createdBy: "u-admin", leftOut: ["u-approver"] }, members, TODAY).owners).toEqual(["ana@northstar.example"]);
    // Two who may decide: one entered it, the other confirmed it. Neither may pay it, so the card says nobody can yet.
    const two = members.filter((member) => member.role === "owner" || member.role === "approver");
    expect(whoCanAct(two, "u-owner", ["u-approver"])).toEqual([]);
    // The workspace's only approver decides alone, whatever they entered, gave or confirmed.
    expect(whoCanAct(members.filter((member) => member.role === "owner"), "u-owner", ["u-owner"]).map((member) => member.userId)).toEqual(["u-owner"]);
  });
});

describe("the escalation email", () => {
  it("names each payable, its amount and the day it was to be decided by, escaped, with no address", () => {
    const email = decisionEscalationEmail({
      orgName: "Northstar <Labs>",
      items: [{ counterpartyName: "Acme & Co", amount: 1200, currency: "USDC", status: "held", decideBy: "2026-10-12", discount: false }],
      link: "https://tests.vestiarion.xyz/o/northstar/approvals",
      origin: "https://tests.vestiarion.xyz",
    });
    expect(email.subject).toBe("1 payment passed its decide-by day in Northstar <Labs>");
    expect(email.text).toContain("- Acme & Co: 1,200.00 USDC, Held, to decide by Oct 12, 2026");
    expect(email.html).toContain("Acme &amp; Co");
    expect(email.html).toContain("Northstar &lt;Labs&gt;");
    expect(email.html).not.toContain("<Labs>");
  });

  describe("with late fees (late fees LF5)", () => {
    const link = "https://tests.vestiarion.xyz/o/northstar/approvals";
    const origin = "https://tests.vestiarion.xyz";
    const overdue = { counterpartyName: "Acme", amount: 1200, currency: "USDC", status: "held" as const, decideBy: "2026-10-20", discount: false };
    const ahead = { ...overdue, lateFee: { startsOn: "2026-10-30", rate: "1.5% a month", started: false } };
    const started = { ...overdue, lateFee: { startsOn: "2026-10-21", rate: "1.5% a month", started: true } };
    const eve = { ...overdue, counterpartyName: "Globex", decideBy: "2026-10-29", lateFee: { startsOn: "2026-10-30", rate: "25.00 USDC", started: false }, eve: true };
    const email = (items: Parameters<typeof decisionEscalationEmail>[0]["items"]) => decisionEscalationEmail({ orgName: "Northstar", items, link, origin });

    it("says a payment past its decide-by day passed it, as before, and names its late fee", () => {
      const before = email([ahead]);
      expect(before.subject).toBe("1 payment passed its decide-by day in Northstar");
      expect(before.text).toContain("1 payment in Northstar passed the day it was to be decided by.");
      expect(before.text).toContain("- Acme: 1,200.00 USDC, Held, to decide by Oct 20, 2026; a late fee of 1.5% a month starts Oct 30, 2026");
      expect(email([started]).text).toContain("- Acme: 1,200.00 USDC, Held, to decide by Oct 20, 2026; a late fee of 1.5% a month applies since Oct 21, 2026");
    });

    it("says on a late fee's eve that the fee starts tomorrow, with its day and rate", () => {
      const sent = email([eve]);
      expect(sent.subject).toBe("A late fee starts tomorrow on 1 payment in Northstar");
      expect(sent.text).toContain("1 payment in Northstar has a late fee that starts tomorrow.");
      expect(sent.text).toContain("- Globex: 1,200.00 USDC, Held, to decide by Oct 29, 2026, before a late fee of 25.00 USDC starts tomorrow, Oct 30, 2026");
      expect(sent.html).toContain("before a late fee of 25.00 USDC starts tomorrow, Oct 30, 2026");
      expect(`${sent.subject} ${sent.text}`).not.toMatch(/passed|reached/);
    });

    it("words each payment on its own in a batch that mixes a fee's eve with payments past their day", () => {
      const lineOf = (text: string, name: string) => text.split("\n").find((line) => line.startsWith(`- ${name}:`));
      const mixed = email([{ ...ahead, counterpartyName: "Initech" }, eve, started]);
      expect(mixed.subject).toBe("3 payments wait for a decision in Northstar; a late fee starts tomorrow");
      expect(mixed.text).toContain("3 payments in Northstar wait for a decision: 2 passed the day they were to be decided by, and 1 has a late fee that starts tomorrow.");
      // Each past payment reads as it does alone, never as reached; the eve reads as its own, and comes first.
      expect(lineOf(mixed.text, "Initech")).toBe(lineOf(email([{ ...ahead, counterpartyName: "Initech" }]).text, "Initech"));
      expect(lineOf(mixed.text, "Acme")).toBe(lineOf(email([started]).text, "Acme"));
      expect(lineOf(mixed.text, "Globex")).toBe(lineOf(email([eve]).text, "Globex"));
      expect(mixed.text.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2, line.indexOf(":")))).toEqual(["Globex", "Initech", "Acme"]);
      expect(`${mixed.subject} ${mixed.text} ${mixed.html}`).not.toContain("reached");
    });
  });
});

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000e5c1";
const LATE = "018f8ce0-1557-7b54-a931-4d777f6be001";
const ON_TIME = "018f8ce0-1557-7b54-a931-4d777f6be002";
const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
const savedSiteUrl = process.env.SITE_URL;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
  process.env.SITE_URL = "https://tests.vestiarion.xyz";
  emailSettingsMock.mockReturnValue({ apiKey: "test-resend-key", from: "Vestiarion <no-reply@vestiarion.xyz>" });
  sendEmailMock.mockResolvedValue({ sent: true, id: "email-1" });
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
  if (savedSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = savedSiteUrl;
  sendEmailMock.mockReset();
  emailSettingsMock.mockReset();
  vi.restoreAllMocks();
});

const payable = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  amount: "1200",
  currency: "USDC",
  status: "held",
  due_date: "2026-10-12T00:00:00Z",
  early_pay_discount_pct: null,
  discount_due_date: null,
  counterparties: { name: "Northwind Hosting" },
  ...over,
});

/** PostgREST as the escalation meets it: the waiting payables, the claims, the members, the workspace and the ledger. */
function escalationFake(
  options: {
    invoices?: unknown[];
    claimed?: (rows: Array<{ invoice_id: string; decide_by: string }>) => FakeReply;
    members?: Array<{ user_id: string; email: string; role: string; notify: boolean }>;
    /** The day this workspace's escalations started: Oct 1 unless said, null for none set yet. */
    startsOn?: string | null;
    /** What the members' read answers, by its number in the run (1 first); the members when it answers nothing. */
    membersRead?: (call: number) => FakeReply | null;
    /** What a request to the claims answers, in place of `claimed` and the defaults, when it answers at all. */
    claims?: (request: RecordedRequest) => FakeReply | null;
    /** What a read of the invoices answers, in place of `invoices`, when it answers at all. */
    invoicesRead?: (request: RecordedRequest) => FakeReply | null;
  } = {}
) {
  const members = options.members ?? [
    { user_id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000001", email: "ana@northstar.example", role: "owner", notify: true },
    { user_id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000002", email: "ben@northstar.example", role: "approver", notify: false },
  ];
  let memberReads = 0;
  const fake = fakeSupabase((request: RecordedRequest) => {
    if (request.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG,
          slug: "northstar",
          name: "Northstar",
          mode: "live",
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
          circle_api_key_enc: null,
          circle_entity_secret_enc: null,
        },
      };
    }
    if (request.path === "/rest/v1/invoices" && options.invoicesRead) {
      const reply = options.invoicesRead(request);
      if (reply) return reply;
    }
    if (request.path === "/rest/v1/invoices") return { body: options.invoices ?? [payable(LATE), payable(ON_TIME, { due_date: "2026-10-20T00:00:00Z" })] };
    if (request.path === "/rest/v1/approval_escalations" && options.claims) {
      const reply = options.claims(request);
      if (reply) return reply;
    }
    if (request.path === "/rest/v1/approval_escalations" && request.method === "POST") {
      const rows = request.body as Array<{ invoice_id: string; decide_by: string }>;
      return options.claimed ? options.claimed(rows) : { body: rows.map((row, index) => ({ id: `claim-${index}`, ...row })) };
    }
    if (request.path === "/rest/v1/approval_escalations") return { body: [] };
    if (request.path === "/rest/v1/approval_escalation_starts" && request.method === "POST") {
      return { body: [{ starts_on: (request.body as { starts_on: string }).starts_on }] };
    }
    if (request.path === "/rest/v1/approval_escalation_starts") {
      const startsOn = options.startsOn === undefined ? "2026-10-01" : options.startsOn;
      return { body: startsOn ? [{ starts_on: startsOn }] : [] };
    }
    if (request.path === "/rest/v1/rpc/org_members" && options.membersRead) {
      const reply = options.membersRead(++memberReads);
      if (reply) return reply;
    }
    if (request.path === "/rest/v1/rpc/org_members") return { body: members.map(({ user_id, email, role }) => ({ user_id, email, role, joined_at: "2026-09-01T00:00:00Z" })) };
    if (request.path === "/rest/v1/memberships") return { body: members.map(({ user_id, notify }) => ({ user_id, notify_email: notify })) };
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return { body: { seq: 1, id: "e1", ts: NOW.toISOString(), actor: "system", domain: "system", action: "x", summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null } };
    }
    return { body: [] };
  });
  return { fake, run: <T,>(fn: () => Promise<T>) => runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, fn)) };
}

/**
 * The claims as Postgres keeps them across runs (`approval_escalations`, 0108): one per payable and day, an upsert that
 * ignores duplicates answering only the rows it inserted, each stamped `claimed_at` on the day of the run that claimed it;
 * read, released and marked as PostgREST would.
 */
function claimStore() {
  const rows: Array<{ id: string; invoice_id: string; decide_by: string; claimed_at: string }> = [];
  let today = "";
  let next = 0;
  const listOf = (value: string | null) => (value ?? "").replace(/^in\.\(/, "").replace(/\)$/, "").split(",").filter(Boolean);
  const reply = (request: RecordedRequest): FakeReply | null => {
    if (request.method === "POST") {
      const inserted = (request.body as Array<{ invoice_id: string; decide_by: string }>).flatMap((row) => {
        if (rows.some((kept) => kept.invoice_id === row.invoice_id && kept.decide_by === row.decide_by)) return [];
        const claim = { id: `claim-${++next}`, invoice_id: row.invoice_id, decide_by: row.decide_by, claimed_at: `${today}T08:00:01.000000+00:00` };
        rows.push(claim);
        return [claim];
      });
      return { body: inserted.map(({ id, invoice_id, decide_by }) => ({ id, invoice_id, decide_by })) };
    }
    if (request.method === "GET") {
      const ids = listOf(request.params.get("invoice_id"));
      const days = listOf(request.params.get("decide_by"));
      return { body: rows.filter((row) => (ids.length === 0 || ids.includes(row.invoice_id)) && (days.length === 0 || days.includes(row.decide_by))) };
    }
    if (request.method === "DELETE") {
      const ids = new Set(listOf(request.params.get("id")));
      rows.splice(0, rows.length, ...rows.filter((row) => !ids.has(row.id)));
    }
    return { body: [] };
  };
  return { rows, on: (day: string) => (today = day), reply };
}

describe("escalateOverdueDecisions", () => {
  it("finds the waiting payables past their decide-by day", async () => {
    const { run } = escalationFake();
    expect((await run(() => pastDecideBy(NOW))).map(({ id, item }) => [id, item.decideBy])).toEqual([[LATE, "2026-10-12"]]);
  });

  describe("with a late fee (late fees LF5): overdue on Oct 20, the fee from Oct 30", () => {
    const at = (day: string) => new Date(`${day}T08:00:00.000Z`);
    const due = { due_date: "2026-10-20T00:00:00Z" };
    const withFee = (over: Record<string, unknown> = {}) => payable(LATE, { ...due, late_fee_kind: "percent_month", late_fee_value: "1.5", late_fee_starts_on: "2026-10-30", ...over });
    const found = (row: unknown, day: string, from?: string) => escalationFake({ invoices: [row] }).run(() => pastDecideBy(at(day), from));
    const keys = async (row: unknown, day: string, from?: string) => (await found(row, day, from)).map(({ id, item }) => [id, item.decideBy]);

    it("finds it the day after its due date, keyed on the due date as before, with the fee's words", async () => {
      expect(await keys(withFee(), "2026-10-20")).toEqual([]);
      const first = await found(withFee(), "2026-10-21");
      expect(first.map(({ id, item }) => [id, item.decideBy])).toEqual([[LATE, "2026-10-20"]]);
      expect(first[0].item.lateFee).toEqual({ startsOn: "2026-10-30", rate: "1.5% a month", started: false });
      expect(first[0].item).not.toHaveProperty("eve");
    });

    it("finds on Oct 22 to Oct 28 exactly what it finds without the fee", async () => {
      for (const day of ["2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28"]) {
        expect(await keys(withFee(), day), day).toEqual(await keys(payable(LATE, due), day));
        expect(await keys(withFee(), day), day).toEqual([[LATE, "2026-10-20"]]);
      }
    });

    it("finds it once on the fee's eve, Oct 29, keyed on that day, a new escalation, whatever day escalations started", async () => {
      const eve = await found(withFee(), "2026-10-29");
      expect(eve.map(({ id, item }) => [id, item.decideBy])).toEqual([[LATE, "2026-10-29"]]);
      expect(eve[0].item).toMatchObject({ decideBy: "2026-10-29", eve: true, lateFee: { startsOn: "2026-10-30", rate: "1.5% a month", started: false } });
      // With it, the payable as past its due date, as without the fee: sent in place of the eve if that was never sent.
      expect(eve[0].passed).toEqual({ ...eve[0].item, decideBy: "2026-10-20", eve: undefined });
      expect(eve[0].passed).not.toHaveProperty("eve");
      // A start after the due date: the due date's key is left out, as before; the eve, today's day, is not.
      expect(await keys(withFee(), "2026-10-28", "2026-10-25")).toEqual([]);
      const backlog = await found(withFee(), "2026-10-29", "2026-10-25");
      expect(backlog.map(({ id, item }) => [id, item.decideBy])).toEqual([[LATE, "2026-10-29"]]);
      expect(backlog[0]).not.toHaveProperty("passed");
    });

    it("finds no eve once the fee has started, nor for a fee from the day after the due date", async () => {
      for (const day of ["2026-10-30", "2026-11-05"]) {
        const after = await found(withFee(), day);
        expect(after.map(({ id, item }) => [id, item.decideBy]), day).toEqual([[LATE, "2026-10-20"]]);
        expect(after[0].item).toMatchObject({ lateFee: { started: true } });
        expect(after[0].item).not.toHaveProperty("eve");
      }
      const next = await found(withFee({ late_fee_starts_on: "2026-10-21" }), "2026-10-21");
      expect(next.map(({ id, item }) => [id, item.decideBy])).toEqual([[LATE, "2026-10-20"]]);
      expect(next[0].item).toMatchObject({ lateFee: { startsOn: "2026-10-21", started: true } });
      expect(next[0].item).not.toHaveProperty("eve");
    });

    it("emails on the fee's eve, claimed for that day, saying the fee starts tomorrow", async () => {
      // Escalated for its due date on Oct 21: that claim is taken, so only the eve is news.
      const { fake, run } = escalationFake({
        invoices: [withFee()],
        claimed: (rows) => ({ body: rows.filter((row) => row.decide_by !== "2026-10-20").map((row, index) => ({ id: `claim-${index}`, ...row })) }),
      });
      expect(await run(() => escalateOverdueDecisions(at("2026-10-29")))).toEqual({ sent: 1, failed: 0, invoices: 1 });
      const claim = fake.requests.find((request) => request.path === "/rest/v1/approval_escalations" && request.method === "POST");
      expect(claim?.body).toEqual([
        { org_id: ORG, invoice_id: LATE, decide_by: "2026-10-29" },
        { org_id: ORG, invoice_id: LATE, decide_by: "2026-10-20" },
      ]);
      const sent = sendEmailMock.mock.calls[0][0] as { subject: string; text: string };
      expect(sent.subject).toBe("A late fee starts tomorrow on 1 payment in Northstar");
      expect(sent.text).toContain("to decide by Oct 29, 2026, before a late fee of 1.5% a month starts tomorrow, Oct 30, 2026");
      const ledger = fake.requests.find((request) => request.path === "/rest/v1/rpc/append_ledger_entry")?.body as Record<string, unknown>;
      expect(JSON.parse(JSON.stringify(ledger.p_detail))).toEqual({ invoiceIds: [LATE], decideBy: { [LATE]: "2026-10-29" }, recipients: 1, failed: 0 });
    });

    describe("day by day, against the claims as Postgres keeps them", () => {
      const daysFrom = (first: string, count: number) =>
        Array.from({ length: count }, (_, index) => new Date(Date.parse(`${first}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10));
      /**
       * Runs the escalation once on each day, against one store of claims: each day that sent, with the day it was sent
       * for and its line. `rowOn` is the payable as it is that day; on a day `refused` says, the send fails.
       */
      const daily = async (rowOn: (day: string) => unknown, days: string[], options: { refused?: (day: string) => boolean } = {}) => {
        const store = claimStore();
        const sent: Array<{ day: string; decideBy: string; line: string }> = [];
        const deletes: string[] = [];
        for (const day of days) {
          store.on(day);
          sendEmailMock.mockClear();
          sendEmailMock.mockResolvedValue(options.refused?.(day) ? { sent: false, reason: "resend refused" } : { sent: true, id: "email-1" });
          const { fake, run } = escalationFake({ invoices: [rowOn(day)], claims: store.reply });
          await run(() => escalateOverdueDecisions(at(day)));
          deletes.push(...fake.requests.filter((request) => request.path === "/rest/v1/approval_escalations" && request.method === "DELETE").map(() => day));
          const ledger = fake.requests.find((request) => request.path === "/rest/v1/rpc/append_ledger_entry")?.body as
            | { p_detail: { decideBy: Record<string, string> } }
            | undefined;
          if (!ledger) continue;
          const text = (sendEmailMock.mock.calls[0][0] as { text: string }).text;
          sent.push({ day, decideBy: ledger.p_detail.decideBy[LATE], line: text.split("\n").find((line) => line.startsWith("- ")) ?? "" });
        }
        return { sent, store, deletes };
      };
      const keysOf = (sent: Array<{ day: string; decideBy: string }>) => sent.map(({ day, decideBy }) => [day, decideBy]);

      it("sends what it sends without the fee, and the eve besides, and never releases a claim it sent", async () => {
        const days = daysFrom("2026-10-20", 14);
        const main = await daily(() => payable(LATE, due), days);
        const fee = await daily(() => withFee(), days);
        expect(keysOf(main.sent)).toEqual([["2026-10-21", "2026-10-20"]]);
        expect(keysOf(fee.sent)).toEqual([...keysOf(main.sent), ["2026-10-29", "2026-10-29"]]);
        expect(fee.store.rows.map(({ decide_by, claimed_at }) => [decide_by, claimed_at.slice(0, 10)])).toEqual([
          ["2026-10-20", "2026-10-21"],
          ["2026-10-29", "2026-10-29"],
        ]);
        expect(fee.deletes).toEqual([]);
      });

      it("never delays the escalation of a fee two days after the due date: the first day past it names the fee's start, and sends nothing more", async () => {
        const days = daysFrom("2026-10-20", 5);
        const main = await daily(() => payable(LATE, due), days);
        const fee = await daily(() => withFee({ late_fee_starts_on: "2026-10-22" }), days);
        expect(keysOf(main.sent)).toEqual([["2026-10-21", "2026-10-20"]]);
        expect(keysOf(fee.sent)).toEqual(keysOf(main.sent));
        expect(fee.sent[0].line).toBe("- Northwind Hosting: 1,200.00 USDC, Held, to decide by Oct 20, 2026; a late fee of 1.5% a month starts Oct 22, 2026");
      });

      it("sends a bill whose due date was never escalated by its fee's eve as without the fee, once, with its eve spent", async () => {
        // First waiting on its eve: Oct 29.
        const main = await daily(() => payable(LATE, due), ["2026-10-29", "2026-10-30", "2026-10-31"]);
        const fee = await daily(() => withFee(), ["2026-10-29", "2026-10-30", "2026-10-31"]);
        expect(keysOf(main.sent)).toEqual([["2026-10-29", "2026-10-20"]]);
        expect(keysOf(fee.sent)).toEqual(keysOf(main.sent));
        expect(fee.sent[0].line).toBe("- Northwind Hosting: 1,200.00 USDC, Held, to decide by Oct 20, 2026; a late fee of 1.5% a month starts Oct 30, 2026");
        // Every send refused until the eve: the same.
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        const refused = (day: string) => day < "2026-10-29";
        const days = daysFrom("2026-10-20", 12);
        const mainRefused = await daily(() => payable(LATE, due), days, { refused });
        const feeRefused = await daily(() => withFee(), days, { refused });
        expect(keysOf(mainRefused.sent)).toEqual([["2026-10-29", "2026-10-20"]]);
        expect(keysOf(feeRefused.sent)).toEqual(keysOf(mainRefused.sent));
      });

      it("escalates the new day when the due date moves to the day its eve was told, as without the fee", async () => {
        const moved = { due_date: "2026-10-29T00:00:00Z" };
        const days = ["2026-10-21", "2026-10-29", "2026-10-30", "2026-10-31"];
        const main = await daily((day) => payable(LATE, day < "2026-10-30" ? due : moved), days);
        // The fee's start moves with the due date (0141): Nov 8.
        const fee = await daily((day) => (day < "2026-10-30" ? withFee() : withFee({ ...moved, late_fee_starts_on: "2026-11-08" })), days);
        expect(keysOf(main.sent)).toEqual([
          ["2026-10-21", "2026-10-20"],
          ["2026-10-30", "2026-10-29"],
        ]);
        expect(keysOf(fee.sent)).toEqual([
          ["2026-10-21", "2026-10-20"],
          ["2026-10-29", "2026-10-29"],
          ["2026-10-30", "2026-10-29"],
        ]);
        expect(fee.sent[2].line).toBe("- Northwind Hosting: 1,200.00 USDC, Held, to decide by Oct 29, 2026; a late fee of 1.5% a month starts Nov 8, 2026");
        // The eve's claim, spent, gave way to the day that passed; that claim is kept.
        expect(fee.store.rows.map(({ decide_by, claimed_at }) => [decide_by, claimed_at.slice(0, 10)])).toEqual([
          ["2026-10-20", "2026-10-21"],
          ["2026-10-29", "2026-10-30"],
        ]);
      });

      it("leaves the claims as they are, and fails nothing, when they cannot be read for a spent eve", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => {});
        const { fake, run } = escalationFake({
          invoices: [withFee({ due_date: "2026-10-29T00:00:00Z", late_fee_starts_on: "2026-11-08" })],
          claimed: () => ({ body: [] }),
          claims: (request) => (request.method === "GET" ? { status: 500, body: { code: "XX000", message: "claims down" } } : null),
        });
        expect(await run(() => escalateOverdueDecisions(at("2026-10-30")))).toEqual({ sent: 0, failed: 0, invoices: 0 });
        expect(error).toHaveBeenCalledWith("escalations: spent eve claims not retaken", ORG, "claims down");
        expect(fake.requests.some((request) => request.path === "/rest/v1/approval_escalations" && request.method === "DELETE")).toBe(false);
        expect(sendEmailMock).not.toHaveBeenCalled();
      });
    });
  });

  it("reads the waiting payables again without their late fees before migration 0141, as before (late fees LF5)", async () => {
    const refused = vi.fn();
    const before0141 = escalationFake({
      invoices: [payable(LATE)],
      invoicesRead: (request) => {
        if (!(request.params.get("select") ?? "").includes("late_fee_")) return null;
        refused();
        return { status: 400, body: { code: "42703", message: "column invoices.late_fee_kind does not exist" } };
      },
    });
    const found = await before0141.run(() => pastDecideBy(NOW));
    expect(refused).toHaveBeenCalledTimes(1);
    expect(found.map(({ id }) => id)).toEqual([LATE]);
  });

  it("claims each payable for its day, emails each member whose switch is on, marks the claims and signs it", async () => {
    const { fake, run } = escalationFake();
    expect(await run(() => escalateOverdueDecisions(NOW))).toEqual({ sent: 1, failed: 0, invoices: 1 });
    const claim = fake.requests.find((request) => request.path === "/rest/v1/approval_escalations" && request.method === "POST");
    expect(claim?.body).toEqual([{ org_id: ORG, invoice_id: LATE, decide_by: "2026-10-12" }]);
    expect(claim?.params.get("on_conflict")).toBe("org_id,invoice_id,decide_by");
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: "ana@northstar.example", subject: "1 payment passed its decide-by day in Northstar" });
    const marked = fake.requests.find((request) => request.path === "/rest/v1/approval_escalations" && request.method === "PATCH");
    expect(marked?.body).toMatchObject({ recipients: 1, failed: 0 });
    const ledger = fake.requests.find((request) => request.path === "/rest/v1/rpc/append_ledger_entry")?.body as Record<string, unknown>;
    expect(ledger.p_action).toBe("decision_escalated");
    expect(JSON.parse(JSON.stringify(ledger.p_detail))).toEqual({ invoiceIds: [LATE], decideBy: { [LATE]: "2026-10-12" }, recipients: 1, failed: 0 });
  });

  it("tells each member about the payables they may decide: not whoever entered one, while someone else may", async () => {
    const ANA = "0b6c1c9e-4a4f-4a7e-9b1e-000000000001";
    const members = [
      { user_id: ANA, email: "ana@northstar.example", role: "owner", notify: true },
      { user_id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000002", email: "ben@northstar.example", role: "approver", notify: true },
    ];
    const { fake, run } = escalationFake({ members, invoices: [payable(LATE, { created_by: ANA }), payable(ON_TIME, { due_date: "2026-10-10T00:00:00Z" })] });
    expect(await run(() => escalateOverdueDecisions(NOW))).toEqual({ sent: 2, failed: 0, invoices: 2 });
    const sent = Object.fromEntries(sendEmailMock.mock.calls.map(([message]) => [(message as { to: string }).to, (message as { subject: string }).subject]));
    expect(sent).toEqual({
      "ana@northstar.example": "1 payment passed its decide-by day in Northstar",
      "ben@northstar.example": "2 payments passed their decide-by day in Northstar",
    });
    expect(fake.requests.some((request) => request.path === "/rest/v1/approval_escalations" && request.method === "DELETE")).toBe(false);
  });

  it("sends nothing for a payable escalated already for that day", async () => {
    const { fake, run } = escalationFake({ claimed: () => ({ body: [] }) });
    expect(await run(() => escalateOverdueDecisions(NOW))).toEqual({ sent: 0, failed: 0, invoices: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/append_ledger_entry")).toBe(false);
  });

  it("releases the claims when nobody received the email, so the next cycle tries again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    sendEmailMock.mockResolvedValue({ sent: false, reason: "resend refused" });
    const { fake, run } = escalationFake();
    expect(await run(() => escalateOverdueDecisions(NOW))).toEqual({ sent: 0, failed: 1, invoices: 1 });
    const released = fake.requests.find((request) => request.path === "/rest/v1/approval_escalations" && request.method === "DELETE");
    expect(released?.params.get("id")).toBe("in.(claim-0)");
    expect(fake.requests.some((request) => request.path === "/rest/v1/rpc/append_ledger_entry")).toBe(false);
  });

  it("claims nothing when email is not set up, or nobody has the switch on", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    emailSettingsMock.mockReturnValue(null);
    const unset = escalationFake();
    await unset.run(() => escalateOverdueDecisions(NOW));
    expect(unset.fake.requests.some((request) => request.path === "/rest/v1/approval_escalations")).toBe(false);

    emailSettingsMock.mockReturnValue({ apiKey: "k", from: "x" });
    const off = escalationFake({ members: [{ user_id: "0b6c1c9e-4a4f-4a7e-9b1e-000000000001", email: "ana@northstar.example", role: "owner", notify: false }] });
    await off.run(() => escalateOverdueDecisions(NOW));
    expect(off.fake.requests.some((request) => request.path === "/rest/v1/approval_escalations")).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("never emails a payable that was past its day before escalations started here", async () => {
    const STALE = "018f8ce0-1557-7b54-a931-4d777f6be003";
    const { fake, run } = escalationFake({ startsOn: "2026-10-12", invoices: [payable(LATE), payable(STALE, { due_date: "2026-09-01T00:00:00Z" })] });
    expect(await run(() => escalateOverdueDecisions(NOW))).toEqual({ sent: 1, failed: 0, invoices: 1 });
    const claim = fake.requests.find((request) => request.path === "/rest/v1/approval_escalations" && request.method === "POST");
    expect(claim?.body).toEqual([{ org_id: ORG, invoice_id: LATE, decide_by: "2026-10-12" }]);
  });

  it("starts at its first run, so every payable already past its day then never emails: no backlog when it is turned on", async () => {
    const { fake, run } = escalationFake({ startsOn: null, invoices: [payable(LATE), payable(ON_TIME, { due_date: "2026-08-01T00:00:00Z" })] });
    expect(await run(() => escalateOverdueDecisions(NOW))).toEqual({ sent: 0, failed: 0, invoices: 0 });
    const start = fake.requests.find((request) => request.path === "/rest/v1/approval_escalation_starts" && request.method === "POST");
    expect(start?.body).toEqual({ org_id: ORG, starts_on: TODAY });
    expect(start?.params.get("on_conflict")).toBe("org_id");
    expect(fake.requests.some((request) => request.path === "/rest/v1/approval_escalations")).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("escalates nothing, and fails nothing, before migration 0108 runs", async () => {
    const missing = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.approval_escalation_starts' in the schema cache" } };
    const fake = fakeSupabase((request) => (request.path === "/rest/v1/approval_escalation_starts" ? missing : { body: [] }));
    const sent = await runWith({ config, db: fake.client, fetch: fake.fetch }, () => withOrg(ORG, () => escalateOverdueDecisions(NOW)));
    expect(sent).toEqual({ sent: 0, failed: 0, invoices: 0 });
    expect(fake.requests.some((request) => request.path === "/rest/v1/invoices")).toBe(false);
  });

  it("reads who can act before claiming anything: a read that fails leaves every payable for the next cycle", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The recipients read, then the read of who may act on each payable fails.
    const { fake, run } = escalationFake({ membersRead: (call) => (call === 2 ? { status: 500, body: { code: "XX000", message: "members down" } } : null) });
    expect(await run(() => escalateOverdueDecisions(NOW))).toEqual({ sent: 0, failed: 0, invoices: 0 });
    expect(fake.requests.some((request) => request.path === "/rest/v1/approval_escalations")).toBe(false);
  });

  it("sends each member one email a cycle, however many payables passed their day, and none on the next", async () => {
    const ANA = "0b6c1c9e-4a4f-4a7e-9b1e-000000000001";
    const BEN = "0b6c1c9e-4a4f-4a7e-9b1e-000000000002";
    const members = [
      { user_id: ANA, email: "ana@northstar.example", role: "owner", notify: true },
      { user_id: BEN, email: "ben@northstar.example", role: "approver", notify: true },
      // The same person twice, as a read may list them: still one email.
      { user_id: ANA, email: "ana@northstar.example", role: "owner", notify: true },
    ];
    const ids = ["018f8ce0-1557-7b54-a931-4d777f6be011", "018f8ce0-1557-7b54-a931-4d777f6be012", "018f8ce0-1557-7b54-a931-4d777f6be013"];
    const taken = new Set<string>();
    // The claims as Postgres keeps them across runs: a key claimed once is never news again.
    const claimed = (rows: Array<{ invoice_id: string; decide_by: string }>): FakeReply => ({
      body: rows.flatMap((row, index) => {
        const key = `${row.invoice_id}|${row.decide_by}`;
        if (taken.has(key)) return [];
        taken.add(key);
        return [{ id: `claim-${row.invoice_id}-${index}`, ...row }];
      }),
    });
    const { run } = escalationFake({ members, claimed, invoices: ids.map((id, index) => payable(id, { due_date: `2026-10-1${index}T00:00:00Z` })) });
    expect(await run(() => escalateOverdueDecisions(NOW))).toEqual({ sent: 2, failed: 0, invoices: 3 });
    expect(sendEmailMock.mock.calls.map(([message]) => (message as { to: string }).to).sort()).toEqual(["ana@northstar.example", "ben@northstar.example"]);
    expect((sendEmailMock.mock.calls[0][0] as { subject: string }).subject).toBe("3 payments passed their decide-by day in Northstar");
    sendEmailMock.mockClear();
    expect(await run(() => escalateOverdueDecisions(NOW))).toEqual({ sent: 0, failed: 0, invoices: 0 });
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("never throws: a failure is logged by workspace, and a claim nobody received is released", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake, run } = escalationFake();
    sendEmailMock.mockRejectedValue(new Error("resend down"));
    await expect(run(() => escalateOverdueDecisions(NOW))).resolves.toMatchObject({ sent: 0 });
    expect(error).toHaveBeenCalledWith("escalations: failed", ORG, "resend down");
    expect(fake.requests.find((request) => request.path === "/rest/v1/approval_escalations" && request.method === "DELETE")?.params.get("id")).toBe("in.(claim-0)");
  });
});
