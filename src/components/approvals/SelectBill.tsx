"use client";

import { Checkbox } from "@/components/ui/Checkbox";
import { fmt } from "@/components/vx/Primitives";

/** The checkbox's name, read out with the bill it ticks (approve many AM2). */
export function selectLabel(payee: string, amount: number): string {
  return `Select ${payee}, ${fmt(amount)} USDC`;
}

/**
 * The checkbox a card shows while its bill can join a selection (docs/superpowers/specs/2026-10-30-approve-many-design.md
 * AM2). Its name says which bill it ticks; the card already shows the payee and amount beside it. A wider invisible
 * target around the box makes it easy to tick from a phone.
 */
export function SelectBill({ id, payee, amount, selected, onToggle }: { id: string; payee: string; amount: number; selected: boolean; onToggle: () => void }) {
  return (
    <Checkbox
      id={`select-${id}`}
      checked={selected}
      onCheckedChange={onToggle}
      className="relative mt-0.5 gap-0"
      label={
        <>
          <span aria-hidden className="absolute -inset-3" />
          <span className="sr-only">{selectLabel(payee, amount)}</span>
        </>
      }
    />
  );
}
