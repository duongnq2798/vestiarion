"use server";

import "server-only";

import { NOT_AN_ADDRESS } from "@/lib/payee-journey";
import { submitPayeeAddress } from "@/lib/platform/payee-links";

/**
 * The payee's submission from a payee link (spec 2026-09-30-payee-links-design.md
 * §2 step 3). No session: the one-time link is the payee's only credential, and
 * whatever they enter waits for a member to confirm it before any payment.
 * Nothing from a failure reaches the payee but a fixed sentence.
 */

export interface PayeeAddressResult {
  ok: boolean;
  message: string;
}

function formString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

export async function submitPayeeAddressAction(_previous: PayeeAddressResult, formData: FormData): Promise<PayeeAddressResult> {
  try {
    const result = await submitPayeeAddress(formString(formData, "token"), formString(formData, "address"));
    if (result.ok) {
      return result.unchanged
        ? { ok: true, message: `That is already the address ${result.orgName} has on file.` }
        : { ok: true, message: `Thanks. ${result.orgName} will confirm your address before paying you.` };
    }
    return result.reason === "invalid_address"
      ? { ok: false, message: NOT_AN_ADDRESS }
      : { ok: false, message: "This link is no longer valid. Ask the business that sent it for a new one." };
  } catch {
    console.error("payee address submission failed");
    return { ok: false, message: "That did not work. Try again in a moment." };
  }
}
