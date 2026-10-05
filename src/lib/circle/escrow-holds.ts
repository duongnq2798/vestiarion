import { workspaceNetwork } from "../workspace-network";
import { initiateDeveloperControlledWalletsClient, type CircleDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { currentOrgConfig, currentOrgId } from "../context";
import { addressUnconfirmed } from "../counterparty-address";
import { db, unwrap } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { networkRpcUrl } from "./arcFees";
import { homeChain } from "../payee-chains";
import { escrowStepKey, readEscrowContract } from "./escrow-setup";
import { circleCall, CircleCallFailed } from "./provision";
import { awaitSettlement } from "./settlement";
import { assertPaymentsEnabled } from "../payments-switch";

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
  options: { fetch?: typeof fetch; rpcUrl: string }
): Promise<{ payee: string; refundAfter: number; state: HoldState; amountUnits: bigint }> {
  const response = await (options.fetch ?? fetch)(options.rpcUrl, {
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
  counterparties: { address: string | null; chain: string | null; name: string; address_changed_at?: string | null; address_confirmed_at?: string | null } | null;
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
  // Nothing moves while the platform has payments switched off (payment safety S2).
  await assertPaymentsEnabled();
  const escrow = await readEscrowContract();
  if (!escrow?.address) throw new EscrowHoldError("Set up escrow for this workspace first.");
  const milestone = unwrap(
    await db()
      .from("milestones")
      .select("id, status, amount, escrow_state, counterparties(address, chain, name, address_changed_at, address_confirmed_at)")
      .eq("id", input.milestoneId)
      .single()
  ) as MilestoneForHold;
  const contractor = milestone.counterparties;
  if (milestone.escrow_state && milestone.escrow_state !== "funding") throw new EscrowHoldError("This milestone is already locked in escrow.");
  // Locked before the work is verified: once it is, the agent may be paying it (review I1).
  if (milestone.status !== "pending") throw new EscrowHoldError("Only a milestone not yet verified can be locked in escrow.");
  if (!contractor?.address) throw new EscrowHoldError(`${contractor?.name ?? "The contractor"} has no Arc testnet address to lock this milestone for.`);
  const network = workspaceNetwork();
  const own = homeChain(network.id).id;
  if ((contractor.chain ?? own) !== own) throw new EscrowHoldError(`Escrow pays on ${network.label}; ${contractor.name} is paid on another chain.`);
  // A hold pays one address for good: never one no one has confirmed (review C1).
  if (addressUnconfirmed(contractor.address_changed_at ?? null, contractor.address_confirmed_at ?? null)) {
    throw new EscrowHoldError(`${contractor.name}'s address changed and no one has confirmed it. Confirm it on Counterparties before locking a milestone for it.`);
  }
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
  const chainOptions = { fetch: options.fetch, rpcUrl: options.rpcUrl ?? networkRpcUrl(workspaceNetwork()) };

  // What is recorded is the hold as it is: the chain's payee, date and amount when it was found there (review M1).
  const record = async (hold: { payee: string; refundAfter: Date; amount: number }, fundTxHash: string | null) => {
    const saved = await db()
      .from("milestones")
      .update({ escrow_state: "funded", escrow_amount: hold.amount, escrow_refund_after: hold.refundAfter.toISOString(), escrow_fund_tx_hash: fundTxHash, escrow_payee: hold.payee })
      .eq("id", milestone.id);
    if (saved.error) throw new Error(saved.error.message);
    await appendLedgerEntry({
      actor: "human",
      domain: "contractor",
      action: "escrow_funded",
      summary: `Locked ${hold.amount} USDC in escrow for ${contractor.name} until ${hold.refundAfter.toISOString().slice(0, 10)}`,
      detail: { by: input.actorId, milestoneId: milestone.id, contract: escrow.address, holdId: id, payee: hold.payee, amountUsdc: hold.amount, refundAfter: hold.refundAfter.toISOString(), fundTxHash },
    });
    return { fundTxHash };
  };
  const recordFromChain = async () => {
    const onChain = await readHold(escrow.address as string, id, chainOptions);
    if (onChain.state === "none") return null;
    return record({ payee: onChain.payee, refundAfter: new Date(onChain.refundAfter * 1000), amount: Number(onChain.amountUnits) / 1_000_000 }, null);
  };
  const letGo = async () => {
    const released = await db().from("milestones").update({ escrow_state: null }).eq("id", milestone.id).eq("escrow_state", "funding");
    if (released.error) console.error("escrow: the lock's claim was not let go", milestone.id, released.error.message);
  };

  // Already on chain: an earlier lock whose answer was lost. Record it; send nothing.
  const found = await recordFromChain();
  if (found) return found;

  if (operating.balance !== null && amount > operating.balance) {
    throw new EscrowHoldError(`The operating wallet holds ${operating.balance} USDC, less than the ${amount} USDC to lock.`);
  }
  const chain = currentOrgConfig().chain;
  if (chain.credentialsUnreadable || !chain.circleApiKey || !chain.circleEntitySecret) throw new EscrowHoldError("This workspace's Circle credentials could not be read.");
  const client = (options.client ?? initiateDeveloperControlledWalletsClient)({ apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret });
  const seed = `${currentOrgId()}/hold/${milestone.id}/${input.requestId}`;

  // The claim: from here the agent holds this milestone rather than pay it, until the lock ends (review I1).
  const claimed = unwrap(
    await db()
      .from("milestones")
      .update({ escrow_state: "funding" })
      .eq("id", milestone.id)
      .eq("status", "pending")
      .or("escrow_state.is.null,escrow_state.eq.funding")
      .select("id")
  ) as Array<{ id: string }>;
  if (claimed.length === 0) throw new EscrowHoldError("This milestone changed while it was being locked. Reload the page.");

  const approved = await execute(
    client,
    operating.walletId,
    { contractAddress: workspaceNetwork().tokens.USDC, abiFunctionSignature: "approve(address,uint256)", abiParameters: [escrow.address, units(amount)] },
    escrowStepKey(`${seed}/approve`)
  );
  if (!approved.ok) {
    await letGo();
    throw new EscrowHoldError(`Circle did not complete the approval (${approved.state}). Nothing is locked; try again.`, true);
  }

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
    const twin = await recordFromChain();
    if (twin) return twin;
    await letGo();
    throw new EscrowHoldError(`Circle did not complete the fund (${funded.state}). Nothing is locked; try again.`, true);
  }
  return record({ payee: contractor.address, refundAfter, amount }, funded.txHash);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (date: Date) => `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;

/**
 * Takes a hold back to the workspace from its refund date (milestone escrow E5): an owner's or admin's act,
 * for a milestone not paid. The chain is read first: a hold it no longer has funded is recorded as it is
 * there, and nothing is sent. The refund runs under the request's key.
 */
export async function refundMilestone(
  input: { actorId: string; milestoneId: string; requestId: string; now?: Date },
  options: { client?: (credentials: { apiKey: string; entitySecret: string }) => EscrowHoldClient; fetch?: typeof fetch; rpcUrl?: string } = {}
): Promise<{ refundTxHash: string | null }> {
  // Nothing moves while the platform has payments switched off (payment safety S2).
  await assertPaymentsEnabled();
  const escrow = await readEscrowContract();
  if (!escrow?.address) throw new EscrowHoldError("Set up escrow for this workspace first.");
  const milestone = unwrap(
    await db().from("milestones").select("id, status, amount, escrow_state, escrow_amount, escrow_refund_after").eq("id", input.milestoneId).single()
  ) as { id: string; status: string; amount: string | number; escrow_state: string | null; escrow_amount: string | number | null; escrow_refund_after: string | null };
  // The chain decides whether the hold is still there, not the milestone's status (review I1).
  if (milestone.escrow_state !== "funded") throw new EscrowHoldError("This milestone has no hold in escrow to refund.");
  const refundAfter = new Date(milestone.escrow_refund_after ?? "");
  const now = input.now ?? new Date();
  if (Number.isNaN(refundAfter.getTime()) || now.getTime() < refundAfter.getTime()) throw new EscrowHoldError(`This hold can be refunded from ${day(refundAfter)}.`);

  const amount = Number(milestone.escrow_amount ?? milestone.amount);
  const id = holdId(milestone.id);
  const chainOptions = { fetch: options.fetch, rpcUrl: options.rpcUrl ?? networkRpcUrl(workspaceNetwork()) };
  const record = async (state: "refunded" | "released", refundTxHash: string | null) => {
    const saved = await db()
      .from("milestones")
      .update(state === "refunded" ? { escrow_state: "refunded", escrow_refund_tx_hash: refundTxHash } : { escrow_state: "released" })
      .eq("id", milestone.id);
    if (saved.error) throw new Error(saved.error.message);
    // Money back in the workspace is in the ledger, however it was found (review I3).
    if (state === "refunded") {
      await appendLedgerEntry({
        actor: "human",
        domain: "contractor",
        action: "escrow_refunded",
        summary: `Refunded ${amount} USDC from escrow to the workspace`,
        detail: { by: input.actorId, milestoneId: milestone.id, contract: escrow.address, holdId: id, amountUsdc: amount, refundTxHash },
      });
    }
  };

  const onChain = (await readHold(escrow.address, id, chainOptions)).state;
  if (onChain === "released") {
    await record("released", null);
    throw new EscrowHoldError("This hold was released to the contractor.");
  }
  if (onChain === "refunded") {
    await record("refunded", null);
    return { refundTxHash: null };
  }

  const chain = currentOrgConfig().chain;
  if (chain.credentialsUnreadable || !chain.circleApiKey || !chain.circleEntitySecret) throw new EscrowHoldError("This workspace's Circle credentials could not be read.");
  const client = (options.client ?? initiateDeveloperControlledWalletsClient)({ apiKey: chain.circleApiKey, entitySecret: chain.circleEntitySecret });
  const operating = await operatingWallet();
  const refunded = await execute(
    client,
    operating.walletId,
    { contractAddress: escrow.address, abiFunctionSignature: "refund(bytes32)", abiParameters: [id] },
    escrowStepKey(`${currentOrgId()}/refund/${milestone.id}/${input.requestId}`)
  );
  if (!refunded.ok) {
    const after = (await readHold(escrow.address, id, chainOptions)).state;
    if (after === "refunded") {
      await record("refunded", null);
      return { refundTxHash: null };
    }
    throw new EscrowHoldError(`Circle did not complete the refund (${refunded.state}). Nothing moved; try again.`, true);
  }
  await record("refunded", refunded.txHash);
  return { refundTxHash: refunded.txHash };
}
