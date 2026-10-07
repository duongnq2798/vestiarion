import type { PasskeyWalletConfig } from "./passkey-wallet";

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
