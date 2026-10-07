import { createPublicClient, decodeFunctionResult, encodeFunctionData, erc20Abi, getAddress, http, TransactionReceiptNotFoundError, type Hex } from "viem";
import { networkRpcUrl } from "../circle/arcFees";
import type { NetworkProfile } from "../network";

/**
 * What the server reads of an owner's wallet and their contract on chain (docs/superpowers/specs/2026-10-07-wallet-
 * treasury-design.md W7–W9, W12), over the network's RPC: Circle holds neither, so nothing here asks Circle. Every read
 * is one JSON-RPC call; nothing here can move money.
 */

const RPC_TIMEOUT_MS = 10_000;

/** A transaction's outcome as the checks need it: addresses as the node gave them, in whatever case. */
export interface TreasuryReceipt {
  status: "success" | "reverted";
  from: Hex;
  to: Hex | null;
  contractAddress: Hex | null;
  /** Its logs: a bundler's transaction says in them whether each user operation in it succeeded (passkey treasury K7). */
  logs?: Array<{ address: Hex; topics: Hex[]; data: Hex }>;
}

export interface TreasuryChain {
  /** The transaction's receipt, or null while it is not mined. */
  receipt(hash: Hex): Promise<TreasuryReceipt | null>;
  /** The code at an address; `0x` for a wallet, or for nothing deployed there. */
  code(address: Hex): Promise<Hex>;
  /** A deployment simulated (`eth_call` with no `to`): the runtime code it would leave (W8). */
  simulateDeploy(input: { from: Hex; data: Hex }): Promise<Hex>;
  /** An `eth_call` at the latest block; throws on a revert. */
  read(to: Hex, data: Hex): Promise<Hex>;
  /** The owner's USDC, in the token's 6-decimal units. */
  usdcBalance(owner: Hex): Promise<bigint>;
  /** What the owner lets `spender` move of their USDC, in 6-decimal units. */
  allowance(owner: Hex, spender: Hex): Promise<bigint>;
  /** The native balance, which on Arc is USDC in 18 decimals: what an agent wallet pays its gas from (W10). */
  nativeBalance(address: Hex): Promise<bigint>;
}

/** An address as the node and viem take it, whatever case it came in (Review Focus 3). */
export function asAddress(address: string): Hex {
  return getAddress(address.toLowerCase());
}

/** The chain reads for `network`, over its RPC (ARC_MAINNET_RPC_URL when set) unless `rpcUrl` names another. */
export function treasuryChain(network: NetworkProfile, options: { rpcUrl?: string; fetch?: typeof fetch } = {}): TreasuryChain {
  const client = createPublicClient({
    // One try: a failed read is unreadable to every caller, and a page waiting on three stages of retries hung for minutes.
    transport: http(options.rpcUrl ?? networkRpcUrl(network), { timeout: RPC_TIMEOUT_MS, retryCount: 0, ...(options.fetch ? { fetchFn: options.fetch } : {}) }),
  });
  const usdc = asAddress(network.tokens.USDC);
  const ethCall = (call: { from?: Hex; to?: Hex; data: Hex }) => client.request({ method: "eth_call", params: [call, "latest"] }) as Promise<Hex>;

  return {
    async receipt(hash) {
      try {
        const found = await client.getTransactionReceipt({ hash });
        return {
          status: found.status,
          from: found.from,
          to: found.to ?? null,
          contractAddress: found.contractAddress ?? null,
          logs: found.logs.map((log) => ({ address: log.address, topics: log.topics as Hex[], data: log.data })),
        };
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
    async code(address) {
      return (await client.getCode({ address: asAddress(address) })) ?? "0x";
    },
    simulateDeploy({ from, data }) {
      return ethCall({ from: asAddress(from), data });
    },
    read(to, data) {
      return ethCall({ to: asAddress(to), data });
    },
    async usdcBalance(owner) {
      const data = await ethCall({ to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [asAddress(owner)] }) });
      return decodeFunctionResult({ abi: erc20Abi, functionName: "balanceOf", data });
    },
    async allowance(owner, spender) {
      const data = await ethCall({ to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [asAddress(owner), asAddress(spender)] }) });
      return decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data });
    },
    nativeBalance(address) {
      return client.getBalance({ address: asAddress(address) });
    },
  };
}
