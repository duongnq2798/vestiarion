import { concat, encodeFunctionData, erc20Abi, getAddress, getContractAddress, keccak256, maxUint256, stringToHex, type Hex } from "viem";
import { ARC_MAINNET } from "./network";
import { browserReason, passkeySmartAccount, type PasskeySdk, type PasskeyWalletConfig } from "./passkey-wallet";
import type { SendOutcome } from "./passkey-wallet-send";
import type { WalletTreasuryStep } from "./treasury/wallet-treasury";
import { deploymentData, setLimitsData } from "./spending-limit/deployment";

/**
 * A passkey wallet as a workspace's treasury on Arc mainnet (docs/superpowers/specs/2026-10-07-passkey-treasury-
 * design.md): a Circle Smart Account owned by the owner's passkey, set up with one confirmation. Browser-safe: it holds
 * no secret, and what runs only in the browser lives in src/lib/passkey-treasury-sdk.ts.
 */

/** Circle's Modular Wallets client URL, the one the Console gives every client key. */
const CIRCLE_CLIENT_URL = "https://modular-sdk.circle.com/v1/rpc/w3s/buidl";

/**
 * The Circle mainnet client key and client URL (K11), from the build's environment; null without a key. A client key is
 * meant for the browser: its allowed domain is what guards it, and it carries no right to move anyone's money.
 */
export function passkeyTreasuryConfig(
  env: { key: string | undefined; url: string | undefined } = {
    key: process.env.NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_KEY,
    url: process.env.NEXT_PUBLIC_MODULAR_WALLETS_MAINNET_CLIENT_URL,
  }
): PasskeyWalletConfig | null {
  const clientKey = env.key?.trim() ?? "";
  if (!clientKey) return null;
  const clientUrl = (env.url?.trim() || CIRCLE_CLIENT_URL).replace(/\/+$/, "");
  return { clientKey, clientUrl };
}

/**
 * The deterministic deployment proxy, at the same address on Arc mainnet as on most EVM chains (checked 2026-10-07): a
 * call of `salt ++ creation code` deploys the code with CREATE2, so the contract's address follows from the two (K6).
 */
export const DEPLOYMENT_PROXY = "0x4e59b44847b379578588920cA78FbF26c0B4956C" as const;

/** The workspace's own salt for its contract: one workspace, one address for given figures (K6). */
export function spendingLimitSalt(orgId: string): Hex {
  return keccak256(stringToHex(`vestiarion:spending-limit:${orgId}`));
}

/** One call of a user operation: its target, its data and its value in wei. */
export interface SetupCall {
  to: Hex;
  data: Hex;
  value: bigint;
}

const checksummed = (address: string) => getAddress(address.toLowerCase());

/**
 * The figures the contract is deployed with: its address then depends on the wallet and the agent alone, never on the
 * figures, so a second setup reuses it rather than deploying another (final review I3). The owner's own figures are set
 * by `setLimits` in the same user operation.
 */
const DEPLOYED_FIGURE_UNITS = 1n;

/**
 * A passkey wallet's setup as one user operation (K6): the contract deployed through the proxy (left out when it is at
 * its address already), its figures set, its approval on USDC (unlimited, or the cap), and the agent's gas in Arc's
 * native USDC (left out when the agent holds its own already). The server builds it, and the browser builds it again
 * from what it shows the owner before the passkey signs.
 */
export function passkeySetupCalls(input: {
  usdc: string;
  treasury: string;
  agent: string;
  dailyUnits: bigint;
  weeklyUnits: bigint;
  capUnits: bigint | null;
  salt: Hex;
  deployed: boolean;
  agentFunded: boolean;
  gasWei: bigint;
}): { contract: Hex; calls: SetupCall[] } {
  const bytecode = deploymentData({
    usdc: input.usdc,
    treasury: input.treasury,
    agent: input.agent,
    dailyUnits: DEPLOYED_FIGURE_UNITS,
    weeklyUnits: DEPLOYED_FIGURE_UNITS,
  });
  const contract = getContractAddress({ opcode: "CREATE2", from: DEPLOYMENT_PROXY, salt: input.salt, bytecode });
  const calls: SetupCall[] = [];
  if (!input.deployed) calls.push({ to: DEPLOYMENT_PROXY, data: concat([input.salt, bytecode]), value: 0n });
  calls.push({ to: contract, data: setLimitsData(input.dailyUnits, input.weeklyUnits), value: 0n });
  calls.push({
    to: checksummed(input.usdc),
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [contract, input.capUnits ?? maxUint256] }),
    value: 0n,
  });
  if (!input.agentFunded) calls.push({ to: checksummed(input.agent), data: "0x", value: input.gasWei });
  return { contract, calls };
}

/** The refusal when the server's setup is not the browser's own (Review Focus 1). */
export const SETUP_MISMATCH = "The setup Vestiarion sent is not the one this page expected; nothing was signed.";

/**
 * Refuses a setup that differs in anything from the one the browser built itself (K6, Review Focus 1): its contract,
 * the number of calls, or any call's target, data or value. A passkey prompt shows no transaction, so this is where a
 * wrong one is stopped.
 */
export function checkPasskeySetup(
  server: { contract: string; calls: Array<{ to: string; data: string; value: string | bigint }> },
  expected: { contract: string; calls: SetupCall[] }
): void {
  const same =
    server.contract.toLowerCase() === expected.contract.toLowerCase() &&
    server.calls.length === expected.calls.length &&
    server.calls.every((call, index) => {
      const mine = expected.calls[index];
      return call.to.toLowerCase() === mine.to.toLowerCase() && call.data.toLowerCase() === mine.data.toLowerCase() && BigInt(call.value) === mine.value;
    });
  if (!same) throw new Error(SETUP_MISMATCH);
}

/** The part of a passkey the browser keeps for a workspace: public by nature; the private key stays in the authenticator. */
export interface KeptCredential {
  id: string;
  publicKey: Hex;
  rpId?: string;
}

/** The parts of `localStorage` used here, so a test can stand in for it; null where the browser has none. */
export type KeepingStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The browser's own store; none on the server, or where the browser refuses storage. */
export function browserKeepingStore(): KeepingStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Which card leads Go live's choice (K1): a passkey where the browser has no wallet, the wallet where it has one, and
 * both, the wallet first, while the browser is still being asked. Where passkeys cannot work, the wallet.
 */
export function choiceLead(input: { wallets: number | null; passkeys: boolean }): "wallet" | "passkey" | "both-pending" {
  if (!input.passkeys) return "wallet";
  if (input.wallets === null) return "both-pending";
  return input.wallets === 0 ? "passkey" : "wallet";
}

const credentialKey = (orgSlug: string) => `vestiarion.passkey-treasury.${orgSlug}`;
const pendingKey = (orgSlug: string) => `vestiarion.passkey-setup.${orgSlug}`;

function readJson(store: KeepingStore | null, key: string): unknown {
  try {
    const value = store?.getItem(key);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeJson(store: KeepingStore | null, key: string, value: unknown): void {
  try {
    store?.setItem(key, JSON.stringify(value));
  } catch {
    // A private window or full storage: the passkey is asked to log in next time instead.
  }
}

function remove(store: KeepingStore | null, key: string): void {
  try {
    store?.removeItem(key);
  } catch {
    // Nothing to forget where nothing could be kept.
  }
}

/** A passkey's public part, if `value` has one: an id, a hex public key, and its relying party where given. */
function asKept(value: unknown): KeptCredential | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, publicKey, rpId } = value as { id?: unknown; publicKey?: unknown; rpId?: unknown };
  if (typeof id !== "string" || id === "" || typeof publicKey !== "string" || !/^0x[0-9a-fA-F]+$/.test(publicKey)) return null;
  return { id, publicKey: publicKey as Hex, ...(typeof rpId === "string" && rpId ? { rpId } : {}) };
}

/** The passkey kept in this browser for the workspace, if a usable one is (K9). */
export function keptCredential(store: KeepingStore | null, orgSlug: string): KeptCredential | null {
  return asKept(readJson(store, credentialKey(orgSlug)));
}

/** Keeps a passkey's public part for the workspace; anything else about it is dropped (K9). */
export function keepCredential(store: KeepingStore | null, orgSlug: string, credential: unknown): void {
  const kept = asKept(credential);
  if (kept) writeJson(store, credentialKey(orgSlug), kept);
}

/** Forgets the passkey kept for the workspace: one that owns another wallet, say (K9). */
export function forgetCredential(store: KeepingStore | null, orgSlug: string): void {
  remove(store, credentialKey(orgSlug));
}

/** A setup sent and not yet recorded (K10): its contract, and its transaction or, until that is known, its user operation. */
export interface PendingSetup {
  contract: Hex;
  txHash?: Hex;
  userOpHash?: Hex;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;

export function pendingSetup(store: KeepingStore | null, orgSlug: string): PendingSetup | null {
  const value = readJson(store, pendingKey(orgSlug));
  if (typeof value !== "object" || value === null) return null;
  const { contract, txHash, userOpHash } = value as { contract?: unknown; txHash?: unknown; userOpHash?: unknown };
  if (typeof contract !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(contract)) return null;
  const tx = typeof txHash === "string" && HASH.test(txHash) ? (txHash as Hex) : undefined;
  const op = typeof userOpHash === "string" && HASH.test(userOpHash) ? (userOpHash as Hex) : undefined;
  if (!tx && !op) return null;
  return { contract: contract as Hex, ...(tx ? { txHash: tx } : {}), ...(op ? { userOpHash: op } : {}) };
}

export function keepPendingSetup(store: KeepingStore | null, orgSlug: string, pending: PendingSetup): void {
  writeJson(store, pendingKey(orgSlug), pending);
}

export function forgetPendingSetup(store: KeepingStore | null, orgSlug: string): void {
  remove(store, pendingKey(orgSlug));
}

/** A refusal of this route's own, said to the person as it is. */
export class PasskeyTreasuryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PasskeyTreasuryError";
  }
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** A passkey wallet opened as the treasury (K2): its address, its USDC, and its user operations. */
export interface PasskeyTreasury {
  address: string;
  /** The passkey's public part, to keep for the workspace (K9). */
  credential: KeptCredential | null;
  /** Its USDC on Arc mainnet, in units of 6 decimals. */
  balance(): Promise<bigint>;
  /** Sends the calls as one user operation, whose gas the wallet pays itself (K6). Throws only when Circle never took it. */
  send(calls: SetupCall[]): Promise<SendOutcome>;
  /** Registers `recoveryAddress` as a recovery owner of the wallet (K8). */
  registerRecovery(recoveryAddress: string): Promise<SendOutcome>;
  /** How a user operation sent before ended, from its receipt (K10). */
  receipt(userOpHash: string): Promise<SendOutcome>;
}

/**
 * Opens the owner's passkey wallet on Arc mainnet (K2): with a new passkey (`Register`), one made before (`Login`), or
 * the one this browser kept (`Kept`, no prompt). With `expected`, a passkey that owns another wallet is refused by
 * name before anything is signed (Review Focus 3).
 */
export async function openPasskeyTreasury(input: {
  config: PasskeyWalletConfig;
  sdk: PasskeySdk;
  mode: "Register" | "Login" | "Kept";
  username?: string;
  kept?: KeptCredential | null;
  expected?: string | null;
}): Promise<PasskeyTreasury> {
  const { config, sdk } = input;
  const chainPath = ARC_MAINNET.modularWallets?.chain;
  if (!chainPath) throw new PasskeyTreasuryError("Passkey wallets do not run on Arc mainnet here.");
  if (input.mode === "Kept" && !input.kept) throw new PasskeyTreasuryError("No passkey is kept in this browser.");
  const opened = await passkeySmartAccount({
    config,
    sdk,
    chainPath,
    ...(input.mode === "Kept" ? { credential: input.kept } : { mode: input.mode, ...(input.username ? { username: input.username } : {}) }),
  });
  const { account, client, transport } = opened;
  const address = account.address;
  if (input.expected && address.toLowerCase() !== input.expected.toLowerCase()) {
    throw new PasskeyTreasuryError(
      `This passkey owns another wallet (${short(address)}), not this workspace's treasury (${short(input.expected)}). Use the passkey you made for it.`
    );
  }
  const bundler = sdk.createBundlerClient({ account, client, chain: sdk.chain, transport });
  const settle = async (hash: string): Promise<SendOutcome> => {
    try {
      const { success, receipt } = await bundler.waitForUserOperationReceipt({ hash });
      return success ? { kind: "sent", txHash: receipt.transactionHash } : { kind: "reverted", txHash: receipt.transactionHash };
    } catch (error) {
      // Taken, but its receipt could not be read: it may still land, and is not sent again blind.
      console.error("passkey treasury receipt", error instanceof Error ? error.message : error);
      return { kind: "unconfirmed", userOpHash: hash };
    }
  };
  return {
    address,
    credential: asKept(opened.credential),
    balance: () =>
      client.readContract({ address: ARC_MAINNET.tokens.USDC as Hex, abi: erc20Abi, functionName: "balanceOf", args: [address as Hex] }),
    async send(calls) {
      // No paymaster: the wallet pays its own gas in USDC (K6).
      return settle(await bundler.sendUserOperation({ calls: calls.map((call) => ({ to: call.to, data: call.data, value: call.value })) }));
    },
    async registerRecovery(recoveryAddress) {
      if (!sdk.registerRecoveryAddress) throw new PasskeyTreasuryError("Recovery is not available in this browser.");
      return settle(await sdk.registerRecoveryAddress({ bundler, account, recoveryAddress }));
    },
    receipt: settle,
  };
}

const OWN_REFUSALS = [SETUP_MISMATCH];

/** What a person is told when the passkey route fails (K10). Anything unforeseen goes to the console only. */
export function passkeyTreasuryFailure(error: unknown, during: "create" | "open" | "setup" | "recovery" | "check"): string {
  const reason = browserReason(error);
  if (reason === "NotAllowedError") return during === "create" ? "No passkey was created. Nothing changed." : "The passkey was not used. Nothing changed.";
  if (reason === "NotSupportedError") return "This browser cannot use passkeys. Use one that can, such as Chrome or Safari, or connect a wallet instead.";
  if (reason === "SecurityError") return "Passkeys for Vestiarion wallets work only on www.vestiarion.xyz.";
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof PasskeyTreasuryError || OWN_REFUSALS.includes(message)) return message;
  // Checking a setup sent before sends nothing, and what was sent stays sent (final review I3).
  if (during === "check") {
    console.error("passkey treasury", during, message);
    return "The setup could not be checked just now; it is kept and not sent twice. Check again in a moment.";
  }
  if (/AA21|prefund|insufficient funds/i.test(message)) return "The wallet does not hold enough USDC for this. Add a little more, then try again. Nothing was sent.";
  // Estimating a setup the wallet cannot carry out (its 0.50 USDC of gas, past what the fee set aside leaves) reverts.
  if (during === "setup" && /execution reverted|AA[235]\d/i.test(message)) {
    return "The wallet could not carry out the setup with what it holds. Add a little more USDC, then try again. Nothing was sent.";
  }
  console.error("passkey treasury", during, message);
  return "That did not work. Nothing was sent. Try again in a moment.";
}

/** What a recording action answers (`RecordActionResult`). */
export interface RecordAnswer {
  ok: boolean;
  message: string;
  state: "pending" | "verified" | null;
  chainUnreadable?: true;
}

/** How asking to record what a passkey sent ended: recorded, refused for good, or not yet read. */
export type PolledRecord = { state: "verified" } | { state: "refused"; message: string } | { state: "unread" };

/**
 * Asks the server to record what a passkey sent until it is recorded, refused, or the tries run out (final review I3).
 * A call that throws (the page offline, the server unreachable) counts as not yet read, as an unread chain does: what
 * was sent is never said to be nothing.
 */
export async function pollRecord(input: {
  record: () => Promise<RecordAnswer>;
  tries: number;
  waitMs: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PolledRecord> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < input.tries; attempt += 1) {
    if (attempt > 0) await sleep(input.waitMs);
    let answer: RecordAnswer;
    try {
      answer = await input.record();
    } catch {
      continue;
    }
    if (answer.ok && answer.state === "verified") return { state: "verified" };
    if (!answer.ok && !answer.chainUnreadable) return { state: "refused", message: answer.message };
  }
  return { state: "unread" };
}

/**
 * Ends a setup the passkey sent (K7, K10; final review I3): recorded once the chain shows it, kept until then so a
 * reload asks about it, and never said to have sent nothing once it went. A server refusal is final: the setup is
 * forgotten and said to have been sent; a reverted one cost only its fee.
 */
export async function settlePasskeySetup(input: {
  store: KeepingStore | null;
  orgSlug: string;
  contract: Hex;
  outcome: SendOutcome;
  record: (txHash: string) => Promise<RecordAnswer>;
  tries: number;
  waitMs: number;
  sleep?: (ms: number) => Promise<void>;
  label: string;
  say: (text: string) => void;
}): Promise<"verified" | "pending"> {
  const { store, orgSlug, outcome, label } = input;
  const stillChecking = `The setup was sent. ${label} has not confirmed it yet; reload this page in a minute to check it again. It is not sent twice.`;
  if (outcome.kind === "reverted") {
    forgetPendingSetup(store, orgSlug);
    throw new PasskeyTreasuryError(`${label} did not carry out the setup; nothing was set up, and only its network fee was spent.`);
  }
  if (outcome.kind === "unconfirmed") {
    keepPendingSetup(store, orgSlug, { contract: input.contract, userOpHash: outcome.userOpHash as Hex });
    input.say(stillChecking);
    return "pending";
  }
  keepPendingSetup(store, orgSlug, { contract: input.contract, txHash: outcome.txHash as Hex });
  input.say(`Sent. Waiting for ${label} to confirm it…`);
  const polled = await pollRecord({ record: () => input.record(outcome.txHash), tries: input.tries, waitMs: input.waitMs, sleep: input.sleep });
  if (polled.state === "verified") {
    forgetPendingSetup(store, orgSlug);
    return "verified";
  }
  if (polled.state === "refused") {
    forgetPendingSetup(store, orgSlug);
    throw new PasskeyTreasuryError(`The setup was sent, but it could not be recorded: ${polled.message}`);
  }
  input.say(stillChecking);
  return "pending";
}

/** What the passkey route shows at a step (final review I3): a setup sent before is checked before anything else. */
export type PasskeyStepView = "agent" | "pending" | "fund" | "setup" | "gas" | "recovery" | "none";

export function passkeyStepView(input: { step: WalletTreasuryStep; walletUsdc: number | null; setupNeedsUsdc: number; pending: boolean }): PasskeyStepView {
  if (input.step === "agent" || input.step === "gas" || input.step === "recovery") return input.step;
  if (input.step === "deploy" || input.step === "approve") {
    if (input.pending) return "pending";
    return (input.walletUsdc ?? 0) < input.setupNeedsUsdc ? "fund" : "setup";
  }
  return "none";
}
