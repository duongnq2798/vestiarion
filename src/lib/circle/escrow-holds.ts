import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { currentOrgConfig, currentOrgId } from "../context";
import { db, unwrap } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { ARC_TESTNET_RPC_URL } from "./arcFees";
import { ARC_TESTNET_USDC } from "./cctp";
import { escrowStepKey, readEscrowContract } from "./escrow-setup";
import { circleCall, CircleCallFailed } from "./provision";
import { awaitSettlement } from "./settlement";

/**
 * A milestone's hold in the workspace's escrow (docs/superpowers/specs/2026-10-01-milestone-escrow-design.md
 * E3, E5). Locking it is an owner's or admin's act: approve the escrow for the amount, then fund the hold, from
 * the operating wallet under the request's keys. The hold's id is the milestone's, so a milestone has one hold,
 * and the contract refuses a second; the chain is read before anything is sent and after a step Circle failed,
 * so a hold whose answer was lost is recorded rather than funded again.
 */

export type EscrowHoldClient = Pick<CircleDeveloperControlledWalletsClient, "createContractExecutionTransaction" | "getTransaction">;

export class EscrowHoldError extends Error {
  /** `renew`: Circle failed a step; the form makes a new request id, since the old one would only be answered with that failure. */
  constructor(
    message: string,
    readonly renew = false
  ) {
    super(message);
    this.name = "EscrowHoldError";
  }
}

/** keccak256("holds(bytes32)")'s first four bytes: the contract's public view of a hold. */
export const HOLDS_SELECTOR = "0x7175a3c2";
const STATES = ["none", "funded", "released", "refunded"] as const;
export type HoldState = (typeof STATES)[number];
const DAY_MS = 86_400_000;

/** A milestone's id as the hold's bytes32: its 16 bytes, then zeros. */
export function holdId(milestoneId: string): `0x${string}` {
  return `0x${milestoneId.replace(/-/g, "").toLowerCase().padEnd(64, "0")}`;
}

const units = (amount: number) => BigInt(Math.round(amount * 1_000_000)).toString();

/** A hold as the contract holds it, read with eth_call from Arc testnet's public RPC: it sends nothing. */
export async function readHold(
  escrow: string,
  id: string,
  options: { fetch?: typeof fetch; rpcUrl?: string } = {}
): Promise<{ payee: string; refundAfter: number; state: HoldState; amountUnits: bigint }> {
  const response = await (options.fetch ?? fetch)(options.rpcUrl ?? ARC_TESTNET_RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: escrow, data: `${HOLDS_SELECTOR}${id.slice(2)}` }, "latest"] }),
    signal: AbortSignal.timeout(5_000),
  });
  const answer = (await response.json()) as { result?: string };
  const words = answer.result?.slice(2).match(/.{64}/g);
  if (!response.ok || !words || words.length < 4) throw new Error("Arc testnet did not answer the hold's read.");
  return {
    payee: `0x${words[0].slice(24)}`,
    refundAfter: Number(BigInt(`0x${words[1]}`)),
    state: STATES[Number(BigInt(`0x${words[2]}`))] ?? "none",
    amountUnits: BigInt(`0x${words[3]}`),
  };
}

interface MilestoneForHold {
  id: string;
  status: string;
  amount: string | number;
  escrow_state: string | null;
  counterparties: { address: string | null; chain: string | null; name: string } | null;
}

async function operatingWallet(): Promise<{ walletId: string; address: string; balance: number | null }> {
  const row = unwrap(await db().from("accounts").select("id, circle_wallet_id, address, balance").eq("kind", "operating").single()) as {
    circle_wallet_id: string | null;
    address: string | null;
    balance?: string | number | null;
  };
  if (!row.circle_wallet_id || !row.address) throw new EscrowHoldError("This workspace's operating wallet has not been created yet.");
  const balance = row.balance == null ? null : Number(row.balance);
  return { walletId: row.circle_wallet_id, address: row.address, balance: Number.isFinite(balance) ? balance : null };
}

/** One contract call from the operating wallet under `key`, waited for: its id and hash, or Circle's terminal state. */
async function execute(
  client: EscrowHoldClient,
  walletId: string,
  call: { contractAddress: string; abiFunctionSignature: string; abiParameters: string[] },
  key: string
): Promise<{ ok: true; txHash: string | null } | { ok: false; state: string }> {
  const created = await circleCall(
    "createContractExecutionTransaction",
    () => client.createContractExecutionTransaction({ walletId, ...call, idempotencyKey: key, fee: { type: "level", config: { feeLevel: "MEDIUM" } } }),
    true
  );
  const id = created.data?.id;
  if (!id) throw new CircleCallFailed("createContractExecutionTransaction");
  const settled = await awaitSettlement(client, id);
  if (settled.status === "confirmed") return { ok: true, txHash: settled.transaction?.txHash ?? null };
  if (settled.status === "failed") return { ok: false, state: settled.transaction?.state ?? "FAILED" };
  throw new EscrowHoldError("Circle has not finished the transaction yet. Press again in a minute: nothing is sent twice.");
}

export async function lockMilestone(
  input: { actorId: string; milestoneId: string; refundAfter: string; requestId: string; now?: Date },
  options: { client?: (credentials: { apiKey: string; entitySecret: string }) => EscrowHoldClient; fetch?: typeof fetch; rpcUrl?: string } = {}
): Promise<{ fundTxHash: string | null }> {
  const escrow = await readEscrowContract();
  if (!escrow?.address) throw new EscrowHoldError("Set up escrow for this workspace first.");
  const milestone = unwrap(
    await db().from("milestones").select("id, status, amount, escrow_state, counterparties(address, chain, name)").eq("id", input.milestoneId).single()
  ) as MilestoneForHold;
  const contractor = milestone.counterparties;
  if (milestone.escrow_state) throw new EscrowHoldError("This milestone is already locked in escrow.");
  if (milestone.status === "paid") throw new EscrowHoldError("Only a milestone that is not paid yet can be locked in escrow.");
  if (!contractor?.address) throw new EscrowHoldError(`${contractor?.name ?? "The contractor"} has no Arc testnet address to lock this milestone for.`);
  if ((contractor.chain ?? "ARC-TESTNET") !== "ARC-TESTNET") throw new EscrowHoldError(`Escrow pays on Arc testnet; ${contractor.name} is paid on another chain.`);
  // A milestone whose payment has started is paid by it: locking it too would commit its amount twice.
  const started = unwrap(
    await db().from("payment_intents").select("id").eq("source_type", "milestone").eq("source_id", milestone.id).limit(1)
  ) as Array<{ id: string }>;
  if (started.length > 0) throw new EscrowHoldError("This milestone's payment has already started, so it cannot be locked in escrow.");

  const now = input.now ?? new Date();
  const refundAfter = new Date(`${input.refundAfter}T00:00:00Z`);
  if (Number.isNaN(refundAfter.getTime()) || refundAfter.getTime() <= now.getTime() || refundAfter.getTime() > now.getTime() + 366 * DAY_MS) {
    throw new EscrowHoldError("Choose a refund date after today, and within a year.");
  }
  const amount = Number(milestone.amount);
  const operating = await operatingWallet();
  const id = holdId(milestone.id);
  const chainOptions = { fetch: options.fetch, rpcUrl: options.rpcUrl };

  const record = async (fundTxHash: string | null) => {
    const saved = await db()
      .from("milestones")
      .update({ escrow_state: "funded", escrow_amount: amount, escrow_refund_after: refundAfter.toISOString(), escrow_fund_tx_hash: fundTxHash })
      .eq("id", milestone.id);
    if (saved.error) throw new Error(saved.error.message);
    await appendLedgerEntry({
      actor: "human",
      domain: "contractor",
      action: "escrow_funded",
      summary: `Locked ${amount} USDC in escrow for ${contractor.name} until ${refundAfter.toISOString().slice(0, 10)}`,
      detail: { by: input.actorId, milestoneId: milestone.id, contract: escrow.address, holdId: id, payee: contractor.address, amountUsdc: amount, refundAfter: refundAfter.toISOString(), fundTxHash },
    });
    return { fundTxHash };
  };

  // Already on chain: an earlier lock whose answer was lost. Record it; send nothing.
  if ((await readHold(escrow.address, id, chainOptions)).state !== "none") return record(null);

  if (operating.balance !== null && amount > operating.balance) {
    throw new EscrowHoldError(`The operating wallet holds ${operating.balance} USDC, less than the ${amount} USDC to lock.`);
  }
  const chain = currentOrgConfig().chain;
  if (chain.credentialsUnreadable || !chain.circleApiKey || !chain.circleEntitySecret) throw new EscrowHoldError("This workspace's Circle credentials could not be read.");
  const client = (options.client ?? initiateDeveloperControlledWalletsClient)({ apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret });
  const seed = `${currentOrgId()}/hold/${milestone.id}/${input.requestId}`;

  const approved = await execute(
    client,
    operating.walletId,
    { contractAddress: ARC_TESTNET_USDC, abiFunctionSignature: "approve(address,uint256)", abiParameters: [escrow.address, units(amount)] },
    escrowStepKey(`${seed}/approve`)
  );
  if (!approved.ok) throw new EscrowHoldError(`Circle did not complete the approval (${approved.state}). Nothing is locked; try again.`, true);

  const funded = await execute(
    client,
    operating.walletId,
    {
      contractAddress: escrow.address,
      abiFunctionSignature: "fund(bytes32,address,uint256,uint64)",
      abiParameters: [id, contractor.address, units(amount), String(Math.floor(refundAfter.getTime() / 1000))],
    },
    escrowStepKey(`${seed}/fund`)
  );
  if (!funded.ok) {
    // The contract refuses a hold it already has: a failed fund may be one whose earlier twin went through.
    if ((await readHold(escrow.address, id, chainOptions)).state !== "none") return record(null);
    throw new EscrowHoldError(`Circle did not complete the fund (${funded.state}). Nothing is locked; try again.`, true);
  }
  return record(funded.txHash);
}
