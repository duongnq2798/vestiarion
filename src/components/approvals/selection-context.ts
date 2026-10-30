"use client";

import { createContext, useContext, useEffect } from "react";

/**
 * The bills a person ticked on Approvals, to approve with one confirmation
 * (docs/superpowers/specs/2026-10-30-approve-many-design.md). A plain context module, so a card can offer itself without
 * loading the confirmation or its server action: outside Approvals' selection there is no context, and a card shows no
 * checkbox.
 */

/** One bill a card offers to a selection, as the confirmation lists it (approve many AM2, AM9). */
export interface SelectableBill {
  id: string;
  payee: string;
  /** The bill's full amount, in USDC: what the selection's total adds up and the operating wallet must hold (AM4). */
  amount: number;
  /** The address its card shows, sent with it so the server pays only what the person saw. */
  address: string;
  /** Paying it goes against the agent's hold, so the confirmation asks why (AM9). */
  overridesHold: boolean;
  /** This person's approval pays it now; false for the first of two approvals, which sends nothing (AM5). */
  pays: boolean;
  /** An early-payment discount still applies to it, which comes off at the transfer, as alone (AM4). */
  discounted: boolean;
}

export interface SelectionValue {
  /** Whether this bill is in the selection. */
  selected: (id: string) => boolean;
  /** Ticks or unticks a bill its card offers; a bill no card offers is left alone. */
  toggle: (id: string) => void;
  /**
   * A card says whether it can be selected now, with what the confirmation shows of it, or `null` when it cannot. A
   * bill no card offers any more, because it left the list or can no longer be selected, leaves the selection.
   */
  offer: (id: string, bill: SelectableBill | null) => void;
}

export const SelectionContext = createContext<SelectionValue | null>(null);

/** The most bills one confirmation approves: what one batch carries (`MAX_BATCH_SIZE`, approve many AM3). */
export const MAX_SELECTION = 20;

/** The bills' full amounts added up in micro-USDC, so twenty amounts never drift (AM4). */
export function totalOf(bills: ReadonlyArray<Pick<SelectableBill, "amount">>): number {
  return bills.reduce((sum, bill) => sum + Math.round(bill.amount * 1_000_000), 0) / 1_000_000;
}

/** The selection a card sits in, or null outside Approvals' (approve many AM13). */
export function useSelection(): SelectionValue | null {
  return useContext(SelectionContext);
}

/**
 * Offers a card's bill to the selection for as long as it can be selected (AM2), keeping what the confirmation shows of
 * it up to date across the page's refreshes, and takes it back when it no longer can or the card leaves the page.
 * Returns whether it is selected and how to tick it, or null where it cannot be selected or there is no selection.
 */
export function useSelectableBill(id: string, bill: SelectableBill | null): { selected: boolean; toggle: () => void } | null {
  const selection = useSelection();
  const offer = selection?.offer;
  // The bill's facts as one value, so an unchanged bill offers itself once, however often the page refreshes.
  const facts = bill ? JSON.stringify(bill) : null;
  useEffect(() => {
    if (!offer) return;
    offer(id, facts ? (JSON.parse(facts) as SelectableBill) : null);
    return () => offer(id, null);
  }, [offer, id, facts]);
  if (!selection || !bill) return null;
  return { selected: selection.selected(id), toggle: () => selection.toggle(id) };
}
