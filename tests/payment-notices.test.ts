import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { withOrg } from "@/lib/dal/scope";
import { paymentNoticeEmail } from "@/lib/email/payment-notice";
import { noticeEmailSchema } from "@/lib/intake-validation";
import { changeCounterpartyNoticeEmail, maskEmail, sendPaymentNotices } from "@/lib/payment-notices";
import { encryptSecret, parseMasterKeys } from "@/lib/secrets";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Payment notices (docs/superpowers/specs/2026-10-03-payment-notices-design.md): a payee is emailed once its payment
 * is confirmed on Arc testnet, from a live workspace only, each payment once, and the notice is recorded.
 */

const ORG = "5d0f3a2e-8c1b-4f7a-9e6d-00000000a0de";
const ACTOR = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000a1";
const INVOICE = "018f8ce0-1557-7b54-a931-4d777f6bca01";
const MILESTONE = "018f8ce0-1557-7b54-a931-4d777f6bca02";
const VENDOR = "018f8ce0-1557-7b54-a931-4d777f6bca03";
const CONTRACTOR = "018f8ce0-1557-7b54-a931-4d777f6bca04";
const TX = `0x${"79".repeat(32)}`;
const NOW = Date.parse("2026-10-03T03:30:00Z");

const config = configFromEnv({
  NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
  SUPABASE_JWT_SECRET: "test-request-token-secret-at-least-32-characters",
});
const MASTER_KEYS = `t1:${crypto.randomBytes(32).toString("base64")}`;
const LEDGER_PEM = crypto.generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const savedMasterKeys = process.env.VESTIARION_MASTER_KEYS;
beforeEach(() => {
  process.env.VESTIARION_MASTER_KEYS = MASTER_KEYS;
});
afterEach(() => {
  if (savedMasterKeys === undefined) delete process.env.VESTIARION_MASTER_KEYS;
  else process.env.VESTIARION_MASTER_KEYS = savedMasterKeys;
});

const intent = (overrides: Record<string, unknown> = {}) => ({
  id: "intent-1",
  source_type: "invoice",
  source_id: INVOICE,
  amount: "12.500000",
  token: "USDC",
  tx_hash: TX,
  chain: "ARC-TESTNET",
  destination: "0x7a3c9e2b41d05f8a6c1e3b9d2f4a8c6e0b5d1f93",
  confirmed_at: "2026-10-03T03:27:40Z",
  payout_route: null,
  ...overrides,
});

function fake(options: {
  mode?: "live" | "sandbox";
  intents?: Array<Record<string, unknown>>;
  noticeEmail?: string | null;
  noticeEmailSetAt?: string | null;
  claim?: (request: RecordedRequest) => FakeReply | undefined;
} = {}) {
  return fakeSupabase((request) => {
    if (request.path === "/rest/v1/orgs") {
      return {
        body: {
          id: ORG,
          slug: "northstar",
          name: "Northstar",
          mode: options.mode ?? "live",
          ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)),
          circle_api_key_enc: null,
          circle_entity_secret_enc: null,
        },
      };
    }
    if (request.path === "/rest/v1/payment_intents" && request.method === "GET") return { body: options.intents ?? [intent()] };
    if (request.path === "/rest/v1/payment_intents" && request.method === "PATCH") {
      if (request.body && (request.body as Record<string, unknown>).notice_sent_at === null) return { body: [] };
      return options.claim?.(request) ?? { body: [{ id: "intent-1" }] };
    }
    if (request.path === "/rest/v1/invoices") {
      return { body: [{ id: INVOICE, counterparty_id: VENDOR, memo: "October design retainer", po_reference: "PO-2207", direction: "payable" }] };
    }
    if (request.path === "/rest/v1/milestones") return { body: [{ id: MILESTONE, contractor_id: CONTRACTOR, title: "Landing page" }] };
    if (request.path === "/rest/v1/counterparties" && request.method === "GET") {
      const email = options.noticeEmail === undefined ? "linh@example.com" : options.noticeEmail;
      const setAt = options.noticeEmailSetAt === undefined ? "2026-10-01T00:00:00Z" : options.noticeEmailSetAt;
      // As PostgREST answers `notice_email=not.is.null&notice_email_set_at=not.is.null`.
      if (email === null || setAt === null) return { body: [] };
      return {
        body: [
          { id: VENDOR, name: "Northstar Studio", notice_email: email, notice_email_set_at: setAt },
          { id: CONTRACTOR, name: "Linh Tran", notice_email: email, notice_email_set_at: setAt },
        ],
      };
    }
    if (request.path === "/rest/v1/rpc/append_ledger_entry") {
      return { body: { seq: 1, id: "e1", ts: "2026-10-03T03:30:00Z", actor: "system", domain: "ap", action: "x", summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null } };
    }
    return { body: [] };
  });
}

const run = <T>(client: ReturnType<typeof fakeSupabase>, fn: () => Promise<T>) => runWith({ config, db: client.client, fetch: client.fetch }, () => withOrg(ORG, fn));
const appends = (client: ReturnType<typeof fakeSupabase>) =>
  client.requests.filter((r) => r.path === "/rest/v1/rpc/append_ledger_entry").map((r) => r.body as Record<string, unknown>);
const patches = (client: ReturnType<typeof fakeSupabase>) =>
  client.requests.filter((r) => r.path === "/rest/v1/payment_intents" && r.method === "PATCH");

describe("sending payment notices", () => {
  it("emails the payee once its payment is confirmed on Arc testnet, claims it first, and records it", async () => {
    const client = fake();
    const send = vi.fn().mockResolvedValue({ sent: true, id: "re_1" });

    const lines = await run(client, () => sendPaymentNotices({ now: NOW, send, origin: "https://www.vestiarion.xyz" }));

    expect(lines).toEqual([{ domain: "ap", message: "Told Northstar Studio by email: 12.50 USDC paid" }]);
    const due = client.requests.find((r) => r.path === "/rest/v1/payment_intents" && r.method === "GET")!;
    expect(due.params.get("status")).toBe("eq.confirmed");
    expect(due.params.get("provider_mode")).toBe("eq.live");
    expect(due.params.get("notice_sent_at")).toBe("is.null");
    // From when the address was set, inside the three days (R4, R7).
    expect(due.params.get("confirmed_at")).toBe("gte.2026-10-01T00:00:00.000Z");
    // Newest first, so a busy workspace's older payments never crowd out the one just made.
    expect(due.params.get("order")).toBe("confirmed_at.desc");
    // Claimed before the send, only while unclaimed (R4).
    const [claim] = patches(client);
    expect(claim.params.get("notice_sent_at")).toBe("is.null");
    expect((claim.body as Record<string, unknown>).notice_sent_at).toBe(new Date(NOW).toISOString());

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.to).toBe("linh@example.com");
    expect(message.subject).toBe("Northstar paid you 12.50 USDC");
    expect(message.text).toContain("Northstar paid you 12.50 USDC on Arc testnet for October design retainer (PO-2207).");
    expect(message.text).toContain(`https://explorer.testnet.arc.io/tx/${TX}`);
    expect(message.text).toContain("Sent to 0x7a3c9e2b41d05f8a6c1e3b9d2f4a8c6e0b5d1f93 on Oct 3, 2026, 03:27 UTC.");

    const [entry] = appends(client);
    expect(entry).toMatchObject({ p_actor: "system", p_domain: "ap", p_action: "payment_notice_sent", p_summary: "Told Northstar Studio by email that 12.50 USDC was paid" });
    expect(entry.p_detail).toEqual({ invoiceId: INVOICE, counterpartyId: VENDOR, to: "li***@example.com", amount: 12.5, token: "USDC", txHash: TX });
  });

  it("names the network the payment was made on: Arc mainnet for one made there (mainnet copy C1)", async () => {
    const client = fake({ intents: [intent({ network: "arc-mainnet", chain: "ARC" })] });
    const send = vi.fn().mockResolvedValue({ sent: true, id: "re_1" });

    await run(client, () => sendPaymentNotices({ now: NOW, send, origin: "https://www.vestiarion.xyz" }));

    const message = send.mock.calls[0][0];
    for (const part of [message.text, message.html]) {
      expect(part).toContain("Northstar paid you 12.50 USDC on Arc mainnet");
      expect(part).not.toContain("Arc testnet");
    }
    expect(message.text).toContain(`https://explorer.arc.io/tx/${TX}`);
  });

  it("names a milestone by its title, under the contractor's domain", async () => {
    const client = fake({ intents: [intent({ source_type: "milestone", source_id: MILESTONE, amount: "1" })] });
    const send = vi.fn().mockResolvedValue({ sent: true, id: "re_2" });

    await run(client, () => sendPaymentNotices({ now: NOW, send, origin: "https://www.vestiarion.xyz" }));

    expect(send.mock.calls[0][0].text).toContain("Northstar paid you 1.00 USDC on Arc testnet for Landing page.");
    expect(appends(client)[0]).toMatchObject({ p_domain: "contractor", p_detail: expect.objectContaining({ milestoneId: MILESTONE, counterpartyId: CONTRACTOR }) });
  });

  it("reads no payment when no counterparty wants notices, and only what came after the earliest address was set", async () => {
    const none = fake({ noticeEmail: null });
    const send = vi.fn();
    expect(await run(none, () => sendPaymentNotices({ now: NOW, send }))).toEqual([]);
    const recipients = none.requests.find((r) => r.path === "/rest/v1/counterparties")!;
    expect(recipients.params.get("notice_email")).toBe("not.is.null");
    expect(recipients.params.get("notice_email_set_at")).toBe("not.is.null");
    expect(none.requests.some((r) => r.path === "/rest/v1/payment_intents")).toBe(false);

    // An address set an hour ago: only payments since then are read.
    const recent = fake({ noticeEmailSetAt: "2026-10-03T02:30:00Z" });
    await run(recent, () => sendPaymentNotices({ now: NOW, send: vi.fn().mockResolvedValue({ sent: true, id: "re_3" }) }));
    const due = recent.requests.find((r) => r.path === "/rest/v1/payment_intents" && r.method === "GET")!;
    expect(due.params.get("confirmed_at")).toBe("gte.2026-10-03T02:30:00.000Z");
  });

  it("emails no one from a sandbox, whose payments are simulated", async () => {
    const client = fake({ mode: "sandbox" });
    const send = vi.fn();
    expect(await run(client, () => sendPaymentNotices({ now: NOW, send }))).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(client.requests.some((r) => r.path === "/rest/v1/payment_intents")).toBe(false);
  });

  it.each([
    ["a counterparty with no address for notices", { noticeEmail: null }],
    ["a payout to another chain", { intents: [intent({ chain: "BASE-SEPOLIA" })] }],
    ["a payout through Gateway", { intents: [intent({ payout_route: "gateway" })] }],
    ["a payment with no transaction on Arc", { intents: [intent({ tx_hash: "sim_44bd8923" })] }],
    // Set after the payment: setting an address never tells of older payments (R7).
    ["a payment confirmed before the address was set", { noticeEmailSetAt: "2026-10-03T03:28:00Z" }],
    ["an address with no time it was set", { noticeEmailSetAt: null }],
  ])("sends nothing for %s", async (_label, options: Parameters<typeof fake>[0]) => {
    const client = fake(options);
    const send = vi.fn();
    expect(await run(client, () => sendPaymentNotices({ now: NOW, send }))).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(patches(client)).toHaveLength(0);
  });

  it("sends nothing when another run claimed the payment first", async () => {
    const client = fake({ claim: () => ({ body: [] }) });
    const send = vi.fn();
    expect(await run(client, () => sendPaymentNotices({ now: NOW, send }))).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("releases the claim when the send fails, so the next cycle tries again, and records nothing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const client = fake();
    const send = vi.fn().mockResolvedValue({ sent: false, reason: "status 422" });

    const lines = await run(client, () => sendPaymentNotices({ now: NOW, send }));

    expect(lines).toEqual([{ domain: "ap", message: "Payment notice to Northstar Studio not sent (status 422); tried again at the next cycle" }]);
    const [, release] = patches(client);
    expect(release.body).toEqual({ notice_sent_at: null });
    expect(appends(client)).toHaveLength(0);
    error.mockRestore();
  });
});

describe("where payment notices go", () => {
  it("hides most of an address in the ledger", () => {
    expect(maskEmail("linh@example.com")).toBe("li***@example.com");
    expect(maskEmail("a@example.com")).toBe("a***@example.com");
    expect(maskEmail("nonsense")).toBe("***");
  });

  it("takes an address as a form gives it, or none", () => {
    expect(noticeEmailSchema.parse("  linh@example.com ")).toBe("linh@example.com");
    expect(noticeEmailSchema.parse("")).toBeNull();
    expect(noticeEmailSchema.safeParse("not-an-email").success).toBe(false);
  });

  it("changes a counterparty's address and records both, masked; an unchanged one writes nothing", async () => {
    const client = fakeSupabase((request) => {
      if (request.path === "/rest/v1/orgs") {
        return { body: { id: ORG, slug: "northstar", name: "Northstar", mode: "live", ledger_signing_key_enc: encryptSecret(LEDGER_PEM, { orgId: ORG, column: "ledger_signing_key_enc" }, parseMasterKeys(MASTER_KEYS)), circle_api_key_enc: null, circle_entity_secret_enc: null } };
      }
      if (request.path === "/rest/v1/counterparties" && request.method === "GET") return { body: { id: VENDOR, name: "Northstar Studio", role: "vendor", notice_email: "old@example.com" } };
      if (request.path === "/rest/v1/counterparties" && request.method === "PATCH") return { body: [{ id: VENDOR }] };
      if (request.path === "/rest/v1/rpc/append_ledger_entry") {
        return { body: { seq: 1, id: "e1", ts: "t", actor: "human", domain: "compliance", action: "x", summary: "", detail: {}, body_hash: "00", signature: "00", prev_hash: null, hash: "00", signing_key_id: null } };
      }
      return { body: [] };
    });

    expect(await run(client, () => changeCounterpartyNoticeEmail({ actorId: ACTOR, counterpartyId: VENDOR, email: "linh@example.com" }))).toEqual({
      name: "Northstar Studio",
      email: "linh@example.com",
      role: "vendor",
    });
    const patch = client.requests.find((r) => r.path === "/rest/v1/counterparties" && r.method === "PATCH")!;
    expect(patch.body).toEqual({ notice_email: "linh@example.com" });
    const [entry] = appends(client);
    expect(entry).toMatchObject({ p_action: "counterparty_notice_email_changed", p_summary: "Billing email for Northstar Studio: li***@example.com" });
    expect(entry.p_detail).toEqual({ by: ACTOR, counterpartyId: VENDOR, from: "ol***@example.com", to: "li***@example.com" });

    const before = client.requests.length;
    await run(client, () => changeCounterpartyNoticeEmail({ actorId: ACTOR, counterpartyId: VENDOR, email: "old@example.com" }));
    expect(client.requests.slice(before).some((r) => r.method === "PATCH")).toBe(false);
  });
});

describe("the payment notice email", () => {
  it("says who paid, how much, what for, where and when, with the transaction, escaping names", () => {
    const email = paymentNoticeEmail({
      orgName: "Acme <Ops>",
      payeeName: "Linh",
      amount: "12.50",
      token: "USDC",
      what: "October design retainer (PO-2207)",
      address: "0x7a3c",
      paidAt: "Oct 3, 2026, 03:27 UTC",
      txUrl: `https://explorer.testnet.arc.io/tx/${TX}`,
      origin: "https://www.vestiarion.xyz",
      network: "arc-testnet",
    });
    expect(email.subject).toBe("Acme <Ops> paid you 12.50 USDC");
    expect(email.html).toContain("Acme &lt;Ops&gt;");
    expect(email.html).not.toContain("Acme <Ops>");
    expect(email.html).toContain("View the transaction");
    expect(email.text).toContain("For anything about this payment, contact Acme <Ops>.");
  });
});
