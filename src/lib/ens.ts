import "server-only";
import { createPublicClient, getAddress, http, type Address, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { ccipRequest } from "viem/utils";
import { currentConfig } from "./context";
import { ENS_GATEWAY_HOSTS, ENS_RPC_DEFAULT } from "./ens-hosts";
import { isAddressName } from "./ens-words";

/**
 * Looking up ENS names and Basenames for an address field (docs/superpowers/specs/2026-10-22-ens-address-names-design.md
 * EN1, EN4): a name to the address it points to, and an address to its primary ENS name, read from Ethereum mainnet
 * through PublicNode, or the node `ENS_RPC_URL` names. A Basename resolves there through Coinbase's gateway.
 *
 * A name's resolver may ask the server to fetch a gateway it names (CCIP-read). The server fetches only an https gateway
 * on the hosts below, never one a resolver makes up, so a crafted name cannot make it call an address of its choosing.
 * Nothing is stored; each answer is kept for ten minutes.
 */

export { ENS_GATEWAY_HOSTS, ENS_RPC_DEFAULT };

const TIMEOUT_MS = 6_000;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;

/** Whether the server may fetch a CCIP-read gateway: https, on a listed host, nothing else (EN4). */
export function allowedGateway(url: string): boolean {
  try {
    const parsed = new URL(url.replace("{sender}", "0x").replace("{data}", "0x"));
    return parsed.protocol === "https:" && ENS_GATEWAY_HOSTS.includes(parsed.hostname) && parsed.port === "";
  } catch {
    return false;
  }
}

let client: PublicClient | null = null;
let clientUrl: string | null = null;

function ensClient(): PublicClient {
  const url = currentConfig().chain.ensRpcUrl ?? ENS_RPC_DEFAULT;
  if (client && clientUrl === url) return client;
  client = createPublicClient({
    chain: mainnet,
    transport: http(url, { timeout: TIMEOUT_MS }),
    ccipRead: {
      async request(parameters) {
        const urls = parameters.urls.filter(allowedGateway);
        if (urls.length === 0) throw new Error("ens: gateway not allowed");
        return ccipRequest({ ...parameters, urls });
      },
    },
  }) as PublicClient;
  clientUrl = url;
  return client;
}

const cache = new Map<string, { at: number; value: string | null }>();

async function cached(key: string, read: () => Promise<string | null>, now: number): Promise<string | null> {
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const value = await read();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: now, value });
  return value;
}

export interface EnsDeps {
  client?: Pick<PublicClient, "getEnsAddress" | "getEnsName">;
  now?: number;
}

/** The address a name points to (EN1), checksummed, or null for a name that points nowhere. Throws when the node cannot answer. */
export async function resolveAddressName(name: string, deps: EnsDeps = {}): Promise<{ name: string; address: Address } | null> {
  if (!isAddressName(name)) return null;
  const normalized = normalize(name.trim());
  const reader = deps.client ?? ensClient();
  const address = await cached(`name:${normalized}`, async () => (await reader.getEnsAddress({ name: normalized })) ?? null, deps.now ?? Date.now());
  return address ? { name: normalized, address: getAddress(address) } : null;
}

/** An address's primary ENS name (EN1), which its owner set and which points back to it, or null. Throws when the node cannot answer. */
export async function primaryName(address: string, deps: EnsDeps = {}): Promise<string | null> {
  const checked = getAddress(address);
  const reader = deps.client ?? ensClient();
  return cached(`address:${checked.toLowerCase()}`, async () => (await reader.getEnsName({ address: checked })) ?? null, deps.now ?? Date.now());
}

/** For tests: forget what was looked up. */
export function clearEnsCache(): void {
  cache.clear();
}
