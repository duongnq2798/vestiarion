import { workspaceNetwork } from "../workspace-network";
import { FeatureOffError } from "../network";
import crypto from "node:crypto";
import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { initiateSmartContractPlatformClient, type CircleSmartContractPlatformClient } from "@circle-fin/smart-contract-platform";
import { readOutflowBudget, type OutflowBudget } from "../agent/outflow-budget";
import { currentOrgConfig, currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { appendLedgerEntry } from "../ledger";
import artifact from "../spending-limit/artifact.json";
import { readSpendingLimit, SET_LIMITS_SIGNATURE, usdcUnits, type SpendingLimitReading } from "../spending-limit/onchain";
import { circleCall, CircleCallFailed, createScaWallet, treasuryWalletSetId, walletIdempotencyKey } from "./provision";
import { awaitSettlement } from "./settlement";
import { assertPaymentsEnabled } from "../payments-switch";

/**
 * Enforcing the agent's spending limit on Arc (docs/superpowers/specs/2026-10-03-onchain-spending-limit-design.md
 * R1, R2, R10, R11): an owner's or admin's deliberate act, never the agent's.
 *
 * The contract is deployed through Circle's Smart Contract Platform from an EOA deployer the operating wallet
 * gives 0.1 USDC of gas, as the escrow is. The agent gets a wallet of its own, a smart account holding no USDC,
 * whose gas Circle's Gas Station pays on Arc testnet; it is the only address the contract lets pay. The operating
 * wallet is the treasury the contract draws from and the owner that changes its figures, and it approves the
 * contract last. Each step is recorded on the workspace's `spending_limit_contracts` row as it completes, so a
 * setup interrupted at any point resumes where it was; a deployment Circle failed starts over, with new keys.
 */

export type SpendingLimitWalletsClient = Pick<
  CircleDeveloperControlledWalletsClient,
  "listWalletSets" | "createWalletSet" | "createWallets" | "getWallet" | "getWalletSet" | "createContractExecutionTransaction" | "getTransaction"
>;
export type SpendingLimitScpClient = Pick<CircleSmartContractPlatformClient, "deployContract" | "getContract">;

export class SpendingLimitSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendingLimitSetupError";
  }
}

/** The approval the operating wallet gives the contract: all it may ever draw, since `pay` bounds every draw. */
export const MAX_ALLOWANCE = (2n ** 256n - 1n).toString();

const GAS_USDC = 0.1;
const GAS_UNITS = "100000";
const POLL_MS = 3_000;
const WAIT_MS = 45_000;

export interface SpendingLimitRow {
  id: string;
  address: string | null;
  circle_contract_id: string | null;
  deployer_wallet_id: string | null;
  deployer_address: string | null;
  gas_tx_id: string | null;
  deploy_tx_hash: string | null;
  agent_wallet_id: string | null;
  agent_address: string | null;
  approve_tx_id: string | null;
  enforced: boolean;
}

const COLUMNS =
  "id, address, circle_contract_id, deployer_wallet_id, deployer_address, gas_tx_id, deploy_tx_hash, agent_wallet_id, agent_address, approve_tx_id, enforced";

interface Options {
  wallets?: (credentials: { apiKey: string; entitySecret: string }) => SpendingLimitWalletsClient;
  scp?: (credentials: { apiKey: string; entitySecret: string }) => SpendingLimitScpClient;
  pollMs?: number;
  waitMs?: number;
}

/** A UUID-shaped key from a seed: Circle requires UUIDs, and the same seed must give the same key. */
export function spendingLimitStepKey(seed: string): string {
  const bytes = crypto.createHash("sha256").update(`vestiarion/spending-limit-setup/v1/${seed}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** PostgREST's code for a table it does not know, and Postgres's own: the database has no migration 0062 yet. */
const MISSING_TABLE = new Set(["PGRST205", "42P01"]);

/**
 * The workspace's spending limit contract row, or null before its first setup. Null too before migration 0062:
 * without the table no workspace can enforce its limit on Arc, so the agent's payments and the limit's form work as
 * they did. Any other failure to read it throws: paying past a limit no one could read is what this guards.
 */
export async function readSpendingLimitContract(): Promise<SpendingLimitRow | null> {
  const found = await db().from("spending_limit_contracts").select(COLUMNS).maybeSingle<SpendingLimitRow>();
  if (found.error) {
    if (MISSING_TABLE.has(found.error.code ?? "")) return null;
    throw new Error(found.error.message);
  }
  return found.data ?? null;
}

/** What the agent's payments go through now: the contract and the agent's wallet, or null when it is not enforced (R3). */
export interface EnforcedSpendingLimit {
  contract: string;
  agentWalletId: string;
  agentAddress: string;
}

export async function enforcedSpendingLimit(): Promise<EnforcedSpendingLimit | null> {
  const row = await readSpendingLimitContract();
  if (!row?.enforced || !row.address || !row.agent_wallet_id || !row.agent_address) return null;
  return { contract: row.address, agentWalletId: row.agent_wallet_id, agentAddress: row.agent_address };
}

/** What the console shows of the limit on Arc (R14): the contract's own figures and count, never the code's. */
export interface SpendingLimitStatus {
  /** `enforced`; `off` once deployed but not carrying the agent's payments; `unfinished` before the deployment completed. */
  state: "enforced" | "off" | "unfinished";
  contract: string | null;
  agent: string | null;
  /** Read from the contract; null before it is deployed. */
  reading: SpendingLimitReading | null;
}

/** The workspace's limit on Arc for the console, or null when it was never set up. */
export async function spendingLimitStatus(read: (contract: string) => Promise<SpendingLimitReading> = readSpendingLimit): Promise<SpendingLimitStatus | null> {
  const row = await readSpendingLimitContract();
  if (!row) return null;
  return {
    state: row.enforced ? "enforced" : row.address ? "off" : "unfinished",
    contract: row.address,
    agent: row.agent_address,
    reading: row.address ? await read(row.address) : null,
  };
}

async function operatingWallet(): Promise<{ walletId: string; address: string; balance: number | null }> {
  const row = unwrap(await db().from("accounts").select("id, circle_wallet_id, address, balance").eq("kind", "operating").single()) as {
    circle_wallet_id: string | null;
    address: string | null;
    balance?: string | number | null;
  };
  if (!row.circle_wallet_id || !row.address) throw new SpendingLimitSetupError("This workspace's operating wallet has not been created yet.");
  const balance = row.balance == null ? null : Number(row.balance);
  return { walletId: row.circle_wallet_id, address: row.address, balance: Number.isFinite(balance) ? balance : null };
}

async function record(id: string, values: Partial<SpendingLimitRow> & { updated_at?: string }): Promise<void> {
  const saved = await db().from("spending_limit_contracts").update(values).eq("id", id);
  if (saved.error) throw new Error(saved.error.message);
}

async function forget(id: string): Promise<void> {
  const dropped = await db().from("spending_limit_contracts").delete().eq("id", id);
  if (dropped.error) throw new Error(dropped.error.message);
}

function clientsFor(options: Options): { wallets: SpendingLimitWalletsClient; scp: SpendingLimitScpClient } {
  const chain = currentOrgConfig().chain;
  if (chain.credentialsUnreadable) throw new SpendingLimitSetupError("This workspace's Circle credentials are stored but could not be read.");
  if (!chain.circleApiKey || !chain.circleEntitySecret) throw new SpendingLimitSetupError("This workspace has no Circle credentials.");
  const credentials = { apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret };
  return {
    wallets: (options.wallets ?? initiateDeveloperControlledWalletsClient)(credentials),
    scp: (options.scp ?? initiateSmartContractPlatformClient)(credentials),
  };
}

/**
 * One contract call from the operating wallet, waited for: its transaction hash once Circle confirms it. A call
 * Circle failed, or one still on its way, throws `what` with the reason, so the caller changes nothing.
 */
async function operatingCall(
  wallets: SpendingLimitWalletsClient,
  call: { walletId: string; contractAddress: string; abiFunctionSignature: string; abiParameters: string[]; idempotencyKey: string },
  what: string
): Promise<{ id: string; txHash: string | null }> {
  const sent = await circleCall(
    "createContractExecutionTransaction",
    () => wallets.createContractExecutionTransaction({ ...call, fee: { type: "level", config: { feeLevel: "MEDIUM" } } }),
    true
  );
  const id = sent.data?.id;
  if (!id) throw new CircleCallFailed("createContractExecutionTransaction");
  const settled = await awaitSettlement(wallets, id);
  if (settled.status === "failed") throw new SpendingLimitSetupError(`Circle did not ${what} (${settled.transaction?.state ?? "FAILED"}).`);
  if (settled.status !== "confirmed") throw new SpendingLimitSetupError(`Circle has not confirmed it yet: ${what} is still on its way. Try again in a minute.`);
  return { id, txHash: settled.transaction?.txHash ?? null };
}

const figures = (budget: OutflowBudget): [string, string] => [
  budget.dailyUsdc === null ? "0" : usdcUnits(budget.dailyUsdc).toString(),
  budget.weeklyUsdc === null ? "0" : usdcUnits(budget.weeklyUsdc).toString(),
];

export async function enforceSpendingLimit(input: { actorId: string }, options: Options = {}): Promise<{ contract: string; agent: string; alreadyEnforced: boolean }> {
  // The limit's contract is deployed per workspace, outside Arc mainnet's first scope (mainnet go-live M6): refused by
  // name, before anything is read.
  const network = workspaceNetwork();
  if (!network.spendingLimitContract) throw new FeatureOffError("Enforcing the spending limit in a contract", network);
  // Nothing moves while the platform has payments switched off (payment safety S2).
  await assertPaymentsEnabled();
  const existing = await readSpendingLimitContract();
  if (existing?.enforced && existing.address && existing.agent_address) {
    return { contract: existing.address, agent: existing.agent_address, alreadyEnforced: true };
  }

  // The figures the contract will hold (R1): one at least, as the contract itself requires.
  const budget = await readOutflowBudget(db());
  if (!budget || (budget.dailyUsdc === null && budget.weeklyUsdc === null)) {
    throw new SpendingLimitSetupError("Set a daily or 7-day limit first: the contract holds the agent to it.");
  }
  const { wallets, scp } = clientsFor(options);
  const orgId = currentOrgId();
  const operating = await operatingWallet();
  if (!existing?.gas_tx_id && operating.balance !== null && operating.balance < GAS_USDC) {
    throw new SpendingLimitSetupError(
      `The operating wallet holds ${operating.balance} USDC; enforcing the limit on Arc sends ${GAS_USDC} USDC of it to the deployer for gas.`
    );
  }

  // The row this setup records its steps on; its id is in every key, so a setup that starts over gets new ones.
  let row = existing;
  if (!row) {
    const claimed = await db().from("spending_limit_contracts").insert({ created_by: input.actorId }).select(COLUMNS).single<SpendingLimitRow>();
    if (claimed.error) {
      if (/spending_limit_contracts_org_id_key/.test(claimed.error.message)) {
        throw new SpendingLimitSetupError("Someone is setting this up right now. Reload the page in a minute.");
      }
      throw new Error(claimed.error.message);
    }
    row = claimed.data;
  }
  // A contract already deployed (turned off, or an approval that did not finish) is set to the current figures again.
  const deployedBefore = Boolean(row.address);

  // 1. The deployer: a Circle EOA, as the Smart Contract Platform deploys from.
  if (!row.deployer_wallet_id || !row.deployer_address) {
    const created = await circleCall(
      "createWallets",
      async () =>
        wallets.createWallets({
          blockchains: [workspaceNetwork().circleBlockchain as never],
          count: 1,
          walletSetId: await treasuryWalletSetId(wallets),
          accountType: "EOA",
          idempotencyKey: walletIdempotencyKey(orgId, "spending-limit-deployer"),
        }),
      true
    );
    const wallet = created.data?.wallets?.[0];
    if (!wallet?.id || !wallet.address) throw new CircleCallFailed("createWallets");
    await record(row.id, { deployer_wallet_id: wallet.id, deployer_address: wallet.address });
    row = { ...row, deployer_wallet_id: wallet.id, deployer_address: wallet.address };
  }

  // 2. Gas for the deployer: 0.1 USDC from the operating wallet, Arc testnet's gas token.
  if (!row.gas_tx_id && !deployedBefore) {
    const gas = await circleCall(
      "createContractExecutionTransaction",
      () =>
        wallets.createContractExecutionTransaction({
          walletId: operating.walletId,
          contractAddress: workspaceNetwork().tokens.USDC,
          abiFunctionSignature: "transfer(address,uint256)",
          abiParameters: [row!.deployer_address as string, GAS_UNITS],
          idempotencyKey: spendingLimitStepKey(`${orgId}/${row!.id}/gas`),
          fee: { type: "level", config: { feeLevel: "MEDIUM" } },
        }),
      true
    );
    const gasId = gas.data?.id;
    if (!gasId) throw new CircleCallFailed("createContractExecutionTransaction");
    const settled = await awaitSettlement(wallets, gasId);
    if (settled.status === "failed") {
      await forget(row.id);
      throw new SpendingLimitSetupError(`Circle did not send the deployer its gas (${settled.transaction?.state ?? "FAILED"}). Nothing is set up; press Enforce on Arc to try again.`);
    }
    if (settled.status !== "confirmed") throw new SpendingLimitSetupError("The deployer's gas is still on its way. Press Enforce on Arc again in a minute to finish.");
    await record(row.id, { gas_tx_id: gasId });
    row = { ...row, gas_tx_id: gasId };
  }

  // 3. The agent's own wallet: a smart account with no USDC, the only address the contract lets pay.
  if (!row.agent_wallet_id || !row.agent_address) {
    const agent = await createScaWallet(wallets, await treasuryWalletSetId(wallets), workspaceNetwork().circleBlockchain, walletIdempotencyKey(orgId, "spending-limit-agent"));
    await record(row.id, { agent_wallet_id: agent.id, agent_address: agent.address });
    row = { ...row, agent_wallet_id: agent.id, agent_address: agent.address };
  }

  // 4. The deployment, with the operating wallet as treasury and owner, and the current figures.
  if (!row.address) {
    if (!row.circle_contract_id) {
      const deployed = await circleCall(
        "deployContract",
        () =>
          scp.deployContract({
            name: "VestiarionSpendingLimit",
            description: "Vestiarion agent spending limit",
            walletId: row!.deployer_wallet_id as string,
            blockchain: workspaceNetwork().circleBlockchain as never,
            abiJson: JSON.stringify(artifact.abi),
            bytecode: artifact.bytecode,
            constructorParameters: [workspaceNetwork().tokens.USDC, operating.address, row!.agent_address as string, ...figures(budget)],
            fee: { type: "level", config: { feeLevel: "MEDIUM" } },
            idempotencyKey: spendingLimitStepKey(`${orgId}/${row!.id}/deploy`),
          }),
        true
      );
      const contractId = deployed.data?.contractId;
      if (!contractId) throw new CircleCallFailed("deployContract");
      await record(row.id, { circle_contract_id: contractId });
      row = { ...row, circle_contract_id: contractId };
    }
    const deadline = Date.now() + (options.waitMs ?? WAIT_MS);
    for (;;) {
      const read = await circleCall("getContract", () => scp.getContract({ id: row!.circle_contract_id as string }), false);
      const contract = read.data?.contract;
      if (contract?.status === "FAILED") {
        await forget(row.id);
        throw new SpendingLimitSetupError(
          `Circle could not deploy the spending limit contract (${contract.deploymentErrorReason ?? "FAILED"}). Nothing is enforced; press Enforce on Arc to try again.`
        );
      }
      if (contract?.status === "COMPLETE" && contract.contractAddress) {
        await record(row.id, { address: contract.contractAddress, deploy_tx_hash: contract.txHash ?? null });
        row = { ...row, address: contract.contractAddress, deploy_tx_hash: contract.txHash ?? null };
        break;
      }
      if (Date.now() >= deadline) throw new SpendingLimitSetupError("The spending limit contract is still being deployed. Press Enforce on Arc again in a minute to finish.");
      await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? POLL_MS));
    }
  }
  const contract = row.address as string;

  // 5. A contract deployed earlier holds the figures it last had: it gets the current ones first (R11).
  let setLimitsTxHash: string | null = null;
  if (deployedBefore) {
    const set = await operatingCall(
      wallets,
      {
        walletId: operating.walletId,
        contractAddress: contract,
        abiFunctionSignature: SET_LIMITS_SIGNATURE,
        abiParameters: figures(budget),
        idempotencyKey: crypto.randomUUID(),
      },
      "set the current figures on the contract"
    );
    setLimitsTxHash = set.txHash;
  }

  // 6. The operating wallet's approval, after which the contract can draw for the agent's payments.
  const approved = await operatingCall(
    wallets,
    {
      walletId: operating.walletId,
      contractAddress: workspaceNetwork().tokens.USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [contract, MAX_ALLOWANCE],
      idempotencyKey: crypto.randomUUID(),
    },
    "send the operating wallet's approval"
  );
  await record(row.id, { approve_tx_id: approved.id, enforced: true, updated_at: new Date().toISOString() });

  await appendLedgerEntry({
    actor: "human",
    domain: "system",
    action: "spending_limit_enforced",
    summary: `Enforced the agent's spending limit on Arc through ${contract}`,
    detail: {
      by: input.actorId,
      contract,
      agent: row.agent_address,
      treasury: operating.address,
      dailyUsdc: budget.dailyUsdc,
      weeklyUsdc: budget.weeklyUsdc,
      deployTxHash: deployedBefore ? null : row.deploy_tx_hash,
      approveTxHash: approved.txHash,
      setLimitsTxHash,
    },
  });
  return { contract, agent: row.agent_address as string, alreadyEnforced: false };
}

/** Stops the agent's payments going through the contract: the approval goes to 0, and the contract stays (R11). */
export async function turnOffSpendingLimit(input: { actorId: string }, options: Options = {}): Promise<{ contract: string; txHash: string | null }> {
  const row = await readSpendingLimitContract();
  if (!row?.enforced || !row.address) throw new SpendingLimitSetupError("The spending limit is not enforced on Arc.");
  const { wallets } = clientsFor(options);
  const operating = await operatingWallet();
  const revoked = await operatingCall(
    wallets,
    {
      walletId: operating.walletId,
      contractAddress: workspaceNetwork().tokens.USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [row.address, "0"],
      idempotencyKey: crypto.randomUUID(),
    },
    "withdraw the operating wallet's approval"
  );
  await record(row.id, { enforced: false, approve_tx_id: null, updated_at: new Date().toISOString() });
  await appendLedgerEntry({
    actor: "human",
    domain: "system",
    action: "spending_limit_unenforced",
    summary: `Stopped enforcing the agent's spending limit on Arc through ${row.address}`,
    detail: { by: input.actorId, contract: row.address, txHash: revoked.txHash },
  });
  return { contract: row.address, txHash: revoked.txHash };
}

/** The contract's new figures, from the operating wallet, once Circle confirms them (R10). Throws, changing nothing, otherwise. */
export async function setLimitsOnChain(budget: OutflowBudget, options: Options = {}): Promise<{ contract: string; txHash: string | null }> {
  // Nothing moves while the platform has payments switched off (payment safety S2).
  await assertPaymentsEnabled();
  const row = await readSpendingLimitContract();
  if (!row?.address) throw new SpendingLimitSetupError("This workspace has no spending limit contract.");
  const { wallets } = clientsFor(options);
  const operating = await operatingWallet();
  try {
    const set = await operatingCall(
      wallets,
      {
        walletId: operating.walletId,
        contractAddress: row.address,
        abiFunctionSignature: SET_LIMITS_SIGNATURE,
        abiParameters: figures(budget),
        idempotencyKey: crypto.randomUUID(),
      },
      "change the figures on the contract"
    );
    return { contract: row.address, txHash: set.txHash };
  } catch (error) {
    if (error instanceof SpendingLimitSetupError) throw new SpendingLimitSetupError(`${error.message} The limit was not changed.`);
    throw error;
  }
}
