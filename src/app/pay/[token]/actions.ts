"use server";

import "server-only";

import { networkProfile, type Network } from "@/lib/network";
import { checkPayLink } from "@/lib/platform/pay-links";

export interface PaymentCheckResult {
  ok: boolean;
  message: string;
  received?: boolean;
}

const MESSAGES = {
  not_yet: "Not seen yet. A transfer can take a moment to confirm; check again in a minute.",
  wait: "Checked just now. Try again in a few seconds.",
  invalid: "This pay link no longer works. Ask for a new one.",
} as const;

/** The thanks, on the link's network (mainnet copy C1). */
function received(network: Network | null): string {
  return network ? `Received, thank you. The payment is recorded on ${networkProfile(network).label}.` : "Received, thank you. The payment is recorded.";
}

/**
 * "I have paid" on a pay link (receivables on Arc R5). The client has no account: the link is the
 * credential, and this only asks Vestiarion to look for the transfer sooner. Nothing is marked paid
 * here; a receivable is received only when Circle shows the transfer complete.
 */
export async function checkPaymentAction(_previous: PaymentCheckResult, formData: FormData): Promise<PaymentCheckResult> {
  const token = formData.get("token");
  try {
    const { outcome, network } = await checkPayLink(typeof token === "string" ? token : "");
    return { ok: outcome !== "invalid", message: outcome === "received" ? received(network) : MESSAGES[outcome], received: outcome === "received" };
  } catch (error) {
    // The client sees a sentence, not a broken page; the cause stays in the server log.
    console.error("pay link check failed", error instanceof Error ? error.message : error);
    return { ok: false, message: "We could not check just now. Try again in a minute." };
  }
}
