import { encodeFunctionData, erc20Abi, parseAbi } from "viem";
import { erc20Allowance, erc20Balance, nativeBalance, waitForReceipt, walletErrorMessage, walletErrorText, type Eip1193Provider } from "./browser-wallet";
import { CCTP_FORWARD_HOOK, FAST_FINALITY, fastForwardedRoute, irisMessagesFor, mintIn, toBytes32, ZERO_BYTES32 } from "./circle/cctp-forward";
import { FeatureOffError, type InboundSource, type NetworkProfile } from "./network";
import type { SentStore } from "./treasury/sent-transaction";

/**
 * Add USDC from another chain (docs/superpowers/specs/2026-10-08-add-usdc-from-another-chain-design.md): a person's
 * browser wallet burns USDC it holds on another chain through CCTP V2 with the forwarding hook, and Circle's Forwarding
 * Service mints it on Arc to the workspace's wallet, which needs no gas for it. It all runs in the browser: Vestiarion's
 * server takes no part, and only the burn's hash, public on its chain, is kept.
 */

export class InboundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboundError";
  }
}

/** What a transfer costs and brings, in USDC base units: Circle's fee is at most `maxFeeUnits`. */
export interface InboundQuote {
  amountUnits: bigint;
  maxFeeUnits: bigint;
  /** What arrives at least: the amount less the most the fee can be. */
  arrivesUnits: bigint;
}

/** A transfer sent and not yet seen minted, kept in the browser (B5). */
export interface PendingInbound {
  sourceId: string;
  burnTxHash: string;
  amountUnits: string;
  sentAt: string;
}

const IRIS_DEADLINE_MS = 10_000;
const UNITS = BigInt(1_000_000);
/** Basis points in thousandths, so a fee such as 0.325 bp stays whole: 1 milli-bp is 1/10,000,000 of the amount. */
const MILLI_BPS = BigInt(10_000_000);
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEPOSIT_FOR_BURN_WITH_HOOK = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

/** The chains USDC comes from into this network; none where it cannot (B1). */
export function inboundSources(profile: NetworkProfile): readonly InboundSource[] {
  return profile.inbound?.sources ?? [];
}

function inboundOf(profile: NetworkProfile): NonNullable<NetworkProfile["inbound"]> {
  if (!profile.inbound) throw new FeatureOffError("Adding USDC from another chain", profile);
  return profile.inbound;
}

/** One of the network's sources, by App Kit's name for it. */
export function inboundSource(profile: NetworkProfile, id: string): InboundSource {
  const source = inboundOf(profile).sources.find((entry) => entry.id === id);
  if (!source) throw new InboundError(`${id} is not a chain USDC comes from into ${profile.label}.`);
  return source;
}

/**
 * USDC a person typed, in base units: above 0, with a point for decimals and at most 6 of them (B4). A comma is never read:
 * half the world writes "12,50" for twelve and a half, and it must not become 1250 USDC (review M1).
 */
export function usdcUnits(text: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());
  if (!match) return null;
  const units = BigInt(match[1]) * UNITS + BigInt((match[2] ?? "").padEnd(6, "0"));
  return units > BigInt(0) ? units : null;
}

/** USDC as copy says it: at least 2 decimals, none past them that are zeros. */
export function formatUsdc(units: bigint): string {
  const whole = units / UNITS;
  const fraction = (units % UNITS).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}

/**
 * Circle's fee for bringing `amountUnits` from `source`, read from Iris now (B2): the forwarding fee's high estimate plus
 * the fast transfer's minimum fee, rounded up. It is the burn's `maxFee`, so what arrives is at least the amount less it.
 */
export async function inboundQuote(profile: NetworkProfile, source: InboundSource, amountUnits: bigint, options: { fetch?: typeof fetch } = {}): Promise<InboundQuote> {
  const inbound = inboundOf(profile);
  let rows: unknown;
  try {
    const response = await (options.fetch ?? fetch)(`${inbound.iris}/v2/burn/USDC/fees/${source.domain}/${inbound.domain}?forward=true`, {
      signal: AbortSignal.timeout(IRIS_DEADLINE_MS),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Iris answered ${response.status}`);
    rows = await response.json();
  } catch {
    throw new InboundError(`Circle did not answer for the fee from ${source.label}. Try again in a moment.`);
  }
  const route = fastForwardedRoute(rows);
  if (!route) throw new InboundError(`Circle offers no fast transfer from ${source.label} to ${profile.label} just now. Try again later, or from another chain.`);
  const milliBps = BigInt(Math.round(route.bps * 1000));
  const protocolUnits = (amountUnits * milliBps + MILLI_BPS - BigInt(1)) / MILLI_BPS;
  const maxFeeUnits = route.forwardUnits + protocolUnits;
  if (amountUnits <= maxFeeUnits) throw new InboundError(`Send more than Circle's fee, at most ${formatUsdc(maxFeeUnits)} USDC.`);
  return { amountUnits, maxFeeUnits, arrivesUnits: amountUnits - maxFeeUnits };
}

/** The wallet's two transactions on the source chain (B3): approve TokenMessengerV2, then burn with the forwarding hook. */
export function inboundCalls(input: { profile: NetworkProfile; source: InboundSource; recipient: string; amountUnits: bigint; maxFeeUnits: bigint }): {
  approve: { to: string; data: `0x${string}` };
  burn: { to: string; data: `0x${string}` };
} {
  const inbound = inboundOf(input.profile);
  if (!ADDRESS.test(input.recipient)) throw new InboundError(`${input.recipient} is not an address on ${input.profile.label}.`);
  if (input.amountUnits <= input.maxFeeUnits) throw new InboundError(`Send more than Circle's fee, at most ${formatUsdc(input.maxFeeUnits)} USDC.`);
  const { source } = input;
  return {
    approve: {
      to: source.usdc,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [source.tokenMessenger as `0x${string}`, input.amountUnits] }),
    },
    burn: {
      to: source.tokenMessenger,
      data: encodeFunctionData({
        abi: DEPOSIT_FOR_BURN_WITH_HOOK,
        functionName: "depositForBurnWithHook",
        args: [
          input.amountUnits,
          inbound.domain,
          toBytes32(input.recipient) as `0x${string}`,
          source.usdc as `0x${string}`,
          ZERO_BYTES32 as `0x${string}`,
          input.maxFeeUnits,
          FAST_FINALITY,
          CCTP_FORWARD_HOOK,
        ],
      }),
    },
  };
}

/** Where a burn stands at Iris: minted on Arc by the Forwarding Service, or seen and not minted yet. */
export type InboundArrival = { state: "minted"; mintTxHash: string } | { state: "seen" };

/**
 * The mint Circle's Forwarding Service submitted on Arc for a burn on `source` (B5), or that Circle has seen the burn and
 * not minted it yet (review I2): a burn it has seen is not lost, and is never offered to be forgotten. Null while Iris
 * knows no message for it, or cannot say.
 */
export async function inboundArrival(profile: NetworkProfile, source: InboundSource, burnTxHash: string, options: { fetch?: typeof fetch } = {}): Promise<InboundArrival | null> {
  const messages = await irisMessagesFor(inboundOf(profile).iris, source.domain, burnTxHash, options);
  if (!messages || messages.length === 0) return null;
  const minted = mintIn(messages);
  return minted ? { state: "minted", mintTxHash: minted } : { state: "seen" };
}

/** How long a reviewed fee stands before it is asked for again (review I3): Circle asks for it just before a transfer. */
export const QUOTE_FRESH_MS = 60_000;

/**
 * The fee again just before sending, when the review is more than a minute old (review I3). A higher fee is returned to
 * be shown before anything is sent; a lower one changes nothing, as the reviewed `maxFee` still covers it.
 */
export async function freshQuote(input: {
  profile: NetworkProfile;
  source: InboundSource;
  quote: InboundQuote;
  quotedAt: number;
  now: number;
  fetch?: typeof fetch;
}): Promise<{ quote: InboundQuote; rose: boolean }> {
  if (input.now - input.quotedAt <= QUOTE_FRESH_MS) return { quote: input.quote, rose: false };
  const next = await inboundQuote(input.profile, input.source, input.quote.amountUnits, { fetch: input.fetch });
  return next.maxFeeUnits > input.quote.maxFeeUnits ? { quote: next, rose: true } : { quote: input.quote, rose: false };
}

const key = (profile: NetworkProfile, recipient: string) => `vestiarion.inbound.${profile.id}.${recipient.toLowerCase()}`;

/** Keeps a transfer until its mint is seen; a browser that refuses storage keeps nothing, and the page still waits. */
export function rememberInbound(store: SentStore | null, profile: NetworkProfile, recipient: string, pending: PendingInbound): void {
  try {
    store?.setItem(key(profile, recipient), JSON.stringify(pending));
  } catch {
    // A private window or full storage: only a reload loses it.
  }
}

/** The transfer kept for this recipient on this network, if what is kept is one. */
export function pendingInbound(store: SentStore | null, profile: NetworkProfile, recipient: string): PendingInbound | null {
  try {
    const raw = store?.getItem(key(profile, recipient)) ?? null;
    if (raw === null) return null;
    const value = JSON.parse(raw) as Partial<PendingInbound>;
    const valid =
      typeof value.sourceId === "string" &&
      typeof value.burnTxHash === "string" &&
      HASH.test(value.burnTxHash) &&
      typeof value.amountUnits === "string" &&
      /^\d+$/.test(value.amountUnits) &&
      typeof value.sentAt === "string" &&
      !Number.isNaN(Date.parse(value.sentAt));
    return valid ? { sourceId: value.sourceId!, burnTxHash: value.burnTxHash!, amountUnits: value.amountUnits!, sentAt: value.sentAt! } : null;
  } catch {
    return null;
  }
}

export function forgetInbound(store: SentStore | null, profile: NetworkProfile, recipient: string): void {
  try {
    store?.removeItem(key(profile, recipient));
  } catch {
    // Nothing to forget where nothing could be kept.
  }
}

/**
 * What the page checks before the wallet asks anything (B2, B4): the wallet's USDC on the source chain, which must cover
 * the amount, then Circle's fee. A wallet that did not switch to the source chain is said so, before anything is read
 * (review M8).
 */
export async function reviewInbound(input: {
  provider: Eip1193Provider;
  from: string;
  profile: NetworkProfile;
  source: InboundSource;
  amountUnits: bigint;
  fetch?: typeof fetch;
}): Promise<{ balanceUnits: bigint; quote: InboundQuote }> {
  if (!(await onSource(input.provider, input.source))) {
    throw new InboundError(`Your wallet is not on ${input.source.label} yet. Choose Review again: it switches to ${input.source.label} first.`);
  }
  // Both transactions pay the chain's own gas: a wallet with none would only be refused by the chain (2026-10-08).
  const { label, nativeSymbol } = input.source;
  if ((await nativeBalance(input.provider, input.from)) === BigInt(0)) {
    throw new InboundError(`Your wallet holds no ${nativeSymbol} on ${label} to pay its gas. Add a little ${nativeSymbol} there, then choose Review again.`);
  }
  const balanceUnits = await erc20Balance(input.provider, input.source.usdc, input.from);
  if (balanceUnits < input.amountUnits) {
    throw new InboundError(`Your wallet holds ${formatUsdc(balanceUnits)} USDC on ${input.source.label}: send at most that.`);
  }
  const quote = await inboundQuote(input.profile, input.source, input.amountUnits, { fetch: input.fetch });
  return { balanceUnits, quote };
}

/**
 * What a failure says on this page (2026-10-08): this page's own refusals as they are; a wallet that cannot pay the gas,
 * in the source chain's currency; any other wallet error in its own words.
 */
export function inboundWalletError(error: unknown, source: InboundSource | null): string {
  if (error instanceof InboundError) return error.message;
  const text = walletErrorText(error);
  if (text && /insufficient funds/i.test(text)) {
    return source
      ? `Your wallet does not hold enough ${source.nativeSymbol} on ${source.label} for the gas. Add a little ${source.nativeSymbol} there, then send again.`
      : "Your wallet does not hold enough for the gas on that chain. Add a little of its own currency there, then send again.";
  }
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "number") return walletErrorMessage(error);
  return text ?? String(error);
}

/** Whether the wallet is on the source chain now, as it answers itself. */
async function onSource(provider: Eip1193Provider, source: InboundSource): Promise<boolean> {
  const current = await provider.request({ method: "eth_chainId" });
  return typeof current === "string" && BigInt(current) === BigInt(source.chainId);
}

const movedAway = (source: InboundSource) => new InboundError(`Your wallet is on another chain now. Choose Send again: it switches to ${source.label} first.`);

/** A receipt, where a read that fails, such as a rate-limited RPC, counts as not confirmed yet rather than a refusal (review M2). */
async function receiptOf(provider: Eip1193Provider, hash: string, wait: { tries: number; waitMs: number; sleep?: (ms: number) => Promise<void> }) {
  try {
    return await waitForReceipt(provider, hash, wait);
  } catch {
    return "pending" as const;
  }
}

async function sendOnSource(provider: Eip1193Provider, from: string, source: InboundSource, tx: { to: string; data: string }): Promise<string> {
  if (!(await onSource(provider, source))) throw movedAway(source);
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [{ from, to: tx.to, data: tx.data, value: "0x0", chainId: `0x${source.chainId.toString(16)}` }],
  });
  if (typeof hash !== "string") throw new InboundError("The wallet gave no transaction hash.");
  return hash;
}

/**
 * Sends the transfer from the wallet (B3, B5): the approval only when the allowance falls short, confirmed on the source
 * chain before the burn is asked for; then the burn, kept in the browser as soon as the wallet answers with its hash. A
 * burn the source chain refused is forgotten; one it has not confirmed yet stays kept, and Iris is asked about it.
 */
export async function sendInbound(input: {
  provider: Eip1193Provider;
  from: string;
  profile: NetworkProfile;
  source: InboundSource;
  recipient: string;
  quote: InboundQuote;
  store: SentStore | null;
  say: (text: string) => void;
  tries?: number;
  waitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}): Promise<PendingInbound> {
  const { provider, from, profile, source, recipient, quote, store, say } = input;
  const wait = { tries: input.tries ?? 60, waitMs: input.waitMs ?? 3_000, sleep: input.sleep };
  const calls = inboundCalls({ profile, source, recipient, amountUnits: quote.amountUnits, maxFeeUnits: quote.maxFeeUnits });
  if (!(await onSource(provider, source))) throw movedAway(source);
  if ((await erc20Allowance(provider, source.usdc, from, source.tokenMessenger)) < quote.amountUnits) {
    say("Confirm the approval in your wallet.");
    const approval = await sendOnSource(provider, from, source, calls.approve);
    say(`Waiting for ${source.label} to confirm the approval…`);
    const approved = await receiptOf(provider, approval, wait);
    if (approved === "reverted") throw new InboundError(`${source.label} refused the approval. Your USDC did not leave your wallet.`);
    if (approved === "pending") {
      throw new InboundError(`${source.label} has not confirmed the approval yet. Choose Send again in a minute: once it is confirmed, it is not asked for again.`);
    }
  }
  say("Confirm the transfer in your wallet.");
  const burnTxHash = await sendOnSource(provider, from, source, calls.burn);
  const pending: PendingInbound = { sourceId: source.id, burnTxHash, amountUnits: quote.amountUnits.toString(), sentAt: (input.now ?? (() => new Date()))().toISOString() };
  rememberInbound(store, profile, recipient, pending);
  say(`Waiting for ${source.label} to confirm it…`);
  if ((await receiptOf(provider, burnTxHash, wait)) === "reverted") {
    forgetInbound(store, profile, recipient);
    throw new InboundError(`${source.label} refused the transfer. Your USDC did not leave your wallet.`);
  }
  return pending;
}
