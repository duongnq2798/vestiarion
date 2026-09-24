"use client";

import { useActionState, useEffect, useRef } from "react";
import { createInvoiceAction, type IntakeActionResult } from "@/app/actions/intake";

const INITIAL: IntakeActionResult = { ok: false, message: "" };
const INPUT = "h-10 w-full rounded-xl border border-line-strong bg-surface px-3 text-sm text-ink shadow-sm outline-none placeholder:text-ink-3 focus:border-agent focus:ring-2 focus:ring-agent-soft";

export interface IntakeCounterparty {
  id: string;
  name: string;
  role: string;
}

export default function InvoiceIntake({ counterparties }: { counterparties: IntakeCounterparty[] }) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState(createInvoiceAction, INITIAL);

  useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Direction" htmlFor="invoice-direction">
          <select className={INPUT} id="invoice-direction" name="direction" defaultValue="payable">
            <option value="payable">Payable</option>
            <option value="receivable">Receivable</option>
          </select>
        </Field>
        <Field label="Counterparty" htmlFor="invoice-counterparty">
          <select className={INPUT} id="invoice-counterparty" name="counterpartyId" required defaultValue="">
            <option value="" disabled>Select a counterparty</option>
            {counterparties.map((counterparty) => (
              <option key={counterparty.id} value={counterparty.id}>{counterparty.name} · {counterparty.role}</option>
            ))}
          </select>
        </Field>
        <Field label="Amount (USDC)" htmlFor="invoice-amount">
          <input className={INPUT} id="invoice-amount" name="amount" required inputMode="decimal" placeholder="1250.00" />
        </Field>
        <Field label="Due date" htmlFor="invoice-due">
          <input className={INPUT} id="invoice-due" name="dueDate" required type="date" />
        </Field>
        <Field label="Memo" htmlFor="invoice-memo">
          <input className={INPUT} id="invoice-memo" name="memo" maxLength={280} />
        </Field>
        <Field label="PO reference" htmlFor="invoice-po">
          <input className={INPUT} id="invoice-po" name="poReference" maxLength={100} placeholder="PO-100" />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" name="goodsReceived" className="size-4 accent-agent" />
        Goods or services received
      </label>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p aria-live="polite" className={`text-sm ${state.message && !state.ok ? "text-refused" : "text-ink-2"}`}>
          {state.message || "The agent will evaluate this invoice on the next cycle."}
        </p>
        <button disabled={pending || counterparties.length === 0} className="brand-shadow h-10 shrink-0 rounded-xl bg-agent px-4 text-sm font-semibold text-on-agent transition-transform hover:-translate-y-0.5 disabled:opacity-60">
          {pending ? "Adding…" : "Add invoice"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
      {label}
      <span className="mt-1.5 block">{children}</span>
    </label>
  );
}
