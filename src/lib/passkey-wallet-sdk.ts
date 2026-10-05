import { toCircleSmartAccount, toModularTransport, toPasskeyTransport, toWebAuthnCredential, WebAuthnMode } from "@circle-fin/modular-wallets-core";
import { createPublicClient, defineChain } from "viem";
import { createBundlerClient, toWebAuthnAccount } from "viem/account-abstraction";
import { PASSKEY_WALLET_NETWORK, type PasskeyBundler, type PasskeyPublicClient, type PasskeySdk } from "./passkey-wallet";

/**
 * The browser's Modular Wallets SDK and viem, as src/lib/passkey-wallet.ts takes them (payee passkey wallet P2, P4). Only
 * imported, dynamically, when a person chooses to create or open a passkey wallet, so a payee who types an address never
 * loads it. The SDK is built on its own copy of viem: values cross between the two as the SDK's examples pass them, and
 * the types are cast at this one seam.
 */

/** The network's chain as viem describes it, from its profile: USDC is Arc's native token, with 18 decimals there. */
const CHAIN = defineChain({
  id: PASSKEY_WALLET_NETWORK.chainId,
  name: PASSKEY_WALLET_NETWORK.label,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [PASSKEY_WALLET_NETWORK.rpcUrl] } },
  blockExplorers: { default: { name: "Arc explorer", url: PASSKEY_WALLET_NETWORK.explorer } },
  testnet: true,
});

export function passkeySdk(): PasskeySdk {
  return {
    chain: CHAIN,
    toPasskeyTransport: (clientUrl, clientKey) => toPasskeyTransport(clientUrl, clientKey),
    toWebAuthnCredential: (parameters) =>
      toWebAuthnCredential({
        transport: parameters.transport as never,
        mode: parameters.mode === "Register" ? WebAuthnMode.Register : WebAuthnMode.Login,
        ...(parameters.username ? { username: parameters.username } : {}),
      }),
    toModularTransport: (url, clientKey) => toModularTransport(url, clientKey),
    createPublicClient: (parameters) =>
      createPublicClient({ chain: parameters.chain as never, transport: parameters.transport as never }) as unknown as PasskeyPublicClient,
    // Signs under the passkey's own rpId, not the page's host: they differ when the Console's passkey domain is the apex
    // (review finding 2).
    toWebAuthnAccount: (parameters) =>
      toWebAuthnAccount({ credential: parameters.credential as never, rpId: (parameters.credential as { rpId?: string }).rpId }),
    toCircleSmartAccount: (parameters) => toCircleSmartAccount({ client: parameters.client as never, owner: parameters.owner as never }),
    createBundlerClient: (parameters) =>
      createBundlerClient({
        account: parameters.account as never,
        client: parameters.client as never,
        chain: parameters.chain as never,
        transport: parameters.transport as never,
      }) as unknown as PasskeyBundler,
  };
}
