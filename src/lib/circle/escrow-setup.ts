import crypto from "node:crypto";
import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { initiateSmartContractPlatformClient, type CircleSmartContractPlatformClient } from "@circle-fin/smart-contract-platform";
import { currentOrgConfig, currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import artifact from "../escrow/artifact.json";
import { appendLedgerEntry } from "../ledger";
import { ARC_TESTNET_USDC } from "./cctp";
import { circleCall, CircleCallFailed, treasuryWalletSetId, walletIdempotencyKey } from "./provision";
import { awaitSettlement } from "./settlement";

/**
 * Setting up a workspace's milestone escrow (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md E2):
 * an owner's or admin's deliberate act, never the agent's.
 *
 * The contract is deployed through Circle's Smart Contract Platform from an EOA deployer, the documented
 * path; the operating wallet gives the deployer 0.1 USDC for gas, and is the contract's payer, the only
 * address it answers to (R1, R2). Each step runs under a key and is recorded on the workspace's
 * `escrow_contracts` row as it completes, so a setup interrupted at any point resumes where it was; one
 * Circle failed starts over, with new keys.
 */

export type EscrowWalletsClient = Pick<
  CircleDeveloperControlledWalletsClient,
  "listWalletSets" | "createWalletSet" | "createWallets" | "getWallet" | "getWalletSet" | "createContractExecutionTransaction" | "getTransaction"
>;
export type EscrowScpClient = Pick<CircleSmartContractPlatformClient, "deployContract" | "getContract">;

export class EscrowSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EscrowSetupError";
  }
}

const GAS_USDC = 0.1;
const GAS_UNITS = "100000";
const POLL_MS = 3_000;
const WAIT_MS = 45_000;

interface EscrowRow {
  id: string;
  address: string | null;
  circle_contract_id: string | null;
  deployer_wallet_id: string | null;
  deployer_address: string | null;
  gas_tx_id: string | null;
  deploy_tx_hash: string | null;
}

const COLUMNS = "id, address, circle_contract_id, deployer_wallet_id, deployer_address, gas_tx_id, deploy_tx_hash";

/** A UUID-shaped key from a seed: Circle requires UUIDs, and the same seed must give the same key. */
export function escrowStepKey(seed: string): string {
  const bytes = crypto.createHash("sha256").update(`vestiarion/escrow/v1/${seed}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The workspace's escrow row, or null before its first setup. */
export async function readEscrowContract(): Promise<EscrowRow | null> {
  const found = await db().from("escrow_contracts").select(COLUMNS).maybeSingle<EscrowRow>();
  if (found.error) throw new Error(found.error.message);
  return found.data ?? null;
}

async function operatingWallet(): Promise<{ walletId: string; address: string; balance: number | null }> {
  const row = unwrap(await db().from("accounts").select("id, circle_wallet_id, address, balance").eq("kind", "operating").single()) as {
    circle_wallet_id: string | null;
    address: string | null;
    balance?: string | number | null;
  };
  if (!row.circle_wallet_id || !row.address) throw new EscrowSetupError("This workspace's operating wallet has not been created yet.");
  const balance = row.balance == null ? null : Number(row.balance);
  return { walletId: row.circle_wallet_id, address: row.address, balance: Number.isFinite(balance) ? balance : null };
}

async function record(id: string, values: Partial<EscrowRow>): Promise<void> {
  const saved = await db().from("escrow_contracts").update(values).eq("id", id);
  if (saved.error) throw new Error(saved.error.message);
}

/** Forgets an attempt Circle failed, so the next press starts over with new keys. */
async function forget(id: string): Promise<void> {
  const dropped = await db().from("escrow_contracts").delete().eq("id", id);
  if (dropped.error) throw new Error(dropped.error.message);
}

export async function setUpEscrow(
  input: { actorId: string },
  options: {
    wallets?: (credentials: { apiKey: string; entitySecret: string }) => EscrowWalletsClient;
    scp?: (credentials: { apiKey: string; entitySecret: string }) => EscrowScpClient;
    pollMs?: number;
    waitMs?: number;
  } = {}
): Promise<{ address: string; alreadySetUp: boolean }> {
  const existing = await readEscrowContract();
  if (existing?.address) return { address: existing.address, alreadySetUp: true };

  const chain = currentOrgConfig().chain;
  if (chain.credentialsUnreadable) throw new EscrowSetupError("This workspace's Circle credentials are stored but could not be read.");
  if (!chain.circleApiKey || !chain.circleEntitySecret) throw new EscrowSetupError("This workspace has no Circle credentials.");
  const orgId = currentOrgId();
  const operating = await operatingWallet();
  if (!existing?.gas_tx_id && operating.balance !== null && operating.balance < GAS_USDC) {
    throw new EscrowSetupError(`The operating wallet holds ${operating.balance} USDC; setting up escrow sends ${GAS_USDC} USDC of it to the deployer for gas.`);
  }
  const credentials = { apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret };
  const wallets = (options.wallets ?? initiateDeveloperControlledWalletsClient)(credentials);
  const scp = (options.scp ?? initiateSmartContractPlatformClient)(credentials);

  // The row this attempt records its steps on; its id is in every key, so an attempt that starts over gets new ones.
  let row = existing;
  if (!row) {
    const claimed = await db().from("escrow_contracts").insert({ created_by: input.actorId }).select(COLUMNS).single<EscrowRow>();
    if (claimed.error) {
      if (/escrow_contracts_org_id_key/.test(claimed.error.message)) throw new EscrowSetupError("Someone is setting up escrow right now. Reload the page in a minute.");
      throw new Error(claimed.error.message);
    }
    row = claimed.data;
  }

  // 1. The deployer: a Circle EOA, as the Smart Contract Platform's guide deploys from.
  if (!row.deployer_wallet_id || !row.deployer_address) {
    const created = await circleCall(
      "createWallets",
      async () =>
        wallets.createWallets({
          blockchains: ["ARC-TESTNET"],
          count: 1,
          walletSetId: await treasuryWalletSetId(wallets),
          accountType: "EOA",
          idempotencyKey: walletIdempotencyKey(orgId, "escrow-deployer"),
        }),
      true
    );
    const wallet = created.data?.wallets?.[0];
    if (!wallet?.id || !wallet.address) throw new CircleCallFailed("createWallets");
    await record(row.id, { deployer_wallet_id: wallet.id, deployer_address: wallet.address });
    row = { ...row, deployer_wallet_id: wallet.id, deployer_address: wallet.address };
  }

  // 2. Gas for the deployer: 0.1 USDC from the operating wallet, Arc testnet's gas token.
  if (!row.gas_tx_id) {
    const gas = await circleCall(
      "createContractExecutionTransaction",
      () =>
        wallets.createContractExecutionTransaction({
          walletId: operating.walletId,
          contractAddress: ARC_TESTNET_USDC,
          abiFunctionSignature: "transfer(address,uint256)",
          abiParameters: [row!.deployer_address as string, GAS_UNITS],
          idempotencyKey: escrowStepKey(`${orgId}/${row!.id}/gas`),
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        }),
      true
    );
    const gasId = gas.data?.id;
    if (!gasId) throw new CircleCallFailed("createContractExecutionTransaction");
    const settled = await awaitSettlement(wallets, gasId);
    if (settled.status === "failed") {
      await forget(row.id);
      throw new EscrowSetupError(`Circle did not send the deployer its gas (${settled.transaction?.state ?? "FAILED"}). Nothing is locked; press Set up escrow to try again.`);
    }
    if (settled.status !== "confirmed") throw new EscrowSetupError("The deployer's gas is still on its way. Press Set up escrow again in a minute to finish.");
    await record(row.id, { gas_tx_id: gasId });
    row = { ...row, gas_tx_id: gasId };
  }

  // 3. The deployment, for the operating wallet as payer.
  if (!row.circle_contract_id) {
    const deployed = await circleCall(
      "deployContract",
      () =>
        scp.deployContract({
          name: "VestiarionEscrow",
          description: "Vestiarion milestone escrow",
          walletId: row!.deployer_wallet_id as string,
          blockchain: "ARC-TESTNET",
          abiJson: JSON.stringify(artifact.abi),
          bytecode: artifact.bytecode,
          constructorParameters: [ARC_TESTNET_USDC, operating.address],
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
          idempotencyKey: escrowStepKey(`${orgId}/${row!.id}/deploy`),
        }),
      true
    );
    const contractId = deployed.data?.contractId;
    if (!contractId) throw new CircleCallFailed("deployContract");
    await record(row.id, { circle_contract_id: contractId });
    row = { ...row, circle_contract_id: contractId };
  }

  // 4. Its address, once Circle has one.
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
  for (;;) {
    const read = await circleCall("getContract", () => scp.getContract({ id: row!.circle_contract_id as string }), false);
    const contract = read.data?.contract;
    if (contract?.status === "FAILED") {
      await forget(row.id);
      throw new EscrowSetupError(
        `Circle could not deploy the escrow contract (${contract.deploymentErrorReason ?? "FAILED"}). Nothing is locked; press Set up escrow to try again.`
      );
    }
    if (contract?.status === "COMPLETE" && contract.contractAddress) {
      await record(row.id, { address: contract.contractAddress, deploy_tx_hash: contract.txHash ?? null });
      await appendLedgerEntry({
        actor: "human",
        domain: "contractor",
        action: "escrow_deployed",
        summary: `Milestone escrow deployed at ${contract.contractAddress}`,
        detail: {
          by: input.actorId,
          address: contract.contractAddress,
          payer: operating.address,
          deployer: row.deployer_address,
          circleContractId: row.circle_contract_id,
          txHash: contract.txHash ?? null,
        },
      });
      return { address: contract.contractAddress, alreadySetUp: false };
    }
    if (Date.now() >= deadline) throw new EscrowSetupError("The escrow contract is still being deployed. Press Set up escrow again in a minute to finish.");
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS));
  }
}
