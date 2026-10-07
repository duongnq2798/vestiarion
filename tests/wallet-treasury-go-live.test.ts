import { describe, expect, it } from "vitest";
import { connectCircle, goLive, goLiveStatus } from "@/lib/platform/go-live";
import {
  ACTOR,
  agentRow,
  APPROVE_TX,
  chain,
  chosen,
  CONTRACT,
  database,
  ORG,
  OWNER_EMAIL,
  sealLedgerKeysPerTest,
  world,
} from "./support/wallet-treasury-world";

/**
 * Go live for a workspace paying from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-treasury-
 * design.md W1, W10, W12): the path is offered on Arc mainnet where the deployment holds the agent account; the
 * workspace stays on the wallets step until its contract is approved and its agent holds gas; it never takes a Circle
 * account of its own; and it goes live with the typed word, as every mainnet workspace does.
 */

sealLedgerKeysPerTest();

const ready = () => world({ ...chosen, contract: agentRow({ address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true }) });
const fundedChain = () => chain({ usdc: 5_000_000n, allowance: 2n ** 256n - 1n, gas: 500_000_000_000_000_000n });

describe("goLiveStatus for a wallet treasury", () => {
  it("offers the owner's own wallet on Arc mainnet, where the deployment holds the agent account", async () => {
    const status = await database(world()).inScope(() => goLiveStatus(ORG, { walletTreasury: { chain: chain() } }));
    expect(status.step).toBe("connect");
    expect(status.walletTreasuryAvailable).toBe(true);
    expect(status.walletTreasury).toBeNull();
  });

  it("is on the wallets step until the setup is ready, then on the go live step", async () => {
    const approving = await database(world({ ...chosen, contract: agentRow({ address: CONTRACT }) })).inScope(() => goLiveStatus(ORG, { walletTreasury: { chain: chain() } }));
    expect(approving.step).toBe("wallets");
    expect(approving.host).toBe("external");
    expect(approving.walletTreasury?.step).toBe("approve");
    const done = await database(ready()).inScope(() => goLiveStatus(ORG, { walletTreasury: { chain: fundedChain() } }));
    expect(done.step).toBe("go_live");
    expect(done.walletTreasury?.step).toBe("ready");
  });
});

describe("a wallet treasury and a Circle account", () => {
  it("never takes a Circle account of its own", async () => {
    const state = world(chosen);
    await expect(
      database(state).inScope(() => connectCircle({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, apiKey: "LIVE_API_KEY:a:b", entitySecret: "c0ffee".repeat(10) + "abcd" }))
    ).rejects.toMatchObject({ code: "external_wallet" });
    expect(state.org.circle_api_key_enc).toBeNull();
  });
});

describe("goLive for a wallet treasury", () => {
  it("waits until the contract is approved and the agent holds its gas", async () => {
    const state = world({ ...chosen, contract: agentRow({ address: CONTRACT }) });
    await expect(
      database(state).inScope(() => goLive({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, confirmation: "mainnet", walletTreasury: { chain: fundedChain() } }))
    ).rejects.toMatchObject({ code: "wallet_treasury_unfinished" });
    expect(state.org.mode).toBe("sandbox");
  });

  it("waits, on the passkey route, until the recovery is registered or skipped (passkey treasury K8, Review Focus 4)", async () => {
    const passkeyReady = (extra: Record<string, unknown> = {}) =>
      world({ ...chosen, contract: agentRow({ treasury_signer: "passkey", address: CONTRACT, approve_tx_hash: APPROVE_TX, enforced: true, ...extra }) });
    const undecided = passkeyReady();
    await expect(
      database(undecided).inScope(() => goLive({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, confirmation: "mainnet", walletTreasury: { chain: fundedChain() } }))
    ).rejects.toMatchObject({ code: "wallet_recovery_undecided", message: "Save a recovery phrase for the passkey wallet, or skip it, first." });
    expect(undecided.org.mode).toBe("sandbox");
    const skipped = passkeyReady({ recovery_skipped_at: "2026-10-07T10:00:00Z" });
    await database(skipped).inScope(() => goLive({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, confirmation: "mainnet", walletTreasury: { chain: fundedChain() } }));
    expect(skipped.org.mode).toBe("live");
  });

  it("asks for the typed word, then takes it live, saying whose wallet it pays from", async () => {
    const state = ready();
    const { inScope } = database(state);
    await expect(inScope(() => goLive({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, confirmation: "", walletTreasury: { chain: fundedChain() } }))).rejects.toMatchObject({
      code: "mainnet_confirmation",
    });
    await inScope(() => goLive({ orgId: ORG, actorId: ACTOR, actorEmail: OWNER_EMAIL, confirmation: "mainnet", walletTreasury: { chain: fundedChain() } }));
    expect(state.org.mode).toBe("live");
    expect(state.ledger).toEqual([{ action: "workspace_went_live", detail: { by: ACTOR, network: "arc-mainnet", walletHost: "external" } }]);
  });
});
