import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import type { Actor } from "@/lib/commands/actor";
import { addressRequestEmail } from "@/lib/email/address-request";
import { fakeSupabase, orgTestContext, type RecordedRequest } from "./support/fake-supabase";

/**
 * Ask every payee for an address at once (docs/superpowers/specs/2026-10-18-ask-every-payee-design.md A2-A6): who is
 * asked (a vendor or contractor with no address of its own, a mirror one included, never a client, sample data or a
 * payee with a link out; 25 at most, by name), each link made through the single link's command and emailed to the
 * payee's notice email, the rest shown once to copy, and one `payee_addresses_requested` entry beside the links' own. A
 * workspace that simulates its payments emails no one, and past 100 address emails in 24 hours the links are shown to
 * copy; in shadow mode the email says the business is getting ready to pay in USDC.
 */

const { issueMock, sendMock, linksOutMock, ledgerMock, shadowMock, simulatesMock } = vi.hoisted(() => ({
  issueMock: vi.fn(),
  sendMock: vi.fn(),
  linksOutMock: vi.fn(),
  ledgerMock: vi.fn(),
  shadowMock: vi.fn(),
  simulatesMock: vi.fn(),
}));
vi.mock("@/lib/commands/payee-links", () => ({ issuePayeeLink: issueMock }));
vi.mock("@/lib/email/send", () => ({ sendEmail: sendMock }));
vi.mock("@/lib/platform/payee-links", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/platform/payee-links")>()), listActivePayeeLinks: linksOutMock }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));
vi.mock("@/lib/capability-read", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/capability-read")>()), simulatesPayments: simulatesMock }));
vi.mock("@/lib/shadow-mode", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/shadow-mode")>()), readShadowMode: shadowMock }));

const { askablePayees, askPayeesForAddresses, ASK_MAX } = await import("@/lib/address-requests");

const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000c21";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c5";
const id = (n: number) => `0b6c1c9e-4a4f-4a7e-9b1e-${String(n).padStart(12, "0")}`;
const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const admin = (fields: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: USER, role: "admin", mode: "live", surface: { kind: "console" }, ...fields });

const payee = (n: number, name: string, fields: Record<string, unknown> = {}) => ({
  id: id(n),
  name,
  role: "vendor",
  address: null,
  mirror_wallet_id: null,
  notice_email: null,
  sample: false,
  ...fields,
});
const ROWS = [
  payee(1, "Northwind Hosting", { notice_email: "billing@northwind.example" }),
  payee(2, "Lumen Print Co.", { address: "0x1111111111111111111111111111111111111111", mirror_wallet_id: "wallet-1" }),
  payee(3, "Quill Studio", { role: "contractor", notice_email: "  " }),
  payee(4, "Cobalt Cloud", { address: "0x97f85033BBd83870A841cF7153f35B387746b6B6" }),
  payee(5, "Acme Retail", { role: "client" }),
  payee(6, "Sample Co", { sample: true }),
  payee(7, "Atlas Compute"),
];

function workspace(rows = ROWS, emailsToday = 0) {
  const fake = fakeSupabase((sent: RecordedRequest) => {
    if (sent.path === "/rest/v1/usage_events") return { body: Array.from({ length: emailsToday }, () => ({ quantity: 1 })) };
    if (sent.path === "/rest/v1/counterparties") {
      const ids = sent.params.get("id")?.replace(/^in\.\(|\)$/g, "").split(",") ?? [];
      return { body: rows.filter((row) => ids.includes(row.id)) };
    }
    return { body: [] };
  });
  const run = <T,>(fn: () => Promise<T>) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG }), fn);
  return { fake, run };
}

beforeEach(() => {
  issueMock.mockReset().mockImplementation(async (_actor: Actor, input: { counterpartyId: string }) => ({
    ok: true,
    message: "Link created.",
    linkId: `link-${input.counterpartyId.slice(-2)}`,
    counterpartyId: input.counterpartyId,
    url: `https://www.vestiarion.xyz/payee/vxp_${input.counterpartyId.slice(-2)}`,
    expiresAt: "2026-10-25T12:00:00.000Z",
  }));
  sendMock.mockReset().mockResolvedValue({ sent: true, id: "email-1" });
  linksOutMock.mockReset().mockResolvedValue(new Map());
  ledgerMock.mockReset().mockResolvedValue(undefined);
  shadowMock.mockReset().mockResolvedValue(null);
  simulatesMock.mockReset().mockReturnValue(false);
});

describe("askablePayees", () => {
  it("asks vendors and contractors with no address of their own, a mirror one included, by name", () => {
    const asked = askablePayees(ROWS, new Map([[id(7), { id: "l", expiresAt: "x" }]]));
    expect(asked.payees).toEqual([
      { id: id(2), name: "Lumen Print Co.", email: null, mirror: true },
      { id: id(1), name: "Northwind Hosting", email: "billing@northwind.example", mirror: false },
      { id: id(3), name: "Quill Studio", email: null, mirror: false },
    ]);
    // Atlas Compute has a link out: counted, not asked again.
    expect(asked).toMatchObject({ more: 0, linksOut: 1 });
  });

  it("asks at most 25 at a press and says how many remain", () => {
    const many = Array.from({ length: ASK_MAX + 3 }, (_, n) => payee(100 + n, `Payee ${String(n).padStart(2, "0")}`));
    const asked = askablePayees(many, new Map());
    expect(asked.payees).toHaveLength(ASK_MAX);
    expect(asked.payees[0].name).toBe("Payee 00");
    expect(asked.more).toBe(3);
  });
});

describe("askPayeesForAddresses", () => {
  it("makes each link through the single link's command, emails it where it can, shows the rest once, and signs one entry", async () => {
    const { run } = workspace();
    sendMock.mockResolvedValueOnce({ sent: true, id: "e1" });
    const result = await run(() => askPayeesForAddresses({ actor: admin(), orgName: "Pinecrest Studio", counterpartyIds: [id(1), id(2), id(3), id(4), id(5)] }));

    expect(result).toEqual({
      ok: true,
      asked: {
        emailed: ["Northwind Hosting"],
        links: [
          { counterpartyId: id(2), name: "Lumen Print Co.", url: "https://www.vestiarion.xyz/payee/vxp_02", expiresAt: "2026-10-25T12:00:00.000Z" },
          { counterpartyId: id(3), name: "Quill Studio", url: "https://www.vestiarion.xyz/payee/vxp_03", expiresAt: "2026-10-25T12:00:00.000Z" },
        ],
        notMade: [],
        // Cobalt Cloud has an address and Acme Retail is a client.
        skipped: 2,
        emailsOff: null,
      },
    });
    expect(issueMock.mock.calls.map((call) => (call[1] as { counterpartyId: string }).counterpartyId)).toEqual([id(2), id(1), id(3)]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0]).toMatchObject({ to: "billing@northwind.example", subject: "Pinecrest Studio asks where to pay you", meter: "address_request" });
    expect(String(sendMock.mock.calls[0][0].text)).toContain("https://www.vestiarion.xyz/payee/vxp_01");

    expect(ledgerMock).toHaveBeenCalledTimes(1);
    expect(ledgerMock.mock.calls[0][0]).toBe(ORG);
    expect(ledgerMock.mock.calls[0][1]).toMatchObject({
      actor: "human",
      domain: "compliance",
      action: "payee_addresses_requested",
      detail: {
        by: USER,
        links: [
          { counterpartyId: id(2), linkId: "link-02", emailed: false },
          { counterpartyId: id(1), linkId: "link-01", emailed: true },
          { counterpartyId: id(3), linkId: "link-03", emailed: false },
        ],
        notMade: [],
      },
    });
  });

  it("shows the link to copy when its email did not go, and names a link that could not be made", async () => {
    const { run } = workspace();
    sendMock.mockReset().mockResolvedValue({ sent: false, reason: "not configured" });
    issueMock.mockImplementationOnce(async () => ({ ok: false, code: "failed", message: "That did not work." }));
    const result = await run(() => askPayeesForAddresses({ actor: admin(), orgName: "Pinecrest Studio", counterpartyIds: [id(1), id(2)] }));
    expect(result).toMatchObject({ ok: true, asked: { emailed: [], notMade: ["Lumen Print Co."], links: [{ name: "Northwind Hosting" }] } });
    expect(ledgerMock.mock.calls[0][1].detail).toEqual({ by: USER, links: [{ counterpartyId: id(1), linkId: "link-01", emailed: false }], notMade: [id(2)] });
  });

  it("does not ask a payee that got a link since the page loaded", async () => {
    const { run } = workspace();
    linksOutMock.mockResolvedValue(new Map([[id(1), { id: "l", expiresAt: "x" }]]));
    const result = await run(() => askPayeesForAddresses({ actor: admin(), orgName: "Pinecrest Studio", counterpartyIds: [id(1)] }));
    expect(result).toEqual({ ok: true, asked: { emailed: [], links: [], notMade: [], skipped: 1, emailsOff: null } });
    expect(issueMock).not.toHaveBeenCalled();
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("emails no one from a workspace that simulates its payments, and shows every link to copy", async () => {
    const { run } = workspace();
    simulatesMock.mockReturnValue(true);
    const result = await run(() => askPayeesForAddresses({ actor: admin({ mode: "sandbox" }), orgName: "P", counterpartyIds: [id(1), id(3)] }));
    expect(result).toMatchObject({ ok: true, asked: { emailed: [], emailsOff: "simulated" } });
    if (result.ok) expect(result.asked.links.map((link) => link.name)).toEqual(["Northwind Hosting", "Quill Studio"]);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("past 100 address emails in 24 hours, shows the link to copy instead", async () => {
    const { fake, run } = workspace(ROWS, 100);
    const result = await run(() => askPayeesForAddresses({ actor: admin(), orgName: "P", counterpartyIds: [id(1)], now: Date.parse("2026-10-18T12:00:00Z") }));
    expect(result).toMatchObject({ ok: true, asked: { emailed: [], emailsOff: "limit", links: [{ name: "Northwind Hosting" }] } });
    expect(sendMock).not.toHaveBeenCalled();
    const read = fake.requests.find((sent) => sent.path === "/rest/v1/usage_events")!;
    expect(read.params.get("action")).toBe("eq.address_request");
    expect(read.params.get("occurred_at")).toBe("gte.2026-10-17T12:00:00.000Z");
  });

  it("in shadow mode, says the business is getting ready to pay in USDC", async () => {
    shadowMock.mockResolvedValue({ currency: "USDC", startedAt: "2026-10-08T00:00:00Z", startedBy: USER });
    const { run } = workspace();
    await run(() => askPayeesForAddresses({ actor: admin(), orgName: "Boba Labs", counterpartyIds: [id(1)] }));
    expect(String(sendMock.mock.calls[0][0].text)).toContain("Boba Labs is getting ready to pay you in USDC and asks for the address to send it to.");
  });

  it("is refused for a role that cannot make a payee link, and for none or too many payees", async () => {
    const { run } = workspace();
    expect(await run(() => askPayeesForAddresses({ actor: admin({ role: "viewer" }), orgName: "P", counterpartyIds: [id(1)] }))).toMatchObject({ ok: false });
    expect(await run(() => askPayeesForAddresses({ actor: admin(), orgName: "P", counterpartyIds: [] }))).toEqual({ ok: false, message: "Choose between 1 and 25 payees." });
    const many = Array.from({ length: ASK_MAX + 1 }, (_, n) => id(200 + n));
    expect(await run(() => askPayeesForAddresses({ actor: admin(), orgName: "P", counterpartyIds: many }))).toMatchObject({ ok: false });
    expect(issueMock).not.toHaveBeenCalled();
  });
});

describe("addressRequestEmail", () => {
  const base = { orgName: "Pinecrest Studio", payeeName: "Northwind <Hosting>", link: "https://www.vestiarion.xyz/payee/vxp_x", expiresAt: new Date("2026-10-25T12:00:00Z"), origin: "https://www.vestiarion.xyz" };

  it("names the business, the network, the link and that nothing is paid until someone confirms it", () => {
    const email = addressRequestEmail({ ...base, network: "arc-mainnet" });
    expect(email.subject).toBe("Pinecrest Studio asks where to pay you");
    expect(email.text).toContain("Pinecrest Studio pays you in USDC on Arc mainnet and asks for the address to send it to.");
    expect(email.text).toContain("Nothing is paid to it until someone at Pinecrest Studio confirms it.");
    expect(email.text).toContain("before 2026-10-25 (UTC), and needs no account.");
    expect(email.html).toContain("Northwind &lt;Hosting&gt;");
    expect(email.html).not.toContain("<Hosting>");
  });

  it("names no network from a workspace in shadow mode, which still pays its own way", () => {
    const email = addressRequestEmail({ ...base, network: "arc-testnet", shadow: true });
    expect(email.text).toContain("Pinecrest Studio is getting ready to pay you in USDC");
    expect(email.text).not.toContain("Arc testnet");
  });
});
