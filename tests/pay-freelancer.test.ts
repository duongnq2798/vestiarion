import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { parseFreelancerPayment, setUpFreelancerPayment } from "@/lib/pay-freelancer";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Paying a freelancer in one step
 * (docs/superpowers/specs/2026-10-01-pay-a-freelancer-design.md): a
 * contractor with the amount as its limit, a milestone verified by the person
 * setting it up, and a payee link, emailed when an email is given. Screening,
 * the link, the email and the ledger are faked; the two inserts go to a
 * recorded supabase-js client in the workspace's scope.
 */

const { screenMock, linkMock, sendMock, ledgerMock } = vi.hoisted(() => ({
  screenMock: vi.fn(),
  linkMock: vi.fn(),
  sendMock: vi.fn(),
  ledgerMock: vi.fn(),
}));
vi.mock("@/lib/compliance", () => ({ screenCounterparty: screenMock }));
vi.mock("@/lib/platform/payee-links", () => ({ createPayeeLink: linkMock }));
vi.mock("@/lib/email/send", () => ({ sendEmail: sendMock }));
vi.mock("@/lib/ledger", () => ({ appendLedgerEntry: ledgerMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const COUNTERPARTY = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const MILESTONE = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001b1";
const TOKEN = `vxp_${"A".repeat(43)}`;
const NOW = new Date("2026-10-01T15:00:00Z");

let fake: ReturnType<typeof fakeSupabase>;

function reply(request: RecordedRequest) {
  if (request.path === "/rest/v1/counterparties" && request.method === "POST") return { body: { id: COUNTERPARTY, name: "Linh" } };
  if (request.path === "/rest/v1/milestones" && request.method === "POST") return { body: { id: MILESTONE } };
  return { body: [] };
}

const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: USER }), fn);
const posted = (path: string) => fake.requests.find((request) => request.path === path && request.method === "POST")?.body as Record<string, unknown>;

const valid = (over: Record<string, string> = {}) => {
  const parsed = parseFreelancerPayment({ name: "Linh", email: "linh@example.com", work: "10 Canva posts", amount: "12.5", evidence: "", ...over });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};

beforeEach(() => {
  fake = fakeSupabase(reply);
  screenMock.mockReset().mockResolvedValue({ riskLevel: "clear" });
  linkMock.mockReset().mockResolvedValue({ link: { id: "l1", counterpartyId: COUNTERPARTY, expiresAt: "2026-10-08T15:00:00+00:00" }, token: TOKEN });
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "e1" });
  ledgerMock.mockReset().mockResolvedValue(undefined);
  process.env.SITE_URL = "https://www.vestiarion.xyz";
});

describe("setUpFreelancerPayment", () => {
  const setUp = (over: Record<string, string> = {}) =>
    run(() => setUpFreelancerPayment({ ...valid(over), actorId: USER, orgName: "Mai Studio", now: NOW }));

  it("adds the freelancer as a contractor whose limit is the amount, and screens them", async () => {
    await setUp();
    expect(posted("/rest/v1/counterparties")).toMatchObject({
      name: "Linh",
      role: "contractor",
      address: null,
      chain: "ARC-TESTNET",
      baseline_payment_limit: "12.5",
      payment_limit: null,
    });
    expect(screenMock).toHaveBeenCalledWith(COUNTERPARTY);
  });

  it("keeps the email the link goes to as where the freelancer hears they were paid (payment notices R1)", async () => {
    await setUp();
    expect(posted("/rest/v1/counterparties").notice_email).toBe(valid().email);
  });

  it("keeps no address for notices when no email was given", async () => {
    await setUp({ email: "" });
    expect(posted("/rest/v1/counterparties").notice_email).toBeNull();
  });

  it("adds the work as a milestone already verified by the person setting up the payment", async () => {
    await setUp({ evidence: "https://www.canva.com/design/abc/view" });
    expect(posted("/rest/v1/milestones")).toMatchObject({
      contractor_id: COUNTERPARTY,
      title: "10 Canva posts",
      amount: "12.5",
      verification_source: "https://www.canva.com/design/abc/view",
      verified: true,
      status: "verified",
      verification_method: "manual",
      verification_status: "verified",
      verified_at: NOW.toISOString(),
      verification_detail: { note: "Delivered work confirmed when the payment was set up" },
    });
  });

  it("records what the person did, in the ledger's existing actions and in order", async () => {
    await setUp();
    expect(ledgerMock.mock.calls.map(([entry]) => entry.action)).toEqual(["create_counterparty", "create_milestone", "verify_milestone_manual"]);
    for (const [entry] of ledgerMock.mock.calls) expect(entry).toMatchObject({ actor: "human", detail: expect.objectContaining({ by: USER }) });
    expect(linkMock).toHaveBeenCalledWith({ orgId: ORG, actorId: USER, counterpartyId: COUNTERPARTY });
  });

  it("emails the link to the freelancer and returns it", async () => {
    const result = await setUp();
    const url = `https://www.vestiarion.xyz/payee/${TOKEN}`;
    expect(result).toEqual({
      counterpartyId: COUNTERPARTY,
      milestoneId: MILESTONE,
      name: "Linh",
      url,
      expiresAt: "2026-10-08T15:00:00+00:00",
      emailed: true,
      screening: "clear",
    });
    const [message] = sendMock.mock.calls[0];
    expect(message.to).toBe("linh@example.com");
    expect(message.subject).toBe("Mai Studio wants to pay you 12.5 USDC");
    expect(message.text).toContain(url);
  });

  it("returns the link to copy, emailing nothing, when no email was given", async () => {
    const result = await setUp({ email: "" });
    expect(result.emailed).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("still returns the link when the email does not go out", async () => {
    sendMock.mockResolvedValueOnce({ sent: false, reason: "not_configured" });
    expect((await setUp()).emailed).toBe(false);
    sendMock.mockRejectedValueOnce(new Error("network"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await setUp()).emailed).toBe(false);
    logged.mockRestore();
  });

  it("goes on when screening is not available, and says so", async () => {
    screenMock.mockRejectedValueOnce(new Error("provider unavailable"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await setUp();
    expect(result.screening).toBe("incomplete");
    expect(linkMock).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe("parseFreelancerPayment", () => {
  const parse = (over: Record<string, string>) =>
    parseFreelancerPayment({ name: "Linh", email: "", work: "10 Canva posts", amount: "12.5", evidence: "", ...over });

  it("accepts a payment with no email and no evidence", () => {
    expect(parse({})).toEqual({ ok: true, value: { name: "Linh", email: null, work: "10 Canva posts", amount: "12.5", evidence: null } });
  });

  it.each([
    [{ name: "L" }, "Give the freelancer's name, in at least 2 characters"],
    [{ email: "not-an-email" }, "That email address does not look right"],
    [{ work: "ok" }, "Say what was delivered, in at least 3 characters"],
    [{ amount: "0" }, "Amount must be greater than zero"],
    [{ evidence: "http://example.com" }, "The link to the work must start with https://"],
  ])("refuses %o", (over, message) => {
    expect(parse(over)).toEqual({ ok: false, message });
  });
});
