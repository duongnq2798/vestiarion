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

/** Latin letters that Unicode does not split into a letter and an accent, as `passkeyName` writes them. */
const PLAIN_LETTERS: Record<string, string> = {
  đ: "d", Đ: "D", ð: "d", Ð: "D", ß: "ss", æ: "ae", Æ: "AE", ø: "o", Ø: "O", œ: "oe", Œ: "OE", ł: "l", Ł: "L", þ: "th", Þ: "Th",
};

/**
 * The name the passkey is saved under, as the payee's password manager lists it beside www.vestiarion.xyz (P2): the
 * business that pays, then a mark, so two wallets never share a name. Circle takes 5 to 50 letters, digits and _@.:+-
 * only, and refuses anything else (-32025), so accents are dropped and every other character becomes a hyphen:
 * "Công ty Đất Việt" is saved as "Cong-ty-Dat-Viet-4f2a9c1e". The payee's own name is not sent to Circle.
 */
export function passkeyName(businessName: string, mark: string): string {
  const business = businessName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[đĐðÐßæÆøØœŒłŁþÞ]/g, (letter) => PLAIN_LETTERS[letter])
    .replace(/['’]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  return `${business || "Vestiarion"}-${mark}`;
}

/**
 * Eight hex characters from the browser's random source, for `passkeyName`, drawn for every attempt: Circle keeps a name
 * from the moment a registration asks for it, whether or not a passkey follows, and refuses it after (-32024).
 */
export function passkeyMark(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The bundler client calls a send makes: a user operation, and its receipt, which says whether it was carried out. A
 * payee's send has Circle Gas Station pay its gas (`paymaster: true`); a passkey treasury pays its own, and its calls
 * may carry a value (passkey treasury K6).
 */
export interface PasskeyBundler {
  sendUserOperation(operation: { calls: Array<{ to: `0x${string}`; data: `0x${string}`; value?: bigint }>; paymaster?: true }): Promise<string>;
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
  /** Circle's recovery: registers an address as a recovery owner of the wallet, as a user operation (passkey treasury K8). */
  registerRecoveryAddress?(parameters: { bundler: PasskeyBundler; account: unknown; recoveryAddress: string }): Promise<string>;
}

/**
 * The passkey, registered or used, then the smart account it owns on Arc testnet: worked out, never deployed here (P2).
 * The same passkey gives the same wallet either way.
 */
export async function passkeySmartAccount(input: {
  config: PasskeyWalletConfig;
  sdk: PasskeySdk;
  mode?: "Register" | "Login";
  username?: string;
  /** Modular Wallets' chain path; a payee's wallet's network by default (P1). */
  chainPath?: string;
  /** A passkey's public part kept from before: used as is, without a prompt (passkey treasury K9). */
  credential?: unknown;
}) {
  const { config, sdk } = input;
  const chainPath = input.chainPath ?? PASSKEY_WALLET_NETWORK.modularWallets?.chain;
  if (!chainPath) throw new Error("Passkey wallets do not run on this network");
  const credential =
    input.credential ??
    (await sdk.toWebAuthnCredential({
      transport: sdk.toPasskeyTransport(config.clientUrl, config.clientKey),
      mode: input.mode ?? "Login",
      ...(input.username ? { username: input.username } : {}),
    }));
  const transport = sdk.toModularTransport(`${config.clientUrl}/${chainPath}`, config.clientKey);
  const client = sdk.createPublicClient({ chain: sdk.chain, transport });
  const owner = sdk.toWebAuthnAccount({ credential });
  const account = await sdk.toCircleSmartAccount({ client, owner });
  return { account, client, transport, credential };
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
export function browserReason(error: unknown): string {
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
