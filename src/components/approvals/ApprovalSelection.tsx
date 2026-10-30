"use client";

import { Banknote } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Kbd } from "@/components/ui/Kbd";
import { Money, fmt } from "@/components/vx/Primitives";
import { ApproveSelectionDialog } from "./ApproveSelectionDialog";
import { OPEN_OVERLAY, selectionKey } from "./keys";
import { MAX_SELECTION, SelectionContext, totalOf, type SelectableBill, type SelectionValue } from "./selection-context";

/** "1 bill selected", "4 bills selected". */
export function selectedLine(count: number): string {
  return `${count} ${count === 1 ? "bill" : "bills"} selected`;
}

/** The bar's button: Approve and pay, or Approve where no bill of the selection pays now, only gives the first of two (AM5). */
export function approveLabel(count: number, anyPays: boolean): string {
  return `${anyPays ? "Approve and pay" : "Approve"} ${count}`;
}

/** Why the bar's button is off: a selection is 2 to 20 bills (AM3). Null when it is not. */
export function selectionHint(count: number): string | null {
  if (count < 2) return "Select one more bill to approve them together.";
  if (count > MAX_SELECTION) return `Select at most ${MAX_SELECTION} bills to approve together.`;
  return null;
}

/** What the live region says as the selection changes, so a screen reader hears the count and the total (AM12). */
export function selectionAnnouncement(bills: ReadonlyArray<Pick<SelectableBill, "amount">>): string {
  if (bills.length === 0) return "No bills selected.";
  return `${selectedLine(bills.length)}, ${fmt(totalOf(bills))} USDC.`;
}

/**
 * Approvals' selection (docs/superpowers/specs/2026-10-30-approve-many-design.md): the bills a person ticked, the bar
 * that approves them with one confirmation, and the keys that drive it (AM12). It wraps the list of cards on the
 * Approvals page only (AM13), and stays on the page when the list empties, so the result of the bills just paid is
 * still read.
 *
 * Each card offers its bill while it can be selected (AM2). The page re-renders every 15 seconds: the selection survives
 * it, kept here, and a bill no card offers any more, because it was decided, left the list or can no longer be selected,
 * leaves the selection at once. The selection is listed in the page's order, due date first, which is the order the
 * server decides it in (AM5).
 *
 * Focus never falls to the page when what held it goes with the selection: the bar's buttons as the bar goes, or what
 * opened the confirmation once the bills were decided. It moves to the cards, or to the list once none is left.
 */
export function ApprovalSelection({
  orgSlug,
  order,
  sandbox,
  children,
}: {
  orgSlug: string;
  /** The waiting bills' ids in the page's order. */
  order: readonly string[];
  /** Whether a payment is simulated here, as each card's own confirmation says it. */
  sandbox: boolean;
  children: ReactNode;
}) {
  const [offered, setOffered] = useState<ReadonlyMap<string, SelectableBill>>(() => new Map());
  const [chosen, setChosen] = useState<ReadonlySet<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  // Each opening starts the confirmation afresh: no reason, refusal or result from the one before.
  const [round, setRound] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  // What had focus as the confirmation opened, which the dialog gives focus back to as it closes.
  const opener = useRef<Element | null>(null);
  const hintId = useId();
  // Where focus goes when what held it left with the selection, never to the page itself (approve many review ui-3).
  const landing = useCallback(() => (root.current ? focusLanding(root.current) : null), []);

  const offer = useCallback((id: string, bill: SelectableBill | null) => {
    setOffered((current) => {
      const before = current.get(id);
      if (bill ? before !== undefined && sameBill(before, bill) : before === undefined) return current;
      const next = new Map(current);
      if (bill) next.set(id, bill);
      else next.delete(id);
      return next;
    });
  }, []);

  // A bill no card offers any more leaves the selection (AM2), checked once the cards have all said so: a card whose
  // facts changed on a refresh takes its offer back and makes it again in the same commit, and stays selected.
  const [prunedFor, setPrunedFor] = useState(offered);
  if (prunedFor !== offered) {
    setPrunedFor(offered);
    const kept = [...chosen].filter((id) => offered.has(id));
    if (kept.length !== chosen.size) setChosen(new Set(kept));
  }

  const toggle = useCallback((id: string) => {
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clear = useCallback(() => setChosen(new Set()), []);

  const bills = useMemo(() => order.flatMap((id) => (chosen.has(id) ? (offered.get(id) ?? []) : [])), [order, chosen, offered]);
  const count = bills.length;
  const ready = count >= 2 && count <= MAX_SELECTION;
  const openConfirmation = useCallback(() => {
    opener.current = document.activeElement;
    setRound((current) => current + 1);
    setConfirming(true);
  }, []);
  // The dialog gives focus back to what opened it, unless that left with the bills just decided: the bar, which goes with
  // the selection, or the card of a bill just paid. Then to the cards, as the bar's own buttons do (approve many review
  // ui-3).
  const giveFocusBack = useCallback(
    (event: Event) => {
      if (opener.current?.isConnected !== false) return;
      event.preventDefault();
      landing()?.focus({ preventScroll: true });
    },
    [landing]
  );

  // The keys (AM12): j and k move between the cards, x ticks the one in focus, a opens the confirmation, Escape clears.
  // None does anything while typing, with Ctrl, Meta or Alt, or while a dialog is open; none pays.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const key = selectionKey(event, event.target instanceof HTMLElement ? event.target : null, document.querySelector(OPEN_OVERLAY) !== null);
      if (!key || !root.current) return;
      const cards = [...root.current.querySelectorAll<HTMLElement>("article[data-bill]")];
      const active = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("article[data-bill]") : null;
      const focused = active && root.current.contains(active) ? active : null;
      if (key === "next" || key === "previous") {
        if (cards.length === 0) return;
        const at = focused ? cards.indexOf(focused) : -1;
        const to = at === -1 ? (key === "next" ? 0 : cards.length - 1) : Math.min(Math.max(at + (key === "next" ? 1 : -1), 0), cards.length - 1);
        event.preventDefault();
        cards[to].focus({ preventScroll: true });
        cards[to].scrollIntoView?.({ block: "nearest" });
        return;
      }
      if (key === "toggle") {
        const id = focused?.dataset.bill;
        if (!id || !offered.has(id)) return;
        event.preventDefault();
        toggle(id);
        return;
      }
      if (key === "approve") {
        if (!ready) return;
        event.preventDefault();
        openConfirmation();
        return;
      }
      if (chosen.size === 0) return;
      event.preventDefault();
      clear();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [offered, chosen, ready, toggle, clear, openConfirmation]);

  // Silent until something was selected; from then on it says the count, and that none is left once cleared.
  const [heard, setHeard] = useState(false);
  if (!heard && count > 0) setHeard(true);

  const value = useMemo<SelectionValue>(() => ({ selected: (id) => chosen.has(id), toggle, offer }), [chosen, toggle, offer]);
  const hint = selectionHint(count);
  const anyPays = bills.some((bill) => bill.pays);

  return (
    <SelectionContext.Provider value={value}>
      {/* Focus lands on the list itself only when no card is left to take it. */}
      <div ref={root} tabIndex={-1} className="outline-hidden">
        {children}
        {/* Heard as the count changes, whether or not the bar is there to read. */}
        <p role="status" aria-live="polite" className="sr-only">
          {heard ? selectionAnnouncement(bills) : ""}
        </p>
        {count > 0 && (
          // In the page's flow under the last card, held to the bottom of the screen while the list scrolls under it: at
          // the end of the list it rests below the last card, so it never covers that card's buttons. While it shows, the
          // page keeps its height clear when it scrolls a control into view (`data-selection-bar`, globals.css).
          <div data-selection-bar="" className="sticky bottom-3 z-20 mt-4 print:hidden">
            <KeepFocus landing={landing} />
            <div
              role="region"
              aria-label="Selected bills"
              className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-2xl border border-agent-line bg-surface px-4 py-3 shadow-overlay"
            >
              <p className="min-w-0 text-sm text-ink">
                <span className="font-semibold">{selectedLine(count)}</span>
                <span className="text-ink-3"> · </span>
                <Money value={totalOf(bills)} className="font-semibold" />
              </p>
              <div className="flex items-center gap-2 max-sm:w-full">
                <Button size="touch" variant="ghost" onClick={clear}>
                  Clear
                </Button>
                <Button
                  size="touch"
                  icon={<Banknote />}
                  disabled={!ready}
                  aria-describedby={hint ? hintId : undefined}
                  onClick={openConfirmation}
                  className="max-sm:flex-1"
                >
                  {approveLabel(count, anyPays)}
                </Button>
              </div>
              {hint && (
                <p id={hintId} className="w-full text-xs text-ink-2">
                  {hint}
                </p>
              )}
              {/* The keys, for a keyboard: a phone has none. */}
              <p className="w-full text-xs text-ink-3 pointer-coarse:hidden">
                Keys: <Kbd>j</Kbd> and <Kbd>k</Kbd> move, <Kbd>x</Kbd> selects, <Kbd>a</Kbd> approves, <Kbd>Esc</Kbd> clears.
              </p>
            </div>
          </div>
        )}
      </div>
      <ApproveSelectionDialog
        key={round}
        open={confirming}
        onOpenChange={setConfirming}
        orgSlug={orgSlug}
        sandbox={sandbox}
        bills={bills}
        onDecided={clear}
        onCloseAutoFocus={giveFocusBack}
      />
    </SelectionContext.Provider>
  );
}

/**
 * Where focus lands when what held it left with the selection (AM12): the lowest card in view, just above where the bar
 * was, or the list itself once no card is left.
 */
function focusLanding(root: HTMLElement): HTMLElement {
  const inView = [...root.querySelectorAll<HTMLElement>("article[data-bill]")].filter((card) => card.getBoundingClientRect().top < window.innerHeight);
  return inView[inView.length - 1] ?? root;
}

/**
 * Inside the bar: as the bar goes, with Clear, Escape, or the last selected bill leaving the list, focus in it moves to
 * the cards first rather than fall to the page (approve many review ui-3). A layout effect's cleanup runs while the bar is
 * still in the page.
 */
function KeepFocus({ landing }: { landing: () => HTMLElement | null }) {
  const marker = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const bar = marker.current?.parentElement ?? null;
    return () => {
      if (bar?.contains(document.activeElement)) landing()?.focus({ preventScroll: true });
    };
  }, [landing]);
  return <span ref={marker} hidden />;
}

function sameBill(a: SelectableBill, b: SelectableBill): boolean {
  return (
    a.payee === b.payee && a.amount === b.amount && a.address === b.address && a.overridesHold === b.overridesHold && a.pays === b.pays && a.discounted === b.discounted
  );
}
