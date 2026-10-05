import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { currentOrgConfig, currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { encodeFunctionData, getAddress, parseAbi } from "viem";
import { SCA_EXECUTE_BATCH } from "./batch";
import { ARC_TESTNET_USDC } from "./cctp";
import { GATEWAY_WALLET, gatewayBalance, gatewayStepKey } from "./gateway";
import { circleCall, CircleCallFailed, treasuryWalletSetId, walletIdempotencyKey } from "./provision";
import { awaitSettlement } from "./settlement";
import { assertPaymentsEnabled } from "../payments-switch";

/**
 * Funds the workspace's Gateway balance (docs/superpowers/specs/2026-10-01-gateway-payouts-design.md G1):
 * a person's deliberate move of treasury cash from the operating wallet into
 * Circle's GatewayWallet on Arc testnet, never the agent's (R2).
 *
 * The first funding creates the Gateway signer, a Circle EOA wallet, and makes
 * it the operating wallet's delegate on GatewayWallet: Gateway accepts only an
 * EOA's signature on a transfer, and an SCA cannot give one. Circle holds the
 * signer's key. Every step runs under an idempotency key from its seed, so a
 * retried or doubled request is answered with the transactions Circle already
 * made: one signer and one delegate per workspace, one deposit per request.
 */

export type GatewayFundingClient = Pick<
  CircleDeveloperControlledWalletsClient,
  "listWalletSets" | "createWalletSet" | "createWallets" | "getWallet" | "getWalletSet" | "createContractExecutionTransaction" | "getTransaction"
>;

export interface FundGatewayResult {
  signerAddress: string;
  depositTxHash: string | null;
  /** The Gateway balance read just after, or null when Gateway did not answer. */
  balanceUsdc: number | null;
}

interface SignerRow {
  circle_wallet_id: string;
  address: string;
  delegate_tx_id: string | null;
  delegate_tx_hash: string | null;
}

/**
 * A step Circle ended without completing it (`FAILED`, `CANCELLED` or `DENIED`): nothing moved, and the
 * same key would only be answered with the same failed transaction, so the request is made again as a
 * new one (review I5). `transactionId` is Circle's id for the failed transaction.
 */
export class GatewayStepFailed extends Error {
  readonly name = "GatewayStepFailed";
  constructor(
    message: string,
    readonly transactionId: string
  ) {
    super(message);
  }
}

const toUnits = (amount: number) => BigInt(Math.round(amount * 1_000_000)).toString();

async function operatingWallet(): Promise<{ walletId: string; address: string; balance: number | null }> {
  const row = unwrap(await db().from("accounts").select("id, circle_wallet_id, address, balance").eq("kind", "operating").single()) as {
    circle_wallet_id: string | null;
    address: string | null;
    balance?: string | number | null;
  };
  if (!row.circle_wallet_id || !row.address) throw new Error("This workspace's operating wallet has not been created yet.");
  const balance = row.balance == null ? null : Number(row.balance);
  return { walletId: row.circle_wallet_id, address: row.address, balance: Number.isFinite(balance) ? balance : null };
}

async function readSigner(): Promise<SignerRow | null> {
  const result = await db().from("gateway_signers").select("circle_wallet_id, address, delegate_tx_id, delegate_tx_hash").maybeSingle<SignerRow>();
  if (result.error) throw new Error(result.error.message);
  return result.data ?? null;
}

/** One contract call from the operating wallet under `key`, waited for; a call Circle did not complete throws. */
async function execute(
  client: GatewayFundingClient,
  walletId: string,
  call: { contractAddress: string; abiFunctionSignature: string; abiParameters: unknown[] },
  key: string,
  what: string
): Promise<{ id: string; txHash: string | null }> {
  const created = await circleCall(
    "createContractExecutionTransaction",
    () =>
      client.createContractExecutionTransaction({
        walletId,
        ...call,
        idempotencyKey: key,
        fee: { type: "level", config: { feeLevel: "MEDIUM" } },
      } as Parameters<GatewayFundingClient["createContractExecutionTransaction"]>[0]),
    true
  );
  const id = created.data?.id;
  if (!id) throw new CircleCallFailed("createContractExecutionTransaction");
  const settled = await awaitSettlement(client, id);
  if (settled.status === "failed") {
    throw new GatewayStepFailed(`Circle did not complete the ${what} (${settled.transaction?.state ?? "FAILED"}). Nothing was moved into Gateway; try again.`, id);
  }
  if (settled.status !== "confirmed") {
    throw new Error(`Circle did not complete the ${what} (${settled.transaction?.state ?? "no answer yet"}). Try again: the same request sends nothing twice.`);
  }
  return { id, txHash: settled.transaction?.txHash ?? null };
}

/** Reads the Gateway balance, or null when Gateway does not answer. */
async function readBalance(depositor: string, fetcher: typeof fetch | undefined): Promise<number | null> {
  try {
    return await gatewayBalance(depositor, { fetch: fetcher });
  } catch {
    return null;
  }
}

/**
 * The Gateway balance once Gateway counts a deposit: it does so a few seconds after Circle completes the
 * deposit on Arc testnet (Gateway rollout, where a read right after found none of it). Read until it
 * reaches `target` or `waitMs` pass; null if it has not, rather than a balance without the deposit.
 */
async function countedBalance(depositor: string, target: number, options: { fetch?: typeof fetch; waitMs: number; pollMs: number }): Promise<number | null> {
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    const balance = await readBalance(depositor, options.fetch);
    if (balance !== null && Math.round(balance * 1_000_000) >= Math.round(target * 1_000_000)) return balance;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

export async function fundGateway(
  input: { actorId: string; amount: number; requestId: string },
  options: {
    client?: (credentials: { apiKey: string; entitySecret: string }) => GatewayFundingClient;
    fetch?: typeof fetch;
    /** How long to wait for Gateway to count the deposit; 20 seconds unless given. */
    balanceWaitMs?: number;
    balancePollMs?: number;
  } = {}
): Promise<FundGatewayResult> {
  // Nothing moves while the platform has payments switched off (payment safety S2).
  assertPaymentsEnabled();
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("Enter an amount greater than zero.");
  const chain = currentOrgConfig().chain;
  if (chain.credentialsUnreadable) throw new Error("This workspace's Circle credentials are stored but could not be read.");
  if (!chain.circleApiKey || !chain.circleEntitySecret) throw new Error("This workspace has no Circle credentials.");

  const orgId = currentOrgId();
  const operating = await operatingWallet();
  // Weighed before any call: a deposit the wallet cannot cover would only fail on chain (review I5).
  if (operating.balance !== null && input.amount > operating.balance) {
    throw new Error(`The operating wallet holds ${operating.balance} USDC, less than the ${input.amount} USDC to move into Gateway.`);
  }
  const client = (options.client ?? initiateDeveloperControlledWalletsClient)({ apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret });

  // The signer: one Circle EOA per workspace, under a key of its own.
  let signer = await readSigner();
  if (!signer) {
    const walletSetId = await treasuryWalletSetId(client);
    const created = await circleCall(
      "createWallets",
      () =>
        client.createWallets({
          blockchains: ["ARC-TESTNET"],
          count: 1,
          walletSetId,
          accountType: "EOA",
          idempotencyKey: walletIdempotencyKey(orgId, "gateway-signer"),
        }),
      true
    );
    const wallet = created.data?.wallets?.[0];
    if (!wallet?.id || !wallet.address) throw new CircleCallFailed("createWallets");
    const inserted = await db()
      .from("gateway_signers")
      .upsert({ circle_wallet_id: wallet.id, address: wallet.address, created_by: input.actorId }, { onConflict: "org_id", ignoreDuplicates: true });
    if (inserted.error) throw new Error(inserted.error.message);
    signer = await readSigner();
    if (!signer) throw new Error("The Gateway signer was created but could not be stored.");
    await appendLedgerEntry({
      actor: "human",
      domain: "treasury",
      action: "gateway_signer_created",
      summary: `Gateway signer created: ${signer.address}`,
      detail: { by: input.actorId, signer: signer.address, circleWalletId: signer.circle_wallet_id },
    });
  }

  // The delegate: once per workspace, from the operating wallet. After one Circle failed, the next is
  // keyed by the failed transaction, which its key would otherwise return forever (review I5).
  if (!signer.delegate_tx_hash) {
    const failedBefore = signer.delegate_tx_id;
    let delegated: { id: string; txHash: string | null };
    try {
      delegated = await execute(
        client,
        operating.walletId,
        { contractAddress: GATEWAY_WALLET, abiFunctionSignature: "addDelegate(address,address)", abiParameters: [ARC_TESTNET_USDC, signer.address] },
        gatewayStepKey(failedBefore ? `${orgId}/delegate/after/${failedBefore}` : `${orgId}/delegate`),
        "delegate on Gateway"
      );
    } catch (error) {
      if (error instanceof GatewayStepFailed) {
        const noted = await db().from("gateway_signers").update({ delegate_tx_id: error.transactionId, delegate_tx_hash: null }).eq("address", signer.address);
        if (noted.error) throw new Error(noted.error.message);
      }
      throw error;
    }
    const stored = await db().from("gateway_signers").update({ delegate_tx_id: delegated.id, delegate_tx_hash: delegated.txHash }).eq("address", signer.address);
    if (stored.error) throw new Error(stored.error.message);
    await appendLedgerEntry({
      actor: "human",
      domain: "treasury",
      action: "gateway_delegate_added",
      summary: `Gateway signer ${signer.address} added as the operating wallet's delegate`,
      detail: { by: input.actorId, depositor: operating.address, signer: signer.address, txHash: delegated.txHash },
    });
  }

  // The deposit: approve GatewayWallet for the amount, then deposit it, each under this request's keys.
  // The balance before it, so the one after is known to include it.
  const before = await readBalance(operating.address, options.fetch);
  const units = toUnits(input.amount);
  const approved = await execute(
    client,
    operating.walletId,
    { contractAddress: ARC_TESTNET_USDC, abiFunctionSignature: "approve(address,uint256)", abiParameters: [GATEWAY_WALLET, units] },
    gatewayStepKey(`${orgId}/fund/${input.requestId}/approve`),
    "approval for Gateway"
  );
  const deposited = await execute(
    client,
    operating.walletId,
    { contractAddress: GATEWAY_WALLET, abiFunctionSignature: "deposit(address,uint256)", abiParameters: [ARC_TESTNET_USDC, units] },
    gatewayStepKey(`${orgId}/fund/${input.requestId}/deposit`),
    "deposit into Gateway"
  );

  const balanceUsdc =
    before === null
      ? null
      : await countedBalance(operating.address, before + input.amount, {
          fetch: options.fetch,
          waitMs: options.balanceWaitMs ?? 20_000,
          pollMs: options.balancePollMs ?? 2_000,
        });
  await appendLedgerEntry({
    actor: "human",
    domain: "treasury",
    action: "gateway_deposit",
    summary: `Deposited ${input.amount} USDC into the Gateway balance`,
    detail: {
      by: input.actorId,
      amountUsdc: input.amount,
      depositor: operating.address,
      signer: signer.address,
      approveTxHash: approved.txHash,
      depositTxHash: deposited.txHash,
      balanceUsdc,
    },
  });
  return { signerAddress: signer.address, depositTxHash: deposited.txHash, balanceUsdc };
}

/**
 * What the Treasury page shows of the Gateway balance (G5): the signer, and
 * the balance Gateway holds for the operating wallet, read now. Nothing
 * before the first funding; no balance when Gateway does not answer.
 */
export async function readGatewayState(options: { fetch?: typeof fetch } = {}): Promise<{ signerAddress: string | null; balanceUsdc: number | null }> {
  const signer = await readSigner();
  if (!signer) return { signerAddress: null, balanceUsdc: null };
  try {
    const operating = await operatingWallet();
    return { signerAddress: signer.address, balanceUsdc: await gatewayBalance(operating.address, { fetch: options.fetch }) };
  } catch {
    return { signerAddress: signer.address, balanceUsdc: null };
  }
}

const FUNDING_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
  "function depositFor(address token, address depositor, uint256 value)",
]);

/** The most one deposit adds to the agent's service budget: it pays for lookups, not payments. */
export const SERVICE_BUDGET_MAX_DEPOSIT_USDC = 1;

/**
 * Adds to the agent's service budget (docs/superpowers/specs/2026-10-02-x402-payee-history-design.md R4): a
 * person's move of USDC from the operating wallet into Gateway for the workspace's Gateway signer, the EOA
 * that pays for x402 services. One transaction, the operating wallet's own `executeBatch` of `approve` and
 * `depositFor`, under this request's key. The signer is the one Gateway funding created: fund Gateway once
 * first. Never the agent's.
 */
export async function fundServiceBudget(
  input: { actorId: string; amount: number; requestId: string },
  options: {
    client?: (credentials: { apiKey: string; entitySecret: string }) => GatewayFundingClient;
    fetch?: typeof fetch;
    balanceWaitMs?: number;
    balancePollMs?: number;
  } = {}
): Promise<{ signerAddress: string; txHash: string | null; balanceUsdc: number | null }> {
  // Nothing moves while the platform has payments switched off (payment safety S2).
  assertPaymentsEnabled();
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("Enter an amount greater than zero.");
  if (input.amount > SERVICE_BUDGET_MAX_DEPOSIT_USDC) {
    throw new Error(`Add at most ${SERVICE_BUDGET_MAX_DEPOSIT_USDC} USDC at a time: the budget pays for lookups of a thousandth of a USDC.`);
  }
  const chain = currentOrgConfig().chain;
  if (chain.credentialsUnreadable) throw new Error("This workspace's Circle credentials are stored but could not be read.");
  if (!chain.circleApiKey || !chain.circleEntitySecret) throw new Error("This workspace has no Circle credentials.");
  const signer = await readSigner();
  if (!signer) throw new Error("Fund Gateway once first: that creates the signer the agent pays services with.");
  const operating = await operatingWallet();
  if (operating.balance !== null && input.amount > operating.balance) {
    throw new Error(`The operating wallet holds ${operating.balance} USDC, less than the ${input.amount} USDC to add.`);
  }
  const client = (options.client ?? initiateDeveloperControlledWalletsClient)({ apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret });
  const units = BigInt(toUnits(input.amount));
  const before = await readBalance(signer.address, options.fetch);
  const funded = await execute(
    client,
    operating.walletId,
    {
      // The operating wallet itself: Circle runs its executeBatch, so both calls are one transaction.
      contractAddress: operating.address,
      abiFunctionSignature: SCA_EXECUTE_BATCH,
      abiParameters: [
        [
          [ARC_TESTNET_USDC, "0", encodeFunctionData({ abi: FUNDING_ABI, functionName: "approve", args: [getAddress(GATEWAY_WALLET), units] })],
          [GATEWAY_WALLET, "0", encodeFunctionData({ abi: FUNDING_ABI, functionName: "depositFor", args: [getAddress(ARC_TESTNET_USDC), getAddress(signer.address), units] })],
        ],
      ],
    },
    gatewayStepKey(`${currentOrgId()}/service-budget/${input.requestId}`),
    "deposit into the agent's service budget"
  );
  const balanceUsdc =
    before === null
      ? null
      : await countedBalance(signer.address, before + input.amount, { fetch: options.fetch, waitMs: options.balanceWaitMs ?? 20_000, pollMs: options.balancePollMs ?? 2_000 });
  await appendLedgerEntry({
    actor: "human",
    domain: "treasury",
    action: "service_budget_funded",
    summary: `Added ${input.amount} USDC to the agent's service budget`,
    detail: { by: input.actorId, amountUsdc: input.amount, signer: signer.address, depositor: operating.address, txHash: funded.txHash, balanceUsdc },
  });
  return { signerAddress: signer.address, txHash: funded.txHash, balanceUsdc };
}
