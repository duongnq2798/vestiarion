import type { erc20Abi } from "viem";
import { ARC_TESTNET } from "./network";

/**
 * A payee's passkey wallet (docs/superpowers/specs/2026-10-05-payee-passkey-wallet-design.md): a Circle Smart Account on
 * Arc testnet owned by a passkey, made or used from a payee link (P2) and opened at /wallet (P4). The Modular Wallets SDK
 * and viem come in as `sdk` (the browser's binding is src/lib/passkey-wallet-sdk.ts, loaded only when a person chooses
 * this), so the order of the calls and the failures are plain functions. Safe in client components, and light: the
 * payee link loads it, so viem is imported here for its types only; sending lives in src/lib/passkey-wallet-send.ts.
 */

/** Where passkey wallets live: Arc testnet, the one network Modular Wallets serve here (P1). */
export const PASSKEY_WALLET_NETWORK = ARC_TESTNET;

/** The Modular Wallets client key and client URL from the Circle Console (P6). */
export interface PasskeyWalletConfig {
  clientKey: string;
  clientUrl: string;
}

/**
 * The Modular Wallets client key and URL (P6), from the build's environment; null unless both are set. The client key
 * is meant for the browser: it names the app to Circle and carries no right to move money.
 */
export function passkeyWalletConfig(
  env: { key: string | undefined; url: string | undefined } = {
    key: process.env.NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_KEY,
    url: process.env.NEXT_PUBLIC_MODULAR_WALLETS_CLIENT_URL,
  }
): PasskeyWalletConfig | null {
  const clientKey = env.key?.trim() ?? "";
  const clientUrl = (env.url?.trim() ?? "").replace(/\/+$/, "");
  return clientKey && clientUrl ? { clientKey, clientUrl } : null;
}

/** Whether a payee paid on `chain` (Circle's blockchain name) is offered a passkey wallet (P1). */
export function passkeyWalletOffered(chain: string, config: PasskeyWalletConfig | null): boolean {
  return config !== null && PASSKEY_WALLET_NETWORK.modularWallets !== null && chain === PASSKEY_WALLET_NETWORK.circleBlockchain;
}

/**
 * The name the passkey is saved under, as the payee's password manager lists it (P2): the business that pays and
 * Vestiarion, with a short mark so two wallets never share a name. The payee's own name is not sent to Circle.
 */
export function passkeyName(businessName: string, mark: string): string {
  const name = businessName.trim().replace(/\s+/g, " ").slice(0, 40);
  return name ? `${name} (Vestiarion ${mark})` : `Vestiarion wallet ${mark}`;
}

/** Four hex characters from the browser's random source, for `passkeyName`. */
export function passkeyMark(): string {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The bundler client calls a send makes: a user operation, and its receipt, which says whether it was carried out. */
export interface PasskeyBundler {
  sendUserOperation(operation: { calls: Array<{ to: `0x${string}`; data: `0x${string}` }>; paymaster: true }): Promise<string>;
  waitForUserOperationReceipt(parameters: { hash: string }): Promise<{ success: boolean; receipt: { transactionHash: string } }>;
}

/** The public client call /wallet makes: a USDC balance. */
export interface PasskeyPublicClient {
  readContract(parameters: { address: `0x${string}`; abi: typeof erc20Abi; functionName: "balanceOf"; args: [`0x${string}`] }): Promise<bigint>;
}

/** The parts of the Modular Wallets SDK and viem these modules use, passed in so they run without a browser in tests. */
export interface PasskeySdk {
  /** viem's chain for `PASSKEY_WALLET_NETWORK`. */
  chain: unknown;
  toPasskeyTransport(clientUrl: string, clientKey: string): unknown;
  toWebAuthnCredential(parameters: { transport: unknown; mode: "Register" | "Login"; username?: string }): Promise<unknown>;
  toModularTransport(url: string, clientKey: string): unknown;
  createPublicClient(parameters: { chain: unknown; transport: unknown }): PasskeyPublicClient;
  toWebAuthnAccount(parameters: { credential: unknown }): unknown;
  toCircleSmartAccount(parameters: { client: unknown; owner: unknown }): Promise<{ address: string }>;
  createBundlerClient(parameters: { account: unknown; client: unknown; chain: unknown; transport: unknown }): PasskeyBundler;
}

/**
 * The passkey, registered or used, then the smart account it owns on Arc testnet: worked out, never deployed here (P2).
 * The same passkey gives the same wallet either way.
 */
export async function passkeySmartAccount(input: { config: PasskeyWalletConfig; sdk: PasskeySdk; mode: "Register" | "Login"; username?: string }) {
  const { config, sdk } = input;
  const chainPath = PASSKEY_WALLET_NETWORK.modularWallets?.chain;
  if (!chainPath) throw new Error("Passkey wallets do not run on this network");
  const passkeys = sdk.toPasskeyTransport(config.clientUrl, config.clientKey);
  const credential = await sdk.toWebAuthnCredential({ transport: passkeys, mode: input.mode, ...(input.username ? { username: input.username } : {}) });
  const transport = sdk.toModularTransport(`${config.clientUrl}/${chainPath}`, config.clientKey);
  const client = sdk.createPublicClient({ chain: sdk.chain, transport });
  const owner = sdk.toWebAuthnAccount({ credential });
  const account = await sdk.toCircleSmartAccount({ client, owner });
  return { account, client, transport };
}

/**
 * The address of a passkey wallet, for a payee link to send as any typed one (P2, P3): a new passkey (`Register`), or
 * one the payee made before (`Login`), so a second link uses the same wallet rather than another. Nothing is deployed
 * and nothing is paid; Vestiarion keeps nothing of the passkey.
 */
export async function passkeyWalletAddress(input: {
  config: PasskeyWalletConfig;
  mode: "Register" | "Login";
  username?: string;
  sdk: PasskeySdk;
}): Promise<{ address: string }> {
  const { account } = await passkeySmartAccount(input);
  return { address: account.address };
}

const KNOWN_FAILURES = new Set(["NotAllowedError", "NotSupportedError", "SecurityError"]);

/** The browser's own reason for a failure, however deep a library wrapped it: signing wraps a cancelled prompt. */
function browserReason(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    const name = (current as { name?: unknown }).name;
    if (typeof name === "string" && KNOWN_FAILURES.has(name)) return name;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}

/** What a person is told when making, opening or sending fails (P5). Anything unforeseen goes to the console only. */
export function passkeyFailure(error: unknown, during: "create" | "open" | "send"): string {
  const reason = browserReason(error);
  if (reason === "NotAllowedError") {
    if (during === "create") return "No passkey was created. Nothing changed.";
    return during === "open" ? "The passkey was not used. Nothing changed." : "The passkey was not used. Nothing was sent.";
  }
  if (reason === "NotSupportedError") {
    return during === "create"
      ? "This browser cannot create passkeys. Enter an address from another wallet instead."
      : "This browser cannot use passkeys. Open this page in a browser that can, such as Chrome or Safari.";
  }
  if (reason === "SecurityError") return "Passkeys for Vestiarion wallets work only on www.vestiarion.xyz.";
  console.error("passkey wallet", during, error instanceof Error ? error.message : error);
  if (during === "create") return "That did not work. Try again in a moment, or enter an address from another wallet.";
  return during === "open" ? "That did not work. Try again in a moment." : "Nothing was sent. Try again in a moment.";
}
