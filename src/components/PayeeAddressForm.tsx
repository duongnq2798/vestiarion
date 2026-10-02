"use client";

import { CircleCheck, PenLine } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { submitPayeeAddressAction, type PayeeAddressResult } from "@/app/payee/[token]/actions";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { groupAddress, looksLikeAddress, NOT_AN_ADDRESS } from "@/lib/payee-journey";

const INITIAL: PayeeAddressResult = { ok: false, message: "" };

/** What the payee ticks before sending an address the link cannot take back (freelancer journey R6). */
export const ADDRESS_CHECKS = [
  "It's my own wallet, and I can open it.",
  "It's not an exchange deposit address.",
  "The first and last characters match my wallet.",
] as const;

/**
 * The payee's address, in two screens (freelancer journey §4): the field, then the address read
 * back in fours with three boxes to tick before Send my address. Once it is sent the page refreshes
 * into the next step, which the link now shows. `intro`, how it works, shows with the field only, so
 * the check screen has the address and the boxes and nothing else.
 */
export default function PayeeAddressForm({
  token,
  chainLabel = "Arc testnet",
  orgName,
  intro,
}: {
  token: string;
  chainLabel?: string;
  orgName: string;
  intro?: ReactNode;
}) {
  const router = useRouter();
  const [step, setStep] = useState<"enter" | "check">("enter");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [checked, setChecked] = useState<boolean[]>(ADDRESS_CHECKS.map(() => false));
  const { state, formProps } = useActionForm(submitPayeeAddressAction, INITIAL, { onSuccess: () => router.refresh() });

  if (state.ok) {
    return (
      <p role="status" className="flex items-start gap-2 rounded-xl border border-proof-line bg-proof-soft px-4 py-3 text-sm text-ink">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-proof" />
        {state.message}
      </p>
    );
  }

  if (step === "enter") {
    const next = (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!looksLikeAddress(address)) {
        setError(NOT_AN_ADDRESS);
        return;
      }
      setError("");
      setStep("check");
    };
    return (
      <form onSubmit={next} noValidate className="grid gap-4">
        {intro}
        <Field
          id="payee-address"
          label={`Your wallet address on ${chainLabel}`}
          description="Starts with 0x, then 40 letters and numbers. Copy it from your wallet, such as MetaMask."
          error={error || undefined}
        >
          <Input
            name="address"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            required
            maxLength={200}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            placeholder="0x…"
          />
        </Field>
        <Button type="submit">Continue</Button>
      </form>
    );
  }

  const trimmed = address.trim();
  const groups = groupAddress(trimmed);
  const ready = checked.every(Boolean);
  return (
    <form {...formProps} className="grid gap-5">
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="address" value={trimmed} />
      <div>
        <h2 className="text-base font-semibold text-ink">Check your address</h2>
        <p className="mt-2 flex flex-wrap gap-x-1.5 gap-y-1 rounded-xl border border-line bg-raised px-3 py-2.5 font-mono text-[0.9375rem] tabular-nums text-ink">
          <span className="sr-only">{trimmed}</span>
          {groups.map((group, index) => (
            <span key={index} aria-hidden className={index === 1 || index === groups.length - 1 ? "font-semibold" : undefined}>
              {group}
            </span>
          ))}
        </p>
      </div>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium text-ink">Before you send it</legend>
        {ADDRESS_CHECKS.map((label, index) => (
          <Checkbox
            key={label}
            label={label}
            checked={checked[index]}
            onCheckedChange={(value) => setChecked((current) => current.map((item, at) => (at === index ? value === true : item)))}
          />
        ))}
      </fieldset>
      <div className="grid gap-2">
        <p className="text-xs leading-5 text-ink-3">After you send it, this link can&apos;t change it. To change it later, ask {orgName} for a new link.</p>
        <FormMessage tone={state.message ? "error" : "neutral"}>{state.message || null}</FormMessage>
      </div>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="ghost" icon={<PenLine />} onClick={() => setStep("enter")}>
          Edit address
        </Button>
        <SubmitButton pendingLabel="Sending…" disabled={!ready}>
          Send my address
        </SubmitButton>
      </div>
    </form>
  );
}
