import * as kit from "@circle-fin/app-kit/chains";
import { decodeFunctionData, erc20Abi, getAddress, parseAbi } from "viem";
import { describe, expect, it, vi } from "vitest";
import { CCTP_FORWARD_HOOK, FAST_FINALITY, toBytes32 } from "@/lib/circle/cctp-forward";
import {
  forgetInbound,
  formatUsdc,
  freshQuote,
  inboundArrival,
  inboundCalls,
  InboundError,
  inboundQuote,
  inboundSource,
  inboundWalletError,
  inboundSources,
  pendingInbound,
  rememberInbound,
  reviewInbound,
  sendInbound,
  usdcUnits,
  type PendingInbound,
} from "@/lib/inbound-usdc";
import type { Eip1193Provider } from "@/lib/browser-wallet";
import { ARC_MAINNET, ARC_TESTNET, FeatureOffError, type NetworkProfile } from "@/lib/network";

/**
 * Add USDC from another chain (docs/superpowers/specs/2026-10-08-add-usdc-from-another-chain-design.md B1–B5): a
 * browser wallet burns USDC on another chain through CCTP V2 with the forwarding hook, and Circle's Forwarding Service
 * mints it on Arc to the workspace's wallet. Everything here runs in the browser; Iris and the wallet are stand-ins.
 */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ZERO32 = `0x${"0".repeat(64)}`;
const RECIPIENT = "0x49A0e31153562a81cdc79ACF6D138B1965F71631";
const FROM = "0x" + "b0".repeat(20);
const BURN = `0x${"bb".repeat(32)}`;
/** Iris's fee rows for Base to Arc mainnet, as it answered on 2026-10-08. */
const BASE_TO_ARC = [
  { finalityThreshold: 1000, minimumFee: 0.325, forwardFee: { low: 17875, med: 18375, high: 18875 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 17875, med: 18375, high: 18875 } },
];
const base = () => inboundSource(ARC_MAINNET, "Base");

describe("where USDC comes from (B1)", () => {
  type KitChain = { chain: string; chainId: number; usdcAddress: string; cctp: { domain: number; contracts: { v2: { tokenMessenger: string } } } };
  const KIT = (Object.values(kit) as unknown[]).filter(
    (value): value is KitChain => typeof value === "object" && value !== null && "chainId" in value && "cctp" in value
  );

  it.each([
    [ARC_MAINNET, ["Base", "Ethereum", "Arbitrum", "Optimism", "Polygon", "Avalanche", "Linea", "Unichain", "World_Chain"]],
    [ARC_TESTNET, ["Base_Sepolia", "Ethereum_Sepolia", "Arbitrum_Sepolia", "Optimism_Sepolia", "Polygon_Amoy_Testnet", "Avalanche_Fuji"]],
  ])("lists %s's sources, each with Circle's own chain id, domain, USDC and TokenMessengerV2", (profile, ids) => {
    expect(inboundSources(profile).map((source) => source.id)).toEqual(ids);
    for (const source of inboundSources(profile)) {
      const circle = KIT.find((chain) => chain.chain === source.id);
      expect(circle, source.id).toBeDefined();
      expect(source.chainId, source.id).toBe(circle!.chainId);
      expect(source.domain, source.id).toBe(circle!.cctp.domain);
      expect(source.usdc, source.id).toBe(getAddress(circle!.usdcAddress));
      expect(source.tokenMessenger, source.id).toBe(getAddress(circle!.cctp.contracts.v2.tokenMessenger));
      expect(source.explorerTx).toMatch(/^https:\/\/.+\/tx\/$/);
      expect(source.nativeSymbol).toMatch(/^[A-Z]+$/);
    }
  });

  it("brings it to Arc's own CCTP domain, through Iris for the network", () => {
    const arc = KIT.find((chain) => chain.chain === "Arc")!;
    expect(ARC_MAINNET.inbound).toMatchObject({ domain: arc.cctp.domain, iris: "https://iris-api.circle.com" });
    expect(ARC_TESTNET.inbound).toMatchObject({ domain: arc.cctp.domain, iris: "https://iris-api-sandbox.circle.com" });
  });

  it("refuses a chain the network does not list, and a network with none", () => {
    expect(() => inboundSource(ARC_MAINNET, "Base_Sepolia")).toThrow(InboundError);
    const without: NetworkProfile = { ...ARC_MAINNET, inbound: null };
    expect(inboundSources(without)).toEqual([]);
    expect(() => inboundSource(without, "Base")).toThrow(FeatureOffError);
  });
});

describe("amounts (B4)", () => {
  it("reads USDC with up to 6 decimals, above 0, and a point for decimals", () => {
    expect(usdcUnits("10")).toBe(BigInt(10_000_000));
    expect(usdcUnits(" 1.234567 ")).toBe(BigInt(1_234_567));
    expect(usdcUnits("0.5")).toBe(BigInt(500_000));
    expect(usdcUnits("1000.25")).toBe(BigInt(1_000_250_000));
  });

  it("refuses any comma, which half the world writes for decimals: 12,50 is never 1250 USDC (review M1)", () => {
    for (const refused of ["12,50", "1,2", "1,000", "1,000.25"]) expect(usdcUnits(refused), refused).toBeNull();
    for (const refused of ["", "0", "0.0000001", "-1", "abc", "1e3", "1.2.3", "."]) expect(usdcUnits(refused), refused).toBeNull();
  });

  it("says USDC with at least 2 decimals and no trailing zeros past them", () => {
    expect(formatUsdc(BigInt(9_980_800))).toBe("9.9808");
    expect(formatUsdc(BigInt(10_000_000))).toBe("10.00");
    expect(formatUsdc(BigInt(18_919))).toBe("0.018919");
    expect(formatUsdc(BigInt(1_000_250_000))).toBe("1000.25");
  });
});

describe("the fee (B2)", () => {
  it("is Iris's forwarding fee, high estimate, plus the fast minimum fee rounded up: the burn's maxFee", async () => {
    const fetch = vi.fn(async () => json(BASE_TO_ARC));
    const quote = await inboundQuote(ARC_MAINNET, base(), BigInt(10_000_000), { fetch });
    expect(fetch).toHaveBeenCalledWith("https://iris-api.circle.com/v2/burn/USDC/fees/6/26?forward=true", expect.objectContaining({ cache: "no-store" }));
    expect(quote).toEqual({ amountUnits: BigInt(10_000_000), maxFeeUnits: BigInt(18_875 + 325), arrivesUnits: BigInt(10_000_000 - 19_200) });
    // 1.234567 USDC at 0.35 basis points is 43.2 units of fee: 44.
    const arbitrum = inboundSource(ARC_MAINNET, "Arbitrum");
    const odd = await inboundQuote(ARC_MAINNET, arbitrum, BigInt(1_234_567), { fetch: vi.fn(async () => json([{ finalityThreshold: 1000, minimumFee: 0.35, forwardFee: { high: 18875 } }])) });
    expect(odd.maxFeeUnits).toBe(BigInt(18_875 + 44));
  });

  it("refuses when Iris does not answer, lists no fast forwarded route, or the amount does not cover the fee", async () => {
    await expect(inboundQuote(ARC_MAINNET, base(), BigInt(10_000_000), { fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")) })).rejects.toThrow(
      "Circle did not answer for the fee from Base. Try again in a moment."
    );
    await expect(inboundQuote(ARC_MAINNET, base(), BigInt(10_000_000), { fetch: vi.fn(async () => json({ message: "down" }, 503)) })).rejects.toBeInstanceOf(InboundError);
    await expect(inboundQuote(ARC_MAINNET, base(), BigInt(10_000_000), { fetch: vi.fn(async () => json([BASE_TO_ARC[1]])) })).rejects.toThrow(
      "Circle offers no fast transfer from Base to Arc mainnet just now. Try again later, or from another chain."
    );
    // 0.018876 USDC pays 18,875 units of forwarding and 1 of the fast fee: nothing would arrive.
    await expect(inboundQuote(ARC_MAINNET, base(), BigInt(18_876), { fetch: vi.fn(async () => json(BASE_TO_ARC)) })).rejects.toThrow(
      "Send more than Circle's fee, at most 0.018876 USDC."
    );
  });
});

describe("the fee again before sending (review I3)", () => {
  const QUOTED = { amountUnits: BigInt(10_000_000), maxFeeUnits: BigInt(19_200), arrivesUnits: BigInt(9_980_800) };

  it("is not asked for again within a minute of the review", async () => {
    const fetch = vi.fn();
    expect(await freshQuote({ profile: ARC_MAINNET, source: base(), quote: QUOTED, quotedAt: 1_000, now: 61_000, fetch })).toEqual({ quote: QUOTED, rose: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is asked for again after a minute: a fee that rose is shown before anything is sent, a lower one changes nothing", async () => {
    const higher = [{ finalityThreshold: 1000, minimumFee: 0.325, forwardFee: { high: 25_000 } }];
    const rose = await freshQuote({ profile: ARC_MAINNET, source: base(), quote: QUOTED, quotedAt: 1_000, now: 62_000, fetch: vi.fn(async () => json(higher)) });
    expect(rose).toEqual({ quote: { amountUnits: BigInt(10_000_000), maxFeeUnits: BigInt(25_325), arrivesUnits: BigInt(9_974_675) }, rose: true });
    const lower = [{ finalityThreshold: 1000, minimumFee: 0.325, forwardFee: { high: 16_000 } }];
    expect(await freshQuote({ profile: ARC_MAINNET, source: base(), quote: QUOTED, quotedAt: 1_000, now: 62_000, fetch: vi.fn(async () => json(lower)) })).toEqual({ quote: QUOTED, rose: false });
  });
});

describe("the two transactions (B3)", () => {
  const DEPOSIT = parseAbi([
    "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
  ]);

  it("approves TokenMessengerV2 for the amount, then burns it to the recipient on Arc with the forwarding hook", () => {
    const source = base();
    const { approve, burn } = inboundCalls({ profile: ARC_MAINNET, source, recipient: RECIPIENT, amountUnits: BigInt(10_000_000), maxFeeUnits: BigInt(19_200) });
    expect(approve.to).toBe(source.usdc);
    expect(decodeFunctionData({ abi: erc20Abi, data: approve.data })).toEqual({ functionName: "approve", args: [source.tokenMessenger, BigInt(10_000_000)] });
    expect(burn.to).toBe(source.tokenMessenger);
    expect(decodeFunctionData({ abi: DEPOSIT, data: burn.data }).args).toEqual([
      BigInt(10_000_000),
      26,
      toBytes32(RECIPIENT),
      source.usdc,
      ZERO32,
      BigInt(19_200),
      FAST_FINALITY,
      CCTP_FORWARD_HOOK,
    ]);
  });

  it("refuses a recipient that is not an address, and an amount the fee would take whole", () => {
    expect(() => inboundCalls({ profile: ARC_MAINNET, source: base(), recipient: "0x49A0", amountUnits: BigInt(10), maxFeeUnits: BigInt(1) })).toThrow(InboundError);
    expect(() => inboundCalls({ profile: ARC_MAINNET, source: base(), recipient: RECIPIENT, amountUnits: BigInt(5), maxFeeUnits: BigInt(5) })).toThrow(InboundError);
  });
});

describe("the mint (B5)", () => {
  it("is the transaction Circle's Forwarding Service submitted on Arc, from Iris's messages for the burn", async () => {
    const fetch = vi.fn(async () => json({ messages: [{ status: "complete", forwardState: "CONFIRMED", forwardTxHash: "0xmint" }] }));
    expect(await inboundArrival(ARC_MAINNET, base(), BURN, { fetch })).toEqual({ state: "minted", mintTxHash: "0xmint" });
    expect(fetch).toHaveBeenCalledWith(`https://iris-api.circle.com/v2/messages/6?transactionHash=${BURN}`, expect.anything());
  });

  it("tells a burn Circle has seen and not minted from one it has never seen (review I2)", async () => {
    expect(await inboundArrival(ARC_MAINNET, base(), BURN, { fetch: vi.fn(async () => json({ messages: [{ status: "pending_confirmations" }] })) })).toEqual({ state: "seen" });
    expect(await inboundArrival(ARC_MAINNET, base(), BURN, { fetch: vi.fn(async () => json({ messages: [{ status: "complete", forwardState: "PENDING" }] })) })).toEqual({ state: "seen" });
    expect(await inboundArrival(ARC_MAINNET, base(), BURN, { fetch: vi.fn(async () => json({ messages: [] })) })).toBeNull();
    expect(await inboundArrival(ARC_MAINNET, base(), BURN, { fetch: vi.fn(async () => json({ error: "Message hash not found" }, 404)) })).toBeNull();
    expect(await inboundArrival(ARC_MAINNET, base(), BURN, { fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")) })).toBeNull();
  });
});

function memoryStore() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
}

describe("a transfer on its way (B5)", () => {
  const PENDING: PendingInbound = { sourceId: "Base", burnTxHash: BURN, amountUnits: "10000000", sentAt: "2026-10-08T10:00:00.000Z" };

  it("is kept per network and recipient until it is forgotten", () => {
    const store = memoryStore();
    rememberInbound(store, ARC_MAINNET, RECIPIENT, PENDING);
    expect(pendingInbound(store, ARC_MAINNET, RECIPIENT.toLowerCase())).toEqual(PENDING);
    expect(pendingInbound(store, ARC_TESTNET, RECIPIENT)).toBeNull();
    expect(pendingInbound(store, ARC_MAINNET, FROM)).toBeNull();
    forgetInbound(store, ARC_MAINNET, RECIPIENT);
    expect(pendingInbound(store, ARC_MAINNET, RECIPIENT)).toBeNull();
  });

  it("reads nothing kept that is not one, and keeps nothing where the browser refuses storage", () => {
    const store = memoryStore();
    rememberInbound(store, ARC_MAINNET, RECIPIENT, PENDING);
    const [key] = [...store.items.keys()];
    store.setItem(key, "{not json");
    expect(pendingInbound(store, ARC_MAINNET, RECIPIENT)).toBeNull();
    store.setItem(key, JSON.stringify({ ...PENDING, burnTxHash: "0x12" }));
    expect(pendingInbound(store, ARC_MAINNET, RECIPIENT)).toBeNull();
    const refusing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } };
    expect(() => rememberInbound(refusing, ARC_MAINNET, RECIPIENT, PENDING)).not.toThrow();
    expect(pendingInbound(refusing, ARC_MAINNET, RECIPIENT)).toBeNull();
    expect(pendingInbound(null, ARC_MAINNET, RECIPIENT)).toBeNull();
  });
});

type Request = { method: string; params?: unknown };

/** A browser wallet on Base: its chain, its USDC and allowance, and the receipts its chain gives. */
function wallet(options: { chainId?: number; balance?: bigint; native?: bigint; allowance?: bigint; receipts?: Array<"0x1" | "0x0" | null | "throw"> } = {}) {
  const requests: Request[] = [];
  const sent: Array<{ to: string; data: string }> = [];
  const receipts = [...(options.receipts ?? [])];
  const provider: Eip1193Provider = {
    request: vi.fn(async (request: Request) => {
      requests.push(request);
      switch (request.method) {
        case "eth_chainId":
          return `0x${(options.chainId ?? 8453).toString(16)}`;
        case "eth_getBalance":
          return `0x${(options.native ?? BigInt(10) ** BigInt(15)).toString(16)}`;
        case "eth_call": {
          const [call] = request.params as [{ data: string }];
          const value = call.data.startsWith("0x70a08231") ? options.balance ?? BigInt(0) : options.allowance ?? BigInt(0);
          return `0x${value.toString(16).padStart(64, "0")}`;
        }
        case "eth_sendTransaction": {
          const [tx] = request.params as [{ to: string; data: string }];
          sent.push(tx);
          return `0x${String(sent.length).repeat(64)}`;
        }
        case "eth_getTransactionReceipt": {
          const status = receipts.length > 0 ? receipts.shift() : "0x1";
          if (status === "throw") throw Object.assign(new Error("request limit reached"), { code: -32005 });
          return status === null ? null : { status };
        }
        default:
          throw new Error(`unexpected ${request.method}`);
      }
    }),
  };
  return { provider, requests, sent };
}

const QUOTE = { amountUnits: BigInt(10_000_000), maxFeeUnits: BigInt(19_200), arrivesUnits: BigInt(9_980_800) };
const sendWith = (w: ReturnType<typeof wallet>, store = memoryStore(), say = vi.fn()) =>
  sendInbound({ provider: w.provider, from: FROM, profile: ARC_MAINNET, source: base(), recipient: RECIPIENT, quote: QUOTE, store, say, tries: 3, waitMs: 1, sleep: async () => {}, now: () => new Date("2026-10-08T10:00:00Z") });

describe("checking before the wallet asks (B4)", () => {
  it("reads the wallet's USDC on the source chain and Iris's fee", async () => {
    const w = wallet({ balance: BigInt(25_000_000) });
    const review = await reviewInbound({ provider: w.provider, from: FROM, profile: ARC_MAINNET, source: base(), amountUnits: BigInt(10_000_000), fetch: vi.fn(async () => json(BASE_TO_ARC)) });
    expect(review).toEqual({ balanceUnits: BigInt(25_000_000), quote: QUOTE });
    expect(w.requests.map((request) => request.method)).toEqual(["eth_chainId", "eth_getBalance", "eth_call"]);
    expect(w.requests[1].params).toEqual([FROM, "latest"]);
    expect((w.requests[2].params as [{ to: string }])[0].to).toBe(base().usdc);
  });

  it("reads nothing on a chain other than the source, saying so (review M8)", async () => {
    const w = wallet({ chainId: 1, balance: BigInt(25_000_000) });
    await expect(reviewInbound({ provider: w.provider, from: FROM, profile: ARC_MAINNET, source: base(), amountUnits: BigInt(10_000_000), fetch: vi.fn() })).rejects.toThrow(
      "Your wallet is not on Base yet. Choose Review again: it switches to Base first."
    );
    expect(w.requests.map((request) => request.method)).toEqual(["eth_chainId"]);
  });

  it("refuses a wallet with none of the chain's own currency for gas, before any prompt (2026-10-08)", async () => {
    const w = wallet({ balance: BigInt(3_900_000), native: BigInt(0) });
    const fetch = vi.fn();
    await expect(reviewInbound({ provider: w.provider, from: FROM, profile: ARC_MAINNET, source: base(), amountUnits: BigInt(1_000_000), fetch })).rejects.toThrow(
      "Your wallet holds no ETH on Base to pay its gas. Add a little ETH there, then choose Review again."
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses more than the wallet holds there, before any prompt", async () => {
    const w = wallet({ balance: BigInt(4_500_000) });
    const fetch = vi.fn();
    await expect(reviewInbound({ provider: w.provider, from: FROM, profile: ARC_MAINNET, source: base(), amountUnits: BigInt(10_000_000), fetch })).rejects.toThrow(
      "Your wallet holds 4.50 USDC on Base: send at most that."
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("what a wallet's refusal says (2026-10-08)", () => {
  it("names the chain's own currency when the wallet cannot pay the gas, and reads a plain-object error's message", () => {
    const noGas = { code: -32603, message: "RPC 0x2105 Custom eth_sendRawTransaction: insufficient funds for gas * price + value: have 0 want 1350303222160" };
    expect(inboundWalletError(noGas, base())).toBe("Your wallet does not hold enough ETH on Base for the gas. Add a little ETH there, then send again.");
    expect(inboundWalletError(noGas, null)).toBe("Your wallet does not hold enough for the gas on that chain. Add a little of its own currency there, then send again.");
    expect(inboundWalletError({ code: 4001, message: "User rejected the request." }, base())).toBe("You declined it in your wallet.");
    expect(inboundWalletError({ code: -32000, message: "nonce too low" }, base())).toBe("Your wallet did not send it: nonce too low");
    expect(inboundWalletError(new InboundError("Circle did not answer."), base())).toBe("Circle did not answer.");
    expect(inboundWalletError(new Error("insufficient funds for gas"), base())).toBe("Your wallet does not hold enough ETH on Base for the gas. Add a little ETH there, then send again.");
  });
});

describe("sending (B3, B5)", () => {
  it("approves, waits for the approval on chain, then burns, keeping the burn before its receipt is read", async () => {
    const w = wallet({ allowance: BigInt(0) });
    const store = memoryStore();
    const say = vi.fn();
    const pending = await sendWith(w, store, say);
    expect(w.sent.map((tx) => tx.to)).toEqual([base().usdc, base().tokenMessenger]);
    const methods = w.requests.map((request) => request.method);
    expect(methods.indexOf("eth_getTransactionReceipt")).toBeLessThan(methods.lastIndexOf("eth_sendTransaction"));
    expect(pending).toEqual({ sourceId: "Base", burnTxHash: `0x${"2".repeat(64)}`, amountUnits: "10000000", sentAt: "2026-10-08T10:00:00.000Z" });
    expect(pendingInbound(store, ARC_MAINNET, RECIPIENT)).toEqual(pending);
    expect(say.mock.calls.map(([text]) => text)).toEqual([
      "Confirm the approval in your wallet.",
      "Waiting for Base to confirm the approval…",
      "Confirm the transfer in your wallet.",
      "Waiting for Base to confirm it…",
    ]);
  });

  it("asks for no approval when the allowance covers the amount", async () => {
    const w = wallet({ allowance: BigInt(10_000_000) });
    await sendWith(w);
    expect(w.sent.map((tx) => tx.to)).toEqual([base().tokenMessenger]);
  });

  it("sends nothing when the wallet is on another chain", async () => {
    const w = wallet({ chainId: 1 });
    await expect(sendWith(w)).rejects.toThrow("Your wallet is on another chain now. Choose Send again: it switches to Base first.");
    expect(w.sent).toEqual([]);
  });

  it("stops after a refused approval, and asks again later for one not yet confirmed", async () => {
    const refused = wallet({ receipts: ["0x0"] });
    await expect(sendWith(refused)).rejects.toThrow("Base refused the approval. Your USDC did not leave your wallet.");
    expect(refused.sent).toHaveLength(1);
    const slow = wallet({ receipts: [null, null, null] });
    await expect(sendWith(slow)).rejects.toThrow("Base has not confirmed the approval yet. Choose Send again in a minute: once it is confirmed, it is not asked for again.");
    expect(slow.sent).toHaveLength(1);
  });

  it("never says a failed receipt read refused anything: the approval is asked about again, the burn is kept (review M2)", async () => {
    const approval = wallet({ receipts: ["throw"] });
    const refused = sendWith(approval);
    await expect(refused).rejects.toThrow("Base has not confirmed the approval yet.");
    await expect(refused).rejects.toBeInstanceOf(InboundError);
    const store = memoryStore();
    const pending = await sendWith(wallet({ allowance: BigInt(10_000_000), receipts: ["throw"] }), store);
    expect(pendingInbound(store, ARC_MAINNET, RECIPIENT)).toEqual(pending);
  });

  it("forgets a burn the source chain refused, and keeps one it has not confirmed yet", async () => {
    const store = memoryStore();
    await expect(sendWith(wallet({ allowance: BigInt(10_000_000), receipts: ["0x0"] }), store)).rejects.toThrow("Base refused the transfer. Your USDC did not leave your wallet.");
    expect(pendingInbound(store, ARC_MAINNET, RECIPIENT)).toBeNull();
    const pending = await sendWith(wallet({ allowance: BigInt(10_000_000), receipts: [null, null, null] }), store);
    expect(pendingInbound(store, ARC_MAINNET, RECIPIENT)).toEqual(pending);
  });
});
