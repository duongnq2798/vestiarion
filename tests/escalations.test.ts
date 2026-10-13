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
    if (request.path === "/rest/v1/invoices") return { body: options.invoices ?? [payable(LATE), payable(ON_TIME, { due_date: "2026-10-20T00:00:00Z" })] };
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

describe("escalateOverdueDecisions", () => {
  it("finds the waiting payables past their decide-by day", async () => {
    const { run } = escalationFake();
    expect((await run(() => pastDecideBy(NOW))).map(({ id, item }) => [id, item.decideBy])).toEqual([[LATE, "2026-10-12"]]);
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
