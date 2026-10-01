import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { currentOrgConfig, currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { ARC_TESTNET_USDC } from "./cctp";
import { GATEWAY_WALLET, gatewayBalance, gatewayStepKey } from "./gateway";
import { circleCall, CircleCallFailed, treasuryWalletSetId, walletIdempotencyKey } from "./provision";
import { awaitSettlement } from "./settlement";

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

const toUnits = (amount: number) => BigInt(Math.round(amount * 1_000_000)).toString();

async function operatingWallet(): Promise<{ walletId: string; address: string }> {
  const row = unwrap(await db().from("accounts").select("id, circle_wallet_id, address").eq("kind", "operating").single()) as {
    circle_wallet_id: string | null;
    address: string | null;
  };
  if (!row.circle_wallet_id || !row.address) throw new Error("This workspace's operating wallet has not been created yet.");
  return { walletId: row.circle_wallet_id, address: row.address };
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
  call: { contractAddress: string; abiFunctionSignature: string; abiParameters: string[] },
  key: string,
  what: string
): Promise<{ id: string; txHash: string | null }> {
  const created = await circleCall(
    "createContractExecutionTransaction",
    () => client.createContractExecutionTransaction({ walletId, ...call, idempotencyKey: key, fee: { type: "level", config: { feeLevel: "MEDIUM" } } }),
    true
  );
  const id = created.data?.id;
  if (!id) throw new CircleCallFailed("createContractExecutionTransaction");
  const settled = await awaitSettlement(client, id);
  if (settled.status !== "confirmed") {
    throw new Error(`Circle did not complete the ${what} (${settled.transaction?.state ?? "no answer yet"}). Try again: the same request sends nothing twice.`);
  }
  return { id, txHash: settled.transaction?.txHash ?? null };
}

export async function fundGateway(
  input: { actorId: string; amount: number; requestId: string },
  options: { client?: (credentials: { apiKey: string; entitySecret: string }) => GatewayFundingClient; fetch?: typeof fetch } = {}
): Promise<FundGatewayResult> {
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error("Enter an amount greater than zero.");
  const chain = currentOrgConfig().chain;
  if (chain.credentialsUnreadable) throw new Error("This workspace's Circle credentials are stored but could not be read.");
  if (!chain.circleApiKey || !chain.circleEntitySecret) throw new Error("This workspace has no Circle credentials.");

  const orgId = currentOrgId();
  const operating = await operatingWallet();
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

  // The delegate: once per workspace, from the operating wallet.
  if (!signer.delegate_tx_hash) {
    const delegated = await execute(
      client,
      operating.walletId,
      { contractAddress: GATEWAY_WALLET, abiFunctionSignature: "addDelegate(address,address)", abiParameters: [ARC_TESTNET_USDC, signer.address] },
      gatewayStepKey(`${orgId}/delegate`),
      "delegate on Gateway"
    );
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

  let balanceUsdc: number | null = null;
  try {
    balanceUsdc = await gatewayBalance(operating.address, { fetch: options.fetch });
  } catch {
    balanceUsdc = null;
  }
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
