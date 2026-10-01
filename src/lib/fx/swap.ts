import crypto from "node:crypto";
import type { ChainProvider, SwapCallResult } from "../circle";
import { ARC_TESTNET_RPC_URL } from "../circle/arcFees";
import { currentOrgId } from "../context";
import { db } from "../dal";
import { appendLedgerEntry } from "../ledger";
import { ARC_TESTNET_EURC, FxQuoteError } from "./quote";
import { createSwapTransaction, swapCostPercent, type SwapOffer } from "./swap-service";
import { SWAP_COST_CAP_PERCENT } from "./swap-limits";

/**
 * A swap of USDC for EURC made to pay a EURC invoice (docs/superpowers/specs/2026-10-01-eurc-swap-design.md
 * S6, S7). The service's transaction is written to `fx_swaps` before anything is sent, with the swap's id
 * the Circle keys come from, so a swap whose answer was lost is resumed — the same two calls under the
 * same keys, which Circle answers with the transactions it already has — and never made again. What came
 * in is read from the swap's receipt on Arc testnet. Each swap that ends gets one `fx_swap` entry.
 */

export interface SwapDeps {
  provider: ChainProvider;
  operating: { id: string };
  /** The operating wallet's address: the swap's sender and the EURC's beneficiary. */
  operatingAddress: string;
  /** The workspace's Circle API key, for the Stablecoin Service. */
  apiKey?: string | null;
  /** For the service and for Arc testnet's RPC; the global fetch when absent. */
  fetch?: typeof fetch;
  rpcUrl?: string;
  retryDelayMs?: number;
}

export type SwapOutcome =
  | { ok: true; swapId: string; usdcIn: number; eurcMinimum: number; eurcReceived: number | null; swapTxHash: string | null }
  | { ok: false; pending: boolean; swapId: string | null; reason: string };

/** The swaps in flight a stage finished before deciding anything (S7), and whether swaps exist at all yet. */
export interface SwapSweep {
  /** False before migration 0048: no swap can be recorded, so none is offered (S8). */
  available: boolean;
  outcomes: Array<{ invoiceId: string; outcome: SwapOutcome }>;
}

interface SwapRow {
  id: string;
  invoice_id: string;
  usdc_in: string | number;
  eurc_minimum: string | number;
  eurc_estimated: string | number;
  usdc_per_eurc: string | number;
  cost_percent: string | number;
  provider: string | null;
  adapter: string;
  call_data: string;
}

const COLUMNS = "id, invoice_id, usdc_in, eurc_minimum, eurc_estimated, usdc_per_eurc, cost_percent, provider, adapter, call_data";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** A swap step's Circle idempotency key: a UUID from its seed, as escrow's are (`escrowStepKey`). */
export function swapStepKey(seed: string): string {
  const bytes = crypto.createHash("sha256").update(`vestiarion/swap/v1/${seed}`, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const num = (value: string | number) => Number(value);
const missingTable = (code: string | undefined) => code === "42P01" || code === "PGRST205";
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** A swap whose row exists but whose calls did not finish here: the next sweep resumes it (review #2). */
const unknownYet = (swapId: string, error: unknown): SwapOutcome => ({ ok: false, pending: true, swapId, reason: `The swap's outcome is not known yet (${message(error)}).` });

/** The EURC the swap's transaction sent to the wallet, from its receipt's Transfer logs; null when it cannot be read. */
async function eurcReceivedIn(txHash: string | null, wallet: string, deps: SwapDeps): Promise<number | null> {
  if (!txHash) return null;
  try {
    const response = await (deps.fetch ?? fetch)(deps.rpcUrl ?? ARC_TESTNET_RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [txHash] }),
      signal: AbortSignal.timeout(5_000),
    });
    const receipt = ((await response.json()) as { result?: { logs?: Array<{ address: string; topics: string[]; data: string }> } }).result;
    if (!response.ok || !receipt?.logs) return null;
    const to = `0x${wallet.slice(2).toLowerCase().padStart(64, "0")}`;
    const units = receipt.logs
      .filter((log) => log.address.toLowerCase() === ARC_TESTNET_EURC.toLowerCase() && log.topics[0] === TRANSFER_TOPIC && log.topics[2]?.toLowerCase() === to)
      .reduce((sum, log) => sum + BigInt(log.data), BigInt(0));
    return Number(units) / 1_000_000;
  } catch {
    return null;
  }
}

async function update(id: string, fields: Record<string, unknown>): Promise<void> {
  const saved = await db().from("fx_swaps").update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
  if (saved.error) throw new Error(saved.error.message);
}

/** Sends a recorded swap's two calls under its keys, and closes the row and records the swap once it ends. */
async function send(row: SwapRow, context: { counterpartyName: string; reasoning: string | null; resumed: boolean }, deps: SwapDeps): Promise<SwapOutcome> {
  if (!deps.provider.swapForEurc) return { ok: false, pending: false, swapId: row.id, reason: "This workspace's provider cannot swap." };
  const seed = `${currentOrgId()}/swap/${row.invoice_id}/${row.id}`;
  const usdcIn = num(row.usdc_in);
  const result: SwapCallResult = await deps.provider.swapForEurc({
    fromAccountId: deps.operating.id,
    adapter: row.adapter,
    usdcIn,
    callData: row.call_data,
    approveKey: swapStepKey(`${seed}/approve`),
    executeKey: swapStepKey(`${seed}/execute`),
  });
  const ids = {
    approve_tx_id: result.approve.txId,
    approve_tx_hash: result.approve.txHash,
    swap_tx_id: result.execute?.txId ?? null,
    swap_tx_hash: result.execute?.txHash ?? null,
  };
  const step = result.execute ?? result.approve;
  if (step.status === "pending") {
    await update(row.id, ids);
    return { ok: false, pending: true, swapId: row.id, reason: "A swap for this invoice is in flight at Circle." };
  }

  const confirmed = result.execute?.status === "confirmed";
  const failure = confirmed ? null : result.execute ? `Circle did not complete the swap (${result.execute.state ?? "FAILED"}).` : `Circle did not complete the approval (${result.approve.state ?? "FAILED"}).`;
  const eurcReceived = confirmed ? await eurcReceivedIn(result.execute?.txHash ?? null, deps.operatingAddress, deps) : null;
  await update(row.id, { ...ids, state: confirmed ? "confirmed" : "failed", eurc_received: eurcReceived, failure });
  const eurcMinimum = num(row.eurc_minimum);
  await appendLedgerEntry({
    actor: "agent",
    domain: "treasury",
    action: "fx_swap",
    summary: confirmed
      ? `SWAP ${usdcIn} USDC for ${eurcReceived ?? `at least ${eurcMinimum}`} EURC to pay ${context.counterpartyName}'s invoice`
      : `SWAP failed: ${usdcIn} USDC for EURC to pay ${context.counterpartyName}'s invoice`,
    // Not `invoiceId`: that names an invoice's decision entries, and a swap is not one (as receipts, 0046).
    detail: {
      paysInvoiceId: row.invoice_id,
      swapId: row.id,
      state: confirmed ? "confirmed" : "failed",
      usdcIn,
      eurcMinimum,
      eurcEstimated: num(row.eurc_estimated),
      eurcReceived,
      usdcPerEurc: num(row.usdc_per_eurc),
      costPercent: num(row.cost_percent),
      provider: row.provider,
      adapter: row.adapter,
      approveTxHash: result.approve.txHash,
      swapTxHash: result.execute?.txHash ?? null,
      failure,
      reasoning: context.reasoning,
      resumed: context.resumed,
    },
  });
  return confirmed
    ? { ok: true, swapId: row.id, usdcIn, eurcMinimum, eurcReceived, swapTxHash: result.execute?.txHash ?? null }
    : { ok: false, pending: false, swapId: row.id, reason: failure as string };
}

/**
 * Swaps `offer.usdcIn` USDC for EURC to pay an invoice `short` EURC short (S6): the service's
 * transaction, refused if its minimum no longer covers `short`; the row; then the calls.
 */
export async function swapForPayment(
  input: { invoiceId: string; counterpartyName: string; offer: SwapOffer; short: number; reasoning: string },
  deps: SwapDeps
): Promise<SwapOutcome> {
  let transaction;
  try {
    transaction = await createSwapTransaction(input.offer.usdcIn, { fromAddress: deps.operatingAddress, apiKey: deps.apiKey, fetch: deps.fetch, retryDelayMs: deps.retryDelayMs });
  } catch (error) {
    // Nothing is recorded or sent yet: no swap, and the payable is decided again next cycle.
    const why =
      error instanceof FxQuoteError
        ? error.code === "no_route"
          ? "No USDC→EURC route on Arc testnet right now"
          : error.code === "malformed"
            ? "its answer could not be read"
            : "it did not answer"
        : message(error);
    return { ok: false, pending: false, swapId: null, reason: `Circle's Stablecoin Service gave no swap: ${why}.` };
  }
  // The created transaction is weighed again: its estimate can be worse than the quote's (review #4).
  const cost = swapCostPercent(input.offer.usdcIn, transaction.eurcEstimated, input.offer.usdcPerEurc);
  if (cost > SWAP_COST_CAP_PERCENT) {
    return {
      ok: false,
      pending: false,
      swapId: null,
      reason: `The rate moved: the swap would now cost ${cost}% above the quoted rate, more than the ${SWAP_COST_CAP_PERCENT}% a swap may cost.`,
    };
  }
  if (transaction.eurcMinimum < input.short) {
    return {
      ok: false,
      pending: false,
      swapId: null,
      reason: `The rate moved: the swap would now give at least ${transaction.eurcMinimum} EURC, less than the ${input.short} EURC needed.`,
    };
  }

  const row: SwapRow = {
    id: crypto.randomUUID(),
    invoice_id: input.invoiceId,
    usdc_in: input.offer.usdcIn,
    eurc_minimum: transaction.eurcMinimum,
    eurc_estimated: transaction.eurcEstimated,
    usdc_per_eurc: input.offer.usdcPerEurc,
    cost_percent: input.offer.costPercent,
    provider: transaction.provider,
    adapter: transaction.adapter,
    call_data: transaction.callData,
  };
  const inserted = await db()
    .from("fx_swaps")
    .insert({ ...row, state: "submitted", deadline: transaction.deadline.toISOString() })
    .select("id")
    .single();
  if (inserted.error) {
    if (inserted.error.code === "23505") return { ok: false, pending: true, swapId: null, reason: "Another swap for this invoice is in flight." };
    if (missingTable(inserted.error.code)) return { ok: false, pending: false, swapId: null, reason: "Swaps are not set up for this workspace yet." };
    return { ok: false, pending: false, swapId: null, reason: `The swap could not be recorded (${inserted.error.message}).` };
  }
  try {
    return await send(row, { counterpartyName: input.counterpartyName, reasoning: input.reasoning, resumed: false }, deps);
  } catch (error) {
    return unknownYet(row.id, error);
  }
}

/**
 * Finishes every swap in flight (S7), before a stage decides anything: the same calls under the same
 * keys. One whose calls fail again is reported still in flight, not thrown, so one stuck swap never
 * stops a stage (review #2). Before migration 0048 there is no table: swaps are unavailable.
 */
export async function resumeOpenSwaps(deps: SwapDeps): Promise<SwapSweep> {
  const open = await db().from("fx_swaps").select(`${COLUMNS}, invoices(counterparties(name))`).eq("state", "submitted");
  if (open.error) {
    if (missingTable(open.error.code)) return { available: false, outcomes: [] };
    throw new Error(open.error.message);
  }
  const rows = (open.data ?? []) as unknown as Array<SwapRow & { invoices?: { counterparties?: { name?: string | null } | null } | null }>;
  const outcomes: SwapSweep["outcomes"] = [];
  for (const row of rows) {
    const counterpartyName = row.invoices?.counterparties?.name ?? "a counterparty";
    let outcome: SwapOutcome;
    try {
      outcome = await send(row, { counterpartyName, reasoning: null, resumed: true }, deps);
    } catch (error) {
      outcome = unknownYet(row.id, error);
    }
    outcomes.push({ invoiceId: row.invoice_id, outcome });
  }
  return { available: true, outcomes };
}
