"use client";

import { ShieldCheck } from "lucide-react";
import { useState } from "react";
import { createCounterpartyAction, type IntakeActionResult } from "@/app/actions/intake";
import { AddressNameHint } from "./AddressNameHint";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { FormMessage } from "@/components/ui/FormMessage";
import { Input } from "@/components/ui/Input";
import { RadioGroup } from "@/components/ui/RadioGroup";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/Select";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { useActionForm } from "@/components/ui/useActionForm";
import { chainsOn, homeChain } from "@/lib/payee-chains";
import { networkProfile, type Network } from "@/lib/network";

const INITIAL: IntakeActionResult = { ok: false, message: "" };

/**
 * What the Chain field offers on the workspace's network (mainnet polish E2): other chains through CCTP, or its own only.
 * Where a workspace may pay from the owner's own wallet, it says that version 2 of the wallet's contract pays another
 * chain (mainnet Base payouts B5; spending limit v2 V11).
 */
export function chainHelp(network: Network): string {
  const profile = networkProfile(network);
  if (!profile.cctp) return `${profile.label} pays on its own chain only`;
  return profile.walletTreasury
    ? "Another chain is paid from Arc through CCTP, for a fee; from your own wallet, version 2 of its contract pays it"
    : "Another chain is paid from Arc through CCTP, for a fee";
}

/**
 * Whether a supplier sends purchase orders, asked in shadow mode (three-way match design M2): its answer sets the
 * supplier's "Pay without purchase orders", which Counterparties changes later. Not asked of a client.
 */
export const PURCHASE_ORDERS_QUESTION = "Does this supplier send you purchase orders?";
const PURCHASE_ORDER_ANSWERS = [
  { value: "yes", label: "Yes", description: "The agent pays a bill once its purchase order is on file." },
  { value: "no", label: "No", description: "The agent pays without one. The goods or services still need to be marked received." },
] as const;

/** A new counterparty is screened the moment it is saved; the toast carries the verdict. */
/** `framed={false}` inside a section that already frames it (Counterparties folds it under Add counterparty). */
/** `askPurchaseOrders` in shadow mode: a supplier's purchase orders are asked for, not assumed. */
export default function CounterpartyIntake({
  orgSlug,
  framed = true,
  network,
  askPurchaseOrders = false,
  initialName,
}: {
  orgSlug: string;
  framed?: boolean;
  network: Network;
  askPurchaseOrders?: boolean;
  /** The name to start with: a captured draft's supplier (invoice capture design C5). */
  initialName?: string;
}) {
  const [role, setRole] = useState("vendor");
  // The name and the address, held here for the address field's hint (ENS address names EN1, EN3).
  const [name, setName] = useState(initialName ?? "");
  const [address, setAddress] = useState("");
  // The form clears on success, its role back to Vendor.
  const { state, formProps } = useActionForm(createCounterpartyAction, INITIAL, {
    resetOnSuccess: true,
    toastOnSuccess: true,
    onSuccess: () => {
      setRole("vendor");
      setName("");
      setAddress("");
    },
  });

  return (
    <Card asChild className={framed ? "p-4 sm:p-6" : "border-0 bg-transparent p-0 shadow-none"}>
      <form {...formProps}>
        <input type="hidden" name="orgSlug" value={orgSlug} />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field id="cp-name" label="Legal or trading name">
            <Input name="name" required maxLength={160} autoComplete="organization" value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
          <Field id="cp-role" label="Role">
            <Select name="role" defaultValue="vendor" onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="vendor">Vendor</SelectItem>
                <SelectItem value="contractor">Contractor</SelectItem>
                <SelectItem value="client">Client</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field id="cp-limit" label="Payment limit (USDC)" description="May be blank for clients">
            <Input name="paymentLimit" inputMode="decimal" placeholder="5000.00" />
          </Field>
          <Field id="cp-chain" label="Chain" description={chainHelp(network)}>
            <Select name="chain" defaultValue={homeChain(network).id}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {chainsOn(network).map((chain) => (
                  <SelectItem key={chain.id} value={chain.id}>
                    {chain.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="cp-address" label="Payment address" description="Optional until payment setup. An ENS name or Basename is looked up.">
            <Input name="address" maxLength={200} autoComplete="off" className="font-mono" value={address} onChange={(event) => setAddress(event.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <AddressNameHint orgSlug={orgSlug} value={address} payeeName={name} onUse={setAddress} />
          </div>
          <Field id="cp-jurisdiction" label="Jurisdiction" optional description="ISO code or country name">
            <Input name="jurisdiction" maxLength={80} placeholder="US" />
          </Field>
          <Field id="cp-notice-email" label="Billing email" optional description="A payee is told each payment; a client gets the reminders you turn on" className="sm:col-span-2">
            <Input name="noticeEmail" type="email" maxLength={254} autoComplete="off" placeholder="accounts@example.com" />
          </Field>
        </div>
        {askPurchaseOrders && role !== "client" && (
          <RadioGroup legend={PURCHASE_ORDERS_QUESTION} name="purchaseOrders" required options={PURCHASE_ORDER_ANSWERS} className="mt-4" />
        )}
        <p className="mt-4 text-xs leading-relaxed text-ink-3">The agent never pays more than the payment limit on one bill without asking you.</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <FormMessage tone="error">{state.ok ? null : state.message}</FormMessage>
          <SubmitButton icon={<ShieldCheck />} pendingLabel="Adding and screening…" className="shrink-0">
            Add and screen
          </SubmitButton>
        </div>
      </form>
    </Card>
  );
}
