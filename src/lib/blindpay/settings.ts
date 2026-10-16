import type { Network } from "../network";

/**
 * The deployment's BlindPay instance (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B2). Off unless its API
 * key and instance id are both set: then there is no Bank payouts card, no bank account form, no bank route, and the
 * webhook answers 404. The webhook secret lets BlindPay's notices in; without it they are refused.
 */

export interface BlindpaySettings {
  apiKey: string;
  instanceId: string;
  webhookSecret: string | null;
  /** The network and token a payout is sent on, for the workspace's network. */
  route: (network: Network) => { network: string; token: "USDC" | "USDB" };
}

/** BlindPay's instance ids are `in_` and 12 letters and digits. */
const INSTANCE_ID = /^in_[A-Za-z0-9]{8,32}$/;
const NETWORK = /^[a-z_]{2,40}$/;

export function blindpaySettingsFromEnv(env: Record<string, string | undefined> = process.env): BlindpaySettings | null {
  const apiKey = env.BLINDPAY_API_KEY?.trim();
  const instanceId = env.BLINDPAY_INSTANCE_ID?.trim();
  if (!apiKey || !instanceId) return null;
  // Never the values themselves: only that they were not used.
  if (!INSTANCE_ID.test(instanceId)) {
    console.warn("Bank payouts are off: BLINDPAY_INSTANCE_ID is not a BlindPay instance id");
    return null;
  }
  const secret = env.BLINDPAY_WEBHOOK_SECRET?.trim();
  const networkOverride = env.BLINDPAY_NETWORK?.trim();
  const tokenOverride = env.BLINDPAY_TOKEN?.trim();
  return {
    apiKey,
    instanceId,
    webhookSecret: secret && secret.startsWith("whsec_") ? secret : null,
    route: (network) => {
      // Arc testnet pays with BlindPay's development token, USDB; Arc mainnet with USDC (B2).
      const base = network === "arc-mainnet" ? { network: "arc", token: "USDC" as const } : { network: "arc_testnet", token: "USDB" as const };
      return {
        network: networkOverride && NETWORK.test(networkOverride) ? networkOverride : base.network,
        token: tokenOverride === "USDC" || tokenOverride === "USDB" ? tokenOverride : base.token,
      };
    },
  };
}

/** Where BlindPay sends an owner back once they accepted its terms (B3). */
export function blindpayTermsReturnUri(origin: string, orgSlug: string): string {
  return `${origin}/api/integrations/blindpay/terms?org=${encodeURIComponent(orgSlug)}`;
}

export const BLINDPAY_API = "https://api.blindpay.com";
