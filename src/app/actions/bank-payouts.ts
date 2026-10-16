"use server";

import "server-only";

import { z } from "zod";
import { siteOrigin } from "@/lib/auth/env";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { BankPayoutsError, bankPayoutsTermsLink, setBankAccount, stopBankAccount } from "@/lib/bank-payouts/commands";
import { mintTestUsdb } from "@/lib/bank-payouts/test-token";
import { inOrg } from "@/lib/dal/scope";

/**
 * Bank payouts from the console (docs/superpowers/specs/2026-10-16-bank-payouts-design.md B3, B4): an owner starts the
 * workspace's set-up with BlindPay's terms; an owner or admin puts a vendor's bank account in use, or stops using it.
 * Every action reads the person's role again and works in the workspace's scope. Nothing returned carries a bank number.
 */

export interface BankPayoutsActionResult {
  ok: boolean;
  message: string;
  /** BlindPay's terms page, for the browser to open (B3). */
  url?: string;
}

const TRY_AGAIN = "That did not work. Try again in a moment.";
const counterpartyId = z.string().uuid();

const answer = (error: unknown, what: string): BankPayoutsActionResult => {
  if (error instanceof BankPayoutsError) return { ok: false, message: error.message };
  console.error(what, error instanceof Error ? error.message : "unknown error");
  return { ok: false, message: TRY_AGAIN };
};

/** Step 1 (B3): BlindPay's terms, which send the owner back to finish setting up. */
export async function startBankPayoutsAction(_previous: BankPayoutsActionResult, formData: FormData): Promise<BankPayoutsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "org.administer");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const url = await bankPayoutsTermsLink({ origin: siteOrigin(), orgSlug: auth.membership.slug });
      return { ok: true, message: "Opening BlindPay's terms…", url };
    } catch (error) {
      return answer(error, "startBankPayoutsAction failed");
    }
  });
}

/** A vendor's Mexican bank account put in use (B4). */
export async function setBankAccountAction(_previous: BankPayoutsActionResult, formData: FormData): Promise<BankPayoutsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const id = counterpartyId.safeParse(formData.get("counterpartyId"));
    if (!id.success) return { ok: false, message: "Counterparty not found." };
    const name = formData.get("beneficiaryName");
    const clabe = formData.get("clabe");
    try {
      const account = await setBankAccount({ actorId: auth.user.id, counterpartyId: id.data, beneficiaryName: typeof name === "string" ? name : "", clabe: typeof clabe === "string" ? clabe : "" });
      revalidateOrgPages();
      return { ok: true, message: `Paid to the bank account ending ${account.last4} from now on.` };
    } catch (error) {
      return answer(error, "setBankAccountAction failed");
    }
  });
}

/** Stops paying a vendor to its bank account (B4). */
export async function stopBankAccountAction(_previous: BankPayoutsActionResult, formData: FormData): Promise<BankPayoutsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    const id = counterpartyId.safeParse(formData.get("counterpartyId"));
    if (!id.success) return { ok: false, message: "Counterparty not found." };
    const name = formData.get("counterpartyName");
    try {
      const removed = await stopBankAccount({ actorId: auth.user.id, counterpartyId: id.data, counterpartyName: typeof name === "string" ? name.slice(0, 160) : "This vendor" });
      revalidateOrgPages();
      return removed ? { ok: true, message: "Paid to its address again." } : { ok: false, message: "It was not paid to a bank account." };
    } catch (error) {
      return answer(error, "stopBankAccountAction failed");
    }
  });
}

/** BlindPay's test token minted to the operating wallet, on Arc testnet (B13). */
export async function mintTestUsdbAction(_previous: BankPayoutsActionResult, formData: FormData): Promise<BankPayoutsActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "integrations.manage");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const minted = await mintTestUsdb({ actorId: auth.user.id, requestId: crypto.randomUUID() });
      revalidateOrgPages();
      return { ok: true, message: `${minted.amount} test USDB minted to the operating wallet.` };
    } catch (error) {
      return answer(error, "mintTestUsdbAction failed");
    }
  });
}
