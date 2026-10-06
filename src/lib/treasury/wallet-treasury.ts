import { decodeFunctionResult, encodeFunctionData, erc20Abi, parseEther, type Hex } from "viem";
import { walletTreasuryAvailable, type WalletHost } from "../config";
import { currentConfig, currentOrgConfig, currentOrgId, NoOrgScopeError } from "../context";
import { db, platformDb, unwrap } from "../dal";
import { withOrg } from "../dal/scope";
import type { LedgerEntryInput } from "../ledger";
import { appendLedgerEntryBestEffort } from "../ledger-best-effort";
import { MAINNET_NOT_OPEN, mayUseMainnet } from "../mainnet";
import { networkOf, networkProfile, type NetworkProfile } from "../network";
import { workspaceNetwork } from "../workspace-network";
import { readOutflowBudget } from "../agent/outflow-budget";
import { circleFailureLabel, defaultCircleClient, type CircleClientFactory } from "../circle/check";
import { ensureNotificationSubscription } from "../circle/notifications";
import { AGENT_WALLET_SET, createWallet, walletIdempotencyKey, walletSetIdNamed } from "../circle/provision";
import { withDeadline } from "../circle/settlement";
import { MAX_ALLOWANCE } from "../circle/spending-limit-setup";
import { SPENDING_LIMIT_ABI, usdcUnits } from "../spending-limit/onchain";
import { asAddress, treasuryChain, type TreasuryChain } from "./chain";
import { deploymentData, verifyApproval, verifyDeployment, verifyWalletProof, walletProofMessage } from "./verify";

/**
 * The setup of a workspace that pays from its owner's own wallet (docs/superpowers/specs/2026-10-07-wallet-treasury-
 * design.md W3, W5–W10), one step after another: the owner proves their wallet; Vestiarion creates the agent's wallet
 * in its own agent account; the owner deploys the contract and approves it from their wallet; on a network whose agent
 * pays its own gas, the owner sends it some. The server builds every transaction the owner's wallet sends and reads
 * every result back from the chain before it records it (W7).
 */

export type WalletTreasuryStep = "wallet" | "agent" | "deploy" | "approve" | "gas" | "ready";

/** What the Go live panel shows of the setup: nothing secret, and no Circle wallet id. */
export interface WalletTreasuryStatus {
  step: WalletTreasuryStep;
  wallet: string | null;
  agent: string | null;
  contract: string | null;
  /** The contract's own figures, once deployed; null for a figure not set. */
  dailyUsdc: number | null;
  weeklyUsdc: number | null;
  /** Read from the chain; null when not read, or not readable now. */
  walletUsdc: number | null;
  spendableUsdc: number | null;
  agentGasUsdc: number | null;
  /** What the agent must hold to go live: the profile's gas reserve, 0 where its gas is paid for it. */
  agentGasMinimumUsdc: number;
}

export type WalletTreasuryErrorCode =
  | "unavailable"
  | "not_allowed"
  | "proof_refused"
  | "not_an_eoa"
  | "wrong_step"
  | "invalid_figures"
  | "chain_refused"
  | "chain_unreadable"
  | "agent_failed";

const MESSAGES: Record<WalletTreasuryErrorCode, string> = {
  unavailable: "Paying from your own wallet is not available for this workspace on this deployment.",
  not_allowed: MAINNET_NOT_OPEN,
  proof_refused: "The wallet's signature could not be accepted; sign again.",
  not_an_eoa: "That address is a contract, not a wallet in your browser. Use a wallet such as MetaMask or Rabby.",
  wrong_step: "That step is not the one this workspace is on; reload the page.",
  invalid_figures: "Set a daily figure, a 7-day figure, or both, above 0 USDC. The 7-day figure cannot be below the daily one.",
  chain_refused: "The chain does not show what was expected; nothing was recorded.",
  chain_unreadable: "The chain could not be read just now; nothing was recorded. Try again in a moment.",
  agent_failed: "Circle did not create the agent's wallet; nothing was recorded. Try again in a moment.",
};

export class WalletTreasuryError extends Error {
  constructor(
    readonly code: WalletTreasuryErrorCode,
    message: string = MESSAGES[code]
  ) {
    super(message);
    this.name = "WalletTreasuryError";
  }
}

/** A transaction for the owner's wallet to send: no `to` for a deployment, the value in wei as a decimal string. */
export interface PreparedTransaction {
  to: string | null;
  data: string;
  value: string;
  chainId: number;
}

export interface WalletTreasuryDeps {
  chain?: TreasuryChain;
  circle?: CircleClientFactory;
  now?: number;
}

/** What the owner sends the agent for its gas, where it pays its own (W10). */
const AGENT_GAS_USDC = "0.5";
/** How long the agent's account is given to make its notification subscription. */
const SUBSCRIBE_DEADLINE_MS = 10_000;
/** An allowance this large is unlimited for every purpose: half of uint256. */
const UNLIMITED = 2n ** 255n;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

interface OrgFacts {
  slug: string;
  mode: "sandbox" | "live";
  walletHost: WalletHost | null;
  network: NetworkProfile;
  credentials: boolean;
}

async function orgFacts(orgId: string): Promise<OrgFacts> {
  const row = unwrap(
    await platformDb().from("orgs").select("slug, mode, wallet_host, network, api_key_stored:circle_api_key_enc->>k").eq("id", orgId).single()
  ) as { slug: string; mode: "sandbox" | "live"; wallet_host: string | null; network: string | null; api_key_stored: string | null };
  const host = row.wallet_host === "own" || row.wallet_host === "hosted" || row.wallet_host === "external" ? row.wallet_host : null;
  return { slug: row.slug, mode: row.mode, walletHost: host, network: networkProfile(networkOf(row.network)), credentials: row.api_key_stored !== null };
}

/** Every step: Arc mainnet open to the person, the path offered here, and the workspace not live yet. */
function admit(org: OrgFacts, actorEmail: string | null | undefined): void {
  if (org.network.id === "arc-mainnet" && !mayUseMainnet(actorEmail, currentConfig())) throw new WalletTreasuryError("not_allowed");
  if (!walletTreasuryAvailable(currentConfig(), org.network)) throw new WalletTreasuryError("unavailable");
  if (org.mode === "live") throw new WalletTreasuryError("wrong_step", "This workspace is live already.");
}

function scopedOrgId(): string | null {
  try {
    return currentOrgId();
  } catch (error) {
    if (error instanceof NoOrgScopeError) return null;
    throw error;
  }
}

function inScopeOf<T>(orgId: string, actorId: string | undefined, fn: () => Promise<T>): Promise<T> {
  return scopedOrgId() === orgId ? fn() : withOrg(orgId, fn, { userId: actorId });
}

function record(orgId: string, actorId: string, entry: Omit<LedgerEntryInput, "actor" | "domain">): Promise<void> {
  return appendLedgerEntryBestEffort(orgId, { actor: "human", domain: "system", ...entry }, scopedOrgId() === orgId ? {} : { enterScope: { userId: actorId } });
}

interface ContractRow {
  id: string;
  treasury_kind: string | null;
  treasury_address: string | null;
  agent_wallet_id: string | null;
  agent_address: string | null;
  address: string | null;
  deploy_tx_hash: string | null;
  approve_tx_hash: string | null;
  enforced: boolean;
}

const CONTRACT_COLUMNS = "id, treasury_kind, treasury_address, agent_wallet_id, agent_address, address, deploy_tx_hash, approve_tx_hash, enforced";

async function contractRow(): Promise<ContractRow | null> {
  const found = await db().from("spending_limit_contracts").select(CONTRACT_COLUMNS).maybeSingle<ContractRow>();
  if (found.error) throw new Error(found.error.message);
  return found.data ?? null;
}

async function operatingAccount(): Promise<{ id: string; address: string | null; circle_wallet_id: string | null } | null> {
  const found = await db().from("accounts").select("id, address, circle_wallet_id").eq("kind", "operating").maybeSingle<{ id: string; address: string | null; circle_wallet_id: string | null }>();
  if (found.error) throw new Error(found.error.message);
  return found.data ?? null;
}

/** The owner's wallet, the agent and the contract, in scope, as each step needs them; `wrong_step` where one is missing. */
async function setup(need: { agent?: boolean; contract?: boolean }): Promise<{ wallet: Hex; row: ContractRow | null; network: NetworkProfile }> {
  if (currentOrgConfig().chain.walletHost !== "external") throw new WalletTreasuryError("wrong_step", "Choose your own wallet first.");
  const operating = await operatingAccount();
  if (!operating?.address) throw new WalletTreasuryError("wrong_step", "Choose your own wallet first.");
  const row = await contractRow();
  if (need.agent && !row?.agent_address) throw new WalletTreasuryError("wrong_step", "Create the agent's wallet first.");
  if (need.contract && !row?.address) throw new WalletTreasuryError("wrong_step", "Deploy the contract from your wallet first.");
  return { wallet: asAddress(operating.address), row, network: workspaceNetwork() };
}

async function readOrRefuse<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof WalletTreasuryError) throw error;
    throw new WalletTreasuryError("chain_unreadable");
  }
}

async function tolerant<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

const usdcOf = (units: bigint | null) => (units === null ? null : Number(units) / 1_000_000);
const nativeUsdcOf = (wei: bigint | null) => (wei === null ? null : Number(wei / 1_000_000_000_000n) / 1_000_000);

/** Where the setup stands, with the chain's figures where they can be read (W10, W12). */
export async function walletTreasuryStatus(orgId: string, deps: WalletTreasuryDeps = {}): Promise<WalletTreasuryStatus> {
  return inScopeOf(orgId, undefined, async () => {
    const network = workspaceNetwork();
    const external = currentOrgConfig().chain.walletHost === "external";
    const operating = external ? await operatingAccount() : null;
    const row = external ? await contractRow() : null;
    const status: WalletTreasuryStatus = {
      step: "wallet",
      wallet: operating?.address ? asAddress(operating.address) : null,
      agent: row?.agent_address ? asAddress(row.agent_address) : null,
      contract: row?.address ? asAddress(row.address) : null,
      dailyUsdc: null,
      weeklyUsdc: null,
      walletUsdc: null,
      spendableUsdc: null,
      agentGasUsdc: null,
      agentGasMinimumUsdc: network.gasReserveUsdc,
    };
    if (!status.wallet) return status;
    const chain = deps.chain ?? treasuryChain(network);
    const wallet = status.wallet as Hex;
    const balance = await tolerant(() => chain.usdcBalance(wallet));
    status.walletUsdc = usdcOf(balance);
    if (!status.agent) return { ...status, step: "agent" };
    status.agentGasUsdc = nativeUsdcOf(await tolerant(() => chain.nativeBalance(status.agent as Hex)));
    if (!status.contract) return { ...status, step: "deploy" };
    const contract = status.contract as Hex;
    const figure = (functionName: "dailyLimit" | "weeklyLimit") =>
      tolerant(async () => decodeFunctionResult({ abi: SPENDING_LIMIT_ABI, functionName, data: await chain.read(contract, encodeFunctionData({ abi: SPENDING_LIMIT_ABI, functionName })) }) as bigint);
    const [daily, weekly, allowance] = await Promise.all([figure("dailyLimit"), figure("weeklyLimit"), tolerant(() => chain.allowance(wallet, contract))]);
    status.dailyUsdc = daily ? usdcOf(daily) : null;
    status.weeklyUsdc = weekly ? usdcOf(weekly) : null;
    status.spendableUsdc = balance === null || allowance === null ? null : usdcOf(balance < allowance ? balance : allowance);
    if (!row?.enforced) return { ...status, step: "approve" };
    if (network.gasReserveUsdc > 0 && (status.agentGasUsdc === null || status.agentGasUsdc < network.gasReserveUsdc)) return { ...status, step: "gas" };
    return { ...status, step: "ready" };
  });
}

/** The message the owner's wallet signs for this workspace now (W3). */
export async function proofMessage(input: { orgId: string; address: string; now?: number }): Promise<string> {
  const org = await orgFacts(input.orgId);
  return walletProofMessage({ orgSlug: org.slug, network: org.network, address: input.address, issuedAt: new Date(input.now ?? Date.now()).toISOString() });
}

/**
 * The owner proves their wallet, and it becomes the workspace's treasury (W1, W3): only while the workspace has chosen
 * no other host and has no Circle credentials, and, once chosen, until its contract is deployed. The address must be a
 * wallet, not a contract.
 */
export async function chooseWalletTreasury(
  input: { orgId: string; actorId: string; actorEmail?: string | null; address: string; message: string; signature: string },
  deps: WalletTreasuryDeps = {}
): Promise<void> {
  const org = await orgFacts(input.orgId);
  admit(org, input.actorEmail);
  if (org.credentials || (org.walletHost !== null && org.walletHost !== "external")) {
    throw new WalletTreasuryError("wrong_step", "This workspace chose where its wallets live already; start a new workspace to pay from your own wallet.");
  }
  let address: Hex;
  try {
    address = asAddress(input.address);
  } catch {
    throw new WalletTreasuryError("proof_refused", "That is not a wallet address.");
  }
  const proof = await verifyWalletProof({ message: input.message, signature: input.signature as Hex, address, orgSlug: org.slug, network: org.network, now: deps.now });
  if (!proof.ok) throw new WalletTreasuryError("proof_refused", proof.reason);
  const chain = deps.chain ?? treasuryChain(org.network);
  if ((await readOrRefuse(() => chain.code(address))) !== "0x") throw new WalletTreasuryError("not_an_eoa");

  await inScopeOf(input.orgId, input.actorId, async () => {
    const existing = await contractRow();
    if (existing?.address) throw new WalletTreasuryError("wrong_step", "The wallet is fixed once its contract is deployed.");
    const chosen = unwrap(
      await platformDb()
        .from("orgs")
        .update({ wallet_host: "external" })
        .eq("id", input.orgId)
        .eq("mode", "sandbox")
        .is("circle_api_key_enc", null)
        .or("wallet_host.is.null,wallet_host.eq.external")
        .select("id")
    ) as Array<{ id: string }>;
    if (chosen.length === 0) throw new WalletTreasuryError("wrong_step", "This workspace chose where its wallets live already.");
    const placed = unwrap(await db().from("accounts").update({ address }).eq("kind", "operating").is("circle_wallet_id", null).select("id")) as Array<{ id: string }>;
    if (placed.length === 0) throw new WalletTreasuryError("wrong_step", "This workspace's operating account has a Circle wallet already.");
    if (existing) {
      const updated = await db().from("spending_limit_contracts").update({ treasury_address: address }).eq("id", existing.id).is("address", null);
      if (updated.error) throw new Error(updated.error.message);
    }
    await record(input.orgId, input.actorId, {
      action: "treasury_wallet_proven",
      summary: `The workspace pays from ${address}, its owner's own wallet`,
      detail: { by: input.actorId, address, message: input.message, signature: input.signature, network: org.network.id },
    });
  });
}

/**
 * Creates the workspace's agent wallet in Vestiarion's agent account, once (W5): it is the only address that may pay
 * through the contract, and holds only gas. A second call keeps the first wallet.
 */
export async function createAgentWallet(input: { orgId: string; actorId: string; actorEmail?: string | null }, deps: WalletTreasuryDeps = {}): Promise<void> {
  const org = await orgFacts(input.orgId);
  admit(org, input.actorEmail);
  await inScopeOf(input.orgId, input.actorId, async () => {
    const { wallet, row, network } = await setup({});
    if (row?.agent_address) return;
    const { circleApiKey: apiKey, circleEntitySecret: entitySecret } = currentOrgConfig().chain;
    if (!apiKey || !entitySecret) throw new WalletTreasuryError("unavailable");
    const factory = deps.circle ?? defaultCircleClient;
    const client = factory({ apiKey, entitySecret });
    let agent: { id: string; address: string };
    try {
      const walletSetId = await walletSetIdNamed(client, AGENT_WALLET_SET);
      agent = await createWallet(client, {
        walletSetId,
        chain: network.circleBlockchain,
        accountType: network.walletAccountType,
        idempotencyKey: walletIdempotencyKey(input.orgId, "wallet-treasury-agent"),
      });
    } catch (error) {
      console.warn("wallet treasury: the agent's wallet was not created", circleFailureLabel(error));
      throw new WalletTreasuryError("agent_failed");
    }
    const fields = { treasury_kind: "external", treasury_address: wallet, agent_wallet_id: agent.id, agent_address: asAddress(agent.address) };
    const written = row
      ? await db().from("spending_limit_contracts").update(fields).eq("id", row.id).is("agent_address", null)
      : await db().from("spending_limit_contracts").insert({ ...fields, created_by: input.actorId }).select("id").single();
    if (written.error) throw new Error(written.error.message);
    await record(input.orgId, input.actorId, {
      action: "agent_wallet_created",
      summary: `Created the agent's wallet ${fields.agent_address}, which pays through the workspace's contract`,
      detail: { by: input.actorId, address: fields.agent_address },
    });
    // Circle tells Vestiarion when the agent's payments settle (W15): from production only, best effort, bounded.
    if (process.env.VERCEL_ENV === "production") {
      try {
        await withDeadline(ensureNotificationSubscription(factory({ apiKey, entitySecret })), SUBSCRIBE_DEADLINE_MS, "Circle did not answer the subscription");
      } catch (error) {
        console.warn("Circle notifications not subscribed for the agent account", circleFailureLabel(error));
      }
    }
  });
}

/**
 * The figures to deploy with, in units: the owner's, each empty one the workspace's agent spending limit's (W6). Each
 * defaults on its own, since the contract reads 0 as no limit: leaving one empty never deploys it unbounded.
 */
async function deploymentFigures(dailyUsdc: number | null, weeklyUsdc: number | null): Promise<{ daily: bigint; weekly: bigint }> {
  const budget = dailyUsdc === null || weeklyUsdc === null ? await readOutflowBudget(db()) : null;
  const daily = dailyUsdc ?? budget?.dailyUsdc ?? null;
  const weekly = weeklyUsdc ?? budget?.weeklyUsdc ?? null;
  // A figure too small to be one unit of USDC would be deployed as 0, no limit.
  const valid = (value: number | null) => value === null || (Number.isFinite(value) && value > 0 && usdcUnits(value) > 0n);
  if (!valid(daily) || !valid(weekly) || (daily === null && weekly === null) || (daily !== null && weekly !== null && weekly < daily)) {
    throw new WalletTreasuryError("invalid_figures");
  }
  return { daily: daily === null ? 0n : usdcUnits(daily), weekly: weekly === null ? 0n : usdcUnits(weekly) };
}

/** The deployment the owner's wallet sends (W6, W7): Vestiarion's contract with this wallet, agent and figures. */
export async function prepareDeployment(input: { orgId: string; dailyUsdc: number | null; weeklyUsdc: number | null }): Promise<PreparedTransaction> {
  return inScopeOf(input.orgId, undefined, async () => {
    const { wallet, row, network } = await setup({ agent: true });
    if (row?.approve_tx_hash) throw new WalletTreasuryError("wrong_step", "The contract is approved already.");
    const figures = await deploymentFigures(input.dailyUsdc, input.weeklyUsdc);
    return {
      to: null,
      data: deploymentData({ usdc: network.tokens.USDC, treasury: wallet, agent: row?.agent_address as string, dailyUnits: figures.daily, weeklyUnits: figures.weekly }),
      value: "0",
      chainId: network.chainId,
    };
  });
}

function txHash(value: string): Hex {
  if (!TX_HASH.test(value.trim())) throw new WalletTreasuryError("chain_refused", "That is not a transaction hash.");
  return value.trim().toLowerCase() as Hex;
}

/**
 * Records the owner's deployment once the chain shows it (W8): `pending` while it is not mined. A deployment verified
 * before the approval replaces an earlier one; an approved contract is never replaced. Its figures become the
 * workspace's agent spending limit, so the code's limit and the contract's agree.
 */
export async function recordDeployment(input: { orgId: string; actorId: string; txHash: string }, deps: WalletTreasuryDeps = {}): Promise<"pending" | "verified"> {
  const hash = txHash(input.txHash);
  return inScopeOf(input.orgId, input.actorId, async () => {
    const { wallet, row, network } = await setup({ agent: true });
    // The deployment already recorded, asked about again (a lost answer, a second tab, a reload): answered, not recorded twice.
    if (row?.address && row.deploy_tx_hash === hash) return "verified";
    if (!row || row.approve_tx_hash) throw new WalletTreasuryError("wrong_step", "The contract is approved already; it cannot be replaced.");
    const chain = deps.chain ?? treasuryChain(network);
    const check = await readOrRefuse(() => verifyDeployment(chain, { txHash: hash, usdc: network.tokens.USDC, treasury: wallet, agent: row.agent_address as string }));
    if (check.state === "pending") return "pending";
    if (check.state === "refused") throw new WalletTreasuryError("chain_refused", check.reason);

    const written = unwrap(
      await db().from("spending_limit_contracts").update({ address: check.contract, deploy_tx_hash: hash }).eq("id", row.id).is("approve_tx_hash", null).select("id")
    ) as Array<{ id: string }>;
    if (written.length === 0) throw new WalletTreasuryError("wrong_step", "The contract is approved already; it cannot be replaced.");

    const to = { dailyUsdc: check.dailyUnits === 0n ? null : Number(check.dailyUnits) / 1_000_000, weeklyUsdc: check.weeklyUnits === 0n ? null : Number(check.weeklyUnits) / 1_000_000 };
    const from = await readOutflowBudget(db());
    if (from?.dailyUsdc !== to.dailyUsdc || from?.weeklyUsdc !== to.weeklyUsdc) {
      const budget = await db()
        .from("agent_budgets")
        .upsert({ daily_usdc: to.dailyUsdc, weekly_usdc: to.weeklyUsdc, updated_by: input.actorId, updated_at: new Date().toISOString() }, { onConflict: "org_id" });
      if (budget.error) throw new Error(budget.error.message);
      await record(input.orgId, input.actorId, {
        action: "agent_budget_changed",
        summary: "The agent's spending limit follows the contract the owner's wallet deployed",
        detail: { by: input.actorId, from, to, onChain: { contract: check.contract, txHash: hash } },
      });
    }
    await record(input.orgId, input.actorId, {
      action: "spending_limit_deployed",
      summary: `The owner's wallet deployed the workspace's spending limit contract ${check.contract}`,
      detail: { by: input.actorId, contract: check.contract, txHash: hash, dailyUsdc: to.dailyUsdc, weeklyUsdc: to.weeklyUsdc },
    });
    return "verified";
  });
}

/** The approval the owner's wallet sends on USDC (W9): unlimited unless capped, since the contract bounds each day and week. */
export async function prepareApproval(input: { orgId: string; capUsdc: number | null }): Promise<PreparedTransaction> {
  return inScopeOf(input.orgId, undefined, async () => {
    const { row, network } = await setup({ agent: true, contract: true });
    if (input.capUsdc !== null && !(Number.isFinite(input.capUsdc) && input.capUsdc > 0)) throw new WalletTreasuryError("invalid_figures", "Set a cap above 0 USDC, or none.");
    const amount = input.capUsdc === null ? BigInt(MAX_ALLOWANCE) : usdcUnits(input.capUsdc);
    return {
      to: asAddress(network.tokens.USDC),
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [asAddress(row?.address as string), amount] }),
      value: "0",
      chainId: network.chainId,
    };
  });
}

/** Records the owner's approval once the chain shows it, and the contract then carries every payment (W9, W11). */
export async function recordApproval(input: { orgId: string; actorId: string; txHash: string }, deps: WalletTreasuryDeps = {}): Promise<"pending" | "verified"> {
  const hash = txHash(input.txHash);
  return inScopeOf(input.orgId, input.actorId, async () => {
    const { wallet, row, network } = await setup({ agent: true, contract: true });
    // The approval already recorded is answered again, never recorded twice; another one is refused (Review Focus 1).
    if (row?.approve_tx_hash === hash && row.enforced) return "verified";
    if (row?.approve_tx_hash) throw new WalletTreasuryError("wrong_step", "The contract is approved already.");
    const contract = row?.address as string;
    const chain = deps.chain ?? treasuryChain(network);
    const check = await readOrRefuse(() => verifyApproval(chain, { txHash: hash, usdc: network.tokens.USDC, treasury: wallet, contract, minimumUnits: 1n }));
    if (check.state === "pending") return "pending";
    if (check.state === "refused") throw new WalletTreasuryError("chain_refused", check.reason);
    // Only while no approval is recorded: one recorded meanwhile, from another tab, wins, and nothing is appended here.
    const written = unwrap(
      await db()
        .from("spending_limit_contracts")
        .update({ approve_tx_hash: hash, enforced: true })
        .eq("id", (row as ContractRow).id)
        .eq("address", contract)
        .is("approve_tx_hash", null)
        .select("id")
    ) as Array<{ id: string }>;
    if (written.length === 0) throw new WalletTreasuryError("wrong_step", "The contract is approved already.");
    // The contract's figures, which its deployment made the workspace's spending limit.
    const figures = await readOutflowBudget(db());
    await record(input.orgId, input.actorId, {
      action: "spending_limit_enforced",
      summary: "The owner's wallet approved its spending limit contract, which now carries every payment",
      // The shape a Circle wallet's enforcement records, so one reader reads both: the treasury is the owner's wallet.
      detail: {
        by: input.actorId,
        contract: asAddress(contract),
        agent: asAddress(row?.agent_address as string),
        treasury: wallet,
        walletHost: "external",
        dailyUsdc: figures?.dailyUsdc ?? null,
        weeklyUsdc: figures?.weeklyUsdc ?? null,
        deployTxHash: row?.deploy_tx_hash ?? null,
        approveTxHash: hash,
        setLimitsTxHash: null,
        allowanceUsdc: check.allowanceUnits >= UNLIMITED ? null : Number(check.allowanceUnits) / 1_000_000,
      },
    });
    return "verified";
  });
}

/** The gas the owner's wallet sends the agent, where it pays its own (W10): 0.50 USDC, Arc's native currency. */
export async function prepareAgentGas(input: { orgId: string }): Promise<PreparedTransaction> {
  return inScopeOf(input.orgId, undefined, async () => {
    const { row, network } = await setup({ agent: true });
    if (network.gasReserveUsdc <= 0) throw new WalletTreasuryError("wrong_step", "The agent's gas is paid for it on this network.");
    return { to: asAddress(row?.agent_address as string), data: "0x", value: parseEther(AGENT_GAS_USDC).toString(), chainId: network.chainId };
  });
}
