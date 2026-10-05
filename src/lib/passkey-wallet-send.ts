import { encodeFunctionData, erc20Abi, formatUnits, getAddress, parseUnits } from "viem";
import { checksumMatches, CHECKSUM_MISMATCH } from "./address-checksum";
import { looksLikeAddress, NOT_AN_ADDRESS } from "./payee-journey";
import { PASSKEY_WALLET_NETWORK, passkeySmartAccount, type PasskeySdk, type PasskeyWalletConfig } from "./passkey-wallet";

/**
 * Spending from a payee's passkey wallet at /wallet (docs/superpowers/specs/2026-10-05-payee-passkey-wallet-design.md
 * P4): its USDC, the checks before a send, and the send as a user operation whose gas Circle Gas Station pays. Kept apart
 * from src/lib/passkey-wallet.ts because it needs viem at run time, which a payee link has no use for.
 */

const USDC_DECIMALS = 6;

/** The USDC transfer a send makes: the token contract, and `transfer(to, units)`, to the address checksummed. */
export function transferCall(to: string, units: bigint): { to: `0x${string}`; data: `0x${string}` } {
  return {
    to: PASSKEY_WALLET_NETWORK.tokens.USDC as `0x${string}`,
    // An address written in one case alone is taken as written (payment safety A1); viem wants it checksummed.
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(to.trim().toLowerCase()), units] }),
  };
}

/**
 * What a send came to (review finding 1): carried out, with its transaction; reverted on Arc testnet, so nothing moved;
 * or taken by Circle with no receipt read yet, so it may still land and must not be sent again blind.
 */
export type SendOutcome =
  | { kind: "sent"; txHash: string }
  | { kind: "reverted"; txHash: string }
  | { kind: "unconfirmed"; userOpHash: string };

/** A passkey wallet opened at /wallet (P4): its address, its USDC, and a send. */
export interface OpenPasskeyWallet {
  address: string;
  /** Its USDC on Arc testnet, in units of 6 decimals. */
  balance(): Promise<bigint>;
  /** Sends USDC as a user operation whose gas Circle Gas Station pays. Throws only when Circle never took it. */
  send(to: string, units: bigint): Promise<SendOutcome>;
}

/** Logs in with the passkey and opens the wallet it owns (P4). */
export async function openPasskeyWallet(input: { config: PasskeyWalletConfig; sdk: PasskeySdk }): Promise<OpenPasskeyWallet> {
  const { account, client, transport } = await passkeySmartAccount({ config: input.config, sdk: input.sdk, mode: "Login" });
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
      // Not taken by Circle: this throws, and nothing was sent.
      const hash = await bundler.sendUserOperation({ calls: [transferCall(to, units)], paymaster: true });
      try {
        const { success, receipt } = await bundler.waitForUserOperationReceipt({ hash });
        return success ? { kind: "sent", txHash: receipt.transactionHash } : { kind: "reverted", txHash: receipt.transactionHash };
      } catch (error) {
        // Taken, but its receipt could not be read: it may still land.
        console.error("passkey wallet receipt", error instanceof Error ? error.message : error);
        return { kind: "unconfirmed", userOpHash: hash };
      }
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

/**
 * Why a send cannot go yet, before the passkey is asked (P4); null when it can. A balance that could not be read is
 * said so, not read as none (review finding 4).
 */
export function sendProblem(input: { to: string; amount: string; balance: bigint | null; from: string }): string | null {
  const to = input.to.trim();
  if (!looksLikeAddress(to)) return NOT_AN_ADDRESS;
  if (!checksumMatches(to)) return `${CHECKSUM_MISMATCH} Copy it again from where it came.`;
  if (to.toLowerCase() === input.from.toLowerCase()) return "That is this wallet's own address.";
  const units = usdcUnits(input.amount);
  if (units === null) return "Enter an amount of USDC, such as 1.50.";
  if (input.balance === null) return "This wallet's USDC could not be read. Choose Refresh, then try again.";
  if (units > input.balance) return `This wallet holds ${usdcText(input.balance)} USDC.`;
  return null;
}
