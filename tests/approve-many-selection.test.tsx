// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ApprovalCard, { REASON_HINT, selectableInSelection } from "@/components/ApprovalCard";
import { ApprovalSelection } from "@/components/approvals/ApprovalSelection";
import { CONFIRM_DESCRIPTION, DISCOUNT_NOTE, FIRST_OF_TWO, FUNDS_NOTE } from "@/components/approvals/ApproveSelectionDialog";
import { selectionKey } from "@/components/approvals/keys";
import { MAX_SELECTION, totalOf } from "@/components/approvals/selection-context";
import { TooltipProvider } from "@/components/ui/Tooltip";
import type { ApproveManyActionResult } from "@/app/actions/approvals";
import type { WaitingPayable } from "@/lib/agent/approvals";
import { MAX_BATCH_SIZE } from "@/lib/circle/batch";
import type { VerdictView } from "@/lib/verdict-view";

/**
 * Approvals' selection (docs/superpowers/specs/2026-10-30-approve-many-design.md), rendered in a DOM with the real
 * cards: which bills offer a checkbox (AM2), the bar's count, total and limits (AM3), the one confirmation and its one
 * optional reason (AM4, AM9), what it says once the bills were decided (AM11), and the keys (AM12). The server action is
 * a stand-in; tests/approve-many-action.test.ts holds the action to the command.
 */

const { actions } = vi.hoisted(() => ({
  actions: { approveMany: vi.fn<(previous: unknown, data: FormData) => Promise<unknown>>(async () => ({ ok: false, message: "" })) },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/app/actions/verdicts", () => ({ giveVerdictAction: vi.fn() }));
vi.mock("@/app/actions/document-requests", () => ({ revokeDocumentRequestAction: vi.fn(), setDocumentRequestsAction: vi.fn(), attachDocumentAction: vi.fn() }));
vi.mock("@/app/actions/approvals", () => ({
  approveInvoiceAction: vi.fn(),
  approveManyAction: actions.approveMany,
  cosignInvoiceAction: vi.fn(),
  rejectInvoiceAction: vi.fn(),
  returnInvoiceAction: vi.fn(),
  addInvoiceDetailsAction: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const VIEWER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000e5";
const OTHER = "0b6c1c9e-4a4f-4a7e-9b1e-0000000000c1";
const ID = (n: number) => `1b6c1c9e-4a4f-4a7e-9b1e-0000000000${String(n).padStart(2, "0")}`;
const ADDRESS = (n: number) => `0x1948aB00000000000000000000000000000c34${String(n).padStart(2, "0")}`;

const bill = (n: number, fields: Partial<WaitingPayable> = {}): WaitingPayable => ({
  id: ID(n),
  counterpartyId: `2b6c1c9e-4a4f-4a7e-9b1e-0000000000${String(n).padStart(2, "0")}`,
  counterpartyName: `Vendor ${n}`,
  riskLevel: "low",
  amount: 10 * n + 0.5,
  dueDate: `2026-10-${String(10 + (n % 15)).padStart(2, "0")}`,
  status: "held",
  reasoning: "Held for cash.",
  explanation: "Held for cash.",
  decidedAt: "2026-10-07T10:00:00.000Z",
  createdBy: OTHER,
  reviewedAt: null,
  reclaimable: false,
  paymentSent: false,
  address: ADDRESS(n),
  lastAttempt: null,
  discount: null,
  currency: "USDC",
  payeeChain: "ARC-TESTNET",
  bridgeFeeUsdc: null,
  poReference: null,
  goodsReceived: true,
  addedSinceDecision: null,
  guardrailRule: null,
  heldForCash: true,
  ...fields,
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  actions.approveMany.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

/** The Approvals list as the page renders it: the cards inside the selection, in the page's order. */
function render(payables: WaitingPayable[], options: { sandbox?: boolean; verdicts?: Record<string, VerdictView> } = {}) {
  act(() => {
    root.render(
      <TooltipProvider>
        <ApprovalSelection orgSlug="acme" order={payables.map((payable) => payable.id)} sandbox={options.sandbox ?? false}>
          <div className="space-y-4">
            {payables.map((payable) => (
              <ApprovalCard
                key={payable.id}
                orgSlug="acme"
                payable={payable}
                canDecide
                viewerId={VIEWER}
                sandbox={options.sandbox ?? false}
                verdict={options.verdicts?.[payable.id]}
              />
            ))}
          </div>
        </ApprovalSelection>
      </TooltipProvider>
    );
  });
}

const checkbox = (n: number) => document.querySelector<HTMLButtonElement>(`#select-${ID(n)}`);
const tick = (n: number) => {
  const box = checkbox(n);
  if (!box) throw new Error(`Vendor ${n} offers no checkbox`);
  act(() => box.click());
};
const bar = () => document.querySelector<HTMLElement>('[role="region"][aria-label="Selected bills"]');
const live = () => [...document.querySelectorAll<HTMLElement>('p[role="status"][aria-live="polite"]')].find((node) => node.classList.contains("sr-only"));
const buttonNamed = (name: string, scope: ParentNode = document) =>
  [...scope.querySelectorAll("button")].find((button) => button.textContent?.trim() === name) as HTMLButtonElement | undefined;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
/** What a person reads: each piece of text once, with a space between pieces, as a separate element would be spaced. */
function text(node: Element | null | undefined): string {
  if (!node) return "";
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const pieces: string[] = [];
  for (let current = walker.nextNode(); current; current = walker.nextNode()) pieces.push(current.textContent ?? "");
  return pieces.map((piece) => piece.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
}
const press = (key: string, target: EventTarget = window, init: KeyboardEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });

/** Opens the confirmation from the bar's button. */
function openConfirmation(label: string): HTMLElement {
  const button = buttonNamed(label, bar() ?? document);
  if (!button) throw new Error(`no ${label} in the bar`);
  act(() => button.click());
  const opened = dialog();
  if (!opened) throw new Error("the confirmation did not open");
  return opened;
}

async function confirm(opened: HTMLElement, label: string) {
  const button = buttonNamed(label, opened);
  if (!button) throw new Error(`no ${label} in the confirmation`);
  await act(async () => {
    button.closest("form")?.requestSubmit(button);
  });
}

const sent = () => actions.approveMany.mock.calls[0]?.[1];

/**
 * Enter in a text field, as a browser takes it: unless its keydown is stopped, the field's form is submitted by its
 * first submit button (HTML's implicit submission), which this DOM does not do on its own.
 */
async function pressEnterIn(field: HTMLInputElement) {
  await act(async () => {
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    const submitter = [...(field.form?.querySelectorAll("button") ?? [])].find((button) => button.type === "submit");
    if (!event.defaultPrevented && submitter && !submitter.disabled) field.form?.requestSubmit(submitter);
  });
}

describe("which bills a card offers to the selection (approve many AM2)", () => {
  const offers = (payable: WaitingPayable, verdict?: VerdictView, own = { entry: false, address: false }) => selectableInSelection(payable, VIEWER, own.entry, own.address, verdict);

  it("offers a held USDC bill paid to an address on the workspace's chain, with no payment tried", () => {
    expect(offers(bill(1))).toBe(true);
    expect(offers(bill(1, { status: "flagged", heldForCash: false, guardrailRule: "counterparty_limit" }))).toBe(true);
    expect(offers(bill(1, { status: "awaiting_info" }))).toBe(true);
  });

  it("does not offer a bill someone else is deciding, nor an unfinished decision, which Approve and pay alone records", () => {
    expect(offers(bill(1, { status: "processing" }))).toBe(false);
    expect(offers(bill(1, { status: "processing", reclaimable: true }))).toBe(false);
  });

  it("does not offer a bill an open shadow verdict decides, nor one whose verdict was not read; one with its verdict given is offered", () => {
    const held = bill(1, { heldForCash: false, heldForVerdict: true });
    const view: VerdictView = { entrySeq: 41, agentAction: "ap_pay", given: null, open: true, heldForVerdict: true };
    expect(offers(held, view)).toBe(false);
    expect(offers(held)).toBe(false);
    expect(offers(held, { ...view, open: false, given: { verdict: "agree", reason: null } })).toBe(true);
  });

  it("does not offer what payBlockedReason refuses this person: their own entry, an address they gave, high risk", () => {
    expect(offers(bill(1, { createdBy: VIEWER }))).toBe(false);
    expect(offers(bill(1, { createdBy: VIEWER }), undefined, { entry: true, address: false })).toBe(true);
    expect(offers(bill(1, { firstPaymentAddressBy: VIEWER }))).toBe(false);
    expect(offers(bill(1, { riskLevel: "high" }))).toBe(false);
  });

  it("offers the first of two approvals, and not the second from the same person, nor one no second approver can pay", () => {
    const two = { above: 10, approvals: [], excluded: [OTHER], excludedSlots: 0, approvers: 2 };
    expect(offers(bill(1, { twoApprovals: two }))).toBe(true);
    expect(offers(bill(1, { twoApprovals: { ...two, approvals: [{ by: OTHER, at: "2026-10-08T10:00:00Z" }] } }))).toBe(true);
    expect(offers(bill(1, { twoApprovals: { ...two, approvals: [{ by: VIEWER, at: "2026-10-08T10:00:00Z" }] } }))).toBe(false);
    expect(offers(bill(1, { twoApprovals: { ...two, approvers: 1 } }))).toBe(false);
  });

  it("does not offer EURC, a bank payout, a payee on another chain, or a bill with no address", () => {
    expect(offers(bill(1, { currency: "EURC" }))).toBe(false);
    const bank = { bankCode: "012", last4: "1234", beneficiaryName: "Ana Lopez", accountStatus: "approved" as const, quote: null, quoteProblem: "unread" as const };
    expect(offers(bill(1, { bank }))).toBe(false);
    expect(offers(bill(1, { payeeChain: "BASE-SEPOLIA" }))).toBe(false);
    expect(offers(bill(1, { address: null }))).toBe(false);
  });

  it("does not offer a bill a payment was ever tried for, nor one whose payee is frozen", () => {
    expect(offers(bill(1, { paymentSent: true }))).toBe(false);
    expect(offers(bill(1, { lastAttempt: { state: "failed", reason: "insufficient funds" } }))).toBe(false);
    expect(offers(bill(1, { lastAttempt: { state: "in_flight" } }))).toBe(false);
    expect(offers(bill(1, { lastAttempt: { state: "unanswered" } }))).toBe(false);
    // A send Circle refused before giving it an id shows neither, and the server refuses it all the same (review ui-1).
    expect(offers(bill(1, { paymentTried: true }))).toBe(false);
    expect(offers(bill(1, { payeeFrozen: true }))).toBe(false);
  });

  it("shows the checkbox only where the card offers its bill, named with the payee and amount, and nowhere outside Approvals' selection", () => {
    render([bill(1), bill(2, { currency: "EURC" })]);
    expect(checkbox(1)?.getAttribute("role")).toBe("checkbox");
    const label = document.querySelector(`label[for="select-${ID(1)}"]`);
    expect(text(label)).toBe("Select Vendor 1, 10.50 USDC");
    expect(checkbox(2)).toBeNull();

    act(() => root.render(<TooltipProvider><ApprovalCard orgSlug="acme" payable={bill(1)} canDecide viewerId={VIEWER} sandbox={false} /></TooltipProvider>));
    expect(checkbox(1)).toBeNull();
    expect(document.querySelector("article")?.hasAttribute("tabindex")).toBe(false);
  });

  it("offers nothing to a person who may not decide", () => {
    act(() =>
      root.render(
        <TooltipProvider>
          <ApprovalSelection orgSlug="acme" order={[ID(1)]} sandbox={false}>
            <ApprovalCard orgSlug="acme" payable={bill(1)} canDecide={false} viewerId={VIEWER} sandbox={false} />
          </ApprovalSelection>
        </TooltipProvider>
      )
    );
    expect(checkbox(1)).toBeNull();
  });
});

describe("the selection bar (approve many AM3, AM12)", () => {
  it("shows the count and the total from the first bill, and approves from 2 bills", () => {
    render([bill(1), bill(2), bill(3)]);
    expect(bar()).toBeNull();
    tick(2);
    expect(checkbox(2)?.getAttribute("aria-checked")).toBe("true");
    expect(text(bar())).toContain("1 bill selected · 20.50 USDC");
    const approve = buttonNamed("Approve and pay 1", bar() as HTMLElement);
    expect(approve?.disabled).toBe(true);
    expect(text(bar())).toContain("Select one more bill to approve them together.");
    expect(approve?.getAttribute("aria-describedby")).toBeTruthy();
    expect(text(live())).toBe("1 bill selected, 20.50 USDC.");

    tick(1);
    expect(text(bar())).toContain("2 bills selected · 31.00 USDC");
    expect(buttonNamed("Approve and pay 2", bar() as HTMLElement)?.disabled).toBe(false);
    expect(text(bar())).not.toContain("Select one more bill");
    expect(text(bar())).toContain("Keys: j and k move, x selects, a approves, Esc clears.");
    expect(text(live())).toBe("2 bills selected, 31.00 USDC.");
  });

  it("adds the amounts in micro-USDC, so the total never drifts (AM4)", () => {
    expect(totalOf([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
    expect(totalOf([{ amount: 1.000001 }, { amount: 2.000002 }])).toBe(3.000003);
    const many = Array.from({ length: 3 }, (_, index) => bill(index + 1, { amount: 0.1 }));
    render(many);
    for (const n of [1, 2, 3]) tick(n);
    expect(text(bar())).toContain("3 bills selected · 0.30 USDC");
  });

  it(`stops at ${MAX_SELECTION}, one batch, and says so`, () => {
    expect(MAX_SELECTION).toBe(MAX_BATCH_SIZE);
    const many = Array.from({ length: MAX_SELECTION + 1 }, (_, index) => bill(index + 1, { amount: 1 }));
    render(many);
    for (let n = 1; n <= MAX_SELECTION; n++) tick(n);
    expect(buttonNamed(`Approve and pay ${MAX_SELECTION}`, bar() as HTMLElement)?.disabled).toBe(false);
    tick(MAX_SELECTION + 1);
    expect(buttonNamed(`Approve and pay ${MAX_SELECTION + 1}`, bar() as HTMLElement)?.disabled).toBe(true);
    expect(text(bar())).toContain(`Select at most ${MAX_SELECTION} bills to approve together.`);
    // Twenty-one cards ticked one by one, each tick a render: slower than the rest under a loaded run.
  }, 30_000);

  it("reads Approve where no bill of the selection pays now, only gives the first of two approvals", () => {
    const two = { above: 5, approvals: [], excluded: [OTHER], excludedSlots: 0, approvers: 2 };
    render([bill(1, { twoApprovals: two }), bill(2, { twoApprovals: two })]);
    tick(1);
    tick(2);
    expect(buttonNamed("Approve 2", bar() as HTMLElement)).toBeDefined();
  });

  it("clears with Clear, and says none is left", () => {
    render([bill(1), bill(2)]);
    tick(1);
    tick(2);
    act(() => buttonNamed("Clear", bar() as HTMLElement)?.click());
    expect(bar()).toBeNull();
    expect(checkbox(1)?.getAttribute("aria-checked")).toBe("false");
    expect(text(live())).toBe("No bills selected.");
  });

  it("moves focus to the cards when Clear, or Escape on the bar, takes the bar away, never to the page (review ui-3)", () => {
    render([bill(1), bill(2), bill(3)]);
    tick(1);
    tick(2);
    const clearButton = buttonNamed("Clear", bar() as HTMLElement) as HTMLButtonElement;
    clearButton.focus();
    act(() => clearButton.click());
    expect(bar()).toBeNull();
    // The lowest card in view, just above where the bar was.
    expect(document.activeElement).toBe(document.querySelector(`article[data-bill="${ID(3)}"]`));

    tick(1);
    tick(2);
    const approve = buttonNamed("Approve and pay 2", bar() as HTMLElement) as HTMLButtonElement;
    approve.focus();
    press("Escape", approve);
    expect(bar()).toBeNull();
    expect(document.activeElement?.tagName).toBe("ARTICLE");
  });

  it("keeps a focused control clear of the bar while it shows, as the page scrolls it into view (WCAG 2.4.11, review ui-4)", () => {
    render([bill(1), bill(2)]);
    tick(1);
    expect(bar()?.closest("[data-selection-bar]")).not.toBeNull();
    const css = readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    const rule = /html:has\(\[data-selection-bar\]\)\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/scroll-padding-bottom:\s*10rem;/);
  });

  it("keeps the selection across the page's refresh, and lets go of a bill that left the list or can no longer be selected", () => {
    render([bill(1), bill(2), bill(3)]);
    for (const n of [1, 2, 3]) tick(n);
    // AutoRefresh re-renders the same bills: nothing changes.
    render([bill(1), bill(2), bill(3)]);
    expect(text(bar())).toContain("3 bills selected");
    // A refresh whose facts changed for a selected bill, such as a discount whose day passed, keeps it selected.
    render([bill(1), bill(2, { reasoning: "Held again." }), bill(3, { amount: 31 })]);
    expect(text(bar())).toContain("3 bills selected · 62.00 USDC");
    // Another person started deciding one; another left the list.
    render([bill(1), bill(2, { status: "processing" })]);
    expect(text(bar())).toContain("1 bill selected · 10.50 USDC");
    // It comes back, unselected.
    render([bill(1), bill(2), bill(3)]);
    expect(checkbox(2)?.getAttribute("aria-checked")).toBe("false");
    expect(checkbox(3)?.getAttribute("aria-checked")).toBe("false");
  });

  it("outlines a selected card", () => {
    render([bill(1), bill(2)]);
    tick(1);
    const [first, second] = [...document.querySelectorAll("article")];
    expect(first.className).toContain("ring-agent");
    expect(second.className).not.toContain("ring-agent");
  });
});

describe("the one confirmation (approve many AM1, AM4, AM9)", () => {
  it("lists each bill in the page's order with its payee, shortened address and amount, the total, and what the wallet must hold", () => {
    render([bill(1), bill(2), bill(3)]);
    tick(3);
    tick(1);
    const opened = openConfirmation("Approve and pay 2");
    expect(text(opened.querySelector("h2"))).toBe("Approve and pay 2 bills?");
    expect(text(opened)).toContain(CONFIRM_DESCRIPTION);
    const rows = [...opened.querySelectorAll("li")].map(text);
    expect(rows).toEqual(["Vendor 1 0x1948...3401 10.50 USDC", "Vendor 3 0x1948...3403 30.50 USDC"]);
    expect(text(opened)).toContain("Total 41.00 USDC");
    expect(text(opened)).toContain(FUNDS_NOTE);
    expect(buttonNamed("Pay now", opened)).toBeDefined();
    // It opens on Cancel, as a confirmation does: nothing pays until the person chooses Pay now.
    expect(document.activeElement).toBe(buttonNamed("Cancel", opened));
  });

  it("asks one optional Why pay them anyway? only when a bill goes against the agent's hold, and sends it", async () => {
    render([bill(1), bill(2, { heldForCash: false, guardrailRule: "counterparty_limit" }), bill(3)]);
    tick(1);
    tick(3);
    let opened = openConfirmation("Approve and pay 2");
    expect(text(opened)).not.toContain("Why pay them anyway?");
    act(() => buttonNamed("Cancel", opened)?.click());

    tick(2);
    opened = openConfirmation("Approve and pay 3");
    expect(text(opened)).toContain("Why pay them anyway?");
    expect(text(opened)).toContain(REASON_HINT);
    const field = opened.querySelector<HTMLInputElement>('input[name="reason"]');
    expect(field?.required).toBe(false);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(field, "Known suppliers, limits raised next week");
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    actions.approveMany.mockResolvedValueOnce({ ok: false, message: "These 3 bills come to 61.5 USDC; the operating wallet holds 5 USDC. Select fewer, or approve them one at a time, which can bring cash back from the reserve." });
    await confirm(opened, "Pay now");
    const data = sent();
    expect(data?.get("orgSlug")).toBe("acme");
    expect(JSON.parse(String(data?.get("items")))).toEqual([1, 2, 3].map((n) => ({ invoiceId: ID(n), address: ADDRESS(n) })));
    expect(data?.get("reason")).toBe("Known suppliers, limits raised next week");
  });

  it("pays nothing on Enter in Why pay them anyway?: only the confirmation's button pays (AM12, review ui-2)", async () => {
    render([bill(1, { heldForCash: false, guardrailRule: "counterparty_limit" }), bill(2)]);
    tick(1);
    tick(2);
    const opened = openConfirmation("Approve and pay 2");
    const field = opened.querySelector<HTMLInputElement>('input[name="reason"]') as HTMLInputElement;
    field.focus();

    await pressEnterIn(field);

    expect(actions.approveMany).not.toHaveBeenCalled();
    expect(text(dialog()?.querySelector("h2"))).toBe("Approve and pay 2 bills?");
    actions.approveMany.mockResolvedValueOnce({ ok: false, message: "Try again." });
    await confirm(opened, "Pay now");
    expect(actions.approveMany).toHaveBeenCalledTimes(1);
  });

  it("says a first of two approvals pays nothing yet, and an open discount comes off at the transfer", () => {
    const two = { above: 5, approvals: [], excluded: [OTHER], excludedSlots: 0, approvers: 2 };
    const discount = { pct: 2, deadline: "2099-12-31" };
    render([bill(1, { twoApprovals: two }), bill(2, { discount })]);
    tick(1);
    tick(2);
    const opened = openConfirmation("Approve and pay 2");
    const rows = [...opened.querySelectorAll("li")].map(text);
    expect(rows[0]).toContain(FIRST_OF_TWO);
    expect(rows[1]).toContain(DISCOUNT_NOTE);
    expect(buttonNamed("Approve and pay", opened)).toBeDefined();
  });

  it("says a sandbox's payments are simulated, as Approve and pay does", () => {
    render([bill(1), bill(2)], { sandbox: true });
    tick(1);
    tick(2);
    expect(text(openConfirmation("Approve and pay 2").querySelector("h2"))).toBe("Approve and pay 2 bills? (simulated)");
  });

  it("keeps the selection and says why when the selection is refused whole", async () => {
    render([bill(1), bill(2)]);
    tick(1);
    tick(2);
    const opened = openConfirmation("Approve and pay 2");
    const refusal = "These 2 bills come to 31 USDC; the operating wallet holds 5 USDC. Select fewer, or approve them one at a time, which can bring cash back from the reserve.";
    actions.approveMany.mockResolvedValueOnce({ ok: false, message: refusal });
    await confirm(opened, "Pay now");
    expect(text(dialog())).toContain(refusal);
    expect(text(bar())).toContain("2 bills selected");
  });
});

describe("what the confirmation did (approve many AM11)", () => {
  it("says one line per bill, the transaction they shared with View transaction, and clears the selection", async () => {
    render([bill(1), bill(2), bill(3), bill(4)]);
    for (const n of [1, 2, 3, 4]) tick(n);
    const opened = openConfirmation("Approve and pay 4");
    const tx = `0x${"ab".repeat(32)}`;
    const result: ApproveManyActionResult = {
      ok: true,
      message: "4 bills: 2 paid, 1 approved, 1 not paid.",
      bills: [
        { invoiceId: ID(1), payee: "Vendor 1", amount: 10.5, currency: "USDC", outcome: "paid", message: "Paid 10.50 USDC to Vendor 1; Circle confirmed it on Arc testnet.", txRef: tx },
        { invoiceId: ID(2), payee: "Vendor 2", amount: 20.5, currency: "USDC", outcome: "paid", message: "Paid 20.50 USDC to Vendor 2; Circle confirmed it on Arc testnet.", txRef: tx },
        { invoiceId: ID(3), payee: "Vendor 3", amount: 30.5, currency: "USDC", outcome: "approved", message: "Approved. One more approval, by another person, pays it.", txRef: null },
        { invoiceId: ID(4), payee: null, amount: null, currency: null, outcome: "refused", message: "That invoice is not waiting for a decision.", txRef: null },
      ],
      transaction: { txRef: tx, size: 2, txUrl: `https://testnet.arcscan.app/tx/${tx}`, message: "Paid 2 bills in one Arc transaction." },
    };
    actions.approveMany.mockResolvedValueOnce(result);
    await confirm(opened, "Pay now");

    const shown = dialog();
    expect(text(shown?.querySelector("h2"))).toBe("4 bills: 2 paid, 1 approved, 1 not paid.");
    expect(text(shown)).toContain("Paid 2 bills in one Arc transaction.");
    const link = [...(shown?.querySelectorAll("a") ?? [])].find((anchor) => anchor.textContent?.includes("View transaction"));
    expect(link?.getAttribute("href")).toBe(`https://testnet.arcscan.app/tx/${tx}`);
    expect(link?.getAttribute("target")).toBe("_blank");
    const lines = [...(shown?.querySelectorAll("li") ?? [])].map(text);
    expect(lines).toEqual([
      "Paid Vendor 1 10.50 USDC Paid 10.50 USDC to Vendor 1; Circle confirmed it on Arc testnet.",
      "Paid Vendor 2 20.50 USDC Paid 20.50 USDC to Vendor 2; Circle confirmed it on Arc testnet.",
      "Approved Vendor 3 30.50 USDC Approved. One more approval, by another person, pays it.",
      // The server could not read it as waiting: the page's own name for it stands in.
      "Not paid Vendor 4 That invoice is not waiting for a decision.",
    ]);
    expect(bar()).toBeNull();
    expect(document.activeElement?.textContent).toBe("Done");
    act(() => buttonNamed("Done", shown as HTMLElement)?.click());
    expect(dialog()).toBeNull();
  });

  it("gives focus to a card left on the page after Done, since the bar that opened it left with the selection (review ui-3)", async () => {
    render([bill(1), bill(2), bill(3)]);
    tick(1);
    tick(2);
    // Opened from the bar's button, as a click or a key on it opens it.
    const approve = buttonNamed("Approve and pay 2", bar() as HTMLElement) as HTMLButtonElement;
    approve.focus();
    act(() => approve.click());
    actions.approveMany.mockResolvedValueOnce({
      ok: true,
      message: "2 bills: 2 paid.",
      bills: [1, 2].map((n) => ({ invoiceId: ID(n), payee: `Vendor ${n}`, amount: 10 * n + 0.5, currency: "USDC", outcome: "paid", message: "Paid.", txRef: null })),
    } satisfies ApproveManyActionResult);
    await confirm(dialog() as HTMLElement, "Pay now");
    // The page refreshes without the bills just paid.
    render([bill(3)]);
    act(() => buttonNamed("Done", dialog() as HTMLElement)?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(document.querySelector(`article[data-bill="${ID(3)}"]`));
  });

  it("gives focus back to the bar after Cancel, which is still there", async () => {
    render([bill(1), bill(2)]);
    tick(1);
    tick(2);
    const approve = buttonNamed("Approve and pay 2", bar() as HTMLElement) as HTMLButtonElement;
    approve.focus();
    act(() => approve.click());
    act(() => buttonNamed("Cancel", dialog() as HTMLElement)?.click());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(approve);
  });

  it("calls a shared transaction submitted, not paid, while Circle has not confirmed it, and gives no link without a hash", async () => {
    render([bill(1), bill(2)]);
    tick(1);
    tick(2);
    const opened = openConfirmation("Approve and pay 2");
    actions.approveMany.mockResolvedValueOnce({
      ok: true,
      message: "2 bills: 2 submitted.",
      bills: [1, 2].map((n) => ({
        invoiceId: ID(n), payee: `Vendor ${n}`, amount: 10 * n + 0.5, currency: "USDC", outcome: "submitted",
        message: `Submitted ${10 * n + 0.5} USDC to Vendor ${n}; Circle has not answered yet, so the outcome is unknown and nothing goes out again until it does.`,
        txRef: null,
      })),
      transaction: { txRef: null, size: 2, txUrl: null, message: "Submitted 2 bills in one Arc transaction; Circle has not answered yet, so the outcome is unknown and nothing goes out again until it does." },
    } satisfies ApproveManyActionResult);
    await confirm(opened, "Pay now");
    const shown = dialog();
    expect(text(shown)).toContain("Submitted 2 bills in one Arc transaction; Circle has not answered yet");
    for (const line of shown?.querySelectorAll("li") ?? []) expect(text(line)).toMatch(/^Submitted Vendor \d/);
    expect(text(shown)).not.toContain("View transaction");
  });
});

describe("the keys (approve many AM12)", () => {
  const cards = () => [...document.querySelectorAll<HTMLElement>("article[data-bill]")];

  it("moves focus between the cards with j and k, ticks the focused one with x, opens the confirmation with a, and clears with Escape", () => {
    render([bill(1), bill(2), bill(3, { currency: "EURC" })]);
    press("j");
    expect(document.activeElement).toBe(cards()[0]);
    press("x");
    press("j");
    expect(document.activeElement).toBe(cards()[1]);
    press("x");
    expect(text(bar())).toContain("2 bills selected");
    // A card that cannot be selected is moved through, and x does nothing there.
    press("j");
    expect(document.activeElement).toBe(cards()[2]);
    press("x");
    expect(text(bar())).toContain("2 bills selected");
    press("j");
    expect(document.activeElement).toBe(cards()[2]);
    press("k");
    expect(document.activeElement).toBe(cards()[1]);
    press("x");
    expect(text(bar())).toContain("1 bill selected");
    press("x");

    press("a");
    expect(text(dialog()?.querySelector("h2"))).toBe("Approve and pay 2 bills?");
    expect(actions.approveMany).not.toHaveBeenCalled();
    act(() => buttonNamed("Cancel", dialog() as HTMLElement)?.click());

    press("Escape");
    expect(bar()).toBeNull();
  });

  it("does nothing with a key typed into a field, held with Ctrl, Meta or Alt, or repeated for x and a", () => {
    render([bill(1), bill(2)]);
    tick(1);
    const field = document.createElement("input");
    document.body.appendChild(field);
    field.focus();
    press("Escape", field);
    press("j", field);
    expect(text(bar())).toContain("1 bill selected");
    expect(document.activeElement).toBe(field);
    press("j", window, { ctrlKey: true });
    press("Escape", window, { metaKey: true });
    press("Escape", window, { altKey: true });
    expect(text(bar())).toContain("1 bill selected");
    expect(selectionKey({ key: "x", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, repeat: true }, null, false)).toBeNull();
    expect(selectionKey({ key: "j", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false, repeat: true }, null, false)).toBe("next");
    expect(selectionKey({ key: "j", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false }, { tagName: "DIV", isContentEditable: true }, false)).toBeNull();
    expect(selectionKey({ key: "a", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false }, { tagName: "TEXTAREA" }, false)).toBeNull();
    expect(selectionKey({ key: "a", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false }, { tagName: "SELECT" }, false)).toBeNull();
    expect(selectionKey({ key: "J", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false }, null, false)).toBeNull();
  });

  it("does nothing while a dialog is open: Escape closes the dialog and keeps the selection", () => {
    render([bill(1), bill(2)]);
    tick(1);
    tick(2);
    openConfirmation("Approve and pay 2");
    expect(selectionKey({ key: "x", ctrlKey: false, metaKey: false, altKey: false, defaultPrevented: false }, null, true)).toBeNull();
    press("x");
    press("a");
    press("j");
    press("Escape", document.activeElement ?? document.body);
    expect(dialog()).toBeNull();
    expect(text(bar())).toContain("2 bills selected");
    expect(actions.approveMany).not.toHaveBeenCalled();
  });

  it("does not open the confirmation with a while fewer than 2 bills are selected", () => {
    render([bill(1), bill(2)]);
    tick(1);
    press("a");
    expect(dialog()).toBeNull();
  });
});
