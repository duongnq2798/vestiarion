import { encodeFunctionData, erc20Abi, formatUnits, parseUnits } from "viem";
import { checksumMatches, CHECKSUM_MISMATCH } from "./address-checksum";
import { ARC_TESTNET } from "./network";
import { looksLikeAddress, NOT_AN_ADDRESS } from "./payee-journey";

/**
 * A payee's passkey wallet (docs/superpowers/specs/2026-10-05-payee-passkey-wallet-design.md): a Circle Smart Account on
 * Arc testnet owned by a passkey, created from a payee link (P2) and opened at /wallet (P4). The Modular Wallets SDK and
 * viem come in as `sdk` (the browser's binding is src/lib/passkey-wallet-sdk.ts, loaded only when a person chooses this),
 * so the order of the calls, the failures and the USDC arithmetic are plain functions. Safe in client components.
 */

/** Where passkey wallets live: Arc testnet, the one network Modular Wallets serve here (P1). */
export const PASSKEY_WALLET_NETWORK = ARC_TESTNET;

const USDC_DECIMALS = 6;

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
 * The name the passkey is saved under, as the payee's password manager lists it (P2): their name and Vestiarion, with a
 * short mark so two payees of one name never collide.
 */
export function passkeyName(payeeName: string, mark: string): string {
  const name = payeeName.trim().replace(/\s+/g, " ").slice(0, 40);
  return name ? `${name} (Vestiarion ${mark})` : `Vestiarion wallet ${mark}`;
}

/** Four hex characters from the browser's random source, for `passkeyName`. */
export function passkeyMark(): string {
  const bytes = new Uint8Array(2);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The bundler client calls this module makes: a user operation, and its receipt. */
export interface PasskeyBundler {
  sendUserOperation(operation: { calls: Array<{ to: `0x${string}`; data: `0x${string}` }>; paymaster: true }): Promise<string>;
  waitForUserOperationReceipt(parameters: { hash: string }): Promise<{ receipt: { transactionHash: string } }>;
}

/** The public client call this module makes: a USDC balance. */
export interface PasskeyPublicClient {
  readContract(parameters: { address: `0x${string}`; abi: typeof erc20Abi; functionName: "balanceOf"; args: [`0x${string}`] }): Promise<bigint>;
}

/** The parts of the Modular Wallets SDK and viem this module uses, passed in so it runs without a browser in tests. */
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

/** The passkey, then the smart account it owns on Arc testnet: worked out, never deployed here (P2). */
async function smartAccount(input: { config: PasskeyWalletConfig; sdk: PasskeySdk; mode: "Register" | "Login"; username?: string }) {
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
 * Creates a passkey and works out the wallet it owns (P2): its address, which a payee link then sends as any typed one
 * (P3). Nothing is deployed and nothing is paid; Vestiarion keeps nothing of the passkey.
 */
export async function createPasskeyWallet(input: { config: PasskeyWalletConfig; username: string; sdk: PasskeySdk }): Promise<{ address: string }> {
  const { account } = await smartAccount({ config: input.config, sdk: input.sdk, mode: "Register", username: input.username });
  return { address: account.address };
}

/** A passkey wallet opened at /wallet (P4): its address, its USDC, and a send. */
export interface OpenPasskeyWallet {
  address: string;
  /** Its USDC on Arc testnet, in units of 6 decimals. */
  balance(): Promise<bigint>;
  /** Sends USDC as a user operation whose gas Circle Gas Station pays; the transaction's hash once it lands. */
  send(to: string, units: bigint): Promise<string>;
}

/** The USDC transfer a send makes: the token contract, and `transfer(to, units)`. */
export function transferCall(to: string, units: bigint): { to: `0x${string}`; data: `0x${string}` } {
  return {
    to: PASSKEY_WALLET_NETWORK.tokens.USDC as `0x${string}`,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as `0x${string}`, units] }),
  };
}

/** Logs in with the passkey and opens the wallet it owns (P4). */
export async function openPasskeyWallet(input: { config: PasskeyWalletConfig; sdk: PasskeySdk }): Promise<OpenPasskeyWallet> {
  const { account, client, transport } = await smartAccount({ config: input.config, sdk: input.sdk, mode: "Login" });
  const bundler = input.sdk.createBundlerClient({ account, client, chain: input.sdk.chain, transport });
  const address = account.address;
  return {
    address,
    balance: () =>
      client.readContract({
        address: PASSKEY_WALLET_NETWORK.tokens.USDC as `0x${string}`,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address as `0x${string}`],
      }),
    async send(to, units) {
      const hash = await bundler.sendUserOperation({ calls: [transferCall(to, units)], paymaster: true });
      const { receipt } = await bundler.waitForUserOperationReceipt({ hash });
      return receipt.transactionHash;
    },
  };
}

/** An amount a person typed, in USDC units of 6 decimals; null for anything that cannot be sent. */
export function usdcUnits(text: string): bigint | null {
  const value = text.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(value)) return null;
  const units = parseUnits(value, USDC_DECIMALS);
  return units > 0n ? units : null;
}

/** Units as USDC, with at least two decimals: "12.34", "0.000001", "0.00". */
export function usdcText(units: bigint): string {
  const [whole, fraction = ""] = formatUnits(units, USDC_DECIMALS).split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}

/** Why a send cannot go yet, before the passkey is asked (P4); null when it can. */
export function sendProblem(input: { to: string; amount: string; balance: bigint; from: string }): string | null {
  const to = input.to.trim();
  if (!looksLikeAddress(to)) return NOT_AN_ADDRESS;
  if (!checksumMatches(to)) return `${CHECKSUM_MISMATCH} Copy it again from where it came.`;
  if (to.toLowerCase() === input.from.toLowerCase()) return "That is this wallet's own address.";
  const units = usdcUnits(input.amount);
  if (units === null) return "Enter an amount of USDC, such as 1.50.";
  if (units > input.balance) return `This wallet holds ${usdcText(input.balance)} USDC.`;
  return null;
}

/** What a person is told when creating, opening or sending fails (P5). Anything unforeseen goes to the console only. */
export function passkeyFailure(error: unknown, during: "create" | "open" | "send"): string {
  const name = typeof (error as { name?: unknown } | null)?.name === "string" ? (error as { name: string }).name : "";
  if (name === "NotAllowedError") {
    if (during === "create") return "No passkey was created. Nothing changed.";
    return during === "open" ? "The passkey was not used. Nothing changed." : "The passkey was not used. Nothing was sent.";
  }
  if (name === "NotSupportedError") {
    return during === "create"
      ? "This browser cannot create passkeys. Enter an address from another wallet instead."
      : "This browser cannot use passkeys. Open this page in a browser that can, such as Chrome or Safari.";
  }
  if (name === "SecurityError") return "Passkeys for Vestiarion wallets work only on www.vestiarion.xyz.";
  console.error("passkey wallet", during, error instanceof Error ? error.message : error);
  if (during === "create") return "That did not work. Try again in a moment, or enter an address from another wallet.";
  return during === "open" ? "That did not work. Try again in a moment." : "Nothing was sent. Try again in a moment.";
}
