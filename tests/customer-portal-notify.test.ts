import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { customerPreview, customerWroteEmail } from "@/lib/email/customer-wrote";
import { CUSTOMER_NOTICE_MAX_RECIPIENTS, notifyCustomerWrote } from "@/lib/notifications/customer-portal";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Telling the members who answer customers that a customer wrote on its statement link
 * (docs/superpowers/specs/2026-10-13-customer-portal-design.md P8): owners and admins (`records.write`) whose email switch
 * is on, at most ten, each their own message, with a short preview of the words and a link into the workspace. Best
 * effort: it never throws. How often is the database's (0109's `notified_at`): at most once an hour per request.
 */

const { sendEmailMock, emailSettingsMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn(), emailSettingsMock: vi.fn() }));
vi.mock("@/lib/email/send", () => ({ sendEmail: sendEmailMock, emailSettingsFromEnv: emailSettingsMock }));

const ORG = "7d0f3a2e-8c1b-4f7a-9e6d-00000000c0c0";
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const SETTINGS = { apiKey: "test-resend-key", from: "Vestiarion <no-reply@vestiarion.xyz>" };

interface MemberFixture {
  user_id: string;
  email: string;
  role: string;
  notify: boolean;
}

const member = (n: number, role: string, notify = true): MemberFixture => ({
  user_id: `0b6c1c9e-4a4f-4a7e-9b1e-0000000000${String(n).padStart(2, "0")}`,
  email: `member${String(n).padStart(2, "0")}@example.com`,
  role,
  notify,
});

function run<T>(members: MemberFixture[], fn: () => Promise<T>, respond?: (request: RecordedRequest) => FakeReply | null) {
  const fake = fakeSupabase((request) => {
    const answered = respond?.(request);
    if (answered) return answered;
    if (request.path === "/rest/v1/orgs") return { body: { name: "Northstar Studio", slug: "northstar" } };
    if (request.path === "/rest/v1/rpc/org_members") return { body: members.map(({ user_id, email, role }) => ({ user_id, email, role, joined_at: "2026-09-01T00:00:00Z" })) };
    if (request.path === "/rest/v1/memberships") return { body: members.map(({ user_id, notify }) => ({ user_id, notify_email: notify })) };
    return { body: [] };
  });
  return { fake, result: runWith({ config, db: fake.client, fetch: fake.fetch }, fn) };
}

const savedSiteUrl = process.env.SITE_URL;
beforeEach(() => {
  process.env.SITE_URL = "https://www.vestiarion.xyz";
  emailSettingsMock.mockReturnValue(SETTINGS);
  sendEmailMock.mockResolvedValue({ sent: true, id: "email-1" });
});
afterEach(() => {
  if (savedSiteUrl === undefined) delete process.env.SITE_URL;
  else process.env.SITE_URL = savedSiteUrl;
  sendEmailMock.mockReset();
  emailSettingsMock.mockReset();
  vi.restoreAllMocks();
});

const recipients = () => sendEmailMock.mock.calls.map(([message]) => (message as { to: string }).to);
const NOTICE = { orgId: ORG, customerName: "Acme Corp", kind: "dispute" as const, more: false, words: "We were charged twice for October." };

describe("notifyCustomerWrote", () => {
  it("emails the owners and admins whose switch is on, and no one else", async () => {
    const members = [member(1, "owner"), member(2, "admin"), member(3, "admin", false), member(4, "approver"), member(5, "viewer")];
    const { fake, result } = run(members, () => notifyCustomerWrote(NOTICE));
    expect(await result).toBe(2);
    expect(recipients().sort()).toEqual(["member01@example.com", "member02@example.com"]);
    const read = fake.requests.find((request) => request.path === "/rest/v1/memberships") as RecordedRequest;
    expect(read.params.get("org_id")).toBe(`eq.${ORG}`);
  });

  it("sends a short preview and a link into the workspace, never more of what the customer wrote", async () => {
    const long = `Please see https://evil.example/login and www.evil.example for proof. ${"More detail. ".repeat(40)}SECRET-TAIL`;
    const { result } = run([member(1, "owner")], () => notifyCustomerWrote({ ...NOTICE, words: long }));
    expect(await result).toBe(1);
    const [message] = sendEmailMock.mock.calls[0] as [{ to: string; subject: string; html: string; text: string }];
    expect(message.subject).toBe("Acme Corp disputed an invoice");
    for (const body of [message.html, message.text]) {
      expect(body).toContain("https://www.vestiarion.xyz/o/northstar/invoices?tab=receivables#from-customers");
      expect(body).not.toContain("SECRET-TAIL");
      expect(body).not.toContain("evil.example");
    }
    expect(message.subject).not.toContain("charged");
  });

  it("caps the recipients", async () => {
    const members = Array.from({ length: CUSTOMER_NOTICE_MAX_RECIPIENTS + 3 }, (_, i) => member(i + 1, i === 0 ? "owner" : "admin"));
    const { result } = run(members, () => notifyCustomerWrote(NOTICE));
    expect(await result).toBe(CUSTOMER_NOTICE_MAX_RECIPIENTS);
    expect(recipients()).toContain("member01@example.com");
  });

  it("sends nothing without email configured, and never throws", async () => {
    emailSettingsMock.mockReturnValue(null);
    const quiet = run([member(1, "owner")], () => notifyCustomerWrote(NOTICE));
    expect(await quiet.result).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();

    emailSettingsMock.mockReturnValue(SETTINGS);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const broken = run([member(1, "owner")], () => notifyCustomerWrote(NOTICE), (request) => (request.path === "/rest/v1/rpc/org_members" ? { status: 500, body: { message: "down" } } : null));
    expect(await broken.result).toBe(0);

    sendEmailMock.mockResolvedValue({ sent: false, reason: "status 500" });
    const refused = run([member(1, "owner")], () => notifyCustomerWrote(NOTICE));
    expect(await refused.result).toBe(0);
  });
});

describe("customerWroteEmail", () => {
  const email = (over: Partial<Parameters<typeof customerWroteEmail>[0]> = {}) =>
    customerWroteEmail({
      orgName: "Northstar <Studio>",
      customerName: "Acme & Co",
      kind: "paid",
      more: false,
      preview: null,
      link: "https://www.vestiarion.xyz/o/northstar/invoices?tab=receivables#from-customers",
      origin: "https://www.vestiarion.xyz",
      ...over,
    });

  it("says a claim of payment is the customer's word, never a payment", () => {
    const { subject, html, text } = email();
    expect(subject).toBe("Acme & Co says it paid an invoice");
    expect(text).toContain("It is the customer's word, not a payment: the invoice stays open until the money arrives and is applied.");
    expect(html).toContain("Acme &amp; Co");
    expect(html).toContain("Northstar &lt;Studio&gt;");
    expect(html).not.toContain("<Studio>");
  });

  it("names each kind, and words added to a request already open", () => {
    expect(email({ kind: "promise" }).subject).toBe("Acme & Co promised to pay an invoice");
    expect(email({ kind: "dispute" }).subject).toBe("Acme & Co disputed an invoice");
    expect(email({ kind: "pay_link" }).subject).toBe("Acme & Co asked for a pay link");
    expect(email({ kind: "dispute", more: true }).subject).toBe("Acme & Co wrote more on its statement");
  });

  it("escapes the preview", () => {
    const { html } = email({ kind: "dispute", preview: `<img src=x onerror="alert(1)"> wrong rate` });
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});

describe("customerPreview", () => {
  it("is one line of at most 140 characters, with links left out", () => {
    expect(customerPreview(null)).toBeNull();
    expect(customerPreview("   ")).toBeNull();
    expect(customerPreview("Paid\n\n  on   Friday")).toBe("Paid on Friday");
    expect(customerPreview("See https://evil.example/x?y=1 and WWW.evil.example now")).toBe("See [link] and [link] now");
    const long = customerPreview("word ".repeat(100)) as string;
    expect([...long].length).toBeLessThanOrEqual(140);
    expect(long.endsWith("…")).toBe(true);
  });
});
