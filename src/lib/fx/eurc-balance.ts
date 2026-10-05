import { chainModes } from "../circle";
import { networkRpcUrl } from "../circle/arcFees";
import type { NetworkProfile } from "../network";
import { workspaceNetwork } from "../workspace-network";
import { db } from "../dal";

/**
 * The operating wallet's EURC, for the balance tile beside its USDC. Read from Arc testnet's public RPC
 * (EURC's `balanceOf`), not from Circle: it costs no Circle call and needs nothing stored. Null whenever
 * it cannot be read; the tile then shows no EURC line.
 */

/** `keccak256("balanceOf(address)")`'s first four bytes. */
const BALANCE_OF = "0x70a08231";

export async function readEurcBalance(address: string, options: { network: NetworkProfile; fetch?: typeof fetch; rpcUrl?: string }): Promise<number | null> {
  try {
    const response = await (options.fetch ?? fetch)(options.rpcUrl ?? networkRpcUrl(options.network), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: options.network.tokens.EURC, data: `${BALANCE_OF}${address.slice(2).toLowerCase().padStart(64, "0")}` }, "latest"],
      }),
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const result = ((await response.json()) as { result?: unknown }).result;
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]+$/.test(result)) return null;
    return Number(BigInt(result)) / 1_000_000;
  } catch {
    return null;
  }
}

/** The live operating wallet's EURC, in the organization's scope; null in a sandbox or before the wallet has an address. */
export async function operatingEurcBalance(options: { fetch?: typeof fetch; rpcUrl?: string } = {}): Promise<number | null> {
  if (chainModes().mode !== "live") return null;
  const row = await db().from("accounts").select("address").eq("kind", "operating").maybeSingle<{ address: string | null }>();
  const address = row.data?.address;
  if (row.error || !address || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  // The node this workspace is configured to read Arc testnet from, as the fee and receipt reads use.
  const network = workspaceNetwork();
  return readEurcBalance(address, { network, fetch: options.fetch, rpcUrl: options.rpcUrl ?? networkRpcUrl(network) });
}
