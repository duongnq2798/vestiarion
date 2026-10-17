// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * New ▾ asks before leaving the page only while something typed is unsaved
 * (docs/superpowers/specs/2026-10-12-bills-tabs-design.md B13). Found in a live test on Oct 17: after a bill was added the
 * form cleared itself, a select going back to its default reported a "change" (Radix's hidden <select> dispatches one),
 * and the page asked "Leave site?" about a bill already added. Rendered in a DOM, with the bill form stood in for by one
 * that does the same.
 */

const hooks = vi.hoisted(() => ({ saved: null as null | (() => void) }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/intake/InvoiceIntake", () => ({
  default: ({ onAdded }: { onAdded?: () => void }) => {
    hooks.saved = onAdded ?? null;
    return (
      <form>
        <input name="amount" aria-label="Amount" />
        <select name="counterpartyId" aria-label="Counterparty" defaultValue="">
          <option value="">Select a counterparty</option>
          <option value="cp-1">Cobalt Cloud</option>
        </select>
      </form>
    );
  },
}));
vi.mock("@/components/intake/InvoiceDocumentIntake", () => ({ default: () => null }));
vi.mock("@/components/intake/BillImport", () => ({ default: () => null }));
vi.mock("@/components/intake/RecurringPayableIntake", () => ({ default: () => null }));
vi.mock("@/components/deals/DealForm", () => ({ DealForm: () => null }));

import { NewMenu, OPEN_NEW_EVENT } from "@/components/bills/NewMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  hooks.saved = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<NewMenu orgSlug="acme" counterparties={[]} importWorkspace={{ shadowOn: false, shadowCurrency: null, network: "arc-testnet" }} deal={null} />);
  });
  act(() => {
    window.dispatchEvent(new CustomEvent(OPEN_NEW_EVENT, { detail: "bill" }));
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

/** Whether leaving the page now would ask first. */
function leavingAsks(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

const field = <T extends HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`) as T;
const fire = (element: HTMLElement, type: string) => act(() => void element.dispatchEvent(new Event(type, { bubbles: true })));

describe("leaving the page from New ▾", () => {
  it("asks once something is typed", () => {
    expect(leavingAsks()).toBe(false);
    fire(field("Amount"), "input");
    expect(leavingAsks()).toBe(true);
  });

  it("asks after a select alone is changed, before any save", () => {
    fire(field("Counterparty"), "change");
    expect(leavingAsks()).toBe(true);
  });

  it("no longer asks once the bill is added, though the cleared select reports a change", () => {
    fire(field("Amount"), "input");
    expect(leavingAsks()).toBe(true);
    act(() => hooks.saved?.());
    // The form's reset: a select back at its default dispatches a change, as Radix's hidden <select> does.
    fire(field("Counterparty"), "change");
    expect(leavingAsks()).toBe(false);
  });

  it("asks again once the person types into the next bill", () => {
    act(() => hooks.saved?.());
    fire(field("Counterparty"), "change");
    expect(leavingAsks()).toBe(false);
    fire(field("Amount"), "input");
    expect(leavingAsks()).toBe(true);
  });
});
