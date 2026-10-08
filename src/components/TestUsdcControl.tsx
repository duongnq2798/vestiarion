"use client";

import { Coins } from "lucide-react";
import { addTestUsdcAction, type TestUsdcActionResult } from "@/app/actions/test-usdc";
import { FormMessage } from "@/components/ui/FormMessage";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { withSuccessToast } from "@/components/withSuccessToast";

/**
 * Adds test USDC from Vestiarion's float to the operating wallet, in the console's shadow mode section
 * (docs/superpowers/specs/2026-10-08-shadow-test-usdc-design.md T8). The amount on the button is the page's; the server
 * works it out again when pressed.
 */

const INITIAL: TestUsdcActionResult = { ok: false, message: "" };
const add = withSuccessToast(addTestUsdcAction);
const usdc = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 2 });

export default function TestUsdcControl({ orgSlug, amount }: { orgSlug: string; amount: number }) {
  const { state, formProps, pending } = useActionForm(add, INITIAL);
  return (
    <form {...formProps} className="space-y-1">
      <input type="hidden" name="orgSlug" value={orgSlug} />
      <SubmitButton size="sm" variant="secondary" icon={<Coins />} pendingLabel="Adding it…" disabled={pending}>
        {`Add ${usdc(amount)} test USDC`}
      </SubmitButton>
      <p className="text-xs text-ink-3">From Vestiarion&apos;s test USDC float, on Arc testnet.</p>
      <FormMessage tone={state.message && !state.ok ? "error" : "neutral"}>
        {state.ok && state.txUrl ? (
          <a href={state.txUrl} target="_blank" rel="noreferrer" className="font-medium text-agent underline-offset-2 hover:underline">
            View transaction
          </a>
        ) : state.ok ? null : (
          state.message
        )}
      </FormMessage>
    </form>
  );
}
