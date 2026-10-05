import { ARC_TESTNET_RPC_URL } from "../circle/arcFees";
import { chainById } from "../payee-chains";
import { ARC_TESTNET } from "../network";
import { payeeChain, type PayeeChain } from "../payee-chains";
import type { ReceiptFacts } from "./facts";

/**
 * A receipt's on-chain check (docs/superpowers/specs/2026-10-01-payment-receipts-design.md P5 check 3).
 * The transaction's receipt, read from the payee's chain, must hold a transfer of the amount to the payee
 * in the token, and the transaction must have succeeded. The sender is not checked: for a mint it is the
 * zero address.
 *
 * On Arc testnet USDC is the native token, and a payment is logged by the system address `0xff…fe` at
 * 18 decimals; it may also be logged by USDC's ERC-20 interface at 6. Gas is a second transfer, to the
 * bundler, which matches neither the payee nor the amount.
 */

export interface TxReceipt {
  status: string;
  blockNumber: string;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

export type OnChainCheck = { state: "matches"; block: number } | { state: "mismatch"; reason: string } | { state: "unreadable" };

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ARC_NATIVE_USDC = "0xfffffffffffffffffffffffffffffffffffffffe";
const RPC_TIMEOUT_MS = 4_000;

/**
 * The public RPC of each payee chain. Arc testnet's too: an anonymous page view never spends the
 * deployment's own node, which the agent reads fees through (review #5).
 */
const PUBLIC_RPC: Record<PayeeChain, string> = {
  "ARC-TESTNET": ARC_TESTNET_RPC_URL,
  "BASE-SEPOLIA": "https://sepolia.base.org",
  "ARB-SEPOLIA": "https://sepolia-rollup.arbitrum.io/rpc",
  "ETH-SEPOLIA": "https://ethereum-sepolia-rpc.publicnode.com",
};

export function receiptRpcUrl(chain: string): string {
  return PUBLIC_RPC[payeeChain(chain).id];
}

/**
 * Mined transactions' receipts, by chain and hash: a mined receipt never changes, so each is read once per
 * server instance however often its page is opened (review #5). Bounded; the oldest goes first.
 */
const MINED = new Map<string, TxReceipt>();
const MINED_LIMIT = 500;

/** Forgets every remembered receipt: for tests, which share this module. */
export function forgetMinedReceipts(): void {
  MINED.clear();
}

function remember(key: string, receipt: TxReceipt): void {
  if (MINED.size >= MINED_LIMIT) MINED.delete(MINED.keys().next().value as string);
  MINED.set(key, receipt);
}

/** The contracts that log a transfer of the token on the chain, with their decimals. */
function tokenContracts(facts: ReceiptFacts): Array<{ address: string; decimals: number }> {
  const chain = payeeChain(facts.chain).id;
  if (facts.token === "EURC") return chain === "ARC-TESTNET" ? [{ address: ARC_TESTNET.tokens.EURC, decimals: 6 }] : [];
  if (chain === "ARC-TESTNET") return [{ address: ARC_NATIVE_USDC, decimals: 18 }, { address: chainById(chain).usdc, decimals: 6 }];
  return [{ address: chainById(chain).usdc, decimals: 6 }];
}

function units(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 1_000_000)) * BigInt(10) ** BigInt(decimals - 6);
}

function topicAddress(topic: string | undefined): string {
  return topic ? `0x${topic.slice(-40)}`.toLowerCase() : "";
}

function value(data: string): bigint | null {
  try {
    return BigInt(data === "0x" ? 0 : data);
  } catch {
    return null;
  }
}

export function matchTransfer(facts: ReceiptFacts, receipt: TxReceipt): OnChainCheck {
  if (receipt.status !== "0x1") return { state: "mismatch", reason: "This transaction failed on chain." };
  const payee = facts.payee.toLowerCase();
  const found = tokenContracts(facts).some(({ address, decimals }) => {
    const expected = units(facts.amount, decimals);
    // A CCTP mint also carries the part of the most the fee could be that Circle did not charge (CCTP payouts
    // R3): the payee receives the amount, and at most the fee on top (review #3). Every other route is exact.
    const most = facts.route === "cctp" && facts.feeUsdc ? expected + units(facts.feeUsdc, decimals) : expected;
    return receipt.logs.some((log) => {
      const moved = value(log.data);
      return (
        log.address.toLowerCase() === address.toLowerCase() &&
        log.topics[0] === TRANSFER &&
        topicAddress(log.topics[2]) === payee &&
        moved !== null &&
        moved >= expected &&
        moved <= most
      );
    });
  });
  if (!found) return { state: "mismatch", reason: `No transfer of ${facts.amount} ${facts.token} to ${facts.payee} is in this transaction.` };
  return { state: "matches", block: Number(BigInt(receipt.blockNumber)) };
}

/** Reads the transaction's receipt from its chain and matches it; anything short of an answer is `unreadable`. */
export async function readOnChain(
  facts: ReceiptFacts,
  options: { fetch?: typeof fetch; rpcUrl?: (chain: string) => string; timeoutMs?: number } = {}
): Promise<OnChainCheck> {
  const key = `${payeeChain(facts.chain).id}:${facts.txHash.toLowerCase()}`;
  const known = MINED.get(key);
  if (known) return matchTransfer(facts, known);
  let answer: { result?: TxReceipt | null; error?: unknown };
  try {
    const response = await (options.fetch ?? fetch)((options.rpcUrl ?? receiptRpcUrl)(facts.chain), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getTransactionReceipt", params: [facts.txHash] }),
      signal: AbortSignal.timeout(options.timeoutMs ?? RPC_TIMEOUT_MS),
    });
    if (!response.ok) return { state: "unreadable" };
    answer = (await response.json()) as typeof answer;
  } catch {
    return { state: "unreadable" };
  }
  // No receipt is not proof of no transaction: a lagging or pruned node answers null too (review #4).
  if (answer.error || answer.result === undefined || answer.result === null) return { state: "unreadable" };
  try {
    const checked = matchTransfer(facts, answer.result);
    remember(key, answer.result);
    return checked;
  } catch {
    return { state: "unreadable" };
  }
}
