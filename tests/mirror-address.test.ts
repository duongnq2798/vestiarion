import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CircleClientFactory } from "@/lib/circle/check";
import { walletIdempotencyKey } from "@/lib/circle/provision";
import { configFromEnv, type VestiarionConfig } from "@/lib/config";
import { runWith } from "@/lib/context";
import { giveMirrorAddress, MirrorAddressError } from "@/lib/mirror-address";
import { fakeSupabase, orgTestContext, type FakeReply, type RecordedRequest } from "./support/fake-supabase";

/**
 * A mirror address for a payee with none, in shadow mode (docs/superpowers/specs/2026-10-07-shadow-mode-design.md S7):
 * a wallet on Arc testnet that Vestiarion makes in the workspace's own Circle wallet set, so a payment a person agrees to
 * has somewhere to go. Made once per payee, written only where the payee still has no address, and signed.
 */

const { ledgerMock } = vi.hoisted(() => ({ ledgerMock: vi.fn() }));
vi.mock("@/lib/ledger", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ledger")>()), appendLedgerEntry: ledgerMock }));

const base = configFromEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://tests.supabase.invalid", SUPABASE_SERVICE_ROLE_KEY: "k" });
const withCircle = { ...base, chain: { ...base.chain, circleApiKey: "test-api-key", circleEntitySecret: "test-entity-secret", walletHost: "hosted" as const } };
const ORG = "0b6c1c9e-4a4f-4a7e-9b1e-000000002a2a";
const MEMBER = "a1b2c3d4-0000-4000-8000-0000000002a1";
const PAYEE = "0b6c1c9e-4a4f-4a7e-9b1e-00000000c0de";
const MIRROR_ADDRESS = "0x6d1a0a0000000000000000000000000000000001";

function circle() {
  const createWallets = vi.fn(async () => ({ data: { wallets: [{ id: "mirror-wallet-1", address: MIRROR_ADDRESS }] } }));
  const factory = (() => ({
    listWalletSets: vi.fn(async () => ({ data: { walletSets: [{ id: "set-1", name: `vestiarion-${ORG}` }] } })),
    createWalletSet: vi.fn(),
    createWallets,
  })) as unknown as CircleClientFactory;
  return { factory, createWallets };
}

/** The ledger's entry giving the payee its mirror, as the new payee check reads it. */
const MIRROR_ENTRY = { action: "counterparty_address_changed", detail: { counterpartyId: PAYEE, via: "mirror", from: null, to: MIRROR_ADDRESS } };

function workspace(
  over: { shadow?: boolean; payee?: Record<string, unknown> | null; patched?: FakeReply; afterRace?: Record<string, unknown>; entries?: Array<Record<string, unknown>> } = {}
) {
  let reads = 0;
  return (r: RecordedRequest): FakeReply => {
    if (r.path === "/rest/v1/shadow_modes") return { body: over.shadow === false ? [] : [{ currency: "VND", started_at: "2026-10-07T00:00:00Z", started_by: MEMBER }] };
    if (r.path === "/rest/v1/counterparties" && r.method === "GET") {
      reads += 1;
      const row = reads > 1 && over.afterRace ? over.afterRace : over.payee === undefined ? { id: PAYEE, name: "Dien luc", role: "vendor", address: null, mirror_wallet_id: null } : over.payee;
      return { body: row ? [row] : [] };
    }
    if (r.path === "/rest/v1/counterparties" && r.method === "PATCH") return over.patched ?? { body: [{ id: PAYEE }] };
    if (r.path === "/rest/v1/ledger_entries" && r.method === "GET") return { body: over.entries ?? [] };
    return { body: [] };
  };
}

let fake: ReturnType<typeof fakeSupabase>;
const run = <T,>(fn: () => Promise<T>, config: VestiarionConfig = withCircle) => runWith(orgTestContext({ config, client: fake.client, orgId: ORG, userId: MEMBER }), fn);
const patches = () => fake.requests.filter((r) => r.path === "/rest/v1/counterparties" && r.method === "PATCH");

beforeEach(() => {
  ledgerMock.mockReset().mockResolvedValue(undefined);
});

describe("giveMirrorAddress", () => {
  it("makes a wallet on Arc testnet in the workspace's own wallet set, gives it to the payee, and signs it", async () => {
    const { factory, createWallets } = circle();
    fake = fakeSupabase(workspace());
    expect(await run(() => giveMirrorAddress({ actorId: MEMBER, counterpartyId: PAYEE }, { circle: factory }))).toEqual({ address: MIRROR_ADDRESS, walletId: "mirror-wallet-1" });

    expect(createWallets).toHaveBeenCalledWith(
      expect.objectContaining({ blockchains: ["ARC-TESTNET"], count: 1, walletSetId: "set-1", idempotencyKey: walletIdempotencyKey(ORG, `mirror:${PAYEE}`) })
    );
    const [patch] = patches();
    // No person typed it, so it waits for no one to confirm it, even where an earlier address was cleared (review finding 2).
    expect(patch.body).toEqual({ address: MIRROR_ADDRESS, chain: "ARC-TESTNET", mirror_wallet_id: "mirror-wallet-1", address_changed_at: null, address_confirmed_at: null });
    // Written only where the payee still has no address.
    expect(patch.params.get("address")).toBe("is.null");
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: "human",
        domain: "compliance",
        action: "counterparty_address_changed",
        detail: { by: MEMBER, counterpartyId: PAYEE, via: "mirror", from: null, to: MIRROR_ADDRESS, walletId: "mirror-wallet-1" },
      })
    );
  });

  it("is only for a workspace in shadow mode", async () => {
    const { factory, createWallets } = circle();
    fake = fakeSupabase(workspace({ shadow: false }));
    await expect(run(() => giveMirrorAddress({ actorId: MEMBER, counterpartyId: PAYEE }, { circle: factory }))).rejects.toMatchObject({ code: "not_in_shadow" });
    expect(createWallets).not.toHaveBeenCalled();
  });

  it("refuses a payee that has an address, a client, and one that is not this workspace's", async () => {
    const { factory, createWallets } = circle();
    fake = fakeSupabase(workspace({ payee: { id: PAYEE, name: "Dien luc", role: "vendor", address: "0x1234567890abcdef1234567890abcdef12345678", mirror_wallet_id: null } }));
    await expect(run(() => giveMirrorAddress({ actorId: MEMBER, counterpartyId: PAYEE }, { circle: factory }))).rejects.toMatchObject({ code: "has_address" });
    fake = fakeSupabase(workspace({ payee: { id: PAYEE, name: "Acme", role: "client", address: null, mirror_wallet_id: null } }));
    await expect(run(() => giveMirrorAddress({ actorId: MEMBER, counterpartyId: PAYEE }, { circle: factory }))).rejects.toMatchObject({ code: "client" });
    fake = fakeSupabase(workspace({ payee: null }));
    await expect(run(() => giveMirrorAddress({ actorId: MEMBER, counterpartyId: PAYEE }, { circle: factory }))).rejects.toMatchObject({ code: "not_found" });
    expect(createWallets).not.toHaveBeenCalled();
  });

  it("answers with the mirror it has, made before or by another tab a moment before, and signs nothing twice", async () => {
    const { factory, createWallets } = circle();
    const mirrored = { id: PAYEE, name: "Dien luc", role: "vendor", address: MIRROR_ADDRESS, mirror_wallet_id: "mirror-wallet-1" };
    fake = fakeSupabase(workspace({ payee: mirrored, entries: [MIRROR_ENTRY] }));
    expect(await run(() => giveMirrorAddress({ actorId: MEMBER, counterpartyId: PAYEE }, { circle: factory }))).toEqual({ address: MIRROR_ADDRESS, walletId: "mirror-wallet-1" });
    expect(createWallets).not.toHaveBeenCalled();

    fake = fakeSupabase(workspace({ patched: { body: [] }, afterRace: mirrored }));
    expect(await run(() => giveMirrorAddress({ actorId: MEMBER, counterpartyId: PAYEE }, { circle: factory }))).toEqual({ address: MIRROR_ADDRESS, walletId: "mirror-wallet-1" });
    expect(ledgerMock).not.toHaveBeenCalled();
  });

  it("records a mirror the ledger does not have, when asked again after a request died having written it (review finding 1)", async () => {
    const { factory, createWallets } = circle();
    const mirrored = { id: PAYEE, name: "Dien luc", role: "vendor", address: MIRROR_ADDRESS, mirror_wallet_id: "mirror-wallet-1" };
    fake = fakeSupabase(workspace({ payee: mirrored, entries: [{ action: "create_counterparty", detail: { counterpartyId: PAYEE, address: null } }] }));

    expect(await run(() => giveMirrorAddress({ actorId: MEMBER, counterpartyId: PAYEE }, { circle: factory }))).toEqual({ address: MIRROR_ADDRESS, walletId: "mirror-wallet-1" });
    expect(createWallets).not.toHaveBeenCalled();
    expect(patches()).toHaveLength(0);
    expect(ledgerMock).toHaveBeenCalledTimes(1);
    expect(ledgerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "counterparty_address_changed",
        detail: { by: MEMBER, counterpartyId: PAYEE, via: "mirror", from: null, to: MIRROR_ADDRESS, walletId: "mirror-wallet-1" },
      })
    );
  });

  it("puts the payee back as it was when the mirror cannot be signed, so asking again makes it whole (review finding 1)", async () => {
    const { factory } = circle();
    const cleared = { id: PAYEE, name: "Dien luc", role: "vendor", address: null, chain: null, mirror_wallet_id: null, address_changed_at: "2026-10-06T10:00:00Z", address_confirmed_at: null };
    fake = fakeSupabase(workspace({ payee: cleared }));
    ledgerMock.mockRejectedValueOnce(new Error("ledger unavailable"));

    await expect(run(() => giveMirrorAddress({ actorId: MEMBER, counterpartyId: PAYEE }, { circle: factory }))).rejects.toThrow("ledger unavailable");
    const [, back] = patches();
    expect(back.body).toEqual({ address: null, chain: null, mirror_wallet_id: null, address_changed_at: "2026-10-06T10:00:00Z", address_confirmed_at: null });
    // Only the mirror this request wrote: not an address someone gave meanwhile.
    expect(back.params.get("address")).toBe(`eq.${MIRROR_ADDRESS}`);
    expect(back.params.get("mirror_wallet_id")).toBe("eq.mirror-wallet-1");
  });

  it("needs the workspace's Circle wallets, which going live on Arc testnet gives it", async () => {
    const { factory } = circle();
    fake = fakeSupabase(workspace());
    await expect(run(() => giveMirrorAddress({ actorId: MEMBER, counterpartyId: PAYEE }, { circle: factory }), base)).rejects.toMatchObject({
      code: "no_circle",
      message: "Go live on Arc testnet first: a mirror address is a wallet in this workspace's Circle wallets.",
    });
  });

  it("says each refusal in words a person reads", () => {
    expect(new MirrorAddressError("has_address").message).toBe("This payee has an address already. A mirror address is for a payee with none.");
  });
});
