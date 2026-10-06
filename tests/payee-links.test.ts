import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configFromEnv } from "@/lib/config";
import { runWith } from "@/lib/context";
import { CounterpartyAddressError } from "@/lib/counterparty-address";
import {
  createPayeeLink,
  generatePayeeLinkToken,
  listActivePayeeLinks,
  PayeeLinkError,
  payeeLinkHash,
  payeeLinkStatus,
  previewPayeeLink,
  revokePayeeLink,
  submitPayeeAddress,
} from "@/lib/platform/payee-links";
import { fakeSupabase, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * Payee links (docs/superpowers/specs/2026-09-30-payee-links-design.md): the
 * library over migration 0039's functions, against a recorded supabase-js
 * client. The address change itself (counterparty-address.test.ts), the
 * workspace scope and the ledger are faked here.
 */

const { changeMock, withOrgMock, ledgerMock, notifyMock } = vi.hoisted(() => ({
  changeMock: vi.fn(),
  withOrgMock: vi.fn(),
  ledgerMock: vi.fn(),
  notifyMock: vi.fn(),
}));
vi.mock("@/lib/notifications/payee-address", () => ({ notifyPayeeAddress: notifyMock }));
vi.mock("@/lib/counterparty-address", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/counterparty-address")>()),
  changeCounterpartyAddress: changeMock,
}));
vi.mock("@/lib/dal/scope", () => ({ withOrg: withOrgMock }));
vi.mock("@/lib/ledger-best-effort", () => ({ appendLedgerEntryBestEffort: ledgerMock }));

const config = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000000a0a";
const USER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e1";
const PAYEE = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const LINK = "0b6c1c9e-4a4f-4a7e-9b1e-0000000001e1";
const ADDRESS = "0x2222222222222222222222222222222222222222";
const TOKEN = `vxp_${"A".repeat(43)}`;
const HASH = createHash("sha256").update("A".repeat(43), "utf8").digest("hex");
const NOW = Date.parse("2026-09-30T12:00:00Z");

function platform<T>(fn: () => Promise<T>, respond: (request: RecordedRequest) => FakeReply = () => ({ body: [] })) {
  const fake = fakeSupabase(respond);
  return { fake, result: runWith({ config, db: fake.client }, fn) };
}

const rpc = (request: RecordedRequest, name: string) => request.path === `/rest/v1/rpc/${name}`;

beforeEach(() => {
  changeMock.mockReset().mockResolvedValue({ name: "Northwind", from: null, to: ADDRESS });
  withOrgMock.mockReset().mockImplementation(async (_orgId: string, fn: () => Promise<unknown>) => fn());
  ledgerMock.mockReset().mockResolvedValue(undefined);
  notifyMock.mockReset().mockResolvedValue(1);
});

describe("tokens", () => {
  it("are vxp_ and 43 base64url characters from 32 random bytes; only the secret's hash is kept", () => {
    const { token, secretHash } = generatePayeeLinkToken(() => Buffer.alloc(32, 0xff));
    expect(token).toBe(`vxp_${Buffer.alloc(32, 0xff).toString("base64url")}`);
    expect(token).toMatch(/^vxp_[A-Za-z0-9_-]{43}$/);
    expect(secretHash).toBe(payeeLinkHash(token));
    expect(secretHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reads no hash from anything else", () => {
    expect(payeeLinkHash(TOKEN)).toBe(HASH);
    for (const bad of ["", "vxp_short", `vxk_${"A".repeat(43)}`, `${TOKEN}x`, `vxp_${"A".repeat(42)}!`]) expect(payeeLinkHash(bad)).toBeNull();
  });
});

describe("createPayeeLink", () => {
  it("stores the hash with a 7-day expiry, records it, and returns the token once", async () => {
    const { fake, result } = platform(
      () => createPayeeLink({ orgId: ORG, actorId: USER, counterpartyId: PAYEE, now: NOW }),
      (request) => (rpc(request, "create_payee_link") ? { body: { id: LINK, counterparty_id: PAYEE, expires_at: "2026-10-07T12:00:00+00:00" } } : { body: [] })
    );
    const { link, token } = await result;
    const sent = fake.requests.find((request) => rpc(request, "create_payee_link"))?.body as Record<string, unknown>;
    expect(sent).toEqual({
      p_org_id: ORG,
      p_counterparty_id: PAYEE,
      p_token_hash: payeeLinkHash(token),
      p_by: USER,
      p_expires_at: "2026-10-07T12:00:00.000Z",
    });
    expect(JSON.stringify(fake.requests)).not.toContain(token.slice(4));
    expect(link).toEqual({ id: LINK, counterpartyId: PAYEE, expiresAt: "2026-10-07T12:00:00+00:00" });
    expect(ledgerMock).toHaveBeenCalledWith(ORG, {
      actor: "human",
      domain: "compliance",
      action: "payee_link_created",
      summary: "Created a one-time link for a payee to enter their own address",
      detail: { by: USER, counterpartyId: PAYEE, linkId: LINK, expiresAt: "2026-10-07T12:00:00+00:00" },
    });
  });

  it("names the API and its key in the entry for a link made through it, and never the link (write API part 2, W3)", async () => {
    const { result } = platform(
      () => createPayeeLink({ orgId: ORG, actorId: USER, counterpartyId: PAYEE, now: NOW, provenance: { via: "api", apiKeyId: "3c3c3c3c-0000-4000-8000-000000000001" } }),
      (request) => (rpc(request, "create_payee_link") ? { body: { id: LINK, counterparty_id: PAYEE, expires_at: "2026-10-07T12:00:00+00:00" } } : { body: [] })
    );
    const { token } = await result;
    expect(ledgerMock.mock.calls[0][1].detail).toEqual({
      by: USER,
      counterpartyId: PAYEE,
      linkId: LINK,
      expiresAt: "2026-10-07T12:00:00+00:00",
      via: "api",
      apiKeyId: "3c3c3c3c-0000-4000-8000-000000000001",
    });
    expect(JSON.stringify(ledgerMock.mock.calls)).not.toContain(token.slice(4));
  });

  it("says not found for a counterparty the workspace does not hold", async () => {
    const { result } = platform(
      () => createPayeeLink({ orgId: ORG, actorId: USER, counterpartyId: PAYEE, now: NOW }),
      () => ({ status: 400, body: { code: "P0001", message: "counterparty_not_found: no such counterparty in this workspace" } })
    );
    await expect(result).rejects.toBeInstanceOf(PayeeLinkError);
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});

describe("listActivePayeeLinks", () => {
  it("reads the workspace's unused, unrevoked, unexpired links by payee", async () => {
    const { fake, result } = platform(
      () => listActivePayeeLinks(ORG, NOW),
      () => ({ body: [{ id: LINK, counterparty_id: PAYEE, expires_at: "2026-10-07T12:00:00+00:00" }] })
    );
    expect(await result).toEqual(new Map([[PAYEE, { id: LINK, expiresAt: "2026-10-07T12:00:00+00:00" }]]));
    const read = fake.requests[0];
    expect(read.path).toBe("/rest/v1/payee_links");
    expect(read.params.get("org_id")).toBe(`eq.${ORG}`);
    expect(read.params.get("used_at")).toBe("is.null");
    expect(read.params.get("revoked_at")).toBe("is.null");
    expect(read.params.get("expires_at")).toBe("gt.2026-09-30T12:00:00.000Z");
  });
});

describe("revokePayeeLink", () => {
  it("revokes the workspace's link and records it", async () => {
    const { result } = platform(
      () => revokePayeeLink({ orgId: ORG, actorId: USER, linkId: LINK }),
      (request) => {
        if (request.path === "/rest/v1/payee_links") return { body: [{ counterparty_id: PAYEE }] };
        if (rpc(request, "revoke_payee_link")) return { body: true };
        return { body: [] };
      }
    );
    expect(await result).toBe(true);
    expect(ledgerMock).toHaveBeenCalledWith(ORG, expect.objectContaining({ action: "payee_link_revoked", detail: { by: USER, counterpartyId: PAYEE, linkId: LINK } }));
  });

  it("records nothing when there was nothing to revoke", async () => {
    const { result } = platform(
      () => revokePayeeLink({ orgId: ORG, actorId: USER, linkId: LINK }),
      (request) => (rpc(request, "revoke_payee_link") ? { body: false } : { body: [{ counterparty_id: PAYEE }] })
    );
    expect(await result).toBe(false);
    expect(ledgerMock).not.toHaveBeenCalled();
  });
});

describe("previewPayeeLink", () => {
  it("names the workspace and the payee for a usable link", async () => {
    const { fake, result } = platform(
      () => previewPayeeLink(TOKEN),
      (request) => (rpc(request, "payee_link_chain") ? { body: "ARC-TESTNET" } : { body: [{ org_name: "Acme", counterparty_name: "Northwind", expires_at: "2026-10-07T12:00:00+00:00" }] })
    );
    expect(await result).toEqual({ orgName: "Acme", counterpartyName: "Northwind", expiresAt: "2026-10-07T12:00:00+00:00", chain: "ARC-TESTNET" });
    expect(fake.requests[0].body).toEqual({ p_token_hash: HASH });
  });

  it("names the chain the payee is paid on, and none when that cannot be read rather than assume one (review I3; network threading P3)", async () => {
    const preview = [{ org_name: "Acme", counterparty_name: "Northwind", expires_at: "2026-10-07T12:00:00+00:00" }];
    const onBase = platform(() => previewPayeeLink(TOKEN), (request) => (rpc(request, "payee_link_chain") ? { body: "BASE-SEPOLIA" } : { body: preview }));
    expect(await onBase.result).toMatchObject({ chain: "BASE-SEPOLIA" });
    const unreadable = platform(() => previewPayeeLink(TOKEN), (request) =>
      rpc(request, "payee_link_chain") ? { status: 404, body: { message: "function payee_link_chain does not exist" } } : { body: preview }
    );
    expect(await unreadable.result).toMatchObject({ chain: null });
  });

  it("is null for an unusable link, and asks nothing for a malformed token", async () => {
    expect(await platform(() => previewPayeeLink(TOKEN), () => ({ body: [] })).result).toBeNull();
    const malformed = platform(() => previewPayeeLink("not-a-token"));
    expect(await malformed.result).toBeNull();
    expect(malformed.fake.requests).toEqual([]);
  });
});

describe("payeeLinkStatus (freelancer journey R1, R2)", () => {
  const STATUS = {
    orgName: "Acme", payeeName: "Northwind", chain: "ARC-TESTNET", linkState: "used", expiresAt: "2026-10-07T12:00:00+00:00",
    usedAt: "2026-10-01T12:00:00+00:00", statusUntil: "2026-10-31T12:00:00+00:00", address: ADDRESS, addressConfirmed: true,
    payments: [{ kind: "milestone", title: "10 social posts", amount: 25, currency: "USDC", status: "paid", txRef: "0xabc", settledAt: "2026-10-01T12:05:00+00:00", scheduledFor: null }],
  };

  it("reads the link's status by its hash", async () => {
    const { fake, result } = platform(() => payeeLinkStatus(TOKEN), () => ({ body: STATUS }));
    expect(await result).toEqual(STATUS);
    expect(fake.requests[0].path).toBe("/rest/v1/rpc/payee_link_status");
    expect(fake.requests[0].body).toEqual({ p_token_hash: HASH });
  });

  it("takes an amount PostgREST sent as text as a number, and an unknown currency as USDC", async () => {
    const payments = [{ ...STATUS.payments[0], amount: "12.500000", currency: null }];
    expect((await platform(() => payeeLinkStatus(TOKEN), () => ({ body: { ...STATUS, payments } })).result)?.payments[0]).toMatchObject({ amount: 12.5, currency: "USDC" });
  });

  it("is null for a link with no status, and asks nothing for a malformed token", async () => {
    expect(await platform(() => payeeLinkStatus(TOKEN), () => ({ body: null })).result).toBeNull();
    const malformed = platform(() => payeeLinkStatus("not-a-token"));
    expect(await malformed.result).toBeNull();
    expect(malformed.fake.requests).toEqual([]);
  });

  it("throws when the status cannot be read, so the page says so", async () => {
    await expect(platform(() => payeeLinkStatus(TOKEN), () => ({ status: 500, body: { message: "connection reset" } })).result).rejects.toThrow(/connection reset/);
  });
});

describe("submitPayeeAddress", () => {
  const usable = (claimRows: unknown[] = [{ link_id: LINK, org_id: ORG, counterparty_id: PAYEE }]) => (request: RecordedRequest) => {
    if (rpc(request, "payee_link_preview")) return { body: [{ org_name: "Acme", counterparty_name: "Northwind", expires_at: "2026-10-07T12:00:00+00:00" }] };
    if (rpc(request, "claim_payee_link")) return { body: claimRows };
    return { body: null };
  };

  it("checks the address, claims the link, then changes the address in the workspace as the link", async () => {
    const { fake, result } = platform(() => submitPayeeAddress(TOKEN, `  ${ADDRESS} `), usable());
    expect(await result).toEqual({ ok: true, orgName: "Acme", unchanged: false });
    expect(fake.requests.map((request) => request.path)).toEqual(["/rest/v1/rpc/payee_link_preview", "/rest/v1/rpc/claim_payee_link"]);
    expect(withOrgMock).toHaveBeenCalledWith(ORG, expect.any(Function));
    expect(changeMock).toHaveBeenCalledWith({ payeeLinkId: LINK, counterpartyId: PAYEE, raw: ADDRESS });
  });

  it("tells the people who can confirm the address that it arrived (pay a freelancer R4)", async () => {
    const { result } = platform(() => submitPayeeAddress(TOKEN, ADDRESS), usable());
    await result;
    expect(notifyMock).toHaveBeenCalledWith({ orgId: ORG, orgName: "Acme", payeeName: "Northwind", address: ADDRESS });
  });

  it("refuses a malformed or empty address without using the link", async () => {
    for (const raw of ["0x123", "", "   ", `${ADDRESS}0`]) {
      const { fake, result } = platform(() => submitPayeeAddress(TOKEN, raw), usable());
      expect(await result).toEqual({ ok: false, reason: "invalid_address" });
      expect(fake.requests.some((request) => rpc(request, "claim_payee_link"))).toBe(false);
    }
    expect(changeMock).not.toHaveBeenCalled();
  });

  it("tells a mistyped address from one that is no address, without using the link (payment safety A3)", async () => {
    const { fake, result } = platform(() => submitPayeeAddress(TOKEN, "0x19801daA2F1E5E5e707b7E57Ff664f3d27fFdd12"), usable());
    expect(await result).toEqual({ ok: false, reason: "checksum_address" });
    expect(fake.requests.some((request) => rpc(request, "claim_payee_link"))).toBe(false);
  });

  it("says the link is invalid when it cannot be claimed, such as a second submission of the same token", async () => {
    const { result } = platform(() => submitPayeeAddress(TOKEN, ADDRESS), usable([]));
    expect(await result).toEqual({ ok: false, reason: "invalid_link" });
    expect(changeMock).not.toHaveBeenCalled();
  });

  it("says the link is invalid for a malformed token, asking nothing", async () => {
    const { fake, result } = platform(() => submitPayeeAddress("vxp_nope", ADDRESS), usable());
    expect(await result).toEqual({ ok: false, reason: "invalid_link" });
    expect(fake.requests).toEqual([]);
  });

  it("uses the link for the address already on file, and says so", async () => {
    changeMock.mockRejectedValueOnce(new CounterpartyAddressError("unchanged"));
    const { fake, result } = platform(() => submitPayeeAddress(TOKEN, ADDRESS), usable());
    expect(await result).toEqual({ ok: true, orgName: "Acme", unchanged: true });
    expect(fake.requests.some((request) => rpc(request, "release_payee_link"))).toBe(false);
    // Nothing new to confirm.
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("puts the link back when the change fails, so the payee can try again", async () => {
    changeMock.mockRejectedValueOnce(new CounterpartyAddressError("conflict"));
    const { fake, result } = platform(() => submitPayeeAddress(TOKEN, ADDRESS), usable());
    await expect(result).rejects.toBeInstanceOf(CounterpartyAddressError);
    const release = fake.requests.find((request) => rpc(request, "release_payee_link"));
    expect(release?.body).toEqual({ p_link_id: LINK });
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
