"use client";

import { useActionState, useEffect, useRef } from "react";
import { createCounterpartyAction, type IntakeActionResult } from "@/app/actions/intake";

const INITIAL: IntakeActionResult = { ok: false, message: "" };
const INPUT = "h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink outline-none placeholder:text-ink-3 focus:border-agent";

export default function CounterpartyIntake() {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(createCounterpartyAction, INITIAL);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="rounded-lg border border-line bg-surface p-4 sm:p-5">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Legal or trading name" htmlFor="cp-name">
          <input className={INPUT} id="cp-name" name="name" required maxLength={160} autoComplete="organization" />
        </Field>
        <Field label="Role" htmlFor="cp-role">
          <select className={INPUT} id="cp-role" name="role" defaultValue="vendor">
            <option value="vendor">Vendor</option>
            <option value="contractor">Contractor</option>
            <option value="client">Client</option>
          </select>
        </Field>
        <Field label="Payment limit (USDC)" htmlFor="cp-limit" hint="May be blank for clients">
          <input className={INPUT} id="cp-limit" name="paymentLimit" inputMode="decimal" placeholder="5000.00" />
        </Field>
        <Field label="Chain" htmlFor="cp-chain">
          <input className={INPUT} id="cp-chain" name="chain" required maxLength={40} defaultValue="ARC-TESTNET" />
        </Field>
        <Field label="Payment address" htmlFor="cp-address" hint="Optional until payment setup">
          <input className={INPUT} id="cp-address" name="address" maxLength={200} autoComplete="off" />
        </Field>
        <Field label="Jurisdiction" htmlFor="cp-jurisdiction" hint="ISO code or country name">
          <input className={INPUT} id="cp-jurisdiction" name="jurisdiction" maxLength={80} placeholder="US" />
        </Field>
      </div>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p aria-live="polite" className={`text-sm ${state.message && !state.ok ? "text-refused" : "text-ink-2"}`}>
          {state.message || "The configured limit is preserved as the baseline; screening derives current payment authority."}
        </p>
        <button disabled={pending} className="h-10 shrink-0 rounded-md bg-agent px-4 text-sm font-semibold text-on-agent hover:bg-agent/90 disabled:opacity-60">
          {pending ? "Adding and screening…" : "Add and screen"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
      <span>{label}</span>
      {hint && <span className="ml-1 font-normal text-ink-3">· {hint}</span>}
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}
