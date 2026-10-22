import "server-only";
import { createPublicClient, getAddress, http, isHex, type Address, type Hex, type PublicClient } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { currentConfig } from "./context";
import { ENS_GATEWAY_HOSTS, ENS_RPC_DEFAULT } from "./ens-hosts";
import { isAddressName } from "./ens-words";

/**
 * Looking up ENS names and Basenames for an address field (docs/superpowers/specs/2026-10-22-ens-address-names-design.md
 * EN1, EN4): a name to the address it points to, and an address to its primary ENS name, read from Ethereum mainnet
 * through PublicNode, or the node `ENS_RPC_URL` names. A Basename resolves there through Coinbase's gateway.
 *
 * A name's resolver may ask the server to fetch a gateway it names (CCIP-read). The server fetches only an https gateway
 * on the hosts below, never one a resolver makes up, and follows no redirect, so a crafted name cannot make it call an
 * address of its choosing. Nothing is stored; each answer is kept for ten minutes, and a lookup gives up after ten
 * seconds.
 */

export { ENS_GATEWAY_HOSTS, ENS_RPC_DEFAULT };

const TIMEOUT_MS = 5_000;
const LOOKUP_MS = 10_000;
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

/**
 * Fetches a CCIP-read gateway as viem's `ccipRequest` does (GET when the URL carries `{data}`, POST otherwise), but only an
 * allowed one, within 5 seconds, and refusing a redirect, which could lead anywhere (EN4).
 */
export async function gatewayRequest(
  { data, sender, urls }: { data: Hex; sender: Address; urls: readonly string[] },
  fetcher: typeof fetch = fetch
): Promise<Hex> {
  const allowed = urls.filter(allowedGateway);
  if (allowed.length === 0) throw new Error("ens: gateway not allowed");
  let failure = new Error("ens: gateway did not answer");
  for (const url of allowed) {
    const get = url.includes("{data}");
    try {
      const response = await fetcher(url.replace("{sender}", sender.toLowerCase()).replace("{data}", data), {
        method: get ? "GET" : "POST",
        headers: get ? {} : { "Content-Type": "application/json" },
        body: get ? undefined : JSON.stringify({ data, sender }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const result = response.headers.get("Content-Type")?.startsWith("application/json")
        ? ((await response.json()) as { data?: unknown }).data
        : await response.text();
      if (response.ok && typeof result === "string" && isHex(result)) return result;
      failure = new Error(`ens: gateway answered ${response.status}`);
    } catch (error) {
      if (error instanceof Error) failure = error;
    }
  }
  throw failure;
}

let client: PublicClient | null = null;
let clientUrl: string | null = null;

function ensClient(): PublicClient {
  const url = currentConfig().chain.ensRpcUrl ?? ENS_RPC_DEFAULT;
  if (client && clientUrl === url) return client;
  client = createPublicClient({
    chain: mainnet,
    // One try: a person is waiting on the answer, and can paste the address instead.
    transport: http(url, { timeout: TIMEOUT_MS, retryCount: 0 }),
    ccipRead: { request: (parameters) => gatewayRequest(parameters) },
  }) as PublicClient;
  clientUrl = url;
  return client;
}

function withinDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("ens: lookup took too long")), LOOKUP_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

const cache = new Map<string, { at: number; value: string | null }>();

async function cached(key: string, read: () => Promise<string | null>, now: number): Promise<string | null> {
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const value = await withinDeadline(read());
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: now, value });
  return value;
}

/** A name in its normal form, or null for one ENS refuses (a hyphen in the third and fourth places, say). */
function normalized(name: string): string | null {
  try {
    return normalize(name);
  } catch {
    return null;
  }
}

export interface EnsDeps {
  client?: Pick<PublicClient, "getEnsAddress" | "getEnsName">;
  now?: number;
}

/** The address a name points to (EN1), checksummed, or null for a name that points nowhere. Throws when the node cannot answer. */
export async function resolveAddressName(name: string, deps: EnsDeps = {}): Promise<{ name: string; address: Address } | null> {
  if (!isAddressName(name)) return null;
  const valid = normalized(name.trim());
  if (!valid) return null;
  const reader = deps.client ?? ensClient();
  const address = await cached(`name:${valid}`, async () => (await reader.getEnsAddress({ name: valid })) ?? null, deps.now ?? Date.now());
  return address ? { name: valid, address: getAddress(address) } : null;
}

/**
 * An address's primary ENS name (EN1), which its owner set and which points back to it, or null. Throws when the node
 * cannot answer. The owner writes that record as they like, so a name with a hidden or lookalike character, which would
 * read as `acme.eth`, is dropped: only plain letters, digits and hyphens, in normal form, are shown.
 */
export async function primaryName(address: string, deps: EnsDeps = {}): Promise<string | null> {
  const checked = getAddress(address);
  const reader = deps.client ?? ensClient();
  const name = await cached(`address:${checked.toLowerCase()}`, async () => (await reader.getEnsName({ address: checked })) ?? null, deps.now ?? Date.now());
  return name && isAddressName(name) && normalized(name) === name ? name : null;
}

/** For tests: forget what was looked up. */
export function clearEnsCache(): void {
  cache.clear();
}
