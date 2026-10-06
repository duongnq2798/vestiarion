import type { OrgDb } from "../dal";
import { estimateGateway, gatewayBalance, gatewaySalt } from "./gateway";
import type { ChainProvider } from "./types";

/** What a payout from the workspace's Gateway balance would cost, and what that balance holds (Gateway payouts G2). */
export interface GatewayQuote {
  feeUsdc: number;
  balanceUsdc: number;
}

/**
 * Reads a workspace's Gateway quote for a payout: the fee Gateway estimates
 * now and the balance its operating wallet has deposited. Null in a sandbox,
 * or without a Gateway signer (nothing was ever funded). The signer and the
 * operating wallet's address are read once per stage.
 */
export function gatewayQuoter(provider: ChainProvider, db: OrgDb): (chain: string, amount: number) => Promise<GatewayQuote | null> {
  let parties: Promise<{ signer: string; depositor: string } | null> | undefined;
  return async (chain, amount) => {
    // No quote in a sandbox, or on a network without Gateway (network threading P5): the payout goes another way or waits.
    if (provider.mode !== "live" || provider.network.gateway === null) return null;
    parties ??= (async () => {
      const signer = await db.from("gateway_signers").select("address").maybeSingle();
      if (signer.error || !signer.data) return null;
      const operating = await db.from("accounts").select("address").eq("kind", "operating").maybeSingle();
      const depositor = (operating.data as { address: string | null } | null)?.address;
      return depositor ? { signer: (signer.data as { address: string }).address, depositor } : null;
    })();
    const known = await parties;
    if (!known) return null;
    const [estimate, balanceUsdc] = await Promise.all([
      estimateGateway(provider.network, { depositor: known.depositor, signer: known.signer, recipient: known.depositor, chain, amount, salt: gatewaySalt("quote") }),
      gatewayBalance(provider.network, known.depositor),
    ]);
    return { feeUsdc: estimate.feeUsdc, balanceUsdc };
  };
}

