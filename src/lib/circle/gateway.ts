import { createHash } from "node:crypto";
import { chainOn, chainsOn, homeChain } from "../payee-chains";
import { MAY_HAVE_BEEN_ACCEPTED } from "./settlement";
import { FeatureOffError, type NetworkProfile } from "../network";

/**
 * Circle Gateway from Arc testnet (docs/superpowers/specs/2026-10-01-gateway-payouts-design.md).
 * A workspace's operating wallet deposits USDC into GatewayWallet on Arc; a
 * payout is then a burn intent its Gateway signer signs, sent to Gateway's
 * API with the Forwarding Service, and Circle mints on the payee's chain.
 * The EIP-712 types and domain are Circle's, exactly as its reference for an
 * SCA depositor with an EOA delegate builds them: a changed field name, type
 * or order makes every signature invalid.
 */

/**
 * Gateway on a network (network threading P2, P5): its API, Circle's x402 facilitator, and GatewayWallet and
 * GatewayMinter. A network without Gateway refuses by name, before any request.
 */
export function gatewayOf(network: NetworkProfile): { api: string; facilitator: string; wallet: string; minter: string } {
  if (!network.gateway) throw new FeatureOffError("Paying through Gateway", network);
  return network.gateway;
}

/** Gateway's domain for a network's own chain, which is CCTP's numbering. */
function sourceDomain(network: NetworkProfile): number {
  const domain = homeChain(network.id).domain;
  if (domain === null) throw new FeatureOffError("Paying through Gateway", network);
  return domain;
}
/** What a forwarded Gateway payout takes: the attestation is instant, and the mint is the next block on the payee's chain. */
export const EXPECTED_GATEWAY_SECONDS = 5;

const GATEWAY_DEADLINE_MS = 10_000;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** A Gateway API refusal or silence, in words that are safe to record. */
export class GatewayError extends Error {
  /** Gateway's HTTP status, when it answered with one. */
  readonly status?: number;
  /** True when the connection was never made, so the request never left (payment safety R8). */
  readonly neverSent?: boolean;
  constructor(message: string, status?: number, neverSent?: boolean) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    if (neverSent) this.neverSent = true;
  }
}

/** Connection failures in which the request never left (payment safety R8), as Node's fetch reports them in `cause`. */
const NEVER_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"]);

function connectionNeverMade(error: unknown): boolean {
  const code = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === "string" && NEVER_SENT.has(code);
}

const toBytes32 = (address: string) => `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const toUnits = (amount: number) => BigInt(Math.round(amount * 1_000_000));

/**
 * The burn intent's salt for a payment attempt: sha256 of its key and the
 * route. Every attempt under the same key asks for the same transfer, and
 * GatewayWallet spends a salt only once, so a retried payout cannot pay twice.
 */
export function gatewaySalt(attemptKey: string): `0x${string}` {
  return `0x${createHash("sha256").update(`${attemptKey}:gateway`, "utf8").digest("hex")}`;
}

/**
 * A Circle idempotency key for one Gateway step, from its seed: the same for
 * every run of that step, so Circle answers a retry with the transaction it
 * already made. Circle takes a UUID; this is the first 16 bytes of
 * sha256(`vestiarion/gateway/v1/<seed>`), shaped as one, as `bridgeStepKey` does.
 */
export function gatewayStepKey(seed: string): string {
  const hash = createHash("sha256").update(`vestiarion/gateway/v1/${seed}`, "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface GatewayPayout {
  /** The operating wallet: the Gateway balance's depositor. */
  depositor: string;
  /** The workspace's Gateway signer, the depositor's delegate. */
  signer: string;
  /** The payee, on `chain`. */
  recipient: string;
  chain: string;
  amount: number;
  salt: `0x${string}`;
}

export interface BurnIntent {
  maxBlockHeight: string;
  maxFee: string;
  spec: {
    version: 1;
    sourceDomain: number;
    destinationDomain: number;
    sourceContract: string;
    destinationContract: string;
    sourceToken: string;
    destinationToken: string;
    sourceDepositor: string;
    destinationRecipient: string;
    sourceSigner: string;
    destinationCaller: string;
    value: string;
    salt: string;
    hookData: "0x";
  };
}

function transferSpec(network: NetworkProfile, payout: GatewayPayout): BurnIntent["spec"] {
  const gateway = gatewayOf(network);
  const target = chainOn(network.id, payout.chain);
  if (target.id === homeChain(network.id).id) throw new GatewayError(`A payee on ${network.label} is paid directly, not through Gateway`);
  if (target.domain === null) throw new GatewayError(`Gateway has no domain for ${target.label}`);
  return {
    version: 1,
    sourceDomain: sourceDomain(network),
    destinationDomain: target.domain,
    sourceContract: toBytes32(gateway.wallet),
    destinationContract: toBytes32(gateway.minter),
    sourceToken: toBytes32(network.tokens.USDC),
    destinationToken: toBytes32(target.usdc),
    sourceDepositor: toBytes32(payout.depositor),
    destinationRecipient: toBytes32(payout.recipient),
    sourceSigner: toBytes32(payout.signer),
    destinationCaller: toBytes32(ZERO_ADDRESS),
    value: toUnits(payout.amount).toString(),
    salt: payout.salt,
    hookData: "0x",
  };
}

export function burnIntent(network: NetworkProfile, input: GatewayPayout & { maxFee: bigint; maxBlockHeight: string }): BurnIntent {
  return { maxBlockHeight: input.maxBlockHeight, maxFee: input.maxFee.toString(), spec: transferSpec(network, input) };
}

const EIP712_TYPES = {
  EIP712Domain: [
    { name: "name", type: "string" },
    { name: "version", type: "string" },
  ],
  TransferSpec: [
    { name: "version", type: "uint32" },
    { name: "sourceDomain", type: "uint32" },
    { name: "destinationDomain", type: "uint32" },
    { name: "sourceContract", type: "bytes32" },
    { name: "destinationContract", type: "bytes32" },
    { name: "sourceToken", type: "bytes32" },
    { name: "destinationToken", type: "bytes32" },
    { name: "sourceDepositor", type: "bytes32" },
    { name: "destinationRecipient", type: "bytes32" },
    { name: "sourceSigner", type: "bytes32" },
    { name: "destinationCaller", type: "bytes32" },
    { name: "value", type: "uint256" },
    { name: "salt", type: "bytes32" },
    { name: "hookData", type: "bytes" },
  ],
  BurnIntent: [
    { name: "maxBlockHeight", type: "uint256" },
    { name: "maxFee", type: "uint256" },
    { name: "spec", type: "TransferSpec" },
  ],
};

/** The typed data the Gateway signer signs, through Circle's `signTypedData`. */
export function burnIntentTypedData(intent: BurnIntent) {
  return { types: EIP712_TYPES, domain: { name: "GatewayWallet", version: "1" }, primaryType: "BurnIntent" as const, message: intent };
}

async function call(what: string, url: string, init: RequestInit, fetcher: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: AbortSignal.timeout(GATEWAY_DEADLINE_MS), cache: "no-store" });
  } catch (error) {
    throw new GatewayError(`Gateway did not answer the ${what}`, undefined, connectionNeverMade(error));
  }
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  if (!response.ok) {
    const said = typeof body?.message === "string" ? `: ${body.message.slice(0, 200)}` : "";
    throw new GatewayError(`Gateway answered ${response.status} to the ${what}${said}`, response.status);
  }
  return body;
}

const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/**
 * What a forwarded payout costs, and the `maxFee` and `maxBlockHeight` to
 * sign it with: Gateway's estimate covers its base fee and the Forwarding
 * Service's fee for minting on the payee's chain.
 */
export async function estimateGateway(network: NetworkProfile, payout: GatewayPayout, options: { fetch?: typeof fetch } = {}): Promise<{ maxFee: bigint; maxBlockHeight: string; feeUsdc: number }> {
  const answer = (await call("fee estimate", `${gatewayOf(network).api}/estimate?enableForwarder=true`, post([{ spec: transferSpec(network, payout) }]), options.fetch ?? fetch)) as {
    body?: Array<{ burnIntent?: { maxFee?: string; maxBlockHeight?: string } }>;
    fees?: { total?: string };
  } | null;
  const estimated = answer?.body?.[0]?.burnIntent;
  const total = Number(answer?.fees?.total);
  if (!estimated?.maxFee || !estimated.maxBlockHeight || !Number.isFinite(total) || total < 0) {
    throw new GatewayError("Gateway's fee estimate had no fee");
  }
  return { maxFee: BigInt(estimated.maxFee), maxBlockHeight: estimated.maxBlockHeight, feeUsdc: total };
}

/** The depositor's unified Gateway balance in USDC, over every domain Gateway answers for. */
export async function gatewayBalance(network: NetworkProfile, depositor: string, options: { fetch?: typeof fetch } = {}): Promise<number> {
  const answer = (await call("balance read", `${gatewayOf(network).api}/balances`, post({ token: "USDC", sources: [{ domain: sourceDomain(network), depositor }] }), options.fetch ?? fetch)) as {
    balances?: Array<{ balance?: string }>;
  } | null;
  const total = (answer?.balances ?? []).reduce((sum, row) => sum + (Number(row.balance) || 0), 0);
  return Math.round(total * 1_000_000) / 1_000_000;
}

/** Sends a signed burn intent, with forwarding: Circle mints on the payee's chain. Returns the transfer's id. */
/**
 * Sends the signed transfer to Gateway and returns its id. When Gateway never says what became of it — no answer, a
 * 5xx, or an answer with no id — the error says it may or may not have been accepted (payment safety R1): GatewayWallet
 * may hold it, and the same intent sent again is spent once. A refusal (4xx) keeps Gateway's own words.
 */
export async function submitGatewayTransfer(network: NetworkProfile, intent: BurnIntent, signature: string, options: { fetch?: typeof fetch } = {}): Promise<string> {
  const api = gatewayOf(network).api;
  let answer: { transferId?: unknown } | null;
  try {
    answer = (await call("transfer", `${api}/transfer?enableForwarder=true`, post([{ burnIntent: intent, signature }]), options.fetch ?? fetch)) as { transferId?: unknown } | null;
  } catch (error) {
    if (error instanceof GatewayError && (error.neverSent || (error.status !== undefined && error.status < 500))) throw error;
    throw new GatewayError(`${(error as Error).message}; it ${MAY_HAVE_BEEN_ACCEPTED}`);
  }
  if (typeof answer?.transferId !== "string" || !answer.transferId) throw new GatewayError(`Gateway answered the transfer with no transfer id; it ${MAY_HAVE_BEEN_ACCEPTED}`);
  return answer.transferId;
}

export interface GatewayTransferStatus {
  status: "pending" | "confirmed" | "failed";
  /**
   * Gateway's own word for the transfer. `failed` and `expired` are both a failed payout, but only
   * an expired attestation can never be minted; a failed one still can (review I2).
   */
  state: "pending" | "confirmed" | "finalized" | "failed" | "expired";
  /** The mint on the payee's chain, once confirmed. */
  mintTxHash: string | null;
  failureReason: string | null;
  /** The payee's chain, from the transfer's destination domain; null when Gateway did not say. */
  destinationChain: string | null;
}

/** A transfer's state, read again: it sends nothing. */
export async function gatewayTransferStatus(network: NetworkProfile, transferId: string, options: { fetch?: typeof fetch } = {}): Promise<GatewayTransferStatus> {
  const answer = (await call("status read", `${gatewayOf(network).api}/transfer/${encodeURIComponent(transferId)}`, { method: "GET" }, options.fetch ?? fetch)) as {
    status?: string;
    destinationDomain?: number;
    transactionHash?: string;
    forwardingDetails?: { failureReason?: string };
  } | null;
  const own = homeChain(network.id).id;
  const destinationChain = chainsOn(network.id).find((chain) => chain.domain === answer?.destinationDomain && chain.id !== own)?.id ?? null;
  const status = answer?.status;
  if (status === "confirmed" || status === "finalized") {
    return { status: "confirmed", state: status, mintTxHash: typeof answer?.transactionHash === "string" ? answer.transactionHash : null, failureReason: null, destinationChain };
  }
  if (status === "failed") return { status: "failed", state: "failed", mintTxHash: null, failureReason: answer?.forwardingDetails?.failureReason ?? "Gateway reported the transfer failed", destinationChain };
  if (status === "expired") return { status: "failed", state: "expired", mintTxHash: null, failureReason: "Gateway's attestation expired before the mint", destinationChain };
  return { status: "pending", state: "pending", mintTxHash: null, failureReason: null, destinationChain };
}
