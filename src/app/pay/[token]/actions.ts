"use server";

import "server-only";

import { checkPayLink } from "@/lib/platform/pay-links";

export interface PaymentCheckResult {
  ok: boolean;
  message: string;
  received?: boolean;
}

const MESSAGES = {
  received: "Received, thank you. The payment is recorded on Arc testnet.",
  not_yet: "Not seen yet. A transfer can take a moment to confirm; check again in a minute.",
  wait: "Checked just now. Try again in a few seconds.",
  invalid: "This pay link no longer works. Ask for a new one.",
} as const;

/**
 * "I have paid" on a pay link (receivables on Arc R5). The client has no account: the link is the
 * credential, and this only asks Vestiarion to look for the transfer sooner. Nothing is marked paid
 * here; a receivable is received only when Circle shows the transfer complete.
 */
export async function checkPaymentAction(_previous: PaymentCheckResult, formData: FormData): Promise<PaymentCheckResult> {
  const token = formData.get("token");
  const outcome = await checkPayLink(typeof token === "string" ? token : "");
  return { ok: outcome !== "invalid", message: MESSAGES[outcome], received: outcome === "received" };
}
