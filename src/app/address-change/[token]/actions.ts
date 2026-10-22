"use server";

import "server-only";

import { after } from "next/server";
import { answerAddressChange } from "@/lib/address-change-check";

/**
 * The payee's answer to "Was this you?" (docs/superpowers/specs/2026-10-22-address-change-check-design.md AC3). No
 * session: the one-time link is the payee's only credential. Nothing from a failure reaches the payee but a fixed
 * sentence. The owners' and admins' email, on not me, goes after the payee has its answer.
 */

export interface AddressChangeAnswerResult {
  ok: boolean;
  message: string;
  outcome?: "confirmed" | "frozen" | "disputed";
}

const NOT_VALID = "This link is no longer valid. If you did not change your payment address, contact the business that pays you directly.";

export async function answerAddressChangeAction(_previous: AddressChangeAnswerResult, formData: FormData): Promise<AddressChangeAnswerResult> {
  const token = formData.get("token");
  const notMe = formData.get("answer") === "not_me";
  try {
    const outcome = await answerAddressChange(typeof token === "string" ? token : "", notMe, { defer: (work) => after(work) });
    if (outcome === "confirmed") return { ok: true, outcome, message: "Thank you. You told them you made this change. Nothing else is needed from you." };
    if (outcome === "frozen") {
      return {
        ok: true,
        outcome,
        message: "Thank you. Payments to the new address are stopped, and the business has been told. Someone there will check with you before anything changes.",
      };
    }
    if (outcome === "disputed") {
      return { ok: true, outcome, message: "Thank you. The address has already been changed again, and the business has been told what you said." };
    }
    return { ok: false, message: NOT_VALID };
  } catch (error) {
    console.error("address change answer failed", error instanceof Error ? error.message : "unknown error");
    return { ok: false, message: "That did not work. Try again in a moment." };
  }
}
