"use server";

import "server-only";

import { raiseCycleEvent } from "@/lib/agent/cycle-soon";
import { authorize } from "@/lib/auth/authorize";
import { revalidateOrgPages } from "@/lib/auth/revalidate";
import { inOrg } from "@/lib/dal/scope";
import { PaymentsDisabledError } from "@/lib/payments-switch";
import { addTestUsdc, TestUsdcError } from "@/lib/test-usdc";

/**
 * Adds test USDC from Vestiarion's float to the operating wallet, from the console's shadow mode section
 * (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T2, T7, T8): someone who may add records asks; the
 * library works out the amount, sends it and signs it; the agent then decides again on what waited for cash.
 */

export interface TestUsdcActionResult {
  ok: boolean;
  message: string;
  /** The transfer on Arc testnet's explorer, once it is confirmed. */
  txUrl?: string;
}

const usdc = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });
/** Where else testnet USDC comes from while the float is empty (test USDC T8). */
const ELSEWHERE = "Use Circle's faucet, or buy testnet USDC from TestMint and send it to the operating wallet.";

export async function addTestUsdcAction(_previous: TestUsdcActionResult, formData: FormData): Promise<TestUsdcActionResult> {
  const auth = await authorize(formData.get("orgSlug"), "records.write");
  if (!auth.ok) return { ok: false, message: auth.message };
  return inOrg(auth, async () => {
    try {
      const added = await addTestUsdc({ actorId: auth.user.id });
      revalidateOrgPages();
      // Circle's own terminal state: nothing moved, and the next press sends again under a new key.
      if (added.status === "failed") return { ok: false, message: "Circle could not send the test USDC. Try again in a moment." };
      raiseCycleEvent(auth, "test_usdc_added");
      const said = `Added ${usdc(added.amount)} test USDC to the operating wallet.`;
      const message = added.status === "pending" ? `${said} Arc testnet is still confirming it.` : said;
      return added.txUrl ? { ok: true, message, txUrl: added.txUrl } : { ok: true, message };
    } catch (error) {
      if (error instanceof TestUsdcError) return { ok: false, message: error.code === "float_empty" ? `${error.message} ${ELSEWHERE}` : error.message };
      if (error instanceof PaymentsDisabledError) return { ok: false, message: error.message };
      console.error("test USDC failed", error instanceof Error ? error.message : "unknown error");
      return { ok: false, message: "That did not work. Try again in a moment." };
    }
  });
}
